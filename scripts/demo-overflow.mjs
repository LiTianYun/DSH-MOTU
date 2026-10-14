/**
 * Before/after demonstration of the Graphviz text-overflow fix.
 *
 * Renders the architecture diagram from the conversation demo twice: with
 * measuring off (what used to ship — boxes sized from Graphviz's ~half-width
 * CJK estimate) and on (the margin grows until every label fits). The headless
 * environment normally cannot measure, so this script installs a getBBox that
 * computes real geometry — path bounds parsed from `d`, text measured with
 * CJK-true glyph widths — which is exactly what a browser reports.
 *
 *   node scripts/demo-overflow.mjs
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadVendorScript, setupDom } from './dom-env.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const dom = setupDom({ scripts: true })
const { window } = dom
const { document } = window

loadVendorScript(dom, join(root, 'vendor', 'graphviz', 'viz-global.js'))

// ---------------------------------------------------------------------------
// Real-geometry getBBox: path/polygon bounds from their own coordinates, text
// measured the way Microsoft YaHei actually renders (Han ≈ 1em, Latin ≈ .55em).
// ---------------------------------------------------------------------------

const measureText = (value, fontSize) => {
  const text = String(value ?? '')
  const cjk = (text.match(/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/g) ?? []).length
  return cjk * fontSize + (text.length - cjk) * fontSize * 0.55
}

function geometryBBox(el) {
  const tag = el.tagName.toLowerCase()
  if (tag === 'ellipse') {
    return { x: 0, y: 0, width: 2 * Number(el.getAttribute('rx') ?? 0), height: 2 * Number(el.getAttribute('ry') ?? 0) }
  }
  if (tag === 'rect') {
    return { x: Number(el.getAttribute('x') ?? 0), y: Number(el.getAttribute('y') ?? 0), width: Number(el.getAttribute('width') ?? 0), height: Number(el.getAttribute('height') ?? 0) }
  }
  const attr = tag === 'path' ? 'd' : 'points'
  const numbers = (el.getAttribute(attr) ?? '').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const xs = numbers.filter((_, index) => index % 2 === 0)
  const ys = numbers.filter((_, index) => index % 2 === 1)
  if (xs.length === 0 || ys.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
}

window.SVGElement.prototype.getBBox = function getBBox() {
  const tag = this.tagName.toLowerCase()
  if (tag === 'text') {
    const fontSize = Number(this.getAttribute('font-size')) || 13
    const tspans = [...this.querySelectorAll('tspan')]
    const lines = tspans.length > 0 ? tspans.map((t) => t.textContent) : [this.textContent]
    return {
      x: 0,
      y: 0,
      width: Math.max(...lines.map((line) => measureText(line, fontSize))),
      height: lines.length * fontSize * 1.3,
    }
  }
  return geometryBBox(this)
}

// ---------------------------------------------------------------------------
// The client half, loaded through its module contract.
// ---------------------------------------------------------------------------

const registry = new Map()
window.__ModuleLoader__ = {
  load({ id, factory }) {
    registry.set(id, factory(() => {
      throw new Error('this half requires nothing')
    }))
  },
}
window.eval(readFileSync(join(root, 'lib', 'client.js'), 'utf8'))
const { ADAPTERS } = registry.get('dsh-visual-kit').internals

const demo = `digraph kit {
  rankdir=LR;
  node [shape=box, style="rounded,filled", fillcolor="#eef4ff", color="#5b7cc4"];
  manifest [label="manifest.js\\n单一事实来源", fillcolor="#fff4e5", color="#e0a458"];
  host [label="宿主半\\n路由/配置/完整性"];
  client [label="客户端半\\n管线/适配器"];
  config [label="插件配置界面"];
  prompt [label="提示段+技能"];
  manifest -> host;
  manifest -> client;
  manifest -> config;
  host -> prompt;
  client -> host [label="诊断信标", style=dashed];
}`

mkdirSync(join(root, 'preview'), { recursive: true })

const envFor = (measure) => ({
  loadEngine: async () => ({ Viz: window.Viz }),
  container: () => document.createElement('div'),
  clearContainer: () => {},
  theme: 'light',
  presentation: { fontFamily: 'Microsoft YaHei', fontSize: 13, canvasMaxHeight: 360, canvasPadding: 16, background: 'auto', showToolbar: true },
  settings: {},
  measure,
  nextId: () => 'demo',
})

// ---------------------------------------------------------------------------
// "Before" is reproduced with the previous pipeline's fixed margin (0.10,0.06)
// — the exact code path that produced the overflow in the GUI. "After" is the
// current adapter (roomier starting margin + measured re-render loop).
// ---------------------------------------------------------------------------

const beforeDefaults = demo.replace(
  /(\{)/,
  `$1
  graph [fontname="Microsoft YaHei", fontsize=13, bgcolor="transparent", pad="0.3", nodesep="0.45", ranksep="0.55"];
  node [fontname="Microsoft YaHei", fontsize=13, shape=box, style="rounded,filled", fillcolor="#F8FAFC", color="#CBD5E1", fontcolor="#334155", margin="0.10,0.06", penwidth=1];
  edge [fontname="Microsoft YaHei", fontsize=12, color="#94A3B8", fontcolor="#64748B", arrowsize=0.7, penwidth=1];`,
)

const viz = await window.Viz.instance()
const beforeSvg = viz.renderString(beforeDefaults, { format: 'svg' })
const after = await ADAPTERS.graphviz.render(demo, envFor(true))
writeFileSync(join(root, 'preview', 'demo-arch-before.svg'), beforeSvg, 'utf8')
writeFileSync(join(root, 'preview', 'demo-arch-after.svg'), after.markup, 'utf8')

// 量化对比：逐节点文字宽 vs 盒宽（pt → px 按 96/72）
const host = document.createElement('div')
document.body.appendChild(host)
for (const [label, svg] of [['修复前', beforeSvg], ['修复后', after.markup]]) {
  host.innerHTML = svg
  let worst = -Infinity
  let worstLabel = ''
  for (const g of host.querySelectorAll('g.node')) {
    const text = g.querySelector('text')
    const shape = g.querySelector('path, polygon, ellipse')
    if (!text || !shape) continue
    const overflowPx = (text.getBBox().width - shape.getBBox().width) * (96 / 72)
    if (overflowPx > worst) {
      worst = overflowPx
      worstLabel = text.textContent.replace(/\s+/g, ' ').trim().slice(0, 18)
    }
  }
  console.log(`${label}: 最大文字溢出 ${worst <= 0 ? 0 : worst.toFixed(1)}px (${worstLabel})`)
}
console.log('\nwrote preview/demo-arch-before.svg / demo-arch-after.svg')
