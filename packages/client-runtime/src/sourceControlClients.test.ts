import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

describe("sourceControlClients", () => {
  // Coder: GitLab is the only shipped host.
  it("reads a missing kind as GitLab and every other kind as the generic one", () => {
    expect(sourceControlClients.get(undefined).kind).toBe("gitlab");
    expect(sourceControlClients.get("github").kind).toBe("unknown");
    expect(sourceControlClients.get("forkhost").kind).toBe("unknown");
  });

  it("claims only GitLab merge request URLs", () => {
    const kindOf = (url: string) => sourceControlClients.findByChangeRequestUrl(url)?.kind;
    expect(kindOf("https://gitlab.example.com/group/sub/app/-/merge_requests/7")).toBe("gitlab");
    expect(kindOf("https://github.com/acme/web/pull/7")).toBeUndefined();
    expect(kindOf("https://codeberg.org/acme/web/pulls/7")).toBeUndefined();
  });
});
