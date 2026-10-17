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
