/**
 * 产物必须是**严格合法的 XML**。
 *
 * 这是从一次真实事故来的：ECharts 把字体栈直接写进 `font-family` 属性且不转义，
 * 带引号的栈（`"Segoe UI"`）会让整个 SVG 变成非法 XML。HTML 解析很宽容，所以在应用里
 * 看着一切正常 —— 但同样的字节：
 *   · 用「下载 SVG」导出后，浏览器按 XML 打开 → 裂图；
 *   · 贴到 GitHub 的 `<img>` 里 → 裂图。
 *
 * 所以这条不是"锦上添花的校验"，而是导出与外部引用的前提。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'

import { loadVendorScript, setupDom } from '../scripts/dom-env.mjs'

const here = fileURLToPath(new URL('..', import.meta.url))

/** 应用真实的回退字体栈：带引号，正是触发转义问题的那种。 */
const QUOTED_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", sans-serif'

function loadClient(t) {
  const dom = setupDom({ scripts: true })
  let client
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      client = factory(() => {
        throw new Error('no react needed')
      })
    },
  }
  dom.window.eval(readFileSync(join(here, 'lib', 'client.js'), 'utf8'))
  t.after(() => dom.window.close())
  return { dom, client }
}

/** Parse as strict XML and report whether it is well-formed. */
function xmlProblem(dom, markup) {
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  const error = parsed.querySelector('parsererror')
  if (error !== null) return String(error.textContent).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (parsed.documentElement?.nodeName?.toLowerCase() === 'parsererror') return '根元素是 parsererror'
  return ''
}

it('带引号的字体栈被改写成属性安全的形式', (t) => {
  const { client } = loadClient(t)
  const { xmlSafeFontFamily } = client.internals
  assert.equal(typeof xmlSafeFontFamily, 'function', '应导出纯函数以便测试')
  assert.equal(xmlSafeFontFamily(QUOTED_FONT), "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif")
  assert.ok(!xmlSafeFontFamily(QUOTED_FONT).includes('"'), '结果里不能再有双引号')
  assert.equal(xmlSafeFontFamily(undefined), '', '缺失时不应抛异常')
})

it('ECharts 在带引号字体栈下产出合法 XML（曾经是裂图的根因）', async (t) => {
  const { dom, client } = loadClient(t)
  const { window } = dom
  loadVendorScript(dom, join(here, 'vendor', 'echarts', 'echarts.min.js'))
  assert.equal(typeof window.echarts, 'object', 'vendored ECharts 应可用')

  const source = JSON.stringify({
    title: { text: '字体栈与 XML' },
    xAxis: { type: 'category', data: ['一', '二'] },
    yAxis: {},
    series: [{ type: 'bar', data: [1, 2] }],
  })
  const result = await client.internals.ADAPTERS.echarts.render(source, {
    loadEngine: async () => ({ echarts: window.echarts }),
    container: () => window.document.createElement('div'),
    clearContainer: () => {},
    theme: 'light',
    presentation: { fontFamily: QUOTED_FONT, fontSize: 13, canvasMaxHeight: 360, canvasPadding: 16, background: 'auto', showToolbar: false },
    settings: { animation: false, interactive: false },
    behaviour: {},
    measure: false,
    nextId: () => 'xml-test',
  })
  const markup = String(result?.markup ?? '')
  assert.ok(markup.includes('<svg'), '应有 SVG 产物')
  const problem = xmlProblem(dom, markup)
  assert.equal(problem, '', `产物必须是合法 XML：${problem}`)
  // 字体栈仍在（只是换了引号），否则就是把字体丢了而不是修好了
  assert.ok(markup.includes('Segoe UI'), '字体栈应保留')
  assert.ok(!/font-family="[^"]*"[^"]*"/.test(markup) || !markup.includes('" segoe'), '不应出现被拆散的属性')
})
