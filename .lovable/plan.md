## What's happening

The video isn't actually expiring in 14.7 hours. In the database, `expires_at` for `bafybei…iba` is **37 days out** — the +7-day extension worked.

The "14.7h" is a **stale UI countdown** on the video page that's hardcoded to 24, not reading the `PAYMENT_GRACE_HOURS` constant we bumped to `24 * 7` in `src/lib/fees.ts`.

```
src/routes/v.$cid.tsx:655
const graceLeft = Math.max(0, 24 - ageHrs);   // ← hardcoded 24
```

Video uploaded ~9.3h ago → 24 − 9.3 ≈ 14.7h. Exact match.

The watcher (`payment-watcher.ts`) already uses `PAYMENT_GRACE_HOURS` correctly, so the actual unpin behavior is on the 7-day clock — only the user-visible countdown lies.

## Plan

One file, two-line fix in `src/routes/v.$cid.tsx`:

1. Import the constant:
   ```ts
   import { PAYMENT_GRACE_HOURS } from "@/lib/fees";
   ```
2. Replace line 655:
   ```ts
   const graceLeft = Math.max(0, PAYMENT_GRACE_HOURS - ageHrs);
   ```
3. Update the display at line 785 so values >24h render as days instead of an awkward "162.3h":
   ```tsx
   {graceLeft <= 0
     ? "0h"
     : graceLeft >= 48
       ? `${(graceLeft / 24).toFixed(1)} days`
       : `${graceLeft.toFixed(1)}h`}
   ```

No DB changes, no watcher changes, no other files. After this, your video will correctly show ~6.6 days of grace remaining instead of 14.7 hours.

## Out of scope

- The actual 37-day `expires_at` is already correct from the previous bulk update; not touching it.
- Other "24h" copy in `upload.tsx` / `about.tsx` was already updated to "7 days" in the prior change — verified, nothing else to fix.
