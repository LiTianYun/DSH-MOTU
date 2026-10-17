/**
 * Vendor every renderer engine, record its integrity, and generate the skill.
 *
 *   npm run vendor
 *
 * Three products, all derived from the manifest so they can never disagree with
 * it:
 *
 *   vendor/<renderer>/<file>   the engine builds, copied out of node_modules
 *   vendor/integrity.json      sha256, byte size and engine version per file —
 *                              the host half checks against this at startup and
 *                              when serving, so a truncated or hand-edited
 *                              engine is caught instead of failing mysteriously
 *   skill/SKILL.md + skill/references/<id>.md
 *                              what the agent reads when it decides to draw
 *
 * The engines are copied rather than bundled because they are what the browser
 * loads lazily, one per renderer, only when a conversation first uses it.
 *
 * @module dsh-visual-kit/scripts/vendor
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderers } from '../lib/renderers/manifest.js'
import { styles } from '../lib/styles.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const modules = join(root, 'node_modules')
const vendorDir = join(root, 'vendor')
const skillDir = join(root, 'skill')

/** A markdown code fence, spelled once so the generated text stays readable. */
const F = '```'

/**
 * The mistake each engine's grammar trips on most often.
 *
 * The browser half's error card suggests the same things (`fixHint` in
 * `lib/client.js`), so both halves teach one lesson and a repeat failure costs
 * a glance instead of a round trip. Edit both together.
 *
 * @type {Record<string, string[]>}
 */
const PITFALLS = {
  mermaid: [
    '节点文字含括号、方括号或引号时**整段加引号**：写 `A["文字（含括号）"]`，不要写 `A[文字（含括号）]`。',
    '形状括号必须成对：`[]` 矩形、`()` 圆角、`[()]` 圆柱、`{}` 菱形。**只有旗形是左开口**的 `id>文字]` —— 把方括号塞进旗形（`id>["文字"]`）会直接 `Parse error`；要方框就写 `id["文字"]`。',
    '子图标题写成 `subgraph 名称["标题"]`；`end` 必须单独一行。',
  ],
  graphviz: [
    '属性写成 `key="value"`；含空格或标点的标签必须加引号（`label="含 空格"`）。',
    '节点名不要用 `graph` / `node` / `edge` 这些保留字。',
    '每条语句以 `;` 结尾，整个图包在一对花括号里。',
  ],
  nomnoml: [
    '框是 `[文字]`、箭头是 `->`；连线标签写在箭头**前**：`[A] 是 -> [B]`。',
    '没有 `<choice>` 这类语法，尖括号会被当普通文本；判定就画普通方框。',
    '中文要加 `#padding: 22`，否则按西文字宽估算会溢出。',
  ],
  'vega-lite': [
    '必须有 `mark` 与 `data`；字段引用写在 `encoding.x.field`。',
    '这是 Vega-Lite，不是 Vega：不要写 `signals` / `marks` 这类运行时语法；叠加用 `layer`。',
  ],
  echarts: [
    'JSON 里不能有注释或尾随逗号；`series` 每项必须带 `type`，数据放在 `series.data`。',
  ],
  isometric: [
    'kind 只能是 solid 或 voxel；两种都是 JSON，不能有注释或尾随逗号。',
    '颜色写语义令牌（amber/blue/green/purple/red/ink/muted）或 #rrggbb；voxel 的 palette 键必须是单个字符。',
    'voxel 的 layers 与 shapes 二选一；用 shapes 时只有会放置体素的形状需要 fill（collapse 是挖空，不需要）。',
    '不要自己算缩放与取景 —— 引擎会自动把场景放进画布，你只描述有什么、在哪、什么颜色。',
    '需要转动或切开看内部时用 \u0060\u0060\u0060isometric-interactive；静态图用 \u0060\u0060\u0060isometric。',
  ],
  svg: [
    '手写 SVG 没有语法可错，但必须带 `<title>` 与 `<desc>`；`viewBox` 用 `0 0 680 高`（高 ≤ 400），否则会被画布裁切。',
  ],
}

/**
 * One-line fallback for a renderer without a pitfalls entry.
 *
 * @param {object} spec - the renderer.
 * @returns {string[]} its pitfall lines.
 */
function pitfallsOf(spec) {
  return PITFALLS[spec.id] ?? [spec.syntaxHint ?? '']
}

/**
 * Hash a file's bytes.
 *
 * @param {string} path - the file.
 * @returns {{ sha256: string, bytes: number }} its digest and size.
 */
function digest(path) {
  const bytes = readFileSync(path)
  return { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
}

/**
 * The installed version of an npm package.
 *
 * @param {string} name - package name.
 * @returns {string} its version, or 'unknown' when the package is absent.
 */
function versionOf(name) {
  try {
    return JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// 1. Copy the engines and hash them.
// ---------------------------------------------------------------------------

mkdirSync(vendorDir, { recursive: true })

/** @type {Record<string, {sha256: string, bytes: number, pkg: string, version: string}>} */
const integrity = {}
const missing = []

for (const spec of renderers) {
  for (const asset of spec.assets) {
    const source = join(modules, asset.pkg, asset.from)
    const target = join(vendorDir, asset.path)
    let info
    try {
      info = digest(source)
    } catch {
      missing.push(`${asset.pkg} (${asset.from})`)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    const version = versionOf(asset.pkg)
    integrity[asset.path] = { sha256: info.sha256, bytes: info.bytes, pkg: asset.pkg, version }
    console.log(
      `${spec.id.padEnd(11)} ${asset.path.padEnd(28)} ${(info.bytes / 1024).toFixed(0).padStart(6)} KB  ${asset.pkg}@${version}`,
    )
  }
}

if (missing.length > 0) {
  console.error(`\n缺少依赖: ${missing.join(', ')}`)
  console.error('先运行: npm install')
  process.exit(1)
}

writeFileSync(
  join(vendorDir, 'integrity.json'),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), assets: integrity }, null, 2)}\n`,
  'utf8',
)
console.log(`\nvendor/integrity.json  ${Object.keys(integrity).length} 个文件`)

// ---------------------------------------------------------------------------
// 2. Generate the skill: the body the agent loads on demand, plus one
//    reference page per renderer.
// ---------------------------------------------------------------------------

mkdirSync(join(skillDir, 'references'), { recursive: true })

const selectionRows = renderers
  .map((spec) => `| ${spec.usage} | ${spec.label} | ${spec.languages.map((l) => `${F}${l}`).join(' / ')} |`)
  .join('\n')

const navigationRows = renderers
  .map((spec) => `| ${spec.label} | 阅读 [references/${spec.id}.md](references/${spec.id}.md) |`)
  .join('\n')

/**
 * The pre-flight checklist for a figure.
 *
 * Ported from the Anatomy skill's craft notes, where every entry is traced to a
 * figure that was rejected for it. Kept short and phrased as things that go wrong,
 * because that is what makes a rule memorable enough to be applied.
 *
 * @returns {string} the markdown section.
 */
function checklistSection() {
  return [
    '## 出图前的自检',
    '',
    '每条都对应一次真实返工（前几条借鉴自 Anatomy 的工艺笔记，那里每条都记着是哪张图被谁驳回的）。',
    '',
    '- **线停在半空**：手写 SVG 里每条开放路径都要落在别的笔画、圆点或轮廓上。一条没有落点的线，读者会以为它指向别处。',
    '- **纹理画到一半断掉**：刻度、螺栓点、肋条要么结束在真实边界上，要么淡出。硬切在面中间读起来像坏了。',
    '- **靠眼睛调一张特写**：手调的键在 1× 下看着对，实际可能有几百处深度序错误（Anatomy 初版猛禽：54 处间隙问题、323 处深度序问题，全是截图看不出来的）。**先测量，再看。**',
    '- **抽象堆叠**：浮着的板子代表"层"，读者认不出是什么。做成抽屉、托盘、导轨上的滑台。',
    '- **一块大平板**：大面配几条线太平。拆成底座 + 滑台 + 零件，加沟槽、螺丝、标尺。',
    '- **文字塞进图里**：文字进标题、图例与说明；图内只留必要标注（编号引线是有意的，但不要每块都标）。',
    '- **颜色铺满**：留一处高亮告诉眼睛先看哪里，其余克制。',
    '- **指针瞬移**：一切移动都要缓动，慢到能跟上。',
    '- **照抄参考图**：取气质与完成度，物件自己造。',
    '',
    '等距与体素还有一条硬检查（`npm run check:renderers` 会跑）：物体不得互穿、引线必须落在图元上、图例项必须有对应物体。包含不算缺陷——球在壳里、城在球里是这些图的常用构造。',
    '',
  ].join('\n')
}
/**
 * The visual-style section of the skill.
 *
 * The active style is named in the standing prompt; this lists every style so
 * the model can tell them apart and knows what a hand-written figure must match.
 *
 * @returns {string} the markdown section.
 */
function styleSection() {
  const rows = styles
    .map((style) => '| **' + style.label + '**（' + String.fromCharCode(96) + style.id + String.fromCharCode(96) + '） | ' + style.summary + ' | ' + style.description + ' |')
    .join('\n')
  const detail = styles.map((style) => '- **' + style.label + '**：' + style.guidance).join('\n')
  return [
    '## 可选视觉风格',
    '',
    '风格规定整张图的构图、信息层级、排版、配色与标注，渲染器决定实现方式。**当前风格以文首「当前视觉风格」或提示段「视觉风格」为准**；未指定时采用「' + styles[0].label + '」。下表供比较，不得混用其他风格规则。引擎只应用支持的外观参数；已有手写 SVG 不会自动转换。',
    '',
    '| 风格 | 特征 | 适合 |',
    '| --- | --- | --- |',
    rows,
    '',
    '各风格的整图设计规范：',
    '',
    detail,
    '',
  ].join('\n')
}
writeFileSync(
  join(skillDir, 'SKILL.md'),
  `# 可视化输出

用带语言的代码块输出图，DSH 会把它渲染成真正的图；写错语法不会破坏对话，只会显示一张错误卡片。普通 echarts 保持静态；交互模式按需选择。

## 选型

| 要表达什么 | 用什么 | 栅栏 |
| --- | --- | --- |
${selectionRows}

## 语法要点

${renderers.map((spec) => `- **${spec.label}**：${spec.syntaxHint}`).join('\n')}

## 常见语法错误

写之前先排除这几条；它们占已知失败的大多数，且都会让整张图变成错误卡片。

${renderers
  .map(
    (spec) =>
      `- **${spec.label}**\n${pitfallsOf(spec)
        .map((line) => `  - ${line}`)
        .join('\n')}`,
  )
  .join('\n')}

每个渲染器的完整示例见下方导航。

<!-- ECHARTS_INTERACTIVE:BEGIN -->
## ECharts 交互模式

需要悬停数值、图例筛选或区间缩放时，用 \`\`\`echarts-interactive 输出 ECharts JSON。使用内联数据，配置不超过 256 KiB、数据总量不超过 10,000 点，不写函数、HTML 提示框或外部资源。提示框使用 richText；需要区间缩放时声明 dataZoom，图例筛选时声明 legend。

交互初始化失败只尝试一次静态降级；降级失败保留源码与错误说明。配置页可关闭交互模式，普通 echarts 不受影响。
<!-- ECHARTS_INTERACTIVE:END -->

## 手写 SVG 设计系统

选用手写 \`\`\`svg 后遵循当前视觉风格的整图设计规范；画法选择以当前绘图偏好与用户要求为准。以下是各风格共用的可读性要求，不额外指定配色、圆角或字号来覆盖当前风格。

- **画布**：\`<svg viewBox="0 0 680 高" width="100%" role="img">\`，左边距 40，卡片间留白充足。
- **构图**：先确定阅读顺序与主体，再安放标题、分区、说明和图例；不要把所有内容机械地套入相同卡片。
- **视觉语言**：配色、圆角、边框、连线和字号取当前风格的规则，保持全图一致；参考示例的暖色不是所有风格的强制要求。
- **连线与标注**：箭头表达真实方向，路径避开文字和节点；标签靠近对应对象，长文手动换行，不重叠、不出界。
- **字号层级**：标题、分区标题、正文与注释有明确主次，字号随画布比例协调；代码路径可用 \`ui-monospace\`。
- **无障碍**：每个图带 \`<title>\` 与一句 \`<desc>\`。
- 布局模式：对照＝两块语义色面板并排；时间线＝竖线＋圆点＋卡片；路线＝阶梯上行；循环＝横链＋虚线回路。

## 成本纪律

- 图由浏览器渲染，**渲染本身不花 token**；花 token 的是你写进对话的源码，而它会留在对话里、之后每轮都被重读。
- 同一份内容**语法越声明式越省**：一张流程图 nomnoml/mermaid ≈ 58 tokens，Graphviz ≈ 93，ECharts ≈ 113，Vega-Lite ≈ 182。优先选够用的最小语法。
- **不要重复画同一张图**。
- 大段 HTML/长文档**写成文件并给出路径**，不要贴进对话（省 92–99% 的上下文）。

## 失败处理

- 语法错误会保留原始代码块并显示错误卡片，改对后自动重新渲染。
- 图上「反馈」按钮把经过截断的源码与诊断记录到本机，并尝试复制诊断；不会自动发给作者或自动修改插件。
- 交互图表的反馈附带模式、原始失败阶段与降级结果；修正源码后可重新展示。静态错误卡片的「反馈并修复」在自修开关开启时向当前会话排队投递请求，会消耗该会话 token。

## 参考

| 渲染器 | 完整示例与注意事项 |
| --- | --- |
${navigationRows}
` + styleSection() + checklistSection(),
  'utf8',
)

for (const spec of renderers) {
  const versions = spec.assets.length === 0
    // 自绘渲染器不加载任何第三方引擎：参考页要说明这一点，而不是留一个空的"引擎："
    ? '内置于插件（无第三方引擎，投影在本地计算）'
    : spec.assets
        .map((asset) => `${asset.pkg}@${integrity[asset.path]?.version ?? 'unknown'}`)
        .join(', ')
  const fontNote = {
    stack: '字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。',
    'single-family': '该引擎只能指定**单一字体族**（CSS 字体栈无效）。中文必须显式写字体，否则标签会缺字。',
    embedded: '该引擎自带字体。',
  }[spec.fontPolicy ?? 'stack']

  writeFileSync(
    join(skillDir, 'references', `${spec.id}.md`),
    `# ${spec.label}

${spec.usage}

- 栅栏：${spec.languages.map((l) => `${F}${l}`).join(' / ')}
- 引擎：${versions}
- 字体：${fontNote}

## 语法

${spec.syntaxHint}

## 易错点

${pitfallsOf(spec)
  .map((line) => `- ${line}`)
  .join('\n')}

## 完整示例

${F}${spec.languages[0]}
${spec.sample}
${F}
`,
    'utf8',
  )
}

console.log(`skill/SKILL.md + skill/references/*.md  ${renderers.length + 1} 个文件`)
console.log(`\n完成：${Object.values(integrity).reduce((sum, item) => sum + item.bytes, 0) / 1024 / 1024} MB 引擎产物`)
