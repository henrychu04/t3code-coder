/**
 * Where upstream keeps pull-request list and detail snapshots so a reopened page renders at once.
 * Coder keeps merge-request content out of browser storage, so the snapshots live in memory for
 * the page session only.
 */
const entries = new Map<string, string>();

export const pullRequestSnapshotStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => {
    entries.set(key, value);
  },
};
