import renderDom from "dom-serializer";
import { Element, Text, type AnyNode } from "domhandler";
import { parseDocument } from "htmlparser2";
import * as DomUtils from "domutils";
import { sha256 } from "../lib/hash.js";
import type {
  FeatureContext,
  FeatureRunResult,
  NormalizedItem,
  OperationUnit,
  SummaryFeatureConfig,
} from "../types.js";
import { generateFeatureOutputs } from "./shared.js";

const EXTRACTION_VERSION = "v1";
const SUMMARY_LABEL = "摘要";
const SUMMARY_HINT = "点击展开";

export async function runSummaryFeature(
  items: NormalizedItem[],
  feature: SummaryFeatureConfig,
  context: FeatureContext,
): Promise<FeatureRunResult> {
  const units: OperationUnit[] = [];

  for (const item of items) {
    const sourceValue = item[feature.sourceField];
    const prepared = prepareSummaryInput(sourceValue);
    if (!prepared.trim()) {
      continue;
    }
    units.push(makeSummaryUnit(context.feed.pathKey, item._meta.itemKey, feature.sourceField, prepared));
  }

  const generation = await generateFeatureOutputs({
    kind: "summary",
    systemPrompt: feature.systemPrompt,
    userPrompt: feature.prompt,
    units,
    context,
    metadata: {
      sourceField: feature.sourceField,
      extractionVersion: EXTRACTION_VERSION,
    },
  });

  const outputById = new Map(generation.results.filter((result) => result.outputText).map((result) => [result.id, result.outputText as string]));
  const nextItems = items.map((item) => {
    const next: NormalizedItem = {
      ...item,
      category: [...item.category],
      enclosure: item.enclosure ? { ...item.enclosure } : undefined,
    };

    const sourceValue = item[feature.sourceField];
    const prepared = prepareSummaryInput(sourceValue);
    if (!prepared.trim()) {
      return next;
    }
    const unit = makeSummaryUnit(context.feed.pathKey, item._meta.itemKey, feature.sourceField, prepared);
    const summaryMarkdown = outputById.get(unit.id);
    if (!summaryMarkdown) {
      return next;
    }
    next[feature.sourceField] = prependSummary(sourceValue, summaryMarkdown);
    return next;
  });

  return {
    items: nextItems,
    issues: generation.issues,
    stats: {
      kind: "summary",
      units: units.length,
      cacheHits: generation.results.filter((result) => result.status === "cached").length,
      generated: generation.results.filter((result) => result.status === "generated").length,
      failed: generation.results.filter((result) => result.status === "failed").length,
      usedCacheKeys: generation.usedCacheKeys,
    },
  };
}

function makeSummaryUnit(pathKey: string, itemKey: string, field: SummaryFeatureConfig["sourceField"], sourceText: string): OperationUnit {
  const normalized = normalizeSource(sourceText);
  const sourceHash = sha256(normalized);
  return {
    id: sha256(`summary|${pathKey}|${itemKey}|${field}|${sourceHash}`),
    itemKey,
    field,
    sourceText,
    sourceHash,
    feature: "summary",
    unitKind: "summary-source",
    cacheKey: sha256(`cache:summary|${EXTRACTION_VERSION}|${field}|${sourceHash}`),
  };
}

function prepareSummaryInput(sourceValue: string): string {
  if (!sourceValue.trim()) {
    return "";
  }
  if (!/<\/?[a-z][\s\S]*>/i.test(sourceValue)) {
    return sourceValue.replace(/\s+/g, " ").trim();
  }

  const document = parseDocument(sourceValue, { decodeEntities: true });
  const lines: string[] = [];
  for (const node of document.children) {
    collectMarkdownishText(node, lines, 0);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function collectMarkdownishText(node: AnyNode, lines: string[], depth: number): void {
  if (node instanceof Text) {
    const text = node.data.replace(/\s+/g, " ").trim();
    if (text) {
      appendLine(lines, text);
    }
    return;
  }
  if (!(node instanceof Element)) {
    return;
  }

  const tag = node.name.toLowerCase();
  if (["script", "style", "noscript", "template"].includes(tag)) {
    return;
  }
  if (tag === "br") {
    appendLine(lines, "");
    return;
  }
  if (tag === "li") {
    const text = DomUtils.textContent(node).replace(/\s+/g, " ").trim();
    if (text) {
      appendLine(lines, `${"  ".repeat(depth)}- ${text}`);
    }
    return;
  }
  if (["p", "div", "section", "article", "blockquote"].includes(tag)) {
    const text = DomUtils.textContent(node).replace(/\s+/g, " ").trim();
    if (text) {
      appendLine(lines, text);
      appendLine(lines, "");
    }
    return;
  }
  if (/^h[1-6]$/.test(tag)) {
    const text = DomUtils.textContent(node).replace(/\s+/g, " ").trim();
    if (text) {
      appendLine(lines, `${"#".repeat(Number(tag[1]))} ${text}`);
      appendLine(lines, "");
    }
    return;
  }
  if (tag === "ul" || tag === "ol") {
    for (const child of node.children) {
      collectMarkdownishText(child, lines, depth + 1);
    }
    appendLine(lines, "");
    return;
  }
  for (const child of node.children) {
    collectMarkdownishText(child, lines, depth);
  }
}

function appendLine(lines: string[], line: string): void {
  if (!line && lines.at(-1) === "") {
    return;
  }
  lines.push(line);
}

function prependSummary(originalValue: string, summaryMarkdown: string): string {
  const summaryHtml = renderSummaryDetails(summaryMarkdown);
  if (!originalValue.trim()) {
    return summaryHtml;
  }
  return `${summaryHtml}\n${originalValue}`;
}

function renderSummaryDetails(summaryMarkdown: string): string {
  const paragraphs = summaryMarkdown
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const bodyNodes = paragraphs.map((paragraph) =>
    new Element("p", { class: "feed-summary-paragraph" }, [new Text(paragraph.replace(/\n+/g, " "))]),
  );

  const root = [
    new Element("details", { class: "feed-summary" }, [
      new Element("summary", { class: "feed-summary-toggle" }, [
        new Element("span", { class: "feed-summary-label" }, [new Text(SUMMARY_LABEL)]),
        new Text(" "),
        new Element("small", { class: "feed-summary-hint" }, [new Text(SUMMARY_HINT)]),
      ]),
      new Element("div", { class: "feed-summary-body" }, bodyNodes),
    ]),
  ];

  return renderDom(root, { encodeEntities: "utf8" });
}

function normalizeSource(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}
