import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

import type { CoderHelperConnection } from "@t3tools/coder-cli/helperConnection";
import type { CoderPortForwardConnection } from "@t3tools/coder-cli/portForward";
import type { WorkspaceAction } from "./coderCommands.ts";
import type { WorkspaceRpcBridge } from "./rpcBridge.ts";

/** The gateway's fiber-set runners (`FiberSet.runtimePromise` and `FiberSet.runtime`). */
export type RunPromise = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
export type RunFork = <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;

export class WorkspaceActionConflictError extends Error {}

export interface DeferredPromise<A> {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
  readonly reject: (cause: unknown) => void;
}

export function makeDeferredPromise<A>(): DeferredPromise<A> {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export type WorkspaceLifecycleState =
  | {
      readonly _tag: "ShutdownFailed";
      readonly generation: number;
      readonly connection: CoderHelperConnection;
      readonly scope: Scope.Closeable;
      readonly error: string;
    }
  | { readonly _tag: "Disconnected"; readonly generation: number }
  | {
      readonly _tag: "Connecting";
      readonly generation: number;
      readonly operation: Promise<WorkspaceConnection>;
      // Interrupts the attempt, killing its `coder ssh` child, so a close need not wait for it.
      readonly cancel: AbortController;
    }
  | {
      readonly _tag: "Connected";
      readonly generation: number;
      readonly connection: CoderHelperConnection;
      readonly rpcBridge: WorkspaceRpcBridge;
      readonly scope: Scope.Closeable;
    }
  | {
      readonly _tag: "Changing";
      readonly generation: number;
      readonly action: WorkspaceAction;
      readonly operation: Promise<void>;
      // Acquisition cleanup can fail while this operation is waiting for it.
      readonly shutdownFailure?:
        | Extract<WorkspaceLifecycleState, { _tag: "ShutdownFailed" }>
        | undefined;
    };

export type PortForwardLifecycleState =
  | {
      readonly _tag: "ShutdownFailed";
      readonly generation: number;
      readonly connection: CoderPortForwardConnection;
      readonly scope: Scope.Closeable;
      readonly error: string;
    }
  | { readonly _tag: "Idle"; readonly generation: number }
  | { readonly _tag: "WorkspaceStopped"; readonly generation: number }
  | {
      readonly _tag: "Starting";
      readonly generation: number;
      readonly operation: Promise<CoderPortForwardConnection>;
    }
  | {
      readonly _tag: "Running";
      readonly generation: number;
      readonly connection: CoderPortForwardConnection;
      readonly scope: Scope.Closeable;
    }
  | {
      readonly _tag: "Stopping";
      readonly generation: number;
      readonly operation: Promise<void>;
      // Acquisition cleanup can fail while this operation is waiting for it.
      readonly shutdownFailure?:
        | Extract<PortForwardLifecycleState, { _tag: "ShutdownFailed" }>
        | undefined;
    }
  | { readonly _tag: "Failed"; readonly generation: number; readonly error: string };

export type WorkspaceConnectionClaim =
  | { readonly _tag: "ShutdownFailed"; readonly error: string }
  | { readonly _tag: "Existing"; readonly connection: WorkspaceConnection }
  | { readonly _tag: "Pending"; readonly operation: Promise<WorkspaceConnection> }
  | { readonly _tag: "Changing"; readonly operation: Promise<void> }
  | { readonly _tag: "Start"; readonly generation: number };

export type WorkspaceCloseClaim =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Changing"; readonly operation: Promise<void> }
  | {
      readonly _tag: "Close";
      readonly pending: Promise<WorkspaceConnection> | undefined;
      readonly cancel: AbortController | undefined;
      readonly scope: Scope.Closeable | undefined;
      readonly previous:
        | Extract<WorkspaceLifecycleState, { _tag: "Connected" | "ShutdownFailed" }>
        | undefined;
    };

export type PortForwardStartClaim =
  | { readonly _tag: "ShutdownFailed"; readonly error: string }
  | { readonly _tag: "Existing"; readonly connection: CoderPortForwardConnection }
  | { readonly _tag: "Pending"; readonly operation: Promise<CoderPortForwardConnection> }
  | { readonly _tag: "Stopping"; readonly operation: Promise<void> }
  | { readonly _tag: "Start"; readonly generation: number };

export type PortForwardStopClaim =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "Pending"; readonly operation: Promise<void> }
  | {
      readonly _tag: "Stop";
      readonly pending: Promise<CoderPortForwardConnection> | undefined;
      readonly scope: Scope.Closeable | undefined;
      readonly previous:
        | Extract<PortForwardLifecycleState, { _tag: "Running" | "ShutdownFailed" }>
        | undefined;
    };

export type WorkspaceActionClaim =
  | { readonly _tag: "Pending"; readonly operation: Promise<void> }
  | { readonly _tag: "Conflict"; readonly action: WorkspaceAction }
  | {
      readonly _tag: "Start";
      readonly pending: Promise<WorkspaceConnection> | undefined;
      readonly cancel: AbortController | undefined;
      readonly scope: Scope.Closeable | undefined;
      readonly previous:
        | Extract<WorkspaceLifecycleState, { _tag: "Connected" | "ShutdownFailed" }>
        | undefined;
    };

export interface WorkspaceConnection {
  readonly connection: CoderHelperConnection;
  readonly rpcBridge: WorkspaceRpcBridge;
}
