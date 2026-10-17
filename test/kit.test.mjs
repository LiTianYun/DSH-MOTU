/**
 * 自绘渲染器工具箱与等距基座。
 *
 * 这两层是"以后加很多风格"的扩展位：新风格只提供几何，主题、转义、拼装、
 * 限额、投影、排序、剖面、体素表面提取都由这里负责。所以它们自己必须先被钉死。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'

function loadClient(t) {
  const dom = setupDom({ scripts: true })
  let client
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      client = factory(() => { throw new Error('no react needed') })
    },
  }
  dom.window.eval(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  t.after(() => dom.window.close())
  return { dom, client, kit: client.internals }
}

/** 严格 XML 解析，返回问题描述（空串表示合法）。 */
function xmlProblem(dom, markup) {
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  const error = parsed.querySelector('parsererror')
  if (error !== null) return String(error.textContent).replace(/\s+/g, ' ').trim().slice(0, 160)
  if (parsed.documentElement?.nodeName?.toLowerCase() === 'parsererror') return '根元素是 parsererror'
  return ''
}

it('转义：模型写的文本不能破坏 XML', (t) => {
  const { kit } = loadClient(t)
  assert.equal(kit.escapeXml('a & b'), 'a &amp; b')
  assert.equal(kit.escapeXml('<script>'), '&lt;script&gt;')
  assert.equal(kit.escapeXml('say "hi"'), 'say &quot;hi&quot;')
  assert.equal(kit.escapeXml(undefined), '')
})

it('颜色令牌：语义名解析为主题色，字面量原样通过，未知名字报错并列出可用项', (t) => {
  const { kit } = loadClient(t)
  const tokens = kit.themeTokens()
  assert.match(kit.tokenColor('amber', tokens), /^#[0-9a-f]{6}$/i)
  assert.equal(kit.tokenColor('#123456', tokens), '#123456')
  assert.equal(kit.tokenColor('ink', tokens), tokens.ink)
  assert.throws(() => kit.tokenColor('chartreuse', tokens), /未知颜色：chartreuse/)
  assert.throws(() => kit.tokenColor('', tokens), /颜色不能为空/)
})

it('明暗：加深变暗、提亮变亮，且对 rgb() 形式同样有效', (t) => {
  const { kit } = loadClient(t)
  assert.equal(kit.shadeColor('#808080', 0), 'rgb(128,128,128)')
  assert.equal(kit.shadeColor('#808080', -0.5), 'rgb(64,64,64)')
  assert.equal(kit.shadeColor('#808080', 0.5), 'rgb(192,192,192)')
  assert.equal(kit.shadeColor('rgb(100,100,100)', 0), 'rgb(100,100,100)')
  assert.equal(kit.shadeColor('#FFFFFF', 1), 'rgb(255,255,255)', '不得超过 255')
  assert.equal(kit.shadeColor('#000000', -1), 'rgb(0,0,0)', '不得低于 0')
})

it('限额：超限时给出可操作的建议', (t) => {
  const { kit } = loadClient(t)
  kit.enforceLimits(undefined, { faces: 10 })
  assert.throws(() => kit.enforceLimits({ faces: 5 }, { faces: 6 }), /faces ≤ 5.*当前 6.*减少细分/s)
  assert.throws(() => kit.enforceLimits({ grid: 8 }, { grid: 9 }), /grid ≤ 8.*调小 grid/s)
  assert.throws(() => kit.enforceLimits(undefined, { bytes: 999999 }), /bytes ≤ 65536/s)
})

it('画布骨架：带 title/desc、样式块、且产物是合法 XML', (t) => {
  const { dom, kit } = loadClient(t)
  const svg = kit.svgDocument({
    width: 200, height: 100, title: '标题 <&>', desc: '说明',
    body: kit.svgPath([[0, 0], [10, 0], [10, 10]], 'c0'),
    classes: [['c0', 'fill:#fff;stroke:#000']],
    fontFamily: '-apple-system, "Segoe UI", sans-serif',
  })
  assert.match(svg, /<title>标题 &lt;&amp;&gt;<\/title>/)
  assert.match(svg, /<desc>说明<\/desc>/)
  assert.match(svg, /\.c0\{fill:#fff;stroke:#000\}/)
  assert.match(svg, /font-family="-apple-system, &apos;Segoe UI&apos;, sans-serif"/, '字体栈必须转成属性安全形式')
  assert.equal(xmlProblem(dom, svg), '', '骨架产物必须是合法 XML')
})

it('画布骨架：body 超过限额时拒绝', (t) => {
  const { kit } = loadClient(t)
  assert.throws(
    () => kit.svgDocument({ width: 10, height: 10, title: 't', desc: 'd', body: 'x'.repeat(70000), limits: { bytes: 1024 } }),
    /bytes ≤ 1024/,
  )
})

it('等距投影：2:1 等距，且 x/y 对称', (t) => {
  const { kit } = loadClient(t)
  const view = { scale: 10, ox: 100, oy: 100 }
  // 投影结果来自 jsdom realm，逐个取值比较（跨 realm 的原型不同）
  const at = (point) => Array.from(kit.isoProject(point, view))
  assert.deepEqual(at([0, 0, 0]), [100, 100])
  // x 正方向：向右下；y 正方向：向左下 —— 2:1 等距的基本形状
  assert.deepEqual(at([1, 0, 0]), [110, 105])
  assert.deepEqual(at([0, 1, 0]), [90, 105])
  // z 向上：只改 y，且是一个整单位
  assert.deepEqual(at([0, 0, 1]), [100, 90])
})

it('画家算法：远的先画，剖切按模型自身坐标', (t) => {
  const { kit } = loadClient(t)
  const near = { v: [[0, 0, 2], [1, 0, 2], [1, 1, 2], [0, 1, 2]], color: '#fff' }
  const far = { v: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], color: '#fff' }
  const ordered = kit.isoOrderFaces([near, far], null)
  assert.equal(ordered[0], far, 'z 小的先画')
  assert.equal(ordered[1], near)

  const a = { v: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], color: '#fff' }   // x+y 均值 1
  const b = { v: [[5, 5, 0], [6, 5, 0], [6, 6, 0], [5, 6, 0]], color: '#fff' }   // x+y 均值 11
  assert.equal(kit.isoOrderFaces([a, b], 6).length, 1, '超过切平面的面应被移除')
  assert.equal(kit.isoOrderFaces([a, b], null).length, 2, '不剖切时两个面都保留')
})

it('体素表面提取：内部体素不产生任何面，只画朝向观察者的三面', (t) => {
  const { kit } = loadClient(t)
  const size = 3
  const grid = new Uint8Array(size ** 3).fill(1)          // 实心 3³
  const center = (size - 1) / 2
  const colors = { 1: '#888888' }
  const solid = kit.isoVoxelFaces(grid, { size, center, colors })
  // 实心立方体只有 6 个面可见（每面 9 格 → 但只画 +x/+y/+z 三向），内部 1 格完全跳过
  assert.ok(solid.length > 0)
  assert.equal(solid.length, 27, '每个边界体素贡献一个朝向观察者的面')

  // 挖空中心后，围绕空腔的体素会补出新的面
  grid[(1 * size + 1) * size + 1] = 0
  const hollow = kit.isoVoxelFaces(grid, { size, center, colors })
  assert.ok(hollow.length > solid.length, '挖空后应多出朝向空腔的面')

  assert.equal(kit.isoVoxelFaces(new Uint8Array(size ** 3), { size, center, colors }).length, 0, '空网格不产生面')
})

it('体素明暗：顶面最亮、右面次之、左面最暗，且逐格抖动是确定性的', (t) => {
  const { kit } = loadClient(t)
  const size = 2
  const grid = new Uint8Array(size ** 3).fill(1)
  const colors = { 1: '#808080' }
  const options = { size, center: 0.5, colors }
  const faces = kit.isoVoxelFaces(grid, options)
  const shades = new Set(faces.map((face) => Math.round(face.shade * 100) / 100))
  assert.ok(shades.size >= 2, '三个朝向应有不同的明度')
  const again = kit.isoVoxelFaces(grid, options)
  assert.deepEqual(again.map((f) => f.shade), faces.map((f) => f.shade), '同一输入必须给出同一明度（禁止随机）')
})

it('绘制：颜色合并为 class，产物是合法 XML', (t) => {
  const { dom, kit } = loadClient(t)
  const faces = [
    { v: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], color: '#808080', flat: true, shade: 0 },
    { v: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], color: '#808080', flat: true, shade: 0 },
  ]
  const { body, classes } = kit.isoDraw(faces, { scale: 20, ox: 50, oy: 50 })
  assert.equal(classes.length, 1, '同色同明度应合并成一个 class')
  const svg = kit.svgDocument({ width: 100, height: 100, title: 't', desc: 'd', body, classes })
  assert.equal(xmlProblem(dom, svg), '')
  assert.ok(svg.length < 1000, '两张面的产物应很小')
})

it('等距风格注册表：可注册、可读取', (t) => {
  const { kit } = loadClient(t)
  const before = kit.ISO_KINDS.size
  kit.registerIsoKind('测试风格', () => ({ faces: [] }))
  assert.equal(kit.ISO_KINDS.size, before + 1)
  assert.equal(typeof kit.ISO_KINDS.get('测试风格'), 'function')
})
