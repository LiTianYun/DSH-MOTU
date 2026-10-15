import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'
import { setupDom } from '../scripts/dom-env.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))

function stage(t, { timeout = 15_000, width = 600 } = {}) {
  const dom = setupDom({ scripts: true })
  const { window } = dom
  let currentWidth = width
  const observers = new Set()
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.add(this) }
    observe() {}
    disconnect() { observers.delete(this) }
  }
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: currentWidth, height: 328, top: 0, left: 0, right: currentWidth, bottom: 328 })
  let client
  window.__ModuleLoader__ = { load({ factory }) { client = factory(() => ({ createElement() {}, useRef: () => ({ current: null }), useState: v => [v, () => {}], useEffect() {} })) } }
  // Shorten only the clock in timeout tests; exercise the shipped pipeline.
  const testSource = source.replace('const DISPLAY_TIMEOUT_MS = 15_000', `const DISPLAY_TIMEOUT_MS = ${timeout}`)
    .replace('return module.exports', `exports.testing = { scan, displays, managedHandle, validateInteractiveSource, renderEnv, loadScript, clipUtf8, disposeDisplay,
      setCatalogue(value) { catalogue = value },
      async drain() { while(renderJobs.size) await Promise.allSettled([...renderJobs]) }
    }; return module.exports`)
  window.eval(testSource)
  const spec = { id: 'echarts', label: 'ECharts', enabled: true, languages: ['echarts', 'echarts-interactive'], settings: { interactive: true } }
  const cat = { renderers: [spec], byLanguage: new Map(spec.languages.map(l => [l, spec.id])), behavior: { lazyRender: false }, presentation: {} }
  client.testing.setCatalogue(cat)
  const realMount = client.internals.ADAPTERS.echarts.mount
  const staticRender = async () => ({ markup: '<svg viewBox="0 0 200 100"><text>静态图</text></svg>' })
  client.internals.ADAPTERS.echarts.render = staticRender
  let disposed = 0, mounted = 0, resized = 0
  client.internals.ADAPTERS.echarts.mount = async () => {
    mounted++
    return { resize() { resized++ }, reset() {}, snapshot: () => ({ data: '<svg></svg>', mimeType: 'image/svg+xml', extension: 'svg' }), dispose() { disposed++ } }
  }
  function block(language = 'echarts-interactive', text = '{"series":[{"type":"bar","data":[1,2]}]}') {
    const node = window.document.createElement('pre')
    node.innerHTML = `<code class="language-${language}"></code>`
    node.firstChild.textContent = text
    window.document.body.appendChild(node)
    return node
  }
  const api = client.testing
  t.after(() => { for (const [node] of api.displays) api.disposeDisplay(node); dom.window.close() })
  return { window, client, api, cat, spec, block, observers, staticRender, realMount,
    counts: () => ({ disposed, mounted, resized }),
    resize(value) { currentWidth = value; for (const observer of [...observers]) observer.callback() },
  }
}

it('通用句柄销毁幂等，销毁后不再执行操作', t => {
  const { api } = stage(t)
  let calls = 0, disposed = 0
  const handle = api.managedHandle({ reset() { calls++ }, dispose() { disposed++ } })
  handle.reset(); handle.dispose(); handle.dispose(); handle.reset()
  assert.equal(calls, 1); assert.equal(disposed, 1)
  assert.throws(() => api.managedHandle({}), /句柄/)
})

it('旧语法静态，新语法挂载动态句柄并按能力显示操作', async t => {
  const { api, block, window, counts } = stage(t)
  block('echarts'); block()
  await api.scan(); await api.drain()
  assert.equal(counts().mounted, 1)
  const figures = window.document.querySelectorAll('.vk-figure')
  assert.equal(figures[0].dataset.vkMode, 'static')
  assert.equal(figures[1].dataset.vkMode, 'interactive')
  assert.equal(figures[1].dataset.vkDisplayState, 'ready')
  assert.ok([...figures[1].querySelectorAll('[data-vk-action="scale"]')].every(b => b.hidden))
  assert.equal(figures[1].querySelector('[data-vk-action="snapshot"]').disabled, false)
  figures[1].__vkHandle.reset = () => { throw new Error('重置异常') }
  figures[1].querySelector('[data-vk-action="reset"]').click()
  await tick()
  assert.match(figures[1].querySelector('.vk-status').textContent, /操作失败.*重置异常/)
})

it('交互开关关闭时静态展示，不尝试挂载', async t => {
  const { api, spec, block, counts } = stage(t)
  spec.settings.interactive = false
  const node = block()
  await api.scan(); await api.drain()
  assert.equal(counts().mounted, 0)
  assert.equal(node.nextElementSibling.dataset.vkDisplayState, 'fallback')
  assert.match(node.nextElementSibling.querySelector('.vk-fallback').textContent, /已关闭/)
})

it('源码替换和关闭总开关均释放实例、恢复源码', async t => {
  const { api, cat, block, counts, observers } = stage(t)
  const node = block()
  await api.scan(); await api.drain()
  node.firstChild.textContent = '{"series":[]}'
  await api.scan(); await api.drain()
  assert.equal(counts().disposed, 1)
  cat.behavior.autoRender = false
  await api.scan(); await api.drain()
  assert.equal(counts().disposed, 2)
  assert.equal(observers.size, 0)
  assert.notEqual(node.style.display, 'none')
})

it('会话切换和主题切换使旧动态实例失效', async t => {
  const { api, client, window, block, counts } = stage(t)
  block(); await api.scan(); await api.drain()
  client.internals.SessionProbe({ sessionId: 'next-session' })
  await tick(); await api.scan(); await api.drain()
  assert.equal(counts().disposed, 1)
  window.document.documentElement.dataset.theme = 'dark'
  await api.scan(); await api.drain()
  assert.equal(counts().disposed, 2)
  assert.equal(window.document.querySelector('.vk-figure').dataset.vkTheme, 'dark')
})

it('零宽容器延迟挂载，尺寸恢复后挂载并响应 resize', async t => {
  const { api, block, counts, resize } = stage(t, { width: 0 })
  block(); await api.scan(); await tick()
  assert.equal(counts().mounted, 0)
  resize(600); await api.drain()
  assert.equal(counts().mounted, 1)
  const previous = counts().resized
  resize(375)
  assert.ok(counts().resized > previous)
})

it('挂载期间取消，迟到句柄释放且不回写', async t => {
  const { api, client, block, window } = stage(t)
  let finish, disposed = 0
  client.internals.ADAPTERS.echarts.mount = () => new Promise(resolve => { finish = resolve })
  const node = block(); await api.scan(); await tick()
  node.remove(); api.disposeDisplay(node)
  finish({ dispose() { disposed++ } }); await api.drain(); await tick()
  assert.equal(disposed, 1)
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 0)
})

it('初始化超时仅降级一次，迟到句柄也释放', async t => {
  const { api, client, block } = stage(t, { timeout: 10 })
  let finish, fallback = 0, disposed = 0
  client.internals.ADAPTERS.echarts.mount = () => new Promise(resolve => { finish = resolve })
  client.internals.ADAPTERS.echarts.render = async () => { fallback++; return { markup: '<svg></svg>' } }
  const node = block(); await api.scan(); await api.drain()
  assert.equal(fallback, 1)
  const figure = node.nextElementSibling
  assert.equal(figure.dataset.vkDisplayState, 'fallback')
  assert.match(figure.__vkFailure.message, /超时/)
  assert.equal(figure.querySelector('[data-vk-action="reset"]').getAttribute('aria-label'), '适应画布')
  finish({ dispose() { disposed++ } }); await tick()
  assert.equal(disposed, 1)
  await api.scan(); await api.drain()
  assert.equal(fallback, 1)
})

it('旧任务取消后不会销毁已经开始的新任务', async t => {
  const { api, client, block, window } = stage(t)
  let finishOld, mounted = 0, disposedOld = 0, disposedNew = 0
  client.internals.ADAPTERS.echarts.mount = () => {
    mounted++
    if (mounted === 1) return new Promise(resolve => { finishOld = resolve })
    return Promise.resolve({ dispose() { disposedNew++ } })
  }
  const node = block(); await api.scan(); await tick()
  node.firstChild.textContent = '{"series":[]}'
  await api.scan(); await api.drain()
  assert.equal(node.nextElementSibling.dataset.vkDisplayState, 'ready')
  assert.equal(disposedNew, 0)
  finishOld({ dispose() { disposedOld++ } }); await tick()
  assert.equal(disposedOld, 1)
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 1)
})

it('挂载失败保留原始阶段；静态降级再次失败保留源码', async t => {
  const { api, client, block } = stage(t)
  let fallback = 0
  client.internals.ADAPTERS.echarts.mount = async () => { throw new Error('挂载失败') }
  client.internals.ADAPTERS.echarts.render = async () => { fallback++; throw new Error('静态失败') }
  const node = block(); await api.scan(); await api.drain()
  assert.equal(fallback, 1)
  assert.equal(node.dataset.vkState, 'failed')
  assert.notEqual(node.style.display, 'none')
  assert.match(node.nextElementSibling.textContent, /挂载失败.*静态失败/)
  assert.equal(api.displays.size, 0)
})

it('独立测量容器不会清除另一个展示的内容', t => {
  const { api, spec } = stage(t)
  const first = api.renderEnv(spec, {})
  const second = api.renderEnv(spec, {})
  const a = first.container(), b = second.container()
  a.textContent = 'A'; b.textContent = 'B'
  first.clearContainer()
  assert.equal(b.textContent, 'B'); assert.equal(b.isConnected, true)
  first.dispose(); second.dispose()
  assert.equal(b.isConnected, false)
})

it('无效或超限配置在挂载和静态降级前拒绝', async t => {
  const { api, client, block } = stage(t)
  let renders = 0
  client.internals.ADAPTERS.echarts.render = async () => { renders++; return { markup: '<svg></svg>' } }
  block('echarts-interactive', JSON.stringify({ series: [{ data: Array(10001).fill(1) }] }))
  await api.scan(); await api.drain()
  assert.equal(renders, 0)
  assert.throws(() => api.validateInteractiveSource('[]'), /顶层/)
  assert.throws(() => api.validateInteractiveSource('{"x":"' + '中'.repeat(100000) + '"}'), /256 KiB/)
  assert.throws(() => api.validateInteractiveSource('{"dataset":{"source":"https://example.com/data"}}'), /内联/)
  for(const value of ['{"symbol":"image://https://example.com/x.png"}', '{"graphic":{"style":{"image":"x.png"}}}', '{"__proto__":{}}']) {
    assert.throws(() => api.validateInteractiveSource(value))
  }
  assert.throws(() => api.validateInteractiveSource(JSON.stringify({ dataset: { source: { a: Array(10001).fill(0) } } })), /10,000/)
  assert.throws(() => api.validateInteractiveSource(JSON.stringify({ series: [{ type: 'tree', data: [{ children: Array(10000).fill({ value: 1 }) }] }] })), /10,000/)
  assert.throws(() => api.validateInteractiveSource(JSON.stringify({ baseOption: { series: [{ data: Array(6000).fill(0) }] }, options: [{ series: [{ data: Array(5000).fill(0) }] }] })), /10,000/)
  assert.doesNotThrow(() => api.validateInteractiveSource(JSON.stringify({ series: [{ data: Array(10000).fill(0) }] })))
})

it('诊断截断按 UTF-8 字节，保留明确截断说明', t => {
  const { api, window } = stage(t)
  const result = api.clipUtf8('中'.repeat(10000), 1024)
  assert.ok(new window.Blob([result]).size <= 1024)
  assert.match(result, /源码已截断/)
})

it('失败脚本可重新加载，加载等待有超时且共享一次请求', async t => {
  const { api, window } = stage(t, { timeout: 10 })
  const first = api.loadScript('/failed.js')
  const second = api.loadScript('/failed.js')
  assert.equal(first, second)
  await assert.rejects(first, /超时/)
  assert.equal(window.document.querySelectorAll('script[data-vk-asset]').length, 0)
  const retry = api.loadScript('/failed.js')
  window.document.querySelector('script[data-vk-asset]').dispatchEvent(new window.Event('load'))
  await retry
})

it('真实交互适配器强制各级 richText，取消与销毁只释放一次', async t => {
  const { api, spec, realMount, window } = stage(t)
  const controller = new window.AbortController()
  const env = api.renderEnv(spec, {}, controller.signal)
  let option, disposed = 0
  env.target = window.document.createElement('div')
  env.loadEngine = async () => ({ echarts: { init(target, _theme, config) {
    assert.equal(target, env.target); assert.equal(config.renderer, 'svg'); assert.notEqual(config.ssr, true)
    return { setOption(value, options) { option = value; assert.equal(options.notMerge, true) },
      dispose() { disposed++ }, resize() {}, dispatchAction() {}, renderToSVGString: () => '<svg></svg>' }
  } } })
  const handle = await realMount(JSON.stringify({ animation: true, tooltip: { renderMode: 'html' },
    series: { type: 'bar', tooltip: { renderMode: 'html' }, data: [{ value: 1, tooltip: { renderMode: 'html' } }] } }), env)
  assert.equal(option.animation, false)
  assert.equal(option.tooltip.renderMode, 'richText')
  assert.equal(option.series.tooltip.renderMode, 'richText')
  assert.equal(option.series.data[0].tooltip.renderMode, 'richText')
  assert.equal(handle.snapshot().mimeType, 'image/svg+xml')
  controller.abort(); handle.dispose(); handle.dispose()
  assert.equal(disposed, 1)
  env.dispose()
})
