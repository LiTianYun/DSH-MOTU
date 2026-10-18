/** Run real Chromium interaction and failure tests. npm run check:ui */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startUiFixture, chartSamples } from './ui-fixture.mjs'

const out = fileURLToPath(new URL('../.scratch/ui-check/', import.meta.url))
await mkdir(out, { recursive: true })
const fixture = await startUiFixture()
let browser
const checks = []
try {
  browser = await chromium.launch({ headless: true, ...(process.env.MOTU_CHROMIUM_PATH ? { executablePath: process.env.MOTU_CHROMIUM_PATH } : {}) })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(fixture.url)
  // 图数量从目录推导：每加一个渲染器，夹具就多一块静态图（另有 3 块 live 交互图）
  const readyFigures = await page.evaluate(async () => {
    const catalogue = await (await fetch('/dsh-visual-kit/renderers.json')).json()
    return catalogue.renderers.length + 3
  })
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.vk-figure[data-vk-display-state="ready"]').length === expected,
    readyFigures,
  )
  assert.equal(await page.locator('#live-bar .vk-figure').getAttribute('data-vk-mode'), 'interactive')
  assert.equal(await page.locator('#static-echarts .vk-figure').getAttribute('data-vk-mode'), 'static')
  checks.push('六个静态引擎与柱/线/饼交互图真实挂载')

  // Observe lifecycle on the real ECharts instances, without replacing rendering.
  await page.evaluate(() => {
    window.lifecycle = { mounted: 0, disposed: 0, static: 0 }
    const init = echarts.init
    echarts.init = function(target, theme, options) {
      if (target && window.failMount) { window.failMount--; throw new Error('测试挂载失败') }
      if (!target && window.failStatic) { window.failStatic--; throw new Error('测试静态失败') }
      if (!target) lifecycle.static++
      const instance = init(target, theme, options)
      if (target) lifecycle.mounted++
      const dispose = instance.dispose.bind(instance)
      instance.dispose = () => { lifecycle.disposed++; dispose() }
      return instance
    }
    window.chartOf = id => echarts.getInstanceByDom(document.querySelector('#'+id+' .vk-mount'))
  })

  for (const id of ['live-bar', 'live-line', 'live-pie']) {
    const mount = page.locator(`#${id} .vk-mount`)
    await mount.scrollIntoViewIfNeeded()
    const box = await mount.boundingBox()
    const point = await page.evaluate(id => {
      const chart = chartOf(id)
      if (id === 'live-bar') {
        const p = chart.getModel().getSeriesByIndex(0).getData().getItemLayout(0)
        return [p.x + p.width/2, p.y + p.height/2]
      }
      if (id === 'live-pie') {
        const p = chart.getModel().getSeriesByIndex(0).getData().getItemLayout(0)
        const angle = (p.startAngle + p.endAngle) / 2
        const radius = (p.r + p.r0) / 2
        return [p.cx + Math.cos(angle)*radius, p.cy + Math.sin(angle)*radius]
      }
      return chart.convertToPixel({ seriesIndex: 0 }, ['2日', 4])
    }, id)
    await page.mouse.move(box.x + point[0], box.y + point[1])
    await page.waitForFunction(id => chartOf(id)._componentsViews.find(view => view.type === 'tooltip')._tooltipContent.isShow(), id)
    assert.equal(await page.evaluate(id => chartOf(id).getOption().tooltip[0].renderMode, id), 'richText')
    console.log(`ok 悬停 ${id}`)
  }
  checks.push('真实鼠标悬停展示 richText 数值提示')
  await page.mouse.move(0, 0)
  await page.locator('#live-bar svg text').filter({ hasText: /^销量$/ }).first().click()
  await page.waitForFunction(() => chartOf('live-bar').getOption().legend[0].selected['销量'] === false)
  await page.locator('#live-bar').getByRole('button', { name: '重置图表' }).click()
  await page.waitForFunction(() => chartOf('live-bar').getOption().legend[0].selected['销量'] !== false)
  checks.push('图例筛选与重置通过真实控件操作')
  const line = page.locator('#live-line .vk-mount')
  await line.scrollIntoViewIfNeeded()
  const lineBox = await line.boundingBox()
  await page.mouse.move(lineBox.x + lineBox.width/2, lineBox.y + 120)
  await page.mouse.wheel(0, -300)
  await page.waitForFunction(() => chartOf('live-line').getOption().dataZoom[0].end - chartOf('live-line').getOption().dataZoom[0].start < 100)
  await page.locator('#live-line').getByRole('button', { name: '重置图表' }).click()
  await page.waitForFunction(() => chartOf('live-line').getOption().dataZoom[0].start === 0 && chartOf('live-line').getOption().dataZoom[0].end === 100)
  checks.push('滚轮区间缩放与重置恢复原始范围')
  const downloadEvent = page.waitForEvent('download')
  await page.locator('#live-bar').getByRole('button', { name: '下载 SVG' }).click()
  const download = await downloadEvent
  await download.saveAs(join(out, 'interactive.svg'))
  checks.push('当前交互图可导出 SVG')

  await page.setViewportSize({ width: 375, height: 812 })
  await page.waitForFunction(() => chartOf('live-bar').getWidth() <= 350)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(out, 'mobile-light.png'), fullPage: true })
  await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
  // 数量从目录推导：每加一个渲染器，夹具就多一块静态图
  const expectedFigures = await page.evaluate(async () => {
    const catalogue = await (await fetch('/dsh-visual-kit/renderers.json')).json()
    return catalogue.renderers.length + 3
  })
  await page.waitForFunction(
    (expected) => document.querySelectorAll('.vk-figure[data-vk-theme="dark"][data-vk-display-state="ready"]').length === expected,
    expectedFigures,
  )
  await page.screenshot({ path: join(out, 'mobile-dark.png'), fullPage: true })
  checks.push('375px 窄屏 resize 与主题重建正常，无页面横向溢出')

  await page.evaluate(option => addBlock('hidden', 'echarts-interactive', JSON.stringify(option), true), chartSamples.bar)
  await page.waitForFunction(() => document.querySelector('#hidden .vk-figure')?.dataset.vkDisplayState === 'loading')
  assert.equal(await page.evaluate(() => echarts.getInstanceByDom(document.querySelector('#hidden .vk-mount'))), undefined)
  await page.evaluate(() => document.querySelector('#hidden').style.display = '')
  await page.waitForFunction(() => document.querySelector('#hidden .vk-figure')?.dataset.vkDisplayState === 'ready')
  checks.push('隐藏容器不初始化，恢复尺寸后自动挂载')

  await page.evaluate(option => { window.failMount = 1; addBlock('fallback', 'echarts-interactive', JSON.stringify(option)) }, chartSamples.bar)
  await page.waitForFunction(() => document.querySelector('#fallback .vk-figure')?.dataset.vkDisplayState === 'fallback')
  assert.match(await page.locator('#fallback .vk-fallback').innerText(), /测试挂载失败/)
  await page.locator('#fallback').getByRole('button', { name: '把源码与诊断信息复制并上报' }).click()
  await page.waitForFunction(() => document.querySelector('#fallback .vk-status').textContent.includes('已上报'))
  const report = await (await page.request.get(fixture.url + '/dsh-visual-kit/diag')).json()
  assert.equal(report.value.reports[0].mode, 'interactive')
  assert.equal(report.value.reports[0].phase, 'mount')
  checks.push('挂载失败静态降级，真实诊断路由保留失败模式与阶段')
  await page.evaluate(option => { window.failMount = 1; window.failStatic = 1; addBlock('failure', 'echarts-interactive', JSON.stringify(option)) }, chartSamples.bar)
  await page.waitForFunction(() => document.querySelector('#failure pre')?.dataset.vkState === 'failed')
  assert.equal(await page.locator('#failure pre:visible').count(), 1)
  assert.match(await page.locator('#failure .vk-error').innerText(), /测试静态失败/)
  checks.push('降级再次失败保留源码与错误说明')

  const before = await page.evaluate(() => lifecycle.static)
  await page.evaluate(option => addBlock('timeout', 'echarts-interactive', JSON.stringify(option), true), chartSamples.bar)
  await page.waitForFunction(() => document.querySelector('#timeout .vk-figure')?.dataset.vkDisplayState === 'fallback', undefined, { timeout: 20_000 })
  assert.equal(await page.evaluate(() => lifecycle.static), before + 1)
  checks.push('真实 15 秒初始化超时只静态降级一次')
  await page.evaluate(() => { const code = document.querySelector('#live-bar pre code'); code.textContent = '{"series":[]}'; code.textContent = JSON.stringify({series:[{type:'pie',data:[1,2]}]}) })
  await page.waitForFunction(() => chartOf('live-bar')?.getOption().series[0].type === 'pie')
  await page.evaluate(() => motu.internals.SessionProbe({ sessionId: 'second-session' }))
  await page.waitForFunction(() => document.querySelectorAll('.vk-figure[data-vk-display-state="loading"]').length === 0)
  checks.push('快速源码更新与会话切换不保留旧实例')
  const blocked = await browser.newPage()
  let requests = 0
  await blocked.route('**/assets/echarts/**', route => { requests++; return route.abort() })
  await blocked.goto(fixture.url + '/?onlyLive')
  await blocked.waitForFunction(() => document.querySelectorAll('pre[data-vk-state="failed"]').length === 3)
  assert.equal(await blocked.locator('pre:visible').count(), 3)
  assert.ok(requests >= 1)
  await blocked.close()
  checks.push('真实引擎加载失败保留三份源码，不无限重试')
  // Reproduce a live upgrade from a client whose retained stylesheet predates
  // the viewer. A fresh-page-only test misses this failure in the real host.
  const upgraded = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await upgraded.goto(fixture.url + '/?onlyLive')
  await upgraded.waitForSelector('.vk-figure[data-vk-display-state="ready"]')
  await upgraded.evaluate(() => {
    stopMotu()
    document.getElementById('dsh-visual-kit-styles').textContent = '.vk-figure { border: 1px solid gray; }'
  })
  await upgraded.addScriptTag({ url: fixture.url + '/client.js' })
  await upgraded.evaluate(() => {
    motu.apply({ effect(fn) { window.stopUpgradedMotu = fn() }, get() {} })
    motu.internals.SessionProbe({ sessionId: 'upgraded-session' })
  })
  await upgraded.waitForSelector('.vk-figure[data-vk-display-state="ready"]')
  // Native desktop window controls sit above web content. Reproduce their hit
  // area without invoking real minimize/maximize/close operations.
  await upgraded.evaluate(() => {
    const native = document.createElement('button')
    native.id = 'fixture-native-window-controls'
    native.textContent = '—  □  ×'
    native.style.cssText = 'position:fixed;top:0;right:0;width:150px;height:40px;z-index:2147483647;background:#f4f3ef;color:#444441;border:0'
    window.nativeWindowCloseHits = 0
    native.onclick = () => window.nativeWindowCloseHits++
    document.body.append(native)
  })
  await upgraded.locator('#live-bar [data-vk-action="expand"]').click()
  const upgradedView = await upgraded.evaluate(() => {
    const root = document.querySelector('.vk-lightbox'), style = getComputedStyle(root), box = root.getBoundingClientRect()
    const pixel = document.createElement('canvas')
    pixel.width = pixel.height = 1
    const context = pixel.getContext('2d')
    context.fillStyle = style.backgroundColor
    context.fillRect(0, 0, 1, 1)
    return { position: style.position, background: style.backgroundColor, opacity: style.opacity,
      alpha: context.getImageData(0, 0, 1, 1).data[3],
      box: [box.x, box.y, box.width, box.height], viewport: [innerWidth, innerHeight],
      styles: document.querySelectorAll('#dsh-visual-kit-styles').length }
  })
  assert.equal(upgradedView.position, 'fixed', '热更新后仍须为独立看图层')
  assert.deepEqual(upgradedView.box, [0, 0, ...upgradedView.viewport], '必须覆盖整个窗口')
  assert.equal(upgradedView.opacity, '1')
  assert.equal(upgradedView.styles, 1)
  assert.equal(upgradedView.alpha, 255, `背景应完全不透明，实际 ${upgradedView.background}`)
  for (const width of [1280, 375]) {
    await upgraded.setViewportSize({ width, height: 900 })
    const controls = await upgraded.evaluate(() => {
      const native = document.getElementById('fixture-native-window-controls').getBoundingClientRect()
      return [...document.querySelectorAll('.vk-lightbox-tools button')].map(button => {
        const box = button.getBoundingClientRect()
        return { label: button.getAttribute('aria-label'),
          overlap: box.left < native.right && box.right > native.left && box.top < native.bottom && box.bottom > native.top,
          onScreen: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight }
      })
    })
    for (const control of controls) {
      assert.equal(control.overlap, false, `${width}px：${control.label} 不能与原生窗口控件重叠`)
      assert.equal(control.onScreen, true, `${width}px：${control.label} 必须完整可见`)
    }
  }
  await upgraded.screenshot({ path: join(out, 'lightbox-upgrade.png') })
  await upgraded.getByRole('button', { name: '关闭放大展示（Esc）', exact: true }).click()
  assert.equal(await upgraded.locator('.vk-lightbox').count(), 0)
  assert.equal(await upgraded.evaluate(() => nativeWindowCloseHits), 0, '看图关闭按钮不能触发窗口关闭')
  assert.equal(await upgraded.evaluate(() => document.body.style.overflow), '')
  await upgraded.evaluate(() => stopUpgradedMotu())
  await upgraded.close()
  checks.push('旧样式热更新后放大全屏且完全不透底，关闭恢复页面')
  checks.push('1280px 与 375px 下看图控件避开原生窗口按钮，可独立点击关闭')

  // 放大展示：密集的图在 360px 画布里缩到看不清，这条走真实鼠标与键盘。
  const enlarge = page.locator('#static-echarts [data-vk-action="expand"]')
  await enlarge.scrollIntoViewIfNeeded()
  await enlarge.click()
  await page.waitForSelector('.vk-lightbox[role="dialog"]')
  const stage = page.locator('.vk-lightbox-stage')
  const snapshotSvg = page.locator('.vk-lightbox-stage > svg')
  assert.equal(await snapshotSvg.count(), 1)
  assert.ok((await snapshotSvg.innerHTML()).length > 50, '快照应带真实图形内容')
  // 图形必须真的铺在深色底上：面板透明会让页面内容透出来
  const surfaces = await page.evaluate(() => {
    const root = document.querySelector('.vk-lightbox')
    const svg = root.querySelector('.vk-lightbox-stage > svg')
    return { backdrop: getComputedStyle(root).backgroundColor, paper: getComputedStyle(svg).backgroundColor }
  })
  assert.notEqual(surfaces.backdrop, 'rgba(0, 0, 0, 0)', `遮罩层应有底色，实际 ${surfaces.backdrop}`)
  assert.notEqual(surfaces.paper, 'rgba(0, 0, 0, 0)', `图形应有纸面底色，实际 ${surfaces.paper}`)
  const readScale = () => page.evaluate(() =>
    Number((document.querySelector('.vk-lightbox-stage > svg').style.transform.match(/scale\(([\d.]+)\)/) ?? [0, '1'])[1]))
  const readTransform = () => page.evaluate(() => document.querySelector('.vk-lightbox-stage > svg').style.transform)
  const fitted = await readScale()
  const stageBox = await stage.boundingBox()
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2)
  await page.mouse.wheel(0, -120)
  const zoomed = await readScale()
  assert.ok(zoomed > fitted, `滚轮应放大：${fitted} → ${zoomed}`)
  assert.ok(zoomed / fitted < 1.2, `一格滚轮应是细步，实际 ×${(zoomed / fitted).toFixed(3)}`)
  const beforeDrag = await readTransform()
  await page.mouse.move(stageBox.x + 200, stageBox.y + 200)
  await page.mouse.down()
  await page.mouse.move(stageBox.x + 260, stageBox.y + 230, { steps: 6 })
  await page.mouse.up()
  assert.notEqual(await readTransform(), beforeDrag, '拖拽应改变平移')
  // 拖拽之后不应被当成"点击"而关闭
  await page.waitForTimeout(260)
  assert.equal(await page.locator('.vk-lightbox').count(), 1, '拖拽不应关闭')
  await page.screenshot({ path: join(out, 'lightbox.png') })
  // 像看图一样：点图形区域关闭
  await page.mouse.click(stageBox.x + 80, stageBox.y + 80)
  await page.waitForSelector('.vk-lightbox', { state: 'detached' })
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.vkAction), 'expand', '焦点应回到放大按钮')
  assert.equal(await page.evaluate(() => document.body.style.overflow), '', '页面滚动应恢复')
  checks.push('放大展示：底色不透明、滚轮细步缩放、拖拽平移、点图形区域关闭并归还焦点')

  // isometric：交互在本地重算，不重新请求模型
  await page.evaluate(() => addBlock('iso-live', 'isometric-interactive', JSON.stringify({
    kind: 'solid', title: '交互等距图', desc: '拖拽旋转、滚轮缩放、图内切剖面。',
    case: 2.0, cut: 0.7,
    objects: [
      { type: 'box', at: [0, 0, -0.9], size: [1.8, 1.8, 0.3], color: 'ink' },
      { type: 'ball', r: 0.5, color: 'blue' },
    ],
  })))
  await page.waitForFunction(() => document.querySelector('#iso-live .vk-figure')?.dataset.vkDisplayState === 'ready')
  assert.equal(await page.evaluate(() => document.querySelector('#iso-live .vk-figure')?.dataset.vkMode), 'interactive')
  // 先滚进视口再抓初始快照：page.mouse 用的是视口坐标（元素在折叠线以下时事件落不到它身上），
  // 而滚动会改变滚动条、进而改变容器宽度 —— 快照与重置必须在同一布局状态下抓取。
  await page.locator('#iso-live .vk-iso-view').scrollIntoViewIfNeeded()
  const isoBefore = await page.evaluate(() => document.querySelector('#iso-live .vk-iso-view svg')?.outerHTML ?? '')
  const isoBox = await page.locator('#iso-live .vk-iso-view').boundingBox()
  await page.mouse.move(isoBox.x + isoBox.width / 2, isoBox.y + isoBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(isoBox.x + isoBox.width / 2 + 120, isoBox.y + isoBox.height / 2, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(200)
  const isoAfterDrag = await page.evaluate(() => document.querySelector('#iso-live .vk-iso-view svg')?.outerHTML ?? '')
  assert.notEqual(isoAfterDrag, isoBefore, '拖拽应改变视角')
  await page.locator('#iso-live .vk-iso-button', { hasText: '剖面' }).first().click()
  await page.waitForTimeout(200)
  const isoAfterCut = await page.evaluate(() => document.querySelector('#iso-live .vk-iso-view svg')?.outerHTML ?? '')
  assert.notEqual(isoAfterCut, isoAfterDrag, '剖面开关应改变画面')
  // 剖面是独立开关，「重置视角」只重置视角：先把剖面切回去，再重置，
  // 此时画面应当与初始完全一致（确定性渲染的端到端证据）。
  await page.locator('#iso-live .vk-iso-button', { hasText: '剖面' }).first().click()
  await page.waitForTimeout(200)
  await page.locator('#iso-live .vk-iso-button', { hasText: '重置视角' }).first().click()
  await page.waitForTimeout(200)
  const isoReset = await page.evaluate(() => document.querySelector('#iso-live .vk-iso-view svg')?.outerHTML ?? '')
  assert.notEqual(isoReset, isoAfterCut, '重置应改变画面')
  assert.equal(isoReset, isoBefore, '剖面切回 + 重置视角后，画面应与初始逐字节一致')
  await page.screenshot({ path: join(out, 'isometric.png') })
  checks.push('等距展示：拖拽旋转、图内切剖面、重置视角均在本地生效')

  // 视觉风格：用户可选的外观层。走真实配置路由换风格，引擎图必须按新令牌重绘。
  const beforeStyle = await page.evaluate(() => document.querySelector('#static-isometric .vk-canvas svg')?.outerHTML ?? '')
  assert.ok(beforeStyle.length > 0, '应有等距图可供比较')
  const styled = await page.request.post(fixture.url + '/dsh-visual-kit/config', { data: { presentation: { style: 'blueprint' } } })
  assert.equal(styled.status(), 200)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction((before) => {
    const svg = document.querySelector('#static-isometric .vk-canvas svg')
    return svg !== null && svg.outerHTML !== before
  }, beforeStyle)
  const afterStyle = await page.evaluate(() => document.querySelector('#static-isometric .vk-canvas svg')?.outerHTML ?? '')
  assert.notEqual(afterStyle, beforeStyle, '换风格后画面应不同')
  assert.ok(!/fill="#FFFFFF"|fill="#1E1E1C"/.test(afterStyle), '不应再是默认风格的画布底')
  checks.push('视觉风格：换风格后引擎图按新令牌重绘')

// 卡片外观契约：卡片 / 标题条 / 画布三层底色都必须透明，图也不能自绘整幅底色。
// 否则会叠成「灰框里浮一块白方块」—— 圆角接不上，深浅主题各错一次。这类问题不会报错，
// 只能靠眼睛发现，所以在这里用计算样式钉住。
const chrome = await page.evaluate(() => {
  const figure = document.querySelector('.vk-figure')
  const svg = figure?.querySelector('.vk-canvas svg')
  const bg = (node) => (node === null || node === undefined ? null : getComputedStyle(node).backgroundColor)
  const viewWidth = Number((svg?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/)[2])
  const opaqueCover = svg === null || svg === undefined
    ? null
    : [...svg.querySelectorAll('rect')].some((rect) =>
        !rect.hasAttribute('x') && !rect.hasAttribute('y') && Number(rect.getAttribute('width')) === viewWidth)
  return {
    figure: bg(figure),
    bar: bg(figure?.querySelector('.vk-bar')),
    canvas: bg(figure?.querySelector('.vk-canvas')),
    button: bg(figure?.querySelector('.vk-btn')),
    opaqueCover,
  }
})
assert.equal(chrome.figure, 'rgba(0, 0, 0, 0)', '卡片底应当透明')
assert.equal(chrome.bar, 'rgba(0, 0, 0, 0)', '标题条不该有自己的底色')
assert.equal(chrome.canvas, 'rgba(0, 0, 0, 0)', '画布不该铺自己的面')
assert.equal(chrome.button, 'rgba(0, 0, 0, 0)', '工具按钮平时不该有底色（hover 才出）')
assert.equal(chrome.opaqueCover, false, '图不该自绘整幅底色')
checks.push('卡片外观：三层底色全透明，图直接落在聊天背景上')

// 灯箱里必须反过来：底是近黑，图透明就会让深色字落在黑上。纸面这一层由灯箱提供。
// 用稳定的 data-vk-action，不靠按钮文字（'放大' 同时匹配'画布内放大'）
await page.locator('.vk-figure').first().locator('[data-vk-action="expand"]').click()
await page.waitForTimeout(400)
const lightbox = await page.evaluate(() => {
  const svg = document.querySelector('.vk-lightbox-stage > svg')
  return svg === null ? 'no-lightbox' : getComputedStyle(svg).backgroundColor
})
assert.notEqual(lightbox, 'no-lightbox', '双击应当打开灯箱')
assert.notEqual(lightbox, 'rgba(0, 0, 0, 0)', '灯箱里的图必须有纸面，否则深色字落在近黑底上')
await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  if (await page.locator('.vk-lightbox').count() > 0) await page.keyboard.press('Escape')
await page.waitForTimeout(200)
checks.push('灯箱：图在近黑底上有纸面')

  const config = await page.request.post(fixture.url + '/dsh-visual-kit/config', { data: { renderers: { echarts: { interactive: false } } } })
  assert.equal(config.status(), 200)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => document.querySelector('#live-bar .vk-figure')?.dataset.vkMode === 'static')
  await page.request.post(fixture.url + '/dsh-visual-kit/config', { data: { behavior: { autoRender: false } } })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForFunction(() => document.querySelectorAll('.vk-figure').length === 0)
  checks.push('实际配置路由控制交互降级和总开关还原')
  await page.evaluate(() => stopMotu())
  assert.equal(await page.locator('.vk-scratch').count(), 0)
  assert.deepEqual(errors, [])
  checks.push('卸载清理与浏览器运行时错误检查通过')
  await writeFile(join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2))
  console.log(checks.map(check => `ok ${check}`).join('\n'))
  console.log(`\n${checks.length} 组 Chromium 检查通过；产物：${out}`)
} finally { await browser?.close(); await fixture.close() }
