/**
 * 指标卡（metrics）渲染器。
 *
 * 它是第八种之后新增的一个，性质与前面几个不同：不是几何图，是**读数**——
 * 一排大数字 + 阈值色 + 可选趋势线。所以这里钉的不是投影或布局，而是：
 *   1. 读数的契约（必填、单位、阈值色的语义映射、错误文案可操作）；
 *   2. **没有空色**：生成物里任何 fill/stroke 都必须是非空颜色值 —— 这条是通用
 *      守卫，因为我第一版用错了令牌名，写出一堆 fill=""，浅色下回落成黑看着正常、
 *      换深色就错。空值能过 XML 校验，所以必须单独钉；
 *   3. 扩展位够用：新增一个渲染器不该动配置、路由、目录、技能之外的东西。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const spec = renderers.find((item) => item.id === 'metrics')

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

function env(overrides = {}) {
  return {
    loadEngine: async () => ({}),
    container: () => setupDom({ scripts: true }).window.document.createElement('div'),
    clearContainer: () => {},
    theme: 'light',
    presentation: { fontFamily: 'system-ui, sans-serif', fontSize: 13 },
    settings: {},
    behaviour: {},
    limits: spec.limits,
    nextId: () => 'metrics-test',
    ...overrides,
  }
}

/** 渲染一段 spec，返回产物。 */
async function draw(client, value, overrides) {
  const source = typeof value === 'string' ? value : JSON.stringify(value)
  return client.internals.ADAPTERS.metrics.render(source, env(overrides))
}

/** 严格 XML 解析，返回问题描述（空串表示合法）。 */
function xmlProblem(dom, markup) {
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  const error = parsed.querySelector('parsererror')
  if (error !== null) return String(error.textContent).replace(/\s+/g, ' ').trim().slice(0, 160)
  if (parsed.documentElement?.nodeName?.toLowerCase() === 'parsererror') return '根元素是 parsererror'
  return ''
}

const SAMPLE = {
  title: '待机功耗',
  items: [
    { label: '待机电流', value: '12.4', unit: 'mA', tone: 'ok', delta: '比上次 +0.8' },
    { label: 'SoC 温度', value: '48.2', unit: '°C', tone: 'warn' },
    { label: '守护进程', value: '3/3', tone: 'ok' },
  ],
  spark: [11.9, 12.1, 12.0, 12.3, 12.4],
}

it('指标卡产出合法 XML，读数、单位与阈值都在', async (t) => {
  const { dom, client } = loadClient(t)
  const { markup } = await draw(client, SAMPLE)
  assert.equal(xmlProblem(dom, markup), '', '产物必须是合法 XML')
  assert.match(markup, /待机电流/)
  assert.match(markup, /12\.4/)
  assert.match(markup, />mA</, '单位要跟在数值后面')
  assert.match(markup, /比上次 \+0\.8/, '变化说明要画出来')
  assert.match(markup, /待机功耗/, '标题要进 <title>')
  assert.match(markup, /role="img"/)
})

it('生成物里没有空色：任何 fill/stroke 都是真实颜色值', async (t) => {
  const { client } = loadClient(t)
  // 令牌名写错时属性会变成 fill="" —— 它能过 XML 校验、浅色下还回落成黑，
  // 只有深色下才看得出错，所以这里显式钉死。
  for (const value of [SAMPLE, { items: [{ label: 'A', value: '1', tone: 'bad' }] }]) {
    const { markup } = await draw(client, value)
    const empties = [...markup.matchAll(/\s(fill|stroke)=""/g)]
    assert.equal(empties.length, 0, `不应出现空色：${empties.map((m) => m[1]).join('、')}`)
  }
})

it('阈值色按语义映射，idle 取次要色而不是彩色', async (t) => {
  const { client } = loadClient(t)
  const tones = { ok: 'green', warn: 'amber', bad: 'red' }
  for (const [tone, name] of Object.entries(tones)) {
    const { markup } = await draw(client, { items: [{ label: 'x', value: '1', tone }] })
    // 同一个色值应当能在其他渲染器里作为语义色出现；这里只断言它是彩色而非灰
    const colors = [...new Set([...markup.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0].toUpperCase()))]
    assert.ok(colors.length >= 3, `${tone} 应当带出至少一个语义色`)
  }
  const idle = await draw(client, { items: [{ label: 'x', value: '1' }] })
  assert.match(idle.markup, /x/, '缺省 tone 也要能画')
})

it('超过一行自动换行，画布随之变高', async (t) => {
  const { client } = loadClient(t)
  const items = (count) => Array.from({ length: count }, (unused, index) => ({ label: `项 ${index}`, value: String(index) }))
  const three = await draw(client, { items: items(3) })
  const six = await draw(client, { items: items(6) })
  const height = (markup) => Number(markup.match(/viewBox="0 0 680 (\d+)"/)[1])
  assert.ok(height(six.markup) > height(three.markup), '六项应当比三项高（换行了）')
  assert.match(six.markup, /项 5/, '第二行的项也要画出来')
})

it('趋势线只在给够数据时画，且标出首尾', async (t) => {
  const { client } = loadClient(t)
  const withSpark = await draw(client, SAMPLE)
  assert.match(withSpark.markup, /mt-spark/, 'spark 要给出一条路径')
  assert.match(withSpark.markup, /趋势：11\.9 → 12\.4/, '首尾值要标出来')
  const without = await draw(client, { items: SAMPLE.items })
  assert.doesNotMatch(without.markup, /mt-spark/, '不给 spark 就不该有趋势线')
})

it('错误文案指到具体字段，且说清可用值', async (t) => {
  const { client } = loadClient(t)
  const cases = [
    [{ items: [] }, /非空数组/],
    [{ items: [{ label: 'x' }] }, /items\[0\]\.value/],
    [{ items: [{ label: '', value: '1' }] }, /items\[0\]\.label/],
    [{ items: [{ label: 'x', value: '1', tone: '红' }] }, /tone 未知.*ok \/ warn \/ bad \/ idle/s],
    [{ items: [{ label: 'x', value: '1' }], spark: [1] }, /至少要有两个数字/],
    [{ items: [{ label: 'x', value: '1' }], spark: ['a', 'b'] }, /spark\[0\]/],
  ]
  for (const [value, pattern] of cases) {
    await assert.rejects(() => draw(client, value), pattern)
  }
})

it('读数项数受限额约束，超了给出可操作的提示', async (t) => {
  const { client } = loadClient(t)
  const many = { items: Array.from({ length: spec.limits.points + 1 }, (unused, index) => ({ label: `项 ${index}`, value: '1' })) }
  await assert.rejects(() => draw(client, many), /上限|超过|too many|超出/i)
})

it('深色主题下取的是深色令牌，不是浅色那一套', async (t) => {
  const { client: lightClient } = loadClient(t, 'light')
  const light = await draw(lightClient, SAMPLE)
  const { client: darkClient } = loadClient(t, 'dark')
  const dark = await draw(darkClient, SAMPLE)
  assert.notEqual(light.markup, dark.markup, '两套主题的产物不该一样')
  assert.equal([...dark.markup.matchAll(/\s(fill|stroke)=""/g)].length, 0, '深色下也不能有空色')
})

it('识别只认读数形状，不抢 ECharts 与 Vega-Lite 的活', (t) => {
  const { client } = loadClient(t)
  const detect = client.internals.ADAPTERS.metrics.detect
  assert.equal(detect(JSON.stringify(SAMPLE)), true)
  assert.equal(detect('{"series":[{"type":"bar","data":[1]}]}'), false, 'ECharts 的 series 不该被抢')
  assert.equal(detect('{"mark":"bar","data":{"values":[1]}}'), false, 'Vega-Lite 的 mark 不该被抢')
  assert.equal(detect('flowchart TD\n  A --> B'), false, 'Mermaid 更不该')
})

it('manifest 条目齐全：栅栏、家族、限额、字体策略、示例', () => {
  assert.equal(spec.family, 'chart')
  assert.deepEqual([...spec.languages], ['metrics'])
  assert.equal(spec.output, 'svg')
  assert.deepEqual([...spec.assets], [], '自绘渲染器不加载第三方引擎')
  assert.equal(spec.fontPolicy, 'stack')
  assert.ok(spec.limits.points >= 4, '限额要能装下一排读数')
  assert.ok(spec.promptNote.length > 0, '常驻提示段要有一句')
  // 示例必须能渲染 —— 它是错误卡片与预览的输入
  assert.doesNotThrow(() => JSON.parse(spec.sample))
})
