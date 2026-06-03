import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { ITEM_FIELDS, type FeedConfig, type ItemField } from "../types.js";
import { shortHash } from "../lib/hash.js";
import { stateFilePath } from "../state/paths.js";
import { expandEnvTokens } from "./secrets.js";

const DEFAULT_FEED_LIMIT = 25;

const rawFeedSchema = z.object({
  path: z.string(),
  url: z.string().min(1),
  targetLanguage: z.string().min(1),
  limit: z.number().int().positive().optional(),
  fields: z.array(z.enum(ITEM_FIELDS)).nonempty(),
});

const rawConfigSchema = z.object({
  feeds: z.array(rawFeedSchema).nonempty(),
});

export async function loadConfig(path = stateFilePath("config/feeds.yaml")): Promise<FeedConfig[]> {
  const content = await readConfigFile(path);
  const parsed = rawConfigSchema.parse(parse(content));
  const seen = new Set<string>();

  return parsed.feeds.map((feed) => {
    const pathKey = normalizePath(feed.path);
    const url = normalizeUrl(expandEnvTokens(feed.url));
    if (seen.has(pathKey)) {
      throw new Error(`duplicate feed path: ${feed.path}`);
    }
    seen.add(pathKey);

    return {
      path: `/${pathKey}`,
      pathKey,
      feedId: shortHash(`${pathKey}|${url}|${feed.targetLanguage}`),
      url,
      targetLanguage: feed.targetLanguage,
      limit: feed.limit ?? DEFAULT_FEED_LIMIT,
      fields: [...feed.fields] as ItemField[],
    };
  });
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
      throw new Error(`missing feed config: ${path}. Initialize config/feeds.yaml in the state branch.`);
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
