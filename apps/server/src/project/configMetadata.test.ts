import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { readConfigMetadata, readProjectConfig } from "./configMetadata.ts";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-config-test-"));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const write = (contents: string | Buffer) => fs.writeFileSync(path.join(root, "t3.json"), contents);
describe("fixed project configuration metadata", () => {
  it("returns supported fields only and never returns raw contents", () => {
    write(
      JSON.stringify({
        defaultThreadEnvMode: "worktree",
        scripts: [
          {
            name: "Build",
            command: "pnpm build",
            icon: "build",
            previewUrl: "https://example.com",
          },
        ],
        iconPath: "../secret",
        secret: "private",
      }),
    );
    expect(readProjectConfig(root)).toEqual({
      status: "valid",
      file: {
        defaultThreadEnvMode: "worktree",
        scripts: [{ name: "Build", command: "pnpm build", icon: "build" }],
      },
    });
  });
  it("distinguishes missing, invalid and unavailable configuration without diagnostics", () => {
    expect(readProjectConfig(root)).toEqual({ status: "missing", file: null });
    write('{"secret":"do-not-expose",');
    expect(readProjectConfig(root)).toEqual({ status: "invalid", file: null });
    expect(readProjectConfig(path.join(root, "missing-root"))).toEqual({
      status: "unavailable",
      file: null,
    });
  });
  it.each([Buffer.from([0xff, 0xfe]), Buffer.from('{"x":"\0"}'), Buffer.alloc(65537, 32)])(
    "rejects binary, malformed UTF-8, and oversized files (%#)",
    (contents) => {
      write(contents);
      expect(readProjectConfig(root)).toEqual({ status: "invalid", file: null });
    },
  );
  it("rejects symlinks and directories", () => {
    fs.writeFileSync(path.join(root, "private"), '{"defaultThreadEnvMode":"worktree"}');
    fs.symlinkSync(path.join(root, "private"), path.join(root, "t3.json"));
    expect(readProjectConfig(root).status).toBe("invalid");
    fs.unlinkSync(path.join(root, "t3.json"));
    fs.mkdirSync(path.join(root, "t3.json"));
    expect(readProjectConfig(root).status).toBe("invalid");
  });
  it("rejects invalid supported fields and excessive scripts", () => {
    write('{"defaultThreadEnvMode":"other"}');
    expect(readProjectConfig(root).status).toBe("invalid");
    write(
      JSON.stringify({
        scripts: Array.from({ length: 51 }, () => ({ name: "run", command: "true" })),
      }),
    );
    expect(readProjectConfig(root).status).toBe("invalid");
  });
  it("observes file changes on subsequent reads", () => {
    write('{"defaultThreadEnvMode":"local"}');
    expect(readProjectConfig(root).file?.defaultThreadEnvMode).toBe("local");
    write('{"defaultThreadEnvMode":"worktree"}');
    expect(readProjectConfig(root).file?.defaultThreadEnvMode).toBe("worktree");
  });
  it("enforces the caller's byte limit on regular metadata", () => {
    write("abc");
    expect(readConfigMetadata(path.join(root, "t3.json"), 2)).toBeNull();
    expect(readConfigMetadata(path.join(root, "t3.json"), 3)).toBe("abc");
  });
});

it("binds a metadata read to its expected directory", () => {
  write("private");
  expect(readConfigMetadata(path.join(root, "t3.json"), 100, path.join(root, "other"))).toBeNull();
});
