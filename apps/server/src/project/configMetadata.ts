// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as path from "node:path";
import * as Schema from "effect/Schema";
import { T3ProjectFile, type ProjectGetConfigResult } from "@t3tools/contracts";

/** Read one small regular file, with checks tied to the descriptor actually read. */
export function readConfigMetadata(
  filePath: string,
  maxBytes: number,
  expectedDirectory?: string,
): string | null {
  let fd: number | undefined;
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) return null;
    fd = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    if (expectedDirectory !== undefined) {
      const resolved = fs.realpathSync(filePath);
      if (path.dirname(resolved) !== expectedDirectory) return null;
      const expected = fs.statSync(resolved);
      if (expected.dev !== info.dev || expected.ino !== info.ino) return null;
    }
    const bytes = Buffer.alloc(info.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (n === 0) break;
      count += n;
    }
    if (count > info.size || count > maxBytes) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The caller resolves this root from a live project, never from an RPC path. */
export function readProjectConfig(workspaceRoot: string): ProjectGetConfigResult {
  try {
    const root = fs.realpathSync(workspaceRoot);
    const filePath = path.join(root, "t3.json");
    try {
      fs.lstatSync(filePath);
    } catch (error) {
      return {
        status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid",
        file: null,
      };
    }
    const text = readConfigMetadata(filePath, 64 * 1024, root);
    if (text === null) return { status: "invalid", file: null };
    const decoded = Schema.decodeUnknownExit(Schema.fromJsonString(T3ProjectFile))(text);
    return decoded._tag === "Success"
      ? { status: "valid", file: decoded.value }
      : { status: "invalid", file: null };
  } catch {
    return { status: "unavailable", file: null };
  }
}
