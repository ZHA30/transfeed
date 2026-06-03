# RSS Translation Service Design

## 1. 目标与边界

Transfeed 使用 GitHub Repository、GitHub Actions 和 GitHub Pages 构建一个静态 RSS 翻译服务。

核心行为：

- 通过 `state` 分支中的配置文件声明需要翻译的 RSS/Atom feed。
- 每次 GitHub Actions 运行时抓取原始 feed，标准化为统一结构。
- 每个 feed 只处理最新 `limit` 条 item；未配置时使用代码默认值 `25`。
- 输入窗口有多少 item，最终输出就有多少 item。
- 只翻译配置中声明的 item 字段。
- 翻译结果增量复用，避免每次全量重翻。
- 最终 XML 只发布到 GitHub Pages，不提交回任何分支。

非目标：

- 不提供实时在线翻译 API。
- 不允许用户运行时提交任意 feed URL。
- 不为单个 feed 配置 DOM 规则、拼接模板或模型参数。
- 不把生成后的 XML 写入仓库。
- 不在 Pages artifact 中生成首页；订阅链接列表写入 `state` 分支的 `README.md`。

## 2. 配置模型

配置文件位于 `state` 分支的 `config/feeds.yaml`，描述 feed 本身和需要翻译的字段。模型、并发、抓取超时等运行参数来自仓库 Variables / Secrets 或代码常量。

示例：

```yaml
feeds:
  - path: /openai/blog
    url: https://openai.com/blog/rss.xml
    targetLanguage: zh-CN
    limit: 30
    fields:
      - title
      - description

  - path: /hn
    url: https://hnrss.org/frontpage
    targetLanguage: zh-CN
    fields:
      - title
```

字段规则：

- `path` 必填，必须以 `/` 开头，支持多段路径，例如 `/openai/blog`。
- `url` 必填，必须是 `http` 或 `https` 绝对 URL。
- `targetLanguage` 必填，例如 `zh-CN`、`zh-TW`、`ja`、`ko`。
- `limit` 可选，必须是正整数，表示该 feed 的输入和输出窗口大小；未配置时使用代码默认值 `25`。
- `fields` 必填，非空数组，只允许标准化后的 item 字段。

允许翻译的标准字段：

```ts
type ItemField =
  | 'title'
  | 'description'
  | 'content:encoded'
  | 'summary'
  | 'content';
```

`path` 在配置中保留前导 `/`，内部使用时转换为无前导斜杠的 `pathKey`：

```text
config path: /openai/blog
pathKey: openai/blog
output file: dist/openai/blog.xml
README link: <GitHub Pages URL>/openai/blog.xml
```

`path` 规范化后必须全局唯一，不允许：

- 空路径或 `/`。
- 末尾 `/`。
- 空段、`.`、`..`。
- 反斜杠。
- 查询参数或 hash。
- 直接以 `.xml` 结尾。

配置校验后得到的内部对象应包含解析后的窗口大小：

```ts
interface ValidatedFeedConfig {
  path: string;
  pathKey: string;
  url: string;
  targetLanguage: string;
  limit: number;
  fields: ItemField[];
}
```

## 3. 运行参数

feed 配置之外的参数放在 GitHub Repository Variables / Secrets 中。

Repository Variables：

| Name | Purpose |
|---|---|
| `LLM_PROVIDER` | LLM 提供方 |
| `LLM_BASE_URL` | OpenAI-compatible API base URL |
| `LLM_MODEL` | 翻译模型 |

Repository Secrets：

| Name | Purpose |
|---|---|
| `LLM_API_KEY` | LLM API key |

抓取超时、抓取并发、LLM 并发和批次大小先作为代码常量，不进入配置文件。

## 4. 总体流水线

单次 run 的阶段：

1. `load-config`
2. `fetch-normalize`
3. `window`
4. `extract`
5. `translate`
6. `reembed-render`
7. `publish`
8. `commit-state`

数据流：

```text
state/config/feeds.yaml
  -> ValidatedFeedConfig[]
  -> NormalizedFeed
  -> Windowed NormalizedFeed
  -> ExtractedFeed
  -> TranslationResult
  -> RenderedFeed
  -> dist/**/*.xml
  -> GitHub Pages

state/cache/units.json
  -> TranslationCache
  -> updated TranslationCache
  -> state/cache/units.json

GitHub Pages URL + feed config
  -> state/README.md
```

阶段间只传结构化产物。翻译层只输出 `unitId -> translatedText`，不直接改写 normalized feed。回嵌层负责把译文写回 item 字段。

## 5. 公共标识

贯穿全流程的标识：

- `path`：配置中的 feed 输出路径，例如 `/openai/blog`。
- `pathKey`：内部路径键，例如 `openai/blog`。
- `feedId`：状态文件使用的稳定 hash，基于 `path + url + targetLanguage`。
- `itemKey`：单个 feed 内稳定的 item ID。
- `field`：标准 item 字段。
- `unitId`：本次运行中的翻译单元 ID。
- `cacheKey`：跨运行复用的翻译缓存 key。

`itemKey` 生成优先级：

1. RSS `guid` 或 Atom `id`。
2. canonical `link`。
3. `title + sortDate`。
4. `title + sourceOrder`。

建议：

```text
itemKey = sha256("item:v1|" + pathKey + "|" + sourceKey)
```

`unitId` 用于本次 run 内定位：

```text
unitId = sha256("unit:v1|" + pathKey + "|" + itemKey + "|" + field + "|" + unitIndex + "|" + sourceHash)
```

`cacheKey` 用于跨 feed 复用，不包含 `path`：

```text
cacheKey = sha256(
  "cache:v1|" +
  targetLanguage + "|" +
  kind + "|" +
  promptVersion + "|" +
  extractionVersion + "|" +
  normalizedSourceText
)
```

## 6. Issue 传递

所有阶段使用统一 issue 结构记录局部失败。

```ts
type IssueSeverity = 'info' | 'warning' | 'error';

type IssueStage =
  | 'config'
  | 'fetch'
  | 'normalize'
  | 'window'
  | 'extract'
  | 'translate'
  | 'render'
  | 'write'
  | 'publish'
  | 'commit-state';

interface PipelineIssue {
  id: string;
  stage: IssueStage;
  severity: IssueSeverity;
  code: string;
  message: string;
  path?: string;
  itemKey?: string;
  field?: ItemField;
  unitId?: string;
  retryable?: boolean;
  blocking?: boolean;
  cause?: string;
  createdAt: string;
}
```

规则：

- 每个阶段只追加 issue，不覆盖上游 issue。
- feed 级阻塞错误会跳过该 feed。
- unit 级翻译失败通常不是阻塞错误，回嵌时保留原文。
- 只要至少一个 feed 成功输出 XML，run 可以是 `partial`。

## 7. 抓取与标准化

抓取解析阶段只做：

- 下载原始 RSS/Atom XML。
- 判断 feed 类型。
- 映射为统一 `channel/items` schema。
- 生成 `itemKey`。
- 规范化日期、数组和缺失字段。

不做：

- 翻译。
- DOM 提取。
- 双语回嵌。
- 缓存写入。

标准化目标：

```ts
interface NormalizedFeed {
  channel: {
    _meta: {
      path: string;
      pathKey: string;
      feedId: string;
      sourceUrl: string;
      finalUrl?: string;
      targetLanguage: string;
      sourceFormat: 'rss' | 'atom' | 'rdf' | 'unknown';
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

interface NormalizedItem {
  _meta: {
    itemKey: string;
    sourceOrder: number;
    sourceHash: string;
    sourceId?: string;
  };
  title: string;
  description: string;
  'content:encoded': string;
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
```

字段映射：

| Standard field | RSS item | Atom entry |
|---|---|---|
| `title` | `item.title` | `entry.title` |
| `description` | `item.description` | empty |
| `content:encoded` | `item["content:encoded"]` | empty |
| `summary` | empty | `entry.summary` |
| `content` | empty | `entry.content` |
| `link` | `item.link` | `entry.link[rel=alternate]` |
| `guid` | `item.guid` | `entry.id` |
| `publishedAt` | `item.pubDate` | `entry.published` |
| `updatedAt` | empty | `entry.updated` |
| `sortDate` | `item.pubDate` | `entry.updated || entry.published` |
| `author` | `item.author` | `entry.author.name` |
| `category` | `item.category` | `entry.category[].term` |
| `enclosure` | `item.enclosure` | `entry.link[rel=enclosure]` |

值规范化：

- 缺失字符串字段统一为 `""`。
- `category` 统一为数组。
- `guid` 统一为字符串。
- 日期统一为 ISO 字符串；渲染 RSS 时再转换为 `pubDate`。
- HTML 字段保留原始字符串，不提前清洗。

## 8. 输入窗口

标准化后立即应用当前 feed 的 `limit`。

行为：

- 原始 feed 返回 120 条，`limit=25`，只取最新 25 条进入后续流程，最终输出 25 条。
- 原始 feed 返回 10 条，`limit=25`，10 条全部进入后续流程，最终输出 10 条。
- 输出 item 数始终等于窗口化后的输入 item 数。

排序规则：

1. 优先按 `sortDate` 倒序。
2. 日期不可用时保留源顺序。

窗口裁剪之后，后续提取、翻译、回嵌、渲染全部只处理窗口内 item。

## 9. 提取

提取阶段输入：

- Windowed `NormalizedFeed`。
- 当前 feed 配置中的 `fields`。
- translation cache 只读视图。

输出：

```ts
interface ExtractedFeed {
  path: string;
  pathKey: string;
  feedId: string;
  targetLanguage: string;
  limit: number;
  items: ExtractedItem[];
  units: TranslationUnit[];
  issues: PipelineIssue[];
}

interface ExtractedItem {
  itemKey: string;
  sourceItem: NormalizedItem;
  fields: Partial<Record<ItemField, ExtractedField>>;
}

interface ExtractedField {
  field: ItemField;
  kind: 'text' | 'html';
  sourceValue: string;
  sourceHash: string;
  unitIds: string[];
  skippedReason?: 'missing' | 'empty' | 'unsupported';
}

interface TranslationUnit {
  unitId: string;
  path: string;
  pathKey: string;
  feedId: string;
  itemKey: string;
  field: ItemField;
  unitIndex: number;
  kind: 'text' | 'html-block';
  sourceText: string;
  normalizedSourceText: string;
  sourceHash: string;
  cacheKey: string;
  blockPath?: string;
}
```

`title` 默认按纯文本处理。

`description`、`content:encoded`、`summary`、`content` 默认按 HTML 处理；如果解析后没有有效 HTML 结构，则退化为纯文本 unit。

### 9.1 DOM 排除规则

以下节点不生成翻译单元，但保留在最终 HTML 中：

- `script`
- `style`
- `noscript`
- `template`
- `meta`
- `link`
- `form`
- `input`
- `button`
- `select`
- `textarea`
- `option`
- `svg`
- `canvas`
- `iframe`
- `video`
- `audio`
- `picture`
- `source`
- `pre`
- `code`
- `kbd`
- `samp`
- `var`

额外跳过：

- 带有 `translate="no"` 的节点。
- 带有 `data-no-translate` 的节点。
- class 包含 `notranslate` 的节点。
- 已回嵌的 `.translated` 节点。
- `hidden`、`aria-hidden="true"`、`display:none`、`visibility:hidden` 节点。

### 9.2 正文块选择

优先提取这些块：

- `p`
- `h1` 到 `h6`
- `li`
- `blockquote`
- `td`
- `th`
- `figcaption`
- `summary`

兜底提取：

- `div`
- `section`
- `article`

兜底节点只有在自身包含有效文本、且内部没有更具体的候选正文块时才作为 unit，避免重复提取。

### 9.3 低价值内容过滤

跳过代码类节点：

- class/id 包含 `code`、`highlight`、`syntax`、`language-`、`hljs`。
- 文本中代码特征过强，例如多行 `{}`、`() =>`、`import/export`、连续缩进、命令行提示符。

跳过广告类节点：

- class/id/role 包含 `ad`、`ads`、`advert`、`sponsor`、`promo`、`banner`、`recommend`、`related`。
- 短文本包含 `Advertisement`、`Sponsored`、`Promoted`、`相关阅读`、`相关推荐`。

跳过导航和面包屑：

- `nav`、`footer`、`aside`。
- role 为 `navigation`、`complementary`、`banner`、`contentinfo`。
- class/id/aria-label 包含 `breadcrumb`、`breadcrumbs`、`crumb`。
- 形如 `Home > News > Article`、`首页 / 栏目 / 正文` 的短文本。
- 链接文本长度 / 总文本长度大于 `0.6` 的块。

其他过滤：

- 有效字符少于 2 个。
- 只有符号、数字、URL、邮箱或版权声明。
- 空白折叠后无可翻译内容。

## 10. 翻译

翻译阶段输入：

- `ExtractedFeed.units`。
- translation cache。
- LLM 配置。

输出：

```ts
interface TranslationResult {
  path: string;
  pathKey: string;
  feedId: string;
  limit: number;
  targetLanguage: string;
  units: TranslationUnitResult[];
  issues: PipelineIssue[];
}

interface TranslationUnitResult {
  unitId: string;
  path: string;
  itemKey: string;
  field: ItemField;
  cacheKey: string;
  status: 'cached' | 'translated' | 'failed' | 'skipped';
  translatedText?: string;
  attempts: number;
  translatedAt?: string;
  errorCode?: string;
}
```

流程：

1. 对每个 unit 计算 `cacheKey`。
2. 命中 translation cache 的 unit 标记为 `cached`。
3. 未命中的 unit 按 `targetLanguage` 分桶。
4. 按代码常量中的单批 unit 数和字符数切批。
5. 并发调用 LLM，要求严格 JSON 输出。
6. 校验响应。
7. 批量调用失败时重试一次。
8. 仍失败时逐条重试。
9. 单条仍失败的 unit 标记为 `failed`，回嵌阶段保留原文。
10. 成功结果写入 next state 中的 translation cache。

LLM 输入：

```json
{
  "targetLanguage": "zh-CN",
  "items": [
    {
      "id": "unit-id",
      "sourceText": "Original text"
    }
  ]
}
```

LLM 输出：

```json
{
  "items": [
    {
      "id": "unit-id",
      "translatedText": "译文"
    }
  ]
}
```

校验规则：

- JSON 可解析。
- `items` 是数组。
- 输出 id 集合与输入 id 集合完全一致。
- 无重复 id。
- 无未知 id。
- `translatedText` 是字符串。
- 译文非空，除非源文本被判定为不可翻译。
- 译文长度不能异常，默认不超过源文长度的 `4x + 200`。
- 译文不得包含明显提示词泄露，例如 `As an AI`、`I cannot`、额外 JSON 说明。
- HTML 回嵌前必须把译文作为文本转义。

失败处理：

- 批量请求失败、超时、输出 JSON 无效或 id 集合不匹配时，同批重试一次。
- 同批重试仍失败时，将该批拆成单 unit 请求。
- 单 unit 仍失败时，标记为 `failed`，不写入 cache。
- 内容审查或安全拒绝不做额外绕过处理，最终保留原文。

## 11. 回嵌与渲染

回嵌阶段输入：

- Windowed `NormalizedFeed`。
- `ExtractedFeed`。
- `TranslationResult`。

输出：

```ts
interface RenderedFeed {
  path: string;
  pathKey: string;
  feedId: string;
  outputPath: string;
  limit: number;
  targetLanguage: string;
  itemCount: number;
  xml: string;
  issues: PipelineIssue[];
}
```

每次 run 都重新回嵌并渲染 XML。增量只发生在翻译调用层：命中 `cacheKey` 的 unit 不再调用 LLM。

文本字段格式：

```text
译文¶原文
```

规则：

- 有译文和原文：输出 `译文¶原文`。
- 只有原文：输出原文。
- 只有译文：输出译文。
- 翻译失败：输出原文。

HTML 字段格式：

```html
原文<span class="translated"><br>译文</span>
```

回嵌规则：

- 每个成功翻译的正文块，在原块内容后追加 `<span class="translated"><br>译文</span>`。
- `span` 由程序生成。
- `译文` 必须作为文本插入并 HTML escape。
- 不修改原块已有 HTML。
- 翻译失败的块不追加 `.translated`。
- 已存在 `.translated` 的节点不再提取，避免重复回嵌。

XML 渲染规则：

- 输出 RSS 2.0。
- `title` 作为纯文本 XML escape。
- `description`、`content:encoded`、`summary`、`content` 作为 CDATA 输出。
- CDATA 内出现 `]]>` 时必须安全拆分。
- 保留 `link`、`guid`、`pubDate`、`author`、`category`、`enclosure`。
- 不因单个 unit 翻译失败丢弃 item。
- 输出 item 数必须等于窗口 item 数。

## 12. State 分支

配置、状态和运行报告保存在独立的 `state` 分支中，生成的 RSS/XML 仍然只发布到 Pages，不提交回仓库。

`state` 分支根目录：

```text
README.md
config/
  feeds.yaml
cache/
  manifest.json
  units.json
reports/
  latest.json
```

`state` 分支不执行代码，只作为数据分支。状态只服务于增量翻译，不作为发布产物，也不代表线上 Pages 当前内容。状态中不保存最终 XML、双语 HTML 或完整 rendered item。构建时通过本地临时 worktree `state/` 读写该分支，主分支忽略这个目录。

`README.md` 是订阅入口，只包含每个 feed 的 GitHub Pages 绝对订阅链接列表。Pages artifact 不生成 `index.html`。

### 12.1 manifest

`cache/manifest.json` 只保存状态 schema：

```json
{
  "schemaVersion": 1
}
```

### 12.2 Translation Cache

`cache/units.json` 保存翻译单元缓存，key 为 `cacheKey`。

```json
{
  "schemaVersion": 1,
  "entries": {
    "sha256:...": {
      "targetLanguage": "zh-CN",
      "kind": "html-block",
      "field": "description",
      "sourceHash": "sha256:...",
      "promptVersion": "v1",
      "extractionVersion": "v1",
      "translated": "译文",
      "model": "model-name",
      "createdAt": "2026-06-03T00:00:00Z"
    }
  }
}
```

清理策略：

- 每次 run 根据当前所有 feed 窗口生成 `usedCacheKeys`。
- 默认只保留仍被当前窗口引用的 cache entry。
- 不按时间保留缓存。
- 相同文本在多个当前窗口中复用同一个 `cacheKey`，只要仍被任一当前窗口引用就保留。
- 状态读取失败时记录 warning，并从空 cache 继续构建。

## 13. 单次 run 状态流转

1. 使用 workflow concurrency 串行化 Transfeed run。
2. checkout 默认分支最新 HEAD。
3. 准备 `state/` worktree：若远端已有 `state` 分支则检出该分支，否则创建空的 orphan `state` 分支。
4. 加载 `state/config/feeds.yaml` 和 `state/cache/units.json`；状态读取失败时从空 cache 继续。
5. 抓取并标准化 feed。
6. 按该 feed 的 `limit` 裁剪最新窗口。
7. 每次都从窗口 item 重新提取 units。
8. units 命中 cache 时直接复用译文。
9. cache miss units 进入 LLM 批量翻译和重试。
10. 回嵌并渲染 `dist/**/*.xml`。
11. 根据当前所有 feed 窗口生成 next state，只包含 `state/cache/manifest.json` 和 `state/cache/units.json`。
12. 写入 `state/reports/latest.json`。
13. 上传 Pages artifact 并部署。
14. Pages 部署成功后，用 Pages URL 更新 `state/README.md` 订阅链接列表。
15. 将 `state/` worktree 提交并推送到远端 `state` 分支。

失败写入策略：

- 默认只有 Pages 部署成功后才提交状态。
- 配置无效、XML 渲染失败、Pages artifact 上传失败、Pages 部署失败时不提交状态。
- 状态读取失败不阻塞发布，从空 cache 继续。
- 部分 unit 失败但仍输出 XML 时，本次 run 为 `partial`，可以提交状态；失败 unit 不写入 unit cache。
- 状态提交失败时不回滚 Pages。状态只是 best-effort cache；提交失败会导致线上内容和 `state` 分支 cache 暂时不一致，下一次 run 可能重复翻译。

状态提交规则：

- 只允许在 `state/` worktree 中 stage `README.md`、`config/feeds.yaml`、`cache/manifest.json`、`cache/units.json`、`reports/latest.json`。
- 提交前必须校验 staged 文件路径，不允许 `dist/`、XML 或其他文件进入提交。
- 空 diff 直接跳过提交。
- 禁止 force push。
- 状态提交使用可跳过 workflow 的 commit message，例如 `chore(transfeed): update state [skip ci]`。

## 14. GitHub Actions 与 Pages 发布

Pages 发布源应配置为 GitHub Actions。构建产物只通过 Pages artifact 发布，生成 XML 不提交到源码分支。

Workflow 只从默认分支发布。手动触发也应检出默认分支最新 HEAD，避免使用触发时的旧 state。

Workflow 草案：

```yaml
name: Build Transfeed

on:
  workflow_dispatch:
  schedule:
    - cron: '*/30 * * * *'

concurrency:
  group: transfeed-pages
  cancel-in-progress: false

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: main
      - run: git fetch --depth=1 origin main:refs/remotes/origin/main && git checkout -B main origin/main
      - name: Prepare state worktree
        run: |
          if git ls-remote --exit-code --heads origin state >/dev/null 2>&1; then
            git fetch --depth=1 origin state:refs/remotes/origin/state
            git worktree add --detach state origin/state
          else
            git worktree add --orphan state
          fi
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run transfeed:build
        env:
          LLM_PROVIDER: ${{ vars.LLM_PROVIDER }}
          LLM_BASE_URL: ${{ vars.LLM_BASE_URL }}
          LLM_MODEL: ${{ vars.LLM_MODEL }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          TRANSFEED_STATE_DIR: state
      - uses: actions/upload-pages-artifact@v4
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
      - run: npm run transfeed:update-readme
        env:
          TRANSFEED_STATE_DIR: state
          TRANSFEED_PAGE_URL: ${{ steps.deployment.outputs.page_url }}
      - run: npm run transfeed:commit-state
        env:
          TRANSFEED_STATE_DIR: state
```

GitHub 官方文档要求 Pages 部署 job 至少具有 `pages: write` 和 `id-token: write` 权限；`deploy-pages` 会部署由 `upload-pages-artifact` 上传的 Pages artifact。

仓库需要允许 `github-actions[bot]` 推送 `state` 分支。`dist/` 和 `state/` 必须在 `.gitignore` 中，`commit-state` 必须硬校验 staged 文件只能是 `README.md`、`config/feeds.yaml`、`cache/manifest.json`、`cache/units.json`、`reports/latest.json`。

首次运行前需要在 `state` 分支初始化 `config/feeds.yaml`。如果远端 `state` 分支不存在，workflow 会创建空分支，但缺少配置时构建会失败并提示补充配置。

## 15. RunReport

每次 run 生成简短报告，写入 Actions summary。

```ts
interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  status: 'success' | 'partial' | 'failed';
  feeds: FeedRunReport[];
  totals: {
    feeds: number;
    renderedFeeds: number;
    inputItems: number;
    outputItems: number;
    units: number;
    cacheHits: number;
    translated: number;
    failedUnits: number;
  };
  issues: PipelineIssue[];
}

interface FeedRunReport {
  path: string;
  sourceUrl: string;
  outputPath?: string;
  limit: number;
  inputItems: number;
  outputItems: number;
  units: number;
  cacheHits: number;
  translated: number;
  failedUnits: number;
  issues: PipelineIssue[];
}
```

状态判定：

- `success`：所有配置 feed 均成功输出，无 error issue。
- `partial`：部分 feed 或部分 unit 失败，但至少一个 feed 成功输出 XML。
- `failed`：配置错误、状态损坏，或没有任何 feed 成功输出。

## 16. 参考资料

- GitHub Pages custom workflows: https://docs.github.com/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
- `actions/upload-pages-artifact`: https://github.com/actions/upload-pages-artifact
- `actions/deploy-pages`: https://github.com/actions/deploy-pages
- 参考实现：`references/feedbridge-main`
- 参考工作流：`references/03-trans-description.json`
