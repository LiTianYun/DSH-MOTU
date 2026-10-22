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
import { rendererCost } from '../lib/index.js'
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
    '**边标签里有裸双引号会 `Parse error`**：`A -->|说明| B` 的标签内不要放 `"` —— 改用 `「」` 或单引号，或把整段标签括起来并把内层引号转义。',
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
  report: [
    '**正文必须是一个 JSON 对象**：栅栏里不要写「结论：…」这种行文，也不要写 Markdown 列表 —— 直接写 `{ "title": "…", "status": "done", "verdict": "…" }`。',
    'JSON 用英文双引号，不能有注释或尾随逗号；「改动 / 验证 / 风险」分别放进 `sections` 的 `items`。',
    '只写实际跑过的验证；没跑就写「未验证」，不要写「应该没问题」。',
    'verdict 要回答「交付了什么」，不要写成「我做了以下工作」的流水账。',
    '改动表只列真实改过的文件；不要把计划、建议或未做的改动写进去。',
    '状态与徽章要一致：`partial` 时不要给「已完成」徽章。',
    '`sections[].flow` 画内联 SVG 流程图：2–6 个节点，`nodes[].id` 唯一，`edges[].from/to` 必须指向已声明的 id；不要写坐标、颜色或 SVG 源码。',
    '流程图是"结构 / 流程"的补充，不是替代正文；改动流程、数据流、调用链最适合画，纯清单不必硬塞。',
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

// 成本数字从同一份计算里取，避免像上一版那样手写后漂掉
const costRows = [...renderers]
  .sort((a, b) => rendererCost(a, {}, false).figureTokens - rendererCost(b, {}, false).figureTokens)
  .map((spec) => `${spec.label} ≈ ${rendererCost(spec, {}, false).figureTokens}`)
  .join('，')

const selectionRows = renderers
  .map((spec) => `| ${spec.when} | ${spec.label} | ${spec.languages.map((l) => `${F}${l}`).join(' / ')} | [${spec.id}.md](references/${spec.id}.md) |`)
  .join('\n')

/**
 * Per-renderer material that belongs on its own reference page.
 *
 * These sections used to sit in SKILL.md, where every reader paid for all eight
 * renderers whether or not they used them — and the syntax and pitfall sections
 * were verbatim duplicates of what the reference pages already carried. The
 * body is read whole, the reference page is read when it is needed, so the
 * detail belongs here.
 *
 * @param {object} spec - the renderer.
 * @returns {string} extra markdown for that page, or ''.
 */
function extraFor(spec) {
  if (spec.id === 'report') {
    return `
## 什么时候写

任务收尾时，只在**改过文件或运行过命令**后写；纯问答、纯解释不写。报告是给用户看的交付档案，不是过程流水账。

## 内容清单

1. **结论**：\`status\` + 一句话 \`verdict\`，先说交付了什么。
2. **用户能感知到的变化**：用户会看到或用到的变化，不是 commit 列表。
3. **改了什么**：文件 → 改动，用 \`table\`；只列实际改过的。
4. **验证**：实际跑过的命令与结果；没跑就写「未验证」，不要编。
5. **未测范围 / 风险**：用 \`details\` 折叠，写清楚为什么没测。
6. **来源**：文件路径或链接，纯文本；下载页与对话里都不发外部请求。

## 纪律

- 只写实际发生的事；不确定就写不确定。
- 改动表用 \`table\`，验证用列表或表；不要把所有内容都塞进 \`facts\`。
- 同一轮只写一份；不要重复报告。
- 报告页与摘要卡都跟随当前风格；正文里不要指定颜色、字号或版式。
- 自动归档到项目的 \`.dsh/visual-kit/reports/\`，正文里不需要贴路径。
`
  }
  if (spec.id === 'echarts') {
    return `
## 交互模式

需要悬停数值、图例筛选或区间缩放时，用 \`\`\`echarts-interactive 输出 ECharts JSON。使用内联数据，配置不超过 256 KiB、数据总量不超过 10,000 点，不写函数、HTML 提示框或外部资源。提示框使用 richText；需要区间缩放时声明 dataZoom，图例筛选时声明 legend。

交互初始化失败只尝试一次静态降级；降级失败保留源码与错误说明。配置页可关闭交互模式，普通 echarts 不受影响。
`
  }
  if (spec.id === 'svg') {
    return `
## 设计系统

选用手写 \`\`\`svg 后遵循当前视觉风格的整图设计规范；画法选择以当前绘图偏好与用户要求为准。以下是各风格共用的可读性要求，不额外指定配色、圆角或字号来覆盖当前风格。

- **画布**：\`<svg viewBox="0 0 680 高" width="100%" role="img">\`，左边距 40，卡片间留白充足。
- **构图**：先确定阅读顺序与主体，再安放标题、分区、说明和图例；不要把所有内容机械地套入相同卡片。
- **视觉语言**：配色、圆角、边框、连线和字号取当前风格的规则，保持全图一致；参考示例的暖色不是所有风格的强制要求。
- **连线与标注**：箭头表达真实方向，路径避开文字和节点；标签靠近对应对象，长文手动换行，不重叠、不出界。
- **字号层级**：标题、分区标题、正文与注释有明确主次，字号随画布比例协调；代码路径可用 \`ui-monospace\`。
- **无障碍**：每个图带 \`<title>\` 与一句 \`<desc>\`。
- 布局模式：对照＝两块语义色面板并排；时间线＝竖线＋圆点＋卡片；路线＝阶梯上行；循环＝横链＋虚线回路。
`
  }
  return ''
}

/**
 * The part-recipe table for the isometric reference page.
 *
 * A part is a shorthand that expands into primitives, so the model writes one
 * line instead of placing every plate and foot. Listed here rather than only in
 * the renderer's syntax hint because the parameters are what make them usable.
 *
 * @returns {string} the markdown section.
 */
function partSection() {
  const rows = [
    ['base', '底座 + 四角支脚，给场景一个落地感', 'size, thickness, footHeight, feet'],
    ['stack', '分层堆叠：每层一块板，层间留空', 'layers, size, gap, thickness, colors[]'],
    ['rack', '机架：四柱 + 顶底 + 槽位', 'size, height, slots, post'],
    ['grid', '阵列：集群 / 机柜排 / 节点网格', 'count[列,行], size, spacing'],
    ['tower', '塔楼：角柱 + 楼板', 'size, floors, floorHeight, slab, post'],
    ['dial', '表盘：盘面 + 表圈 + 指针', 'r, height, needle（弧度 0..1）, needleColor'],
    ['rail', '导轨 + 滑台 + 两端限位', 'length, gauge, rail, carriage, carriageAt(0..1), carriageColor'],
    ['post', '立柱 + 底座法兰 + 卡箍', 'height, r, clampAt(0..1), clampColor'],
  ].map(([name, what, params]) => '| `' + name + '` | ' + what + ' | ' + params + ' |').join('\n')
  return [
    '## 零件配方',
    '',
    '图元是积木，配方是成品件。写 `{ "type": "part", "part": "stack", "layers": 3 }` 比一个个摆板子省得多，也更不容易摆歪。公共参数是 `at`（中心）、`color`、`label`。',
    '',
    '| 配方 | 是什么 | 参数 |',
    '| --- | --- | --- |',
    rows,
    '',
    '`case` 可以是数字（立方体）或 `[宽, 深, 高]`（扁柜子）——宽而矮的场景塞进立方体会浪费大半画幅。',
    '',
    '关系检查会跑在配方上：引线必须落在某个配方或图元的包围盒内。**配方内部不做互穿判定**——它的几何是展开出来的，只有包围盒，而按包围盒判互穿会报出并不存在的重叠。',
    '',
  ].join('\n')
}
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
writeFileSync(
  join(skillDir, 'SKILL.md'),
  `# 可视化输出

用带语言的代码块输出图，DSH 会把它渲染成真正的图；写错语法不会破坏对话，只会显示一张错误卡片。

**动手前先读你打算用的那一种的参考页**：语法、易错点与完整示例都在那里。本页只讲选型与纪律 —— 把每个渲染器的细节都摊在这里，等于让每次读取都为十一种渲染器付费。

## 选型

| 要表达什么 | 用什么 | 栅栏 | 参考页 |
| --- | --- | --- | --- |
${selectionRows}

## 成本纪律

- 图由浏览器渲染，**渲染本身不花 token**；花 token 的是你写进对话的源码，而它会留在对话里、之后每轮都被重读。
- 同一份内容**语法越声明式越省**。一张典型图的源码代价（估算）：${costRows}。优先选够用的最小语法。
- **不要重复画同一张图**。
- 大段 HTML/长文档**写成文件并给出路径**，不要贴进对话（省 92–99% 的上下文）。

## 失败处理

- 语法错误会保留原始代码块并显示错误卡片，改对后自动重新渲染。
- 图上「反馈」按钮把经过截断的源码与诊断记录到本机，并尝试复制诊断；不会自动发给作者或自动修改插件。
- 交互图表的反馈附带模式、原始失败阶段与降级结果；修正源码后可重新展示。静态错误卡片的「反馈并修复」会拉起一个新会话去修，本会话不受影响。
` + checklistSection(),
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
` + extraFor(spec) + (spec.id === 'isometric' ? partSection() : ''),
    'utf8',
  )
}

console.log(`skill/SKILL.md + skill/references/*.md  ${renderers.length + 1} 个文件`)
console.log(`\n完成：${Object.values(integrity).reduce((sum, item) => sum + item.bytes, 0) / 1024 / 1024} MB 引擎产物`)
