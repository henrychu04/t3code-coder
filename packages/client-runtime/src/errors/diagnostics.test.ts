import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";

import { executeAtomCommand } from "../state/runtime.ts";
import {
  reportErrorCause,
  reportErrorDiagnostic,
  setErrorDiagnosticReporter,
} from "./diagnostics.ts";

let restore = () => {};
afterEach(() => {
  restore();
  vi.restoreAllMocks();
});

describe("console error diagnostics", () => {
  it("records a handled command failure even when UI reporting is disabled", async () => {
    const diagnostic = vi.fn();
    restore = setErrorDiagnosticReporter(diagnostic);
    const error = new Error("The MR branch is already checked out in the main repository.");
    const result = await executeAtomCommand(() => Promise.resolve(Exit.fail(error)), {
      label: "git.preparePullRequestThread",
      reportFailure: false,
    });
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBe(error);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        source: "git.preparePullRequestThread",
        message: error.message,
        timestamp: expect.any(String),
        errorName: "Error",
      }),
    );
  });

  it("records thrown defects but leaves successful operations and cancellations quiet", async () => {
    const diagnostic = vi.fn();
    restore = setErrorDiagnosticReporter(diagnostic);
    await executeAtomCommand(() => Promise.resolve(Exit.succeed("ok")));
    await executeAtomCommand(() => Promise.resolve(Exit.interrupt(1)));
    reportErrorDiagnostic("fetch", new DOMException("Cancelled", "AbortError"));
    expect(diagnostic).not.toHaveBeenCalled();
    await executeAtomCommand(
      () => {
        throw new TypeError("Invalid response");
      },
      { reportDefect: false },
    );
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorName: "TypeError",
        message: "Invalid response",
      }),
    );
  });

  it("does not duplicate the same error at RPC, command, and global boundaries", async () => {
    const diagnostic = vi.fn();
    const legacyError = vi.spyOn(console, "error").mockImplementation(() => {});
    const legacyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    restore = setErrorDiagnosticReporter(diagnostic);
    const error = new Error("Checkout failed");
    reportErrorCause("git.preparePullRequestThread", Cause.fail(error));
    await executeAtomCommand(() => Promise.resolve(Exit.fail(error)));
    reportErrorDiagnostic("browser.unhandledrejection", error);
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(legacyError).not.toHaveBeenCalled();
    expect(legacyWarn).not.toHaveBeenCalled();
  });

  it("bounds messages and omits payloads, nested causes, and credential values", () => {
    const diagnostic = vi.fn();
    restore = setErrorDiagnosticReporter(diagnostic);
    const error = Object.assign(
      new Error(
        'Denied https://user:pass@example.test/api?token=url-secret#fragment Bearer bearer-secret api_key="key-secret" token=token-secret glpat-gitlab-secret',
        { cause: { credential: "cause-secret" } },
      ),
      { input: { query: "private-query", contents: "private-contents" } },
    );
    error.stack = `Error: ${error.message}\n    at handler (https://user:pass@example.test/app.js?token=stack-secret:1:2)`;
    reportErrorDiagnostic("rpc.test", error);
    const serialized = JSON.stringify(diagnostic.mock.calls);
    for (const secret of [
      "pass",
      "url-secret",
      "bearer-secret",
      "key-secret",
      "token-secret",
      "gitlab-secret",
      "cause-secret",
      "private-query",
      "private-contents",
      "stack-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("Denied https://example.test/api");
    reportErrorDiagnostic("test", new Error("x".repeat(4_000)));
    expect(diagnostic.mock.calls[1]?.[0].message).toHaveLength(2_000);
  });

  it("never lets a broken reporter change the operation result", async () => {
    restore = setErrorDiagnosticReporter(() => {
      throw new Error("console unavailable");
    });
    const original = new Error("original");
    const result = await executeAtomCommand(() => Promise.resolve(Exit.fail(original)));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(Cause.squash(result.cause)).toBe(original);
  });
});
