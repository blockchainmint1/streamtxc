// Reports streamTXC sign-ins/signups to the honest.money Hub (honest.money/api §3).
// Best-effort: never blocks a sign-in.
export const HM_SERVICE = "streamtxc";

export async function sendHubEvent(args: {
  event: "signup" | "service_used" | "purchase";
  memberId?: string | null;
  email?: string | null;
  ref?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const secret = process.env.HME_HMAC_SECRET;
  if (!secret) return;
  try {
    await fetch("https://honest.money/api/public/hub/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        service: HM_SERVICE,
        event: args.event,
        ...(args.memberId ? { member_id: args.memberId } : { email: args.email }),
        ...(args.ref ? { ref: args.ref } : {}),
        metadata: args.metadata ?? {},
      }),
    });
  } catch {
    /* ignore */
  }
}

export const BLOCKED_STATUSES = ["blocked", "ban"];
