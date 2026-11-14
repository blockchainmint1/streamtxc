# HME API update
- [x] Fix audit H-1 media execution, H-2 canonical wallet messages and browser-only exchange proof, M-4 fail-open signatures, M-6 branch identity binding, and H-3 confirmed-only renewals. 27 regression tests pass; real signed QR callback/exchange and replay rejection verified, plus actual archive thumbnail, playlist and segment reads. Publication and an HME Wallet phone check remain required; no real renewal payment or existing branch was changed during testing.
- [x] Build and test append-only historical repair with IPFS read-back and persisted signed transactions; 362 records repaired, originals retained.
- [x] Finish remaining historical records: all 543 complete, 543 unique transactions, total fees 0.01434591 TXC; script now pages past 1000 rows.
- [x] Check current HME API instructions and existing member links; HME confirmed all four stored UUIDs.
- [x] Switch SSO, Hub reporting, and profile updates to HME_ECOSYSTEM and permanent UUIDs without changing wallet ownership.
- [x] Test real member lookup and Hub reporting; test signed site ticket through the browser to Bobby's 103-video account, replay rejection and profile sync; ten protocol tests pass.
- [ ] Confirm an HME-issued sign-in after publishing and HME's automatic profile-update delivery. Blocker: no HME browser session; publication and sender registration are outside this turn. Test tickets were generated server-side, not issued through HME's login screen.
# Audit medium items still open (verified in code Nov 11)
- [x] M-1 Dropbox shortcut imports must be real Dropbox https links (tested)
- [x] M-2 chat requires sign-in; comments/boosts credit only the signed-in wallet, else "anon"
- [x] M-3 new channels get random keys; "Make a new stream key" button; no auto-created open groups
- [ ] M-3 follow-up: replace Bobby's and TsNCJ…'s old "primary" keys. AWS permission done + tested. Waiting on Bobby: press the button on a non-stream day, update StreamYard.
- [x] M-5 own SESSION_SECRET, server-side sessions (sign-out cancels, "Sign out everywhere"), import tokens off the service key, admin wallet in one place; revocation tested against the database
- [x] M-7 site-wide headers (anti-framing except /embed, nosniff, referrer, HSTS); full script CSP / hm.js pinning not done (hm.js updates itself)
- [x] M-10 link never returned, 1/min and 5/day per wallet, verify page escaped
- [x] M-11 diagnostic tools now return only status/progress; raw errors owner-only; tests added
# Team meetings (/meet)
- [x] Build /meet host page, team link + view-only link, meeting screen (mic, camera, screen share, leave, end for all), send-to-live-stream button; 6 link-rule tests pass.
- [x] AWS Chime permission granted; room join/roles verified in browser.
- [ ] Live meeting test with real audio/video. Blocker: needs Bobby on real devices after publishing (test browser can't place calls).
- [x] Charge hosts ~10x AWS cost from prepaid TXC balance (admin room free); seat freed on leave; real AWS seat count test passed.
- [x] Meeting settings: multiple named rooms with own links, join sound (+ personal mute), approve team / view-only link with waiting room; browser-tested create → approve → admit → delete.
- [x] Bobby's 4th/5th meeting settings: record option + transcript/meeting notes (room auto-settings + Record / Take notes buttons, private recording page, one-click publish, AI summary/decisions/to-dos). 33 meeting tests pass; AI notes tested live; Record button shows the AWS-setup message.
- [x] Conference section on /manage (same rooms as /meet: create, rename, copy links, start/join).
- [ ] Recording + notes end-to-end test. Blocker: Bobby must run the AWS setup command (recordings bucket + permissions), then a real meeting.
- [x] Fixed duplicate "Daily team meeting" rooms (19 accidental copies archived; failed room lookups no longer create rooms).
- [ ] Discuss with Bobby how people pay in TXC (top-up flow, pay-per-meeting, plans). Blocker: Bobby's decision.
# Captions
- [x] Transcription request used a format the AI service rejects (0 videos had transcripts); now saves transcript text.
- [ ] Timed closed captions (.vtt). Blocker: AI service returns no timings; needs Amazon Transcribe (Bobby decision + AWS permission).
