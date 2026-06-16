import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { AppConfig, FeedConfig, FeedFeatureConfig, ItemField } from "../types.js";
import { shortHash } from "../lib/hash.js";
import { stateFilePath } from "../state/paths.js";
import { expandEnvTokens } from "./secrets.js";
import { rawConfigSchema } from "./schema.js";

export async function loadConfig(path = stateFilePath("config/feeds.yaml")): Promise<AppConfig> {
  const content = await readConfigFile(path);
  const parsed = rawConfigSchema.parse(parse(content));
  const seen = new Set<string>();

  return {
    feeds: parsed.feeds.map((feed) => {
      const pathKey = normalizePath(feed.path);
      const url = normalizeUrl(expandEnvTokens(feed.url));
      if (seen.has(pathKey)) {
        throw new Error(`duplicate feed path: ${feed.path}`);
      }
      seen.add(pathKey);

      const features: FeedFeatureConfig[] = [];
      if (feed.translate) {
        features.push({
          kind: "translate",
          targetLanguage: feed.translate.targetLanguage,
          mode: feed.translate.mode,
          fields: [...feed.translate.fields] as ItemField[],
          systemPrompt: parsed.translate!.systemPrompt,
        });
      }
      if (feed.summary) {
        features.push({
          kind: "summary",
          sourceField: feed.summary.sourceField,
          prompt: feed.summary.prompt,
          systemPrompt: parsed.summary!.systemPrompt,
        });
      }

      return makeFeedConfig(pathKey, url, feed.limit, features);
    }),
  };
}

function makeFeedConfig(pathKey: string, url: string, limit: number, features: FeedFeatureConfig[]): FeedConfig {
  const featureKey = features.map((feature) => serializeFeature(feature)).join("|");
  return {
    path: `/${pathKey}`,
    pathKey,
    feedId: shortHash(`${pathKey}|${url}|${featureKey}`),
    url,
    limit,
    features,
  };
}

function serializeFeature(feature: FeedFeatureConfig): string {
  if (feature.kind === "translate") {
    return `${feature.kind}:${feature.targetLanguage}:${feature.mode}:${feature.fields.join(",")}:${feature.systemPrompt}`;
  }
  return `${feature.kind}:${feature.sourceField}:${feature.prompt}:${feature.systemPrompt}`;
}

function normalizeUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`feed url must use http or https: ${input}`);
  }
  return url.toString();
}

async function readConfigFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  }
  catch (error) {
    if (isNotFound(error)) {
      throw new Error(`missing feed config: ${path}`);
    }
    throw error;
  }
}

function normalizePath(input: string): string {
  if (!input.startsWith("/")) {
    throw new Error(`feed path must start with "/": ${input}`);
  }
  if (input === "/") {
    throw new Error("feed path cannot be root");
  }
  if (input.endsWith("/")) {
    throw new Error(`feed path cannot end with "/": ${input}`);
  }
  if (input.endsWith(".xml")) {
    throw new Error(`feed path should not include .xml: ${input}`);
  }
  if (input.includes("?") || input.includes("#") || input.includes("\\")) {
    throw new Error(`feed path contains invalid characters: ${input}`);
  }
  const segments = input.slice(1).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`feed path contains invalid segment: ${input}`);
  }
  return segments.join("/");
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
