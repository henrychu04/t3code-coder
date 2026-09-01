// @vitest-environment happy-dom

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

const testState = vi.hoisted(() => ({
  matches: [
    {
      path: "src/main.ts",
      lineNumber: 1,
      lineContent: "const main = true;",
      matchRanges: [{ start: 0, end: 5 }],
    },
    {
      path: "src/other.ts",
      lineNumber: 2,
      lineContent: "const other = true;",
      matchRanges: [{ start: 0, end: 5 }],
    },
  ],
  lastTarget: null as Record<string, unknown> | null,
  pathEntries: [
    { path: "src/main.ts", kind: "file" },
    { path: "src/other.ts", kind: "file" },
  ],
}));

vi.mock("~/components/ui/command", () => ({
  CommandDialog: ({ children }: { children: React.ReactNode }) => children,
  CommandDialogPopup: ({
    children,
    onBackdropPointerDown: _onBackdropPointerDown,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & {
    onBackdropPointerDown?: React.PointerEventHandler<HTMLDivElement>;
  }) => <div {...props}>{children}</div>,
  CommandFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div data-slot="command-footer" {...props}>
      {children}
    </div>
  ),
}));

vi.mock("~/hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("~/state/queries", () => ({
  useProjectPathSearch: (target: Record<string, unknown>) => ({
    entries: testState.pathEntries,
    isPending: false,
    error: null,
    searchedQuery: target.query,
  }),
  useProjectTextSearch: (target: Record<string, unknown>) => {
    testState.lastTarget = target;
    return {
      matches: testState.matches,
      truncated: false,
      regexFallbackError: null,
      error: null,
      isPending: false,
      searchedQuery: target.query,
    };
  },
}));

vi.mock("./HighlightedSearchLine", () => ({
  HighlightedSearchLine: ({ match }: { match: { lineContent: string } }) => match.lineContent,
}));

vi.mock("./projectFilesQueryState", () => ({
  confirmProjectFileQueryData: vi.fn(),
  discardProjectFileQueryData: vi.fn(),
  getOptimisticProjectFileQueryData: vi.fn(),
  setProjectFileQueryData: vi.fn(),
  useProjectFileQuery: () => ({ data: null, error: null }),
}));

import { FileSearchDialog, FileSearchDialogs, ProjectTextSearchDialog } from "./FilePreviewPanel";

const threadRef = scopeThreadRef(
  EnvironmentId.make("test-environment"),
  ThreadId.make("test-thread"),
);
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

describe("ProjectTextSearchDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let openedFiles: Array<{ relativePath: string; line: number | undefined }>;
  let openChanges: boolean[];

  beforeAll(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  beforeEach(async () => {
    testState.matches = [
      {
        path: "src/main.ts",
        lineNumber: 1,
        lineContent: "const main = true;",
        matchRanges: [{ start: 0, end: 5 }],
      },
      {
        path: "src/other.ts",
        lineNumber: 2,
        lineContent: "const other = true;",
        matchRanges: [{ start: 0, end: 5 }],
      },
    ];
    testState.lastTarget = null;
    openedFiles = [];
    openChanges = [];
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <ProjectTextSearchDialog
          open
          environmentId={EnvironmentId.make("test-environment")}
          threadRef={threadRef}
          cwd="/workspace/project"
          projectName="project"
          onOpenChange={(open) => openChanges.push(open)}
          onOpenFile={(relativePath, line) => openedFiles.push({ relativePath, line })}
        />,
      ),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps keyboard focus, selection, preview, and Enter on the same result", async () => {
    const query = container.querySelector<HTMLInputElement>(
      "[data-testid=project-text-search-input]",
    );
    expect(query).not.toBeNull();
    await act(async () => setInputValue(query!, "const"));

    const results = [
      ...container.querySelectorAll<HTMLButtonElement>("[data-content-search-result]"),
    ];
    expect(results).toHaveLength(2);
    results[0]!.focus();
    await act(async () => {
      results[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      await nextFrame();
    });

    expect(document.activeElement).toBe(results[1]);
    expect(results[1]!.getAttribute("aria-current")).toBe("true");
    expect(query!.getAttribute("aria-activedescendant")).toBe(results[1]!.id);

    await act(async () =>
      results[1]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })),
    );
    expect(openedFiles).toEqual([{ relativePath: "src/other.ts", line: 2 }]);
    expect(openChanges).toEqual([false]);
  });

  it("enforces the contract length on the query and file mask", async () => {
    const query = container.querySelector<HTMLInputElement>("[aria-label='Find in Files']");
    const fileMask = container.querySelector<HTMLInputElement>("[aria-label='File mask']");
    expect(query?.maxLength).toBe(256);
    expect(fileMask?.maxLength).toBe(256);

    await act(async () => {
      setInputValue(query!, "q".repeat(257));
      setInputValue(fileMask!, "m".repeat(257));
    });
    expect(query?.value).toHaveLength(256);
    expect(fileMask?.value).toHaveLength(256);
  });

  it("shows results for a whitespace-only content query", async () => {
    const query = container.querySelector<HTMLInputElement>(
      "[data-testid=project-text-search-input]",
    );
    await act(async () => setInputValue(query!, " "));

    expect(testState.lastTarget?.query).toBe(" ");
    expect(container.textContent).not.toContain("Type to search project text.");
    expect(container.querySelectorAll("[data-content-search-result]")).toHaveLength(2);
  });

  it("uses singular result-count grammar", async () => {
    testState.matches = [testState.matches[0]!];
    const query = container.querySelector<HTMLInputElement>(
      "[data-testid=project-text-search-input]",
    );
    await act(async () => setInputValue(query!, "const"));

    expect(container.querySelector("[role=status]")?.textContent).toBe("1 match in 1 file");
  });

  it("uses the command palette input, selection, hover, and footer language", async () => {
    const query = container.querySelector<HTMLInputElement>("[aria-label='Find in Files']");
    await act(async () => setInputValue(query!, "const"));
    const queryGroup = query?.closest<HTMLElement>("[data-slot=input-group]");
    const fileMask = container.querySelector<HTMLInputElement>("[aria-label='File mask']");
    const fileMaskGroup = fileMask?.closest<HTMLElement>("[data-slot=input-group]");
    const fileMaskLabel = [...(fileMaskGroup?.querySelectorAll("span") ?? [])].find(
      (element) => element.textContent === "File mask:",
    );
    const selectedResult = container.querySelector<HTMLElement>("[aria-selected=true]");
    const unselectedResult = container.querySelector<HTMLElement>("[aria-selected=false]");
    const footer = container.querySelector<HTMLElement>("[data-slot=command-footer]");

    expect(queryGroup?.className).toContain("border-transparent!");
    expect(queryGroup?.className).toContain("ring-0!");
    expect(fileMaskGroup?.className).toContain("sm:w-64");
    expect(fileMaskLabel?.className).toContain("whitespace-nowrap");
    expect(fileMaskGroup?.querySelector("svg")?.getAttribute("class")).toContain("mx-0!");
    expect(selectedResult?.className).toContain("bg-accent");
    expect(selectedResult?.className).not.toContain("bg-primary");
    expect(unselectedResult?.className).toContain("hover:bg-foreground/[0.06]");
    expect(footer).not.toBeNull();
    expect(footer?.querySelectorAll("[data-slot=kbd]")).toHaveLength(4);
    expect(footer?.textContent).toContain("Navigate");
    expect(footer?.textContent).toContain("EnterOpen");
    expect(footer?.textContent).toContain("EscClose");
  });

  it("applies the same command palette language to Shift+Shift file search", async () => {
    await act(async () =>
      root.render(
        <FileSearchDialog
          open
          environmentId={EnvironmentId.make("test-environment")}
          threadRef={threadRef}
          cwd="/workspace/project"
          projectName="project"
          onOpenChange={(open) => openChanges.push(open)}
          onOpenFile={(relativePath) => openedFiles.push({ relativePath, line: undefined })}
        />,
      ),
    );

    const query = container.querySelector<HTMLInputElement>("[aria-label='Search Files']");
    const queryGroup = query?.closest<HTMLElement>("[data-slot=input-group]");
    const selectedResult = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("main.ts"),
    );
    const unselectedResult = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("other.ts"),
    );

    expect(queryGroup?.className).toContain("border-transparent!");
    expect(selectedResult?.className).toContain("bg-accent");
    expect(selectedResult?.className).not.toContain("bg-primary");
    expect(unselectedResult?.className).toContain("hover:bg-foreground/[0.06]");
    expect(container.querySelector("[data-slot=command-footer]")).not.toBeNull();
  });

  it("opens shortcut search dialogs without a file viewer surface", async () => {
    const handled: number[] = [];
    await act(async () =>
      root.render(
        <FileSearchDialogs
          commandRequest={{ id: 1, command: "filePicker.toggle" }}
          onCommandRequestHandled={(id) => handled.push(id)}
          environmentId={EnvironmentId.make("test-environment")}
          threadRef={threadRef}
          cwd="/workspace/project"
          projectName="project"
          onOpenFile={(relativePath) => openedFiles.push({ relativePath, line: undefined })}
        />,
      ),
    );

    expect(container.querySelector("[data-file-viewer]")).toBeNull();
    expect(container.querySelector("[aria-label='Search Files']")).not.toBeNull();
    expect(handled).toEqual([1]);
  });
});
