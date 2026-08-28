import { describe, expect, it } from "vite-plus/test";

import {
  formatCoderAutostop,
  formatCoderResourceBytes,
  formatCoderResourcePercent,
  formatCoderWorkspaceLatency,
  formatCoderWorkspaceLatencyDetail,
} from "./CoderWorkspaceLatency";

describe("formatCoderWorkspaceLatency", () => {
  it("keeps the toolbar value compact", () => {
    expect(formatCoderWorkspaceLatency(0.85)).toBe("<1 ms");
    expect(formatCoderWorkspaceLatency(31.4)).toBe("31 ms");
    expect(formatCoderWorkspaceLatency(31.6)).toBe("32 ms");
  });

  it("keeps the live hover value precise enough to show small changes", () => {
    expect(formatCoderWorkspaceLatencyDetail(0.04)).toBe("<0.1 ms");
    expect(formatCoderWorkspaceLatencyDetail(0.85)).toBe("0.9 ms");
    expect(formatCoderWorkspaceLatencyDetail(31.46)).toBe("31.5 ms");
    expect(formatCoderWorkspaceLatencyDetail(35)).toBe("35 ms");
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

describe("Coder workspace autostop formatting", () => {
  const now = Date.parse("2026-08-25T18:00:00.000Z");

  it("surfaces imminent deadlines without showing unstable seconds", () => {
    expect(formatCoderAutostop("2026-08-25T18:29:01.000Z", now)).toBe("Idle stop in 30m");
    expect(formatCoderAutostop("2026-08-25T20:00:00.000Z", now)).toBe("Idle stop in 2h 0m");
    expect(formatCoderAutostop("2026-08-25T19:59:00.000Z", now)).toBe("Idle stop in 1h 59m");
    expect(formatCoderAutostop("2026-08-27T20:00:00.000Z", now)).toBe("Idle stop in 2d 2h");
    expect(formatCoderAutostop("2026-08-25T17:59:00.000Z", now)).toBe("Idle stop due");
    expect(formatCoderAutostop("2026-08-25T20:00:00.000Z", now, "required")).toBe(
      "Required stop in 2h 0m",
    );
    expect(formatCoderAutostop("not-a-date", now)).toBeNull();
  });
});
