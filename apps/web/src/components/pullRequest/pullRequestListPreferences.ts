import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ProjectId,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
} from "@t3tools/contracts";

export const PullRequestListSort = Schema.Literals([
  "ready",
  "updated",
  "newest",
  "oldest",
  "largest",
  "smallest",
]);
export type PullRequestListSort = typeof PullRequestListSort.Type;

export interface PullRequestListPreferences {
  readonly involvement: PullRequestInvolvement;
  readonly state: PullRequestListState;
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly host?: string;
  readonly q?: string;
  readonly draft?: "only" | "hide";
  readonly review?: NonNullable<PullRequestListFilters["review"]>;
  readonly checks?: NonNullable<PullRequestListFilters["checks"]>;
  readonly author?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly sort?: PullRequestListSort;
}

export type PullRequestListPreferencePatch = {
  [Key in keyof PullRequestListPreferences]?: PullRequestListPreferences[Key] | undefined;
};

export const DEFAULT_PULL_REQUEST_LIST_PREFERENCES = {
  involvement: "all",
  state: "open",
} as const satisfies PullRequestListPreferences;

const PullRequestListPreferencesSchema = Schema.Struct({
  involvement: PullRequestInvolvement,
  state: PullRequestListState,
  draft: PullRequestListFilters.fields.draft,
  review: PullRequestListFilters.fields.review,
  checks: PullRequestListFilters.fields.checks,
  sort: Schema.optional(PullRequestListSort),
});

const decodePullRequestListPreferences = Schema.decodeUnknownOption(
  PullRequestListPreferencesSchema,
);
const PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY = "t3.pullRequests.preferences";
type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function resolvePreferenceStorage(
  storage: PreferenceStorage | undefined,
): PreferenceStorage | undefined {
  return storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
}

/** Remember presentation controls only, never repository identities or user-entered content. */
export function pullRequestListPreferences(
  search: PullRequestListPreferences | Schema.Schema.Type<typeof PullRequestListPreferencesSchema>,
): PullRequestListPreferences {
  return {
    involvement: search.involvement,
    state: search.state,
    ...(search.draft ? { draft: search.draft } : {}),
    ...(search.review ? { review: search.review } : {}),
    ...(search.checks ? { checks: search.checks } : {}),
    ...(search.sort && search.sort !== "ready" ? { sort: search.sort } : {}),
  };
}

export function readPullRequestListPreferences(
  storage?: PreferenceStorage,
): PullRequestListPreferences {
  try {
    const raw = resolvePreferenceStorage(storage)?.getItem(
      PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY,
    );
    if (!raw) return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    let decoded;
    try {
      decoded = decodePullRequestListPreferences(JSON.parse(raw));
    } catch {
      decoded = undefined;
    }
    const preferences =
      decoded?._tag === "Some"
        ? pullRequestListPreferences(decoded.value)
        : DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
    // Migrate the old key in place so previously saved search content is removed.
    writePullRequestListPreferences(preferences, storage);
    return preferences;
  } catch {
    return DEFAULT_PULL_REQUEST_LIST_PREFERENCES;
  }
}

/** Explicit URL controls win as a set; otherwise restore only presentation defaults. */
export function restorePullRequestListPreferences(
  search: Record<string, unknown>,
  storage?: PreferenceStorage,
): Record<string, unknown> {
  if (
    Object.keys(PullRequestListPreferencesSchema.fields).some((key) => search[key] !== undefined)
  ) {
    return search;
  }
  return { ...readPullRequestListPreferences(storage), ...search };
}

export function writePullRequestListPreferences(
  preferences: PullRequestListPreferences,
  storage?: PreferenceStorage,
): void {
  try {
    resolvePreferenceStorage(storage)?.setItem(
      PULL_REQUEST_LIST_PREFERENCES_STORAGE_KEY,
      JSON.stringify(pullRequestListPreferences(preferences)),
    );
  } catch {
    // Storage can be full or denied; the URL remains the source of truth for this visit.
  }
}
