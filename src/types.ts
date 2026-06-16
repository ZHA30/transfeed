export const ITEM_FIELDS = ["title", "description", "content:encoded", "summary", "content"] as const;
export const TRANSLATE_MODES = ["translation", "bilingual"] as const;

export type ItemField = (typeof ITEM_FIELDS)[number];
export type FeatureKind = "translate" | "summary";
export type TranslateMode = (typeof TRANSLATE_MODES)[number];
export type PipelineStage =
  | "config"
  | "fetch"
  | "normalize"
  | "feature"
  | "render"
  | "write"
  | "publish"
  | "commit-state";

export interface FeatureSystemConfig {
  systemPrompt: string;
}

export interface TranslateFeatureConfig {
  kind: "translate";
  targetLanguage: string;
  mode: TranslateMode;
  fields: ItemField[];
  systemPrompt: string;
}

export interface SummaryFeatureConfig {
  kind: "summary";
  sourceField: ItemField;
  prompt: string;
  systemPrompt: string;
}

export type FeedFeatureConfig = TranslateFeatureConfig | SummaryFeatureConfig;

export interface FeedConfig {
  path: string;
  pathKey: string;
  feedId: string;
  url: string;
  limit: number;
  features: FeedFeatureConfig[];
}

export interface AppConfig {
  feeds: FeedConfig[];
}

export interface PipelineIssue {
  stage: PipelineStage;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  path?: string;
  itemKey?: string;
  field?: ItemField;
  feature?: FeatureKind;
}

export interface NormalizedFeed {
  channel: {
    _meta: {
      path: string;
      pathKey: string;
      feedId: string;
      sourceUrl: string;
      finalUrl?: string;
      sourceFormat: "rss" | "atom" | "unknown";
      fetchedAt: string;
      sourceHash: string;
      limit: number;
    };
    title: string;
    link: string;
    description: string;
    language: string;
    image?: {
      url?: string;
      title?: string;
      link?: string;
    };
    lastBuildDate: string;
    items: NormalizedItem[];
  };
  issues: PipelineIssue[];
}

export interface NormalizedItem {
  _meta: {
    itemKey: string;
    sourceOrder: number;
    sourceHash: string;
    sourceId?: string;
  };
  title: string;
  description: string;
  "content:encoded": string;
  summary: string;
  content: string;
  link: string;
  guid: string;
  publishedAt: string;
  updatedAt: string;
  sortDate: string;
  author: string;
  category: string[];
  enclosure?: {
    url?: string;
    type?: string;
    length?: string;
  };
}

export interface FeatureContext {
  feed: FeedConfig;
  cache: OperationCache;
}

export interface FeatureRunStats {
  kind: FeatureKind;
  units: number;
  cacheHits: number;
  generated: number;
  failed: number;
  usedCacheKeys: Set<string>;
}

export interface FeatureRunResult {
  items: NormalizedItem[];
  stats: FeatureRunStats;
  issues: PipelineIssue[];
}

export interface OperationUnit {
  id: string;
  itemKey: string;
  field: ItemField;
  cacheKey: string;
  sourceHash: string;
  sourceText: string;
  feature: FeatureKind;
  unitKind: "text" | "html-block" | "summary-source";
  blockPath?: string;
}

export interface OperationResult {
  id: string;
  cacheKey: string;
  status: "cached" | "generated" | "failed" | "skipped";
  outputText?: string;
  attempts: number;
  errorCode?: string;
}

export interface OperationCacheEntry {
  feature: FeatureKind;
  sourceHash: string;
  promptHash: string;
  output: string;
  model: string;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface OperationCache {
  schemaVersion: 1;
  entries: Record<string, OperationCacheEntry>;
}

export interface FeedRunReport {
  path: string;
  sourceUrl: string;
  outputPath?: string;
  limit: number;
  inputItems: number;
  outputItems: number;
  featureStats: FeatureRunStatsReport[];
  issues: PipelineIssue[];
}

export interface FeatureRunStatsReport {
  kind: FeatureKind;
  units: number;
  cacheHits: number;
  generated: number;
  failed: number;
}

export interface RenderedFeed {
  path: string;
  pathKey: string;
  feedId: string;
  outputPath: string;
  limit: number;
  itemCount: number;
  xml: string;
  issues: PipelineIssue[];
}

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: "success" | "partial" | "failed";
  feeds: FeedRunReport[];
  totals: {
    feeds: number;
    renderedFeeds: number;
    inputItems: number;
    outputItems: number;
    featureStats: FeatureRunStatsReport[];
  };
  issues: PipelineIssue[];
}
