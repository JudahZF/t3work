import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export class OriginCliError extends Schema.TaggedError<OriginCliError>()("OriginCliError", {
  operation: Schema.String,
  cwd: Schema.String,
  reason: Schema.Literals(["missing-cli", "authentication", "not-found", "rate-limit", "failed"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface OriginCommandInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs?: number;
}

export interface OriginApiInput {
  readonly operation: string;
  readonly cwd: string;
  /** Below `/v1/origin`; `{owner}/{repo}` expand from `repository`, else the `origin` remote. */
  readonly path: string;
  readonly repository?: string | undefined;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | undefined;
  readonly body?: unknown;
}

/** Runs the signed-in `origin` CLI, which holds the credential: T3 Code never sees a token. */
export class OriginCli extends Context.Service<
  OriginCli,
  {
    /** Resolves with stdout. */
    readonly execute: (input: OriginCommandInput) => Effect.Effect<string, OriginCliError>;
    /** `origin api`, resolving with the response body. */
    readonly api: (input: OriginApiInput) => Effect.Effect<string, OriginCliError>;
  }
>()("@t3tools/source-control-origin/server/OriginCli") {}

const ApiErrorBody = Schema.Struct({ message: Schema.String });
const decodeApiErrorBody = decodeJsonResult(ApiErrorBody);
const encodeApiBody = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * `origin` exits non-zero with `Error: <sentence>` on stderr; `origin api` adds
 * `origin api: HTTP <status>` there and the host's `{ message }` body on stdout.
 */
function classifyOriginFailure(output: {
  readonly stdout: string;
  readonly stderr: string;
}): Pick<OriginCliError, "reason" | "detail"> {
  const apiMessage = decodeApiErrorBody(output.stdout.trim());
  const stderr = output.stderr.trim();
  const status = Number(/\bHTTP (\d{3})\b/.exec(stderr)?.[1]);
  const detail =
    (Result.isSuccess(apiMessage) ? apiMessage.success.message.trim() : "") ||
    stderr
      .split(/\r?\n/)
      .map((line) => line.replace(/^Error:\s*/, "").trim())
      .find((line) => line.length > 0) ||
    "Origin CLI command failed.";
  const normalized = `${stderr}\n${detail}`.toLowerCase();
  if (status === 401 || /not authenticated|not logged in|origin auth login/.test(normalized)) {
    return {
      reason: "authentication",
      detail: "Origin CLI is not signed in. Run `origin auth login` and retry.",
    };
  }
  if (status === 429 || normalized.includes("rate limit")) return { reason: "rate-limit", detail };
  if (status === 404 || /\bnot found\b/.test(normalized)) return { reason: "not-found", detail };
  return { reason: "failed", detail };
}

const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;

  const run = (input: OriginCommandInput & { readonly stdin?: string }) =>
    process
      .run({
        operation: `OriginCli.${input.operation}`,
        command: "origin",
        args: input.args,
        cwd: input.cwd,
        allowNonZeroExit: true,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
        ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OriginCliError({
              operation: input.operation,
              cwd: input.cwd,
              cause,
              ...(cause._tag === "VcsProcessSpawnError"
                ? {
                    reason: "missing-cli" as const,
                    detail: "Install the Cursor Origin CLI (`origin`) and run `origin auth login`.",
                  }
                : { reason: "failed" as const, detail: "Origin CLI command failed." }),
            }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new OriginCliError({
                  operation: input.operation,
                  cwd: input.cwd,
                  ...classifyOriginFailure(result),
                }),
              ),
        ),
      );

  return OriginCli.of({
    execute: run,
    api: (input) =>
      run({
        operation: input.operation,
        cwd: input.cwd,
        args: [
          "api",
          input.path,
          "--method",
          input.method ?? "GET",
          ...(input.repository ? ["--repo", input.repository] : []),
          ...(input.body === undefined ? [] : ["--input", "-"]),
        ],
        ...(input.body === undefined ? {} : { stdin: encodeApiBody(input.body) }),
      }),
  });
});

export const layer = Layer.effect(OriginCli, make);
