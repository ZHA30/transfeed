import { writeTextFile } from "../lib/files.js";
import { runFeature } from "../features/index.js";
import { renderRss } from "../output/rss.js";
import type {
  FeatureRunStatsReport,
  FetchedFeedSuccess,
  OperationCache,
  ProcessedFeedResult,
} from "../types.js";

export async function runProcessStage(
  fetchedFeeds: FetchedFeedSuccess[],
  cache: OperationCache,
  usedCacheKeys: Set<string>,
): Promise<ProcessedFeedResult[]> {
  const results: ProcessedFeedResult[] = [];

  for (const fetchedFeed of fetchedFeeds) {
    const startedAt = Date.now();
    const { feed, normalized } = fetchedFeed;
    const featureStats: FeatureRunStatsReport[] = [];
    const issues = [...fetchedFeed.issues];

    try {
      let currentItems = normalized.channel.items;

      for (const feature of feed.features) {
        const result = await runFeature(currentItems, feature, { feed, cache });
        currentItems = result.items;
        issues.push(...result.issues);
        featureStats.push({
          kind: result.stats.kind,
          units: result.stats.units,
          cacheHits: result.stats.cacheHits,
          generated: result.stats.generated,
          failed: result.stats.failed,
        });
        for (const cacheKey of result.stats.usedCacheKeys) {
          usedCacheKeys.add(cacheKey);
        }
      }

      const rendered = renderRss(normalized, feed, currentItems);
      await writeTextFile(rendered.outputPath, rendered.xml);

      results.push({
        kind: "success",
        feed,
        normalized,
        rendered,
        featureStats,
        issues,
        startedAt,
        finishedAt: Date.now(),
      });
    } catch (error) {
      issues.push({
        stage: "feature",
        severity: "error",
        code: "feed_processing_failed",
        message: errorToMessage(error),
        path: feed.path,
      });
      results.push({
        kind: "failure",
        feed,
        normalized,
        featureStats,
        issues,
        startedAt,
        finishedAt: Date.now(),
      });
    }
  }

  return results;
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return "feed processing failed";
}
