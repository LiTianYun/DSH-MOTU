/**
 * 反馈修复的投递目标。
 *
 * 用户点的是「上报」，不是「在这个会话里起一个任务」——所以默认要开一个新会话去修，
 * 本会话的历史与上下文都不受影响。这里用一个假的 sessions 服务把"去了哪"钉住，
 * 不需要真的起 agent。
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

it('新会话模式：先 fork，再只往新会话投递，本会话一个字都不进', async (t) => {
  const sessions = fakeSessions({ childId: 'session-fork-42' })
  const kit = loadClient(t, sessions)

  const result = await kit.deliverRepair('修插件', true)

  assert.equal(result.target, '新会话')
  assert.equal(result.id, 'session-fork-42')
  assert.equal(sessions.calls.forked.length, 1, '应当 fork 一次')
  assert.equal(sessions.calls.forked[0].sessionId, 'session-main', 'fork 的源是本会话')
  assert.equal(sessions.calls.forked[0].allowMigration, false, '必须是复制，不能迁移源会话')
  assert.deepEqual(sessions.calls.used, ['session-fork-42'], '只使用新会话')
  assert.equal(sessions.calls.prompted.length, 1)
  assert.equal(sessions.calls.prompted[0].target, 'session-fork-42')
  assert.equal(sessions.calls.prompted[0].delivery, 'queue')
  assert.equal(
    sessions.calls.prompted.some((call) => call.target === 'session-main'),
    false,
    '本会话绝不能被投递',
  )
})

it('本会话模式：只投递本会话，不 fork', async (t) => {
  const sessions = fakeSessions()
  const kit = loadClient(t, sessions)

  const result = await kit.deliverRepair('修插件', false)

  assert.equal(result.target, '本会话')
  assert.equal(sessions.calls.forked.length, 0, '这个模式不该 fork')
  assert.deepEqual(sessions.calls.used, ['session-main'])
})

it('新会话模式失败时不回退到本会话（那正是它要避免的事）', async (t) => {
  const sessions = fakeSessions({ forkFails: true })
  const kit = loadClient(t, sessions)

  await assert.rejects(() => kit.deliverRepair('修插件', true), /fork 不可用/)
  assert.deepEqual(sessions.calls.used, [], '失败后不该往任何会话投递')
  assert.equal(sessions.calls.prompted.length, 0, '失败后不该有投递')
})

it('投递被拒时抛出真实原因，而不是假装成功', async (t) => {
  const sessions = fakeSessions({ promptResult: { ok: false, error: { message: '队列已满' } } })
  const kit = loadClient(t, sessions)

  await assert.rejects(() => kit.deliverRepair('修插件', true), /队列已满/)
})

it('还没拿到会话 id 时明确报错，不去猜一个', async (t) => {
  const sessions = fakeSessions()
  const kit = loadClient(t, sessions)
  kit.setCurrentSessionId('')

  await assert.rejects(() => kit.deliverRepair('修插件', true), /还没拿到本会话 id/)
  assert.equal(sessions.calls.forked.length, 0)
})

it('服务缺失或版本不支持时给出可读的失败，而不是崩在 undefined 上', async (t) => {
  const noService = loadClient(t)
  await assert.rejects(() => noService.deliverRepair('修插件', true), /sessions 服务不可用/)

  const noFork = loadClient(t, { using: async () => {} })
  await assert.rejects(() => noFork.deliverRepair('修插件', true), /不支持开新会话/)
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
