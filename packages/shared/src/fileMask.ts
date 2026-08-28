function escapeRegexCharacter(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function globPatternToRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegexCharacter(character);
  }
  return new RegExp(`${source}$`, "u");
}

export interface FileMaskPatterns {
  readonly includes: ReadonlyArray<string>;
  readonly excludes: ReadonlyArray<string>;
}

export function parseFileMask(mask: string): FileMaskPatterns {
  const includes: string[] = [];
  const excludes: string[] = [];
  const patterns = mask
    .split(/[;,]/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  for (const pattern of patterns) {
    if (pattern.startsWith("!") && pattern.length > 1) {
      excludes.push(pattern.slice(1));
    } else {
      includes.push(pattern);
    }
  }
  return { includes, excludes };
}

export function matchesFileMask(path: string, mask: string): boolean {
  const { includes, excludes } = parseFileMask(mask);
  if (includes.length === 0 && excludes.length === 0) return true;

  // IntelliJ file masks apply to file names, not project-relative paths.
  const normalizedPath = path.replaceAll("\\", "/");
  const fileName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const matches = (pattern: string) => globPatternToRegex(pattern).test(fileName);
  return (includes.length === 0 || includes.some(matches)) && !excludes.some(matches);
}
