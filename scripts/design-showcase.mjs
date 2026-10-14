/**
 * Ten hand-authored SVGs in the reference application's design system.
 *
 * The tokens were read out of that product's own conversation artifacts (see
 * 图表参考/): warm neutrals for structure, semantic hues for meaning, hairline
 * borders, open arrowheads, and a strict type scale. One generator keeps all
 * ten consistent.
 *
 *   node scripts/design-showcase.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', 'preview', 'design')
mkdirSync(outDir, { recursive: true })

/** Design tokens, verbatim from the reference artifacts. */
const T = {
  ink: '#444441', // primary text
  inkStrong: '#2C2C2A', // strong text on white
  sub: '#5F5E5A', // secondary text
  tertiary: '#888780', // tertiary text / muted lines
  paper: '#FFFFFF',
  warm: '#F1EFE8', // current / existing card
  warmLine: '#B4B2A9', // warm hairline border
  blue: '#185FA5', blueDeep: '#0C447C', blueFill: '#E6F1FB', blueHi: '#B5D4F4',
  green: '#3B6D11', greenDeep: '#27500A', greenFill: '#EAF3DE', greenMint: '#E1F5EE', greenDark: '#085041', greenMid: '#0F6E56',
  red: '#A32D2D', redDeep: '#791F1F', redFill: '#FCEBEB', redSoft: '#F09595',
  amber: '#BA7517', amberDeep: '#854F0B', amberFill: '#FAEEDA', amberDark: '#633806',
  purple: '#534AB7', purpleDeep: '#3C3489', purpleFill: '#EEEDFE', purpleHi: '#CECBF6',
}
const FONT = "system-ui, -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
const MONO = "ui-monospace, 'Cascadia Code', Consolas, monospace"

/** Escape for text nodes. */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A text element. */
const tx = (x, y, s, o = {}) => {
  const size = o.size ?? 12
  const weight = o.weight ? ` font-weight="${o.weight}"` : ''
  const fill = o.fill ? ` fill="${o.fill}"` : ''
  const anchor = o.anchor ? ` text-anchor="${o.anchor}"` : ''
  const baseline = o.base ? ` dominant-baseline="${o.base}"` : ''
  const family = o.mono ? ` font-family="${MONO}"` : o.family ? ` font-family="${o.family}"` : ''
  const style = o.var ? ` style="${o.var}"` : ''
  return `<text x="${x}" y="${y}" font-size="${size}"${weight}${fill}${anchor}${baseline}${family}${style}>${esc(s)}</text>`
}

/** A rounded rect. */
const box = (x, y, w, h, o = {}) => {
  const rx = o.rx ?? 8
  const fill = o.fill ?? T.paper
  const stroke = o.stroke ?? T.warmLine
  const sw = o.sw ?? 0.5
  const dash = o.dash ? ` stroke-dasharray="${o.dash}"` : ''
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${dash}/>`
}

/** Open-arrowhead defs (the signature marker). */
const defs = (id) => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`

/** A connector line/polyline with an open arrowhead. */
const edge = (d, color, o = {}) => {
  const dash = o.dash ? ` stroke-dasharray="${o.dash}"` : ''
  const sw = o.sw ?? 1.5
  const marker = o.noArrow ? '' : ` marker-end="url(#${o.mark ?? 'a'})"`
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}"${dash}${marker}/>`
}

/** Wrap a full document. */
const doc = (title, desc, h, body) => `<svg viewBox="0 0 680 ${h}" width="100%" role="img" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
<title>${esc(title)}</title>
<desc>${esc(desc)}</desc>
${defs('a')}
${body}
</svg>
`

const files = []
const save = (name, svg) => {
  writeFileSync(join(outDir, name), svg, 'utf8')
  files.push(name)
}

// ---------------------------------------------------------------------------
// 1. 对比：两种缓存策略（红 = 现状问题 / 绿 = 建议）
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(box(40, 40, 292, 250, { rx: 16, fill: T.redFill, stroke: T.red }))
  body.push(tx(66, 70, '本地缓存（现状）', { size: 14, weight: 500, fill: T.redDeep, base: 'central' }))
  body.push(box(60, 92, 252, 44, { stroke: T.red }))
  body.push(tx(186, 114, '每个实例各存一份', { size: 13, fill: '#501313', anchor: 'middle', base: 'central' }))
  body.push(edge('M186 136 V150', T.red, { mark: 'a' }))
  body.push(edge('M96 150 L276 150', T.red, { noArrow: true }))
  for (const [i, lbl] of ['实例 A', '实例 B', '实例 C'].entries()) {
    const x = 60 + i * 92
    body.push(edge(`M${x + 42} 150 V160`, T.red))
    body.push(box(x, 164, 84, 36, { stroke: T.redSoft }))
    body.push(tx(x + 42, 182, lbl, { size: 12, fill: '#501313', anchor: 'middle', base: 'central' }))
  }
  body.push(tx(60, 226, '· 内存被 triple，命中率低', { size: 12, fill: T.red, base: 'central' }))
  body.push(tx(60, 250, '· 一份失效，三份不一致', { size: 12, fill: T.red, base: 'central' }))

  body.push(box(348, 40, 292, 250, { rx: 16, fill: T.greenMint, stroke: T.greenMid }))
  body.push(tx(374, 70, '共享缓存（建议）', { size: 14, weight: 500, fill: T.greenDark, base: 'central' }))
  for (const [i, lbl] of ['实例 A', '实例 B', '实例 C'].entries()) {
    const x = 368 + i * 92
    body.push(box(x, 92, 84, 36, { stroke: T.greenMid }))
    body.push(tx(x + 42, 110, lbl, { size: 12, fill: '#173404', anchor: 'middle', base: 'central' }))
    body.push(edge(`M${x + 42} 128 V142`, T.greenMid))
  }
  body.push(edge('M410 142 L578 142', T.greenMid, { noArrow: true }))
  body.push(edge('M494 142 V154', T.greenMid))
  body.push(box(410, 158, 168, 40, { stroke: T.greenMid }))
  body.push(tx(494, 178, 'Redis 集群（单一副本）', { size: 12, fill: '#173404', anchor: 'middle', base: 'central' }))
  body.push(tx(368, 226, '· 一份数据，全员命中', { size: 12, fill: T.greenMid, base: 'central' }))
  body.push(tx(368, 250, '· TTL 统一，失效一致', { size: 12, fill: T.greenMid, base: 'central' }))
  save('01-comparison.svg', doc('两种缓存策略的对比', '左侧本地缓存三实例各存一份导致不一致，右侧共享 Redis 集群单一副本、统一失效。', 320, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 2. 时间线：发布日
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(tx(43, 30, '发布日 · 蓝 = 新增环节，灰 = 已有流程', { size: 12, var: `fill:var(--color-text-tertiary,${T.tertiary})` }))
  body.push(`<line x1="112" y1="48" x2="112" y2="432" stroke-width="1" style="stroke:var(--color-border-secondary,${T.warmLine})" fill="none"/>`)
  const steps = [
    ['09:00', '冻结代码 & 打 tag', 'main 锁定，只收热修', T.blue, T.blueFill, T.blueDeep, T.blue],
    ['10:30', '跑全量回归', '自动化 + 人工冒烟', T.warmLine, T.warm, T.ink, T.sub],
    ['13:00', '灰度 5%', '金丝雀实例观察 30 分钟', T.blue, T.blueFill, T.blueDeep, T.blue],
    ['15:00', '灰度 50%', '错误率 & 延迟双达标', T.blue, T.blueFill, T.blueDeep, T.blue],
    ['19:00', '全量 & 观察', '解冻 main，值班盯盘', T.warmLine, T.warm, T.ink, T.sub],
  ]
  let y = 48
  for (const [time, title, sub, dot, fill, tfill, sfill] of steps) {
    body.push(tx(96, y + 24, time, { size: 12, weight: 500, fill: T.ink, anchor: 'end', base: 'central' }))
    body.push(`<circle cx="112" cy="${y + 20}" r="4" fill="${dot}"/>`)
    body.push(box(132, y, 508, 48, { fill, stroke: dot }))
    body.push(tx(148, y + 20, title, { size: 13, weight: 500, fill: tfill, base: 'central' }))
    body.push(tx(148, y + 38, sub, { size: 11, fill: sfill, base: 'central' }))
    y += 76
  }
  save('02-timeline.svg', doc('发布日 · 时间线', '从冻结代码到全量观察的五步发布流程，蓝为新增灰度环节，灰为已有流程。', 470, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 3. 阶梯：工程师四级成长
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(tx(42, 40, '工程师成长 · 每级都能独立交付', { size: 12, var: `fill:var(--color-text-tertiary,${T.tertiary})` }))
  body.push(edge('M42 400 L185 400 L185 340 L336 340 L336 280 L487 280 L487 220 L636 220', T.warmLine, { noArrow: true, sw: 0.5 }))
  const levels = [
    ['L1 · 入门', '独立完成需求', ['写测试 · 懂回滚', '代码被 review 通过'], T.blueHi, T.blue, T.blueDeep, T.blue, false],
    ['L2 · 熟练', '独立负责模块', ['设计评审主导', '带新人上手'], T.blueFill, T.blue, T.blueDeep, T.blue, false],
    ['L3 · 骨干', '跨团队定方案', ['权衡取舍写进 ADR', '救火不救火场'], T.purpleHi, T.purple, T.purpleDeep, T.purple, false],
    ['L4 · 专家', '定义技术方向', ['影响路线图', '培养下一个 L4'], T.purpleFill, '#7F77DD', T.purpleDeep, T.purple, true],
  ]
  const x0 = 42
  for (const [i, [tag, title, lines, fill, stroke, tfill, sfill, dashed]] of levels.entries()) {
    const x = x0 + i * 151
    const y = 268 - i * 58
    body.push(`<g>`)
    body.push(box(x, y, 141, 132, { fill, stroke, dash: dashed ? '4 3' : undefined }))
    body.push(tx(x + 13, y + 24, tag, { size: 11, weight: 500, fill: stroke }))
    body.push(tx(x + 13, y + 52, title, { size: 14, weight: 500, fill: tfill }))
    lines.forEach((ln, j) => body.push(tx(x + 13, y + 84 + j * 22, ln, { size: 12, fill: sfill })))
    body.push(`</g>`)
  }
  save('03-roadmap.svg', doc('工程师四级成长', '从独立完成需求到定义技术方向的四个层级，逐级上升，L4 为虚线远景。', 430, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 4. 闭环：需求流转五环
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(tx(42, 34, '需求闭环 · 五环', { size: 14, weight: 500, fill: T.ink }))
  const rings = [
    ['提出', '写清验收标准', T.blueFill, T.blue, T.blueDeep, T.blue],
    ['评审', '砍范围定边界', T.blueFill, T.blue, T.blueDeep, T.blue],
    ['开发', '小步提交可回滚', T.blueFill, T.blue, T.blueDeep, T.blue],
    ['验收', '对照标准逐项过', T.amberFill, T.amber, T.amberDark, T.amber],
    ['回顾', '沉淀进知识库', T.redFill, T.red, T.redDeep, T.red],
  ]
  const cw = 108, gap = 15, x0 = 40, y = 58
  rings.forEach(([title, sub, fill, stroke, tfill, sfill], i) => {
    const x = x0 + i * (cw + gap)
    body.push(box(x, y, cw, 96, { rx: 10, fill, stroke }))
    body.push(tx(x + cw / 2, y + 30, `第 ${i + 1} 环`, { size: 11, weight: 500, fill: stroke, anchor: 'middle' }))
    body.push(tx(x + cw / 2, y + 58, title, { size: 13, weight: 500, fill: tfill, anchor: 'middle' }))
    body.push(tx(x + cw / 2, y + 80, sub, { size: 11, fill: sfill, anchor: 'middle' }))
    if (i < rings.length - 1) body.push(tx(x + cw + gap / 2, y + 54, '→', { size: 12, fill: T.tertiary, anchor: 'middle' }))
  })
  const last = x0 + 4 * (cw + gap) + cw / 2
  const first = x0 + cw / 2
  body.push(edge(`M${last} 154 V176 H${first} V152`, T.tertiary, { dash: '4 3' }))
  body.push(tx(340, 198, '转起来，需求才不会在原地打转', { size: 11, var: `fill:var(--color-text-tertiary,${T.tertiary})`, anchor: 'middle' }))
  save('04-loop.svg', doc('需求闭环 · 五环', '提出、评审、开发、验收、回顾五环流转，底部虚线表示回到起点形成闭环。', 214, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 5. 三层架构
// ---------------------------------------------------------------------------
{
  const body = []
  const layers = [
    ['接入层', ['API 网关', '静态资源', '限流熔断'], T.blueFill, T.blue, T.blueDeep],
    ['服务层', ['订单服务', '库存服务', '用户服务'], T.greenMint, T.greenMid, T.greenDark],
    ['数据层', ['PostgreSQL', 'Redis', '对象存储'], T.warm, T.warmLine, T.ink],
  ]
  let y = 40
  for (const [name, items, fill, stroke, tfill] of layers) {
    body.push(box(40, y, 460, 108, { rx: 12, fill, stroke }))
    body.push(tx(64, y + 30, name, { size: 14, weight: 500, fill: tfill, base: 'central' }))
    items.forEach((it, i) => {
      const x = 180 + i * 104
      body.push(box(x, y + 30, 92, 48, { fill: T.paper, stroke }))
      body.push(tx(x + 46, y + 54, it, { size: 12, fill: T.ink, anchor: 'middle', base: 'central', mono: /[A-Z]/.test(it) }))
    })
    if (y < 256) body.push(edge('M270 ' + (y + 108) + ' V' + (y + 128), T.tertiary))
    y += 128
  }
  body.push(box(520, 40, 120, 364, { rx: 12, fill: T.amberFill, stroke: T.amber }))
  body.push(tx(580, 70, '横切关注', { size: 13, weight: 500, fill: T.amberDark, anchor: 'middle' }))
  ;['日志', '监控', '鉴权'].forEach((it, i) => {
    body.push(box(536, 92 + i * 60, 88, 40, { fill: T.paper, stroke: T.amber }))
    body.push(tx(580, 112 + i * 60, it, { size: 12, fill: T.amberDeep, anchor: 'middle', base: 'central' }))
  })
  body.push(tx(580, 300, '每一层', { size: 11, fill: T.amber, anchor: 'middle' }))
  body.push(tx(580, 322, '都要接', { size: 11, fill: T.amber, anchor: 'middle' }))
  save('05-architecture.svg', doc('Web 应用三层架构', '接入层、服务层、数据层自上而下，右侧琥珀色面板列出贯穿三层的横切关注点。', 430, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 6. 四象限优先级
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(tx(42, 30, '需求优先级 · 影响 × 紧迫', { size: 14, weight: 500, fill: T.ink }))
  body.push(edge('M340 60 V400', T.warmLine, { noArrow: true, sw: 1 }))
  body.push(edge('M80 230 H620', T.warmLine, { noArrow: true, sw: 1 }))
  body.push(tx(340, 48, '影响 ↑ 高', { size: 11, fill: T.sub, anchor: 'middle' }))
  body.push(tx(340, 420, '影响 ↓ 低', { size: 11, fill: T.sub, anchor: 'middle' }))
  body.push(tx(70, 234, '紧迫 ← 低', { size: 11, fill: T.sub, anchor: 'middle' }))
  body.push(tx(630, 234, '紧迫 高 →', { size: 11, fill: T.sub, anchor: 'middle' }))
  const quads = [
    [96, 72, '规划做', '重要不紧急 · 定节奏', T.blueFill, T.blue, T.blueDeep],
    [360, 72, '马上做', '重要且紧急 · 先救火', T.greenMint, T.greenMid, T.greenDark],
    [96, 250, '少做', '不重要不紧急 · 默认拒绝', T.warm, T.warmLine, T.sub],
    [360, 250, '授权做', '紧急不重要 · 交出去', T.amberFill, T.amber, T.amberDark],
  ]
  for (const [x, y, title, sub, fill, stroke, tfill] of quads) {
    body.push(box(x, y, 224, 140, { rx: 12, fill, stroke }))
    body.push(tx(x + 112, y + 56, title, { size: 14, weight: 500, fill: tfill, anchor: 'middle', base: 'central' }))
    body.push(tx(x + 112, y + 86, sub, { size: 11, fill: stroke, anchor: 'middle', base: 'central' }))
  }
  save('06-matrix.svg', doc('需求优先级四象限', '按影响与紧迫分为马上做、规划做、授权做、少做四个象限，绿为最高优先。', 440, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 7. 漏斗：注册转化
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(tx(42, 34, '注册转化漏斗', { size: 14, weight: 500, fill: T.ink }))
  const stages = [
    ['访问落地页', 10000, '100%'],
    ['点击注册', 4600, '46%'],
    ['填写资料', 2900, '63%'],
    ['完成验证', 1800, '62%'],
    ['首次付费', 640, '36%'],
  ]
  const maxW = 560, x0 = 60
  let y = 60
  const fills = [T.blueHi, T.blueFill, '#CFE0F6', '#BBD3F0', '#A9C8EA']
  stages.forEach(([label, n, pct], i) => {
    const w = Math.max(120, maxW * (n / 10000))
    const x = x0 + (maxW - w) / 2
    body.push(box(x, y, w, 56, { rx: 8, fill: fills[i], stroke: T.blue }))
    body.push(tx(340, y + 28, `${label} · ${n.toLocaleString()}`, { size: 13, weight: 500, fill: T.blueDeep, anchor: 'middle', base: 'central' }))
    if (i < stages.length - 1) {
      body.push(tx(340, y + 72, `↓ ${pct}`, { size: 11, fill: T.sub, anchor: 'middle' }))
    }
    y += 88
  })
  save('07-funnel.svg', doc('注册转化漏斗', '从访问落地页到首次付费的五级漏斗，各级标注转化率，蓝色逐级加深。', 500, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 8. 流程：支付决策
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(box(270, 40, 140, 44, { fill: T.blueFill, stroke: T.blue }))
  body.push(tx(340, 62, '发起支付', { size: 13, weight: 500, fill: T.blueDeep, anchor: 'middle', base: 'central' }))
  body.push(edge('M340 84 V104', T.tertiary))
  body.push(`<polygon points="340,104 400,144 340,184 280,144" fill="${T.paper}" stroke="${T.amber}" stroke-width="0.5"/>`)
  body.push(tx(340, 140, '余额', { size: 12, fill: T.ink, anchor: 'middle' }))
  body.push(tx(340, 160, '充足？', { size: 12, fill: T.ink, anchor: 'middle' }))
  body.push(edge('M400 144 H470', T.greenMid))
  body.push(tx(435, 136, '是', { size: 11, fill: T.greenMid, anchor: 'middle' }))
  body.push(edge('M280 144 H210', T.red))
  body.push(tx(245, 136, '否', { size: 11, fill: T.red, anchor: 'middle' }))
  body.push(box(470, 120, 150, 48, { fill: T.greenMint, stroke: T.greenMid }))
  body.push(tx(545, 138, '扣款 & 出单', { size: 13, weight: 500, fill: T.greenDark, anchor: 'middle', base: 'central' }))
  body.push(tx(545, 156, '幂等 · 可重试', { size: 11, fill: T.greenMid, anchor: 'middle', base: 'central' }))
  body.push(box(60, 120, 150, 48, { fill: T.amberFill, stroke: T.amber }))
  body.push(tx(135, 138, '触发充值', { size: 13, weight: 500, fill: T.amberDark, anchor: 'middle', base: 'central' }))
  body.push(tx(135, 156, '拉起收银台', { size: 11, fill: T.amber, anchor: 'middle', base: 'central' }))
  body.push(edge('M545 168 V210', T.greenMid))
  body.push(edge('M135 168 V210', T.amber))
  body.push(edge('M135 210 H470', T.tertiary, { noArrow: true, sw: 1 }))
  body.push(edge('M340 210 V228', T.tertiary))
  body.push(box(270, 230, 140, 44, { fill: T.warm, stroke: T.warmLine }))
  body.push(tx(340, 252, '通知结果', { size: 13, weight: 500, fill: T.ink, anchor: 'middle', base: 'central' }))
  save('08-flow.svg', doc('支付流程决策', '发起支付后判断余额，充足走扣款出单，不足触发充值，最终汇流到通知结果。', 300, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 9. 角色卡网格（3×2）
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(tx(42, 34, '项目角色 · 一人一摊', { size: 14, weight: 500, fill: T.ink }))
  const roles = [
    ['产品', '小明', '定范围 · 写验收', '绿 · 进度健康', T.greenMint, T.greenMid, T.greenDark],
    ['前端', '阿花', '界面 · 交互还原', '绿 · 进度健康', T.greenMint, T.greenMid, T.greenDark],
    ['后端', '老张', '接口 · 数据一致', '琥珀 · 联调中', T.amberFill, T.amber, T.amberDark],
    ['测试', '丽丽', '用例 · 自动化回归', '绿 · 进度健康', T.greenMint, T.greenMid, T.greenDark],
    ['运维', '大强', '部署 · 监控告警', '红 · 有阻塞', T.redFill, T.red, T.redDeep],
    ['设计', '茜茜', '视觉 · 走查验收', '绿 · 进度健康', T.greenMint, T.greenMid, T.greenDark],
  ]
  const cw = 196, ch = 120, gx = 20, gy = 24, x0 = 40, y0 = 60
  roles.forEach(([tag, name, duty, status, fill, stroke, tfill], i) => {
    const col = i % 3, row = Math.floor(i / 3)
    const x = x0 + col * (cw + gx), y = y0 + row * (ch + gy)
    body.push(box(x, y, cw, ch, { rx: 10, fill: T.paper, stroke }))
    body.push(box(x, y, cw, 34, { rx: 10, fill, stroke, sw: 0.5 }))
    body.push(`<rect x="${x}" y="${y + 17}" width="${cw}" height="17" fill="${fill}"/>`)
    body.push(tx(x + 14, y + 17, tag, { size: 11, weight: 500, fill: stroke, base: 'central' }))
    body.push(tx(x + cw - 14, y + 17, name, { size: 12, weight: 500, fill: tfill, anchor: 'end', base: 'central' }))
    body.push(tx(x + 14, y + 58, duty, { size: 12, fill: T.ink, base: 'central' }))
    body.push(tx(x + 14, y + 92, status, { size: 11, fill: stroke, base: 'central' }))
  })
  save('09-card-grid.svg', doc('项目角色卡网格', '六个角色各守一摊，卡片顶部色条按进度语义着色，红为阻塞、琥珀为联调中。', 350, body.join('\n')))
}

// ---------------------------------------------------------------------------
// 10. 甘特：两周迭代
// ---------------------------------------------------------------------------
{
  const body = []
  body.push(tx(42, 32, '两周迭代 · 甘特', { size: 14, weight: 500, fill: T.ink }))
  const days = ['一', '二', '三', '四', '五', '六', '日', '一', '二', '三', '四', '五', '六', '日']
  const gx0 = 150, dw = 36, gy = 56
  days.forEach((d, i) => {
    const x = gx0 + i * dw
    const weekend = i === 5 || i === 6 || i === 12 || i === 13
    if (weekend) body.push(`<rect x="${x}" y="${gy - 6}" width="${dw}" height="300" fill="${T.warm}" opacity="0.5"/>`)
    body.push(tx(x + dw / 2, gy + 10, d, { size: 11, fill: weekend ? T.tertiary : T.sub, anchor: 'middle' }))
  })
  body.push(edge(`M${gx0} ${gy + 18} H${gx0 + 14 * dw}`, T.warmLine, { noArrow: true, sw: 1 }))
  const tasks = [
    ['需求评审', 0, 1, T.blueFill, T.blue],
    ['接口设计', 1, 2, T.blueFill, T.blue],
    ['后端开发', 2, 4, T.greenMint, T.greenMid],
    ['前端开发', 3, 5, T.greenMint, T.greenMid],
    ['联调', 6, 2, T.amberFill, T.amber],
    ['测试回归', 8, 3, T.purpleFill, T.purple],
    ['发布上线', 12, 1, T.blueHi, T.blue],
  ]
  tasks.forEach(([name, start, len, fill, stroke], i) => {
    const y = gy + 40 + i * 38
    body.push(tx(140, y + 13, name, { size: 12, fill: T.ink, anchor: 'end' }))
    body.push(box(gx0 + start * dw, y, len * dw - 6, 26, { rx: 8, fill, stroke }))
  })
  body.push(`<polygon points="${gx0 + 12 * dw - 3},${gy + 40 + 6 * 38 - 6} ${gx0 + 12 * dw + 9},${gy + 40 + 6 * 38 + 6} ${gx0 + 12 * dw - 3},${gy + 40 + 6 * 38 + 18} ${gx0 + 12 * dw - 15},${gy + 40 + 6 * 38 + 6}" fill="${T.red}"/>`)
  save('10-gantt.svg', doc('两周迭代甘特图', '七项任务分布在两周工作日，灰底为周末，红色菱形标记发布里程碑。', 400, body.join('\n')))
}

console.log(`写出 ${files.length} 张到 preview/design/`)
for (const f of files) console.log('  ' + f)
