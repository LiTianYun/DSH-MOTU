/**
 * 视觉风格：用户可选的外观层。
 *
 * 风格与渲染器正交——渲染器决定"画什么"，风格决定"怎么读"。这里钉三件事：
 *   1. 注册表本身的结构与默认风格；
 *   2. 客户端兜底色板与注册表**逐字节一致**（两份表漂移过一次，不能再漂）；
 *   3. 换风格真的会改变取色、提示段与技能内容。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { it } from 'node:test'

import { setupDom } from '../scripts/dom-env.mjs'
import { Config, promptText, effectiveSkillContent, sanitizeConfigPatch } from '../lib/index.js'
import { enabledRenderers, renderers } from '../lib/renderers/manifest.js'
import { styleEntry, styleFor, styles } from '../lib/styles.js'

const usable = enabledRenderers({})

/** 最小 React 桩：createElement 返回可断言的普通对象树。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((child) => child !== null && child !== undefined && child !== false) }),
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

function loadClient(t, catalogue) {
  const dom = setupDom({ scripts: true })
  let client
  dom.window.__ModuleLoader__ = {
    load({ factory }) {
      client = factory(reactStub)
    },
  }
  dom.window.eval(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))
  if (catalogue !== undefined) client.internals.setCatalogue?.(catalogue)
  t.after(() => dom.window.close())
  return { dom, client }
}

/** 一个最小目录：客户端只需要 styles + presentation。 */
function catalogueFor(styleId) {
  return {
    renderers: renderers.map((spec) => ({ ...spec, enabled: true, settings: spec.defaults })),
    byLanguage: new Map(renderers.flatMap((spec) => spec.languages.map((language) => [language, spec.id]))),
    behavior: {},
    presentation: { style: styleId },
    styles: styles.map((style) => styleEntry(style, styleFor({ presentation: { style: styleId } }).id)),
  }
}

it('注册表结构完整，且默认风格是第一个', () => {
  assert.ok(styles.length >= 2, '至少要有默认与简洁风两种风格')
  assert.equal(styles[0].id, 'motu', '第一个是默认风格')
  for (const style of styles) {
    assert.match(style.id, /^[a-z][a-z0-9-]*$/, `${style.id} 应是稳定的 id`)
    for (const key of ['label', 'summary', 'description', 'guidance']) {
      assert.ok(String(style[key] ?? '').length > 0, `${style.id} 缺少 ${key}`)
    }
    for (const theme of ['light', 'dark']) {
      const table = style.chrome[theme]
      for (const key of ['nodeFill', 'nodeBorder', 'nodeText', 'edge', 'canvasText', 'title', 'grid']) {
        assert.match(table[key], /^#[0-9a-f]{6}$/i, `${style.id}.${theme}.${key} 应是 #rrggbb`)
      }
      assert.ok(Array.isArray(table.palette) && table.palette.length >= 2, `${style.id}.${theme}.palette 至少两色`)
    }
    assert.ok(['open', 'orthogonal'].includes(style.shape.edge), `${style.id} 的连线语汇要么开放箭头要么正交`)
    assert.ok(style.swatches.length >= 2, `${style.id} 至少要两个预览色块`)
  }
})

it('每种风格都显式声明语义令牌，绿就是绿', () => {
  for (const style of styles) {
    assert.ok(style.named, `${style.id} 必须声明 named`)
    for (const key of ['blue', 'red', 'green', 'amber', 'purple', 'teal']) {
      assert.match(style.named[key], /^#[0-9a-f]{6}$/i, `${style.id}.named.${key} 应是 #rrggbb`)
    }
    // 按位置取调色板会让"绿"解析成蓝、"紫"解析成红 —— 用通道关系钉住语义
    const [r, g, b] = style.named.green.match(/[0-9a-f]{2}/gi).map((hex) => parseInt(hex, 16))
    assert.ok(g >= r && g >= b, `${style.id}.named.green 应当真的偏绿（rgb ${r},${g},${b}）`)
    const [pr, pg, pb] = style.named.purple.match(/[0-9a-f]{2}/gi).map((hex) => parseInt(hex, 16))
    assert.ok(pb > pg, `${style.id}.named.purple 应当偏紫（rgb ${pr},${pg},${pb}）`)
  }
})

it('未知风格 id 退回默认，而不是渲染成空色板', () => {
  assert.equal(styleFor({ presentation: { style: '不存在' } }).id, 'motu')
  assert.equal(styleFor({}).id, 'motu')
  assert.equal(styleFor({ presentation: { style: 'blueprint' } }).id, 'blueprint')
})

it('配置默认值与校验：风格 id 必须在注册表里', () => {
  assert.equal(Config({}).presentation.style, 'motu')
  const ok = sanitizeConfigPatch({ presentation: { style: 'blueprint' } })
  assert.equal(ok.presentation.style, 'blueprint')
  const bad = sanitizeConfigPatch({ presentation: { style: '拼错的名字' } })
  assert.equal(bad.presentation, undefined, '拼错的名字必须被拒，否则图会静默退回默认风格')
})

it('客户端兜底色板与注册表逐字节一致（防两份表漂移）', (t) => {
  const { client } = loadClient(t)
  const fallback = client.internals.STYLE_FALLBACK
  assert.ok(fallback, '客户端应导出兜底风格')
  assert.deepEqual(
    JSON.parse(JSON.stringify(fallback.chrome)),
    JSON.parse(JSON.stringify(styles[0].chrome)),
    '兜底 CHROME 必须等于注册表里的默认风格',
  )
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.surface)), JSON.parse(JSON.stringify(styles[0].surface)))
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.paper)), JSON.parse(JSON.stringify(styles[0].paper)))
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.shape)), JSON.parse(JSON.stringify(styles[0].shape)))
  assert.deepEqual(JSON.parse(JSON.stringify(fallback.named)), JSON.parse(JSON.stringify(styles[0].named)))
})

it('换风格改变引擎取色：目录到达后以目录为准', (t) => {
  const { client } = loadClient(t)
  const kit = client.internals
  kit.setCatalogue(catalogueFor('motu'))
  const motu = kit.themeTokens()
  kit.setCatalogue(catalogueFor('blueprint'))
  const blueprint = kit.themeTokens()
  // 浅色画布底两种风格都是白（卡片底就是白），所以比真正有差异的项：
  // 次级面（暖灰 vs 冷灰蓝）、正文色温、以及深色画布底。
  assert.equal(motu.paper, styles[0].paper.light)
  assert.equal(blueprint.paper, styles.find((style) => style.id === 'blueprint').paper.light)
  assert.notEqual(motu.paper, blueprint.paper, '次级面应随风格变化')
  assert.notEqual(motu.ink, blueprint.ink, '正文色温应随风格变化')
  assert.notEqual(
    styles[0].surface.dark,
    styles.find((style) => style.id === 'blueprint').surface.dark,
    '深色画布底应随风格变化',
  )
  assert.equal(motu.ink, styles[0].chrome.light.title)
  assert.equal(blueprint.ink, styles.find((style) => style.id === 'blueprint').chrome.light.title)
})

it('换风格改变线宽与圆角语汇', (t) => {
  const { client } = loadClient(t)
  const kit = client.internals
  kit.setCatalogue(catalogueFor('motu'))
  assert.equal(kit.styleShape().hairline, 0.5)
  kit.setCatalogue(catalogueFor('blueprint'))
  assert.equal(kit.styleShape().hairline, 1)
  assert.equal(kit.styleShape().edge, 'orthogonal')
})

it('非默认风格在常驻提示段里点名，默认风格不加行', () => {
  const motu = promptText({ presentation: { style: 'motu' } }, usable)
  const blueprint = promptText({ presentation: { style: 'blueprint' } }, usable)
  assert.ok(!motu.includes('视觉风格：'), '默认风格不必重复付费')
  assert.match(blueprint, /视觉风格：简洁风/)
  assert.match(blueprint, /整图构图、排版、层级与标注/)
  assert.ok(blueprint.length - motu.length < 120, `风格行要短，实际增加 ${blueprint.length - motu.length} 字符`)
})

it('技能正文带上当前风格的完整指引', () => {
  const skill = effectiveSkillContent('【正文】', { presentation: { style: 'blueprint' } }, usable)
  const style = styles.find((item) => item.id === 'blueprint')
  assert.ok(skill.includes(`当前视觉风格：${style.label}`), '技能要说明当前风格')
  assert.ok(skill.includes(style.guidance), '技能要带上该风格的完整令牌与线型')
})

it('风格预览：同一主题展示整图标题、分区、正文和图例，可比较版式', (t) => {
  const { client } = loadClient(t)
  const preview = client.internals.stylePreview
  assert.equal(typeof preview, 'function', '预览组件应导出以便单测')

  for (const style of styles) {
    const tree = preview(styleEntry(style, style.id))
    assert.equal(tree.type, 'svg', `${style.id} 预览应是 svg`)
    const walk = node => typeof node === 'object' && node !== null ? [node, ...node.children.filter(child => child?.type !== 'defs').flatMap(walk)] : []
    const elements = walk(tree)
    const texts = elements.filter(node => node.type === 'text').map(node => node.children.join(''))
    assert.ok(texts.includes('方案说明'), '预览应有整图标题')
    assert.ok(texts.includes('主体信息') && texts.includes('补充说明'), '预览应有图例')
    assert.ok(texts.length >= 8, '预览应展示实际排版层级，而非几个空框')

    const rects = elements.filter((child) => child.type === 'rect')
    assert.ok(rects.length >= 2)
    for (const rect of rects) {
      assert.equal(rect.props.rx, style.shape.cardRadius, `${style.id} 预览圆角应取该风格`)
      assert.equal(rect.props.strokeWidth, style.shape.hairline, `${style.id} 预览边框应取该风格`)
      assert.equal(rect.props.stroke, style.chrome.light.nodeBorder, `${style.id} 预览边框色应取该风格`)
    }
    const edge = elements.find((child) => child.type === 'path' && child.props.strokeWidth === style.shape.edgeWidth)
    assert.equal(edge.props.strokeWidth, style.shape.edgeWidth, `${style.id} 预览线宽应取该风格`)
    if (style.shape.edge === 'orthogonal') {
      assert.match(edge.props.d, /V/, `${style.id} 正交风格应画出折点`)
      assert.ok(texts.includes('01  结构与分工'), '简洁风应呈现清楚的编号分区')
    } else {
      assert.ok(!/V/.test(edge.props.d), `${style.id} 开放箭头风格不应有折点`)
      assert.ok(String(edge.props.markerEnd ?? '').startsWith('url(#'), '开放箭头风格应挂箭头标记')
      assert.ok(tree.children.some((child) => child.type === 'defs'), '开放箭头风格需要 defs 定义箭头')
    }
    assert.equal(tree.props.style.background, style.surface.light, `${style.id} 预览底色应取该风格`)
  }
})

it('简洁风规范覆盖整图，电气配色不强加给其他主题，公共 SVG 规则不覆盖风格', () => {
  const content = readFileSync(new URL('../skill/SKILL.md', import.meta.url), 'utf8')
  const body = effectiveSkillContent(content, { presentation: { style: 'blueprint' } }, usable)
  assert.match(body, /架构、流程、原理说明、对照与 SVG 剖面插图/)
  assert.match(body, /仅在电气内容中采用/)
  assert.match(body, /其他内容不得机械套用/)
  assert.match(body, /参考页的示例仅供语法参考，不得覆盖当前风格/)
  const common = body.split('## 手写 SVG 设计系统')[1].split('\n## ')[0]
  assert.doesNotMatch(common, /#F1EFE8|rx="8"|边框.*0\.5/)
  assert.doesNotMatch(body, /颜色只表示链路类型/)
  assert.match(body, /已有手写 SVG 不会自动改写/)
  assert.ok(!body.includes(styles[0].guidance), '运行时不应同时给出另一个风格的完整规范')
  assert.equal(body.split(styles.find(style => style.id === 'blueprint').guidance).length, 2, '当前完整规范只注入一次')
})

it('目录下发成本，设置页把它渲染成两行数字', (t) => {
  const { client } = loadClient(t)
  const catalogue = catalogueFor('motu')
  // 目录里的每个渲染器都要有 cost（宿主算好，客户端只显示）
  for (const spec of catalogue.renderers) {
    assert.ok(spec.cost === undefined || typeof spec.cost === 'object', '目录条目可选带 cost')
  }
  const line = client.internals.costLine
  assert.equal(typeof line, 'function', 'costLine 应导出以便单测')
  assert.equal(line(undefined), null, '没有成本数据时不渲染')

  const tree = line({ figureTokens: 3514, figureChars: 13000, standingTokens: 55, standingChars: 108, figureBasis: '典型插图' })
  const texts = []
  const walk = (node) => {
    if (node === null || typeof node !== 'object') return
    if (typeof node.children !== 'undefined') for (const child of node.children) {
      if (typeof child === 'string') texts.push(child)
      else walk(child)
    }
  }
  walk(tree)
  const joined = texts.join('')
  assert.ok(joined.includes('3514'), '每图 token 要显示出来')
  assert.ok(joined.includes('55'), '常驻 token 要显示出来')
  assert.ok(joined.includes('典型插图'), '要说明每图数字的依据')
  // 估算口径必须能查到，否则数字不可核
  assert.ok(String(tree.props.title).includes('1.5 字符/token'), '提示里要写明估算口径')
  assert.ok(String(tree.props.title).includes('13000'), '提示里要给出精确字符数')
})
