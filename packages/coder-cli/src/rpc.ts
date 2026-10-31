import {
  AuthMcpClientAccess,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

// Version 2 makes browser-session request isolation and synchronization
// completion part of the required gateway/helper contract. Version 3 adds the
// hub methods, which let the gateway route T3 tool calls between two
// workspaces it is connected to.
export const CODER_HELPER_PROTOCOL_VERSION = 3;
export const CODER_HELPER_INFO_METHOD = "coder.helper.info";
export const CODER_HUB_OUTBOX_METHOD = "coder.hub.outbox";
export const CODER_HUB_REPLY_METHOD = "coder.hub.reply";
export const CODER_HUB_INVOKE_METHOD = "coder.hub.invoke";

/** One RPC frame between browser, gateway and helper; bounds per-message buffering at each hop. */
export const CODER_RPC_FRAME_MAX_BYTES = 8 * 1024 * 1024;

/** Only the gateway calls these; the browser bridge refuses them. */
export const CODER_HUB_METHODS: ReadonlySet<string> = new Set([
  CODER_HUB_OUTBOX_METHOD,
  CODER_HUB_REPLY_METHOD,
  CODER_HUB_INVOKE_METHOD,
]);

export class CoderHelperProtocolError extends Schema.TaggedError<CoderHelperProtocolError>()(
  "CoderHelperProtocolError",
  {
    message: Schema.String,
    supportedVersion: Schema.Int,
  },
) {}

export const CoderHelperInfo = Schema.Struct({
  protocolVersion: Schema.Int,
  platform: Schema.String,
  architecture: Schema.String,
});
export type CoderHelperInfo = typeof CoderHelperInfo.Type;

export const CoderHelperInfoRpc = Rpc.make(CODER_HELPER_INFO_METHOD, {
  payload: Schema.Struct({
    protocolVersion: Schema.Int,
  }),
  success: CoderHelperInfo,
  error: CoderHelperProtocolError,
});

/** The calling agent's modes; the target workspace caps the call at the narrower of these and the link's access. */
export const CoderHubCallLimits = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type CoderHubCallLimits = typeof CoderHubCallLimits.Type;

/** A link rule as the requesting workspace sees it. */
export const CoderHubLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  access: AuthMcpClientAccess,
  /** Whether the gateway holds a helper connection to that workspace right now. */
  connected: Schema.Boolean,
});
export type CoderHubLink = typeof CoderHubLink.Type;

/**
 * What a helper asks the gateway for. `Call` runs a T3 tool in another
 * workspace; `ListLinks` reads the link rules from this workspace.
 */
export const CoderHubRequest = Schema.Union([
  Schema.TaggedStruct("Call", {
    id: Schema.String,
    environmentId: EnvironmentId,
    tool: Schema.String,
    /** The tool's encoded parameters, without `environmentId`. */
    arguments: Schema.Record(Schema.String, Schema.Unknown),
    limits: CoderHubCallLimits,
  }),
  Schema.TaggedStruct("ListLinks", {
    id: Schema.String,
  }),
]);
export type CoderHubRequest = typeof CoderHubRequest.Type;

/** A tool call's outcome: its encoded success, or the failure the agent sees. */
export const CoderHubCallOutcome = Schema.Union([
  Schema.TaggedStruct("Success", { value: Schema.Unknown }),
  Schema.TaggedStruct("Failure", { failure: OrchestratorMcpFailure }),
]);
export type CoderHubCallOutcome = typeof CoderHubCallOutcome.Type;

export const CoderHubReply = Schema.Union([
  Schema.TaggedStruct("Call", { id: Schema.String, outcome: CoderHubCallOutcome }),
  Schema.TaggedStruct("ListLinks", {
    id: Schema.String,
    links: Schema.Array(CoderHubLink),
  }),
]);
export type CoderHubReply = typeof CoderHubReply.Type;

/**
 * The gateway holds this stream open on every connected helper: each item is
 * a request the helper's agents made of another workspace.
 */
export const CoderHubOutboxRpc = Rpc.make(CODER_HUB_OUTBOX_METHOD, {
  payload: Schema.Struct({}),
  success: CoderHubRequest,
  stream: true,
});

/** The gateway's answer to an outbox request; an unknown id is ignored. */
export const CoderHubReplyRpc = Rpc.make(CODER_HUB_REPLY_METHOD, {
  payload: CoderHubReply,
});

/**
 * Runs a T3 tool here for an agent in another workspace, as that link's
 * caller: what it starts here carries the link as its origin, and it may
 * change only that work unless the link has full access.
 */
export const CoderHubInvokeRpc = Rpc.make(CODER_HUB_INVOKE_METHOD, {
  payload: Schema.Struct({
    link: Schema.Struct({
      /** Stable for the link rule; the origin work started here carries. */
      id: Schema.String,
      /** The requesting workspace's name. */
      label: Schema.String,
      access: AuthMcpClientAccess,
    }),
    tool: Schema.String,
    arguments: Schema.Record(Schema.String, Schema.Unknown),
    limits: CoderHubCallLimits,
  }),
  success: CoderHubCallOutcome,
});

/** The hub methods, served by the workspace runtime that owns the T3 tools. */
export const CoderHubRpcGroup = RpcGroup.make(
  CoderHubOutboxRpc,
  CoderHubReplyRpc,
  CoderHubInvokeRpc,
);

export const CoderHelperInfoRpcGroup = RpcGroup.make(CoderHelperInfoRpc);

export const CoderHelperRpcGroup = CoderHelperInfoRpcGroup.merge(CoderHubRpcGroup);
