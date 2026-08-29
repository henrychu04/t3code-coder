import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";

export const conventionalCommitsTextGenerationPolicy: TextGenerationPolicy = {
  commitInstructions:
    "Use Conventional Commits. Prefer the narrowest accurate type and include a scope only when it is obvious from the diff.",
  changeRequestInstructions:
    "Keep the merge request title concise. Do not force Conventional Commit syntax into it unless the repository already uses it.",
};

export const repositoryConventionsTextGenerationPolicy: TextGenerationPolicy = {
  commitInstructions: "Follow the repository's established commit message style.",
  changeRequestInstructions: "Follow the repository's established merge request title and body style.",
};

export const customTextGenerationPolicy = (
  instructions: string,
): TextGenerationPolicy => ({
  commitInstructions: instructions,
  changeRequestInstructions: instructions,
});
