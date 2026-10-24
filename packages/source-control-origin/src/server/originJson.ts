import {
  type ChangeRequest,
  type ChangeRequestState,
  PositiveInt,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const KIND = SourceControlProviderKind.make("cursor-origin");

/** The REST API sends integers such as `number` and `version.number` as strings. */
const PositiveIntString = Schema.FiniteFromString.pipe(Schema.decodeTo(PositiveInt));

/** `origin auth status --json`, which exits 1 with `{ authenticated: false }` when signed out. */
export const OriginAuthStatus = Schema.Struct({
  authenticated: Schema.Boolean,
  tokenValid: Schema.optional(Schema.Boolean),
  reason: Schema.optional(Schema.String),
  account: Schema.optional(
    Schema.Struct({
      email: Schema.optional(Schema.String),
      publicUserId: Schema.optional(Schema.String),
    }),
  ),
});
export const decodeOriginAuthStatus = decodeJsonResult(OriginAuthStatus);

/** `origin api /namespaces`: the account's own namespace is the one whose type is `user`. */
const OriginNamespaces = Schema.Struct({
  namespaces: Schema.Array(
    Schema.Struct({
      namespace: Schema.Struct({ slug: Schema.String, type: Schema.optional(Schema.String) }),
    }),
  ),
});
const decodeOriginNamespaces = decodeJsonResult(OriginNamespaces);

export function parseOriginViewerHandle(raw: string): string | null {
  const decoded = decodeOriginNamespaces(raw);
  if (Result.isFailure(decoded)) return null;
  const own = decoded.success.namespaces.find((entry) => entry.namespace.type === "user");
  return own?.namespace.slug.trim() || null;
}

/** `origin repo view --json org,name,defaultBranch,cloneUrl`. */
export const OriginRepository = Schema.Struct({
  org: Schema.String,
  name: Schema.String,
  defaultBranch: Schema.optional(Schema.String),
  cloneUrl: Schema.optional(Schema.String),
});
export const decodeOriginRepository = decodeJsonResult(OriginRepository);
export const ORIGIN_REPOSITORY_FIELDS = "org,name,defaultBranch,cloneUrl";

/** A user, app, or service account; absent when the account no longer exists. */
export const OriginPrincipal = Schema.Struct({
  id: Schema.optional(Schema.String),
  handle: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
});
export const OriginActor = Schema.Struct({
  user: Schema.optional(OriginPrincipal),
  app: Schema.optional(OriginPrincipal),
  serviceAccount: Schema.optional(OriginPrincipal),
});

const OriginApiRef = Schema.Struct({ ref: Schema.String, sha: Schema.optional(Schema.String) });

export const OriginApiPullRequest = Schema.Struct({
  id: Schema.String,
  number: PositiveIntString,
  // "open" or "closed"; a draft is "open", and a merged pull request is "closed" with `merged`.
  state: Schema.String,
  draft: Schema.optional(Schema.Boolean),
  merged: Schema.optional(Schema.Boolean),
  title: Schema.String,
  body: Schema.optional(Schema.String),
  head: OriginApiRef,
  base: OriginApiRef,
  author: Schema.optional(OriginActor),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  // Absent or null while unset.
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  changedFiles: Schema.optional(Schema.Number),
  labels: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.optional(Schema.String) })),
  ),
  stack: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        parentPullRequest: Schema.optional(
          Schema.NullOr(Schema.Struct({ number: PositiveIntString })),
        ),
      }),
    ),
  ),
  webUrl: Schema.String,
  version: Schema.optional(
    Schema.NullOr(Schema.Struct({ number: Schema.optional(Schema.String) })),
  ),
  // Set while auto-merge is armed.
  autoMerge: Schema.optional(
    Schema.NullOr(Schema.Struct({ mergeMethod: Schema.optional(Schema.String) })),
  ),
});
export type OriginApiPullRequest = typeof OriginApiPullRequest.Type;

const OriginApiPullRequestPage = Schema.Struct({
  pullRequests: Schema.Array(Schema.Unknown),
  nextPageToken: Schema.optional(Schema.String),
});
const decodeOriginApiPullRequestPage = decodeJsonResult(OriginApiPullRequestPage);
const decodeOriginApiPullRequestRow = Schema.decodeUnknownOption(OriginApiPullRequest);

/** A strict page, for reads where a row this build cannot read must fail the read. */
export const OriginApiPullRequestPageSchema = Schema.Struct({
  pullRequests: Schema.Array(OriginApiPullRequest),
  nextPageToken: Schema.optional(Schema.String),
});

/**
 * Origin is in beta, so a row this build cannot read is skipped instead of failing the page.
 * Undefined when the page itself is not a pull request list.
 */
export function parseOriginApiPullRequestPage(raw: string):
  | {
      readonly pullRequests: ReadonlyArray<OriginApiPullRequest>;
      readonly nextPageToken: string | null;
    }
  | undefined {
  const page = decodeOriginApiPullRequestPage(raw);
  if (Result.isFailure(page)) return undefined;
  return {
    pullRequests: page.success.pullRequests.flatMap((row) =>
      Option.toArray(decodeOriginApiPullRequestRow(row)),
    ),
    nextPageToken: page.success.nextPageToken || null,
  };
}

export function originApiPullRequestState(pullRequest: OriginApiPullRequest): ChangeRequestState {
  if (pullRequest.merged === true) return "merged";
  return pullRequest.state === "closed" ? "closed" : "open";
}

export function originApiPullRequestToChangeRequest(
  pullRequest: OriginApiPullRequest,
): ChangeRequest {
  return {
    provider: KIND,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.webUrl,
    baseRefName: pullRequest.base.ref,
    headRefName: pullRequest.head.ref,
    ...(pullRequest.head.sha ? { headSha: pullRequest.head.sha } : {}),
    state: originApiPullRequestState(pullRequest),
    ...(pullRequest.draft === true ? { isDraft: true } : {}),
    closedAt: pullRequest.closedAt ?? null,
    mergedAt: pullRequest.mergedAt ?? null,
    updatedAt: DateTime.make(pullRequest.updatedAt),
  };
}

/** `origin pr view --json <ORIGIN_PULL_REQUEST_VIEW_FIELDS>`, which resolves numbers, URLs and branches. */
export const OriginPullRequestView = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  headRef: Schema.String,
  baseRef: Schema.String,
  status: Schema.Literals(["open", "draft", "closed", "merged"]),
  url: Schema.String,
  headSha: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  closedAt: Schema.optional(Schema.NullOr(Schema.String)),
  mergedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
export const decodeOriginPullRequestView = decodeJsonResult(OriginPullRequestView);
export const ORIGIN_PULL_REQUEST_VIEW_FIELDS =
  "number,title,headRef,baseRef,status,url,headSha,updatedAt,closedAt,mergedAt";

export function originPullRequestViewToChangeRequest(
  view: typeof OriginPullRequestView.Type,
): ChangeRequest {
  return {
    provider: KIND,
    number: view.number,
    title: view.title,
    url: view.url,
    baseRefName: view.baseRef,
    headRefName: view.headRef,
    ...(view.headSha ? { headSha: view.headSha } : {}),
    state: view.status === "draft" ? "open" : view.status,
    ...(view.status === "draft" ? { isDraft: true } : {}),
    closedAt: view.closedAt ?? null,
    mergedAt: view.mergedAt ?? null,
    updatedAt: view.updatedAt ? DateTime.make(view.updatedAt) : Option.none(),
  };
}
