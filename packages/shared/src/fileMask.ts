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
  return new RegExp(`${source}$`, "i");
}

export function matchesFileMask(path: string, mask: string): boolean {
  const patterns = mask
    .split(/[;,]/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (patterns.length === 0) return true;
  const normalizedPath = path.replaceAll("\\", "/");
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  return patterns.some((pattern) => {
    const normalizedPattern = pattern.replaceAll("\\", "/");
    return globPatternToRegex(normalizedPattern).test(
      normalizedPattern.includes("/") ? normalizedPath : basename,
    );
  });
}
