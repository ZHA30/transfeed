import { XMLParser } from "fast-xml-parser";
import type { FeedConfig, NormalizedFeed, NormalizedItem } from "../types.js";
import { sha256 } from "../lib/hash.js";
import { redactUrl } from "../lib/url.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "#cdata",
  textNodeName: "#text",
  trimValues: false,
});

export function parseFeedXml(xml: string, config: FeedConfig, finalUrl?: string): NormalizedFeed {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  if (isRecord(parsed.rss)) {
    return normalizeRss(parsed.rss, xml, config, finalUrl);
  }
  if (isRecord(parsed.feed)) {
    return normalizeAtom(parsed.feed, xml, config, finalUrl);
  }
  throw new Error("source feed must be RSS or Atom");
}

export function windowFeed(feed: NormalizedFeed): NormalizedFeed {
  const items = [...feed.channel.items]
    .sort((a, b) => {
      const aTime = Date.parse(a.sortDate);
      const bTime = Date.parse(b.sortDate);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return a._meta.sourceOrder - b._meta.sourceOrder;
    })
    .slice(0, feed.channel._meta.limit);

  return {
    ...feed,
    channel: {
      ...feed.channel,
      items,
    },
  };
}

function normalizeRss(rss: Record<string, unknown>, xml: string, config: FeedConfig, finalUrl?: string): NormalizedFeed {
  const channel = firstRecord(rss.channel) ?? {};
  const items = asArray(channel.item).map((item, index) => normalizeRssItem(firstRecord(item) ?? {}, config, index));
  return {
    channel: {
      _meta: meta(config, xml, "rss", finalUrl),
      title: textOf(channel.title),
      link: textOf(channel.link),
      description: textOf(channel.description),
      language: textOf(channel.language),
      image: normalizeImage(firstRecord(channel.image)),
      lastBuildDate: textOf(channel.lastBuildDate),
      items,
    },
    issues: [],
  };
}

function normalizeAtom(feed: Record<string, unknown>, xml: string, config: FeedConfig, finalUrl?: string): NormalizedFeed {
  const updated = textOf(feed.updated);
  const items = asArray(feed.entry).map((entry, index) => normalizeAtomEntry(firstRecord(entry) ?? {}, config, index));
  return {
    channel: {
      _meta: meta(config, xml, "atom", finalUrl),
      title: textOf(feed.title),
      link: atomLink(feed.link),
      description: textOf(feed.subtitle),
      language: textOf(feed["@_xml:lang"]),
      image: normalizeAtomImage(feed),
      lastBuildDate: updated ? toRssDate(updated) : "",
      items,
    },
    issues: [],
  };
}

function normalizeRssItem(item: Record<string, unknown>, config: FeedConfig, sourceOrder: number): NormalizedItem {
  const guid = textOf(item.guid);
  const link = textOf(item.link);
  const title = textOf(item.title);
  const pubDate = textOf(item.pubDate);
  const sourceId = guid || link || `${title}|${pubDate}|${sourceOrder}`;
  return {
    _meta: itemMeta(config, sourceId, item, sourceOrder),
    title,
    description: textOf(item.description),
    "content:encoded": textOf(item["content:encoded"]),
    summary: "",
    content: "",
    link,
    guid,
    publishedAt: toIsoDate(pubDate),
    updatedAt: "",
    sortDate: toIsoDate(pubDate),
    author: textOf(item.author) || textOf(item["dc:creator"]),
    category: asArray(item.category).map(textOf).filter(Boolean),
    enclosure: normalizeEnclosure(firstRecord(item.enclosure)),
  };
}

function normalizeAtomEntry(entry: Record<string, unknown>, config: FeedConfig, sourceOrder: number): NormalizedItem {
  const id = textOf(entry.id);
  const link = atomLink(entry.link);
  const title = textOf(entry.title);
  const published = textOf(entry.published);
  const updated = textOf(entry.updated);
  const sourceId = id || link || `${title}|${updated || published}|${sourceOrder}`;
  return {
    _meta: itemMeta(config, sourceId, entry, sourceOrder),
    title,
    description: "",
    "content:encoded": "",
    summary: textOf(entry.summary),
    content: textOf(entry.content),
    link,
    guid: id,
    publishedAt: toIsoDate(published),
    updatedAt: toIsoDate(updated),
    sortDate: toIsoDate(updated || published),
    author: atomAuthor(entry.author),
    category: asArray(entry.category).map((category) => {
      const record = firstRecord(category);
      return record ? textOf(record["@_term"]) : textOf(category);
    }).filter(Boolean),
    enclosure: atomEnclosure(entry.link),
  };
}

function meta(config: FeedConfig, xml: string, sourceFormat: "rss" | "atom", finalUrl?: string): NormalizedFeed["channel"]["_meta"] {
  return {
    path: config.path,
    pathKey: config.pathKey,
    feedId: config.feedId,
    sourceUrl: redactUrl(config.url),
    finalUrl: finalUrl ? redactUrl(finalUrl) : undefined,
    targetLanguage: config.targetLanguage,
    sourceFormat,
    fetchedAt: new Date().toISOString(),
    sourceHash: sha256(xml),
    limit: config.limit,
  };
}

function itemMeta(config: FeedConfig, sourceId: string, item: unknown, sourceOrder: number): NormalizedItem["_meta"] {
  return {
    itemKey: sha256(`item:v1|${config.pathKey}|${sourceId}`),
    sourceOrder,
    sourceHash: sha256(JSON.stringify(item)),
    sourceId,
  };
}

function normalizeImage(image: Record<string, unknown> | null): NormalizedFeed["channel"]["image"] | undefined {
  if (!image) {
    return undefined;
  }
  return {
    url: textOf(image.url),
    title: textOf(image.title),
    link: textOf(image.link),
  };
}

function normalizeAtomImage(feed: Record<string, unknown>): NormalizedFeed["channel"]["image"] | undefined {
  const url = textOf(feed.logo) || textOf(feed.icon);
  return url ? { url, title: textOf(feed.title), link: atomLink(feed.link) } : undefined;
}

function normalizeEnclosure(enclosure: Record<string, unknown> | null): NormalizedItem["enclosure"] | undefined {
  if (!enclosure) {
    return undefined;
  }
  return {
    url: textOf(enclosure["@_url"]),
    type: textOf(enclosure["@_type"]),
    length: textOf(enclosure["@_length"]),
  };
}

function atomEnclosure(input: unknown): NormalizedItem["enclosure"] | undefined {
  const enclosure = asArray(input).map(firstRecord).find((link) => link?.["@_rel"] === "enclosure");
  if (!enclosure) {
    return undefined;
  }
  return {
    url: textOf(enclosure["@_href"]),
    type: textOf(enclosure["@_type"]),
    length: textOf(enclosure["@_length"]),
  };
}

function atomAuthor(input: unknown): string {
  const author = firstRecord(input);
  return author ? textOf(author.name) : textOf(input);
}

function atomLink(input: unknown): string {
  const value = Array.isArray(input)
    ? input.find((link) => {
      const record = firstRecord(link);
      return !record?.["@_rel"] || record["@_rel"] === "alternate";
    }) ?? input[0]
    : input;
  const record = firstRecord(value);
  return record ? textOf(record["@_href"]) : textOf(value);
}

function textOf(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }
  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    return decodeEntities(String(input));
  }
  if (Array.isArray(input)) {
    return textOf(input[0]);
  }
  if (isRecord(input)) {
    if (typeof input["#cdata"] === "string") {
      return input["#cdata"];
    }
    if (typeof input["#text"] === "string") {
      return decodeEntities(input["#text"]);
    }
  }
  return "";
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return "\"";
    if (entity === "apos") return "'";
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return match;
  });
}

function toIsoDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : "";
}

function toRssDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toUTCString() : "";
}

function asArray(input: unknown): unknown[] {
  if (input === null || input === undefined) {
    return [];
  }
  return Array.isArray(input) ? input : [input];
}

function firstRecord(input: unknown): Record<string, unknown> | null {
  if (Array.isArray(input)) {
    return firstRecord(input[0]);
  }
  return isRecord(input) ? input : null;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input);
}
