/**
 * dsh-visual-kit — host half.
 *
 * Owns these same-origin routes:
 *
 *   GET  /dsh-visual-kit/config              effective configuration + liveness
 *   GET  /dsh-visual-kit/renderers.json      the renderer catalogue the browser renders from
 *   GET  /dsh-visual-kit/assets/<id>/<file>  the vendored engine builds
 *   GET  /dsh-visual-kit/health              integrity report per renderer and file
 *   GET  /dsh-visual-kit/diag                what the browser half last saw
 *   POST /dsh-visual-kit/diag                the browser half's report
 *
 * The rendering itself is a browser concern; this half exists so the browser
 * never reaches a CDN, and so the engines have exactly one version per install.
 * Shipping them also makes the plugin work offline, which is what "it renders
 * the same way everywhere" requires.
 *
 * Everything this half serves is derived from `renderers/manifest.js` — the
 * catalogue, the configuration schema, the integrity expectations, the prompt
 * section and the skill. Adding a renderer therefore needs no edit here.
 *
 * Export shape follows the dsh convention for host plugin halves:
 * `name` / `inject` / `apply` / `Config`, and no default export.
 *
 * @module dsh-visual-kit
 */

import z from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { enabledRenderers, families, renderers, settingsFor } from './renderers/manifest.js'
import { styleEntry, styleFor, styles } from './styles.js'

/** Cordis plugin name. */
export const name = 'dsh-visual-kit'

/** The route carrier this half cannot work without. */
export const inject = ['webServer']

/** Public route prefix. */
const ROUTE_PREFIX = '/dsh-visual-kit'

/** Where the engine builds live. */
const ASSET_PREFIX = `${ROUTE_PREFIX}/assets`

/** Liveness marker: bumped whenever this half changes, so a reload can be proven. */
const rev = 'v0.11.0'

/** Largest accepted diagnostic report, in bytes. A report is a handful of counters. */
const MAX_REPORT_BYTES = 32 * 1024

/** How many recent browser reports to keep. */
const MAX_REPORTS = 20

/**
 * Where a prompt section of our own belongs.
 *
 * The host's own section table places tool descriptions at 1000–3000, MCP at
 * 3100 and the SDK/tool-order sections at 5000+, so a capability statement that
 * tells the model how to *write* output belongs after the tools and before the
 * structured-output sections.
 */
const PROMPT_ORDER = 4500

/** The skill's name, and the directory its reference pages live in. */
const SKILL_NAME = 'dsh-visualization'
const SKILL_DIR = fileURLToPath(new URL('../skill/', import.meta.url))
const SKILL_FILE = fileURLToPath(new URL('../skill/SKILL.md', import.meta.url))

/** The generated record of what was vendored, and where the bytes live. */
const INTEGRITY_FILE = fileURLToPath(new URL('../vendor/integrity.json', import.meta.url))
const VENDOR_DIR = fileURLToPath(new URL('../vendor/', import.meta.url))

/** Recent reports from browser halves, newest first. */
const reports = []

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * A schema field for one default value.
 *
 * The manifest's defaults are plain values; this maps each to the matching
 * schema type so a renderer's own knobs appear in the plugin settings without
 * anyone writing a field by hand. An unrecognised value type becomes a string
 * field, which is the least surprising fallback: it round-trips whatever the
 * renderer declared.
 *
 * @param {unknown} value - the default from the manifest.
 * @returns {object} a schemastery field.
 */
function fieldFor(value) {
  if (typeof value === 'boolean') return z.boolean().default(value)
  if (typeof value === 'number') return z.number().default(value)
  if (typeof value === 'string') return z.string().default(value)
  return z.any().default(value)
}

/**
 * The plugin configuration schema, generated from the manifest.
 *
 * One `enabled` toggle plus the renderer's own defaults per renderer, so a
 * renderer added to the manifest shows up in the DSH plugin settings with no
 * schema edit — which is the point of generating it.
 *
 * @returns {object} the schema.
 */
function buildConfig() {
  const rendererSections = Object.fromEntries(
    renderers.map((spec) => [
      spec.id,
      z
        .object({
          enabled: z.boolean().default(true).description(`渲染 ${spec.label}`),
          ...Object.fromEntries(Object.entries(spec.defaults).map(([key, value]) => [key, fieldFor(value)])),
        })
        .default({}),
    ]),
  )

  return z.object({
    renderers: z
      .object(rendererSections)
      .default({})
      .description('逐项开关渲染器；关闭后该语言的代码块保持原样，也不再出现在给模型的能力说明里'),
    presentation: z
      .object({
        fontFamily: z.string().default('').description('留空则继承 DSH 主题字体；引擎只支持单一字体族的项除外'),
        fontSize: z.number().default(13).description('图内字号，默认与正文同尺度'),
        canvasMaxHeight: z.number().default(360).description('画布最高像素，超出则滚动'),
        canvasPadding: z.number().default(16).description('画布内边距'),
        background: z.string().default('auto').description('画布底色：auto | white | dark | transparent'),
        showToolbar: z.boolean().default(true).description('显示缩放/适应/复制/下载/反馈工具条'),
        style: z
          .string()
          .default(styles[0].id)
          .description(`生成风格：${styles.map((style) => `${style.id}（${style.label}·${style.summary}）`).join(' / ')}；指导整图构图、排版、配色与标注，引擎采用其支持的外观参数`),
      })
      .default({}),
    behavior: z
      .object({
        autoRender: z.boolean().default(true).description('自动把代码块渲染成图'),
        debounceMs: z.number().default(500).description('扫描防抖，毫秒'),
        lazyRender: z.boolean().default(true).description('仅渲染进入视口的图'),
        errorCard: z.boolean().default(true).description('渲染失败时显示错误卡片（关闭则保持代码块）'),
        repairInNewSession: z
          .boolean()
          .default(true)
          .description('修复在新会话里跑（复制本会话作为上下文），不占用本会话上下文；关闭则直接投递给本会话'),
        selfRepair: z
          .boolean()
          .default(true)
          .description('点「反馈并修复」时，把失败信息投递给本会话，让该会话的 agent 直接去修插件（会消耗该会话的 token）'),
      })
      .default({}),
    integrity: z
      .object({
        checkOnStartup: z.boolean().default(true).description('启动时校验已启用渲染器的引擎文件'),
        verifyOnServe: z.boolean().default(true).description('伺服引擎文件时校验哈希'),
        strict: z.boolean().default(false).description('校验失败的渲染器自动禁用'),
      })
      .default({}),
    agent: z
      .object({
        promptSection: z.boolean().default(true).description('向模型说明哪些代码块会被渲染'),
        skill: z.boolean().default(true).description('注册 dsh-visualization 技能（按需加载，不常驻）'),
        svgPreference: z.number().min(0).max(100).step(1).default(50).description('绘图偏好：0 偏常规引擎，50 按任务均衡选择，100 偏模型手写 SVG；是生成指引而非精确概率'),
      })
      .default({}),
    diagnostics: z
      .object({
        enabled: z.boolean().default(true).description('保留浏览器半的诊断上报'),
        keep: z.number().default(20).description('保留多少条上报'),
      })
      .default({}),
  })
}

/** The plugin configuration schema. */
export const Config = buildConfig()

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/**
 * Read the vendor step's integrity record.
 *
 * @returns {{ assets: Record<string, { sha256: string, bytes: number, pkg: string, version: string }> }}
 *   the record; an empty one when the file is missing, which is reported per
 *   asset rather than thrown, so a half-vendored install still starts.
 */
function loadIntegrityFile() {
  try {
    const parsed = JSON.parse(readFileSync(INTEGRITY_FILE, 'utf8'))
    return { assets: parsed?.assets ?? {} }
  } catch {
    return { assets: {} }
  }
}

/**
 * Hash files on demand, remembering the answer per file version.
 *
 * The cache key is mtime+size, so replacing an engine on disk (an upgrade, or a
 * hand-fix during development) is picked up without a restart.
 *
 * @returns {{ verify: (path: string) => {ok: boolean, actual: string, expected: string, bytes: number, version: string, message: string}, report: (config: object) => object[] }}
 *   the verifier and the report builder.
 */
function createIntegrity() {
  const record = loadIntegrityFile()
  /** @type {Map<string, { key: string, result: object }>} */
  const cache = new Map()

  /**
   * Verify one vendored file.
   * @param {string} path - path relative to `vendor/`.
   * @returns {{ok: boolean, actual: string, expected: string, bytes: number, version: string, message: string}} the result.
   */
  function verify(path) {
    const file = join(VENDOR_DIR, path)
    const expected = record.assets[path]
    let key = 'missing'
    try {
      const info = statSync(file)
      key = `${info.mtimeMs}:${info.size}`
    } catch {
      // Left as 'missing': the read below reports it.
    }
    const cached = cache.get(path)
    if (cached !== undefined && cached.key === key) return cached.result

    /** @type {{ok: boolean, actual: string, expected: string, bytes: number, version: string, message: string}} */
    let result
    try {
      const bytes = readFileSync(file)
      const actual = createHash('sha256').update(bytes).digest('hex')
      if (expected === undefined) {
        result = { ok: false, actual, expected: '', bytes: bytes.length, version: 'unknown', message: 'integrity.json 里没有这条记录（请重新运行 npm run vendor）' }
      } else if (expected.sha256 !== actual) {
        result = { ok: false, actual, expected: expected.sha256, bytes: bytes.length, version: expected.version, message: '文件哈希与记录不符（文件被改动或损坏）' }
      } else {
        result = { ok: true, actual, expected: expected.sha256, bytes: bytes.length, version: expected.version, message: '' }
      }
    } catch (error) {
      result = { ok: false, actual: '', expected: expected?.sha256 ?? '', bytes: 0, version: expected?.version ?? 'unknown', message: `无法读取：${String(error?.message ?? error)}` }
    }
    cache.set(path, { key, result })
    return result
  }

  /**
   * Build the per-renderer report.
   * @param {object} config - the plugin configuration.
   * @returns {object[]} one entry per renderer, each with its assets.
   */
  function report(config) {
    return renderers.map((spec) => {
      const settings = settingsFor(spec, config)
      const assets = spec.assets.map((asset) => {
        const result = verify(asset.path)
        return { path: asset.path, pkg: asset.pkg, ok: result.ok, version: result.version, bytes: result.bytes, expected: result.expected, actual: result.actual, message: result.message }
      })
      return {
        id: spec.id,
        label: spec.label,
        enabled: settings.enabled !== false,
        usable: settings.enabled !== false && assets.every((asset) => asset.ok),
        assets,
      }
    })
  }

  return { verify, report }
}

// ---------------------------------------------------------------------------
// What the agent is told
// ---------------------------------------------------------------------------

/**
 * The standing prompt line.
 *
 * This is a **directive, not a description**. The reference application is
 * pleasant to read because its model draws unprompted: explaining a structure,
 * a comparison or a plan comes with a picture whether or not the user asked for
 * one. A section that merely lists what *can* be rendered produces the opposite
 * behaviour — the model stays in prose until it is told to draw — so the line
 * leads with the instruction and only then names the fences.
 *
 * Generated from the enabled renderers, so disabling one also stops the model
 * being told about it — a capability the plugin cannot honour must not be
 * advertised. Returns '' when nothing is enabled, and the caller then registers
 * no section at all.
 *
 * @param {object} config - the plugin configuration.
 * @param {object[]} usable - the renderers that are enabled and intact.
 * @returns {string} the prompt text.
 */
function advertisedLanguages(spec, config) {
  const settings = settingsFor(spec, config)
  return spec.languages.filter((language) => !spec.modes?.some((mode) => mode.setting && mode.languages.includes(language) && settings[mode.setting] === false))
}

function svgPreference(config) {
  const value = config?.agent?.svgPreference
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value))) : 50
}

function drawingPolicy(config, usable) {
  if (!usable.some(spec => spec.id === 'svg') || !usable.some(spec => spec.id !== 'svg')) return null
  const weight = svgPreference(config)
  if (weight < 34) return {
    mode: 'standard', label: '常规引擎优先',
    rule: '结构、流程与架构默认使用合适的已启用图表引擎自动布局；只有用户明确要求或现有引擎不适合时才手写 SVG。',
  }
  if (weight > 66) return {
    mode: 'svg', label: '手写 SVG 优先',
    rule: '流程、架构、概念对照、时间线和路线图默认输出 ```svg 代码块，直接编写 <svg> 图示，普通流程图和架构图也在此范围。不要因为其他图表语法更熟悉、源码更短或更省 token 就换回传统图表。只有用户明确指定其他画法、需要悬停筛选等真实交互、需要统计图表引擎，或节点密集到手写难以清晰排布时，才使用合适的已启用引擎。',
  }
  return {
    mode: 'auto', label: '按任务均衡选择',
    rule: '复杂关系与架构用自动布局，统计数据用图表引擎，语义对照与定制版式可手写 SVG。',
  }
}

function drawingPreference(config, usable) {
  const policy = drawingPolicy(config, usable)
  if (policy === null) return ''
  return `绘图方式偏好：${policy.label}：${policy.rule}用户明确指定的画法优先；当前绘图偏好优先于通用选型表和省 token 建议。只使用当前启用的渲染器，不按模型名称猜测能力。`
}

function orderedRenderers(config, usable) {
  return drawingPolicy(config, usable)?.mode === 'svg'
    ? [...usable.filter(spec => spec.id === 'svg'), ...usable.filter(spec => spec.id !== 'svg')]
    : usable
}

/**
 * The standing prompt's character budget.
 *
 * Six renderers measure 623 characters. The budget is what keeps the prompt
 * from growing without bound as renderer families are added: the selection line
 * is spent first, then each renderer's own note while room remains, and anything
 * that does not fit is named as living in the skill reference page instead of
 * being silently dropped.
 */
/** 常驻提示段的字符预算：每轮都要付费，所以封顶并显式报告被挤掉的部分。 */
/** 栅栏清单自己的上限：它随渲染器数量线性增长，必须与总预算分开封顶。 */
const FENCE_LIST_BUDGET = 200

/** 常驻提示段的字符预算：每轮都要付费，所以封顶并显式报告被挤掉的部分。 */
export const PROMPT_BUDGET = 1000

/** The one line that is always worth its characters, whatever is enabled. */
const PROMPT_COST = '大段 HTML 或长文档写入文件并给出路径，不要贴进对话。'

/**
 * Spend the selection line's share of the budget, in manifest order.
 *
 * Deterministic: the same configuration always yields the same prompt, so the
 * prompt cannot flicker between turns.
 *
 * @param {object[]} ordered - the renderers, already ordered for the preference.
 * @param {boolean} svgFirst - whether hand-written SVG is the preferred mode.
 * @param {number} budget - characters available for this line.
 * @returns {{kept: string[], dropped: object[], used: number}} the split.
 */
function budgetedSelection(ordered, svgFirst, budget) {
  const kept = []
  const dropped = []
  let used = 0
  for (const spec of ordered) {
    const clause = svgFirst ? `${spec.label}（${spec.when}）` : `${spec.when}用 ${spec.label}`
    const cost = clause.length + 1
    // Always keep at least one clause: a selection line that names nothing is
    // worse than one that is slightly over budget.
    if (used + cost > budget && kept.length > 0) {
      dropped.push(spec)
      continue
    }
    kept.push(clause)
    used += cost
  }
  return { kept, keptSpecs: ordered.filter((spec) => !dropped.includes(spec)), dropped, used }
}

export function promptText(config, usable) {
  if (config?.behavior?.autoRender === false) return ''
  if (config?.agent?.promptSection === false) return ''
  if (usable.length === 0) return ''
  const ordered = orderedRenderers(config, usable)
  // 栅栏清单必须自己封顶：渲染器变多时它会线性增长，20 个就能吃掉整个预算，
  // 而预算本该是硬顶。放不下时改成"前几个 等 N 种"，其余在技能里查。
  const fenceNames = [...new Set(ordered.flatMap((spec) => advertisedLanguages(spec, config).slice(0, 2).map((language) => `\`\`\`${language}`)))]
  const fenceShown = []
  let fenceUsed = 0
  for (const name of fenceNames) {
    if (fenceUsed + name.length + 1 > FENCE_LIST_BUDGET) break
    fenceShown.push(name)
    fenceUsed += name.length + 1
  }
  const fences = fenceShown.length === fenceNames.length
    ? fenceShown.join('、')
    : `${fenceShown.join('、')} 等 ${fenceNames.length} 种`
  const svgFirst = drawingPolicy(config, usable)?.mode === 'svg'
  const lines = [
    '可视化：讲解结构、流程、对比、方案或数据时，**主动画一张图**，不要等用户要求 —— 一张清楚的图胜过三段文字。',
  ]
  const preference = drawingPreference(config, usable)
  if (preference) lines.push(preference)
  // 风格只报名字与要点：完整令牌与线型在技能里（按需读），常驻段每轮都要付费
  const activeStyle = styleFor(config)
  if (activeStyle.id !== styles[0].id) {
    lines.push(`视觉风格：${activeStyle.label}（${activeStyle.summary}）。整图构图、排版、层级与标注均遵循此风格，非仅换色；完整规则见技能。引擎采用支持的外观参数。`)
  }
  lines.push(`把图写进回复的代码块即可，DSH 会渲染成真正的图：${fences}。`)

  // The selection line is spent first: knowing *which* renderer to reach for
  // matters more than a syntax reminder, which the skill page repeats anyway.
  const fixed = lines.reduce((sum, line) => sum + line.length, 0) + PROMPT_COST.length
  const room = Math.max(120, PROMPT_BUDGET - fixed)
  const selected = budgetedSelection(ordered, svgFirst, room)
  let kept = selected.kept
  let keptSpecs = selected.keptSpecs
  let dropped = selected.dropped
  let used = selected.used
  const overflowText = () => (dropped.length > 0
    ? `其余（${[...new Set(dropped.map((spec) => families[spec.family] ?? spec.label))].join('、')}）见技能参考页。`
    : '')
  let overflow = overflowText()
  const selectionText = () => `${svgFirst ? '备选引擎能力（仅在上述例外情形使用）' : '选型'}：${kept.join('，')}。${overflow}`
  // 选型行落在 lines 里的下标：后面的硬裁切要就地替换它
  const selectionAt = lines.length
  lines.push(selectionText())
  // 补句按 ordered 顺序花剩下的预算。放不下的**必须点名**：静默丢弃会让人以为
  // 提示段覆盖了某个渲染器，而模型其实没收到那条规范（svg 的结构与排版规范被
  // 静默挤掉过一次，代价是产出非法 SVG）。
  const notes = ordered
    .filter((spec) => spec.promptNote !== undefined
      && (spec.promptNoteSetting === undefined || settingsFor(spec, config)[spec.promptNoteSetting] !== false))
    .map((spec) => ({ label: spec.label, note: spec.promptNote }))
  let budget = Math.max(0, room - used)
  const noteDropped = []
  for (const { label, note } of notes) {
    if (note.length > budget) {
      noteDropped.push(label)
      continue
    }
    budget -= note.length
    lines.push(note)
  }
  if (noteDropped.length > 0) {
    // 这行自己也要封顶：被挤掉的渲染器可能很多，列全了反而把预算撑爆
    const named = noteDropped.slice(0, 4).join('、')
    lines.push(noteDropped.length > 4
      ? `（${named} 等 ${noteDropped.length} 个渲染器的写法要点见技能参考页。）`
      : `（${named} 的写法要点见技能参考页。）`)
  }
  lines.push(PROMPT_COST)

  // 上面的优先级只是"尽量"，这里做最后一道硬裁切：预算必须是硬顶。
  // 从句尾开始丢选型条目（丢掉的照样写进溢出提示），直到装得下 —— 之前靠
  // "预留"是错的：在已经不够的预算里再减，等于没留，30 个渲染器时超了 37 字符。
  const total = () => lines.reduce((sum, line) => sum + line.length, 0)
  while (total() > PROMPT_BUDGET && keptSpecs.length > 1) {
    dropped.push(keptSpecs.pop())
    kept.pop()
    overflow = overflowText()
    lines[selectionAt] = selectionText()
  }
  return lines.join('')
}

/**
 * A rough token count for a piece of text.
 *
 * There is no tokenizer in this plugin and no dependency to add one, so this is
 * an estimate with a stated method rather than a measurement: CJK runs about 1.5
 * characters per token and everything else about 4. Counting the two separately
 * is cruder than a real tokenizer but much better than one blended ratio, since
 * this content is half Chinese prose and half JSON.
 *
 * Everywhere this number is shown, the exact character count is shown next to
 * it, so the estimate can be checked against its own basis instead of trusted.
 *
 * @param {string} text - the text.
 * @returns {number} the estimated tokens.
 */
export function estimateTokens(text) {
  const value = String(text ?? '')
  let wide = 0
  let total = 0
  for (const character of value) {
    total += 1
    // CJK、假名、全角标点：这些字符每个占的 token 明显多于一个 ASCII 字符
    if (/[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(character)) wide += 1
  }
  return Math.round(wide / 1.5 + (total - wide) / 4)
}

/**
 * What one renderer costs, for the settings panel.
 *
 * Two different costs, and conflating them is what makes "token cost" useless:
 *
 *   - **standing** — paid on every single model step, whether or not a figure is
 *     drawn: the fences it advertises, its clause in the selection line, and its
 *     syntax note.
 *   - **figure** — paid once per figure, when the model writes the source. The
 *     sample is used as the stand-in, so this is the cost of a *representative*
 *     figure rather than a bound.
 *
 * Computed directly rather than by diffing the prompt with and without the
 * renderer: that diff moves when the budget repacks, and a number that changes
 * for unrelated reasons teaches the reader to distrust it.
 *
 * @param {object} spec - the renderer.
 * @param {object} config - the plugin configuration.
 * @param {boolean} svgFirst - whether the drawing policy prefers hand-written SVG.
 * @returns {{standingChars: number, standingTokens: number, figureChars: number, figureTokens: number}} the cost.
 */
export function rendererCost(spec, config, svgFirst) {
  const clause = svgFirst ? `${spec.label}（${spec.when}）` : `${spec.when}用 ${spec.label}`
  const fences = advertisedLanguages(spec, config).slice(0, 2).map((language) => `\`\`\`${language}`).join('、')
  const noteEnabled = spec.promptNote !== undefined
    && (spec.promptNoteSetting === undefined || settingsFor(spec, config)[spec.promptNoteSetting] !== false)
  const standing = `${clause}、${fences}。${noteEnabled ? spec.promptNote : ''}`
  // 示例是"最小可用"，不是典型成本：手写 SVG 的示例不到一千字符，而真实插图约 1.3 万。
  // 所以渲染器可以声明一个实测的典型值，设置页显示它并标明依据。
  const sample = String(spec.sample ?? '')
  const hint = spec.costHint ?? {}
  const figureChars = Number.isFinite(hint.figureChars) ? hint.figureChars : sample.length
  return {
    standingChars: standing.length,
    standingTokens: estimateTokens(standing),
    figureChars,
    // 声明了典型长度时，用**示例自身的字符构成**外推，而不是假设全是中文 ——
    // 手写 SVG 大多是 ASCII 标记，按全中文估会高出一倍。
    figureTokens: Number.isFinite(hint.figureChars) && sample.length > 0
      ? Math.round(figureChars * (estimateTokens(sample) / sample.length))
      : estimateTokens(sample),
    figureBasis: hint.basis ?? '按该渲染器的示例',
  }
}

/**
 * The skill's catalogue summary.
 *
 * Only the name and these two strings are always visible; the body is loaded
 * when the agent decides to draw something.
 *
 * @param {object[]} usable - the renderers that are enabled and intact.
 * @returns {{description: string, whenToUse: string}} the summary.
 */
export function skillSummary(usable) {
  const labels = usable.map((spec) => spec.label).join('、')
  return {
    description: `把讲解画成图：${labels}。讲结构、流程、对比、方案、数据时主动配图，让回复一眼看懂。`,
    whenToUse:
      '讲解结构、流程、对比、方案或数据时主动使用（不必等用户要求画图）；用户明确要求画图、梳理架构、展示数据时同样使用。',
  }
}

export function effectiveSkillContent(content, config, usable) {
  const enabled = new Set(usable.map((spec) => spec.id))
  let result = content
  const interactive = enabled.has('echarts') && settingsFor(renderers.find((spec) => spec.id === 'echarts'), config).interactive !== false
  if (!interactive) result = result.replace(/<!-- ECHARTS_INTERACTIVE:BEGIN -->[\s\S]*?<!-- ECHARTS_INTERACTIVE:END -->\s*/g, '').replaceAll(' / ```echarts-interactive', '').replace('；交互模式按需选择', '')
  if (!enabled.has('echarts')) result = result.replace('普通 echarts 保持静态。', '')
  for (const spec of renderers) {
    if (!enabled.has(spec.id)) result = result.split('\n').filter((line) => !line.includes(`**${spec.label}**`) && !line.includes(`| ${spec.label} |`) && !line.includes(`| ${spec.usage} |`)).join('\n')
  }
  if (!enabled.has('svg')) result = result.replace(/## 手写 SVG 设计系统[\s\S]*?(?=\n## |$)/, '')
  // The generated reference lists every style for discovery. A live skill must
  // carry only the selected design brief, so a default example cannot compete
  // with the user's current choice (and the brief is not paid for twice).
  result = result.replace(/## 可选视觉风格\r?\n[\s\S]*?(?=\r?\n## |$)/,
    '## 风格应用\n\n整图设计以文首「当前视觉风格」为准；语法示例不能覆盖该选择。引擎按支持的参数呈现，手写 SVG 按完整规范构图与排版。\n')
  result = result.replace(/概念对照、时间线、成长路线、架构分工这类\*\*语义图\*\*优先手写 ```svg[^\n]*/, '选用手写 ```svg 后遵循以下设计系统；画法选择以当前绘图偏好与用户要求为准：')
  const svgFirst = drawingPolicy(config, usable)?.mode === 'svg'
  const rows = orderedRenderers(config, usable).map(spec => {
    const usage = svgFirst
      ? spec.id === 'svg' ? '默认：流程、架构、概念对照、时间线和路线图，直接手写 SVG'
        : `备选：${spec.usage.replace('，拿不准时用它', '')}`
      : spec.usage
    return `| ${usage} | ${spec.label} | ${advertisedLanguages(spec, config).map(language => `\`\`\`${language}`).join(' / ')} |`
  }).join('\n')
  result = result.replace(/## 选型\r?\n[\s\S]*?(?=\r?\n## 语法要点)/,
    `## 选型\n\n先遵循用户指定与文首绘图方式，再查此表；备选能力不能覆盖当前默认画法。\n\n| 要表达什么 | 用什么 | 栅栏 |\n| --- | --- | --- |\n${rows}\n`)
  result = result.replace('优先选够用的最小语法。', '先满足用户指定与当前绘图偏好，再在该画法内精简源码；不得仅为省 token 改换画法。')
  const preference = drawingPreference(config, usable)
  const style = styleFor(config)
  const head = [
    preference,
    `## 当前视觉风格：${style.label}（${style.summary}）\n\n${style.guidance}\n\n此风格约束整张新生成图的构图、排版、配色、图形和标注；用户明确指定优先。参考页的示例仅供语法参考，不得覆盖当前风格。引擎只能应用其支持的参数，不能承诺任意版式；已有手写 SVG 不会自动改写。`,
  ].filter(Boolean).join('\n\n')
  return `${head}\n\n${result}`
}

// ---------------------------------------------------------------------------
// Writing configuration back
//
// The settings page can flip switches, and those switches are the plugin's real
// configuration — not a shadow copy. The patch is validated against the very
// schema that renders the config form, so a field the schema does not define (or
// a value of the wrong type) is dropped instead of being persisted.
// ---------------------------------------------------------------------------

/** Sections a client patch may touch. */
const PATCHABLE_SECTIONS = ['renderers', 'behavior', 'agent', 'presentation']

/**
 * Does a value match the primitive type a schema field declares?
 *
 * The field's own `type` is the contract (a default value is not reliably
 * reachable on the schema node), and it is exactly what the config form
 * validates against.
 *
 * @param {string} fieldType - the schema field's type name.
 * @param {unknown} value - the requested value.
 * @returns {boolean} whether it is acceptable.
 */
function matchesFieldType(fieldType, value) {
  switch (fieldType) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string'
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    case 'any':
      return true
    default:
      return false
  }
}

/**
 * Keep only the fields a section's schema declares, with matching value types.
 *
 * @param {object} schema - the section's schemastery schema.
 * @param {object} patch - the requested values.
 * @returns {Record<string, unknown>} the accepted values.
 */
function cleanAgainst(schema, patch) {
  const fields = schema?.dict
  if (fields === undefined) return {}
  const out = {}
  for (const [key, value] of Object.entries(patch)) {
    const field = fields[key]
    if (field === undefined) continue
    if (!matchesFieldType(String(field.type ?? ''), value)) continue
    if (key === 'svgPreference' && (!Number.isInteger(value) || value < 0 || value > 100)) continue
    // 风格 id 必须是注册表里的一个：拼错的名字会让所有图静默退回默认风格
    if (key === 'style' && !styles.some((style) => style.id === value)) continue
    out[key] = value
  }
  return out
}

/**
 * Validate a client-supplied configuration patch.
 *
 * @param {unknown} patch - the parsed request body.
 * @returns {object} the accepted patch, possibly empty.
 */
export function sanitizeConfigPatch(patch) {
  const out = {}
  if (patch === null || typeof patch !== 'object') return out
  for (const section of PATCHABLE_SECTIONS) {
    const value = patch[section]
    if (value === null || typeof value !== 'object') continue
    if (section !== 'renderers') {
      const clean = cleanAgainst(Config.dict?.[section], value)
      if (Object.keys(clean).length > 0) out[section] = clean
      continue
    }
    const sectionOut = {}
    for (const [id, settings] of Object.entries(value)) {
      if (settings === null || typeof settings !== 'object') continue
      const clean = cleanAgainst(Config.dict?.renderers?.dict?.[id], settings)
      if (Object.keys(clean).length > 0) sectionOut[id] = clean
    }
    if (Object.keys(sectionOut).length > 0) out.renderers = sectionOut
  }
  return out
}

/**
 * Merge a validated patch onto the current configuration.
 *
 * @param {object} current - the entry's current raw config.
 * @param {object} patch - the validated patch.
 * @returns {object} the next raw config.
 */
export function mergeConfigPatch(current, patch) {
  const base = current !== null && typeof current === 'object' ? current : {}
  const next = { ...base }
  for (const [section, value] of Object.entries(patch)) {
    if (section === 'renderers') {
      const merged = { ...(base.renderers ?? {}) }
      for (const [id, settings] of Object.entries(value)) {
        merged[id] = { ...(merged[id] ?? {}), ...settings }
      }
      next.renderers = merged
      continue
    }
    next[section] = { ...(base[section] ?? {}), ...value }
  }
  return next
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Content types for the asset kinds this package vendors. */
const CONTENT_TYPES = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}

/**
 * Write one JSON response.
 * @param res - the server response.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serialisable body.
 */
function writeJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Read a request body with a hard cap.
 *
 * The beacon is small and local, but an unbounded body reader on a public route
 * is how a diagnostic channel becomes a memory problem.
 *
 * @param req - the incoming request.
 * @param {number} limit - maximum accepted bytes.
 * @returns {Promise<string>} the body text.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`body exceeds ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Where submitted feedback and error reports are appended.
 *
 * The in-memory ring is for the live `/diag` view; this file is the part that
 * survives a restart. A failure report that vanishes when the app closes is not
 * a report anyone can act on.
 *
 * @returns {string} the log path.
 */
function reportLogPath() {
  return join(homedir(), '.dsh', 'visual-kit', 'reports.jsonl')
}

/**
 * Append one report to the on-disk log, best effort.
 *
 * Diagnostics must never break rendering, so every failure here is swallowed.
 *
 * @param {object} record - the report record.
 */
function appendReportLog(record) {
  try {
    const file = reportLogPath()
    mkdirSync(join(homedir(), '.dsh', 'visual-kit'), { recursive: true })
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // A read-only home directory, a full disk — none of it may break a diagram.
  }
}

/**
 * Keep one browser report.
 *
 * Plain liveness beacons stay in memory only (they are noise); feedback and
 * error reports are also appended to the on-disk log.
 *
 * @param {unknown} payload - whatever the browser half sent.
 * @param {number} keep - how many reports to retain.
 */
function recordReport(payload, keep) {
  if (payload === null || typeof payload !== 'object') return
  const record = { at: new Date().toISOString(), ...payload }
  reports.unshift(record)
  if (reports.length > keep) reports.length = keep
  if (record.kind === 'feedback' || record.kind === 'error') appendReportLog(record)
}

/**
 * Serve one vendored engine file.
 *
 * The servable set is a whitelist built from the manifest, so the route cannot
 * be walked out of `vendor/` no matter what the URL says. Bytes are read once
 * and cached in memory keyed by mtime+size: the engines are megabytes and a
 * conversation may ask for them on every page load.
 *
 * @param {Map<string, {path: string, contentType: string}>} servable - url path → file.
 * @param {object} integrity - the verifier.
 * @param {() => object} currentConfig - reads the live configuration.
 * @param {Map<string, {key: string, bytes: Buffer, etag: string}>} cache - the byte cache.
 * @returns {(req, res) => void} the handler.
 */
function assetHandler(servable, integrity, currentConfig, cache) {
  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const entry = servable.get(url.pathname)
    if (entry === undefined) {
      res.statusCode = 404
      res.end()
      return
    }

    const config = currentConfig()
    if (config?.integrity?.verifyOnServe !== false) {
      const result = integrity.verify(entry.path)
      if (!result.ok) {
        // A corrupt engine must not be served as if it were fine: the browser
        // would fail deep inside the library with an unrelated message.
        res.statusCode = 503
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(`dsh-visual-kit: ${entry.path} 完整性校验失败 — ${result.message}`)
        return
      }
    }

    const file = join(VENDOR_DIR, entry.path)
    let key = 'missing'
    try {
      const info = statSync(file)
      key = `${info.mtimeMs}:${info.size}`
    } catch {
      // Reported by the read below.
    }
    let held = cache.get(entry.path)
    if (held === undefined || held.key !== key) {
      try {
        const bytes = readFileSync(file)
        const etag = `"${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"`
        held = { key, bytes, etag }
        cache.set(entry.path, held)
      } catch (error) {
        res.statusCode = 503
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(`dsh-visual-kit: 无法读取 ${entry.path} — ${String(error?.message ?? error)}`)
        return
      }
    }

    res.setHeader('content-type', entry.contentType)
    // The bytes change only when the plugin is upgraded, and the client stamps
    // its requests with the plugin revision, so a long cache is safe.
    res.setHeader('cache-control', 'public, max-age=86400')
    res.setHeader('etag', held.etag)
    if (req.headers['if-none-match'] === held.etag) {
      res.statusCode = 304
      res.end()
      return
    }
    res.statusCode = 200
    res.setHeader('content-length', String(held.bytes.length))
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    res.end(held.bytes)
  }
}

/**
 * Mount the host half.
 *
 * @param ctx - plugin context with `webServer` injected.
 * @param {object} [config] - the plugin configuration.
 * @returns {() => void} disposer releasing the routes and registrations.
 */
export function apply(ctx, config = {}) {
  const live = { current: config }
  const integrity = createIntegrity()
  /** @type {Map<string, {key: string, bytes: Buffer, etag: string}>} */
  const assetCache = new Map()
  /** @type {Map<string, {path: string, contentType: string}>} */
  const servable = new Map()

  for (const spec of renderers) {
    for (const asset of spec.assets) {
      const extension = asset.path.slice(asset.path.lastIndexOf('.'))
      servable.set(`${ASSET_PREFIX}/${asset.path}`, {
        path: asset.path,
        contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
      })
    }
  }

  // The startup check runs once per apply and its result is what `strict` acts
  // on, so a failing engine cannot be advertised and then fail in the browser.
  const startupReport = config?.integrity?.checkOnStartup === false ? null : integrity.report(config)
  if (startupReport !== null) {
    for (const entry of startupReport) {
      for (const asset of entry.assets) {
        if (!asset.ok) ctx.logger?.warn?.(`[dsh-visual-kit] ${entry.id}: ${asset.path} — ${asset.message}`)
      }
    }
  }

  /**
   * The renderers this configuration can actually honour.
   * @returns {object[]} enabled, and intact when `strict` is on.
   */
  function usable() {
    const current = live.current
    const enabled = enabledRenderers(current)
    if (current?.integrity?.strict !== true) return enabled
    return enabled.filter((spec) => spec.assets.every((asset) => integrity.verify(asset.path).ok))
  }

  /** @returns {object} the catalogue the browser renders from. */
  function catalogue() {
    const current = live.current
    const allowed = new Set(usable().map((spec) => spec.id))
    return {
      rev,
      renderers: renderers.map((spec) => {
        const settings = settingsFor(spec, current)
        return {
          id: spec.id,
          label: spec.label,
          languages: spec.languages,
          output: spec.output,
          modes: (spec.modes ?? [{ id: 'static', languages: spec.languages, capabilities: ['scale', 'reset', 'snapshot'] }])
            .map((mode) => ({ ...mode, enabled: live.current?.behavior?.autoRender !== false && allowed.has(spec.id) && (!mode.setting || settings[mode.setting] !== false) })),
          needsContainer: spec.needsContainer === true,
          worker: spec.worker === true,
          fontPolicy: spec.fontPolicy ?? 'stack',
          // 分组键与输入上限都要下发：设置页按 family 分组，渲染器按 limits 执行自己的上限
          family: spec.family ?? '',
          limits: spec.limits ?? {},
          enabled: allowed.has(spec.id),
          settings,
          // Carried for the settings panel, which previews each renderer by
          // rendering its own sample through the same adapter the conversation
          // uses — so the panel can never drift from what the chat produces.
          usage: spec.usage,
          syntaxHint: spec.syntaxHint,
          sample: spec.sample,
          // 成本：常驻部分每轮都付，图源在生成时付一次。设置页据此显示预估 token。
          cost: rendererCost(spec, current, drawingPolicy(current, usable())?.mode === 'svg'),
          assets: spec.assets.map((asset) => {
            const result = integrity.verify(asset.path)
            return {
              path: asset.path,
              url: `${ASSET_PREFIX}/${asset.path}`,
              load: asset.load,
              global: asset.global ?? '',
              role: asset.role ?? 'engine',
              version: result.version,
              bytes: result.bytes,
              ok: result.ok,
            }
          }),
        }
      }),
      presentation: current?.presentation ?? {},
      // 风格清单给设置页做选择器；active 让面板不必自己推导
      styles: styles.map((style) => styleEntry(style, styleFor(current).id)),
      behavior: current?.behavior ?? {},
    }
  }

  /**
   * Register one route, tolerating a transient duplicate.
   *
   * Rapid disable→enable (or enable→enable) can re-enter `apply` before the
   * previous fiber's `webServer` registrations have been released, and the
   * carrier rejects the second `register` with a duplicate-route error. That
   * race is a host-lifecycle artifact, not a misconfiguration, so rather than
   * hard-failing the whole fiber (which leaves the plugin dark until an app
   * restart), wait briefly for the sibling to let go and retry a few times.
   *
   * The wait is a bounded `Atomics.wait` (a few hundred milliseconds, only on
   * the rare duplicate path); activation is not latency-sensitive.
   *
   * @param {object} route - the web route to register.
   * @returns {() => void} the disposer.
   */
  function registerRoute(route) {
    let lastError
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return ctx.webServer.register(route)
      } catch (error) {
        lastError = error
        const message = String(error?.message ?? error)
        if (!message.includes('duplicate') || attempt === 3) break
        try {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
        } catch {
          /* a platform without blocking wait falls through to the next try */
        }
      }
    }
    throw lastError
  }

  /**
   * Persist a validated configuration patch through the host's config editor.
   *
   * The editor owns profile rows, so this is the supported way to change a
   * plugin's own config: it validates, writes the row, and lets the Loader
   * reconcile — which re-runs `apply` with the new values.
   *
   * @param {object} patch - the validated patch.
   * @returns {Promise<void>} resolves after the Loader reconciles.
   */
  async function writeConfig(patch) {
    const editor = ctx.get?.('configEditor')
    if (editor === undefined || editor === null) {
      throw new Error('宿主没有提供 configEditor 服务，无法写入配置（请在插件配置页手动修改）')
    }
    const entries = editor.entries()
    const own = entries.find(
      (entry) =>
        entry?.name === name ||
        entry?.options?.name === name ||
        entry?.patchId === 'visual-kit' ||
        entry?.id === 'visual-kit',
    )
    if (own === undefined) {
      throw new Error(`没有找到本插件的配置行（候选 ${entries.length} 条）`)
    }
    await editor.edit(own, (current) => mergeConfigPatch(current ?? live.current ?? {}, patch))
  }

  const disposeAssets = registerRoute({
    kind: 'prefix',
    path: ASSET_PREFIX,
    handler: assetHandler(servable, integrity, () => live.current, assetCache),
  })

  const disposeConfig = registerRoute({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/config`,
    handler: (req, res) => {
      if (req.method === 'POST') {
        // The settings page writes here. Persisting through `configEditor`
        // keeps one source of truth: the write lands in the profile row, so the
        // plugin's own config form, this catalogue, the prompt section and the
        // skill all move together — no shadow copy to drift.
        readBody(req, MAX_REPORT_BYTES)
          .then(async (raw) => {
            let patch
            try {
              patch = JSON.parse(raw)
            } catch {
              writeJson(res, 400, { ok: false, error: { message: 'invalid JSON body' } })
              return
            }
            const clean = sanitizeConfigPatch(patch)
            if (Object.keys(clean).length === 0) {
              writeJson(res, 400, { ok: false, error: { message: '没有可写入的字段（字段名或类型不匹配）' } })
              return
            }
            try {
              await writeConfig(clean)
              writeJson(res, 200, { ok: true, value: { applied: clean } })
            } catch (error) {
              writeJson(res, 503, { ok: false, error: { message: String(error?.message ?? error) } })
            }
          })
          .catch((error) => writeJson(res, 413, { ok: false, error: { message: String(error?.message ?? error) } }))
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD, POST')
        res.end()
        return
      }
      const allowed = usable()
      writeJson(res, 200, {
        ok: true,
        value: {
          rev,
          name,
          enabled: allowed.map((spec) => spec.id),
          disabled: renderers.filter((spec) => !allowed.includes(spec)).map((spec) => spec.id),
          prompt: promptText(live.current, allowed),
          skill: live.current?.agent?.skill === false || live.current?.behavior?.autoRender === false || allowed.length === 0 ? '' : SKILL_NAME,
          routes: { assets: ASSET_PREFIX },
          // What the settings page needs to render its switches.
          settings: {
            autoRender: live.current?.behavior?.autoRender !== false,
            selfRepair: live.current?.behavior?.selfRepair !== false,
            repairInNewSession: live.current?.behavior?.repairInNewSession !== false,
            promptSection: live.current?.agent?.promptSection !== false,
            skill: live.current?.agent?.skill !== false,
            svgPreference: svgPreference(live.current),
            // 当前风格也要下发：客户端据此察觉"只有风格变了"，并把已有图重绘
            style: styleFor(live.current).id,
            interactive: settingsFor(renderers.find((spec) => spec.id === 'echarts'), live.current).interactive !== false,
            renderers: Object.fromEntries(
              renderers.map((spec) => [spec.id, settingsFor(spec, live.current).enabled !== false]),
            ),
          },
        },
      })
    },
  })

  const disposeCatalogue = registerRoute({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/renderers.json`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }
      writeJson(res, 200, catalogue())
    },
  })

  const disposeHealth = registerRoute({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/health`,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }
      const allowed = new Set(usable().map((spec) => spec.id))
      const report = integrity.report(live.current).map((entry) => ({ ...entry, usable: allowed.has(entry.id) }))
      writeJson(res, 200, {
        ok: report.every((entry) => !entry.enabled || entry.usable),
        value: {
          rev,
          strict: live.current?.integrity?.strict === true,
          renderers: report,
        },
      })
    },
  })

  const disposeDiag = registerRoute({
    kind: 'exact',
    path: `${ROUTE_PREFIX}/diag`,
    handler: (req, res) => {
      if (req.method === 'POST') {
        readBody(req, MAX_REPORT_BYTES)
          .then((raw) => {
            let payload
            try {
              payload = JSON.parse(raw)
            } catch {
              writeJson(res, 400, { ok: false, error: { message: 'invalid JSON body' } })
              return
            }
            recordReport(payload, Math.max(1, Number(live.current?.diagnostics?.keep) || MAX_REPORTS))
            writeJson(res, 200, { ok: true, value: { accepted: true, kept: reports.length } })
          })
          .catch((error) => writeJson(res, 413, { ok: false, error: { message: String(error?.message ?? error) } }))
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD, POST')
        res.end()
        return
      }
      writeJson(res, 200, {
        ok: true,
        value: {
          rev,
          reports: live.current?.diagnostics?.enabled === false ? [] : reports,
          // Feedback and errors are also appended here, so they outlive a restart.
          log: live.current?.diagnostics?.enabled === false ? '' : reportLogPath(),
        },
      })
    },
  })

  // The two agent-facing registrations are optional services: the plugin must
  // keep rendering even where the host does not provide them.
  const disposers = [disposeAssets, disposeConfig, disposeCatalogue, disposeHealth, disposeDiag]

  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt !== undefined && systemPrompt !== null) {
    const text = promptText(config, usable())
    if (text !== '') {
      disposers.push(systemPrompt.section({ name: 'visual-kit:capability', order: PROMPT_ORDER, text }))
    }
  }

  const skills = ctx.get?.('skills')
  if (skills !== undefined && skills !== null && config?.agent?.skill !== false && config?.behavior?.autoRender !== false && usable().length > 0) {
    let content = ''
    try {
      content = readFileSync(SKILL_FILE, 'utf8')
    } catch (error) {
      ctx.logger?.warn?.(`[dsh-visual-kit] skill 正文缺失：${String(error?.message ?? error)}（请运行 npm run vendor）`)
    }
    if (content !== '') {
      const summary = skillSummary(usable())
      const policy = drawingPolicy(config, usable())
      const modeHint = policy === null ? '' : `当前绘图方式：${policy.label}。`
      disposers.push(
        skills.register({
          name: SKILL_NAME,
          description: modeHint + summary.description,
          whenToUse: modeHint + summary.whenToUse,
          source: 'bundled',
          content: effectiveSkillContent(content, config, usable()),
          resourceBase: { kind: 'directory', path: SKILL_DIR },
          invocation: { modelInvocable: true, userInvocable: true },
          metadata: { plugin: name, renderers: usable().map((spec) => spec.id) },
        }),
      )
    }
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) {
      try {
        dispose()
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-visual-kit] dispose failed: ${String(error?.message ?? error)}`)
      }
    }
  }
  // Cordis can construct `apply` as a plugin class. A returned function alone
  // is then not a teardown hook; explicitly own registrations with an effect.
  ctx.effect?.(() => dispose, 'dsh-visual-kit: host registrations')
  return dispose
}
