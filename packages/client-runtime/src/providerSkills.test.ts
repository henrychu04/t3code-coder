import { describe, expect, it } from "vite-plus/test";

import {
  dedupeProviderSkillsByName,
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  resolveProviderSkillSourceKind,
} from "./providerSkills.ts";

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("dedupeProviderSkillsByName", () => {
  it("keeps the first resolved skill and preserves unrelated skill order", () => {
    const firstSkill = {
      name: "branch-audit",
      path: "/home/dev/.codex/skills/branch-audit/SKILL.md",
      enabled: true,
    };
    const otherSkill = {
      name: "browser",
      path: "/home/dev/.agents/skills/browser/SKILL.md",
      enabled: true,
    };
    const duplicateSkill = {
      name: "Branch-Audit",
      path: "/home/dev/.agents/skills/branch-audit/SKILL.md",
      enabled: true,
    };

    expect(dedupeProviderSkillsByName([firstSkill, otherSkill, duplicateSkill])).toEqual([
      firstSkill,
      otherSkill,
    ]);
  });
});

describe("provider slash menu collisions", () => {
  const skills = [
    { name: "review", path: "/home/dev/.claude/skills/review/SKILL.md", enabled: true },
  ];

  it("lets the enabled skill alias win over a same-named provider command", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills);
    expect(
      getProviderSlashCommandsForSlashMenu(
        [
          { name: "review", description: "Review changes" },
          { name: "compact", description: "Compact context" },
        ],
        visibleSkills,
      ).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("matches names case-insensitively after trimming", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(
        [
          { name: " REVIEW ", description: "Review changes" },
          { name: "compact", description: "Compact context" },
        ],
        getProviderSkillsForSlashMenu(skills),
      ).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the colliding skill is disabled", () => {
    const disabledSkills = skills.map((skill) => ({ ...skill, enabled: false }));
    expect(getProviderSkillsForSlashMenu(disabledSkills)).toEqual([]);
    expect(
      getProviderSlashCommandsForSlashMenu(
        [{ name: "review", description: "Review changes" }],
        getProviderSkillsForSlashMenu(disabledSkills),
      ).map((command) => command.name),
    ).toEqual(["review"]);
  });

  it("shows one row when enabled skills share a name", () => {
    expect(
      getProviderSkillsForSlashMenu([
        {
          name: "branch-audit",
          path: "/home/dev/.codex/skills/branch-audit/SKILL.md",
          enabled: true,
        },
        {
          name: "browser",
          path: "/home/dev/.agents/skills/browser/SKILL.md",
          enabled: true,
        },
        {
          name: "branch-audit",
          path: "/home/dev/.agents/skills/branch-audit/SKILL.md",
          enabled: true,
        },
      ]).map((skill) => skill.name),
    ).toEqual(["branch-audit", "browser"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    for (const path of [
      "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
      "/Users/julius/.claude/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
      "/Users/julius/.agents/plugins/github/skills/gh-fix-ci/SKILL.md",
    ]) {
      expect(resolveProviderSkillSourceKind({ path, scope: "user" })).toBe("app");
    }
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});
