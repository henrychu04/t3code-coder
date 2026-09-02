import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
} from "@t3tools/contracts";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentServerConfigsAtom } from "@t3tools/client-runtime/state/shell";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";

export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
});
export const environmentServerConfigsAtom = createEnvironmentServerConfigsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});

export interface EnvironmentServerState {
  readonly config: ServerConfig | null;
  readonly latestEvent: ServerConfigStreamEvent | null;
  readonly welcome: ServerLifecycleWelcomePayload | null;
}

export const environmentServerStatesAtom = Atom.make(
  (get): ReadonlyMap<EnvironmentId, EnvironmentServerState> => {
    const states = new Map<EnvironmentId, EnvironmentServerState>();

    for (const [environmentId] of get(environmentCatalog.catalogValueAtom).entries) {
      const target = { environmentId, input: {} };
      const configProjection = Option.getOrNull(
        AsyncResult.value(get(serverEnvironment.configProjection(target))),
      );
      const welcome = Option.getOrNull(AsyncResult.value(get(serverEnvironment.welcome(target))));

      states.set(environmentId, {
        config: get(serverEnvironment.configValueAtom(environmentId)),
        latestEvent: configProjection?.latestEvent ?? null,
        welcome,
      });
    }

    return states;
  },
).pipe(Atom.withLabel("web-environment-server-states"));
