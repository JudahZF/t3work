import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import apiPullsAll from "./fixtures/api-pulls-all.json" with { type: "json" };
import namespaces from "./fixtures/namespaces.json" with { type: "json" };
import prViewDraft from "./fixtures/pr-view-draft.json" with { type: "json" };
import prViewMerged from "./fixtures/pr-view-merged.json" with { type: "json" };
import {
  decodeOriginPullRequestView,
  originApiPullRequestToChangeRequest,
  originPullRequestViewToChangeRequest,
  parseOriginApiPullRequestPage,
  parseOriginViewerHandle,
} from "./originJson.ts";

// Fixtures are `origin` 2026.10.01 output, recorded against a throwaway repository and scrubbed
// of account details. A beta CLI that changes its JSON fails here rather than at runtime.
describe("originJson", () => {
  it("reads every pull request state from a recorded API page", () => {
    const page = parseOriginApiPullRequestPage(JSON.stringify(apiPullsAll));
    assert.ok(page);
    assert.strictEqual(page.nextPageToken, null);
    const rows = page.pullRequests.map(originApiPullRequestToChangeRequest);
    assert.deepStrictEqual(
      rows.map((row) => [row.number, row.state, row.isDraft ?? false]),
      [
        [4, "closed", false],
        [3, "merged", false],
        [2, "open", true],
        [1, "open", false],
      ],
    );
    const merged = rows[1]!;
    assert.strictEqual(merged.url, "https://cursor.com/codebase/ada/demo/pull/3");
    assert.strictEqual(merged.headRefName, "feat/merged");
    assert.isNotNull(merged.mergedAt);
    assert.isTrue(Option.isSome(merged.updatedAt));
  });

  it("skips a row it cannot read instead of failing the page", () => {
    const page = parseOriginApiPullRequestPage(
      JSON.stringify({
        pullRequests: [{ number: "not a number" }, ...apiPullsAll.pullRequests.slice(0, 1)],
        nextPageToken: "next",
      }),
    );
    assert.deepStrictEqual(
      page?.pullRequests.map((row) => row.number),
      [4],
    );
    assert.strictEqual(page?.nextPageToken, "next");
    assert.isUndefined(parseOriginApiPullRequestPage('{"message":"not a page"}'));
  });

  it("reads `origin pr view`, which reports drafts as their own status", () => {
    const draft = decodeOriginPullRequestView(JSON.stringify(prViewDraft));
    assert.ok(Result.isSuccess(draft));
    const draftRequest = originPullRequestViewToChangeRequest(draft.success);
    assert.strictEqual(draftRequest.state, "open");
    assert.strictEqual(draftRequest.isDraft, true);

    const merged = decodeOriginPullRequestView(JSON.stringify(prViewMerged));
    assert.ok(Result.isSuccess(merged));
    assert.strictEqual(originPullRequestViewToChangeRequest(merged.success).state, "merged");
  });

  it("names the account by its own namespace", () => {
    assert.strictEqual(parseOriginViewerHandle(JSON.stringify(namespaces)), "ada");
    assert.isNull(parseOriginViewerHandle('{"namespaces":[]}'));
  });
});
