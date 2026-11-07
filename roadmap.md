# HME API update
- [x] Build and test append-only historical repair with IPFS read-back and persisted signed transactions; 222 records repaired, originals retained.
- [ ] Finish remaining 321 historical records. Current run stopped at execution time limit; rerun scripts/repair-historical-chain-records.ts in small serial batches, which skips completed records and reuses prepared transactions.
- [x] Check current HME API instructions and existing member links; HME confirmed all four stored UUIDs.
- [x] Switch SSO, Hub reporting, and profile updates to HME_ECOSYSTEM and permanent UUIDs without changing wallet ownership.
- [x] Test real member lookup and Hub reporting; test signed site ticket through the browser to Bobby's 103-video account, replay rejection and profile sync; ten protocol tests pass.
- [ ] Confirm an HME-issued sign-in after publishing and HME's automatic profile-update delivery. Blocker: no HME browser session; publication and sender registration are outside this turn. Test tickets were generated server-side, not issued through HME's login screen.