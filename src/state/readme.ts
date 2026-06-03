import type { FeedConfig } from "../types.js";

export function renderReadme(feeds: FeedConfig[], pageUrl: string): string {
  const baseUrl = normalizeBaseUrl(pageUrl);
  return `${feeds
    .map((feed) => {
      const href = `${baseUrl}${encodePath(feed.pathKey)}.xml`;
      return `- [${feed.path}](${href})`;
    })
    .join("\n")}\n`;
}

function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("page URL is required to render state README");
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function encodePath(pathKey: string): string {
  return pathKey.split("/").map(encodeURIComponent).join("/");
}
