// Reports streamTXC sign-ins/signups to the honest.money Hub (honest.money/api §3).
// Best-effort: never blocks a sign-in.
import { HME_SITE } from "./hme-protocol";
export const HM_SERVICE = HME_SITE;

export async function sendHubEvent(args: {
  event: "signup" | "service_used" | "purchase";
  memberId?: string | null;
  email?: string | null;
  ref?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const secret = process.env.HME_ECOSYSTEM;
  if (!secret) return;
  try {
    await fetch("https://honest.money/api/public/hub/events", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "X-HME-Site": HM_SERVICE, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
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

export { BLOCKED_STATUSES } from "./hme-protocol";
