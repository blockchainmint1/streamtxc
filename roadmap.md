# HME API update
- [x] Fix audit H-1 media execution, H-2 canonical wallet messages and browser-only exchange proof, M-4 fail-open signatures, M-6 branch identity binding, and H-3 confirmed-only renewals. 27 regression tests pass; real signed QR callback/exchange and replay rejection verified, plus actual archive thumbnail, playlist and segment reads. Publication and an HME Wallet phone check remain required; no real renewal payment or existing branch was changed during testing.
- [x] Build and test append-only historical repair with IPFS read-back and persisted signed transactions; 362 records repaired, originals retained.
- [x] Finish remaining historical records: all 543 complete, 543 unique transactions, total fees 0.01434591 TXC; script now pages past 1000 rows.
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
- [x] M-11 diagnostic tools now return only status/progress; raw errors owner-only; tests added
# Team meetings (/meet)
- [x] Build /meet host page, team link + view-only link, meeting screen (mic, camera, screen share, leave, end for all), send-to-live-stream button; 6 link-rule tests pass.
- [x] AWS Chime permission granted; room join/roles verified in browser.
- [ ] Live meeting test with real audio/video. Blocker: needs Bobby on real devices after publishing (test browser can't place calls).
- [x] Charge hosts ~10x AWS cost from prepaid TXC balance (admin room free); seat freed on leave; real AWS seat count test passed.
- [ ] Discuss with Bobby how people pay in TXC (top-up flow, pay-per-meeting, plans). Blocker: Bobby's decision.
