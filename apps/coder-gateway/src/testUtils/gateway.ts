import { CoderHelperConnectionError } from "@t3tools/coder-cli/helperConnection";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import type { CoderHelperConnection, CoderHelperExit } from "@t3tools/coder-cli/helperConnection";
import type { CoderPortForwardExit } from "@t3tools/coder-cli/portForward";
import { makeLocalCoderGateway, type LocalCoderGatewayEffectOptions } from "../server.ts";

export interface PromiseCoderHelperConnection {
  readonly info: CoderHelperConnection["info"];
  readonly closed: Promise<CoderHelperExit>;
  readonly sendRpc: (message: unknown) => void;
  readonly onRpcMessage: CoderHelperConnection["onRpcMessage"];
  readonly close: () => void;
}
interface PromisePortForwardConnection {
  readonly closed: Promise<CoderPortForwardExit>;
  readonly close: () => void;
}
type PromiseOption<T> = T extends (
  ...args: infer Args
) => Effect.Effect<infer A, infer _E, infer _R>
  ? (...args: Args) => Promise<A>
  : T;
type Options = Omit<
  { [K in keyof LocalCoderGatewayEffectOptions]: PromiseOption<LocalCoderGatewayEffectOptions[K]> },
  "connectHelper" | "connectPortForward"
> & {
  connectHelper?: (
    invocation: Parameters<NonNullable<LocalCoderGatewayEffectOptions["connectHelper"]>>[0],
  ) => Promise<PromiseCoderHelperConnection>;
  connectPortForward?: (
    invocation: Parameters<NonNullable<LocalCoderGatewayEffectOptions["connectPortForward"]>>[0],
  ) => Promise<PromisePortForwardConnection>;
};
const fromPromise = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (error) => error });

// Node test fixtures use promises. Ownership and cancellation still belong to the gateway's Effect scope.
function acquireConnection<C extends { close: () => void; closed: Promise<unknown> }>(
  open: () => Promise<C>,
) {
  return Effect.acquireRelease(
    Effect.callback<C, unknown>((resume) => {
      let interrupted = false;
      void Promise.resolve()
        .then(open)
        .then(
          (connection) => {
            if (interrupted) {
              try {
                connection.close();
              } catch {
                /* Detached fixture. */
              }
              void connection.closed.catch(() => undefined);
            } else {
              let closed = false;
              void connection.closed.then(
                () => {
                  closed = true;
                },
                () => {
                  closed = true;
                },
              );
              resume(
                Effect.succeed({
                  ...connection,
                  close: () => {
                    if (!closed) {
                      closed = true;
                      connection.close();
                    }
                  },
                }),
              );
            }
          },
          (error) => {
            if (!interrupted) resume(Effect.fail(error));
          },
        );
      return Effect.sync(() => {
        interrupted = true;
      });
    }),
    (connection) =>
      Effect.sync(() => connection.close()).pipe(
        Effect.andThen(fromPromise(() => connection.closed)),
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void }),
        Effect.ignoreCause,
      ),
    { interruptible: true },
  );
}

export async function startLocalCoderGateway(options: Options = {}) {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const { connectHelper, connectPortForward, ...rest } = options;
  const effectOptions: LocalCoderGatewayEffectOptions = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args: unknown[]) => fromPromise(() => Reflect.apply(value, undefined, args))
        : value,
    ]),
  );
  if (connectHelper)
    Object.assign(effectOptions, {
      connectHelper: (invocation: Parameters<typeof connectHelper>[0]) =>
        acquireConnection(() => connectHelper(invocation)).pipe(
          Effect.map((connection) => ({
            info: connection.info,
            closed: fromPromise(() => connection.closed).pipe(Effect.orDie),
            close: Effect.sync(() => connection.close()),
            sendRpc: (message: unknown) =>
              Effect.try({
                try: () => connection.sendRpc(message),
                catch: (cause) =>
                  new CoderHelperConnectionError("Coder workspace helper RPC request failed.", {
                    cause,
                  }),
              }),
            onRpcMessage: connection.onRpcMessage,
          })),
        ),
    });
  if (connectPortForward)
    Object.assign(effectOptions, {
      connectPortForward: (invocation: Parameters<typeof connectPortForward>[0]) =>
        acquireConnection(() => connectPortForward(invocation)).pipe(
          Effect.map((connection) => ({
            closed: fromPromise(() => connection.closed).pipe(Effect.orDie),
            close: Effect.sync(() => connection.close()),
          })),
        ),
    });
  try {
    const gateway = await Effect.runPromise(
      makeLocalCoderGateway(effectOptions).pipe(Scope.provide(scope)),
    );
    let closing: Promise<void> | undefined;
    return {
      ...gateway,
      close: () => (closing ??= Effect.runPromise(Scope.close(scope, Exit.void))),
    };
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw error;
  }
}
