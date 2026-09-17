// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CustomThemeSettings } from "./CustomThemeSettings";
import { ThemeLibrary } from "./ThemeSettings";
import { useThemeEditorStore } from "./themeEditorStore";
import {
  installCustomTheme,
  invalidateCustomThemes,
  getCustomThemes,
  T3_CHAT_THEME,
} from "../../themePalette";
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => <>{render}</>,
  TooltipPopup: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../ui/alert-dialog", () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;
  return {
    AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? <>{children}</> : null,
    AlertDialogPopup: Wrapper,
    AlertDialogHeader: Wrapper,
    AlertDialogFooter: Wrapper,
    AlertDialogClose: Wrapper,
    AlertDialogTitle: Wrapper,
    AlertDialogDescription: Wrapper,
  };
});
let renderer: ReactTestRenderer;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  window.localStorage.clear();
  invalidateCustomThemes();
  useThemeEditorStore.getState().closeThemeEditor();
});
afterEach(async () => {
  if (renderer) await act(async () => renderer.unmount());
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(<CustomThemeSettings />);
  });
}
it("opens the upstream theme editor from the library", async () => {
  await mount();
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Create theme"))!
      .props.onClick(),
  );
  expect(useThemeEditorStore.getState().session).toMatchObject({
    editingThemeId: null,
    seedThemeId: null,
  });
});
it("opens a saved theme for editing and retains upstream duplicate/remove controls", async () => {
  installCustomTheme({ ...T3_CHAT_THEME, id: "custom-test", label: "Test colors" });
  await mount();
  const buttons = renderer.root.findAllByType("button");
  const edit = buttons.find((node) => node.props["aria-label"] === "Edit Test colors")!;
  await act(async () => edit.props.onClick({ stopPropagation() {} }));
  expect(useThemeEditorStore.getState().session?.editingThemeId).toBe("custom-test");
  expect(buttons.some((node) => node.props["aria-label"] === "Remove Test colors")).toBe(true);
  expect(buttons.some((node) => String(node.props["aria-label"]).includes("Export"))).toBe(false);
});
it("removes a custom theme only after confirming the library dialog", async () => {
  installCustomTheme({ ...T3_CHAT_THEME, id: "custom-test", label: "Test colors" });
  await mount();
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((node) => node.props["aria-label"] === "Remove Test colors")!
      .props.onClick({ stopPropagation() {} }),
  );
  expect(getCustomThemes()).toHaveLength(1);
  const buttons = renderer.root.findAllByType("button");
  await act(async () =>
    buttons.find((node) => node.children.includes("Remove theme"))!.props.onClick(),
  );
  expect(getCustomThemes()).toHaveLength(0);
});
it("seeds from the currently displayed half of a theme mix", async () => {
  await act(async () => {
    renderer = create(
      <ThemeLibrary
        theme="system"
        setTheme={() => true}
        themeHalves={{ light: T3_CHAT_THEME.id }}
        setThemeHalf={() => true}
        appearanceMode="light"
        setAppearanceMode={() => true}
        customThemes={[]}
        initialAppearance="light"
      />,
    );
  });
  await act(async () =>
    renderer.root
      .findAllByType("button")
      .find((node) => node.children.includes("Create theme"))!
      .props.onClick(),
  );
  expect(useThemeEditorStore.getState().session?.seedThemeId).toBe(T3_CHAT_THEME.id);
});
