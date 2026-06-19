import { fetchText } from "../feed/fetch.js";
import { parseFeedXml, windowFeed } from "../feed/normalize.js";
import { redactUrl } from "../lib/url.js";
import type { FeedConfig, FetchedFeedResult, PipelineIssue } from "../types.js";

const FETCH_TIMEOUT_SECONDS = 30;

export async function runFetchStage(feeds: FeedConfig[]): Promise<FetchedFeedResult[]> {
  const results: FetchedFeedResult[] = [];

  for (const feed of feeds) {
    const startedAt = Date.now();
    try {
      const fetched = await fetchText(feed.url, FETCH_TIMEOUT_SECONDS);
      const normalized = windowFeed(parseFeedXml(fetched.body, feed, fetched.finalUrl));
      results.push({
        kind: "success",
        feed,
        normalized,
        issues: [...normalized.issues],
        startedAt,
        finishedAt: Date.now(),
      });
    } catch (error) {
      const issue: PipelineIssue = {
        stage: "fetch",
        severity: "error",
        code: "feed_failed",
        message: errorToMessage(error),
        path: feed.path,
      };
      results.push({
        kind: "failure",
        feed,
        issues: [issue],
        startedAt,
        finishedAt: Date.now(),
      });
    }
  }

  return results;
}

export function describeFetchSource(feed: FeedConfig): string {
  return redactUrl(feed.url);
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return "feed failed";
}
