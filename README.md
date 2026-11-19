# 墨图 · MoTu（个人改动版）

把对话里的代码块渲染成图：Mermaid、Graphviz、nomnoml、ECharts、Vega-Lite、手写 SVG、等距剖面、体素模型、指标卡、用例矩阵、代码差异。引擎随包本地伺服，不联网。

**上游**：[molanxuan-del/DSH-MOTU](https://github.com/molanxuan-del/DSH-MOTU)。本仓库是 fork，功能、语法、安装与设置项以上游 README 为准；本仓库只改了下面几处。

## 改了什么

| 改动 | 说明 |
|---|---|
| 引擎配色 | Mermaid / Graphviz / nomnoml 从出厂灰改为风格语义色（蓝=主线、绿=通过、琥珀=部分），深色主题下同色向白提亮 |
| 文字对比 | 两处兜底：Graphviz / nomnoml 渲染后按实际底色重算；mermaid 的 classDef 只写了底色时，渲染前补 `color`（低于 4.5 才改） |
| 图卡片材质 | 底板改为半透明磨砂，复用壁纸引擎的侧栏配方；主题插件可用 `--vk-figure-bg` 完全接管 |
| 新增 `diff` 渲染器 | `diff` / `patch` 栅栏渲染成彩色差异卡：文件头、双列行号、增绿删红（上游是单色文本） |

## 效果

文字不再溶进底色：浅底上的字自动变深，深底上的自动变浅。

![mermaid 文字对比度](docs/shots/mermaid-ink-dark.png)

指标卡与用例矩阵：

![指标卡与用例矩阵](docs/shots/cards-dark.png)

新增的代码差异卡：

![代码差异](docs/shots/diff-dark.png)

> 截图取自真实渲染管线（Chromium + 随包引擎 + 插件真实 CSS + 壁纸底），不是示意图。

## 安装

```bash
git clone https://github.com/LiTianYun/DSH-MOTU.git dsh-visual-kit
cd dsh-visual-kit
npm install                       # 依赖 + prepare 自动生成 vendor/ 与 skill/
dsh plugin --profile <name> add link:$PWD
```

`vendor/` 是第三方引擎产物（约 6.6 MB），不入库，`npm install` 时自动生成。

## 验证

```bash
npm test                 # 270 项单测
npm run check:renderers  # 12 个渲染器各产出一份真实产物并校验为合法 XML
```

## 许可

MIT。引擎许可见上游 README。
