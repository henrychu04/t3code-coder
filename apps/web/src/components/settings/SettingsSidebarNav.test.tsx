// @vitest-environment happy-dom
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { searchSettings, SETTINGS_SEARCH_ITEMS } from "./settingsSearch";
import { Input } from "../ui/input";
const mocks = vi.hoisted(() => ({ navigate: vi.fn(), setOpen: vi.fn(), setOpenMobile: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({ hash: "", search: {} }),
}));
vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => SETTINGS_SEARCH_ITEMS,
}));
vi.mock("../sidebar/SidebarChrome", () => ({ SidebarChromeFooter: () => null }));
vi.mock("../ui/input", () => ({
  Input: (props: React.ComponentProps<"input">) => <input {...props} />,
}));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({
    isMobile: false,
    open: true,
    setOpen: mocks.setOpen,
    setOpenMobile: mocks.setOpenMobile,
  }),
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenuButton: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));
let renderer: ReactTestRenderer;
let inputNode: HTMLInputElement;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.resetAllMocks();
  mocks.navigate.mockResolvedValue(undefined);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  inputNode = document.createElement("input");
  document.body.append(inputNode);
  await act(async () => {
    renderer = create(<SettingsSidebarNav pathname="/settings/preferences" />, {
      createNodeMock: (element) => (element.type === "input" ? inputNode : null),
    });
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
  inputNode.remove();
  vi.unstubAllGlobals();
});
function input() {
  return renderer.root.findByType(Input);
}
async function search(value: string) {
  await act(async () => input().props.onChange({ currentTarget: { value } }));
}
it("opens a matching setting with its anchor and leaves scope retention to the router", async () => {
  await search("fast forward");
  await act(async () => input().props.onKeyDown({ key: "Enter", preventDefault() {} }));
  expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
    to: "/settings/source-control",
    hash: "automatic-pull",
    replace: true,
    hashScrollIntoView: false,
    state: { settingsTargetHighlight: true },
  });
  expect(input().props.value).toBe("");
});
it("moves through results with arrow keys and clears search on Escape", async () => {
  await search("model");
  await act(async () => input().props.onKeyDown({ key: "ArrowDown", preventDefault() {} }));
  expect(input().props["aria-activedescendant"]).toBe(
    `settings-search-result-${searchSettings("model")[1]!.id}`,
  );
  const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
  await act(async () => input().props.onKeyDown(event));
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(input().props.value).toBe("");
  expect(mocks.navigate).not.toHaveBeenCalled();
});
it("focuses search with slash but leaves text inputs alone", async () => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "/", cancelable: true }));
  });
  expect(document.activeElement).toBe(inputNode);
  const editor = document.createElement("input");
  document.body.append(editor);
  editor.focus();
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
  });
  expect(document.activeElement).toBe(editor);
  editor.remove();
});
