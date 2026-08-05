#!/usr/bin/env bash
# Run once on txc-ipfs-node (as ubuntu, via SSH or EC2 Instance Connect) after
# the box is back up. Idempotent — safe to re-run.
#
# Fixes the failure mode seen 2026-08-05: the instance stopped answering on
# every port (no ICMP, no 80/443/4001/5001/8080) while EC2 still reported
# "Running", and EC2 Instance Connect could not establish SSH. That signature
# is a wedged kernel, not a crashed process — Restart=always on the ipfs unit
# cannot help, because systemd itself never got scheduled.
set -euo pipefail

echo "==> 1/6  Swap (absorbs a kubo memory spike instead of OOM-wedging the box)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 8G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.d/99-ipfs.conf 2>/dev/null || echo 'vm.swappiness=10' >> /etc/sysctl.d/99-ipfs.conf

echo "==> 2/6  Kernel panic-and-reboot instead of hanging forever"
# A hung box needs a human + a reboot. These make the kernel reboot itself
# after 10s on panic, and treat an unrecoverable OOM as a panic.
cat >/etc/sysctl.d/99-ipfs-recover.conf <<'EOF'
kernel.panic=10
kernel.panic_on_oops=1
vm.panic_on_oom=0
vm.min_free_kbytes=131072
EOF
sysctl -p /etc/sysctl.d/99-ipfs-recover.conf

echo "==> 3/6  Hardware watchdog (reboots the box if the kernel stops responding)"
apt-get update -qq && apt-get install -y -qq watchdog
sed -i 's/^#\?watchdog-device.*/watchdog-device = \/dev\/watchdog/' /etc/watchdog.conf || true
grep -q '^max-load-1' /etc/watchdog.conf || echo 'max-load-1 = 24' >> /etc/watchdog.conf
grep -q '^min-memory' /etc/watchdog.conf || echo 'min-memory = 1' >> /etc/watchdog.conf
systemctl enable --now watchdog || echo "   (no /dev/watchdog on this instance family — skipping)"

echo "==> 4/6  Cap kubo's memory + connections so it can't eat the whole box"
IPFS_PATH=/var/lib/ipfs
sudo -u ipfs IPFS_PATH=$IPFS_PATH ipfs config --json Swarm.ConnMgr '{"Type":"basic","LowWater":100,"HighWater":400,"GracePeriod":"20s"}'
sudo -u ipfs IPFS_PATH=$IPFS_PATH ipfs config --json Swarm.ResourceMgr '{"Enabled":true,"MaxMemory":"3GB","MaxFileDescriptors":32768}'
# Accelerated DHT client is a big memory/CPU consumer; we are a gateway, not a
# DHT server, so turn the server-side burden off.
sudo -u ipfs IPFS_PATH=$IPFS_PATH ipfs config Routing.Type "dhtclient"
sudo -u ipfs IPFS_PATH=$IPFS_PATH ipfs config --json Swarm.RelayService '{"Enabled":false}'

echo "==> 5/6  systemd guardrails on the ipfs unit"
mkdir -p /etc/systemd/system/ipfs.service.d
cat >/etc/systemd/system/ipfs.service.d/limits.conf <<'EOF'
[Service]
# Hard ceiling: the cgroup OOM-kills kubo alone rather than letting the
# kernel OOM-reaper pick a random victim and wedge the machine.
MemoryMax=5G
MemoryHigh=4G
Restart=always
RestartSec=5
# Don't give up after repeated crashes — keep retrying forever.
StartLimitIntervalSec=0
EOF
systemctl daemon-reload
systemctl restart ipfs

echo "==> 6/6  Self-healing gateway healthcheck (every minute)"
cat >/usr/local/bin/ipfs-healthcheck <<'EOF'
#!/usr/bin/env bash
# If the local gateway can't serve a known-good CID in 10s, restart kubo.
CID=bafkreidqqb7nh3hlebz2elar5bw7lxb4eu32ms6suwm6lg3ayibcduftu4
if ! curl -sf --max-time 10 -o /dev/null "http://127.0.0.1:8080/ipfs/$CID"; then
  logger -t ipfs-healthcheck "gateway unresponsive — restarting ipfs"
  systemctl restart ipfs
fi
EOF
chmod +x /usr/local/bin/ipfs-healthcheck
cat >/etc/systemd/system/ipfs-healthcheck.service <<'EOF'
[Unit]
Description=IPFS gateway healthcheck
[Service]
Type=oneshot
ExecStart=/usr/local/bin/ipfs-healthcheck
EOF
cat >/etc/systemd/system/ipfs-healthcheck.timer <<'EOF'
[Unit]
Description=Run IPFS gateway healthcheck every minute
[Timer]
OnBootSec=3min
OnUnitActiveSec=1min
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now ipfs-healthcheck.timer

echo
echo "Done. Verify with:"
echo "  systemctl status ipfs --no-pager"
echo "  curl -sI http://127.0.0.1:8080/ipfs/bafkreidqqb7nh3hlebz2elar5bw7lxb4eu32ms6suwm6lg3ayibcduftu4"
echo "  free -h && swapon --show"
