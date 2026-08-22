import * as Schema from "effect/Schema";

import { PrimaryConnectionTarget, type ConnectionTarget } from "./model.ts";

export interface ConnectionCatalogEntry {
  readonly target: ConnectionTarget;
}

export class PrimaryConnectionRegistration extends Schema.TaggedClass<PrimaryConnectionRegistration>()(
  "PrimaryConnectionRegistration",
  { target: PrimaryConnectionTarget },
) {}

export const ConnectionRegistration = PrimaryConnectionRegistration;
export type ConnectionRegistration = typeof ConnectionRegistration.Type;
export const PlatformConnectionRegistration = PrimaryConnectionRegistration;
export type PlatformConnectionRegistration = typeof PlatformConnectionRegistration.Type;

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
