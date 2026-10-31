// Coder: macOS keeps temp files under /var, a symlink to /private/var, so Git and realpath report
// a different path than os.tmpdir(). Upstream canonicalizes only Windows temp paths
// (packages/shared/src/testing/longTempDir.ts) because its CI runs on Linux; the fork's tests also
// run on a macOS development machine.
// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

if (process.platform === "darwin") {
  try {
    process.env.TMPDIR = NodeFS.realpathSync.native(NodeOS.tmpdir());
  } catch {}
}
