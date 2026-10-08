/**
 * ProviderEventLoggers — upstream's shared native/canonical provider event logger tag.
 *
 * Coder: no diagnostic log files are created, so the only layer provides the no-op service.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import type * as EventNdjsonLogger from "./EventNdjsonLogger.ts";

export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  {
    readonly native: EventNdjsonLogger.EventNdjsonLogger | undefined;
    readonly canonical: EventNdjsonLogger.EventNdjsonLogger | undefined;
  }
>()("t3/provider/Layers/ProviderEventLoggers") {}

export const NoOpProviderEventLoggers: ProviderEventLoggers["Service"] = {
  native: undefined,
  canonical: undefined,
};

export const layer = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);
