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

export function connectionRegistrationTarget(
  registration: ConnectionRegistration,
): ConnectionTarget {
  return registration.target;
}

export function connectionRegistrationCatalogEntry(
  registration: ConnectionRegistration,
): ConnectionCatalogEntry {
  return { target: registration.target };
}
