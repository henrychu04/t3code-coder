import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import { make } from "./AgentMergeRequests.ts";

const exec = promisify(execFile);
const threadId = ThreadId.make("thread-one");
const runId = RunId.make("run-one");
const instanceId = ProviderInstanceId.make("codex");
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
] as unknown as OrchestrationProjectShell[];

type Tools = Effect.Success<typeof make>;
const prepare = (
  tools: Tools,
  input: { readonly readOnly?: boolean; readonly instanceId?: ProviderInstanceId } = {},
) =>
  Effect.runPromise(
    tools.prepare({
      threadId,
      runId,
      readOnly: input.readOnly ?? false,
      instanceId: input.instanceId ?? instanceId,
    }),
  ).then((instructions) => {
    if (instructions === undefined) throw new Error("Missing MR instructions");
    return instructions;
  });

function fixture(
  run: (
    tools: Tools,
    thread: OrchestrationV2ThreadShell,
    commands: OrchestrationV2Command[],
  ) => Promise<void>,
) {
  const thread = {
    id: threadId,
    archivedAt: null,
    activeRunId: runId,
    interactionMode: "default",
    pullRequests: [],
  } as unknown as OrchestrationV2ThreadShell;
  const commands: OrchestrationV2Command[] = [];
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const tools = yield* make;
        yield* tools.bind({
          getThreadShell: (id) => Effect.succeed(id === threadId ? thread : null),
          listProjects: Effect.succeed(projects),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              if (command.type === "thread.pull-request.link") {
                (thread as unknown as { pullRequests: unknown[] }).pullRequests = [
                  {
                    ...command,
                    linkedAt: "2026-09-10T00:00:00.000Z",
                    snapshot: null,
                    stack: null,
                  },
                ];
              } else if (command.type === "thread.pull-request.unlink") {
                (thread as unknown as { pullRequests: unknown[] }).pullRequests = [];
              }
              return { sequence: commands.length };
            }),
        });
        yield* Effect.promise(() => run(tools, thread, commands));
      }),
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
      const script = scriptOf(await prepare(tools));
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
      const script = scriptOf(await prepare(tools));
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
      const instructions = await prepare(tools, { readOnly: true });
      expect(instructions).toContain("Only listing");
      const script = scriptOf(instructions);
      expect(await call(script, "list")).toMatchObject({ mergeRequests: [] });
      await expect(call(script, "link", url)).rejects.toThrow();
      expect(commands).toHaveLength(0);
    }));
  it("rejects inactive turns and ignores completion for another turn", () =>
    fixture(async (tools, thread) => {
      const script = scriptOf(await prepare(tools));
      await Effect.runPromise(tools.release(threadId, RunId.make("older")));
      await access(script);
      Object.assign(thread, { activeRunId: RunId.make("next") });
      await expect(call(script, "list")).rejects.toThrow();
      await Effect.runPromise(tools.release(threadId, runId));
      await expect(access(script)).rejects.toThrow();
    }));
});

it("does not revoke a replacement provider's commands on a stale exit", () =>
  fixture(async (tools) => {
    const oldProvider = ProviderInstanceId.make("old");
    const newProvider = ProviderInstanceId.make("new");
    const oldScript = scriptOf(await prepare(tools, { instanceId: oldProvider }));
    const newScript = scriptOf(await prepare(tools, { instanceId: newProvider }));
    await expect(access(oldScript)).rejects.toThrow();
    await Effect.runPromise(tools.release(threadId, undefined, oldProvider));
    expect(await call(newScript, "list")).toMatchObject({ mergeRequests: [] });
  }));

it("checks persisted plan mode even when the caller omits it", () =>
  fixture(async (tools, thread, commands) => {
    Object.assign(thread, { interactionMode: "plan" });
    const script = scriptOf(await prepare(tools));
    await expect(call(script, "link", url)).rejects.toThrow();
    expect(commands).toHaveLength(0);
  }));
