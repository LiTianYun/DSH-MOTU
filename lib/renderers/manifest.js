/**
 * The renderer manifest — the single source of truth for this plugin.
 *
 * Everything else is generated from this list:
 *
 *   - the plugin configuration schema (one `enabled` toggle plus this renderer's
 *     own knobs per entry), which is what makes a new renderer appear in the DSH
 *     plugin settings with no schema edit;
 *   - the host's routes, its renderer catalogue and its integrity checks;
 *   - the agent-facing prompt section and the skill body, so a disabled renderer
 *     also disappears from what the model is told it can draw;
 *   - the client's adapter index and the headless render checks.
 *
 * Adding a renderer is therefore: vendor its engine, add one entry here, write
 * one adapter. Nothing else in the plugin needs to know it exists.
 *
 * @module dsh-visual-kit/renderers/manifest
 */

/**
 * One file a renderer needs at runtime, and how the browser should load it.
 *
 * @typedef {object} AssetSpec
 * @property {string} path - destination under `vendor/`, also the route segment.
 * @property {string} from - source path inside the engine's npm package.
 * @property {string} pkg - npm package the file and its version come from.
 * @property {'script'|'module'|'style'} load - how the browser loads it.
 * @property {string} [global] - the global a `script` asset defines.
 * @property {'engine'|'support'} [role] - `support` assets (a second library, a
 *   font) are loaded only after the engine asks for them.
 */

/**
 * One renderer.
 *
 * @typedef {object} RendererSpec
 * @property {string} id - stable id: route segment, config key, adapter id.
 * @property {string} label - shown in the tool strip and in plugin settings.
 * @property {string} [family] - grouping key (`families`); used by the settings
 *   panel and by the standing prompt, so adding renderers does not grow the
 *   prompt without bound.
 * @property {string[]} languages - fence languages this renderer claims.
 * @property {{id: string, languages: string[], setting?: string, capabilities: string[]}[]} [modes] - optional display modes; existing output/languages remain compatible.
 * @property {'svg'|'html'} output - what the adapter returns.
 * @property {string} usage - one line: when to reach for this renderer.
 * @property {string} when - the same idea in a few words, for the standing
 *   prompt line, where every character is paid for on every model step.
 * @property {string} syntaxHint - one line of syntax guidance for the model.
 * @property {string} [promptNote] - one extra always-on sentence. Budget-gated:
 *   dropped first when the prompt would grow past its budget, because the same
 *   guidance also lives in the skill reference page.
 * @property {object} defaults - this renderer's own configuration defaults.
 * @property {AssetSpec[]} assets - files it needs.
 * @property {boolean} [needsContainer] - needs a live DOM node (canvas engines).
 * @property {boolean} [worker] - runs its layout in a worker or child process.
 * @property {'stack'|'single-family'|'embedded'} [fontPolicy] - how text is
 *   typed: a CSS font stack, one family the engine resolves itself, or fonts the
 *   engine carries.
 * @property {Record<string, number>} [limits] - input ceilings this renderer
 *   enforces through `enforceLimits` (bytes / faces / grid / points).
 * @property {string} sample - a valid source, used by the headless checks and by
 *   the skill's reference page.
 */

/**
 * Renderer families: the grouping the settings panel and the standing prompt use.
 *
 * A new renderer picks an existing family or adds one here — either way the
 * prompt gains at most a few words rather than a full sentence per renderer.
 *
 * @type {Record<string, string>}
 */
export const families = {
  diagram: '图与流程',
  chart: '数据图表',
  semantic: '手绘语义图',
  spatial: '空间与展示',
}

/** @type {RendererSpec[]} */
export const renderers = [
  {
    id: 'mermaid',
    label: 'Mermaid 图表',
    family: 'diagram',
    languages: ['mermaid'],
    output: 'svg',
    usage: '流程、时序、状态、类、甘特、饼图、脑图 —— 覆盖面最广，拿不准时用它',
    when: '流程、时序、状态、甘特、饼图、脑图',
    syntaxHint: '首行必须是图表类型关键字（flowchart TD / sequenceDiagram / stateDiagram-v2 / gantt / pie / mindmap）',
    defaults: { theme: 'auto' },
    fontPolicy: 'stack',
    assets: [
      { path: 'mermaid/mermaid.min.js', from: 'dist/mermaid.min.js', pkg: 'mermaid', load: 'script', global: 'mermaid' },
    ],
    sample: `flowchart LR
    A[开始] --> B[读取数据]
    B --> C{校验通过}
    C -->|是| D[写入结果]
    C -->|否| E[记录错误]
    D --> F[结束]
    E --> F`,
  },
  {
    id: 'graphviz',
    label: 'Graphviz（dot）',
    family: 'diagram',
    languages: ['dot', 'graphviz'],
    output: 'svg',
    usage: '流程、依赖、架构分层 —— 分层布局最稳，集群（subgraph cluster）是它的强项',
    when: '结构关系、依赖、架构分层',
    syntaxHint:
      'digraph G { rankdir=LR; A -> B; }；中文标签必须写 fontname="Microsoft YaHei"，分层用 subgraph cluster_x { label="…" }',
    defaults: { layout: 'dot', font: 'Microsoft YaHei', fontSize: 13 },
    fontPolicy: 'single-family',
    assets: [
      { path: 'graphviz/viz-global.js', from: 'dist/viz-global.js', pkg: '@viz-js/viz', load: 'script', global: 'Viz' },
    ],
    sample: `digraph G {
  rankdir=LR;
  A [label="开始"];
  B [label="读取数据"];
  C [label="校验通过", shape=diamond];
  D [label="写入结果"];
  E [label="记录错误"];
  F [label="结束"];
  A -> B -> C;
  C -> D [label="是"];
  C -> E [label="否"];
  D -> F;
  E -> F;
}`,
  },
  {
    id: 'nomnoml',
    label: 'nomnoml',
    family: 'diagram',
    languages: ['nomnoml'],
    output: 'svg',
    usage: '极简框线图 —— 语法最短，适合小而清楚的流程',
    when: '小而清楚的流程',
    syntaxHint:
      '[A] -> [B]；边标签写在端点和箭头之间：[A] 是 -> [B]；决策就是普通方框 [命中]，不要写 <choice>（尖括号会被当文本渲染）；中文必须加 #padding: 22 补偿它按西文字宽估算',
    defaults: { padding: 22, fill: '#f7f8fb', stroke: '#8a94a6', fontSize: 13 },
    fontPolicy: 'single-family',
    assets: [
      // nomnoml's UMD build expects its layout package as a global, so it loads
      // first. This is the case `role: 'support'` exists for: an engine that is
      // not self-contained.
      { path: 'nomnoml/graphre.js', from: 'dist/graphre.js', pkg: 'graphre', load: 'script', global: 'graphre', role: 'support' },
      { path: 'nomnoml/nomnoml.js', from: 'dist/nomnoml.js', pkg: 'nomnoml', load: 'script', global: 'nomnoml' },
    ],
    sample: `#padding: 22
#fill: #f7f8fb
#stroke: #8a94a6
[开始] -> [读取数据]
[读取数据] -> [校验通过]
[校验通过] 是 -> [写入结果]
[校验通过] 否 -> [记录错误]
[写入结果] -> [结束]
[记录错误] -> [结束]`,
  },
  {
    id: 'echarts',
    label: 'ECharts',
    family: 'chart',
    languages: ['echarts', 'echarts-interactive'],
    modes: [
      { id: 'static', languages: ['echarts'], capabilities: ['scale', 'reset', 'snapshot'] },
      { id: 'interactive', languages: ['echarts-interactive'], setting: 'interactive', capabilities: ['resize', 'reset', 'snapshot'] },
    ],
    output: 'svg',
    usage: '数量、占比、趋势、对比 —— 数据图表首选，中文排版友好',
    when: '数据图表',
    syntaxHint:
      'JSON 配置：{ "xAxis": { "type": "category", "data": [...] }, "series": [{ "type": "bar", "data": [...] }] }；饼图用 "type": "pie"',
    promptNote:
      '需要悬停数值、图例筛选或区间缩放时用 \u0060\u0060\u0060echarts-interactive，仍写 ECharts JSON，数据必须内联；普通 \u0060\u0060\u0060echarts 保持静态。',
    promptNoteSetting: 'interactive',
    defaults: { animation: false, interactive: true },
    // 交互配置的输入上限：体积与数据点数（由 enforceLimits 统一执行）
    limits: { bytes: 256 * 1024, points: 10000 },
    fontPolicy: 'stack',
    needsContainer: true,
    assets: [
      { path: 'echarts/echarts.min.js', from: 'dist/echarts.min.js', pkg: 'echarts', load: 'script', global: 'echarts' },
    ],
    sample: `{
  "title": { "text": "流量来源" },
  "series": [
    {
      "type": "pie",
      "radius": ["40%", "68%"],
      "data": [
        { "value": 1048, "name": "搜索引擎" },
        { "value": 735, "name": "直接访问" },
        { "value": 580, "name": "社交媒体" },
        { "value": 484, "name": "邮件营销" }
      ]
    }
  ]
}`,
  },
  {
    id: 'vega-lite',
    label: 'Vega-Lite',
    family: 'chart',
    languages: ['vega-lite', 'vegalite', 'vega'],
    output: 'svg',
    usage: '分层、分面、多视图统计图 —— 表达力最强，适合复杂的数据关系',
    when: '复杂统计图',
    syntaxHint:
      'Vega-Lite v6 JSON：{ "$schema": "…/v6.json", "data": { "values": [...] }, "mark": "bar", "encoding": { … } }；叠加用 "layer": [ … ]',
    defaults: { width: 560, height: 300 },
    fontPolicy: 'stack',
    assets: [
      { path: 'vega/vega.min.js', from: 'build/vega.min.js', pkg: 'vega', load: 'script', global: 'vega' },
      { path: 'vega/vega-lite.min.js', from: 'build/vega-lite.min.js', pkg: 'vega-lite', load: 'script', global: 'vegaLite' },
    ],
    sample: `{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "data": { "values": [
    { "月": "1月", "销售额": 128, "目标": 120 },
    { "月": "2月", "销售额": 142, "目标": 130 },
    { "月": "3月", "销售额": 168, "目标": 150 }
  ] },
  "layer": [
    { "mark": { "type": "bar", "color": "#5b7cc4" }, "encoding": { "y": { "field": "销售额", "type": "quantitative" } } },
    { "mark": { "type": "line", "color": "#e0a458" }, "encoding": { "y": { "field": "目标", "type": "quantitative" } } }
  ],
  "encoding": { "x": { "field": "月", "type": "nominal" } }
}`,
  },
  {
    id: 'svg',
    label: 'SVG 图示（手写）',
    family: 'semantic',
    languages: ['svg'],
    output: 'svg',
    usage: '概念对照、时间线、成长路线、架构分工 —— 模型按设计系统手写 SVG，布局与语义配色完全自由，最出彩（参照应用的真正用法）',
    when: '语义对照、时间线、路线图、概念架构',
    syntaxHint:
      '直接写 <svg viewBox="0 0 680 XXX" width="100%" role="img">…</svg>；必须带 <title> 与 <desc>；圆角 rx=8、边框 0.5px、暖中性配色（见参考页）',
    promptNote:
      '选择手写 \u0060\u0060\u0060svg 时，viewBox 用 680 宽、高不超过 400；检查 SVG 结构、文字溢出与留白，并遵循设计令牌。',
    defaults: {},
    fontPolicy: 'embedded',
    assets: [
      // DOMPurify sanitises the model-written markup before it is injected into
      // the page: scripts, event handlers and foreignObject are stripped.
      { path: 'svg/purify.min.js', from: 'dist/purify.min.js', pkg: 'dompurify', load: 'script', global: 'DOMPurify' },
    ],
    sample: `<svg viewBox="0 0 680 160" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">
  <title>手写 SVG 示例</title>
  <desc>两张圆角卡片展示设计系统的基础元素：暖中性现状卡与蓝色目标卡。</desc>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect x="40" y="40" width="200" height="80" rx="8" fill="#F1EFE8" stroke="#B4B2A9" stroke-width="0.5"/>
  <text x="140" y="86" font-size="13" font-weight="500" fill="#444441" text-anchor="middle">现状 · 各自为战</text>
  <line x1="260" y1="80" x2="400" y2="80" stroke="#888780" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="420" y="40" width="200" height="80" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"/>
  <text x="520" y="86" font-size="13" font-weight="500" fill="#0C447C" text-anchor="middle">目标 · 统一供给</text>
</svg>`,
  },
]

/**
 * Every fence language any renderer claims, mapped to its renderer id.
 *
 * @returns {Map<string, string>} language (lower-cased) → renderer id.
 */
export function languageIndex() {
  const index = new Map()
  for (const spec of renderers) {
    for (const language of spec.languages) index.set(language.toLowerCase(), spec.id)
  }
  return index
}

/**
 * Resolve one renderer's effective settings.
 *
 * The manifest's defaults are the baseline; the plugin configuration overrides
 * them per key. Missing configuration (a fresh install, or a renderer added by
 * an upgrade) falls back to the defaults rather than throwing.
 *
 * @param {RendererSpec} spec - the renderer.
 * @param {object} [config] - the plugin configuration.
 * @returns {object} the renderer's effective settings, `enabled` included.
 */
export function settingsFor(spec, config = {}) {
  const section = config?.renderers?.[spec.id]
  const given = section !== null && typeof section === 'object' ? section : {}
  return { ...spec.defaults, enabled: true, ...given }
}

/**
 * The renderers a configuration enables, in manifest order.
 *
 * @param {object} [config] - the plugin configuration.
 * @returns {RendererSpec[]} the enabled renderers.
 */
export function enabledRenderers(config = {}) {
  return renderers.filter((spec) => settingsFor(spec, config).enabled !== false)
}
