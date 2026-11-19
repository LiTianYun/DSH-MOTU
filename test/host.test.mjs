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
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'

import { Config, apply, mergeConfigPatch, promptText, sanitizeConfigPatch, skillSummary } from '../lib/index.js'
import { enabledRenderers, renderers } from '../lib/renderers/manifest.js'
import { styles } from '../lib/styles.js'

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
    assert.equal(routes.size, 7)
    effects.splice(0).forEach(dispose => dispose())
    assert.equal(routes.size, 0)
    const second = new apply(ctx, {})
    returned()
    assert.equal(routes.size, 7, '旧实例重复销毁不能删除新实例的路由')
    second()
    effects.splice(0).forEach(dispose => dispose())
    assert.equal(routes.size, 0)
  })

  it('同一 ECharts 开关管理两种语言，旧输出字段保留', async () => {
    const harness = mount({ renderers: { echarts: { interactive: false } } })
    try {
      const result = await call(harness.routes, 'GET', '/dsh-visual-kit/renderers.json')
      const catalogue = JSON.parse(result.body)
      const spec = catalogue.renderers.find(spec => spec.id === 'echarts')
      // 设置页的 token 预估靠这条：真目录必须带上每个渲染器的成本
      for (const entry of catalogue.renderers) {
        assert.ok(entry.cost !== undefined, `${entry.id} 的目录条目应当带 cost`)
        assert.ok(entry.cost.standingTokens > 0 && entry.cost.figureTokens > 0, `${entry.id} 的两项成本都要有`)
        assert.ok(entry.cost.figureChars > 0 && typeof entry.cost.figureBasis === 'string', `${entry.id} 要给出字符数与依据`)
      }
      // 关掉交互后，常驻成本应当变小（补句随开关消失）
      const full = mount({})
      try {
        const before = JSON.parse((await call(full.routes, 'GET', '/dsh-visual-kit/renderers.json')).body)
          .renderers.find(entry => entry.id === 'echarts').cost
        assert.ok(before.standingChars > spec.cost.standingChars, '交互关掉后常驻字符数应当减少')
      } finally {
        full.dispose()
      }
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
      assert.match(value.prompt, /手写 SVG 优先/)
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

  it('手写优先先声明默认画法，技能摘要与正文不再把用户引回 Mermaid', () => {
    const sections = [], skills = []
    const config = { agent: { svgPreference: 80 } }
    const ctx = {
      webServer: { register: () => () => {} },
      get: key => key === 'systemPrompt' ? { section: value => { sections.push(value); return () => {} } }
        : key === 'skills' ? { register: value => { skills.push(value); return () => {} } } : undefined,
    }
    const dispose = apply(ctx, config)
    try {
      assert.match(sections[0].text, /流程、架构[^。]*默认[^。]*```svg/)
      assert.ok(sections[0].text.indexOf('手写 SVG 优先') < sections[0].text.indexOf('```mermaid'), '模式规则必须先于备选引擎清单')
      assert.match(skills[0].description, /手写 SVG 优先/, '未加载技能正文时也应能看到当前模式')
      assert.match(skills[0].whenToUse, /手写 SVG 优先/)
      const table = skills[0].content.split('## 选型')[1].split('## 语法要点')[0]
      assert.ok(table.indexOf('| SVG 图示（手写） |') < table.indexOf('| Mermaid 图表 |'), '默认画法排在备选能力之前')
      assert.match(table, /默认[^\n]*SVG/)
      assert.ok(!skills[0].content.includes('拿不准时用它'))
      assert.ok(!skills[0].content.includes('优先选够用的最小语法'))
      assert.match(skills[0].content, /不得仅为省 token 改换画法/)
      assert.match(sections[0].text, /用户明确指定的画法优先/)
      assert.match(sections[0].text, /交互|统计/)
    } finally { dispose() }
  })

  it('仅启用技能时仍能看到手写模式，渲染器关闭后不再宣传该模式', () => {
    for (const config of [
      { agent: { promptSection: false, svgPreference: 80 } },
      { agent: { promptSection: false, svgPreference: 80 }, renderers: { svg: { enabled: false } } },
      { agent: { svgPreference: 20 } },
    ]) {
      const sections = [], skills = []
      const dispose = apply({
        webServer: { register: () => () => {} },
        get: key => key === 'systemPrompt' ? { section: value => { sections.push(value); return () => {} } }
          : key === 'skills' ? { register: value => { skills.push(value); return () => {} } } : undefined,
      }, config)
      try {
        assert.equal(sections.length, config.agent.promptSection === false ? 0 : 1)
        if (config.renderers?.svg?.enabled === false) {
          assert.ok(!skills[0].description.includes('SVG'))
          assert.ok(!skills[0].content.includes('```svg'))
        } else {
          const expected = config.agent.svgPreference > 66 ? /手写 SVG 优先/ : /常规引擎优先/
          assert.match(skills[0].description, expected)
          assert.match(skills[0].content, expected)
        }
      } finally { dispose() }
    }
  })

  it('通过设置路由切换画法及整图风格后，提示和技能一起替换，旧注册被释放', async () => {
    const routes = new Map(), sections = new Set(), skills = new Set()
    let current = Config({}), dispose
    const ctx = {
      webServer: { register(route) {
        const key = `${route.kind}:${route.path}`
        assert.ok(!routes.has(key))
        routes.set(key, route)
        return () => routes.delete(key)
      } },
      get: key => key === 'systemPrompt' ? { section: value => { sections.add(value); return () => sections.delete(value) } }
        : key === 'skills' ? { register: value => { skills.add(value); return () => skills.delete(value) } }
          : key === 'configEditor' ? {
            entries: () => [{ name: 'dsh-visual-kit' }],
            async edit(_entry, change) { current = Config(change(current)); dispose(); dispose = apply(ctx, current) },
          } : undefined,
    }
    dispose = apply(ctx, current)
    try {
      for (const [value, label] of [[80, '手写 SVG 优先'], [20, '常规引擎优先'], [50, '按任务均衡选择']]) {
        const oldSection = [...sections][0], oldSkill = [...skills][0]
        const result = await call(routes, 'POST', '/dsh-visual-kit/config', { body: JSON.stringify({ agent: { svgPreference: value } }) })
        assert.equal(result.status, 200)
        assert.equal(sections.size, 1)
        assert.equal(skills.size, 1)
        assert.ok(!sections.has(oldSection) && !skills.has(oldSkill))
        const snapshot = JSON.parse((await call(routes, 'GET', '/dsh-visual-kit/config')).body).value
        assert.equal(snapshot.settings.svgPreference, value)
        assert.equal([...sections][0].text, snapshot.prompt)
        assert.ok([...sections][0].text.includes(label))
        assert.ok([...skills][0].description.includes(label))
        assert.ok([...skills][0].content.includes(label))
      }
      for (const styleId of ['blueprint', 'motu', 'blueprint']) {
        const oldSection = [...sections][0], oldSkill = [...skills][0]
        const result = await call(routes, 'POST', '/dsh-visual-kit/config', { body: JSON.stringify({ presentation: { style: styleId } }) })
        assert.equal(result.status, 200)
        assert.equal(sections.size, 1)
        assert.equal(skills.size, 1)
        assert.ok(!sections.has(oldSection) && !skills.has(oldSkill), '换风格也必须释放旧模型指引')
        const style = styles.find(style => style.id === styleId)
        const body = [...skills][0].content
        assert.ok(body.includes(style.guidance))
        assert.ok(!body.includes(styles.find(style => style.id !== styleId).guidance), '只传递当前选中的完整规范')
        if (styleId === 'blueprint') assert.ok([...sections][0].text.includes('视觉风格：简洁风'))
        else assert.ok(![...sections][0].text.includes('简洁风'), '切回默认不能残留上一个风格')
        const snapshot = JSON.parse((await call(routes, 'GET', '/dsh-visual-kit/config')).body).value
        assert.equal(snapshot.settings.style, styleId)
        assert.equal(snapshot.settings.svgPreference, 50, '风格切换不改画法')
      }
    } finally { dispose() }
    assert.equal(sections.size, 0)
    assert.equal(skills.size, 0)
    assert.equal(routes.size, 0)
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

describe('后台修复路由', () => {
  it('宿主没有 subagents 服务时返回 501，而不是崩', async () => {
    const harness = mount({})
    try {
      const response = await call(harness.routes, 'POST', '/dsh-visual-kit/repair', {
        body: JSON.stringify({ sessionId: 'session-1', prompt: '修一下' }),
      })
      assert.equal(response.status, 501)
      assert.match(JSON.parse(response.body.toString()).error.message, /subagents|agents/)
    } finally {
      harness.dispose()
    }
  })

  it('缺少 sessionId / prompt 时返回 400', async () => {
    const harness = mount({})
    try {
      const response = await call(harness.routes, 'POST', '/dsh-visual-kit/repair', {
        body: JSON.stringify({ sessionId: '', prompt: '' }),
      })
      assert.equal(response.status, 400)
    } finally {
      harness.dispose()
    }
  })
})

describe('报告归档路由', () => {
  it('POST → 列表 → 页面 → 删除 的闭环，且页面带 CSP', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vk-report-route-'))
    const previousHome = process.env.HOME
    const previousProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    const harness = mount({})
    try {
      const spec = { title: '路由测试', verdict: '完成了存储闭环', status: 'done' }
      const html = '<!doctype html><html><body>report-body</body></html>'
      const created = await call(harness.routes, 'POST', '/dsh-visual-kit/reports', {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: '', spec, html, style: 'motu' }),
      })
      assert.equal(created.status, 200)
      const value = JSON.parse(created.body.toString()).value
      assert.match(value.id, /^\d{8}-\d{6}-[0-9a-f]{8}$/)
      assert.equal(value.root, 'home')
      assert.ok(existsSync(join(value.path, 'report.html')))
      assert.ok(existsSync(join(value.path, 'report.json')))
      assert.ok(existsSync(join(home, '.dsh', 'visual-kit', 'reports', 'index.json')))

      const listed = JSON.parse((await call(harness.routes, 'GET', '/dsh-visual-kit/reports')).body.toString())
      assert.equal(listed.value.reports.length, 1)
      assert.equal(listed.value.reports[0].title, '路由测试')

      const page = await call(harness.routes, 'GET', `/dsh-visual-kit/reports/${value.id}`)
      assert.equal(page.status, 200)
      assert.match(page.headers['content-type'], /text\/html/)
      assert.match(page.headers['content-security-policy'], /default-src 'none'/)
      assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/, '归档预览需要在应用内同源 iframe 加载')
      assert.equal(page.body.toString(), html)

      const removed = await call(harness.routes, 'DELETE', `/dsh-visual-kit/reports/${value.id}`)
      assert.equal(removed.status, 200)
      const empty = JSON.parse((await call(harness.routes, 'GET', '/dsh-visual-kit/reports')).body.toString())
      assert.equal(empty.value.reports.length, 0)
    } finally {
      harness.dispose()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousProfile
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('会话工作区可解析时，报告落到项目 .dsh 目录', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vk-report-home-'))
    const workspace = mkdtempSync(join(tmpdir(), 'vk-report-ws-'))
    const previousHome = process.env.HOME
    const previousProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    const routes = new Map()
    const activations = []
    let disposed = 0
    const ctx = {
      webServer: {
        register(route) {
          routes.set(`${route.kind}:${route.path}`, route)
          return () => routes.delete(`${route.kind}:${route.path}`)
        },
      },
      get(name) {
        if (name === 'agents') return { get: (id) => (id === 'session-1' ? { id, session: { id } } : undefined) }
        if (name === 'workingDirectory') return { ensure: async () => workspace, get: () => workspace }
        if (name === 'workspaceRegistry') {
          return { list: () => [{ id: 'ws-1', title: '测试工作区', path: workspace }], archiveSession: async () => {} }
        }
        if (name === 'subagents') {
          return {
            list: () => ['fork'],
            startActivation: async (spec) => {
              activations.push(spec)
              return {
                childId: 'child-1',
                result: Promise.resolve({
                  output: [{ type: 'text', text: '【修正后的源码】\n```mermaid\nflowchart LR\n    A --> B\n```' }],
                  stopReason: 'completed',
                }),
                dispose: async () => { disposed += 1 },
              }
            },
          }
        }
        return undefined
      },
      logger: { warn: () => {}, error: () => {} },
    }
    const dispose = apply(ctx, {})
    try {
      const created = await call(routes, 'POST', '/dsh-visual-kit/reports', {
        body: JSON.stringify({
          sessionId: 'session-1',
          spec: { title: '项目内报告', verdict: '落在项目里', status: 'done' },
          html: '<!doctype html><html><body>project</body></html>',
          style: 'motu',
        }),
      })
      assert.equal(created.status, 200)
      const value = JSON.parse(created.body.toString()).value
      assert.equal(value.root, 'project')
      assert.ok(value.path.startsWith(join(workspace, '.dsh', 'visual-kit', 'reports')))
      assert.ok(existsSync(join(value.path, 'report.html')))

      const listed = JSON.parse((await call(routes, 'GET', '/dsh-visual-kit/reports')).body.toString())
      assert.equal(listed.value.reports.length, 1)
      assert.equal(listed.value.reports[0].workspace.title, '测试工作区')

      const repaired = await call(routes, 'POST', '/dsh-visual-kit/repair', {
        body: JSON.stringify({ sessionId: 'session-1', prompt: '请修这段' }),
      })
      assert.equal(repaired.status, 200, '后台修复应当返回子代理结论')
      assert.match(JSON.parse(repaired.body.toString()).value.text, /修正后的源码/)
      assert.equal(activations.length, 1)
      assert.equal(activations[0].provider, 'fork')
      assert.equal(activations[0].delivery, 'caller', '结果只回调用方，不写进父会话')
      assert.equal(activations[0].label, 'visual-kit-repair')
      assert.equal(activations[0].request.parent.id, 'session-1')
      assert.equal(disposed, 1, '跑完要释放 activation')
    } finally {
      dispose()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousProfile
      rmSync(home, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('拒绝外部资源、缺 doctype 与缺结论的页面', async () => {
    const home = mkdtempSync(join(tmpdir(), 'vk-report-route-'))
    const previousHome = process.env.HOME
    const previousProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    const harness = mount({})
    try {
      const base = { sessionId: '', spec: { title: 'x', verdict: 'y', status: 'done' }, style: 'motu' }
      const external = await call(harness.routes, 'POST', '/dsh-visual-kit/reports', {
        body: JSON.stringify({ ...base, html: '<!doctype html><html><head><script src="https://x.test/a.js"></script></head></html>' }),
      })
      assert.equal(external.status, 400, '外部脚本必须拒绝')
      const anchor = await call(harness.routes, 'POST', '/dsh-visual-kit/reports', {
        body: JSON.stringify({ ...base, html: '<!doctype html><html><body><a href="https://x.test/">x</a></body></html>' }),
      })
      assert.equal(anchor.status, 400, '外部链接必须拒绝')
      const incomplete = await call(harness.routes, 'POST', '/dsh-visual-kit/reports', {
        body: JSON.stringify({ ...base, html: '<div>no doctype</div>' }),
      })
      assert.equal(incomplete.status, 400, '不完整页面必须拒绝')
      const missing = await call(harness.routes, 'POST', '/dsh-visual-kit/reports', {
        body: JSON.stringify({ ...base, spec: { title: '', verdict: 'y' }, html: '<!doctype html><html></html>' }),
      })
      assert.equal(missing.status, 400, '缺 title 必须拒绝')
    } finally {
      harness.dispose()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = previousProfile
      rmSync(home, { recursive: true, force: true })
    }
  })
})

it('版本锁步：宿主 rev 与 CLIENT_REV 一致，且都以 package.json 版本号开头', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const clientRev = client.match(/const CLIENT_REV = '([^']+)'/)?.[1] ?? ''
  const hostRev = host.match(/^const rev = '([^']+)'/m)?.[1] ?? ''
  assert.ok(clientRev !== '' && hostRev !== '', '两处版本号都要能读到')

  // 两者必须逐字相同：客户端用它做缓存失效，也对不上就会加载到旧客户端。
  assert.equal(hostRev, clientRev, '宿主 rev 与 CLIENT_REV 必须一致')

  // 允许 -settings-1 这类构建后缀，但数字部分必须跟上 package.json ——
  // 这条纪律原先只写在 CHANGELOG 里、没有测试，于是它静默漂过一次。
  for (const [name, value] of [['CLIENT_REV', clientRev], ['rev', hostRev]]) {
    const exact = `v${pkg.version}`
    assert.ok(
      value === exact || value.startsWith(`${exact}-`),
      `${name} 必须是 ${exact} 或以 ${exact}- 开头的构建后缀，当前是 ${value}`,
    )
  }
})

it('成本估算：每个渲染器都下发常驻与每图两项，且口径可查', async () => {
  const { estimateTokens, rendererCost } = await import('../lib/index.js')
  const { enabledRenderers } = await import('../lib/renderers/manifest.js')
  const list = enabledRenderers({})
  for (const spec of list) {
    const cost = rendererCost(spec, {}, false)
    assert.ok(cost.standingChars > 0, `${spec.id} 应当有常驻字符数`)
    assert.ok(cost.standingTokens > 0, `${spec.id} 应当有常驻 token 估算`)
    assert.ok(cost.figureChars > 0, `${spec.id} 应当有每图字符数`)
    assert.ok(cost.figureTokens > 0, `${spec.id} 应当有每图 token 估算`)
    // token 必须小于字符数（中文 1.5、其余 4，任何混合都满足）
    assert.ok(cost.standingTokens <= cost.standingChars, `${spec.id} 常驻 token 不该超过字符数`)
    assert.ok(cost.figureTokens <= cost.figureChars, `${spec.id} 每图 token 不该超过字符数`)
    assert.ok(typeof cost.figureBasis === 'string' && cost.figureBasis.length > 0, `${spec.id} 要说明每图数字的依据`)
  }
  // 手写 SVG 的示例远小于真实插图，必须用声明值，否则会把最贵的画法显示成最便宜
  const svg = list.find((spec) => spec.id === 'svg')
  const svgCost = rendererCost(svg, {}, false)
  assert.ok(svgCost.figureChars >= 10000, `svg 的每图成本应当按典型插图算，实际 ${svgCost.figureChars}`)
  assert.ok(svgCost.figureChars > String(svg.sample).length * 5, 'svg 的典型值应当明显大于其最小示例')
  // 相对关系：手写 SVG 每图最贵，mermaid 最便宜 —— 这是设置页要让用户看到的结论
  const costs = list.map((spec) => ({ id: spec.id, tokens: rendererCost(spec, {}, false).figureTokens }))
  const dearest = costs.reduce((a, b) => (a.tokens >= b.tokens ? a : b))
  assert.equal(dearest.id, 'svg', '每图最贵的应当是手写 SVG')
})

it('成本估算口径：中文比英文贵，且不依赖具体 tokenizer', async () => {
  // 这条钉的是"口径可解释"：同样的字符数，中文估出来的 token 更多
  const { estimateTokens } = await import('../lib/index.js')
  assert.ok(estimateTokens('中'.repeat(100)) > estimateTokens('a'.repeat(100)), '中文每字符占的 token 应当更多')
  assert.equal(estimateTokens(''), 0)
  assert.ok(estimateTokens('中'.repeat(15)) === 10, '15 个中文字按 1.5 字符/token 应当是 10')
  assert.ok(estimateTokens('a'.repeat(40)) === 10, '40 个 ASCII 按 4 字符/token 应当是 10')
})
