/**
 * 反馈修复：走宿主后台子代理，不新建可见会话。
 *
 * 用户点的是「上报」，不是「在这个会话里起一个任务」——所以修复在后台跑，结论直接
 * 回卡片；这里用一个假的 sessions 服务钉住"绝不分叉"，不需要真的起 agent。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'

/** 假的 sessions 服务：记录 fork 与 prompt 的每一次调用。 */
function fakeSessions(options = {}) {
  const calls = { forked: [], prompted: [], used: [] }
  return {
    calls,
    fork: async (request) => {
      calls.forked.push(request)
      if (options.forkFails === true) throw new Error('fork 不可用')
      return options.childId ?? 'session-child-1'
    },
    using: async (target, _opts, operation) => {
      calls.used.push(String(target))
      const prompt = async (content, delivery) => {
        calls.prompted.push({ target: String(target), content, delivery })
        return options.promptResult ?? { ok: true }
      }
      return operation({ binding: { session: { prompt } } })
    },
  }
}

function loadClient(t, sessions) {
  const dom = setupDom({ scripts: true })
  let client
  dom.window.__ModuleLoader__ = { load({ factory }) { client = factory(() => { throw new Error('no react') }) } }
  dom.window.eval(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  const kit = client.internals
  kit.dom = dom
  kit.setCurrentSessionId('session-main')
  if (sessions !== undefined) kit.setClientCtx({ get: (name) => (name === 'sessions' ? sessions : undefined) })
  t.after(() => dom.window.close())
  return kit
}

it('后台修复：POST /repair 带上会话与提示词，返回子代理文本', async (t) => {
  const kit = loadClient(t)
  const calls = []
  kit.dom.window.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(String(options?.body ?? '{}')) })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { text: '【修正后的源码】\n```mermaid\nflowchart LR\n    A --> B\n```' } }),
    }
  }
  const text = await kit.requestRepair('请修这段')
  assert.match(text, /修正后的源码/)
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/dsh-visual-kit\/repair$/)
  assert.equal(calls[0].body.sessionId, 'session-main')
  assert.equal(calls[0].body.prompt, '请修这段')
})

it('后台修复失败时抛出宿主给的原因，不假装成功', async (t) => {
  const kit = loadClient(t)
  kit.dom.window.fetch = async () => ({
    ok: false,
    status: 501,
    json: async () => ({ ok: false, error: { message: '宿主未提供 subagents 服务' } }),
  })
  await assert.rejects(() => kit.requestRepair('x'), /宿主未提供 subagents 服务/)
})

it('反馈按钮走后台修复，不再 fork 新会话', async (t) => {
  const sessions = fakeSessions({ childId: 'session-fork-42' })
  const kit = loadClient(t, sessions)
  const requests = []
  kit.dom.window.fetch = async (url, options) => {
    if (String(url).includes('/repair')) {
      requests.push(JSON.parse(String(options?.body ?? '{}')))
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: { text: '【修正后的源码】\n```mermaid\nflowchart LR\n    A --> B\n```' } }),
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
  }
  kit.setCatalogue({
    renderers: [{ id: 'mermaid', label: 'Mermaid 图表', languages: ['mermaid'], enabled: true, sample: 'flowchart LR\n    A --> B' }],
    behavior: { selfRepair: true, repairInNewSession: true },
  })
  const doc = kit.dom.window.document
  const host = doc.createElement('div')
  host.dataset.vkLanguage = 'mermaid'
  doc.body.appendChild(host)
  kit.showError(host, '图挂了', 'flowchart LR\n    A --> B', { renderer: 'mermaid', tier: 'language' })
  const card = host.nextElementSibling
  const feedback = [...card.querySelectorAll('button')].find((node) => node.textContent === '反馈并修复')
  assert.ok(feedback, '应当有反馈并修复按钮')
  feedback.click()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(requests.length, 1, '应当请求后台修复')
  assert.equal(sessions.calls.forked.length, 0, '绝不能 fork 新会话')
  assert.equal(sessions.calls.prompted.length, 0, '也不能往任何会话投递')
  assert.ok(card.querySelector('.vk-repair'), '应当原地给出修复建议')
})

it('后台修复没有结论时给「复制修复提示词」兜底', async (t) => {
  const kit = loadClient(t)
  kit.dom.window.fetch = async (url) => {
    if (String(url).includes('/repair')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { text: '我看了看，没什么问题' } }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
  }
  kit.setCatalogue({
    renderers: [{ id: 'mermaid', label: 'Mermaid 图表', languages: ['mermaid'], enabled: true, sample: 'flowchart LR\n    A --> B' }],
    behavior: { selfRepair: true, repairInNewSession: true },
  })
  const doc = kit.dom.window.document
  const host = doc.createElement('div')
  host.dataset.vkLanguage = 'mermaid'
  doc.body.appendChild(host)
  kit.showError(host, '图挂了', 'flowchart LR\n    A --> B', { renderer: 'mermaid', tier: 'language' })
  const card = host.nextElementSibling
  const feedback = [...card.querySelectorAll('button')].find((node) => node.textContent === '反馈并修复')
  feedback.click()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.match(card.textContent, /没有返回可用结果/)
  assert.ok(card.querySelector('.vk-repair-copy'), '应当提供复制修复提示词')
})

/** 造一条 assistant 消息事件。 */
function assistantEvent(text) {
  return { event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } } }
}

it('修复结论：按约定读出修正后的源码，栅栏本身不留进源码', (t) => {
  const kit = loadClient(t)
  const result = kit.readRepairResult([
    assistantEvent('看了一下，是节点文字里的括号没加引号。'),
    assistantEvent('已改好。\n\n【修正后的源码】\n```mermaid\nflowchart LR\n    A["含（括号）的文字"] --> B\n```\n'),
  ])
  assert.equal(result.kind, 'source')
  assert.match(result.source, /flowchart LR/)
  assert.match(result.source, /含（括号）的文字/)
  assert.doesNotMatch(result.source, /```/, '栅栏不该留在源码里')
})

it('修复结论：声明无需改源码时不返回源码', (t) => {
  const kit = loadClient(t)
  const result = kit.readRepairResult([assistantEvent('这是插件的 bug，我改了适配器。\n\n【无需改源码】')])
  assert.equal(result.kind, 'plugin')
  assert.equal(result.source, '')
})

it('修复结论：两个标记都在时，以最后出现的那个为准', (t) => {
  const kit = loadClient(t)
  const sourceLast = kit.readRepairResult([assistantEvent('【无需改源码】\n……想了想还是改源码：\n【修正后的源码】\n```matrix\n{"cases":[{"name":"a","status":"pass"}]}\n```')])
  assert.equal(sourceLast.kind, 'source', '收尾那个才是结论')
  const pluginLast = kit.readRepairResult([assistantEvent('【修正后的源码】\n```matrix\n{}\n```\n再看过之后，其实是插件的问题。\n【无需改源码】')])
  assert.equal(pluginLast.kind, 'plugin')
})

it('修复结论：读不到就返回 null —— 宁可什么都不做，也不猜', (t) => {
  const kit = loadClient(t)
  const cases = [
    ['没有标记', [assistantEvent('我觉得大概是括号的问题，你再看看？')]],
    ['有标记但没有栅栏', [assistantEvent('【修正后的源码】\n就是上面那样。')]],
    ['一条 assistant 消息都没有', [{ event: { type: 'tool/result', data: {} } }]],
    ['空数组', []],
    ['不是数组', null],
  ]
  for (const [label, entries] of cases) assert.equal(kit.readRepairResult(entries), null, label + ' 应当返回 null')
})

it('修复结论：只看 assistant 消息，工具结果不参与', (t) => {
  const kit = loadClient(t)
  const result = kit.readRepairResult([
    assistantEvent('【修正后的源码】\n```metrics\n{"items":[{"label":"a","value":"1"}]}\n```'),
    { event: { type: 'tool/result', data: { content: [{ type: 'text', text: '【无需改源码】' }] } } },
  ])
  assert.equal(result.kind, 'source', '工具结果里的字样不该被当成结论')
})

it('报告修复请求要求改报告内容，而不是让 agent 去修插件', (t) => {
  const kit = loadClient(t)
  const text = kit.reportRepairRequest({
    renderer: 'report', tier: 'content', message: '报告 spec 不是合法 JSON', source: '结论：把这条改成 JSON',
  })
  assert.match(text, /【任务报告修复请求】/)
  assert.match(text, /合法的 report JSON/)
  assert.match(text, /【修正后的源码】/)
  assert.match(text, /```report/)
  assert.doesNotMatch(text, /直接修插件/, '内容错误不能被路由成插件修复')
})

it('「应用并重画」把状态从 failed 放回可渲染状态', (t) => {
  const kit = loadClient(t)
  const doc = kit.dom.window.document
  const host = doc.createElement('div')
  host.dataset.vkLanguage = 'mermaid'
  host.dataset.vkState = 'failed'
  doc.body.appendChild(host)
  const card = doc.createElement('div')
  doc.body.appendChild(card)

  kit.showRepairSuggestion(card, host, 'mermaid', { id: 'mermaid', tier: 'language' }, {
    kind: 'source', source: 'flowchart LR\n    A --> B', text: '',
  })
  const apply = [...card.querySelectorAll('button')].find((node) => node.textContent === '应用并重画')
  assert.ok(apply, '修正后的源码必须给出应用按钮')
  apply.click()

  // 修复前这里会停在 failed，renderBlock 的首行检查直接 return，图永远不出现。
  assert.notEqual(host.dataset.vkState, 'failed', '应用后不能继续停在 failed')
})

it('查看报告在应用内打开 iframe，不要求先下载', (t) => {
  const kit = loadClient(t)
  const doc = kit.dom.window.document
  const ok = kit.openReportViewer({
    html: '<!doctype html><html><body><h1>报告正文</h1></body></html>',
    title: '测试报告',
  })
  assert.equal(ok, true)
  const viewer = doc.querySelector('.vk-report-viewer')
  assert.ok(viewer, '应当挂出报告查看层')
  const frame = viewer.querySelector('iframe')
  assert.equal(frame.title, '测试报告')
  assert.match(frame.getAttribute('srcdoc') ?? '', /报告正文/, '完整 HTML 应当直接进入 iframe')

  const close = [...viewer.querySelectorAll('button')].find((node) => node.textContent === '关闭')
  assert.ok(close)
  close.click()
  assert.equal(doc.querySelector('.vk-report-viewer'), null, '关闭后查看层应被移除')
})

it('右侧栏「报告」标签页：注册类型与正文/标题，打开时带上报告参数', (t) => {
  const kit = loadClient(t)
  const registered = []
  const slots = []
  const opened = []
  const layoutCalls = []
  kit.setClientCtx({
    get: (name) => {
      if (name === 'sidebarRight') return { openTab: (kind, options) => opened.push({ kind, options }) }
      if (name === 'layout') return { openRightbar: (track, fullscreen) => layoutCalls.push({ track, fullscreen }) }
      return undefined
    },
  })
  const handle = kit.registerReportTab({
    inject: (deps, fn) => fn({
      sidebarRightTabs: { register: (definition) => { registered.push(definition); return () => {} } },
      slots: {
        inject: (name, inner) => { slots.push(name); return inner() },
        register: (registration) => { slots.push(registration); return () => {} },
      },
    }),
  })
  assert.ok(handle, '注册应当返回可释放的句柄')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].kind, 'visual-kit-report')
  assert.ok(slots.some((item) => item?.name === 'sidebar.right.pane.tab' && item.key === 'dsh-visual-kit-report'))
  assert.ok(slots.some((item) => item?.name === 'sidebar.right.pane.tab.title' && item.key === 'dsh-visual-kit-report'))

  const ok = kit.openReportSidebarTab({ reportId: 'r1', url: '/dsh-visual-kit/reports/r1', title: '报告 A' })
  assert.equal(ok, true)
  assert.equal(opened.length, 1)
  assert.equal(opened[0].kind, 'visual-kit-report')
  assert.equal(opened[0].options.params.reportId, 'r1')
  assert.equal(opened[0].options.params.url, '/dsh-visual-kit/reports/r1')
  assert.equal(opened[0].options.params.title, '报告 A')
  assert.equal(opened[0].options.revealIfOpened, true)
  assert.deepEqual(layoutCalls, [{ track: false, fullscreen: false }])
})

it('老宿主没有右侧栏服务时「查看」降级，不抛错', (t) => {
  const kit = loadClient(t)
  kit.setClientCtx({ get: () => undefined })
  assert.equal(kit.openReportSidebarTab({ reportId: 'r1', url: '/x' }), false)
  assert.equal(kit.registerReportTab({ get: () => undefined }), null)
})

it('报告卡片「查看」会切到报告面板并带上待打开 id', (t) => {
  const kit = loadClient(t)
  const selected = []
  kit.setClientCtx({ get: (name) => (name === 'layout' ? { selectPanel: (id) => selected.push(id) } : undefined) })
  const ok = kit.openReportsPanel('20261022-000000-deadbeef')
  assert.equal(ok, true)
  assert.deepEqual(selected, ['dsh-visual-kit-reports'], '应当切到报告面板')
})

it('已归档的报告优先用宿主路由查看，而不是本地 srcdoc', (t) => {
  const kit = loadClient(t)
  const doc = kit.dom.window.document
  const ok = kit.openReportViewer({ url: '/dsh-visual-kit/reports/20261022-000000-deadbeef', title: '归档报告' })
  assert.equal(ok, true)
  const frame = doc.querySelector('.vk-report-viewer iframe')
  assert.equal(frame.getAttribute('src'), '/dsh-visual-kit/reports/20261022-000000-deadbeef')
  assert.equal(frame.getAttribute('srcdoc'), null, '有宿主路由时不再走 srcdoc')
  doc.querySelector('.vk-report-viewer')?.remove()
})

it('报告修复结果会移除错误卡并把源码放回待渲染状态', (t) => {
  const kit = loadClient(t)
  const doc = kit.dom.window.document
  const host = doc.createElement('div')
  host.dataset.vkState = 'failed'
  doc.body.appendChild(host)
  const card = doc.createElement('div')
  doc.body.appendChild(card)

  kit.applyReportRepair(card, host, '{"title":"x","verdict":"y","status":"done"}')

  assert.equal(card.isConnected, false, '修复后错误卡应当消失')
  assert.notEqual(host.dataset.vkState, 'failed', '源码要重新进入渲染流程')
  assert.equal(host.dataset.vkSource, '{"title":"x","verdict":"y","status":"done"}')
})

it('报告解析失败的错误卡提供后台修复按钮，而不是通用的「反馈并修复」', (t) => {
  const kit = loadClient(t)
  const doc = kit.dom.window.document
  kit.setCatalogue({
    renderers: [{ id: 'report', label: '任务报告', languages: ['report'], enabled: true, sample: '{"title":"x","verdict":"y"}' }],
    behavior: { selfRepair: true, repairInNewSession: true },
  })
  const host = doc.createElement('div')
  host.dataset.vkLanguage = 'report'
  doc.body.appendChild(host)
  kit.showError(host, '报告 spec 不是合法 JSON', '结论：这不是 JSON', { renderer: 'report', tier: 'content' })
  const card = host.nextElementSibling
  assert.ok(card !== null)
  assert.match(card.textContent, /后台修复这份报告/)
  assert.doesNotMatch(card.textContent, /反馈并修复/)
})
