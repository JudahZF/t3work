import type {
  PullRequestActor,
  PullRequestCheck,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestLabelCandidate,
  PullRequestOmittedFileStat,
  PullRequestReaction,
  PullRequestReactionContent,
  PullRequestReviewDecision,
  PullRequestReviewerCandidate,
  PullRequestReviewThread,
} from "@t3tools/contracts";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import type { ProviderChangeRequest } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  type OriginApiPullRequest,
  OriginActor,
  OriginPrincipal,
  originApiPullRequestState,
} from "./originJson.ts";

type OriginActor = typeof OriginActor.Type;

/** Who is signed in: the namespace handle T3 Code calls the viewer, and the stable user id. */
export interface OriginIdentity {
  readonly handle: string;
  readonly id: string | null;
}

/**
 * A user is named by their handle, which matches the viewer's namespace. Origin omits the handle
 * of a private profile, so the viewer is recognised by id, and anyone else without a handle, an
 * app, or a service account falls back to its stable id.
 */
function originActor(
  actor: OriginActor | undefined,
  viewer: OriginIdentity | null = null,
): PullRequestActor | null {
  const principal = actor?.user ?? actor?.app ?? actor?.serviceAccount;
  const self = actor?.user?.id !== undefined && actor.user.id === viewer?.id;
  const login = [
    self ? viewer?.handle : undefined,
    principal?.handle,
    principal?.slug,
    principal?.id,
  ]
    .map((value) => value?.trim())
    .find((value) => !!value);
  if (!principal || !login) return null;
  return {
    login,
    name: principal.displayName ?? principal.name ?? null,
    avatarUrl: null,
    ...(actor?.user ? {} : { isBot: true }),
  };
}

const toIso = (value: string) =>
  Option.match(DateTime.make(value), { onNone: () => value, onSome: DateTime.formatIso });

export function originChangeRequest(
  pullRequest: OriginApiPullRequest,
  viewer: OriginIdentity | null = null,
): ProviderChangeRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.webUrl,
    author: originActor(pullRequest.author, viewer),
    headBranch: pullRequest.head.ref,
    baseBranch: pullRequest.base.ref,
    state: originApiPullRequestState(pullRequest),
    isDraft: pullRequest.draft === true,
    // The list does not say; the detail reads `/mergeability`.
    mergeability: "unknown",
    additions: pullRequest.additions ?? 0,
    deletions: pullRequest.deletions ?? 0,
    createdAt: toIso(pullRequest.createdAt),
    updatedAt: toIso(pullRequest.updatedAt),
    closedAt: pullRequest.closedAt ? toIso(pullRequest.closedAt) : null,
    mergedAt: pullRequest.mergedAt ? toIso(pullRequest.mergedAt) : null,
    reviewRequestLogins: [],
    labels: (pullRequest.labels ?? []).flatMap((label) =>
      label.name.trim() ? [{ name: label.name, color: label.color ?? null }] : [],
    ),
  };
}

const pageToken = Schema.optional(Schema.String);

export const OriginRepositorySettings = Schema.Struct({
  allowMergeCommit: Schema.optional(Schema.Boolean),
  allowSquashMerge: Schema.optional(Schema.Boolean),
});

export const OriginMergeability = Schema.Struct({
  verdict: Schema.optional(Schema.String),
  blockers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/** Origin treats a verdict it does not recognise as blocked; only a conflict reads as one here. */
export function originMergeability(
  mergeability: typeof OriginMergeability.Type,
): PullRequestMergeability {
  if (mergeability.blockers?.some((blocker) => blocker.kind === "merge_conflict"))
    return "conflicting";
  return mergeability.verdict === "mergeable" ? "mergeable" : "unknown";
}

const OriginThread = Schema.Struct({
  id: Schema.String,
  // Read loosely: an odd version only loses the outdated mark, never the conversation.
  version: Schema.optional(
    Schema.NullOr(Schema.Struct({ number: Schema.optional(Schema.String) })),
  ),
  // Empty for general discussion.
  path: Schema.optional(Schema.String),
  side: Schema.optional(Schema.String),
  startLine: Schema.optional(Schema.Number),
  endLine: Schema.optional(Schema.Number),
  resolvedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const OriginComment = Schema.Struct({
  id: Schema.String,
  thread: OriginThread,
  body: Schema.String,
  author: Schema.optional(OriginActor),
  createdAt: Schema.String,
  updatedAt: Schema.optional(Schema.String),
  reactions: Schema.optional(
    Schema.Array(Schema.Struct({ emoji: Schema.String, reactor: Schema.optional(OriginActor) })),
  ),
});
type OriginComment = typeof OriginComment.Type;

export const OriginCommentPage = Schema.Struct({
  comments: Schema.Array(OriginComment),
  nextPageToken: pageToken,
});

const OriginReview = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(OriginActor),
  verdict: Schema.String,
  body: Schema.optional(Schema.String),
  submittedAt: Schema.optional(Schema.NullOr(Schema.String)),
  dismissal: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
type OriginReview = typeof OriginReview.Type;

export const OriginReviewPage = Schema.Struct({
  reviews: Schema.Array(OriginReview),
  nextPageToken: pageToken,
});

export const OriginCommitPage = Schema.Struct({
  commits: Schema.Array(
    Schema.Struct({
      sha: Schema.String,
      commit: Schema.Struct({
        message: Schema.String,
        author: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
        committer: Schema.optional(Schema.Struct({ date: Schema.optional(Schema.String) })),
      }),
    }),
  ),
  nextPageToken: pageToken,
});

export function originCommits(
  page: typeof OriginCommitPage.Type,
): ReadonlyArray<PullRequestCommit> {
  return page.commits.flatMap((commit) => {
    const date = commit.commit.committer?.date;
    return date
      ? [
          {
            oid: commit.sha,
            messageHeadline: commit.commit.message.split("\n")[0] ?? "",
            committedDate: toIso(date),
          },
        ]
      : [];
  });
}

export const OriginCheckRunPage = Schema.Struct({
  checkRuns: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.optional(Schema.NullOr(Schema.String)),
      detailsUrl: Schema.optional(Schema.NullOr(Schema.String)),
      checkSuite: Schema.optional(
        Schema.NullOr(Schema.Struct({ name: Schema.optional(Schema.String) })),
      ),
      output: Schema.optional(
        Schema.NullOr(Schema.Struct({ title: Schema.optional(Schema.String) })),
      ),
    }),
  ),
  nextPageToken: pageToken,
});

function originCheckStatus(run: (typeof OriginCheckRunPage.Type)["checkRuns"][number]) {
  if (run.status === "failing") return "failure";
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
      return "success";
    case "skipped":
      return "skipped";
    case "neutral":
    case "stale":
      return "neutral";
    case "cancelled":
      return "cancelled";
    case "action_required":
      return "action-required";
    default:
      return "failure";
  }
}

/**
 * Origin lists the current run of each check, so none is dropped; two checks sharing a name in
 * different suites are told apart by their suite.
 */
export function originChecks(
  page: typeof OriginCheckRunPage.Type,
): ReadonlyArray<PullRequestCheck> {
  const counts = new Map<string, number>();
  for (const run of page.checkRuns) counts.set(run.name, (counts.get(run.name) ?? 0) + 1);
  return page.checkRuns.map((run) => {
    const name = run.name.trim() || "check";
    const suite = run.checkSuite?.name?.trim();
    return {
      name: suite && (counts.get(run.name) ?? 0) > 1 ? `${suite} / ${name}` : name,
      description: run.output?.title || null,
      url: run.detailsUrl || null,
      status: originCheckStatus(run),
    };
  });
}

export const OriginFilePage = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
      status: Schema.optional(Schema.String),
      patch: Schema.optional(Schema.String),
      previousFilename: Schema.optional(Schema.String),
      additions: Schema.optional(Schema.Number),
      deletions: Schema.optional(Schema.Number),
    }),
  ),
  nextPageToken: pageToken,
});

/**
 * The files API sends hunks without git headers; this restores them so the diff parses. A file
 * with line changes but no patch was left out by Origin, and one with neither is binary.
 */
export function originFilesPatch(files: (typeof OriginFilePage.Type)["files"]): {
  readonly patch: string;
  readonly omittedFileStats: ReadonlyArray<PullRequestOmittedFileStat>;
} {
  const omittedFileStats: PullRequestOmittedFileStat[] = [];
  const patch = files
    .map((file) => {
      const oldPath = file.previousFilename || file.filename;
      const a = quoteGitPatchPath(`a/${oldPath}`);
      const b = quoteGitPatchPath(`b/${file.filename}`);
      const before = file.status === "added" ? "/dev/null" : a;
      const after = file.status === "removed" ? "/dev/null" : b;
      const lines = [`diff --git ${a} ${b}`];
      if (file.status === "added") lines.push("new file mode 100644");
      if (file.status === "removed") lines.push("deleted file mode 100644");
      const changedLines = (file.additions ?? 0) + (file.deletions ?? 0);
      if (file.status === "renamed" || file.status === "copied") {
        const action = file.status === "renamed" ? "rename" : "copy";
        // Origin sends no similarity, but the diff parser reads a rename only with one.
        lines.push(
          `similarity index ${file.patch || changedLines > 0 ? 90 : 100}%`,
          `${action} from ${quoteGitPatchPath(oldPath)}`,
          `${action} to ${quoteGitPatchPath(file.filename)}`,
        );
      }

      if (file.patch) {
        lines.push(`--- ${before}`, `+++ ${after}`, file.patch.replace(/\n$/, ""));
      } else if (changedLines > 0) {
        omittedFileStats.push({
          path: file.filename,
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
        });
      } else if (file.status === "modified") {
        // Empty added or removed files and pure renames carry no patch either.
        lines.push(`Binary files ${before} and ${after} differ`);
      }
      return `${lines.join("\n")}\n`;
    })
    .join("");
  return { patch, omittedFileStats };
}

/** The latest standing verdict per reviewer decides, as on the Origin pull request page. */
export function originReviewDecision(
  reviews: ReadonlyArray<OriginReview>,
): PullRequestReviewDecision | null {
  const latest = new Map<string, string>();
  for (const review of reviews.toSorted((a, b) =>
    (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""),
  )) {
    const reviewer = originActor(review.author)?.login;
    if (!reviewer || !review.submittedAt || review.dismissal) continue;
    if (review.verdict === "approve" || review.verdict === "request_changes")
      latest.set(reviewer, review.verdict);
  }
  const verdicts = new Set(latest.values());
  if (verdicts.has("request_changes")) return "changes-requested";
  return verdicts.has("approve") ? "approved" : null;
}

/** The emoji Origin stores for each reaction T3 Code offers; a reaction is added by its emoji. */
export const ORIGIN_REACTIONS: Record<PullRequestReactionContent, string> = {
  "thumbs-up": "👍",
  "thumbs-down": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

function originReactions(
  reactions: OriginComment["reactions"],
  viewer: OriginIdentity,
): ReadonlyArray<PullRequestReaction> {
  return Object.entries(ORIGIN_REACTIONS).flatMap(([content, emoji]) => {
    const matching = (reactions ?? []).filter((reaction) => reaction.emoji === emoji);
    if (matching.length === 0) return [];
    const logins = matching.flatMap((reaction) => {
      const login = originActor(reaction.reactor, viewer)?.login;
      return login ? [login] : [];
    });
    return [
      {
        content: content as PullRequestReactionContent,
        count: matching.length,
        actors: logins.filter((login) => login !== viewer.handle),
        viewerHasReacted: logins.includes(viewer.handle),
      },
    ];
  });
}

const REVIEW_STATES: Record<string, string> = {
  approve: "APPROVED",
  request_changes: "CHANGES_REQUESTED",
  comment: "COMMENTED",
};

function originComment(comment: OriginComment, viewer: OriginIdentity): PullRequestComment {
  const anchored = !!comment.thread.path;
  const author = originActor(comment.author, viewer);
  return {
    id: comment.id,
    kind: anchored ? "review-comment" : "issue-comment",
    author,
    body: comment.body,
    createdAt: toIso(comment.createdAt),
    editedAt:
      comment.updatedAt && comment.updatedAt !== comment.createdAt
        ? toIso(comment.updatedAt)
        : null,
    url: null,
    path: anchored ? (comment.thread.path ?? null) : null,
    reviewState: null,
    reactions: originReactions(comment.reactions, viewer),
    canEdit: author !== null && author.login === viewer.handle,
  };
}

/**
 * Every Origin comment sits in a thread. A thread with a file path is a review thread; one
 * without is general discussion, which reads as a plain conversation.
 */
export function originActivity(input: {
  /** The pull request's latest version; a thread filed against an earlier one is outdated. */
  readonly currentVersion: number | null;
  readonly viewer: OriginIdentity;
  readonly comments: ReadonlyArray<OriginComment>;
  readonly reviews: ReadonlyArray<OriginReview>;
}): {
  readonly comments: ReadonlyArray<PullRequestComment>;
  readonly reviewThreads: ReadonlyArray<PullRequestReviewThread>;
} {
  const threads = new Map<string, { thread: OriginComment["thread"]; comments: OriginComment[] }>();
  for (const comment of input.comments) {
    if (!comment.thread.path) continue;
    const held = threads.get(comment.thread.id);
    if (held) held.comments.push(comment);
    else threads.set(comment.thread.id, { thread: comment.thread, comments: [comment] });
  }
  const reviews = input.reviews.flatMap((review): ReadonlyArray<PullRequestComment> =>
    review.submittedAt
      ? [
          {
            id: review.id,
            kind: "review",
            author: originActor(review.author, input.viewer),
            body: review.body ?? "",
            createdAt: toIso(review.submittedAt),
            url: null,
            path: null,
            reviewState: REVIEW_STATES[review.verdict] ?? null,
            // Origin keeps reactions on comments, not on a review's summary.
            canReact: false,
          },
        ]
      : [],
  );
  return {
    comments: [
      ...input.comments.map((comment) => originComment(comment, input.viewer)),
      ...reviews,
    ].toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)),
    reviewThreads: [...threads.values()].map(({ thread, comments }) => {
      const line = thread.endLine || thread.startLine || 0;
      return {
        id: thread.id,
        path: thread.path ?? "",
        line: line > 0 ? line : null,
        side: thread.side === "left" ? "left" : "right",
        isResolved: !!thread.resolvedAt,
        isOutdated:
          input.currentVersion !== null && Number(thread.version?.number) < input.currentVersion,
        comments: comments.map((comment) => {
          const { id, author, body, createdAt, editedAt, url, reactions, canEdit } = originComment(
            comment,
            input.viewer,
          );
          return { id, author, body, createdAt, editedAt, url, reactions, canEdit };
        }),
      };
    }),
  };
}

export const OriginRequestedReviewers = Schema.Struct({
  users: Schema.optional(Schema.Array(OriginPrincipal)),
  groups: Schema.optional(Schema.Array(OriginPrincipal)),
});

/** Requested users as actors; groups have no login, so only users are named. */
export function originRequestedUsers(
  requested: typeof OriginRequestedReviewers.Type,
  viewer: OriginIdentity | null = null,
): ReadonlyArray<PullRequestActor> {
  return (requested.users ?? []).flatMap((user) => {
    const actor = originActor({ user }, viewer);
    return actor ? [actor] : [];
  });
}

/**
 * Users and groups granted access, on the repository or on its owner. A team group (every member
 * or admin of the owning team) is a grant too, but a review cannot be asked of one.
 */
export const OriginGrantPage = Schema.Struct({
  grants: Schema.Array(
    Schema.Struct({
      user: Schema.optional(OriginPrincipal),
      group: Schema.optional(OriginPrincipal),
    }),
  ),
  nextPageToken: pageToken,
});

/**
 * Whoever is already requested is offered too, so a request made on Origin to someone outside
 * these grants can still be withdrawn here.
 */
export function originReviewerCandidates(input: {
  readonly grants: (typeof OriginGrantPage.Type)["grants"];
  readonly requested: typeof OriginRequestedReviewers.Type;
  readonly author: string | null;
  readonly viewer: OriginIdentity | null;
}): ReadonlyArray<PullRequestReviewerCandidate> {
  const requested = [
    ...(input.requested.users ?? []).map((user) => ({ user })),
    ...(input.requested.groups ?? []).map((group) => ({ group })),
  ];
  const requestedIds = new Set(
    requested.flatMap((entry) => {
      const id = ("user" in entry ? entry.user : entry.group).id;
      return id ? [id] : [];
    }),
  );
  const seen = new Set<string>();
  return [...input.grants, ...requested].flatMap(
    (grant): ReadonlyArray<PullRequestReviewerCandidate> => {
      const user = "user" in grant ? grant.user : undefined;
      const principal = user ?? ("group" in grant ? grant.group : undefined);
      const actor = user ? originActor({ user }, input.viewer) : null;
      const login = actor?.login ?? principal?.slug ?? principal?.name ?? principal?.id;
      if (!principal?.id || !login || seen.has(principal.id)) return [];
      seen.add(principal.id);
      if (login === input.author && !requestedIds.has(principal.id)) return [];
      return [
        {
          id: principal.id,
          kind: user ? "user" : "team",
          login,
          name: principal.displayName ?? principal.name ?? null,
          avatarUrl: null,
          isRequested: requestedIds.has(principal.id),
        },
      ];
    },
  );
}

export const OriginLabelPage = Schema.Struct({
  labels: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      color: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
  nextPageToken: pageToken,
});

export function originLabelCandidates(
  labels: (typeof OriginLabelPage.Type)["labels"],
  applied: ReadonlyArray<string>,
): ReadonlyArray<PullRequestLabelCandidate> {
  return labels.flatMap((label) =>
    label.name.trim()
      ? [
          {
            name: label.name,
            color: label.color ?? null,
            description: label.description || null,
            isApplied: applied.includes(label.name),
          },
        ]
      : [],
  );
}

/** A recursive tree listing: each file's blob id names its content at that commit. */
export const OriginTree = Schema.Struct({
  tree: Schema.Array(
    Schema.Struct({ path: Schema.String, type: Schema.String, sha: Schema.String }),
  ),
  truncated: Schema.optional(Schema.Boolean),
});

/**
 * The layers from a stack's root up through `number`, then on up while each layer has exactly
 * one child. Origin stacks may branch; a fork above the read layer ends the line here.
 */
export function originStackLayers(
  members: ReadonlyArray<OriginApiPullRequest>,
  number: number,
): ReadonlyArray<OriginApiPullRequest> {
  const byNumber = new Map(members.map((member) => [member.number, member]));
  const parentOf = (member: OriginApiPullRequest) => member.stack?.parentPullRequest?.number;
  const below: OriginApiPullRequest[] = [];
  for (
    let member = byNumber.get(number);
    member !== undefined && !below.includes(member);
    member = byNumber.get(parentOf(member) ?? 0)
  ) {
    below.unshift(member);
  }
  const layers = [...below];
  for (let top = layers.at(-1); top !== undefined;) {
    const children = members.filter((member) => parentOf(member) === top?.number);
    const next = children.length === 1 ? children[0] : undefined;
    if (next === undefined || layers.includes(next)) break;
    layers.push(next);
    top = next;
  }
  return layers;
}
