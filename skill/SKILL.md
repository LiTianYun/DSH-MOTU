# 可视化输出

用带语言的代码块输出图，DSH 会把它渲染成真正的图；写错语法不会破坏对话，只会显示一张错误卡片。

## 选型

| 要表达什么 | 用什么 | 栅栏 |
| --- | --- | --- |
| 流程、时序、状态、类、甘特、饼图、脑图 —— 覆盖面最广，拿不准时用它 | Mermaid 图表 | ```mermaid |
| 流程、依赖、架构分层 —— 分层布局最稳，集群（subgraph cluster）是它的强项 | Graphviz（dot） | ```dot / ```graphviz |
| 极简框线图 —— 语法最短，适合小而清楚的流程 | nomnoml | ```nomnoml |
| 数量、占比、趋势、对比 —— 数据图表首选，中文排版友好 | ECharts | ```echarts |
| 分层、分面、多视图统计图 —— 表达力最强，适合复杂的数据关系 | Vega-Lite | ```vega-lite / ```vegalite / ```vega |
| 概念对照、时间线、成长路线、架构分工 —— 模型按设计系统手写 SVG，布局与语义配色完全自由，最出彩（参照应用的真正用法） | SVG 图示（手写） | ```svg |

## 语法要点

- **Mermaid 图表**：首行必须是图表类型关键字（flowchart TD / sequenceDiagram / stateDiagram-v2 / gantt / pie / mindmap）
- **Graphviz（dot）**：digraph G { rankdir=LR; A -> B; }；中文标签必须写 fontname="Microsoft YaHei"，分层用 subgraph cluster_x { label="…" }
- **nomnoml**：[A] -> [B]；边标签写在端点和箭头之间：[A] 是 -> [B]；决策就是普通方框 [命中]，不要写 <choice>（尖括号会被当文本渲染）；中文必须加 #padding: 22 补偿它按西文字宽估算
- **ECharts**：JSON 配置：{ "xAxis": { "type": "category", "data": [...] }, "series": [{ "type": "bar", "data": [...] }] }；饼图用 "type": "pie"
- **Vega-Lite**：Vega-Lite v6 JSON：{ "$schema": "…/v6.json", "data": { "values": [...] }, "mark": "bar", "encoding": { … } }；叠加用 "layer": [ … ]
- **SVG 图示（手写）**：直接写 <svg viewBox="0 0 680 XXX" width="100%" role="img">…</svg>；必须带 <title> 与 <desc>；圆角 rx=8、边框 0.5px、暖中性配色（见参考页）

每个渲染器的完整示例见下方导航。

## 手写 SVG 设计系统

概念对照、时间线、成长路线、架构分工这类**语义图**优先手写 ```svg —— 参照应用的高级感全部来自手写 SVG。设计系统（从其真实产物中提取）：

- **画布**：`<svg viewBox="0 0 680 高" width="100%" role="img">`，左边距 40，卡片间留白充足。
- **语义配色（颜色即含义）**：蓝 `#185FA5`/`#0C447C`/`#E6F1FB`＝新增或目标；暖灰 `#F1EFE8`/`#B4B2A9`/`#444441`＝现状；绿 `#3B6D11`/`#EAF3DE`＝推荐；红 `#A32D2D`/`#FCEBEB`＝问题；琥珀 `#BA7517`/`#FAEEDA`＝部分；紫 `#534AB7`/`#EEEDFE`＝进阶。
- **卡片**：`rx="8"` 圆角，`stroke-width="0.5"` 发丝边框；面板容器 `rx="12~16"` 带浅色底。
- **箭头**：开放式箭头 `<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round"/>`，`marker-end` 引用，`stroke-dasharray="4 3"` 表未来/循环。
- **字号层级**：11 眉标 / 12 正文 / 13 卡题 / 14 节题；卡题 `font-weight="500"`；代码路径用 `ui-monospace`。
- **无障碍**：每个图带 `<title>` 与一句 `<desc>`。
- 布局模式：对照＝两块语义色面板并排；时间线＝竖线＋圆点＋卡片；路线＝阶梯上行；循环＝横链＋虚线回路。

## 成本纪律

- 图由浏览器渲染，**渲染本身不花 token**；花 token 的是你写进对话的源码，而它会留在对话里、之后每轮都被重读。
- 同一份内容**语法越声明式越省**：一张流程图 nomnoml/mermaid ≈ 58 tokens，Graphviz ≈ 93，ECharts ≈ 113，Vega-Lite ≈ 182。优先选够用的最小语法。
- **不要重复画同一张图**。
- 大段 HTML/长文档**写成文件并给出路径**，不要贴进对话（省 92–99% 的上下文）。

## 失败处理

- 语法错误会保留原始代码块并显示错误卡片，改对后自动重新渲染。
- 图上「反馈」按钮会把源码与诊断信息发回插件作者。

## 参考

| 渲染器 | 完整示例与注意事项 |
| --- | --- |
| Mermaid 图表 | 阅读 [references/mermaid.md](references/mermaid.md) |
| Graphviz（dot） | 阅读 [references/graphviz.md](references/graphviz.md) |
| nomnoml | 阅读 [references/nomnoml.md](references/nomnoml.md) |
| ECharts | 阅读 [references/echarts.md](references/echarts.md) |
| Vega-Lite | 阅读 [references/vega-lite.md](references/vega-lite.md) |
| SVG 图示（手写） | 阅读 [references/svg.md](references/svg.md) |
