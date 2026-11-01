import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

// Coder: no browser preview or desktop menu, so neither is mocked.
const state = vi.hoisted(() => ({
  keybindings: [] as ResolvedKeybindingsConfig,
  params: {} as Record<string, string>,
  workspaceAvailable: true,
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => state.keybindings) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => state.params) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../connection/catalog"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return {
    ...actual,
    environmentCatalog: {
      ...actual.environmentCatalog,
      catalogValueAtom: Atom.make({
        isReady: true,
        entries: new Map([["remote", { target: { _tag: "DirectConnectionTarget" } }]]),
      }) as never,
    },
  };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const live = Atom.make({ status: "live" });
  return {
    ...actual,
    environmentShell: { ...actual.environmentShell, stateValueAtom: (() => live) as never },
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ projectId: "project-1", worktreePath: null })) as never,
  readProject: (() =>
    state.workspaceAvailable ? { workspaceRoot: "/work/project" } : null) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { useClosedViewStore } from "../closedViewStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { ReopenClosedViewShortcut } from "./ReopenClosedViewShortcut";

const ref = { environmentId: "remote", threadId: "thread-1" } as ScopedThreadRef;

function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    params: {},
    workspaceAvailable: true,
  });
  state.navigate.mockResolvedValue(undefined);
  useClosedViewStore.setState({ entries: [] });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useTerminalUiStateStore.setState({
    terminalUiStateByThreadKey: {},
    suppressedTerminalIdsByThreadKey: {},
  });
}

async function renderShortcut() {
  await using stack = new AsyncDisposableStack();
  stack.use(vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64"));
  stack.use(await render(<ReopenClosedViewShortcut />));
  const environment = stack.move();
  return {
    /** Attaches an element to the document until the test ends. */
    append(element: HTMLElement) {
      document.body.append(element);
      environment.defer(() => element.remove());
      return element;
    },
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
  };
}

function press(target: Element = document.body) {
  const event = new KeyboardEvent("keydown", {
    key: "T",
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("root reopen shortcut", () => {
  // Coder: no browser surface, and the keyboard is the only reopen trigger.
  it.each(["files", "file"] as const)(
    "keeps a failed %s restore retryable without blocking older history",
    async (kind) => {
      setup();
      const store = useClosedViewStore.getState();
      const older = store.remember({
        kind: "panel-tab",
        threadRef: ref,
        surface: { kind: "diff", id: "diff" },
      });
      const failed = store.remember({
        kind: "panel-tab",
        threadRef: ref,
        surface:
          kind === "files"
            ? { kind: "files", id: "files" }
            : {
                kind: "file",
                id: "file:src/app.ts",
                relativePath: "src/app.ts",
                revealLine: null,
                revealRequestId: 0,
              },
      });
      state.workspaceAvailable = false;
      await using _view = await renderShortcut();
      await act(() => {
        press();
      });
      expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([
        older,
        failed,
      ]);
      expect(state.navigate).not.toHaveBeenCalled();
      await act(() => {
        press();
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
      ).toBe("diff");
      expect(useClosedViewStore.getState().entries.map((entry) => entry.id)).toEqual([failed]);
      state.workspaceAvailable = true;
      await act(() => {
        press();
      });
      expect(
        selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).activeSurfaceId,
      ).toBe(kind === "file" ? "file:src/app.ts" : "files");
      expect(useClosedViewStore.getState().entries).toEqual([]);
    },
  );
  it("forwards address-bar focus from a focused desktop page", async () => {
    setup();
    await using _shortcut = await renderShortcut();
    expect(state.setShortcuts).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ command: "preview.focusUrl" })]),
    );
  });
});
