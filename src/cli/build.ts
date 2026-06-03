import { rm } from "node:fs/promises";
import { loadConfig } from "../config/load.js";
import { extractFeed } from "../pipeline/extract.js";
import { writeTextFile, writeJsonFile } from "../lib/files.js";
import { fetchText } from "../feed/fetch.js";
import { parseFeedXml, windowFeed } from "../feed/normalize.js";
import { redactUrl } from "../lib/url.js";
import { reembedFeed } from "../output/reembed.js";
import { renderRss } from "../output/rss.js";
import { loadTranslationCache, pruneCache, saveTranslationCache } from "../state/cache.js";
import { stateFilePath } from "../state/paths.js";
import { translateFeed } from "../pipeline/translate.js";
import type { FeedRunReport, PipelineIssue, RunReport } from "../types.js";

const FETCH_TIMEOUT_SECONDS = 30;

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const issues: PipelineIssue[] = [];
  const feedReports: FeedRunReport[] = [];
  const usedCacheKeys = new Set<string>();

  await rm("dist", { recursive: true, force: true });

  const configs = await loadConfig();
  const cache = await loadTranslationCache();

  for (const config of configs) {
    try {
      const fetched = await fetchText(config.url, FETCH_TIMEOUT_SECONDS);
      const normalized = windowFeed(parseFeedXml(fetched.body, config, fetched.finalUrl));
      const extracted = extractFeed(normalized, config);
      const translated = await translateFeed(extracted, cache);
      const renderedItems = reembedFeed(normalized, config, extracted, translated);
      const rendered = renderRss(normalized, config, renderedItems);

      for (const unit of extracted.units) {
        if (translated.units.some((result) => result.cacheKey === unit.cacheKey && result.status !== "failed")) {
          usedCacheKeys.add(unit.cacheKey);
        }
      }

      await writeTextFile(rendered.outputPath, rendered.xml);
      const failedUnits = translated.units.filter((unit) => unit.status === "failed").length;
      const feedIssues = [...normalized.issues, ...extracted.issues, ...translated.issues, ...rendered.issues];
      issues.push(...feedIssues);
      feedReports.push({
        path: config.path,
        sourceUrl: redactUrl(config.url),
        outputPath: rendered.outputPath,
        limit: config.limit,
        inputItems: normalized.channel.items.length,
        outputItems: rendered.itemCount,
        units: extracted.units.length,
        cacheHits: translated.units.filter((unit) => unit.status === "cached").length,
        translated: translated.units.filter((unit) => unit.status === "translated").length,
        failedUnits,
        issues: feedIssues,
      });
    }
    catch (error) {
      const issue: PipelineIssue = {
        stage: "fetch",
        severity: "error",
        code: "feed_failed",
        message: errorToMessage(error),
        path: config.path,
      };
      issues.push(issue);
      feedReports.push({
        path: config.path,
        sourceUrl: redactUrl(config.url),
        limit: config.limit,
        inputItems: 0,
        outputItems: 0,
        units: 0,
        cacheHits: 0,
        translated: 0,
        failedUnits: 0,
        issues: [issue],
      });
    }
  }

  const nextCache = pruneCache(cache, usedCacheKeys);
  await saveTranslationCache(nextCache);

  const report = makeReport(runId, startedAt, new Date().toISOString(), feedReports, issues);
  await writeJsonFile(stateFilePath("reports/latest.json"), report);
  writeSummary(report);

  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

function makeReport(runId: string, startedAt: string, finishedAt: string, feeds: FeedRunReport[], issues: PipelineIssue[]): RunReport {
  const renderedFeeds = feeds.filter((feed) => feed.outputItems > 0).length;
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
      units: feeds.reduce((sum, feed) => sum + feed.units, 0),
      cacheHits: feeds.reduce((sum, feed) => sum + feed.cacheHits, 0),
      translated: feeds.reduce((sum, feed) => sum + feed.translated, 0),
      failedUnits: feeds.reduce((sum, feed) => sum + feed.failedUnits, 0),
    },
    issues,
  };
}

function writeSummary(report: RunReport): void {
  console.log(`Transfeed ${report.status}`);
  console.log(`Feeds: ${report.totals.renderedFeeds}/${report.totals.feeds}`);
  console.log(`Items: ${report.totals.outputItems}`);
  console.log(`Units: ${report.totals.units}, cache hits: ${report.totals.cacheHits}, translated: ${report.totals.translated}, failed: ${report.totals.failedUnits}`);
  for (const issue of report.issues) {
    console.log(`[${issue.severity}] ${issue.path ?? ""} ${issue.code}: ${issue.message}`);
  }
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
  }
  return "feed failed";
}

await main();
