# HME API update
- [ ] Fix audit H-1 media execution, H-2 canonical wallet messages and browser-only exchange proof, M-4 fail-open signatures, M-6 branch identity binding, and H-3 confirmed-only renewals; verify normal playback and rejection paths.
- [x] Build and test append-only historical repair with IPFS read-back and persisted signed transactions; 362 records repaired, originals retained.
- [ ] Finish remaining 181 historical records. Current turn reached its time budget; rerun scripts/repair-historical-chain-records.ts in small serial batches, which skips completed records and reuses prepared transactions. Gateway propagation retries and unambiguous original-chain destination recovery are supported.
- [x] Check current HME API instructions and existing member links; HME confirmed all four stored UUIDs.
- [x] Switch SSO, Hub reporting, and profile updates to HME_ECOSYSTEM and permanent UUIDs without changing wallet ownership.
- [x] Test real member lookup and Hub reporting; test signed site ticket through the browser to Bobby's 103-video account, replay rejection and profile sync; ten protocol tests pass.
- [ ] Confirm an HME-issued sign-in after publishing and HME's automatic profile-update delivery. Blocker: no HME browser session; publication and sender registration are outside this turn. Test tickets were generated server-side, not issued through HME's login screen.