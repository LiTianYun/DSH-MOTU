/** 检查展示图作为 XML 是否合法（GitHub 用 <img> 渲染，必须严格合法）。一次性工具。 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { setupDom } from './dom-env.mjs'

const dom = setupDom({ scripts: false })
const { window } = dom
const dir = 'preview/showcase'

for (const name of readdirSync(dir).filter((n) => n.endsWith('.svg')).sort()) {
  const text = readFileSync(join(dir, name), 'utf8')
  const parsed = new window.DOMParser().parseFromString(text, 'image/svg+xml')
  const root = parsed.documentElement
  const bad = root.nodeName.toLowerCase() === 'parsererror' || parsed.querySelector('parsererror') !== null
  const foreign = /<foreignObject/i.test(text)
  const external = /(?:href|src)\s*=\s*"(?:https?:)?\/\//i.test(text)
  const urlRefs = [...text.matchAll(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi)].map((m) => m[2])
  const remoteUrls = urlRefs.filter((u) => /^https?:|^\/\//i.test(u))
  const styleTags = (text.match(/<style/gi) ?? []).length
  const flags = []
  if (bad) flags.push('XML 非法')
  if (foreign) flags.push('含 foreignObject')
  if (external) flags.push('含外部 href/src')
  if (remoteUrls.length > 0) flags.push(`含远程 url(): ${remoteUrls.slice(0, 2).join(',')}`)
  console.log(`${name.padEnd(26)} ${flags.length === 0 ? '合法 ✓' : flags.join(' / ')}  [style×${styleTags}]`)
  if (bad) {
    const message = parsed.querySelector('parsererror')?.textContent ?? ''
    console.log('    解析错误:', message.replace(/\s+/g, ' ').slice(0, 160))
  }
}
