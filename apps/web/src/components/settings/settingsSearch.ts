import { DEFAULT_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { KEYBINDING_ACTIONS } from "~/keybindingCatalog";
import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import type { ResolvedSettingsScope } from "./settingsScope";
import { validateSettingsScopeSearch, type SettingsScopeSearch } from "./settingsScope";
export type CoderSettingsPath =
  | "/settings/storage"
  | "/settings/projects"
  | "/settings/providers"
  | "/settings/preferences"
  | "/settings/appearance"
  | "/settings/shortcuts"
  | "/settings/general"
  | "/settings/source-control"
  | "/settings/archived"
  | "/settings/open-source-licenses";

export type SettingsSearchScope =
  | "environment"
  | "environment-defaults"
  | "project-defaults"
  | "project"
  | "checkout"
  | "connections";
export interface SettingsSearchItem {
  readonly scope?: SettingsSearchScope;
  readonly environmentOnly?: boolean;
  readonly id: string;
  readonly title: string;
  readonly to: CoderSettingsPath;
  readonly section: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly targetId?: string;
  /** Command shortcuts sort below the settings they control. */
  readonly secondary?: boolean;
  readonly requiresThreadAutoSettlement?: boolean;
}

/** Coder-only settings destinations, including individual source-control controls. */
export const SETTINGS_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  ...KEYBINDING_ACTIONS.toSorted((left, right) => left.label.localeCompare(right.label)).map(
    (action): SettingsSearchItem => ({
      id: `keybinding-${action.command}`,
      title: action.label,
      to: "/settings/shortcuts",
      section: "Keyboard shortcuts",
      scope: "environment-defaults",
      searchTerms: [
        action.command,
        ...DEFAULT_KEYBINDINGS.filter((binding) => binding.command === action.command).map(
          (binding) => binding.key,
        ),
      ],
      secondary: true,
    }),
  ),
  {
    id: "storage-cleanup",
    title: "Storage cleanup",
    to: "/settings/storage",
    section: "Storage",
    searchTerms: ["worktrees artifacts retention logs cleanup"],
  },
  {
    id: "plan-mode",
    title: "Plan mode",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["Build Plan shift tab workflow"],
  },
  {
    id: "context-window-indicator",
    title: "Context window indicator",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["tokens composer meter usage"],
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    scope: "environment-defaults",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["folder directory home"],
  },
  {
    id: "environment-icon",
    title: "Workspace icon",
    scope: "environment-defaults",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["machine cloud identity"],
  },
  {
    id: "background-activity",
    title: "Background activity",
    scope: "environment-defaults",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["scheduling profile balanced performance battery saver git polling"],
  },
  {
    id: "provider-health-check-interval",
    title: "Provider health check interval",
    scope: "environment-defaults",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["poll refresh seconds"],
  },
  {
    id: "continue-threads-after-server-update",
    title: "Continue threads after restarts",
    scope: "environment-defaults",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["recovery resume crash helper"],
  },
  {
    id: "thread-notifications",
    title: "System notifications",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["sound alerts browser permissions"],
  },
  {
    id: "default-project-actions",
    scope: "environment-defaults",
    title: "Default actions",
    to: "/settings/preferences",
    section: "General",
    searchTerms: ["workspace default scripts commands inherited actions"],
  },
  {
    id: "custom-themes",
    title: "Create and edit custom themes",
    to: "/settings/appearance",
    section: "Appearance",
    searchTerms: ["colors palette accent canvas custom theme"],
  },
  {
    id: "projects",
    scope: "project",
    targetId: "project-overview",
    title: "Projects and actions",
    to: "/settings/projects",
    section: "Projects",
    searchTerms: ["name rename scripts commands checkouts remove"],
  },
  {
    id: "providers",
    scope: "environment",
    environmentOnly: true,
    title: "Provider configuration and models",
    to: "/settings/providers",
    section: "Providers",
    searchTerms: ["codex claude api models authentication"],
  },
  {
    id: "default-model",
    scope: "project-defaults",
    title: "Default model",
    to: "/settings/preferences",
    section: "New threads",
    searchTerms: ["new thread model inherit"],
  },
  {
    id: "automatic-pull",
    scope: "project-defaults",
    title: "Automatically pull",
    to: "/settings/source-control",
    section: "Repositories",
    searchTerms: ["default branch clean checkout fast forward"],
  },

  {
    id: "notifications",
    title: "Thread notifications and sounds",
    to: "/settings/preferences",
    section: "Notifications",
    targetId: "notifications",
    searchTerms: ["alert sound badge completed input approval"],
  },
  {
    id: "open-source-licenses",
    title: "Open source licenses",
    to: "/settings/open-source-licenses",
    section: "About",
    searchTerms: ["third party notices attribution dependencies"],
  },
  {
    id: "restore-client-defaults",
    title: "Restore browser preferences",
    to: "/settings/preferences",
    section: "Defaults",
    searchTerms: ["reset appearance interface"],
  },
  {
    id: "restore-workspace-defaults",
    scope: "environment-defaults",
    title: "Restore workspace preferences",
    to: "/settings/preferences",
    section: "Defaults",
    searchTerms: ["reset general source control"],
  },
  {
    id: "skills-in-slash-menu",
    title: "Skills in slash menu",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["slash commands dollar skills picker"],
  },
  {
    id: "panel-animations",
    title: "Panel animations",
    to: "/settings/appearance",
    section: "Motion",
    searchTerms: ["duration transition reduced motion"],
  },
  {
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
    section: "Appearance",
    searchTerms: ["bundled palette light dark variants"],
  },

  {
    id: "git-fetch-interval",
    scope: "environment-defaults",
    title: "Git fetch interval",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["automatic remote branch merge request refresh background seconds off"],
  },
  {
    id: "source-control-writing-style",
    scope: "project-defaults",
    title: "Source control writing style",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: [
      "repository conventions conventional commits custom instructions commit merge request titles descriptions",
    ],
  },
  {
    id: "follow-merge-request-templates",
    scope: "project-defaults",
    title: "Follow merge request templates",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["repository gitlab mr description structure template"],
  },
  {
    id: "source-control-writer-model",
    scope: "project-defaults",
    title: "Source control writer model",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["generated commit branch merge request titles descriptions separate model"],
  },
  {
    id: "reset-source-control-defaults",
    scope: "environment-defaults",
    title: "Reset source control defaults",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["restore writing style templates writer model fetch interval"],
  },
  {
    id: "gitlab-workspace-status",
    scope: "environment",
    environmentOnly: true,
    title: "Workspace GitLab status",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["git glab cli authentication account host installation discovery rescan"],
  },
  {
    id: "gitlab-write-probe",
    scope: "environment",
    environmentOnly: true,
    title: "GitLab write access probe",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["workspace policy blocked writable authentication reprobe write commands"],
    targetId: "gitlab-workspace-status",
  },
  {
    id: "default-checkout-mode",
    scope: "project-defaults",
    title: "Default checkout mode",
    to: "/settings/preferences",
    section: "New threads",
    searchTerms: ["project checkout worktree new threads workspace"],
  },
  {
    id: "worktrees-from-origin",
    scope: "project-defaults",
    title: "Start worktrees from origin",
    to: "/settings/preferences",
    section: "New threads",
    searchTerms: ["remote tracking branch local base"],
  },
  {
    id: "project-grouping",
    title: "Group projects",
    to: "/settings/preferences",
    section: "Sidebar",
    searchTerms: ["repository path separate checkouts sidebar"],
  },
  {
    id: "project-order",
    title: "Project order",
    to: "/settings/preferences",
    section: "Sidebar",
    searchTerms: ["recent activity added manual sort sidebar"],
  },
  {
    id: "thread-order",
    title: "Thread order",
    to: "/settings/preferences",
    section: "Sidebar",
    searchTerms: ["recent activity created sort sidebar"],
  },
  {
    id: "visible-threads-per-project",
    title: "Visible threads per project",
    to: "/settings/preferences",
    section: "Sidebar",
    searchTerms: ["preview count expand sidebar"],
  },
  {
    requiresThreadAutoSettlement: true,
    id: "auto-settle-inactive-threads",
    scope: "project-defaults",
    title: "Auto-settle inactive threads",
    to: "/settings/preferences",
    section: "Thread settlement",
    searchTerms: ["sidebar inactivity days no activity automatically"],
  },
  {
    requiresThreadAutoSettlement: true,
    id: "auto-settle-merged-threads",
    scope: "project-defaults",
    title: "Auto-settle merged threads",
    to: "/settings/preferences",
    section: "Thread settlement",
    searchTerms: ["gitlab merge request merged closed automatically sidebar"],
  },
  {
    id: "proactive-panels",
    title: "Proactive panels",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["automatic merge request diff completed turn panel"],
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["timestamp locale 12 hour 24 hour clock"],
  },
  {
    id: "diff-layout",
    title: "Diff layout",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["stacked split side by side review"],
  },
  {
    id: "wrap-long-lines",
    title: "Wrap long lines",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["diff file view word wrap overflow"],
  },
  {
    id: "ignore-diff-whitespace",
    title: "Ignore whitespace in diffs",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["review changes spacing diff"],
  },
  {
    id: "confirm-thread-unpin",
    title: "Confirm before unpinning",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["thread confirmation pinned sidebar"],
  },
  {
    id: "confirm-thread-archive",
    title: "Confirm before archiving",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["thread confirmation history hide"],
  },
  {
    id: "confirm-thread-delete",
    title: "Confirm before deleting",
    to: "/settings/preferences",
    section: "Editor and history",
    searchTerms: ["thread confirmation destructive remove"],
  },
  {
    id: "coder-connections",
    scope: "connections",
    title: "Coder connections",
    to: "/settings/general",
    section: "Coder connections",
    searchTerms: ["deployment workspace domain authentication executable path"],
  },
  {
    id: "coder-workspaces",
    scope: "connections",
    title: "Workspace connections",
    to: "/settings/general",
    section: "Coder connections",
    searchTerms: ["start stop restart update reconnect workspace diagnostics status"],
  },
  {
    id: "port-forwarding",
    scope: "connections",
    title: "Port forwarding",
    to: "/settings/general",
    section: "Coder connections",
    searchTerms: ["ports tcp udp localhost loopback forward local remote restart"],
  },
  {
    id: "color-mode",
    title: "Color mode",
    to: "/settings/appearance",
    section: "Appearance",
    searchTerms: ["theme system light dark interface"],
  },
  {
    id: "appearance-contrast",
    title: "Contrast",
    to: "/settings/appearance",
    section: "Appearance",
    searchTerms: ["colors borders accessibility interface"],
  },
  {
    id: "glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
    section: "Appearance",
    searchTerms: ["menus dialogs composer transparency"],
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    section: "Appearance",
    searchTerms: ["workspace artwork version pill marker"],
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
    section: "Appearance",
    searchTerms: ["macos grayscale thinner text"],
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
    section: "Typography",
    searchTerms: ["family size sans ui"],
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
    section: "Typography",
    searchTerms: ["family size composer input"],
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
    section: "Typography",
    searchTerms: ["family size monospace diff files"],
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
    section: "Typography",
    searchTerms: ["family size monospace shell"],
  },
  {
    id: "keyboard-shortcuts",
    scope: "environment-defaults",
    title: "Keyboard shortcuts",
    to: "/settings/shortcuts",
    section: "Keyboard shortcuts",
    searchTerms: ["keybindings hotkeys commands bindings json"],
  },
  {
    id: "archived-threads",
    title: "Archived threads",
    to: "/settings/archived",
    section: "Archived threads",
    searchTerms: ["archive restore deleted hidden conversations"],
  },
];

export const SETTINGS_SECTION_LABELS: Readonly<Record<CoderSettingsPath, string>> = {
  "/settings/storage": "Storage",
  "/settings/preferences": "General",
  "/settings/appearance": "Appearance",
  "/settings/shortcuts": "Keyboard shortcuts",
  "/settings/projects": "Projects",
  "/settings/providers": "Providers",
  "/settings/general": "Coder connections",
  "/settings/source-control": "GitLab source control",
  "/settings/open-source-licenses": "Open source licenses",
  "/settings/archived": "Archived threads",
};

function normalizeSearchText(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];
  const queryTokens = normalizedQuery.split(" ");

  return items
    .flatMap((item, index) => {
      const title = normalizeSearchText(item.title);
      const fields = [
        title,
        normalizeSearchText(SETTINGS_SECTION_LABELS[item.to]),
        ...(item.searchTerms ?? []).map(normalizeSearchText),
      ];
      if (!queryTokens.every((token) => fields.some((field) => field.includes(token)))) return [];

      const exactPhraseField = fields.findIndex((field) => field.includes(normalizedQuery));
      const rank =
        title === normalizedQuery
          ? 5
          : title.startsWith(normalizedQuery)
            ? 4
            : title.includes(normalizedQuery)
              ? 3
              : queryTokens.every((token) => title.includes(token))
                ? 2
                : exactPhraseField >= 0
                  ? 1
                  : 0;
      return [{ item, index, rank }];
    })
    .toSorted(
      (left, right) =>
        Number(left.item.secondary ?? false) - Number(right.item.secondary ?? false) ||
        right.rank - left.rank ||
        left.index - right.index,
    )
    .map(({ item }) => item);
}

export function isSettingsOverviewVisible(search: SettingsScopeSearch): boolean {
  const target = validateSettingsScopeSearch({ ...search });
  return Boolean(target.project);
}
export function filterAvailableSettingsSearchItems(availability: {
  hasThreadAutoSettlement: boolean;
  hasEnvironment?: boolean;
}): readonly SettingsSearchItem[] {
  return SETTINGS_SEARCH_ITEMS.filter(
    (item) =>
      (!item.requiresThreadAutoSettlement || availability.hasThreadAutoSettlement) &&
      (!item.environmentOnly || availability.hasEnvironment !== false),
  );
}

export function getSettingsSearchTargetScope(targetId: string) {
  const items: readonly SettingsSearchItem[] = SETTINGS_SEARCH_ITEMS;
  const item =
    items.find((candidate) => candidate.id === targetId) ??
    items.find((candidate) => candidate.targetId === targetId);
  return item
    ? {
        title: item.title,
        scope: item.scope ?? null,
        ...(item.requiresThreadAutoSettlement ? { requiresThreadAutoSettlement: true } : {}),
      }
    : null;
}

interface AutoSettlementSearchEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly environment: {
      readonly capabilities: { readonly threadAutoSettlement?: boolean };
    };
  } | null;
}

/** Discovery needs one capable environment; the selected page needs every connected target to support it. */
export function getThreadAutoSettlementSearchAvailability(
  environments: readonly AutoSettlementSearchEnvironment[],
  scope?: Pick<ResolvedSettingsScope, "kind" | "environmentIds">,
) {
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  const eligibleEnvironmentIds = connected
    .filter(
      (environment) =>
        environment.serverConfig?.environment.capabilities.threadAutoSettlement === true,
    )
    .map((environment) => environment.environmentId);
  const selected = connected.filter((environment) =>
    scope?.environmentIds.includes(environment.environmentId),
  );
  return {
    eligibleEnvironmentIds,
    isTargetAvailable:
      scope !== undefined &&
      scope.kind !== "unavailable" &&
      selected.length > 0 &&
      selected.every((environment) => eligibleEnvironmentIds.includes(environment.environmentId)),
  };
}

export function isSettingsSearchScopeAvailable(
  requiredScope: SettingsSearchScope | null,
  scopeKind: ResolvedSettingsScope["kind"],
): boolean {
  switch (requiredScope) {
    case null:
    case "connections":
      return true;
    case "environment":
    case "checkout":
      return requiredScope === scopeKind;
    case "project":
      return scopeKind === "project" || scopeKind === "checkout";
    case "environment-defaults":
      return scopeKind === "environment" || scopeKind === "all";
    case "project-defaults":
      return (
        scopeKind === "environment" ||
        scopeKind === "all" ||
        scopeKind === "project" ||
        scopeKind === "checkout"
      );
  }
}
