// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import * as Schema from "effect/Schema";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type SettingSource = "user" | "project" | "local";

export type PermissionUpdateDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session";

export type PermissionUpdate =
  | {
      readonly type: "addRules" | "replaceRules" | "removeRules";
      readonly rules: ReadonlyArray<{ readonly toolName: string; readonly ruleContent?: string }>;
      readonly behavior: "allow" | "deny" | "ask";
      readonly destination: PermissionUpdateDestination;
    }
  | {
      readonly type: "setMode";
      readonly mode: PermissionMode;
      readonly destination: PermissionUpdateDestination;
    }
  | {
      readonly type: "addDirectories" | "removeDirectories";
      readonly directories: ReadonlyArray<string>;
      readonly destination: PermissionUpdateDestination;
    };

export type PermissionResult =
  | {
      readonly behavior: "allow";
      readonly updatedInput?: Record<string, unknown>;
      readonly updatedPermissions?: ReadonlyArray<PermissionUpdate>;
      readonly toolUseID?: string;
      readonly decisionClassification?: "user_temporary" | "user_permanent" | "user_reject";
    }
  | {
      readonly behavior: "deny";
      readonly message: string;
      readonly interrupt?: boolean;
      readonly toolUseID?: string;
      readonly decisionClassification?: "user_temporary" | "user_permanent" | "user_reject";
    };

export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    readonly signal: AbortSignal;
    readonly suggestions?: ReadonlyArray<PermissionUpdate>;
    readonly blockedPath?: string;
    readonly decisionReason?: string;
    readonly title?: string;
    readonly displayName?: string;
    readonly description?: string;
    readonly toolUseID: string;
    readonly agentID?: string;
  },
) => Promise<PermissionResult>;

export type ModelUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly webSearchRequests: number;
  readonly costUSD: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
};

type MessageContent =
  | string
  | ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly [key: string]: unknown;
    }>;

export type SDKUserMessage = {
  readonly type: "user";
  readonly session_id: string;
  readonly parent_tool_use_id: string | null;
  readonly uuid?: string;
  readonly message: {
    readonly role: "user";
    readonly content: MessageContent;
  };
  readonly tool_use_result?: unknown;
};

type SDKAssistantMessage = {
  readonly type: "assistant";
  readonly session_id: string;
  readonly parent_tool_use_id: string | null;
  readonly uuid: string;
  readonly message: {
    readonly id?: string;
    readonly model?: string;
    readonly content?: ReadonlyArray<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
};

type StreamEvent =
  | {
      readonly type: "message_delta";
      readonly usage: unknown;
      readonly [key: string]: unknown;
    }
  | {
      readonly type: "content_block_delta";
      readonly index: number;
      readonly delta:
        | { readonly type: "text_delta"; readonly text: string }
        | { readonly type: "thinking_delta"; readonly thinking: string }
        | { readonly type: "input_json_delta"; readonly partial_json: string };
    }
  | {
      readonly type: "content_block_start";
      readonly index: number;
      readonly content_block: {
        readonly type: string;
        readonly id: string;
        readonly name: string;
        readonly input?: unknown;
        readonly text?: string;
        readonly [key: string]: unknown;
      };
    }
  | {
      readonly type: "content_block_stop";
      readonly index: number;
    };

type SDKPartialAssistantMessage = {
  readonly type: "stream_event";
  readonly session_id: string;
  readonly parent_tool_use_id: string | null;
  readonly uuid?: string;
  readonly event: StreamEvent;
};

export type SDKResultMessage = {
  readonly type: "result";
  readonly subtype: "success" | "error_max_turns" | "error_during_execution" | string;
  readonly session_id: string;
  readonly uuid?: string;
  readonly is_error: boolean;
  readonly result?: string;
  readonly errors?: ReadonlyArray<string>;
  readonly terminal_reason?: string;
  readonly stop_reason?: string | null;
  readonly usage?: unknown;
  readonly modelUsage?: Record<string, ModelUsage>;
  readonly total_cost_usd?: number;
  readonly duration_ms?: number;
  readonly duration_api_ms?: number;
  readonly num_turns?: number;
  readonly [key: string]: unknown;
};

type SDKSystemSubtype =
  | "init"
  | "status"
  | "compact_boundary"
  | "hook_started"
  | "hook_progress"
  | "hook_response"
  | "task_started"
  | "task_progress"
  | "task_updated"
  | "task_notification"
  | "files_persisted"
  | "thinking_tokens"
  | "api_retry"
  | "session_state_changed"
  | "notification"
  | "model_refusal_fallback"
  | "local_command_output"
  | "plugin_install"
  | "commands_changed"
  | "memory_recall"
  | "elicitation_complete"
  | "permission_denied"
  | "mirror_error";

type SDKSystemMessageCommon = {
  readonly type: "system";
  readonly session_id: string;
  readonly uuid?: string;
  readonly hook_id: string;
  readonly hook_name: string;
  readonly hook_event: string;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exit_code?: number;
  readonly task_id: string;
  readonly tool_use_id?: string;
  readonly description: string;
  readonly subagent_type?: string;
  readonly task_type?: string;
  readonly workflow_name?: string;
  readonly skip_transcript?: boolean;
  readonly summary?: string;
  readonly usage?: unknown;
  readonly last_tool_name?: string;
  readonly patch: {
    readonly status?: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
    readonly description?: string;
    readonly error?: string;
    readonly end_time?: number;
    readonly is_backgrounded?: boolean;
  };
  readonly output_file?: string;
  readonly files?: ReadonlyArray<{ readonly filename: string; readonly file_id: string }>;
  readonly failed?: ReadonlyArray<{ readonly filename: string; readonly error: string }>;
  readonly attempt: number;
  readonly max_retries: number;
  readonly state: string;
  readonly priority?: string;
  readonly text: string;
  readonly tool_name: string;
  readonly decision_reason?: string;
  readonly agent_id?: string;
  readonly error: string;
  readonly [key: string]: unknown;
};

type SDKSystemMessage = {
  [Subtype in SDKSystemSubtype]: SDKSystemMessageCommon & {
    readonly subtype: Subtype;
  } & (Subtype extends "hook_response"
      ? { readonly outcome: "success" | "error" | "cancelled" }
      : Subtype extends "task_notification"
        ? { readonly status: "completed" | "failed" | "stopped" }
        : Subtype extends "status"
          ? { readonly status?: string }
          : Record<never, never>);
}[SDKSystemSubtype];

type SDKToolProgressMessage = {
  readonly type: "tool_progress";
  readonly session_id: string;
  readonly tool_use_id: string;
  readonly tool_name: string;
  readonly elapsed_time_seconds: number;
  readonly task_id?: string;
  readonly parent_tool_use_id: string | null;
};

type SDKToolUseSummaryMessage = {
  readonly type: "tool_use_summary";
  readonly session_id: string;
  readonly summary: string;
  readonly preceding_tool_use_ids: ReadonlyArray<string>;
};

type SDKAuthStatusMessage = {
  readonly type: "auth_status";
  readonly session_id: string;
  readonly isAuthenticating: boolean;
  readonly output: ReadonlyArray<string>;
  readonly error?: string;
};

type SDKRateLimitMessage = {
  readonly type: "rate_limit_event";
  readonly session_id: string;
  readonly [key: string]: unknown;
};

type SDKPromptSuggestionMessage = {
  readonly type: "prompt_suggestion";
  readonly session_id: string;
  readonly suggestion: string;
};

export type SDKMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKPartialAssistantMessage
  | SDKResultMessage
  | SDKSystemMessage
  | SDKToolProgressMessage
  | SDKToolUseSummaryMessage
  | SDKAuthStatusMessage
  | SDKRateLimitMessage
  | SDKPromptSuggestionMessage;

export type SlashCommand = {
  readonly name: string;
  readonly description: string;
  readonly argumentHint: string;
};

export type ModelInfo = {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<"low" | "medium" | "high" | "xhigh" | "max">;
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
  readonly supportsAutoMode?: boolean;
};

export type SDKControlInitializeResponse = {
  readonly commands: ReadonlyArray<SlashCommand>;
  readonly agents?: ReadonlyArray<Record<string, unknown>>;
  readonly models?: ReadonlyArray<ModelInfo>;
  readonly account?: Record<string, unknown>;
  readonly [key: string]: unknown;
};

export type SDKControlGetContextUsageResponse = {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly isAutoCompactEnabled: boolean;
  readonly [key: string]: unknown;
};

export type Options = {
  readonly abortController?: AbortController;
  readonly additionalDirectories?: ReadonlyArray<string>;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly canUseTool?: CanUseTool;
  readonly cwd?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly env?: NodeJS.ProcessEnv;
  readonly includePartialMessages?: boolean;
  readonly model?: string;
  readonly pathToClaudeCodeExecutable: string;
  readonly permissionMode?: PermissionMode;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly persistSession?: boolean;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly sessionId?: string;
  readonly settingSources?: ReadonlyArray<SettingSource>;
  readonly settings?: Record<string, unknown>;
  readonly systemPrompt?: { readonly type: "preset"; readonly preset: "claude_code" };
  readonly stderr?: (data: string) => void;
};

type ControlRequest = {
  readonly type: "control_request";
  readonly request_id: string;
  readonly request: {
    readonly subtype: string;
    readonly tool_name?: string;
    readonly input?: Record<string, unknown>;
    readonly permission_suggestions?: ReadonlyArray<PermissionUpdate>;
    readonly blocked_path?: string;
    readonly decision_reason?: string;
    readonly title?: string;
    readonly display_name?: string;
    readonly description?: string;
    readonly tool_use_id?: string;
    readonly agent_id?: string;
  };
};

type ControlCancelRequest = {
  readonly type: "control_cancel_request";
  readonly request_id: string;
};

type ControlResponse = {
  readonly type: "control_response";
  readonly response:
    | {
        readonly subtype: "success";
        readonly request_id: string;
        readonly response?: Record<string, unknown>;
      }
    | {
        readonly subtype: "error";
        readonly request_id: string;
        readonly error: string;
      };
};

const PermissionUpdateSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["addRules", "replaceRules", "removeRules"]),
    rules: Schema.Array(
      Schema.Struct({
        toolName: Schema.String,
        ruleContent: Schema.optional(Schema.String),
      }),
    ),
    behavior: Schema.Literals(["allow", "deny", "ask"]),
    destination: Schema.Literals(["userSettings", "projectSettings", "localSettings", "session"]),
  }),
  Schema.Struct({
    type: Schema.Literal("setMode"),
    mode: Schema.Literals([
      "default",
      "acceptEdits",
      "bypassPermissions",
      "plan",
      "dontAsk",
      "auto",
    ]),
    destination: Schema.Literals(["userSettings", "projectSettings", "localSettings", "session"]),
  }),
  Schema.Struct({
    type: Schema.Literals(["addDirectories", "removeDirectories"]),
    directories: Schema.Array(Schema.String),
    destination: Schema.Literals(["userSettings", "projectSettings", "localSettings", "session"]),
  }),
]);

const ControlResponseSchema = Schema.Struct({
  type: Schema.Literal("control_response"),
  response: Schema.Union([
    Schema.Struct({
      subtype: Schema.Literal("success"),
      request_id: Schema.String,
      response: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    Schema.Struct({
      subtype: Schema.Literal("error"),
      request_id: Schema.String,
      error: Schema.String,
    }),
  ]),
});

const ControlRequestSchema = Schema.Struct({
  type: Schema.Literal("control_request"),
  request_id: Schema.String,
  request: Schema.Struct({
    subtype: Schema.String,
    tool_name: Schema.optional(Schema.String),
    input: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    permission_suggestions: Schema.optional(Schema.Array(PermissionUpdateSchema)),
    blocked_path: Schema.optional(Schema.String),
    decision_reason: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    display_name: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    tool_use_id: Schema.optional(Schema.String),
    agent_id: Schema.optional(Schema.String),
  }),
});

const ControlCancelRequestSchema = Schema.Struct({
  type: Schema.Literal("control_cancel_request"),
  request_id: Schema.String,
});

const decodeControlResponse = Schema.decodeUnknownSync(ControlResponseSchema);
const decodeControlRequest = Schema.decodeUnknownSync(ControlRequestSchema);
const decodeControlCancelRequest = Schema.decodeUnknownSync(ControlCancelRequestSchema);

type PendingControlResponse = {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (cause: Error) => void;
};

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<T> = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

  enqueue(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  fail(cause: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) waiter.reject(cause);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) return Promise.reject(this.failure);
        if (this.ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

export interface Query extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  getSettings(): Promise<Record<string, unknown>>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  close(): void;
}

const CONTROL_REQUEST_TIMEOUT_MS = 60_000;
const PROCESS_TERMINATION_GRACE_MS = 5_000;
const MAX_CLAUDE_CLI_LINE_BYTES = 1024 * 1024;

function stringifyError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function buildClaudeCliArgs(options: Options): Array<string> {
  const args = ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"];

  if (options.effort) args.push("--effort", options.effort);
  if (options.model) args.push("--model", options.model);
  if (options.canUseTool) args.push("--permission-prompt-tool", "stdio");
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.settingSources) args.push(`--setting-sources=${options.settingSources.join(",")}`);
  // This transport never accepts an integration configuration from callers.
  args.push("--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }));
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.allowDangerouslySkipPermissions) {
    args.push("--allow-dangerously-skip-permissions");
  }
  if (options.includePartialMessages) args.push("--include-partial-messages");
  for (const directory of options.additionalDirectories ?? []) args.push("--add-dir", directory);
  if (options.resume) args.push("--resume", options.resume);
  if (options.resumeSessionAt) args.push("--resume-session-at", options.resumeSessionAt);
  if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.persistSession === false) args.push("--no-session-persistence");
  if (options.settings) args.push("--settings", JSON.stringify(options.settings));

  return args;
}

class ClaudeCliQuery implements Query {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly messages = new AsyncMessageQueue<SDKMessage>();
  private readonly pendingResponses = new Map<string, PendingControlResponse>();
  private readonly callbackControllers = new Map<string, AbortController>();
  private readonly initialization: Promise<SDKControlInitializeResponse>;
  private readonly abortController: AbortController;
  private readonly options: Options;
  private writeChain = Promise.resolve();
  private closed = false;
  private stderrTail = "";

  constructor(prompt: AsyncIterable<SDKUserMessage>, options: Options) {
    this.options = options;
    this.abortController = options.abortController ?? new AbortController();
    this.process = spawn(options.pathToClaudeCodeExecutable, buildClaudeCliArgs(options), {
      cwd: options.cwd,
      env: { ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data: string) => {
      this.stderrTail = `${this.stderrTail}${data}`.slice(-8_192);
      options.stderr?.(data);
    });

    this.process.once("error", (cause) => this.fail(cause));
    this.process.once("exit", (code, signal) => {
      if (this.closed) {
        this.messages.end();
        return;
      }
      if (code === 0 && this.pendingResponses.size === 0) {
        this.messages.end();
        return;
      }
      const detail = this.stderrTail.trim();
      this.fail(
        new Error(
          `Claude Code exited ${
            code === 0
              ? "before completing a control request"
              : signal
                ? `from signal ${signal}`
                : `with code ${String(code)}`
          }${detail ? `: ${detail}` : ""}`,
        ),
      );
    });

    this.readStdout();
    this.abortController.signal.addEventListener("abort", () => this.close(), { once: true });
    this.initialization = this.request({ subtype: "initialize" }).then(
      (response) => response as SDKControlInitializeResponse,
    );
    this.initialization.catch(() => undefined);
    this.pumpPrompt(prompt);
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.messages[Symbol.asyncIterator]();
  }

  initializationResult(): Promise<SDKControlInitializeResponse> {
    return this.initialization;
  }

  interrupt(): Promise<void> {
    return this.request({ subtype: "interrupt" }).then(() => undefined);
  }

  stopTask(taskId: string): Promise<void> {
    return this.request({ subtype: "stop_task", task_id: taskId }).then(() => undefined);
  }

  setModel(model?: string): Promise<void> {
    return this.request({ subtype: "set_model", ...(model ? { model } : {}) }).then(
      () => undefined,
    );
  }

  setPermissionMode(mode: PermissionMode): Promise<void> {
    return this.request({ subtype: "set_permission_mode", mode }).then(() => undefined);
  }

  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    return this.request({
      subtype: "set_max_thinking_tokens",
      max_thinking_tokens: maxThinkingTokens,
    }).then(() => undefined);
  }

  getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return this.request({ subtype: "get_context_usage" }).then(
      (response) => response as SDKControlGetContextUsageResponse,
    );
  }

  getSettings(): Promise<Record<string, unknown>> {
    return this.request({ subtype: "get_settings" }).then(
      (response) => response as Record<string, unknown>,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.callbackControllers.values()) controller.abort();
    this.callbackControllers.clear();
    const closeError = new Error("Claude Code query closed before a response was received.");
    for (const pending of this.pendingResponses.values()) pending.reject(closeError);
    this.pendingResponses.clear();
    this.terminateProcess();
    this.messages.end();
  }

  private terminateProcess(): void {
    this.process.stdin.end();
    if (this.process.exitCode === null) {
      this.process.kill("SIGTERM");
      const forceKillSignal = AbortSignal.timeout(PROCESS_TERMINATION_GRACE_MS);
      forceKillSignal.addEventListener("abort", () => {
        if (this.process.exitCode === null) this.process.kill("SIGKILL");
      });
    }
  }

  private async pumpPrompt(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const message of prompt) {
        if (this.closed || this.abortController.signal.aborted) return;
        await this.write(message);
      }
      if (!this.closed) this.process.stdin.end();
    } catch (cause) {
      this.fail(cause);
    }
  }

  private readStdout(): void {
    let buffered = Buffer.alloc(0);
    this.process.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      buffered = Buffer.concat([buffered, chunk]);
      let newline = buffered.indexOf(0x0a);
      while (newline !== -1) {
        if (newline > MAX_CLAUDE_CLI_LINE_BYTES) {
          this.fail(new Error("Claude Code emitted an oversized stream-json message."));
          return;
        }
        const line = buffered.subarray(0, newline).toString("utf8").trim();
        buffered = buffered.subarray(newline + 1);
        if (line) {
          try {
            this.handleWireMessage(JSON.parse(line) as unknown);
          } catch (cause) {
            this.fail(cause);
            return;
          }
        }
        newline = buffered.indexOf(0x0a);
      }
      if (buffered.byteLength > MAX_CLAUDE_CLI_LINE_BYTES) {
        this.fail(new Error("Claude Code emitted an oversized stream-json message."));
      }
    });
    this.process.stdout.once("error", (cause) => this.fail(cause));
  }

  private handleWireMessage(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const typed = message as { readonly type: unknown };
    if (typed.type === "control_response") {
      this.handleControlResponse(decodeControlResponse(message) as ControlResponse);
      return;
    }
    if (typed.type === "control_request") {
      void this.handleControlRequest(decodeControlRequest(message) as ControlRequest);
      return;
    }
    if (typed.type === "control_cancel_request") {
      const cancel = decodeControlCancelRequest(message) as ControlCancelRequest;
      this.callbackControllers.get(cancel.request_id)?.abort();
      this.callbackControllers.delete(cancel.request_id);
      return;
    }
    if (typed.type === "keep_alive") return;
    this.messages.enqueue(message as SDKMessage);
  }

  private handleControlResponse(message: ControlResponse): void {
    const pending = this.pendingResponses.get(message.response.request_id);
    if (!pending) return;
    this.pendingResponses.delete(message.response.request_id);
    if (message.response.subtype === "success") pending.resolve(message.response.response ?? {});
    else pending.reject(new Error(message.response.error));
  }

  private async handleControlRequest(message: ControlRequest): Promise<void> {
    const callbackController = new AbortController();
    this.callbackControllers.set(message.request_id, callbackController);
    try {
      if (message.request.subtype !== "can_use_tool" || !this.options.canUseTool) {
        throw new Error(`Unsupported Claude Code control request: ${message.request.subtype}`);
      }
      const toolName = message.request.tool_name;
      const input = message.request.input;
      const toolUseID = message.request.tool_use_id;
      if (!toolName || !input || !toolUseID) {
        throw new Error("Claude Code sent an invalid can_use_tool request.");
      }
      const result = await this.options.canUseTool(toolName, input, {
        signal: callbackController.signal,
        ...(message.request.permission_suggestions
          ? { suggestions: message.request.permission_suggestions }
          : {}),
        ...(message.request.blocked_path ? { blockedPath: message.request.blocked_path } : {}),
        ...(message.request.decision_reason
          ? { decisionReason: message.request.decision_reason }
          : {}),
        ...(message.request.title ? { title: message.request.title } : {}),
        ...(message.request.display_name ? { displayName: message.request.display_name } : {}),
        ...(message.request.description ? { description: message.request.description } : {}),
        toolUseID,
        ...(message.request.agent_id ? { agentID: message.request.agent_id } : {}),
      });
      await this.write({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: { ...result, toolUseID },
        },
      });
    } catch (cause) {
      if (!this.closed) {
        await this.write({
          type: "control_response",
          response: {
            subtype: "error",
            request_id: message.request_id,
            error: stringifyError(cause),
          },
        }).catch(() => undefined);
      }
    } finally {
      this.callbackControllers.delete(message.request_id);
    }
  }

  private request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutSignal = AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS);
      timeoutSignal.addEventListener("abort", () => {
        const pending = this.pendingResponses.get(requestId);
        if (!pending) return;
        this.pendingResponses.delete(requestId);
        pending.reject(
          new Error(`Claude Code control request timed out: ${String(request.subtype)}`),
        );
      });
      this.pendingResponses.set(requestId, {
        resolve,
        reject,
      });
      this.write({ type: "control_request", request_id: requestId, request }).catch((cause) => {
        const pending = this.pendingResponses.get(requestId);
        this.pendingResponses.delete(requestId);
        pending?.reject(cause instanceof Error ? cause : new Error(stringifyError(cause)));
      });
    });
  }

  private write(value: unknown): Promise<void> {
    const payload = `${JSON.stringify(value)}\n`;
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (this.closed || this.process.stdin.destroyed || this.process.stdin.writableEnded) {
            reject(new Error("Claude Code stdin is closed."));
            return;
          }
          this.process.stdin.write(payload, (cause) => {
            if (cause) reject(cause);
            else resolve();
          });
        }),
    );
    return this.writeChain;
  }

  private fail(cause: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const error = cause instanceof Error ? cause : new Error(stringifyError(cause));
    for (const controller of this.callbackControllers.values()) controller.abort();
    this.callbackControllers.clear();
    for (const pending of this.pendingResponses.values()) pending.reject(error);
    this.pendingResponses.clear();
    this.terminateProcess();
    this.messages.fail(error);
  }
}

export function query(input: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
}): Query {
  return new ClaudeCliQuery(input.prompt, input.options);
}
