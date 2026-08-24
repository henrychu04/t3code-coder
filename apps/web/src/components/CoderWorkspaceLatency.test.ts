import { describe, expect, it } from "vite-plus/test";

import {
  formatCoderResourceBytes,
  formatCoderResourcePercent,
  formatCoderWorkspaceLatency,
} from "./CoderWorkspaceLatency";

describe("formatCoderWorkspaceLatency", () => {
  it("keeps the toolbar value compact", () => {
    expect(formatCoderWorkspaceLatency(0.85)).toBe("<1 ms");
    expect(formatCoderWorkspaceLatency(31.4)).toBe("31 ms");
    expect(formatCoderWorkspaceLatency(31.6)).toBe("32 ms");
  });
});

describe("Coder workspace resource formatting", () => {
  it("formats percentages and binary byte quantities for the health card", () => {
    expect(formatCoderResourcePercent(3, 8)).toBe("38%");
    expect(formatCoderResourceBytes(512 * 1024 ** 2)).toBe("512 MiB");
    expect(formatCoderResourceBytes(3.25 * 1024 ** 3)).toBe("3.3 GiB");
    expect(formatCoderResourceBytes(32 * 1024 ** 3)).toBe("32 GiB");
  });
});
