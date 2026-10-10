// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  buildCoderWorkspaceShellInvocation,
  REMOTE_HELPER_BUNDLE_HASH_FILE,
  type CoderInvocation,
  type CoderInvocationOptions,
} from "./command.ts";
import { type CoderDeploymentProfile, type CoderWorkspaceProfile } from "./profile.ts";

const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_TRANSFER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const ATTACHMENT_PATH_SENTINEL = "T3_CODER_ATTACHMENT_PATH=";
/** Printed once the remote shell is ready to read the transfer from stdin. */
const TRANSFER_READY_SENTINEL = "T3_CODER_TRANSFER_READY";
/** A composer attachment's stored extension, without its dot: `png`, `pdf`, `bin`. */
const ATTACHMENT_EXTENSION_PATTERN = /^[a-z0-9]{1,10}$/;
const TAR_BLOCK_BYTES = 512;

export class CoderProcessError extends Error {
  readonly _tag = "CoderProcessError";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CoderProcessError";
  }
}

function appendOutput(current: Buffer, chunk: Buffer): Buffer {
  if (current.byteLength >= MAX_PROCESS_OUTPUT_BYTES) return current;
  return Buffer.concat([current, chunk.subarray(0, MAX_PROCESS_OUTPUT_BYTES - current.byteLength)]);
}

/** Bytes written to the child's stdin once its stdout prints `readySentinel`. */
interface ProcessInput {
  readonly readySentinel: string;
  readonly chunks: readonly Buffer[];
}

export function runProcess(
  invocation: CoderInvocation,
  label: string,
  timeoutMs: number,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  input?: ProcessInput,
): Effect.Effect<string, CoderProcessError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const exit = yield* Deferred.make<
        | {
            readonly _tag: "Exit";
            readonly code: number | null;
            readonly signal: NodeJS.Signals | null;
          }
        | { readonly _tag: "Error"; readonly cause: Error }
      >();
      let stdout: Buffer = Buffer.alloc(0);
      yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            const child = spawn(invocation.executable, invocation.args, {
              shell: false,
              stdio: ["pipe", "pipe", "pipe"],
              windowsHide: true,
              ...(invocation.env ? { env: { ...process.env, ...invocation.env } } : {}),
            });
            // Bytes sent before the remote shell disables its PTY's line discipline would be
            // echoed or reinterpreted, so stdin waits for the remote ready line.
            let pending = input ? "" : undefined;
            child.stdin.on("error", () => {
              // A remote failure closes stdin early; the exit status reports it.
            });
            if (!input) child.stdin.end();
            child.stdout.on("data", (chunk: Buffer) => {
              stdout = appendOutput(stdout, chunk);
              if (pending === undefined || !input) return;
              pending = (pending + chunk.toString("latin1")).slice(-4096);
              if (!pending.includes(input.readySentinel)) return;
              pending = undefined;
              for (const bytes of input.chunks) child.stdin.write(bytes);
              child.stdin.end();
            });
            // Drain stderr without retaining local paths or transfer details.
            child.stderr.resume();
            child.once("error", (cause) => {
              Deferred.doneUnsafe(exit, Effect.succeed({ _tag: "Error", cause }));
            });
            child.once("exit", (code, signal) => {
              Deferred.doneUnsafe(exit, Effect.succeed({ _tag: "Exit", code, signal }));
            });
            return child;
          },
          catch: (cause) => new CoderProcessError(`${label} could not start.`, { cause }),
        }),
        (child) =>
          Effect.uninterruptible(
            Effect.suspend(() => {
              if (Deferred.isDoneUnsafe(exit)) return Effect.void;
              child.kill("SIGTERM");
              return Deferred.await(exit).pipe(
                Effect.timeoutOption(terminationGraceMs),
                Effect.flatMap((result) => {
                  if (Option.isSome(result)) return Effect.void;
                  if (child.exitCode === null && child.signalCode === null) {
                    child.kill("SIGKILL");
                  }
                  return Deferred.await(exit).pipe(Effect.asVoid);
                }),
              );
            }),
          ).pipe(Effect.catchCause(() => Effect.void)),
      );

      const result = yield* Deferred.await(exit).pipe(
        Effect.timeoutOrElse({
          duration: timeoutMs,
          orElse: () => Effect.fail(new CoderProcessError(`${label} timed out.`)),
        }),
      );
      if (result._tag === "Error") {
        return yield* Effect.fail(
          new CoderProcessError(`${label} could not start.`, { cause: result.cause }),
        );
      }
      if (result.code !== 0) {
        return yield* Effect.fail(
          new CoderProcessError(
            `${label} failed (code ${String(result.code)}, signal ${String(result.signal)}).`,
          ),
        );
      }
      return stdout.toString("utf8");
    }),
  );
}

/**
 * The remote half of a stdin transfer: puts Coder's remote PTY in raw mode, asks for the bytes,
 * and stores exactly `size` of them at `target` before running `finish`.
 */
function remoteStdinTransferCommand(input: {
  readonly setup: readonly string[];
  readonly target: string;
  readonly size: number;
  readonly finish: readonly string[];
}): string {
  return [
    "set -eu",
    "umask 077",
    ...input.setup,
    // Coder 2.25 always allocates a remote PTY; raw mode passes stdin through unchanged.
    "stty raw -echo 2>/dev/null || true",
    `printf '${TRANSFER_READY_SENTINEL}\\n'`,
    `head -c ${String(input.size)} > ${input.target}`,
    `[ "$(($(wc -c < ${input.target})))" -eq ${String(input.size)} ]`,
    ...input.finish,
  ].join("; ");
}

function cleanupRemoteTransfer(
  deployment: CoderDeploymentProfile,
  workspace: CoderWorkspaceProfile,
  remotePaths: readonly string[],
  invocationOptions?: CoderInvocationOptions,
): Effect.Effect<void> {
  const command = `rm -rf ${remotePaths.map((path) => `"$HOME/${path}"`).join(" ")}`;
  return runProcess(
    buildCoderWorkspaceShellInvocation(deployment, workspace, command, invocationOptions),
    "Coder transfer cleanup",
    DEFAULT_COMMAND_TIMEOUT_MS,
  ).pipe(
    // Cleanup is best-effort after the authoritative transfer failure.
    Effect.ignore,
  );
}

async function listBundleFiles(bundlePath: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await NodeFS.readdir(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile()) files.push(NodePath.relative(bundlePath, entryPath));
      else throw new Error("Coder helper bundle contains an unsupported file type.");
    }
  };
  await walk(bundlePath);
  return files.map((path) => path.split(NodePath.sep).join("/")).toSorted();
}

/**
 * SHA-256 over the helper bundle's relative file paths and contents, in a fixed order. The
 * helper launch compares it with the installed copy to skip a transfer when nothing changed,
 * and the install recomputes it in the workspace before replacing the helper.
 */
export async function hashCoderHelperBundle(bundlePath: string): Promise<string> {
  return (await archiveCoderHelperBundle(bundlePath)).hash;
}

/** The same digest as `hashCoderHelperBundle`, computed by the workspace shell in `$directory`. */
const REMOTE_BUNDLE_HASH_COMMAND =
  'actual="$(cd "$directory" && find . -type f | LC_ALL=C sort | while IFS= read -r file; do file="${file#./}"; printf \'%s\\000%s\\000\' "$file" "$(($(wc -c < "$file")))"; cat "$file"; done | sha256sum)"';

function tarField(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("Coder helper bundle path is too long.");
  bytes.copy(header, offset);
}

function tarOctal(header: Buffer, offset: number, length: number, value: number): void {
  tarField(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** One POSIX ustar entry for a regular file; GNU tar creates its parent directories. */
function tarFileHeader(path: string, size: number, mtimeSeconds: number): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  let prefix = "";
  let name = path;
  if (Buffer.byteLength(name) > 100) {
    const split = path.lastIndexOf("/", 155);
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  tarField(header, 0, 100, name);
  tarOctal(header, 100, 8, 0o644);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size);
  tarOctal(header, 136, 12, mtimeSeconds);
  header.fill(0x20, 148, 156);
  tarField(header, 156, 1, "0");
  tarField(header, 257, 6, "ustar\0");
  tarField(header, 263, 2, "00");
  tarField(header, 345, 155, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** A tar archive of the bundle (Windows has no `tar -c` to stream it) and the bundle's hash. */
async function archiveCoderHelperBundle(
  bundlePath: string,
): Promise<{ readonly chunks: readonly Buffer[]; readonly size: number; readonly hash: string }> {
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  for (const file of await listBundleFiles(bundlePath)) {
    const localPath = NodePath.join(bundlePath, ...file.split("/"));
    const [contents, stat] = await Promise.all([
      NodeFS.readFile(localPath),
      NodeFS.stat(localPath),
    ]);
    hash.update(`${file}\0${String(contents.byteLength)}\0`);
    hash.update(contents);
    chunks.push(tarFileHeader(file, contents.byteLength, Math.floor(stat.mtimeMs / 1000)));
    chunks.push(contents);
    const padding = (TAR_BLOCK_BYTES - (contents.byteLength % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(TAR_BLOCK_BYTES * 2));
  return {
    chunks,
    size: chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
    hash: hash.digest("hex"),
  };
}

/**
 * Replaces the workspace helper with the local bundle. One foreground `coder ssh` session reads
 * a tar archive from stdin into a generated temporary directory, checks its size and the bundle
 * hash, records the hash, and renames the directory into place.
 */
export function installCoderHelper(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly helperBundlePath: string;
  readonly invocationOptions?: CoderInvocationOptions;
  readonly timeoutMs?: number;
}): Effect.Effect<void, CoderProcessError> {
  return Effect.gen(function* () {
    const archive = yield* Effect.tryPromise({
      try: () => archiveCoderHelperBundle(input.helperBundlePath),
      catch: (cause) =>
        new CoderProcessError("The local workspace helper bundle could not be read.", { cause }),
    });
    const remotePath = `.t3-coder/bin/workspace-helper.tmp.${randomUUID()}`;
    const command = remoteStdinTransferCommand({
      setup: [
        `directory="$HOME/${remotePath}"`,
        'archive="$directory.tar"',
        'final="$HOME/.t3-coder/bin/workspace-helper"',
        'backup="$HOME/.t3-coder/bin/workspace-helper.previous"',
        'mkdir "$directory"',
      ],
      target: '"$archive"',
      size: archive.size,
      finish: [
        'tar -x -f "$archive" -C "$directory"',
        'rm -f "$archive"',
        '[ -f "$directory/index.mjs" ]',
        REMOTE_BUNDLE_HASH_COMMAND,
        `[ "\${actual%% *}" = "${archive.hash}" ]`,
        'chmod 700 "$directory/index.mjs"',
        `printf '%s\\n' '${archive.hash}' > "$directory/${REMOTE_HELPER_BUNDLE_HASH_FILE}"`,
        'rm -rf "$backup"',
        'if [ -e "$final" ]; then mv "$final" "$backup"; fi',
        'if mv "$directory" "$final"; then rm -rf "$backup"; else if [ -e "$backup" ]; then mv "$backup" "$final"; fi; exit 1; fi',
      ],
    });
    yield* runProcess(
      buildCoderWorkspaceShellInvocation(
        input.deployment,
        input.workspace,
        command,
        input.invocationOptions,
      ),
      "Coder helper transfer",
      input.timeoutMs ?? DEFAULT_TRANSFER_TIMEOUT_MS,
      DEFAULT_TERMINATION_GRACE_MS,
      { readySentinel: TRANSFER_READY_SENTINEL, chunks: archive.chunks },
    ).pipe(
      Effect.onError(() =>
        cleanupRemoteTransfer(
          input.deployment,
          input.workspace,
          [remotePath, `${remotePath}.tar`],
          input.invocationOptions,
        ),
      ),
    );
  });
}

/**
 * Stages a validated composer image or file in `$HOME/.t3-coder/attachments` under an internally
 * generated name and returns its workspace path.
 */
export function uploadCoderComposerAttachment(input: {
  readonly deployment: CoderDeploymentProfile;
  readonly workspace: CoderWorkspaceProfile;
  readonly bytes: Buffer;
  readonly extension: string;
  readonly invocationOptions?: CoderInvocationOptions;
}): Effect.Effect<string, CoderProcessError> {
  return Effect.gen(function* () {
    if (!ATTACHMENT_EXTENSION_PATTERN.test(input.extension)) {
      return yield* Effect.fail(new CoderProcessError("Invalid attachment extension."));
    }
    // Upstream's pending-upload id, `pending-<uuid>-<ext>`, stored as `<id>.<ext>`. The workspace
    // helper claims it into the thread when the message is sent.
    const filename = `pending-${randomUUID()}-${input.extension}.${input.extension}`;
    const remotePath = `.t3-coder/attachments/${filename}.tmp`;
    const finalRemotePath = `.t3-coder/attachments/${filename}`;
    const command = remoteStdinTransferCommand({
      setup: [`temporary="$HOME/${remotePath}"`, `final="$HOME/${finalRemotePath}"`],
      target: '"$temporary"',
      size: input.bytes.byteLength,
      finish: [
        'chmod 600 "$temporary"',
        'mv "$temporary" "$final"',
        `printf '${ATTACHMENT_PATH_SENTINEL}%s\\n' "$final"`,
      ],
    });
    const upload = Effect.gen(function* () {
      const stdout = yield* runProcess(
        buildCoderWorkspaceShellInvocation(
          input.deployment,
          input.workspace,
          command,
          input.invocationOptions,
        ),
        "Coder attachment transfer",
        DEFAULT_TRANSFER_TIMEOUT_MS,
        DEFAULT_TERMINATION_GRACE_MS,
        { readySentinel: TRANSFER_READY_SENTINEL, chunks: [input.bytes] },
      );
      const pathLine = stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith(ATTACHMENT_PATH_SENTINEL));
      const workspacePath = pathLine?.slice(ATTACHMENT_PATH_SENTINEL.length).trim();
      if (!workspacePath?.startsWith("/")) {
        return yield* Effect.fail(
          new CoderProcessError("Coder attachment transfer did not return a workspace path."),
        );
      }
      return workspacePath;
    });
    return yield* upload.pipe(
      Effect.onError(() =>
        cleanupRemoteTransfer(
          input.deployment,
          input.workspace,
          [remotePath, finalRemotePath],
          input.invocationOptions,
        ),
      ),
    );
  });
}
