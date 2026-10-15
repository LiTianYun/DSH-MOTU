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

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const modules = join(root, 'node_modules')
const vendorDir = join(root, 'vendor')
const skillDir = join(root, 'skill')

/** A markdown code fence, spelled once so the generated text stays readable. */
const F = '```'

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

每个渲染器的完整示例见下方导航。

<!-- ECHARTS_INTERACTIVE:BEGIN -->
## ECharts 交互模式

需要悬停数值、图例筛选或区间缩放时，用 \`\`\`echarts-interactive 输出 ECharts JSON。使用内联数据，配置不超过 256 KiB、数据总量不超过 10,000 点，不写函数、HTML 提示框或外部资源。提示框使用 richText；需要区间缩放时声明 dataZoom，图例筛选时声明 legend。

交互初始化失败只尝试一次静态降级；降级失败保留源码与错误说明。配置页可关闭交互模式，普通 echarts 不受影响。
<!-- ECHARTS_INTERACTIVE:END -->

## 手写 SVG 设计系统

概念对照、时间线、成长路线、架构分工这类**语义图**优先手写 \`\`\`svg —— 参照应用的高级感全部来自手写 SVG。设计系统（从其真实产物中提取）：

- **画布**：\`<svg viewBox="0 0 680 高" width="100%" role="img">\`，左边距 40，卡片间留白充足。
- **语义配色（颜色即含义）**：蓝 \`#185FA5\`/\`#0C447C\`/\`#E6F1FB\`＝新增或目标；暖灰 \`#F1EFE8\`/\`#B4B2A9\`/\`#444441\`＝现状；绿 \`#3B6D11\`/\`#EAF3DE\`＝推荐；红 \`#A32D2D\`/\`#FCEBEB\`＝问题；琥珀 \`#BA7517\`/\`#FAEEDA\`＝部分；紫 \`#534AB7\`/\`#EEEDFE\`＝进阶。
- **卡片**：\`rx="8"\` 圆角，\`stroke-width="0.5"\` 发丝边框；面板容器 \`rx="12~16"\` 带浅色底。
- **箭头**：开放式箭头 \`<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round"/>\`，\`marker-end\` 引用，\`stroke-dasharray="4 3"\` 表未来/循环。
- **字号层级**：11 眉标 / 12 正文 / 13 卡题 / 14 节题；卡题 \`font-weight="500"\`；代码路径用 \`ui-monospace\`。
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
`,
  'utf8',
)

for (const spec of renderers) {
  const versions = spec.assets
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
