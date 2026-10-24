import { assert, describe, it } from "@effect/vitest";
import { SourceControlProviderKind } from "@t3tools/contracts";
import type { SourceControlProcessInput } from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import apiPullsAll from "./fixtures/api-pulls-all.json" with { type: "json" };
import authStatusSignedOut from "./fixtures/auth-status-signed-out.json" with { type: "json" };
import authStatus from "./fixtures/auth-status.json" with { type: "json" };
import repoView from "./fixtures/repo-view.json" with { type: "json" };
import * as OriginCli from "./OriginCli.ts";
import * as OriginSourceControlProvider from "./OriginSourceControlProvider.ts";

const context = {
  provider: {
    kind: SourceControlProviderKind.make("cursor-origin"),
    name: "Cursor Origin",
    baseUrl: "https://origin.cursor.com",
  },
  remoteName: "upstream",
  remoteUrl: "git@origin.cursor.com:ada/demo.git",
};

/** Answers each `origin` run from `answer`, recording its arguments. */
function originHost(
  answer: (args: ReadonlyArray<string>) => { stdout?: string; stderr?: string; exitCode?: number },
) {
  const runs: Array<ReadonlyArray<string>> = [];
  const layer = OriginCli.layer.pipe(
    Layer.provideMerge(
      TestSourceControlHost.layer({
        process: {
          run: (input: SourceControlProcessInput) => {
            runs.push(input.args);
            const result = answer(input.args);
            return Effect.succeed(
              TestSourceControlHost.processOutput(result.stdout ?? "", {
                stderr: result.stderr ?? "",
                exitCode: ChildProcessSpawner.ExitCode(result.exitCode ?? 0),
              }),
            );
          },
        },
      }),
    ),
  );
  return { runs, layer };
}

const output = (stdout: unknown) => ({ stdout: JSON.stringify(stdout) });
const isOriginCliError = Schema.is(OriginCli.OriginCliError);

describe("OriginSourceControlProvider", () => {
  it("reads `origin auth status --json` signed in, signed out, and unreadable", () => {
    const exitCode = ChildProcessSpawner.ExitCode;
    const signedIn = OriginSourceControlProvider.parseOriginAuth({
      stdout: JSON.stringify(authStatus),
      stderr: "",
      exitCode: exitCode(0),
    });
    assert.strictEqual(signedIn.status, "authenticated");
    assert.deepStrictEqual(signedIn.account, Option.some("ada@example.com"));

    const signedOut = OriginSourceControlProvider.parseOriginAuth({
      stdout: JSON.stringify(authStatusSignedOut),
      stderr: "",
      exitCode: exitCode(1),
    });
    assert.strictEqual(signedOut.status, "unauthenticated");
    assert.deepStrictEqual(
      signedOut.detail,
      Option.some("Not logged in. Run `origin auth login` to sign in."),
    );

    assert.strictEqual(
      OriginSourceControlProvider.parseOriginAuth({
        stdout: "Account: ada@example.com",
        stderr: "",
        exitCode: exitCode(0),
      }).status,
      "unknown",
    );
  });

  it.effect("opens pull requests as ready, not as Origin's default draft", () => {
    const host = originHost(() => output({}));
    return Effect.gen(function* () {
      const provider = yield* OriginSourceControlProvider.make;
      yield* provider.createChangeRequest({
        cwd: "/repo",
        context,
        baseRefName: "main",
        headSelector: "feature/x",
        title: "Add x",
        bodyFile: "/tmp/body.md",
      });
      assert.deepStrictEqual(host.runs, [
        [
          "pr",
          "create",
          "--repo",
          "ada/demo",
          "--title",
          "Add x",
          "--body-file",
          "/tmp/body.md",
          "--head",
          "feature/x",
          "--base",
          "main",
          "--status",
          "open",
        ],
      ]);
    }).pipe(Effect.provide(host.layer));
  });

  it.effect("finds a branch's pull requests through the API, which counts drafts as open", () => {
    const host = originHost(() => output(apiPullsAll));
    return Effect.gen(function* () {
      const provider = yield* OriginSourceControlProvider.make;
      const closed = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature/x",
        state: "closed",
      });
      // The API's "closed" includes merged pull requests.
      assert.deepStrictEqual(
        closed.map((request) => request.number),
        [4],
      );
      const open = yield* provider.listChangeRequests({
        cwd: "/repo",
        context,
        headSelector: "feature/x",
        state: "open",
        limit: 5,
      });
      assert.deepStrictEqual(
        open.map((request) => [request.number, request.isDraft ?? false]),
        [
          [2, true],
          [1, false],
        ],
      );
      assert.deepStrictEqual(host.runs[1], [
        "api",
        "/repos/{owner}/{repo}/pulls?head=feature%2Fx&state=open&pageSize=5&sortBy=updated",
        "--method",
        "GET",
        "--repo",
        "ada/demo",
      ]);
    }).pipe(Effect.provide(host.layer));
  });

  it.effect("publishes private repositories and refuses public ones", () => {
    const host = originHost((args) => (args[1] === "view" ? output(repoView) : output({})));
    return Effect.gen(function* () {
      const provider = yield* OriginSourceControlProvider.make;
      const refused = yield* provider
        .createRepository({ cwd: "/repo", repository: "ada/demo", visibility: "public" })
        .pipe(Effect.flip);
      assert.strictEqual(refused.detail, "Cursor Origin repositories cannot be public.");
      assert.deepStrictEqual(host.runs, []);

      const urls = yield* provider.createRepository({
        cwd: "/repo",
        repository: "ada/demo",
        visibility: "private",
      });
      assert.deepStrictEqual(urls, {
        nameWithOwner: "ada/demo",
        url: "https://origin.cursor.com/ada/demo.git",
        sshUrl: "git@origin.cursor.com:ada/demo.git",
      });
      assert.deepStrictEqual(
        host.runs.map((args) => args.slice(0, 2).join(" ")),
        ["repo create", "repo edit", "repo view"],
      );
      assert.deepStrictEqual(host.runs[1]?.slice(2), ["ada/demo", "--visibility", "private"]);
    }).pipe(Effect.provide(host.layer));
  });

  it.effect("reports a signed-out CLI and a missing pull request in Origin's own words", () => {
    const host = originHost((args) =>
      args[0] === "api"
        ? {
            stdout: '{"code":5,"message":"pull request #9 not found"}',
            stderr: "origin api: HTTP 404 Not Found",
            exitCode: 1,
          }
        : {
            stderr: "Error: Not authenticated. Run `origin auth login` or set CURSOR_API_KEY.",
            exitCode: 1,
          },
    );
    return Effect.gen(function* () {
      const provider = yield* OriginSourceControlProvider.make;
      const signedOut = yield* provider
        .getChangeRequest({ cwd: "/repo", context, reference: "9" })
        .pipe(Effect.flip);
      assert.strictEqual(
        signedOut.detail,
        "Origin CLI is not signed in. Run `origin auth login` and retry.",
      );
      const missing = yield* provider
        .listChangeRequests({ cwd: "/repo", context, headSelector: "x", state: "open" })
        .pipe(Effect.flip);
      assert.strictEqual(missing.detail, "pull request #9 not found");
      assert.strictEqual(
        isOriginCliError(missing.cause) ? missing.cause.reason : null,
        "not-found",
      );
    }).pipe(Effect.provide(host.layer));
  });
});
