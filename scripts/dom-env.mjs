/**
 * The headless browser environment the render checks run in.
 *
 * Rendering libraries assume a browser. jsdom is close, but it has gaps that
 * matter here, and each one is a hang or a crash rather than a warning:
 *
 *   - no SVG text metrics (`getBBox`), which every layout engine calls;
 *   - no font loading (`document.fonts`), which libraries await forever;
 *   - no constructable stylesheets (`CSSStyleSheet`), which mermaid uses to
 *     inject its theme CSS.
 *
 * Text metrics stay estimates: a Han glyph is roughly twice a Latin one at the
 * same size, which is what keeps Chinese labels from overlapping their boxes.
 * What the checks assert — that an engine loads and produces markup — does not
 * depend on exact metrics.
 *
 * @module dsh-visual-kit/scripts/dom-env
 */

import { readFileSync } from 'node:fs'

import { JSDOM } from 'jsdom'

/**
 * Build a window the engines can run in.
 *
 * @param {{scripts?: boolean, url?: string}} [options] - `scripts` enables
 *   `window.eval`, which is how the vendored builds are loaded (they are UMD
 *   files that assign a global, so they must run inside the window, not be
 *   imported). `url` gives the document a real base: Graphviz derives its script
 *   directory from `document.baseURI`, and against jsdom's default `about:blank`
 *   that derivation throws before the engine ever runs.
 * @returns {JSDOM} the window.
 */
export function setupDom(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    pretendToBeVisual: true,
    url: options.url ?? 'http://localhost/',
    // Mermaid 11's dist is an esbuild ESM bundle that maps its modules on a
    // global-scoped `var` and reads them back through `globalThis` at the end.
    // That round trip only works under classic-script semantics — a real
    // `<script>` execution, where top-level `var` lands on the global object —
    // so the vendored builds are injected as inline script tags, not eval'd.
    runScripts: options.scripts === true ? 'dangerously' : undefined,
  })
  const { window } = dom

  const install = (key, value) => {
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    } catch {
      /* a global we cannot replace is not worth failing over */
    }
  }

  for (const key of ['window', 'document', 'DOMParser', 'Node', 'Element', 'HTMLElement', 'SVGElement', 'DocumentFragment', 'ShadowRoot']) {
    const value = key === 'window' ? window : window[key]
    if (value !== undefined) install(key, value)
  }
  install('getComputedStyle', window.getComputedStyle.bind(window))
  install('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0))
  install('cancelAnimationFrame', (id) => clearTimeout(id))
  install('devicePixelRatio', window.devicePixelRatio ?? 1)

  // Vega clones its runtime state with `structuredClone`, which jsdom lacks and
  // every real browser has. Node's own implementation is the honest stand-in.
  if (typeof window.structuredClone !== 'function' && typeof globalThis.structuredClone === 'function') {
    install('structuredClone', globalThis.structuredClone)
    Object.defineProperty(window, 'structuredClone', { value: globalThis.structuredClone, configurable: true, writable: true })
  }

  if (typeof window.matchMedia !== 'function') {
    install('matchMedia', (query) => ({
      matches: false,
      media: String(query),
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }))
  }

  if (window.document.fonts === undefined) {
    install('FontFace', class FontFace {})
    Object.defineProperty(window.document, 'fonts', {
      value: { ready: Promise.resolve(), status: 'loaded', check: () => true, add: () => {}, delete: () => {}, forEach: () => {} },
      configurable: true,
    })
  }

  const StyleSheetClass =
    typeof window.CSSStyleSheet === 'function'
      ? window.CSSStyleSheet
      : class MinimalStyleSheet {
          replaceSync(text) {
            this.cssText = text
          }
        }
  if (typeof StyleSheetClass.prototype.replaceSync !== 'function') {
    StyleSheetClass.prototype.replaceSync = function replaceSync(text) {
      this.cssText = text
    }
  }
  install('CSSStyleSheet', StyleSheetClass)
  if (window.document.adoptedStyleSheets === undefined) {
    Object.defineProperty(window.document, 'adoptedStyleSheets', { value: [], writable: true, configurable: true })
  }

  if (typeof window.ResizeObserver !== 'function') {
    install('ResizeObserver', class ResizeObserver { observe() {} unobserve() {} disconnect() {} })
  }
  if (typeof window.IntersectionObserver !== 'function') {
    install(
      'IntersectionObserver',
      class IntersectionObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords() {
          return []
        }
      },
    )
  }

  /** Estimate the rendered width of a text run. */
  const measure = (text) => {
    const value = String(text ?? '')
    const cjk = (value.match(/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/g) ?? []).length
    const latin = value.length - cjk
    return Math.max(12, latin * 8 + cjk * 15) + 16
  }

  const proto = window.SVGElement?.prototype
  if (proto !== undefined && typeof proto.getBBox !== 'function') {
    proto.getBBox = function getBBox() {
      // A root <svg> carries the injected theme CSS in a <style> child; counting
      // it as ink made a six-node flowchart 35 000px wide.
      let text = String(this.textContent ?? '')
      const style = this.querySelector?.('style, script')
      if (style !== null && style !== undefined) text = text.replace(String(style.textContent ?? ''), '')
      return { x: 0, y: 0, width: measure(text), height: 24 }
    }
    proto.getComputedTextLength = function getComputedTextLength() {
      return this.getBBox().width
    }
  }

  /** Estimate an element's box; leaves only, since a container's text is the whole diagram. */
  const estimateBox = (element) => {
    if (element.children !== undefined && element.children.length > 0) return { width: 0, height: 0 }
    const text = String(element.textContent ?? '')
    return { width: text.length === 0 ? 0 : measure(text), height: text.length === 0 ? 0 : 24 }
  }
  const htmlProto = window.HTMLElement?.prototype
  if (htmlProto !== undefined) {
    for (const [property, axis] of [
      ['offsetWidth', 'width'],
      ['clientWidth', 'width'],
      ['scrollWidth', 'width'],
      ['offsetHeight', 'height'],
      ['clientHeight', 'height'],
      ['scrollHeight', 'height'],
    ]) {
      try {
        Object.defineProperty(htmlProto, property, {
          configurable: true,
          get() {
            return estimateBox(this)[axis]
          },
        })
      } catch {
        /* a property we cannot redefine keeps jsdom's value */
      }
    }
  }
  const elementProto = window.Element?.prototype
  const nativeRect = elementProto?.getBoundingClientRect
  if (elementProto !== undefined && typeof nativeRect === 'function') {
    elementProto.getBoundingClientRect = function getBoundingClientRect() {
      const rect = nativeRect.call(this)
      if (rect.width > 0 || rect.height > 0) return rect
      const { width, height } = estimateBox(this)
      return {
        x: rect.x,
        y: rect.y,
        top: rect.top,
        left: rect.left,
        right: rect.left + width,
        bottom: rect.top + height,
        width,
        height,
        toJSON() {
          return { width, height }
        },
      }
    }
  }

  return dom
}

/**
 * Run one vendored UMD build inside the window, so its global is defined.
 *
 * The builds are files the browser loads with a `<script>` tag, so they are
 * injected as inline script tags here — the same classic-script semantics,
 * where a top-level `var` lands on the global object the way these bundles
 * expect. Importing them as modules would exercise a different code path than
 * the one that ships.
 *
 * @param {JSDOM} dom - the window.
 * @param {string} file - the vendored file.
 * @returns {string[]} the global names the build defined.
 */
export function loadVendorScript(dom, file) {
  const source = readFileSync(file, 'utf8')
  const before = new Set(Object.keys(dom.window))
  const tag = dom.window.document.createElement('script')
  tag.textContent = source
  dom.window.document.body.appendChild(tag)
  return Object.keys(dom.window).filter((key) => !before.has(key))
}
