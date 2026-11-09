import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import { CoderWsRpcGroup } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as RpcServer from "effect/rpc/RpcServer";

import {
  CODER_HELPER_INFO_METHOD,
  CODER_HELPER_PROTOCOL_VERSION,
  CODER_HELPER_SHUTDOWN_METHOD,
  CoderHelperProtocolError,
  CoderHelperInfoRpcGroup,
  CoderHelperRpcGroup,
} from "@t3tools/coder-cli/rpc";
import * as ServerConfig from "t3/src/config.ts";
import * as DatabaseMaintenance from "t3/src/persistence/DatabaseMaintenance.ts";
import * as DefectReporter from "t3/src/observability/DefectReporter.ts";
import { withOutputWindow } from "t3/src/terminal/OutputProtocol.ts";
import { makeCoderRuntimeLayer } from "t3/src/coderServer.ts";
import { WS_RPC_SERVER_OPTIONS } from "t3/src/ws.ts";

export const coderHelperHandlers = CoderHelperInfoRpcGroup.toLayer({
  [CODER_HELPER_INFO_METHOD]: ({ protocolVersion }) =>
    protocolVersion === CODER_HELPER_PROTOCOL_VERSION
      ? Effect.succeed({
          protocolVersion: CODER_HELPER_PROTOCOL_VERSION,
          platform: process.platform,
          architecture: process.arch,
        })
      : Effect.fail(
          new CoderHelperProtocolError({
            message: `Unsupported protocol version ${protocolVersion}.`,
            supportedVersion: CODER_HELPER_PROTOCOL_VERSION,
          }),
        ),
  // The helper's normal SIGTERM shutdown: NodeRuntime interrupts the main fiber, which runs every
  // finalizer, and the process exits.
  [CODER_HELPER_SHUTDOWN_METHOD]: () =>
    Effect.sync(() => void process.kill(process.pid, "SIGTERM")),
});

const coderServerConfigLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = yield* HostProcess.Environment;
    const baseDir = env.T3_CODER_HOME?.trim() || path.join(env.HOME ?? ".", ".t3-coder");
    const cwd =
      env.T3_CODER_CWD?.trim() || env.HOME?.trim() || (yield* HostProcess.WorkingDirectory);
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir);
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    return ServerConfig.ServerConfig.of({
      ...derivedPaths,
      cwd,
      baseDir,
    });
  }),
);

export const CoderWorkspaceRpcGroup = CoderHelperRpcGroup.merge(CoderWsRpcGroup);

export const coderHelperStdioLayer = RpcServer.layer(
  CoderWorkspaceRpcGroup,
  WS_RPC_SERVER_OPTIONS,
).pipe(
  Layer.provide(Layer.mergeAll(coderHelperHandlers, makeCoderRuntimeLayer(), DefectReporter.layer)),
  Layer.provide(
    Layer.effect(RpcServer.Protocol, Effect.map(RpcServer.Protocol, withOutputWindow)).pipe(
      Layer.provide(RpcServer.layerProtocolStdio),
    ),
  ),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(NodeStdio.layer),
);

/**
 * The helper process. Coder: as upstream's `runServerCommand`, a reclaim requested from Settings
 * runs once the runtime has stopped and closed the database, before the process exits. The
 * browser's next connection then starts a fresh helper (see ServerRestart in `coderServer.ts`).
 */
export const coderHelperMain = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return yield* Layer.launch(coderHelperStdioLayer).pipe(
    // Settings' Reclaim stops the helper; repair once the database is closed, before the restart.
    Effect.ensuring(
      DatabaseMaintenance.runRequestedReclaim(config.dbPath).pipe(
        Effect.provide(DatabaseMaintenance.layer),
      ),
    ),
  );
}).pipe(
  Effect.provide(coderServerConfigLayer.pipe(Layer.provideMerge(NodeServices.layer))),
  // Keep Effect logs, including DefectReporter's and the repair's, off stdout, which carries the
  // NDJSON RPC transport. The helper launch discards stderr, so these logs are not kept anywhere.
  Effect.provideService(Logger.LogToStderr, true),
);
