/**
 * 用例矩阵（matrix）渲染器。
 *
 * 与指标卡同一类：呈现型可视，markdown 顶替不了。这里钉四件事：
 *   1. 契约：必填、状态集合、ms 允许 null、错误文案指到具体字段；
 *   2. **汇总行由渲染器算** —— 这是它存在的理由，绝不能让模型自己数；
 *   3. 状态 → 字形与语义色的映射（写错的状态要报错，不静默降级）；
 *   4. 没有空色（通用守卫，与指标卡同一条）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const spec = renderers.find((item) => item.id === 'matrix')

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

function env() {
  return {
    loadEngine: async () => ({}),
    container: () => setupDom({ scripts: true }).window.document.createElement('div'),
    clearContainer: () => {},
    theme: 'light',
    presentation: { fontFamily: 'system-ui, sans-serif', fontSize: 13 },
    settings: {},
    behaviour: {},
    limits: spec.limits,
    nextId: () => 'matrix-test',
  }
}

async function draw(client, value) {
  const source = typeof value === 'string' ? value : JSON.stringify(value)
  return client.internals.ADAPTERS.matrix.render(source, env())
}

/** 产物里的纯文本（去掉标签），用于断言汇总行内容。 */
function plainText(markup) {
  return markup.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

const SAMPLE = {
  title: '连板前自测',
  cases: [
    { name: 'serial-cmd.py 查 uname', status: 'pass', ms: 820, note: '115200 8N1' },
    { name: 'i2cdetect 查 bq28z620', status: 'fail', ms: 3010, note: '地址 0x0b 无应答' },
    { name: 'iperf3 打流', status: 'warn', ms: 10050, note: '丢包 0.6%' },
    { name: 'tio 抓日志', status: 'skip', ms: null, note: '未插板' },
    { name: '烧录校验', status: 'pass', ms: 4200 },
    { name: 'RTC 走时', status: 'running' },
  ],
}

it('用例矩阵产出合法 XML，名称、耗时与备注都在', async (t) => {
  const { dom, client } = loadClient(t)
  const { markup } = await draw(client, SAMPLE)
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  assert.equal(parsed.querySelector('parsererror'), null, '产物必须是合法 XML')
  assert.match(markup, /serial-cmd\.py 查 uname/)
  assert.match(markup, /820 ms/, '耗时要在')
  assert.match(markup, /地址 0x0b 无应答/, '备注要在')
  assert.match(markup, /连板前自测/, '标题要进 <title>')
  assert.match(markup, /role="img"/)
})

it('汇总行由渲染器算，模型不用自己数', async (t) => {
  const { client } = loadClient(t)
  const { markup } = await draw(client, SAMPLE)
  const text = plainText(markup)
  // 6 条：2 pass / 1 fail / 1 warn / 1 skip / 1 running
  assert.match(text, /6 项/)
  assert.match(text, /2 通过/)
  assert.match(text, /1 失败/)
  assert.match(text, /1 警告/)
  assert.match(text, /1 跳过/)
  assert.match(text, /1 进行中/)
  // 数错一位就该看得见
  assert.doesNotMatch(text, /3 通过/)
})

it('汇总只列出现过的状态，不硬塞零项', async (t) => {
  const { client } = loadClient(t)
  const { markup } = await draw(client, { cases: [{ name: '只有一条', status: 'pass' }] })
  const text = plainText(markup)
  assert.match(text, /1 项/)
  assert.match(text, /1 通过/)
  assert.doesNotMatch(text, /0 失败/, '没有的状态不该出现在汇总里')
  assert.doesNotMatch(text, /0 跳过/)
})

it('状态映射到字形，写错的状态直接报错不静默降级', async (t) => {
  const { client } = loadClient(t)
  const glyphs = { pass: '✓', fail: '✗', warn: '!', skip: '○', running: '●' }
  for (const [status, glyph] of Object.entries(glyphs)) {
    const { markup } = await draw(client, { cases: [{ name: 'x', status }] })
    assert.ok(markup.includes(glyph), `${status} 应当画成 ${glyph}`)
  }
  await assert.rejects(
    () => draw(client, { cases: [{ name: 'x', status: '过了' }] }),
    /status 未知.*pass \/ fail \/ warn \/ skip \/ running/s,
  )
  // 缺省是 skip，不是报错
  const omitted = await draw(client, { cases: [{ name: 'x' }] })
  assert.ok(omitted.markup.includes('○'), '缺省状态按 skip 处理')
})

it('ms 允许 null（显示 —），负数与字符串要报错', async (t) => {
  const { client } = loadClient(t)
  const { markup } = await draw(client, { cases: [{ name: 'x', status: 'skip', ms: null }] })
  assert.match(markup, />—</, 'null 显示为破折号')
  await assert.rejects(() => draw(client, { cases: [{ name: 'x', ms: -1 }] }), /cases\[0\]\.ms/)
  await assert.rejects(() => draw(client, { cases: [{ name: 'x', ms: 'soon' }] }), /cases\[0\]\.ms/)
})

it('错误文案指到具体字段', async (t) => {
  const { client } = loadClient(t)
  await assert.rejects(() => draw(client, { cases: [] }), /非空数组/)
  await assert.rejects(() => draw(client, { cases: [{ name: '' }] }), /cases\[0\]\.name/)
  await assert.rejects(() => draw(client, { cases: [{ name: 'a' }, { status: 'pass' }] }), /cases\[1\]\.name/)
})

it('没有空色，深色主题取深色令牌', async (t) => {
  const { client: lightClient } = loadClient(t, 'light')
  const light = await draw(lightClient, SAMPLE)
  assert.equal([...light.markup.matchAll(/\s(fill|stroke)=""/g)].length, 0, '不能有空色')
  const { client: darkClient } = loadClient(t, 'dark')
  const dark = await draw(darkClient, SAMPLE)
  assert.notEqual(light.markup, dark.markup, '两套主题产物不该一样')
  assert.equal([...dark.markup.matchAll(/\s(fill|stroke)=""/g)].length, 0, '深色下也不能有空色')
})

it('备注只在有备注时留出行高，全部无备注时更紧凑', async (t) => {
  const { client } = loadClient(t)
  const height = (markup) => Number(markup.match(/viewBox="0 0 680 (\d+)"/)[1])
  const withNote = await draw(client, { cases: [{ name: 'a', note: '有备注' }, { name: 'b' }] })
  const without = await draw(client, { cases: [{ name: 'a' }, { name: 'b' }] })
  assert.ok(height(withNote.markup) > height(without.markup), '有备注应当占更高')
})

it('识别只认用例形状，不抢别人的活', (t) => {
  const { client } = loadClient(t)
  const detect = client.internals.ADAPTERS.matrix.detect
  assert.equal(detect(JSON.stringify(SAMPLE)), true)
  assert.equal(detect('{"items":[{"label":"x","value":"1"}]}'), false, '指标卡不该被抢')
  assert.equal(detect('{"series":[{"type":"bar"}]}'), false, 'ECharts 不该被抢')
  assert.equal(detect('flowchart TD\n A --> B'), false, 'Mermaid 更不该')
})

it('manifest 条目齐全', () => {
  assert.equal(spec.family, 'chart')
  assert.deepEqual([...spec.languages], ['matrix'])
  assert.equal(spec.output, 'svg')
  assert.deepEqual([...spec.assets], [])
  assert.equal(spec.fontPolicy, 'stack')
  assert.ok(spec.limits.points >= 8, '限额要能装下一屏用例')
  assert.ok(spec.promptNote.length > 0 && spec.promptNote.length <= 40, '常驻补句要短 —— 提示段预算很紧')
  assert.doesNotThrow(() => JSON.parse(spec.sample))
})
