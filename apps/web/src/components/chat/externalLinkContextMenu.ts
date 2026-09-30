// Coder keeps upstream's host resolution only; its context menu opens links in the excluded
// in-app browser preview.
export function resolveExternalWebLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}
