import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import apiPullsAll from "./fixtures/api-pulls-all.json" with { type: "json" };
import apiStack from "./fixtures/api-stack.json" with { type: "json" };
import * as OriginCli from "./OriginCli.ts";
import * as OriginPullRequestProvider from "./OriginPullRequestProvider.ts";

const ref = { cwd: "/repo", repository: "ada/demo", host: "origin.cursor.com" };
const viewerNamespace = { slug: "ada", type: "user" };

/** Answers `origin api` from `answer`, recording each request. */
function originApi(answer: (input: OriginCli.OriginApiInput) => unknown) {
  const requests: Array<OriginCli.OriginApiInput> = [];
  const layer = Layer.mock(OriginCli.OriginCli)({
    api: (input) => {
      if (input.path === "/namespaces")
        return Effect.succeed(JSON.stringify({ namespaces: [{ namespace: viewerNamespace }] }));
      requests.push(input);
      return Effect.succeed(JSON.stringify(answer(input) ?? {}));
    },
    // `origin auth status --json`, which names the viewer's stable id.
    execute: () =>
      Effect.succeed(
        JSON.stringify({ authenticated: true, account: { publicUserId: "user_ada" } }),
      ),
  });
  return { requests, layer };
}

describe("OriginPullRequestProvider", () => {
  it.effect("pages past delivered rows, and searches for closed without merged", () => {
    const pulls = apiPullsAll.pullRequests;
    const api = originApi((input) =>
      input.path.includes("pageToken=p2")
        ? { pullRequests: pulls.slice(2), nextPageToken: "" }
        : { pullRequests: pulls.slice(0, 2), nextPageToken: "p2" },
    );
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const closed = yield* provider.listChangeRequests({
        ...ref,
        state: "closed",
        involvement: "all",
        viewer: "ada",
        limit: 10,
      });
      // The list endpoint's "closed" includes merged pull requests, so closed is a search that
      // leaves them out; a merged row that slips through is still dropped.
      assert.deepStrictEqual(
        closed.items.map((item) => item.number),
        [4],
      );
      assert.strictEqual(closed.truncated, false);
      const search = new URL(`https://api.test${api.requests[0]?.path}`);
      assert.strictEqual(search.pathname, "/search/pulls");
      assert.strictEqual(search.searchParams.get("q"), "is:closed is:unmerged");

      const next = yield* provider.listChangeRequests({
        ...ref,
        state: "all",
        involvement: "all",
        viewer: "ada",
        limit: 1,
        cursor: { updatedBefore: "2026-10-16T16:45:13Z", delivered: 2 },
      });
      assert.deepStrictEqual(
        next.items.map((item) => [item.number, item.isDraft]),
        [[2, true]],
      );
      assert.strictEqual(next.cursorAdvance, 1);
      // #1 is still on the page the limit stopped in.
      assert.strictEqual(next.truncated, true);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("searches for involvement, text, and filters, and marks review requests", () => {
    const api = originApi(() => ({
      pullRequests: apiPullsAll.pullRequests.slice(3),
      nextPageToken: "",
    }));
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const page = yield* provider.listChangeRequests({
        ...ref,
        state: "open",
        involvement: "reviewing",
        viewer: "bo",
        limit: 10,
        query: 'fix "login"',
        filters: {
          labels: [["bug", "p1"]],
          excludedLabels: ["wip"],
          draft: "hide",
          checks: "passing",
        },
      });
      assert.deepStrictEqual(page.items[0]?.reviewRequestLogins, ["bo"]);
      // What the search matched on is what each row has, so the client's own filter keeps it.
      const approved = yield* provider.listChangeRequests({
        ...ref,
        state: "open",
        involvement: "all",
        viewer: "bo",
        limit: 10,
        filters: { review: "approved" },
      });
      assert.strictEqual(approved.items[0]?.reviewDecision, "approved");
      const url = new URL(`https://api.test${api.requests[0]?.path}`);
      assert.strictEqual(url.pathname, "/search/pulls");
      assert.strictEqual(url.searchParams.get("repo"), "ada/demo");
      // No `status:`: Origin does not index CI, so the caller narrows checks.
      assert.strictEqual(
        url.searchParams.get("q"),
        'is:open review-requested:@me "fix \\"login\\"" label:"bug","p1" -label:"wip" draft:false',
      );
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("sends each action as the API expects it", () => {
    const api = originApi((input) =>
      input.method === undefined ? { ...apiPullsAll.pullRequests[2], state: "closed" } : {},
    );
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      yield* provider.runAction({ ...ref, number: 2, action: "merge", mergeMethod: "squash" });
      yield* provider.runAction({ ...ref, number: 2, action: "draft" });
      // A closed draft reopens as a draft.
      yield* provider.runAction({ ...ref, number: 2, action: "reopen" });
      const writes = api.requests.filter((request) => request.method !== undefined);
      assert.deepStrictEqual(
        writes.map(({ path, method, body }) => ({ path, method, body })),
        [
          {
            path: "/repos/ada/demo/pulls/2/merge",
            method: "POST",
            // Fenced on the head that was read, so a push in between is not merged unseen.
            body: { mergeMethod: "squash", expectedHeadSha: apiPullsAll.pullRequests[2]!.head.sha },
          },
          { path: "/repos/ada/demo/pulls/2", method: "PATCH", body: { draft: true } },
          {
            path: "/repos/ada/demo/pulls/2",
            method: "PATCH",
            body: { state: "open", draft: true },
          },
        ],
      );
      const refused = yield* provider
        .runAction({ ...ref, number: 2, action: "update-branch" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.detail, "Cursor Origin does not support update-branch.");
      const rebase = yield* provider
        .runAction({ ...ref, number: 2, action: "merge", mergeMethod: "rebase" })
        .pipe(Effect.flip);
      assert.strictEqual(rebase.detail, "Cursor Origin does not support rebase merges.");
    }).pipe(Effect.provide(api.layer));
  });

  it("anchors a removed line on the base side under its old path", () => {
    assert.deepStrictEqual(
      OriginPullRequestProvider.originInlineAnchor({
        path: "new.ts",
        oldPath: "old.ts",
        position: { kind: "deleted", oldLine: 7 },
        body: "Why remove this?",
      }),
      { path: "old.ts", side: "left", startLine: 7 },
    );
    assert.deepStrictEqual(
      OriginPullRequestProvider.originInlineAnchor({
        path: "new.ts",
        position: { kind: "context", oldLine: 3, newLine: 4, side: "right" },
        body: "Nit",
      }),
      { path: "new.ts", side: "right", startLine: 4 },
    );
  });

  it.effect("lands a stack through a layer only when every head it moves is current", () => {
    const [top, root] = apiStack.pullRequests;
    const api = originApi((input) =>
      input.path.includes("stackId=")
        ? apiStack
        : input.path.endsWith("/pulls/2")
          ? top
          : input.path.endsWith("/pulls/1")
            ? root
            : {},
    );
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const stack = yield* provider.getChangeRequestStack!({ ...ref, number: 2 });
      // Named by its root; the merged root stays a layer until the child is retargeted.
      assert.deepStrictEqual(
        stack && {
          number: stack.number,
          base: stack.base,
          layers: stack.layers.map((l) => [l.number, l.state]),
        },
        {
          number: 1,
          base: "main",
          layers: [
            [1, "merged"],
            [2, "open"],
          ],
        },
      );

      const autoMerge = yield* provider
        .runAction({ ...ref, number: 2, action: "enable-auto-merge" })
        .pipe(Effect.flip);
      assert.match(autoMerge.detail, /Merge it from the stack/);
      const direct = yield* provider
        .runAction({ ...ref, number: 2, action: "merge" })
        .pipe(Effect.flip);
      assert.match(direct.detail, /Merge it from the stack/);
      const stale = yield* provider
        .runAction({
          ...ref,
          number: 2,
          action: "merge",
          stackNumber: 1,
          expectedStackHeads: [{ number: 2, headSha: "0".repeat(40) }],
        })
        .pipe(Effect.flip);
      assert.match(stale.detail, /stack changed/);
      assert.isFalse(api.requests.some((request) => request.method === "POST"));

      yield* provider.runAction({
        ...ref,
        number: 2,
        action: "merge",
        mergeMethod: "squash",
        stackNumber: 1,
        expectedStackHeads: [{ number: 2, headSha: top!.head.sha }],
      });
      assert.deepStrictEqual(api.requests.at(-1)?.body, {
        mergeMethod: "squash",
        expectedHeadSha: top!.head.sha,
      });
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("keeps viewed marks by blob, and reads a path gone from the head as deleted", () => {
    const api = originApi((input) =>
      input.path.includes("/git/trees/")
        ? {
            tree: [
              { path: "src/a.ts", type: "blob", sha: "b1" },
              { path: "src", type: "tree", sha: "t1" },
            ],
          }
        : apiPullsAll.pullRequests[3],
    );
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const read = yield* provider.getFileRevisions!({
        ...ref,
        number: 1,
        paths: ["src/a.ts", "gone.ts"],
      });
      assert.deepStrictEqual(
        [...read.revisions],
        [
          ["src/a.ts", "b1"],
          ["gone.ts", ""],
        ],
      );
      assert.isTrue(read.complete);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("refuses a stack read missing the layers below, which a merge would land", () => {
    const [top] = apiStack.pullRequests;
    const api = originApi((input) =>
      input.path.includes("stackId=") ? { pullRequests: [top], nextPageToken: "" } : top,
    );
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const error = yield* provider.getChangeRequestStack!({ ...ref, number: 2 }).pipe(Effect.flip);
      assert.match(error.detail, /only part of this stack/);
    }).pipe(Effect.provide(api.layer));
  });

  it.effect("replays short pages before the offset without spending the page cap", () => {
    const [row] = apiPullsAll.pullRequests;
    const page = (index: number) => ({
      pullRequests: [{ ...row, number: String(20 - index) }],
      nextPageToken: index < 9 ? `p${index + 1}` : "",
    });
    const api = originApi((input) => page(Number(/pageToken=p(\d+)/.exec(input.path)?.[1] ?? 0)));
    return Effect.gen(function* () {
      const provider = yield* OriginPullRequestProvider.make;
      const next = yield* provider.listChangeRequests({
        ...ref,
        state: "all",
        involvement: "all",
        viewer: "ada",
        limit: 2,
        cursor: { updatedBefore: "2026-10-16T16:45:13Z", delivered: 7 },
      });
      // Seven one-row pages are replayed; the cap of five counts only pages that deliver.
      assert.deepStrictEqual(
        next.items.map((item) => item.number),
        [13, 12],
      );
      assert.strictEqual(next.cursorAdvance, 2);
    }).pipe(Effect.provide(api.layer));
  });
});
