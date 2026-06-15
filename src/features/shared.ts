import { sha256 } from "../lib/hash.js";
import { logGroup, logGroupEnd, logKeyValue } from "../lib/logger.js";
import { runStructuredBatch, type LlmBatchItem } from "../pipeline/llm.js";
import { putCacheEntry } from "../state/cache.js";
import type {
  FeatureContext,
  FeatureKind,
  OperationResult,
  OperationUnit,
  PipelineIssue,
} from "../types.js";

const BATCH_MAX_UNITS = 40;
const BATCH_MAX_CHARS = 12_000;
const DEFAULT_BATCH_CONCURRENCY = 3;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface FeatureGenerationOptions {
  kind: FeatureKind;
  systemPrompt: string;
  userPrompt: string;
  units: OperationUnit[];
  context: FeatureContext;
  metadata?: Record<string, string>;
}

export interface FeatureGenerationResult {
  results: OperationResult[];
  issues: PipelineIssue[];
  usedCacheKeys: Set<string>;
  model: string | null;
}

export function makePromptHash(...parts: string[]): string {
  return sha256(parts.join("\n\n"));
}

export async function generateFeatureOutputs(options: FeatureGenerationOptions): Promise<FeatureGenerationResult> {
  const { context, kind, metadata, systemPrompt, units, userPrompt } = options;
  const llmConfigModule = await import("../pipeline/llm.js");
  const llmConfig = llmConfigModule.loadLlmConfig();
  const issues: PipelineIssue[] = [];
  const results: OperationResult[] = [];
  const usedCacheKeys = new Set<string>();
  const promptHash = makePromptHash(systemPrompt, userPrompt);

  const misses: OperationUnit[] = [];
  for (const unit of units) {
    const cached = context.cache.entries[unit.cacheKey];
    if (cached && cached.feature === kind && cached.sourceHash === unit.sourceHash && cached.promptHash === promptHash && cached.output) {
      results.push({
        id: unit.id,
        cacheKey: unit.cacheKey,
        status: "cached",
        outputText: cached.output,
        attempts: 0,
      });
      usedCacheKeys.add(unit.cacheKey);
    }
    else {
      misses.push(unit);
    }
  }

  logGroup(`${kind} ${context.feed.path}`);
  logKeyValue("cache hits", results.length);
  logKeyValue("misses", misses.length);

  if (!llmConfig) {
    for (const unit of misses) {
      results.push({
        id: unit.id,
        cacheKey: unit.cacheKey,
        status: "failed",
        attempts: 0,
        errorCode: "missing_llm_config",
      });
    }
    if (misses.length > 0) {
      issues.push({
        stage: "feature",
        severity: "error",
        code: "missing_llm_config",
        message: `${kind} requires LLM configuration`,
        path: context.feed.path,
        feature: kind,
      });
    }
    logGroupEnd();
    return { results, issues, usedCacheKeys, model: null };
  }

  const batches = makeBatches(misses);
  logKeyValue("batches", batches.length);
  const batchConcurrency = Math.min(batches.length, resolveBatchConcurrency());
  logKeyValue("batch concurrency", batchConcurrency);
  await runWithConcurrency(
    batches.map((batch, index) => ({ batch, index })),
    batchConcurrency,
    async ({ batch, index }) => {
      const batchNumber = index + 1;
      const batchStartedAt = Date.now();
      console.log(`batch ${batchNumber}/${batches.length}: ${batch.length} units, ${batch.reduce((sum, unit) => sum + unit.sourceText.length, 0)} chars`);
      try {
        const items: LlmBatchItem[] = batch.map((unit) => ({ id: unit.id, input: unit.sourceText }));
        const generated = await withHeartbeat(`batch ${batchNumber}/${batches.length}`, batchStartedAt, () =>
          runStructuredBatch(llmConfig, systemPrompt, userPrompt, items),
        );

        for (const item of generated) {
          const unit = batch.find((entry) => entry.id === item.id);
          if (!unit) {
            continue;
          }
          putCacheEntry({
            cache: context.cache,
            unit,
            output: item.output,
            model: llmConfig.model,
            promptHash,
            metadata,
          });
          usedCacheKeys.add(unit.cacheKey);
          results.push({
            id: unit.id,
            cacheKey: unit.cacheKey,
            status: "generated",
            outputText: item.output,
            attempts: 1,
          });
        }

        console.log(`batch ${batchNumber}/${batches.length}: ok in ${formatDuration(Date.now() - batchStartedAt)}`);
      }
      catch (error) {
        console.log(`batch ${batchNumber}/${batches.length}: failed, retrying as single-unit requests`);
        for (const unit of batch) {
          const startedAt = Date.now();
          try {
            const [item] = await withHeartbeat(`batch ${batchNumber}/${batches.length} fallback`, startedAt, () =>
              runStructuredBatch(llmConfig, systemPrompt, userPrompt, [{ id: unit.id, input: unit.sourceText }]),
            );
            putCacheEntry({
              cache: context.cache,
              unit,
              output: item.output,
              model: llmConfig.model,
              promptHash,
              metadata,
            });
            usedCacheKeys.add(unit.cacheKey);
            results.push({
              id: unit.id,
              cacheKey: unit.cacheKey,
              status: "generated",
              outputText: item.output,
              attempts: 2,
            });
          }
          catch (singleError) {
            results.push({
              id: unit.id,
              cacheKey: unit.cacheKey,
              status: "failed",
              attempts: 2,
              errorCode: singleError instanceof Error ? singleError.message : "generation_failed",
            });
            issues.push({
              stage: "feature",
              severity: "error",
              code: "generation_failed",
              message: singleError instanceof Error ? singleError.message : "generation failed",
              path: context.feed.path,
              itemKey: unit.itemKey,
              field: unit.field,
              feature: kind,
            });
          }
        }
        console.log(`batch ${batchNumber}/${batches.length}: fallback done in ${formatDuration(Date.now() - batchStartedAt)}`);
        if (error instanceof Error) {
          issues.push({
            stage: "feature",
            severity: "warning",
            code: "batch_retry",
            message: error.message,
            path: context.feed.path,
            feature: kind,
          });
        }
      }
    },
  );

  logGroupEnd();
  return {
    results,
    issues,
    usedCacheKeys,
    model: llmConfig.model,
  };
}

function makeBatches(units: OperationUnit[]): OperationUnit[][] {
  const batches: OperationUnit[][] = [];
  let current: OperationUnit[] = [];
  let chars = 0;

  for (const unit of units) {
    if (current.length > 0 && (current.length >= BATCH_MAX_UNITS || chars + unit.sourceText.length > BATCH_MAX_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(unit);
    chars += unit.sourceText.length;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function resolveBatchConcurrency(): number {
  const raw = process.env.FEED_BATCH_CONCURRENCY;
  if (!raw) {
    return DEFAULT_BATCH_CONCURRENCY;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_BATCH_CONCURRENCY;
  }
  return parsed;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const active = new Set<Promise<void>>();
  for (const item of items) {
    const task = worker(item).finally(() => {
      active.delete(task);
    });
    active.add(task);
    if (active.size >= concurrency) {
      await Promise.race(active);
    }
  }
  await Promise.all(active);
}

async function withHeartbeat<T>(label: string, startedAt: number, task: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => {
    console.log(`${label}: running ${formatDuration(Date.now() - startedAt)}...`);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  try {
    return await task();
  }
  finally {
    clearInterval(timer);
  }
}
