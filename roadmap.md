# Roadmap

Public repository — keep this list free of personal names, emails, wallet labels, infrastructure IDs and details of open security gaps.

## Open
- [ ] Rotate the remaining legacy live stream key on a non-streaming day (owner action on /manage, then update the streaming app).
- [ ] Confirm a real Honest.Money-issued sign-in and automatic profile-update delivery after publishing.
- [ ] Real-device meeting test with audio/video, recording and notes.
- [ ] Decide how people pay for meetings in TXC (top-up, pay-per-meeting or plans).
- [ ] Timed closed captions (.vtt) — needs a transcription service that returns timings.

## Done
- Wallet sign-in, Honest.Money SSO with permanent member IDs, HME Wallet branch filing and on-chain records (JSON on IPFS, compact pointer on chain).
- Historical on-chain record supplements (append-only; originals preserved).
- Team meetings at /meet: named rooms, waiting room, join sounds, view-only links, live-stream hand-off, recording and AI notes, prepaid TXC billing.
- Security audit rounds 1 and 2 addressed; see SECURITY.md for reporting.
- Public-release readiness: history scanned (no secrets), docs/LICENSE/SECURITY added, internal notes scrubbed.
- [ ] Upload payment packs (prepaid TXC bundles, modelled on File Fingerprint / Passage) — waiting on pack sizes and prices
- [ ] Rotate the remaining legacy live stream key (next session)
- [ ] Studio: real-device rehearsal (studio picture → Send to live stream → YouTube/Facebook)
- [ ] Multistream: confirm the AWS user may update live channels (UpdateChannel); check per-output cost before charging TXC for it
- [ ] One-click "connect your YouTube/Facebook/Twitch" for guests — needs each platform's app approval
