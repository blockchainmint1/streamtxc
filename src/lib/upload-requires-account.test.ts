import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Rule: anonymous uploads are closed — every upload step needs a signed-in account.
const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("uploads require an Honest.Money account", () => {
  test("upload server steps use requireWalletSession, never optional", () => {
    for (const f of ["./transcode.functions.ts", "./ipfs-lambda.functions.ts", "./videos.functions.ts", "./imports.functions.ts"]) {
      expect(src(f)).not.toContain("optionalWalletSession");
    }
    const v = src("./videos.functions.ts");
    for (const fn of ["registerUpload", "addByCid", "pinThumbnail", "createUploadDraft"]) {
      expect(v).toMatch(new RegExp(`export const ${fn} = createServerFn\\([^)]*\\)\\s*\\.middleware\\(\\[requireWalletSession\\]\\)`));
    }
  });
  test("direct file upload endpoint rejects requests without a session", () => {
    const r = src("../routes/api/public/upload.ts");
    expect(r).toContain("verifySessionToken");
    expect(r).toContain("status: 401");
  });
});
