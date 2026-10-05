import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  composerDraftHasUserContent,
  deriveEffectiveComposerModelState,
  useComposerDraftStore,
} from "./composerDraftStore";

describe("existing-thread unsent drafts", () => {
  const ref = scopeThreadRef(EnvironmentId.make("draft-test"), ThreadId.make("thread"));
  const other = scopeThreadRef(EnvironmentId.make("other-workspace"), ref.threadId);
  afterEach(() => {
    useComposerDraftStore.getState().clearComposerContent(ref);
    useComposerDraftStore.getState().clearComposerContent(other);
  });
  it("tracks unsent content, ignores whitespace, and clears on discard", () => {
    const hasDraft = () =>
      composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(ref));
    expect(hasDraft()).toBe(false);
    useComposerDraftStore.getState().setPrompt(ref, "   ");
    expect(hasDraft()).toBe(false);
    useComposerDraftStore.getState().setPrompt(ref, "follow up on the review");
    expect(hasDraft()).toBe(true);
    expect(
      composerDraftHasUserContent(useComposerDraftStore.getState().getComposerDraft(other)),
    ).toBe(false);
    useComposerDraftStore.getState().clearComposerContent(ref);
    expect(hasDraft()).toBe(false);
  });
});

it("preserves Fast options across model-only sticky updates and honors explicit Normal", () => {
  const initial = useComposerDraftStore.getState();
  const instanceId = ProviderInstanceId.make("codex");
  try {
    initial.setStickyModelSelection({
      instanceId,
      model: "gpt-5.4",
      options: [{ id: "fastMode", value: true }],
    });
    initial.setStickyModelSelection({ instanceId, model: "gpt-5.5" });
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[instanceId]?.options,
    ).toEqual([{ id: "fastMode", value: true }]);
    initial.setStickyModelSelection({
      instanceId,
      model: "gpt-5.5",
      options: [{ id: "fastMode", value: false }],
    });
    expect(
      useComposerDraftStore.getState().stickyModelSelectionByProvider[instanceId]?.options,
    ).toEqual([{ id: "fastMode", value: false }]);
  } finally {
    useComposerDraftStore.setState({
      stickyActiveProvider: initial.stickyActiveProvider,
      stickyModelSelectionByProvider: initial.stickyModelSelectionByProvider,
    });
  }
});

it("retains a custom thread/draft selection and sticky selection through send resolution", () => {
  const initial = useComposerDraftStore.getState();
  const ref = scopeThreadRef(
    EnvironmentId.make("custom-draft-test"),
    ThreadId.make("custom-thread"),
  );
  const instanceId = ProviderInstanceId.make("codex");
  const driver = ProviderDriverKind.make("codex");
  const selection = { instanceId, model: "custom", options: [{ id: "effort", value: "high" }] };
  const settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: { [instanceId]: { driver, config: { customModels: ["custom"] } } },
  };
  const providers: ReadonlyArray<ServerProvider> = [
    {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: "gpt-5.4", name: "GPT", isCustom: false, capabilities: {} },
        { slug: "custom", name: "Custom", isCustom: true, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    },
  ];
  try {
    initial.setModelSelection(ref, selection, { explicit: true });
    initial.setStickyModelSelection(selection);
    const draft = useComposerDraftStore.getState().getComposerDraft(ref);
    expect(draft?.modelSelectionByProvider[instanceId]).toEqual(selection);
    expect(useComposerDraftStore.getState().stickyModelSelectionByProvider[instanceId]).toEqual(
      selection,
    );
    const input = {
      providers,
      selectedProvider: driver,
      selectedInstanceId: instanceId,
      threadModelSelection: selection,
      projectModelSelection: null,
      settings,
    };
    expect(deriveEffectiveComposerModelState({ ...input, draft }).selectedModel).toBe("custom");
    expect(deriveEffectiveComposerModelState({ ...input, draft: null }).selectedModel).toBe(
      "custom",
    );
    expect(
      deriveEffectiveComposerModelState({ ...input, draft }).modelOptions?.[instanceId],
    ).toEqual(selection.options);
  } finally {
    useComposerDraftStore.getState().clearComposerContent(ref);
    useComposerDraftStore.setState({
      stickyActiveProvider: initial.stickyActiveProvider,
      stickyModelSelectionByProvider: initial.stickyModelSelectionByProvider,
    });
  }
});
