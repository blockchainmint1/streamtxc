import { describe, expect, test as it } from "bun:test";
import { renderAppEmail } from "./app-email-content";

describe("app emails", () => {
  it("verify email carries the confirm link", () => {
    const m = renderAppEmail("wallet-verify-email", { verifyLink: "https://streamtxc.com/api/public/notify/verify-email?token=abc" })!;
    expect(m.html).toContain("token=abc");
  });
  it("escapes video titles", () => {
    const m = renderAppEmail("video-unpinned", { title: "<script>x</script>", manageUrl: "https://streamtxc.com/manage" })!;
    expect(m.html).not.toContain("<script>");
  });
  it("drops non-https links", () => {
    const m = renderAppEmail("live-stream-starting", { title: "t", url: "javascript:alert(1)" })!;
    expect(m.html).not.toContain("javascript:");
  });
});
