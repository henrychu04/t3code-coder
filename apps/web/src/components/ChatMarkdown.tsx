import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  InfoIcon,
  LightbulbIcon,
  Maximize2Icon,
  MessageSquareWarningIcon,
  Minimize2Icon,
  OctagonAlertIcon,
  TriangleAlertIcon,
  WrapTextIcon,
} from "lucide-react";
import {
  Children,
  Suspense,
  type ClipboardEvent as ReactClipboardEvent,
  type ComponentProps,
  type CSSProperties,
  isValidElement,
  memo,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Components, Options as ReactMarkdownOptions } from "react-markdown";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { getClientSettings } from "../hooks/useSettings";
import { useTheme } from "../hooks/useTheme";
import { fnv1a32, resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { getSyntaxHighlighterPromise } from "../lib/syntaxHighlighting";
import { cn } from "../lib/utils";
import { resolveMarkdownFileLinkMeta } from "../markdown-links";
import { useRightPanelStore } from "../rightPanelStore";
import {
  chatMarkdownClipboardPayload,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../markdown-clipboard";
import { remarkGithubAlerts } from "../markdown-github-alerts";
import { remarkNormalizeListItemIndentation } from "../markdown-list-indentation";
import { RenderErrorBoundary } from "./RenderErrorBoundary";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

interface ChatMarkdownProps {
  readonly text: string;
  /** Used only to resolve contained project-relative Files links. */
  readonly cwd: string | undefined;
  /** Opens contained project file links in the in-browser Files surface. */
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onTaskListChange?: (input: { markerOffset: number; checked: boolean }) => void;
  readonly isStreaming?: boolean;
  readonly skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly className?: string;
  readonly lineBreaks?: boolean;
  readonly parseRawHtml?: boolean;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];
const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;
const highlightedCodeCache = new LRUCache<string>(500, 50 * 1024 * 1024);

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  data?: { hProperties?: Record<string, unknown> };
  children?: MarkdownAstNode[];
};

const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta", "dataInlineCode"],
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), "dataAlert"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkPreserveCodeMeta,
  remarkTagInlineCode,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = [
  remarkGfm,
  remarkGithubAlerts,
  remarkNormalizeListItemIndentation,
  remarkBreaks,
  remarkPreserveCodeMeta,
  remarkTagInlineCode,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

const GITHUB_ALERT_PRESENTATIONS: Record<
  string,
  { label: string; Icon: typeof InfoIcon; borderClassName: string; titleClassName: string }
> = {
  note: {
    label: "Note",
    Icon: InfoIcon,
    borderClassName: "border-blue-500/70",
    titleClassName: "text-blue-600 dark:text-blue-400",
  },
  tip: {
    label: "Tip",
    Icon: LightbulbIcon,
    borderClassName: "border-emerald-500/70",
    titleClassName: "text-emerald-600 dark:text-emerald-400",
  },
  important: {
    label: "Important",
    Icon: MessageSquareWarningIcon,
    borderClassName: "border-purple-500/70",
    titleClassName: "text-purple-600 dark:text-purple-400",
  },
  warning: {
    label: "Warning",
    Icon: TriangleAlertIcon,
    borderClassName: "border-amber-500/70",
    titleClassName: "text-amber-600 dark:text-amber-500",
  },
  caution: {
    label: "Caution",
    Icon: OctagonAlertIcon,
    borderClassName: "border-red-500/70",
    titleClassName: "text-red-600 dark:text-red-400",
  },
};

export function orderedListGutterStyle(
  itemCount: number,
  start: unknown,
): { "--list-gutter": string } | undefined {
  const parsedStart = Number.parseInt(String(start ?? 1), 10);
  const firstNumber = Number.isNaN(parsedStart) ? 1 : parsedStart;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const markerWidth = Math.max(String(firstNumber).length, String(lastNumber).length);
  return markerWidth <= 2 ? undefined : { "--list-gutter": `${markerWidth + 1}ch` };
}

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  return match?.[1] ? listItemStart + firstLine.indexOf(match[1]) : null;
}

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim()) {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataCodeMeta: node.meta.trim() },
        };
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

function remarkTagInlineCode() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode, insideLink: boolean) => {
      if (node.type === "inlineCode" && !insideLink) {
        node.data = {
          ...node.data,
          hProperties: { ...node.data?.hProperties, dataInlineCode: "" },
        };
      }
      const childInsideLink = insideLink || node.type === "link" || node.type === "linkReference";
      node.children?.forEach((child) => visit(child, childInsideLink));
    };
    visit(tree, false);
  };
}

function extractFenceLanguage(className: string | undefined): string {
  const raw = className?.match(CODE_FENCE_LANGUAGE_REGEX)?.[1] ?? "text";
  return raw === "gitignore" ? "ini" : raw;
}

function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const match = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const title = match?.[1] ?? match?.[2] ?? match?.[3];
  if (title) return title;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;
  const codeNode = children?.find((child) => child.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim() ? meta.trim() : undefined;
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToPlainText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeToPlainText(node.props.children);
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) return null;
  const child = childNodes[0];
  if (
    !isValidElement<{ className?: string; children?: ReactNode; node?: { tagName?: string } }>(
      child,
    ) ||
    (child.type !== "code" && child.props.node?.tagName !== "code")
  ) {
    return null;
  }
  return { className: child.props.className, code: nodeToPlainText(child.props.children) };
}

function MarkdownCopyAction({ label, value }: { label: string; value: () => string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current != null) clearTimeout(timerRef.current);
    },
    [],
  );
  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) return;
    void navigator.clipboard
      .writeText(value())
      .then(() => {
        if (timerRef.current != null) clearTimeout(timerRef.current);
        setCopied(true);
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      })
      .catch((cause) => console.error("[chat-markdown] copy failed", { label }, cause));
  }, [label, value]);
  const actionLabel = copied ? "Copied" : label;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-chrome-action"
            aria-label={actionLabel}
            onClick={handleCopy}
          />
        }
      >
        {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup side="top">{actionLabel}</TooltipPopup>
    </Tooltip>
  );
}

function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [expanded, setExpanded] = useState(() => getClientSettings().wordWrap);
  const serialize = useCallback(
    (format: "markdown" | "csv") => () => {
      const table = tableRef.current;
      if (!table) return "";
      return format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    },
    [],
  );
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  return (
    <div className="chat-markdown-table-container" data-expanded={expanded ? "true" : "false"}>
      <div className="w-full max-w-full overflow-x-auto">
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </div>
      <div className="mt-0.5 flex items-center justify-between select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="chat-markdown-chrome-action"
                aria-pressed={expanded}
                aria-label={expandLabel}
                onClick={() => setExpanded((value) => !value)}
              />
            }
          >
            {expanded ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <span className="flex items-center gap-0.5">
          <MarkdownCopyAction label="Copy table as Markdown" value={serialize("markdown")} />
          <MarkdownCopyAction label="Copy table as CSV" value={serialize("csv")} />
        </span>
      </div>
    </div>
  );
}

function MarkdownDetails({
  children,
  open = false,
}: Pick<ComponentProps<"details">, "children" | "open">) {
  const [isOpen, setIsOpen] = useState(open);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <Collapsible
      defaultOpen={open}
      onOpenChange={setIsOpen}
      className="chat-markdown-details my-2 border-y border-border/60"
      data-markdown-details=""
      data-markdown-details-open={isOpen ? "true" : "false"}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
        data-markdown-details-summary=""
      >
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform"
          aria-hidden
        />
        <span>{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pb-3 ps-6 text-foreground/80" data-markdown-details-content="">
          {content}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  children: ReactNode;
}) {
  const [wrapped, setWrapped] = useState(() => getClientSettings().wordWrap);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const codeValue = useCallback(() => code, [code]);
  return (
    <div
      className="chat-markdown-codeblock my-[0.65rem] overflow-hidden rounded-[var(--radius)] border border-border/70 bg-secondary leading-snug dark:border-transparent dark:bg-input/32"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header flex items-center justify-between gap-2 pt-1.5 pr-1.5 pb-0 pl-3 select-none">
        <span className="truncate [font-family:var(--font-mono)] [font-size:0.6875rem]">
          {fenceTitle ?? language}
        </span>
        <span className="flex items-center gap-0.5" role="toolbar" aria-label="Code block actions">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={wrapped}
                  aria-label={wrapLabel}
                  onClick={() => setWrapped((value) => !value)}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <MarkdownCopyAction label="Copy code" value={codeValue} />
        </span>
      </div>
      {children}
    </div>
  );
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
}: {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
}) {
  const language = extractFenceLanguage(className);
  const cacheKey = `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
  const cachedHtml = isStreaming ? null : highlightedCodeCache.get(cacheKey);
  if (cachedHtml != null) {
    return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: cachedHtml }} />;
  }
  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
    />
  );
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
}: {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
}) {
  const highlighter = use(getSyntaxHighlighterPromise(language));
  const html = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (cause) {
      console.warn(`Code highlighting failed for language "${language}".`, cause);
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);
  useEffect(() => {
    if (!isStreaming)
      highlightedCodeCache.set(cacheKey, html, Math.max(html.length * 2, code.length * 3));
  }, [cacheKey, code, html, isStreaming]);
  return <div className="chat-markdown-shiki" dangerouslySetInnerHTML={{ __html: html }} />;
}

function InertMarkdownImage({ alt }: { alt: string }) {
  return (
    <span className="my-1 inline-flex items-center gap-1.5 rounded-md border border-border/40 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
      <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
      {alt ? `Image unavailable · ${alt}` : "Image unavailable"}
    </span>
  );
}

function ChatMarkdown({
  text,
  cwd,
  threadRef,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
  parseRawHtml = true,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  }, []);

  const markdownComponents = useMemo<Components>(
    () => ({
      p({ node: _node, children, ...props }) {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
      },
      blockquote({ node: _node, children, ...props }) {
        const alert =
          GITHUB_ALERT_PRESENTATIONS[
            String((props as Record<string, unknown>)["data-alert"] ?? "")
          ];
        if (!alert) return <blockquote {...props}>{children}</blockquote>;
        return (
          <div role="note" className={cn("my-1 border-l-2 pl-3", alert.borderClassName)}>
            <p className={cn("flex items-center gap-1.5 font-medium", alert.titleClassName)}>
              <alert.Icon aria-hidden className="size-3.5 shrink-0" />
              {alert.label}
            </p>
            {children}
          </div>
        );
      },
      ol({ node, start, style, ...props }) {
        const itemCount =
          node?.children?.filter((child) => child.type === "element" && child.tagName === "li")
            .length ?? 0;
        const gutterStyle = orderedListGutterStyle(itemCount, start);
        return (
          <ol
            {...props}
            start={start}
            style={{ ...style, ...(gutterStyle as CSSProperties | undefined) }}
          />
        );
      },
      li({ node, children, ...props }) {
        const listItemStart = node?.position?.start.offset;
        const markerOffset =
          typeof listItemStart === "number" ? findTaskListMarkerOffset(text, listItemStart) : null;
        return (
          <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
            {renderSkillInlineMarkdownChildren(children, skills)}
          </li>
        );
      },
      input({ node: _node, type, checked, disabled, ...props }) {
        if (type !== "checkbox" || !onTaskListChange) {
          return <input {...props} type={type} checked={checked} disabled={disabled} readOnly />;
        }
        return (
          <input
            {...props}
            type="checkbox"
            name="markdown-task"
            aria-label="Toggle task"
            checked={checked}
            onChange={(event) => {
              const markerOffset = Number(
                event.currentTarget.closest("li")?.dataset.taskMarkerOffset,
              );
              if (Number.isSafeInteger(markerOffset)) {
                onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
              }
            }}
          />
        );
      },
      a({ node: _node, href, children, title: _title, ...props }) {
        if (href?.startsWith("#")) {
          return (
            <a {...props} href={href}>
              {children}
            </a>
          );
        }
        const fileLink = resolveMarkdownFileLinkMeta(href, cwd);
        if (threadRef && fileLink?.workspaceRelativePath) {
          return (
            <button
              type="button"
              className={cn(props.className, "cursor-pointer text-primary underline")}
              onClick={() =>
                useRightPanelStore
                  .getState()
                  .openFile(threadRef, fileLink.workspaceRelativePath!, fileLink.line)
              }
            >
              {children}
            </button>
          );
        }
        return <span className={cn(props.className, "text-primary underline")}>{children}</span>;
      },
      img({ node: _node, title: _title, src: _src, alt }) {
        return <InertMarkdownImage alt={alt ?? ""} />;
      },
      code({ node: _node, children, className: codeClassName, ...props }) {
        return (
          <code {...props} className={cn(codeClassName, "font-mono")}>
            {children}
          </code>
        );
      },
      table({ node: _node, ...props }) {
        return <MarkdownTable {...props} />;
      },
      details({ node: _node, children, open }) {
        return <MarkdownDetails open={open}>{children}</MarkdownDetails>;
      },
      pre({ node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) return <pre {...props}>{children}</pre>;
        const language = extractFenceLanguage(codeBlock.className);
        const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
        return (
          <MarkdownCodeBlock code={codeBlock.code} language={language} fenceTitle={fenceTitle}>
            <RenderErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                />
              </Suspense>
            </RenderErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    }),
    [cwd, diffThemeName, isStreaming, onTaskListChange, skills, text, threadRef],
  );

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80 [overflow-wrap:anywhere] [word-break:break-word]",
        className,
      )}
      onCopy={handleCopy}
    >
      <ReactMarkdown
        remarkPlugins={
          lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS
        }
        rehypePlugins={parseRawHtml ? CHAT_MARKDOWN_REHYPE_PLUGINS : undefined}
        skipHtml={false}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
