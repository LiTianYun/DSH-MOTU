# 墨图 · MoTu

**把对话里的代码块变成真正的图。**

**墨图（MoTu）** 是 DeepSeek Harness 的可视化套件：模型在回复里写一段带语言的代码块，浏览器端就把它渲染成图。六种渲染方式全部**随插件本地伺服——不联网、不走 CDN**，每次出图结果一致；每个引擎按需懒加载，只画流程图的会话不会下载图表库。

> 三个名字，一处对应：仓库 **`DSH-MOTU`** · 品牌 **墨图 / MoTu** · npm 包名 **`dsh-visual-kit`**（也是插件 id 与路由前缀 `/dsh-visual-kit/*`）。

> 设计取向一句话：**一张清楚的图胜过三段文字**。所以插件不只是"能渲染图"，它还会要求模型在讲解结构、流程、对比、方案时**主动配图**，并给出成图规范。

[![CI](https://github.com/molanxuan-del/DSH-MOTU/actions/workflows/ci.yml/badge.svg)](https://github.com/molanxuan-del/DSH-MOTU/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)

## 效果

手写 SVG 渲染器（概念对照、时间线、路线图这类语义图的最佳选择——**没有语法可错**）：

![两种缓存策略的对比](preview/design/01-comparison.svg)

![工程师四级成长](preview/design/03-roadmap.svg)

![Web 应用三层架构](preview/design/05-architecture.svg)

![两周迭代甘特图](preview/design/10-gantt.svg)

以上十张都是本仓库生成器（`scripts/design-showcase.mjs`）产出的，用来演示同一套设计令牌覆盖的十种版式：对比 / 时间线 / 阶梯 / 闭环 / 分层架构 / 四象限 / 漏斗 / 流程 / 卡片网格 / 甘特。

## 六种渲染方式

| 渲染器 | 栅栏 | 擅长 |
| --- | --- | --- |
| **Mermaid** | ` ```mermaid ` | 流程、时序、状态、甘特、饼图、脑图 |
| **Graphviz** | ` ```dot ` / ` ```graphviz ` | 结构关系、依赖、架构分层 |
| **nomnoml** | ` ```nomnoml ` | 小而清楚的框线图 |
| **ECharts** | ` ```echarts ` | 数量、占比、趋势（JSON 配置） |
| **Vega-Lite** | ` ```vega-lite ` / ` ```vegalite ` / ` ```vega ` | 分层、分面统计图（JSON 规格） |
| **手写 SVG** | ` ```svg ` | 概念对照、时间线、路线图、闭环、架构图 |

没有语言的代码块会按内容识别（首行是 `flowchart TD` 的 mermaid、以 `digraph` 开头的 Graphviz、以 `<svg` 开头的 SVG……）。

## 安装

```bash
git clone https://github.com/molanxuan-del/DSH-MOTU.git
cd DSH-MOTU
npm install                                  # 安装依赖并自动执行 prepare → 生成本地引擎产物
dsh plugin --profile <name> add link:$PWD
```

`npm install` 会通过 `prepare` 脚本自动运行 `npm run vendor`：把引擎产物拷进 `vendor/`、写入哈希清单、生成技能文件。`vendor/` **不入库**（6.6 MB 第三方产物），克隆后一次 `npm install` 即可得到。

安装后在 DSH 设置里会出现本插件的配置页与「**可视化套件**」能力页，全部改动**即时生效**。

## 给模型用

插件在模型侧做了三件事：

1. **一行常驻提示**：要求模型讲解结构、流程、对比、方案或数据时**主动画一张图**（不必等用户要求），并说明各栅栏的选型与成本纪律；
2. **`dsh-visualization` 技能**：按需加载的完整参考——选型表、各引擎语法要点、手写 SVG 设计系统（配色令牌、发丝线、开放箭头、字号层级、`<title>`/`<desc>` 无障碍）；
3. **能力与宣传一致**：关掉某个渲染器后，它的栅栏恢复成普通代码，模型也不再被告知它能用。

## 设置面板

设置里的「**可视化套件**」页把能力摆在明面上：

- **总开关**：自动渲染 / 模型侧提示段 / 技能 / 反馈时让本会话直接修；
- **六个渲染器各一个滑动开关**，每张卡片带**实时预览**——预览走的是对话里同一条渲染管线，所以面板不会和实际出图不一致；
- 开关写入的是**插件的真实配置行**（经宿主 `configEditor` 持久化），不是页面上的一层影子状态，因此配置页、提示段、技能、渲染目录始终同步。

## 出错时

渲染失败**不会破坏对话**：原代码块保留，下面出现一张错误卡片，写明**哪个渲染器、什么原因、怎么改**，并附该渲染器的**最小可用示例**（可折叠）。

卡片上有一个「**反馈并修复**」按钮：

1. 把源码与诊断上报到插件本地（`~/.dsh/visual-kit/reports.jsonl`，**不出你的机器**）；
2. 若开关打开，再通过会话服务把一条自修请求**投递给当前会话**——由那个会话自己的 agent 判断是"适配器 bug"还是"语法本来就写错"，并自己决定要不要开 subagent 去改插件。

## 完整性校验

`vendor/integrity.json` 记录每个引擎文件的 SHA-256、字节数与版本。三层校验：

1. **启动时**校验所有已启用渲染器的引擎文件；
2. **伺服时**每个文件首次读取再校验一次；
3. **`GET /dsh-visual-kit/health`** 随时可查逐文件结果。

`strict` 模式下校验失败的渲染器自动禁用（并在图的位置给出可读原因），而不是加载一半诡异失败。

## 路由

| 路由 | 用途 |
| --- | --- |
| `GET /dsh-visual-kit/config` | 有效配置、启用集合、提示文本、开关快照 |
| `POST /dsh-visual-kit/config` | 写入配置（字段按配置 Schema 校验，未知字段丢弃） |
| `GET /dsh-visual-kit/renderers.json` | 浏览器渲染用的渲染器目录（含示例源码，供面板预览） |
| `GET /dsh-visual-kit/assets/<id>/<file>` | 引擎产物（白名单伺服，长缓存，哈希不符返回 503） |
| `GET /dsh-visual-kit/health` | 完整性报告 |
| `GET/POST /dsh-visual-kit/diag` | 诊断信标与反馈落点 |

## 开发

```bash
npm install            # 依赖 + prepare 自动生成 vendor/
npm test               # 91 个单测：宿主路由/配置/完整性 + 客户端适配器/消毒/缩放/槽位注册
npm run check:renderers # 无头渲染六个引擎，产出真实产物并校验
node scripts/design-showcase.mjs   # 重新生成 README 里那十张设计示例
```

### 新增一种可视化（5 步）

1. `npm i <引擎>`（devDependency）；
2. `lib/renderers/manifest.js` 加一条记录（id / languages / label / output / assets / defaults / syntaxHint / 能力标志）；
3. `lib/client.js` 的 `ADAPTERS` 里加一个适配器（`loadEngine` + `render`，30–80 行）；
4. `npm run vendor`（拷贝产物、更新哈希、重新生成技能文件）；
5. `npm test && npm run check:renderers`。

配置界面、设置面板、提示段、技能、健康检查**自动**出现新渲染器的开关与记录——不需要再改别处。

### 目录结构

```
lib/index.js              宿主半：配置 Schema、路由、完整性校验、提示段与技能生成
lib/client.js             客户端半：扫描管线、六个适配器、图框、设置面板
lib/renderers/manifest.js 单一事实来源：渲染器清单（配置界面/提示/技能/面板都由它派生）
scripts/vendor.mjs        拷贝引擎产物、写 integrity.json、生成 skill/
scripts/design-showcase.mjs  README 里的十张设计示例
test/                     宿主半与客户端半的单测
vendor/                   引擎产物（不入库，npm install 生成）
```

## 呈现规范

图内字体沿用宿主应用字体栈，字号 **13px**（与正文同尺度），画布居中、16px 内边距、最高 360px，随主题切换底色；自适应缩放同时受宽度与高度约束（纵向超出会直接看不到内容，因此高度下限比宽度下限更松）。渲染失败显示错误卡片，主题变化自动重渲染。

手写 SVG 的设计令牌（暖中性基色 + 语义色、`stroke-width="0.5"` 发丝线、`rx=8` 圆角、开放式箭头、11/12/13/14 四级字号、`<title>`+`<desc>` 无障碍）整理自 **WorkBuddy** 对话产物中实际使用的规范——本项目按同一套规范生成示例图（见 `preview/design/`）。

## 许可

本插件为 **MIT**。

各引擎许可见其包：mermaid、Graphviz-wasm（`@viz-js/viz`）、nomnoml、graphre、DOMPurify 为 MIT；ECharts 为 Apache-2.0；Vega / Vega-Lite 为 BSD-3-Clause。
