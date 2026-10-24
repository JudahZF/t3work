import { assert, describe, it } from "@effect/vitest";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

import apiComments from "./fixtures/api-comments.json" with { type: "json" };
import apiCommits from "./fixtures/api-commits.json" with { type: "json" };
import apiFiles from "./fixtures/api-files.json" with { type: "json" };
import apiPullsAll from "./fixtures/api-pulls-all.json" with { type: "json" };
import apiMergeability from "./fixtures/api-mergeability.json" with { type: "json" };
import apiReviews from "./fixtures/api-reviews.json" with { type: "json" };
import {
  OriginCheckRunPage,
  OriginCommentPage,
  OriginCommitPage,
  OriginFilePage,
  OriginMergeability,
  OriginReviewPage,
  originActivity,
  originChangeRequest,
  originChecks,
  originCommits,
  originFilesPatch,
  originLabelCandidates,
  originMergeability,
  originReviewDecision,
  originReviewerCandidates,
  originStackLayers,
} from "./originPullRequestJson.ts";
import { OriginApiPullRequestPageSchema } from "./originJson.ts";

const ada = { handle: "ada", id: "user_01ada00000000000000000000" };

const decode = <A>(schema: Schema.Codec<A, unknown, never, never>, value: unknown): A => {
  const decoded = decodeJsonResult(schema)(JSON.stringify(value));
  assert.ok(Result.isSuccess(decoded));
  return decoded.success;
};

describe("originPullRequestJson", () => {
  it("reads general discussion as conversation and anchored threads as review threads", () => {
    const activity = originActivity({
      currentVersion: 1,
      viewer: ada,
      comments: decode(OriginCommentPage, apiComments).comments,
      reviews: decode(OriginReviewPage, apiReviews).reviews,
    });
    assert.deepStrictEqual(
      activity.comments.map((comment) => [comment.kind, comment.body, comment.reviewState]),
      [
        ["issue-comment", "A smoke comment", null],
        ["review", "A review comment", "COMMENTED"],
        ["issue-comment", "a reply", null],
        ["review", "looks fine", "COMMENTED"],
        ["review-comment", "Why this line?", null],
      ],
    );
    assert.deepStrictEqual(
      activity.reviewThreads.map(({ path, line, side, isResolved, comments }) => ({
        path,
        line,
        side,
        isResolved,
        bodies: comments.map((comment) => comment.body),
      })),
      [
        {
          path: "README.md",
          line: 2,
          side: "right",
          isResolved: false,
          bodies: ["Why this line?"],
        },
      ],
    );
    assert.isFalse(activity.reviewThreads[0]?.isOutdated);
    // A push records version 2, and the thread filed on version 1 no longer anchors to it.
    const later = originActivity({
      currentVersion: 2,
      viewer: ada,
      comments: decode(OriginCommentPage, apiComments).comments,
      reviews: [],
    });
    assert.isTrue(later.reviewThreads[0]?.isOutdated);
    assert.strictEqual(activity.comments[0]?.author?.login, "ada");
    // Origin takes reactions on comments only, so a review summary offers none.
    assert.deepStrictEqual(
      activity.comments.filter((comment) => comment.kind === "review").map((c) => c.canReact),
      [false, false],
    );
    // Commit dates carry the committer's offset; the timeline wants UTC.
    assert.deepStrictEqual(originCommits(decode(OriginCommitPage, apiCommits)), [
      {
        oid: "742e3e59c256e0d6205943cce4d88b5ba3279683",
        messageHeadline: "Add a change",
        committedDate: "2026-10-16T16:33:47.000Z",
      },
    ]);
  });

  it("restores git headers around the files API's hunks", () => {
    assert.deepStrictEqual(originFilesPatch(decode(OriginFilePage, apiFiles).files), {
      patch:
        "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n # smoke\n+change\n",
      omittedFileStats: [],
    });
    const { patch, omittedFileStats } = originFilesPatch([
      { filename: "new.txt", status: "added", patch: "@@ -0,0 +1 @@\n+hi", additions: 1 },
      { filename: "b.txt", previousFilename: "a.txt", status: "renamed" },
      { filename: "d.txt", previousFilename: "c.txt", status: "renamed", additions: 2 },
      { filename: "logo.png", status: "modified" },
      { filename: "huge.json", status: "modified", additions: 9000, deletions: 3 },
    ]);
    assert.strictEqual(
      patch,
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+hi",
        // T3's diff parser reads a rename only with a similarity line.
        "diff --git a/a.txt b/b.txt",
        "similarity index 100%",
        "rename from a.txt",
        "rename to b.txt",
        // Line counts without a patch still mean the content changed.
        "diff --git a/c.txt b/d.txt",
        "similarity index 90%",
        "rename from c.txt",
        "rename to d.txt",
        "diff --git a/logo.png b/logo.png",
        "Binary files a/logo.png and b/logo.png differ",
        "diff --git a/huge.json b/huge.json",
        "",
      ].join("\n"),
    );
    assert.deepStrictEqual(omittedFileStats, [
      { path: "d.txt", additions: 2, deletions: 0 },
      { path: "huge.json", additions: 9000, deletions: 3 },
    ]);
  });

  it("names an actor without a public handle by its stable id", () => {
    const activity = originActivity({
      currentVersion: null,
      viewer: ada,
      comments: [],
      reviews: [
        {
          id: "rev_1",
          author: { app: { id: "app_bugbot", displayName: "Bugbot" } },
          verdict: "comment",
          submittedAt: "2026-10-01T00:00:00Z",
        },
        {
          id: "rev_2",
          author: { user: { id: "user_private" } },
          verdict: "comment",
          submittedAt: "2026-10-02T00:00:00Z",
        },
      ],
    });
    assert.deepStrictEqual(
      activity.comments.map((comment) => comment.author),
      [
        { login: "app_bugbot", name: "Bugbot", avatarUrl: null, isBot: true },
        { login: "user_private", name: null, avatarUrl: null },
      ],
    );
  });

  it("lets each reviewer's latest standing verdict decide", () => {
    const review = (handle: string, verdict: string, submittedAt: string, dismissed = false) => ({
      id: `${handle}-${submittedAt}`,
      author: { user: { handle } },
      verdict,
      submittedAt,
      ...(dismissed ? { dismissal: { reason: "stale" } } : {}),
    });
    assert.strictEqual(
      originReviewDecision([
        review("bo", "request_changes", "2026-10-01T00:00:00Z"),
        review("bo", "approve", "2026-10-02T00:00:00Z"),
      ]),
      "approved",
    );
    assert.strictEqual(
      originReviewDecision([
        review("bo", "approve", "2026-10-01T00:00:00Z"),
        review("cy", "request_changes", "2026-10-02T00:00:00Z", true),
      ]),
      "approved",
    );
    assert.isNull(originReviewDecision([review("bo", "comment", "2026-10-01T00:00:00Z")]));
  });

  it("reads mergeability and check runs", () => {
    assert.strictEqual(
      originMergeability(decode(OriginMergeability, apiMergeability)),
      "mergeable",
    );
    assert.strictEqual(
      originMergeability({ verdict: "blocked", blockers: [{ kind: "merge_conflict" }] }),
      "conflicting",
    );
    // Shaped from the OpenAPI spec: Origin does not let a user account post check runs.
    const runs = decode(OriginCheckRunPage, {
      checkRuns: [
        { name: "lint", status: "completed", conclusion: "success", detailsUrl: "https://ci/1" },
        { name: "unit", status: "in_progress" },
        { name: "e2e", status: "completed", conclusion: "timed_out" },
        { name: "test", status: "completed", conclusion: "success", checkSuite: { name: "web" } },
        { name: "test", status: "completed", conclusion: "failure", checkSuite: { name: "api" } },
      ],
    });
    // Two current checks sharing a name are both kept, so a failure is never hidden.
    assert.deepStrictEqual(
      originChecks(runs).map((check) => [check.name, check.status]),
      [
        ["lint", "success"],
        ["unit", "pending"],
        ["e2e", "failure"],
        ["web / test", "success"],
        ["api / test", "failure"],
      ],
    );
  });

  it("reads comment reactions from the viewer's side", () => {
    const comment = {
      id: "cmt_1",
      thread: { id: "cth_1" },
      body: "nice",
      createdAt: "2026-10-01T00:00:00Z",
      author: { user: { handle: "bo" } },
      reactions: [
        { emoji: "👍", reactor: { user: { handle: "ada" } } },
        { emoji: "👍", reactor: { user: { handle: "cy" } } },
        { emoji: "✅", reactor: { user: { handle: "cy" } } },
      ],
    };
    const [read] = originActivity({
      currentVersion: null,
      viewer: ada,
      comments: [comment],
      reviews: [],
    }).comments;
    // An emoji T3 Code has no name for is left out.
    assert.deepStrictEqual(read?.reactions, [
      { content: "thumbs-up", count: 2, actors: ["cy"], viewerHasReacted: true },
    ]);
    assert.isFalse(read?.canEdit);
  });

  it("offers granted users and groups as reviewers, leaving out the author", () => {
    assert.deepStrictEqual(
      originReviewerCandidates({
        grants: [
          { user: { id: "user_ada", handle: "ada" } },
          { user: { id: "user_bo", handle: "bo", displayName: "Bo" } },
          { group: { id: "grp_web", slug: "web" } },
        ],
        // Cy was asked on Origin without a grant here, and can still be un-asked.
        requested: { users: [{ id: "user_bo" }, { id: "user_cy", handle: "cy" }] },
        author: "ada",
        viewer: ada,
      }),
      [
        {
          id: "user_bo",
          kind: "user",
          login: "bo",
          name: "Bo",
          avatarUrl: null,
          isRequested: true,
        },
        {
          id: "grp_web",
          kind: "team",
          login: "web",
          name: null,
          avatarUrl: null,
          isRequested: false,
        },
        {
          id: "user_cy",
          kind: "user",
          login: "cy",
          name: null,
          avatarUrl: null,
          isRequested: true,
        },
      ],
    );
    assert.deepStrictEqual(
      originLabelCandidates([{ name: "bug", color: "d73a4a", description: "" }], ["bug"]),
      [{ name: "bug", color: "d73a4a", description: null, isApplied: true }],
    );
  });

  it("follows a stack from its root, stopping where it branches above the read layer", () => {
    const pull = (number: number, parent?: number) => ({
      ...apiPullsAll.pullRequests[0]!,
      number: String(number),
      stack: { id: "stk", ...(parent ? { parentPullRequest: { number: String(parent) } } : {}) },
    });
    const members = decode(OriginApiPullRequestPageSchema, {
      pullRequests: [pull(4, 3), pull(5, 3), pull(3, 2), pull(2), pull(6, 4)],
    }).pullRequests;
    assert.deepStrictEqual(
      originStackLayers(members, 3).map((layer) => layer.number),
      [2, 3],
    );
    assert.deepStrictEqual(
      originStackLayers(members, 4).map((layer) => layer.number),
      [2, 3, 4, 6],
    );
  });

  it("knows the viewer by id when Origin leaves a private profile's handle out", () => {
    const [comment] = originActivity({
      currentVersion: null,
      viewer: ada,
      comments: [
        {
          id: "cmt_1",
          thread: { id: "cth_1" },
          body: "mine",
          createdAt: "2026-10-01T00:00:00Z",
          author: { user: { id: ada.id } },
          reactions: [{ emoji: "👍", reactor: { user: { id: ada.id } } }],
        },
      ],
      reviews: [],
    }).comments;
    assert.strictEqual(comment?.author?.login, "ada");
    assert.isTrue(comment?.canEdit);
    assert.deepStrictEqual(comment?.reactions, [
      { content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true },
    ]);
  });

  it("keeps an app's pull request authored by the app", () => {
    const pull = decode(OriginApiPullRequestPageSchema, {
      pullRequests: [
        {
          ...apiPullsAll.pullRequests[0]!,
          author: { app: { id: "app_1", slug: "bugbot", name: "Bugbot" } },
        },
      ],
    }).pullRequests[0]!;
    assert.deepStrictEqual(originChangeRequest(pull).author, {
      login: "bugbot",
      name: "Bugbot",
      avatarUrl: null,
      isBot: true,
    });
  });
});
