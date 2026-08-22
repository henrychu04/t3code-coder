import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const CODER_HELPER_PROTOCOL_VERSION = 1;
export const CODER_HELPER_INFO_METHOD = "coder.helper.info";

export class CoderHelperProtocolError extends Schema.TaggedErrorClass<CoderHelperProtocolError>()(
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

export const CoderHelperRpcGroup = RpcGroup.make(CoderHelperInfoRpc);
