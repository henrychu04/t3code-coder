// @effect-diagnostics nodeBuiltinImport:off
// A mechanical check of the laptop boundary in AGENTS.md: the gateway and coder-cli sources may
// reach only loopback, and may spawn only the Coder CLI or the OS browser opener. It reads the
// sources as text, so it stays fast and catches a change before anything is built.
import { deepStrictEqual } from "node:assert";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scannedDirectories = ["apps/coder-gateway/src", "packages/coder-cli/src"];

const sources = scannedDirectories.flatMap((directory) =>
  NodeFS.readdirSync(NodePath.join(repositoryRoot, directory), { recursive: true })
    .map((entry) => NodePath.join(directory, String(entry)).split(NodePath.sep).join("/"))
    .filter(
      (path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.includes("/testUtils/"),
    )
    .map((path) => ({
      path,
      text: NodeFS.readFileSync(NodePath.join(repositoryRoot, path), "utf8"),
    })),
);

/** Every match of `pattern` in the scanned sources, as `path: match`. */
function findAll(pattern: RegExp, keep: (match: RegExpExecArray) => boolean = () => true) {
  return sources.flatMap(({ path, text }) =>
    [...text.matchAll(pattern)].filter(keep).map((match) => `${path}: ${match[0]}`),
  );
}

// The gateway's own origin, written as a template over its loopback host constant.
const ALLOWED_URL_PREFIXES = [
  "http://127.0.0.1",
  "ws://127.0.0.1",
  "http://${CODER_GATEWAY_HOST}",
  "http://${expectedHost}",
];
// The configured deployment executable is validated to be `coder` or `coder.exe` (profile.ts).
const ALLOWED_EXECUTABLES = ["coder", "open", "xdg-open", "explorer.exe"];
const ALLOWED_SPAWN_TARGETS = ["invocation.executable", "browser.executable"];

describe("laptop boundary guard", () => {
  it("scans the gateway and coder-cli sources", () => {
    deepStrictEqual(
      sources.some(({ path }) => path === "apps/coder-gateway/src/server.ts"),
      true,
    );
  });

  it("names no URL other than loopback", () => {
    deepStrictEqual(
      findAll(
        /\b(?:https?|wss?):\/\/[^\s'"`;]*/g,
        (match) => !ALLOWED_URL_PREFIXES.some((prefix) => match[0].startsWith(prefix)),
      ),
      [],
    );
    deepStrictEqual(findAll(/\bCODER_GATEWAY_HOST = "(?!127\.0\.0\.1")/g), []);
  });

  it("opens no outbound connection of its own", () => {
    deepStrictEqual(findAll(/\bfetch\(|\bnet\.connect\b|\bcreateConnection\(/g), []);
    deepStrictEqual(findAll(/"node:(?:net|tls|dgram|https|http2)"/g), []);
    deepStrictEqual(findAll(/\b(?:NodeHttp|http)\.(?:request|get)\(/g), []);
  });

  it("spawns only the Coder CLI or the OS browser opener, never through a shell", () => {
    deepStrictEqual(
      findAll(
        /(?:\bspawn|\bspawnProcess|\?\? spawn\))\(\s*([^,)]+),/g,
        (match) => !ALLOWED_SPAWN_TARGETS.includes(match[1]!.trim()),
      ),
      [],
    );
    deepStrictEqual(
      findAll(
        /\bexecutable:\s*(?:[^,}\n]*\?\?\s*)?"([^"]*)"/g,
        (match) => !ALLOWED_EXECUTABLES.includes(match[1]!),
      ),
      [],
    );
    // `spawn` is the only value imported from child_process; exec and fork take shells or scripts.
    const childProcessImports = sources.flatMap(({ path, text }) =>
      [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"node:child_process"/g)].flatMap((match) =>
        match[1]!
          .split(",")
          .map((name) => name.trim())
          .filter((name) => name !== "" && name !== "spawn" && !name.startsWith("type "))
          .map((name) => `${path}: ${name}`),
      ),
    );
    deepStrictEqual(childProcessImports, []);
    deepStrictEqual(findAll(/require\("node:child_process"\)|from "child_process"/g), []);
    deepStrictEqual(findAll(/\bshell:\s*true\b/g), []);
  });
});
