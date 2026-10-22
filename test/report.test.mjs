/**
 * 任务报告（report）渲染器。
 *
 * 对话里是一张摘要卡；「下载」导出的是**一份自包含的 HTML 报告网页**。
 *
 * 这套形态取自 ChatGPT 每轮结束附的那份网页：先结论与口径，再变化、证据与未测范围。
 * 这里钉三件事：
 *   1. **自包含** —— 页面不许引用任何外部资源、不许发请求（离线可读）；
 *   2. **确定性** —— 同一份 spec 必须得到同一份字节（内容全部来自 spec，页面里没有时间戳）；
 *   3. **不猜** —— 规格写错就报错，缺结论就拒绝，不生成一份"看着像"的空报告。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const spec = renderers.find((item) => item.id === 'report')

function loadClient(t) {
  const dom = setupDom({ scripts: true })
  dom.window.document.documentElement.dataset.theme = 'light'
  let client
  dom.window.__ModuleLoader__ = { load({ factory }) { client = factory(() => { throw new Error('no react') }) } }
  dom.window.eval(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  t.after(() => dom.window.close())
  return { dom, client }
}

const env = () => ({
  loadEngine: async () => ({}),
  container: () => setupDom({ scripts: true }).window.document.createElement('div'),
  clearContainer: () => {},
  theme: 'light',
  presentation: { fontFamily: 'system-ui, sans-serif', fontSize: 13 },
  settings: {},
  behaviour: {},
  limits: spec.limits,
  nextId: () => 'report-test',
})

const SAMPLE = {
  title: '修好了调色板串色',
  round: '第 18 轮 · 2026-10-19',
  status: 'done',
  verdict: '定位并修掉同名类互相覆盖的根因。',
  badges: [
    { tone: 'done', text: '已完成' },
    { tone: 'info', text: '仅本机验证' },
  ],
  facts: ['类名是文档级的', '改成内容哈希前缀'],
  meta: { 基线: '0.17.0', 验证: '243 单测' },
  notice: { tone: 'warn', text: '未测长对话。' },
  notes: ['前缀来自内容哈希，不破坏确定性。'],
  sections: [
    { title: '用户能感知到的变化', items: ['两张异色图不再互相污染'] },
    { title: '改了什么', table: { head: ['文件', '改动'], rows: [['lib/client.js', '类名加前缀']] } },
    { title: '验证与未测', items: ['npm test 通过'], details: { summary: '未测范围', items: ['长对话'] } },
  ],
  sources: [{ label: '改动', text: 'lib/client.js' }],
}

it('报告网页包含结论与分节，且下载的是 HTML', async (t) => {
  const { client } = loadClient(t)
  const drawn = await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), env())
  const snapshot = drawn.snapshot()
  assert.equal(snapshot.extension, 'html')
  assert.equal(snapshot.mimeType, 'text/html')
  assert.match(snapshot.data, /^<!doctype html>/i)
  assert.match(snapshot.data, /修好了调色板串色/)
  assert.match(snapshot.data, /定位并修掉同名类互相覆盖的根因/)
  assert.match(snapshot.data, /用户能感知到的变化/)
  assert.match(snapshot.data, /已完成/)
  assert.match(snapshot.data, /badge done/, '显式徽章要按 tone 上色')
  assert.match(snapshot.data, /<table>/, '改动表要真的渲染成表格')
  assert.match(snapshot.data, /未测范围/, '未验证范围要进折叠块')
  assert.match(snapshot.data, /来源/, '来源要单独成节')
})

it('页面自包含：不引用外部资源，也不发请求', async (t) => {
  const { client } = loadClient(t)
  const drawn = await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), env())
  const html = drawn.snapshot().data
  for (const banned of ['<script src', '<link ', '<img', 'http://', 'https://', '@import', 'fetch(']) {
    assert.equal(html.includes(banned), false, `页面不该出现 ${banned}`)
  }
  // 唯一允许的脚本是切换深浅色那段内联逻辑
  assert.match(html, /<script>[\s\S]*<\/script>/, '应当有内联的深浅色脚本')
})

it('同一份 spec 得到同一份字节（页面里没有时间戳）', async (t) => {
  const { client } = loadClient(t)
  const once = (await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), env())).snapshot().data
  const twice = (await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), env())).snapshot().data
  assert.equal(once, twice)
})

it('摘要卡是合法 SVG，且提示查看 / 下载完整网页', async (t) => {
  const { dom, client } = loadClient(t)
  const drawn = await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), env())
  const parsed = new dom.window.DOMParser().parseFromString(drawn.markup, 'image/svg+xml')
  assert.equal(parsed.querySelector('parsererror'), null, '摘要卡必须是合法 XML')
  assert.match(drawn.markup, /查看/)
  assert.match(drawn.markup, /下载/)
  assert.equal([...drawn.markup.matchAll(/\s(fill|stroke)=""/g)].length, 0, '不能有空色')
})

it('没有 flow 的旧报告规格照常渲染，不出现流程图结构（向后兼容）', async (t) => {
  const { client } = loadClient(t)
  const parsed = client.internals.reportSpecOf(JSON.stringify(SAMPLE))
  assert.equal(parsed.sections.every((section) => section.flow === null), true)
  const html = client.internals.reportHtml(parsed)
  assert.doesNotMatch(html, /class="flow"/)
  const drawn = await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), env())
  assert.doesNotMatch(drawn.markup, /含流程图/)
  assert.match(drawn.markup, /这是摘要卡/)
})

it('sections[].flow 生成内联 SVG 流程图，文字被转义', async (t) => {
  const { client } = loadClient(t)
  const flow = {
    direction: 'LR',
    nodes: [
      { id: 'a', label: '输入 <script>', sub: '需求' },
      { id: 'b', label: '处理' },
      { id: 'c', label: '输出' },
    ],
    edges: [
      { from: 'a', to: 'b', label: '解析' },
      { from: 'b', to: 'c' },
    ],
  }
  const value = { ...SAMPLE, sections: [{ title: '改动流程', flow }] }
  const parsed = client.internals.reportSpecOf(JSON.stringify(value))
  assert.equal(parsed.sections[0].flow.nodes.length, 3)
  const html = client.internals.reportHtml(parsed)
  assert.match(html, /<svg/, '报告页应当含内联 SVG')
  assert.match(html, /改动流程/)
  assert.match(html, /输入 &lt;script&gt;/, '流程图文字必须转义')
  assert.doesNotMatch(html, /输入 <script>/, '不能把标记带进页面')
})

it('流程图规格写错就报错', async (t) => {
  const { client } = loadClient(t)
  const base = (flow) => ({ ...SAMPLE, sections: [{ title: '流程', flow }] })
  const cases = [
    [base({ direction: 'XX', nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }] }), /direction 只能是/],
    [base({ nodes: [{ id: 'a', label: 'a' }] }), /至少 2 个节点/],
    [base({ nodes: Array.from({ length: 7 }, (unused, index) => ({ id: `n${index}`, label: `n${index}` })) }), /最多 6 个/],
    [base({ nodes: [{ id: 'a', label: 'a' }, { id: 'a', label: 'b' }] }), /id 不能重复/],
    [base({ nodes: [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }], edges: [{ from: 'a', to: 'zzz' }] }), /to 指向不存在的节点/],
  ]
  for (const [value, pattern] of cases) {
    assert.throws(() => client.internals.reportSpecOf(JSON.stringify(value)), pattern)
  }
})

it('规格写错就报错，不生成"看着像"的空报告', async (t) => {
  const { client } = loadClient(t)
  const cases = [
    [{ ...SAMPLE, status: '差不多完成' }, /status 未知/],
    [{ ...SAMPLE, title: '  ' }, /title 不能为空/],
    [{ ...SAMPLE, verdict: '' }, /verdict 不能为空/],
    [{ ...SAMPLE, sections: [{ title: '没有条目' }] }, /sections\[0\]\.items/],
    [{ ...SAMPLE, sections: 'nope' }, /sections 必须是数组/],
    [{ ...SAMPLE, meta: [] }, /meta 必须是对象/],
    [{ ...SAMPLE, badges: [{ tone: 'done' }] }, /badges\[0\]\.text 不能为空/],
    [{ ...SAMPLE, badges: [{ tone: 'nope', text: 'x' }] }, /badges\[0\]\.tone 未知/],
    [{ ...SAMPLE, notice: { tone: 'nope', text: 'x' } }, /notice\.tone 未知/],
    [{ ...SAMPLE, sections: [{ title: 't', table: { head: ['a'], rows: [['a', 'b']] } }] }, /rows\[0\] 必须与表头同列数/],
    [{ ...SAMPLE, sources: [{ text: '' }] }, /sources\[0\]\.text 不能为空/],
  ]
  for (const [value, pattern] of cases) {
    await assert.rejects(() => client.internals.ADAPTERS.report.render(JSON.stringify(value), env()), pattern)
  }
})

it('识别只认"结论 + 状态"这一对，不抢矩阵与指标卡', (t) => {
  const { client } = loadClient(t)
  const detect = client.internals.ADAPTERS.report.detect
  assert.equal(detect(JSON.stringify(SAMPLE)), true)
  assert.equal(detect(JSON.stringify({ items: [{ label: 'a', value: '1' }] })), false, '指标卡不该被抢')
  assert.equal(detect(JSON.stringify({ cases: [{ name: 'a', status: 'pass' }] })), false, '矩阵不该被抢')
  assert.equal(detect('flowchart TD\n  A --> B'), false)
})

it('归档只发一次，且尊重任务报告开关', async (t) => {
  const { dom, client } = loadClient(t)
  const calls = []
  let taskReport = true
  dom.window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' })
    if (String(url).endsWith('/config')) {
      return { ok: true, json: async () => ({ value: { settings: { taskReport } } }) }
    }
    if (String(url).endsWith('/reports') && options.method === 'POST') {
      return { ok: true, json: async () => ({ ok: true, value: { id: 'x' } }) }
    }
    return { ok: true, json: async () => ({ ok: true, value: {} }) }
  }
  const spec = { title: 't', verdict: 'v', status: 'done' }
  await client.internals.archiveReport(spec, '<!doctype html>')
  await client.internals.archiveReport(spec, '<!doctype html>')
  assert.equal(calls.filter(call => call.method === 'POST').length, 1, '同一份报告只 POST 一次')

  await client.internals.archiveReport({ ...spec, title: 't2' }, '<!doctype html>')
  assert.equal(calls.filter(call => call.method === 'POST').length, 2, '新报告要再 POST')

  taskReport = false
  await client.internals.archiveReport({ ...spec, title: 't3' }, '<!doctype html>')
  assert.equal(calls.filter(call => call.method === 'POST').length, 2, '关闭后不能再归档')
})

it('设置页预览不归档示例报告', async (t) => {
  const { dom, client } = loadClient(t)
  const calls = []
  dom.window.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? 'GET' })
    return { ok: true, json: async () => ({ ok: true, value: { settings: { taskReport: true } } }) }
  }
  await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), { ...env(), measure: false })
  assert.equal(calls.length, 0, '预览走同一个适配器，但不能写报告库')
})

it('manifest 条目齐全', () => {
  assert.equal(spec.output, 'svg', '对话里是 SVG 摘要卡')
  assert.deepEqual([...spec.languages], ['report'])
  assert.deepEqual([...spec.assets], [])
  assert.equal(spec.eager, true, '报告在长回复末尾，必须立即渲染并归档')
  assert.equal(spec.promptNote, undefined, '常驻规则由宿主固定行承担，避免同一句出现两次')
  assert.ok(spec.syntaxHint.includes('badges') && spec.syntaxHint.includes('table'), '语法提示要讲新块')
  assert.doesNotThrow(() => JSON.parse(spec.sample))
})

it('表格与来源里的标记被转义，不会变成 HTML', async (t) => {
  const { client } = loadClient(t)
  const source = {
    ...SAMPLE,
    sections: [{ title: '转义', table: { head: ['列'], rows: [['<b>']] } }],
    sources: [{ label: '来源', text: '<script>' }],
  }
  const html = (await client.internals.ADAPTERS.report.render(JSON.stringify(source), env())).snapshot().data
  assert.match(html, /&lt;b&gt;/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<b>/)
})
