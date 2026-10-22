/**
 * 坑位清单必须是真的。
 *
 * `fixHint`（lib/client.js）与 `skill/references/*.md` 会告诉读者「这样写会
 * Parse error」。这类说法一旦过期，就会把人指向一个其实已经能用的写法 ——
 * 比不说还糟，因为它把人的注意力从真问题引开。
 *
 * 所以这里用**真引擎**把清单里的每一条跑一遍：说会失败的必须真失败，
 * 说能用的必须真能用。
 *
 * 只覆盖 mermaid：它是唯一有「同一段文字，写法不同则成败相反」这类坑的引擎。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadVendorScript, setupDom } from '../scripts/dom-env.mjs'

const VENDOR = new URL('../vendor/', import.meta.url)

/**
 * 起一个装了 vendored mermaid 的窗口。
 *
 * @param {object} t - the test context.
 * @returns {object} the engine.
 */
function loadMermaid(t) {
  const dom = setupDom({ scripts: true })
  loadVendorScript(dom, fileURLToPath(new URL('mermaid/mermaid.min.js', VENDOR)))
  const mermaid = dom.window.mermaid
  assert.ok(mermaid !== undefined, 'vendored mermaid 应当定义 window.mermaid')
  mermaid.initialize({ startOnLoad: false, theme: 'base' })
  t.after(() => dom.window.close())
  return mermaid
}

/** 一段最小可用的流程图，待测的那一行拼在后面。 */
const HEAD = 'flowchart TB\n    A[开始] --> B[结束]\n'

it('边标签里的裸双引号确实会 Parse error（错误卡片就是这么说的）', async (t) => {
  const mermaid = loadMermaid(t)
  await assert.rejects(
    () => mermaid.parse(`${HEAD}    A -->|标记"完成"| B`),
    /Parse error/i,
    '这条坑位一旦失效，错误卡片就在误导人',
  )
})

it('卡片给出的替代写法都真的能用', async (t) => {
  const mermaid = loadMermaid(t)
  const alternatives = [
    `${HEAD}    A -->|标记完成| B`,
    `${HEAD}    A -->|标记「完成」| B`,
    `${HEAD}    A -->|标记'完成'| B`,
  ]
  for (const source of alternatives) {
    await mermaid.parse(source)
  }
})

it('技能文档与客户端提示讲的是同一件事（只改一处会被抓到）', () => {
  const doc = readFileSync(new URL('../skill/references/mermaid.md', import.meta.url), 'utf8')
  assert.match(doc, /边标签/, 'skill/references/mermaid.md 必须写明边标签里的双引号这一坑')

  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(client, /边标签里有双引号会 Parse error/, 'fixHint 必须写明同一条')
})
