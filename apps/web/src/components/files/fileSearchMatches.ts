import type { ProjectEntry } from "@t3tools/contracts";
import { normalizeSearchQuery } from "@t3tools/shared/searchRanking";

export interface FileSearchMatch {
  readonly name: string;
  readonly nameMatchIndices: ReadonlyArray<number>;
  readonly path: string;
  readonly pathMatchIndices: ReadonlyArray<number>;
}

function findMatchIndices(value: string, query: string): number[] | null {
  if (!query) return [];
  const normalizedValue = value.toLowerCase();
  const indices: number[] = [];
  let queryIndex = 0;
  for (let valueIndex = 0; valueIndex < normalizedValue.length; valueIndex += 1) {
    if (normalizedValue[valueIndex] !== query[queryIndex]) continue;
    indices.push(valueIndex);
    queryIndex += 1;
    if (queryIndex === query.length) return indices;
  }
  return null;
}

export function getFileSearchMatches(
  entries: ReadonlyArray<ProjectEntry>,
  rawQuery: string,
): FileSearchMatch[] {
  const query = normalizeSearchQuery(rawQuery, { trimLeadingPattern: /^[@./]+/u }).replaceAll(
    /\s/g,
    "",
  );
  return entries.flatMap((entry) => {
    if (entry.kind !== "file") return [];
    const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
    return [
      {
        name,
        nameMatchIndices: findMatchIndices(name, query) ?? [],
        path: entry.path,
        pathMatchIndices: findMatchIndices(entry.path, query) ?? [],
      },
    ];
  });
}
