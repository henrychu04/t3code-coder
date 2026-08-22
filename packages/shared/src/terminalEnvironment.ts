export function terminalCwd(input: { projectRoot: string; worktreePath?: string | null }): string {
  return input.worktreePath ?? input.projectRoot;
}

export function terminalRuntimeEnv(input: {
  projectRoot: string;
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  const env: Record<string, string> = { T3CODE_PROJECT_ROOT: input.projectRoot };
  if (input.worktreePath) env.T3CODE_WORKTREE_PATH = input.worktreePath;
  return input.extraEnv ? { ...env, ...input.extraEnv } : env;
}
