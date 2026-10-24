import {
  type PullRequestCapabilities,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListState,
  type PullRequestReviewCommentDraft,
  type PullRequestStackHead,
  type PullRequestState,
  type PullRequestViewerPermissions,
  resolvePullRequestAuthorFilter,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  type ProviderChangeRequest,
  type ProviderChangeRequestDetail,
  type ProviderChangeRequestStack,
  type ProviderRepositoryRef,
  PullRequestProviderError,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { definition } from "../client/definition.ts";
import * as OriginCli from "./OriginCli.ts";
import {
  decodeOriginAuthStatus,
  OriginApiPullRequest,
  OriginApiPullRequestPageSchema,
  parseOriginApiPullRequestPage,
  parseOriginViewerHandle,
} from "./originJson.ts";
import {
  ORIGIN_REACTIONS,
  type OriginIdentity,
  OriginCheckRunPage,
  OriginCommentPage,
  OriginCommitPage,
  OriginFilePage,
  OriginGrantPage,
  OriginLabelPage,
  OriginMergeability,
  OriginRepositorySettings,
  OriginRequestedReviewers,
  OriginReviewPage,
  OriginTree,
  originActivity,
  originChangeRequest,
  originChecks,
  originCommits,
  originFilesPatch,
  originLabelCandidates,
  originMergeability,
  originRequestedUsers,
  originReviewDecision,
  originReviewerCandidates,
  originStackLayers,
} from "./originPullRequestJson.ts";

const KIND = SourceControlProviderKind.make("cursor-origin");
const PAGE_SIZE = 100;
/** Pages read for one conversation, file list, or commit list before it reads as truncated. */
const MAX_PAGES = 5;
const IDENTITY_TTL_MS = 60_000;

// Origin has no fork pull requests, rebase merges, branch updates, or reverts, and it keeps
// no viewed-file marks, so the environment keeps them.
const CAPABILITIES: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash"],
  deleteBranch: true,
  search: true,
  reactions: true,
  labels: true,
  stacks: true,
  stackActions: true,
  viewedFiles: "environment",
  review: {
    inlineComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve", "request-changes"],
  },
  reviewers: { request: true, listCandidates: true },
  edit: { changeRequest: true, comment: true },
};

const REVIEW_VERDICTS = {
  comment: "comment",
  approve: "approve",
  "request-changes": "request_changes",
} as const;

/** A removed line anchors on the base side of the file, everything else on the head side. */
export function originInlineAnchor(comment: PullRequestReviewCommentDraft) {
  const { position } = comment;
  const left =
    position.kind === "deleted" || (position.kind === "context" && position.side === "left");
  return {
    path: left ? (comment.oldPath ?? comment.path) : comment.path,
    side: left ? "left" : "right",
    startLine:
      position.kind === "added" || (position.kind === "context" && !left)
        ? position.newLine
        : position.oldLine,
  } as const;
}

/**
 * Origin merges a stacked pull request together with every layer below it, so such a merge goes
 * through the stack: every head it lands is checked first, and the write is fenced on the target's.
 */
const isStackedOnAnother = (pull: OriginApiPullRequest) => !!pull.stack?.parentPullRequest;

const repoPath = (input: ProviderRepositoryRef) =>
  `/repos/${input.repository.split("/").map(encodeURIComponent).join("/")}`;
const pullPath = (input: ProviderRepositoryRef & { readonly number: number }) =>
  `${repoPath(input)}/pulls/${input.number}`;

/** What the viewer may do; Origin checks every write again, so this only hides what cannot apply. */
function viewerPermissions(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly isAuthor: boolean;
  readonly autoMerge: boolean;
  readonly isStackedOnAnother: boolean;
}): PullRequestViewerPermissions {
  const open = input.state === "open";
  return {
    actions: open
      ? [
          "merge",
          "close",
          input.isDraft ? "ready" : "draft",
          ...(input.autoMerge
            ? (["disable-auto-merge"] as const)
            : input.isStackedOnAnother
              ? []
              : (["enable-auto-merge"] as const)),
        ]
      : input.state === "closed"
        ? ["reopen", "delete-branch"]
        : ["delete-branch"],
    comment: true,
    resolve: true,
    verdicts: !open ? [] : input.isAuthor ? ["comment"] : CAPABILITIES.review.verdicts,
    requestReviewers: open,
    labels: open,
    editChangeRequest: true,
    // Origin restacks with `origin stack restack`, which rewrites local branches; not offered.
    stackRebase: false,
  };
}

const REVIEW_QUALIFIERS = {
  approved: "approved",
  "changes-requested": "changes_requested",
  "review-required": "required",
  none: "none",
} as const;

/** Typed text is quoted so it stays text; `"` cannot appear in a label or handle. */
const quoted = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
const qualifierValue = (value: string) => `"${value.replaceAll('"', "").trim()}"`;

/**
 * Origin's search takes GitHub's qualifiers, except `status:`: it does not index CI yet, and
 * rows carry no check state, so a checks filter is not applied and the listing is wider.
 */
function originSearchQuery(input: {
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly viewer: string;
  readonly query?: string | undefined;
  readonly filters?: PullRequestListFilters | undefined;
}): string {
  const query = input.query?.trim() ?? "";
  const filters = input.filters;
  return [
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed", "is:unmerged"] : []),
    ...(input.state === "merged" ? ["is:merged"] : []),
    ...(input.involvement === "authored" ? ["author:@me"] : []),
    ...(input.involvement === "reviewing" ? ["review-requested:@me"] : []),
    ...(query ? [quoted(query)] : []),
    ...(filters?.labels ?? []).flatMap((group) =>
      group.length === 0 ? [] : [`label:${group.map(qualifierValue).join(",")}`],
    ),
    ...(filters?.excludedLabels ?? []).map((label) => `-label:${qualifierValue(label)}`),
    ...(filters?.author === undefined
      ? []
      : [`author:${qualifierValue(resolvePullRequestAuthorFilter(filters.author, input.viewer))}`]),
    ...(filters?.draft === undefined ? [] : [`draft:${filters.draft === "only"}`]),
    ...(filters?.review === undefined ? [] : [`review:${REVIEW_QUALIFIERS[filters.review]}`]),
  ].join(" ");
}

/** True when the listing needs search: the list endpoint filters by open, merged, or all. */
const needsSearch = (input: {
  readonly state: PullRequestListState;
  readonly involvement: PullRequestInvolvement;
  readonly query?: string | undefined;
  readonly filters?: PullRequestListFilters | undefined;
}) =>
  // The list endpoint's "closed" includes merged pull requests; search can leave them out.
  input.state === "closed" ||
  input.involvement !== "all" ||
  (input.query?.trim() ?? "") !== "" ||
  Object.values(input.filters ?? {}).some((value) => value !== undefined);

/** The unmerged layers a land through `number` moves have the heads the reader saw. */
function stackHeadsCurrent(
  stack: ProviderChangeRequestStack,
  number: number,
  expected: ReadonlyArray<PullRequestStackHead>,
): boolean {
  const index = stack.layers.findIndex((layer) => layer.number === number);
  if (index === -1) return false;
  const moved = stack.layers.slice(0, index + 1).filter((layer) => layer.state !== "merged");
  return (
    moved.length === expected.length &&
    moved.every((layer) =>
      expected.some((head) => head.number === layer.number && head.headSha === layer.headSha),
    )
  );
}

export const make = Effect.gen(function* () {
  const origin = yield* OriginCli.OriginCli;

  const failure = (operation: string, detail: string, cause?: unknown) =>
    new PullRequestProviderError({
      provider: KIND,
      operation,
      reason: "failed",
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const request = (input: {
    readonly cwd: string;
    readonly path: string;
    readonly method?: OriginCli.OriginApiInput["method"];
    readonly body?: unknown;
  }) =>
    origin.api({ operation: input.path, ...input }).pipe(
      Effect.mapError(
        (error) =>
          new PullRequestProviderError({
            provider: KIND,
            operation: input.path,
            detail: error.detail,
            cause: error,
            reason:
              error.reason === "missing-cli"
                ? "missing-tool"
                : error.reason === "authentication"
                  ? "unauthenticated"
                  : error.reason === "rate-limit"
                    ? "rate-limited"
                    : error.reason === "not-found"
                      ? "not-found"
                      : "failed",
          }),
      ),
    );

  const read = Effect.fn("OriginPullRequestProvider.read")(function* <A>(
    input: { readonly cwd: string; readonly path: string },
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const decoded = decodeJsonResult(schema)(yield* request(input));
    return Result.isSuccess(decoded)
      ? decoded.success
      : yield* failure(
          input.path,
          "Origin returned a response this version cannot read.",
          decoded.failure,
        );
  });

  const readPages = Effect.fn("OriginPullRequestProvider.readPages")(function* <
    A extends { readonly nextPageToken?: string | undefined },
  >(
    input: { readonly cwd: string; readonly path: string },
    schema: Schema.Codec<A, unknown, never, never>,
  ) {
    const pages: A[] = [];
    let token = "";
    do {
      const separator = input.path.includes("?") ? "&" : "?";
      const page = yield* read(
        {
          cwd: input.cwd,
          path: `${input.path}${separator}pageSize=${PAGE_SIZE}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`,
        },
        schema,
      );
      pages.push(page);
      token = page.nextPageToken ?? "";
    } while (token && pages.length < MAX_PAGES);
    return { pages, truncated: token !== "" };
  });

  const write = (input: Parameters<typeof request>[0]) => request(input).pipe(Effect.asVoid);

  const getPull = (input: ProviderRepositoryRef & { readonly number: number }) =>
    read({ cwd: input.cwd, path: pullPath(input) }, OriginApiPullRequest);

  // Every read names authors against the viewer, so who is signed in is remembered briefly.
  let identity: { readonly value: OriginIdentity; readonly at: number } | null = null;
  const getIdentity = Effect.fn("OriginPullRequestProvider.getIdentity")(function* (input: {
    readonly cwd: string;
  }) {
    const now = yield* Clock.currentTimeMillis;
    if (identity !== null && now - identity.at < IDENTITY_TTL_MS) return identity.value;
    const [namespaces, status] = yield* Effect.all(
      [
        request({ cwd: input.cwd, path: "/namespaces" }),
        origin
          .execute({ operation: "getIdentity", cwd: input.cwd, args: ["auth", "status", "--json"] })
          .pipe(Effect.orElseSucceed(() => "")),
      ],
      { concurrency: 2 },
    );
    const handle = parseOriginViewerHandle(namespaces);
    if (!handle) return yield* failure("getViewer", "Origin did not name the signed-in account.");
    const decoded = decodeOriginAuthStatus(status.trim());
    const value: OriginIdentity = {
      handle,
      id: Result.isSuccess(decoded) ? (decoded.success.account?.publicUserId ?? null) : null,
    };
    identity = { value, at: now };
    return value;
  });

  const getViewer: PullRequestProviderApi["getViewer"] = (input) =>
    getIdentity(input).pipe(Effect.map((viewer) => viewer.handle));

  const permissionsFor = (pull: OriginApiPullRequest, viewer: OriginIdentity) => {
    const summary = originChangeRequest(pull, viewer);
    return viewerPermissions({
      state: summary.state,
      isDraft: summary.isDraft,
      isAuthor: summary.author?.login === viewer.handle,
      autoMerge: !!pull.autoMerge,
      isStackedOnAnother: isStackedOnAnother(pull),
    });
  };

  const getRequestedReviewers = (input: ProviderRepositoryRef & { readonly number: number }) =>
    read(
      { cwd: input.cwd, path: `${pullPath(input)}/requested_reviewers` },
      OriginRequestedReviewers,
    );

  /** Null for a pull request in no stack. Every member is read, merged ones included. */
  const readStack = Effect.fn("OriginPullRequestProvider.readStack")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
    pull?: OriginApiPullRequest,
  ) {
    const target = pull ?? (yield* getPull(input));
    if (!target.stack) return null;
    const query = new URLSearchParams({ stackId: target.stack.id, state: "all" });
    const { pages, truncated } = yield* readPages(
      { cwd: input.cwd, path: `${repoPath(input)}/pulls?${query.toString()}` },
      OriginApiPullRequestPageSchema,
    );
    const layers = originStackLayers(
      pages.flatMap((page) => page.pullRequests),
      target.number,
    );
    const root = layers[0];
    if (root === undefined) return null;
    // A layer whose parent was not read would hide layers a merge lands, so the read fails.
    if (truncated || root.stack?.parentPullRequest)
      return yield* failure("getChangeRequestStack", "Origin returned only part of this stack.");
    return {
      id: target.stack.id,
      // Origin names a stack by id; T3 Code names it by its root pull request.
      number: root.number,
      url: root.webUrl,
      base: root.base.ref,
      layers: layers.map((layer) => {
        const summary = originChangeRequest(layer);
        return {
          number: layer.number,
          title: layer.title,
          headBranch: layer.head.ref,
          state: summary.state,
          isDraft: summary.isDraft,
          ...(layer.head.sha ? { headSha: layer.head.sha } : {}),
        };
      }),
    } satisfies ProviderChangeRequestStack;
  });

  const getChecks = (input: ProviderRepositoryRef, headSha: string | undefined) =>
    headSha
      ? readPages(
          {
            cwd: input.cwd,
            path: `${repoPath(input)}/commits/${encodeURIComponent(headSha)}/check-runs`,
          },
          OriginCheckRunPage,
        ).pipe(
          Effect.map(({ pages }) =>
            originChecks({ checkRuns: pages.flatMap((page) => page.checkRuns) }),
          ),
        )
      : Effect.succeed([]);

  const getDetail = Effect.fn("OriginPullRequestProvider.getChangeRequest")(function* (
    input: ProviderRepositoryRef & { readonly number: number },
  ) {
    const [pull, repo, mergeability, reviews, requested, viewer] = yield* Effect.all(
      [
        getPull(input),
        read({ cwd: input.cwd, path: repoPath(input) }, OriginRepositorySettings),
        read({ cwd: input.cwd, path: `${pullPath(input)}/mergeability` }, OriginMergeability),
        readPages({ cwd: input.cwd, path: `${pullPath(input)}/reviews` }, OriginReviewPage),
        getRequestedReviewers(input),
        getIdentity(input),
      ],
      { concurrency: 6 },
    );
    const [checks, stack] = yield* Effect.all(
      [getChecks(input, pull.head.sha), readStack(input, pull)],
      { concurrency: 2 },
    );
    const summary = originChangeRequest(pull, viewer);
    const reviewers = originRequestedUsers(requested, viewer);
    const position = stack ? stack.layers.findIndex((layer) => layer.number === pull.number) : -1;
    return {
      ...summary,
      ...(stack && position >= 0
        ? {
            stack: {
              number: stack.number,
              position: position + 1,
              size: stack.layers.length,
              base: stack.base,
            },
          }
        : {}),
      reviewRequestLogins: reviewers.map((reviewer) => reviewer.login),
      autoMergeEnabled: !!pull.autoMerge,
      ...(pull.autoMerge?.mergeMethod === "squash" || pull.autoMerge?.mergeMethod === "merge"
        ? { autoMergeMethod: pull.autoMerge.mergeMethod }
        : {}),
      mergeability: originMergeability(mergeability),
      reviewDecision: originReviewDecision(reviews.pages.flatMap((page) => page.reviews)),
      headSha: pull.head.sha ?? null,
      body: pull.body ?? "",
      changedFiles: pull.changedFiles ?? 0,
      mergedAt: summary.mergedAt ?? null,
      closedAt: summary.closedAt ?? null,
      reviewers,
      checks,
      mergeCapabilities: {
        merge: repo.allowMergeCommit ?? true,
        squash: repo.allowSquashMerge ?? true,
        rebase: false,
      },
      viewerPermissions: permissionsFor(pull, viewer),
    } satisfies ProviderChangeRequestDetail;
  });

  const listFilesPatch = (input: { readonly cwd: string; readonly path: string }) =>
    readPages(input, OriginFilePage).pipe(
      Effect.map(({ pages, truncated }) => {
        const { patch, omittedFileStats } = originFilesPatch(pages.flatMap((page) => page.files));
        return {
          patch,
          truncated: truncated || omittedFileStats.length > 0,
          nextCursor: null,
          omittedFileStats,
        };
      }),
    );

  const provider: PullRequestProviderApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    getViewer,
    listChangeRequests: Effect.fn("OriginPullRequestProvider.listChangeRequests")(
      function* (input) {
        const search = needsSearch(input);
        const viewer = yield* getIdentity(input);
        // Both endpoints page by opaque token, so a later slice re-reads the rows it delivered.
        const offset = input.cursor?.delivered ?? 0;
        const items: ProviderChangeRequest[] = [];
        let consumed = 0;
        let seen = 0;
        let token = "";
        let more = true;
        // Pages before the offset are re-read and may be short, so only pages that deliver past
        // it count against the cap.
        let pagesPastOffset = 0;
        // Each replayed page moves past at least one row, so this only stops empty pages.
        for (
          let pages = 0;
          more &&
          items.length < input.limit &&
          pagesPastOffset < MAX_PAGES &&
          pages < offset + MAX_PAGES;
          pages++
        ) {
          const page = token ? `&pageToken=${encodeURIComponent(token)}` : "";
          const path = search
            ? `/search/pulls?${new URLSearchParams({
                repo: input.repository,
                q: originSearchQuery(input),
                sort: "updated",
                order: "desc",
                pageSize: String(PAGE_SIZE),
              }).toString()}${page}`
            : `${repoPath(input)}/pulls?${new URLSearchParams({
                state: input.state,
                sortBy: "updated",
                pageSize: String(PAGE_SIZE),
              }).toString()}${page}`;
          const result = parseOriginApiPullRequestPage(yield* request({ cwd: input.cwd, path }));
          if (!result)
            return yield* failure(
              "listChangeRequests",
              "Origin returned an invalid pull request list.",
            );
          for (const pull of result.pullRequests) {
            // A slice holds `limit` matches: the service stops paging at an empty one.
            if (items.length >= input.limit) break;
            consumed++;
            if (consumed <= offset) continue;
            const item = originChangeRequest(pull, viewer);
            // Guards a host answer that strays from the state asked for.
            if (input.state !== "all" && item.state !== input.state) continue;
            // Rows carry no review state; what the search matched on is what each row has.
            const review = input.filters?.review;
            items.push({
              ...item,
              ...(input.involvement === "reviewing" ? { reviewRequestLogins: [input.viewer] } : {}),
              ...(review === undefined
                ? {}
                : { reviewDecision: review === "none" ? null : review }),
            });
          }
          seen += result.pullRequests.length;
          if (consumed > offset) pagesPastOffset++;
          token = result.nextPageToken ?? "";
          // Rows the limit left on this page are more, as is another page.
          more = token !== "" || consumed < seen;
        }
        return { items, truncated: more, continues: true, cursorAdvance: consumed - offset };
      },
    ),
    getChangeRequestSummary: (input) =>
      Effect.all([getPull(input), getIdentity(input)], { concurrency: 2 }).pipe(
        Effect.map(([pull, viewer]) => originChangeRequest(pull, viewer)),
      ),
    getChangeRequestChecks: Effect.fn("OriginPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const pull = yield* getPull(input);
        return {
          state: originChangeRequest(pull).state,
          checks: yield* getChecks(input, pull.head.sha),
        };
      },
    ),
    getChangeRequest: getDetail,
    getViewerPermissions: (input) =>
      Effect.all([getPull(input), getIdentity(input)], { concurrency: 2 }).pipe(
        Effect.map(([pull, viewer]) => permissionsFor(pull, viewer)),
      ),
    getChangeRequestActivity: Effect.fn("OriginPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const [pull, comments, reviews, commits, viewer] = yield* Effect.all(
          [
            getPull(input),
            readPages({ cwd: input.cwd, path: `${pullPath(input)}/comments` }, OriginCommentPage),
            readPages({ cwd: input.cwd, path: `${pullPath(input)}/reviews` }, OriginReviewPage),
            readPages({ cwd: input.cwd, path: `${pullPath(input)}/commits` }, OriginCommitPage),
            getIdentity(input),
          ],
          { concurrency: 5 },
        );
        const activity = originActivity({
          currentVersion: Number(pull.version?.number) || null,
          viewer,
          comments: comments.pages.flatMap((page) => page.comments),
          reviews: reviews.pages.flatMap((page) => page.reviews),
        });
        return {
          ...activity,
          commentCount: activity.comments.length,
          commentsTruncated: comments.truncated || reviews.truncated,
          commits: commits.pages.flatMap((page) => originCommits(page)),
        };
      },
    ),
    getDiff: (input) =>
      listFilesPatch({
        cwd: input.cwd,
        path: input.commit
          ? `${repoPath(input)}/commits/${encodeURIComponent(input.commit)}/files`
          : `${pullPath(input)}/files`,
      }),
    runAction: (input) => {
      switch (input.action) {
        case "merge":
          return Effect.gen(function* () {
            if (input.mergeMethod === "rebase")
              return yield* failure("merge", "Cursor Origin does not support rebase merges.");
            const pull = yield* getPull(input);
            if (input.stackNumber !== undefined) {
              const stack = yield* readStack(input, pull);
              if (
                stack === null ||
                stack.number !== input.stackNumber ||
                input.expectedStackHeads === undefined ||
                !stackHeadsCurrent(stack, input.number, input.expectedStackHeads)
              )
                return yield* failure(
                  "merge",
                  "The stack changed since it was read. Refresh it and try again.",
                );
            } else if (isStackedOnAnother(pull)) {
              return yield* failure(
                "merge",
                "Merging this stacked pull request also lands the layers below it. Merge it from the stack.",
              );
            }
            // Origin fences a merge on the target's head only. The layers below were checked
            // against the reader's heads just above; Origin has no per-layer guard to send.
            yield* write({
              cwd: input.cwd,
              path: `${pullPath(input)}/merge`,
              method: "POST",
              body: {
                mergeMethod: input.mergeMethod ?? "merge",
                ...(pull.head.sha ? { expectedHeadSha: pull.head.sha } : {}),
              },
            });
          });
        case "enable-auto-merge":
          return getPull(input).pipe(
            Effect.flatMap((pull) =>
              isStackedOnAnother(pull)
                ? Effect.fail(
                    failure(
                      "enable-auto-merge",
                      "Auto-merge on a stacked pull request would also land the layers below it. Merge it from the stack.",
                    ),
                  )
                : write({
                    cwd: input.cwd,
                    path: `${pullPath(input)}/auto_merge`,
                    method: "PUT",
                    body: input.mergeMethod ? { mergeMethod: input.mergeMethod } : {},
                  }),
            ),
          );
        case "disable-auto-merge":
          return write({ cwd: input.cwd, path: `${pullPath(input)}/auto_merge`, method: "DELETE" });
        case "delete-branch":
          return getPull(input).pipe(
            Effect.flatMap((pull) =>
              write({
                cwd: input.cwd,
                path: `${repoPath(input)}/git/refs/heads/${pull.head.ref.split("/").map(encodeURIComponent).join("/")}`,
                method: "DELETE",
              }),
            ),
          );
        case "close":
          return write({
            cwd: input.cwd,
            path: pullPath(input),
            method: "PATCH",
            body: { state: "closed" },
          });
        case "reopen":
          // Reopening sends the draft flag too, since `state: "open"` alone also marks it ready.
          return getPull(input).pipe(
            Effect.flatMap((pull) =>
              write({
                cwd: input.cwd,
                path: pullPath(input),
                method: "PATCH",
                body: { state: "open", draft: pull.draft === true },
              }),
            ),
          );
        case "ready":
          return write({
            cwd: input.cwd,
            path: pullPath(input),
            method: "PATCH",
            body: { draft: false },
          });
        case "draft":
          return write({
            cwd: input.cwd,
            path: pullPath(input),
            method: "PATCH",
            body: { draft: true },
          });
        default:
          return Effect.fail(
            failure(input.action, `Cursor Origin does not support ${input.action}.`),
          );
      }
    },
    updateChangeRequest: (input) =>
      write({
        cwd: input.cwd,
        path: pullPath(input),
        method: "PATCH",
        body: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
        },
      }),
    comment: (input) =>
      write({
        cwd: input.cwd,
        path: `${pullPath(input)}/comments`,
        method: "POST",
        body: { body: input.body },
      }),
    submitReview: (input) =>
      write({
        cwd: input.cwd,
        path: `${pullPath(input)}/reviews`,
        method: "POST",
        body: {
          verdict: REVIEW_VERDICTS[input.verdict],
          body: input.body,
          comments: input.comments.map((comment) => ({
            body: comment.body,
            inline: originInlineAnchor(comment),
          })),
        },
      }),
    replyToThread: (input) =>
      write({
        cwd: input.cwd,
        path: `${pullPath(input)}/comments`,
        method: "POST",
        body: { body: input.body, threadId: input.threadId },
      }),
    setThreadResolution: (input) =>
      write({
        cwd: input.cwd,
        path: `${repoPath(input)}/pulls/threads/${encodeURIComponent(input.threadId)}`,
        method: "PATCH",
        body: { resolved: input.resolved },
      }),
    listReviewerCandidates: Effect.fn("OriginPullRequestProvider.listReviewerCandidates")(
      function* (input) {
        const owner = encodeURIComponent(input.repository.split("/")[0] ?? "");
        const [pull, requested, viewer, repositoryGrants, ownerGrants] = yield* Effect.all(
          [
            getPull(input),
            getRequestedReviewers(input),
            getIdentity(input),
            readPages({ cwd: input.cwd, path: `${repoPath(input)}/grants` }, OriginGrantPage),
            // Reading an owner's grants can need more access than the reader has; the repository's
            // own grants and the requested reviewers still stand without them.
            readPages(
              { cwd: input.cwd, path: `/namespaces/${owner}/grants` },
              OriginGrantPage,
            ).pipe(Effect.orElseSucceed(() => ({ pages: [], truncated: false }))),
          ],
          { concurrency: 5 },
        );
        return {
          candidates: originReviewerCandidates({
            grants: [...repositoryGrants.pages, ...ownerGrants.pages].flatMap(
              (page) => page.grants,
            ),
            requested,
            author: originChangeRequest(pull, viewer).author?.login ?? null,
            viewer,
          }),
          truncated: repositoryGrants.truncated || ownerGrants.truncated,
        };
      },
    ),
    setReviewerRequest: (input) =>
      write({
        cwd: input.cwd,
        path: `${pullPath(input)}/requested_reviewers`,
        method: input.requested ? "POST" : "DELETE",
        body: {
          users: input.reviewers
            .filter((reviewer) => reviewer.kind === "user")
            .map((reviewer) => reviewer.id),
          groups: input.reviewers
            .filter((reviewer) => reviewer.kind === "team")
            .map((reviewer) => reviewer.id),
        },
      }),
    listLabelCandidates: Effect.fn("OriginPullRequestProvider.listLabelCandidates")(
      function* (input) {
        const [pull, labels] = yield* Effect.all(
          [
            getPull(input),
            readPages({ cwd: input.cwd, path: `${repoPath(input)}/labels` }, OriginLabelPage),
          ],
          { concurrency: 2 },
        );
        return {
          candidates: originLabelCandidates(
            labels.pages.flatMap((page) => page.labels),
            (pull.labels ?? []).map((label) => label.name),
          ),
          truncated: labels.truncated,
        };
      },
    ),
    setLabels: (input) =>
      input.applied
        ? write({
            cwd: input.cwd,
            path: `${pullPath(input)}/labels`,
            method: "POST",
            body: { labels: input.labels },
          })
        : Effect.forEach(
            input.labels,
            (label) =>
              write({
                cwd: input.cwd,
                path: `${pullPath(input)}/labels/${encodeURIComponent(label)}`,
                method: "DELETE",
              }),
            { concurrency: 1, discard: true },
          ),
    updateComment: (input) =>
      write({
        cwd: input.cwd,
        path: `${repoPath(input)}/pulls/comments/${encodeURIComponent(input.commentId)}`,
        method: "PATCH",
        body: { body: input.body },
      }),
    setReaction: (input) => {
      // Review summaries carry `canReact: false`; this refuses a caller that sends one anyway.
      if (!input.subjectId?.startsWith("cmt_"))
        return Effect.fail(
          failure("setReaction", "Cursor Origin takes reactions on comments only."),
        );
      const emoji = ORIGIN_REACTIONS[input.content];
      const path = `${repoPath(input)}/pulls/comments/${encodeURIComponent(input.subjectId)}/reactions`;
      return input.reacted
        ? write({ cwd: input.cwd, path, method: "POST", body: { emoji } })
        : write({ cwd: input.cwd, path: `${path}/${encodeURIComponent(emoji)}`, method: "DELETE" });
    },
    getChangeRequestStack: (input) => readStack(input),
    getFileRevisions: Effect.fn("OriginPullRequestProvider.getFileRevisions")(function* (input) {
      const pull = yield* getPull(input);
      if (!pull.head.sha) return { revisions: new Map<string, string>() };
      const tree = yield* read(
        {
          cwd: input.cwd,
          path: `${repoPath(input)}/git/trees/${encodeURIComponent(pull.head.sha)}?recursive=true`,
        },
        OriginTree,
      );
      const blobs = new Map(
        tree.tree.flatMap((entry) =>
          entry.type === "blob" ? [[entry.path, entry.sha] as const] : [],
        ),
      );
      // A path missing from a whole tree was deleted, which is the empty revision.
      const revisions = new Map(
        input.paths.flatMap((path) => {
          const blob = blobs.get(path);
          return blob !== undefined
            ? [[path, blob] as const]
            : tree.truncated
              ? []
              : [[path, ""] as const];
        }),
      );
      return { revisions, complete: tree.truncated !== true };
    }),
  };
  return provider;
});
