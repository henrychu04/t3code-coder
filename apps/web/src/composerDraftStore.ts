import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  RuntimeMode,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  parseScopedProjectKey,
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import * as Schema from "effect/Schema";
import * as Equal from "effect/Equal";
import { DeepMutable } from "effect/Types";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import { useMemo } from "react";
import { resolveAppModelSelection, resolveAppModelSelectionForInstance } from "./modelSelection";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./types";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
  stripInlineTerminalContextPlaceholders,
} from "./lib/terminalContext";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { getDefaultServerModel } from "./providerModels";
import { UnifiedSettings } from "@t3tools/contracts/settings";
import { ReviewCommentContextSchema, type ReviewCommentContext } from "./reviewCommentContext";
const isRuntimeMode = Schema.is(RuntimeMode);
const isProviderDriverKind = Schema.is(ProviderDriverKind);
const isReviewCommentContext = Schema.is(ReviewCommentContextSchema);

export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";
const DraftThreadEnvModeSchema = Schema.Literals(["local", "worktree"]);
export type DraftThreadEnvMode = typeof DraftThreadEnvModeSchema.Type;

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

/**
 * Per-provider record of generic option selections. Used as a transient
 * representation when migrating legacy v2 storage payloads and when
 * deriving per-provider option bundles for downstream consumers.
 */
type ProviderOptionSelectionsByProvider = Partial<
  Record<string, ReadonlyArray<ProviderOptionSelection>>
>;

export interface ComposerThreadDraftState {
  prompt: string;
  terminalContexts: TerminalContextDraft[];
  reviewComments: ReviewCommentContext[];
  /**
   * Per-instance model selection. Keyed by `ProviderInstanceId` so separate
   * Claude configurations retain their own model choices.
   */
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  /** Routing key of the last picked instance (see `modelSelectionByProvider`). */
  activeProvider: ProviderInstanceId | null;
  /** True only when the active model was explicitly chosen in the composer. */
  modelSelectionExplicit?: boolean;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
}

/**
 * True when the user has invested real content in the draft: typed text or
 * any attachment/context. Model selection and mode choices alone do not
 * count — those are ambient defaults, not work in progress. Used by the
 * sidebar draft rows (which draft sessions deserve a row) and by new-thread
 * resurrection (a draft with content keeps its settings instead of being
 * reset to defaults).
 */
export function composerDraftHasUserContent(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }
  return (
    draft.prompt.trim().length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.reviewComments.length > 0
  );
}

/**
 * Mutable routing and execution context for a pre-thread draft session.
 *
 * Unlike a real server thread, a draft session can still change target
 * environment/worktree configuration before the first send.
 */
export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

/**
 * Draft session metadata paired with its stable draft-session identity.
 */
interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

/**
 * App-facing composer identity:
 * - `DraftId` for pre-thread draft sessions
 * - `ScopedThreadRef` for server-backed threads
 *
 * Raw `ThreadId` is intentionally excluded so callers cannot drop environment
 * identity for real threads.
 */
type ComposerThreadTarget = ScopedThreadRef | DraftId;

/**
 * Persisted store for composer content plus draft-session metadata.
 *
 * The store intentionally models two domains:
 * - draft sessions keyed by `DraftId`
 * - server thread composer state keyed by `ScopedThreadRef`
 */
interface ComposerDraftStoreState {
  draftsByThreadKey: Record<string, ComposerThreadDraftState>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  backgroundSubmissionThreadKeys: Record<string, true>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyActiveProvider: ProviderInstanceId | null;
  /** Returns the editable composer content for a draft session or server thread. */
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState | null;
  /** Looks up the active draft session for a logical project identity. */
  getDraftThreadByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  /** Reads mutable draft-session metadata by `DraftId`. */
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  /** Resolves a server-thread ref back to a matching draft session when one exists. */
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  /** Creates or updates the draft session tracked for a logical project. */
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  /** Creates or updates the draft session tracked for a concrete project ref. */
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  /** Updates mutable draft-session metadata without touching composer content. */
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      startFromOrigin?: boolean;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
    },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  /** Marks a draft session as being promoted to a real server thread. */
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  /** Removes draft-session metadata after promotion is complete. */
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
    opts?: {
      explicit?: boolean;
      /**
       * Replace the stored entry outright instead of preserving its
       * existing options when the incoming selection has none. Used when
       * the selection is a complete snapshot (e.g. carried from another
       * thread) rather than a model-only change.
       */
      replaceOptions?: boolean;
    },
  ) => void;
  /** Replace the model options for one or more providers in the draft. */
  setModelOptions: (
    threadRef: ComposerThreadTarget,
    modelOptions:
      | Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>
      | null
      | undefined,
  ) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadRef: ComposerThreadTarget, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  addReviewComment: (threadRef: ComposerThreadTarget, comment: ReviewCommentContext) => void;
  setReviewComments: (
    threadRef: ComposerThreadTarget,
    comments: ReadonlyArray<ReviewCommentContext>,
  ) => void;
  removeReviewComment: (threadRef: ComposerThreadTarget, commentId: string) => void;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
  moveComposerPrompt: (from: ComposerThreadTarget, to: ComposerThreadTarget) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

function providerSelectionsFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection) {
    return null;
  }
  const options = modelSelection.options;
  if (!options || options.length === 0) {
    return null;
  }
  return { [modelSelection.instanceId]: options };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function cloneModelSelection(selection: ModelSelection): DeepMutable<ModelSelection> {
  return {
    ...selection,
    ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
  } as DeepMutable<ModelSelection>;
}

function compactModelSelectionByProvider(
  selections: Partial<Record<ProviderInstanceId, ModelSelection>>,
): DeepMutable<Record<ProviderInstanceId, ModelSelection>> {
  const entries: Array<[string, DeepMutable<ModelSelection>]> = [];
  for (const [provider, selection] of Object.entries(selections)) {
    if (selection !== undefined) {
      entries.push([provider, cloneModelSelection(selection)]);
    }
  }
  return Object.fromEntries(entries) as DeepMutable<Record<ProviderInstanceId, ModelSelection>>;
}

const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_REVIEW_COMMENTS: ReviewCommentContext[] = [];
Object.freeze(EMPTY_REVIEW_COMMENTS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderDriverKind, ModelSelection>> =
  Object.freeze({});
const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
});

const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState>({
  prompt: "",
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  reviewComments: EMPTY_REVIEW_COMMENTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
});

/**
 * Canonical factory for a blank `ComposerThreadDraftState`. Exported so tests
 * (and any other call sites) can build a draft without re-declaring every
 * slice.
 */
export function createEmptyThreadDraft(): ComposerThreadDraftState {
  return {
    prompt: "",
    terminalContexts: [],
    reviewComments: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
  };
}

function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.reviewComments.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}

function normalizeProviderDriverKind(value: unknown): ProviderDriverKind | null {
  return isProviderDriverKind(value) ? value : null;
}

/**
 * Match the `ProviderInstanceId` slug pattern (letter followed by
 * letters/digits/`-`/`_`, 1..64 chars). Permissive validator — the schema
 * layer owns authoritative validation; this is used inline to gate typed
 * writes to the draft's instance-keyed maps without pulling the full
 * Effect Schema runtime into the hot path.
 */
const PROVIDER_INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Coerce an arbitrary persisted value into a valid `ProviderInstanceId`. Used
 * wherever we accept custom Claude instance slugs as routing keys.
 */
function normalizeProviderInstanceId(value: unknown): ProviderInstanceId | null {
  if (typeof value !== "string") return null;
  if (!PROVIDER_INSTANCE_ID_PATTERN.test(value)) return null;
  return value as ProviderInstanceId;
}

/**
 * Coerce an unknown value into a `ReadonlyArray<ProviderOptionSelection>`.
 * Accepts either:
 *   - the v3 representation: an array of `{ id, value }` entries
 *   - the legacy v2 representation: a record of `{ id: string | boolean }`
 *
 * Validation is intentionally permissive: descriptors are the source of truth
 * for which option ids are meaningful for a given provider/model. Anything
 * outside the descriptor list is harmless trailing data and will simply be
 * ignored downstream.
 */
function coerceProviderOptionSelections(
  value: unknown,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (Array.isArray(value)) {
    const out: ProviderOptionSelection[] = [];
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const id = record.id;
      const optionValue = record.value;
      if (typeof id !== "string" || id.length === 0) continue;
      if (typeof optionValue === "string" || typeof optionValue === "boolean") {
        out.push({ id, value: optionValue });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: ProviderOptionSelection[] = [];
    for (const [id, raw] of Object.entries(record)) {
      if (typeof raw === "string" || typeof raw === "boolean") {
        out.push({ id, value: raw });
      }
    }
    return out.length > 0 ? out : undefined;
  }
  return undefined;
}

/**
 * Normalize a per-provider options bag from either the v3 or legacy v2 shape.
 *
 * This migration helper only retains Claude option data.
 */
function normalizeProviderModelOptions(value: unknown): ProviderOptionSelectionsByProvider | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const providerKey of ["claudeAgent"] as const) {
    const selections = coerceProviderOptionSelections(candidate?.[providerKey]);
    if (selections) {
      result[providerKey] = selections;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

// Returns a model selection whose `instanceId` is a valid
// `ProviderInstanceId` slug. Legacy `provider` fields are promoted verbatim
// because default instance ids used the same slug as the driver kind.
//
// Selections whose instance id doesn't match the slug pattern collapse to
// `null` — caller is responsible for deciding whether that's a dropped
// write or a routed error.
function normalizeModelSelection(
  value: unknown,
  legacy?: {
    provider?: unknown;
    model?: unknown;
    modelOptions?: unknown;
  },
): NormalizedModelSelection | null {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  // Post-migration ModelSelection carries `instanceId`; pre-migration (v2
  // storage, legacy wire shapes) carries `provider`. Accept either so both
  // normalized stores and legacy drafts round-trip through this helper.
  const instanceId = normalizeProviderInstanceId(
    candidate?.instanceId ?? candidate?.provider ?? legacy?.provider,
  );
  if (instanceId === null) {
    return null;
  }
  const rawModel = candidate?.model ?? legacy?.model;
  if (typeof rawModel !== "string") {
    return null;
  }
  // Slug normalization can use provider-kind-specific rules when a legacy
  // driver key is present. Instance-only selections are not reverse-inferred
  // into a driver kind here; they get generic default normalization.
  const driverKindHint =
    normalizeProviderDriverKind(candidate?.provider ?? legacy?.provider) ??
    ProviderDriverKind.make("claudeAgent");
  const model = normalizeModelSlug(rawModel, driverKindHint);
  if (!model) {
    return null;
  }
  if (Array.isArray(candidate?.options)) {
    const selections = coerceProviderOptionSelections(candidate.options);
    return createModelSelection(instanceId, model, selections) as NormalizedModelSelection;
  }
  // Per-kind options were a pre-migration concern; only recover them for a
  // built-in-kind instance. Custom instances don't have a legacy options
  // store to thread through here.
  const kindForLegacyOptions = normalizeProviderDriverKind(instanceId);
  const modelOptions = kindForLegacyOptions
    ? normalizeProviderModelOptions(
        candidate?.options ? { [kindForLegacyOptions]: candidate.options } : legacy?.modelOptions,
      )
    : null;
  const options = kindForLegacyOptions ? modelOptions?.[kindForLegacyOptions] : undefined;
  return createModelSelection(instanceId, model, options) as NormalizedModelSelection;
}

type NormalizedModelSelection = Omit<ModelSelection, "instanceId"> & {
  readonly instanceId: ProviderInstanceId;
};

// ── Legacy sync helpers (used only during migration from v2 storage) ──
//
// These operate against the legacy kind-keyed `modelOptions` map. The
// normalized selection now carries an open `ProviderInstanceId`; legacy
// migration only recovers options for keys that existed before custom
// provider instances.

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * Optional routing key of the instance whose selection should override
   * the driver-level lookup. When present, the draft is queried by
   * `modelSelectionByProvider[selectedInstanceId]` so a custom Claude
   * instance reads its own saved model.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModelCandidate =
    input.threadModelSelection?.model ?? input.projectModelSelection?.model ?? null;
  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
        )
      : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);
  // Look up the instance's saved selection first; fall back to the
  // driver-kind bucket so legacy kind-keyed drafts still resolve. Every
  // `ProviderDriverKind` literal is a valid `ProviderInstanceId` slug, so the
  // cast to the branded type is safe.
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  const legacySelection =
    input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
      ) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerSelectionsFromModelSelection(input.threadModelSelection) ??
    providerSelectionsFromModelSelection(input.projectModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

function projectDraftKey(projectRef: ScopedProjectRef): string {
  return scopedProjectKey(projectRef);
}

function logicalProjectDraftKey(logicalProjectKey: string): string {
  return logicalProjectKey.trim();
}

/**
 * Runtime composer storage key for app-facing identities only.
 *
 * Draft sessions are keyed by `DraftId`. Real threads are keyed by
 * `ScopedThreadRef` so environment identity is always preserved.
 */
function composerTargetKey(target: ScopedThreadRef | DraftId): string {
  if (typeof target === "string") {
    return target.trim();
  }
  return scopedThreadKey(target);
}

/**
 * Legacy persisted data may still be keyed by a raw `ThreadId`. This helper is
 * intentionally migration-only so live code cannot accidentally accept that
 * incomplete identity.
 */
type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

function normalizeComposerTarget(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ComposerThreadTarget | null {
  if (typeof target === "string") {
    const draftId = target.trim();
    return draftId.length > 0 ? DraftId.make(draftId) : null;
  }
  return target;
}

function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    const scopedKey = composerTargetKey(normalizedTarget);
    if (state.draftsByThreadKey[scopedKey]) {
      return scopedKey;
    }
    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      ) {
        return draftId;
      }
    }
    return scopedKey;
  }
  const threadKey = composerTargetKey(normalizedTarget);
  return threadKey.length > 0 ? threadKey : null;
}

function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    return normalizedTarget.threadId;
  }
  return state.draftThreadsByThreadKey[normalizedTarget]?.threadId ?? null;
}

function getComposerDraftState(
  state: Pick<ComposerDraftStoreState, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState | null {
  const threadKey = resolveComposerDraftKey(state, target);
  if (!threadKey) {
    return null;
  }
  return state.draftsByThreadKey[threadKey] ?? null;
}

function isComposerThreadKeyInUse(mappings: Record<string, string>, threadKey: string): boolean {
  return Object.values(mappings).includes(threadKey);
}

function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
  options?: {
    threadId?: ThreadId;
    branch?: string | null;
    worktreePath?: string | null;
    createdAt?: string;
    envMode?: DraftThreadEnvMode;
    startFromOrigin?: boolean;
    runtimeMode?: RuntimeMode;
    interactionMode?: ProviderInteractionMode;
  },
): DraftThreadState {
  // A project change (including switching environments within a logical
  // project) invalidates machine-specific context: the branch may not exist
  // there and the worktree path certainly doesn't. The user's *intent* —
  // env mode and start-from-origin — is machine-independent and carries.
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId);
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null);
  const nextStartFromOrigin =
    options?.startFromOrigin === undefined
      ? (existingThread?.startFromOrigin ?? false)
      : options.startFromOrigin;
  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    envMode:
      options?.envMode ?? (nextWorktreePath ? "worktree" : (existingThread?.envMode ?? "local")),
    startFromOrigin: nextStartFromOrigin,
    promotedTo: null,
  };
}

function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

function draftThreadsEqual(left: DraftThreadState | undefined, right: DraftThreadState): boolean {
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    left.startFromOrigin === right.startFromOrigin &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  );
}

function removeDraftThreadReferences(
  state: Pick<
    ComposerDraftStoreState,
    | "draftThreadsByThreadKey"
    | "draftsByThreadKey"
    | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  >,
  threadKey: string,
): Pick<
  ComposerDraftStoreState,
  | "draftThreadsByThreadKey"
  | "draftsByThreadKey"
  | "logicalProjectDraftThreadKeyByLogicalProjectKey"
> {
  const nextLogicalMappings = Object.fromEntries(
    Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
      ([, draftThreadKey]) => draftThreadKey !== threadKey,
    ),
  ) as Record<string, string>;
  const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
    state.draftThreadsByThreadKey;
  const { [threadKey]: _removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey;
  return {
    draftsByThreadKey: restDraftsByThreadKey,
    draftThreadsByThreadKey: restDraftThreadsByThreadKey,
    logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
  };
}

const composerDraftStore = create<ComposerDraftStoreState>()((setBase, get) => {
  const set = setBase;

  return {
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
    getComposerDraft: (target) => getComposerDraftState(get(), target),
    getDraftThreadByLogicalProjectKey: (logicalProjectKey) => {
      return get().getDraftSessionByLogicalProjectKey(logicalProjectKey);
    },
    getDraftSessionByLogicalProjectKey: (logicalProjectKey) => {
      const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
      if (normalizedLogicalProjectKey.length === 0) {
        return null;
      }
      const draftId =
        get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
      if (!draftId) {
        return null;
      }
      const draftThread = get().draftThreadsByThreadKey[draftId];
      if (!draftThread || isDraftThreadPromoting(draftThread)) {
        return null;
      }
      return toProjectDraftSession(DraftId.make(draftId), draftThread);
    },
    getDraftThreadByProjectRef: (projectRef) => {
      return get().getDraftSessionByProjectRef(projectRef);
    },
    getDraftSessionByProjectRef: (projectRef) => {
      const state = get();
      // Mapped drafts win: a project can also own older unmapped drafts
      // (invested ones left behind by a remap), but "the" draft for a
      // project is the one new-thread flows currently target.
      for (const draftId of Object.values(state.logicalProjectDraftThreadKeyByLogicalProjectKey)) {
        const draftThread = state.draftThreadsByThreadKey[draftId];
        if (!draftThread || isDraftThreadPromoting(draftThread)) {
          continue;
        }
        if (
          draftThread.projectId === projectRef.projectId &&
          draftThread.environmentId === projectRef.environmentId
        ) {
          return toProjectDraftSession(DraftId.make(draftId), draftThread);
        }
      }
      for (const [draftId, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
        if (isDraftThreadPromoting(draftThread)) {
          continue;
        }
        if (
          draftThread.projectId === projectRef.projectId &&
          draftThread.environmentId === projectRef.environmentId
        ) {
          return toProjectDraftSession(DraftId.make(draftId), draftThread);
        }
      }
      return null;
    },
    getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,
    getDraftSessionByRef: (threadRef) => {
      for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
        if (
          draftSession.environmentId === threadRef.environmentId &&
          draftSession.threadId === threadRef.threadId
        ) {
          return draftSession;
        }
      }
      return null;
    },
    getDraftThread: (threadRef) => {
      if (typeof threadRef === "string") {
        return get().getDraftSession(DraftId.make(threadRef));
      }
      return get().getDraftSessionByRef(threadRef);
    },
    getDraftThreadByRef: (threadRef) => {
      return get().getDraftSessionByRef(threadRef);
    },
    listDraftThreadKeys: () =>
      Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
        scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
      ),
    hasDraftThreadsInEnvironment: (environmentId) =>
      Object.values(get().draftThreadsByThreadKey).some(
        (draftThread) => draftThread.environmentId === environmentId,
      ),
    setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) => {
      const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
      if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
        return;
      }
      set((state) => {
        const existingThread = state.draftThreadsByThreadKey[draftId];
        const previousThreadKeyForLogicalProject =
          state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
        const nextDraftThread = createDraftThreadState(
          projectRef,
          options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
          normalizedLogicalProjectKey,
          existingThread,
          options,
        );
        const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
        if (hasSameLogicalMapping && draftThreadsEqual(existingThread, nextDraftThread)) {
          return state;
        }
        const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {
          ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
          [normalizedLogicalProjectKey]: draftId,
        };
        const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
          ...state.draftThreadsByThreadKey,
          [draftId]: nextDraftThread,
        };
        let nextDraftsByThreadKey = state.draftsByThreadKey;
        const previousDraftThread =
          previousThreadKeyForLogicalProject === undefined
            ? undefined
            : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
        // A remap only garbage-collects the previous draft when the user
        // never invested content in it. A draft with typed text or
        // attachments stays alive unmapped — the sidebar draft rows list
        // every such session, so "new thread" can mint a fresh draft
        // without destroying the one the user walked away from.
        if (
          previousThreadKeyForLogicalProject &&
          previousThreadKeyForLogicalProject !== draftId &&
          !isComposerThreadKeyInUse(
            nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
            previousThreadKeyForLogicalProject,
          ) &&
          !isDraftThreadPromoting(previousDraftThread) &&
          !composerDraftHasUserContent(state.draftsByThreadKey[previousThreadKeyForLogicalProject])
        ) {
          delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
          if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
            nextDraftsByThreadKey = { ...state.draftsByThreadKey };
            delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
          }
        }
        return {
          draftsByThreadKey: nextDraftsByThreadKey,
          draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
        };
      });
    },
    setProjectDraftThreadId: (projectRef, draftId, options) => {
      get().setLogicalProjectDraftThreadId(
        projectDraftKey(projectRef),
        projectRef,
        draftId,
        options,
      );
    },
    setDraftThreadContext: (threadRef, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadKey[threadKey];
        if (!existing) {
          return state;
        }
        const nextProjectRef = options.projectRef ?? {
          environmentId: existing.environmentId,
          projectId: existing.projectId,
        };
        if (nextProjectRef.projectId.length === 0 || nextProjectRef.environmentId.length === 0) {
          return state;
        }
        // Mirrors createDraftThreadState: a project/environment change
        // drops machine-specific context (branch, worktree path) but
        // keeps the user's env mode and start-from-origin intent.
        const projectChanged =
          nextProjectRef.environmentId !== existing.environmentId ||
          nextProjectRef.projectId !== existing.projectId;
        const nextWorktreePath =
          options.worktreePath === undefined
            ? projectChanged
              ? null
              : existing.worktreePath
            : (options.worktreePath ?? null);
        const nextBranch =
          options.branch === undefined
            ? projectChanged
              ? null
              : existing.branch
            : (options.branch ?? null);
        const nextStartFromOrigin =
          options.startFromOrigin === undefined
            ? existing.startFromOrigin
            : options.startFromOrigin;
        const nextDraftThread: DraftThreadState = {
          threadId: existing.threadId,
          environmentId: nextProjectRef.environmentId,
          projectId: nextProjectRef.projectId,
          logicalProjectKey: existing.logicalProjectKey,
          createdAt:
            options.createdAt === undefined
              ? existing.createdAt
              : options.createdAt || existing.createdAt,
          runtimeMode: options.runtimeMode ?? existing.runtimeMode,
          interactionMode: options.interactionMode ?? existing.interactionMode,
          branch: nextBranch,
          worktreePath: nextWorktreePath,
          envMode:
            options.envMode ?? (nextWorktreePath ? "worktree" : (existing.envMode ?? "local")),
          startFromOrigin: nextStartFromOrigin,
          promotedTo: existing.promotedTo ?? null,
        };
        const isUnchanged =
          nextDraftThread.environmentId === existing.environmentId &&
          nextDraftThread.projectId === existing.projectId &&
          nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
          nextDraftThread.createdAt === existing.createdAt &&
          nextDraftThread.runtimeMode === existing.runtimeMode &&
          nextDraftThread.interactionMode === existing.interactionMode &&
          nextDraftThread.branch === existing.branch &&
          nextDraftThread.worktreePath === existing.worktreePath &&
          nextDraftThread.envMode === existing.envMode &&
          nextDraftThread.startFromOrigin === existing.startFromOrigin &&
          scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo);
        if (isUnchanged) {
          return state;
        }
        return {
          draftThreadsByThreadKey: {
            ...state.draftThreadsByThreadKey,
            [threadKey]: nextDraftThread,
          },
        };
      });
    },
    clearProjectDraftThreadId: (projectRef) => {
      set((state) => {
        // A project can own several sessions (invested drafts survive
        // remaps unmapped), so project removal must sweep them all — a
        // leftover would render a sidebar row for a project that no
        // longer exists.
        const matchingThreadKeys = Object.entries(state.draftThreadsByThreadKey)
          .filter(
            ([, draftThread]) =>
              draftThread.projectId === projectRef.projectId &&
              draftThread.environmentId === projectRef.environmentId,
          )
          .map(([threadKey]) => threadKey);
        if (matchingThreadKeys.length === 0) {
          return state;
        }
        let nextState = {
          draftsByThreadKey: state.draftsByThreadKey,
          draftThreadsByThreadKey: state.draftThreadsByThreadKey,
          logicalProjectDraftThreadKeyByLogicalProjectKey:
            state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        };
        for (const threadKey of matchingThreadKeys) {
          nextState = removeDraftThreadReferences(nextState, threadKey);
        }
        return nextState;
      });
    },
    clearProjectDraftThreadById: (projectRef, threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const draftThread = state.draftThreadsByThreadKey[threadKey];
        if (
          !draftThread ||
          draftThread.projectId !== projectRef.projectId ||
          draftThread.environmentId !== projectRef.environmentId
        ) {
          return state;
        }
        return removeDraftThreadReferences(state, threadKey);
      });
    },
    markDraftThreadPromoting: (threadRef, promotedTo) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadKey[threadKey];
        if (!existing) {
          return state;
        }
        const nextPromotedTo =
          promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
        if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
          return state;
        }
        return {
          draftThreadsByThreadKey: {
            ...state.draftThreadsByThreadKey,
            [threadKey]: {
              ...existing,
              promotedTo: nextPromotedTo,
            },
          },
        };
      });
    },
    finalizePromotedDraftThread: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftThreadsByThreadKey[threadKey];
        if (!isDraftThreadPromoting(existing)) {
          return state;
        }
        return removeDraftThreadReferences(state, threadKey);
      });
    },
    clearDraftThread: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
        const hasLogicalProjectMapping = Object.values(
          state.logicalProjectDraftThreadKeyByLogicalProjectKey,
        ).includes(threadKey);
        const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
        if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
          return state;
        }
        return removeDraftThreadReferences(state, threadKey);
      });
    },
    setStickyModelSelection: (modelSelection) => {
      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        if (!normalized) {
          return state;
        }
        const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
          ...state.stickyModelSelectionByProvider,
          [normalized.instanceId]: normalized,
        };
        if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
          return state.stickyActiveProvider === normalized.instanceId
            ? state
            : { stickyActiveProvider: normalized.instanceId };
        }
        return {
          stickyModelSelectionByProvider: nextMap,
          stickyActiveProvider: normalized.instanceId,
        };
      });
    },
    applyStickyState: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const stickyMap = state.stickyModelSelectionByProvider;
        const stickyActiveProvider = state.stickyActiveProvider;
        const existing = state.draftsByThreadKey[threadKey];
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = compactModelSelectionByProvider(stickyMap);
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === stickyActiveProvider &&
          base.modelSelectionExplicit === undefined
        ) {
          return state;
        }
        const { modelSelectionExplicit: _modelSelectionExplicit, ...retained } = base;
        const nextDraft: ComposerThreadDraftState = {
          ...retained,
          modelSelectionByProvider: nextMap,
          activeProvider: stickyActiveProvider,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setPrompt: (threadRef, prompt) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setTerminalContexts: (threadRef, contexts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId) {
        return;
      }
      const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt: ensureInlineTerminalContextPlaceholders(
            existing.prompt,
            normalizedContexts.length,
          ),
          terminalContexts: normalizedContexts,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setModelSelection: (threadRef, modelSelection, opts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      const normalized = normalizeModelSelection(modelSelection);
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];
        if (!existing && normalized === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        if (normalized) {
          const current = nextMap[normalized.instanceId];
          if (normalized.options !== undefined || opts?.replaceOptions) {
            // Explicit options provided (or the caller passed a complete
            // snapshot whose absent options mean "no options") → use the
            // selection as-is.
            nextMap[normalized.instanceId] = normalized as ModelSelection;
          } else {
            // No options in selection → preserve existing options, update provider+model
            nextMap[normalized.instanceId] = createModelSelection(
              normalized.instanceId,
              normalized.model,
              current?.options,
            );
          }
        }
        const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          base.activeProvider === nextActiveProvider &&
          (base.modelSelectionExplicit ?? false) === (opts?.explicit === true)
        ) {
          return state;
        }
        const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
        const nextDraft: ComposerThreadDraftState = {
          ...restBase,
          modelSelectionByProvider: nextMap,
          activeProvider: nextActiveProvider,
          ...(opts?.explicit === true ? { modelSelectionExplicit: true as const } : {}),
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setModelOptions: (threadRef, modelOptions) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];
        if (!existing && (!modelOptions || Object.keys(modelOptions).length === 0)) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        const nextMap = { ...base.modelSelectionByProvider };
        for (const provider of ["claudeAgent"] as const) {
          if (!modelOptions || !(provider in modelOptions)) continue;
          const opts = modelOptions[provider];
          const driverKind = ProviderDriverKind.make(provider);
          const instanceKey = defaultInstanceIdForDriver(driverKind);
          const current = nextMap[instanceKey];
          if (opts && opts.length > 0) {
            nextMap[instanceKey] = createModelSelection(
              instanceKey,
              current?.model ?? DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL,
              opts,
            );
          } else if (current?.options) {
            const { options: _, ...rest } = current;
            nextMap[instanceKey] = rest as ModelSelection;
          }
        }
        if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          modelSelectionByProvider: nextMap,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      const normalizedProvider = normalizeProviderDriverKind(provider);
      if (normalizedProvider === null) {
        return;
      }
      const instanceKey = options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider);
      const fallbackModel =
        normalizeModelSlug(options?.model, normalizedProvider) ??
        DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
        DEFAULT_MODEL;
      const providerOpts =
        nextProviderOptions && nextProviderOptions.length > 0 ? nextProviderOptions : undefined;

      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];
        const base = existing ?? createEmptyThreadDraft();

        // Update the map entry for this provider
        const nextMap = { ...base.modelSelectionByProvider };
        const currentForProvider = nextMap[instanceKey];
        if (providerOpts) {
          nextMap[instanceKey] = createModelSelection(
            instanceKey,
            currentForProvider?.model ?? fallbackModel,
            providerOpts,
          );
        } else if (currentForProvider && (currentForProvider.options?.length ?? 0) > 0) {
          const { options: _, ...rest } = currentForProvider;
          nextMap[instanceKey] = rest as ModelSelection;
        }

        // Handle sticky persistence
        let nextStickyMap = state.stickyModelSelectionByProvider;
        let nextStickyActiveProvider = state.stickyActiveProvider;
        if (options?.persistSticky === true) {
          nextStickyMap = { ...state.stickyModelSelectionByProvider };
          const stickyBase =
            nextStickyMap[instanceKey] ??
            base.modelSelectionByProvider[instanceKey] ??
            createModelSelection(instanceKey, fallbackModel);
          if (providerOpts) {
            nextStickyMap[instanceKey] = createModelSelection(
              instanceKey,
              stickyBase.model,
              providerOpts,
            );
          } else if ((stickyBase.options?.length ?? 0) > 0) {
            const { options: _, ...rest } = stickyBase;
            nextStickyMap[instanceKey] = rest as ModelSelection;
          }
          nextStickyActiveProvider = options.instanceId
            ? instanceKey
            : (base.activeProvider ?? instanceKey);
        }

        if (
          Equal.equals(base.modelSelectionByProvider, nextMap) &&
          Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
          state.stickyActiveProvider === nextStickyActiveProvider
        ) {
          return state;
        }

        const { modelSelectionExplicit: _previousExplicit, ...restBase } = base;
        const nextDraft: ComposerThreadDraftState = {
          ...restBase,
          ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
          modelSelectionByProvider: nextMap,
          modelSelectionExplicit: true,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }

        return {
          draftsByThreadKey: nextDraftsByThreadKey,
          ...(options?.persistSticky === true
            ? {
                stickyModelSelectionByProvider: nextStickyMap,
                stickyActiveProvider: nextStickyActiveProvider,
              }
            : {}),
        };
      });
    },
    setRuntimeMode: (threadRef, runtimeMode) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];
        if (!existing && nextRuntimeMode === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        if (base.runtimeMode === nextRuntimeMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          runtimeMode: nextRuntimeMode,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    setInteractionMode: (threadRef, interactionMode) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      const nextInteractionMode =
        interactionMode === "plan" || interactionMode === "default" ? interactionMode : null;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey];
        if (!existing && nextInteractionMode === null) {
          return state;
        }
        const base = existing ?? createEmptyThreadDraft();
        if (base.interactionMode === nextInteractionMode) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...base,
          interactionMode: nextInteractionMode,
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    insertTerminalContext: (threadRef, prompt, context, index) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId) {
        return false;
      }
      let inserted = false;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const normalizedContext = normalizeTerminalContextForThread(threadId, context);
        if (!normalizedContext) {
          return state;
        }
        const dedupKey = terminalContextDedupKey(normalizedContext);
        if (
          existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
          existing.terminalContexts.some((entry) => terminalContextDedupKey(entry) === dedupKey)
        ) {
          return state;
        }
        inserted = true;
        const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
        const nextDraft: ComposerThreadDraftState = {
          ...existing,
          prompt,
          terminalContexts: [
            ...existing.terminalContexts.slice(0, boundedIndex),
            normalizedContext,
            ...existing.terminalContexts.slice(boundedIndex),
          ],
        };
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: nextDraft,
          },
        };
      });
      return inserted;
    },
    addTerminalContext: (threadRef, context) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId) {
        return;
      }
      get().addTerminalContexts(
        typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
        [context],
      );
    },
    addTerminalContexts: (threadRef, contexts) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      const threadId = resolveComposerThreadId(get(), threadRef);
      if (!threadKey || !threadId || contexts.length === 0) {
        return;
      }
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
          ...existing.terminalContexts,
          ...contexts,
        ]).slice(existing.terminalContexts.length);
        if (acceptedContexts.length === 0) {
          return state;
        }
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              prompt: ensureInlineTerminalContextPlaceholders(
                existing.prompt,
                existing.terminalContexts.length + acceptedContexts.length,
              ),
              terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
            },
          },
        };
      });
    },
    removeTerminalContext: (threadRef, contextId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0 || contextId.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: current.terminalContexts.filter((context) => context.id !== contextId),
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    clearTerminalContexts: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current || current.terminalContexts.length === 0) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          terminalContexts: [],
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    addReviewComment: (threadRef, comment) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey || !isReviewCommentContext(comment)) return;
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const reviewComments = existing.reviewComments.filter((entry) => entry.id !== comment.id);
        return {
          draftsByThreadKey: {
            ...state.draftsByThreadKey,
            [threadKey]: {
              ...existing,
              reviewComments: [...reviewComments, { ...comment }],
            },
          },
        };
      });
    },
    setReviewComments: (threadRef, comments) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey) return;
      const reviewComments = comments
        .filter(isReviewCommentContext)
        .map((comment) => ({ ...comment }));
      set((state) => {
        const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
        const nextDraft = { ...existing, reviewComments };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    removeReviewComment: (threadRef, commentId) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef);
      if (!threadKey || !commentId) return;
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) return state;
        const reviewComments = current.reviewComments.filter((entry) => entry.id !== commentId);
        if (reviewComments.length === current.reviewComments.length) return state;
        const nextDraft = { ...current, reviewComments };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) delete nextDraftsByThreadKey[threadKey];
        else nextDraftsByThreadKey[threadKey] = nextDraft;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    clearComposerContent: (threadRef) => {
      const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
      if (threadKey.length === 0) {
        return;
      }
      set((state) => {
        const current = state.draftsByThreadKey[threadKey];
        if (!current) {
          return state;
        }
        const nextDraft: ComposerThreadDraftState = {
          ...current,
          prompt: "",
          terminalContexts: [],
          reviewComments: [],
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextDraft)) {
          delete nextDraftsByThreadKey[threadKey];
        } else {
          nextDraftsByThreadKey[threadKey] = nextDraft;
        }
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
    moveComposerPrompt: (from, to) => {
      const fromKey = resolveComposerDraftKey(get(), from) ?? "";
      const toKey = resolveComposerDraftKey(get(), to) ?? "";
      if (fromKey.length === 0 || toKey.length === 0 || fromKey === toKey) return;
      set((state) => {
        const source = state.draftsByThreadKey[fromKey];
        if (!source) return state;
        const destination = state.draftsByThreadKey[toKey] ?? createEmptyThreadDraft();
        const nextDestination = {
          ...destination,
          prompt: ensureInlineTerminalContextPlaceholders(
            stripInlineTerminalContextPlaceholders(source.prompt),
            destination.terminalContexts.length,
          ),
        };
        const nextSource = {
          ...source,
          prompt: ensureInlineTerminalContextPlaceholders("", source.terminalContexts.length),
        };
        const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
        if (shouldRemoveDraft(nextSource)) delete nextDraftsByThreadKey[fromKey];
        else nextDraftsByThreadKey[fromKey] = nextSource;
        nextDraftsByThreadKey[toKey] = nextDestination;
        return { draftsByThreadKey: nextDraftsByThreadKey };
      });
    },
  };
});

export const useComposerDraftStore = composerDraftStore;

export function beginBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }
    return {
      backgroundSubmissionThreadKeys: {
        ...state.backgroundSubmissionThreadKeys,
        [threadKey]: true,
      },
    };
  });
}

export function clearBackgroundDraftSubmissionByRef(threadRef: ScopedThreadRef): void {
  const threadKey = scopedThreadKey(threadRef);
  useComposerDraftStore.setState((state) => {
    if (!state.backgroundSubmissionThreadKeys[threadKey]) {
      return state;
    }
    const backgroundSubmissionThreadKeys = { ...state.backgroundSubmissionThreadKeys };
    delete backgroundSubmissionThreadKeys[threadKey];
    return { backgroundSubmissionThreadKeys };
  });
}

export function useBackgroundDraftSubmissionPending(threadRef: ScopedThreadRef | null): boolean {
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  return useComposerDraftStore(
    (state) => threadKey !== null && state.backgroundSubmissionThreadKeys[threadKey] === true,
  );
}

export function clearComposerDraftsEnvironment(environmentId: EnvironmentId): void {
  useComposerDraftStore.setState((state) => {
    const removedThreadKeys = new Set<string>();

    for (const [threadKey, draftThread] of Object.entries(state.draftThreadsByThreadKey)) {
      if (draftThread.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const threadKey of Object.keys(state.draftsByThreadKey)) {
      if (parseScopedThreadKey(threadKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }
    for (const [logicalProjectKey, threadKey] of Object.entries(
      state.logicalProjectDraftThreadKeyByLogicalProjectKey,
    )) {
      if (parseScopedProjectKey(logicalProjectKey)?.environmentId === environmentId) {
        removedThreadKeys.add(threadKey);
      }
    }

    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([logicalProjectKey, threadKey]) =>
          parseScopedProjectKey(logicalProjectKey)?.environmentId !== environmentId &&
          !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, string>;
    const nextDraftThreads = Object.fromEntries(
      Object.entries(state.draftThreadsByThreadKey).filter(
        ([threadKey, draftThread]) =>
          draftThread.environmentId !== environmentId && !removedThreadKeys.has(threadKey),
      ),
    ) as Record<string, DraftThreadState>;
    const nextDrafts = Object.fromEntries(
      Object.entries(state.draftsByThreadKey).filter(([threadKey, draft]) => {
        if (!removedThreadKeys.has(threadKey)) {
          return true;
        }
        return false;
      }),
    ) as Record<string, ComposerThreadDraftState>;
    const nextBackgroundSubmissionThreadKeys = Object.fromEntries(
      Object.entries(state.backgroundSubmissionThreadKeys).filter(
        ([threadKey]) => parseScopedThreadKey(threadKey)?.environmentId !== environmentId,
      ),
    ) as Record<string, true>;

    return {
      draftsByThreadKey: nextDrafts,
      draftThreadsByThreadKey: nextDraftThreads,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
      backgroundSubmissionThreadKeys: nextBackgroundSubmissionThreadKeys,
    };
  });
}

export function useComposerThreadDraft(threadRef: ComposerThreadTarget): ComposerThreadDraftState {
  return useComposerDraftStore((state) => {
    return getComposerDraftState(state, threadRef) ?? EMPTY_THREAD_DRAFT;
  });
}

/**
 * True when a real thread's composer holds unsent user content. Selects a
 * boolean so the sidebar row that reads it re-renders only when the draft
 * appears or disappears, not on every keystroke.
 */
export function useThreadHasUnsentDraft(threadRef: ScopedThreadRef): boolean {
  return useComposerDraftStore((state) =>
    composerDraftHasUserContent(getComposerDraftState(state, threadRef)),
  );
}

export function useComposerDraftModelState(
  threadRef: ComposerThreadTarget,
): ComposerDraftModelState {
  return useComposerDraftStore(
    useShallow((state) => {
      const draft = getComposerDraftState(state, threadRef);
      return draft
        ? {
            activeProvider: draft.activeProvider,
            modelSelectionByProvider: draft.modelSelectionByProvider,
          }
        : EMPTY_COMPOSER_DRAFT_MODEL_STATE;
    }),
  );
}

export function useEffectiveComposerModelState(input: {
  threadRef?: ComposerThreadTarget;
  draftId?: DraftId;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * When supplied, the draft's saved selection for this instance takes
   * precedence over the driver-kind bucket so a custom Claude instance reads
   * its own model.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  projectModelSelection: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const draft = useComposerDraftModelState(input.threadRef ?? input.draftId ?? DraftId.make(""));

  return useMemo(
    () =>
      deriveEffectiveComposerModelState({
        draft,
        providers: input.providers,
        selectedProvider: input.selectedProvider,
        selectedInstanceId: input.selectedInstanceId,
        threadModelSelection: input.threadModelSelection,
        projectModelSelection: input.projectModelSelection,
        settings: input.settings,
      }),
    [
      draft,
      input.providers,
      input.settings,
      input.projectModelSelection,
      input.selectedInstanceId,
      input.selectedProvider,
      input.threadModelSelection,
    ],
  );
}

/**
 * Mark a draft thread as promoting once the server has materialized the same thread id.
 *
 * Use the single-thread helper for live `thread.created` events and the
 * iterable helper for bootstrap/recovery paths that discover multiple server
 * threads at once.
 */
export function markPromotedDraftThread(threadId: ThreadId): void {
  const store = useComposerDraftStore.getState();
  const draftThreadTargets: ComposerThreadTarget[] = [];
  for (const [draftId, draftThread] of Object.entries(store.draftThreadsByThreadKey)) {
    if (draftThread.threadId === threadId) {
      draftThreadTargets.push(DraftId.make(draftId));
    }
  }
  if (draftThreadTargets.length === 0) {
    return;
  }
  for (const draftThreadTarget of draftThreadTargets) {
    store.markDraftThreadPromoting(draftThreadTarget);
  }
}

export function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    if (
      draftThread.environmentId === threadRef.environmentId &&
      draftThread.threadId === threadRef.threadId
    ) {
      draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
    }
  }
}

export function markPromotedDraftThreads(serverThreadIds: Iterable<ThreadId>): void {
  for (const threadId of serverThreadIds) {
    markPromotedDraftThread(threadId);
  }
}

export function markPromotedDraftThreadsByRef(serverThreadRefs: Iterable<ScopedThreadRef>): void {
  for (const threadRef of serverThreadRefs) {
    markPromotedDraftThreadByRef(threadRef);
  }
}

export function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
  const draftStore = useComposerDraftStore.getState();
  for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
    const promotedRef = draftThread.promotedTo;
    const matches = promotedRef
      ? promotedRef.environmentId === threadRef.environmentId &&
        promotedRef.threadId === threadRef.threadId
      : draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId;
    if (matches) {
      const target = DraftId.make(draftId);
      draftStore.markDraftThreadPromoting(target, threadRef);
      draftStore.finalizePromotedDraftThread(target);
    }
  }
  clearBackgroundDraftSubmissionByRef(threadRef);
}

export function finalizePromotedDraftThreadsByRef(
  serverThreadRefs: Iterable<ScopedThreadRef>,
): void {
  for (const threadRef of serverThreadRefs) {
    finalizePromotedDraftThreadByRef(threadRef);
  }
}
