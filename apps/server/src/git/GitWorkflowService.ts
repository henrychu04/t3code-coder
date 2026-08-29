import type {
  ChangeRequest,
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitManagerServiceError,
  GitPullRequestRefInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  SourceControlProviderError,
  ServerSettings as ServerSettingsValue,
  VcsCreateRefInput,
  VcsCreateRefResult,
  VcsCreateWorktreeInput,
  VcsCreateWorktreeResult,
  VcsListRefsInput,
  VcsListRefsResult,
  VcsRemoveWorktreeInput,
  VcsRefStatusResult,
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsPullInput,
  VcsPullResult,
  VcsSwitchRefInput,
  VcsSwitchRefResult,
} from "@t3tools/contracts";
import { GitCommandError, GitManagerError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  detectSourceControlProviderFromGitRemoteUrl,
  mergeGitStatusParts,
  resolveAutoFeatureBranchName,
  sanitizeBranchFragment,
} from "@t3tools/shared/git";
import { resolveSourceControlWriterModelSelection } from "@t3tools/shared/serverSettings";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { detectPrTemplate } from "../sourceControl/PrTemplateDetection.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  conventionalCommitsTextGenerationPolicy,
  customTextGenerationPolicy,
  repositoryConventionsTextGenerationPolicy,
} from "../textGeneration/TextGenerationPresets.ts";

export interface GitActionProgressReporter {
  readonly publish: (event: GitActionProgressEvent) => Effect.Effect<void, never>;
}

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  {
    readonly localStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsStatusLocalResult, GitCommandError>;
    readonly remoteStatus: (
      input: VcsStatusInput,
      options?: { readonly fetch?: boolean },
    ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
    readonly status: (
      input: VcsStatusInput,
      options?: { readonly fetch?: boolean },
    ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
    readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
    readonly pull: (input: VcsPullInput) => Effect.Effect<VcsPullResult, GitCommandError>;
    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      progressReporter?: GitActionProgressReporter,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
    readonly localRefStatus: (
      input: VcsStatusInput,
    ) => Effect.Effect<VcsRefStatusResult, GitCommandError>;
    readonly listRefs: (
      input: VcsListRefsInput,
    ) => Effect.Effect<VcsListRefsResult, GitCommandError>;
    readonly createWorktree: (
      input: VcsCreateWorktreeInput,
    ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
    readonly removeWorktree: (
      input: VcsRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;
    readonly pruneWorktrees: (input: {
      readonly cwd: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly createRef: (
      input: VcsCreateRefInput,
    ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
    readonly switchRef: (
      input: VcsSwitchRefInput,
    ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
    readonly renameBranch: (input: {
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.Effect<{ readonly branch: string }, GitCommandError>;
    readonly moveWorktree: (input: {
      readonly cwd: string;
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<void, GitCommandError>;
    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<
      GitPreparePullRequestThreadResult,
      GitCommandError | GitManagerError | SourceControlProviderError
    >;
  }
>()("t3/git/GitWorkflowService") {}

export const layer = Layer.effect(
  GitWorkflowService,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const sourceControls = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const textGeneration = yield* Effect.serviceOption(TextGeneration.TextGeneration);
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const projectSetupScriptRunner = yield* Effect.serviceOption(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
    );
    const readGenerationSettings = (cwd: string) =>
      Option.isSome(serverSettings)
        ? serverSettings.value.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new GitManagerError({
                  operation: "readGenerationSettings",
                  cwd,
                  detail: "Could not read text-generation settings.",
                  cause,
                }),
            ),
          )
        : Effect.succeed(null);
    const resolveWritingPolicy = Effect.fn("GitWorkflowService.resolveWritingPolicy")(function* (
      cwd: string,
      settings: ServerSettingsValue,
    ) {
      const style = settings.sourceControlWritingStyle;
      if (style.mode === "conventional_commits") {
        return conventionalCommitsTextGenerationPolicy;
      }
      if (style.mode === "custom") {
        return customTextGenerationPolicy(style.customInstructions);
      }
      const recent = yield* git.execute({
        operation: "GitWorkflowService.resolveWritingPolicy.recentCommits",
        cwd,
        args: ["log", "-20", "--pretty=%s"],
        allowNonZeroExit: true,
        maxOutputBytes: 16 * 1024,
      });
      const examples = recent.stdout.trim();
      return examples
        ? {
            ...repositoryConventionsTextGenerationPolicy,
            commitInstructions: `${repositoryConventionsTextGenerationPolicy.commitInstructions}\n\nRecent commit subjects:\n${examples}`,
          }
        : repositoryConventionsTextGenerationPolicy;
    });

    const parseCount = (value: string): number => {
      const count = Number.parseInt(value.trim(), 10);
      return Number.isSafeInteger(count) && count >= 0 ? count : 0;
    };

    const STATUS_CACHE_TTL = Duration.seconds(1);
    const STATUS_CACHE_CAPACITY = 2_048;
    const FETCH_CACHE_TTL = Duration.seconds(1);
    const PR_CACHE_TTL = Duration.minutes(2);
    const FAILURE_BASE_TTL = Duration.seconds(20);
    const FAILURE_MAX_TTL = Duration.minutes(15);
    const failureTtl = (failures: number) =>
      Duration.min(
        Duration.millis(
          Duration.toMillis(FAILURE_BASE_TTL) * Math.pow(2, Math.max(0, failures - 1)),
        ),
        FAILURE_MAX_TTL,
      );
    const setBounded = <K, V>(map: Map<K, V>, key: K, value: V) => {
      if (!map.has(key) && map.size >= STATUS_CACHE_CAPACITY) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
      map.set(key, value);
    };

    const readLocalStatus = Effect.fn("GitWorkflowService.readLocalStatus")(function* ({
      cwd,
    }: VcsStatusInput) {
      const details = yield* git.statusDetailsLocal(cwd);
      if (!details.isRepo) {
        return {
          isRepo: false,
          hasPrimaryRemote: false,
          isDefaultRef: false,
          refName: null,
          hasWorkingTreeChanges: false,
          workingTree: details.workingTree,
        } satisfies VcsStatusLocalResult;
      }
      const remote = yield* git.execute({
        operation: "GitWorkflowService.localStatus.remote",
        cwd,
        args: ["remote", "get-url", "origin"],
        allowNonZeroExit: true,
      });
      const remoteUrl = remote.exitCode === 0 ? remote.stdout.trim() : "";
      const sourceControlProvider = remoteUrl
        ? detectSourceControlProviderFromGitRemoteUrl(remoteUrl)
        : null;
      return {
        isRepo: true,
        ...(sourceControlProvider ? { sourceControlProvider } : {}),
        hasPrimaryRemote: remote.exitCode === 0,
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
      } satisfies VcsStatusLocalResult;
    });
    const localStatusCache = yield* Cache.makeWith((cwd: string) => readLocalStatus({ cwd }), {
      capacity: STATUS_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_CACHE_TTL : Duration.zero),
    });
    const localStatus = ({ cwd }: VcsStatusInput) => Cache.get(localStatusCache, cwd);

    const resolveDefaultBranch = Effect.fn("GitWorkflowService.resolveDefaultBranch")(function* (
      cwd: string,
    ) {
      const symbolic = yield* git.execute({
        operation: "GitWorkflowService.resolveDefaultBranch.symbolic",
        cwd,
        args: ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
        allowNonZeroExit: true,
      });
      if (symbolic.exitCode === 0) {
        const value = symbolic.stdout.trim();
        if (value.startsWith("origin/") && value.length > "origin/".length) {
          return value.slice("origin/".length);
        }
      }
      for (const candidate of ["main", "master"] as const) {
        const exists = yield* git.execute({
          operation: "GitWorkflowService.resolveDefaultBranch.exists",
          cwd,
          args: ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`],
          allowNonZeroExit: true,
        });
        if (exists.exitCode === 0) return candidate;
      }
      return "main";
    });

    const prEpochByCwd = new Map<string, number>();
    const prFailureStreak = new Map<string, number>();
    const lastKnownPr = new Map<string, ChangeRequest | null>();
    const prLookupCache = yield* Cache.makeWith(
      (key: string) => {
        const [cwd = "", branch = ""] = key.split("\0");
        return Effect.gen(function* () {
          const provider = yield* sourceControls.get("gitlab");
          const requests = yield* provider.listChangeRequests({
            cwd,
            headSelector: branch,
            state: "all",
            limit: 20,
          });
          return requests.find((candidate) => candidate.headRefName === branch) ?? null;
        });
      },
      {
        capacity: STATUS_CACHE_CAPACITY,
        timeToLive: (exit, key) => {
          if (Exit.isSuccess(exit)) {
            prFailureStreak.delete(key);
            return PR_CACHE_TTL;
          }
          const failures = (prFailureStreak.get(key) ?? 0) + 1;
          setBounded(prFailureStreak, key, failures);
          return failureTtl(failures);
        },
      },
    );
    const lookupMergeRequest = (cwd: string, branch: string) => {
      const branchKey = `${cwd}\0${branch}`;
      const cacheKey = `${branchKey}\0${prEpochByCwd.get(cwd) ?? 0}`;
      return Cache.get(prLookupCache, cacheKey).pipe(
        Effect.tap((request) => Effect.sync(() => setBounded(lastKnownPr, branchKey, request))),
        Effect.catch((error) =>
          Effect.logWarning("GitLab merge request lookup failed; keeping last known state.", {
            operation: "GitWorkflowService.lookupMergeRequest",
            errorTag:
              typeof error === "object" && error !== null && "_tag" in error
                ? String(error._tag)
                : typeof error,
          }).pipe(Effect.as(lastKnownPr.get(branchKey) ?? null)),
        ),
      );
    };

    const readRemoteStatus = Effect.fn("GitWorkflowService.readRemoteStatus")(function* ({
      cwd,
    }: VcsStatusInput) {
      const local = yield* localStatus({ cwd });
      if (!local.isRepo || !local.hasPrimaryRemote || local.refName === null) return null;
      const upstream = yield* git.execute({
        operation: "GitWorkflowService.remoteStatus.upstream",
        cwd,
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        allowNonZeroExit: true,
      });
      const hasUpstream = upstream.exitCode === 0 && upstream.stdout.trim().length > 0;
      let aheadCount = 0;
      let behindCount = 0;
      if (hasUpstream) {
        const counts = yield* git.execute({
          operation: "GitWorkflowService.remoteStatus.counts",
          cwd,
          args: ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        });
        const [behind = "0", ahead = "0"] = counts.stdout.trim().split(/\s+/u);
        behindCount = parseCount(behind);
        aheadCount = parseCount(ahead);
      }
      const defaultBranch = yield* resolveDefaultBranch(cwd);
      const aheadOfDefault = yield* git.execute({
        operation: "GitWorkflowService.remoteStatus.aheadOfDefault",
        cwd,
        args: ["rev-list", "--count", `origin/${defaultBranch}..HEAD`],
        allowNonZeroExit: true,
      });
      const request = yield* lookupMergeRequest(cwd, local.refName);
      return {
        hasUpstream,
        aheadCount,
        behindCount,
        aheadOfDefaultCount: aheadOfDefault.exitCode === 0 ? parseCount(aheadOfDefault.stdout) : 0,
        pr: request
          ? {
              number: request.number,
              title: request.title,
              url: request.url,
              baseRef: request.baseRefName,
              headRef: request.headRefName,
              state: request.state,
            }
          : null,
      } satisfies VcsStatusRemoteResult;
    });

    const fetchFailureStreak = new Map<string, number>();
    const fetchCache = yield* Cache.makeWith(
      (cwd: string) =>
        git.execute({
          operation: "GitWorkflowService.remoteStatus.fetch",
          cwd,
          args: ["fetch", "--prune", "origin"],
          timeoutMs: 300_000,
          maxOutputBytes: 512 * 1024,
        }),
      {
        capacity: STATUS_CACHE_CAPACITY,
        timeToLive: (exit, key) => {
          if (Exit.isSuccess(exit)) {
            fetchFailureStreak.delete(key);
            return FETCH_CACHE_TTL;
          }
          const failures = (fetchFailureStreak.get(key) ?? 0) + 1;
          setBounded(fetchFailureStreak, key, failures);
          return failureTtl(failures);
        },
      },
    );
    const remoteStatusCache = yield* Cache.makeWith((cwd: string) => readRemoteStatus({ cwd }), {
      capacity: STATUS_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? STATUS_CACHE_TTL : Duration.zero),
    });
    const remoteStatus = Effect.fn("GitWorkflowService.remoteStatus")(function* (
      { cwd }: VcsStatusInput,
      options?: { readonly fetch?: boolean },
    ) {
      if (options?.fetch === true) {
        yield* Cache.get(fetchCache, cwd).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Git fetch failed; using the last fetched refs.", {
              operation: "GitWorkflowService.remoteStatus.fetch",
              errorTag:
                typeof error === "object" && error !== null && "_tag" in error
                  ? String(error._tag)
                  : typeof error,
            }),
          ),
        );
        yield* Cache.invalidate(remoteStatusCache, cwd);
      }
      return yield* Cache.get(remoteStatusCache, cwd);
    });

    const invalidateStatus = Effect.fn("GitWorkflowService.invalidateStatus")(function* (
      cwd: string,
    ) {
      yield* Cache.invalidate(localStatusCache, cwd);
      yield* Cache.invalidate(remoteStatusCache, cwd);
      setBounded(prEpochByCwd, cwd, (prEpochByCwd.get(cwd) ?? 0) + 1);
    });

    const status = Effect.fn("GitWorkflowService.status")(function* (
      input: VcsStatusInput,
      options?: { readonly fetch?: boolean },
    ) {
      const local = yield* localStatus(input);
      const remote = yield* remoteStatus(input, options);
      return mergeGitStatusParts(local, remote);
    });

    const pull = Effect.fn("GitWorkflowService.pull")(function* ({ cwd }: VcsPullInput) {
      const branch = (yield* localStatus({ cwd })).refName;
      if (branch === null) {
        return yield* new GitCommandError({
          operation: "GitWorkflowService.pull",
          command: "git pull",
          cwd,
          detail: "A checked-out branch is required before pulling.",
        });
      }
      const upstream = yield* git.execute({
        operation: "GitWorkflowService.pull.upstream",
        cwd,
        args: ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        allowNonZeroExit: true,
      });
      const upstreamRef = upstream.exitCode === 0 ? upstream.stdout.trim() || null : null;
      if (upstreamRef === null) {
        return yield* new GitCommandError({
          operation: "GitWorkflowService.pull",
          command: "git pull",
          cwd,
          detail: "The current branch has no upstream branch.",
        });
      }
      yield* git.execute({
        operation: "GitWorkflowService.pull",
        cwd,
        args: ["pull", "--ff-only"],
        timeoutMs: 300_000,
        maxOutputBytes: 512 * 1024,
      });
      return { status: "pulled", refName: branch, upstreamRef } satisfies VcsPullResult;
    });

    const resolvePullRequest = Effect.fn("GitWorkflowService.resolvePullRequest")(function* (
      input: GitPullRequestRefInput,
    ) {
      const provider = yield* sourceControls.get("gitlab");
      const request = yield* provider.getChangeRequest(input);
      return {
        pullRequest: {
          number: request.number,
          title: request.title,
          url: request.url,
          baseBranch: request.baseRefName,
          headBranch: request.headRefName,
          state: request.state,
        },
      } satisfies GitResolvePullRequestResult;
    });

    const runStackedAction = Effect.fn("GitWorkflowService.runStackedAction")(function* (
      input: GitRunStackedActionInput,
      progressReporter?: GitActionProgressReporter,
    ) {
      const report = (event: GitActionProgressEvent) =>
        progressReporter?.publish(event) ?? Effect.void;
      const base = { actionId: input.actionId, cwd: input.cwd, action: input.action } as const;
      const makeGitProgress = () => {
        let currentHookName: string | null = null;
        const reportOutput = (stream: "stdout" | "stderr", text: string) => {
          const trimmed = text.trim();
          if (!trimmed) return Effect.void;
          return report({
            ...base,
            kind: "hook_output",
            hookName: currentHookName,
            stream,
            text: trimmed.slice(0, 500).trimEnd(),
          });
        };
        return {
          onStdoutLine: (line: string) => reportOutput("stdout", line),
          onStderrLine: (line: string) => reportOutput("stderr", line),
          onHookStarted: (hookName: string) => {
            currentHookName = hookName;
            return report({ ...base, kind: "hook_started", hookName });
          },
          onHookFinished: (event: {
            hookName: string;
            exitCode: number | null;
            durationMs: number | null;
          }) => {
            if (currentHookName === event.hookName) currentHookName = null;
            return report({ ...base, kind: "hook_finished", ...event });
          },
        } satisfies GitVcsDriver.ExecuteGitProgress;
      };
      const wantsCommit =
        input.action === "commit" ||
        input.action === "commit_push" ||
        input.action === "commit_push_pr";
      const wantsPush = input.action !== "commit";
      const wantsPr = input.action === "create_pr" || input.action === "commit_push_pr";
      const phases: GitActionProgressPhase[] = [
        ...(input.featureBranch ? (["branch"] as const) : []),
        ...(wantsCommit ? (["commit"] as const) : []),
        ...(wantsPush ? (["push"] as const) : []),
        ...(wantsPr ? (["pr"] as const) : []),
      ];
      yield* report({ ...base, kind: "action_started", phases });

      let branchStatus: GitRunStackedActionResult["branch"] = {
        status: "skipped_not_requested",
      };
      let commitStatus: GitRunStackedActionResult["commit"] = {
        status: "skipped_not_requested",
      };
      let pushStatus: GitRunStackedActionResult["push"] = {
        status: "skipped_not_requested",
      };
      let prStatus: GitRunStackedActionResult["pr"] = {
        status: "skipped_not_requested",
      };

      if (input.featureBranch) {
        yield* report({
          ...base,
          kind: "phase_started",
          phase: "branch",
          label: "Preparing feature branch...",
        });
        const refs = yield* git.execute({
          operation: "GitWorkflowService.runStackedAction.listBranches",
          cwd: input.cwd,
          args: ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        });
        let preferred = input.commitMessage?.split("\n")[0] ?? "update";
        if (
          input.commitMessage === undefined &&
          Option.isSome(textGeneration) &&
          Option.isSome(serverSettings)
        ) {
          const changes = yield* git.execute({
            operation: "GitWorkflowService.runStackedAction.branchContext",
            cwd: input.cwd,
            args: ["status", "--short"],
          });
          const settings = yield* readGenerationSettings(input.cwd);
          if (settings === null) {
            return yield* new GitManagerError({
              operation: "runStackedAction",
              cwd: input.cwd,
              detail: "Text-generation settings are unavailable.",
            });
          }
          const generated = yield* textGeneration.value.generateBranchName({
            cwd: input.cwd,
            message: changes.stdout.trim() || "Update project files",
            modelSelection: resolveSourceControlWriterModelSelection(settings),
          });
          preferred = generated.branch;
        }
        const name = resolveAutoFeatureBranchName(
          refs.stdout
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean),
          preferred,
        );
        yield* git.execute({
          operation: "GitWorkflowService.runStackedAction.createBranch",
          cwd: input.cwd,
          args: ["switch", "-c", name],
        });
        branchStatus = { status: "created", name };
      }

      if (wantsCommit) {
        if (input.filePaths?.length) {
          yield* git.execute({
            operation: "GitWorkflowService.runStackedAction.unstageExcludedFiles",
            cwd: input.cwd,
            args: ["reset", "--mixed"],
          });
        }
        yield* git.execute({
          operation: "GitWorkflowService.runStackedAction.stage",
          cwd: input.cwd,
          args: input.filePaths?.length ? ["add", "--", ...input.filePaths] : ["add", "--all"],
        });
        const staged = yield* git.execute({
          operation: "GitWorkflowService.runStackedAction.staged",
          cwd: input.cwd,
          args: ["diff", "--cached", "--quiet"],
          allowNonZeroExit: true,
        });
        if (staged.exitCode === 0) {
          commitStatus = { status: "skipped_no_changes" };
        } else {
          const names = yield* git.execute({
            operation: "GitWorkflowService.runStackedAction.changedFiles",
            cwd: input.cwd,
            args: ["diff", "--cached", "--name-only"],
          });
          const firstPath = names.stdout
            .split("\n")
            .map((value) => value.trim())
            .find(Boolean);
          const fallbackSubject = firstPath
            ? `Update ${firstPath.split("/").at(-1) ?? "project files"}`
            : "Update project files";
          let subject = input.commitMessage?.trim() || fallbackSubject;
          let body = "";
          if (
            input.commitMessage === undefined &&
            Option.isSome(textGeneration) &&
            Option.isSome(serverSettings)
          ) {
            yield* report({
              ...base,
              kind: "phase_started",
              phase: "commit",
              label: "Generating commit message...",
            });
            const [summary, patch] = yield* Effect.all([
              git.execute({
                operation: "GitWorkflowService.runStackedAction.commitSummary",
                cwd: input.cwd,
                args: ["diff", "--cached", "--stat"],
                maxOutputBytes: 64 * 1024,
              }),
              git.execute({
                operation: "GitWorkflowService.runStackedAction.commitPatch",
                cwd: input.cwd,
                args: ["diff", "--cached"],
                maxOutputBytes: 512 * 1024,
                appendTruncationMarker: true,
              }),
            ]);
            const settings = yield* readGenerationSettings(input.cwd);
            if (settings === null) {
              return yield* new GitManagerError({
                operation: "runStackedAction",
                cwd: input.cwd,
                detail: "Text-generation settings are unavailable.",
              });
            }
            const generated = yield* textGeneration.value.generateCommitMessage({
              cwd: input.cwd,
              branch: (yield* localStatus({ cwd: input.cwd })).refName,
              stagedSummary: summary.stdout,
              stagedPatch: patch.stdout,
              modelSelection: resolveSourceControlWriterModelSelection(settings),
              policy: yield* resolveWritingPolicy(input.cwd, settings),
            });
            subject = generated.subject;
            body = generated.body;
          }
          yield* report({
            ...base,
            kind: "phase_started",
            phase: "commit",
            label: "Committing...",
          });
          yield* git.execute({
            operation: "GitWorkflowService.runStackedAction.commit",
            cwd: input.cwd,
            args: ["commit", "-m", subject, ...(body ? ["-m", body] : [])],
            timeoutMs: 600_000,
            maxOutputBytes: 1024 * 1024,
            progress: makeGitProgress(),
          });
          const sha = yield* git.execute({
            operation: "GitWorkflowService.runStackedAction.commitSha",
            cwd: input.cwd,
            args: ["rev-parse", "HEAD"],
          });
          commitStatus = {
            status: "created",
            commitSha: sha.stdout.trim(),
            subject: subject.split("\n")[0] ?? subject,
          };
        }
      }

      const localAfterCommit = yield* localStatus({ cwd: input.cwd });
      const branch = localAfterCommit.refName;
      if (wantsPush) {
        yield* report({ ...base, kind: "phase_started", phase: "push", label: "Pushing..." });
        const pushed = yield* git.pushCurrentBranch(input.cwd, branch, {
          progress: makeGitProgress(),
        });
        pushStatus = {
          status: "pushed",
          branch: pushed.branch,
          ...(pushed.upstreamBranch ? { upstreamBranch: pushed.upstreamBranch } : {}),
          setUpstream: pushed.setUpstream,
        };
      }

      if (wantsPr) {
        yield* report({
          ...base,
          kind: "phase_started",
          phase: "pr",
          label: "Creating GitLab merge request...",
        });
        if (branch === null) {
          return yield* new GitManagerError({
            operation: "runStackedAction",
            cwd: input.cwd,
            detail: "A checked-out branch is required before creating a merge request.",
          });
        }
        const provider = yield* sourceControls.get("gitlab");
        const baseBranch = yield* resolveDefaultBranch(input.cwd);
        const existing = yield* provider.listChangeRequests({
          cwd: input.cwd,
          headSelector: branch,
          state: "open",
          limit: 20,
        });
        let request = existing.find((candidate) => candidate.headRefName === branch) ?? null;
        const openedExisting = request !== null;
        if (request === null) {
          const latestSubject = yield* git.execute({
            operation: "GitWorkflowService.runStackedAction.mergeRequestTitle",
            cwd: input.cwd,
            args: ["log", "-1", "--pretty=%s"],
          });
          let title = latestSubject.stdout.trim() || branch.replaceAll("-", " ");
          let body = "";
          if (Option.isSome(textGeneration) && Option.isSome(serverSettings)) {
            yield* report({
              ...base,
              kind: "phase_started",
              phase: "pr",
              label: "Generating merge request content...",
            });
            const baseRef = `origin/${baseBranch}`;
            const settings = yield* readGenerationSettings(input.cwd);
            if (settings === null) {
              return yield* new GitManagerError({
                operation: "runStackedAction",
                cwd: input.cwd,
                detail: "Text-generation settings are unavailable.",
              });
            }
            const [commitSummary, diffSummary, diffPatch, template] = yield* Effect.all([
              git.execute({
                operation: "GitWorkflowService.runStackedAction.mergeRequestCommits",
                cwd: input.cwd,
                args: ["log", "--oneline", `${baseRef}..HEAD`],
                maxOutputBytes: 128 * 1024,
                appendTruncationMarker: true,
              }),
              git.execute({
                operation: "GitWorkflowService.runStackedAction.mergeRequestSummary",
                cwd: input.cwd,
                args: ["diff", "--stat", `${baseRef}...HEAD`],
                maxOutputBytes: 128 * 1024,
                appendTruncationMarker: true,
              }),
              git.execute({
                operation: "GitWorkflowService.runStackedAction.mergeRequestPatch",
                cwd: input.cwd,
                args: ["diff", `${baseRef}...HEAD`],
                maxOutputBytes: 512 * 1024,
                appendTruncationMarker: true,
              }),
              settings.sourceControlWritingStyle.followChangeRequestTemplates
                ? detectPrTemplate(input.cwd, baseRef, git.execute)
                : Effect.succeed(Option.none()),
            ]);
            const generated = yield* textGeneration.value.generatePrContent({
              cwd: input.cwd,
              baseBranch,
              headBranch: branch,
              commitSummary: commitSummary.stdout,
              diffSummary: diffSummary.stdout,
              diffPatch: diffPatch.stdout,
              ...(Option.isSome(template) ? { changeRequestTemplate: template.value } : {}),
              modelSelection: resolveSourceControlWriterModelSelection(settings),
              policy: yield* resolveWritingPolicy(input.cwd, settings),
            });
            title = generated.title;
            body = generated.body;
          }
          const fs = Option.getOrNull(fileSystem);
          const bodyFile =
            body && fs
              ? yield* fs.makeTempFile({ prefix: "t3-gitlab-mr-", suffix: ".md" }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitManagerError({
                        operation: "runStackedAction",
                        cwd: input.cwd,
                        detail: "Could not create the merge request body file.",
                        cause,
                      }),
                  ),
                )
              : "/dev/null";
          if (bodyFile !== "/dev/null" && fs) {
            yield* fs.writeFileString(bodyFile, body).pipe(
              Effect.mapError(
                (cause) =>
                  new GitManagerError({
                    operation: "runStackedAction",
                    cwd: input.cwd,
                    detail: "Could not write the merge request body file.",
                    cause,
                  }),
              ),
            );
          }
          yield* provider
            .createChangeRequest({
              cwd: input.cwd,
              baseRefName: baseBranch,
              headSelector: branch,
              title,
              bodyFile,
            })
            .pipe(
              Effect.ensuring(
                bodyFile === "/dev/null" || !fs
                  ? Effect.void
                  : fs.remove(bodyFile).pipe(Effect.ignore),
              ),
            );
          const created = yield* provider.listChangeRequests({
            cwd: input.cwd,
            headSelector: branch,
            state: "open",
            limit: 20,
          });
          request = created.find((candidate) => candidate.headRefName === branch) ?? null;
        }
        prStatus = {
          status: openedExisting ? "opened_existing" : "created",
          ...(request
            ? {
                url: request.url,
                number: request.number,
                baseBranch: request.baseRefName,
                headBranch: request.headRefName,
                title: request.title,
              }
            : { baseBranch, headBranch: branch }),
        };
      }

      const title = wantsPr
        ? prStatus.status === "opened_existing"
          ? "Merge request already open"
          : "Merge request created"
        : wantsPush
          ? "Changes pushed"
          : commitStatus.status === "skipped_no_changes"
            ? "No changes to commit"
            : "Changes committed";
      const result: GitRunStackedActionResult = {
        action: input.action,
        branch: branchStatus,
        commit: commitStatus,
        push: pushStatus,
        pr: prStatus,
        toast: {
          title,
          cta: prStatus.url
            ? { kind: "open_pr", label: "Open merge request", url: prStatus.url }
            : { kind: "none" },
        },
      };
      yield* report({ ...base, kind: "action_finished", result });
      return result;
    });

    const preparePullRequestThreadImpl = Effect.fn("GitWorkflowService.preparePullRequestThread")(
      function* (input: GitPreparePullRequestThreadInput) {
        const provider = yield* sourceControls.get("gitlab");
        const summary = yield* provider.getChangeRequest({
          cwd: input.cwd,
          reference: input.reference,
        });
        const pullRequest = {
          number: summary.number,
          title: summary.title,
          url: summary.url,
          baseBranch: summary.baseRefName,
          headBranch: summary.headRefName,
          state: summary.state,
        } as const;

        const canonicalizeExistingPath = (value: string) =>
          Option.isSome(fileSystem)
            ? fileSystem.value.realPath(value).pipe(Effect.orElseSucceed(() => value))
            : Effect.succeed(value);
        const execute = (
          cwd: string,
          operation: string,
          args: ReadonlyArray<string>,
          allowNonZeroExit = false,
        ) =>
          git.execute({
            cwd,
            operation: `GitWorkflowService.preparePullRequestThread.${operation}`,
            args,
            allowNonZeroExit,
            maxOutputBytes: 64 * 1024,
          });
        const primaryRemoteName = Effect.fn("preparePullRequestThread.primaryRemoteName")(
          function* (cwd: string) {
            const remotes = yield* execute(cwd, "listRemotes", ["remote"]);
            const names = remotes.stdout
              .split(/\r?\n/u)
              .map((name) => name.trim())
              .filter(Boolean);
            const remote = names.includes("origin") ? "origin" : names[0];
            if (!remote) {
              return yield* new GitManagerError({
                operation: "preparePullRequestThread",
                cwd,
                detail: "The repository has no Git remote for fetching the merge request.",
              });
            }
            return remote;
          },
        );
        const readConfig = Effect.fn("preparePullRequestThread.readConfig")(function* (
          cwd: string,
          key: string,
        ) {
          const result = yield* execute(cwd, "readConfig", ["config", "--get", key], true);
          return Number(result.exitCode) === 0 ? result.stdout.trim() || null : null;
        });
        const configureUpstreamBase = Effect.fn("preparePullRequestThread.configureUpstream")(
          function* (cwd: string, localBranch: string) {
            let remoteName = yield* primaryRemoteName(cwd);
            if (summary.isCrossRepository && summary.headRepositoryNameWithOwner) {
              const cloneUrls = yield* provider.getRepositoryCloneUrls({
                cwd,
                repository: summary.headRepositoryNameWithOwner,
              });
              const originUrl = yield* readConfig(cwd, "remote.origin.url");
              const remoteUrl = /^(?:git@|ssh:)/iu.test(originUrl ?? "")
                ? cloneUrls.sshUrl
                : cloneUrls.url;
              remoteName = yield* git.ensureRemote({
                cwd,
                preferredName:
                  summary.headRepositoryOwnerLogin?.trim() ||
                  summary.headRepositoryNameWithOwner.split("/")[0]?.trim() ||
                  "fork",
                url: remoteUrl,
              });
            }
            yield* execute(cwd, "fetchHeadTrackingBranch", [
              "fetch",
              remoteName,
              `+refs/heads/${pullRequest.headBranch}:refs/remotes/${remoteName}/${pullRequest.headBranch}`,
            ]);
            yield* execute(cwd, "setHeadUpstream", [
              "branch",
              "--set-upstream-to",
              `${remoteName}/${pullRequest.headBranch}`,
              localBranch,
            ]);
          },
        );
        const configureUpstream = (cwd: string, localBranch: string) =>
          configureUpstreamBase(cwd, localBranch).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("GitWorkflowService prepare MR upstream configuration failed", {
                cwd,
                localBranch,
                cause,
              }).pipe(Effect.asVoid),
            ),
          );
        const maybeRunSetupScript = (worktreePath: string) => {
          if (!input.threadId || Option.isNone(projectSetupScriptRunner)) return Effect.void;
          return projectSetupScriptRunner.value
            .runForThread({
              threadId: input.threadId,
              projectCwd: input.cwd,
              worktreePath,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("GitWorkflowService prepare MR setup script failed", {
                  threadId: input.threadId,
                  worktreePath,
                  cause,
                }).pipe(Effect.asVoid),
              ),
              Effect.asVoid,
            );
        };

        if (input.mode === "local") {
          yield* provider.checkoutChangeRequest({
            cwd: input.cwd,
            reference: input.reference,
            force: true,
          });
          const status = yield* git.refStatusLocal(input.cwd);
          const branch = status.refName ?? pullRequest.headBranch;
          yield* configureUpstream(input.cwd, branch);
          return {
            pullRequest,
            branch,
            worktreePath: null,
            isOnPullRequestHead: true,
          };
        }

        const sanitizedHeadBranch = sanitizeBranchFragment(pullRequest.headBranch).trim();
        const localBranch = summary.isCrossRepository
          ? `t3code/pr-${pullRequest.number}/${sanitizedHeadBranch || "head"}`
          : pullRequest.headBranch;
        const rootWorktreePath = yield* canonicalizeExistingPath(input.cwd);
        const listLocalRefs = () =>
          git.listRefs({ cwd: input.cwd, query: localBranch, refresh: true, limit: 500 });
        const findLocalHeadBranch = Effect.fn("preparePullRequestThread.findLocalHeadBranch")(
          function* () {
            const refs = yield* listLocalRefs();
            const exact = refs.refs.find((ref) => !ref.isRemote && ref.name === localBranch);
            if (exact || localBranch === pullRequest.headBranch) return exact ?? null;
            return (
              refs.refs.find(
                (ref) =>
                  !ref.isRemote && ref.name === pullRequest.headBranch && ref.worktreePath !== null,
              ) ?? null
            );
          },
        );
        const resolveCommit = Effect.fn("preparePullRequestThread.resolveCommit")(function* (
          cwd: string,
          revision: string,
        ) {
          const result = yield* execute(cwd, "resolveCommit", ["rev-parse", revision], true);
          return Number(result.exitCode) === 0 ? result.stdout.trim() || null : null;
        });
        const fetchPullRequestHead = Effect.fn("preparePullRequestThread.fetchHead")(function* (
          cwd: string,
        ) {
          const remoteName = yield* primaryRemoteName(cwd);
          const targetRef = `refs/t3code/merge-requests/${pullRequest.number}/head`;
          yield* execute(cwd, "fetchHead", [
            "fetch",
            remoteName,
            `+refs/merge-requests/${pullRequest.number}/head:${targetRef}`,
          ]);
          const commit = yield* resolveCommit(cwd, targetRef);
          if (!commit) {
            return yield* new GitManagerError({
              operation: "preparePullRequestThread",
              cwd,
              detail: "The merge request head could not be resolved after fetching it.",
            });
          }
          return commit;
        });
        const refreshReusedWorktree = Effect.fn("preparePullRequestThread.refreshReusedWorktree")(
          function* (worktreePath: string, upstreamCommitBeforeFetch: string | null) {
            const targetCommit = yield* fetchPullRequestHead(worktreePath);
            const headCommit = yield* resolveCommit(worktreePath, "HEAD");
            if (headCommit === targetCommit) return { moved: false, onTarget: true } as const;
            const dirty = yield* execute(worktreePath, "statusPorcelain", [
              "status",
              "--porcelain=v1",
              "--untracked-files=normal",
            ]);
            if (dirty.stdout.trim()) return { moved: false, onTarget: false } as const;
            if (headCommit && upstreamCommitBeforeFetch === headCommit) {
              yield* execute(worktreePath, "resetRewrittenHead", ["reset", "--hard", targetCommit]);
              return { moved: true, onTarget: true } as const;
            }
            const ancestor = yield* execute(
              worktreePath,
              "headIsAncestor",
              ["merge-base", "--is-ancestor", "HEAD", targetCommit],
              true,
            );
            if (Number(ancestor.exitCode) !== 0) {
              return { moved: false, onTarget: false } as const;
            }
            yield* execute(worktreePath, "fastForwardHead", ["merge", "--ff-only", targetCommit]);
            return { moved: true, onTarget: true } as const;
          },
        );
        const reuseExistingWorktree = Effect.fn("preparePullRequestThread.reuseExistingWorktree")(
          function* (worktreePath: string, checkedOutBranch: string) {
            if (checkedOutBranch !== localBranch) {
              yield* configureUpstream(worktreePath, checkedOutBranch);
              return {
                pullRequest,
                branch: localBranch,
                worktreePath,
                isOnPullRequestHead: false,
              };
            }
            const upstreamCommitBeforeFetch = yield* resolveCommit(worktreePath, "@{upstream}");
            yield* configureUpstream(worktreePath, localBranch);
            const refreshed = yield* refreshReusedWorktree(
              worktreePath,
              upstreamCommitBeforeFetch,
            ).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("GitWorkflowService reused MR worktree refresh failed", {
                  worktreePath,
                  localBranch,
                  cause,
                }).pipe(Effect.as({ moved: false, onTarget: false } as const)),
              ),
            );
            if (refreshed.moved) yield* maybeRunSetupScript(worktreePath);
            return {
              pullRequest,
              branch: localBranch,
              worktreePath,
              isOnPullRequestHead: refreshed.onTarget,
            };
          },
        );
        const reuseOrReject = Effect.fn("preparePullRequestThread.reuseOrReject")(function* (
          candidate: VcsListRefsResult["refs"][number] | null,
        ) {
          if (!candidate?.worktreePath) return null;
          const candidatePath = yield* canonicalizeExistingPath(candidate.worktreePath);
          if (candidatePath === rootWorktreePath) {
            return yield* new GitManagerError({
              operation: "preparePullRequestThread",
              cwd: input.cwd,
              detail:
                "This merge-request branch is already checked out in the main repository. Use Local or switch the main repository before creating a worktree.",
            });
          }
          return yield* reuseExistingWorktree(candidate.worktreePath, candidate.name);
        });

        const beforeFetch = yield* findLocalHeadBranch();
        const reusedBeforeFetch = yield* reuseOrReject(beforeFetch);
        if (reusedBeforeFetch) return reusedBeforeFetch;

        const remoteName = yield* primaryRemoteName(input.cwd);
        yield* execute(input.cwd, "materializeHead", [
          "fetch",
          remoteName,
          `+refs/merge-requests/${pullRequest.number}/head:refs/heads/${localBranch}`,
        ]);
        yield* configureUpstream(input.cwd, localBranch);

        const afterFetch = yield* findLocalHeadBranch();
        const reusedAfterFetch = yield* reuseOrReject(afterFetch);
        if (reusedAfterFetch) return reusedAfterFetch;

        const worktree = yield* git.createWorktree({
          cwd: input.cwd,
          refName: localBranch,
          path: null,
        });
        yield* configureUpstream(worktree.worktree.path, localBranch);
        yield* maybeRunSetupScript(worktree.worktree.path);
        return {
          pullRequest,
          branch: worktree.worktree.refName,
          worktreePath: worktree.worktree.path,
          isOnPullRequestHead: true,
        };
      },
    );
    const preparePullRequestThread: GitWorkflowService["Service"]["preparePullRequestThread"] = (
      input,
    ) => preparePullRequestThreadImpl(input).pipe(Effect.ensuring(invalidateStatus(input.cwd)));

    return GitWorkflowService.of({
      localStatus,
      remoteStatus,
      status,
      invalidateStatus,
      pull,
      resolvePullRequest,
      runStackedAction,
      localRefStatus: ({ cwd }) => git.refStatusLocal(cwd),
      listRefs: git.listRefs,
      createWorktree: git.createWorktree,
      removeWorktree: git.removeWorktree,
      pruneWorktrees: git.pruneWorktrees,
      createRef: git.createRef,
      switchRef: (input) => Effect.scoped(git.switchRef(input)),
      renameBranch: git.renameBranch,
      moveWorktree: git.moveWorktree,
      preparePullRequestThread,
    });
  }),
);
