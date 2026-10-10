// @effect-diagnostics nodeBuiltinImport:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import type * as Sdk from "@anthropic-ai/claude-agent-sdk";
import * as Schema from "effect/Schema";

// Coder: the CLI transport speaks the Agent SDK's wire protocol, so it uses the SDK's own types.
// The SDK is a type-only dependency; nothing from it is loaded at runtime.
export type PermissionMode = Sdk.PermissionMode;
export type SettingSource = Sdk.SettingSource;
export type SDKRateLimitInfo = Sdk.SDKRateLimitInfo;
export type PermissionUpdateDestination = Sdk.PermissionUpdateDestination;
export type PermissionUpdate = Sdk.PermissionUpdate;
export type PermissionResult = Sdk.PermissionResult;
export type CanUseTool = Sdk.CanUseTool;
export type ModelUsage = Sdk.ModelUsage;
export type SDKUserMessage = Sdk.SDKUserMessage;
export type SDKResultMessage = Sdk.SDKResultMessage;
export type SDKMessage = Sdk.SDKMessage;
export type SlashCommand = Sdk.SlashCommand;
export type ModelInfo = Sdk.ModelInfo;
export type SDKControlInitializeResponse = Sdk.SDKControlInitializeResponse;
export type SDKControlGetContextUsageResponse = Sdk.SDKControlGetContextUsageResponse;
export type UserDialogRequest = Sdk.UserDialogRequest;
export type UserDialogResult = Sdk.UserDialogResult;

const ClaudeUsageWindow = Schema.Struct({
  utilization: Schema.NullOr(Schema.Number),
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsageResponse = Schema.Struct({
  rate_limits_available: Schema.Boolean,
  rate_limits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        five_hour: Schema.optional(Schema.NullOr(ClaudeUsageWindow)),
        seven_day: Schema.optional(Schema.NullOr(ClaudeUsageWindow)),
        model_scoped: Schema.optional(
          Schema.Array(
            Schema.Struct({
              ...ClaudeUsageWindow.fields,
              display_name: Schema.String,
            }),
          ),
        ),
      }),
    ),
  ),
});
export type SDKControlGetUsageResponse = typeof ClaudeUsageResponse.Type;
export type Options = {
  readonly abortController?: AbortController;
  readonly additionalDirectories?: ReadonlyArray<string>;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly canUseTool?: CanUseTool;
  readonly cwd?: string;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly env?: NodeJS.ProcessEnv;
  readonly includePartialMessages?: boolean;
  readonly thinking?: { readonly type: "adaptive"; readonly display: "summarized" };
  readonly model?: string;
  /** External MCP server configurations, passed as `--mcp-config` as the SDK does. */
  readonly mcpServers?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly strictMcpConfig?: boolean;
  readonly onUserDialog?: NonNullable<Sdk.Options["onUserDialog"]>;
  readonly pathToClaudeCodeExecutable: string;
  /** Arguments before the CLI's own, as the SDK passes them to a native executable. */
  readonly executableArgs?: ReadonlyArray<string>;
  readonly permissionMode?: PermissionMode;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly persistSession?: boolean;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly forkSession?: boolean;
  readonly sessionId?: string;
  readonly settingSources?: ReadonlyArray<SettingSource>;
  /** Settings object, or a settings file path passed through as the SDK does. */
  readonly settings?: Record<string, unknown> | string;
  readonly disallowedTools?: ReadonlyArray<string>;
  /** Tool availability: explicit tool names, or Claude Code's default preset. */
  readonly tools?:
    | ReadonlyArray<string>
    | { readonly type: "preset"; readonly preset: "claude_code" };
  /** CLI flags from the workspace launch-args setting; `null` is a flag without a value. */
  readonly extraArgs?: Readonly<Record<string, string | null>>;
  readonly supportedDialogKinds?: ReadonlyArray<string>;
  readonly systemPrompt?: {
    readonly type: "preset";
    readonly preset: "claude_code";
    readonly append?: string;
  };
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
    readonly dialog_kind?: string;
    readonly payload?: Record<string, unknown>;
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
    dialog_kind: Schema.optional(Schema.String),
    payload: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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

// Coder: upstream's Agent SDK reads lines without a cap. One line may carry a tool_result image
// up to the provider's 10 MiB base64 limit, so a line may use the whole pending-message budget.
const MAX_PENDING_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_CLAUDE_CLI_LINE_BYTES = MAX_PENDING_MESSAGE_BYTES;

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<{ value: T; bytes: number }> = [];
  private queuedBytes = 0;
  private readonly pause: () => void;
  private readonly resume: () => void;
  constructor(pause: () => void, resume: () => void) {
    this.pause = pause;
    this.resume = resume;
  }
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
    else {
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (this.queuedBytes + bytes > MAX_PENDING_MESSAGE_BYTES)
        throw new Error("Claude Code output exceeded the pending message budget.");
      this.values.push({ value, bytes });
      this.queuedBytes += bytes;
      if (this.queuedBytes >= 1024 * 1024 || this.values.length >= 256) this.pause();
    }
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
        const entry = this.values.shift();
        if (entry !== undefined) {
          this.queuedBytes -= entry.bytes;
          if (this.queuedBytes < 512 * 1024 && this.values.length < 128) this.resume();
          return Promise.resolve({ done: false, value: entry.value });
        }
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
  /** `skipBehaviors` skips the CLI's local transcript scan, as the SDK's usage request does. */
  getUsage(
    options?: { readonly skipBehaviors?: boolean },
    timeoutMs?: number,
  ): Promise<SDKControlGetUsageResponse>;
  interrupt(): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  getContextUsage(): Promise<SDKControlGetContextUsageResponse>;
  getSettings(timeoutMs?: number): Promise<Record<string, unknown>>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  close(): void;
}

const CONTROL_REQUEST_TIMEOUT_MS = 60_000;
// Coder: launch args may add CLI flags but never the stream-json transport flags this
// driver depends on.
const RESERVED_CLAUDE_CLI_FLAGS: ReadonlySet<string> = new Set([
  "output-format",
  "input-format",
  "print",
  "permission-prompt-tool",
]);
const PROCESS_TERMINATION_GRACE_MS = 5_000;

function stringifyError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function buildClaudeCliArgs(options: Options): Array<string> {
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--print",
  ];

  if (options.effort) args.push("--effort", options.effort);
  if (options.model) args.push("--model", options.model);
  if (options.canUseTool) args.push("--permission-prompt-tool", "stdio");
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.disallowedTools.join(","));
  }
  if (options.tools !== undefined) {
    args.push(
      "--tools",
      "type" in options.tools ? "default" : (options.tools as ReadonlyArray<string>).join(","),
    );
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: options.mcpServers }));
  }
  if (options.settingSources) args.push(`--setting-sources=${options.settingSources.join(",")}`);
  if (options.strictMcpConfig) args.push("--strict-mcp-config");
  if (options.permissionMode) args.push("--permission-mode", options.permissionMode);
  if (options.allowDangerouslySkipPermissions) {
    args.push("--allow-dangerously-skip-permissions");
  }
  if (options.includePartialMessages) args.push("--include-partial-messages");
  if (options.thinking?.display === "summarized") args.push("--thinking-display", "summarized");
  for (const directory of options.additionalDirectories ?? []) args.push("--add-dir", directory);
  if (options.resume) args.push("--resume", options.resume);
  if (options.forkSession) args.push("--fork-session");
  if (options.resumeSessionAt) args.push("--resume-session-at", options.resumeSessionAt);
  if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.persistSession === false) args.push("--no-session-persistence");
  if (options.settings) {
    args.push(
      "--settings",
      typeof options.settings === "string" ? options.settings : JSON.stringify(options.settings),
    );
  }
  for (const [flag, value] of Object.entries(options.extraArgs ?? {})) {
    if (RESERVED_CLAUDE_CLI_FLAGS.has(flag)) continue;
    if (flag === "thinking-display" && options.thinking) continue;
    args.push(`--${flag}`, ...(value === null ? [] : [value]));
  }

  return args;
}

class ClaudeCliQuery implements Query {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly messages = new AsyncMessageQueue<SDKMessage>(
    () => {
      if (this.pendingResponses.size === 0) this.process.stdout.pause();
    },
    () => this.process.stdout.resume(),
  );
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
    const environment: NodeJS.ProcessEnv = { ...options.env };
    if (!environment.CLAUDE_CODE_ENTRYPOINT) {
      environment.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
    }
    this.process = spawn(
      options.pathToClaudeCodeExecutable,
      [...(options.executableArgs ?? []), ...buildClaudeCliArgs(options)],
      {
        cwd: options.cwd,
        env: environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (data: string) => {
      this.stderrTail = `${this.stderrTail}${data}`.slice(-8_192);
      options.stderr?.(data);
    });

    this.process.once("error", (cause) => this.fail(cause));
    this.process.once("close", (code, signal) => {
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
    this.initialization = this.request({
      subtype: "initialize",
      hooks: {},
      ...(options.systemPrompt?.append ? { appendSystemPrompt: options.systemPrompt.append } : {}),
      ...(options.supportedDialogKinds
        ? { supportedDialogKinds: options.supportedDialogKinds }
        : {}),
    }).then((response) => response as SDKControlInitializeResponse);
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

  getSettings(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.request({ subtype: "get_settings" }, timeoutMs).then(
      (response) => response as Record<string, unknown>,
    );
  }

  getUsage(
    options?: { readonly skipBehaviors?: boolean },
    timeoutMs?: number,
  ): Promise<SDKControlGetUsageResponse> {
    return this.request(
      { subtype: "get_usage", ...(options?.skipBehaviors ? { skip_behaviors: true } : {}) },
      timeoutMs,
    ).then((response) => Schema.decodeUnknownSync(ClaudeUsageResponse)(response));
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
    // Buffer a partial line as chunks and scan only new bytes, so a large line costs linear time.
    let partial: Buffer[] = [];
    let partialBytes = 0;
    this.process.stdout.on("data", (chunk: Buffer) => {
      if (this.closed) return;
      let start = 0;
      let newline = chunk.indexOf(0x0a);
      while (newline !== -1) {
        if (partialBytes + newline - start > MAX_CLAUDE_CLI_LINE_BYTES) {
          this.fail(new Error("Claude Code emitted an oversized stream-json message."));
          return;
        }
        const bytes = Buffer.concat([...partial, chunk.subarray(start, newline)]);
        partial = [];
        partialBytes = 0;
        start = newline + 1;
        const line = bytes.toString("utf8").trim();
        if (line) {
          try {
            this.handleWireMessage(JSON.parse(line) as unknown);
          } catch (cause) {
            // Workspace-managed Claude launchers may print a short status
            // preamble before exec'ing the stream-json CLI. Ignore plain text,
            // but retain strict handling for malformed JSON protocol frames.
            if (line.startsWith("{") || line.startsWith("[")) {
              this.fail(cause);
              return;
            }
          }
        }
        newline = chunk.indexOf(0x0a, start);
      }
      if (start < chunk.byteLength) {
        partial.push(chunk.subarray(start));
        partialBytes += chunk.byteLength - start;
      }
      if (partialBytes > MAX_CLAUDE_CLI_LINE_BYTES) {
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
      if (message.request.subtype === "request_user_dialog" && this.options.onUserDialog) {
        const dialogKind = message.request.dialog_kind;
        const payload = message.request.payload;
        if (!dialogKind || !payload) {
          throw new Error("Claude Code sent an invalid request_user_dialog request.");
        }
        const result = await this.options.onUserDialog(
          {
            dialogKind,
            payload,
            ...(message.request.tool_use_id ? { toolUseID: message.request.tool_use_id } : {}),
          },
          { signal: callbackController.signal, requestId: message.request_id },
        );
        await this.write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: message.request_id,
            response: result,
          },
        });
        return;
      }
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
          ? { suggestions: [...message.request.permission_suggestions] }
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
        requestId: message.request_id,
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

  private request(
    request: Record<string, unknown>,
    timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    this.process.stdout.resume();
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
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
