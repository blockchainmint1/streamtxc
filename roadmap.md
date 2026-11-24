# Roadmap

Public repository — keep this list free of personal names, emails, wallet labels, infrastructure IDs and details of open security gaps.

## Open
- [ ] Rotate the remaining legacy live stream key on a non-streaming day (owner action on /manage, then update the streaming app).
- [ ] Confirm a real Honest.Money-issued sign-in and automatic profile-update delivery after publishing.
- [ ] Real-device meeting test with audio/video, recording and notes.
- [ ] Studio rehearsal: studio picture → Send to live stream → YouTube/Facebook.
- [ ] Multistream: AWS update permission confirmed; still needs a real rehearsal stream to YouTube/Facebook, and a per-output cost check before charging TXC for it.
- [ ] Decide how people pay for meetings in TXC (top-up, pay-per-meeting or plans).
- [ ] Upload payment packs (prepaid TXC bundles, modelled on File Fingerprint / Passage) — waiting on pack sizes and prices.
- [ ] One-click "connect your YouTube/Facebook/Twitch" for guests — needs each platform's app approval.
- [ ] Timed closed captions (.vtt) — needs a transcription service that returns timings.

## Done
- Wallet sign-in, Honest.Money SSO with permanent member IDs, HME Wallet branch filing and on-chain records (JSON on IPFS, compact pointer on chain).
- Historical on-chain record supplements (append-only; originals preserved).
- Team meetings at /meet: named rooms, waiting room, join sounds, view-only links, live-stream hand-off, recording and AI notes, prepaid TXC billing.
- Security audit rounds 1 and 2 addressed; see SECURITY.md for reporting.
- Public-release readiness: history scanned (no secrets), docs/LICENSE/SECURITY added, internal notes scrubbed.
- Manage page UX/UI overhaul (tabs, tidy rows, phone cards, live checklist).
- Green room: server-enforced backstage pause verified against real AWS — a backstage seat's mic, camera and screen share are cut at the source, and bringing them on stage restores them.
