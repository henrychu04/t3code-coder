// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { installConsoleDiagnostics } from "./consoleDiagnostics";
import { loadCoderConfig } from "./coder/api";

afterEach(() => vi.restoreAllMocks());

it("reports browser failures to the console without requests and removes its listeners", () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.spyOn(window, "fetch");
  const dispose = installConsoleDiagnostics();
  try {
    const errorEvent = new ErrorEvent("error", {
      error: new Error("Unhandled bug"),
      cancelable: true,
    });
    window.dispatchEvent(errorEvent);
    window.dispatchEvent(
      Object.assign(new Event("unhandledrejection"), {
        reason: new Error("Rejected operation"),
        promise: Promise.resolve(),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      "[t3-error] browser.error",
      expect.objectContaining({ message: "Unhandled bug" }),
    );
    expect(log).toHaveBeenCalledWith(
      "[t3-error] browser.unhandledrejection",
      expect.objectContaining({ message: "Rejected operation" }),
    );
    expect(errorEvent.defaultPrevented).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    dispose();
  }
  log.mockClear();
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("After cleanup") }));
  expect(log).not.toHaveBeenCalled();
});

it("logs handled gateway HTTP and network failures without changing what callers receive", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fetch = vi.spyOn(window, "fetch");
  const dispose = installConsoleDiagnostics();
  try {
    fetch.mockResolvedValueOnce(new Response("Workspace is unavailable", { status: 503 }));
    await expect(loadCoderConfig()).rejects.toThrow("Workspace is unavailable");
    const networkError = new TypeError("Failed to fetch");
    fetch.mockRejectedValueOnce(networkError);
    await expect(loadCoderConfig()).rejects.toBe(networkError);
    expect(log).toHaveBeenCalledWith(
      "[t3-error] coder.gateway",
      expect.objectContaining({ message: "Workspace is unavailable" }),
    );
    expect(log).toHaveBeenCalledWith(
      "[t3-error] coder.gateway",
      expect.objectContaining({ message: "Failed to fetch" }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("/api/config", { cache: "no-store" });
  } finally {
    dispose();
  }
});
