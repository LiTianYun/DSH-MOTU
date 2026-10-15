/**
 * dsh-visual-kit — browser half.
 *
 * Turns fenced blocks in the conversation into real diagrams and charts. The
 * engines are not bundled here: each one is fetched from the host half the first
 * time a conversation actually uses that renderer, so a session that only draws
 * flowcharts never downloads a charting library.
 *
 * The shape of this half is deliberately generic. Everything renderer-specific
 * lives in `ADAPTERS` — an id, an optional content detector, and a `render`
 * function — while the pipeline around it (finding blocks, routing them,
 * loading engines, the canvas and its toolbar, error cards, theme re-rendering,
 * diagnostics) is shared. Adding a renderer is one adapter plus one manifest
 * entry in the host half.
 *
 * Two host facts this depends on, both verified against the shipped component:
 *
 *   - a code block is `div.md-code-block`, its body is `[data-code-block-content]`
 *     and its toolbar is `[data-code-block-banner]`;
 *   - transcript history mounts lazily, so scanning is driven by a
 *     MutationObserver on the body rather than by a one-shot pass.
 *
 * Module format is the client module loader's lazy CJS contract:
 * `window.__ModuleLoader__.load({ id, factory })`, `factory(require)` returning
 * the exports object that carries `apply`.
 */

window.__ModuleLoader__.load({
  id: 'dsh-visual-kit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // ---------------------------------------------------------------------
    // Constants.
    // ---------------------------------------------------------------------

    /** Public route prefix owned by the host half. */
    const ROUTE_PREFIX = '/dsh-visual-kit'

    /** The renderer catalogue: which renderers are enabled, and where their engines live. */
    const CATALOGUE_URL = `${ROUTE_PREFIX}/renderers.json`

    /** Effective configuration and enabled set, polled for live changes. */
    const CONFIG_URL = `${ROUTE_PREFIX}/config`

    /** The diagnostic beacon. */
    const DIAG_URL = `${ROUTE_PREFIX}/diag`

    /** Build stamp for this browser half, logged on load. */
    const CLIENT_REV = 'v0.4.1'
    const DISPLAY_TIMEOUT_MS = 15_000
    const MAX_INTERACTIVE_BYTES = 256 * 1024
    const MAX_DATA_POINTS = 10_000

    /**
     * How long the DOM must stay quiet before a scan runs. Streaming a code
     * fence mutates the DOM on every token, so this is what turns "half a
     * flowchart" into "no diagram yet".
     */
    const SCAN_DEBOUNCE_MS = 500

    /** How long a theme change must settle before every figure re-renders. */
    const THEME_DEBOUNCE_MS = 250

    /** Blocks within this margin of the viewport render ahead of the scroll. */
    const LAZY_MARGIN = '200px'

    const MIN_SCALE = 0.2
    const MAX_SCALE = 5
    const SCALE_STEP = 1.25

    /**
     * How far a figure may be shrunk to fit before it is better to leave it at
     * full size and let the canvas scroll. Scaling a wide diagram down to the
     * message width is what makes its labels unreadable: the shape is right, the
     * text is gone.
     */
    const FIT_FLOOR = 0.75

    /**
     * The lowest a figure may shrink to satisfy the canvas height.
     *
     * Lower than FIT_FLOOR on purpose: a tall diagram cannot be scrolled into
     * view the way a wide one can, so shrinking beats hiding the top of it.
     */
    const HEIGHT_FLOOR = 0.45

    /** How often the enabled set is re-checked while the page is open. */
    const CONFIG_POLL_MS = 30_000

    const STYLE_ID = 'dsh-visual-kit-styles'

    /** The font stack the reference application uses, as a last resort. */
    const FALLBACK_FONT =
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", "Cantarell", "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif'

    /** Tagged console diagnostics (filter devtools by dsh-visual-kit). */
    const log = (...args) => console.log('[dsh-visual-kit]', ...args)

    /**
     * Counters this half reports back to its host half.
     *
     * "The diagram did not appear" has several unrelated causes — the browser
     * half never loaded, no fence was recognised, an engine failed to load, the
     * syntax was wrong — and these counters tell them apart from outside the
     * browser, without asking the user to open devtools.
     */
    const diag = {
      rev: CLIENT_REV,
      started: false,
      scans: 0,
      candidates: 0,
      rendered: 0,
      failed: 0,
      degraded: 0,
      byRenderer: {},
      catalogueRev: '',
      enabled: [],
      theme: '',
      lastError: '',
      domSamples: [],
    }

    // ---------------------------------------------------------------------
    // Mutable state. All of it is released by `stop()`.
    // ---------------------------------------------------------------------

    /** The fetched renderer catalogue, or null before the first fetch. */
    let catalogue = null

    /** The configuration revision the catalogue was built from. */
    let catalogueRev = ''

    /** In-flight catalogue fetch, so concurrent scans share one request. */
    let cataloguePromise = null

    /** Loaded engines by renderer id: `{ api, assets }`. */
    const engines = new Map()

    /** In-flight engine loads by renderer id, so a block cannot load twice. */
    const enginePromises = new Map()

    /** A hidden holder for engines that need a laid-out node. */
    let scratch = null

    let domObserver = null
    let themeObserver = null
    let lazyObserver = null
    let scanTimer = 0
    let themeTimer = 0
    let configTimer = 0
    let focusHandler = null
    let started = false
    let styleInjected = false
    let renderSeq = 0

    /** The client runtime context, kept so a button can reach the session service. */
    let clientCtx = null

    /** Which session this page is showing; learned from the session probe. */
    let currentSessionId = ''
    let currentChatSnapshot = null

    /** Renders run one at a time: two engines parsing at once stall the frame. */
    let renderQueue = Promise.resolve()
    const displays = new Map()
    const renderJobs = new Set()

    // ---------------------------------------------------------------------
    // Small DOM helpers.
    // ---------------------------------------------------------------------

    /**
     * Create an element.
     * @param {string} tag - tag name.
     * @param {string} [className] - class attribute.
     * @param {string} [text] - text content.
     * @returns {HTMLElement} the element.
     */
    function el(tag, className, text) {
      const node = document.createElement(tag)
      if (className !== undefined && className !== '') node.className = className
      if (text !== undefined) node.textContent = text
      return node
    }

    /**
     * Create a toolbar button.
     * @param {string} label - visible label.
     * @param {string} title - tooltip.
     * @param {() => void} onClick - handler.
     * @param {string} [variant] - extra class.
     * @returns {HTMLElement} the button.
     */
    function button(label, title, onClick, variant) {
      const node = el('button', variant === undefined ? 'vk-btn' : `vk-btn vk-btn-${variant}`, label)
      node.type = 'button'
      node.title = title
      node.setAttribute('aria-label', title)
      node.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        onClick()
      })
      return node
    }

    /**
     * The source text of one block body.
     *
     * Both renderer arms separate their `<span class="line">` elements with real
     * newlines, so ordinary `textContent` reassembles the fence exactly. The
     * line-by-line join is a safety net for any arm that loses those separators:
     * without it every line would run together and a perfectly valid diagram
     * would be rejected.
     *
     * @param {HTMLElement} body - the block body.
     * @returns {string} the source text.
     */
    function readSource(body) {
      const raw = String(body.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n')
      if (raw.includes('\n')) return raw
      const lines = body.querySelectorAll('.line')
      if (lines.length < 2) return raw
      return [...lines].map((line) => line.textContent).join('\n')
    }

    /**
     * A stable hash of a source, used to skip work already done.
     * @param {string} text - the source.
     * @returns {string} a short hash.
     */
    function hash(text) {
      let h = 5381
      for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
      return (h >>> 0).toString(36)
    }

    /**
     * Which theme the application is showing.
     *
     * The theme service is not reachable from a plain DOM plugin, so this reads
     * what the DOM actually renders. Two checks, in order:
     *
     *   - an explicit `data-theme` / `data-color-scheme` attribute wins — the
     *     theme service sets it once it has applied a theme;
     *   - otherwise the body's *background*: a dark surface means a dark theme.
     *     (The very first scan can run before the theme service has painted any
     *     attribute, so the surface probe must be right on its own.)
     *
     * The fallback probes the text colour instead, with the opposite polarity:
     * light text on a dark surface. Two earlier mistakes are worth naming so
     * they are not reintroduced: probing the text colour with the background's
     * polarity (dark text reads as "dark theme" and every canvas goes black in
     * a light UI), and trusting a transparent background (which parses as
     * black and would again force "dark").
     *
     * @returns {'light'|'dark'} the resolved theme.
     */
    function resolveTheme() {
      try {
        const root = document.documentElement
        const explicit = String(
          root.getAttribute('data-theme') ?? root.getAttribute('data-color-scheme') ?? root.dataset?.theme ?? '',
        ).toLowerCase()
        if (explicit.includes('dark')) return 'dark'
        if (explicit.includes('light')) return 'light'

        const channelsOf = (value) => {
          const channels = String(value ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
          if (channels.length < 3) return null
          if (channels.length >= 4 && channels[3] === 0) return null // transparent is not a colour
          return channels
        }
        for (const element of [document.body, root]) {
          if (element === null || element === undefined) continue
          const channels = channelsOf(getComputedStyle(element).backgroundColor)
          if (channels === null) continue
          const [r, g, b] = channels
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? 'dark' : 'light'
        }

        const text = channelsOf(getComputedStyle(root).color)
        if (text !== null) {
          const [r, g, b] = text
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5 ? 'dark' : 'light'
        }
        return 'light'
      } catch {
        return 'light'
      }
    }

    /**
     * The application's own font stack, so figures match the text around them.
     * @returns {string} a CSS font stack.
     */
    function themeFontFamily() {
      try {
        const styles = getComputedStyle(document.documentElement)
        for (const name of ['--dsw-font-family', '--dsw-font-sans', '--cb-font-family']) {
          const value = String(styles.getPropertyValue(name) ?? '').trim()
          if (value !== '') return value
        }
      } catch {
        // Falls through to the reference stack.
      }
      return FALLBACK_FONT
    }

    // ---------------------------------------------------------------------
    // The catalogue: what may render, and where the engines are.
    // ---------------------------------------------------------------------

    /**
     * Fetch the renderer catalogue.
     *
     * The host half is the single source of truth for what is enabled, so this
     * half renders exactly what the configuration allows and nothing else.
     *
     * @param {boolean} [force] - refetch even when a revision is already held.
     * @returns {Promise<object|null>} the catalogue, or null when unavailable.
     */
    async function ensureCatalogue(force = false) {
      if (catalogue !== null && force !== true) return catalogue
      if (cataloguePromise !== null) return cataloguePromise
      cataloguePromise = (async () => {
        try {
          const response = await fetch(CATALOGUE_URL, { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          catalogue = {
            rev: String(payload.rev ?? ''),
            renderers: Array.isArray(payload.renderers) ? payload.renderers : [],
            presentation: payload.presentation ?? {},
            behavior: payload.behavior ?? {},
            byLanguage: new Map(),
          }
          for (const spec of catalogue.renderers) {
            for (const language of spec.languages ?? []) {
              catalogue.byLanguage.set(String(language).toLowerCase(), spec.id)
            }
          }
          catalogueRev = catalogue.rev
          diag.catalogueRev = catalogue.rev
          diag.enabled = catalogue.renderers.filter((spec) => spec.enabled).map((spec) => spec.id)
          return catalogue
        } catch (error) {
          // Without the catalogue nothing can be routed; say so once, and let
          // the next scan try again rather than caching the failure.
          diag.lastError = `catalogue: ${String(error?.message ?? error)}`
          log('catalogue fetch failed', diag.lastError)
          return null
        } finally {
          cataloguePromise = null
        }
      })()
      return cataloguePromise
    }

    /**
     * Ask the host half whether the enabled set changed, and refresh if it did.
     *
     * Configuration edits must take effect without a reload, and a disabled
     * renderer must hand its blocks back to plain code.
     *
     * @returns {Promise<boolean>} whether anything changed.
     */
    async function refreshCatalogueIfChanged() {
      try {
        const response = await fetch(CONFIG_URL, { credentials: 'same-origin' })
        if (!response.ok) return false
        const payload = await response.json()
        const value = payload?.value ?? {}
        const next = `${value.rev ?? ''}:${(value.enabled ?? []).join(',')}`
        const current = `${catalogueRev}:${diag.enabled.join(',')}`
        const behaviourChanged = value.settings !== undefined &&
          ((value.settings.autoRender !== false) !== (catalogue?.behavior?.autoRender !== false) ||
           (value.settings.selfRepair !== false) !== (catalogue?.behavior?.selfRepair !== false) ||
           (value.settings.interactive !== false) !== (catalogue?.renderers.find((spec) => spec.id === 'echarts')?.settings?.interactive !== false))
        if (catalogue !== null && next === current && !behaviourChanged) return false
        await ensureCatalogue(true)
        return true
      } catch {
        return false
      }
    }

    // ---------------------------------------------------------------------
    // Engine loading.
    // ---------------------------------------------------------------------

    /**
     * Inject one script and resolve when it has run.
     *
     * @param {string} url - the asset URL.
     * @returns {Promise<void>} resolves on load, rejects with a readable reason.
     */
    const assetLoads = new Map()
    function loadScript(url) {
      if (assetLoads.has(url)) return assetLoads.get(url)
      const promise = new Promise((resolve, reject) => {
        let tag = document.querySelector(`script[data-vk-asset="${url}"]`)
        if (tag?.dataset.vkLoaded === '1') { resolve(); return }
        const existing = tag !== null
        if (!tag) {
          tag = document.createElement('script')
          tag.src = url
          tag.async = true
          tag.dataset.vkAsset = url
        }
        let timer
        const clean = () => {
          clearTimeout(timer)
          tag.removeEventListener('load', loaded)
          tag.removeEventListener('error', failed)
        }
        const loaded = () => { clean(); tag.dataset.vkLoaded = '1'; resolve() }
        const failed = () => { clean(); tag.remove(); reject(new Error(`引擎脚本加载失败或超时：${url}`)) }
        tag.addEventListener('load', loaded, { once: true })
        tag.addEventListener('error', failed, { once: true })
        timer = setTimeout(failed, DISPLAY_TIMEOUT_MS)
        if (!existing) document.head.appendChild(tag)
      })
      assetLoads.set(url, promise)
      promise.then(() => assetLoads.delete(url), () => assetLoads.delete(url))
      return promise
    }

    /**
     * Load a renderer's engines once, and hand back the globals they define.
     *
     * A renderer may need more than one file (Vega-Lite needs both Vega and
     * Vega-Lite), and they load in manifest order so a dependency is present
     * before its consumer runs.
     *
     * @param {object} spec - the renderer's catalogue entry.
     * @returns {Promise<Record<string, unknown>>} the globals, by name.
     */
    async function engineFor(spec) {
      if (engines.has(spec.id)) return engines.get(spec.id).globals
      if (enginePromises.has(spec.id)) return enginePromises.get(spec.id)
      const load = (async () => {
        const globals = {}
        for (const asset of spec.assets ?? []) {
          if (asset.ok === false) {
            throw new Error(`引擎文件不可用（完整性校验未通过）：${asset.url}`)
          }
          await loadScript(asset.url)
          if (asset.global !== '' && asset.global !== undefined) {
            globals[asset.global] = window[asset.global]
            if (globals[asset.global] === undefined) {
              throw new Error(`引擎已加载但没有暴露 ${asset.global}：${asset.url}`)
            }
          }
        }
        engines.set(spec.id, { globals, assets: spec.assets ?? [] })
        return globals
      })()
      enginePromises.set(spec.id, load)
      try {
        return await load
      } finally {
        enginePromises.delete(spec.id)
      }
    }

    /**
     * A hidden, laid-out node for engines that draw into the DOM.
     *
     * Canvas engines cannot measure or rasterise a detached element, so the
     * holder is attached but invisible. It is reused across renders.
     *
     * @returns {HTMLElement} the container.
     */
    function scratchContainer() {
      if (scratch === null || scratch.isConnected !== true) {
        scratch = el('div', 'vk-scratch')
        scratch.setAttribute('aria-hidden', 'true')
        document.body.appendChild(scratch)
      }
      const node = el('div', 'vk-scratch-node')
      scratch.appendChild(node)
      return node
    }

    /** Empty the scratch holder after a render. */
    function clearScratch() {
      if (scratch === null) return
      scratch.textContent = ''
    }

    // ---------------------------------------------------------------------
    // The presentation specification.
    //
    // Read out of the reference application's own bundle rather than invented:
    // its diagrams use the host's font at the body text size (13px), inside a
    // centred, padded canvas with a height ceiling and its own background. The
    // values here come from the plugin configuration, so they stay tunable.
    // ---------------------------------------------------------------------

    /**
     * The application's own background colour, for the canvas to blend in with.
     *
     * Falls back to the reference values (#fff / #1e1e1e) only when the surface
     * cannot be read.
     *
     * @returns {string} a CSS colour.
     */
    function surfaceColor() {
      try {
        for (const element of [document.body, document.documentElement]) {
          if (element === null || element === undefined) continue
          const raw = getComputedStyle(element).backgroundColor
          const channels = String(raw ?? '').match(/\d+(?:\.\d+)?/g)?.map(Number) ?? []
          if (channels.length < 3) continue
          if (channels.length >= 4 && channels[3] === 0) continue
          return raw
        }
      } catch {
        // Falls through to the theme-based default.
      }
      return resolveTheme() === 'dark' ? '#1e1e1e' : '#fff'
    }

    /**
     * The effective presentation values.
     * @returns {{fontFamily: string, fontSize: number, canvasMaxHeight: number, canvasPadding: number, background: string, showToolbar: boolean}} the spec.
     */
    function presentation() {
      const configured = catalogue?.presentation ?? {}
      return {
        fontFamily: String(configured.fontFamily ?? '').trim() || themeFontFamily(),
        fontSize: Number(configured.fontSize) > 0 ? Number(configured.fontSize) : 13,
        canvasMaxHeight: Number(configured.canvasMaxHeight) > 0 ? Number(configured.canvasMaxHeight) : 360,
        canvasPadding: Number(configured.canvasPadding) >= 0 ? Number(configured.canvasPadding) : 16,
        background: String(configured.background ?? 'auto'),
        showToolbar: configured.showToolbar !== false,
      }
    }

    /**
     * The environment one adapter render receives.
     *
     * @param {object} spec - the renderer's catalogue entry.
     * @param {object} behaviour - the effective behaviour settings.
     * @returns {object} the environment.
     */
    function renderEnv(spec, behaviour, signal) {
      // Each attempt owns its measurement DOM, including late/cancelled work.
      let holder = null
      const clear = () => { if (holder !== null) holder.replaceChildren() }
      const dispose = () => { holder?.remove(); holder = null }
      signal?.addEventListener('abort', dispose, { once: true })
      return {
        loadEngine: () => engineFor(spec),
        container: () => {
          if (signal?.aborted) throw new DOMException('展示已取消', 'AbortError')
          if (holder === null) {
            holder = el('div', 'vk-scratch')
            holder.setAttribute('aria-hidden', 'true')
            document.body.appendChild(holder)
          }
          const node = el('div', 'vk-scratch-node')
          holder.appendChild(node)
          return node
        },
        clearContainer: clear,
        dispose: () => { signal?.removeEventListener('abort', dispose); dispose() },
        signal,
        theme: resolveTheme(),
        presentation: presentation(),
        settings: spec.settings ?? {},
        behaviour,
        nextId: () => `vk-${(renderSeq += 1)}`,
      }
    }

    // ---------------------------------------------------------------------
    // Adapters. One per renderer; the only renderer-specific code in this half.
    // ---------------------------------------------------------------------

    /**
     * The opening of a mermaid diagram.
     *
     * Every mermaid grammar starts with one of these keywords, optionally after
     * an init directive. Requiring a diagram-type keyword — rather than, say,
     * "contains an arrow" — is what keeps this from claiming ordinary code:
     * `graph TD` at the top of a fence is mermaid, `const graph = …` is not.
     */
    const MERMAID_HEAD =
      /^\s*(?:%%\{.*?\}%%\s*)*(?:flowchart\s+(?:TD|TB|BT|RL|LR)\b|graph\s+(?:TD|TB|BT|RL|LR)\b|sequenceDiagram\b|classDiagram(?:-v2)?\b|stateDiagram(?:-v2)?\b|erDiagram\b|journey\b|gantt\b|pie\b|quadrantChart\b|requirementDiagram\b|gitGraph\b|mindmap\b|timeline\b|xychart-beta\b|block-beta\b|packet-beta\b|architecture-beta\b|sankey-beta\b|zenuml\b|C4[A-Za-z]*\b)/s

    /**
     * The curated chrome each engine is dressed with.
     *
     * The engines' factory palettes read as "default": mermaid's lavender,
     * ECharts' stock blue, Graphviz' flat boxes, hard polyline edges. These
     * values replace the defaults with one quiet system — soft neutrals for
     * structure, one restrained accent set for data — so five different
     * engines read as one product. They are defaults only: a diagram that
     * names its own colours keeps them.
     */
    /**
     * The curated chrome each engine is dressed with.
     *
     * These values replace the engines' factory palettes with the warm-neutral
     * design system the reference application actually uses (read out of its
     * own hand-authored diagrams): soft warm grays for structure, and its
     * semantic hues — blue for the new/goal, green for recommended, red for
     * problems, amber for partial — for data. They are defaults only: a diagram
     * that names its own colours keeps them.
     */
    const CHROME = {
      light: {
        nodeFill: '#FBFAF7',
        nodeBorder: '#B4B2A9',
        nodeText: '#444441',
        edge: '#888780',
        edgeText: '#888780',
        labelBg: '#FFFFFF',
        noteFill: '#FAEEDA',
        noteText: '#854F0B',
        canvasText: '#5F5E5A',
        title: '#2C2C2A',
        grid: '#ECEAE2',
        palette: ['#185FA5', '#534AB7', '#3B6D11', '#BA7517', '#A32D2D', '#0F6E56', '#7F77DD', '#B4473E'],
      },
      dark: {
        nodeFill: '#2A2A28',
        nodeBorder: '#555550',
        nodeText: '#E8E6DF',
        edge: '#7A7970',
        edgeText: '#9A988E',
        labelBg: '#232321',
        noteFill: '#3A2E18',
        noteText: '#E8C57A',
        canvasText: '#B9B7AD',
        title: '#F0EEE6',
        grid: '#3A3A36',
        palette: ['#5B9BD5', '#8B83E0', '#6FA84C', '#D99A3D', '#D96B6B', '#3DBA97', '#A79BEF', '#D97F6A'],
      },
    }

    /** The chrome for the current theme. */
    function chrome() {
      return resolveTheme() === 'dark' ? CHROME.dark : CHROME.light
    }

    /** @type {Record<string, {detect?: (source: string) => boolean, render: (source: string, env: object) => Promise<{markup: string}>}>} */
    const ADAPTERS = {
      mermaid: {
        detect: (source) => MERMAID_HEAD.test(source),
        async render(source, env) {
          const { mermaid } = await env.loadEngine()
          const dark = resolveTheme() === 'dark'
          const configured = String(env.settings.theme ?? 'auto')
          // `base` takes the curated variables; `dark` is mermaid's own dark
          // theme dressed with the app font. `basis` edges curve smoothly —
          // the factory `linear` curve is the single biggest "cheap" tell.
          const theme = configured !== 'auto' && configured !== '' ? configured : dark ? 'dark' : 'base'
          const c = chrome()
          mermaid.initialize({
            startOnLoad: false,
            // Model output is untrusted: strict keeps HTML labels and scripts
            // out of the diagram.
            securityLevel: 'strict',
            theme,
            themeVariables: {
              fontFamily: env.presentation.fontFamily,
              fontSize: `${env.presentation.fontSize}px`,
              ...(!dark
                ? {
                    primaryColor: c.nodeFill,
                    primaryBorderColor: c.nodeBorder,
                    primaryTextColor: c.nodeText,
                    lineColor: c.edge,
                    secondaryColor: c.nodeFill,
                    tertiaryColor: c.labelBg,
                    noteBkgColor: c.noteFill,
                    noteTextColor: c.noteText,
                    noteBorderColor: c.noteFill,
                    actorBkg: c.nodeFill,
                    actorBorder: c.nodeBorder,
                    actorTextColor: c.nodeText,
                    actorLineColor: c.nodeBorder,
                    signalColor: c.edge,
                    signalTextColor: c.edgeText,
                    labelBoxBkgColor: c.labelBg,
                    labelBoxBorderColor: c.nodeBorder,
                    labelTextColor: c.nodeText,
                    loopTextColor: c.edgeText,
                    messageTextColor: c.nodeText,
                  }
                : {}),
            },
            flowchart: { useMaxWidth: true, htmlLabels: false, curve: 'basis' },
            sequence: { useMaxWidth: true, actorMargin: 48 },
            // SVG labels, not HTML ones: an HTML label depends on the page's own
            // CSS and would inherit the message's typography.
            htmlLabels: false,
            // A broken diagram must not paint mermaid's error graphic into the
            // page; the pipeline shows its own card instead.
            suppressErrorRendering: true,
          })
          const { svg } = await mermaid.render(env.nextId(), source)
          return { markup: String(svg) }
        },
      },

      graphviz: {
        detect: (source) => /^\s*(?:strict\s+)?(?:di)?graph\b/.test(source),
        async render(source, env) {
          const { Viz } = await env.loadEngine()
          const viz = await Viz.instance()
          const font = String(env.settings.font ?? 'Microsoft YaHei')
          const size = Number(env.settings.fontSize) > 0 ? Number(env.settings.fontSize) : env.presentation.fontSize
          const c = chrome()
          // DOT can name one family, not a stack, and its default has no CJK
          // glyphs — so a Chinese label would come out as empty boxes. The
          // wasm build also has no metrics for the named font: it sizes a node
          // from an *estimate* that is roughly half the real width of a Han
          // glyph, and the browser then draws the label wider than the box.
          // `rounded` is a node *style*, not a shape, and on ellipse it is
          // ignored — so the base shape comes from the declared shape: box
          // family gets rounded corners, the rest keep their geometry. The
          // measured re-render loop below then grows the margin until no label
          // overflows its box, whatever its length. User attributes still win
          // because these are defaults and DOT merges later statements per key.
          const baseShape = /shape\s*=\s*([a-z]+)/i.exec(source)?.[1]?.toLowerCase() ?? 'box'
          const boxFamily = new Set(['box', 'rect', 'rectangle', 'square'])
          const style = boxFamily.has(baseShape) ? 'rounded,filled' : 'filled'
          const build = (marginX, marginY) => {
            const defaults = [
              `graph [fontname="${font}", fontsize=${size}, bgcolor="transparent", pad="0.3", nodesep="0.45", ranksep="0.55"];`,
              `node [fontname="${font}", fontsize=${size}, shape=${baseShape}, style="${style}", fillcolor="${c.nodeFill}", color="${c.nodeBorder}", fontcolor="${c.nodeText}", margin="${marginX.toFixed(3)},${marginY.toFixed(3)}", penwidth=1];`,
              `edge [fontname="${font}", fontsize=${Math.max(1, size - 1)}, color="${c.edge}", fontcolor="${c.edgeText}", arrowsize=0.7, penwidth=1];`,
            ].join('\n  ')
            return source.replace(/^(\s*(?:strict\s+)?(?:di)?graph[^{]*\{)/, `$1\n  ${defaults}`)
          }
          const draw = (marginX, marginY) => viz.renderString(build(marginX, marginY), { format: 'svg', engine: String(env.settings.layout ?? 'dot') })

          let marginX = 0.18
          const marginY = 0.08
          let svg = draw(marginX, marginY)
          // Grow the horizontal margin while any node/cluster label is wider
          // than its box (≤3 passes; the estimate is ~half width, so one pass
          // usually suffices). Headless environments (jsdom has no real layout)
          // disable measuring via `env.measure === false` — the stub metrics
          // would send the margin to its cap without drawing anything real.
          if (env.measure !== false) {
            for (let pass = 0; pass < 3; pass += 1) {
              const overflowIn = measureTextOverflow(svg, env)
              if (overflowIn <= 0.005) break
              marginX = Math.min(0.9, marginX + overflowIn + 0.04)
              svg = draw(marginX, marginY)
            }
          }
          return { markup: svg }
        },
      },

      nomnoml: {
        detect: (source) => /^(?:\s*#[^\n]*\n)*\s*\[[^\]\n]+\]\s*(?:[-<]|<?->)/.test(source),
        async render(source, env) {
          const { nomnoml } = await env.loadEngine()
          const size = Number(env.settings.fontSize) > 0 ? Number(env.settings.fontSize) : env.presentation.fontSize
          const c = chrome()
          const directives = [
            `#font: ${String(env.settings.font ?? 'Microsoft YaHei')}`,
            `#fontSize: ${size}`,
            // nomnoml measures labels as if they were Latin text, so a CJK label
            // overflows its box unless the padding is raised.
            `#padding: ${Number(env.settings.padding) > 0 ? Number(env.settings.padding) : 22}`,
            env.settings.fill ? `#fill: ${String(env.settings.fill)}` : `#fill: ${c.nodeFill}`,
            env.settings.stroke ? `#stroke: ${String(env.settings.stroke)}` : `#stroke: ${c.nodeBorder}`,
            `#lineWidth: 1.25`,
          ]
            .filter((line) => line !== '')
            .join('\n')
          return { markup: String(nomnoml.renderSvg(`${directives}\n${source}`)) }
        },
      },

      echarts: {
        detect: (source) => {
          const trimmed = source.trim()
          if (!trimmed.startsWith('{')) return false
          return /"(?:series|xAxis|yAxis|dataset|radar|geo|graph|tree|sankey)"\s*:/.test(trimmed)
        },
        async mount(source, env) {
          const option = validateInteractiveSource(source)
          const { echarts } = await env.loadEngine()
          if (env.signal.aborted) throw new DOMException('展示已取消', 'AbortError')
          const merged = echartsOption(option, env)
          // SVG/richText keeps tooltip text out of HTML and preserves export.
          const constrain = (value) => {
            if (value === null || typeof value !== 'object') return
            for (const [key, child] of Object.entries(value)) {
              if (key === 'tooltip' && child && typeof child === 'object') {
                child.renderMode = 'richText'
                child.confine = true
              }
              constrain(child)
            }
          }
          merged.tooltip = { show: true, ...option.tooltip }
          constrain(merged)
          merged.animation = false
          const chart = echarts.init(env.target, null, { renderer: 'svg' })
          let disposed = false
          const dispose = () => { if (!disposed) { disposed = true; chart.dispose() } }
          env.signal.addEventListener('abort', dispose, { once: true })
          try {
            chart.setOption(merged, { notMerge: true })
            return {
              resize: () => chart.resize(),
              reset: () => chart.dispatchAction({ type: 'restore' }),
              snapshot: () => ({ data: chart.renderToSVGString(), mimeType: 'image/svg+xml', extension: 'svg' }),
              dispose: () => { env.signal.removeEventListener('abort', dispose); dispose() },
            }
          } catch (error) {
            env.signal.removeEventListener('abort', dispose)
            dispose()
            throw error
          }
        },
        async render(source, env) {
          const { echarts } = await env.loadEngine()
          const option = parseJson(source, 'ECharts 配置')
          const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 1000, height: 460 })
          try {
            chart.setOption(echartsOption(option, env))
            return { markup: String(chart.renderToSVGString()) }
          } finally {
            chart.dispose()
          }
        },
      },

      'vega-lite': {
        detect: (source) => {
          const trimmed = source.trim()
          if (!trimmed.startsWith('{')) return false
          if (/"\$schema"\s*:\s*"[^"]*vega-lite/i.test(trimmed)) return true
          return /"(?:mark|encoding)"\s*:/.test(trimmed) && /"data"\s*:/.test(trimmed)
        },
        async render(source, env) {
          const { vega, vegaLite } = await env.loadEngine()
          const spec = parseJson(source, 'Vega-Lite 规格')
          const configured = env.settings ?? {}
          const c = chrome()
          // Config merges one level deep per section: the chrome is the floor,
          // the spec's own config raises whatever it names.
          const chromeConfig = {
            background: 'transparent',
            font: env.presentation.fontFamily,
            fontSize: env.presentation.fontSize,
            axis: {
              labelColor: c.canvasText,
              titleColor: c.nodeText,
              gridColor: c.grid,
              domainColor: c.nodeBorder,
              tickColor: c.nodeBorder,
              labelFontSize: env.presentation.fontSize - 1,
              titleFontSize: env.presentation.fontSize - 1,
            },
            legend: { labelColor: c.canvasText, titleColor: c.nodeText },
            title: { color: c.title, fontSize: env.presentation.fontSize + 2, anchor: 'middle' },
            range: { category: c.palette, ordinal: c.palette },
            view: { stroke: 'transparent' },
          }
          const withChrome = {
            ...spec,
            config: mergeConfig(chromeConfig, spec.config),
          }
          if (withChrome.width === undefined && Number(configured.width) > 0) withChrome.width = Number(configured.width)
          if (withChrome.height === undefined && Number(configured.height) > 0) withChrome.height = Number(configured.height)

          let compiled
          try {
            compiled = vegaLite.compile(withChrome).spec
          } catch (error) {
            // Vega-Lite's own validation messages are long and multi-line; the
            // first line is the part that names the actual problem.
            throw new Error(String(error?.message ?? error).split('\n')[0].slice(0, 300))
          }
          const view = new vega.View(vega.parse(compiled), { renderer: 'none' })
          try {
            await view.runAsync()
            return { markup: String(await view.toSVG()) }
          } finally {
            view.finalize?.()
          }
        },
      },

      svg: {
        detect: (source) => /^\s*<svg[\s>]/i.test(source),
        async render(source, env) {
          const { DOMPurify } = await env.loadEngine()
          // The model writes this markup, so it is untrusted: sanitise before it
          // reaches the page. DOMPurify's SVG profile strips scripts, event
          // handlers and foreignObject; external resource references are removed
          // afterwards so an inline diagram cannot phone home.
          //
          // The sanitised result is taken as a STRING and parsed here, rather
          // than asking DOMPurify for a DOM (`RETURN_DOM`). That option's return
          // shape differs between environments — it yielded a body element in a
          // headless DOM but nothing usable in the browser, which is how this
          // renderer failed in the conversation while passing its tests.
          const clean = String(DOMPurify.sanitize(source, { USE_PROFILES: { svg: true, svgFilters: true } }))
          const holder = document.createElement('div')
          holder.innerHTML = clean
          const svgEl = holder.querySelector('svg')
          if (svgEl === null) {
            throw new Error('代码块里没有可用的 <svg> 根元素（需要以 <svg …> 开头并以 </svg> 结束）')
          }
          for (const el of svgEl.querySelectorAll('*')) {
            for (const attr of ['href', 'xlink:href']) {
              const value = el.getAttribute?.(attr)
              if (value !== null && value !== undefined && /^\s*https?:/i.test(value)) {
                el.removeAttribute(attr)
              }
            }
          }
          svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
          return { markup: svgEl.outerHTML }
        },
      },
    }

    /**
     * Measure how far the widest node/cluster label overflows its box, in a
     * laid-out DOM. Graphviz sizes boxes from estimated glyph widths, which for
     * CJK text is about half the real width; measuring the rendered result and
     * growing the margin is what makes the box actually fit. Returns inches.
     *
     * @param {string} svgText - the rendered markup.
     * @param {object} env - the render environment (provides a container).
     * @returns {number} the overflow in inches, 0 when nothing overflows or
     *   measurement is unavailable.
     */
    function measureTextOverflow(svgText, env) {
      let host = null
      try {
        host = env.container()
        if (host.isConnected !== true && typeof document !== 'undefined') document.body.appendChild(host)
        host.innerHTML = svgText
        let maxPx = 0
        for (const group of host.querySelectorAll('g.node, g.cluster')) {
          const text = group.querySelector('text')
          const shape = group.querySelector('path, polygon, ellipse, rect')
          if (text === null || shape === null) continue
          const tb = text.getBBox()
          const sb = shape.getBBox()
          if (!Number.isFinite(tb.width) || !Number.isFinite(sb.width) || sb.width <= 0) continue
          // A little slack reads better than a box that merely touches.
          maxPx = Math.max(maxPx, tb.width - sb.width + 6, tb.height - sb.height + 3)
        }
        return Math.max(0, maxPx) / 96
      } catch {
        return 0
      } finally {
        if (host !== null) host.innerHTML = ''
      }
    }

    /**
     * Merge an axis option (object or array of objects) with the axis chrome,
     * one level deep so nested `axisLabel`/`splitLine` merge key by key.
     * @param {object} chrome - the axis chrome floor.
     * @param {object|Array} user - the user's axis option.
     * @returns {object|Array} the merged axis option.
     */
    function mergeAxis(chrome, user) {
      const one = (axis) => {
        if (axis === null || typeof axis !== 'object') return axis
        return {
          ...chrome,
          ...axis,
          axisLabel: { ...chrome.axisLabel, ...axis.axisLabel },
          axisLine: { ...chrome.axisLine, ...axis.axisLine },
          splitLine: { ...chrome.splitLine, ...axis.splitLine },
          axisTick: { ...chrome.axisTick, ...axis.axisTick },
        }
      }
      return Array.isArray(user) ? user.map(one) : one(user)
    }

    /**
     * Merge two Vega-Lite config objects one level deep: nested sections
     * (`axis`, `legend`, …) merge key by key instead of replacing wholesale.
     * @param {object} base - the chrome floor.
     * @param {object} [over] - the spec's own config.
     * @returns {object} the merged config.
     */
    function mergeConfig(base, over) {
      if (over === undefined || over === null) return base
      const out = { ...base }
      for (const [key, value] of Object.entries(over)) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && typeof out[key] === 'object' && out[key] !== null) {
          out[key] = { ...out[key], ...value }
        } else {
          out[key] = value
        }
      }
      return out
    }

    /**
     * Parse a JSON source with a message that says which field is wrong.
     * @param {string} source - the source text.
     * @param {string} label - what the JSON is, for the message.
     * @returns {object} the parsed value.
     */
    function echartsOption(option, env) {
      const c = chrome()
      const text = { color: c.canvasText, fontFamily: env.presentation.fontFamily, fontSize: env.presentation.fontSize }
      const axisChrome = { axisLabel: { color: c.canvasText, fontSize: env.presentation.fontSize - 1 }, axisLine: { lineStyle: { color: c.nodeBorder } }, splitLine: { lineStyle: { color: c.grid } }, axisTick: { lineStyle: { color: c.nodeBorder } } }
      const base = {
        animation: env.settings.animation === true, color: c.palette, textStyle: text,
        title: { textStyle: { color: c.title, fontSize: env.presentation.fontSize + 2, fontWeight: 600 }, subtextStyle: { color: c.edgeText } },
        legend: { textStyle: { color: c.canvasText, fontSize: env.presentation.fontSize - 1 } },
      }
      const merged = { ...base, ...option }
      if (option.title !== undefined) merged.title = { ...base.title, ...option.title, textStyle: { ...base.title.textStyle, ...option.title?.textStyle }, subtextStyle: { ...base.title.subtextStyle, ...option.title?.subtextStyle } }
      if (option.legend !== undefined) merged.legend = { ...base.legend, ...option.legend, textStyle: { ...base.legend.textStyle, ...option.legend?.textStyle } }
      if (option.xAxis !== undefined) merged.xAxis = mergeAxis(axisChrome, option.xAxis)
      if (option.yAxis !== undefined) merged.yAxis = mergeAxis(axisChrome, option.yAxis)
      if (Array.isArray(option.series)) merged.series = option.series.map((item) => item !== null && typeof item === 'object' ? { ...item, label: { color: c.canvasText, ...item.label } } : item)
      return merged
    }

    function validateInteractiveSource(source) {
      if (new Blob([source]).size > MAX_INTERACTIVE_BYTES) throw new Error('交互配置超过 256 KiB，请减少数据')
      const option = parseJson(source, '交互图表配置')
      if (Array.isArray(option)) throw new Error('交互配置顶层必须是对象')
      const optionLocations = []
      const visit = (value, depth = 0) => {
        if (depth > 64) throw new Error('交互配置嵌套过深')
        if (typeof value === 'string' && /image:\/\/|url\s*\(/i.test(value)) throw new Error('交互图表仅支持内联数据，不支持图片资源')
        if (value === null || typeof value !== 'object') return
        if (!Array.isArray(value) && (Object.hasOwn(value, 'series') || Object.hasOwn(value, 'dataset'))) optionLocations.push(value)
        for (const [key, child] of Object.entries(value)) {
          if (['__proto__', 'prototype', 'constructor', 'image', 'url', 'href', 'src'].includes(key)) throw new Error(`交互配置不支持资源或特殊字段：${key}`)
          visit(child, depth + 1)
        }
      }
      visit(option)
      const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value]
      let count = 0
      const countTree = (data) => {
        if (!Array.isArray(data)) return
        count += data.length
        for (const point of data) if (point && typeof point === 'object') countTree(point.children)
      }
      for (const location of optionLocations) {
        for (const series of list(location.series)) {
          countTree(series?.data)
          if (Array.isArray(series?.nodes)) count += series.nodes.length
          if (Array.isArray(series?.links)) count += series.links.length
        }
        for (const dataset of list(location.dataset)) {
          const data = dataset?.source
          if (data !== undefined && (data === null || typeof data !== 'object')) throw new Error('dataset.source 必须是内联数组或对象')
          count += Array.isArray(data) ? data.length : Math.max(0, ...Object.values(data ?? {}).map((column) => Array.isArray(column) ? column.length : 0))
        }
      }
      if (count > MAX_DATA_POINTS) throw new Error('交互图表超过 10,000 个数据点，请聚合或分段')
      return option
    }

    function parseJson(source, label) {
      try {
        const value = JSON.parse(source)
        if (value === null || typeof value !== 'object') throw new Error('顶层必须是对象')
        return value
      } catch (error) {
        throw new Error(`${label}不是合法 JSON：${String(error?.message ?? error)}`)
      }
    }

    // ---------------------------------------------------------------------
    // Routing: which block belongs to which renderer.
    // ---------------------------------------------------------------------

    /**
     * The language a block's own markup claims.
     *
     * Both places are consulted: the class list a markdown renderer writes, and
     * the banner the component shows (which carries the language name only when
     * a grammar exists for it).
     *
     * @param {HTMLElement} node - the block root.
     * @returns {string} the language, lower-cased, or ''.
     */
    function bannerLanguage(node) {
      const classes = `${node.className ?? ''} ${node.querySelector('code')?.className ?? ''}`.toLowerCase()
      const match = /(?:language|lang)-([a-z0-9+#-]+)/.exec(classes)
      if (match !== null) return match[1]
      const banner = node.querySelector('[data-code-block-banner]')
      const text = String(banner?.querySelector?.('.language')?.textContent ?? banner?.textContent ?? '').trim().toLowerCase()
      return hostFenceLanguage(node) || (/^[a-z0-9+#-]{1,20}$/.test(text) ? text : '')
    }

    // DSH's code toolbar hides unknown language names. Recover the authored
    // fence through the public session chat snapshot, never React internals.
    function hostFenceLanguage(node) {
      const owner = node.closest('[data-chat-node-key]')
      const entry = currentChatSnapshot?.nodes?.get?.(owner?.dataset.chatNodeKey)
      if (!owner || !entry?.data?.blocks) return ''
      const reasoning = owner.dataset.chatGroupPart === 'reasoning'
      const fences = []
      for (const block of entry.data.blocks) {
        if (block.kind !== (reasoning ? 'reasoning' : 'text') || typeof block.text !== 'string') continue
        let open = null, lines = []
        for (const line of block.text.split(/\r?\n/)) {
          if (!open) {
            const match = /^ {0,3}(`{3,}|~{3,})\s*([\w+#-]*)[^\n]*$/.exec(line)
            if (match) { open = { marker: match[1][0], length: match[1].length, language: match[2].toLowerCase() }; lines = [] }
          } else if (new RegExp(`^ {0,3}${open.marker}{${open.length},}\\s*$`).test(line)) {
            fences.push({ source: lines.join('\n').trimEnd(), language: open.language }); open = null
          } else lines.push(line)
        }
        if (open) fences.push({ source: lines.join('\n').trimEnd(), language: open.language })
      }
      const source = readSource(bodyOf(node)).trimEnd()
      const matches = fences.filter(fence => fence.source === source)
      if (matches.length === 1) return matches[0].language
      // Equal source can deliberately appear once as static and once as live.
      const peers = [...owner.querySelectorAll('.md-code-block')].filter(peer =>
        peer.closest('[data-chat-node-key]') === owner && readSource(bodyOf(peer)).trimEnd() === source)
      return matches[peers.indexOf(node)]?.language ?? ''
    }

    /**
     * Decide which renderer owns a block.
     *
     * The declared language wins when it names a renderer — that is the model
     * saying what it meant. Only when there is no usable language does each
     * adapter get to recognise its own content, which is what makes a plain
     * fence with a `flowchart TD` first line work anyway.
     *
     * @param {string} source - the block's text.
     * @param {string} language - the declared language, if any.
     * @param {object|null} cat - the catalogue to route against.
     * @returns {{id: string, tier: 'language'|'content'}|null} the decision.
     */
    function routeBlock(source, language, cat = catalogue) {
      if (cat === null || cat.behavior?.autoRender === false) return null
      const enabled = cat.renderers.filter((spec) => spec.enabled)
      if (language !== '') {
        const id = cat.byLanguage.get(language)
        if (id !== undefined) {
          const spec = enabled.find((candidate) => candidate.id === id)
          if (spec !== undefined) return { id, tier: 'language' }
        }
      }
      for (const spec of enabled) {
        const adapter = ADAPTERS[spec.id]
        if (adapter?.detect?.(source) === true) return { id: spec.id, tier: 'content' }
      }
      return null
    }

    // ---------------------------------------------------------------------
    // Figures: canvas, toolbar, source, and the actions on them.
    // ---------------------------------------------------------------------

    /** The styles this half owns. Every selector is namespaced `vk-`. */
    function injectStyles() {
      if (styleInjected) return
      styleInjected = true
      if (document.getElementById(STYLE_ID) !== null) return
      const style = el('style')
      style.id = STYLE_ID
      style.textContent = `
.vk-figure, .vk-error, .vk-panel, .vk-lightbox { --vk-border: var(--dsw-color-border, oklch(86% .012 85)); --vk-surface: var(--dsw-color-surface, oklch(98% .008 85)); --vk-muted: var(--dsw-color-surface-sunken, oklch(95% .012 85)); --vk-ink: var(--dsw-color-text, oklch(35% .01 85)); --vk-secondary: var(--dsw-color-text-secondary, oklch(48% .012 85)); --vk-hover: var(--dsw-color-surface-hover, oklch(92% .015 85)); --vk-accent: var(--dsw-color-accent, #185FA5); color: var(--vk-ink); }
.vk-figure[data-vk-theme="dark"], .vk-error[data-vk-theme="dark"], :is([data-theme="dark"], [data-color-scheme="dark"], .dark) :is(.vk-figure, .vk-error, .vk-panel, .vk-lightbox) { --vk-border: var(--dsw-color-border, oklch(36% .012 85)); --vk-surface: var(--dsw-color-surface, oklch(23% .008 85)); --vk-muted: var(--dsw-color-surface-sunken, oklch(26% .008 85)); --vk-ink: var(--dsw-color-text, oklch(91% .008 85)); --vk-secondary: var(--dsw-color-text-secondary, oklch(73% .012 85)); --vk-hover: var(--dsw-color-surface-hover, oklch(32% .012 85)); }
.vk-figure { min-width: 0; max-width: 100%; margin: 12px 0 16px; border: 1px solid var(--vk-border); border-radius: 10px; overflow: hidden; background: var(--vk-surface); }
.vk-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vk-border); font-size: 12px; background: var(--vk-muted); }
.vk-bar .vk-label { font-weight: 600; }
.vk-bar .vk-status { margin-left: auto; color: var(--vk-secondary); overflow-wrap: anywhere; }
.vk-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.vk-btn { font: inherit; font-size: 12px; line-height: 1.4; min-width: 30px; min-height: 30px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--vk-border); background: var(--vk-surface); color: inherit; cursor: pointer; transition: background .18s ease-out, border-color .18s ease-out; }
.vk-btn:hover:not(:disabled) { background: var(--vk-hover); border-color: var(--vk-secondary); }
.vk-btn:disabled { opacity: .6; cursor: wait; }
.vk-btn:active:not(:disabled) { background: var(--vk-muted); }
.vk-btn:focus-visible, .vk-source > summary:focus-visible, .vk-error-sample > summary:focus-visible, .vk-toggle:focus-visible { outline: 2px solid var(--vk-accent); outline-offset: 2px; }
.vk-canvas:focus-visible { outline: 2px solid var(--vk-accent); outline-offset: -3px; }
.vk-canvas { display: flex; justify-content: center; justify-content: safe center; align-items: flex-start; overflow: auto; }
.vk-canvas svg { flex-shrink: 0; max-width: 100%; height: auto; }
.vk-figure[data-vk-mode="interactive"] .vk-canvas { display: block; }
.vk-figure[data-vk-mode="interactive"] .vk-canvas svg { max-width: none; }
.vk-mount { width: 100%; min-width: 0; }
.vk-fallback { padding: 8px 12px; font-size: 12px; color: var(--vk-secondary); border-top: 1px solid var(--vk-border); overflow-wrap: anywhere; }
.vk-source { border-top: 1px solid var(--vk-border); }
.vk-source > summary { cursor: pointer; padding: 8px 12px; font-size: 12px; color: var(--vk-secondary); }
.vk-source pre { margin: 0; padding: 8px 10px; overflow: auto; font-size: 12px; line-height: 18px; }
.vk-error { margin: 8px 0 16px; border: 1px solid var(--dsw-color-danger, #e5484d); border-radius: 10px; padding: 12px; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; background: color-mix(in srgb, var(--dsw-color-danger, #e5484d) 6%, var(--vk-surface)); }
.vk-error .vk-error-lead { font-weight: 500; margin-bottom: 4px; }
.vk-error .vk-error-hint { margin-top: 6px; font-size: 12.5px; line-height: 1.65; opacity: .9; }
.vk-error .vk-error-sample { margin-top: 6px; border-top: 1px solid var(--dsw-color-border, #eef0f3); }
.vk-error .vk-error-sample > summary { cursor: pointer; padding: 4px 0; font-size: 12px; color: var(--dsw-color-text-secondary, #6b7280); }
.vk-error .vk-error-sample pre { margin: 0; padding: 8px 10px; overflow: auto; font-size: 12px; line-height: 18px;
  background: var(--dsw-color-surface-sunken, #fafafa); border-radius: 4px; }
.vk-error code { font-family: var(--dsw-font-mono, monospace); font-size: 12px; }
.vk-error .vk-actions { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.vk-error .vk-error-status { opacity: .8; }
.vk-scratch { position: fixed; left: -10000px; top: 0; width: 1000px; height: 600px; overflow: hidden; pointer-events: none; }
.vk-note { opacity: .9; }
/* 放大展示：像看图一样 —— 深色底、图形居中、点任意处关闭 */
.vk-lightbox { position: fixed; inset: 0; z-index: 2147483000; background: rgba(12, 11, 10, .9); }
.vk-lightbox-stage { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; }
.vk-lightbox-stage:active { cursor: grabbing; }
.vk-lightbox-stage:focus-visible { outline: 2px solid var(--vk-accent); outline-offset: -3px; }
.vk-lightbox-stage > svg { position: absolute; left: 50%; top: 50%; transform-origin: center center;
  pointer-events: none; background: var(--vk-surface); border-radius: 6px; box-shadow: 0 14px 44px rgba(0, 0, 0, .5); }
.vk-lightbox-tools { position: absolute; top: 12px; right: 12px; z-index: 2; display: flex; flex-wrap: wrap; gap: 6px; }
.vk-lightbox-caption { position: absolute; left: 50%; bottom: 14px; z-index: 2; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px);
  padding: 6px 14px; border-radius: 999px; background: rgba(0, 0, 0, .58); color: #fff; font-size: 12px; }
.vk-lightbox-caption .vk-lightbox-hint { color: rgba(255, 255, 255, .72); }
.vk-lightbox-status { font-variant-numeric: tabular-nums; }
.vk-lightbox .vk-btn { background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .26); color: #fff; }
.vk-lightbox .vk-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .22); border-color: rgba(255, 255, 255, .45); }
@media (max-width: 640px) { .vk-lightbox-hint { display: none; } .vk-lightbox-caption { bottom: 8px; padding: 5px 12px; } }
@media (prefers-reduced-motion: reduce) { .vk-lightbox-stage > svg { box-shadow: none; } }
@media (max-width: 480px) { .vk-tools { flex-basis: 100%; } .vk-bar { padding: 8px; } .vk-btn { min-height: 36px; } }
@media (pointer: coarse) { .vk-btn, .vk-source > summary { min-height: 44px; box-sizing: border-box; } }
@media (prefers-reduced-motion: reduce) { .vk-btn, .vk-switch-btn, .vk-switch-knob { transition: none !important; } }
`
      document.head.appendChild(style)
    }

    /**
     * The natural size of a figure's markup.
     * @param {HTMLElement} figure - the figure element.
     * @returns {{width: number, height: number}} the size in CSS pixels.
     */
    function naturalSize(figure) {
      const svg = figure.querySelector('svg')
      if (svg === null) {
        const box = figure.querySelector('.vk-canvas')?.getBoundingClientRect?.() ?? { width: 600, height: 300 }
        return { width: box.width, height: box.height }
      }
      // The viewBox is the diagram's intended size and is checked FIRST. The
      // rendered box cannot be trusted here: markup that declares width="100%"
      // (the usual way to write a responsive diagram) is already stretched to
      // the canvas, so measuring it would report the container's width as the
      // diagram's own — and then no height fitting would ever happen.
      const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? []
      if (viewBox.length === 4 && viewBox.every((value) => Number.isFinite(value)) && viewBox[2] > 0 && viewBox[3] > 0) {
        return { width: viewBox[2], height: viewBox[3] }
      }
      const box = svg.getBoundingClientRect?.() ?? { width: 0, height: 0 }
      if (box.width > 1 && box.height > 1) return { width: box.width, height: box.height }
      return { width: Number(svg.getAttribute('width')) || 600, height: Number(svg.getAttribute('height')) || 300 }
    }

    /**
     * How much a figure may be scaled so it fits the canvas.
     *
     * Two bounds apply. Width is bounded by the message width and stops at
     * `FIT_FLOOR`: a too-narrow diagram is still readable by scrolling sideways.
     * Height is bounded by the canvas cap and may shrink further, because
     * vertical overflow cuts the picture off — the top or bottom simply cannot
     * be seen, which reads as "the diagram did not render".
     *
     * @param {HTMLElement} figure - the figure element.
     * @returns {number} the scale, 1 when it already fits.
     */
    function fitScale(figure) {
      const canvas = figure.querySelector('.vk-canvas')
      if (canvas === null) return 1
      const natural = figure.__vkNatural ?? naturalSize(figure)
      if (natural.width <= 0 || natural.height <= 0) return 1
      const padding = getComputedStyle(canvas)
      const horizontalPadding = (Number.parseFloat(padding.paddingLeft) || 0) + (Number.parseFloat(padding.paddingRight) || 0)
      const verticalPadding = (Number.parseFloat(padding.paddingTop) || 0) + (Number.parseFloat(padding.paddingBottom) || 0)
      const availableW = canvas.clientWidth - horizontalPadding
      if (availableW <= 0) return 1
      const capHeight = Number.parseFloat(canvas.style.maxHeight) || 360
      const availableH = capHeight - verticalPadding
      const ratioW = availableW / natural.width
      const ratioH = availableH > 0 ? availableH / natural.height : 1
      if (ratioW >= 1 && ratioH >= 1) return 1
      const widthBound = ratioW >= 1 || ratioW < FIT_FLOOR ? 1 : ratioW
      const heightBound = ratioH >= 1 ? 1 : Math.max(ratioH, HEIGHT_FLOOR)
      return Math.min(widthBound, heightBound)
    }

    /**
     * Apply a zoom level to a figure.
     * @param {HTMLElement} figure - the figure element.
     * @param {number} [scale] - the level; omitted means fit.
     */
    function applyScale(figure, scale) {
      const canvas = figure.querySelector('.vk-canvas')
      const svg = figure.querySelector('svg')
      if (canvas === null || svg === null) return
      const natural = figure.__vkNatural ?? naturalSize(figure)
      figure.__vkNatural = natural
      const next = scale === undefined ? fitScale(figure) : Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
      svg.style.width = `${Math.round(natural.width * next)}px`
      svg.style.height = `${Math.round(natural.height * next)}px`
      svg.style.maxWidth = 'none'
      figure.dataset.vkScale = String(next)
      const status = figure.querySelector('.vk-status')
      if (status !== null) status.textContent = `${Math.round(next * 100)}%`
    }

    /**
     * The figure's SVG, standalone and self-contained.
     * @param {HTMLElement} figure - the figure element.
     * @returns {string} the markup.
     */
    function serializeSvg(figure) {
      const svg = figure.querySelector('svg')
      if (svg === null) return ''
      const clone = svg.cloneNode(true)
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      const natural = figure.__vkNatural ?? naturalSize(figure)
      clone.setAttribute('width', String(Math.round(natural.width)))
      clone.setAttribute('height', String(Math.round(natural.height)))
      clone.style.removeProperty('width')
      clone.style.removeProperty('height')
      clone.style.removeProperty('max-width')
      return `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`
    }

    // ---------------------------------------------------------------------
    // Enlarged view.
    //
    // A dense diagram cannot be read in a 360px canvas, and shrinking it to fit
    // is exactly what makes it unreadable. The overlay shows a snapshot SVG (the
    // same bytes the download button writes) instead of moving the live node:
    // the figure keeps rendering in place, a vector snapshot stays crisp at any
    // scale, and it works identically for static and interactive figures.
    // ---------------------------------------------------------------------

    /** The one open overlay, if any. */
    let lightbox = null

    /** How far the overlay may be zoomed in. */
    const LIGHTBOX_MAX_SCALE = 8

    /** Step for the overlay's buttons and keys. */
    const LIGHTBOX_STEP = 1.25

    /**
     * The size an SVG declares for itself.
     * @param {Element} svg - the SVG element.
     * @returns {{width: number, height: number}|null} the size, or null.
     */
    function viewBoxSize(svg) {
      const parts = String(svg.getAttribute?.('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
      if (parts.length === 4 && parts.every((value) => Number.isFinite(value)) && parts[2] > 0 && parts[3] > 0) {
        return { width: parts[2], height: parts[3] }
      }
      return null
    }

    /**
     * Turn a snapshot string into an SVG element sized by its own viewBox.
     * @param {string} text - the snapshot markup.
     * @returns {Element|null} the element, or null when it is not an SVG.
     */
    function snapshotToSvg(text) {
      if (typeof text !== 'string' || text.trim() === '') return null
      let svg = null
      try {
        const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
        const root = parsed?.documentElement
        if (root !== null && root !== undefined && root.nodeName?.toLowerCase() === 'svg') svg = root
      } catch {
        svg = null
      }
      if (svg === null) {
        // A snapshot without an XML declaration (or with a stray one) still
        // parses as HTML, where an inline <svg> is a first-class element.
        const holder = el('div')
        holder.innerHTML = text.replace(/^<\?xml[^>]*\?>\s*/i, '')
        svg = holder.querySelector('svg')
      }
      if (svg === null || svg === undefined) return null
      svg.removeAttribute('width')
      svg.removeAttribute('height')
      return svg
    }

    /**
     * Close the open overlay, restoring focus and page scrolling.
     * Safe to call when nothing is open.
     */
    function closeLightbox() {
      if (lightbox === null) return
      const closing = lightbox
      lightbox = null
      try {
        closing.teardown()
      } catch (error) {
        log('lightbox teardown failed', String(error?.message ?? error))
      }
    }

    /**
     * Show one figure enlarged, in an overlay that fills most of the window.
     *
     * @param {{label: string, snapshot: string, natural: {width: number, height: number}, trigger?: Element}} input - what to show.
     * @returns {boolean} whether the overlay opened.
     */
    function openLightbox(input) {
      const svg = snapshotToSvg(input.snapshot)
      if (svg === null) return false
      // Only one at a time: opening from another figure replaces the first.
      closeLightbox()

      const natural = viewBoxSize(svg) ?? input.natural ?? { width: 680, height: 400 }
      const root = el('div', 'vk-lightbox')
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-modal', 'true')
      root.setAttribute('aria-label', `放大展示：${input.label}`)
      const stage = el('div', 'vk-lightbox-stage')
      stage.tabIndex = 0
      stage.setAttribute('aria-label', '图形区域：可拖拽平移，双击在适应与原始尺寸之间切换')
      svg.style.width = `${natural.width}px`
      svg.style.height = `${natural.height}px`
      stage.appendChild(svg)
      const tools = el('div', 'vk-lightbox-tools')
      tools.setAttribute('role', 'group')
      tools.setAttribute('aria-label', '放大展示操作')
      const caption = el('div', 'vk-lightbox-caption')
      caption.appendChild(el('span', '', `放大展示 · ${input.label}`))
      const status = el('span', 'vk-lightbox-status', '100%')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      caption.appendChild(status)
      caption.appendChild(el('span', 'vk-lightbox-hint', '滚轮缩放 · 拖拽平移 · 双击 1:1 · 点任意处关闭'))
      root.appendChild(stage)
      root.appendChild(tools)
      root.appendChild(caption)

      const view = { scale: 1, x: 0, y: 0, manual: false }
      const clampScale = (value) => Math.min(LIGHTBOX_MAX_SCALE, Math.max(MIN_SCALE, value))

      const paint = () => {
        svg.style.transform = `translate(-50%, -50%) translate(${Math.round(view.x)}px, ${Math.round(view.y)}px) scale(${view.scale})`
        status.textContent = `${Math.round(view.scale * 100)}%`
      }
      const fit = () => {
        const box = stage.getBoundingClientRect?.() ?? { width: 0, height: 0 }
        const width = box.width > 1 ? box.width : 800
        const height = box.height > 1 ? box.height : 600
        view.scale = clampScale(Math.min((width - 32) / natural.width, (height - 32) / natural.height))
        view.x = 0
        view.y = 0
        view.manual = false
        paint()
      }
      /** Zoom keeping the point under (clientX, clientY) in place. */
      const zoomAt = (clientX, clientY, factor) => {
        const box = stage.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 }
        const cx = clientX - box.left - box.width / 2
        const cy = clientY - box.top - box.height / 2
        const next = clampScale(view.scale * factor)
        if (next === view.scale) return
        const ratio = next / view.scale
        view.x = cx - (cx - view.x) * ratio
        view.y = cy - (cy - view.y) * ratio
        view.scale = next
        view.manual = true
        paint()
      }
      const zoomCentre = (factor) => {
        const box = stage.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 }
        zoomAt(box.left + box.width / 2, box.top + box.height / 2, factor)
      }

      const close = () => closeLightbox()
      const add = (label, title, handler) => {
        const node = button(label, title, handler)
        tools.appendChild(node)
        return node
      }
      add('−', '缩小', () => zoomCentre(1 / LIGHTBOX_STEP))
      add('+', '放大', () => zoomCentre(LIGHTBOX_STEP))
      add('适应', '适应窗口', fit)
      add('1:1', '原始尺寸', () => {
        view.scale = 1
        view.x = 0
        view.y = 0
        view.manual = true
        paint()
      })
      const closeButton = add('关闭', '关闭放大展示（Esc）', close)

      let drag = null
      /** 双指缩放：记录两个指针的距离与中点。 */
      let pinch = null
      /** 点击关闭要等一拍，否则双击缩放会先被单击关掉。 */
      let clickTimer = 0
      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        stage.setPointerCapture?.(event.pointerId)
        const points = stage.__vkPoints ?? (stage.__vkPoints = new Map())
        points.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (points.size === 1) {
          drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: view.x, oy: view.y, moved: 0 }
          pinch = null
          return
        }
        if (points.size === 2) {
          const [a, b] = [...points.values()]
          pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale }
          drag = null
        }
      }
      const onPointerMove = (event) => {
        const points = stage.__vkPoints
        if (points?.has(event.pointerId)) points.set(event.pointerId, { x: event.clientX, y: event.clientY })
        if (pinch !== null && points?.size === 2) {
          const [a, b] = [...points.values()]
          const distance = Math.hypot(a.x - b.x, a.y - b.y)
          if (pinch.distance > 0) {
            const midX = (a.x + b.x) / 2
            const midY = (a.y + b.y) / 2
            const next = clampScale((pinch.scale * distance) / pinch.distance)
            zoomAt(midX, midY, next / view.scale)
          }
          return
        }
        if (drag === null || event.pointerId !== drag.id) return
        const dx = event.clientX - drag.x
        const dy = event.clientY - drag.y
        drag.moved = Math.max(drag.moved, Math.hypot(dx, dy))
        view.x = drag.ox + dx
        view.y = drag.oy + dy
        view.manual = true
        paint()
      }
      const onPointerUp = (event) => {
        const points = stage.__vkPoints
        points?.delete(event.pointerId)
        if (points?.size === 0) stage.__vkPoints = undefined
        if (pinch !== null && (points?.size ?? 0) < 2) pinch = null
        if (drag === null || event.pointerId !== drag.id) return
        stage.releasePointerCapture?.(event.pointerId)
        // 像看图一样：没拖动就是在"点"，点任意处关闭（等一拍让双击有机会先触发）
        const wasClick = drag.moved < 4
        drag = null
        if (wasClick && event.type === 'pointerup') {
          if (clickTimer !== 0) clearTimeout(clickTimer)
          clickTimer = setTimeout(() => {
            clickTimer = 0
            close()
          }, 200)
        }
      }
      const onWheel = (event) => {
        event.preventDefault()
        // 连续缩放，而不是每格跳 25%：一格滚轮约 15%，触控板的细碎位移自然更小
        const factor = Math.min(1.25, Math.max(0.8, Math.exp(-event.deltaY * 0.0012)))
        zoomAt(event.clientX, event.clientY, factor)
      }
      const onDoubleClick = (event) => {
        event.preventDefault()
        if (clickTimer !== 0) {
          clearTimeout(clickTimer)
          clickTimer = 0
        }
        // 看图的双击：在"原始尺寸"与"适应窗口"之间来回，而不是单纯放大
        if (Math.abs(view.scale - 1) <= 0.01) fit()
        else zoomAt(event.clientX, event.clientY, 1 / view.scale)
      }
      const onResize = () => {
        if (!view.manual) fit()
      }
      const focusable = () =>
        [...root.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')].filter(
          // offsetParent 在无布局环境里恒为 null，因此按 hidden/disabled 判断
          (node) => node.disabled !== true && node.hidden !== true,
        )
      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
          return
        }
        if (event.key === 'Tab') {
          const list = focusable()
          if (list.length === 0) return
          const first = list[0]
          const last = list[list.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
          return
        }
        const panStep = event.shiftKey ? 120 : 40
        if (event.key === '+' || event.key === '=') { event.preventDefault(); zoomCentre(LIGHTBOX_STEP); return }
        if (event.key === '-' || event.key === '_') { event.preventDefault(); zoomCentre(1 / LIGHTBOX_STEP); return }
        if (event.key === '0') { event.preventDefault(); fit(); return }
        if (event.key === '1') { event.preventDefault(); view.scale = 1; view.manual = true; paint(); return }
        const moves = { ArrowLeft: [panStep, 0], ArrowRight: [-panStep, 0], ArrowUp: [0, panStep], ArrowDown: [0, -panStep] }
        const move = moves[event.key]
        if (move !== undefined) {
          event.preventDefault()
          view.x += move[0]
          view.y += move[1]
          view.manual = true
          paint()
        }
      }

      stage.addEventListener('pointerdown', onPointerDown)
      stage.addEventListener('pointermove', onPointerMove)
      stage.addEventListener('pointerup', onPointerUp)
      stage.addEventListener('pointercancel', onPointerUp)
      stage.addEventListener('wheel', onWheel, { passive: false })
      stage.addEventListener('dblclick', onDoubleClick)
      root.addEventListener('keydown', onKeyDown)
      window.addEventListener('resize', onResize)

      const restoreFocus = input.trigger ?? document.activeElement
      const previousOverflow = document.body.style.overflow
      document.body.appendChild(root)
      document.body.style.overflow = 'hidden'
      fit()
      closeButton.focus()

      lightbox = {
        root,
        close,
        teardown() {
          if (clickTimer !== 0) clearTimeout(clickTimer)
          clickTimer = 0
          stage.removeEventListener('pointerdown', onPointerDown)
          stage.removeEventListener('pointermove', onPointerMove)
          stage.removeEventListener('pointerup', onPointerUp)
          stage.removeEventListener('pointercancel', onPointerUp)
          stage.removeEventListener('wheel', onWheel)
          stage.removeEventListener('dblclick', onDoubleClick)
          root.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('resize', onResize)
          root.remove()
          document.body.style.overflow = previousOverflow
          if (restoreFocus !== null && restoreFocus !== undefined && typeof restoreFocus.focus === 'function' && restoreFocus.isConnected !== false) {
            restoreFocus.focus({ preventScroll: true })
          }
        },
      }
      return true
    }

    /**
     * Copy text, preferring the async clipboard.
     * @param {string} text - the text.
     * @returns {Promise<boolean>} whether it was copied.
     */
    async function copyText(text) {
      try {
        if (navigator.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Falls back to the selection trick below.
      }
      const scratchNode = el('textarea')
      const previousFocus = document.activeElement
      try {
        scratchNode.value = text
        scratchNode.style.cssText = 'position:fixed;left:-9999px'
        document.body.appendChild(scratchNode)
        scratchNode.select()
        const ok = document.execCommand('copy')
        return ok
      } catch {
        return false
      } finally {
        scratchNode.remove()
        previousFocus?.focus?.({ preventScroll: true })
      }
    }

    /**
     * Flash a short status on a figure.
     * @param {HTMLElement} figure - the figure element.
     * @param {string} text - the message.
     */
    function flash(figure, text) {
      const status = figure.querySelector('.vk-status')
      if (status === null) return
      const token = String(Number(figure.dataset.vkFlash ?? '0') + 1)
      figure.dataset.vkFlash = token
      status.textContent = text
      setTimeout(() => {
        if (figure.dataset.vkFlash === token && status.textContent === text) {
          status.textContent = figure.dataset.vkMode === 'interactive' ? '交互就绪' : `${Math.round(Number(figure.dataset.vkScale ?? '1') * 100)}%`
        }
      }, 1600)
    }

    /**
     * Send a report to the host half, and put it on the clipboard.
     *
     * A diagram that renders wrong is a bug report the user cannot otherwise
     * make: the source is on screen but the reason is not. The clipboard copy is
     * the part that makes it actionable in a chat.
     *
     * @param {object} report - what to report.
     * @returns {Promise<{reported: boolean, copied: boolean}>} the actual outcomes.
     */
    async function sendFeedback(report) {
      const payload = {
        clientRev: CLIENT_REV,
        catalogueRev,
        theme: resolveTheme(),
        href: `${location.origin}${location.pathname}`,
        userAgent: navigator.userAgent,
        diag: { ...diag, byRenderer: { ...diag.byRenderer } },
        ...report,
        source: clipUtf8(String(report.source ?? ''), 16 * 1024),
      }
      const text = [
        'DSH 可视化套件 · 反馈',
        `渲染器: ${payload.renderer ?? '(未知)'}`,
        `识别方式: ${payload.tier ?? '(未知)'}`,
        `客户端版本: ${CLIENT_REV} / 目录 ${catalogueRev}`,
        `主题: ${payload.theme}`,
        '',
        '源码:',
        String(payload.source ?? '').slice(0, 4000),
        '',
        payload.message ? `错误: ${payload.message}` : '',
      ]
        .filter((line) => line !== '')
        .join('\n')
      const copying = copyText(text)
      let reported = false
      try {
        const response = await fetch(DIAG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        })
        reported = response.ok
      } catch {
        // The clipboard result still matters when the report endpoint fails.
      }
      return { reported, copied: await copying }
    }

    function clipUtf8(text, maxBytes) {
      if (new Blob([text]).size <= maxBytes) return text
      let low = 0, high = text.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (new Blob([text.slice(0, mid)]).size <= maxBytes - 32) low = mid
        else high = mid - 1
      }
      return `${text.slice(0, low)}\n[源码已截断]`
    }

    function feedbackStatus(result) {
      if (result.reported) return result.copied ? '已上报，已复制诊断' : '已上报，诊断未复制'
      return result.copied ? '诊断已复制，上报失败，可重试' : '复制和上报均失败，请重试'
    }

    function displayMode(spec, language) {
      const declared = spec.modes?.find((mode) => mode.languages.includes(language))
      const requested = declared?.id ?? (language === 'echarts-interactive' ? 'interactive' : 'static')
      return requested === 'interactive' && spec.settings?.interactive !== false ? 'interactive' : 'static'
    }

    function managedHandle(raw) {
      if (!raw || typeof raw.dispose !== 'function') throw new Error('展示适配器未提供可销毁的句柄')
      let disposed = false
      const handle = { dispose() { if (!disposed) { disposed = true; raw.dispose?.() } } }
      for (const action of ['resize', 'reset', 'scale', 'snapshot']) {
        if (typeof raw[action] === 'function') handle[action] = (...args) => { if (!disposed) return raw[action](...args) }
      }
      return handle
    }

    function legacyHandle(result, figure) {
      const markup = String(result?.markup ?? '')
      if (!markup.trim()) throw new Error('渲染器返回了空结果')
      const canvas = figure.querySelector('.vk-canvas')
      canvas.innerHTML = markup
      return managedHandle({
        scale: (scale) => { figure.dataset.vkManualScale = '1'; applyScale(figure, scale) },
        reset: () => { delete figure.dataset.vkManualScale; applyScale(figure) },
        resize: () => { if (!figure.dataset.vkManualScale) applyScale(figure) },
        snapshot: () => ({ data: serializeSvg(figure), mimeType: 'image/svg+xml', extension: 'svg' }),
        dispose: () => canvas.replaceChildren(),
      })
    }

    function validDisplay(record) {
      const route = routeBlock(record.source, record.language)
      const spec = catalogue?.renderers.find((item) => item.id === record.spec.id)
      return displays.get(record.node) === record && !record.controller.signal.aborted &&
        record.node.isConnected && record.sessionId === currentSessionId && record.theme === resolveTheme() &&
        readSource(bodyOf(record.node)) === record.source && bannerLanguage(record.node) === record.language &&
        route?.id === record.spec.id && displayMode(spec ?? record.spec, record.language) === record.mode
    }

    function disposeDisplay(node, restore = true) {
      const record = displays.get(node)
      if (record) {
        displays.delete(node)
        record.figure.dataset.vkDisplayState = 'disposed'
        record.controller.abort()
        record.resizeObserver?.disconnect()
        window.removeEventListener('resize', record.onResize)
        for (const cleanup of record.cleanups) cleanup()
        try { record.handle?.dispose() } catch (error) { log('display dispose failed', friendlyError(error)) }
        record.figure.remove()
      }
      if (restore) {
        if (node.dataset.vkHidden === '1') node.style.removeProperty('display')
        node.removeAttribute('data-vk-hidden')
        node.dataset.vkState = ''
      }
    }

    function waitForSize(target, signal) {
      return new Promise((resolve, reject) => {
        let observer
        let frame = 0
        const cleanup = () => {
          observer?.disconnect()
          if (frame) cancelAnimationFrame(frame)
          signal.removeEventListener('abort', abort)
          window.removeEventListener('resize', check)
        }
        const abort = () => { cleanup(); reject(signal.reason ?? new DOMException('展示已取消', 'AbortError')) }
        const check = () => {
          if (target.getBoundingClientRect().width > 0) { cleanup(); resolve() }
          else if (!observer) frame = requestAnimationFrame(check)
        }
        if (signal.aborted) { abort(); return }
        signal.addEventListener('abort', abort, { once: true })
        if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(check); observer.observe(target) }
        window.addEventListener('resize', check)
        check()
      })
    }

    async function initializeDisplay(record, mount, timeoutMs = DISPLAY_TIMEOUT_MS) {
      const controller = new AbortController()
      const cancel = () => controller.abort(record.controller.signal.reason)
      record.controller.signal.addEventListener('abort', cancel, { once: true })
      record.cleanups.push(() => { record.controller.signal.removeEventListener('abort', cancel); controller.abort() })
      let timer
      const interrupted = new Promise((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
        timer = setTimeout(() => controller.abort(new Error('展示初始化超时（15 秒），请重试')), timeoutMs)
      })
      if (record.controller.signal.aborted) cancel()
      const env = renderEnv(record.spec, catalogue?.behavior ?? {}, controller.signal)
      env.target = record.target
      const operation = Promise.resolve().then(() => mount(env)).then((result) => {
        if (controller.signal.aborted || !validDisplay(record)) {
          result?.dispose?.()
          throw new DOMException('展示已取消', 'AbortError')
        }
        return result
      }).finally(() => env.dispose())
      try { return await Promise.race([operation, interrupted]) }
      finally { clearTimeout(timer) }
    }

    function observeDisplay(record) {
      record.onResize = () => {
        if (!validDisplay(record) || record.target.getBoundingClientRect().width <= 0) return
        try { record.handle?.resize?.() } catch (error) { flash(record.figure, `尺寸更新失败：${friendlyError(error)}`) }
      }
      if (typeof ResizeObserver !== 'undefined') {
        record.resizeObserver = new ResizeObserver(record.onResize)
        record.resizeObserver.observe(record.target)
      } else window.addEventListener('resize', record.onResize)
      record.onResize()
    }

    function launchRender(node, source, language, route) {
      const job = renderBlock(node, source, language, route)
      renderJobs.add(job)
      void job.finally(() => renderJobs.delete(job)).catch((error) => log('render failed', friendlyError(error)))
      return job
    }

    /**
     * Build the figure element for a rendered block.
     *
     * @param {object} options - the figure's parts.
     * @returns {HTMLElement} the figure.
     */
    function buildFigure(options) {
      const { source, spec, tier, mode = 'static' } = options
      const behaviour = catalogue?.behavior ?? {}
      const view = presentation()
      const figure = el('div', 'vk-figure')
      figure.dataset.vkTheme = resolveTheme()
      figure.dataset.vkMode = mode
      figure.dataset.vkRenderer = spec.id
      figure.dataset.vkSource = source
      figure.dataset.vkHash = hash(source)

      const bar = el('div', 'vk-bar')
      bar.appendChild(el('span', 'vk-label', spec.label))
      const status = el('span', 'vk-status')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      status.textContent = '100%'
      bar.appendChild(status)

      if (view.showToolbar) {
        const actions = el('div', 'vk-tools')
        actions.setAttribute('role', 'group')
        actions.setAttribute('aria-label', `${spec.label}图形操作`)
        const control = (label, title, action, click) => {
          const node = button(label, title, async () => {
            try { await click() }
            catch (error) { flash(figure, `操作失败：${friendlyError(error)}`) }
          })
          node.dataset.vkAction = action
          node.disabled = true
          if (action === 'scale' && mode === 'interactive') node.hidden = true
          return node
        }
        actions.appendChild(control('−', '画布内缩小', 'scale', () => figure.__vkHandle?.scale(Number(figure.dataset.vkScale ?? '1') / SCALE_STEP)))
        actions.appendChild(control('+', '画布内放大', 'scale', () => figure.__vkHandle?.scale(Number(figure.dataset.vkScale ?? '1') * SCALE_STEP)))
        actions.appendChild(control(mode === 'interactive' ? '重置' : '适应', mode === 'interactive' ? '重置图表' : '适应画布', 'reset', () => figure.__vkHandle?.reset()))
        actions.appendChild(
          control('放大', '放大展示：铺满窗口看细节（Esc 关闭）', 'expand', async () => {
            const snapshot = await figure.__vkHandle?.snapshot()
            const text = typeof snapshot?.data === 'string' ? snapshot.data : ''
            if (text === '') {
              flash(figure, '暂时无法放大这张图')
              return
            }
            const opened = openLightbox({
              label: spec.label,
              snapshot: text,
              natural: figure.__vkNatural ?? naturalSize(figure),
              trigger: actions.querySelector('[data-vk-action="expand"]'),
            })
            if (!opened) flash(figure, '暂时无法放大这张图')
          }),
        )
        actions.appendChild(
          button('复制', '复制源码', async () => {
            const ok = await copyText(figure.dataset.vkSource ?? '')
            flash(figure, ok ? '已复制源码' : '复制失败')
          }),
        )
        actions.appendChild(
          control('下载', '下载 SVG', 'snapshot', async () => {
            let snapshot
            try { snapshot = await figure.__vkHandle?.snapshot() }
            catch (error) { flash(figure, `导出失败：${friendlyError(error)}`); return }
            if (!snapshot?.data) { flash(figure, '没有可下载的图'); return }
            const blob = snapshot.data instanceof Blob ? snapshot.data : new Blob([snapshot.data], { type: snapshot.mimeType })
            const url = URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = url
            link.download = `${spec.id}-${figure.dataset.vkHash}.${snapshot.extension}`
            document.body.appendChild(link)
            link.click()
            link.remove()
            setTimeout(() => URL.revokeObjectURL(url), 4000)
          }),
        )
        const feedback = button('反馈', '把源码与诊断信息复制并上报', async () => {
          if (feedback.disabled) return
          feedback.disabled = true
          feedback.textContent = '上报中…'
          try {
            const result = await sendFeedback({ renderer: spec.id, tier, source, mode: options.mode ?? 'static', ...figure.__vkFailure, kind: 'feedback' })
            flash(figure, feedbackStatus(result))
          } finally {
            feedback.disabled = false
            feedback.textContent = '反馈'
          }
        })
        actions.appendChild(feedback)
        bar.appendChild(actions)
      }
      figure.appendChild(bar)

      const canvas = el('div', 'vk-canvas')
      canvas.tabIndex = 0
      canvas.setAttribute('role', 'region')
      canvas.setAttribute('aria-label', `${spec.label}图形，可滚动查看`)
      canvas.style.padding = `${view.canvasPadding}px`
      canvas.style.maxHeight = `${view.canvasMaxHeight}px`
      const background =
        view.background === 'auto' ? surfaceColor() : view.background === 'dark' ? '#1e1e1e' : view.background
      if (background !== 'transparent') canvas.style.background = background
      figure.appendChild(canvas)

      if (tier === 'content') {
        // The model did not label this block, so say what it was taken for: a
        // wrong guess must be visible rather than silently rendered.
        const note = el('div', 'vk-bar vk-note', `按内容识别为 ${spec.label}`)
        figure.appendChild(note)
      }

      const details = el('details', 'vk-source')
      details.appendChild(el('summary', undefined, '查看源码'))
      const pre = el('pre')
      pre.appendChild(el('code', undefined, source))
      details.appendChild(pre)
      figure.appendChild(details)

      return figure
    }

    function attachHandle(record, handle, state, failure) {
      record.handle = handle
      record.figure.__vkHandle = handle
      record.figure.__vkFailure = failure
      record.figure.dataset.vkDisplayState = state
      for (const control of record.figure.querySelectorAll('[data-vk-action]')) {
        const action = control.dataset.vkAction
        // 放大展示读的是快照能力，而不是一个独立的句柄方法
        const capability = action === 'expand' ? 'snapshot' : action
        control.hidden = typeof handle[capability] !== 'function'
        control.disabled = control.hidden
        if (action === 'reset') {
          const interactive = record.figure.dataset.vkMode === 'interactive'
          control.textContent = interactive ? '重置' : '适应'
          control.title = interactive ? '重置图表' : '适应画布'
          control.setAttribute('aria-label', control.title)
        }
      }
      record.figure.querySelector('.vk-status').textContent = record.figure.dataset.vkMode === 'interactive' ? '交互就绪' : '100%'
      observeDisplay(record)
    }

    /**
     * Show why a block did not become a figure.
     *
     * Silence is the worst outcome: the user sees a code block and cannot tell
     * whether the plugin is off, the syntax is wrong, or the renderer is
     * missing. The card always names the renderer, states the reason, and offers
     * the feedback action.
     *
     * @param {HTMLElement} host - the block the card belongs after.
     * @param {string} message - the reason.
     * @param {string} source - the block's source.
     * @param {object} [options] - `renderer`, `uncertain`, `kind`.
     */
    /**
     * A concrete fix suggestion for a failure.
     *
     * A bare parser message ("Parse error on line 10") tells neither the reader
     * nor the model what to change, so the card pairs it with the mistake this
     * engine's grammar most often trips on.
     *
     * @param {object} spec - the renderer's catalogue entry.
     * @param {string} message - the failure message.
     * @returns {string} the suggestion, or '' when nothing specific applies.
     */
    function fixHint(spec, message) {
      const text = String(message)
      const syntax = /parse error|syntax error|lexical error|unexpected|expecting/i.test(text)
      if (syntax) {
        switch (spec.id) {
          case 'mermaid':
            return '常见原因：节点文字里的括号、方括号、引号要整段加引号 —— 写 A["文字（含括号）"]，不要写 A[文字（含括号）]；子图标题写成 subgraph 名称["标题"]。'
          case 'graphviz':
            return '常见原因：属性写成 key="value"；含空格或标点的标签必须加引号（label="含 空格"）；节点名不要用 graph/node/edge 这些保留字。'
          case 'nomnoml':
            return '常见原因：框是 [文字]，箭头是 ->，连线标签写在箭头前 —— [A] 是 -> [B]；没有 <choice> 这类语法。'
          case 'vega-lite':
            return '常见原因：要有 mark 与 data；字段名写在 encoding.x.field；不要用 vega 的运行时语法写 vega-lite。'
          case 'echarts':
            return '常见原因：JSON 里不能有注释或尾随逗号；series 必须带 type；数据放在 series.data。'
          default:
            return spec.syntaxHint ?? ''
        }
      }
      if (spec.id === 'svg' && /没有可用的 <svg>/.test(text)) {
        return '代码块要以 <svg …> 开头、以 </svg> 结束；viewBox 建议写 0 0 680 高，且高不超过 400，否则会被画布裁切。'
      }
      return spec.syntaxHint ?? ''
    }

    /**
     * Report a block that could not be rendered.
     *
     * The card names the renderer, states the reason, suggests a fix and offers
     * the renderer's own minimal example — so a failure is also the fastest way
     * to see what valid input looks like.
     *
     * @param {HTMLElement} host - the block the card belongs after.
     * @param {string} message - the reason.
     * @param {string} source - the block's source.
     * @param {object} [options] - `renderer`, `uncertain`, `kind`, `tier`.
     */
    function showError(host, message, source, options = {}) {
      const existing = host.nextElementSibling
      if (existing !== null && existing.classList?.contains('vk-error')) existing.remove()
      const behaviour = catalogue?.behavior ?? {}
      if (behaviour.errorCard === false) return

      const card = el('div', options.uncertain === true ? 'vk-error vk-note' : 'vk-error')
      card.dataset.vkTheme = resolveTheme()
      const lead =
        options.uncertain === true
          ? '这段代码看着像图，但没能解析成图：'
          : options.kind === 'unavailable'
            ? '这个渲染器当前不可用：'
            : '渲染失败：'
      card.appendChild(el('div', 'vk-error-lead', lead))
      card.appendChild(el('div', 'vk-error-message', String(message).slice(0, 600)))

      const spec =
        typeof options.renderer === 'string' && options.renderer !== ''
          ? catalogue?.renderers.find((candidate) => candidate.id === options.renderer)
          : undefined
      if (spec !== undefined) {
        const hint = fixHint(spec, message)
        if (hint !== '') card.appendChild(el('div', 'vk-error-hint', hint))
        if (typeof spec.sample === 'string' && spec.sample !== '') {
          const details = el('details', 'vk-source vk-error-sample')
          details.appendChild(el('summary', '', `${spec.label} 的最小可用示例`))
          const pre = el('pre', '')
          pre.textContent = spec.sample
          details.appendChild(pre)
          card.appendChild(details)
        }
      }

      const actions = el('div', 'vk-actions')
      const status = el('span', 'vk-error-status')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      const selfRepair = options.mode !== 'interactive' && behaviour.selfRepair !== false
      const feedback = button(selfRepair ? '反馈并修复' : '反馈', selfRepair ? '上报诊断，并让本会话的 agent 去修插件' : '把源码与诊断信息复制并上报', async () => {
        if (feedback.disabled) return
        feedback.disabled = true
        status.textContent = '正在上报诊断…'
        try {
          const failure = {
            renderer: options.renderer ?? '',
            tier: options.tier ?? '',
            source,
            message: String(message),
            kind: options.kind ?? 'error',
            mode: options.mode ?? 'static',
            ...options.failure,
          }
          const result = await sendFeedback(failure)
          if (result.reported !== true) {
            status.textContent = feedbackStatus(result)
            return
          }
          if (selfRepair !== true) {
            status.textContent = feedbackStatus(result)
            return
          }
          status.textContent = '已上报，正在请本会话修复…'
          try {
            await promptSession(repairRequest(failure))
            status.textContent = '已上报，已请本会话修复'
          } catch (error) {
            status.textContent = `已上报（未能请会话修复：${friendlyError(error)}）`
          }
        } finally {
          feedback.disabled = false
        }
      })
      actions.appendChild(feedback)
      actions.appendChild(status)
      card.appendChild(actions)
      host.insertAdjacentElement('afterend', card)
      diag.failed += 1
      diag.lastError = String(message).slice(0, 300)
    }

    // ---------------------------------------------------------------------
    // The render pipeline.
    // ---------------------------------------------------------------------

    /**
     * Render one block, replacing it with a figure.
     *
     * @param {HTMLElement} node - the block root.
     * @param {string} source - its source.
     * @param {string} language - its declared language.
     * @param {{id: string, tier: string}} route - the routing decision.
     * @returns {Promise<void>} when the figure is in place, or the reason is shown.
     */
    async function renderBlock(node, source, language, route) {
      if (node.dataset.vkState !== 'pending') return
      const spec = catalogue?.renderers.find((candidate) => candidate.id === route.id)
      const adapter = ADAPTERS[spec?.id]
      if (!spec || !adapter || !node.isConnected || routeBlock(source, language)?.id !== route.id) {
        node.dataset.vkState = ''
        return
      }
      const requestedInteractive = language === 'echarts-interactive'
      let record
      node.dataset.vkState = 'rendering'
      try {
        // Validation precedes both interactive mounting and its static fallback.
        if (requestedInteractive) validateInteractiveSource(source)
        const mode = displayMode(spec, language)
        const figure = buildFigure({ source, spec, tier: route.tier, mode })
        figure.dataset.vkLanguage = language
        figure.dataset.vkDisplayState = 'loading'
        figure.querySelector('.vk-status').textContent = '正在加载…'
        const previous = node.nextElementSibling
        if (previous?.classList.contains('vk-error')) previous.remove()
        const canvas = figure.querySelector('.vk-canvas')
        const target = mode === 'interactive' ? el('div', 'vk-mount') : canvas
        if (target !== canvas) {
          target.style.height = `${Math.max(120, presentation().canvasMaxHeight - 2 * presentation().canvasPadding)}px`
          canvas.appendChild(target)
        }
        record = { node, source, language, spec, mode, figure, target, theme: resolveTheme(), sessionId: currentSessionId,
          controller: new AbortController(), cleanups: [], handle: null, phase: 'size' }
        displays.set(node, record)
        node.insertAdjacentElement('afterend', figure)
        const staticRender = (env) => enqueue(() => {
          if (env.signal.aborted) throw new DOMException('展示已取消', 'AbortError')
          record.phase = 'static-render'
          return adapter.render(source, env)
        })
        let handle, failure, state = 'ready'
        if (mode === 'interactive') {
          try {
            const result = await initializeDisplay(record, async (env) => {
              await waitForSize(target, env.signal)
              const loadEngine = env.loadEngine
              env.loadEngine = async () => {
                record.phase = 'engine'
                const engine = await loadEngine()
                record.phase = 'mount'
                return engine
              }
              return adapter.mount(source, env)
            })
            handle = managedHandle(result)
          } catch (error) {
            if (!validDisplay(record)) throw error
            failure = { mode: 'interactive', phase: record.phase, message: friendlyError(error) }
            record.figure.dataset.vkMode = 'static'
            record.target = canvas
            canvas.replaceChildren()
            try {
              const result = await initializeDisplay(record, staticRender)
              handle = legacyHandle(result, figure)
            } catch (fallbackError) {
              record.failure = { ...failure, fallbackMessage: friendlyError(fallbackError) }
              throw new Error(`${failure.message}；静态降级也失败：${friendlyError(fallbackError)}`)
            }
            state = 'fallback'
            diag.degraded += 1
            diag.lastError = failure.message
          }
        } else {
          const result = await initializeDisplay(record, staticRender)
          handle = legacyHandle(result, figure)
          if (requestedInteractive) {
            state = 'fallback'
            failure = { mode: 'interactive', phase: 'configuration', message: '交互模式已关闭，以静态图展示' }
          }
        }
        if (!validDisplay(record)) { handle.dispose(); throw new DOMException('展示已取消', 'AbortError') }
        attachHandle(record, handle, state, failure)
        if (failure) {
          const note = el('div', 'vk-fallback', `已静态展示：${failure.message}`)
          note.setAttribute('role', 'status')
          figure.appendChild(note)
        }
        node.style.display = 'none'
        node.dataset.vkHidden = '1'
        node.dataset.vkSource = source
        node.dataset.vkState = 'rendered'
        node.dataset.vkDisplayState = state
        diag.rendered += 1
        diag.byRenderer[spec.id] = (diag.byRenderer[spec.id] ?? 0) + 1
      } catch (error) {
        if (record && !validDisplay(record)) {
          // An older cancelled attempt must not dispose its replacement.
          if (displays.get(node) === record) disposeDisplay(node)
          if (started) scheduleScan()
          return
        }
        const failure = record?.failure ?? { mode: requestedInteractive ? 'interactive' : 'static', phase: record?.phase ?? 'validation', message: friendlyError(error) }
        disposeDisplay(node)
        node.dataset.vkState = 'failed'
        node.dataset.vkDisplayState = 'error'
        showError(node, friendlyError(error), source, { renderer: spec.id, tier: route.tier, mode: failure.mode, failure })
      }
    }

    /**
     * Turn an engine's error into one readable line.
     * @param {unknown} error - whatever was thrown.
     * @returns {string} the message.
     */
    function friendlyError(error) {
      const raw = String(error?.message ?? error ?? '').replace(/^Error:\s*/, '')
      return raw.split('\n').find((line) => line.trim() !== '') ?? raw
    }

    /**
     * Queue a render so two engines never parse at the same time.
     * @param {() => Promise<void>} task - the work.
     * @returns {Promise<void>} when it has run.
     */
    function enqueue(task) {
      const next = renderQueue.then(task, task)
      renderQueue = next.catch(() => {})
      return next
    }

    // ---------------------------------------------------------------------
    // Scanning.
    // ---------------------------------------------------------------------

    /** A code block, or a bare `<pre>` in a renderer that emits one. */
    const BLOCK_SELECTOR = '.md-code-block, pre'

    /** The code body of a block, exposed by the component as a stable attribute. */
    const CONTENT_SELECTOR = '[data-code-block-content]'

    /**
     * The element whose text is the block's source.
     * @param {HTMLElement} node - a block root or a bare `<pre>`.
     * @returns {HTMLElement} the element to read.
     */
    function bodyOf(node) {
      if (node.matches('.md-code-block')) return node.querySelector(CONTENT_SELECTOR) ?? node
      return node.querySelector(':scope > code') ?? node
    }

    /**
     * Every block the document currently offers, in document order.
     *
     * A `.md-code-block` counts as one block; a `<pre>` inside one is that
     * block's body and not a separate candidate. Blocks this plugin rendered are
     * excluded — a figure keeps its source in its own markup, and reading that
     * back would render a diagram inside a diagram.
     *
     * @returns {HTMLElement[]} candidate blocks.
     */
    function candidates() {
      const out = []
      for (const node of document.querySelectorAll(BLOCK_SELECTOR)) {
        if (node.closest('.vk-figure, .vk-error, .vk-panel, .vk-scratch') !== null) continue
        if (!node.matches('.md-code-block') && node.closest('.md-code-block') !== null) continue
        out.push(node)
      }
      return out
    }

    /**
     * A structural sample of the code-looking parts of the page.
     *
     * This is what turns "the diagrams did not appear" into a readable answer
     * from outside the browser: it reports what the DOM actually contains, so a
     * wrong assumption about the host's markup is visible immediately instead of
     * being guessed at. It reports shape, not content — tag names, class names,
     * line counts and the first word, never the block itself.
     *
     * @returns {object[]} up to six samples.
     */
    function sampleDom() {
      const out = []
      try {
        for (const node of document.querySelectorAll(BLOCK_SELECTOR)) {
          if (out.length >= 6) break
          const body = bodyOf(node)
          const text = readSource(body)
          const banner = node.querySelector('[data-code-block-banner]')
          out.push({
            tag: node.tagName.toLowerCase(),
            className: String(node.className ?? '').slice(0, 120),
            hasContentAttr: node.querySelector(CONTENT_SELECTOR) !== null,
            banner: String(banner?.textContent ?? '').trim().slice(0, 40),
            lines: text.split('\n').length,
            firstWord: text.trim().split(/\s+/)[0]?.slice(0, 24) ?? '',
            state: node.dataset?.vkState ?? '',
          })
        }
      } catch (error) {
        out.push({ error: String(error?.message ?? error) })
      }
      return out
    }

    /** Scan the document for blocks to render. */
    async function scan() {
      diag.scans += 1
      const cat = await ensureCatalogue()
      if (cat === null) return
      for (const [node, record] of displays) if (!validDisplay(record)) disposeDisplay(node)
      const behaviour = cat.behavior ?? {}
      const lazy = behaviour.lazyRender !== false && typeof IntersectionObserver !== 'undefined'

      const nodes = candidates()
      diag.candidates = nodes.length
      for (const node of nodes) {
        let state = node.dataset?.vkState ?? ''
        const body = bodyOf(node)
        const source = readSource(body)
        const language = bannerLanguage(node)
        const route = routeBlock(source, language, cat)

        // A renderer that was switched off must hand its block back, otherwise
        // the conversation keeps a picture the configuration no longer allows.
        if (route === null || source.trim() === '' || (state === 'rendered' && node.dataset.vkHash !== hash(source))) {
          const output = node.nextElementSibling
          disposeDisplay(node)
          if (output?.matches('.vk-figure, .vk-error')) output.remove()
          if (state !== '') {
            node.style.removeProperty('display')
            node.removeAttribute('data-vk-hidden')
            node.dataset.vkState = ''
            lazyObserver?.unobserve(node)
          }
          state = ''
          if (route === null || source.trim() === '') continue
        }
        // `pending` means a render is already queued for this block — a second
        // scan can overlap the first while both await the catalogue, and without
        // this guard both would enqueue a render, producing two figures for one
        // block. (`rendered`/`rendering` were never the risk; `pending` was.)
        if (state === 'rendered' || state === 'rendering' || state === 'pending') continue
        if (node.dataset.vkHash === hash(source) && state === 'failed') continue

        node.dataset.vkHash = hash(source)
        node.dataset.vkState = 'pending'
        node.dataset.vkSource = source
        if (lazy && lazyObserver !== null) {
          lazyObserver.observe(node)
        } else {
          void launchRender(node, source, language, route)
        }
      }
    }

    /** Debounce a scan: streaming a fence mutates the DOM on every token. */
    function scheduleScan() {
      if (!started) return
      if (scanTimer !== 0) clearTimeout(scanTimer)
      const delay = Number(catalogue?.behavior?.debounceMs)
      scanTimer = setTimeout(
        () => {
          scanTimer = 0
          void scan().catch((error) => log('scan failed', String(error?.message ?? error)))
        },
        Number.isFinite(delay) && delay >= 0 ? delay : SCAN_DEBOUNCE_MS,
      )
    }

    /** Re-render every figure: the theme changed, so their colours did too. */
    async function rerenderAll() {
      const figures = document.querySelectorAll('.vk-figure')
      if (figures.length === 0) return
      for (const figure of figures) {
        const host = figure.previousElementSibling
        if (host === null) continue
        const source = figure.dataset.vkSource ?? ''
        const spec = catalogue?.renderers.find((candidate) => candidate.id === figure.dataset.vkRenderer)
        if (spec === undefined || source === '') continue
        if (catalogue?.behavior?.autoRender === false || spec.enabled !== true) continue
        const route = { id: spec.id, tier: 'theme' }
        const language = figure.dataset.vkLanguage ?? spec.languages?.[0] ?? ''
        disposeDisplay(host)
        figure.remove()
        host.style.removeProperty('display')
        host.removeAttribute('data-vk-hidden')
        // Mark the block as claimed *before* the queued render runs: a scan
        // firing between here and the render would otherwise see an unclaimed
        // block and enqueue a second render — the duplicate-figure bug.
        host.dataset.vkState = 'pending'
        const node = host
        void launchRender(node, source, language, route)
      }
    }

    /** Watch the theme and re-render when it flips. */
    function watchTheme() {
      if (typeof MutationObserver === 'undefined') return
      const target = document.documentElement
      let last = resolveTheme()
      diag.theme = last
      themeObserver = new MutationObserver(() => {
        const next = resolveTheme()
        if (next === last) return
        last = next
        diag.theme = next
        if (themeTimer !== 0) clearTimeout(themeTimer)
        themeTimer = setTimeout(() => {
          themeTimer = 0
          void rerenderAll()
        }, THEME_DEBOUNCE_MS)
      })
      themeObserver.observe(target, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'data-color-scheme'] })
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'data-color-scheme'] })
    }

    /** Report the current counters to the host half. */
    async function reportBeacon() {
      try {
        diag.domSamples = sampleDom()
        await fetch(DIAG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            clientRev: CLIENT_REV,
            catalogueRev,
            theme: resolveTheme(),
            href: `${location.origin}${location.pathname}`,
            diag: { ...diag, byRenderer: { ...diag.byRenderer } },
            kind: 'beacon',
          }),
        })
      } catch {
        // The beacon is best-effort by design: it must never block rendering.
      }
    }

    // ---------------------------------------------------------------------
    // Settings panel: what this plugin can draw, previewed live.
    //
    // A configuration form can list toggles but cannot show what they produce,
    // so the catalogue gets a page of its own in Settings. Every preview is the
    // renderer's own sample pushed through the same adapter the conversation
    // uses — the panel therefore shows exactly what the chat will draw, and
    // cannot drift from it.
    // ---------------------------------------------------------------------

    /** React from the platform module table; null when the host is headless. */
    let React = null
    try {
      React = require('react')
    } catch {
      React = null
    }

    /** Styles for the capabilities page (namespaced `vk-panel`). */
    const PANEL_CSS = `
.vk-panel { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
.vk-panel-head { display: flex; flex-direction: column; gap: 4px; }
.vk-panel-title { font-size: 18px; font-weight: 600; }
.vk-panel-sub { font-size: 13px; color: var(--vk-secondary); line-height: 1.6; }
.vk-panel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px; }
.vk-card { min-width: 0; border: 1px solid var(--vk-border); border-radius: 10px; overflow: hidden; background: var(--vk-surface); }
.vk-card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 16px 8px; }
.vk-card-title { font-size: 13px; font-weight: 600; }
.vk-card-fence { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--vk-secondary); overflow-wrap: anywhere; }
.vk-card-badge { margin-left: auto; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; opacity: .8; }
.vk-card-usage { padding: 0 16px 12px; font-size: 13px; color: var(--vk-secondary); line-height: 1.6; }
.vk-card-preview { min-height: 150px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center; overflow: hidden; padding: 8px; border-top: 1px solid var(--vk-border); background: var(--vk-muted); }
.vk-card-preview svg { max-width: 100%; max-height: 134px; height: auto; }
.vk-card-error { font-size: 11px; color: var(--dsw-color-danger, #e5484d); padding: 0 12px 10px; }
.vk-panel-warn { font-size: 12px; line-height: 1.6; padding: 10px 12px; border-radius: 8px;
  border: 1px solid var(--dsw-color-warning, #d4a72c); background: color-mix(in srgb, var(--dsw-color-warning, #d4a72c) 8%, transparent);
  color: var(--dsw-color-text, inherit); }
.vk-switches { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 10px;
  border: 1px solid var(--vk-border); background: var(--vk-muted); }
.vk-switch { display: flex; align-items: center; gap: 16px; padding: 6px 4px; }
.vk-switch-text { flex: 1; min-width: 0; }
.vk-switch-label { font-size: 13px; font-weight: 500; }
.vk-switch-hint { font-size: 12px; color: var(--vk-secondary); line-height: 1.6; margin-top: 4px; }
.vk-bulk { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--vk-border); }
.vk-bulk-label { font-size: 12px; opacity: .75; margin-right: auto; }
.vk-toggle { font: inherit; font-size: 12px; line-height: 1; padding: 5px 12px; border-radius: 999px;
  min-height: 32px; border: 1px solid var(--vk-border); background: var(--vk-surface); color: inherit; cursor: pointer; white-space: nowrap; }
.vk-toggle:hover:not(:disabled) { background: var(--vk-hover); }
.vk-toggle:disabled { opacity: .55; cursor: default; }
.vk-toggle-on { color: var(--dsw-color-success, #1a7f37);
  border-color: color-mix(in srgb, var(--dsw-color-success, #1a7f37) 45%, transparent);
  background: color-mix(in srgb, var(--dsw-color-success, #1a7f37) 10%, transparent); }
/* 滑动开关：轨道 + 滑钮 */
.vk-switch-btn { position: relative; flex: none; width: 38px; height: 22px; padding: 0; border: none; border-radius: 999px;
  background: var(--dsw-color-border-strong, #888780); cursor: pointer; margin-left: auto;
  transition: background .18s ease; -webkit-tap-highlight-color: transparent; }
.vk-switch-btn:hover:not(:disabled) { filter: brightness(.97); }
.vk-switch-btn:disabled { opacity: .5; cursor: default; }
.vk-switch-btn:focus-visible { outline: 2px solid var(--dsw-color-accent, #185FA5); outline-offset: 2px; }
.vk-switch-btn-on { background: var(--dsw-color-success, #3B6D11); }
.vk-switch-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%;
  background: oklch(98% .008 85); box-shadow: 0 1px 2px rgba(0, 0, 0, .28); transition: transform .18s ease-out; }
.vk-switch-btn-on .vk-switch-knob { transform: translateX(16px); }
.vk-card-toggle { margin-left: auto; }
.vk-panel-note { font-size: 12px; color: var(--vk-secondary); line-height: 1.7; padding-top: 12px; border-top: 1px solid var(--vk-border); }
.vk-panel-status { min-height: 20px; font-size: 12px; color: var(--vk-secondary); }
@media (pointer: coarse) { .vk-toggle { min-height: 44px; } .vk-switch-btn::before { content: ''; position: absolute; inset: -11px -3px; } }
`

    /** Inject the panel stylesheet once. */
    function injectPanelStyles() {
      if (typeof document === 'undefined') return
      injectStyles()
      if (document.getElementById('dsh-visual-kit-panel-styles') !== null) return
      const style = document.createElement('style')
      style.id = 'dsh-visual-kit-panel-styles'
      style.textContent = PANEL_CSS
      document.head.appendChild(style)
    }

    /**
     * One renderer's live preview.
     * @param {{spec: object}} props - the catalogue entry to draw.
     * @returns {object} the React element.
     */
    function RendererPreview(props) {
      const host = React.useRef(null)
      const [error, setError] = React.useState('')
      const [theme, setTheme] = React.useState(resolveTheme)
      const [loading, setLoading] = React.useState(true)
      const spec = props.spec
      React.useEffect(() => {
        const observer = new MutationObserver(() => setTheme(resolveTheme()))
        const options = { attributes: true, attributeFilter: ['class', 'data-theme', 'style', 'data-color-scheme'] }
        observer.observe(document.documentElement, options)
        observer.observe(document.body, options)
        return () => observer.disconnect()
      }, [])
      React.useEffect(() => {
        const node = host.current
        if (node === null) return undefined
        let cancelled = false
        const controller = new AbortController()
        const env = renderEnv(spec, catalogue?.behavior ?? {}, controller.signal)
        env.theme = theme
        env.measure = false
        setError('')
        setLoading(true)
        void enqueue(async () => {
          if (cancelled) return
          try {
            const adapter = ADAPTERS[spec.id]
            if (adapter === undefined) throw new Error('没有对应的适配器')
            if (typeof spec.sample !== 'string') {
              // The catalogue came from a host half older than this panel: the
              // preview needs the sample only the new host publishes. Say what
              // to do rather than showing an unexplained blank.
              throw new Error('预览需宿主半更新：完全退出并重新打开 DSH 后生效')
            }
            const result = await adapter.render(spec.sample, env)
            if (cancelled) return
            node.innerHTML = String(result?.markup ?? '')
          } catch (failure) {
            if (!cancelled) setError(friendlyError(failure))
          } finally {
            env.dispose()
            if (!cancelled) setLoading(false)
          }
        })
        return () => {
          cancelled = true
          controller.abort()
          env.dispose()
        }
      }, [spec, theme])
      return React.createElement(
        'div',
        { className: 'vk-card-preview', 'aria-busy': loading },
        React.createElement('div', { ref: host, style: { width: '100%', display: loading || error !== '' ? 'none' : 'flex', justifyContent: 'center' } }),
        loading ? React.createElement('span', { className: 'vk-panel-sub', role: 'status' }, '正在生成预览…') : null,
        error !== '' ? React.createElement('span', { className: 'vk-card-error', role: 'status' }, error) : null,
      )
    }

    /**
     * The capabilities page: every renderer, what it is for, and its own output.
     * @returns {object} the React element.
     */
    /**
     * Read the switches the settings page renders.
     * @returns {Promise<object|null>} `{ autoRender, promptSection, skill, renderers }`.
     */
    async function fetchSwitches() {
      try {
        const response = await fetch(CONFIG_URL, { credentials: 'same-origin' })
        if (!response.ok) return null
        const payload = await response.json()
        return payload?.value?.settings ?? null
      } catch {
        return null
      }
    }

    /**
     * Write a configuration patch and reload what the page shows.
     *
     * The write goes through the host, which persists it into the plugin's own
     * profile row — so the plugin's config form, the prompt section, the skill
     * and this page all move together.
     *
     * @param {object} patch - the sections/fields to change.
     * @returns {Promise<void>} resolves once the page has the new state.
     */
    async function writeSwitches(patch) {
      const response = await fetch(CONFIG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error?.message ?? `写入失败（HTTP ${response.status}）`)
      }
    }

    /**
     * A switch in the shape people already know: a track with a sliding knob.
     *
     * It is a real `<button role="switch">`, so it is keyboard reachable and
     * announces its state; the pill it replaces only said "已开启/已关闭" in
     * words and looked like a badge rather than a control.
     *
     * @param {{on: boolean, busy?: boolean, label: string, onToggle: () => void}} props - switch props.
     * @returns {object} the React element.
     */
    function Toggle(props) {
      return React.createElement(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': props.on === true,
          'aria-label': props.label,
          title: props.label,
          className: props.on === true ? 'vk-switch-btn vk-switch-btn-on' : 'vk-switch-btn',
          disabled: props.busy === true,
          onClick: props.onToggle,
        },
        React.createElement('span', { className: 'vk-switch-knob' }),
      )
    }

    /**
     * One labelled switch row.
     * @param {{label: string, hint: string, on: boolean, busy: boolean, onToggle: () => void}} props - row props.
     * @returns {object} the React element.
     */
    function SwitchRow(props) {
      return React.createElement(
        'div',
        { className: 'vk-switch' },
        React.createElement(
          'div',
          { className: 'vk-switch-text' },
          React.createElement('div', { className: 'vk-switch-label' }, props.label),
          React.createElement('div', { className: 'vk-switch-hint' }, props.hint),
        ),
        React.createElement(Toggle, { on: props.on, busy: props.busy, label: props.label, onToggle: props.onToggle }),
      )
    }

    /**
     * The capabilities page: every renderer, what it is for, its own output, and
     * the switches that enable it.
     * @returns {object} the React element.
     */
    function CapabilityPanel() {
      const [state, setState] = React.useState({ status: 'loading', specs: [], switches: null, error: '', busy: '', message: '' })
      const saving = React.useRef(false)

      /** Read the catalogue and the switches together. */
      const reload = React.useCallback(async () => {
        const [cat, switches] = await Promise.all([ensureCatalogue(true), fetchSwitches()])
        if (cat === null || switches === null) throw new Error('读取绘图设置失败，请重试。')
        return { specs: cat?.renderers ?? [], switches }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        void (async () => {
          try {
            const next = await reload()
            if (!cancelled) setState({ status: 'ready', ...next, error: '', busy: '', message: '' })
          } catch (error) {
            if (!cancelled) setState((previous) => ({ ...previous, status: 'ready', error: friendlyError(error) }))
          }
        })()
        return () => {
          cancelled = true
        }
      }, [reload])

      /**
       * Apply a patch, then refresh what this page shows.
       * @param {object} patch - the configuration patch.
       * @param {string} tag - which control is busy.
       */
      const apply = async (patch, tag) => {
        if (saving.current) return
        saving.current = true
        setState((previous) => ({ ...previous, busy: tag, error: '' }))
        try {
          if (patch !== null) await writeSwitches(patch)
          const next = await reload()
          if (started) {
            await scan()
            await rerenderAll()
          }
          setState({ status: 'ready', ...next, error: '', busy: '', message: patch === null ? '设置已刷新' : '设置已保存' })
        } catch (error) {
          setState((previous) => ({ ...previous, busy: '', error: friendlyError(error) }))
        } finally {
          saving.current = false
        }
      }

      if (state.status === 'loading') {
        return React.createElement('div', { className: 'vk-panel' }, React.createElement('div', { className: 'vk-panel-sub' }, '正在读取渲染器目录…'))
      }

      const { specs, switches } = state
      const enabledCount = specs.filter((spec) => spec.enabled).length
      // A host half older than this panel publishes no samples; say so once at
      // the top instead of leaving the reader to guess why every card is blank.
      const staleHost = specs.length > 0 && !specs.some((spec) => typeof spec.sample === 'string')
      const allOn = enabledCount === specs.length
      const setAll = (enabled) =>
        apply(
          { renderers: Object.fromEntries(specs.map((spec) => [spec.id, { enabled }])) },
          enabled ? 'all-on' : 'all-off',
        )

      return React.createElement(
        'div',
        { className: 'vk-panel', 'aria-busy': state.busy !== '' },
        React.createElement(
          'div',
          { className: 'vk-panel-head' },
          React.createElement('div', { className: 'vk-panel-title' }, `绘图能力 · ${specs.length} 种渲染方式`),
          React.createElement(
            'div',
            { className: 'vk-panel-sub' },
            `当前启用 ${enabledCount} 种。预览使用真实渲染器，开关保存后立即生效。`,
          ),
        ),
        React.createElement('div', { className: 'vk-panel-status', role: 'status', 'aria-live': 'polite' }, state.busy !== '' ? '正在保存并同步…' : state.message),
        state.error !== '' ? React.createElement('div', { className: 'vk-panel-warn', role: 'alert' }, state.error,
          React.createElement('button', { type: 'button', className: 'vk-toggle', disabled: state.busy !== '', onClick: () => apply(null, 'retry') }, '重新读取')) : null,
        staleHost
          ? React.createElement(
              'div',
              { className: 'vk-panel-warn' },
              '宿主半仍是旧版本：预览与开关都暂时不可用（它们要读宿主下发的示例源码与开关快照）。完全退出并重新打开 DSH 即可恢复 —— 插件停用/启用不会重载宿主半。',
            )
          : null,
        switches === null
          ? null
          : React.createElement(
              'div',
              { className: 'vk-switches' },
              React.createElement(SwitchRow, {
                label: '总开关 · 自动渲染',
                hint: '关闭后对话里的代码块保持原样，不再自动变成图（插件仍然加载，随时可再打开）。',
                on: switches.autoRender !== false,
                busy: state.busy !== '',
                onToggle: () => apply({ behavior: { autoRender: switches.autoRender === false } }, 'autoRender'),
              }),
              React.createElement(SwitchRow, {
                label: 'ECharts 交互模式',
                hint: '允许 echarts-interactive 悬停查看数值、筛选图例和缩放区间；普通 echarts 保持静态。关闭后交互代码块以静态图展示。',
                on: switches.interactive !== false,
                busy: state.busy !== '',
                onToggle: () => apply({ renderers: { echarts: { interactive: switches.interactive === false } } }, 'interactive'),
              }),
              React.createElement(SwitchRow, {
                label: '模型侧提示段',
                hint: '在系统提示里加一行「讲解结构、流程、对比、方案、数据时主动配图」。关闭后模型不再被要求主动配图。',
                on: switches.promptSection !== false,
                busy: state.busy !== '',
                onToggle: () => apply({ agent: { promptSection: switches.promptSection === false } }, 'promptSection'),
              }),
              React.createElement(SwitchRow, {
                label: 'dsh-visualization 技能',
                hint: '注册按需加载的技能（选型表、语法要点、手写 SVG 设计系统）。关闭后模型不再获得这份参考。',
                on: switches.skill !== false,
                busy: state.busy !== '',
                onToggle: () => apply({ agent: { skill: switches.skill === false } }, 'skill'),
              }),
              React.createElement(SwitchRow, {
                label: '反馈时让本会话直接修',
                hint: '点错误卡片上的「反馈并修复」时，把失败信息投递给本会话，让这个会话的 agent 自己去改插件（会消耗本会话 token；关掉则只上报不投递）。',
                on: switches.selfRepair !== false,
                busy: state.busy !== '',
                onToggle: () => apply({ behavior: { selfRepair: switches.selfRepair === false } }, 'selfRepair'),
              }),
              React.createElement(
                'div',
                { className: 'vk-bulk' },
                React.createElement('span', { className: 'vk-bulk-label' }, '全部渲染器'),
                React.createElement(
                  'button',
                  { type: 'button', className: 'vk-toggle', disabled: state.busy !== '' || allOn, onClick: () => setAll(true) },
                  state.busy === 'all-on' ? '…' : '全部启用',
                ),
                React.createElement(
                  'button',
                  { type: 'button', className: 'vk-toggle', disabled: state.busy !== '' || enabledCount === 0, onClick: () => setAll(false) },
                  state.busy === 'all-off' ? '…' : '全部关闭',
                ),
              ),
            ),
        React.createElement(
          'div',
          { className: 'vk-panel-grid' },
          specs.map((spec) =>
            React.createElement(
              'div',
              { className: 'vk-card', key: spec.id },
              React.createElement(
                'div',
                { className: 'vk-card-head' },
                React.createElement('span', { className: 'vk-card-title' }, spec.label),
                React.createElement('span', { className: 'vk-card-fence' }, (spec.languages ?? []).slice(0, 2).map((l) => `\`\`\`${l}`).join(' ')),
                React.createElement(Toggle, {
                  on: spec.enabled === true,
                  busy: state.busy !== '',
                  label: `${spec.label}：${spec.enabled ? '已启用，点击关闭' : '已关闭，点击启用'}`,
                  onToggle: () => apply({ renderers: { [spec.id]: { enabled: spec.enabled !== true } } }, spec.id),
                }),
              ),
              React.createElement('div', { className: 'vk-card-usage' }, spec.usage ?? ''),
              React.createElement(RendererPreview, { spec }),
            ),
          ),
        ),
        React.createElement(
          'div',
          { className: 'vk-panel-note' },
          '这里改的就是插件的真实配置（写入本插件的配置行），因此插件配置页里的开关、给模型的提示段、技能内容会同步变化。',
          React.createElement('br'),
          '外观参数（字号、画布高度、底色、完整性校验）在插件配置页里调整。',
        ),
      )
    }

    /**
     * An invisible occupant that learns which session this page is showing.
     *
     * Session-scoped slots hand their occupants `sessionId` among the standard
     * props. There is no service that simply answers "which session is open", so
     * this renders nothing and only records the id — which is what lets a failed
     * figure offer to repair itself in the session it appeared in.
     *
     * @param {{sessionId?: string}} props - standard slot props.
     * @returns {null} nothing is drawn.
     */
    function SessionProbe(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const chat = props?.useChat?.(snapshot => snapshot) ?? null
      if (chat !== currentChatSnapshot) {
        currentChatSnapshot = chat
        queueMicrotask(() => scheduleScan())
      }
      if (sessionId !== currentSessionId) {
        currentSessionId = sessionId
        // Defer DOM changes until after React has committed the new session.
        queueMicrotask(() => {
          for (const [node, record] of displays) if (record.sessionId !== currentSessionId) disposeDisplay(node)
          scheduleScan()
        })
      }
      React?.useEffect?.(() => () => {
        if (currentSessionId === sessionId) {
          currentSessionId = ''
          currentChatSnapshot = null
          queueMicrotask(() => {
            for (const [node, record] of displays) if (record.sessionId !== currentSessionId) disposeDisplay(node)
          })
        }
      }, [sessionId])
      return null
    }

    /**
     * Register the session probe, once the slot service is up.
     * @param ctx - the client runtime context.
     * @returns {() => void} disposer.
     */
    function registerSessionProbe(ctx) {
      if (React === null) return () => {}
      const registerInto = (slots) => {
        try {
          return slots.inject('conversation.composer.dock', () =>
            slots.register({ name: 'conversation.composer.dock', id: 'dsh-visual-kit-probe', order: 999 }, SessionProbe),
          )
        } catch (error) {
          log('session probe not registered', String(error?.message ?? error))
          return () => {}
        }
      }
      if (typeof ctx?.inject === 'function') return ctx.inject(['slots'], (scope) => registerInto(scope.slots))
      const slots = ctx?.get?.('slots')
      return slots === undefined || slots === null ? () => {} : registerInto(slots)
    }

    /**
     * Ask the current session's own agent to look at a failure.
     *
     * The message goes through the sessions service, so it arrives as a normal
     * user turn: the agent decides what to do with it and may delegate to a
     * subagent on its own terms. Nothing is injected behind the user's back —
     * this only runs from the button they pressed.
     *
     * @param {string} text - the message to deliver.
     * @returns {Promise<void>} resolves once the host accepted it.
     */
    async function promptSession(text) {
      const sessions = clientCtx?.get?.('sessions')
      if (sessions === undefined || sessions === null) throw new Error('sessions 服务不可用')
      if (currentSessionId === '') throw new Error('还没拿到本会话 id（请在本会话里先完成一轮对话）')
      await sessions.using(currentSessionId, { source: 'controllerOperation' }, async (reference) => {
        const session = reference?.binding?.session
        if (session === undefined || session === null) throw new Error('会话句柄不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (result?.ok !== true) throw new Error(result?.error?.message ?? '投递被拒绝')
      })
    }

    /**
     * The message sent to the session when a diagram fails.
     *
     * It states the facts, points at the plugin's own files, and tells the agent
     * to distinguish "the adapter is wrong" from "the model wrote bad syntax" —
     * the two causes need opposite fixes.
     *
     * @param {{renderer: string, tier: string, message: string, source: string}} failure - what failed.
     * @returns {string} the message.
     */
    function repairRequest(failure) {
      const excerpt = String(failure.source ?? '').slice(0, 1200)
      return [
        '【可视化插件自修请求】本会话里有一张图渲染失败了，请你直接修插件本身。',
        `- 渲染器：${failure.renderer || '未知'}（路由方式：${failure.tier || '未知'}）`,
        `- 失败信息：${String(failure.message ?? '').slice(0, 400)}`,
        '- 出错的源码：',
        '```',
        excerpt,
        '```',
        '插件位置：G:\\DeepSeekHarness\\harness_plugin\\dsh-visual-kit',
        '（宿主半 lib/index.js、客户端半 lib/client.js、渲染器清单 lib/renderers/manifest.js、技能与示例由 scripts/vendor.mjs 生成）',
        '请按这个顺序判断：',
        '1) 先分清是「渲染器适配器的 bug」还是「这段语法本来就写错了」——两者修法相反。',
        '2) 若是插件 bug：改代码 + 补测试（npm test / node --test）+ 提升客户端版本号（lib/client.js 的 CLIENT_REV 与 package.json），并说明需要 F5 还是重启。',
        '3) 若是语法写错：把该引擎最常见的坑补进错误卡片的提示（lib/client.js 的 fixHint）与技能文档（scripts/vendor.mjs），让下次不再犯。',
        '4) 工作量小就直接改；涉及多个文件或多个引擎，用 subagent 分工。',
        '改完给我一句话结论 + 我需要做什么（F5 还是重启）。',
      ].join('\n')
    }

    /**
     * Register the capabilities page, once the slot service is up.
     *
     * The service is NOT read with `ctx.get` here: at boot this module can
     * materialize before `slots` exists, and a one-shot lookup would silently
     * register nothing — which is exactly how the page disappeared after a
     * restart while still working in a long-running page. `ctx.inject` waits for
     * the dependency and disposes with the fiber, without gating the rest of
     * this half (the conversation pipeline must start regardless).
     *
     * @param ctx - the client runtime context.
     * @returns {() => void} disposer.
     */
    function registerCapabilitiesPanel(ctx) {
      if (React === null) return () => {}

      /** Register into a live slot service. */
      const registerInto = (slots) => {
        try {
          injectPanelStyles()
          return slots.inject('settings.section', () =>
            slots.register({ name: 'settings.section', id: 'dsh-visual-kit', order: 60, label: '可视化套件' }, CapabilityPanel),
          )
        } catch (error) {
          log('capabilities panel not registered', String(error?.message ?? error))
          return () => {}
        }
      }

      if (typeof ctx?.inject === 'function') {
        return ctx.inject(['slots'], (scope) => registerInto(scope.slots))
      }
      // Fallback for a runtime without per-callback injection: register only if
      // the service already exists.
      const slots = ctx?.get?.('slots')
      return slots === undefined || slots === null ? () => {} : registerInto(slots)
    }

    // ---------------------------------------------------------------------
    // Lifecycle.
    // ---------------------------------------------------------------------

    /** Start watching the conversation. Safe to call twice. */
    function start() {
      if (started) return
      started = true
      diag.started = true
      injectStyles()

      if (typeof IntersectionObserver !== 'undefined') {
        lazyObserver = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue
              const node = entry.target
              lazyObserver?.unobserve(node)
              // The block may already have been rendered through another path
              // between `observe` and this callback.
              if (node.dataset?.vkState !== 'pending') continue
              const source = node.dataset?.vkSource ?? ''
              if (source.length === 0) continue
              const language = bannerLanguage(node)
              const route = routeBlock(source, language)
              if (route === null) continue
              void launchRender(node, source, language, route)
            }
          },
          { rootMargin: LAZY_MARGIN },
        )
      }

      if (typeof MutationObserver !== 'undefined') {
        // One observer on the body: the conversation container is replaced when
        // the user switches sessions, and watching a node that gets discarded
        // would silently stop the feature.
        domObserver = new MutationObserver((mutations) => {
          for (const [node] of displays) if (!node.isConnected) disposeDisplay(node)
          if (mutations.some((mutation) => !mutation.target.parentElement?.closest('.vk-figure, .vk-panel, .vk-error, .vk-scratch') && !mutation.target.closest?.('.vk-figure, .vk-panel, .vk-error, .vk-scratch'))) scheduleScan()
        })
        domObserver.observe(document.body, { childList: true, characterData: true, subtree: true })
      }

      watchTheme()
      void ensureCatalogue().then(() => scheduleScan())

      // Configuration edits must land without a reload, so the enabled set is
      // re-checked on focus and on a slow timer.
      focusHandler = () => {
        void refreshCatalogueIfChanged().then((changed) => {
          if (changed) {
            log('catalogue changed', { enabled: diag.enabled })
            scheduleScan()
          }
        })
      }
      window.addEventListener('focus', focusHandler)
      configTimer = setInterval(focusHandler, CONFIG_POLL_MS)

      reportBeacon()
      log('client half started', { rev: CLIENT_REV, theme: resolveTheme() })
    }

    /**
     * Release everything this half owns.
     *
     * Teardown must never throw: it runs while the plugin is being unloaded, and
     * an exception here would leave the DOM exactly as half-cleaned as it looks.
     */
    function stop() {
      if (!started) return
      started = false
      diag.started = false
      if (focusHandler !== null) window.removeEventListener('focus', focusHandler)
      focusHandler = null
      domObserver?.disconnect()
      domObserver = null
      themeObserver?.disconnect()
      themeObserver = null
      lazyObserver?.disconnect()
      lazyObserver = null
      for (const timer of [scanTimer, themeTimer, configTimer]) if (timer !== 0) clearTimeout(timer)
      if (configTimer !== 0) clearInterval(configTimer)
      scanTimer = 0
      themeTimer = 0
      configTimer = 0
      for (const [node] of displays) disposeDisplay(node)
      // 放大展示是挂在 body 上的独立遮罩层，插件卸载时必须一起收掉
      closeLightbox()
      try {
        for (const note of document.querySelectorAll('.vk-error')) note.remove()
        for (const figure of document.querySelectorAll('.vk-figure')) figure.remove()
        scratch?.remove()
        scratch = null
        for (const host of document.querySelectorAll('[data-vk-state]')) {
          if (host.getAttribute('data-vk-hidden') === '1') host.style.removeProperty('display')
          host.removeAttribute('data-vk-hidden')
          delete host.dataset.vkSource
          delete host.dataset.vkState
          delete host.dataset.vkHash
          delete host.dataset.vkDisplayState
        }
      } catch (error) {
        log('teardown cleanup skipped', { message: String(error?.message ?? error) })
      }
      log('client half stopped', {})
    }

    /**
     * Mount the browser half.
     * @param ctx - the client runtime context.
     */
    function apply(ctx) {
      try {
        clientCtx = ctx ?? null
        // The settings page and the session probe are independent of the
        // conversation pipeline: they must come up even where the transcript has
        // nothing to render.
        registerCapabilitiesPanel(ctx)
        registerSessionProbe(ctx)
        if (typeof ctx?.effect === 'function') {
          // Owned by an effect, so a reloaded instance cannot leave the previous
          // instance's observers running.
          ctx.effect(
            () => {
              start()
              return () => stop()
            },
            'dsh-visual-kit: conversation diagrams',
          )
        } else {
          start()
        }
      } catch (error) {
        console.error('[dsh-visual-kit] client apply failed:', error)
      }
    }

    exports.name = 'dsh-visual-kit/client'
    exports.apply = apply
    // Exported for tests: the pure parts of this half, reachable without a DOM.
    exports.internals = {
      hash,
      readSource,
      resolveTheme,
      routeBlock,
      bannerLanguage,
      presentation,
      fitScale,
      MERMAID_HEAD,
      ADAPTERS,
      diag,
      // The settings page, reachable for tests without the slot system.
      CapabilityPanel,
      registerCapabilitiesPanel,
      // The self-repair path: an invisible session probe plus the delivery.
      SessionProbe,
      registerSessionProbe,
      repairRequest,
      Toggle,
      // 放大展示：遮罩层的挂载与关闭，可在无 DOM 交互的情况下单测
      openLightbox,
      closeLightbox,
      snapshotToSvg,
    }
    return module.exports
  },
})
