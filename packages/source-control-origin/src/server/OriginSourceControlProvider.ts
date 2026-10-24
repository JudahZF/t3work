import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import {
  probeSourceControlProvider,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { ORIGIN_GIT_HOST } from "../client/definition.ts";
import * as OriginCli from "./OriginCli.ts";
import {
  decodeOriginAuthStatus,
  decodeOriginPullRequestView,
  decodeOriginRepository,
  ORIGIN_PULL_REQUEST_VIEW_FIELDS,
  ORIGIN_REPOSITORY_FIELDS,
  originApiPullRequestState,
  originApiPullRequestToChangeRequest,
  originPullRequestViewToChangeRequest,
  parseOriginApiPullRequestPage,
  parseOriginViewerHandle,
} from "./originJson.ts";

const KIND = SourceControlProviderKind.make("cursor-origin");
const REPOSITORY_PATH = /^[^/\s]+\/[^/\s]+$/;

export function parseOriginAuth(input: SourceControlAuthProbeInput) {
  const status = decodeOriginAuthStatus(input.stdout.trim());
  if (Result.isFailure(status)) {
    return providerAuth({
      status: "unknown",
      host: ORIGIN_GIT_HOST,
      detail: "Origin CLI auth status could not be parsed.",
    });
  }
  if (status.success.authenticated && status.success.tokenValid !== false) {
    return providerAuth({
      status: "authenticated",
      account: status.success.account?.email,
      host: ORIGIN_GIT_HOST,
    });
  }
  return providerAuth({
    status: "unauthenticated",
    host: ORIGIN_GIT_HOST,
    detail: status.success.reason ?? "Run `origin auth login` to sign in to Cursor Origin.",
  });
}

const discovery = {
  type: "cli",
  kind: KIND,
  label: "Cursor Origin",
  executable: "origin",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json"],
  parseAuth: parseOriginAuth,
  installHint:
    "Install the Cursor Origin command-line tool (`origin`) from https://cursor.com/docs/origin, then run `origin auth login`.",
} satisfies SourceControlCliDiscoverySpec;

/** `owner/name` of the remote's repository; undefined lets `origin` read the `origin` remote. */
function contextRepository(
  context: SourceControlProvider.SourceControlProviderContext | undefined,
) {
  return context
    ? (SourceControlProvider.repositoryPathFromRemoteUrl(context.remoteUrl) ?? undefined)
    : undefined;
}

const repositoryArgs = (repository: string | undefined) =>
  repository ? ["--repo", repository] : [];

export const make = Effect.gen(function* () {
  const origin = yield* OriginCli.OriginCli;

  const providerError =
    (operation: string, cwd: string, extra?: { repository?: string; reference?: string }) =>
    (error: OriginCli.OriginCliError) =>
      new SourceControlProviderError({
        provider: KIND,
        operation,
        command: "origin",
        cwd,
        ...(extra?.repository
          ? {
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                extra.repository,
              ),
            }
          : {}),
        ...(extra?.reference
          ? {
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                extra.reference,
              ),
            }
          : {}),
        detail: error.detail,
        cause: error,
      });

  const invalidResponse = (operation: string, cwd: string) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      command: "origin",
      cwd,
      detail: "Origin returned a response this version of T3 Code cannot read.",
    });

  const viewRepository = Effect.fn("OriginSourceControlProvider.viewRepository")(function* (
    operation: string,
    cwd: string,
    repository: string | undefined,
  ) {
    const raw = yield* origin
      .execute({
        operation,
        cwd,
        args: [
          "repo",
          "view",
          ...(repository ? [repository] : []),
          "--json",
          ORIGIN_REPOSITORY_FIELDS,
        ],
      })
      .pipe(Effect.mapError(providerError(operation, cwd, repository ? { repository } : {})));
    const decoded = decodeOriginRepository(raw.trim());
    if (Result.isFailure(decoded)) return yield* invalidResponse(operation, cwd);
    return decoded.success;
  });

  const cloneUrls = Effect.fn("OriginSourceControlProvider.cloneUrls")(function* (
    operation: string,
    cwd: string,
    repository: string,
  ) {
    const repo = yield* viewRepository(operation, cwd, repository);
    const nameWithOwner = `${repo.org}/${repo.name}`;
    return {
      nameWithOwner,
      url: repo.cloneUrl || `https://${ORIGIN_GIT_HOST}/${nameWithOwner}.git`,
      sshUrl: `git@${ORIGIN_GIT_HOST}:${nameWithOwner}.git`,
    } satisfies SourceControlRepositoryCloneUrls;
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    listChangeRequests: Effect.fn("OriginSourceControlProvider.listChangeRequests")(
      function* (input) {
        const head = SourceControlProvider.sourceBranch(input);
        // The REST API, unlike `origin pr list`, counts drafts as open. Its "closed" includes
        // merged pull requests, which the filter below drops.
        const query = new URLSearchParams({
          head,
          state: input.state,
          pageSize: String(Math.min(input.limit ?? 20, 100)),
          sortBy: "updated",
        });
        const raw = yield* origin
          .api({
            operation: "listChangeRequests",
            cwd: input.cwd,
            path: `/repos/{owner}/{repo}/pulls?${query.toString()}`,
            repository: contextRepository(input.context),
          })
          .pipe(
            Effect.mapError(providerError("listChangeRequests", input.cwd, { reference: head })),
          );
        const page = parseOriginApiPullRequestPage(raw);
        if (!page) return yield* invalidResponse("listChangeRequests", input.cwd);
        return page.pullRequests
          .filter(
            (pullRequest) =>
              input.state === "all" || originApiPullRequestState(pullRequest) === input.state,
          )
          .map(originApiPullRequestToChangeRequest);
      },
    ),
    getChangeRequest: Effect.fn("OriginSourceControlProvider.getChangeRequest")(function* (input) {
      const raw = yield* origin
        .execute({
          operation: "getChangeRequest",
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            input.reference,
            ...repositoryArgs(contextRepository(input.context)),
            "--json",
            ORIGIN_PULL_REQUEST_VIEW_FIELDS,
          ],
        })
        .pipe(
          Effect.mapError(
            providerError("getChangeRequest", input.cwd, { reference: input.reference }),
          ),
        );
      const decoded = decodeOriginPullRequestView(raw.trim());
      if (Result.isFailure(decoded)) return yield* invalidResponse("getChangeRequest", input.cwd);
      return originPullRequestViewToChangeRequest(decoded.success);
    }),
    createChangeRequest: (input) =>
      origin
        .execute({
          operation: "createChangeRequest",
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            ...repositoryArgs(contextRepository(input.context)),
            "--title",
            input.title,
            "--body-file",
            input.bodyFile,
            "--head",
            SourceControlProvider.sourceBranch(input),
            "--base",
            input.target?.refName ?? input.baseRefName,
            // `origin pr create` opens a draft unless told otherwise.
            "--status",
            "open",
          ],
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            providerError("createChangeRequest", input.cwd, { reference: input.headSelector }),
          ),
        ),
    getRepositoryCloneUrls: (input) => {
      const repository = input.repository.trim().replace(/\.git$/, "");
      if (!REPOSITORY_PATH.test(repository)) {
        return Effect.fail(
          new SourceControlProviderError({
            provider: KIND,
            operation: "getRepositoryCloneUrls",
            cwd: input.cwd,
            repository: SourceControlProvider.transportSafeSourceControlErrorValue(repository),
            detail: "Specify an Origin repository as owner/repository.",
          }),
        );
      }
      return cloneUrls("getRepositoryCloneUrls", input.cwd, repository);
    },
    createRepository: Effect.fn("OriginSourceControlProvider.createRepository")(function* (input) {
      const repository = input.repository.trim();
      if (input.visibility === "public") {
        return yield* new SourceControlProviderError({
          provider: KIND,
          operation: "createRepository",
          cwd: input.cwd,
          repository: SourceControlProvider.transportSafeSourceControlErrorValue(repository),
          detail: "Cursor Origin repositories cannot be public.",
        });
      }
      const mapError = providerError("createRepository", input.cwd, { repository });
      yield* origin
        .execute({
          operation: "createRepository",
          cwd: input.cwd,
          args: ["repo", "create", repository],
        })
        .pipe(Effect.mapError(mapError));
      // New repositories start internal (visible to the account's teams); publish asked for private.
      yield* origin
        .execute({
          operation: "createRepository",
          cwd: input.cwd,
          args: ["repo", "edit", repository, "--visibility", "private"],
        })
        .pipe(
          Effect.mapError((error) =>
            mapError(
              new OriginCli.OriginCliError({
                ...error,
                detail: `${repository} was created but is still internal, visible to your teams. Make it private on Origin. ${error.detail}`,
              }),
            ),
          ),
        );
      return yield* cloneUrls("createRepository", input.cwd, repository);
    }),
    getDefaultBranch: (input) =>
      viewRepository("getDefaultBranch", input.cwd, contextRepository(input.context)).pipe(
        Effect.map((repository) => repository.defaultBranch || null),
      ),
    checkoutChangeRequest: (input) =>
      origin
        .execute({
          operation: "checkoutChangeRequest",
          cwd: input.cwd,
          args: [
            "pr",
            "checkout",
            input.reference,
            ...repositoryArgs(contextRepository(input.context)),
            ...(input.context ? ["--remote", input.context.remoteName] : []),
            ...(input.force ? ["--force"] : []),
          ],
          timeoutMs: 120_000,
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            providerError("checkoutChangeRequest", input.cwd, { reference: input.reference }),
          ),
        ),
  });
});

/**
 * `origin auth status` names the account by email, but repositories live under the account's
 * namespace handle, which is what publishing prefills and the pull request inbox matches.
 */
export const makeDiscovery = Effect.gen(function* () {
  const origin = yield* OriginCli.OriginCli;
  const { process } = yield* SourceControlHost.SourceControlHost;
  return {
    type: "managed-cli",
    kind: KIND,
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("OriginSourceControlProvider.discovery")(function* (cwd: string) {
      const item = yield* probeSourceControlProvider({ cwd, process, spec: discovery });
      if (item.auth.status !== "authenticated") return item;
      const handle = yield* origin
        .api({ operation: "discovery.viewer", cwd, path: "/namespaces" })
        .pipe(
          Effect.map(parseOriginViewerHandle),
          Effect.orElseSucceed(() => null),
        );
      return handle
        ? {
            ...item,
            auth: providerAuth({ status: "authenticated", account: handle, host: ORIGIN_GIT_HOST }),
          }
        : item;
    }),
    // Origin is one public host, which remote detection already recognises by name.
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});
