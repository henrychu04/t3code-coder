import { describe, expect, it } from "vite-plus/test";

import { formatCoderPortForwardCommand } from "./PortForwardSettings";

describe("port forward settings", () => {
  it("shows the loopback-only Coder CLI command", () => {
    expect(
      formatCoderPortForwardCommand(
        { protocol: "tcp", localPort: 3000, remotePort: 5173 },
        { workspace: "henry/web-app" },
      ),
    ).toBe("coder port-forward henry/web-app --tcp 127.0.0.1:3000:5173");
  });
});
