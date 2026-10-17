import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { it } from 'node:test'
import { setupDom } from '../scripts/dom-env.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
// Exercise private functions without adding to the shipped module's public API.
const source = process.env.MOTU_TEST_BASELINE === '1'
  ? execFileSync('git', ['show', 'HEAD:lib/client.js'], { cwd: root, encoding: 'utf8' })
  : readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const tick = () => new Promise((resolve) => setImmediate(resolve))

function hooks() {
  const values = []
  let cursor = 0
  const effects = []
  return {
    effects,
    reset() { cursor = 0 },
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial
      return [values[index], (next) => { values[index] = typeof next === 'function' ? next(values[index]) : next }]
    },
    useRef(initial) {
      const index = cursor++
      return values[index] ??= { current: initial }
    },
    useCallback: (fn) => fn,
    useEffect: (fn) => effects.push(fn),
  }
}

function load(t) {
  const dom = setupDom({ scripts: true })
  const react = hooks()
  let client
  dom.window.__ModuleLoader__ = { load: ({ factory }) => { client = factory(() => react) } }
  dom.window.eval(source.replace('return module.exports', `
    exports.testing = { scan, candidates, renderBlock, buildFigure, showError, applyScale, copyText, sendFeedback,
      start, stop, refreshCatalogueIfChanged, injectStyles, injectPanelStyles,
      setCatalogue(value) { catalogue = value; catalogueRev = value.rev; diag.enabled = value.renderers.filter(s => s.enabled).map(s => s.id) },
      async drain() { while (renderJobs.size) await Promise.allSettled([...renderJobs]) }
    };
    return module.exports`))
  t.after(() => { client.testing.stop(); dom.window.close() })
  const cat = {
    rev: 'test', presentation: {}, behavior: { lazyRender: false, debounceMs: 10000 },
    renderers: [{ id: 'mermaid', label: 'Mermaid', languages: ['mermaid'], enabled: true, settings: {}, sample: 'flowchart TD\n A --> B' }],
    byLanguage: new Map([['mermaid', 'mermaid']]),
  }
  client.testing.setCatalogue(cat)
  client.internals.ADAPTERS.mermaid.render = async (text) => ({ markup: `<svg viewBox="0 0 200 100"><text>${text}</text></svg>` })
  const block = () => {
    const node = dom.window.document.createElement('pre')
    const code = dom.window.document.createElement('code')
    code.className = 'language-mermaid'
    code.textContent = 'flowchart TD\n A --> B'
    node.appendChild(code)
    dom.window.document.body.appendChild(node)
    return node
  }
  return { window: dom.window, api: client.testing, client, react, cat, block }
}

it('关闭自动渲染后恢复源码，重新开启可再出图', async (t) => {
  const { api, cat, block, window } = load(t)
  const node = block()
  await api.scan(); await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 1)
  cat.behavior.autoRender = false
  await api.scan(); await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 0)
  assert.notEqual(node.style.display, 'none')
  cat.behavior.autoRender = true
  await api.scan(); await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 1)
})

it('流式源码更新替换旧图，重复扫描只产生一张图', async (t) => {
  const { api, block, window } = load(t)
  const node = block()
  await api.scan(); await api.drain()
  node.firstChild.textContent = 'flowchart TD\n A --> C'
  await Promise.all([api.scan(), api.scan()]); await api.drain()
  const figures = window.document.querySelectorAll('.vk-figure')
  assert.equal(figures.length, 1)
  assert.match(figures[0].dataset.vkSource, /C$/)
})

it('引擎返回前源码变化，不插入旧结果，下一次扫描绘制新图', async (t) => {
  const { api, client, block, window } = load(t)
  const node = block()
  let finish
  client.internals.ADAPTERS.mermaid.render = () => new Promise(resolve => { finish = resolve })
  await api.scan(); await tick()
  node.firstChild.textContent = 'flowchart TD\n A --> D'
  finish({ markup: '<svg viewBox="0 0 10 10"></svg>' })
  await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 0)
  assert.notEqual(node.style.display, 'none')
  client.internals.ADAPTERS.mermaid.render = async () => ({ markup: '<svg viewBox="0 0 10 10"></svg>' })
  await api.scan(); await api.drain()
  assert.match(window.document.querySelector('.vk-figure').dataset.vkSource, /D$/)
})

it('绘图期间关闭开关，不隐藏源码或插入失效图', async (t) => {
  const { api, client, cat, block, window } = load(t)
  const node = block()
  let finish
  client.internals.ADAPTERS.mermaid.render = () => new Promise(resolve => { finish = resolve })
  await api.scan(); await tick()
  cat.behavior.autoRender = false
  await api.scan()
  finish({ markup: '<svg></svg>' }); await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 0)
  assert.notEqual(node.style.display, 'none')
})

it('错误示例不被当作新对话块，修正源码后移除错误卡片', async (t) => {
  const { api, client, block, window } = load(t)
  const node = block()
  client.internals.ADAPTERS.mermaid.render = async () => { throw new Error('解析失败') }
  await api.scan(); await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-error').length, 1)
  assert.equal(api.candidates().length, 1)
  node.firstChild.textContent += '\n B --> C'
  client.internals.ADAPTERS.mermaid.render = async () => ({ markup: '<svg></svg>' })
  await api.scan(); await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-error').length, 0)
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 1)
})

it('复制降级抛错也清理临时 textarea，并恢复按钮焦点', async (t) => {
  const { api, window } = load(t)
  const button = window.document.createElement('button')
  window.document.body.appendChild(button); button.focus()
  window.document.execCommand = () => { throw new Error('clipboard unavailable') }
  assert.equal(await api.copyText('source'), false)
  assert.equal(window.document.querySelectorAll('textarea').length, 0)
  assert.equal(window.document.activeElement, button)
})

it('反馈分别报告真实复制和上报结果，不误报复制成功', async (t) => {
  const { api, window } = load(t)
  window.history.replaceState(null, '', '/?token=private-host-token#session')
  window.document.execCommand = () => false
  let payload
  window.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: false } }
  const result = await api.sendFeedback({ source: 'source' })
  assert.equal(result.reported, false)
  assert.equal(result.copied, false)
  assert.equal(payload.href, `${window.location.origin}/`, '反馈不持久化宿主认证查询串或会话 hash')
})

it('适应画布使用实际内边距，缩放后仍留出完整边距', (t) => {
  const { api, client, cat } = load(t)
  cat.presentation = { canvasPadding: 40, canvasMaxHeight: 360 }
  const figure = api.buildFigure({ source: '', spec: cat.renderers[0], tier: 'language' })
  const canvas = figure.querySelector('.vk-canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: 1000 })
  canvas.innerHTML = '<svg viewBox="0 0 800 400"></svg>'
  assert.equal(client.internals.fitScale(figure), .7)
  api.applyScale(figure)
  assert.equal(figure.querySelector('.vk-status').textContent, '70%')
})

it('同一启用集合下总开关变化仍刷新目录', async (t) => {
  const { api, window } = load(t)
  window.fetch = async (url) => ({ ok: true, json: async () => url.endsWith('/config')
    ? { value: { rev: 'test', enabled: ['mermaid'], settings: { autoRender: false } } }
    : { rev: 'test', renderers: [], behavior: { autoRender: false } } })
  assert.equal(await api.refreshCatalogueIfChanged(), true)
})

it('卸载删除 focus 监听和失败状态，重新加载可以重试', async (t) => {
  const { api, window, block } = load(t)
  const node = block()
  node.dataset.vkState = 'failed'
  let requests = 0
  window.fetch = async () => { requests++; return { ok: false } }
  api.start(); await tick(); api.stop()
  const before = requests
  window.dispatchEvent(new window.Event('focus')); await tick()
  assert.equal(requests, before)
  assert.equal(node.dataset.vkState, undefined)
})

function walk(element) {
  if (!element || typeof element !== 'object') return []
  if (Array.isArray(element)) return element.flatMap(walk)
  return [element, ...(element.children ?? []).flatMap(walk)]
}

it('卸载时队列中的任务不会重新绘图或隐藏源码', async (t) => {
  const { api, client, block, window } = load(t)
  const first = block()
  const second = block()
  let finish
  window.fetch = async () => ({ ok: true, json: async () => ({}) })
  api.start()
  client.internals.ADAPTERS.mermaid.render = () => new Promise(resolve => { finish = resolve })
  await api.scan(); await tick()
  api.stop()
  finish({ markup: '<svg></svg>' }); await api.drain()
  assert.equal(window.document.querySelectorAll('.vk-figure').length, 0)
  assert.notEqual(first.style.display, 'none')
  assert.notEqual(second.style.display, 'none')
})

it('错误反馈防止重复上报，失败时保留真实结果并允许重试', async (t) => {
  const { api, cat, block, window } = load(t)
  const node = block()
  cat.behavior.selfRepair = false
  let calls = 0
  let finish
  window.document.execCommand = () => false
  window.fetch = () => { calls++; return new Promise(resolve => { finish = resolve }) }
  api.showError(node, '解析失败', 'source', { renderer: 'mermaid' })
  const card = node.nextElementSibling
  const button = card.querySelector('button')
  button.click(); button.click()
  assert.equal(calls, 1)
  assert.equal(button.disabled, true)
  finish({ ok: false }); await tick()
  assert.match(card.querySelector('.vk-error-status').textContent, /复制和上报均失败/)
  assert.equal(button.disabled, false)
})

it('设置页同一帧重复操作只保存一次，保存中禁用全部总开关', async (t) => {
  const { api, client, react, cat, window } = load(t)
  let writes = 0
  let finish
  window.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      writes++
      await new Promise(resolve => { finish = resolve })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    return { ok: true, json: async () => _url.endsWith('/config')
      ? { value: { settings: { autoRender: true } } } : cat }
  }
  client.internals.CapabilityPanel(); react.effects[0]()
  await tick(); await tick()
  react.reset()
  let tree = client.internals.CapabilityPanel()
  const row = walk(tree).find(e => e.type?.name === 'SwitchRow')
  assert.ok(row)
  const first = row.props.onToggle()
  const second = row.props.onToggle()
  assert.equal(writes, 1)
  react.reset(); tree = client.internals.CapabilityPanel()
  assert.ok(walk(tree).filter(e => e.type?.name === 'SwitchRow').every(e => e.props.busy))
  finish(); await Promise.all([first, second]); await api.drain()
})

it('设置加载失败显示可操作的重试按钮', async (t) => {
  const { client, react, window } = load(t)
  window.fetch = async () => { throw new Error('offline') }
  client.internals.CapabilityPanel(); react.effects[0]()
  await tick(); await tick(); react.reset()
  const tree = client.internals.CapabilityPanel()
  assert.ok(walk(tree).some(e => e.props?.role === 'alert'))
  assert.ok(walk(tree).some(e => e.type === 'button' && e.children.includes('重新读取')))
})

it('Mermaid 语法错误提示点名旗形节点的括号配对', async (t) => {
  // 真实失败现场：把方括号塞进了左开口的旗形（web>["文字"]），整张图变成
  // Parse error。卡片必须直接说出这一条，而不是只复述解析器的行号。
  const { api, block } = load(t)
  const node = block()
  api.showError(node, 'Parse error on line 14:', 'flowchart TB\n  web>["网页 http://x:8080<br/>看状态"]', { renderer: 'mermaid' })
  const hint = node.nextElementSibling.querySelector('.vk-error-hint')
  assert.ok(hint, '语法错误必须给出修复提示')
  assert.ok(hint.textContent.includes('id>["文字"]'), '要点名把方括号塞进旗形这一写法')
  assert.ok(hint.textContent.includes('id["文字"]'), '要给出正确写法')
  assert.ok(hint.textContent.includes('A["文字（含括号）"]'), '节点文字加引号的规则不能丢')
})

it('fixHint 只在语法类错误时给语法提示，其他错误回退到该引擎的一行说明', async (t) => {
  const { client } = load(t)
  const { fixHint } = client.internals
  const mermaid = { id: 'mermaid', syntaxHint: '首行必须是图表类型关键字' }
  assert.match(fixHint(mermaid, 'Parse error on line 14:'), /旗形/)
  assert.match(fixHint(mermaid, 'Lexical error on line 2'), /旗形/)
  assert.equal(fixHint(mermaid, 'engine not loaded'), '首行必须是图表类型关键字')
  assert.match(fixHint({ id: 'graphviz', syntaxHint: 'dot 说明' }, 'syntax error in line 3'), /引号/)
})

it('绘图方式点选即保存，兼容旧数值，失败保留原选项并允许重试', async t => {
  const { api, block, client, react, cat, window } = load(t)
  let saved = 77, rejectWrite = false
  const writes = []
  window.fetch = async (url, options) => {
    if (options?.method === 'POST' && url.endsWith('/config')) {
      const patch = JSON.parse(options.body); writes.push(patch)
      if (!rejectWrite) saved = patch.agent.svgPreference
      return { ok: !rejectWrite, status: rejectWrite ? 503 : 200, json: async () => ({ ok: !rejectWrite, error: { message: '写入失败' } }) }
    }
    return { ok: true, json: async () => url.endsWith('/config') ? { value: { settings: { autoRender: true, svgPreference: saved } } } : cat }
  }
  const node = block()
  api.start(); await tick(); await api.scan(); await api.drain()
  const figure = node.nextElementSibling
  assert.equal(figure.classList.contains('vk-figure'), true)
  const panel = () => { react.reset(); return walk(client.internals.CapabilityPanel()) }
  panel(); react.effects[0](); await tick(); await tick()
  let tree = panel()
  const radio = mode => tree.find(node => node.type === 'input' && node.props.type === 'radio' && node.props.value === mode)
  assert.equal(radio('svg').props.checked, true, '旧数值归入相应的命名模式')
  assert.equal(tree.filter(node => node.type === 'input' && node.props.type === 'radio').length, 3)
  assert.equal(tree.some(node => node.type === 'input' && node.props.type === 'range'), false)
  const selectAuto = radio('auto').props.onChange
  const pending = selectAuto()
  tree = panel()
  assert.ok(['auto', 'standard', 'svg'].every(mode => radio(mode).props.disabled))
  await selectAuto()
  assert.equal(writes.length, 1, '保存期间重复操作不应再次写入')
  await pending
  tree = panel()
  assert.deepEqual(writes[0], { agent: { svgPreference: 50 } })
  assert.equal(radio('auto').props.checked, true)
  await radio('svg').props.onChange(); tree = panel()
  assert.equal(saved, 80)
  assert.equal(radio('svg').props.checked, true)
  assert.equal(node.nextElementSibling, figure, '仅保存生成偏好不应重建已有图表')
  rejectWrite = true
  await radio('standard').props.onChange(); tree = panel()
  assert.equal(saved, 80)
  assert.equal(radio('svg').props.checked, true, '写入失败不能显示成已保存的新选项')
  assert.equal(radio('standard').props.disabled, false)
  assert.ok(tree.some(node => node.props?.role === 'alert'))
  rejectWrite = false
  await radio('standard').props.onChange(); tree = panel()
  assert.equal(saved, 20)
  assert.equal(radio('standard').props.checked, true)
  assert.equal(tree.some(node => node.props?.role === 'alert'), false)
})
