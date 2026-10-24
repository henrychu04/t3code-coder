// Coder: upstream's cases for the GitLab-only registry. Other hosts' URLs, remotes, and repository
// spellings are no host's, so their upstream cases are not carried.
import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "./sourceControlClients.ts";

const parse = (url: string) => {
  const parsed = sourceControlClients.parseChangeRequestUrl(url);
  if (parsed === null) return null;
  const { repositoryUrl: _repositoryUrl, ...link } = parsed.link;
  return link;
};
const kindOf = (url: string) => sourceControlClients.parseChangeRequestUrl(url)?.definition.kind;

describe("sourceControlClients.parseChangeRequestUrl", () => {
  it("reads a GitLab merge request on any host, nested groups and all", () => {
    expect(parse("https://gitlab.com/t3tools/platform/t3code/-/merge_requests/42")).toEqual({
      host: "gitlab.com",
      repository: "t3tools/platform/t3code",
      number: 42,
    });
    expect(parse("https://code.acme.test/team/project/-/merge_requests/9")).toEqual({
      host: "code.acme.test",
      repository: "team/project",
      number: 9,
    });
    expect(kindOf("https://code.acme.test/team/project/-/merge_requests/9")).toBe("gitlab");
  });

  it("survives trailing segments, a trailing slash and a query string", () => {
    expect(parse("https://gitlab.com/t3tools/t3code/-/merge_requests/123/diffs?w=1")).toEqual({
      host: "gitlab.com",
      repository: "t3tools/t3code",
      number: 123,
    });
    expect(parse("https://gitlab.com/t3tools/t3code/-/merge_requests/123/")).toEqual({
      host: "gitlab.com",
      repository: "t3tools/t3code",
      number: 123,
    });
  });

  // Coder: links persist their URL verbatim.
  it("rejects URLs that carry credentials", () => {
    expect(parse("https://user:secret@gitlab.com/team/repo/-/merge_requests/1")).toBeNull();
    expect(parse("https://token@gitlab.example/team/repo/-/merge_requests/1")).toBeNull();
  });

  it("claims nothing it cannot be sure of, including other hosts' pull requests", () => {
    for (const link of [
      "https://github.com/t3tools/t3code/pull/123",
      "https://git.cafe/pingdotgg/t3code/pull/23897",
      "https://codeberg.org/team/repo/pulls/7",
      "https://bitbucket.org/workspace/repo/pull-requests/5",
      "https://dev.azure.com/acme/platform/_git/t3code/pullrequest/17",
      "https://gitlab.com/t3tools/t3code/-/issues/12",
      "https://gitlab.com/t3tools/t3code/-/merge_requests/abc",
      "https://gitlab.com/t3tools/t3code",
      "ftp://gitlab.com/t3tools/t3code/-/merge_requests/1",
      "javascript:alert(1)//gitlab.com/t3tools/t3code/-/merge_requests/1",
      "not a url",
    ]) {
      expect(parse(link), link).toBeNull();
    }
  });
});

describe("sourceControlClients.isSameChangeRequest", () => {
  const linked = "https://gitlab.com/pingdotgg/t3code/-/merge_requests/42";

  it("matches the same merge request whatever its case or trailing path", () => {
    expect(
      sourceControlClients.isSameChangeRequest(
        linked,
        "https://gitlab.com/PingDotGG/T3Code/-/merge_requests/42/diffs",
      ),
    ).toBe(true);
    expect(
      sourceControlClients.isSameChangeRequest(
        linked,
        "https://gitlab.com/pingdotgg/t3code/-/merge_requests/43",
      ),
    ).toBe(false);
  });
});

describe("change request URLs built from a parsed link", () => {
  it("builds a canonical sibling below the parsed repository", () => {
    const parsed = sourceControlClients.parseChangeRequestUrl(
      "https://code.example/group/nested/project/-/merge_requests/42/diffs",
    )!;
    expect(
      parsed.definition.changeRequestUrl({
        host: parsed.link.host,
        repository: parsed.link.repository,
        number: 43,
        webUrl: parsed.link.repositoryUrl,
      }),
    ).toBe("https://code.example/group/nested/project/-/merge_requests/43");
  });
});

describe("sourceControlClients.recognizeRemote", () => {
  const kindOfRemote = (url: string) => sourceControlClients.recognizeRemote(url)?.kind ?? null;

  it("recognises GitLab remotes, self-hosted ones included", () => {
    expect(kindOfRemote("git@gitlab.com:team/project.git")).toBe("gitlab");
    expect(kindOfRemote("https://gitlab.company.com/team/project.git")).toBe("gitlab");
    expect(kindOfRemote("https://github.com/o/r")).toBe("unknown");
  });

  it("reads a remote no host claims as an unknown host, and a local path as no host", () => {
    expect(
      sourceControlClients.recognizeRemote("https://self-hosted.example.test:8443/group/repo.git"),
    ).toEqual({
      kind: "unknown",
      name: "self-hosted.example.test:8443",
      baseUrl: "https://self-hosted.example.test:8443",
    });
    for (const local of ["/srv/git/repo.git", "C:/repos/project", "file:///srv/git/repo.git", ""]) {
      expect(sourceControlClients.recognizeRemote(local), local).toBeNull();
    }
  });
});

describe("sourceControlClients repository keys", () => {
  // Persisted as `repositoryIdentity.canonicalKey` and in thread pull request keys.
  it.each([
    ["git@github.com:T3Tools/T3Code.git", "github.com/t3tools/t3code"],
    ["ssh://git@gitlab.company.com:2222/team/project.git", "gitlab.company.com/team/project"],
    ["C:/repos/project", "c:/repos/project"],
  ])("keys %s as %s", (remote, key) => {
    expect(sourceControlClients.repositoryKeyFromRemote(remote)).toBe(key);
  });
});

describe("sourceControlClients project hosts", () => {
  const identity = {
    canonicalKey: "forge.example/team/repo",
    locator: { remoteUrl: "http://forge.example:3000/team/repo.git" },
  };

  it("names the project host from its key, and falls back to the kind without a key", () => {
    expect(sourceControlClients.changeRequestHost(identity, "gitlab")).toBe("forge.example");
    expect(sourceControlClients.changeRequestHost(identity, undefined)).toBe("forge.example");
    expect(
      sourceControlClients.changeRequestHost(
        { locator: { remoteUrl: "https://x.example/a/b" } },
        "gitlab",
      ),
    ).toBe("gitlab");
  });

  it("selects a repository by its whole path", () => {
    const repository = {
      displayName: "group/subgroup/service",
      owner: "group",
      name: "service",
    };
    expect(sourceControlClients.repositorySelector(repository)).toBe("group/subgroup/service");
    expect(
      sourceControlClients.repositorySelector({
        ...repository,
        provider: SourceControlProviderKind.make("gitlab"),
      }),
    ).toBe("group/subgroup/service");
    expect(sourceControlClients.repositorySelector({ owner: "o", name: "r" })).toBe("o/r");
  });
});

describe("sourceControlClients.findByPublicDomain", () => {
  it("names the host a link is on, subdomains included", () => {
    const kindOf = (hostname: string) => sourceControlClients.findByPublicDomain(hostname)?.kind;
    expect(kindOf("GitLab.com")).toBe("gitlab");
    expect(kindOf("docs.gitlab.com")).toBe("gitlab");
    expect(kindOf("gist.github.com")).toBeUndefined();
    expect(kindOf("gitlab.com.example")).toBeUndefined();
  });
});
