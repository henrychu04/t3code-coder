/**
 * Coder: the Agent SDK entry points T3 uses, backed by the workspace `claude` CLI.
 *
 * `@anthropic-ai/claude-agent-sdk` is a type-only dependency. Its package installs a bundled
 * Claude Code binary, so T3 Coder never loads it at runtime. These functions take and return the
 * SDK's own types so upstream adapter code changes only its import source.
 *
 * Not provided: `forkSession` (forks run natively through the CLI when the forked session first
 * starts), session stores, and control requests the CLI transport does not implement, which fail
 * with a clear error instead of being silently ignored.
 *
 * @module provider/Drivers/ClaudeAgentSdk
 */
// @effect-diagnostics nodeBuiltinImport:off -- Reads the workspace-owned Claude transcript store.
import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import * as Path from "node:path";

import type * as Sdk from "@anthropic-ai/claude-agent-sdk";

import * as Cli from "./ClaudeCli.ts";

const SUPPORTED_QUERY_OPTIONS: ReadonlySet<string> = new Set([
  "abortController",
  "additionalDirectories",
  "allowDangerouslySkipPermissions",
  "allowedTools",
  "canUseTool",
  "cwd",
  "disallowedTools",
  "effort",
  "env",
  "executableArgs",
  "extraArgs",
  "forkSession",
  "includePartialMessages",
  "mcpServers",
  "model",
  "onUserDialog",
  "pathToClaudeCodeExecutable",
  "permissionMode",
  "persistSession",
  "resume",
  "resumeSessionAt",
  "sessionId",
  "settingSources",
  "settings",
  "stderr",
  "strictMcpConfig",
  "supportedDialogKinds",
  "systemPrompt",
  "thinking",
  "tools",
]);

const unsupported = (feature: string): Error =>
  new Error(`Claude ${feature} is not available through T3 Coder's CLI transport.`);

/** SDK query options as CLI transport options; exported for tests. */
export function toClaudeCliOptions(options: Sdk.Options): Cli.Options {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || SUPPORTED_QUERY_OPTIONS.has(key)) {
      continue;
    }
    throw unsupported(`query option '${key}'`);
  }
  const systemPrompt = options.systemPrompt;
  if (
    systemPrompt !== undefined &&
    (typeof systemPrompt === "string" ||
      Array.isArray(systemPrompt) ||
      systemPrompt.type !== "preset")
  ) {
    throw unsupported("custom system prompt");
  }
  const thinking = options.thinking;
  if (
    thinking !== undefined &&
    (thinking.type !== "adaptive" || thinking.display !== "summarized")
  ) {
    throw unsupported(`thinking configuration '${thinking.type}'`);
  }
  for (const [name, server] of Object.entries(options.mcpServers ?? {})) {
    if (server.type === "sdk") throw unsupported(`in-process MCP server '${name}'`);
  }
  if (options.pathToClaudeCodeExecutable === undefined) {
    throw unsupported("query without a workspace Claude executable");
  }
  return {
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    env: options.env ?? process.env,
    ...(options.abortController ? { abortController: options.abortController } : {}),
    ...(options.additionalDirectories
      ? { additionalDirectories: options.additionalDirectories }
      : {}),
    ...(options.allowDangerouslySkipPermissions ? { allowDangerouslySkipPermissions: true } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
    ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.disallowedTools ? { disallowedTools: options.disallowedTools } : {}),
    ...(options.effort ? { effort: options.effort as NonNullable<Cli.Options["effort"]> } : {}),
    ...(options.executableArgs?.length ? { executableArgs: options.executableArgs } : {}),
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    ...(options.forkSession ? { forkSession: true } : {}),
    ...(options.includePartialMessages ? { includePartialMessages: true } : {}),
    ...(options.mcpServers
      ? {
          mcpServers: options.mcpServers as Readonly<
            Record<string, Readonly<Record<string, unknown>>>
          >,
        }
      : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.onUserDialog ? { onUserDialog: options.onUserDialog } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
    ...(options.persistSession === false ? { persistSession: false } : {}),
    ...(options.resume ? { resume: options.resume } : {}),
    ...(options.resumeSessionAt ? { resumeSessionAt: options.resumeSessionAt } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.settingSources ? { settingSources: options.settingSources } : {}),
    ...(options.settings ? { settings: options.settings as Record<string, unknown> | string } : {}),
    ...(options.stderr ? { stderr: options.stderr } : {}),
    ...(options.strictMcpConfig ? { strictMcpConfig: true } : {}),
    ...(options.supportedDialogKinds ? { supportedDialogKinds: options.supportedDialogKinds } : {}),
    ...(systemPrompt
      ? {
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            ...(systemPrompt.append ? { append: systemPrompt.append } : {}),
          },
        }
      : {}),
    ...(thinking
      ? { thinking: { type: "adaptive" as const, display: "summarized" as const } }
      : {}),
    ...(options.tools
      ? {
          tools: Array.isArray(options.tools)
            ? options.tools
            : { type: "preset" as const, preset: "claude_code" as const },
        }
      : {}),
  };
}

async function* singlePrompt(prompt: string): AsyncGenerator<Cli.SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: prompt },
  };
}

function toSdkQuery(cli: Cli.Query): Sdk.Query {
  async function* messages(): AsyncGenerator<Sdk.SDKMessage, void> {
    for await (const message of cli) yield message;
  }
  const initialization = () => cli.initializationResult();
  const reject = (feature: string) => () => Promise.reject(unsupported(feature));
  const query: Omit<Sdk.Query, keyof AsyncGenerator<Sdk.SDKMessage, void>> = {
    interrupt: () => cli.interrupt().then(() => undefined),
    setPermissionMode: (mode) => cli.setPermissionMode(mode as Cli.PermissionMode),
    setModel: (model) => cli.setModel(model),
    setMaxThinkingTokens: (maxThinkingTokens) => cli.setMaxThinkingTokens(maxThinkingTokens),
    initializationResult: initialization,
    supportedCommands: () => initialization().then((result) => result.commands),
    supportedModels: () => initialization().then((result) => result.models),
    supportedAgents: () => initialization().then((result) => result.agents),
    accountInfo: () => initialization().then((result) => result.account),
    getContextUsage: () => cli.getContextUsage(),
    stopTask: (taskId) => cli.stopTask(taskId),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (options) =>
      cli.getUsage(options) as unknown as ReturnType<
        Sdk.Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]
      >,
    close: () => cli.close(),
    setMcpPermissionModeOverride: reject("MCP permission overrides"),
    applyFlagSettings: reject("flag settings"),
    updateSettings: reject("settings updates"),
    reinitialize: reject("reinitialize"),
    mcpServerStatus: reject("MCP server status"),
    reconnectMcpServer: reject("MCP reconnects"),
    toggleMcpServer: reject("MCP toggles"),
    setMcpServers: reject("MCP servers"),
    rewindFiles: reject("file rewinds"),
    seedReadState: reject("read-state seeding"),
    readFile: reject("file reads"),
    reloadOutputStyles: reject("output style reloads"),
    reloadPlugins: reject("plugin reloads"),
    reloadSkills: reject("skill reloads"),
    backgroundTasks: reject("background task listing"),
    streamInput: reject("stream input after start"),
  };
  return Object.assign(messages(), query) as Sdk.Query;
}

/** SDK-compatible `query`, run through the workspace `claude` executable. */
export function query(input: {
  readonly prompt: string | AsyncIterable<Sdk.SDKUserMessage>;
  readonly options?: Sdk.Options;
}): Sdk.Query {
  const prompt = typeof input.prompt === "string" ? singlePrompt(input.prompt) : input.prompt;
  return toSdkQuery(Cli.query({ prompt, options: toClaudeCliOptions(input.options ?? {}) }));
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_ID = /^[\w-]{1,128}$/;
const TOOL_USE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_DIR_NAME_LENGTH = 200;
const MAX_SUBAGENT_DIRECTORY_DEPTH = 8;

function claudeProjectsRoot(): string {
  return Path.join(process.env.CLAUDE_CONFIG_DIR ?? Path.join(homedir(), ".claude"), "projects");
}

function stringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Claude Code's project directory name for a working directory. */
export function claudeProjectDirectoryName(cwd: string): string {
  const sanitized = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return sanitized.length <= MAX_PROJECT_DIR_NAME_LENGTH
    ? sanitized
    : `${sanitized.slice(0, MAX_PROJECT_DIR_NAME_LENGTH)}-${Math.abs(stringHash(cwd)).toString(36)}`;
}

async function readBoundedFile(path: string): Promise<string | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_TRANSCRIPT_BYTES) return null;
    return await file.readFile({ encoding: "utf8" });
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function findSessionTranscriptPath(
  sessionId: string,
  dir: string | undefined,
): Promise<string | null> {
  const root = claudeProjectsRoot();
  const candidates: string[] = [];
  if (dir !== undefined) {
    const resolved = await realpath(Path.resolve(dir)).catch(() => Path.resolve(dir));
    candidates.push(claudeProjectDirectoryName(resolved.normalize("NFC")));
  } else {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    candidates.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  }
  for (const projectDirectory of candidates) {
    const path = Path.join(root, projectDirectory, `${sessionId}.jsonl`);
    const transcript = await readBoundedFile(path);
    if (transcript !== null && transcript.length > 0) return path;
  }
  return null;
}

async function findSubagentTranscriptPath(
  directory: string,
  agentId: string,
  depth = 0,
): Promise<string | null> {
  if (depth > MAX_SUBAGENT_DIRECTORY_DEPTH) return null;
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() && entry.name === `agent-${agentId}.jsonl`) {
      return Path.join(directory, entry.name);
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findSubagentTranscriptPath(
      Path.join(directory, entry.name),
      agentId,
      depth + 1,
    );
    if (found !== null) return found;
  }
  return null;
}

type TranscriptEntry = Record<string, unknown> & {
  readonly type: "user" | "assistant" | "attachment";
  readonly uuid: string;
  readonly parentUuid?: string | null;
};

function parseConversationChain(transcript: string): ReadonlyArray<TranscriptEntry> {
  const entries: TranscriptEntry[] = [];
  for (const line of transcript.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        (entry.type === "user" || entry.type === "assistant" || entry.type === "attachment") &&
        typeof entry.uuid === "string"
      ) {
        entries.push(entry as TranscriptEntry);
      }
    } catch {
      // Claude Code skips unparseable transcript lines; so does the SDK.
    }
  }
  const byUuid = new Map(entries.map((entry) => [entry.uuid, entry]));
  const leaf = entries.findLast((entry) => entry.type === "user" || entry.type === "assistant");
  const chain: TranscriptEntry[] = [];
  const seen = new Set<string>();
  for (let entry = leaf; entry && !seen.has(entry.uuid);) {
    seen.add(entry.uuid);
    chain.push(entry);
    entry = typeof entry.parentUuid === "string" ? byUuid.get(entry.parentUuid) : undefined;
  }
  return chain.reverse();
}

/**
 * SDK-compatible `getSubagentMessages`: a subagent's user and assistant messages along its
 * conversation chain, read-only from the workspace Claude transcript store.
 */
export async function getSubagentMessages(
  sessionId: string,
  agentId: string,
  options?: Sdk.GetSubagentMessagesOptions,
): Promise<Sdk.SessionMessage[]> {
  if (options?.sessionStore !== undefined) throw unsupported("session stores");
  if (!SESSION_ID.test(sessionId) || !AGENT_ID.test(agentId)) return [];
  const sessionPath = await findSessionTranscriptPath(sessionId, options?.dir);
  if (sessionPath === null) return [];
  const transcriptPath = await findSubagentTranscriptPath(
    Path.join(sessionPath.replace(/\.jsonl$/, ""), "subagents"),
    agentId,
  );
  if (transcriptPath === null) return [];
  const transcript = await readBoundedFile(transcriptPath);
  if (transcript === null) return [];
  let toolUseId: string | undefined;
  let parentAgentId: string | undefined;
  try {
    const metadata = JSON.parse(
      (await readBoundedFile(transcriptPath.replace(/\.jsonl$/, ".meta.json"))) ?? "",
    ) as Record<string, unknown>;
    if (typeof metadata.toolUseId === "string" && TOOL_USE_ID.test(metadata.toolUseId)) {
      toolUseId = metadata.toolUseId;
    }
    if (typeof metadata.parentAgentId === "string" && AGENT_ID.test(metadata.parentAgentId)) {
      parentAgentId = metadata.parentAgentId;
    }
  } catch {
    // A missing or unreadable sidecar leaves the parent links unknown, as in the SDK.
  }
  const messages = parseConversationChain(transcript)
    .filter((entry) => entry.type === "user" || entry.type === "assistant")
    .map((entry): Sdk.SessionMessage => ({
      type: entry.type as "user" | "assistant",
      uuid: entry.uuid,
      session_id: typeof entry.sessionId === "string" ? entry.sessionId : sessionId,
      message: entry.message,
      parent_tool_use_id: toolUseId ?? null,
      parent_agent_id: parentAgentId ?? null,
    }));
  const offset = options?.offset ?? 0;
  if (options?.limit !== undefined && options.limit > 0) {
    return messages.slice(offset, offset + options.limit);
  }
  return offset > 0 ? messages.slice(offset) : messages;
}
