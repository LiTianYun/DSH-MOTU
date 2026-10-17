/**
 * 等距展示与体素模型两个渲染器。
 *
 * 它们共用一套投影引擎（客户端半的 isoAdapter 按 kind 参数化），但形态、spec
 * 词汇与适用场景不同，所以是两个条目。这里同时钉三件事：
 *   1. 两种形态各自的契约（取景、剖面、确定性、错误文案、限额）；
 *   2. **共用一个引擎**这件事本身：两条栅栏走同一条管线，交叉使用要被点名；
 *   3. 扩展位够用 —— 产物合法 XML、取景不越界、限额可操作。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const solidSpec = renderers.find((item) => item.id === 'isometric')
const voxelSpec = renderers.find((item) => item.id === 'voxel')

function loadClient(t, theme = 'light') {
  const dom = setupDom({ scripts: true })
  dom.window.document.documentElement.dataset.theme = theme
  let client
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      client = factory(() => { throw new Error('no react needed') })
    },
  }
  dom.window.eval(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  t.after(() => dom.window.close())
  return { dom, client }
}

function env(client, overrides = {}) {
  return {
    loadEngine: async () => ({}),
    container: () => client.__dom.window.document.createElement('div'),
    clearContainer: () => {},
    theme: 'light',
    presentation: { fontFamily: 'system-ui, "Segoe UI", sans-serif', fontSize: 13 },
    settings: {},
    behaviour: {},
    limits: solidSpec.limits,
    nextId: () => 'iso-test',
    ...overrides,
  }
}

/** 严格 XML 解析，返回问题描述（空串表示合法）。 */
function xmlProblem(dom, markup) {
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  const error = parsed.querySelector('parsererror')
  if (error !== null) return String(error.textContent).replace(/\s+/g, ' ').trim().slice(0, 160)
  if (parsed.documentElement?.nodeName?.toLowerCase() === 'parsererror') return '根元素是 parsererror'
  return ''
}

/** 产物里所有路径点的屏幕包围盒（用于判断取景是否越界）。 */
function bbox(dom, markup) {
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  const viewBox = parsed.documentElement.getAttribute('viewBox').split(/\s+/).map(Number)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const path of parsed.querySelectorAll('path')) {
    const d = path.getAttribute('d') ?? ''
    for (const match of d.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)) {
      const x = Number(match[1]); const y = Number(match[2])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
  }
  return { viewBox, minX, minY, maxX, maxY }
}

const countPaths = (markup) => (markup.match(/<path /g) ?? []).length

// kind 由栅栏决定，spec 里不必再写；两种形态都按这个约定写测试
const SOLID = JSON.stringify({
  title: '测试场景',
  desc: '说明',
  case: 2.2,
  cut: 0.7,
  objects: [
    { type: 'box', at: [0, 0, -1], size: [2, 2, 0.3], color: 'ink', label: '底座' },
    { type: 'ball', r: 0.5, color: 'blue' },
    { type: 'ring', at: [0, 0, 0.8], r: 1, count: 5, size: [0.2, 0.2, 0.2], color: 'purple' },
  ],
  callouts: [{ at: [0, 0, 0], text: '中心' }],
})

const VOXEL = JSON.stringify({
  grid: 12,
  cut: true,
  title: '体素场景',
  desc: '说明',
  palette: { '#': 'amber', o: 'purple', '@': 'ink' },
  shapes: [
    { shape: 'shell', r: 5, thickness: 1.2, fill: '#' },
    { shape: 'cluster', count: 6, r: 4, fill: 'o', seed: 5 },
    { shape: 'ball', r: 1.2, fill: '@' },
  ],
  legend: [{ color: 'amber', text: '壳' }],
})

/** 两个条目各渲染自己的形态。 */
const renderSolid = (client, source, overrides) => client.internals.ADAPTERS.isometric.render(source, env(client, overrides))
const renderVoxel = (client, source, overrides) => client.internals.ADAPTERS.voxel.render(source, env(client, overrides))

it('两种形态都能产出合法 XML 的图，且取景不越界', async (t) => {
  const { dom, client } = loadClient(t)
  for (const [label, source, render] of [['剖面', SOLID, renderSolid], ['体素', VOXEL, renderVoxel]]) {
    const { markup } = await render(client, source)
    assert.ok(markup.startsWith('<svg'), `${label} 应产出 SVG`)
    assert.equal(xmlProblem(dom, markup), '', `${label} 产物必须是合法 XML`)
    assert.match(markup, /<title>/, `${label} 必须带 title`)
    assert.match(markup, /<desc>/, `${label} 必须带 desc`)
    const box = bbox(dom, markup)
    const [vx, vy, vw, vh] = box.viewBox
    assert.ok(box.minX >= vx - 1 && box.minY >= vy - 1, `${label} 内容不得超出画布左上：${JSON.stringify(box)}`)
    assert.ok(box.maxX <= vx + vw + 1 && box.maxY <= vy + vh + 1, `${label} 内容不得超出画布右下：${JSON.stringify(box)}`)
  }
})

it('同一份 spec 两次渲染逐字节相同（确定性）', async (t) => {
  const { client } = loadClient(t)
  const solidFirst = await renderSolid(client, SOLID)
  const solidSecond = await renderSolid(client, SOLID)
  assert.equal(solidFirst.markup, solidSecond.markup, '含随机塌陷的场景也必须可复现')
  const voxelFirst = await renderVoxel(client, VOXEL)
  const voxelSecond = await renderVoxel(client, VOXEL)
  assert.equal(voxelFirst.markup, voxelSecond.markup)
})

it('剖面确实去掉一部分，且两种形态语义一致', async (t) => {
  const { client } = loadClient(t)
  const cut = await renderSolid(client, SOLID)
  const whole = await renderSolid(client, JSON.stringify({ ...JSON.parse(SOLID), cut: null }))
  assert.ok(countPaths(cut.markup) < countPaths(whole.markup), '剖切后路径数应减少')

  const voxelCut = await renderVoxel(client, VOXEL)
  const voxelWhole = await renderVoxel(client, JSON.stringify({ ...JSON.parse(VOXEL), cut: false }))
  assert.ok(countPaths(voxelCut.markup) < countPaths(voxelWhole.markup), '体素剖切同样应减少路径')
})

it('浅深主题取色不同', async (t) => {
  const light = loadClient(t, 'light')
  const lightOut = await renderSolid(light.client, SOLID)
  const dark = loadClient(t, 'dark')
  const darkOut = await renderSolid(dark.client, SOLID)
  assert.notEqual(lightOut.markup, darkOut.markup, '深色主题应产出不同的取色')
  assert.match(lightOut.markup, /fill="#FFFFFF"/, '浅色画布底')
  assert.match(darkOut.markup, /fill="#1E1E1C"/, '深色画布底')
})

it('错误信息点名问题并给出可用值', async (t) => {
  const { client } = loadClient(t)
  const solid = (value) => renderSolid(client, JSON.stringify(value))
  await assert.rejects(() => solid({ objects: [] }), /objects 必须是非空数组/)
  await assert.rejects(() => solid({ objects: [{ type: '金字塔' }] }), /type 未知.*box \/ ball \/ shell \/ cylinder \/ ring/s)
  await assert.rejects(() => solid({ objects: [{ type: 'ball', r: '大' }] }), /r 必须是数字/)
  await assert.rejects(() => solid({ objects: [{ type: 'box', size: [1, 1], color: 'blue' }] }), /size 必须是 \[x, y, z\]/)
  await assert.rejects(() => solid({ objects: [{ type: 'ball', r: 1, color: 'chartreuse' }] }), /未知颜色：chartreuse/)

  const voxel = (value) => renderVoxel(client, JSON.stringify(value))
  await assert.rejects(() => voxel({ grid: 12, palette: { '#': 'amber' } }), /需要 shapes 或 layers/)
  await assert.rejects(() => voxel({ grid: 12, palette: { '#': 'amber' }, layers: ['#'], shapes: [] }), /二选一/)
  await assert.rejects(() => voxel({ grid: 12, palette: { '#': 'amber' }, layers: ['x'] }), /未声明的字符/)
  await assert.rejects(() => voxel({ grid: 12, palette: { ab: 'amber' }, shapes: [{ shape: 'ball', r: 1, fill: 'a' }] }), /必须是单个字符/)
})

it('两条栅栏共用一个引擎：交叉使用被点名，而不是掉进构建器的内部错误', async (t) => {
  const { client } = loadClient(t)

  // 块与 spec 写法对不上：要说出"这块画什么、你写的是哪块的写法"
  await assert.rejects(() => renderVoxel(client, SOLID), /画体素.*objects.*isometric/s)
  await assert.rejects(
    () => renderSolid(client, JSON.stringify({ shapes: [{ shape: 'ball', r: 2 }] })),
    /画等距剖面.*shapes\/layers.*voxel/s,
  )
  // 显式声明了相反的 kind：也要点名
  await assert.rejects(
    () => renderVoxel(client, JSON.stringify({ kind: 'solid', objects: [] })),
    /画的是 voxel.*kind.*solid/s,
  )
  // 声明了正确的 kind 则照常通过（向后兼容旧写法）
  const ok = await renderVoxel(client, JSON.stringify({ ...JSON.parse(VOXEL), kind: 'voxel' }))
  assert.ok(ok.markup.startsWith('<svg'), '声明一致的 kind 应当被接受')
})

it('限额：网格与面数超限时给出可操作建议', async (t) => {
  const { client } = loadClient(t)
  await assert.rejects(
    () => renderVoxel(client, JSON.stringify({ grid: 40, palette: { '#': 'amber' }, shapes: [{ shape: 'ball', r: 3, fill: '#' }] })),
    /体素网格边长超过上限 32（当前 40），请调小 grid/s,
  )
  await assert.rejects(
    () => renderSolid(client, JSON.stringify({ objects: [{ type: 'shell', r: 1.4, thickness: 0.2, segments: 40, rings: 24, color: 'amber' }] }), { limits: { ...solidSpec.limits, faces: 100 } }),
    /面数超过上限 100/,
  )
})

it('产物体积超限时拒绝（声明了 bytes 就要真的执行）', async (t) => {
  const { client } = loadClient(t)
  // 上限压到 1 KiB：正常图也应当被拒，且文案给出实际大小
  await assert.rejects(
    () => renderSolid(client, SOLID, { limits: { ...solidSpec.limits, bytes: 1024 } }),
    /产物体积超过上限 1 KiB（当前 \d+ KiB）/,
  )
  // 正常上限下应当通过
  const ok = await renderSolid(client, SOLID)
  assert.ok(ok.markup.length > 0)
})

it('spec 过长时拒绝（进入对话的是它，产物是本地生成的）', async (t) => {
  const { client } = loadClient(t)
  const huge = JSON.stringify({ objects: [{ type: 'ball', r: 1, color: 'amber', note: 'x'.repeat(70_000) }] })
  await assert.rejects(() => renderSolid(client, huge), /spec 过长.*64 KiB/s)
})

it('检测：只在明确声明 kind 时才认领无语言代码块', (t) => {
  const { client } = loadClient(t)
  const { isometric, voxel } = client.internals.ADAPTERS
  assert.equal(isometric.detect('{ "kind": "solid", "objects": [] }'), true)
  assert.equal(isometric.detect('{ "kind": "voxel", "grid": 8 }'), false, '体素归 voxel 条目，不抢')
  assert.equal(voxel.detect('{ "kind": "voxel", "grid": 8 }'), true)
  assert.equal(voxel.detect('{ "kind": "solid", "objects": [] }'), false)
  assert.equal(isometric.detect('{ "series": [{ "type": "bar" }] }'), false, '不能抢 ECharts 的 JSON')
  assert.equal(voxel.detect('flowchart TD\n A --> B'), false)
})

it('两个条目各自声明栅栏与交互模式，共用同一套限额', () => {
  assert.ok(solidSpec, 'manifest 应有 isometric 条目')
  assert.ok(voxelSpec, 'manifest 应有 voxel 条目')
  assert.deepEqual(solidSpec.languages, ['isometric', 'isometric-interactive'])
  assert.deepEqual(voxelSpec.languages, ['voxel', 'voxel-interactive'])
  for (const entry of [solidSpec, voxelSpec]) {
    assert.equal(entry.assets.length, 0, '自绘渲染器不 vendor 任何引擎')
    assert.ok(entry.limits.faces > 0 && entry.limits.grid > 0 && entry.limits.bytes > 64 * 1024, '产物上限应大于 spec 上限')
    assert.ok(entry.modes.some((mode) => mode.id === 'interactive' && mode.setting === 'interactive'), '交互模式要声明开关')
    assert.equal(entry.family, 'spatial', '两者同属空间与展示')
  }
  assert.deepEqual(solidSpec.limits, voxelSpec.limits, '共用引擎就该共用限额')
})

it('关系检查：互穿要报，包含不算缺陷', (t) => {
  // 借鉴 Anatomy 的几何审计（他们的初版猛禽有 54 处间隙问题、323 处深度序问题，
  // 都是 1× 截图看不出来的）。这里只判能精确判交的形状。
  const { client } = loadClient(t)
  const audit = client.internals.isoAudit
  // 客户端在 jsdom realm 里，数组要展开成本 realm 的再比
  const kinds = (spec) => [...audit(spec, 'solid').problems].map((problem) => problem.kind)
  const box = (at, size) => ({ type: 'box', at, size })

  assert.deepEqual(kinds({ objects: [box([0, 0, 0], [1, 1, 1]), box([3, 0, 0], [1, 1, 1])] }), [], '分开的盒子不该报')
  assert.deepEqual(kinds({ objects: [box([0, 0, 0], [1, 1, 1]), box([1, 0, 0], [1, 1, 1])] }), [], '面贴面不算互穿')
  assert.deepEqual(kinds({ objects: [box([0, 0, 0], [2, 2, 2]), box([1, 0, 0], [2, 2, 2])] }), ['overlap'], '互穿要报')

  // 包含是这些图的常用构造：球在壳里、城在球里。它不是缺陷。
  assert.deepEqual(kinds({ objects: [box([0, 0, 0], [4, 4, 4]), { type: 'ball', r: 0.5 }] }), [], '球完整在盒内应当放行')
  assert.deepEqual(kinds({ objects: [box([0, 0, 0], [2, 2, 2]), { type: 'ball', at: [1, 0, 0], r: 0.6 }] }), ['overlap'], '球穿过盒面要报')

  // 圆柱：轴对齐，XY 与 z 都能精确判交（包围盒做不到 —— 对角相邻会误报）
  const cyl = (at, r, h) => ({ type: 'cylinder', at, r, h })
  assert.deepEqual(kinds({ objects: [cyl([0, 0, 0], 0.5, 2), { type: 'ball', at: [2, 0, 0], r: 0.4 }] }), [], '分开的圆柱与球不报')
  assert.deepEqual(kinds({ objects: [cyl([0, 0, 0], 0.5, 2), { type: 'ball', at: [0.5, 0, 0], r: 0.4 }] }), ['overlap'], '圆柱穿过球要报')
  assert.deepEqual(kinds({ objects: [cyl([0, 0, 0], 0.5, 2), cyl([1.2, 0, 0], 0.5, 2)] }), [], '并排的圆柱不报')
  assert.deepEqual(kinds({ objects: [cyl([0, 0, 0], 0.5, 2), cyl([0.6, 0, 0], 0.5, 2)] }), ['overlap'], '重叠的圆柱要报')
  assert.deepEqual(kinds({ objects: [cyl([0, 0, 0], 0.5, 2), cyl([0, 0, 3], 0.5, 2)] }), [], '上下错开的圆柱不报')
})

it('关系检查：引线必须落在图元上，图例必须有对应物体', (t) => {
  const { client } = loadClient(t)
  const audit = client.internals.isoAudit
  const problems = (spec) => [...audit(spec, 'solid').problems]

  // 引线：指向空处要报；指向圆柱/环也要算数（它们没有精确判交形状，但有包围盒）
  const solid = { objects: [{ type: 'box', at: [0, 0, 0], size: [2, 2, 2], color: 'blue' }] }
  assert.deepEqual(problems({ ...solid, callouts: [{ at: [0, 0, 0], text: '中心' }] }), [], '落在图元上应当放行')
  assert.deepEqual(problems({ ...solid, callouts: [{ at: [0, 0, 1.05], text: '顶面' }] }), [], '落在面上应当放行')
  assert.deepEqual(problems({ ...solid, callouts: [{ at: [0, 0, 3], text: '空处' }] }).map((p) => p.kind), ['callout'])
  assert.deepEqual(
    problems({ objects: [{ type: 'cylinder', at: [0, 0, 0], r: 0.5, h: 2, color: 'blue' }], callouts: [{ at: [0, 0, 1], text: '柱' }] }),
    [],
    '引线指向圆柱必须算数（第一版只判 box/ball，在我们自己的示例上误报了三处）',
  )

  // 图例：颜色必须在用
  assert.deepEqual(problems({ ...solid, legend: [{ color: 'blue', text: '主体' }] }), [])
  assert.deepEqual(problems({ ...solid, legend: [{ color: 'red', text: '不存在' }] }).map((p) => p.kind), ['legend'])
})

it('关系检查：我们自己的示例必须零问题', (t) => {
  const { client } = loadClient(t)
  for (const [id, kind] of [['isometric', 'solid'], ['voxel', 'voxel']]) {
    const entry = renderers.find((item) => item.id === id)
    const { problems, checked } = client.internals.isoAudit(JSON.parse(entry.sample), kind)
    assert.deepEqual([...problems], [], `${id} 的示例不该有关系问题`)
    if (kind === 'solid') assert.ok(checked >= 3, `${id} 的示例应当有可判交的图元，实际 ${checked}`)
  }
})

it('关系检查：体素不做互穿判定（网格本身保证了这一点）', (t) => {
  const { client } = loadClient(t)
  const result = client.internals.isoAudit({ grid: 8, shapes: [] }, 'voxel')
  assert.equal(result.checked, 0)
  assert.deepEqual([...result.problems], [])
})
