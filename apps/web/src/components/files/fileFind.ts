export interface FileTextMatch {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
}

export interface FileTextMatchesResult {
  readonly matches: ReadonlyArray<FileTextMatch>;
  readonly truncated: boolean;
  readonly regexError: boolean;
}

const MAX_FILE_FIND_MATCHES = 10_000;
const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;

function codePointAt(value: string, index: number): string | undefined {
  const point = value.codePointAt(index);
  return point === undefined ? undefined : String.fromCodePoint(point);
}

function codePointBefore(value: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previous = value.charCodeAt(index - 1);
  return codePointAt(value, previous >= 0xdc00 && previous <= 0xdfff ? index - 2 : index - 1);
}

function isWholeWordRange(contents: string, start: number, end: number): boolean {
  if (end <= start) return false;
  const isWord = (character: string | undefined) =>
    character !== undefined && WORD_CHARACTER.test(character);
  return (
    (start === 0 ||
      !isWord(codePointBefore(contents, start)) ||
      !isWord(codePointAt(contents, start))) &&
    (end >= contents.length ||
      !isWord(codePointAt(contents, end)) ||
      !isWord(codePointBefore(contents, end)))
  );
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findTextMatches(input: {
  readonly contents: string;
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly useRegex: boolean;
}): FileTextMatchesResult {
  if (!input.query) return { matches: [], truncated: false, regexError: false };
  let expression: RegExp;
  try {
    expression = new RegExp(
      input.useRegex ? input.query : escapeRegularExpression(input.query),
      `gu${input.caseSensitive ? "" : "i"}`,
    );
  } catch {
    return { matches: [], truncated: false, regexError: true };
  }

  const lineStarts = [0];
  for (let index = 0; index < input.contents.length; index += 1) {
    if (input.contents[index] === "\n") lineStarts.push(index + 1);
  }
  const positionAt = (offset: number) => {
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle;
    }
    return { line: low, character: offset - lineStarts[low]! };
  };

  const matches: FileTextMatch[] = [];
  for (
    let match = expression.exec(input.contents);
    match;
    match = expression.exec(input.contents)
  ) {
    const start = match.index;
    const end = start + match[0].length;
    if (!input.wholeWord || isWholeWordRange(input.contents, start, end)) {
      if (matches.length >= MAX_FILE_FIND_MATCHES) {
        return { matches, truncated: true, regexError: false };
      }
      matches.push({ start: positionAt(start), end: positionAt(end) });
    }
    if (match[0].length === 0) {
      expression.lastIndex += codePointAt(input.contents, expression.lastIndex)?.length ?? 1;
    }
  }
  return { matches, truncated: false, regexError: false };
}
