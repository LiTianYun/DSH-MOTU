/**
 * The standing prompt: what the model is told every turn.
 *
 * Every character here is paid for on every model step, so this file guards two
 * properties that are easy to lose while adding renderers:
 *
 *   1. the prompt stays **bounded** as renderer families are added, and
 *   2. renderer-specific guidance is **declared in the manifest**, not branched
 *      on a renderer id inside the prompt builder.
 */

import assert from 'node:assert/strict'
import { it } from 'node:test'

import { PROMPT_BUDGET, promptText } from '../lib/index.js'
import { enabledRenderers, renderers } from '../lib/renderers/manifest.js'

/** A synthetic roster of `count` renderers, as if many styles had been added. */
function roster(count) {
  const list = []
  for (let index = 0; index < count; index++) {
    const base = renderers[index % renderers.length]
    list.push(index < renderers.length
      ? { ...base, enabled: true, assets: [] }
      : { ...base, id: `${base.id}-extra-${index}`, label: `${base.label}·扩展${index}`, enabled: true, assets: [] })
  }
  return list
}

it('提示段随风格数增长但有上限', () => {
  const sizes = [6, 10, 20, 30].map((count) => promptText({}, roster(count)).length)
  for (const size of sizes) assert.ok(size <= PROMPT_BUDGET, `提示段不得超过预算，实测 ${size}`)
  // 单调但不失控：20 个风格时仍应在预算内
  assert.ok(sizes[3] >= sizes[0], '风格变多不应让提示段变短')
  assert.ok(sizes[3] <= PROMPT_BUDGET, `30 个风格时仍应封顶，实测 ${sizes[3]}`)
})

it('超出预算时点名去技能参考页，而不是静默丢弃', () => {
  const text = promptText({}, roster(30))
  assert.match(text, /见技能参考页/, '被省略的部分必须说明去哪找')
  // 选型行至少保留一条，不能变成空的
  assert.match(text, /选型：\S/)
})

it('渲染器专属补句由 manifest 声明，且尊重它绑定的开关', () => {
  const full = promptText({}, enabledRenderers({}))
  const note = renderers.find((spec) => spec.id === 'echarts').promptNote
  assert.ok(note.length > 0, 'echarts 应声明常驻补句')
  assert.ok(full.includes(note), '开关默认开启时应包含该补句')

  const config = { renderers: { echarts: { interactive: false } } }
  const off = promptText(config, enabledRenderers(config))
  assert.ok(!off.includes(note), '交互开关关闭后该补句应消失')
  assert.ok(off.includes('```echarts'), '普通 echarts 栅栏不受影响')
  assert.ok(!off.includes('```echarts-interactive'), '交互栅栏应随之消失')
})

it('提示段里不再按渲染器 id 分支', async () => {
  // 直接检查源码：promptText 若重新长出 `spec.id === '…'` 这种分支，扩展位就破了。
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8'))
  const start = source.indexOf('export function promptText')
  const body = source.slice(start, source.indexOf('\n}', start))
  assert.ok(!/spec\.id\s*===/.test(body), 'promptText 不应按 id 判断')
})

it('预算在任何规模下都是硬顶，不靠"预留"糊过去', () => {
  // 之前靠"预留溢出提示的字符"来守预算，但在已经不够的预算里再减等于没留：
  // 30 个渲染器时超出 37 字符。现在末尾有一次硬裁切，这条钉住它。
  for (const count of [8, 20, 30, 60, 120, 300]) {
    const size = promptText({}, roster(count)).length
    assert.ok(size <= PROMPT_BUDGET, `${count} 个渲染器时超出预算：${size} > ${PROMPT_BUDGET}`)
  }
  // 裁切到极限也要留下可用的选型行，不能裁成空的
  assert.match(promptText({}, roster(300)), /选型：\S/)
})

it('放不下的补句必须点名，不静默丢弃', () => {
  // svg 的结构与排版规范被静默挤掉过一次，代价是产出非法 SVG
  const text = promptText({}, roster(300))
  assert.match(text, /的写法要点见技能参考页/, '被挤掉的补句要点名')
  assert.match(text, /其余（[^）]+）见技能参考页/, '被挤掉的选型条目也要点名')
})
