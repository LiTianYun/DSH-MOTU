/**
 * 内容嗅探的锚定约束 —— 一次真实故障的回归。
 *
 * 故障现场：一段**四反引号的文档块**，内容里演示了一段 ```metrics 示例。
 * 那个外层块没有语言标签，于是走进内容嗅探；metrics 的 detect 当时写的是
 * `/"items"\s*:\s*\[/.test(source)` —— 全串搜索、不锚定，于是把这段文档抢走，
 * 再拿去 JSON.parse，报 "Unexpected token '`'"。
 *
 * 家规：**内容嗅探必须锚定在首字符**（其余七个渲染器都写着 `startsWith('{')`，
 * 只有 metrics 那条是后加的、漏了）。这里不只钉 metrics，而是把"文档块引用了
 * 某种栅栏 → 谁都不许抢"钉成通用约束：新增渲染器时会自动被这条覆盖。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

/** 去掉示例自带的外层栅栏，拿到真正的源码。 */
function bodyOf(sample) {
  const match = /^\+\+\+`?`?/.exec(sample)
  return bodyOfSample(sample)
}
function bodyOfSample(sample) {
  const text = String(sample).trim()
  const match = /^```[a-z0-9-]*\n([\s\S]*?)\n```$/.exec(text)
  return match === null ? text : match[1]
}

/**
 * 每一条：(渲染器 id, 首个栅栏语言, 裸源码)。
 *
 * manifest 的 sample 大多**自带栅栏**（参考页要展示完整示例），所以这里先剥掉，
 * 否则"文档块"会变成双重嵌套，测不到真正要测的东西。
 */
const samples = renderers
  .filter((spec) => spec.languages.length > 0)
  .map((spec) => ({
    id: spec.id,
    language: spec.languages[0],
    sample: bodyOfSample(spec.sample),
  }))

function loadClient(t) {
  const dom = setupDom({ scripts: true })
  dom.window.document.documentElement.dataset.theme = 'light'
  let client
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      client = factory(() => { throw new Error('no react needed') })
    },
  }
  dom.window.eval(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  // routeBlock 默认用全局目录，而它由宿主下发；测试里自己装一份，
  // 结构与宿主 /renderers.json 一致（byLanguage 是 Map —— 客户端就是这么建的）。
  const byLanguage = new Map()
  for (const spec of renderers) for (const language of spec.languages) byLanguage.set(String(language).toLowerCase(), spec.id)
  client.internals.setCatalogue({
    renderers: renderers.map((spec) => ({ ...spec, enabled: true })),
    byLanguage,
    behavior: {},
  })
  t.after(() => dom.window.close())
  return { dom, client }
}

/** 文档块：外层是四反引号、无语言标签，内容是"```lang + 源码 + ```"。 */
function documentationBlock(language, source) {
  return '```' + language + '\n' + source + '\n```'
}

it('文档块里演示某种栅栏时，没有任何渲染器会把它抢走', (t) => {
  const { client } = loadClient(t)
  const misses = []
  for (const { id, language, sample } of samples) {
    const block = documentationBlock(language, sample)
    const route = client.internals.routeBlock(block, '')
    if (route !== null) misses.push(`${id}（讲 ${language}）被 ${route.id} 抢走，tier=${route.tier}`)
  }
  assert.deepEqual(misses, [], `文档块不该被内容嗅探抢走：\n${misses.join('\n')}`)
})

it('每条示例都能被自己的渲染器接住，且不被别人抢走', (t) => {
  const { client } = loadClient(t)
  const misses = []
  for (const { id, language, sample } of samples) {
    // 契约一：贴上自己的语言标签，必须路由到自己
    const byLanguage = client.internals.routeBlock(sample, language)
    if (byLanguage?.id !== id) {
      misses.push(`${id}：按标签 ${language} 路由得到 ${byLanguage?.id ?? '无人认领'}`)
    }
    // 契约二：就算裸着写（没有标签），也绝不能被别的渲染器抢走。
    // 等距/体素这类按 kind 认的，裸内容本来就该没人认领 —— 那是正确行为，
    // 它们靠语言标签路由；这里只禁止"被抢"。
    const bare = client.internals.routeBlock(sample, '')
    if (bare !== null && bare.id !== id) {
      misses.push(`${id}：裸源码被 ${bare.id} 抢走（tier=${bare.tier}）`)
    }
  }
  assert.deepEqual(misses, [], `示例路由有问题：\n${misses.join('\n')}`)
})

it('按语言标签走时不看内容：语言优先于嗅探', (t) => {
  const { client } = loadClient(t)
  // 拿 metrics 的源码贴一个 mermaid 标签 —— 语言标签说了算
  const metrics = samples.find((item) => item.id === 'metrics')
  const route = client.internals.routeBlock(metrics.sample, 'mermaid')
  assert.equal(route?.id, 'mermaid', '标签是 mermaid 就该交给 mermaid')
  assert.equal(route?.tier, 'language')
})

it('故障原文：那段四反引号块不该被任何渲染器认领', (t) => {
  const { client } = loadClient(t)
  const source = documentationBlock(
    'metrics',
    '{"title":"构建健康度","items":[{"label":"单测","value":"222","unit":"例","tone":"ok","delta":"全绿"}]}',
  )
  for (const language of ['', 'text', 'markdown', 'json']) {
    const route = client.internals.routeBlock(source, language)
    assert.equal(route, null, `语言标签 ${language || '(空)'} 下都不该被认领`)
  }
})

it('metrics 的 detect 认的是读数形状，不是随便一段带 items 的 JSON', (t) => {
  const { client } = loadClient(t)
  const detect = client.internals.ADAPTERS.metrics.detect
  assert.equal(detect('  {"items":[{"label":"x","value":"1"}]}  '), true, '允许前后空白')
  assert.equal(detect('{"items":[1,2,3]}'), false, '没有 label 的 items 不算指标卡')
  assert.equal(detect('{"items":[]}'), false)
  assert.equal(detect('[{"items":[{"label":"x"}]}]'), false, '顶层必须是对象')
  assert.equal(detect('前言\n{"items":[{"label":"x"}]}'), false, '前面有正文就不是 spec')
})
