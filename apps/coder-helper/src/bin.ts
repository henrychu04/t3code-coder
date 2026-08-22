import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import { CoderWsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import {
  CODER_HELPER_INFO_METHOD,
  CODER_HELPER_PROTOCOL_VERSION,
  CoderHelperProtocolError,
  CoderHelperRpcGroup,
} from "@t3tools/coder-cli/rpc";
import * as ServerConfig from "t3/src/config.ts";
import { makeCoderRuntimeLayer } from "t3/src/coderRuntime.ts";

export const coderHelperHandlers = CoderHelperRpcGroup.toLayer({
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
});

const coderServerConfigLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const baseDir =
      process.env.T3_CODER_HOME?.trim() || path.join(process.env.HOME ?? ".", ".t3-coder");
    const cwd = process.env.T3_CODER_CWD?.trim() || process.env.HOME?.trim() || process.cwd();
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

export const coderHelperStdioLayer = RpcServer.layer(CoderWorkspaceRpcGroup, {
  disableTracing: true,
}).pipe(
  Layer.provide(Layer.merge(coderHelperHandlers, makeCoderRuntimeLayer())),
  Layer.provide(RpcServer.layerProtocolStdio),
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(NodeStdio.layer),
  Layer.provide(coderServerConfigLayer),
  Layer.provide(NodeServices.layer),
  Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
);

if (import.meta.main) {
  Layer.launch(coderHelperStdioLayer).pipe(NodeRuntime.runMain);
}
