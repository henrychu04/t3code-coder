import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from "@t3tools/shared/htmlRender";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Html = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512_000)).annotate({
  description: "A complete, self-contained HTML document.",
});

// Coder: `html_render` only. `html_preview` screenshots pages in a downloaded headless browser,
// which T3 Coder does not install, so the render description does not point agents at it. The
// height caps a frame only on upstream's mobile app, so the description omits that case.

// This affects only the caller's thread, not its workspace, so read-only sandboxes and plan mode may use it.
const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL_NAME, {
  description: `Show a finished HTML page inline in this thread, above your final reply. Do not announce or restate the page. Frame fits height to ${HTML_RENDER_MAX_FIT_HEIGHT}px. ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  parameters: Schema.Struct({
    html: Html,
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ),
    height: Schema.Int.annotate({
      description: `Frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT} to ${HTML_RENDER_MAX_HEIGHT}. Use the page's full height.`,
    }),
  }),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
      heights: Schema.optional(Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))),
    }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HtmlRender.HtmlRender,
  ],
})
  .annotate(Tool.Title, "Render HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HtmlRenderToolkit = Toolkit.make(HtmlRenderTool);
