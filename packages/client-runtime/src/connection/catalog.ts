// Coder: workspaces come from the gateway's Coder config; there are no saved, relay, bearer,
// or SSH connections to persist or toggle.
import * as Schema from "effect/Schema";

import { ConnectionTarget } from "./model.ts";

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
}

export class ConnectionRegistration extends Schema.TaggedClass<ConnectionRegistration>()(
  "ConnectionRegistration",
  { target: ConnectionTarget },
) {}

export const PlatformConnectionRegistration = ConnectionRegistration;
export type PlatformConnectionRegistration = ConnectionRegistration;

function connectionRegistrationTarget(registration: ConnectionRegistration): ConnectionTarget {
  return registration.target;
}

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration,
): ConnectionCatalogEntry {
  return { target: registration.target };
}
