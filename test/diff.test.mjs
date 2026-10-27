/**
 * 代码差异（diff）渲染器。
 *
 * 聊天里的 ```diff 围栏原本是单色文本（核心主题没有 markup.inserted /
 * deleted 规则，前端也没有 unified diff 解析器），这个渲染器补的就是那块。
 * 钉四件事：
 *   1. 契约：文件路径、增删行、行号都要真的画出来；
 *   2. 统计由渲染器数，不让模型自己算；
 *   3. 识别只认结构化 diff —— markdown 分割线、列表、JSON 不许被抢；
 *   4. 没有空色（通用守卫，与指标卡同一条）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const spec = renderers.find((item) => item.id === 'diff')

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
    nextId: () => 'diff-test',
  }
}

async function draw(client, source) {
  return client.internals.ADAPTERS.diff.render(source, env())
}

const SAMPLE = `--- a/user/main.c
+++ b/user/main.c
@@ -17,7 +17,7 @@
 #ifdef TEMP_100K
-    #define _VER_    "10A1"
+    #define _VER_    "10A3"
 #else
-    #define _VER_    "1001"
+    #define _VER_    "1003"
 #endif`

it('代码差异产出合法 XML，路径、增删行与行号都在', async (t) => {
  const { dom, client } = loadClient(t)
  const { markup } = await draw(client, SAMPLE)
  const parsed = new dom.window.DOMParser().parseFromString(markup, 'image/svg+xml')
  assert.equal(parsed.querySelector('parsererror'), null, '产物必须是合法 XML')
  assert.match(markup, /user\/main\.c/, '文件路径要在')
  assert.match(markup, /10A3/, '新增行内容要在')
  assert.match(markup, /10A1/, '删除行内容要在')
  assert.match(markup, /role="img"/)
})

it('行号取自 hunk 头，删行用旧号、增行用新号', async (t) => {
  const { client } = loadClient(t)
  const { markup } = await draw(client, SAMPLE)
  // @@ -17,7 +17,7 @@：17 是上下文，18 是第一条改动
  for (const number of ['17', '18', '19', '20', '21']) {
    assert.ok(markup.includes(`>${number}</text>`), `行号 ${number} 要在`)
  }
})

it('增删统计由渲染器数，模型不用自己算', async (t) => {
  const { client } = loadClient(t)
  const { markup } = await draw(client, SAMPLE)
  assert.match(markup, /\+2 −2/, '2 增 2 删要自动统计')
  assert.doesNotMatch(markup, /\+3/)
})

it('多个文件各给一个文件头，路径都写出来', async (t) => {
  const { client } = loadClient(t)
  const source = [
    'diff --git a/a.c b/a.c',
    '@@ -1 +1 @@',
    '-int a;',
    '+int a = 1;',
    'diff --git a/b.c b/b.c',
    '@@ -1 +1 @@',
    '-int b;',
    '+int b = 1;',
  ].join('\n')
  const { markup } = await draw(client, source)
  assert.match(markup, /a\.c/)
  assert.match(markup, /b\.c/)
  assert.match(markup, /2 个文件/, '<title> 要说清文件数')
})

it('没有 @@ 的手写片段照样上色，但不猜行号', async (t) => {
  const { client } = loadClient(t)
  const source = `--- a/x.c
+++ b/x.c
 #ifdef TEMP
-    old
+    next`
  const { markup } = await draw(client, source)
  assert.match(markup, /next/)
  assert.doesNotMatch(markup, />17</, '没有 hunk 头就不该编出行号')
})

it('超长行截断成省略号，不撑破卡片宽度', async (t) => {
  const { client } = loadClient(t)
  const long = 'x'.repeat(400)
  const { markup } = await draw(client, `@@ -1 +1 @@
-${long}
+${long}y`)
  assert.match(markup, /…/, '过长要截断')
  assert.doesNotMatch(markup, new RegExp(long.slice(0, 120)), '整行不该原样塞进去')
})

it('超出行数上限时截断并说明，不让卡片无限长', async (t) => {
  const { client } = loadClient(t)
  const lines = ['@@ -1,300 +1,300 @@']
  for (let index = 0; index < 300; index += 1) lines.push(` context ${index}`)
  const { markup } = await draw(client, lines.join('\n'))
  assert.match(markup, /其余 \d+ 行未显示/)
})

it('识别只认结构化 diff，不抢别人的活', (t) => {
  const { client } = loadClient(t)
  const detect = client.internals.ADAPTERS.diff.detect
  assert.equal(detect(SAMPLE), true)
  assert.equal(detect('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b'), true)
  assert.equal(detect('flowchart TD\n    A --> B'), false, 'Mermaid 不该被抢')
  assert.equal(detect('{"cases":[{"name":"x"}]}'), false, '矩阵不该被抢')
  // markdown 分割线 + 列表：最像 diff 的假货
  assert.equal(detect('---\ntitle: x\n---\n- 一条\n+ 另一条'), false, 'front matter 不该被抢')
  assert.equal(detect('--- a/x\n+++ b/x'), false, '没有改动行就不是 diff')
})

it('认不出 diff 行时给明确错误，不静默画空卡', async (t) => {
  const { client } = loadClient(t)
  await assert.rejects(() => draw(client, '这里只是普通文字'), /没有可识别的 diff 行/)
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
