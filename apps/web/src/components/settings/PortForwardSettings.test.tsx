import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PortForwardStatusBadge } from "./PortForwardSettings";

describe("Coder port-forward status badge", () => {
  it("shows checking before the first status response", () => {
    const markup = renderToStaticMarkup(
      <PortForwardStatusBadge status={undefined} unavailable={false} />,
    );

    expect(markup).toContain("Checking…");
    expect(markup).not.toContain("Starting");
  });

  it("does not display a stale running state when status refresh is unavailable", () => {
    const markup = renderToStaticMarkup(
      <PortForwardStatusBadge
        status={{ id: "forward-one", status: "running" }}
        unavailable={true}
      />,
    );

    expect(markup).toContain("Status unavailable");
    expect(markup).not.toContain(">Running<");
  });

  it("shows running when a fresh gateway response reports a live forward", () => {
    const markup = renderToStaticMarkup(
      <PortForwardStatusBadge
        status={{ id: "forward-one", status: "running" }}
        unavailable={false}
      />,
    );

    expect(markup).toContain(">Running<");
  });
});
