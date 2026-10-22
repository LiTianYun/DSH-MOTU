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
 * @property {boolean} [eager] - render without waiting for the viewport. Reports
 *   sit at the end of a long reply and must be archived even before they scroll
 *   into view.
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
    promptNote: '需要悬停、筛选或缩放时用 ```echarts-interactive，数据必须内联；普通 ```echarts 静态。',
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
    id: 'isometric',
    label: '等距展示',
    family: 'spatial',
    languages: ['isometric', 'isometric-interactive'],
    modes: [
      { id: 'static', languages: ['isometric'], capabilities: ['scale', 'reset', 'snapshot'] },
      { id: 'interactive', languages: ['isometric-interactive'], setting: 'interactive', capabilities: ['resize', 'reset', 'snapshot'] },
    ],
    output: 'svg',
    usage: '等距剖面 —— 要转动、缩放、切开看内部，或同一结构要反复改角度改配色时用它（一次性插图手写 SVG 更灵活）',
    when: '需要交互的空间图、要反复改角度的剖面',
    syntaxHint:
      'JSON：{ "objects": [{ "type": "shell", "r": 1.3, "thickness": 0.16, "color": "amber" }] }；图元 box/ball/shell/cylinder/ring，或直接用零件配方 { "type": "part", "part": "stack", "layers": 3 }（base/stack/rack/grid/tower/dial/rail/post）；颜色用语义令牌（amber/blue/green/purple/red/ink/muted）或 #rrggbb',
    promptNote: '要转动、缩放或切开看内部时用 ```isometric-interactive，静态用 ```isometric；投影与取景由引擎算。',
    defaults: { interactive: true },
    // 自绘渲染器：无第三方引擎，投影数学在客户端半本地计算
    // 产物上限：spec 是进入对话的（另有 64 KiB 上限），产物是本地生成的
    limits: { bytes: 256 * 1024, faces: 6000, grid: 32 },
    fontPolicy: 'stack',
    assets: [],
    sample: `{
  "title": "三层部署剖面",
  "desc": "把一次部署画成可切开的三层：自下而上是网关、服务与数据，颜色各自代表一层。",
  "case": [
    6.8,
    6.8,
    3.6
  ],
  "cut": 2.2,
  "height": 320,
  "objects": [
    {
      "type": "box",
      "at": [
        0,
        0,
        -1.2
      ],
      "size": [
        5.8,
        5.4,
        0.5
      ],
      "color": "blue",
      "label": "网关层"
    },
    {
      "type": "box",
      "at": [
        0,
        0,
        0
      ],
      "size": [
        4.6,
        4.2,
        0.5
      ],
      "color": "amber",
      "label": "服务层"
    },
    {
      "type": "box",
      "at": [
        0,
        0,
        1.2
      ],
      "size": [
        3.4,
        3,
        0.5
      ],
      "color": "purple",
      "label": "数据层"
    }
  ]
}`,
  },
  {
    // 与 isometric 共用同一套投影引擎（客户端半的 isoAdapter 按 kind 参数化），
    // 但形态、spec 词汇与适用场景都不同：分开列，才有各自的开关、语法行与示例预览。
    id: 'voxel',
    label: '体素模型',
    family: 'spatial',
    languages: ['voxel', 'voxel-interactive'],
    modes: [
      { id: 'static', languages: ['voxel'], capabilities: ['scale', 'reset', 'snapshot'] },
      { id: 'interactive', languages: ['voxel-interactive'], setting: 'interactive', capabilities: ['resize', 'reset', 'snapshot'] },
    ],
    output: 'svg',
    usage: '体素方块模型 —— 用方块表达体量、密度与"切掉一角看内部"（ASCII 图层直接摆方块，最省 token）',
    when: '体素模型、方块化体量、方块地形',
    syntaxHint:
      'JSON：{ "grid": 17, "palette": { "#": "amber", "o": "purple" }, "shapes": [{ "shape": "shell", "r": 7, "thickness": 1.6, "fill": "#" }] }；shapes 可用 shell/ball/box/cluster/collapse，或直接写 "layers": ["#####\\n#...#"]（每层一段，z 从下往上）；颜色用语义令牌或 #rrggbb',
    promptNote: '要转动或切掉一角时用 ```voxel-interactive，静态用 ```voxel；grid 上限 32，方块越密产物越大。',
    defaults: { interactive: true },
    limits: { bytes: 256 * 1024, faces: 6000, grid: 32 },
    fontPolicy: 'stack',
    assets: [],
    sample: `{
  "grid": 13,
  "cut": true,
  "height": 320,
  "title": "体素剖面 · 薄壳与核心",
  "desc": "蓝色只有薄薄一层壳，里面是琥珀色的结构层与绿色核心；切开一角就看得到。",
  "palette": {
    "#": "blue",
    "o": "amber",
    "@": "green"
  },
  "shapes": [
    {
      "shape": "ball",
      "r": 6,
      "fill": "#"
    },
    {
      "shape": "ball",
      "r": 5.1,
      "fill": "o"
    },
    {
      "shape": "cluster",
      "count": 8,
      "r": 2.6,
      "fill": "@",
      "seed": 7
    }
  ],
  "legend": [
    {
      "color": "blue",
      "text": "薄壳"
    },
    {
      "color": "amber",
      "text": "结构层"
    },
    {
      "color": "green",
      "text": "核心"
    }
  ]
}`,
  },
  {
    // 任务报告：对话里给摘要卡，「下载」得到一份自包含的 HTML 报告网页。
    // 形态取自 ChatGPT 每轮结束附的那份网页：先结论与口径，再变化、证据与未测范围。
    id: 'report',
    label: '任务报告',
    family: 'semantic',
    languages: ['report'],
    output: 'svg',
    usage: '一轮任务结束后附报告：结论、改动、验证与风险；sections[].flow 画一张内联 SVG 流程图；点「查看」跳到报告面板，或用「浏览器」打开独立网页；自动归档到项目',
    when: '任务交付报告、更新档案',
    syntaxHint:
      'JSON：{ "title": "…", "round": "第 N 轮 · 日期", "status": "done|partial|blocked|failed", "verdict": "一两句说清交付了什么", "badges": [{ "tone": "done|partial|blocked|failed|info|neutral", "text": "…" }], "facts": ["要点"], "meta": { "基线": "…" }, "notice": { "tone": "warn|ok|info", "text": "…" }, "sections": [{ "title": "改动流程", "flow": { "direction": "LR", "nodes": [{ "id": "a", "label": "输入", "sub": "可选副标题" }, { "id": "b", "label": "处理" }], "edges": [{ "from": "a", "to": "b", "label": "可选" }] } }, { "title": "改了什么", "table": { "head": ["文件", "改动"], "rows": [["lib/client.js", "…"]] } }, { "title": "验证与风险", "items": ["…"], "details": { "summary": "未测范围", "items": ["…"] } }], "sources": [{ "label": "改动", "text": "lib/client.js" }] }；查看 / 下载得到自包含网页',
    eager: true,
    defaults: {},
    limits: { bytes: 64 * 1024, points: 24 },
    fontPolicy: 'stack',
    assets: [],
    sample: `{
  "title": "同页自绘图共享调色板 · 修复交付",
  "round": "第 18 轮 · 2026-10-19 · 0.18.0",
  "status": "done",
  "verdict": "定位并修掉了「同页所有自绘图共享最后一张调色板」的根因：类名是文档级的，撞了互相覆盖。",
  "badges": [
    { "tone": "done", "text": "已完成" },
    { "tone": "info", "text": "仅本机验证" }
  ],
  "facts": [
    "根因：内联 SVG 的 style 是全局的，c0/c1 撞名后谁最后画谁说了算",
    "修法：svgDocument 给类名加内容哈希前缀，一处修好全部自绘渲染器",
    "回归：同页异色图必须拿到不同前缀，相同输入必须逐字节一致"
  ],
  "meta": {
    "基线": "0.17.0 三层底色透明",
    "验证": "243 单测 / 10-10 渲染器 / 21 组 Chromium"
  },
  "notice": { "tone": "warn", "text": "未测：真实长对话里 20 张以上图同时换主题的耗时。" },
  "sections": [
    {
      "title": "改动流程",
      "flow": {
        "direction": "LR",
        "nodes": [
          { "id": "fence", "label": "报告栅栏", "sub": "JSON spec" },
          { "id": "spec", "label": "校验与默认值", "sub": "reportSpecOf" },
          { "id": "svg", "label": "内联流程图", "sub": "reportFlowSvg" },
          { "id": "page", "label": "自包含网页", "sub": "查看 / 浏览器" }
        ],
        "edges": [
          { "from": "fence", "to": "spec", "label": "解析" },
          { "from": "spec", "to": "svg", "label": "flow" },
          { "from": "svg", "to": "page", "label": "归档" }
        ]
      }
    },
    { "title": "用户能感知到的变化", "items": ["两张不同颜色的等距图不再互相污染", "换风格后颜色跟随当前风格"] },
    {
      "title": "改了什么",
      "table": {
        "head": ["文件", "改动"],
        "rows": [
          ["lib/client.js", "svgDocument 给类名加内容哈希前缀"],
          ["test/report.test.mjs", "新增同页异色与确定性断言"]
        ]
      }
    },
    {
      "title": "验证与未测",
      "items": ["npm test：243/243 通过", "真实浏览器：三张图三种颜色"],
      "details": { "summary": "明确未验证的范围", "items": ["长对话 20 张以上图同时换主题的耗时"] }
    }
  ],
  "sources": [{ "label": "改动", "text": "lib/client.js · svgDocument" }]
}`,
  },
  {
    // 不是图表，是读数：一排大数字 + 阈值色 + 可选迷你趋势线。
    // markdown 表格顶替不了（放不进阈值色、画不出趋势），所以这是真正缺的一块。
    id: 'metrics',
    label: '指标卡',
    family: 'chart',
    languages: ['metrics'],
    output: 'svg',
    usage: '一排读数（指标、容量、健康度），带阈值色与迷你趋势 —— 表格顶替不了时用它',
    when: '一排读数、健康度、阈值状态',
    syntaxHint:
      'JSON：{ "items": [{ "label": "待机电流", "value": "12.4", "unit": "mA", "tone": "ok", "delta": "比上次 +0.8" }], "spark": [11.9, 12.1, 12.0] }；tone 用 ok / warn / bad / idle（缺省 idle）；spark 是数字数组，至少两个才画趋势',
    promptNote: '\u0060\u0060\u0060metrics 放"一排读数"；阈值用 tone，趋势交给 echarts。',
    defaults: {},
    limits: { bytes: 64 * 1024, points: 12 },
    fontPolicy: 'stack',
    assets: [],
    sample: `{
  "title": "RK3576 待机功耗",
  "desc": "一排读数：待机电流、SoC 温度、RSSI 与守护进程状态。",
  "items": [
    { "label": "待机电流", "value": "12.4", "unit": "mA", "tone": "ok", "delta": "比上次 +0.8" },
    { "label": "SoC 温度", "value": "48.2", "unit": "°C", "tone": "warn", "delta": "阈值 55" },
    { "label": "8821CU RSSI", "value": "-58", "unit": "dBm", "tone": "ok" },
    { "label": "守护进程", "value": "3/3", "tone": "ok", "delta": "全部在线" }
  ],
  "spark": [11.9, 12.1, 12.0, 12.3, 12.2, 12.4]
}`,
  },
  {
    // 一条用例一行，状态上色，卡底自动汇总。与指标卡同类：markdown 顶替不了。
    id: 'matrix',
    label: '用例矩阵',
    family: 'chart',
    languages: ['matrix'],
    output: 'svg',
    usage: '跑了一堆用例的结果（自测、联调、验收清单），状态与汇总自动生成',
    when: '一组成败结果、自测清单',
    syntaxHint:
      'JSON：{ "cases": [{ "name": "serial-cmd.py 查 uname", "status": "pass", "ms": 820, "note": "115200 8N1" }] }；status 用 pass / fail / warn / skip / running（缺省 skip）；ms 可为 null（显示 —）；卡底汇总由渲染器算，不用你写',
    promptNote: '\u0060\u0060\u0060matrix 放一组成败结果，汇总行自动生成，别自己算。',
    defaults: {},
    limits: { bytes: 64 * 1024, points: 16 },
    fontPolicy: 'stack',
    assets: [],
    sample: `{
  "title": "连板前自测",
  "desc": "六条用例的结果与耗时，卡底自动汇总。",
  "cases": [
    { "name": "serial-cmd.py 查 uname", "status": "pass", "ms": 820, "note": "115200 8N1" },
    { "name": "i2cdetect 查 bq28z620", "status": "fail", "ms": 3010, "note": "地址 0x0b 无应答" },
    { "name": "iperf3 打流", "status": "warn", "ms": 10050, "note": "丢包 0.6%" },
    { "name": "tio 抓 U-Boot 日志", "status": "skip", "ms": null, "note": "未插板" },
    { "name": "烧录校验", "status": "pass", "ms": 4200 },
    { "name": "RTC 走时", "status": "running" }
  ]
}`,
  },
  {
    id: 'svg',
    label: 'SVG 图示（手写）',
    family: 'semantic',
    languages: ['svg'],
    output: 'svg',
    usage: '概念对照、时间线、成长路线、架构分工、一次性的空间或剖面插图 —— 模型按设计系统手写 SVG，布局与语义配色完全自由，最出彩（参照应用的真正用法）',
    when: '语义对照、时间线、路线图、概念架构、一次性插图',
    syntaxHint:
      '直接写 <svg viewBox="0 0 680 XXX" width="100%" role="img">…</svg>；必须带 <title> 与 <desc>；整图构图、排版、配色与标注遵循当前视觉风格，参考页示例不覆盖该选择',
    promptNote:
      '选择手写 \u0060\u0060\u0060svg 时，viewBox 用 680 宽、高不超过 400；检查 SVG 结构、文字溢出与留白，并遵循设计令牌。',
    // 手写 SVG 的真实成本与示例差一个量级：示例是"最小可用"，真实插图约 1.3 万字符
    // （实测：一份真实的电气连接框架图 13,156 字符）。设置页要显示的是后者，
    // 否则会把最贵的一种画法显示成最便宜的。
    costHint: { figureChars: 13000, basis: '典型插图（实测约 1.3 万字符）' },
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
