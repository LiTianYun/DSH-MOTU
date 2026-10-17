/**
 * Visual styles — the single source of truth for how a figure looks.
 *
 * A style is orthogonal to a renderer: the renderer decides *what* is drawn
 * (a flowchart, a chart, an isometric cutaway), the style decides how it reads
 * — colour temperature, semantic colour count, line weight, corner radius, and
 * the edge vocabulary. The user picks one in plugin settings; the choice then
 * drives
 *
 *   - the chrome (text, borders, grids, palette) every renderer draws with,
 *   - the canvas surface and paper of the self-drawn renderers,
 *   - the guidance the model is given when it hand-writes SVG, so a hand-authored
 *     figure comes out in the same style as an engine-drawn one.
 *
 * Adding a style is one entry here: the settings picker, the standing prompt
 * line, the catalogue the browser reads and the skill section are all derived
 * from this list.
 *
 * @module dsh-visual-kit/styles
 */

/**
 * One visual style.
 *
 * @typedef {object} StyleSpec
 * @property {string} id - stable id: config value, catalogue key.
 * @property {string} label - shown in the settings picker.
 * @property {string} summary - a few words for the picker and the prompt line.
 * @property {string} description - one sentence: what it is for.
 * @property {{light: object, dark: object}} chrome - full chrome tables, shaped
 *   exactly like the built-in one so `chrome()` can return them directly.
 * @property {{light: string, dark: string}} surface - canvas background of the
 *   self-drawn renderers.
 * @property {{light: string, dark: string}} paper - secondary surface (panels,
 *   inset areas) of the self-drawn renderers.
 * @property {{hairline: number, cardRadius: number, panelRadius: number, edgeWidth: number, edge: 'open'|'orthogonal'}} shape -
 *   the geometry vocabulary.
 * @property {Record<string, string>} named - semantic colour tokens (blue / red /
 *   green / amber / purple / teal). Declared per style rather than read from
 *   `palette` by position: a positional read once made "green" resolve to a blue
 *   and "purple" to a red in a two-colour style, which is worse than useless.
 * @property {string[]} swatches - preview colours for the settings picker.
 * @property {string} guidance - what the model must do to match this style when
 *   it hand-writes SVG. Kept short: it is paid for on every model step.
 */

/** @type {StyleSpec[]} */
export const styles = [
  {
    id: 'motu',
    label: '墨图默认',
    summary: '暖中性 · 多语义色',
    description: '纸感暖灰底，颜色即含义（新增/推荐/问题/部分/进阶），发丝边框，开放箭头。适合讲解与方案对照。',
    chrome: {
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
    },
    surface: { light: '#FFFFFF', dark: '#1E1E1C' },
    paper: { light: '#F1EFE8', dark: '#2A2A28' },
    named: { blue: '#185FA5', red: '#A32D2D', green: '#3B6D11', amber: '#BA7517', purple: '#534AB7', teal: '#0F6E56' },
    shape: { hairline: 0.5, cardRadius: 8, panelRadius: 12, edgeWidth: 1.5, edge: 'open' },
    swatches: ['#185FA5', '#3B6D11', '#A32D2D', '#BA7517', '#534AB7'],
    guidance:
      '暖中性纸感底（#F1EFE8 / #FFFFFF），颜色即含义：蓝 #185FA5 新增或目标、绿 #3B6D11 推荐、红 #A32D2D 问题、琥珀 #BA7517 部分、紫 #534AB7 进阶、暖灰 #B4B2A9 现状。卡片 rx=8、边框 0.5px 发丝线、开放箭头、字号 11/12/13/14（卡题 500）。',
  },
  {
    id: 'blueprint',
    label: '工程图纸',
    summary: '冷灰蓝 · 双色线型 · 正交连线',
    description: '仪表盘冷灰蓝底，颜色只区分线缆/链路类型，节点用主副两级标题，连线走正交折线。适合接线、拓扑、部署与管道类图纸。',
    chrome: {
      light: {
        nodeFill: '#FFFFFF',
        nodeBorder: '#DBE3EB',
        nodeText: '#22303F',
        edge: '#5D6B7A',
        edgeText: '#5D6B7A',
        labelBg: '#FFFFFF',
        noteFill: '#EEF2F7',
        noteText: '#155F9E',
        canvasText: '#5D6B7A',
        title: '#22303F',
        grid: '#EEF2F7',
        palette: ['#1F6FB2', '#C8382B', '#155F9E', '#A82C20', '#3F6F8F', '#8A97A6', '#2B7F7A', '#7A5EA8'],
      },
      dark: {
        nodeFill: '#1C2632',
        nodeBorder: '#33404F',
        nodeText: '#DBE4EE',
        edge: '#7D8B9A',
        edgeText: '#93A1B0',
        labelBg: '#1C2632',
        noteFill: '#243040',
        noteText: '#7FB2E0',
        canvasText: '#93A1B0',
        title: '#E8EEF5',
        grid: '#26313D',
        palette: ['#4F9FD8', '#E06255', '#7FB2E0', '#D97A6E', '#6FA8C8', '#93A1B0', '#4FB3AC', '#A58FD0'],
      },
    },
    // 冷灰蓝页面底是这套风格最有辨识度的特征：画布用页面色、卡片才是白的
    surface: { light: '#F4F6F9', dark: '#161E27' },
    paper: { light: '#FFFFFF', dark: '#1C2632' },
    named: { blue: '#1F6FB2', red: '#C8382B', green: '#2B7F7A', amber: '#B7791F', purple: '#7A5EA8', teal: '#2B7F7A' },
    shape: { hairline: 1, cardRadius: 10, panelRadius: 12, edgeWidth: 2.5, edge: 'orthogonal' },
    swatches: ['#C8382B', '#1F6FB2'],
    guidance:
      '冷灰蓝底（页面 #F4F6F9、卡片 #FFFFFF），正文 #22303F、次要 #5D6B7A。**颜色只表示链路类型**：红 #C8382B 电力（带箭头表方向）、蓝 #1F6FB2 数据（无箭头，双向）。节点白底 rx=10、1px 边框 #DBE3EB，**主标 19px/600 + 副标 12.5px** 两级。连线走**正交折线**（只走横竖，2.5px 圆头），电压/接口写在线上并用对应语义色 13.5px/600。分区用左上角小灰字标。',
  },
]

/**
 * The style a config selects, falling back to the first entry.
 *
 * An unknown id (a hand-edited config, or a style removed in an upgrade) must
 * never break rendering, so it degrades to the default instead of throwing.
 *
 * @param {object} [config] - the plugin configuration.
 * @returns {StyleSpec} the style.
 */
export function styleFor(config) {
  const id = config?.presentation?.style
  return styles.find((style) => style.id === id) ?? styles[0]
}

/**
 * The catalogue entry the browser and the settings picker need.
 *
 * The full chrome tables travel with it: the browser half must draw with the
 * selected style, and shipping a second copy of these tables inside
 * `lib/client.js` would let the two drift apart. The client keeps only the
 * default style as a fallback for the moment before the catalogue arrives, and
 * a test pins that fallback to this list.
 *
 * @param {StyleSpec} style - the style.
 * @param {string} activeId - the currently selected style id.
 * @returns {object} the entry.
 */
export function styleEntry(style, activeId) {
  return {
    id: style.id,
    label: style.label,
    summary: style.summary,
    description: style.description,
    swatches: style.swatches,
    active: style.id === activeId,
    chrome: style.chrome,
    named: style.named,
    surface: style.surface,
    paper: style.paper,
    shape: style.shape,
  }
}
