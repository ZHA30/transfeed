import { writeTextFile } from "../lib/files.js";
import { runFeature } from "../features/index.js";
import { renderRss } from "../output/rss.js";
import type {
  FeatureKind,
  FeatureRunStatsReport,
  FetchedFeedSuccess,
  FeedFeatureConfig,
  NormalizedItem,
  OperationCache,
  PipelineIssue,
  ProcessedFeedResult,
} from "../types.js";

const FEATURE_STAGE_ORDER: FeatureKind[] = ["translate", "summary"];

interface FeatureOutput {
  feature: FeedFeatureConfig;
  items: NormalizedItem[];
  stats: FeatureRunStatsReport;
  issues: PipelineIssue[];
}

interface FeedProcessingState {
  feed: FetchedFeedSuccess["feed"];
  normalized: FetchedFeedSuccess["normalized"];
  baseItems: NormalizedItem[];
  featureOutputs: FeatureOutput[];
  featureStats: FeatureRunStatsReport[];
  issues: PipelineIssue[];
  failed: boolean;
}

export async function runProcessStage(
  fetchedFeeds: FetchedFeedSuccess[],
  cache: OperationCache,
  usedCacheKeys: Set<string>,
): Promise<ProcessedFeedResult[]> {
  const stageStartedAt = Date.now();
  const states = initializeStates(fetchedFeeds);

  for (const kind of FEATURE_STAGE_ORDER) {
    for (const state of states) {
      if (state.failed) {
        continue;
      }
      const feature = state.feed.features.find((entry) => entry.kind === kind);
      if (!feature) {
        continue;
      }

      try {
        const result = await runFeature(state.baseItems, feature, { feed: state.feed, cache });
        const stats: FeatureRunStatsReport = {
          kind: result.stats.kind,
          units: result.stats.units,
          cacheHits: result.stats.cacheHits,
          generated: result.stats.generated,
          failed: result.stats.failed,
        };
        state.featureOutputs.push({
          feature,
          items: result.items,
          stats,
          issues: result.issues,
        });
        state.featureStats.push(stats);
        state.issues.push(...result.issues);
        for (const cacheKey of result.stats.usedCacheKeys) {
          usedCacheKeys.add(cacheKey);
        }
      } catch (error) {
        state.failed = true;
        state.issues.push({
          stage: "feature",
          severity: "error",
          code: "feed_processing_failed",
          message: errorToMessage(error),
          path: state.feed.path,
          feature: kind,
        });
      }
    }
  }

  const results: ProcessedFeedResult[] = [];
  for (const state of states) {
    const startedAt = stageStartedAt;
    if (state.failed) {
      results.push({
        kind: "failure",
        feed: state.feed,
        normalized: state.normalized,
        featureStats: state.featureStats,
        issues: state.issues,
        startedAt,
        finishedAt: Date.now(),
      });
      continue;
    }

    try {
      const mergedItems = mergeFeatureOutputs(state.baseItems, state.featureOutputs);
      const rendered = renderRss(state.normalized, state.feed, mergedItems);
      await writeTextFile(rendered.outputPath, rendered.xml);

      results.push({
        kind: "success",
        feed: state.feed,
        normalized: state.normalized,
        rendered,
        featureStats: state.featureStats,
        issues: state.issues,
        startedAt,
        finishedAt: Date.now(),
      });
    } catch (error) {
      state.issues.push({
        stage: "render",
        severity: "error",
        code: "feed_render_failed",
        message: errorToMessage(error),
        path: state.feed.path,
      });
      results.push({
        kind: "failure",
        feed: state.feed,
        normalized: state.normalized,
        featureStats: state.featureStats,
        issues: state.issues,
        startedAt,
        finishedAt: Date.now(),
      });
    }
  }

  return results;
}

function initializeStates(fetchedFeeds: FetchedFeedSuccess[]): FeedProcessingState[] {
  return fetchedFeeds.map((fetchedFeed) => ({
    feed: fetchedFeed.feed,
    normalized: fetchedFeed.normalized,
    baseItems: fetchedFeed.normalized.channel.items,
    featureOutputs: [],
    featureStats: [],
    issues: [...fetchedFeed.issues],
    failed: false,
  }));
}

function mergeFeatureOutputs(baseItems: NormalizedItem[], featureOutputs: FeatureOutput[]): NormalizedItem[] {
  const byItemKey = new Map(baseItems.map((item) => [item._meta.itemKey, cloneItem(item)]));

  applyTranslateOutputs(byItemKey, featureOutputs);
  applySummaryOutputs(byItemKey, featureOutputs);

  return baseItems.map((item) => byItemKey.get(item._meta.itemKey) ?? cloneItem(item));
}

function applyTranslateOutputs(byItemKey: Map<string, NormalizedItem>, featureOutputs: FeatureOutput[]): void {
  for (const output of featureOutputs) {
    if (output.feature.kind !== "translate") {
      continue;
    }
    for (const translatedItem of output.items) {
      const current = byItemKey.get(translatedItem._meta.itemKey);
      if (!current) {
        continue;
      }
      for (const field of output.feature.fields) {
        current[field] = translatedItem[field];
      }
    }
  }
}

function applySummaryOutputs(byItemKey: Map<string, NormalizedItem>, featureOutputs: FeatureOutput[]): void {
  for (const output of featureOutputs) {
    if (output.feature.kind !== "summary") {
      continue;
    }
    for (const summarizedItem of output.items) {
      const current = byItemKey.get(summarizedItem._meta.itemKey);
      if (!current) {
        continue;
      }
      current[output.feature.sourceField] = summarizedItem[output.feature.sourceField];
    }
  }
}

function cloneItem(item: NormalizedItem): NormalizedItem {
  return {
    ...item,
    category: [...item.category],
    enclosure: item.enclosure ? { ...item.enclosure } : undefined,
  };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return "feed processing failed";
}
