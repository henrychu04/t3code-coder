import { expect, it } from "vite-plus/test";

import { findTextMatches } from "./fileFind";

it("supports regex and reports invalid expressions", () => {
  expect(
    findTextMatches({
      contents: "foo1 foo2",
      query: "foo\\d",
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
    }).matches,
  ).toHaveLength(2);
  expect(
    findTextMatches({
      contents: "foo",
      query: "(",
      caseSensitive: true,
      wholeWord: false,
      useRegex: true,
    }).regexError,
  ).toBe(true);
});

it("uses Unicode-aware whole-word boundaries", () => {
  const result = findTextMatches({
    contents: "note notes dénote note",
    query: "note",
    caseSensitive: true,
    wholeWord: true,
    useRegex: false,
  });
  expect(result.matches).toHaveLength(2);
});

it("marks the 10,000 result cap", () => {
  const result = findTextMatches({
    contents: "x ".repeat(10_001),
    query: "x",
    caseSensitive: true,
    wholeWord: false,
    useRegex: false,
  });
  expect(result.matches).toHaveLength(10_000);
  expect(result.truncated).toBe(true);
});
