import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

describe("GitHub client definition", () => {
  // GitHub Enterprise runs on any host, so the path shape is all that tells a GitHub link apart;
  // Cursor Origin's `/codebase/owner/repo/pull/N` must stay Origin's.
  it("claims only /owner/repo/pull/N links", () => {
    expect(definition.isChangeRequestUrl("https://github.acme.test/acme/web/pull/7")).toBe(true);
    expect(definition.isChangeRequestUrl("https://github.com/acme/web/pull/7/files")).toBe(true);
    expect(definition.isChangeRequestUrl("https://cursor.com/codebase/acme/web/pull/7")).toBe(
      false,
    );
  });
});
