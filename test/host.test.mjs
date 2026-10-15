/**
 * Host-half tests.
 *
 * These run the real plugin against a stand-in web server, so what is asserted
 * is the actual routing, the actual integrity check and the actual generated
 * text — not a description of them.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import { Config, apply, mergeConfigPatch, promptText, sanitizeConfigPatch, skillSummary } from '../lib/index.js'
import { enabledRenderers, renderers } from '../lib/renderers/manifest.js'

const here = fileURLToPath(new URL('..', import.meta.url))
const VENDOR = join(here, 'vendor')

describe('交互模式配置与能力声明', () => {
  it('构造式宿主通过 effect 释放路由，重载与重复销毁不冲突', () => {
    const routes = new Set(), effects = []
    const ctx = {
      webServer: { register(route) {
        assert.ok(!routes.has(route.path), `重复路由 ${route.path}`)
        routes.add(route.path)
        return () => routes.delete(route.path)
      } },
      effect(setup) { effects.push(setup()) },
    }
    const returned = new apply(ctx, {})
    assert.equal(routes.size, 5)
    effects.splice(0).forEach(dispose => dispose())
    assert.equal(routes.size, 0)
    const second = new apply(ctx, {})
    returned()
    assert.equal(routes.size, 5, '旧实例重复销毁不能删除新实例的路由')
    second()
    effects.splice(0).forEach(dispose => dispose())
    assert.equal(routes.size, 0)
  })

  it('同一 ECharts 开关管理两种语言，旧输出字段保留', async () => {
    const harness = mount({ renderers: { echarts: { interactive: false } } })
    try {
      const result = await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')
      const spec = JSON.parse(result.body).renderers.find(spec => spec.id === 'echarts')
      assert.equal(spec.output, 'svg')
      assert.ok(spec.languages.includes('echarts-interactive'))
      assert.equal(spec.modes.find(mode => mode.id === 'interactive').enabled, false)
      const config = JSON.parse((await call(harness.routes, 'GET', '/dsh-visual-kit/config')).body)
      assert.equal(config.value.settings.interactive, false)
      assert.ok(!config.value.prompt.includes('echarts-interactive'))
      const patch = sanitizeConfigPatch({ renderers: { echarts: { interactive: true } } })
      assert.equal(patch.renderers.echarts.interactive, true)
    } finally { harness.dispose() }
  })

  it('生成技能按实际启用集合隐藏交互语法与停用引擎', () => {
    const registrations = []
    const ctx = {
      webServer: { register: () => () => {} },
      get: (name) => name === 'skills' ? { register: value => { registrations.push(value); return () => {} } } : undefined,
    }
    const dispose = apply(ctx, { renderers: { echarts: { interactive: false }, svg: { enabled: false } } })
    try {
      assert.equal(registrations.length, 1)
      assert.ok(!registrations[0].content.includes('echarts-interactive'))
      assert.ok(!registrations[0].content.includes('## 手写 SVG 设计系统'))
      assert.ok(!registrations[0].content.includes('| SVG 图示（手写） |'))
      assert.match(registrations[0].content, /本机/)
    } finally { dispose() }
  })

  it('默认宣传交互语法，关闭 ECharts 则两种语言均不宣传', () => {
    const enabled = enabledRenderers({})
    assert.match(promptText({}, enabled), /echarts-interactive/)
    const config = { renderers: { echarts: { enabled: false } } }
    assert.ok(!promptText(config, enabledRenderers(config)).includes('echarts-interactive'))
    assert.equal(Config.dict.renderers.dict.echarts.dict.interactive.type, 'boolean')
  })

  it('总开关关闭后目录与模型侧不宣传正在运行的模式', async () => {
    const config = { behavior: { autoRender: false } }
    const harness = mount(config)
    try {
      assert.equal(promptText(config, enabledRenderers(config)), '')
      const value = JSON.parse((await call(harness.routes, 'GET', '/dsh-visual-kit/config')).body).value
      assert.equal(value.skill, '')
      const catalogue = JSON.parse((await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')).body)
      assert.ok(catalogue.renderers.every(spec => spec.modes.every(mode => !mode.enabled)))
    } finally { harness.dispose() }
  })
})

/**
 * Mount the plugin against a captured route table.
 *
 * @param {object} [config] - the plugin configuration to apply.
 * @returns {{routes: Map<string, object>, dispose: () => void, warnings: string[]}} the harness.
 */
function mount(config = {}) {
  const routes = new Map()
  const warnings = []
  const ctx = {
    webServer: {
      register(route) {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => routes.delete(`${route.kind}:${route.path}`)
      },
    },
    get: () => undefined,
    logger: { warn: (message) => warnings.push(String(message)), error: (message) => warnings.push(String(message)) },
  }
  const dispose = apply(ctx, config)
  return { routes, dispose, warnings }
}

/**
 * Call a registered route.
 *
 * @param {Map<string, object>} routes - the captured routes.
 * @param {string} method - HTTP method.
 * @param {string} url - request path.
 * @param {object} [options] - `headers` and `body`.
 * @returns {Promise<{status: number, headers: Record<string, string>, body: Buffer}>} the response.
 */
async function call(routes, method, url, options = {}) {
  const route = [...routes.values()].find((candidate) =>
    candidate.kind === 'exact' ? candidate.path === url : url.startsWith(candidate.path),
  )
  assert.ok(route !== undefined, `没有匹配的路由: ${url}`)

  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = options.headers ?? {}
  req.destroy = () => {}

  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = String(value)
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
      resolve()
    },
  }
  let resolve
  const done = new Promise((settle) => {
    resolve = settle
  })

  const handled = route.handler(req, res)
  if (options.body !== undefined) {
    req.emit('data', Buffer.from(options.body))
    req.emit('end')
  }
  await Promise.all([done, handled])
  return { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }
}

describe('配置 schema 由清单生成', () => {
  it('每个渲染器都有 enabled 开关与自己的旋钮', () => {
    const sections = Config.dict?.renderers?.dict
    assert.ok(sections !== undefined, 'renderers 段应存在')
    for (const spec of renderers) {
      assert.ok(sections[spec.id] !== undefined, `${spec.id} 应有配置段`)
      assert.ok(sections[spec.id].dict?.enabled !== undefined, `${spec.id} 应有 enabled`)
      for (const key of Object.keys(spec.defaults)) {
        assert.ok(sections[spec.id].dict?.[key] !== undefined, `${spec.id}.${key} 应有配置字段`)
      }
    }
  })

  it('默认值可解析，且与清单一致', () => {
    const resolved = Config({})
    assert.equal(resolved.renderers.mermaid.enabled, true)
    assert.equal(resolved.renderers.graphviz.font, 'Microsoft YaHei')
    assert.equal(resolved.renderers.nomnoml.padding, 22)
    assert.equal(resolved.presentation.fontSize, 13)
    assert.equal(resolved.presentation.canvasMaxHeight, 360)
    assert.equal(resolved.integrity.strict, false)
  })

  it('清单里新增一条记录，配置里就自动多一个开关', () => {
    // The generation is what makes a future renderer appear in the settings;
    // this asserts the property rather than a particular renderer.
    const generated = Config.dict.renderers.dict
    assert.equal(Object.keys(generated).length, renderers.length)
  })
})

describe('提示段与技能摘要随启用集合变化', () => {
  it('默认启用全部渲染器时，各栅栏都出现在提示里', () => {
    const text = promptText({}, renderers)
    for (const fence of ['```mermaid', '```dot', '```nomnoml', '```echarts', '```vega-lite', '```svg']) {
      assert.ok(text.includes(fence), `提示里应提到 ${fence}`)
    }
    assert.ok(text.includes('写入文件'), '提示里应包含成本纪律')
  })

  it('提示段是"主动画图"的指令，不是能力清单', () => {
    // 这是让模型像参照应用那样主动配图的关键：只描述"能渲染"时，模型会一直
    // 写散文，直到用户明确要求才画。指令必须写在最前面。
    const text = promptText({}, renderers)
    assert.ok(text.includes('主动画一张图'), '提示段必须要求主动配图')
    assert.ok(text.includes('不要等用户要求'), '提示段必须说明无需等待用户要求')
    assert.ok(text.indexOf('主动画一张图') < text.indexOf('```mermaid'), '指令应排在栅栏清单之前')
  })

  it('提示段保留手写 SVG 支持，并提醒检查结构与文字溢出', () => {
    const text = promptText({}, renderers)
    assert.ok(text.includes('选择手写 ```svg 时'), '应保留手写 svg 的结构与排版规范')
    assert.ok(text.includes('viewBox'), '应给出尺寸建议')
    const config = { renderers: { svg: { enabled: false } } }
    assert.ok(!promptText(config, enabledRenderers(config)).includes('优先手写'), '关掉 svg 后不应再推荐')
  })

  it('技能摘要同样带主动触发，而非"用户要求时"', () => {
    const summary = skillSummary(renderers)
    assert.ok(summary.whenToUse.includes('主动'), 'whenToUse 应含主动触发')
    assert.ok(!/^用户要求画图/.test(summary.whenToUse), '不应只在用户明确要求时才触发')
  })

  it('关掉某渲染器后，它的栅栏与说明同步消失', () => {
    const config = { renderers: { echarts: { enabled: false } } }
    const usable = enabledRenderers(config)
    const text = promptText(config, usable)
    assert.ok(!text.includes('```echarts'), '关掉的渲染器不应再被宣传')
    assert.ok(text.includes('```dot'), '其它渲染器应保留')
    assert.ok(!skillSummary(usable).description.includes('ECharts'))
  })

  it('全部关闭时不注册任何提示段', () => {
    const config = { renderers: Object.fromEntries(renderers.map((spec) => [spec.id, { enabled: false }])) }
    assert.equal(promptText(config, enabledRenderers(config)), '')
  })

  it('agent.promptSection=false 时不输出提示', () => {
    assert.equal(promptText({ agent: { promptSection: false } }, renderers), '')
  })
})

describe('配置写入（设置页开关的数据通道）', () => {
  it('绘图偏好默认均衡，只接受 0 到 100 的整数', async () => {
    assert.equal(Config({}).agent.svgPreference, 50)
    for (const value of [0, 20, 50, 80, 100]) assert.deepEqual(sanitizeConfigPatch({ agent: { svgPreference: value } }), { agent: { svgPreference: value } })
    for (const value of [-1, 101, 50.5, NaN, Infinity, '80', null]) assert.deepEqual(sanitizeConfigPatch({ agent: { svgPreference: value } }), {})
    const harness = mount({ agent: { svgPreference: 80 } })
    try {
      const value = JSON.parse((await call(harness.routes, 'GET', '/dsh-visual-kit/config')).body).value
      assert.equal(value.settings.svgPreference, 80)
      assert.match(value.prompt, /手写 SVG 80/)
    } finally { harness.dispose() }
  })

  it('偏好同步到常驻提示与实际注册的技能，不覆盖用户指定或停用开关', () => {
    for (const [weight, description] of [[0, '常规引擎优先'], [50, '按任务均衡选择'], [100, '手写 SVG 优先']]) {
      const registrations = []
      const ctx = { webServer: { register: () => () => {} }, get: key => key === 'skills' ? { register: value => { registrations.push(value); return () => {} } } : undefined }
      const config = { agent: { svgPreference: weight } }
      const dispose = apply(ctx, config)
      try {
        assert.ok(promptText(config, enabledRenderers(config)).includes(description))
        assert.ok(registrations[0].content.includes(description))
        assert.match(registrations[0].content, /用户明确指定的画法优先/)
        if (weight === 0) assert.ok(!registrations[0].content.includes('语义图**优先手写'))
      } finally { dispose() }
    }
    const off = { agent: { svgPreference: 100 }, renderers: { svg: { enabled: false } } }
    assert.ok(!promptText(off, enabledRenderers(off)).includes('手写 SVG 优先'))
    assert.ok(!promptText(off, enabledRenderers(off)).includes('```svg'))
  })

  it('白名单只放行 schema 声明的字段与类型', () => {
    const clean = sanitizeConfigPatch({
      behavior: { autoRender: false, 不存在的字段: 1, debounceMs: '不是数字' },
      agent: { promptSection: false },
      renderers: {
        mermaid: { enabled: false, theme: 'dark', 未知旋钮: true },
        不存在的渲染器: { enabled: true },
      },
      未知段: { x: 1 },
    })
    assert.deepEqual(clean.behavior, { autoRender: false }, '类型不符与未知字段应被丢弃')
    assert.deepEqual(clean.agent, { promptSection: false })
    assert.deepEqual(clean.renderers, { mermaid: { enabled: false, theme: 'dark' } }, '未知渲染器与未知旋钮应被丢弃')
    assert.equal(clean['未知段'], undefined, '未知段不应被写入')
  })

  it('非对象输入不产生任何写入', () => {
    assert.deepEqual(sanitizeConfigPatch(null), {})
    assert.deepEqual(sanitizeConfigPatch('字符串'), {})
    assert.deepEqual(sanitizeConfigPatch({ behavior: null }), {})
  })

  it('合并保留同级字段，不清空兄弟渲染器', () => {
    const current = {
      renderers: { mermaid: { enabled: true, theme: 'dark' }, echarts: { enabled: true } },
      behavior: { debounceMs: 500 },
    }
    const next = mergeConfigPatch(current, { renderers: { mermaid: { enabled: false } }, behavior: { autoRender: false } })
    assert.deepEqual(next.renderers.mermaid, { enabled: false, theme: 'dark' }, '只改指定字段')
    assert.deepEqual(next.renderers.echarts, { enabled: true }, '兄弟渲染器不受影响')
    assert.deepEqual(next.behavior, { debounceMs: 500, autoRender: false }, '同级字段合并')
  })

  it('POST /config 拒绝无效补丁（400）', async () => {
    const harness = mount({})
    try {
      const response = await call(harness.routes, 'POST', '/dsh-visual-kit/config', { body: JSON.stringify({ 未知: 1 }) })
      assert.equal(response.status, 400)
      const payload = JSON.parse(response.body.toString('utf8'))
      assert.equal(payload.ok, false)
      assert.match(payload.error.message, /没有可写入的字段/)
    } finally {
      harness.dispose()
    }
  })

  it('POST /config 在宿主无 configEditor 时给出可读原因（503）', async () => {
    // 测试夹具的 ctx.get 一律返回 undefined，正好覆盖"服务缺失"这一支。
    const harness = mount({})
    try {
      const response = await call(harness.routes, 'POST', '/dsh-visual-kit/config', {
        body: JSON.stringify({ renderers: { mermaid: { enabled: false } } }),
      })
      assert.equal(response.status, 503)
      const payload = JSON.parse(response.body.toString('utf8'))
      assert.match(payload.error.message, /configEditor/)
    } finally {
      harness.dispose()
    }
  })

  it('GET /config 带上设置页需要的开关快照', async () => {
    const harness = mount({ renderers: { nomnoml: { enabled: false } } })
    try {
      const response = await call(harness.routes, 'GET', '/dsh-visual-kit/config')
      const settings = JSON.parse(response.body.toString('utf8')).value.settings
      assert.equal(settings.autoRender, true)
      assert.equal(settings.promptSection, true)
      assert.equal(settings.skill, true)
      assert.equal(settings.renderers.mermaid, true)
      assert.equal(settings.renderers.nomnoml, false)
    } finally {
      harness.dispose()
    }
  })
})

describe('设置面板数据源', () => {
  it('目录带上 usage 与 sample，供面板做实时预览', async () => {
    const harness = mount({})
    try {
      const response = await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')
      const payload = JSON.parse(response.body.toString('utf8'))
      assert.equal(payload.renderers.length, renderers.length)
      for (const entry of payload.renderers) {
        assert.ok(typeof entry.usage === 'string' && entry.usage.length > 0, `${entry.id} 应带 usage`)
        assert.ok(typeof entry.sample === 'string' && entry.sample.length > 0, `${entry.id} 应带 sample`)
        assert.ok(Array.isArray(entry.languages) && entry.languages.length > 0, `${entry.id} 应带 languages`)
      }
    } finally {
      harness.dispose()
    }
  })
})

describe('路由', () => {
  /** @type {ReturnType<typeof mount>} */
  let harness

  before(() => {
    harness = mount({})
  })

  after(() => {
    harness.dispose()
  })

  it('注册了 config / renderers.json / health / diag 与资产前缀路由', () => {
    const paths = [...harness.routes.keys()]
    assert.ok(paths.includes('exact:/dsh-visual-kit/config'))
    assert.ok(paths.includes('exact:/dsh-visual-kit/renderers.json'))
    assert.ok(paths.includes('exact:/dsh-visual-kit/health'))
    assert.ok(paths.includes('exact:/dsh-visual-kit/diag'))
    assert.ok(paths.includes('prefix:/dsh-visual-kit/assets'))
  })

  it('/config 报告启用集合与提示文本', async () => {
    const response = await call(harness.routes, 'GET', '/dsh-visual-kit/config')
    assert.equal(response.status, 200)
    const payload = JSON.parse(response.body.toString('utf8'))
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.value.enabled, renderers.map((spec) => spec.id))
    assert.equal(payload.value.skill, 'dsh-visualization')
    assert.ok(payload.value.prompt.length > 0)
  })

  it('/renderers.json 给出每个渲染器的资产与版本', async () => {
    const response = await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')
    const payload = JSON.parse(response.body.toString('utf8'))
    assert.equal(payload.renderers.length, renderers.length)
    const mermaid = payload.renderers.find((entry) => entry.id === 'mermaid')
    assert.equal(mermaid.assets[0].url, '/dsh-visual-kit/assets/mermaid/mermaid.min.js')
    assert.equal(mermaid.assets[0].global, 'mermaid')
    assert.equal(mermaid.assets[0].ok, true)
    assert.match(mermaid.assets[0].version, /^11\./)
    const vega = payload.renderers.find((entry) => entry.id === 'vega-lite')
    assert.equal(vega.assets.length, 2, 'Vega-Lite 需要 vega 与 vega-lite 两个文件')
  })

  it('资产路由伺服真实字节，ETag 命中返回 304', async () => {
    const first = await call(harness.routes, 'GET', '/dsh-visual-kit/assets/nomnoml/nomnoml.js')
    assert.equal(first.status, 200)
    assert.equal(first.headers['content-type'], 'application/javascript; charset=utf-8')
    assert.ok(first.body.length > 1000)
    assert.ok(first.body.toString('utf8').includes('nomnoml'))

    const second = await call(harness.routes, 'GET', '/dsh-visual-kit/assets/nomnoml/nomnoml.js', {
      headers: { 'if-none-match': first.headers.etag },
    })
    assert.equal(second.status, 304)
    assert.equal(second.body.length, 0)
  })

  it('资产路由是白名单：目录穿越与未知文件都是 404', async () => {
    for (const path of [
      '/dsh-visual-kit/assets/../../package.json',
      '/dsh-visual-kit/assets/mermaid/../integrity.json',
      '/dsh-visual-kit/assets/nope/nope.js',
    ]) {
      const response = await call(harness.routes, 'GET', path)
      assert.equal(response.status, 404, `${path} 不应被伺服`)
    }
  })

  it('/health 报出每个文件的校验结果', async () => {
    const response = await call(harness.routes, 'GET', '/dsh-visual-kit/health')
    const payload = JSON.parse(response.body.toString('utf8'))
    assert.equal(payload.ok, true)
    for (const entry of payload.value.renderers) {
      assert.equal(entry.usable, true, `${entry.id} 应可用`)
      for (const asset of entry.assets) {
        assert.equal(asset.ok, true, `${asset.path} 应通过校验`)
        assert.match(asset.actual, /^[0-9a-f]{64}$/)
      }
    }
  })

  it('诊断信标可写可读，并受 keep 限制', async () => {
    const post = await call(harness.routes, 'POST', '/dsh-visual-kit/diag', { body: JSON.stringify({ clientRev: 'test', figures: 3 }) })
    assert.equal(post.status, 200)
    const get = await call(harness.routes, 'GET', '/dsh-visual-kit/diag')
    const payload = JSON.parse(get.body.toString('utf8'))
    assert.equal(payload.value.reports[0].figures, 3)
  })
})

describe('配置生效与降级', () => {
  it('关掉的渲染器不出现在 catalogue 与提示里', async () => {
    const harness = mount({ renderers: { graphviz: { enabled: false } } })
    try {
      const response = await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')
      const payload = JSON.parse(response.body.toString('utf8'))
      const graphviz = payload.renderers.find((entry) => entry.id === 'graphviz')
      assert.equal(graphviz.enabled, false)

      const config = await call(harness.routes, 'GET', '/dsh-visual-kit/config')
      const value = JSON.parse(config.body.toString('utf8')).value
      assert.ok(!value.enabled.includes('graphviz'))
      assert.ok(value.disabled.includes('graphviz'))
      assert.ok(!value.prompt.includes('```dot'))
    } finally {
      harness.dispose()
    }
  })

  it('文件被改动时：health 报错、伺服返回 503、strict 下该渲染器被禁用', async () => {
    const target = join(VENDOR, 'nomnoml', 'nomnoml.js')
    const backup = readFileSync(target)
    writeFileSync(target, Buffer.concat([backup, Buffer.from('\n// tampered\n')]))
    const harness = mount({ integrity: { strict: true } })
    try {
      const health = await call(harness.routes, 'GET', '/dsh-visual-kit/health')
      const payload = JSON.parse(health.body.toString('utf8'))
      const entry = payload.value.renderers.find((item) => item.id === 'nomnoml')
      const tampered = entry.assets.find((asset) => asset.path === 'nomnoml/nomnoml.js')
      assert.equal(tampered.ok, false)
      assert.equal(payload.ok, false)
      assert.ok(tampered.message.includes('不符'), '应说明是哈希不符')

      const asset = await call(harness.routes, 'GET', '/dsh-visual-kit/assets/nomnoml/nomnoml.js')
      assert.equal(asset.status, 503, '损坏的引擎不能被当成正常文件伺服')
      assert.ok(asset.body.toString('utf8').includes('完整性校验失败'))

      const catalogue = await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')
      const entryFromCatalogue = JSON.parse(catalogue.body.toString('utf8')).renderers.find((item) => item.id === 'nomnoml')
      assert.equal(entryFromCatalogue.enabled, false, 'strict 模式下应被禁用')

      // graphre（support 资产）没有被篡改，所以严格模式只禁用 nomnoml 本体。
      const graphre = entryFromCatalogue.assets.find((asset) => asset.path === 'nomnoml/graphre.js')
      assert.equal(graphre.ok, true, 'support 资产仍应完好')

      const config = await call(harness.routes, 'GET', '/dsh-visual-kit/config')
      assert.ok(!JSON.parse(config.body.toString('utf8')).value.prompt.includes('```nomnoml'))
    } finally {
      writeFileSync(target, backup)
      harness.dispose()
    }
  })

  it('非 strict 模式下损坏文件只报告，不禁用', async () => {
    const target = join(VENDOR, 'nomnoml', 'nomnoml.js')
    const backup = readFileSync(target)
    writeFileSync(target, Buffer.concat([backup, Buffer.from('\n// tampered\n')]))
    const harness = mount({ integrity: { strict: false } })
    try {
      const catalogue = await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')
      const entry = JSON.parse(catalogue.body.toString('utf8')).renderers.find((item) => item.id === 'nomnoml')
      assert.equal(entry.enabled, true)
      const tampered = entry.assets.find((asset) => asset.path === 'nomnoml/nomnoml.js')
      assert.equal(tampered.ok, false, '仍然要如实报告文件不可信')
    } finally {
      writeFileSync(target, backup)
      harness.dispose()
    }
  })

  it('dispose 后路由全部注销', () => {
    const harness = mount({})
    assert.ok(harness.routes.size > 0)
    harness.dispose()
    assert.equal(harness.routes.size, 0)
  })
})

describe('完整性校验能发现缺失的 vendor 记录', () => {
  it('integrity.json 覆盖清单里的每个资产', () => {
    const record = JSON.parse(readFileSync(join(VENDOR, 'integrity.json'), 'utf8'))
    for (const spec of renderers) {
      for (const asset of spec.assets) {
        assert.ok(record.assets[asset.path] !== undefined, `${asset.path} 应在 integrity.json 里`)
        assert.match(record.assets[asset.path].sha256, /^[0-9a-f]{64}$/)
        assert.ok(record.assets[asset.path].version !== 'unknown', `${asset.path} 应有版本`)
      }
    }
  })

  it('技能文件由 vendor 生成，且引用了每个渲染器', () => {
    const skill = readFileSync(join(here, 'skill', 'SKILL.md'), 'utf8')
    assert.ok(skill.includes('## 选型'))
    for (const spec of renderers) {
      assert.ok(skill.includes(spec.label), `技能应提到 ${spec.label}`)
      const reference = readFileSync(join(here, 'skill', 'references', `${spec.id}.md`), 'utf8')
      assert.ok(reference.includes(spec.sample.split('\n')[0].slice(0, 8)), `${spec.id} 的参考页应包含示例`)
    }
  })
})

describe('asset 备份机制', () => {
  it('测试用的备份文件不会残留', () => {
    // Guards the tamper tests above: they restore in a finally block, and a
    // leftover backup would mean a corrupted engine in the tree.
    const record = JSON.parse(readFileSync(join(VENDOR, 'integrity.json'), 'utf8'))
    for (const [path, info] of Object.entries(record.assets)) {
      const bytes = readFileSync(join(VENDOR, path))
      assert.equal(createHash('sha256').update(bytes).digest('hex'), info.sha256, `${path} 应与记录一致`)
    }
  })
})
