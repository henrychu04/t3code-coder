// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { __resetLocalApiForTests, createLocalApi } from "./localApi";

describe("browser local API", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await __resetLocalApiForTests();
  });

  it("opens only absolute HTTP and HTTPS URLs", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const api = createLocalApi();

    await api.shell.openExternal(" https://git.example.com/group/project ");
    await api.shell.openExternal("http://git.example.com/group/project");
    await api.shell.openExternal("javascript:alert(1)");
    await api.shell.openExternal("data:text/html,unsafe");
    await api.shell.openExternal("/relative");
    await api.shell.openExternal("not a URL");

    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(
      1,
      "https://git.example.com/group/project",
      "_blank",
      "noopener,noreferrer",
    );
    expect(open).toHaveBeenNthCalledWith(
      2,
      "http://git.example.com/group/project",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
