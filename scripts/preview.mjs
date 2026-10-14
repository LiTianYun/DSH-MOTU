/**
 * Render the manifest samples with the real adapters and write preview SVGs.
 *
 *   node scripts/preview.mjs
 *
 * Lets the polished chrome be reviewed as files before a page refresh, with
 * the same code path the browser runs.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadVendorScript, setupDom } from './dom-env.mjs'
import { renderers } from '../lib/renderers/manifest.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(root, 'preview')

const dom = setupDom({ scripts: true })
const { window } = dom

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
const { ADAPTERS } = client.internals

const loaded = new Map()

async function loadEngine(spec) {
  const globals = {}
  for (const asset of spec.assets) {
    if (!loaded.has(asset.path)) {
      loadVendorScript(dom, join(root, 'vendor', asset.path))
      loaded.set(asset.path, true)
    }
    if (asset.global !== undefined) globals[asset.global] = window[asset.global]
  }
  return globals
}

mkdirSync(outDir, { recursive: true })
let seq = 0

for (const theme of ['light', 'dark']) {
  // 主题通过 body 背景传递：chrome() 与 surfaceColor() 都读这里。
  window.document.documentElement.setAttribute('data-theme', theme)
  for (const spec of renderers) {
    const adapter = ADAPTERS[spec.id]
    const env = {
      loadEngine: () => loadEngine(spec),
      container: () => window.document.createElement('div'),
      clearContainer: () => {},
      theme,
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
      measure: false,
      nextId: () => `preview-${(seq += 1)}`,
    }
    try {
      const result = await adapter.render(spec.sample, env)
      const file = join(outDir, `${spec.id}-${theme}.svg`)
      writeFileSync(file, String(result.markup), 'utf8')
      console.log(`${theme.padEnd(5)} ${spec.id.padEnd(10)} -> ${(result.markup.length / 1024).toFixed(1)} KB`)
    } catch (error) {
      console.log(`${theme.padEnd(5)} ${spec.id.padEnd(10)} FAIL ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
}
console.log(`\npreview/ 共 ${renderers.length * 2} 张`)
