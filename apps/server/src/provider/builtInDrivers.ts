// Coder: only Codex, Claude Code, Pi, and Kilo Code (upstream's ACP Registry driver, limited to
// its local command) are registered; upstream's other drivers are not carried.
import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { PiDriver, type PiDriverEnv } from "@t3tools/provider-pi/server";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | PiDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  PiDriver,
  AcpRegistryDriver,
];

// Coder: no usage page, so there are no usage drivers.
