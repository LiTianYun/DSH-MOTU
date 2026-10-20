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
  facts: ['类名是文档级的', '改成内容哈希前缀'],
  meta: { 基线: '0.17.0', 验证: '243 单测' },
  notes: ['前缀来自内容哈希，不破坏确定性。'],
  sections: [{ title: '用户能感知到的变化', items: ['两张异色图不再互相污染'] }],
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
  assert.match(snapshot.data, /已完成/, '结论胶囊要写中文标签')
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

it('摘要卡是合法 SVG，且提示下载得到完整网页', async (t) => {
  const { dom, client } = loadClient(t)
  const drawn = await client.internals.ADAPTERS.report.render(JSON.stringify(SAMPLE), env())
  const parsed = new dom.window.DOMParser().parseFromString(drawn.markup, 'image/svg+xml')
  assert.equal(parsed.querySelector('parsererror'), null, '摘要卡必须是合法 XML')
  assert.match(drawn.markup, /下载/)
  assert.equal([...drawn.markup.matchAll(/\s(fill|stroke)=""/g)].length, 0, '不能有空色')
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

it('manifest 条目齐全', () => {
  assert.equal(spec.output, 'svg', '对话里是 SVG 摘要卡')
  assert.deepEqual([...spec.languages], ['report'])
  assert.deepEqual([...spec.assets], [])
  assert.ok(spec.promptNote.length > 0 && spec.promptNote.length <= 40, '常驻补句要短')
  assert.doesNotThrow(() => JSON.parse(spec.sample))
})
