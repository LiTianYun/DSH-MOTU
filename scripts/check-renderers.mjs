/**
 * Render every adapter headlessly, against the engines that actually ship.
 *
 *   npm run check:renderers
 *
 * This is the check that matters for "does it still draw": it loads the
 * vendored builds the way the browser loads them (a script in the window, not
 * an import), runs the real adapter from `lib/client.js`, and asserts that real
 * markup came back. A manifest entry whose engine cannot produce anything — a
 * renamed global, a missing file, a broken adapter — fails here rather than in
 * someone's conversation.
 *
 * The five engines render in one process on purpose: this is a smoke test of
 * the shipped artefacts, and process isolation is only needed for the two
 * engines (D2, Excalidraw) that this plugin does not ship.
 *
 * @module dsh-visual-kit/scripts/check-renderers
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadVendorScript, setupDom } from './dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const dom = setupDom({ scripts: true })
const { window } = dom

// The plugin's browser half, loaded through its own module contract.
const registry = new Map()
window.__ModuleLoader__ = {
  load({ id, factory }) {
    registry.set(id, factory(() => {
      throw new Error('this half requires nothing')
    }))
  },
}
window.eval(readFileSync(join(root, 'lib', 'client.js'), 'utf8'))

const client = registry.get('dsh-visual-kit')
if (client === undefined) {
  console.error('浏览器半没有通过模块加载器注册')
  process.exit(1)
}

const { ADAPTERS } = client.internals

/** The globals each vendored build defines, keyed by asset path. */
const loaded = new Map()

/**
 * Load one renderer's engines into the window.
 * @param {object} spec - the renderer's manifest entry.
 * @returns {Promise<Record<string, unknown>>} its globals.
 */
async function loadEngine(spec) {
  const globals = {}
  for (const asset of spec.assets) {
    if (!loaded.has(asset.path)) {
      loadVendorScript(dom, join(root, 'vendor', asset.path))
      loaded.set(asset.path, true)
    }
    if (asset.global !== undefined) {
      globals[asset.global] = window[asset.global]
      if (globals[asset.global] === undefined) {
        throw new Error(`加载 ${asset.path} 后 window.${asset.global} 仍未定义`)
      }
    }
  }
  return globals
}

let failures = 0
const rows = []

for (const spec of renderers) {
  const adapter = ADAPTERS[spec.id]
  const label = spec.label.padEnd(14)
  if (adapter === undefined) {
    console.log(`FAIL ${label} 浏览器半没有这个适配器`)
    failures += 1
    continue
  }

  const env = {
    loadEngine: () => loadEngine(spec),
    container: () => window.document.createElement('div'),
    clearContainer: () => {},
    theme: 'light',
    presentation: {
      fontFamily: 'Microsoft YaHei, sans-serif',
      fontSize: 13,
      canvasMaxHeight: 360,
      canvasPadding: 16,
      background: 'auto',
      showToolbar: true,
    },
    settings: spec.defaults,
    behaviour: {},
    // jsdom has no real layout; graphviz's text-overflow measure would run
    // against stub metrics and needlessly regrow margins. The browser path
    // measures for real.
    measure: false,
    nextId: () => `check-${spec.id}`,
  }

  const started = Date.now()
  try {
    const result = await adapter.render(spec.sample, env)
    const markup = String(result?.markup ?? '')
    const elapsed = Date.now() - started
    const hasSvg = markup.includes('<svg')
    const version = spec.assets.map((asset) => asset.pkg).join('+')
    if (!hasSvg || markup.length < 200) {
      throw new Error(`产物不像一张图（${markup.length} 字符，含 <svg>: ${hasSvg}）`)
    }
    rows.push({ id: spec.id, ok: true, bytes: markup.length, elapsed, version })
    console.log(`ok   ${label} ${String(markup.length).padStart(7)} 字符  ${String(elapsed).padStart(5)} ms  ${version}`)
  } catch (error) {
    failures += 1
    rows.push({ id: spec.id, ok: false, message: String(error?.message ?? error) })
    console.log(`FAIL ${label} ${String(error?.message ?? error).split('\n')[0].slice(0, 160)}`)
  }
}

// The detector is what claims an unlabelled fence; a detector that fires on
// ordinary code would render someone's config file as a diagram.
const detectors = [
  ['graphviz', 'digraph G { a -> b }', true],
  ['graphviz', 'const graph = new Map()', false],
  ['nomnoml', '[A] -> [B]', true],
  ['nomnoml', 'const a = [1] -> 2', false],
  ['echarts', '{ "series": [{ "type": "bar", "data": [1] }] }', true],
  ['echarts', '{ "name": "pkg", "version": "1.0.0" }', false],
  ['vega-lite', '{ "$schema": "https://vega.github.io/schema/vega-lite/v6.json", "mark": "bar" }', true],
  ['vega-lite', '{ "dependencies": { "react": "18" } }', false],
  ['mermaid', 'flowchart TD\n  A --> B', true],
  ['mermaid', 'const x = 1\nconsole.log(x)', false],
]
console.log('')
for (const [id, source, expected] of detectors) {
  const actual = ADAPTERS[id]?.detect?.(source) === true
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} detect ${id.padEnd(10)} ${expected ? '应识别' : '不应识别'}  ${JSON.stringify(source.slice(0, 46))}`)
}

const total = rows.filter((row) => row.ok).reduce((sum, row) => sum + row.bytes, 0)
console.log(`\n${rows.filter((row) => row.ok).length}/${renderers.length} 个渲染器产出真实产物，合计 ${(total / 1024).toFixed(0)} KB；失败项 ${failures}`)
process.exit(failures === 0 ? 0 : 1)
