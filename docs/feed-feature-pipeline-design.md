# Feed Feature Pipeline Design

## Goal

This project is no longer modeled as a translation-only service.
It is a feed processing pipeline with pluggable item-level features.

Current first-class features:

- `translate`
- `summary`

## Config Shape

Global feature settings define shared system prompts.
Each feed enables zero or more feed-level features with its own arguments.
The runtime config schema is maintained in `src/config/schema.ts`.
`src/cli/commit-state.ts` generates `config/feeds.schema.json` into the state directory before committing state changes.

```yaml
translate:
  systemPrompt: |
    You are a feed translation assistant.
    Return only translated text.

summary:
  systemPrompt: |
    你是一个 RSS 摘要助手。
    只输出中文 Markdown 摘要正文，不要标题，不要代码块，不要解释。

feeds:
  - path: /readwise
    url: https://wise.readwise.io/feed
    translate:
      targetLanguage: zh-CN
      mode: bilingual
      fields:
        - title
        - content:encoded
    summary:
      sourceField: description
      prompt: |
        提炼这期内容的核心主题和重点推荐，控制在 2-4 句。
    limit: 10
```

## Pipeline

1. Load config
2. Fetch source feed
3. Normalize RSS/Atom into internal items
4. Run enabled features in declared order
5. Render output RSS
6. Persist cache and run report

## Decoupling Rules

- The build CLI knows only how to run a list of features.
- Each feature owns:
  - unit extraction
  - LLM prompts
  - cache key design
  - item mutation
- Shared LLM batching and cache persistence stay in common modules.

## Summary IO Strategy

- Input: source field is normalized to plain text / markdown-ish text before LLM
- Output: LLM returns Markdown summary text only
- Rendering: pipeline converts summary text into HTML and prepends it to the original field inside `<details><summary>摘要</summary>...</details>`

## Translate Output Mode

`translate.mode` controls how translated fields are written back into the feed.
It defaults to `bilingual` for backwards compatibility.

- `translation`: output translated text only.
- `bilingual`: output translated text plus original text.

For plain text fields, `bilingual` writes `translated¶original`.
For HTML fields, `bilingual` appends translated text to each translated block.
`translation` replaces each translated block with translated text while preserving the outer block element.
