export type CoderSettingsPath =
  | "/settings/preferences"
  | "/settings/appearance"
  | "/settings/shortcuts"
  | "/settings/general"
  | "/settings/source-control"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: CoderSettingsPath;
  readonly section: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly targetId?: string;
}

/** Coder-only settings destinations, including individual source-control controls. */
export const SETTINGS_SEARCH_ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "git-fetch-interval",
    title: "Git fetch interval",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["automatic remote branch merge request refresh background seconds off"],
  },
  {
    id: "source-control-writing-style",
    title: "Source control writing style",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: [
      "repository conventions conventional commits custom instructions commit merge request titles descriptions",
    ],
  },
  {
    id: "follow-merge-request-templates",
    title: "Follow merge request templates",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["repository gitlab mr description structure template"],
  },
  {
    id: "source-control-writer-model",
    title: "Source control writer model",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["generated commit branch merge request titles descriptions separate model"],
  },
  {
    id: "reset-source-control-defaults",
    title: "Reset source control defaults",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["restore writing style templates writer model fetch interval"],
  },
  {
    id: "gitlab-workspace-status",
    title: "Workspace GitLab status",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["git glab cli authentication account host installation discovery rescan"],
  },
  {
    id: "gitlab-write-probe",
    title: "GitLab write access probe",
    to: "/settings/source-control",
    section: "GitLab source control",
    searchTerms: ["workspace policy blocked writable authentication reprobe write commands"],
    targetId: "gitlab-workspace-status",
  },
  {
    id: "default-checkout-mode",
    title: "Default checkout mode",
    to: "/settings/preferences",
    section: "New threads",
    searchTerms: ["project checkout worktree new threads workspace"],
  },
  {
    id: "worktrees-from-origin",
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
    id: "auto-settle-inactive-threads",
    title: "Auto-settle inactive threads",
    to: "/settings/preferences",
    section: "Thread settlement",
    searchTerms: ["sidebar inactivity days no activity automatically"],
  },
  {
    id: "auto-settle-merged-threads",
    title: "Auto-settle merged threads",
    to: "/settings/preferences",
    section: "Thread settlement",
    searchTerms: ["gitlab merge request merged closed automatically sidebar"],
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
    title: "Coder connections",
    to: "/settings/general",
    section: "Coder connections",
    searchTerms: ["deployment workspace domain authentication executable path"],
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
