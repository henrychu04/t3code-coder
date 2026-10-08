/**
 * Coder: T3 Coder does not install or sign in a managed Codex runtime. Only upstream's runtime
 * resolution contract remains so the shared Codex adapter keeps its optional hook.
 *
 * @module provider/CodexManagedRuntime
 */
import type { CodexSettings } from "@t3tools/contracts";

export interface CodexEffectiveRuntime {
  readonly config: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly revision: string;
}
