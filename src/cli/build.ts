import { rm } from "node:fs/promises";
import { loadConfig } from "../config/load.js";
import { writeJsonFile } from "../lib/files.js";
import { appendStepSummary, logGroup, logGroupEnd, logKeyValue, logNotice } from "../lib/logger.js";
import { loadOperationCache, pruneCache, saveOperationCache } from "../state/cache.js";
import { stateFilePath } from "../state/paths.js";
import { describeFetchSource, runFetchStage } from "../pipeline/fetch-stage.js";
import { runProcessStage } from "../pipeline/process-stage.js";
import type {
  FeatureRunStatsReport,
  FetchedFeedResult,
  FetchedFeedSuccess,
  PipelineIssue,
  ProcessedFeedResult,
  RunReport,
} from "../types.js";

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const usedCacheKeys = new Set<string>();

  await rm("dist", { recursive: true, force: true });

  logGroup("Feed build setup");
  const appConfig = await loadConfig();
  const cache = await loadOperationCache();
  logKeyValue("feeds", appConfig.feeds.length);
  logKeyValue("cache entries", Object.keys(cache.entries).length);
  logGroupEnd();

  logGroup("Fetch stage");
  const fetchedFeeds = await runFetchStage(appConfig.feeds);
  for (const fetchedFeed of fetchedFeeds) {
    logFetchResult(fetchedFeed);
  }
  logGroupEnd();

  logGroup("Process stage");
  const processedFeeds = await runProcessStage(
    fetchedFeeds.filter((feed): feed is FetchedFeedSuccess => feed.kind === "success"),
    cache,
    usedCacheKeys,
  );
  for (const processedFeed of processedFeeds) {
    logProcessResult(processedFeed);
  }
  logGroupEnd();

  const feedReports = buildFeedReports(fetchedFeeds, processedFeeds);
  const issues = collectIssues(feedReports);

  logGroup("State and report");
  const nextCache = pruneCache(cache, usedCacheKeys);
  await saveOperationCache(nextCache);
  logKeyValue("next cache", Object.keys(nextCache.entries).length);

  const report = makeReport(runId, startedAt, new Date().toISOString(), feedReports, issues);
  await writeJsonFile(stateFilePath("reports/latest.json"), report);
  logKeyValue("report", stateFilePath("reports/latest.json"));
  logGroupEnd();

  writeSummary(report);
  await appendStepSummary(renderStepSummary(report));
  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

function logFetchResult(result: FetchedFeedResult): void {
  logGroup(`Fetch ${result.feed.path}`);
  logKeyValue("source", describeFetchSource(result.feed));
  logKeyValue("limit", result.feed.limit);
  logKeyValue("features", result.feed.features.map((feature) => feature.kind).join(", "));
  if (result.kind === "success") {
    logKeyValue("items", result.normalized.channel.items.length);
  } else {
    logKeyValue("error", result.issues[0]?.message ?? "feed failed");
  }
  logKeyValue("duration", formatDuration(result.finishedAt - result.startedAt));
  logGroupEnd();
}

function logProcessResult(result: ProcessedFeedResult): void {
  logGroup(`Process ${result.feed.path}`);
  logKeyValue("input items", result.normalized.channel.items.length);
  if (result.kind === "success") {
    logKeyValue("output", result.rendered.outputPath);
    logKeyValue("output items", result.rendered.itemCount);
  } else {
    const latestIssue = result.issues[result.issues.length - 1];
    logKeyValue("error", latestIssue?.message ?? "feed processing failed");
  }
  logKeyValue("duration", formatDuration(result.finishedAt - result.startedAt));
  logGroupEnd();
}

function collectIssues(feedReports: RunReport["feeds"]): PipelineIssue[] {
  return feedReports.flatMap((feed) => feed.issues);
}

function buildFeedReports(fetchedFeeds: FetchedFeedResult[], processedFeeds: ProcessedFeedResult[]): RunReport["feeds"] {
  const processedByPath = new Map(processedFeeds.map((feed) => [feed.feed.path, feed]));

  return fetchedFeeds.map((fetchedFeed) => {
    const processedFeed = processedByPath.get(fetchedFeed.feed.path);
    if (fetchedFeed.kind === "failure") {
      return {
        path: fetchedFeed.feed.path,
        sourceUrl: describeFetchSource(fetchedFeed.feed),
        limit: fetchedFeed.feed.limit,
        inputItems: 0,
        outputItems: 0,
        featureStats: [],
        issues: fetchedFeed.issues,
      };
    }

    if (!processedFeed || processedFeed.kind === "failure") {
      return {
        path: fetchedFeed.feed.path,
        sourceUrl: describeFetchSource(fetchedFeed.feed),
        limit: fetchedFeed.feed.limit,
        inputItems: fetchedFeed.normalized.channel.items.length,
        outputItems: 0,
        featureStats: processedFeed?.featureStats ?? [],
        issues: processedFeed?.issues ?? fetchedFeed.issues,
      };
    }

    return {
      path: fetchedFeed.feed.path,
      sourceUrl: describeFetchSource(fetchedFeed.feed),
      outputPath: processedFeed.rendered.outputPath,
      limit: fetchedFeed.feed.limit,
      inputItems: fetchedFeed.normalized.channel.items.length,
      outputItems: processedFeed.rendered.itemCount,
      featureStats: processedFeed.featureStats,
      issues: processedFeed.issues,
    };
  });
}

function makeReport(runId: string, startedAt: string, finishedAt: string, feeds: RunReport["feeds"], issues: PipelineIssue[]): RunReport {
  const renderedFeeds = feeds.filter((feed) => feed.outputItems > 0).length;
  const featureStats = summarizeFeatureStats(feeds);

  return {
    runId,
    startedAt,
    finishedAt,
    status: renderedFeeds === 0 ? "failed" : issues.some((issue) => issue.severity === "error") ? "partial" : "success",
    feeds,
    totals: {
      feeds: feeds.length,
      renderedFeeds,
      inputItems: feeds.reduce((sum, feed) => sum + feed.inputItems, 0),
      outputItems: feeds.reduce((sum, feed) => sum + feed.outputItems, 0),
      featureStats,
    },
    issues,
  };
}

function summarizeFeatureStats(feeds: RunReport["feeds"]): FeatureRunStatsReport[] {
  const stats = new Map<string, FeatureRunStatsReport>();
  for (const feed of feeds) {
    for (const feature of feed.featureStats) {
      const existing = stats.get(feature.kind);
      if (existing) {
        existing.units += feature.units;
        existing.cacheHits += feature.cacheHits;
        existing.generated += feature.generated;
        existing.failed += feature.failed;
      } else {
        stats.set(feature.kind, { ...feature });
      }
    }
  }
  return [...stats.values()];
}

function writeSummary(report: RunReport): void {
  const featureSummary = report.totals.featureStats
    .map((feature) => `${feature.kind} generated ${feature.generated}/${feature.units}`)
    .join(", ");
  logNotice(`Feed build ${report.status}: feeds ${report.totals.renderedFeeds}/${report.totals.feeds}, items ${report.totals.outputItems}${featureSummary ? `, ${featureSummary}` : ""}`);
  for (const issue of report.issues) {
    console.log(`[${issue.severity}] ${issue.path ?? ""} ${issue.code}: ${issue.message}`);
  }
}

function renderStepSummary(report: RunReport): string {
  const totals = report.totals.featureStats
    .map((feature) => `| ${feature.kind} | ${feature.units} | ${feature.cacheHits} | ${feature.generated} | ${feature.failed} |`)
    .join("\n");

  const feeds = report.feeds
    .map((feed) => {
      const summary = feed.featureStats.map((feature) => `${feature.kind}: ${feature.generated}/${feature.units}`).join(", ");
      return `| ${feed.path} | ${feed.outputItems} | ${summary || "-"} |`;
    })
    .join("\n");

  return `## Feed Build ${report.status}

| Metric | Value |
|---|---:|
| Feeds | ${report.totals.renderedFeeds}/${report.totals.feeds} |
| Items | ${report.totals.outputItems} |

| Feature | Units | Cache hits | Generated | Failed |
|---|---:|---:|---:|---:|
${totals || "| - | 0 | 0 | 0 | 0 |"}

| Feed | Items | Features |
|---|---:|---|
${feeds || "| - | 0 | - |"}
`;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

await main();
