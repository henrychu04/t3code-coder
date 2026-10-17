import { TrimmedString, makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Coder: the only ACP agent is Kilo Code, already installed in the workspace. Upstream's registry
// source, agent ID, distribution preference, and authentication method are not carried; the
// instance always runs its local command. Like Pi, its default instance starts disabled.
export const AcpRegistrySettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    commandPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("kilo")),
      Schema.annotateKey({
        title: "Kilo executable",
        description: "Kilo Code executable on the workspace PATH, or its absolute path.",
        providerSettingsForm: { placeholder: "kilo", clearWhenEmpty: "omit" },
      }),
    ),
    commandArgs: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed(["acp"])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["commandPath"],
  },
);
export type AcpRegistrySettings = typeof AcpRegistrySettings.Type;
