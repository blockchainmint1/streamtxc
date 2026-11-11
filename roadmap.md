# HME API update
- [x] Fix audit H-1 media execution, H-2 canonical wallet messages and browser-only exchange proof, M-4 fail-open signatures, M-6 branch identity binding, and H-3 confirmed-only renewals. 27 regression tests pass; real signed QR callback/exchange and replay rejection verified, plus actual archive thumbnail, playlist and segment reads. Publication and an HME Wallet phone check remain required; no real renewal payment or existing branch was changed during testing.
- [x] Build and test append-only historical repair with IPFS read-back and persisted signed transactions; 362 records repaired, originals retained.
- [ ] Finish remaining 181 historical records. Current turn reached its time budget; rerun scripts/repair-historical-chain-records.ts in small serial batches, which skips completed records and reuses prepared transactions. Gateway propagation retries and unambiguous original-chain destination recovery are supported.
- [x] Check current HME API instructions and existing member links; HME confirmed all four stored UUIDs.
- [x] Switch SSO, Hub reporting, and profile updates to HME_ECOSYSTEM and permanent UUIDs without changing wallet ownership.
- [x] Test real member lookup and Hub reporting; test signed site ticket through the browser to Bobby's 103-video account, replay rejection and profile sync; ten protocol tests pass.
- [ ] Confirm an HME-issued sign-in after publishing and HME's automatic profile-update delivery. Blocker: no HME browser session; publication and sender registration are outside this turn. Test tickets were generated server-side, not issued through HME's login screen.
# Audit medium items still open (verified in code Nov 11)
- [ ] M-1 import host allow-list bypass via prefetched path
- [ ] M-2 chat/comment wallet spoofing (no sign-in check)
- [ ] M-3 predictable live stream keys + open 0.0.0.0/0 ingest security group
- [ ] M-5 sessions signed with service key, 7-day tokens, no revocation
- [ ] M-7 no site-wide browser security headers (clickjacking etc.)
- [ ] M-10 email verification link returned to caller, no rate limit
- [ ] M-11 admin/diagnostic tools exposed without sign-in
