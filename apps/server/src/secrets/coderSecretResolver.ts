// Coder: secret providers are not carried (#25709, #27044, #27115), so this stands in for
// upstream's `@t3tools/secret-provider-core` resolver and its server definitions. No provider can
// read a reference, so the provider instance registry reports a variable that points at one as
// unreadable, and settings writes reject every secret provider kind as unsupported.
import type { SecretReference } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Schema from "effect/Schema";

export class SecretResolver extends Context.Service<
  SecretResolver,
  {
    /** Values in input order; `undefined` marks a reference that could not be read. */
    readonly read: (
      references: ReadonlyArray<SecretReference>,
    ) => Effect.Effect<ReadonlyArray<string | undefined>>;
    /** Forgets the given references, or every reference, so the next read asks the provider again. */
    readonly invalidate: (references?: ReadonlyArray<SecretReference>) => Effect.Effect<void>;
  }
>()("@t3tools/secret-provider-core/server/SecretResolver") {}

export const layer = Layer.succeed(
  SecretResolver,
  SecretResolver.of({
    read: (references) => Effect.succeed(references.map(() => undefined)),
    invalidate: () => Effect.void,
  }),
);

export const secretProviderDefinitions: {
  readonly definitions: ReadonlyArray<{ readonly kind: string; readonly configSchema: Schema.Top }>;
} = { definitions: [] };
