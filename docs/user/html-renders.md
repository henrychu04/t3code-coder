# Visual replies

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or
mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent
builds a self-contained HTML page, which appears in the thread above its written reply. It works
with Codex, Claude Code, and Pi.

Pages use your current theme, including custom themes, and follow light and dark mode as you
switch. Scripts run inside the page, but it is sandboxed away from T3 Coder and your session. Links
you click in a page open in a new browser tab. Use the expand button to open a page full size; from
there you can view its source or save it.

Agents can place images from the workspace in a page by their absolute paths. T3 Coder embeds them
when the page is published, so the page keeps working after the original files move or are
deleted. A page, with its images, can be up to 10 MiB.

Unlike upstream T3 Code, T3 Coder does not download a headless browser for agents to check their
pages with screenshots, so agents publish without that preview step. The frame uses the height the
agent chose and shrinks to fit a shorter page; a longer page scrolls inside it.

## MCP apps

Some MCP servers return an interactive app with their tool results, following the
[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) standard. When an agent calls one of
those tools, the app appears in the thread in place of the tool call. Codex supports this today, for
any MCP server configured for it in the workspace; other providers show these calls as ordinary
tool calls.

Apps follow your theme. An app can call tools on its own server and post a message to the thread;
T3 Coder asks first unless the server marks the tool as read-only, and it asks before every
message. An app stays viewable after its agent stops, but using it needs the agent of the thread
that created it running, so send a message in that thread first if the app says it is unavailable.
An app that navigates away from its own page is stopped. An app can offer a file to save;
T3 Coder asks you first.

An app can open full screen; use the button in its top corner, or press Escape outside the app, to
return it to the thread. Anything else that needs your attention, such as an approval, also returns
it to the thread. An app can also keep the agent informed of what you did in it, such as a filter you
picked; T3 Coder sends the latest note from each app with your next message.
