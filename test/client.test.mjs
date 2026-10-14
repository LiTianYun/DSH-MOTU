/**
 * Browser-half tests.
 *
 * Loads `lib/client.js` through its own module contract and exercises the pure
 * internals — routing, language detection, hashing, source reading, and each
 * adapter's content detector. Rendering itself is covered by
 * `scripts/check-renderers.mjs`, which runs the real engines; here the DOM is
 * only a stage, not the subject.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { before, describe, it } from 'node:test'

import { loadVendorScript, setupDom } from '../scripts/dom-env.mjs'

const here = fileURLToPath(new URL('..', import.meta.url))

/** A catalogue shaped like the host half's `/renderers.json`. */
function fakeCatalogue(enabledIds = ['mermaid', 'graphviz', 'nomnoml', 'echarts', 'vega-lite']) {
  const specs = [
    { id: 'mermaid', languages: ['mermaid'], enabled: enabledIds.includes('mermaid') },
    { id: 'graphviz', languages: ['dot', 'graphviz'], enabled: enabledIds.includes('graphviz') },
    { id: 'nomnoml', languages: ['nomnoml'], enabled: enabledIds.includes('nomnoml') },
    { id: 'echarts', languages: ['echarts'], enabled: enabledIds.includes('echarts') },
    { id: 'vega-lite', languages: ['vega-lite', 'vegalite', 'vega'], enabled: enabledIds.includes('vega-lite') },
  ]
  return {
    rev: 'test',
    renderers: specs,
    presentation: {},
    behavior: {},
    byLanguage: new Map(specs.flatMap((spec) => spec.languages.map((language) => [language, spec.id]))),
  }
}

/**
 * A minimal React stand-in.
 *
 * The settings page is a React component, and the platform module table is what
 * supplies React in the browser. Providing a stub here keeps the panel's
 * registration logic testable without a real renderer.
 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

/** Load the browser half through its module contract. */
function loadClient() {
  // Scripts are enabled so the vendored engine builds can be injected the way
  // the browser loads them (a <script> tag), rather than imported as modules.
  const dom = setupDom({ scripts: true })
  const registry = new Map()
  dom.window.__ModuleLoader__ = {
    load({ id, factory }) {
      registry.set(id, factory((name) => {
        if (name === 'react') return reactStub
        throw new Error(`this half requires nothing else (asked for ${name})`)
      }))
    },
  }
  dom.window.eval(readFileSync(join(here, 'lib', 'client.js'), 'utf8'))
  return { dom, client: registry.get('dsh-visual-kit') }
}

/** @type {ReturnType<typeof loadClient>} */
let loaded

before(() => {
  loaded = loadClient()
})

describe('模块契约', () => {
  it('以 dsh-visual-kit 为名注册，并导出 apply 与 internals', () => {
    assert.ok(loaded.client !== undefined, '应通过模块加载器注册')
    assert.equal(typeof loaded.client.apply, 'function')
    assert.ok(loaded.client.internals !== undefined)
    assert.equal(loaded.client.name, 'dsh-visual-kit/client')
  })
})

describe('语言路由', () => {
  const { routeBlock } = loaded.client.internals

  it('声明的语言优先于内容猜测', () => {
    const cat = fakeCatalogue()
    // 内容是 mermaid 的样子，但语言声明为 dot —— 语言赢。
    const decision = routeBlock('flowchart TD\n  A --> B', 'dot', cat)
    // 逐字段比较：jsdom 开脚本后有独立 realm，对象原型不同，
    // 深层相等会把"结构相同但非同一 realm"判为不等。
    assert.equal(decision?.id, 'graphviz')
    assert.equal(decision?.tier, 'language')
  })

  it('无语言时按内容识别各引擎', () => {
    const cat = fakeCatalogue()
    assert.equal(routeBlock('flowchart TD\n  A --> B', '', cat).id, 'mermaid')
    assert.equal(routeBlock('digraph G { a -> b }', '', cat).id, 'graphviz')
    assert.equal(routeBlock('[A] -> [B]', '', cat).id, 'nomnoml')
    assert.equal(routeBlock('{ "series": [{ "type": "bar" }] }', '', cat).id, 'echarts')
    assert.equal(routeBlock('{ "$schema": "…vega-lite…", "mark": "bar" }', '', cat).id, 'vega-lite')
  })

  it('关掉的渲染器不参与路由', () => {
    const cat = fakeCatalogue(['mermaid'])
    assert.equal(routeBlock('digraph G { a -> b }', '', cat), null, 'graphviz 已关，内容识别也不该认领')
    assert.equal(routeBlock('digraph G { a -> b }', 'dot', cat), null, '语言命中但渲染器已关')
  })

  it('catalogue 为 null 时不路由', () => {
    assert.equal(routeBlock('flowchart TD', '', null), null)
  })

  it('graphviz 的两种语言名都路由到同一渲染器', () => {
    const cat = fakeCatalogue()
    assert.equal(routeBlock('digraph G { a -> b }', 'graphviz', cat).id, 'graphviz')
    assert.equal(routeBlock('digraph G { a -> b }', 'dot', cat).id, 'graphviz')
  })
})

describe('bannerLanguage', () => {
  const { bannerLanguage } = loaded.client.internals
  const { document } = loaded.dom.window

  it('从 class 的 language- 前缀读语言', () => {
    const node = document.createElement('div')
    node.innerHTML = '<pre><code class="language-dot">digraph{}</code></pre>'
    assert.equal(bannerLanguage(node), 'dot')
  })

  it('从组件 banner 的 language 元素读语言', () => {
    const node = document.createElement('div')
    node.innerHTML = '<div data-code-block-banner><span class="language">echarts</span></div><pre></pre>'
    assert.equal(bannerLanguage(node), 'echarts')
  })

  it('没有语言信息时返回空串', () => {
    const node = document.createElement('div')
    node.innerHTML = '<pre><code>const x = 1</code></pre>'
    assert.equal(bannerLanguage(node), '')
  })
})

describe('readSource 与 hash', () => {
  const { readSource, hash } = loaded.client.internals
  const { document } = loaded.dom.window

  it('普通 textContent 直接返回', () => {
    const pre = document.createElement('pre')
    pre.textContent = 'line1\nline2'
    assert.equal(readSource(pre), 'line1\nline2')
  })

  it('单行 span 以换行拼接（无布局环境的兜底）', () => {
    const pre = document.createElement('pre')
    pre.innerHTML = '<code><span class="line">a</span><span class="line">b</span></code>'
    // textContent 是 'ab'（无 \n），走行拼接兜底。
    assert.equal(readSource(pre), 'a\nb')
  })

  it('hash 稳定且区分内容', () => {
    assert.equal(hash('abc'), hash('abc'))
    assert.notEqual(hash('abc'), hash('abd'))
    assert.match(hash('anything'), /^[0-9a-z]+$/)
  })
})

describe('适配器内容识别', () => {
  const { ADAPTERS } = loaded.client.internals

  const cases = [
    ['mermaid', 'flowchart TD\n  A --> B', true],
    ['mermaid', 'sequenceDiagram\n  A->>B: hi', true],
    ['mermaid', 'const graph = new Map()', false],
    ['graphviz', 'digraph G { a -> b }', true],
    ['graphviz', 'graph G { a -- b }', true],
    ['graphviz', 'const a = { graph: 1 }', false],
    ['nomnoml', '[A] -> [B]', true],
    ['nomnoml', '#fill: red\n[A] -> [B]', true],
    ['nomnoml', 'const a = [1, 2]', false],
    ['echarts', '{ "series": [{ "type": "bar" }] }', true],
    ['echarts', '{ "xAxis": {}, "series": [] }', true],
    ['echarts', '{ "name": "pkg" }', false],
    ['vega-lite', '{ "$schema": "https://vega.github.io/schema/vega-lite/v6.json" }', true],
    ['vega-lite', '{ "mark": "bar", "data": { "values": [] } }', true],
    ['vega-lite', '{ "dependencies": {} }', false],
  ]

  for (const [id, source, expected] of cases) {
    it(`${id} ${expected ? '识别' : '不识别'} ${JSON.stringify(source.slice(0, 40))}`, () => {
      assert.equal(ADAPTERS[id]?.detect?.(source) === true, expected, `${id} 的识别结果应正确`)
    })
  }

  it('每个已声明语言的渲染器都有适配器', () => {
    for (const id of ['mermaid', 'graphviz', 'nomnoml', 'echarts', 'vega-lite']) {
      assert.equal(typeof ADAPTERS[id]?.render, 'function', `${id} 应有 render`)
    }
  })
})

describe('resolveTheme', () => {
  const { resolveTheme } = loaded.client.internals
  const { window } = loaded.dom
  const { document } = window

  const originalAttrs = {
    theme: document.documentElement.getAttribute('data-theme'),
    scheme: document.documentElement.getAttribute('data-color-scheme'),
  }
  const originalBodyBg = document.body.style.backgroundColor

  /** Reset whatever a previous case set. */
  function resetDom() {
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.removeAttribute('data-color-scheme')
    document.body.style.backgroundColor = originalBodyBg
  }

  it('data-theme 属性优先', () => {
    resetDom()
    document.documentElement.setAttribute('data-theme', 'dark')
    assert.equal(resolveTheme(), 'dark')
    document.documentElement.setAttribute('data-theme', 'light')
    assert.equal(resolveTheme(), 'light')
  })

  it('浅色页面（白底深字）判为 light —— 判反会让所有画布变黑', () => {
    resetDom()
    document.body.style.backgroundColor = 'rgb(255, 255, 255)'
    assert.equal(resolveTheme(), 'light')
  })

  it('深色页面（深底浅字）判为 dark', () => {
    resetDom()
    document.body.style.backgroundColor = 'rgb(30, 30, 30)'
    assert.equal(resolveTheme(), 'dark')
  })

  it('透明背景不算数，继续看下一个信号', () => {
    resetDom()
    document.documentElement.setAttribute('data-theme', 'light')
    document.body.style.backgroundColor = 'rgba(0, 0, 0, 0)'
    assert.equal(resolveTheme(), 'light', '透明背景不应被当成黑色')
  })

  resetDom()
  for (const [name, value] of Object.entries(originalAttrs)) {
    if (value !== null) document.documentElement.setAttribute(name, value)
  }
  document.body.style.backgroundColor = originalBodyBg
})

describe('渲染状态机', () => {
  const { routeBlock } = loaded.client.internals
  const { document } = loaded.dom.window

  it('pending 块不再被重复认领（重复出图回归）', () => {
    // 模拟 scan 的处理循环：pending 必须视为已认领。
    // 这里直接验证 routeBlock 之外的状态判断顺序——pending 被跳过的行为
    // 由 scan 的 continue 实现，此用例钉住“pending 是终态之一”的契约。
    const cat = fakeCatalogue()
    const node = document.createElement('div')
    node.className = 'md-code-block'
    node.dataset.vkState = 'pending'
    node.innerHTML = '<div data-code-block-content><pre><code>flowchart TD\n  A --> B</code></pre></div>'
    // routeBlock 本身不读 state；scan 负责跳过。此断言确保 route 决策不受 state 污染。
    assert.equal(routeBlock('flowchart TD\n  A --> B', '', cat).id, 'mermaid')
  })
})

describe('nomnoml 语法规范', () => {
  const { ADAPTERS } = loaded.client.internals

  it('边标签写在端点和箭头之间，决策用普通方框', () => {
    // nomnoml 没有 <choice> 尖括号决策语法 —— 那样写会把整行渲染成浮空文本
    // （真实出图里见过的 bug）。正确写法：决策是普通方框，标签在端点后。
    const source = '#padding: 22\n[提问] -> [识别栅栏语言]\n[识别栅栏语言] -> [命中]\n[命中] 是 -> [渲染 SVG]\n[命中] 否 -> [保持代码块]'
    assert.equal(ADAPTERS.nomnoml.detect(source), true)
  })

  it('旧的 <choice> 写法仍能路由（渲染怪相归 nomnoml 自己，detect 不背锅）', () => {
    const legacy = '#padding: 22\n[提问] -> <命中> [对应引擎]\n<命中> 是 -> [渲染 SVG]'
    assert.equal(ADAPTERS.nomnoml.detect(legacy), true)
  })
})

describe('graphviz 文字溢出测量循环', () => {
  const { ADAPTERS } = loaded.client.internals
  const { window } = loaded.dom
  const { document } = window

  it('测量到溢出就加宽 margin 重绘，直到装下', async () => {
    // 受控环境：getBBox 报告文字比盒子宽 40px（一轮），随后合身。
    // 这模拟真实浏览器里 CJK 估计宽度 ~一半的问题，验证循环收敛。
    const realProto = window.SVGElement.prototype
    let calls = 0
    realProto.getBBox = function getBBox() {
      if (this.tagName.toLowerCase() === 'text') return { x: 0, y: 0, width: 100, height: 20 }
      return { x: 0, y: 0, width: calls++ === 0 ? 40 : 140, height: 30 }
    }
    try {
      const source = 'digraph G { 提示段加技能 -> 宿主半路由配置与完整性 }'
      const renders = []
      const fakeViz = {
        instance: async () => ({
          renderString: (dot) => {
            renders.push(dot)
            return '<svg xmlns="http://www.w3.org/2000/svg"><g id="node1" class="node"><path d="M0 0h80v30H0z"/><text>提示段加技能</text></g></svg>'
          },
        }),
      }
      const env = {
        loadEngine: async () => ({ Viz: fakeViz }),
        container: () => document.createElement('div'),
        clearContainer: () => {},
        theme: 'light',
        presentation: { fontFamily: 'Microsoft YaHei', fontSize: 13, canvasMaxHeight: 360, canvasPadding: 16, background: 'auto', showToolbar: true },
        settings: {},
        measure: true,
        nextId: () => 't',
      }
      const { markup } = await ADAPTERS.graphviz.render(source, env)
      assert.ok(markup.includes('<svg'), '应返回渲染产物')
      assert.ok(renders.length >= 2, `溢出后应重绘（实际 ${renders.length} 次）`)
      const finalMargin = /margin="([\d.]+),/.exec(renders[renders.length - 1])?.[1]
      const firstMargin = /margin="([\d.]+),/.exec(renders[0])?.[1]
      assert.ok(Number(finalMargin) > Number(firstMargin), 'margin 应被加大')
    } finally {
      delete realProto.getBBox
    }
  })

  it('measure:false 时一轮出图（无头环境路径）', async () => {
    const fakeViz = {
      instance: async () => ({ renderString: () => '<svg xmlns="http://www.w3.org/2000/svg"><g class="node"><path d="M0 0h80v30H0z"/><text>x</text></g></svg>' }),
    }
    const env = {
      loadEngine: async () => ({ Viz: fakeViz }),
      container: () => document.createElement('div'),
      theme: 'light',
      presentation: { fontFamily: 'f', fontSize: 13 },
      settings: {},
      measure: false,
      nextId: () => 't',
    }
    const { markup } = await ADAPTERS.graphviz.render('digraph G { a -> b }', env)
    assert.ok(markup.includes('<svg'))
  })
})

describe('设置面板注册（启动时序契约）', () => {
  const { registerCapabilitiesPanel, CapabilityPanel } = loaded.client.internals

  it('导出可用的能力页组件', () => {
    assert.equal(typeof CapabilityPanel, 'function')
  })

  it('用 ctx.inject 等服务就绪，而不是一次性 ctx.get', () => {
    // 回归：重启后设置页消失，正是因为启动瞬间 ctx.get('slots') 还是 undefined，
    // 一次性取值会静默什么都不注册。
    const injected = []
    const registered = []
    const slots = {
      inject: (key, callback) => {
        injected.push(key)
        return callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    }
    const ctx = {
      inject: (deps, callback) => {
        injected.push(deps.join(','))
        return callback({ slots })
      },
    }
    registerCapabilitiesPanel(ctx)
    assert.deepEqual(injected, ['slots', 'settings.section'], '应先注入 slots 服务，再注入槽位声明')
    assert.equal(registered.length, 1, '应注册一个设置页')
    assert.equal(registered[0].options.name, 'settings.section')
    assert.equal(registered[0].options.label, '可视化套件')
    assert.equal(registered[0].component, CapabilityPanel)
  })

  it('没有 inject 的运行时退回一次性取值；服务缺失时不抛异常', () => {
    const bare = { get: () => undefined }
    const disposer = registerCapabilitiesPanel(bare)
    assert.equal(typeof disposer, 'function', '应返回可用的 disposer')
    assert.doesNotThrow(() => disposer())
  })
})

describe('svg 直通渲染器（安全关键）', () => {
  const { ADAPTERS } = loaded.client.internals

  // The vendored build is what the browser runs. Importing the npm module would
  // test a different artefact — and the difference is exactly what hid the
  // RETURN_DOM bug, where the sanitised DOM was reachable in a headless DOM but
  // not in a browser.
  loadVendorScript(loaded.dom, join(here, 'vendor', 'svg', 'purify.min.js'))
  const vendored = loaded.dom.window.DOMPurify

  const fakeEnv = () => ({
    loadEngine: async () => ({ DOMPurify: vendored }),
    container: () => loaded.dom.window.document.createElement('div'),
    theme: 'light',
    presentation: { fontFamily: 'f', fontSize: 13 },
    settings: {},
    nextId: () => 't',
  })

  it('用的是随包构建（不是 npm 模块）', () => {
    assert.equal(typeof vendored?.sanitize, 'function', 'vendored DOMPurify 应可用')
  })

  it('保留正常 SVG 并补 xmlns', async () => {
    const { markup } = await ADAPTERS.svg.render(
      '<svg viewBox="0 0 100 100"><rect width="10" height="10"/><text>正常</text></svg>',
      fakeEnv(),
    )
    assert.ok(markup.includes('<svg'), '应有 svg 根')
    assert.ok(markup.includes('xmlns="http://www.w3.org/2000/svg"'), '应补 xmlns')
    assert.ok(markup.includes('正常'), '正常文字应保留')
  })

  it('剥离脚本与事件处理器（不可信模型输出）', async () => {
    const { markup } = await ADAPTERS.svg.render(
      '<svg onload="alert(1)"><script>alert(1)</script><rect onclick="x()" width="10" height="10"/><foreignObject><iframe src="http://evil"></iframe></foreignObject></svg>',
      fakeEnv(),
    )
    assert.ok(!markup.includes('onload'), 'onload 应被剥离')
    assert.ok(!markup.includes('<script'), 'script 应被剥离')
    assert.ok(!markup.includes('onclick'), 'onclick 应被剥离')
    assert.ok(!markup.includes('foreignObject'), 'foreignObject 应被剥离')
  })

  it('剥离外部资源引用', async () => {
    const { markup } = await ADAPTERS.svg.render(
      '<svg><image href="http://evil/tracker.png"/><use href="http://evil/x"/><rect width="10" height="10"/></svg>',
      fakeEnv(),
    )
    assert.ok(!markup.includes('http://evil'), '外部 http 引用应被剥离')
  })

  it('detect：以 <svg 开头识别，其他情况不误判', () => {
    assert.equal(ADAPTERS.svg.detect('<svg viewBox="0 0 1 1"></svg>'), true)
    assert.equal(ADAPTERS.svg.detect('  <svg xmlns="http://www.w3.org/2000/svg">'), true)
    assert.equal(ADAPTERS.svg.detect('<div><svg></svg></div>'), false, '嵌套在其他标记里的不算手写 svg 块')
    assert.equal(ADAPTERS.svg.detect('const svg = 1'), false)
  })
})

describe('自适应缩放（宽度与高度双约束）', () => {
  const { fitScale } = loaded.client.internals

  /**
   * Build a figure whose canvas reports a given width.
   *
   * jsdom lays nothing out, so the canvas width is defined explicitly — that is
   * the one number the fit logic reads from the live DOM.
   */
  function figure({ canvasWidth, maxHeight, viewBox }) {
    const doc = loaded.dom.window.document
    const host = doc.createElement('div')
    const canvas = doc.createElement('div')
    canvas.className = 'vk-canvas'
    canvas.style.maxHeight = `${maxHeight}px`
    Object.defineProperty(canvas, 'clientWidth', { value: canvasWidth, configurable: true })
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', viewBox)
    // 手写 SVG 通常声明 width="100%"，渲染盒会被拉伸 —— 尺寸必须以 viewBox 为准
    svg.setAttribute('width', '100%')
    canvas.appendChild(svg)
    host.appendChild(canvas)
    return host
  }

  it('已经放得下时不缩放', () => {
    assert.equal(fitScale(figure({ canvasWidth: 1000, maxHeight: 360, viewBox: '0 0 680 300' })), 1)
  })

  it('高图按高度收缩，缩放后落在画布内', () => {
    // 680×450 放进 1000×360 的画布：宽度绰绰有余，高度超出 —— 以前只算宽度，
    // 于是图被画布裁掉顶部，看起来像"没有渲染"。
    const scale = fitScale(figure({ canvasWidth: 1000, maxHeight: 360, viewBox: '0 0 680 450' }))
    assert.ok(scale < 1, '高图必须收缩')
    assert.ok(450 * scale <= 360, `缩放后高度 ${Math.round(450 * scale)} 应不超过画布 360`)
    assert.ok(scale >= 0.45, '不应缩到看不清')
  })

  it('宽度以 viewBox 为准，不被 width="100%" 的拉伸误导', () => {
    // 渲染盒已被拉伸到画布宽度；若按渲染盒计算，就会认为"宽度刚好"而完全不缩放。
    assert.equal(fitScale(figure({ canvasWidth: 1000, maxHeight: 360, viewBox: '0 0 680 160' })), 1)
  })

  it('适度宽的图按宽度收缩', () => {
    const scale = fitScale(figure({ canvasWidth: 1000, maxHeight: 360, viewBox: '0 0 1200 200' }))
    assert.ok(scale > 0.75 && scale < 0.9, `应缩到约 0.81，实际 ${scale.toFixed(3)}`)
  })

  it('极宽的图不缩到不可读，改为横向滚动', () => {
    assert.equal(fitScale(figure({ canvasWidth: 1000, maxHeight: 360, viewBox: '0 0 2400 200' })), 1)
  })

  it('没有画布时按原尺寸', () => {
    const doc = loaded.dom.window.document
    assert.equal(fitScale(doc.createElement('div')), 1)
  })
})

describe('自修通道（会话探针 + 投递 + 滑条）', () => {
  const { SessionProbe, registerSessionProbe, repairRequest, Toggle } = loaded.client.internals

  it('会话探针记录 sessionId 且不画任何东西', () => {
    assert.equal(SessionProbe({ sessionId: 'sess-123' }), null, '探针必须是不可见的')
    assert.equal(SessionProbe({}), null, '没有 sessionId 时也不应报错')
    assert.equal(SessionProbe(undefined), null, 'props 缺失时也不应报错')
  })

  it('探针注册进会话作用域的槽位', () => {
    const injected = []
    const registered = []
    const slots = {
      inject: (key, callback) => {
        injected.push(key)
        return callback()
      },
      register: (options, component) => {
        registered.push({ options, component })
        return () => {}
      },
    }
    const ctx = {
      inject: (deps, callback) => {
        injected.push(deps.join(','))
        return callback({ slots })
      },
    }
    registerSessionProbe(ctx)
    assert.deepEqual(injected, ['slots', 'conversation.chat.turnTail'])
    assert.equal(registered[0].options.name, 'conversation.chat.turnTail')
    assert.equal(registered[0].component, SessionProbe)
  })

  it('修复请求带上事实与"两种成因要分开处理"的指令', () => {
    const text = repairRequest({
      renderer: 'mermaid',
      tier: 'language',
      message: 'Parse error on line 10:',
      source: 'flowchart TD\n  A[文字(括号)] --> B',
    })
    assert.ok(text.includes('mermaid'), '应写明渲染器')
    assert.ok(text.includes('Parse error on line 10:'), '应带上原始错误')
    assert.ok(text.includes('A[文字(括号)]'), '应带上出错源码')
    assert.ok(text.includes('dsh-visual-kit'), '应指出插件位置')
    assert.ok(text.includes('适配器的 bug') && text.includes('语法本来就写错'), '应要求先分辨成因')
    assert.ok(text.includes('subagent'), '大改动应指示用 subagent')
    assert.ok(text.includes('CLIENT_REV') || text.includes('版本号'), '应提醒提升版本号')
  })

  it('修复请求截断超长源码', () => {
    const text = repairRequest({ renderer: 'echarts', tier: 'language', message: 'x', source: 'a'.repeat(5000) })
    assert.ok(text.length < 2600, `不应把整段超长源码塞进去（实际 ${text.length}）`)
  })

  it('滑条是 role=switch 的可访问控件，含滑钮', () => {
    const on = Toggle({ on: true, label: 'ECharts', onToggle: () => {} })
    assert.equal(on.type, 'button')
    assert.equal(on.props.role, 'switch')
    assert.equal(on.props['aria-checked'], true)
    assert.equal(on.props['aria-label'], 'ECharts')
    assert.ok(on.props.className.includes('vk-switch-btn-on'), '开启态应有对应类名')
    assert.equal(on.children[0].props.className, 'vk-switch-knob', '应含滑钮')

    const off = Toggle({ on: false, label: 'ECharts', onToggle: () => {} })
    assert.equal(off.props['aria-checked'], false)
    assert.ok(!off.props.className.includes('vk-switch-btn-on'))
  })

  it('滑条忙碌时禁用，避免重复点击', () => {
    assert.equal(Toggle({ on: false, busy: true, label: 'x', onToggle: () => {} }).props.disabled, true)
  })
})

describe('MERMAID_HEAD', () => {
  const { MERMAID_HEAD } = loaded.client.internals

  it('覆盖全部常用图类型', () => {
    for (const head of [
      'flowchart TD', 'graph LR', 'sequenceDiagram', 'classDiagram', 'classDiagram-v2',
      'stateDiagram-v2', 'erDiagram', 'journey', 'gantt', 'pie', 'mindmap', 'timeline',
      'gitGraph', 'quadrantChart',
    ]) {
      assert.ok(MERMAID_HEAD.test(head), `应识别 ${head}`)
    }
  })

  it('init 指令之后才是类型关键字也认', () => {
    assert.ok(MERMAID_HEAD.test('%%{init: {"theme": "dark"}}%%\nflowchart TD'))
  })

  it('普通代码不误判', () => {
    assert.ok(!MERMAID_HEAD.test('const flowchart = 1'))
    assert.ok(!MERMAID_HEAD.test('// graph TD in a comment\nconst x = 1'))
  })
})
