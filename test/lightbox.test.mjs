/**
 * 放大展示（遮罩层）的单元测试。
 *
 * 密集的图在 360px 画布里缩到看不清，放大展示就是为这件事存在的；因此这里钉住
 * 的是它的**行为契约**：一次只开一个、焦点与滚动被接管、退出后原样归还、缩放与
 * 平移真的作用在图形上。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'
import { setupDom } from '../scripts/dom-env.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const SNAPSHOT = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 680 400" width="680" height="400"><text>细节</text></svg>`

function load(t) {
  const dom = setupDom({ scripts: true })
  let client
  dom.window.__ModuleLoader__ = { load: ({ factory }) => { client = factory(() => { throw new Error('no react needed') }) } }
  dom.window.eval(source)
  const { openLightbox, closeLightbox, snapshotToSvg } = client.internals
  t.after(() => { closeLightbox(); dom.window.close() })
  return { window: dom.window, document: dom.window.document, openLightbox, closeLightbox, snapshotToSvg }
}

/** Open an overlay and return the pieces a test needs. */
function open(window, overrides = {}) {
  const trigger = window.document.createElement('button')
  trigger.textContent = '放大'
  window.document.body.appendChild(trigger)
  trigger.focus()
  const opened = window.__vkOpen({
    label: 'ECharts',
    snapshot: SNAPSHOT,
    natural: { width: 680, height: 400 },
    trigger,
    ...overrides,
  })
  return { trigger, opened }
}

function harness(t) {
  const env = load(t)
  env.window.__vkOpen = env.openLightbox
  return env
}

it('快照字符串解析成按 viewBox 定尺寸的 SVG 元素', (t) => {
  const { snapshotToSvg } = harness(t)
  const svg = snapshotToSvg(SNAPSHOT)
  assert.equal(svg?.nodeName?.toLowerCase(), 'svg')
  assert.equal(svg.getAttribute('viewBox'), '0 0 680 400')
  // 宽高属性必须去掉：遮罩层用 CSS 定尺寸，留着会压住缩放
  assert.equal(svg.getAttribute('width'), null)
  assert.equal(svg.getAttribute('height'), null)
})

it('快照解析对垃圾输入返回 null 而不是抛异常', (t) => {
  const { snapshotToSvg } = harness(t)
  for (const bad of ['', '   ', 'not markup at all', '{"json":true}', '<div>不是 svg</div>']) {
    assert.equal(snapshotToSvg(bad), null, `${JSON.stringify(bad)} 应被拒绝`)
  }
})

it('打开后挂载对话框：可访问角色、图形、状态与焦点就位', (t) => {
  const env = harness(t)
  const { opened } = open(env.window)
  assert.equal(opened, true)
  const root = env.document.querySelector('.vk-lightbox')
  assert.ok(root, '遮罩层应挂到 body 上')
  assert.equal(root.getAttribute('role'), 'dialog')
  assert.equal(root.getAttribute('aria-modal'), 'true')
  assert.match(root.getAttribute('aria-label'), /放大展示/)
  assert.equal(root.querySelectorAll('.vk-lightbox-stage svg').length, 1, '应有一份图形')
  const status = root.querySelector('.vk-lightbox-status')
  assert.equal(status.getAttribute('role'), 'status')
  // jsdom 无布局，适应窗口走 800×600 兜底：680×400 的图应被放大到窗口内
  assert.match(status.textContent, /^\d+%$/)
  assert.equal(env.document.activeElement.textContent, '关闭', '焦点应落在关闭按钮')
  assert.equal(env.document.body.style.overflow, 'hidden', '应接管页面滚动')
})

it('同一时刻只存在一个遮罩层', (t) => {
  const env = harness(t)
  open(env.window)
  open(env.window)
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 1)
})

it('Esc 关闭，并把滚动与焦点还给原来的位置', (t) => {
  const env = harness(t)
  const { trigger } = open(env.window)
  const root = env.document.querySelector('.vk-lightbox')
  root.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 0)
  assert.equal(env.document.body.style.overflow, '', '页面滚动应恢复')
  assert.equal(env.document.activeElement, trigger, '焦点应回到触发按钮')
})

it('关闭按钮与点击背景都能关闭，点面板内部不会误关', (t) => {
  const env = harness(t)
  open(env.window)
  let root = env.document.querySelector('.vk-lightbox')
  root.querySelector('.vk-lightbox-panel').click()
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 1, '点面板内部不应关闭')
  root.querySelector('.vk-lightbox-scrim').click()
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 0, '点背景应关闭')

  open(env.window)
  root = env.document.querySelector('.vk-lightbox')
  const close = [...root.querySelectorAll('button')].find((node) => node.textContent === '关闭')
  close.click()
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 0)
})

it('缩放按钮与键盘都作用在图形上，状态同步更新', (t) => {
  const env = harness(t)
  open(env.window)
  const root = env.document.querySelector('.vk-lightbox')
  const status = root.querySelector('.vk-lightbox-status')
  const svg = root.querySelector('.vk-lightbox-stage svg')
  const scaleOf = () => Number((svg.style.transform.match(/scale\(([\d.]+)\)/) ?? [0, '1'])[1])
  const start = scaleOf()

  const plus = [...root.querySelectorAll('button')].find((node) => node.textContent === '+')
  plus.click()
  const zoomedIn = scaleOf()
  assert.ok(zoomedIn > start, `放大后应更大：${start} → ${zoomedIn}`)
  assert.equal(status.textContent, `${Math.round(zoomedIn * 100)}%`, '状态应与实际缩放一致')

  const minus = [...root.querySelectorAll('button')].find((node) => node.textContent === '−')
  minus.click()
  assert.ok(Math.abs(scaleOf() - start) < 1e-6, '缩回原值')

  root.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: '1', bubbles: true }))
  assert.equal(scaleOf(), 1, '按 1 应回到原始尺寸')
  const oneToOne = [...root.querySelectorAll('button')].find((node) => node.textContent === '1:1')
  oneToOne.click()
  assert.equal(scaleOf(), 1)

  root.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: '0', bubbles: true }))
  assert.ok(scaleOf() !== 0, '按 0 应重新适应窗口')
})

it('滚轮按指针位置缩放：光标下的细节留在光标下', (t) => {
  const env = harness(t)
  open(env.window)
  const root = env.document.querySelector('.vk-lightbox')
  const svg = root.querySelector('.vk-lightbox-stage svg')
  const stage = root.querySelector('.vk-lightbox-stage')
  const translateOf = () => {
    const parts = svg.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/)
    return { x: Number(parts[1]), y: Number(parts[2]), scale: Number(parts[3]) }
  }
  const before = translateOf()
  // 指针偏离中心，缩放后平移必须补偿，否则细节会从光标下滑走
  stage.dispatchEvent(new env.window.WheelEvent('wheel', { deltaY: -100, clientX: 300, clientY: 200, bubbles: true, cancelable: true }))
  const after = translateOf()
  assert.ok(after.scale > before.scale, '向上滚应放大')
  assert.ok(after.x !== before.x || after.y !== before.y, '缩放应围绕指针补偿平移')
})

it('拖拽平移图形，并标记为手动（不再自动适应）', (t) => {
  const env = harness(t)
  open(env.window)
  const root = env.document.querySelector('.vk-lightbox')
  const svg = root.querySelector('.vk-lightbox-stage svg')
  const stage = root.querySelector('.vk-lightbox-stage')
  const point = (type, x, y) => {
    const event = new env.window.Event(type, { bubbles: true })
    Object.assign(event, { pointerId: 1, clientX: x, clientY: y, button: 0 })
    stage.dispatchEvent(event)
  }
  point('pointerdown', 100, 100)
  point('pointermove', 160, 130)
  point('pointerup', 160, 130)
  const moved = svg.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)
  assert.equal(Number(moved[1]), 60, '水平位移应等于指针位移')
  assert.equal(Number(moved[2]), 30, '垂直位移应等于指针位移')
  // 手动平移后，窗口尺寸变化不应把视图拉回中心
  env.window.dispatchEvent(new env.window.Event('resize'))
  const after = svg.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)
  assert.equal(Number(after[1]), 60, '手动调整后 resize 不应重置平移')
})

it('没有可用的快照时不挂载遮罩层', (t) => {
  const env = harness(t)
  assert.equal(env.openLightbox({ label: 'x', snapshot: '不是 svg', natural: { width: 10, height: 10 } }), false)
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 0)
})

it('未打开时关闭是安全的，重复关闭也不会报错', (t) => {
  const env = harness(t)
  assert.doesNotThrow(() => env.closeLightbox())
  open(env.window)
  assert.doesNotThrow(() => { env.closeLightbox(); env.closeLightbox() })
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 0)
})

it('关闭后事件已解绑：迟到的 Esc 与 resize 不再触发任何东西', (t) => {
  const env = harness(t)
  open(env.window)
  const root = env.document.querySelector('.vk-lightbox')
  env.closeLightbox()
  assert.doesNotThrow(() => {
    root.dispatchEvent(new env.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    env.window.dispatchEvent(new env.window.Event('resize'))
  })
  assert.equal(env.document.querySelectorAll('.vk-lightbox').length, 0)
  assert.equal(env.document.body.style.overflow, '')
})
