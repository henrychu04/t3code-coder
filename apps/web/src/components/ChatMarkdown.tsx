import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import { memo, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/utils";

interface ChatMarkdownProps {
  readonly text: string;
  readonly cwd: string | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onTaskListChange?: (input: { markerOffset: number; checked: boolean }) => void;
  readonly isStreaming?: boolean;
  readonly skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  readonly className?: string;
  readonly lineBreaks?: boolean;
  readonly parseRawHtml?: boolean;
}

export function orderedListGutterStyle(
  itemCount: number,
  start: number | undefined,
): { "--list-gutter": string } | undefined {
  const firstNumber = typeof start === "number" && Number.isFinite(start) ? start : 1;
  const lastNumber = firstNumber + Math.max(itemCount - 1, 0);
  const digits = String(Math.abs(lastNumber)).length;
  return digits <= 2 ? undefined : { "--list-gutter": `${digits + 1}ch` };
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

function ChatMarkdown({
  text,
  className,
  lineBreaks = false,
  onTaskListChange,
}: ChatMarkdownProps) {
  return (
    <div className={cn("chat-markdown", className)}>
      <ReactMarkdown
        remarkPlugins={lineBreaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        skipHtml
        components={{
          a({ href, children }) {
            if (href?.startsWith("#")) {
              return <a href={href}>{children}</a>;
            }
            return (
              <span className="text-primary underline decoration-primary/40" title={href}>
                {children}
              </span>
            );
          },
          img({ alt }) {
            return <span className="text-muted-foreground">[image{alt ? `: ${alt}` : ""}]</span>;
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
              typeof listItemStart === "number"
                ? findTaskListMarkerOffset(text, listItemStart)
                : null;
            return (
              <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
                {children}
              </li>
            );
          },
          input({ type, checked, ...props }) {
            if (type !== "checkbox" || !onTaskListChange) {
              return <input {...props} type={type} checked={checked} readOnly />;
            }
            return (
              <input
                {...props}
                type="checkbox"
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
          code({ className: codeClassName, children, ...props }) {
            return (
              <code {...props} className={cn(codeClassName, "font-mono")}>
                {children}
              </code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
