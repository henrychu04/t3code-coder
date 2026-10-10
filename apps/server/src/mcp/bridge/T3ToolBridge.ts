/**
 * Coder: runs upstream's T3 toolkits for agents over the workspace file bridge instead of MCP.
 *
 * The toolkit definitions and handlers are upstream's; only the transport differs. A call that
 * does not finish within {@link INLINE_BUDGET_MS} keeps running and answers with a task id that
 * the agent polls with `task_status`, so a provider's shell timeout never cuts a tool off.
 *
 * @module mcp/bridge/T3ToolBridge
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as McpInvocationContext from "../McpInvocationContext.ts";
import * as McpToolAccess from "../McpToolAccess.ts";
import * as OrchestratorMcpService from "../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../ThreadMetadataMcpService.ts";
import * as OrchestratorToolkitHandlers from "../toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../toolkits/orchestrator/tools.ts";
import * as PullRequestsToolkitHandlers from "../toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "../toolkits/pullRequests/tools.ts";
import * as ThreadToolkitHandlers from "../toolkits/thread/handlers.ts";
import { ThreadToolkit } from "../toolkits/thread/tools.ts";
import * as EnvironmentToolkitHandlers from "../toolkits/environment/handlers.ts";
import { EnvironmentToolkit } from "../toolkits/environment/tools.ts";
import * as ProjectToolkitHandlers from "../toolkits/project/handlers.ts";
import { ProjectToolkit } from "../toolkits/project/tools.ts";
import * as WorktreeToolkitHandlers from "../toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "../toolkits/worktree/tools.ts";
import * as HtmlToolkitHandlers from "../toolkits/html/handlers.ts";
import { HtmlRenderToolkit } from "../toolkits/html/tools.ts";
import * as HtmlRender from "../../htmlRender/HtmlRender.ts";
import * as WorktreeMcpService from "../WorktreeMcpService.ts";
import {
  type FileBridgeCatalogEntry,
  type FileBridgeRequest,
  FileBridgeToolFailure,
} from "./FileBridge.ts";
import { type T3ToolBinding, t3ToolFailure } from "./T3ToolDispatch.ts";

/**
 * Upstream's toolkits the bridge carries. Preview, device, attachment uploads, and `html_preview`
 * stay out.
 */
const BridgedToolkit = Toolkit.merge(
  OrchestratorToolkit,
  ThreadToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  HtmlRenderToolkit,
);

/** Handlers as upstream's MCP server registers them. */
const BridgedHandlersLive = Layer.mergeAll(
  McpToolAccess.HandlersLayer.layer(OrchestratorToolkitHandlers.layer).pipe(
    Layer.provide(OrchestratorMcpService.layer),
    Layer.provide(ThreadMetadataMcpService.layer),
  ),
  McpToolAccess.HandlersLayer.layer(ThreadToolkitHandlers.layer),
  McpToolAccess.HandlersLayer.layer(ProjectToolkitHandlers.layer),
  McpToolAccess.HandlersLayer.layer(EnvironmentToolkitHandlers.layer),
  McpToolAccess.HandlersLayer.layer(WorktreeToolkitHandlers.layer).pipe(
    Layer.provide(WorktreeMcpService.layer),
  ),
  McpToolAccess.HandlersLayer.layer(PullRequestsToolkitHandlers.layer),
  McpToolAccess.HandlersLayer.layer(HtmlToolkitHandlers.layerRender).pipe(
    Layer.provide(HtmlRender.layer),
  ),
);

const INLINE_BUDGET_MS = 8_000;
const BRIDGE_JOB_PREFIX = "bridge-job:";
const MAX_JOBS_PER_THREAD = 16;
const JOB_RETENTION_MS = 60 * 60 * 1_000;

const TASK_STATUS_ENTRY: FileBridgeCatalogEntry = {
  name: "task_status",
  description:
    "Read the result of a T3 tool call that answered {status:'running', taskId}. Returns the tool's result once it finishes, or {status:'running'} while it is still running.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
  },
};

const isReadOnly = (tool: Tool.Any) => Context.get(tool.annotations, Tool.Readonly);

/** What `--list` and `--schema` show; built from the tool definitions alone. */
export const T3_TOOL_CATALOG: ReadonlyArray<FileBridgeCatalogEntry> = [
  ...Object.values(BridgedToolkit.tools as Record<string, Tool.Any>).map((tool) => ({
    name: tool.name,
    description: Tool.getDescription(tool) ?? "",
    readOnly: isReadOnly(tool),
    inputSchema: Tool.getJsonSchema(tool),
  })),
  ...(Object.hasOwn(BridgedToolkit.tools, "task_status") ? [] : [TASK_STATUS_ENTRY]),
];

const READ_ONLY_TOOLS = new Set(
  T3_TOOL_CATALOG.filter((entry) => entry.readOnly).map((entry) => entry.name),
);

const failure = t3ToolFailure;

/** A failure the tool raised rather than returned: its tag and its agent-facing message. */
const toolFailure = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "_tag" in cause
    ? failure(
        String(cause._tag),
        cause instanceof Error && cause.message.length > 0 ? cause.message : String(cause._tag),
      )
    : failure("T3ToolFailed", "The T3 tool failed.");

interface BridgeJob {
  readonly threadId: ThreadId;
  readonly startedAt: number;
  readonly fiber: Fiber.Fiber<unknown, FileBridgeToolFailure>;
}

/**
 * Binds upstream's handlers once the orchestrator is available. Calls that outlive the inline
 * budget run in the caller's scope, so they stop with the helper.
 */
export const makeBindingWith = (options: { readonly inlineBudgetMs?: number } = {}) =>
  Effect.gen(function* () {
    const toolkit = yield* BridgedToolkit.pipe(Effect.provide(BridgedHandlersLive));
    // Handlers also read services when they run, as upstream's MCP server provides them.
    const services = yield* Effect.context<never>();
    const engine = yield* Orchestrator.OrchestratorV2;
    const crypto = yield* Crypto.Crypto;
    const jobScope = yield* Effect.scope;
    const jobs = new Map<string, BridgeJob>();

    const run = (
      scope: McpInvocationContext.McpThreadInvocationScope,
      request: FileBridgeRequest,
    ): Effect.Effect<unknown, FileBridgeToolFailure> =>
      (
        toolkit.handle as (
          name: string,
          params: unknown,
        ) => Effect.Effect<
          Stream.Stream<
            Tool.HandlerResult<Tool.Any>,
            unknown,
            McpInvocationContext.McpInvocationContext
          >,
          unknown
        >
      )(request.tool, request.params).pipe(
        Effect.flatMap(Stream.runLast),
        Effect.flatMap((last) =>
          Option.match(last, {
            onNone: () => Effect.fail(failure("T3ToolFailed", "The T3 tool returned no result.")),
            onSome: (result) =>
              // A declared failure reaches the agent as its encoded result, like MCP's
              // structured content.
              result.isFailure
                ? Effect.fail(new FileBridgeToolFailure({ value: result.encodedResult }))
                : Effect.succeed(result.encodedResult),
          }),
        ),
        Effect.mapError((cause) =>
          cause instanceof FileBridgeToolFailure ? cause : toolFailure(cause),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provide(services),
      );

    const readJob = (scope: McpInvocationContext.McpThreadInvocationScope, taskId: string) =>
      Effect.gen(function* () {
        const job = jobs.get(taskId);
        if (job === undefined || job.threadId !== scope.thread.threadId) {
          return yield* failure("TaskNotFound", "No running T3 tool call has this taskId.");
        }
        const exit = job.fiber.pollUnsafe();
        if (exit === undefined) return { status: "running", taskId };
        jobs.delete(taskId);
        return yield* exit;
      });

    const dispatch: T3ToolBinding["dispatch"] = (scope, request) =>
      Effect.gen(function* () {
        const params = request.params as Record<string, unknown>;
        if (
          request.tool === "task_status" &&
          typeof params.taskId === "string" &&
          params.taskId.startsWith(BRIDGE_JOB_PREFIX)
        ) {
          return yield* readJob(scope, params.taskId);
        }
        if (!T3_TOOL_CATALOG.some((entry) => entry.name === request.tool)) {
          return yield* failure("UnknownTool", "Unknown T3 tool. Run --list to see the tools.");
        }
        const thread = yield* engine
          .getThreadShell(scope.thread.threadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (thread?.interactionMode === "plan" && !READ_ONLY_TOOLS.has(request.tool)) {
          return yield* failure("PlanModeReadOnly", "Plan mode permits read-only T3 tools only.");
        }

        const now = Date.now();
        for (const [taskId, job] of jobs) {
          if (now - job.startedAt > JOB_RETENTION_MS) {
            jobs.delete(taskId);
            yield* Fiber.interrupt(job.fiber);
          }
        }
        const fiber = yield* run(scope, request).pipe(Effect.forkIn(jobScope));
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.timeoutOption(options.inlineBudgetMs ?? INLINE_BUDGET_MS),
        );
        if (Option.isSome(exit)) return yield* exit.value;
        if (
          [...jobs.values()].filter((job) => job.threadId === scope.thread.threadId).length >=
          MAX_JOBS_PER_THREAD
        ) {
          yield* Fiber.interrupt(fiber);
          return yield* failure(
            "TooManyRunningCalls",
            "Too many T3 tool calls are still running. Read their results with task_status first.",
          );
        }
        const taskId = `${BRIDGE_JOB_PREFIX}${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
        jobs.set(taskId, { threadId: scope.thread.threadId, startedAt: now, fiber });
        return {
          status: "running",
          taskId,
          message: "Still running. Call task_status with this taskId for the result.",
        };
      });

    return { catalog: T3_TOOL_CATALOG, dispatch } satisfies T3ToolBinding;
  });

export const makeBinding = makeBindingWith();
