/**
 * Coder: upstream's PeerLinks pairs with other environments over MCP OAuth and stores their
 * session tokens. Here the user sets workspace link rules in T3 Coder's gateway, which knows
 * whether each linked workspace is connected; this service reads them through the gateway hub
 * (`coderHub.ts`). It keeps upstream's service tag and the members `PeerForwarding` and
 * `RemoteDelegation` read, so both stay upstream's. Nothing is stored here.
 *
 * @module peer/PeerLinks
 */
import {
  type EnvironmentId,
  type PeerLink,
  PeerLinkError,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { CoderHubLink } from "@t3tools/coder-cli/rpc";
import * as CoderHub from "../coderHub.ts";
import * as ServerSettings from "../serverSettings.ts";

/** Link rules do not expire and record no linking time; these stand in for upstream's fields. */
const LINK_RULE_LINKED_AT = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const LINK_RULE_EXPIRES_AT = DateTime.makeUnsafe("9999-12-31T00:00:00.000Z");

export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    /** Whether the Linked environments beta (Settings → Labs) is on here. */
    readonly enabled: Effect.Effect<boolean>;
    readonly list: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError>;
    /** The link rule to `environmentId`, without asking whether it answers. */
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
  }
>()("t3/peer/PeerLinks") {}

const toSummary = (link: CoderHubLink): PeerLinkSummary => ({
  environmentId: link.environmentId,
  label: link.label,
  urls: [],
  access: link.access,
  linkedAt: LINK_RULE_LINKED_AT,
  expiresAt: LINK_RULE_EXPIRES_AT,
  lastReachedAt: null,
  lastError: link.connected ? null : "That workspace is not connected in T3 Coder.",
  status: link.connected ? "reachable" : "unreachable",
});

const make = Effect.gen(function* () {
  const hub = yield* CoderHub.CoderHub;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const enabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.linkedEnvironmentsEnabled),
    Effect.orElseSucceed(() => false),
  );

  const list: PeerLinks["Service"]["list"] = hub.listLinks.pipe(
    Effect.map((links) => links.map(toSummary)),
    Effect.mapError(
      (failure) => new PeerLinkError({ reason: "unreachable", message: failure.message }),
    ),
  );

  return PeerLinks.of({
    enabled,
    list,
    get: (environmentId) =>
      list.pipe(
        Effect.map((links) =>
          Option.fromNullishOr(links.find((link) => link.environmentId === environmentId)),
        ),
        Effect.map(Option.map(({ status: _status, ...link }): PeerLink => link)),
      ),
  });
});

export const layer = Layer.effect(PeerLinks, make);
