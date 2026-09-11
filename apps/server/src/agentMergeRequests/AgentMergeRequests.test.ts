import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import {
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadShell,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { make } from "./AgentMergeRequests.ts";

const exec = promisify(execFile);
const threadId = ThreadId.make("thread-one");
const url = "https://code.example/team/repo/-/merge_requests/12";
const projects = [
  {
    repositoryIdentity: {
      provider: "gitlab",
      canonicalKey: "code.example/team/repo",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "https://code.example/team/repo.git",
      },
    },
  },
] as OrchestrationProjectShell[];

function fixture(
  run: (
    tools: Effect.Success<typeof make>,
    thread: OrchestrationThreadShell,
    commands: OrchestrationCommand[],
  ) => Promise<void>,
) {
  const thread = {
    id: threadId,
    archivedAt: null,
    session: null,
    pullRequests: [],
  } as unknown as OrchestrationThreadShell;
  const commands: OrchestrationCommand[] = [];
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* make;
        yield* Effect.promise(() => run(tools, thread, commands));
      }),
    ).pipe(
      Effect.provideService(ProjectionSnapshotQuery, {
        getThreadShellById: (id: ThreadId) =>
          Effect.succeed(id === threadId ? Option.some(thread) : Option.none()),
        getShellSnapshot: () => Effect.succeed({ projects }),
      } as unknown as ProjectionSnapshotQuery["Service"]),
      Effect.provideService(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            commands.push(command);
            if (command.type === "thread.pull-request.link") {
              (thread as unknown as { pullRequests: unknown[] }).pullRequests = [
                { ...command, linkedAt: "2026-09-10T00:00:00.000Z", snapshot: null, stack: null },
              ];
            } else if (command.type === "thread.pull-request.unlink") {
              (thread as unknown as { pullRequests: unknown[] }).pullRequests = [];
            }
            return { sequence: commands.length };
          }),
      } as unknown as OrchestrationEngineService["Service"]),
    ),
  );
}
function scriptOf(instructions: string) {
  const script = /'([^']+\/mr\.mjs)'/u.exec(instructions)?.[1];
  if (!script) throw new Error("Missing MR command");
  return script;
}
const call = async (script: string, ...args: string[]) =>
  JSON.parse((await exec(process.execPath, [script, ...args])).stdout);

describe("agent MR operations", () => {
  it("links, lists and unlinks only the captured thread, idempotently", () =>
    fixture(async (tools, _, commands) => {
      const script = scriptOf(await Effect.runPromise(tools.prepare(threadId, false)));
      expect(await call(script, "link", url)).toMatchObject({ number: 12, alreadyLinked: false });
      expect(await call(script, "link", url)).toMatchObject({ alreadyLinked: true });
      expect(await call(script, "list")).toMatchObject({
        mergeRequests: [{ number: 12, source: "agent" }],
      });
      expect(await call(script, "unlink", url)).toMatchObject({ wasLinked: true });
      expect(await call(script, "unlink", url)).toMatchObject({ wasLinked: false });
      expect(commands).toHaveLength(2);
      expect(
        commands.every((command) => "threadId" in command && command.threadId === threadId),
      ).toBe(true);
      await Effect.runPromise(tools.release(threadId));
      await expect(access(script)).rejects.toThrow();
    }));
  it("rejects unknown hosts, other providers and URL credentials", () =>
    fixture(async (tools, _, commands) => {
      const script = scriptOf(await Effect.runPromise(tools.prepare(threadId, false)));
      for (const target of [
        "https://github.com/team/repo/pull/12",
        url.replace("code.example", "unknown.example"),
        url.replace("https://", "https://user:password@"),
      ]) {
        await expect(call(script, "link", target)).rejects.toThrow();
      }
      expect(commands).toHaveLength(0);
    }));
  it("allows listing but rejects mutations in plan mode", () =>
    fixture(async (tools, _, commands) => {
      const instructions = await Effect.runPromise(tools.prepare(threadId, true));
      expect(instructions).toContain("Only listing");
      const script = scriptOf(instructions);
      expect(await call(script, "list")).toMatchObject({ mergeRequests: [] });
      await expect(call(script, "link", url)).rejects.toThrow();
      expect(commands).toHaveLength(0);
    }));
  it("rejects inactive turns and ignores completion for another turn", () =>
    fixture(async (tools) => {
      const script = scriptOf(await Effect.runPromise(tools.prepare(threadId, false)));
      tools.activate(threadId, TurnId.make("active"));
      await Effect.runPromise(tools.release(threadId, TurnId.make("older")));
      await access(script);
      await expect(call(script, "list")).rejects.toThrow();
      await Effect.runPromise(tools.release(threadId, TurnId.make("active")));
      await expect(access(script)).rejects.toThrow();
    }));
});

it("does not revoke a replacement provider's commands on a stale exit", () =>
  fixture(async (tools) => {
    const oldProvider = ProviderInstanceId.make("old");
    const newProvider = ProviderInstanceId.make("new");
    const oldScript = scriptOf(
      await Effect.runPromise(tools.prepare(threadId, false, oldProvider)),
    );
    const newScript = scriptOf(
      await Effect.runPromise(tools.prepare(threadId, false, newProvider)),
    );
    await expect(access(oldScript)).rejects.toThrow();
    await Effect.runPromise(tools.release(threadId, undefined, oldProvider));
    expect(await call(newScript, "list")).toMatchObject({ mergeRequests: [] });
  }));

it("checks persisted plan mode even when the caller omits it", () =>
  fixture(async (tools, thread, commands) => {
    Object.assign(thread, { interactionMode: "plan" });
    const script = scriptOf(await Effect.runPromise(tools.prepare(threadId, false)));
    await expect(call(script, "link", url)).rejects.toThrow();
    expect(commands).toHaveLength(0);
  }));
