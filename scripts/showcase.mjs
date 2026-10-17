/**
 * 为 README 生成"每种渲染器效果"展示图。
 *
 *   node scripts/showcase.mjs
 *
 * 为什么在**真实 Chromium** 里渲染，而不是像 preview.mjs 那样用 jsdom：
 * 引擎要靠 DOM 的真实几何来排版。jsdom 没有 `getBBox()`，mermaid 的流程图会算出
 * 错误的高度（实测 viewBox 高度只有 40，图被裁成一条）。这种"产物存在但几何是错的"
 * 图不能进 README。这里把源码交给真实客户端半渲染，再取回成品 SVG —— 与对话里出图
 * 完全同一条路径。
 *
 * 产物写入 preview/showcase/，并生成 index.json 供 README 生成器使用。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { startUiFixture } from './ui-fixture.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'preview', 'showcase')

/** 展示样例：语言、渲染器、说明、源码。 */
const examples = [
  {
    id: 'mermaid-flowchart',
    renderer: 'mermaid',
    title: '流程图 · 带子图的分层调用',
    language: 'mermaid',
    source: `flowchart TD
  A[客户端] --> B[API 网关]
  subgraph 服务层
    B --> C[订单服务]
    B --> D[用户服务]
    C --> E[(订单库)]
    D --> F[(用户库)]
  end
  C -.->|下单事件| G[[消息队列]]
  G -.-> D
  C --> H{库存充足?}
  H -->|是| I[创建订单]
  H -->|否| J[返回缺货]`,
  },
  {
    id: 'mermaid-sequence',
    renderer: 'mermaid',
    title: '时序图 · 一次支付交互',
    language: 'mermaid',
    source: `sequenceDiagram
  autonumber
  participant U as 用户
  participant A as 应用
  participant P as 支付网关
  U->>A: 提交订单
  A->>P: 创建支付单
  P-->>A: 返回收银台链接
  A-->>U: 跳转收银台
  U->>P: 完成付款
  P->>A: 异步回调（已签名）
  A->>A: 校验签名与幂等
  A-->>U: 订单已支付`,
  },
  {
    id: 'graphviz-deps',
    renderer: 'graphviz',
    title: '依赖图 · 自动布局大量节点',
    language: 'dot',
    source: `digraph deps {
  rankdir=LR;
  node [shape=box];
  subgraph cluster_app {
    label="应用";
    Web; Api; Worker;
  }
  subgraph cluster_store {
    label="存储";
    PG [label="PostgreSQL"];
    Redis [label="Redis"];
    S3 [label="对象存储"];
  }
  Web -> Api;
  Api -> PG;
  Api -> Redis;
  Worker -> PG;
  Worker -> S3;
  Api -> Worker [label="入队"];
}`,
  },
  {
    id: 'nomnoml-states',
    renderer: 'nomnoml',
    title: '状态机 · 小而清楚的框线图',
    language: 'nomnoml',
    source: `#direction: right
#padding: 12
[<frame>订单状态|
  [待支付] 支付成功 -> [已支付]
  [待支付] 超时 -> [已取消]
  [已支付] 发货 -> [已发货]
  [已发货] 签收 -> [已完成]
  [已支付] 退款 -> [已退款]
]`,
  },
  {
    id: 'echarts-combo',
    renderer: 'echarts',
    title: '组合图 · 柱状 + 折线双轴',
    language: 'echarts',
    source: `{
  "title": { "text": "月度订单与转化率" },
  "tooltip": { "trigger": "axis" },
  "legend": { "data": ["订单量", "转化率"] },
  "xAxis": { "type": "category", "data": ["1月", "2月", "3月", "4月", "5月", "6月"] },
  "yAxis": [
    { "type": "value", "name": "单" },
    { "type": "value", "name": "转化率", "axisLabel": { "formatter": "{value}%" } }
  ],
  "series": [
    { "name": "订单量", "type": "bar", "data": [820, 932, 901, 1290, 1330, 1520] },
    { "name": "转化率", "type": "line", "yAxisIndex": 1, "smooth": true, "data": [12, 15, 14, 19, 21, 24] }
  ]
}`,
  },
  {
    id: 'echarts-donut',
    renderer: 'echarts',
    title: '环形图 · 占比',
    language: 'echarts',
    source: `{
  "title": { "text": "流量来源", "left": "center", "top": 8 },
  "legend": { "bottom": 8, "left": "center" },
  "series": [
    {
      "type": "pie",
      "percentPrecision": 1,
      "radius": ["46%", "72%"],
      "center": ["50%", "52%"],
      "label": { "position": "inside", "formatter": "{d}%", "color": "#FFFFFF", "fontSize": 13 },
      "labelLine": { "show": false },
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
    id: 'vega-lite-layered',
    renderer: 'vega-lite',
    title: '分层统计图 · 柱 + 趋势线',
    language: 'vega-lite',
    source: `{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "title": "每周构建耗时",
  "width": 420,
  "height": 200,
  "data": {
    "values": [
      { "week": "W1", "minutes": 12 }, { "week": "W2", "minutes": 15 },
      { "week": "W3", "minutes": 11 }, { "week": "W4", "minutes": 18 },
      { "week": "W5", "minutes": 14 }, { "week": "W6", "minutes": 9 },
      { "week": "W7", "minutes": 8 }, { "week": "W8", "minutes": 7 }
    ]
  },
  "layer": [
    { "mark": { "type": "bar", "color": "#B5D4F4" },
      "encoding": {
        "x": { "field": "week", "type": "nominal", "axis": { "title": null, "labelAngle": 0 } },
        "y": { "field": "minutes", "type": "quantitative", "axis": { "title": "分钟" } }
      } },
    { "mark": { "type": "line", "color": "#185FA5", "strokeWidth": 2, "point": true },
      "encoding": {
        "x": { "field": "week", "type": "nominal" },
        "y": { "field": "minutes", "type": "quantitative" }
      } }
  ]
}`,
  },
  {
    id: 'isometric-solid',
    renderer: 'isometric',
    title: '等距剖面 · 中空星球展示柜',
    language: 'isometric',
    source: `{
  "kind": "solid",
  "title": "碎空星 · 等距剖面",
  "desc": "展示柜里的中空行星：碎裂岩壳、黑洞、悬空城与白洞站方向，切开前四分之一看内部。",
  "case": 2.3,
  "cut": 0.72,
  "objects": [
    { "type": "shell", "r": 1.34, "thickness": 0.17, "color": "amber", "segments": 30, "rings": 16, "label": "碎裂岩壳" },
    { "type": "ball", "r": 0.44, "color": "ink", "segments": 18, "rings": 9, "label": "黑洞" },
    { "type": "ring", "at": [0, 0, 0.12], "r": 0.88, "count": 7, "size": [0.24, 0.24, 0.18], "color": "purple", "label": "悬空城" },
    { "type": "box", "at": [-2.0, -1.4, 0.8], "size": [0.34, 0.34, 0.12], "color": "blue", "label": "白洞站方向" }
  ],
  "callouts": [
    { "at": [0.95, 0.95, 0.55], "text": "碎裂岩壳" },
    { "at": [0, 0, 0], "text": "黑洞" },
    { "at": [0.62, -0.62, 0.12], "text": "悬空城" },
    { "at": [-2.0, -1.4, 0.8], "text": "白洞站方向", "side": "left" }
  ]
}`,
  },
  {
    id: 'isometric-voxel',
    renderer: 'isometric',
    title: '体素剖面 · 方块化的空间关系',
    language: 'isometric',
    source: `{
  "kind": "voxel",
  "grid": 18,
  "cut": true,
  "title": "碎空星 · 体素剖面",
  "desc": "把中空行星拆成方块：球壳、随机塌陷缺口、中心黑洞与内侧悬空城。",
  "palette": { "#": "amber", "o": "purple", "@": "ink" },
  "shapes": [
    { "shape": "shell", "r": 7.4, "thickness": 1.7, "fill": "#" },
    { "shape": "collapse", "count": 14, "radius": [1.6, 3.6], "seed": 11 },
    { "shape": "cluster", "count": 22, "r": 5.4, "fill": "o", "seed": 3 },
    { "shape": "ball", "r": 1.7, "fill": "@" }
  ],
  "legend": [
    { "color": "amber", "text": "碎裂岩壳" },
    { "color": "purple", "text": "悬空城" },
    { "color": "ink", "text": "黑洞" }
  ]
}`,
  },
  {
    id: 'svg-comparison',
    renderer: 'svg',
    title: '手写 SVG · 概念对照',
    language: 'svg',
    source: `<svg viewBox="0 0 680 250" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" font-family="system-ui, 'Microsoft YaHei', sans-serif">
<title>单体与拆分的对照</title>
<desc>左侧单体应用改动牵一发动全身，右侧按边界拆分后各自独立发布。</desc>
<defs>
<marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round"/>
</marker>
</defs>
<rect x="40" y="36" width="280" height="180" rx="12" fill="#FCEBEB" stroke="#A32D2D" stroke-width="0.5"/>
<text x="60" y="64" font-size="11" font-weight="500" fill="#A32D2D">现状</text>
<text x="60" y="92" font-size="14" font-weight="500" fill="#791F1F">单体应用</text>
<rect x="60" y="108" width="240" height="36" rx="8" fill="#FFFFFF" stroke="#F09595" stroke-width="0.5"/>
<text x="180" y="130" font-size="12" fill="#501313" text-anchor="middle">改一处要整体回归</text>
<rect x="60" y="154" width="240" height="36" rx="8" fill="#FFFFFF" stroke="#F09595" stroke-width="0.5"/>
<text x="180" y="176" font-size="12" fill="#501313" text-anchor="middle">发布窗口互相排队</text>
<path d="M330 126 H370" fill="none" stroke="#888780" stroke-width="1.5" marker-end="url(#a)"/>
<rect x="380" y="36" width="260" height="180" rx="12" fill="#E1F5EE" stroke="#0F6E56" stroke-width="0.5"/>
<text x="400" y="64" font-size="11" font-weight="500" fill="#0F6E56">建议</text>
<text x="400" y="92" font-size="14" font-weight="500" fill="#085041">按边界拆分</text>
<rect x="400" y="108" width="220" height="36" rx="8" fill="#FFFFFF" stroke="#0F6E56" stroke-width="0.5"/>
<text x="510" y="130" font-size="12" fill="#085041" text-anchor="middle">各服务独立发布</text>
<rect x="400" y="154" width="220" height="36" rx="8" fill="#FFFFFF" stroke="#0F6E56" stroke-width="0.5"/>
<text x="510" y="176" font-size="12" fill="#085041" text-anchor="middle">故障不外溢</text>
<text x="42" y="236" font-size="11" style="fill:var(--color-text-tertiary,#888780)">手写 SVG 无需专用图表语法，但结构、溢出与留白仍要自己检查</text>
</svg>`,
  },
]

mkdirSync(outDir, { recursive: true })
const fixture = await startUiFixture()
let browser
try {
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(fixture.url)

  // 把样例塞进页面，让真实客户端半按正常管线渲染。
  await page.evaluate((items) => {
    for (const item of items) window.addBlock(item.id, item.language, item.source)
  }, examples.map(({ id, language, source }) => ({ id, language, source })))

  await page.waitForFunction(
    (ids) => ids.every((id) => document.querySelector(`#${id} .vk-figure`)?.dataset.vkDisplayState === 'ready'),
    examples.map((item) => item.id),
    { timeout: 60_000 },
  )

  // 取回成品：去掉画布给的缩放样式，按 viewBox 定尺寸（与「下载」同一处理）。
  const rendered = await page.evaluate((ids) => {
    const out = {}
    for (const id of ids) {
      const svg = document.querySelector(`#${id} .vk-figure .vk-canvas svg`)
      if (!svg) { out[id] = null; continue }
      const clone = svg.cloneNode(true)
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const parts = String(clone.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
      if (parts.length === 4 && parts.every(Number.isFinite) && parts[2] > 0 && parts[3] > 0) {
        clone.setAttribute('width', String(Math.round(parts[2])))
        clone.setAttribute('height', String(Math.round(parts[3])))
      }
      clone.style.removeProperty('width')
      clone.style.removeProperty('height')
      clone.style.removeProperty('max-width')
      out[id] = { markup: clone.outerHTML, viewBox: clone.getAttribute('viewBox') }
    }
    return out
  }, examples.map((item) => item.id))

  const manifest = []
  const broken = []
  for (const example of examples) {
    const result = rendered[example.id]
    if (result === null || result === undefined) {
      broken.push(`${example.id}：页面里没有产出图形`)
      continue
    }
    const parts = String(result.viewBox ?? '').split(/[\s,]+/).map(Number)
    const width = Math.round(parts[2])
    const height = Math.round(parts[3])
    const size = `${width}×${height}`
    // 几何守卫：产物存在不等于画对了。jsdom 里 mermaid 流程图曾算出 732×40 的
    // viewBox（没有 getBBox），图被裁成一条 —— 这种图绝不能进 README。
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 120 || height < 80) {
      broken.push(`${example.id}：几何异常 ${size}`)
      continue
    }
    writeFileSync(join(outDir, `${example.id}.svg`), result.markup, 'utf8')
    manifest.push({ id: example.id, renderer: example.renderer, title: example.title, size })
    console.log(`${example.id.padEnd(22)} ${example.renderer.padEnd(10)} ${size.padStart(9)}  ${(result.markup.length / 1024).toFixed(1)} KB`)
  }
  if (errors.length > 0) console.log(`\n页面报错：${errors.join('; ')}`)
  if (broken.length > 0) {
    console.error(`\n${broken.length} 张几何异常，未写入：\n  ${broken.join('\n  ')}`)
    process.exitCode = 1
  }
  writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`\npreview/showcase/ 共 ${manifest.length} 张`)
} finally {
  await browser?.close()
  await fixture.close()
}
