import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import {
  CODER_HUB_INVOKE_METHOD,
  CODER_HUB_OUTBOX_METHOD,
  CODER_HUB_REPLY_METHOD,
  CoderHubCallOutcome,
  CoderHubReply,
  CoderHubRequest,
  type CoderHubLink,
} from "@t3tools/coder-cli/rpc";
import { type CoderProfileConfig, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";

/** The first helper protocol that serves the hub methods. */
const HUB_PROTOCOL_VERSION = 3;

const decodeRequest = Schema.decodeUnknownSync(CoderHubRequest);
const decodeOutcome = Schema.decodeUnknownSync(CoderHubCallOutcome);
const encodeReply = Schema.encodeSync(CoderHubReply);

type CallRequest = Extract<CoderHubRequest, { readonly _tag: "Call" }>;
type CallOutcome = CoderHubCallOutcome;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const failed = (code: OrchestratorMcpFailure["code"], message: string): CallOutcome => ({
  _tag: "Failure",
  failure: new OrchestratorMcpFailure({ code, message }),
});

interface Attached {
  readonly workspaceId: string;
  readonly connection: CoderHelperConnection;
  readonly environmentId: string;
  /** Runs when this helper goes away: calls it was asked to run fail, calls it asked for stop. */
  readonly onDetach: Set<() => void>;
}

export interface CoderHub {
  /**
   * Routes this helper's hub requests until the returned function runs. A helper older than
   * protocol 3 is not attached.
   */
  readonly attach: (workspaceId: string, connection: CoderHelperConnection) => () => void;
}

export interface CoderHubOptions {
  /** The gateway's current configuration: link rules and workspace names. */
  readonly config: () => CoderProfileConfig;
}

/**
 * Coder: routes T3 tool calls between two workspace helpers the gateway holds. A helper asks
 * through its `coder.hub.outbox` stream; the gateway checks the workspace link rule, runs the call
 * on the other helper with `coder.hub.invoke` as that link's caller, and answers with
 * `coder.hub.reply`. Both helpers are local `coder ssh` children, so nothing here listens or
 * leaves the laptop; a workspace that is not connected is unreachable.
 */
export function makeCoderHub(options: CoderHubOptions): CoderHub {
  let nextRequestId = 0;
  const attached = new Map<string, Attached>();
  // Learned from each helper this run; never persisted.
  const workspaceByEnvironment = new Map<string, string>();
  const environmentByWorkspace = new Map<string, string>();

  const send = (connection: CoderHelperConnection, message: unknown): void => {
    void Effect.runPromiseExit(connection.sendRpc(message));
  };

  const workspaceName = (workspaceId: string): string =>
    options.config().workspaces.find((entry) => entry.id === workspaceId)?.name ?? workspaceId;

  const reply = (requester: Attached, message: CoderHubReply): void => {
    if (attached.get(requester.workspaceId) !== requester) return;
    send(requester.connection, {
      _tag: "Request",
      id: `gateway-hub:${String(nextRequestId++)}`,
      tag: CODER_HUB_REPLY_METHOD,
      payload: encodeReply(message),
      headers: [],
    });
  };

  /** Runs one call on the target helper and settles with its outcome. */
  const invoke = (
    requester: Attached,
    target: Attached,
    request: CallRequest,
    link: { readonly id: string; readonly label: string; readonly access: string },
  ): Promise<CallOutcome | undefined> => {
    const id = `gateway-hub:${String(nextRequestId++)}`;
    const targetName = workspaceName(target.workspaceId);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: CallOutcome | undefined) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        target.onDetach.delete(onTargetDetach);
        requester.onDetach.delete(onRequesterDetach);
        resolve(outcome);
      };
      const onTargetDetach = () =>
        settle(
          failed(
            "orchestration_error",
            `Workspace ${targetName} disconnected before it answered. Retry once it is connected again.`,
          ),
        );
      // The requester is gone, so nobody reads the answer: stop the call there.
      const onRequesterDetach = () => {
        send(target.connection, { _tag: "Interrupt", requestId: id });
        settle(undefined);
      };
      const unsubscribe = target.connection.onRpcMessage((message) => {
        if (!isRecord(message) || message.requestId !== id || message._tag !== "Exit") return;
        const exit = message.exit;
        if (isRecord(exit) && exit._tag === "Success") {
          try {
            settle(decodeOutcome(exit.value));
            return;
          } catch {
            // Falls through to the failure below.
          }
        }
        settle(
          failed("orchestration_error", `Workspace ${targetName} could not run ${request.tool}.`),
        );
      });
      target.onDetach.add(onTargetDetach);
      requester.onDetach.add(onRequesterDetach);
      void Effect.runPromiseExit(
        target.connection.sendRpc({
          _tag: "Request",
          id,
          tag: CODER_HUB_INVOKE_METHOD,
          payload: {
            link,
            tool: request.tool,
            arguments: request.arguments,
            limits: request.limits,
          },
          headers: [],
        }),
      ).then((exit) => {
        if (exit._tag === "Failure") onTargetDetach();
      });
    });
  };

  const handleCall = async (requester: Attached, request: CallRequest): Promise<void> => {
    const config = options.config();
    const targetWorkspaceId = workspaceByEnvironment.get(request.environmentId);
    const rule =
      targetWorkspaceId === undefined
        ? undefined
        : config.workspaceLinks?.find(
            (entry) => entry.from === requester.workspaceId && entry.to === targetWorkspaceId,
          );
    let outcome: CallOutcome | undefined;
    if (
      targetWorkspaceId === undefined &&
      (config.workspaceLinks ?? []).some(
        (entry) => entry.from === requester.workspaceId && !environmentByWorkspace.has(entry.to),
      )
    ) {
      // A linked workspace that has not connected since the gateway started has no known
      // environment id yet; it may be the target, so the caller retries instead of failing.
      outcome = failed(
        "orchestration_error",
        "That workspace has not connected to T3 Coder yet. Retry once it is connected.",
      );
    } else if (targetWorkspaceId === undefined || rule === undefined) {
      outcome = failed(
        "capability_denied",
        "This workspace is not linked to that one. Add a link in T3 Coder's workspace Links settings.",
      );
    } else {
      const target = attached.get(targetWorkspaceId);
      if (target === undefined) {
        outcome = failed(
          "orchestration_error",
          `Workspace ${workspaceName(targetWorkspaceId)} is not connected.`,
        );
      } else {
        outcome = await invoke(requester, target, request, {
          id: rule.id,
          label: workspaceName(requester.workspaceId),
          access: rule.access,
        });
      }
    }
    if (outcome === undefined) return;
    reply(requester, {
      _tag: "Call",
      id: request.id,
      outcome,
    });
  };

  const listLinks = (requester: Attached): ReadonlyArray<CoderHubLink> =>
    (options.config().workspaceLinks ?? []).flatMap((rule) => {
      if (rule.from !== requester.workspaceId) return [];
      const environmentId = environmentByWorkspace.get(rule.to);
      if (environmentId === undefined) return [];
      return [
        {
          environmentId: environmentId as CoderHubLink["environmentId"],
          label: workspaceName(rule.to),
          access: rule.access,
          connected: attached.has(rule.to),
        },
      ];
    });

  const attach: CoderHub["attach"] = (workspaceId, connection) => {
    if (connection.info.protocolVersion < HUB_PROTOCOL_VERSION) return () => {};
    const environmentId = connection.info.environment.environmentId;
    const previous = attached.get(workspaceId);
    if (previous !== undefined) detach(previous);
    const entry: Attached = { workspaceId, connection, environmentId, onDetach: new Set() };
    attached.set(workspaceId, entry);
    const staleWorkspace = workspaceByEnvironment.get(environmentId);
    if (staleWorkspace !== undefined && staleWorkspace !== workspaceId) {
      environmentByWorkspace.delete(staleWorkspace);
    }
    workspaceByEnvironment.set(environmentId, workspaceId);
    environmentByWorkspace.set(workspaceId, environmentId);

    const outboxId = `gateway-hub:${String(nextRequestId++)}`;
    const unsubscribe = connection.onRpcMessage((message) => {
      if (!isRecord(message) || message.requestId !== outboxId) return;
      if (message._tag !== "Chunk" || !Array.isArray(message.values)) return;
      for (const value of message.values) {
        let request: CoderHubRequest;
        try {
          request = decodeRequest(value);
        } catch {
          // Answer what can be answered, so the caller fails now rather than at its timeout.
          if (isRecord(value) && typeof value.id === "string") {
            reply(entry, {
              _tag: "Call",
              id: value.id,
              outcome: failed(
                "orchestration_error",
                "T3 Coder's gateway could not read this request. Reconnect the workspace so its helper matches the gateway.",
              ),
            });
          }
          continue;
        }
        if (request._tag === "ListLinks") {
          reply(entry, { _tag: "ListLinks", id: request.id, links: listLinks(entry) });
        } else {
          void handleCall(entry, request);
        }
      }
      send(connection, { _tag: "Ack", requestId: outboxId });
    });
    // A helper that exits takes its outbox with it.
    const closed = Effect.runFork(connection.closed);
    closed.addObserver(() => detach(entry));
    entry.onDetach.add(() => {
      unsubscribe();
      Effect.runFork(Fiber.interrupt(closed));
    });
    send(connection, {
      _tag: "Request",
      id: outboxId,
      tag: CODER_HUB_OUTBOX_METHOD,
      payload: {},
      headers: [],
    });
    return () => detach(entry);
  };

  function detach(entry: Attached): void {
    if (attached.get(entry.workspaceId) !== entry) return;
    attached.delete(entry.workspaceId);
    for (const callback of [...entry.onDetach]) callback();
    entry.onDetach.clear();
  }

  return { attach };
}
