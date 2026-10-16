// Coder: only Codex, Claude Code, and Pi are registered; upstream's other drivers are not carried.
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { PiDriver, type PiDriverEnv } from "@t3tools/provider-pi/server";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

export type BuiltInDriversEnv = ClaudeDriverEnv | CodexDriverEnv | PiDriverEnv;

export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  PiDriver,
];

// Coder: no usage page, so there are no usage drivers.
