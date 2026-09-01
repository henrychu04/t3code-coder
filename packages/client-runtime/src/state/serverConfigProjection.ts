import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot":
      return Option.some({ config: event.config, latestEvent: event, source: "live" });
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: projection.config.providers.some(
            (provider) => provider.instanceId === event.payload.provider.instanceId,
          )
            ? projection.config.providers.map((provider) =>
                provider.instanceId === event.payload.provider.instanceId
                  ? event.payload.provider
                  : provider,
              )
            : [...projection.config.providers, event.payload.provider],
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerRemoved":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: projection.config.providers.filter(
            (provider) => provider.instanceId !== event.payload.instanceId,
          ),
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: { ...projection.config, settings: event.payload.settings },
        latestEvent: event,
        source: "live",
      }));
  }
}
