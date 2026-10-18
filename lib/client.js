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
    const CLIENT_REV = 'v0.18.0'
    const DISPLAY_TIMEOUT_MS = 15_000
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
            // 风格表由宿主下发：漏掉这一行，用户选的风格就永远到不了浏览器
            styles: Array.isArray(payload.styles) ? payload.styles : [],
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
        // 风格进签名：否则「只有风格变了」会被判成没变化，已有图不会重绘
        const next = `${value.rev ?? ''}:${(value.enabled ?? []).join(',')}:${value.settings?.style ?? ''}`
        const current = `${catalogueRev}:${diag.enabled.join(',')}`
        const behaviourChanged = value.settings !== undefined &&
          ((value.settings.autoRender !== false) !== (catalogue?.behavior?.autoRender !== false) ||
           (value.settings.selfRepair !== false) !== (catalogue?.behavior?.selfRepair !== false) ||
           (value.settings.repairInNewSession !== false) !== (catalogue?.behavior?.repairInNewSession !== false) ||
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
        // 渲染器声明的输入上限：适配器按它执行，而不是各自写死常量
        limits: spec.limits ?? {},
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
    // 默认风格的兜底色板：目录到达前先用它，到达后一切以目录下发的风格为准。
    // 与 lib/styles.js 的一致性由 test/styles.test.mjs 钉住，避免两份表漂移。
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

    /** 默认风格的兜底：目录里没有风格表时用它。 */
    const STYLE_FALLBACK = {
      id: 'motu',
      chrome: CHROME,
      surface: { light: '#FFFFFF', dark: '#1E1E1C' },
      paper: { light: '#F1EFE8', dark: '#2A2A28' },
      named: { blue: '#185FA5', red: '#A32D2D', green: '#3B6D11', amber: '#BA7517', purple: '#534AB7', teal: '#0F6E56' },
      shape: { hairline: 0.5, cardRadius: 8, panelRadius: 12, edgeWidth: 1.5, edge: 'open' },
    }

    /**
     * The style the user selected.
     *
     * The catalogue carries every style's tables, so the browser half never
     * keeps a second copy of them. An unknown id degrades to the default rather
     * than rendering with an empty palette.
     *
     * @returns {object} the style.
     */
    function activeStyle() {
      const list = catalogue?.styles
      if (!Array.isArray(list) || list.length === 0) return STYLE_FALLBACK
      const wanted = catalogue?.presentation?.style
      return list.find((style) => style.id === wanted) ?? list.find((style) => style.active === true) ?? list[0]
    }

    /** The chrome for the current theme, in the selected style. */
    function chrome() {
      const style = activeStyle()
      const table = style.chrome ?? STYLE_FALLBACK.chrome
      return resolveTheme() === 'dark' ? table.dark : table.light
    }

    /** The selected style's geometry vocabulary. */
    function styleShape() {
      return activeStyle().shape ?? STYLE_FALLBACK.shape
    }

    /** SVG namespace, spelled once. */
    const SVG_NS = 'http://www.w3.org/2000/svg'

    // ---------------------------------------------------------------------
    // Self-drawn renderer kit.
    //
    // Renderers that compute their own geometry — instead of loading a third
    // party engine — share this layer: theme tokens, XML escaping, the figure
    // skeleton, class-based styling, legends, callouts and the input ceilings.
    //
    // A new style supplies geometry only. Everything that is easy to get wrong
    // (escaping, theme, size, limits) lives here once, so adding a style stays a
    // purely additive change.
    // ---------------------------------------------------------------------

    /**
     * Escape text for XML.
     *
     * Every model-authored string that reaches the output goes through this: an
     * unescaped `&` or `<` makes the whole SVG unparseable, which shows up as a
     * broken image wherever SVG is read strictly (an exported file, a GitHub
     * `<img>`) while looking fine inside the app.
     *
     * @param {unknown} value - the text.
     * @returns {string} the escaped text.
     */
    function escapeXml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
    }

    /**
     * Semantic colour tokens for the current theme.
     *
     * Renderers name a meaning (`amber`, `muted`), never a literal, so light and
     * dark come out right without every style solving theming again.
     *
     * @returns {object} the tokens.
     */
    function themeTokens() {
      const c = chrome()
      const dark = resolveTheme() === 'dark'
      return {
        ink: c.title,
        secondary: c.nodeText,
        muted: c.canvasText,
        border: c.nodeBorder,
        grid: c.grid,
        // 画布底与次级面由风格决定：换风格时自绘图整体换底，而不是只换几个语义色
        surface: (activeStyle().surface ?? STYLE_FALLBACK.surface)[dark ? 'dark' : 'light'],
        paper: (activeStyle().paper ?? STYLE_FALLBACK.paper)[dark ? 'dark' : 'light'],
        // 语义令牌优先取风格显式声明的表；没有时才退回按位置读调色板
        named: activeStyle().named ?? {
          blue: c.palette[0],
          purple: c.palette[1],
          green: c.palette[2],
          amber: c.palette[3],
          red: c.palette[4],
          teal: c.palette[5],
        },
      }
    }

    /**
     * Resolve a colour: a semantic token or a literal `#rrggbb`.
     *
     * @param {string} name - the token or literal.
     * @param {object} [tokens] - resolved tokens (defaults to the current theme).
     * @returns {string} a colour usable in SVG.
     */
    function tokenColor(name, tokens = themeTokens()) {
      const value = String(name ?? '').trim()
      if (value === '') throw new Error('颜色不能为空')
      if (/^#[0-9a-f]{3,8}$/i.test(value)) return value
      if (value === 'ink' || value === 'secondary' || value === 'muted' || value === 'border' || value === 'surface' || value === 'paper') {
        return tokens[value]
      }
      const named = tokens.named[value]
      if (named === undefined) {
        throw new Error(`未知颜色：${value}（可用 ${['ink', 'secondary', 'muted', 'border', 'surface', 'paper', ...Object.keys(tokens.named)].join('/')}，或直接写 #rrggbb）`)
      }
      return named
    }

    /**
     * Lighten (positive) or darken (negative) a colour by a ratio.
     *
     * Accepts `#rrggbb` and `rgb(r,g,b)` so a face can be shaded after it was
     * already converted for output.
     *
     * @param {string} color - the base colour.
     * @param {number} amount - the ratio, e.g. `-0.3`.
     * @returns {string} an `rgb()` colour.
     */
    function shadeColor(color, amount) {
      const text = String(color)
      let rgb
      if (text.startsWith('#')) {
        const n = parseInt(text.slice(1), 16)
        rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      } else {
        const match = text.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
        rgb = match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0]
      }
      return `rgb(${rgb.map((channel) => Math.max(0, Math.min(255, Math.round(channel * (1 + amount))))).join(',')})`
    }

    /**
     * Input ceilings shared by self-drawn renderers.
     *
     * A renderer overrides any of them through `limits` in the manifest. The
     * point is that an oversized input fails with something actionable instead of
     * freezing the tab.
     */
    const DEFAULT_LIMITS = { bytes: 64 * 1024, faces: 6000, grid: 32 }

    /**
     * Enforce input ceilings, naming the way out.
     *
     * @param {object} [limits] - the renderer's overrides.
     * @param {Record<string, number>} values - the measured values.
     */
    function enforceLimits(limits, values, hints = {}) {
      const merged = { ...DEFAULT_LIMITS, ...(limits ?? {}) }
      const labels = { bytes: '产物体积', faces: '面数', grid: '体素网格边长', points: '数据点' }
      const advice = { bytes: '精简源码', faces: '减少细分（segments / rings）或缩小规模', grid: '调小 grid', points: '聚合或分段', ...hints }
      // 大体积按 KiB、大整数按千分位：模型和人都更容易判断"是不是真的超了"
      const shown = (key, value) => {
        if (key === 'bytes' && value >= 1024) return `${Math.round(value / 1024)} KiB`
        const rounded = Math.round(value * 100) / 100
        return Number.isInteger(rounded) ? String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : String(rounded)
      }
      for (const [key, value] of Object.entries(values)) {
        const max = merged[key]
        if (max === undefined || value === undefined || !Number.isFinite(value)) continue
        if (value > max) {
          throw new Error(`${labels[key] ?? key}超过上限 ${shown(key, max)}（当前 ${shown(key, value)}），请${advice[key] ?? '减少输入'}`)
        }
      }
    }

    /**
     * Assemble the figure skeleton: root, accessibility text, style block, body.
     *
     * @param {object} options - the parts.
     * @returns {string} the SVG document.
     */
    function svgDocument(options) {
      const { width, height, title, desc, body, classes = [], fontFamily = '', limits } = options
      enforceLimits(limits, { bytes: body.length })
      // 类名必须每张图唯一：内联 SVG 的 <style> 是**文档级**的，两张自绘图都用 .c0 时，
      // 后一张的规则会覆盖前一张 —— 实测两张颜色不同的等距图会渲染成同一个颜色
      // （谁最后画谁说了算）。前缀取自内容哈希：同样的输入仍是同样的字节，确定性不受影响。
      const uid = `f${hash(`${width}x${height}x${body}x${classes.map(([name, rules]) => `${name}:${rules}`).join('|')}`)}`
      const scoped = classes.map(([name, rules]) => [`${uid}-${name}`, rules])
      let drawn = body
      if (scoped.length > 0) {
        drawn = body.replace(/class="(c\d+)"/g, (all, name) => `class="${uid}-${name}"`)
      }
      const style = scoped.length > 0
        ? `<style>${scoped.map(([name, rules]) => `.${name}{${rules}}`).join('')}</style>\n`
        : ''
      const font = fontFamily === '' ? '' : ` font-family="${escapeXml(xmlSafeFontFamily(fontFamily))}"`
      return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" xmlns="${SVG_NS}"${font}>\n` +
        `<title>${escapeXml(title)}</title>\n<desc>${escapeXml(desc)}</desc>\n${style}` +
        `${drawn}\n</svg>`
    }

    /**
     * One path through a list of points.
     *
     * @param {Array<[number, number]>} points - the points.
     * @param {string} className - the style class.
     * @returns {string} the path element.
     */
    function svgPath(points, className) {
      const d = `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}Z`
      return `<path class="${className}" d="${d}"/>`
    }

    /**
     * A legend row.
     *
     * @param {Array<{color: string, text: string}>} items - swatch and label.
     * @param {{x: number, y: number, gap: number}} options - placement.
     * @returns {string} the legend group.
     */
    function svgLegend(items, options) {
      const { x, y, gap = 128 } = options
      const tokens = themeTokens()
      return items.map((item, index) => {
        const left = x + index * gap
        const fill = tokenColor(item.color, tokens)
        return `<g><rect x="${left}" y="${y}" width="10" height="10" rx="2" fill="${fill}" stroke="${shadeColor(fill, -0.3)}" stroke-width="0.5"/>` +
          `<text x="${left + 16}" y="${y + 9}" font-size="11" fill="${tokens.muted}">${escapeXml(item.text)}</text></g>`
      }).join('')
    }

    /**
     * A numbered callout: a dot on the subject, a leader line, a label.
     *
     * @param {object} options - `at` (screen point), `text`, `index`, `side`, `x`, `y`.
     * @returns {string} the callout group.
     */
    function svgCallout(options) {
      const { at, text, index, side = 'right', x, y } = options
      const tokens = themeTokens()
      const anchorX = side === 'left' ? x + 96 : x
      const edge = side === 'left' ? x + 96 : x
      return `<path d="M${at[0].toFixed(1)} ${at[1].toFixed(1)}L${edge.toFixed(1)} ${(y + 4).toFixed(1)}" fill="none" stroke="${tokens.border}" stroke-width="0.75"/>` +
        `<circle cx="${at[0].toFixed(1)}" cy="${at[1].toFixed(1)}" r="2.4" fill="${tokens.surface}" stroke="${tokens.secondary}" stroke-width="0.75"/>` +
        `<text x="${anchorX.toFixed(1)}" y="${(y + 8).toFixed(1)}" font-size="11" fill="${tokens.secondary}">${escapeXml(`${index} ${text}`)}</text>`
    }

    // ---------------------------------------------------------------------
    // Isometric base.
    //
    // Everything the isometric family shares: the 2:1 projection, the painter
    // ordering, the section cut, voxel surface extraction and the three-face
    // shading. A style registers a geometry builder and gets all of it.
    // ---------------------------------------------------------------------

    /** Half-width per unit of (x − y); the vertical steps are half of that. */
    const ISO_HW = 1
    const ISO_HH = 0.5
    const ISO_HV = 1

    /**
     * Project a world point to the canvas.
     *
     * @param {number[]} point - `[x, y, z]`.
     * @param {{scale: number, ox: number, oy: number, yaw?: number}} view - the view.
     * @returns {[number, number]} the screen point.
     */
    function isoProject(point, view) {
      const yaw = view.yaw ?? 0
      const cos = Math.cos(yaw)
      const sin = Math.sin(yaw)
      const x = point[0] * cos - point[1] * sin
      const y = point[0] * sin + point[1] * cos
      return [view.ox + (x - y) * ISO_HW * view.scale, view.oy + ((x + y) * ISO_HH - point[2] * ISO_HV) * view.scale]
    }

    /** Painter key: larger z is nearer, and within a layer larger (x + y) is nearer. */
    function isoDepth(face) {
      let z = 0
      let xy = 0
      for (const point of face.v) {
        z += point[2]
        xy += point[0] + point[1]
      }
      return (z / face.v.length) * 1000 + xy / face.v.length
    }

    /**
     * Order faces far to near, and drop the ones a section cut removes.
     *
     * The cut is a fixed plane in the model's own space — a cutaway model, not a
     * camera-facing slice — so the exported mesh and the rendered figure agree
     * and rotating never changes which part is missing.
     *
     * @param {object[]} faces - the faces.
     * @param {number|null} cutAt - remove faces whose centroid `x + y` exceeds this.
     * @returns {object[]} the ordered faces.
     */
    function isoOrderFaces(faces, cutAt) {
      const kept = cutAt === null || cutAt === undefined
        ? faces
        : faces.filter((face) => {
            let sum = 0
            for (const point of face.v) sum += point[0] + point[1]
            return sum / face.v.length <= cutAt
          })
      return kept.map((face) => ({ face, depth: isoDepth(face) })).sort((a, b) => a.depth - b.depth).map((item) => item.face)
    }

    /**
     * A directional light, so a solid's faces separate by orientation.
     *
     * @param {number[]} normal - the face normal.
     * @returns {number} a shade ratio.
     */
    function isoLight(normal) {
      const lit = Math.max(0, normal[0] * -0.35 + normal[1] * 0.55 + normal[2] * 0.76)
      // 范围要克制：物理正确的暗面会把琥珀压成近黑，缩略图里直接读成一团黑，
      // 结构就看不见了。宁可少一点立体感，也要每一面都能看清颜色。
      return Math.max(-0.16, Math.min(0.2, (lit - 0.55) * 0.34))
    }

    /** The face normal of a polygon. */
    function isoNormal(points) {
      const [a, b, c] = points
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      const length = Math.hypot(n[0], n[1], n[2]) || 1
      return [n[0] / length, n[1] / length, n[2] / length]
    }

    /**
     * Turn faces into class-styled paths.
     *
     * Colours are emitted as classes rather than per-path attributes: a scene
     * with a thousand faces shares a few dozen classes, which is what keeps the
     * output small enough to paste into a conversation.
     *
     * @param {object[]} faces - the ordered faces.
     * @param {object} view - the projection view.
     * @returns {{body: string, classes: Array<[string, string]>}} the drawing.
     */
    function isoDraw(faces, view) {
      const byRules = new Map()
      const order = []
      const parts = []
      for (const face of faces) {
        const base = face.color
        const raw = face.flat === true ? (face.shade ?? 0) : isoLight(isoNormal(face.v)) + (face.shade ?? 0)
        // Quantise the shade: continuous lighting would otherwise give every face
        // its own class, and the output size is the whole point of classing.
        const amount = Math.round(raw * 24) / 24
        const rules = `fill:${shadeColor(base, amount)};stroke:${shadeColor(base, amount - 0.25)};stroke-width:${styleShape().hairline}`
        let name = byRules.get(rules)
        if (name === undefined) {
          name = `c${order.length}`
          byRules.set(rules, name)
          order.push([name, rules])
        }
        parts.push(svgPath(face.v.map((point) => isoProject(point, view)), name))
      }
      return { body: parts.join(''), classes: order }
    }

    /**
     * Extract the drawable faces of a voxel grid.
     *
     * Only the three faces that can be seen are emitted, and a voxel with all
     * three neighbours filled emits nothing — so the interior of a solid shape
     * costs no output at all.
     *
     * @param {Uint8Array} grid - occupancy, `size³`.
     * @param {object} options - `size`, `center`, `shades`, `colors`.
     * @returns {object[]} the faces.
     */
    function isoVoxelFaces(grid, options) {
      // 三面明度：顶面不压、侧面各压一档。原来侧面压到 ×0.46，
      // 密集体素图里大部分看到的是侧面，整片会读成黑色 —— 收到 ×0.56 仍能分辨朝向。
      const { size, center, colors, shades = [0, -0.24, -0.44], jitter = 0.0157 } = options
      const index = (x, y, z) => (z * size + y) * size + x
      const faces = []
      for (let z = 0; z < size; z++) {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const type = grid[index(x, y, z)]
            if (type === 0) continue
            const up = z + 1 < size ? grid[index(x, y, z + 1)] : 0
            const px = x + 1 < size ? grid[index(x + 1, y, z)] : 0
            const py = y + 1 < size ? grid[index(x, y + 1, z)] : 0
            if (up !== 0 && px !== 0 && py !== 0) continue
            const color = colors[type]
            if (color === undefined) continue
            const wobble = 1 + ((hash32(x, y, z) % 8) - 3.5) * jitter
            const X = x - center
            const Y = y - center
            const Z = z - center
            if (up === 0) {
              faces.push({ flat: true, shade: shades[0] + (wobble - 1), color, v: [[X, Y, Z + 1], [X + 1, Y, Z + 1], [X + 1, Y + 1, Z + 1], [X, Y + 1, Z + 1]] })
            }
            if (px === 0) {
              faces.push({ flat: true, shade: shades[1] + (wobble - 1), color, v: [[X + 1, Y, Z], [X + 1, Y + 1, Z], [X + 1, Y + 1, Z + 1], [X + 1, Y, Z + 1]] })
            }
            if (py === 0) {
              faces.push({ flat: true, shade: shades[2] + (wobble - 1), color, v: [[X, Y + 1, Z], [X + 1, Y + 1, Z], [X + 1, Y + 1, Z + 1], [X, Y + 1, Z + 1]] })
            }
          }
        }
      }
      return faces
    }

    /** A deterministic 32-bit hash — the per-voxel brightness wobble must not change between renders. */
    function hash32(x, y, z) {
      let h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791)
      h = (h ^ (h >>> 13)) >>> 0
      return h
    }

    /**
     * The registry of isometric styles.
     *
     * A new isometric style registers a geometry builder here and adds one
     * manifest entry; the adapter, projection, cut, ordering, theming and limits
     * are already in place. Builders must be deterministic — the figure is
     * re-rendered on theme changes and compared, so `Math.random()` would make
     * the picture twitch.
     *
     * @type {Map<string, (spec: object, env: object) => {faces: object[], legend?: object[], callouts?: object[], cutAt?: number|null}>}
     */
    const ISO_KINDS = new Map()

    /**
     * Register one isometric style.
     *
     * @param {string} kind - the spec's `kind`.
     * @param {Function} build - `(spec, env) => {faces, legend, callouts, cutAt}`.
     */
    function registerIsoKind(kind, build) {
      ISO_KINDS.set(kind, build)
    }

    // ---------------------------------------------------------------------
    // isometric — the first consumer of the kit above.
    //
    // Two kinds share one pipeline: `solid` builds primitives (a cutaway model
    // in a display case), `voxel` builds a block model from shapes or ASCII
    // layers. Both hand their faces to the same projection, cut, ordering,
    // legend, callout and framing code.
    // ---------------------------------------------------------------------

    /** 进入对话的 spec 上限（产物另有 limits.bytes）。 */
    const ISO_SPEC_BYTES = 64 * 1024

    /** Default canvas for an isometric figure. */
    const ISO_CANVAS = { width: 680, height: 430 }

    /**
     * Frame a scene: pick the scale and offset that fit every face.
     *
     * Model-authored coordinates are unbounded, so the engine decides the
     * framing instead of asking the model to guess a scale. This is the step
     * that keeps a scene inside its canvas.
     *
     * @param {object[]} faces - the faces.
     * @param {object} view - `{yaw}`.
     * @param {number} width - canvas width.
     * @param {number} height - canvas height.
     * @param {number} [padding] - margin in pixels.
     * @returns {object} the view with `scale`, `ox`, `oy`.
     */
    function isoFit(faces, view, width, height, padding = 30, extraPoints = []) {
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      const flat = { ...view, scale: 1, ox: 0, oy: 0 }
      // 展示柜的角点也要算进来：柜子通常比物体大，只按物体取景会把它画到画布外
      for (const point of [...faces.flatMap((face) => face.v), ...extraPoints]) {
        const [x, y] = isoProject(point, flat)
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      if (!Number.isFinite(minX)) return { ...view, scale: 40, ox: width / 2, oy: height / 2 }
      const spanX = Math.max(1e-6, maxX - minX)
      const spanY = Math.max(1e-6, maxY - minY)
      const scale = Math.min((width - 2 * padding) / spanX, (height - 2 * padding) / spanY)
      return {
        ...view,
        scale,
        ox: padding - minX * scale + (width - 2 * padding - spanX * scale) / 2,
        oy: padding - minY * scale + (height - 2 * padding - spanY * scale) / 2,
      }
    }

    /** Read a required number from the spec, naming the field when it is wrong. */
    function isoNumber(value, field, fallback) {
      if (value === undefined || value === null) {
        if (fallback !== undefined) return fallback
        throw new Error(`缺少 ${field}`)
      }
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(`${field} 必须是数字，当前是 ${JSON.stringify(value)}`)
      return number
    }

    /** Read a `[x, y, z]` triple. */
    function isoPoint(value, field, fallback = [0, 0, 0]) {
      if (value === undefined || value === null) return fallback
      if (!Array.isArray(value) || value.length !== 3) throw new Error(`${field} 必须是 [x, y, z] 三个数字`)
      return value.map((item, index) => isoNumber(item, `${field}[${index}]`))
    }

    // ---------------------------------------------------------------------
    // ---------------------------------------------------------------------
    // 画布预算
    // ---------------------------------------------------------------------
    //
    // 客户端的画布有 maxHeight（默认 360）与内边距（默认 16），超高的图会被**整体
    // 缩小** —— 一屏 7 行的矩阵自然高 420，被压到 78%，字变小、图变窄，旁边一张
    // 原尺寸的卡一对比就显得奇怪。
    //
    // 渲染器自己知道这个预算，所以应当在预算内排版，而不是等着被缩放。

    /** 画布可用于作图的像素高度。 */
    function canvasBudget(env) {
      const max = Number(env.presentation?.canvasMaxHeight) > 0 ? Number(env.presentation.canvasMaxHeight) : 360
      const pad = Number(env.presentation?.canvasPadding) >= 0 ? Number(env.presentation.canvasPadding) : 16
      return Math.max(160, max - 2 * pad)
    }

    /**
     * 在预算内挑选行的自然尺寸。
     *
     * @param {object} env - the render environment.
     * @param {object} options - fixed: 除行以外的固定高度；count: 行数；natural: 理想行高；floor: 可读下限。
     * @returns {number} the row size to use.
     */
    function fitRowSize(env, { fixed, count, natural, floor }) {
      if (count <= 0) return natural
      const per = (canvasBudget(env) - fixed) / count
      return Math.max(floor, Math.min(natural, Math.floor(per)))
    }

    // metrics — 指标卡
    // ---------------------------------------------------------------------
    //
    // 这不是图表，是**读数**：一排大数字，带阈值色、可选的一行变化说明，和一条
    // 迷你趋势线。markdown 顶替不了它（表格放不进阈值色，也画不出趋势），所以它是
    // 图之外真正缺的一块：数据型可视。
    //
    // 布局只做两件事：等宽铺开、超过一行就换行。没有力导向、没有自适应坐标轴 ——
    // 一屏读数要的不是聪明，而是对齐。

    /** 语义色到读数的映射：ok 绿、warn 琥珀、bad 红、idle 取次要色。 */
    const METRIC_TONES = { ok: 'green', warn: 'amber', bad: 'red', idle: 'muted' }

    /**
     * Parse and validate a metrics spec.
     *
     * @param {string} source - the fence source.
     * @returns {{spec: object, items: object[], spark: number[]|null}} the parsed spec.
     */
    function metricsSpecOf(source) {
      const spec = parseJson(source, '指标卡 spec')
      if (!Array.isArray(spec.items) || spec.items.length === 0) {
        throw new Error('items 必须是非空数组（至少一个读数）')
      }
      const items = spec.items.map((item, index) => {
        const where = `items[${index}]`
        if (item === null || typeof item !== 'object') throw new Error(`${where} 必须是对象`)
        const label = String(item.label ?? '').trim()
        if (label === '') throw new Error(`${where}.label 不能为空`)
        const value = String(item.value ?? '').trim()
        if (value === '') throw new Error(`${where}.value 不能为空`)
        const tone = item.tone === undefined ? 'idle' : String(item.tone)
        if (METRIC_TONES[tone] === undefined) {
          throw new Error(`${where}.tone 未知：${JSON.stringify(item.tone)}（可用 ${Object.keys(METRIC_TONES).join(' / ')}）`)
        }
        return {
          label,
          value,
          unit: item.unit === undefined ? '' : String(item.unit),
          delta: item.delta === undefined ? '' : String(item.delta),
          tone,
        }
      })
      let spark = null
      if (spec.spark !== undefined && spec.spark !== null) {
        if (!Array.isArray(spec.spark) || spec.spark.length < 2) {
          throw new Error('spark 至少要有两个数字，才画得出趋势')
        }
        spark = spec.spark.map((value, index) => isoNumber(value, `spark[${index}]`))
      }
      return { spec, items, spark }
    }

    /** 估算一段文字的宽度：CJK 按 1em、其余按 0.55em —— 只用于把单位摆在数字右边。 */
    function metricsTextWidth(text, size) {
      let width = 0
      for (const character of String(text)) {
        width += /[\u2e80-\u9fff\uff00-\uffef]/.test(character) ? size : size * 0.55
      }
      return width
    }

    /**
     * Draw the card.
     *
     * @param {object} parsed - from `metricsSpecOf`.
     * @param {object} env - the render environment.
     * @returns {{markup: string}} the figure.
     */
    function metricsFigure(parsed, env) {
      const { spec, items, spark } = parsed
      const tokens = themeTokens()
      const limits = spec.limits ?? env.limits
      enforceLimits(limits, { points: items.length }, { points: '把读数合并成更少的项' })
      const width = 680
      const columns = Math.min(items.length, 4)
      const rows = Math.ceil(items.length / columns)
      const gap = 12
      const pad = 24
      const tileWidth = (width - pad * 2 - gap * (columns - 1)) / columns
      const hasTitle = typeof spec.title === 'string' && spec.title.trim() !== ''
      const sparkHeight = spark === null ? 0 : 52
      // 瓦片高度跟着画布预算走；内部三条文字的基线按高度比例，不写死
      const tileHeight = fitRowSize(env, { fixed: pad * 2 + (hasTitle ? 30 : 0) + (sparkHeight > 0 ? sparkHeight + gap : 0), count: rows, natural: 80, floor: 52 })
      const top = pad + (hasTitle ? 30 : 0)
      const height = Math.round(top + rows * tileHeight + (rows - 1) * gap + (sparkHeight > 0 ? sparkHeight + gap : 0) + pad)
      const parts = []
      if (hasTitle) {
        parts.push(`<text x="${pad}" y="${pad + 14}" font-size="14" font-weight="600" fill="${escapeXml(tokens.ink)}">${escapeXml(spec.title.trim())}</text>`)
      }
      const toneColor = (tone) => tokenColor(METRIC_TONES[tone], tokens)
      items.forEach((item, index) => {
        const column = index % columns
        const row = Math.floor(index / columns)
        const x = pad + column * (tileWidth + gap)
        const y = top + row * (tileHeight + gap)
        const tone = toneColor(item.tone)
        // 三条文字的基线按瓦片高度比例走：瓦片会被预算压矮，写死基线就会挤在一起
        const labelY = y + Math.round(tileHeight * 0.35)
        const valueY = y + Math.round(tileHeight * 0.7)
        const deltaY = y + Math.round(tileHeight * 0.93)
        // 卡片本体 + 顶部阈值条：颜色只出现在这条 3px 上，不铺满整块
        parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${tileWidth.toFixed(1)}" height="${tileHeight}" rx="8" fill="${escapeXml(tokens.surface)}" stroke="${escapeXml(tokens.border)}" stroke-width="0.5"/>`)
        parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${tileWidth.toFixed(1)}" height="3" rx="1.5" fill="${escapeXml(tone)}"/>`)
        parts.push(`<text x="${(x + 14).toFixed(1)}" y="${labelY.toFixed(1)}" font-size="11.5" fill="${escapeXml(tokens.muted)}">${escapeXml(item.label)}</text>`)
        // 数值与单位：单位跟在数字右边，按估算宽度摆放，不参与布局
        const valueSize = 22
        parts.push(`<text x="${(x + 14).toFixed(1)}" y="${valueY.toFixed(1)}" font-size="${valueSize}" font-weight="600" fill="${escapeXml(item.tone === 'idle' ? tokens.ink : tone)}">${escapeXml(item.value)}</text>`)
        if (item.unit !== '') {
          const offset = 14 + metricsTextWidth(item.value, valueSize) + 4
          parts.push(`<text x="${(x + offset).toFixed(1)}" y="${valueY.toFixed(1)}" font-size="11.5" fill="${escapeXml(tokens.muted)}">${escapeXml(item.unit)}</text>`)
        }
        if (item.delta !== '') {
          parts.push(`<text x="${(x + 14).toFixed(1)}" y="${deltaY.toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}">${escapeXml(item.delta)}</text>`)
        }
      })
      if (spark !== null) {
        const top2 = top + rows * tileHeight + (rows - 1) * gap + gap
        const innerWidth = width - pad * 2
        const min = Math.min(...spark)
        const max = Math.max(...spark)
        const span = max - min === 0 ? 1 : max - min
        const points = spark.map((value, index) => {
          const x = pad + (innerWidth * index) / (spark.length - 1)
          const y = top2 + sparkHeight - 8 - ((value - min) / span) * (sparkHeight - 16)
          return [x, y]
        })
        parts.push(`<path class="mt-spark" d="M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join('L')}" fill="none" stroke="${escapeXml(tokens.border)}" stroke-width="1.5" stroke-linecap="round"/>`)
        const [lastX, lastY] = points[points.length - 1]
        parts.push(`<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="2.5" fill="${escapeXml(tokenColor('blue', tokens))}"/>`)
        parts.push(`<text x="${pad}" y="${(top2 + sparkHeight).toFixed(0)}" font-size="10.5" fill="${escapeXml(tokens.muted)}">趋势：${escapeXml(String(spark[0]))} → ${escapeXml(String(spark[spark.length - 1]))}</text>`)
      }
      return {
        markup: svgDocument({
          width,
          height,
          title: hasTitle ? spec.title.trim() : '指标卡',
          desc: String(spec.desc ?? `一排读数：${items.map((item) => `${item.label} ${item.value}${item.unit}`).join('、')}`),
          body: parts.join('\n'),
          fontFamily: env.presentation?.fontFamily ?? '',
          limits,
        }),
      }
    }

    // ---------------------------------------------------------------------
    // matrix — 用例矩阵
    // ---------------------------------------------------------------------
    //
    // 一条用例一行，状态上色，**卡底自动汇总**。汇总行是它真正的价值：一排跑完的
    // 结果里，人先看的是"几个通过几个失败"，而不是逐行读 —— 所以别让模型自己算，
    // 算错一次这张表就废了。
    //
    // 与指标卡同一类：markdown 顶替不了（表格上不了状态色，也生不出汇总）。

    /** 状态 → 字形与语义色。写错的状态直接报错，不静默当 skip。 */
    /** 行高可读下限；触到它就该换列，而不是继续压缩。 */
    const ROW_FLOOR = 30

    /** 状态 → 字形、语义色与胶囊文字。胶囊里带文字：字形要记，文字不用。 */
    const MATRIX_STATUS = {
      pass: { glyph: '✓', tone: 'green', label: '通过' },
      fail: { glyph: '✗', tone: 'red', label: '失败' },
      warn: { glyph: '!', tone: 'amber', label: '警告' },
      skip: { glyph: '○', tone: 'muted', label: '跳过' },
      running: { glyph: '●', tone: 'blue', label: '进行中' },
    }

    /**
     * Parse and validate a case-matrix spec.
     *
     * @param {string} source - the fence source.
     * @returns {{spec: object, cases: object[], summary: string}} the parsed spec.
     */
    function matrixSpecOf(source) {
      const spec = parseJson(source, '用例矩阵 spec')
      if (!Array.isArray(spec.cases) || spec.cases.length === 0) {
        throw new Error('cases 必须是非空数组（至少一条用例）')
      }
      const cases = spec.cases.map((item, index) => {
        const where = `cases[${index}]`
        if (item === null || typeof item !== 'object') throw new Error(`${where} 必须是对象`)
        const name = String(item.name ?? '').trim()
        if (name === '') throw new Error(`${where}.name 不能为空`)
        const status = item.status === undefined ? 'skip' : String(item.status)
        if (MATRIX_STATUS[status] === undefined) {
          throw new Error(`${where}.status 未知：${JSON.stringify(item.status)}（可用 ${Object.keys(MATRIX_STATUS).join(' / ')}）`)
        }
        let ms = null
        if (item.ms !== undefined && item.ms !== null) {
          const value = Number(item.ms)
          if (!Number.isFinite(value) || value < 0) throw new Error(`${where}.ms 必须是非负数字或 null`)
          ms = value
        }
        return { name, status, ms, note: item.note === undefined || item.note === null ? '' : String(item.note) }
      })
      // 汇总在这里算，不让模型算：它算错一次这张表就废了
      const counts = Object.keys(MATRIX_STATUS).map((status) => ({
        status,
        count: cases.filter((item) => item.status === status).length,
      })).filter((entry) => entry.count > 0)
      const summary = `${cases.length} 项 · ${counts.map((entry) => `${entry.count} ${MATRIX_STATUS[entry.status].label}`).join(' / ')}`
      return { spec, cases, counts, summary }
    }

    /**
     * Draw the matrix.
     *
     * @param {object} parsed - from `matrixSpecOf`.
     * @param {object} env - the render environment.
     * @returns {{markup: string}} the figure.
     */
    function matrixFigure(parsed, env) {
      const { spec, cases, counts, summary } = parsed
      const tokens = themeTokens()
      const limits = spec.limits ?? env.limits
      enforceLimits(limits, { points: cases.length }, { points: '把用例合并成更少的行' })
      const width = 680
      const pad = 24
      const hasTitle = typeof spec.title === 'string' && spec.title.trim() !== ''
      const withNote = cases.some((item) => item.note !== '')
      const top = pad + (hasTitle ? 30 : 0)
      const summaryHeight = 34
      // 表头高度要先进"固定高度"：它影响列数与行高，不能等布局算完再加
      const headerHeight = 22
      const fixedHeight = pad * 2 + (hasTitle ? 30 : 0) + headerHeight + summaryHeight
      // 画布预算是硬的：一屏 7 行自然高 420，会被客户端整体缩到 78%，字变小看着就怪。
      // 所以先按预算取行高；一列装不下（行高触到可读下限）就换两列，行数直接减半，
      // 而不是让整张图被缩放。换行顺序按列优先，跟清单一样从上往下读。
      // 选第一个装得下的列数：仍是"渲染器自己适配预算"，而不是交给客户端缩放
      let columnCount = 3
      for (const candidate of [1, 2, 3]) {
        const rowsFor = Math.ceil(cases.length / candidate)
        if (fixedHeight + rowsFor * ROW_FLOOR <= canvasBudget(env)) { columnCount = candidate; break }
      }
      const rowCount = Math.ceil(cases.length / columnCount)
      const columnGap = 20
      const columnWidth = (width - pad * 2 - (columnCount - 1) * columnGap) / columnCount
      const lineHeight = fitRowSize(env, {
        fixed: fixedHeight,
        count: rowCount,
        natural: withNote ? 44 : 34,
        floor: ROW_FLOOR,
      })
      const inlineNote = withNote && (lineHeight < 40 || columnCount > 1)
      // 单列时按真表格排：带表头、状态独立成列。多列是紧凑清单，塞不下表头。
      const tableMode = columnCount === 1
      const showHeader = tableMode && lineHeight >= 30
      // 表格模式给固定列宽：按百分比算会让"耗时"和"备注"贴在一起（实测 820 ms 与备注
      // 连成了一个字符串）。632 的可排版宽度分给 状态 70 / 用例 300 / 耗时 80 / 备注 182。
      const pillWidth = 62
      const statusX = pad
      const nameX = pad + 82
      const timeRight = pad + 450
      const noteX = pad + 462
      const noteRoom = width - pad - noteX
      const height = Math.round(top + headerHeight + rowCount * lineHeight + summaryHeight + pad)
      const parts = []
      if (hasTitle) {
        parts.push(`<text x="${pad}" y="${pad + 14}" font-size="14" font-weight="600" fill="${escapeXml(tokens.ink)}">${escapeXml(spec.title.trim())}</text>`)
      }
      if (showHeader) {
        const headY = top + 14
        parts.push(`<text x="${statusX.toFixed(1)}" y="${headY.toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}">状态</text>`)
        parts.push(`<text x="${nameX.toFixed(1)}" y="${headY.toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}">用例</text>`)
        parts.push(`<text x="${timeRight.toFixed(1)}" y="${headY.toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}" text-anchor="end">耗时</text>`)
        parts.push(`<text x="${noteX.toFixed(1)}" y="${headY.toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}">备注</text>`)
        parts.push(`<line x1="${pad}" y1="${(top + headerHeight - 8).toFixed(1)}" x2="${width - pad}" y2="${(top + headerHeight - 8).toFixed(1)}" stroke="${escapeXml(tokens.border)}" stroke-width="0.5"/>`)
      }
      cases.forEach((item, index) => {
        const meta = MATRIX_STATUS[item.status]
        const tone = tokenColor(meta.tone, tokens)
        const column = index % columnCount
        const rowIndex = Math.floor(index / columnCount)
        const x0 = pad + column * (columnWidth + columnGap)
        const y = top + headerHeight + rowIndex * lineHeight
        // 行分隔用发丝线：状态色已经够醒目，不要再给每行加框（两列时只在列内画）
        if (rowIndex > 0) {
          const lineX0 = tableMode ? pad : x0
          const lineX1 = tableMode ? width - pad : x0 + columnWidth
          parts.push(`<line x1="${lineX0.toFixed(1)}" y1="${(y - 6).toFixed(1)}" x2="${lineX1.toFixed(1)}" y2="${(y - 6).toFixed(1)}" stroke="${escapeXml(tokens.border)}" stroke-width="0.5"/>`)
        }
        if (tableMode) {
          // 胶囊：淡底 + 字形 + 文字。字形要记含义，文字不用。
          const pillY = y + 1
          parts.push(`<rect x="${statusX.toFixed(1)}" y="${pillY.toFixed(1)}" width="${pillWidth}" height="20" rx="10" fill="${escapeXml(tone)}" opacity="0.12"/>`)
          parts.push(`<text x="${(statusX + pillWidth / 2).toFixed(1)}" y="${(pillY + 14).toFixed(1)}" font-size="11" font-weight="600" fill="${escapeXml(tone)}" text-anchor="middle">${escapeXml(meta.glyph)} ${escapeXml(meta.label)}</text>`)
        } else {
          parts.push(`<circle cx="${(x0 + 9).toFixed(1)}" cy="${(y + 10).toFixed(1)}" r="9" fill="${escapeXml(tone)}" opacity="0.14"/>`)
          parts.push(`<text x="${(x0 + 9).toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="11" font-weight="600" fill="${escapeXml(tone)}" text-anchor="middle">${escapeXml(meta.glyph)}</text>`)
        }
        let name = item.name
        if (tableMode) { const room = timeRight - nameX - 70; while (name.length > 1 && metricsTextWidth(name, 12.5) > room) name = name.slice(0, -1); if (name !== item.name) name = name.slice(0, Math.max(1, name.length - 1)) + '…' }
        parts.push(`<text x="${(tableMode ? nameX : x0 + 28).toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="12.5" fill="${escapeXml(tokens.ink)}">${escapeXml(name)}</text>`)
        // 耗时右对齐：一列数字对齐了才扫得动
        const msText = item.ms === null ? '—' : `${item.ms} ms`
        parts.push(`<text x="${(tableMode ? timeRight : x0 + columnWidth).toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="11.5" fill="${escapeXml(tokens.muted)}" text-anchor="end">${escapeXml(msText)}</text>`)
        if (item.note !== '') {
          if (tableMode) {
            // 备注独占一列，按列宽截断
            const room = noteRoom
            let note = item.note
            while (note.length > 1 && metricsTextWidth(note, 11) > room) note = note.slice(0, -1)
            if (note !== item.note) note = note.slice(0, Math.max(1, note.length - 1)) + '…'
            parts.push(`<text x="${noteX.toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}">${escapeXml(note)}</text>`)
          } else if (inlineNote) {
            // 同行：名称之后、耗时之前，放不下就截断（宁可截断也不让整张图被缩放）
            const nameEnd = x0 + 28 + metricsTextWidth(item.name, 12.5) + 12
            const room = x0 + columnWidth - metricsTextWidth(msText, 11.5) - 16 - nameEnd
            let note = item.note
            while (note.length > 1 && metricsTextWidth(note, 11) > room) note = note.slice(0, -1)
            if (note !== item.note) note = note.slice(0, Math.max(1, note.length - 1)) + '…'
            if (room > 24) {
              parts.push(`<text x="${nameEnd.toFixed(1)}" y="${(y + 14).toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}">${escapeXml(note)}</text>`)
            }
          } else {
            parts.push(`<text x="${(x0 + 28).toFixed(1)}" y="${(y + lineHeight - 14).toFixed(1)}" font-size="11" fill="${escapeXml(tokens.muted)}">${escapeXml(item.note)}</text>`)
          }
        }
      })
      // 汇总行：每种状态各一段，颜色跟着状态走
      const summaryY = top + headerHeight + rowCount * lineHeight + 18
      parts.push(`<line x1="${pad}" y1="${(summaryY - 16).toFixed(1)}" x2="${width - pad}" y2="${(summaryY - 16).toFixed(1)}" stroke="${escapeXml(tokens.border)}" stroke-width="0.5"/>`)
      parts.push(`<text x="${pad}" y="${summaryY.toFixed(1)}" font-size="11.5" font-weight="600" fill="${escapeXml(tokens.ink)}">${escapeXml(String(cases.length))} 项</text>`)
      let cursor = pad + metricsTextWidth(`${cases.length} 项`, 11.5) + 10
      parts.push(`<text x="${cursor.toFixed(1)}" y="${summaryY.toFixed(1)}" font-size="11.5" fill="${escapeXml(tokens.muted)}">·</text>`)
      cursor += 12
      counts.forEach((entry, index) => {
        const meta = MATRIX_STATUS[entry.status]
        const text = `${entry.count} ${meta.label}`
        if (index > 0) {
          parts.push(`<text x="${cursor.toFixed(1)}" y="${summaryY.toFixed(1)}" font-size="11.5" fill="${escapeXml(tokens.muted)}">/</text>`)
          cursor += 10
        }
        parts.push(`<text x="${cursor.toFixed(1)}" y="${summaryY.toFixed(1)}" font-size="11.5" fill="${escapeXml(tokenColor(meta.tone, tokens))}">${escapeXml(text)}</text>`)
        cursor += metricsTextWidth(text, 11.5) + 6
      })
      return {
        markup: svgDocument({
          width,
          height,
          title: hasTitle ? spec.title.trim() : '用例矩阵',
          desc: String(spec.desc ?? `用例结果：${summary}`),
          body: parts.join('\n'),
          fontFamily: env.presentation?.fontFamily ?? '',
          limits,
        }),
      }
    }

    // ---------------------------------------------------------------------
    // Part recipes.
    // ---------------------------------------------------------------------

    /**
     * Named part recipes.
     *
     * A part is a shorthand: it expands into primitives the pipeline already
     * knows, so the model writes `{ "type": "part", "part": "stack", "layers": 3 }`
     * instead of placing every plate and foot by hand. The recipes are the ones
     * that pay off for the figures this plugin is actually used for — layered
     * systems, deployments, clusters, gauges, pipelines — rather than the
     * machine-shop vocabulary (flanges, bosses, volutes) of the kit the idea
     * came from.
     *
     * A map rather than a switch, so a new recipe is one entry.
     *
     * @type {Map<string, (part: object, where: string, color: string, tokens: object) => object[]>}
     */
    const ISO_PARTS = new Map()

    /**
     * Register a part recipe.
     *
     * @param {string} name - the value of `part` in a spec.
     * @param {(part: object, where: string, color: string, tokens: object) => object[]} build - the faces.
     */
    function registerIsoPart(name, build) {
      ISO_PARTS.set(name, build)
    }

    /** A number parameter of a part, with a default. */
    function partNumber(part, key, where, fallback, minimum = 0) {
      const value = isoNumber(part[key], `${where}.${key}`, fallback)
      if (value <= minimum) throw new Error(`${where}.${key} 必须大于 ${minimum}`)
      return value
    }

    /** An [x, y] or [x, y, z] size parameter of a part. */
    function partSize(part, key, where, fallback) {
      const value = part[key]
      if (value === undefined || value === null) return fallback
      if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
        throw new Error(`${where}.${key} 必须是 [x, y] 或 [x, y, z]`)
      }
      const out = value.map((item, index) => isoNumber(item, `${where}.${key}[${index}]`))
      if (out.some((item) => item <= 0)) throw new Error(`${where}.${key} 必须为正数`)
      return out
    }

    /** 四角循环，从远到近 —— 画家序要求远的先画。 */
    function partCorners(size, at, inset = 0) {
      const out = []
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          out.push([at[0] + sx * (size[0] / 2 - inset), at[1] + sy * (size[1] / 2 - inset)])
        }
      }
      return out.sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]))
    }

    // 底座 + 四角支脚：给任何场景一个"落地"的底
    registerIsoPart('base', (part, where, color) => {
      const at = isoPoint(part.at, `${where}.at`)
      const size = partSize(part, 'size', where, [3, 3])
      const thickness = partNumber(part, 'thickness', where, 0.24)
      const faces = [...isoBoxFaces(at, [size[0], size[1], thickness], color)]
      if (part.feet !== false) {
        const radius = Math.min(size[0], size[1]) * 0.07
        const height = partNumber(part, 'footHeight', where, 0.26)
        for (const [x, y] of partCorners(size, at, radius * 1.8)) {
          faces.push(...isoLatheFaces({
            center: [x, y, at[2] - thickness / 2 - height / 2],
            radius,
            height,
            color,
            segments: 14,
          }))
        }
      }
      return faces
    })

    // 分层堆叠：分层架构图的主力 —— 每层一块板，层间留空
    registerIsoPart('stack', (part, where, color, tokens) => {
      const at = isoPoint(part.at, `${where}.at`)
      const size = partSize(part, 'size', where, [2.4, 2.4])
      const layers = Math.max(1, Math.round(partNumber(part, 'layers', where, 3)))
      const gap = partNumber(part, 'gap', where, 0.7)
      const thickness = partNumber(part, 'thickness', where, 0.16)
      const palette = Array.isArray(part.colors) ? part.colors : null
      const faces = []
      for (let index = 0; index < layers; index++) {
        const layerColor = palette === null ? color : tokenColor(palette[index % palette.length], tokens)
        faces.push(...isoBoxFaces([at[0], at[1], at[2] + index * gap], [size[0], size[1], thickness], layerColor))
      }
      return faces
    })

    // 机架 + 槽位：部署/机房类场景
    registerIsoPart('rack', (part, where, color) => {
      const at = isoPoint(part.at, `${where}.at`)
      const size = partSize(part, 'size', where, [1.6, 1.6])
      const height = partNumber(part, 'height', where, 2.6)
      const slots = Math.max(1, Math.round(partNumber(part, 'slots', where, 6)))
      const post = partNumber(part, 'post', where, 0.12)
      const inner = shadeColor(color, 0.1)
      const z0 = at[2] - height / 2
      const faces = []
      for (const [x, y] of partCorners(size, at, post / 2)) {
        faces.push(...isoBoxFaces([x, y, at[2]], [post, post, height], color))
      }
      faces.push(...isoBoxFaces([at[0], at[1], z0 + post / 2], [size[0], size[1], post], color))
      faces.push(...isoBoxFaces([at[0], at[1], at[2] + height / 2 - post / 2], [size[0], size[1], post], color))
      const usable = height - post * 2
      for (let index = 0; index < slots; index++) {
        const z = z0 + post + usable * ((index + 0.5) / slots)
        faces.push(...isoBoxFaces([at[0], at[1], z], [size[0] - post * 2.6, size[1] - post * 2.6, post * 0.5], inner))
      }
      return faces
    })

    // 阵列：集群 / 机柜排 / 节点网格
    registerIsoPart('grid', (part, where, color) => {
      const at = isoPoint(part.at, `${where}.at`)
      const count = Array.isArray(part.count) ? part.count : [3, 3]
      if (count.length !== 2) throw new Error(`${where}.count 必须是 [列数, 行数]`)
      const nx = Math.max(1, Math.round(isoNumber(count[0], `${where}.count[0]`)))
      const ny = Math.max(1, Math.round(isoNumber(count[1], `${where}.count[1]`)))
      const size = partSize(part, 'size', where, [0.4, 0.4, 0.4])
      const spacing = partSize(part, 'spacing', where, [size[0] * 1.8, size[1] * 1.8])
      const faces = []
      for (let ix = 0; ix < nx; ix++) {
        for (let iy = 0; iy < ny; iy++) {
          faces.push(...isoBoxFaces([
            at[0] + (ix - (nx - 1) / 2) * spacing[0],
            at[1] + (iy - (ny - 1) / 2) * spacing[1],
            at[2],
          ], [size[0], size[1], size[2] ?? size[0]], color))
        }
      }
      return faces
    })

    // 塔楼：楼体 + 楼板 + 角柱
    registerIsoPart('tower', (part, where, color) => {
      const at = isoPoint(part.at, `${where}.at`)
      const size = partSize(part, 'size', where, [1.8, 1.8])
      const floors = Math.max(1, Math.round(partNumber(part, 'floors', where, 4)))
      const floorHeight = partNumber(part, 'floorHeight', where, 0.8)
      const slab = partNumber(part, 'slab', where, 0.14)
      const post = partNumber(part, 'post', where, 0.14)
      const height = floors * floorHeight
      const inner = shadeColor(color, 0.12)
      const z0 = at[2] - height / 2
      const faces = []
      for (const [x, y] of partCorners(size, at, post / 2)) {
        faces.push(...isoBoxFaces([x, y, at[2]], [post, post, height], color))
      }
      for (let index = 0; index <= floors; index++) {
        faces.push(...isoBoxFaces([at[0], at[1], z0 + index * floorHeight], [size[0], size[1], slab], index === 0 || index === floors ? color : inner))
      }
      return faces
    })

    // 表盘：读数类场景（指标、容量、阈值）
    registerIsoPart('dial', (part, where, color, tokens) => {
      const at = isoPoint(part.at, `${where}.at`)
      const radius = partNumber(part, 'r', where, 0.8)
      const height = partNumber(part, 'height', where, 0.3)
      const needle = part.needle === undefined ? 0.7 : isoNumber(part.needle, `${where}.needle`)
      const faces = [...isoLatheFaces({ center: at, radius, height, color, segments: 40 })]
      // 表圈：一圈更亮的环，让盘面读出边界
      faces.push(...isoLatheFaces({
        center: [at[0], at[1], at[2] + height / 2],
        radius: radius * 0.86,
        thickness: 0,
        height: 0.04,
        color: shadeColor(color, 0.18),
        segments: 40,
      }))
      // 指针：一条细板，方向由 needle 决定（弧度）
      const length = radius * 0.72
      const angle = needle * Math.PI * 2
      faces.push(...isoBoxFaces([
        at[0] + Math.cos(angle) * length / 2,
        at[1] + Math.sin(angle) * length / 2,
        at[2] + height / 2 + 0.05,
      ], [length, radius * 0.08, 0.05], tokenColor(part.needleColor ?? 'red', tokens)))
      return faces
    })

    // 导轨 + 滑台 + 限位：流水线 / 阶段推进
    registerIsoPart('rail', (part, where, color, tokens) => {
      const at = isoPoint(part.at, `${where}.at`)
      const length = partNumber(part, 'length', where, 3)
      const gauge = partNumber(part, 'gauge', where, 0.9)
      const rail = partNumber(part, 'rail', where, 0.12)
      const carriage = partNumber(part, 'carriage', where, 0.5)
      const at0 = part.carriageAt === undefined ? 0.5 : isoNumber(part.carriageAt, `${where}.carriageAt`)
      const faces = []
      for (const sy of [-1, 1]) {
        faces.push(...isoBoxFaces([at[0], at[1] + sy * (gauge / 2), at[2]], [length, rail, rail], color))
      }
      // 限位：两端各一块
      for (const sx of [-1, 1]) {
        faces.push(...isoBoxFaces([at[0] + sx * (length / 2 - rail), at[1], at[2] + rail], [rail * 1.4, gauge * 1.3, rail * 2], color))
      }
      // 滑台：位置由 carriageAt 决定（0..1）
      const x = at[0] + (Math.min(1, Math.max(0, at0)) - 0.5) * (length - carriage)
      faces.push(...isoBoxFaces([x, at[1], at[2] + rail * 1.4], [carriage, gauge * 1.15, rail * 2.4], tokenColor(part.carriageColor ?? 'blue', tokens)))
      return faces
    })

    // 立柱 + 卡箍：支撑 / 挂载
    registerIsoPart('post', (part, where, color, tokens) => {
      const at = isoPoint(part.at, `${where}.at`)
      const height = partNumber(part, 'height', where, 2.4)
      const radius = partNumber(part, 'r', where, 0.14)
      const clampAt = part.clampAt === undefined ? 0.6 : isoNumber(part.clampAt, `${where}.clampAt`)
      const faces = [...isoLatheFaces({ center: at, radius, height, color, segments: 20 })]
      // 底座法兰
      faces.push(...isoLatheFaces({
        center: [at[0], at[1], at[2] - height / 2 + 0.06],
        radius: radius * 2.4,
        height: 0.12,
        color,
        segments: 24,
      }))
      // 卡箍
      const z = at[2] - height / 2 + Math.min(0.95, Math.max(0.05, clampAt)) * height
      faces.push(...isoBoxFaces([at[0], at[1], z], [radius * 3.4, radius * 3.4, radius * 2.2], tokenColor(part.clampColor ?? 'amber', tokens)))
      return faces
    })

    /** A cuboid: six quads. */
    function isoBoxFaces(center, size, color) {
      const [cx, cy, cz] = center
      const [sx, sy, sz] = size
      const x0 = cx - sx / 2, x1 = cx + sx / 2
      const y0 = cy - sy / 2, y1 = cy + sy / 2
      const z0 = cz - sz / 2, z1 = cz + sz / 2
      return [
        [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
        [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
        [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
        [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
        [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
        [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
      ].map((v) => ({ v, color }))
    }

    /**
     * A lathed surface: a sphere, a spherical shell, or a cylinder.
     *
     * @param {object} options - `center`, `radius`, `thickness` (0 = solid),
     *   `height` (a cylinder when set), `color`, `segments`, `rings`.
     * @returns {object[]} the faces.
     */
    function isoLatheFaces(options) {
      const { center, radius, thickness = 0, height = 0, color, segments = 28, rings = 15 } = options
      const [cx, cy, cz] = center
      const faces = []
      const surfaces = height > 0
        ? [[radius, 'out'], [radius, 'in']]
        : thickness > 0 ? [[radius, 'out'], [radius - thickness, 'in']] : [[radius, 'out']]
      for (const [r, tag] of surfaces) {
        const ringCount = height > 0 ? 1 : rings
        for (let i = 0; i < ringCount; i++) {
          const t0 = height > 0 ? 0 : Math.PI * i / rings
          const t1 = height > 0 ? Math.PI : Math.PI * (i + 1) / rings
          for (let j = 0; j < segments; j++) {
            const p0 = Math.PI * 2 * j / segments
            const p1 = Math.PI * 2 * (j + 1) / segments
            const at = (t, p) => height > 0
              ? [cx + r * Math.cos(p), cy + r * Math.sin(p), cz + (t === 0 ? -height / 2 : height / 2)]
              : [cx + r * Math.sin(t) * Math.cos(p), cy + r * Math.sin(t) * Math.sin(p), cz + r * Math.cos(t)]
            const quad = [at(t0, p0), at(t0, p1), at(t1, p1), at(t1, p0)]
            // 内壁提亮而不是压暗：剖面的全部意义是让内部可读，
            // 物理上内壁背光，但画成暗面会让切开的部分糊成一团黑。
            faces.push({ v: tag === 'in' ? quad.slice().reverse() : quad, color, shade: tag === 'in' ? 0.14 : 0 })
          }
        }
      }
      return faces
    }

    /**
     * Build the `solid` kind: a cutaway model inside an optional display case.
     *
     * @param {object} spec - the parsed spec.
     * @param {object} env - the render environment.
     * @returns {{faces: object[], legend: object[], callouts: object[], cutAt: number|null, case: number|null}}
     */
    function isoBuildSolid(spec, env) {
      const objects = spec.objects
      if (!Array.isArray(objects) || objects.length === 0) throw new Error('objects 必须是非空数组（至少一个图元）')
      const tokens = themeTokens()
      const faces = []
      const legend = []
      for (const [index, object] of objects.entries()) {
        const where = `objects[${index}]`
        if (object === null || typeof object !== 'object') throw new Error(`${where} 必须是对象`)
        const color = tokenColor(object.color ?? 'muted', tokens)
        const at = isoPoint(object.at, `${where}.at`)
        switch (object.type) {
          case 'box': {
            const size = isoPoint(object.size, `${where}.size`)
            if (size.some((value) => value <= 0)) throw new Error(`${where}.size 必须为正数`)
            faces.push(...isoBoxFaces(at, size, color))
            break
          }
          case 'ball':
            faces.push(...isoLatheFaces({ center: at, radius: isoNumber(object.r, `${where}.r`), color, segments: isoNumber(object.segments, `${where}.segments`, 22), rings: isoNumber(object.rings, `${where}.rings`, 11) }))
            break
          case 'shell':
            faces.push(...isoLatheFaces({
              center: at,
              radius: isoNumber(object.r, `${where}.r`),
              thickness: isoNumber(object.thickness, `${where}.thickness`, 0),
              color,
              segments: isoNumber(object.segments, `${where}.segments`, 28),
              rings: isoNumber(object.rings, `${where}.rings`, 15),
            }))
            break
          case 'cylinder':
            faces.push(...isoLatheFaces({
              center: at,
              radius: isoNumber(object.r, `${where}.r`),
              height: isoNumber(object.h, `${where}.h`),
              color,
              segments: isoNumber(object.segments, `${where}.segments`, 20),
            }))
            break
          case 'ring': {
            const count = Math.max(1, Math.round(isoNumber(object.count, `${where}.count`, 8)))
            const size = isoPoint(object.size, `${where}.size`, [0.2, 0.2, 0.14])
            const radius = isoNumber(object.r, `${where}.r`)
            const phase = isoNumber(object.phase, `${where}.phase`, 0)
            for (let i = 0; i < count; i++) {
              const angle = phase + (Math.PI * 2 * i) / count
              faces.push(...isoBoxFaces([at[0] + Math.cos(angle) * radius, at[1] + Math.sin(angle) * radius, at[2] + (object.wave === undefined ? 0 : Math.sin(i * 1.7) * Number(object.wave))], size, color))
            }
            break
          }
          case 'part': {
            const name = String(object.part ?? '')
            const build = ISO_PARTS.get(name)
            if (build === undefined) {
              throw new Error(`${where}.part 未知：${JSON.stringify(object.part)}（可用 ${[...ISO_PARTS.keys()].join(' / ')}）`)
            }
            faces.push(...build(object, where, color, tokens))
            break
          }
          default:
            throw new Error(`${where}.type 未知：${JSON.stringify(object.type)}（可用 box / ball / shell / cylinder / ring / part）`)
        }
        if (object.legend !== false && object.label !== undefined) legend.push({ color: object.color ?? 'muted', text: String(object.label) })
      }
      return {
        faces,
        legend,
        callouts: Array.isArray(spec.callouts) ? spec.callouts : [],
        cutAt: spec.cut === undefined || spec.cut === null ? null : isoNumber(spec.cut, 'cut'),
        // 数字 = 立方体；[宽, 深, 高] = 扁柜子（宽而矮的场景不该被立方体浪费画幅）
        case: spec.case === undefined || spec.case === null
          ? null
          : (Array.isArray(spec.case)
            ? spec.case.map((value, index) => {
              const size = isoNumber(value, `case[${index}]`)
              if (size <= 0) throw new Error(`case[${index}] 必须为正数`)
              return size
            })
            : isoNumber(spec.case, 'case')),
      }
    }

    /**
     * Build the `voxel` kind from procedural shapes or hand-written ASCII layers.
     *
     * @param {object} spec - the parsed spec.
     * @param {object} env - the render environment.
     * @returns {{faces: object[], legend: object[], callouts: object[], cutAt: null}}
     */
    function isoBuildVoxel(spec, env) {
      const size = Math.round(isoNumber(spec.grid, 'grid', 17))
      enforceLimits(spec.limits, { grid: size })
      if (size < 3) throw new Error('grid 至少为 3')
      const palette = spec.palette
      if (palette === null || typeof palette !== 'object') throw new Error('palette 必须是对象，把字符映射到颜色，例如 { "#": "amber" }')
      const tokens = themeTokens()
      const colors = {}
      for (const [key, value] of Object.entries(palette)) {
        if (key.length !== 1) throw new Error(`palette 的键必须是单个字符：${JSON.stringify(key)}`)
        colors[key] = tokenColor(value, tokens)
      }
      const grid = new Uint8Array(size ** 3)
      const index = (x, y, z) => (z * size + y) * size + x
      const symbolOf = new Map(Object.keys(colors).map((key, position) => [key, position + 1]))
      const center = (size - 1) / 2
      const set = (x, y, z, symbol) => {
        if (x < 0 || y < 0 || z < 0 || x >= size || y >= size || z >= size) return
        grid[index(x, y, z)] = symbolOf.get(symbol) ?? 0
      }

      if (Array.isArray(spec.layers)) {
        if (Array.isArray(spec.shapes)) throw new Error('layers 与 shapes 只能二选一')
        spec.layers.forEach((layer, z) => {
          if (typeof layer !== 'string') throw new Error(`layers[${z}] 必须是字符串`)
          for (let y = 0; y < size; y++) {
            const row = layer.split('\n')[y] ?? ''
            for (let x = 0; x < size; x++) {
              const symbol = row[x]
              if (symbol === undefined || symbol === ' ' || symbol === '.') continue
              if (!symbolOf.has(symbol)) throw new Error(`layers[${z}] 用了 palette 未声明的字符：${JSON.stringify(symbol)}`)
              set(x, y, z, symbol)
            }
          }
        })
      } else if (Array.isArray(spec.shapes)) {
        for (const [position, shape] of spec.shapes.entries()) {
          const where = `shapes[${position}]`
          // 只有会放置体素的形状才需要 fill；collapse 是挖空，不填任何东西
          const placesVoxels = ['ball', 'shell', 'box', 'cluster'].includes(shape.shape)
          const symbol = shape.fill
          if (placesVoxels && !symbolOf.has(symbol)) {
            throw new Error(`${where}.fill 必须是 palette 里声明过的字符（${where}.shape 是 ${JSON.stringify(shape.shape)}，需要 fill）`)
          }
          const at = isoPoint(shape.at, `${where}.at`, [center, center, center])
          switch (shape.shape) {
            case 'ball': {
              const r = isoNumber(shape.r, `${where}.r`)
              for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                if (Math.hypot(x - at[0], y - at[1], z - at[2]) <= r) set(x, y, z, symbol)
              }
              break
            }
            case 'shell': {
              const outer = isoNumber(shape.r, `${where}.r`)
              const thickness = isoNumber(shape.thickness, `${where}.thickness`, 1)
              for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                const d = Math.hypot(x - at[0], y - at[1], z - at[2])
                if (d <= outer && d >= outer - thickness) set(x, y, z, symbol)
              }
              break
            }
            case 'box': {
              const half = isoPoint(shape.size, `${where}.size`, [1, 1, 1]).map((value) => value / 2)
              for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                if (Math.abs(x - at[0]) <= half[0] && Math.abs(y - at[1]) <= half[1] && Math.abs(z - at[2]) <= half[2]) set(x, y, z, symbol)
              }
              break
            }
            case 'cluster': {
              const count = Math.max(1, Math.round(isoNumber(shape.count, `${where}.count`, 8)))
              const r = isoNumber(shape.r, `${where}.r`, size / 3)
              const seed = Math.round(isoNumber(shape.seed, `${where}.seed`, 7))
              for (let i = 0; i < count; i++) {
                const angle = (Math.PI * 2 * i) / count + seed * 0.1
                set(Math.round(at[0] + Math.cos(angle) * r), Math.round(at[1] + Math.sin(angle) * r), Math.round(at[2] + Math.sin(i * 2.1) * 1.5), symbol)
              }
              break
            }
            case 'collapse': {
              // Deterministic hollowing: a seeded PRNG, never Math.random — the
              // figure is re-rendered on theme changes and compared.
              const count = Math.max(1, Math.round(isoNumber(shape.count, `${where}.count`, 12)))
              const minRadius = Array.isArray(shape.radius) ? isoNumber(shape.radius[0], `${where}.radius[0]`) : isoNumber(shape.radius, `${where}.radius`, 2)
              const maxRadius = Array.isArray(shape.radius) ? isoNumber(shape.radius[1], `${where}.radius[1]`) : minRadius
              let seed = Math.round(isoNumber(shape.seed, `${where}.seed`, 7)) | 0
              const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
              for (let i = 0; i < count; i++) {
                const u = rnd() * 2 - 1
                const angle = rnd() * Math.PI * 2
                const rxy = Math.sqrt(Math.max(0, 1 - u * u))
                const radius = minRadius + (maxRadius - minRadius) * rnd()
                const bx = center + radius * rxy * Math.cos(angle)
                const by = center + radius * rxy * Math.sin(angle)
                const bz = center + radius * u
                const hole = 1.5 + rnd() * 2
                for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
                  if (grid[index(x, y, z)] === 0) continue
                  if (Math.hypot(x - bx, y - by, z - bz) <= hole) grid[index(x, y, z)] = 0
                }
              }
              break
            }
            default:
              throw new Error(`${where}.shape 未知：${JSON.stringify(shape.shape)}（可用 ball / shell / box / cluster / collapse）`)
          }
        }
      } else {
        throw new Error('voxel 需要 shapes 或 layers 之一')
      }

      // The section removes the quarter nearest the viewer, in model space.
      // 剖面与 solid 用同一套语义：切掉 (x + y) 超过阈值的部分（斜切，不是切角块），
      // 这样两种 kind 的"切开"看起来是同一件事。
      if (spec.cut === true || typeof spec.cut === 'number') {
        const cutAt = typeof spec.cut === 'number' ? spec.cut : size * 1.06
        for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
          if (x + y > cutAt) grid[index(x, y, z)] = 0
        }
      }
      const bySymbol = Object.fromEntries([...symbolOf.entries()].map(([key, position]) => [position, colors[key]]))
      const faces = isoVoxelFaces(grid, { size, center, colors: bySymbol })
      enforceLimits(spec.limits, { faces: faces.length })
      return {
        faces,
        legend: Array.isArray(spec.legend) ? spec.legend : [],
        callouts: [],
        cutAt: null,
      }
    }

    registerIsoKind('solid', isoBuildSolid)
    registerIsoKind('voxel', isoBuildVoxel)

    /**
     * Parse a spec and settle which kind it is.
     *
     * Two entries share one engine, so the fence decides the kind. A spec may
     * still declare `kind` — it must then agree with the fence, because silently
     * drawing something other than what the block asked for is worse than an
     * error the author can read.
     *
     * @param {string} source - the fence source.
     * @param {'solid'|'voxel'|undefined} fixedKind - the fence's kind, when the
     *   entry fixes one.
     * @returns {{spec: object, kind: string}} the parsed spec and its kind.
     */
    function isoSpecOf(source, fixedKind) {
      const spec = parseJson(source, fixedKind === 'voxel' ? '体素图 spec' : '等距图 spec')
      const declared = String(spec.kind ?? '')
      if (fixedKind === undefined) {
        if (!ISO_KINDS.has(declared)) {
          throw new Error(`kind 未知：${JSON.stringify(spec.kind)}（可用 ${[...ISO_KINDS.keys()].join(' / ')}）`)
        }
        return { spec, kind: declared }
      }
      if (declared !== '' && declared !== fixedKind) {
        throw new Error(`这个代码块画的是 ${fixedKind}，spec 里的 kind 却是 ${JSON.stringify(declared)}；去掉 kind，或改成 "${fixedKind}"`)
      }
      // 交叉使用的常见形态：块与 spec 写法对不上。直接点名，别让它掉进构建器的
      // "palette 必须是对象" 这种内部错误里 —— 那种提示帮不到写错的人。
      if (fixedKind === 'voxel' && spec.objects !== undefined) {
        throw new Error('这个代码块画体素，spec 里却写了 objects（那是 ```isometric 的写法）；体素用 shapes 或 layers')
      }
      if (fixedKind === 'solid' && (spec.shapes !== undefined || spec.layers !== undefined)) {
        throw new Error('这个代码块画等距剖面，spec 里却写了 shapes/layers（那是 ```voxel 的写法）；剖面用 objects')
      }
      return { spec, kind: fixedKind }
    }

    /**
     * The exact solid of an object, when its intersection test is exact.
     *
     * Only `box` and `ball` qualify. A cylinder, ring or shell would have to be
     * judged by its bounding box, which reports overlaps that are not there —
     * and a check that cries wolf is worse than no check.
     *
     * @param {object} object - one entry of `objects`.
     * @param {string} field - the path, for error messages.
     * @returns {{kind: string, min?: number[], max?: number[], center?: number[], r?: number}|null} the shape, or null.
     */
    function isoShapeOf(object, field) {
      if (object === null || typeof object !== 'object') return null
      if (object.type === 'box') {
        const at = isoPoint(object.at, `${field}.at`)
        if (!Array.isArray(object.size) || object.size.length !== 3) return null
        const size = object.size.map((value, index) => isoNumber(value, `${field}.size[${index}]`))
        return {
          kind: 'box',
          min: [at[0] - size[0] / 2, at[1] - size[1] / 2, at[2] - size[2] / 2],
          max: [at[0] + size[0] / 2, at[1] + size[1] / 2, at[2] + size[2] / 2],
        }
      }
      if (object.type === 'ball') {
        return { kind: 'ball', center: isoPoint(object.at, `${field}.at`), r: isoNumber(object.r, `${field}.r`, 0) }
      }
      if (object.type === 'cylinder') {
        // 轴对齐圆柱：XY 上是圆、z 上是区间，两者都能精确判交。
        // box 与 cylinder 之间不判：包围盒会在对角相邻时报出并不存在的重叠。
        return {
          kind: 'cylinder',
          center: isoPoint(object.at, `${field}.at`),
          r: isoNumber(object.r, `${field}.r`, 0),
          h: isoNumber(object.h, `${field}.h`, 0),
        }
      }
      return null
    }

    /**
     * How two exact solids stand to each other.
     *
     * `contained` is a first-class answer, not a tolerance: these figures are
     * built by putting a ball inside a shell and a city inside a sphere, and
     * that is not a defect. Interpenetration — neither one containing the other
     * — is.
     *
     * @param {object} a - an exact shape.
     * @param {object} b - an exact shape.
     * @returns {'apart'|'contained'|'overlap'} the relation.
     */
    function isoRelation(a, b) {
      const EPS = 1e-6
      if (a.kind === 'ball' && b.kind === 'ball') {
        const d = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1], a.center[2] - b.center[2])
        if (d >= a.r + b.r - EPS) return 'apart'
        if (d + Math.min(a.r, b.r) <= Math.max(a.r, b.r) + EPS) return 'contained'
        return 'overlap'
      }
      if (a.kind === 'box' && b.kind === 'box') {
        for (let axis = 0; axis < 3; axis++) {
          if (a.max[axis] <= b.min[axis] + EPS || b.max[axis] <= a.min[axis] + EPS) return 'apart'
        }
        const aInB = a.min.every((value, axis) => value >= b.min[axis] - EPS) && a.max.every((value, axis) => value <= b.max[axis] + EPS)
        const bInA = b.min.every((value, axis) => value >= a.min[axis] - EPS) && b.max.every((value, axis) => value <= a.max[axis] + EPS)
        return aInB || bInA ? 'contained' : 'overlap'
      }
      if (a.kind === 'cylinder' && b.kind === 'cylinder') {
        const d2 = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1])
        const zApart = a.center[2] + a.h / 2 <= b.center[2] - b.h / 2 + EPS || b.center[2] + b.h / 2 <= a.center[2] - a.h / 2 + EPS
        if (d2 >= a.r + b.r - EPS || zApart) return 'apart'
        const aInB = d2 + a.r <= b.r + EPS && a.h <= b.h + EPS
          && a.center[2] - a.h / 2 >= b.center[2] - b.h / 2 - EPS && a.center[2] + a.h / 2 <= b.center[2] + b.h / 2 + EPS
        const bInA = d2 + b.r <= a.r + EPS && b.h <= a.h + EPS
          && b.center[2] - b.h / 2 >= a.center[2] - a.h / 2 - EPS && b.center[2] + b.h / 2 <= a.center[2] + a.h / 2 + EPS
        return aInB || bInA ? 'contained' : 'overlap'
      }
      if ((a.kind === 'ball' && b.kind === 'cylinder') || (a.kind === 'cylinder' && b.kind === 'ball')) {
        const ball = a.kind === 'ball' ? a : b
        const cyl = a.kind === 'cylinder' ? a : b
        const zNear = Math.min(Math.max(ball.center[2], cyl.center[2] - cyl.h / 2), cyl.center[2] + cyl.h / 2)
        const d2 = Math.hypot(ball.center[0] - cyl.center[0], ball.center[1] - cyl.center[1])
        const dz = Math.abs(ball.center[2] - zNear)
        // 球心到实心圆柱的精确距离：半径内看 z 差，半径外再加上径向的那一段
        const distance = d2 <= cyl.r ? dz : Math.hypot(d2 - cyl.r, dz)
        if (distance >= ball.r - EPS) return 'apart'
        const ballInCyl = d2 + ball.r <= cyl.r + EPS
          && ball.center[2] - ball.r >= cyl.center[2] - cyl.h / 2 - EPS
          && ball.center[2] + ball.r <= cyl.center[2] + cyl.h / 2 + EPS
        if (ballInCyl) return 'contained'
        // 圆柱完全在球内：看圆柱四条最远的棱
        const rim = Math.hypot(cyl.r, cyl.h / 2)
        const far = Math.max(...[-1, 1].flatMap((sz) => [-1, 1].map((sxy) => Math.hypot(
          ball.center[0] - (cyl.center[0] + sxy * cyl.r),
          ball.center[1] - cyl.center[1],
          ball.center[2] - (cyl.center[2] + sz * cyl.h / 2),
        )))) 
        return rim <= ball.r + EPS && far <= ball.r + EPS ? 'contained' : 'overlap'
      }
      // box 与 ball：最近点距离判"分开"、最远点距离判"被包住"
      const box = a.kind === 'box' ? a : b
      const ball = a.kind === 'ball' ? a : b
      const near = box.min.map((value, axis) => Math.min(Math.max(ball.center[axis], value), box.max[axis]))
      const far = box.min.map((value, axis) => (Math.abs(ball.center[axis] - value) > Math.abs(ball.center[axis] - box.max[axis]) ? value : box.max[axis]))
      const dNear = Math.hypot(...near.map((value, axis) => value - ball.center[axis]))
      const dFar = Math.hypot(...far.map((value, axis) => value - ball.center[axis]))
      if (dNear >= ball.r - EPS) return 'apart'
      if (dFar <= ball.r + EPS) return 'contained'
      const inside = box.min.every((value, axis) => ball.center[axis] - ball.r >= value - EPS)
        && box.max.every((value, axis) => ball.center[axis] + ball.r <= value + EPS)
      return inside ? 'contained' : 'overlap'
    }

    /** Does a point land on (or just beside) an exact shape? */
    function isoTouches(shape, point, pad) {
      if (shape.kind === 'ball') {
        return Math.hypot(...shape.center.map((value, axis) => value - point[axis])) <= shape.r + pad
      }
      return shape.min.every((value, axis) => point[axis] >= value - pad)
        && shape.max.every((value, axis) => point[axis] <= value + pad)
    }

    /**
     * The bounding box of any object, whatever its type.
     *
     * The callout check needs this rather than `isoShapeOf`: a leader line
     * usually points at a cylinder or a ring, and judging those by an exact
     * solid is not possible — but judging them by bounds is. The first version
     * of this check used the exact shapes only and reported three phantom
     * "points at nothing" problems on our own sample, which is exactly the
     * crying-wolf failure the shapes list exists to avoid.
     *
     * @param {object} object - one entry of `objects`.
     * @param {string} field - the path, for error messages.
     * @returns {{min: number[], max: number[]}|null} the bounds, or null.
     */
    function isoBoundsOf(object, field) {
      if (object === null || typeof object !== 'object') return null
      const at = isoPoint(object.at, `${field}.at`)
      const around = (half) => ({
        min: [at[0] - half[0], at[1] - half[1], at[2] - half[2]],
        max: [at[0] + half[0], at[1] + half[1], at[2] + half[2]],
      })
      const size = (value, index, fallback) => isoNumber(value, `${field}.size[${index}]`, fallback)
      switch (object.type) {
        case 'box':
          if (!Array.isArray(object.size) || object.size.length !== 3) return null
          return around(object.size.map((value, index) => size(value, index, 1) / 2))
        case 'ball':
        case 'shell': {
          const r = isoNumber(object.r, `${field}.r`, 0)
          return around([r, r, r])
        }
        case 'cylinder': {
          const r = isoNumber(object.r, `${field}.r`, 0)
          return around([r, r, isoNumber(object.h, `${field}.h`, 0) / 2])
        }
        case 'ring': {
          // 环上的每个方块距中心 r，所以外沿是 r 加半个方块
          const r = isoNumber(object.r, `${field}.r`, 0)
          const box = Array.isArray(object.size) ? object.size : [0.3, 0.3, 0.3]
          const half = Math.max(...box.map((value, index) => size(value, index, 0.3))) / 2
          return around([r + half, r + half, size(box[2], 2, 0.3) / 2])
        }
        default:
          return null
      }
    }

    /**
     * The bounds of a part, from its expanded faces.
     *
     * Parts are expanded inside the builder, so the audit cannot see their
     * primitives — but it can see where they end up. That is enough for the
     * callout check (a leader has to land on the part) and it is **not** enough
     * for the interpenetration check, which needs exact solids: a part is only
     * judged by its bounding box, and judging boxes that way reports overlaps
     * that are not there. Stated here rather than left for someone to discover.
     *
     * @param {object} object - a `part` entry.
     * @param {string} where - the path, for error messages.
     * @returns {{min: number[], max: number[]}|null} the bounds, or null.
     */
    function isoPartBounds(object, where) {
      const build = ISO_PARTS.get(String(object.part ?? ''))
      if (build === undefined) return null
      try {
        const tokens = themeTokens()
        const faces = build(object, where, tokenColor(object.color ?? 'muted', tokens), tokens)
        const min = [Infinity, Infinity, Infinity]
        const max = [-Infinity, -Infinity, -Infinity]
        for (const face of faces) {
          for (const vertex of face.v) {
            for (let axis = 0; axis < 3; axis++) {
              min[axis] = Math.min(min[axis], vertex[axis])
              max[axis] = Math.max(max[axis], vertex[axis])
            }
          }
        }
        return Number.isFinite(min[0]) ? { min, max } : null
      } catch {
        // 参数错会让构建器抛错；那是渲染路径要报的错，审计不该重复报
        return null
      }
    }

    /** 一个物体尺度的粗略度量，用于引线容差。 */
    function isoScaleOf(bounds) {
      return Math.max(...bounds.max.map((value, axis) => value - bounds.min[axis])) / 2
    }

    /**
     * Relationship checks for one isometric spec.
     *
     * Adapted from the Anatomy skill's geometry audit (their first engine figure
     * carried 54 clearance problems and 323 depth-order problems that no amount
     * of looking at a 1× screenshot would have found). Three of its rules are
     * provable at the scale our specs work at:
     *
     *   1. **interpenetration** — two solids whose surfaces cut through each
     *      other. Containment is not a defect (see `isoRelation`);
     *   2. **a callout that points at nothing** — the leader has to land on a
     *      part, or the eye follows it into empty space;
     *   3. **a legend entry with no matching object** — the swatch promises
     *      something the figure does not contain.
     *
     * @param {object} spec - the parsed spec.
     * @param {string} kind - `solid` or `voxel`.
     * @returns {{problems: Array<{kind: string, detail: string}>, checked: number}} the findings.
     */
    function isoAudit(spec, kind) {
      const problems = []
      // 体素没有这个问题：一格一个体素，网格本身保证了不互穿
      if (kind !== 'solid') return { problems, checked: 0 }
      const objects = Array.isArray(spec.objects) ? spec.objects : []
      const shapes = objects
        .map((object, index) => ({ index, object, shape: isoShapeOf(object, `objects[${index}]`) }))
        .filter((entry) => entry.shape !== null)

      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          if (isoRelation(shapes[i].shape, shapes[j].shape) === 'overlap') {
            problems.push({
              kind: 'overlap',
              detail: `objects[${shapes[i].index}] 与 objects[${shapes[j].index}] 互相穿过（要么分开，要么让一个完整包住另一个）`,
            })
          }
        }
      }

      // 引线按"包围盒"判，而不是按可精确判交的形状：引线常指向圆柱或环，
      // 只判 box/ball 会在我们自己的示例上误报三处"指向空处"。
      const bounds = objects
        .map((object, index) => (object?.type === 'part'
          ? isoPartBounds(object, `objects[${index}]`)
          : isoBoundsOf(object, `objects[${index}]`)))
        .filter((value) => value !== null)
      for (const [index, callout] of (Array.isArray(spec.callouts) ? spec.callouts : []).entries()) {
        const at = isoPoint(callout?.at, `callouts[${index}].at`)
        // 容差取图元自身尺度的 10%：引线常常落在面上而不是正中
        const landed = bounds.some((value) => isoTouches(
          { kind: 'box', min: value.min, max: value.max }, at, Math.max(0.05, isoScaleOf(value) * 0.1),
        ))
        if (!landed) problems.push({ kind: 'callout', detail: `callouts[${index}] 指向空处：附近没有任何图元` })
      }

      const used = new Set(objects.map((object) => String(object?.color ?? 'muted')))
      for (const [index, item] of (Array.isArray(spec.legend) ? spec.legend : []).entries()) {
        if (!used.has(String(item?.color))) {
          problems.push({ kind: 'legend', detail: `legend[${index}] 的颜色 ${String(item?.color)} 没有任何图元在用` })
        }
      }

      return { problems, checked: shapes.length }
    }

    /**
     * The shared pipeline: parse, build, cut, frame, draw, wrap.
     *
     * Both the static and the interactive path go through here, so the two can
     * never drift apart. Both kinds go through it too: what differs is the
     * builder the kind selects, not the pipeline.
     *
     * @param {string} source - the fence source.
     * @param {object} env - the render environment.
     * @param {object} [options] - `kind` (fixed by the entry), `yaw`, `zoom`.
     * @returns {{markup: string, view: object}} the figure and its view.
     */
    function isoFigure(source, env, options = {}) {
      // 进入对话的是这份 spec，所以它自己要有上限；产物是本地生成的，另有 bytes 上限
      if (source.length > ISO_SPEC_BYTES) throw new Error(`spec 过长（${Math.round(source.length / 1024)} KiB），上限 ${ISO_SPEC_BYTES / 1024} KiB，请精简`)
      const { spec, kind } = isoSpecOf(source, options.kind)
      const build = ISO_KINDS.get(kind)
      // The interactive path overrides the canvas with the container's size, so
      // one spec fills whatever space the figure was given.
      const width = Math.round(isoNumber(options.width ?? spec.width, 'width', ISO_CANVAS.width))
      const height = Math.round(isoNumber(options.height ?? spec.height, 'height', ISO_CANVAS.height))
      const built = build({ ...spec, limits: spec.limits ?? env.limits }, env)
      const cutFaces = isoOrderFaces(built.faces, built.cutAt ?? null)
      enforceLimits(spec.limits ?? env.limits, { faces: cutFaces.length })
      const yaw = (options.yaw ?? isoNumber(spec.yaw, 'yaw', 0.62)) + (options.spin ?? 0)
      const caseCorners = built.case === null || built.case === undefined ? [] : isoCaseCorners(built.case)
      const view = isoFit(cutFaces, { yaw }, width, height, 30, caseCorners)
      const zoom = options.zoom ?? 1
      if (zoom !== 1) {
        view.scale *= zoom
        view.ox = width / 2 - (width / 2 - view.ox) * zoom
        view.oy = height / 2 - (height / 2 - view.oy) * zoom
      }
      const { body, classes } = isoDraw(cutFaces, view)
      const tokens = themeTokens()
      const parts = []
      if (built.case !== null && built.case !== undefined) parts.push(isoCaseBody(built.case, view, tokens))
      parts.push(body)
      for (const [index, callout] of (built.callouts ?? []).entries()) {
        const [x, y] = isoProject(isoPoint(callout.at, `callouts[${index}].at`), view)
        const side = callout.side === 'left' ? 'left' : 'right'
        parts.push(svgCallout({
          at: [x, y],
          text: String(callout.text ?? ''),
          index: index + 1,
          side,
          x: side === 'left' ? 16 : width - 132,
          y: 52 + index * 26,
        }))
      }
      const legend = Array.isArray(built.legend) ? built.legend : []
      if (legend.length > 0) parts.push(svgLegend(legend, { x: 26, y: height - 30, gap: Math.min(150, (width - 52) / legend.length) }))
      const title = String(spec.title ?? '等距展示')
      const markup = svgDocument({
        width,
        height,
        title,
        desc: String(spec.desc ?? '等距投影展示图。'),
        body: parts.join('\n'),
        classes,
        fontFamily: env.presentation?.fontFamily ?? '',
        limits: spec.limits ?? env.limits,
      })
      return { markup, view, spec, title }
    }

    /** The dashed display case: the square space the model sits in. */
    function isoCaseCorners(size) {
      // 数字 = **半边长**（老写法，所有既有图都按这个读）；[宽, 深, 高] = 全尺寸。
      // 两种语义不同是刻意的：把数字改成"全尺寸"会让既有图的柜子缩小一半，
      // 而那是静默的 —— 展示图 diff 抓到过一次。
      const half = Array.isArray(size)
        ? [size[0] / 2, size[1] / 2, size[2] / 2]
        : [size, size, size]
      const corners = []
      for (const x of [-half[0], half[0]]) for (const y of [-half[1], half[1]]) for (const z of [-half[2], half[2]]) corners.push([x, y, z])
      return corners
    }

    function isoCaseBody(half, view, tokens) {
      const corners = isoCaseCorners(half)
      const lines = []
      for (let i = 0; i < corners.length; i++) {
        for (let j = i + 1; j < corners.length; j++) {
          const differing = corners[i].filter((value, axis) => value !== corners[j][axis]).length
          if (differing !== 1) continue
          const [x1, y1] = isoProject(corners[i], view)
          const [x2, y2] = isoProject(corners[j], view)
          lines.push(`M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`)
        }
      }
      return `<path d="${lines.join('')}" fill="none" stroke="${tokens.border}" stroke-width="0.75" stroke-dasharray="4 3" opacity="0.9"/>`
    }

    /** @type {Record<string, {detect?: (source: string) => boolean, render: (source: string, env: object) => Promise<{markup: string}>}>} */
    /**
     * One isometric adapter, for one kind.
     *
     * The projection engine is shared by both kinds; what differs is where the
     * geometry comes from — primitives you place, or a voxel grid you fill.
     * The two manifest entries route here with a fixed kind, so each gets its
     * own fence, its own toggle, its own syntax line and its own settings
     * preview while the engine stays single.
     *
     * @param {'solid'|'voxel'} kind - the kind this adapter always draws.
     * @returns {object} the adapter.
     */
    function isoAdapter(kind) {
      return {
        detect: (source) => source.trim().startsWith('{') && new RegExp(`"kind"\\s*:\\s*"${kind}"`).test(source),
        validate: (source) => {
          isoSpecOf(source, kind)
        },
        async render(source, env) {
          return { markup: isoFigure(source, env, { kind }).markup }
        },
      /**
       * The interactive path.
       *
       * Rotation, the section toggle and zoom are recomputed here, locally:
       * the spec is already in the conversation, so looking at another angle
       * costs no tokens at all. Everything is redrawn from the same
       * `isoFigure` the static path uses, so the two cannot drift apart.
       */
      async mount(source, env) {
        const host = env.target
        const state = { yaw: undefined, zoom: 1, cut: undefined }
        const root = el('div', 'vk-iso')
        const view = el('div', 'vk-iso-view')
        const controls = el('div', 'vk-iso-controls')
        root.appendChild(view)
        root.appendChild(controls)
        host.appendChild(root)
        let current = ''

        const width = () => Math.max(240, Math.round(view.getBoundingClientRect().width || host.getBoundingClientRect().width || 640))

        const draw = () => {
          if (env.signal.aborted) return
          const { spec } = isoSpecOf(source, kind)
          const patched = state.cut === undefined ? source : JSON.stringify({ ...spec, cut: state.cut })
          current = isoFigure(patched, env, {
            kind,

            width: width(),
            height: Math.max(240, Math.round(view.getBoundingClientRect().height || 320)),
            yaw: state.yaw,
            zoom: state.zoom,
          }).markup
          view.innerHTML = current
        }

        const button = (label, action) => {
          const node = el('button', 'vk-iso-button', label)
          node.type = 'button'
          node.addEventListener('click', action)
          controls.appendChild(node)
          return node
        }
        const { spec } = isoSpecOf(source, kind)
        const initialYaw = isoNumber(spec.yaw, 'yaw', 0.62)
        state.yaw = initialYaw
        // 记住 spec 原本的剖切值：切两次要回到它，而不是回到 false。
        // 例如 cut: 0.7 的图，关掉再打开必须是 0.7，否则画面与初始不一致。
        const originalCut = spec.cut ?? null
        state.cut = originalCut
        const voxel = kind === 'voxel'
        const cutIsOn = () => state.cut !== false && state.cut !== null && state.cut !== undefined
        const cutLabel = () => cutIsOn() ? (voxel ? '切掉前 1/4' : '剖面：开') : (voxel ? '完整' : '剖面：关')
        const cutButton = button(cutLabel(), () => {
          state.cut = cutIsOn() ? false : originalCut
          cutButton.textContent = cutLabel()
          draw()
        })
        cutButton.textContent = cutLabel()
        button('旋转 90°', () => { state.yaw += Math.PI / 2; draw() })
        button('重置视角', () => { state.yaw = initialYaw; state.zoom = 1; draw() })

        let dragging = false
        let lastX = 0
        const onDown = (event) => { dragging = true; lastX = event.clientX; view.setPointerCapture?.(event.pointerId) }
        const onMove = (event) => {
          if (!dragging) return
          const step = (event.clientX - lastX) * 0.012
          lastX = event.clientX
          state.yaw += event.shiftKey ? Math.round(step / (Math.PI / 2)) * (Math.PI / 2) : step
          draw()
        }
        const onUp = (event) => { dragging = false; view.releasePointerCapture?.(event.pointerId) }
        const onWheel = (event) => {
          event.preventDefault()
          state.zoom = Math.max(0.5, Math.min(3, state.zoom * Math.exp(-event.deltaY * 0.0012)))
          draw()
        }
        view.addEventListener('pointerdown', onDown)
        view.addEventListener('pointermove', onMove)
        view.addEventListener('pointerup', onUp)
        view.addEventListener('pointercancel', onUp)
        view.addEventListener('wheel', onWheel, { passive: false })
        draw()

        return {
          resize: () => draw(),
          reset: () => { state.yaw = initialYaw; state.zoom = 1; draw() },
          snapshot: () => ({ data: current, mimeType: 'image/svg+xml', extension: 'svg' }),
          dispose: () => {
            view.removeEventListener('pointerdown', onDown)
            view.removeEventListener('pointermove', onMove)
            view.removeEventListener('pointerup', onUp)
            view.removeEventListener('pointercancel', onUp)
            view.removeEventListener('wheel', onWheel)
            root.remove()
          },
        }
      },
      }
    }

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
        /** Interactive sources are validated before mounting and before the static fallback. */
        validate: (source, _mode, spec) => validateInteractiveSource(source, spec?.limits),
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
      // 两种形态各自一个条目，共用 isoAdapter 里的同一套投影引擎
      matrix: {
        detect: (source) => {
          const trimmed = source.trim()
          if (!trimmed.startsWith('{')) return false
          if (!/"cases"\s*:\s*\[/.test(trimmed)) return false
          // 用例必须有 name 才算矩阵，免得抢走数据键恰好叫 cases 的图表
          return /"name"\s*:/.test(trimmed)
        },
        validate: (source) => {
          matrixSpecOf(source)
        },
        async render(source, env) {
          const parsed = matrixSpecOf(source)
          return { markup: matrixFigure({ ...parsed, spec: { ...parsed.spec, limits: parsed.spec.limits ?? env.limits } }, env).markup }
        },
      },
      metrics: {
        // 家规：内容嗅探必须锚定在首字符。不锚定的话，一段"文档里引用了
        // ```metrics 示例"的四反引号块会被抢走，再拿去 JSON.parse 就炸。
        // 其余七个渲染器都写着 trimmed.startsWith('{')，这一条当时漏了。
        detect: (source) => {
          const trimmed = source.trim()
          if (!trimmed.startsWith('{')) return false
          if (!/"items"\s*:\s*\[/.test(trimmed)) return false
          // 读数项必须有 label 才算指标卡，免得抢走数据键恰好叫 items 的图表
          return /"label"\s*:/.test(trimmed)
        },
        validate: (source) => {
          metricsSpecOf(source)
        },
        async render(source, env) {
          const parsed = metricsSpecOf(source)
          return { markup: metricsFigure({ ...parsed, spec: { ...parsed.spec, limits: parsed.spec.limits ?? env.limits } }, env).markup }
        },
      },
      isometric: isoAdapter('solid'),
      voxel: isoAdapter('voxel'),
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
     * A font stack that survives being written into an XML attribute.
     *
     * ECharts renders SVG by putting the font stack straight into a
     * double-quoted `font-family` attribute, and it does not escape what it
     * finds there. A stack like `system-ui, "Segoe UI", sans-serif` therefore
     * produces `font-family="… " segoe="" ui"…` — **not well-formed XML**. HTML
     * parsing is forgiving, so it still looked right inside the app, but the
     * same bytes broke wherever SVG is parsed strictly: an exported file opened
     * in a browser, or an `<img>` on GitHub.
     *
     * Single quotes are valid inside a double-quoted attribute and mean the same
     * thing to CSS, so swapping the delimiter is the whole fix.
     *
     * @param {string} fontFamily - the configured stack.
     * @returns {string} the same stack, safe in an attribute.
     */
    function xmlSafeFontFamily(fontFamily) {
      return String(fontFamily ?? '').replace(/"/g, "'")
    }

    /**
     * Parse a JSON source with a message that says which field is wrong.
     * @param {string} source - the source text.
     * @param {string} label - what the JSON is, for the message.
     * @returns {object} the parsed value.
     */
    function echartsOption(option, env) {
      const c = chrome()
      const text = { color: c.canvasText, fontFamily: xmlSafeFontFamily(env.presentation.fontFamily), fontSize: env.presentation.fontSize }
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

    function validateInteractiveSource(source, limits) {
      const size = new Blob([source]).size
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
      enforceLimits(limits, { bytes: size, points: count }, { bytes: '减少数据' })
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
      // The host retains DOM styles across client reloads. Reuse the owned node
      // but refresh its content so an earlier client cannot suppress new rules.
      const style = document.getElementById(STYLE_ID) ?? el('style')
      style.id = STYLE_ID
      const css = `
.vk-figure, .vk-error, .vk-panel, .vk-lightbox { --vk-border: var(--dsw-color-border, oklch(86% .012 85)); --vk-surface: var(--dsw-color-surface, oklch(98% .008 85)); --vk-muted: var(--dsw-color-surface-sunken, oklch(95% .012 85)); --vk-ink: var(--dsw-color-text, oklch(35% .01 85)); --vk-secondary: var(--dsw-color-text-secondary, oklch(48% .012 85)); --vk-hover: var(--dsw-color-surface-hover, oklch(92% .015 85)); --vk-accent: var(--dsw-color-accent, #185FA5); color: var(--vk-ink); }
.vk-figure[data-vk-theme="dark"], .vk-error[data-vk-theme="dark"], :is([data-theme="dark"], [data-color-scheme="dark"], .dark) :is(.vk-figure, .vk-error, .vk-panel, .vk-lightbox) { --vk-border: var(--dsw-color-border, oklch(36% .012 85)); --vk-surface: var(--dsw-color-surface, oklch(23% .008 85)); --vk-muted: var(--dsw-color-surface-sunken, oklch(26% .008 85)); --vk-ink: var(--dsw-color-text, oklch(91% .008 85)); --vk-secondary: var(--dsw-color-text-secondary, oklch(73% .012 85)); --vk-hover: var(--dsw-color-surface-hover, oklch(32% .012 85)); }
.vk-figure { min-width: 0; max-width: 100%; margin: 12px 0 16px; border: 1px solid var(--vk-border); border-radius: 10px; overflow: hidden; background: transparent; }
.vk-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--vk-border); font-size: 12px; background: transparent; }
.vk-bar .vk-label { font-weight: 600; }
.vk-bar .vk-status { margin-left: auto; color: var(--vk-secondary); overflow-wrap: anywhere; }
.vk-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.vk-btn { font: inherit; font-size: 12px; line-height: 1.4; min-width: 30px; min-height: 30px; padding: 4px 8px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: inherit; cursor: pointer; transition: background .18s ease-out, border-color .18s ease-out; }
.vk-btn:hover:not(:disabled) { background: var(--vk-hover); }
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
.vk-source { border-top: 1px solid var(--vk-border); background: transparent; }
.vk-source > summary { list-style: none; background: transparent; cursor: pointer; padding: 8px 12px; font-size: 12px; color: var(--vk-secondary); }
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
/* 独立看图界面：不透明暖深色背景，隔开聊天与侧边栏。 */
.vk-lightbox { position: fixed; inset: 0; z-index: 2147483000; isolation: isolate; overflow: hidden; background: oklch(19% .008 85); font-family: var(--dsw-font-family, system-ui, sans-serif); }
.vk-lightbox-stage { position: absolute; inset: 0; overflow: hidden; cursor: grab; touch-action: none; }
.vk-lightbox-stage:active { cursor: grabbing; }
.vk-lightbox-stage:focus-visible { outline: 2px solid var(--vk-accent); outline-offset: -3px; }
.vk-lightbox-stage > svg { background: var(--vk-surface); border-radius: 8px; position: absolute; left: 50%; top: 50%; transform-origin: center center;
  pointer-events: none; background: var(--vk-surface); border-radius: 6px; box-shadow: 0 14px 44px rgba(0, 0, 0, .5); }
.vk-lightbox-controls { position: absolute; left: 16px; right: 16px; bottom: max(16px, env(safe-area-inset-bottom)); z-index: 2;
  display: flex; flex-direction: column; align-items: center; gap: 10px; pointer-events: none; }
.vk-lightbox-tools { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; max-width: 100%; padding: 8px;
  box-sizing: border-box; border: 1px solid oklch(38% .008 85); border-radius: 12px; background: oklch(24% .008 85); pointer-events: auto; -webkit-app-region: no-drag; }
.vk-lightbox-caption { display: flex; align-items: center; gap: 10px; max-width: 100%; box-sizing: border-box; pointer-events: auto;
  padding: 6px 14px; border-radius: 999px; background: rgba(0, 0, 0, .58); color: #fff; font-size: 12px; }
.vk-lightbox-caption > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vk-lightbox-caption .vk-lightbox-hint { color: rgba(255, 255, 255, .72); }
.vk-lightbox-status { font-variant-numeric: tabular-nums; flex-shrink: 0; }
.vk-lightbox .vk-btn { background: rgba(255, 255, 255, .12); border-color: rgba(255, 255, 255, .26); color: #fff; }

/* 等距展示的图内控件：旋转/剖切在本地重算，不占上下文 */
.vk-iso { display: flex; flex-direction: column; height: 100%; }
.vk-iso-view { flex: 1; min-height: 0; cursor: grab; touch-action: none; }
.vk-iso-view:active { cursor: grabbing; }
.vk-iso-view svg { display: block; width: 100%; height: 100%; }
.vk-iso-controls { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; padding: 6px 0 2px; }
.vk-iso-button { font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 6px;
  border: 1px solid var(--vk-border); background: var(--vk-surface); color: var(--vk-secondary); cursor: pointer; }
.vk-iso-button:hover { background: var(--vk-hover); }
.vk-iso-button:focus-visible { outline: 2px solid var(--vk-accent); outline-offset: 1px; }

.vk-lightbox .vk-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .22); border-color: rgba(255, 255, 255, .45); }
@media (max-width: 640px) { .vk-lightbox-hint { display: none; } .vk-lightbox-controls { bottom: max(12px, env(safe-area-inset-bottom)); gap: 8px; } .vk-lightbox-caption { padding: 5px 12px; } }
@media (prefers-reduced-motion: reduce) { .vk-lightbox-stage > svg { box-shadow: none; } }
@media (max-width: 480px) { .vk-tools { flex-basis: 100%; } .vk-bar { padding: 8px; } .vk-btn { min-height: 36px; } }
@media (pointer: coarse) { .vk-btn, .vk-source > summary { min-height: 44px; box-sizing: border-box; } }
@media (prefers-reduced-motion: reduce) { .vk-btn, .vk-switch-btn, .vk-switch-knob { transition: none !important; } }
`
      if (style.textContent !== css) style.textContent = css
      if (!style.isConnected) document.head.appendChild(style)
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
      injectStyles()
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
      // Keep viewer controls out of the native desktop titlebar hit area.
      const controls = el('div', 'vk-lightbox-controls')
      controls.appendChild(tools)
      controls.appendChild(caption)
      root.appendChild(stage)
      root.appendChild(controls)

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

    /**
     * Whether the language itself asks for the interactive mode.
     *
     * This is deliberately independent of `settings.interactive`: when the user
     * has switched interaction off, the language still *asked*, and the figure
     * says so instead of silently looking like a plain static chart.
     *
     * Read from the manifest so a new interactive renderer needs no edit here.
     *
     * @param {object} spec - the renderer.
     * @param {string} language - the declared fence language.
     * @returns {boolean} true when that language maps to an `interactive` mode.
     */
    function wantsInteractive(spec, language) {
      return spec?.modes?.find((mode) => mode.languages.includes(language))?.id === 'interactive'
    }

    function displayMode(spec, language) {
      const declared = spec.modes?.find((mode) => mode.languages.includes(language))
      const requested = declared?.id ?? spec.modes?.[0]?.id ?? 'static'
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
        record.style === activeStyle().id &&
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
        const retry = button('重试', '再渲染一次这段代码 —— 插件刚修好时用这个，不必刷新页面', () => {
      retry.disabled = true
      status.textContent = '重新渲染…'
      card.remove()
      host.removeAttribute('data-vk-hidden')
      // 清掉上次的成败标记，让这段代码重新走一遍渲染管线
      delete host.dataset.vkHash
      host.dataset.vkState = 'failed'
      const spec = catalogue?.renderers.find((candidate) => candidate.id === options.renderer) ?? null
      const language = host.dataset.vkLanguage ?? spec?.languages?.[0] ?? ''
      // 原来认领它的渲染器就写在卡片上，重试仍走同一条路
      const route = { id: String(options.renderer ?? spec?.id ?? ''), tier: String(options.tier ?? 'content') }
      void launchRender(host, source, language, route)
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
        // auto = 跟随聊天背景（透明）。铺一层自己的面就会和卡片、图底叠成三层。
        view.background === 'auto' ? 'transparent' : view.background === 'dark' ? '#1e1e1e' : view.background
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
            return '常见原因：① 节点文字里有括号、方括号或引号时整段加引号 —— 写 A["文字（含括号）"]，不要写 A[文字（含括号）]；② 节点形状的括号必须成对：[] 矩形、() 圆角、[()] 圆柱、{} 菱形 —— 只有旗形是左开口的 id>文字]，别把方括号塞进旗形（id>["文字"] 会直接 Parse error），要方框就写 id["文字"]；③ 子图标题写成 subgraph 名称["标题"]。'
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
      // 默认在新会话里修：按钮是"上报"，不是"在本会话里起一个任务"
      const repairInNewSession = behaviour.repairInNewSession !== false
      const feedback = button(selfRepair ? '反馈并修复' : '反馈', selfRepair ? (repairInNewSession ? '上报诊断，并开一个新会话让 agent 去修插件（不占用本会话上下文）' : '上报诊断，并让本会话的 agent 去修插件（会占用本会话上下文）') : '把源码与诊断信息复制并上报', async () => {
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
          status.textContent = repairInNewSession ? '已上报，正在新会话里请 agent 修复…' : '已上报，正在请本会话修复…'
          try {
            const { target, id } = await deliverRepair(repairRequest(failure), repairInNewSession)
            status.textContent = target === '新会话'
              ? `已上报，已在新会话 ${id.slice(0, 14)}… 里修复`
              : '已上报，已请本会话修复'
          } catch (error) {
            // 失败也不回退到本会话：那正是"新会话"模式要避免的事
            status.textContent = `已上报（未能拉起修复会话：${friendlyError(error)}）`
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
      const requestedInteractive = wantsInteractive(spec, language)
      let record
      node.dataset.vkState = 'rendering'
      try {
        // Validation precedes both interactive mounting and its static fallback.
        // The renderer owns it: only that renderer knows what its source must satisfy.
        if (requestedInteractive) adapter.validate?.(source, 'interactive', spec)
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
        record = { node, source, language, spec, mode, figure, target, theme: resolveTheme(), style: activeStyle().id, sessionId: currentSessionId,
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
.vk-panel { display: flex; flex-direction: column; gap: 18px; min-width: 0; max-width: 1040px; margin: 0 auto; padding: 8px 0 24px; }
.vk-panel-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px 24px; }
.vk-panel-title { margin: 0 0 4px; font-size: 22px; line-height: 1.4; font-weight: 600; }
.vk-panel-sub { font-size: 13px; color: var(--vk-secondary); line-height: 1.6; }
.vk-settings-section { min-width: 0; display: flex; flex-direction: column; gap: 12px; }
.vk-section-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 20px; }
.vk-section-title { margin: 0; font-size: 16px; font-weight: 600; line-height: 1.5; }
.vk-section-number { color: var(--vk-secondary); font-size: 12px; font-weight: 400; margin-right: 10px; }
.vk-setting-note { margin: 0; max-width: 75ch; font-size: 12px; line-height: 1.7; color: var(--vk-secondary); }
.vk-style-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.vk-style-option { display: flex; min-width: 0; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--vk-border); border-radius: 12px; background: transparent; cursor: pointer; }
.vk-style-option[data-selected="true"] { border-color: var(--vk-accent); box-shadow: 0 0 0 1px var(--vk-accent); }
.vk-style-option:hover:not(:has(input:disabled)), .vk-mode-option:hover:not(:has(input:disabled)) { background: var(--vk-muted); }
.vk-style-option:focus-within, .vk-mode-option:focus-within { outline: 2px solid var(--vk-accent); outline-offset: 3px; }
.vk-style-option:has(input:disabled), .vk-mode-option:has(input:disabled) { cursor: wait; opacity: .65; }
.vk-option-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.vk-option-heading input, .vk-mode-option input { flex: none; margin: 0; width: 16px; height: 16px; accent-color: var(--vk-accent); }
.vk-option-name { font-size: 14px; font-weight: 600; }
.vk-option-state { margin-left: auto; font-size: 11px; color: var(--vk-secondary); white-space: nowrap; }
.vk-style-caption { display: flex; flex-direction: column; gap: 4px; }
.vk-style-summary { font-size: 12px; font-weight: 500; }
.vk-style-preview { display: block; width: 100%; height: auto; border-radius: 6px; }
.vk-mode-options { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0; border: 1px solid var(--vk-border); border-radius: 10px; overflow: hidden; }
.vk-mode-option { display: flex; align-items: flex-start; gap: 10px; padding: 16px; cursor: pointer; background: transparent; }
.vk-mode-option + .vk-mode-option { border-left: 1px solid var(--vk-border); }
.vk-mode-option[data-selected="true"] { background: var(--vk-muted); }
.vk-mode-option:focus-within { outline-offset: -3px; }
.vk-mode-option input { margin-top: 3px; }
.vk-mode-copy { display: flex; flex-direction: column; min-width: 0; gap: 4px; }
.vk-settings-divider { border-top: 1px solid var(--vk-border); padding-top: 24px; }
.vk-settings-advanced { border-top: 1px solid var(--vk-border); padding-top: 20px; }
.vk-settings-advanced > summary { cursor: pointer; font-size: 14px; font-weight: 500; padding: 4px 0; }
.vk-settings-advanced[open] > summary { margin-bottom: 12px; }
.vk-settings-advanced .vk-switch + .vk-switch { border-top: 1px solid var(--vk-border); }
.vk-settings-auto { display: flex; align-items: center; gap: 12px; }
.vk-panel-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); gap: 16px; }
.vk-card { min-width: 0; border: 1px solid var(--vk-border); border-radius: 10px; overflow: hidden; background: transparent; }
.vk-card-head { display: flex; align-items: center; gap: 8px; padding: 14px 16px 8px; }
.vk-card-head .vk-card-title { min-width: 0; overflow-wrap: anywhere; }
.vk-card-fence { display: block; padding: 0 16px 8px; }
.vk-card-title { font-size: 13px; font-weight: 600; }
.vk-card-fence { font-family: var(--dsw-font-mono, ui-monospace, monospace); font-size: 11px; color: var(--vk-secondary); overflow-wrap: anywhere; }
.vk-card-badge { margin-left: auto; font-size: 11px; padding: 1px 7px; border-radius: 999px; border: 1px solid currentColor; opacity: .8; }
.vk-card-usage { padding: 0 16px 12px; font-size: 13px; color: var(--vk-secondary); line-height: 1.6; }
.vk-card-cost { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin-top: 6px; font-size: 11.5px; color: var(--vk-secondary); }
.vk-cost-item b { font-weight: 600; color: var(--vk-text); }
.vk-cost-basis { font-size: 11px; opacity: .8; }
.vk-cost-tag { display: inline-block; margin-left: 8px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 500; color: var(--vk-secondary); background: var(--vk-muted); white-space: nowrap; }
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
.vk-panel-status:empty { visibility: hidden; }
@media (max-width: 680px) {
  .vk-mode-options { grid-template-columns: 1fr; }
  .vk-mode-option + .vk-mode-option { border-left: 0; border-top: 1px solid var(--vk-border); }
}
@media (max-width: 520px) {
  .vk-style-options { grid-template-columns: 1fr; }
  .vk-panel { gap: 24px; }
  .vk-settings-auto { width: 100%; justify-content: space-between; }
  .vk-panel-title { font-size: 20px; }
}
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
          React.createElement('div', { className: 'vk-switch-label' }, props.label, props.tag ?? null),
          React.createElement('div', { className: 'vk-switch-hint' }, props.hint),
        ),
        React.createElement(Toggle, { on: props.on, busy: props.busy, label: props.label, onToggle: props.onToggle }),
      )
    }

    /**
     * What a renderer costs, as two numbers rather than one.
     *
     * Conflating them is what makes a "token cost" label useless: the standing
     * part is paid on every model step whether or not a figure is drawn, while
     * the figure part is paid once per figure. A renderer can be cheap at one
     * and expensive at the other — hand-written SVG is a small standing cost and
     * by far the largest per-figure cost, which is exactly the trade-off the
     * reader needs to see.
     *
     * The character counts and the estimation basis are in the tooltip: the
     * tokens are an estimate, so the number they came from has to be reachable.
     *
     * @param {object} cost - the catalogue's cost entry.
     * @returns {object|null} the React element.
     */
    /**
     * A small price tag for a switch.
     *
     * A switch the user cannot price is a switch they cannot use: "模型侧提示段"
     * sounds free until you know it is the largest standing cost here, and
     * "手写 SVG 优先" sounds like taste until you know it multiplies the
     * per-figure cost by an order of magnitude.
     *
     * @param {string} text - the tag text.
     * @param {string} [tip] - the estimation basis, for the tooltip.
     * @returns {object|null} the React element.
     */
    function costTag(text, tip) {
      if (text === null || text === undefined || text === '') return null
      return React.createElement('span', { className: 'vk-cost-tag', title: tip ?? '' }, text)
    }

    function costLine(cost) {
      if (cost === null || cost === undefined) return null
      const basis = cost.figureBasis ?? '按该渲染器的示例'
      const tip = `每图：${basis}，${cost.figureChars} 字符。常驻：它在每轮提示段里占的份额（栅栏、选型条目与补句），${cost.standingChars} 字符。token 为估算：中文约 1.5 字符/token、其余约 4 字符/token。`
      return React.createElement('div', { className: 'vk-card-cost', title: tip },
        React.createElement('span', { className: 'vk-cost-item' },
          '每图 ≈', React.createElement('b', null, String(cost.figureTokens)), ' tokens'),
        React.createElement('span', { className: 'vk-cost-item' },
          '常驻 ≈', React.createElement('b', null, String(cost.standingTokens)), ' tokens/轮'),
        React.createElement('span', { className: 'vk-cost-basis' }, basis))
    }

    /**
     * A complete miniature explanation: title, sections, hierarchy and legend.
     * It compares the same content in each style, rather than only its palette.
     *
     * @param {object} style - a catalogue style entry.
     * @returns {object} the React element.
     */
    function stylePreview(style) {
      const c = (style.chrome ?? {}).light ?? {}
      const shape = style.shape ?? {}
      const palette = c.palette ?? []
      const id = `vk-style-preview-${style.id}`
      const orthogonal = shape.edge === 'orthogonal'
      const text = (x, y, value, size = 10, strong = false) => React.createElement('text', {
        x, y, fill: strong ? c.title : c.canvasText, fontSize: size, fontWeight: strong ? 600 : 400,
        fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
      }, value)
      const box = (x, y, width, height, fill = c.nodeFill) => React.createElement('rect', {
        x, y, width, height, rx: shape.cardRadius ?? 8, fill,
        stroke: c.nodeBorder, strokeWidth: shape.hairline ?? 0.5,
      })
      return React.createElement('svg', {
        viewBox: '0 0 360 200', width: '360', height: '200', 'aria-hidden': 'true', className: 'vk-style-preview',
        style: { background: (style.surface ?? {}).light ?? STYLE_FALLBACK.surface.light },
      },
        React.createElement('defs', null,
          React.createElement('marker', { id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
            React.createElement('path', { d: 'M2 1L8 5L2 9', fill: 'none', stroke: c.edge, strokeWidth: 1.5, strokeLinecap: 'round' }))),
        text(20, 23, '方案说明', 16, true),
        text(20, 40, '从输入到结果，让结构一目了然', 9),
        orthogonal
          ? React.createElement('g', null,
            box(16, 53, 328, 81),
            text(28, 70, '01  结构与分工', 10, true),
            box(28, 82, 76, 38), box(142, 82, 76, 38), box(256, 82, 76, 38),
            text(40, 99, '输入', 12, true), text(40, 112, '需求与数据', 8),
            text(154, 99, '处理', 12, true), text(154, 112, '分析与组织', 8),
            text(268, 99, '输出', 12, true), text(268, 112, '结论与方案', 8),
            React.createElement('path', { d: 'M104 104 H120 V98 H140 M218 104 H235 V98 H254', fill: 'none', stroke: palette[0], strokeWidth: shape.edgeWidth, strokeLinecap: 'round' }),
            text(20, 153, '02  阅读说明', 10, true),
            text(20, 169, '主流程与补充信息分区呈现', 9))
          : React.createElement('g', null,
            box(20, 60, 138, 108, (style.paper ?? {}).light),
            text(32, 79, '输入与处理', 11, true),
            text(32, 101, '01  整理需求与数据', 10),
            text(32, 123, '02  分析关键关系', 10),
            text(32, 150, '清楚的顺序，适度的留白', 8),
            box(208, 79, 132, 70),
            text(220, 100, '输出方案', 12, true),
            text(220, 120, '突出结论，补充必要说明', 9),
            text(220, 137, '让读者顺着内容理解', 8),
            React.createElement('path', { d: 'M164 114 H200', fill: 'none', stroke: c.edge, strokeWidth: shape.edgeWidth, markerEnd: `url(#${id})` })),
        React.createElement('circle', { cx: 24, cy: 187, r: 3, fill: palette[0] }),
        text(33, 190, '主体信息', 8),
        React.createElement('circle', { cx: 105, cy: 187, r: 3, fill: c.canvasText }),
        text(114, 190, '补充说明', 8),
      )
    }

    /**
     * The capabilities page: every renderer, what it is for, its own output, and
     * the switches that enable it.
     * @returns {object} the React element.
     */
    function CapabilityPanel() {
      const [state, setState] = React.useState({ status: 'loading', specs: [], styles: [], costs: null, switches: null, error: '', busy: '', message: '' })
      const saving = React.useRef(false)
      const savedFocus = React.useRef(null)

      /** Read the catalogue and the switches together. */
      const reload = React.useCallback(async () => {
        const [cat, switches] = await Promise.all([ensureCatalogue(true), fetchSwitches()])
        if (cat === null || switches === null) throw new Error('读取绘图设置失败，请重试。')
        return { specs: cat?.renderers ?? [], styles: cat?.styles ?? [], costs: cat?.costs ?? null, switches }
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

      // Disabled native controls lose focus in Chromium. Restore it after React
      // commits the enabled state, unless the user moved to another control.
      React.useEffect(() => {
        if (state.busy !== '' || savedFocus.current === null) return
        const control = savedFocus.current
        savedFocus.current = null
        if (control.isConnected && !control.disabled && document.activeElement === document.body) {
          control.focus({ preventScroll: true })
        }
      }, [state.busy])

      /**
       * Apply a patch, then refresh what this page shows.
       * @param {object} patch - the configuration patch.
       * @param {string} tag - which control is busy.
       */
      const apply = async (patch, tag) => {
        if (saving.current) return
        saving.current = true
        savedFocus.current = document.activeElement?.closest?.('.vk-panel') ? document.activeElement : null
        setState((previous) => ({ ...previous, busy: tag, error: '', message: '' }))
        try {
          if (patch !== null) await writeSwitches(patch)
          const next = await reload()
          if (started && (patch === null || Object.keys(patch).some(section => section !== 'agent'))) {
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
      const preference = switches?.svgPreference ?? 50
      const drawingMode = preference < 34 ? 'standard' : preference > 66 ? 'svg' : 'auto'
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

      const heading = (number, title, id) => React.createElement('h2', { className: 'vk-section-title', id },
        React.createElement('span', { className: 'vk-section-number', 'aria-hidden': 'true' }, number), title)
      const busy = state.busy !== ''
      const guidanceInactive = switches?.autoRender === false || switches?.promptSection === false && switches?.skill === false

      return React.createElement('div', { className: 'vk-panel', 'aria-busy': busy },
        React.createElement('div', { className: 'vk-panel-head' },
          React.createElement('div', null,
            React.createElement('h1', { className: 'vk-panel-title' }, '墨图 · 可视化'),
            React.createElement('div', { className: 'vk-panel-sub' }, '先选整图风格，再决定用什么方式画。设置自动保存。'),
            React.createElement('div', { className: 'vk-panel-status', role: 'status', 'aria-live': 'polite' }, busy ? '正在保存并同步…' : state.message)),
          switches === null ? null : React.createElement('div', { className: 'vk-settings-auto' },
            React.createElement('span', { className: 'vk-switch-label' }, '自动展示图形'),
            React.createElement(Toggle, { on: switches.autoRender !== false, busy, label: '自动渲染总开关',
              onToggle: () => apply({ behavior: { autoRender: switches.autoRender === false } }, 'autoRender') }))),
        state.error !== '' ? React.createElement('div', { className: 'vk-panel-warn', role: 'alert' }, state.error,
          React.createElement('button', { type: 'button', className: 'vk-toggle', disabled: busy, onClick: () => apply(null, 'retry') }, '重新读取')) : null,
        staleHost ? React.createElement('div', { className: 'vk-panel-warn' },
          '宿主仍是旧版本，预览与设置可能不可用。请完全退出并重新打开 DSH。') : null,
        switches === null ? null : React.createElement(React.Fragment ?? 'div', null,
          React.createElement('section', { className: 'vk-settings-section', 'aria-labelledby': 'vk-style-label' },
            React.createElement('div', { className: 'vk-section-head' },
              heading('01', '生成风格', 'vk-style-label'),
              React.createElement('span', { className: 'vk-setting-note' }, '影响整图设计，不只是颜色')),
            React.createElement('div', { className: 'vk-style-options', role: 'radiogroup', 'aria-labelledby': 'vk-style-label', 'aria-describedby': 'vk-style-hint' },
              ...(state.styles ?? []).map(style => React.createElement('label', {
                key: style.id, className: 'vk-style-option', 'data-selected': style.active === true,
              },
                React.createElement('span', { className: 'vk-option-heading' },
                  React.createElement('input', { type: 'radio', name: 'vk-style', value: style.id,
                    checked: style.active === true, disabled: busy,
                    'aria-labelledby': `vk-style-${style.id}`, 'aria-describedby': `vk-style-${style.id}-hint`,
                    onChange: () => apply({ presentation: { style: style.id } }, 'style') }),
                  React.createElement('span', { id: `vk-style-${style.id}`, className: 'vk-option-name' }, style.label),
                  React.createElement('span', { className: 'vk-option-state', 'aria-hidden': 'true' }, style.active ? '已选用' : '选择风格')),
                stylePreview(style),
                React.createElement('span', { className: 'vk-style-caption' },
                  React.createElement('span', { className: 'vk-style-summary' }, style.summary),
                  React.createElement('span', { id: `vk-style-${style.id}-hint`, className: 'vk-setting-note' }, style.description))))),
            React.createElement('p', { id: 'vk-style-hint', className: 'vk-setting-note' },
              state.costs == null
                ? '指导后续生成图的构图、排版、配色与标注。已有引擎图更新其支持的外观；已有手写 SVG 保留原样，换风格需重新生成。'
                : `指导后续生成图的构图、排版、配色与标注。已有引擎图更新其支持的外观；已有手写 SVG 保留原样，换风格需重新生成。非默认风格会在每轮提示段里多占约 ${state.costs.style.nonDefaultTokens} tokens（默认风格不额外付费）。`),
            guidanceInactive ? React.createElement('p', { className: 'vk-setting-note' }, '生成指引当前未启用，风格会保存；开启自动展示与至少一种模型指引后用于后续生成。') : null),
          React.createElement('section', { className: 'vk-settings-section vk-settings-divider', 'aria-labelledby': 'vk-drawing-mode-label' },
            heading('02', '绘图方式', 'vk-drawing-mode-label'),
            React.createElement('div', { className: 'vk-mode-options', role: 'radiogroup', 'aria-labelledby': 'vk-drawing-mode-label', 'aria-describedby': 'vk-drawing-mode-hint' },
              ...[
                { id: 'auto', value: 50, label: '自动选择', hint: '按内容选合适的画法，不确定时选这个。',
                  cost: state.costs == null ? '' : `每图 ${state.costs.svgPreference.engine}–${state.costs.svgPreference.svg} tokens（看任务）` },
                { id: 'standard', value: 20, label: '常规图表优先', hint: '让引擎负责布局，适合流程、架构和数据图。',
                  cost: state.costs == null ? '' : `每图 ≈${state.costs.svgPreference.engine} tokens` },
                { id: 'svg', value: 80, label: '手写 SVG 优先', hint: '让模型设计整图，适合定制排版与精细插图。',
                  cost: state.costs == null ? '' : `每图 ≈${state.costs.svgPreference.svg} tokens（最贵的一档）` },
              ].map(mode => React.createElement('label', { key: mode.id, className: 'vk-mode-option', 'data-selected': drawingMode === mode.id },
                React.createElement('input', { type: 'radio', name: 'vk-drawing-mode', value: mode.id,
                  checked: drawingMode === mode.id, disabled: busy,
                  'aria-labelledby': `vk-drawing-mode-${mode.id}`, 'aria-describedby': `vk-drawing-mode-${mode.id}-hint`,
                  onChange: () => apply({ agent: { svgPreference: mode.value } }, 'svgPreference') }),
                React.createElement('span', { className: 'vk-mode-copy' },
                  React.createElement('span', { id: `vk-drawing-mode-${mode.id}`, className: 'vk-switch-label' }, mode.label),
                  React.createElement('span', { id: `vk-drawing-mode-${mode.id}-hint`, className: 'vk-setting-note' }, mode.hint),
                  mode.cost === undefined || mode.cost === ''
                    ? null
                    : costTag(mode.cost, '按各渲染器的示例估算的"每图"成本；token 为估算（中文约 1.5 字符/token、其余约 4）。'))))),
            React.createElement('p', { className: 'vk-setting-note', id: 'vk-drawing-mode-hint' },
              '绘图方式决定如何实现，生成风格决定如何设计。用于后续生成，对话中明确指定的画法优先。'),
            !specs.some(spec => spec.id === 'svg' && spec.enabled)
              ? React.createElement('p', { className: 'vk-setting-note' }, '手写 SVG 已关闭，相关偏好暂不参与选型。') : null)),
        React.createElement('section', { className: 'vk-settings-section vk-settings-divider', 'aria-labelledby': 'vk-renderers-label' },
          React.createElement('div', { className: 'vk-section-head' },
            heading('03', '展示能力', 'vk-renderers-label'),
            React.createElement('span', { className: 'vk-setting-note' }, `已启用 ${enabledCount} / ${specs.length} 种`)),
          switches === null ? null : React.createElement('div', { className: 'vk-bulk' },
            React.createElement('span', { className: 'vk-bulk-label' }, '预览由真实渲染器生成'),
            React.createElement('button', { type: 'button', className: 'vk-toggle', disabled: busy || allOn, onClick: () => setAll(true) }, '全部启用'),
            React.createElement('button', { type: 'button', className: 'vk-toggle', disabled: busy || enabledCount === 0, onClick: () => setAll(false) }, '全部关闭')),
          React.createElement('div', { className: 'vk-panel-grid' }, specs.map(spec => React.createElement('div', { className: 'vk-card', key: spec.id },
            React.createElement('div', { className: 'vk-card-head' },
              React.createElement('span', { className: 'vk-card-title' }, spec.label),
              React.createElement(Toggle, { on: spec.enabled === true, busy,
                label: `${spec.label}：${spec.enabled ? '已启用，点击关闭' : '已关闭，点击启用'}`,
                onToggle: () => apply({ renderers: { [spec.id]: { enabled: spec.enabled !== true } } }, spec.id) })),
            React.createElement('span', { className: 'vk-card-fence' }, (spec.languages ?? []).slice(0, 2).map(l => `\`\`\`${l}`).join(' ')),
            React.createElement('div', { className: 'vk-card-usage' }, spec.usage ?? ''),
            costLine(spec.cost),
            React.createElement(RendererPreview, { spec }))))),
        switches === null ? null : React.createElement('details', { className: 'vk-settings-advanced' },
          React.createElement('summary', null, '高级设置 · 交互、模型指引与反馈'),
          React.createElement(SwitchRow, { label: 'ECharts 交互模式',
            hint: '开启悬停数值、图例筛选与区间缩放。关闭后交互代码块显示为静态图，普通 echarts 不受影响。',
            on: switches.interactive !== false, busy,
            onToggle: () => apply({ renderers: { echarts: { interactive: switches.interactive === false } } }, 'interactive') }),
          React.createElement(SwitchRow, { label: '模型侧提示段',
            tag: state.costs == null ? null : costTag(`常驻 ≈${state.costs.promptSection.tokens} tokens/轮`, `关闭后这一整段不再发送：${state.costs.promptSection.chars} 字符。token 为估算（中文约 1.5 字符/token、其余约 4）。`),
            hint: '提醒模型主动配图，并传递绘图方式与当前生成风格。这是本插件最大的一项常驻开销。',
            on: switches.promptSection !== false, busy,
            onToggle: () => apply({ agent: { promptSection: switches.promptSection === false } }, 'promptSection') }),
          React.createElement(SwitchRow, { label: 'dsh-visualization 技能',
            tag: state.costs == null ? null : costTag(`摘要 ≈${state.costs.skill.summaryTokens}/轮 · 正文按需 ≈${state.costs.skill.bodyTokens}`, `技能注册后始终可见的是名称与摘要（${state.costs.skill.summaryChars} 字符）；正文 ${state.costs.skill.bodyChars} 字符只在模型决定画图时读取。`),
            hint: '供模型按需读取语法、整图风格规范与示例。摘要常驻，正文按需。',
            on: switches.skill !== false, busy,
            onToggle: () => apply({ agent: { skill: switches.skill === false } }, 'skill') }),
          React.createElement(SwitchRow, { label: '反馈后在后台新会话里修',
            hint: '点「反馈并修复」时开一个新会话（复制本会话作为上下文）去修插件，本会话不受影响；关闭则直接把修复请求投给本会话，会占用本会话上下文。',
            on: switches.repairInNewSession !== false, busy,
            onToggle: () => apply({ behavior: { repairInNewSession: switches.repairInNewSession === false } }, 'repairInNewSession') }),
          React.createElement(SwitchRow, { label: '反馈时让 agent 直接修',
            hint: '关闭后按钮只记录反馈并复制源码与诊断，不拉起任何会话。',
            on: switches.selfRepair !== false, busy,
            onToggle: () => apply({ behavior: { selfRepair: switches.selfRepair === false } }, 'selfRepair') })),
        React.createElement('div', { className: 'vk-panel-note' },
          '自动展示关闭后，对话恢复源码。字号、画布高度与完整性校验可在插件配置页调整。'),
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
     * This mode **spends the conversation's own context**: it appends a turn to
     * the user's history. `promptForkedSession` exists because that is usually
     * not what the user asked for — they pressed "report", not "start a task in
     * this conversation".
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
     * Deliver the repair request into a NEW session, leaving this conversation
     * alone.
     *
     * A repair is a side quest: it needs the failure, the plugin path and the
     * fix procedure — not this conversation. Delivering it here would append a
     * turn to the user's own history and spend their context on a task they only
     * asked to be *recorded*.
     *
     * Forking is the supported way to get that: the child is a real session with
     * this conversation as its context (so the repair agent can see the figure
     * that failed), it runs on its own, and it shows up in the workspace as a
     * separate session the user can open, watch or ignore.
     *
     * `allowMigration: false` matters: a fork must copy, never move the source.
     *
     * @param {string} text - the repair request.
     * @returns {Promise<string>} the new session id.
     */
    async function promptForkedSession(text) {
      const sessions = clientCtx?.get?.('sessions')
      if (sessions === undefined || sessions === null) throw new Error('sessions 服务不可用')
      if (currentSessionId === '') throw new Error('还没拿到本会话 id（请在本会话里先完成一轮对话）')
      if (typeof sessions.fork !== 'function') throw new Error('当前版本不支持开新会话')
      const childId = await sessions.fork({ sessionId: currentSessionId, increaseTitle: true, allowMigration: false })
      await sessions.using(childId, { source: 'controllerOperation' }, async (reference) => {
        const session = reference?.binding?.session
        if (session === undefined || session === null) throw new Error('新会话句柄不可用')
        const result = await session.prompt([{ type: 'text', text }], 'queue')
        if (result?.ok !== true) throw new Error(result?.error?.message ?? '投递被拒绝')
      })
      return String(childId)
    }

    /**
     * Hand a repair request to whichever target the user configured.
     *
     * There is deliberately **no fallback** from the new-session mode to the
     * current session: quietly spending the conversation's context is exactly
     * what that mode exists to prevent. A failure is reported instead.
     *
     * @param {string} text - the repair request.
     * @param {boolean} inNewSession - whether to use a fork.
     * @returns {Promise<{target: string, id: string}>} where it went.
     */
    async function deliverRepair(text, inNewSession) {
      if (inNewSession !== true) {
        await promptSession(text)
        return { target: '本会话', id: currentSessionId }
      }
      const id = await promptForkedSession(text)
      return { target: '新会话', id }
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
    '',
    '最后必须以下面两种形式之一收尾，插件会读它来回填原会话里那张失败的图：',
    '- 这段语法本来就写错了 → 用一行「【修正后的源码】」，紧跟一个同语言的栅栏，栅栏里只放修正后的源码；',
    '- 改的是插件本身、源码不用动 → 用一行「【无需改源码】」。',
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
        const styleBefore = activeStyle().id
        void refreshCatalogueIfChanged().then((changed) => {
          if (!changed) return
          log('catalogue changed', { enabled: diag.enabled, style: activeStyle().id })
          // 换风格要重绘已有图：scan 会跳过已渲染的块（它们的源码哈希没变），
          // 只有 rerenderAll 会把旧图作废重画 —— 与换主题走同一条路。
          if (activeStyle().id !== styleBefore) void rerenderAll()
          else scheduleScan()
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
      // 失败时给用户的修复提示：文本本身要有回归测试，避免又退回一句空话
      fixHint,
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
      // 产物要能被严格 XML 解析（导出文件与 GitHub <img> 的前提）
      xmlSafeFontFamily,
      // 自绘渲染器工具箱与等距基座：扩展位的公共接口，逐项单测
      escapeXml,
      themeTokens,
      tokenColor,
      shadeColor,
      enforceLimits,
      svgDocument,
      svgPath,
      svgLegend,
      svgCallout,
      isoProject,
      isoOrderFaces,
      isoDraw,
      isoVoxelFaces,
      registerIsoKind,
      ISO_KINDS,
      // 视觉风格：兜底表、解析与几何语汇
      STYLE_FALLBACK,
      activeStyle,
      styleShape,
      // 测试接缝：注入目录，避免单测去起一个 HTTP 夹具
      setCatalogue(value) { catalogue = value },
      // 关系检查：可单测，也可由 check:renderers 跑在所有示例上
      isoAudit,
      // 修复投递：单测要能验证"去了哪个会话"，而不用真的起 agent
      deliverRepair,
      promptForkedSession,
      promptSession,
      setClientCtx(value) { clientCtx = value },
      setCurrentSessionId(value) { currentSessionId = value },
      stylePreview,
      costLine,
      costTag,
    }
    return module.exports
  },
})
