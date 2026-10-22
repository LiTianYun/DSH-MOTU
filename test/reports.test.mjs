/**
 * The local report library.
 *
 * These tests use real files in temporary directories: the store's contract is
 * about where a report lands, what survives a restart, and what refuses to be
 * read or deleted — a mocked filesystem would not prove any of that.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { createReportStore } from '../lib/reports.js'

/**
 * A fresh home + workspace pair removed after the test.
 *
 * @param {object} t - the test context.
 * @returns {{home: string, workspace: string}} the two roots.
 */
function roots(t) {
  const home = mkdtempSync(join(tmpdir(), 'vk-reports-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'vk-reports-ws-'))
  t.after(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })
  return { home, workspace }
}

/** A valid spec and page shared by the cases. */
const SPEC = { title: '测试报告', verdict: '只验证存储', status: 'done' }
const HTML = '<!doctype html><html><body>ok</body></html>'

/**
 * Save one sample report.
 *
 * @param {object} store - the store.
 * @param {string} workspace - the workspace root.
 * @returns {Promise<object>} the save result.
 */
function saveOne(store, workspace) {
  return store.save({
    spec: SPEC,
    html: HTML,
    style: 'motu',
    workspace: { id: 'ws-1', title: '测试工作区', path: workspace },
    sessionId: 'session-1',
  })
}

describe('报告库', () => {
  it('保存到项目、写索引，并能读回与删除', async (t) => {
    const { home, workspace } = roots(t)
    const store = createReportStore({ home, now: () => new Date('2026-10-22T10:00:00.000Z') })

    const saved = await saveOne(store, workspace)
    assert.equal(saved.deduped, false)
    assert.match(saved.entry.id, /^20261022-100000-[0-9a-f]{8}$/)
    assert.equal(saved.entry.root, 'project')
    assert.ok(saved.entry.dir.startsWith(join(workspace, '.dsh', 'visual-kit', 'reports')))
    assert.equal(readFileSync(join(saved.entry.dir, 'report.html'), 'utf8'), HTML)
    assert.equal(JSON.parse(readFileSync(join(saved.entry.dir, 'report.json'), 'utf8')).title, '测试报告')
    assert.ok(statSync(join(home, '.dsh', 'visual-kit', 'reports', 'index.json')).isFile())

    const listed = await store.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].title, '测试报告')
    assert.equal(listed[0].workspace.title, '测试工作区')

    const found = await store.read(saved.entry.id)
    assert.equal(found.html, HTML)
    assert.equal(found.entry.id, saved.entry.id)

    assert.equal(await store.remove(saved.entry.id), true)
    assert.equal((await store.list()).length, 0)
    assert.equal(await store.read(saved.entry.id), null)
  })

  it('同一份 spec + 风格只存一次', async (t) => {
    const { home, workspace } = roots(t)
    const store = createReportStore({ home })
    const first = await saveOne(store, workspace)
    const second = await saveOne(store, workspace)
    assert.equal(first.deduped, false)
    assert.equal(second.deduped, true)
    assert.equal(second.entry.id, first.entry.id)
    assert.equal((await store.list()).length, 1)
  })

  it('同一内容落到不同工作区时各存一份，且不会互相顶掉索引', async (t) => {
    const { home, workspace } = roots(t)
    const other = mkdtempSync(join(tmpdir(), 'vk-reports-ws2-'))
    t.after(() => rmSync(other, { recursive: true, force: true }))
    const store = createReportStore({ home, now: () => new Date('2026-10-22T10:00:00.000Z') })

    const first = await saveOne(store, workspace)
    const second = await store.save({
      spec: SPEC,
      html: HTML,
      style: 'motu',
      workspace: { id: 'ws-2', title: '另一个工作区', path: other },
      sessionId: 'session-2',
    })

    assert.equal(first.deduped, false)
    assert.equal(second.deduped, false)
    assert.notEqual(second.entry.id, first.entry.id, '同一秒、同一内容也要按目的地分开 id')
    assert.ok(second.entry.dir.startsWith(join(other, '.dsh', 'visual-kit', 'reports')))

    const listed = await store.list()
    assert.equal(listed.length, 2)
    assert.deepEqual(listed.map((entry) => entry.id).sort(), [first.entry.id, second.entry.id].sort())
    assert.equal((await store.read(first.entry.id))?.html, HTML)
    assert.equal((await store.read(second.entry.id))?.html, HTML)
  })

  it('并发保存两份报告不会丢掉索引条目', async (t) => {
    const { home, workspace } = roots(t)
    const store = createReportStore({ home })
    const results = await Promise.all([
      store.save({ spec: { ...SPEC, title: '并发一' }, html: HTML, style: 'motu', workspace: { id: 'ws-1', title: '测试工作区', path: workspace }, sessionId: '' }),
      store.save({ spec: { ...SPEC, title: '并发二' }, html: HTML, style: 'motu', workspace: { id: 'ws-1', title: '测试工作区', path: workspace }, sessionId: '' }),
    ])
    assert.equal(results.filter((result) => result.deduped).length, 0)
    assert.equal((await store.list()).length, 2)
  })

  it('没有工作区时回退到用户目录', async (t) => {
    const { home } = roots(t)
    const store = createReportStore({ home })
    const saved = await store.save({ spec: SPEC, html: HTML, style: 'motu', workspace: null, sessionId: '' })
    assert.equal(saved.entry.root, 'home')
    assert.ok(saved.entry.dir.startsWith(join(home, '.dsh', 'visual-kit', 'reports')))
  })

  it('索引丢失后能从 meta.json 重建', async (t) => {
    const { home, workspace } = roots(t)
    const store = createReportStore({ home })
    const saved = await saveOne(store, workspace)
    unlinkSync(join(home, '.dsh', 'visual-kit', 'reports', 'index.json'))

    const rebuiltStore = createReportStore({ home })
    const rebuilt = await rebuiltStore.rebuild([workspace])
    assert.equal(rebuilt.length, 1)
    assert.equal(rebuilt[0].id, saved.entry.id)
    assert.equal((await rebuiltStore.list()).length, 1)
  })

  it('warm 在索引缺失时从项目目录恢复', async (t) => {
    const { home, workspace } = roots(t)
    const store = createReportStore({ home })
    const saved = await saveOne(store, workspace)
    unlinkSync(join(home, '.dsh', 'visual-kit', 'reports', 'index.json'))

    const fresh = createReportStore({ home })
    const count = await fresh.warm([workspace])
    assert.equal(count, 1)
    const listed = await fresh.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, saved.entry.id)
  })

  it('页面丢失的条目不会出现在列表里', async (t) => {
    const { home, workspace } = roots(t)
    const store = createReportStore({ home })
    const saved = await saveOne(store, workspace)
    unlinkSync(join(saved.entry.dir, 'report.html'))

    const fresh = createReportStore({ home })
    assert.equal((await fresh.list()).length, 0)
    assert.equal(await fresh.read(saved.entry.id), null)
  })

  it('拒绝目录穿越与伪造 id', async (t) => {
    const { home, workspace } = roots(t)
    const store = createReportStore({ home })
    const saved = await saveOne(store, workspace)

    assert.equal(await store.read('../../etc/passwd'), null)
    assert.equal(await store.read('../' + saved.entry.id), null)
    assert.equal(await store.remove('../../etc/passwd'), false)
    assert.equal(await store.remove('20260101-000000-deadbeef'), false)
    assert.ok(statSync(join(saved.entry.dir, 'report.html')).isFile(), '被拒绝的删除不能碰真实文件')
  })

  it('meta.json 是重建的唯一事实来源', async (t) => {
    const { home, workspace } = roots(t)
    const root = join(workspace, '.dsh', 'visual-kit', 'reports', '20261022-100000-abcdef12')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'report.html'), HTML)
    writeFileSync(join(root, 'report.json'), JSON.stringify(SPEC))
    writeFileSync(join(root, 'meta.json'), JSON.stringify({
      id: '20261022-100000-abcdef12',
      title: '手工归档',
      round: '第 1 轮',
      status: 'done',
      createdAt: '2026-10-22T10:00:00.000Z',
      hash: 'deadbeef',
      root: 'project',
      dir: root,
      base: join(workspace, '.dsh', 'visual-kit', 'reports'),
      workspace: { title: '测试工作区', path: workspace },
    }))

    const store = createReportStore({ home })
    const rebuilt = await store.rebuild([workspace])
    assert.equal(rebuilt.length, 1)
    assert.equal(rebuilt[0].title, '手工归档')
    assert.equal((await store.read('20261022-100000-abcdef12')).html, HTML)
  })
})
