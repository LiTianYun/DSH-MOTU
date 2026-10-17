# SVG 图示（手写）

概念对照、时间线、成长路线、架构分工、一次性的空间或剖面插图 —— 模型按设计系统手写 SVG，布局与语义配色完全自由，最出彩（参照应用的真正用法）

- 栅栏：```svg
- 引擎：dompurify@3.4.17
- 字体：该引擎自带字体。

## 语法

直接写 <svg viewBox="0 0 680 XXX" width="100%" role="img">…</svg>；必须带 <title> 与 <desc>；整图构图、排版、配色与标注遵循当前视觉风格，参考页示例不覆盖该选择

## 易错点

- 手写 SVG 没有语法可错，但必须带 `<title>` 与 `<desc>`；`viewBox` 用 `0 0 680 高`（高 ≤ 400），否则会被画布裁切。

## 完整示例

```svg
<svg viewBox="0 0 680 160" width="100%" role="img" xmlns="http://www.w3.org/2000/svg">
  <title>手写 SVG 示例</title>
  <desc>两张圆角卡片展示设计系统的基础元素：暖中性现状卡与蓝色目标卡。</desc>
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
  <rect x="40" y="40" width="200" height="80" rx="8" fill="#F1EFE8" stroke="#B4B2A9" stroke-width="0.5"/>
  <text x="140" y="86" font-size="13" font-weight="500" fill="#444441" text-anchor="middle">现状 · 各自为战</text>
  <line x1="260" y1="80" x2="400" y2="80" stroke="#888780" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="420" y="40" width="200" height="80" rx="8" fill="#E6F1FB" stroke="#185FA5" stroke-width="0.5"/>
  <text x="520" y="86" font-size="13" font-weight="500" fill="#0C447C" text-anchor="middle">目标 · 统一供给</text>
</svg>
```

## 设计系统

选用手写 ```svg 后遵循当前视觉风格的整图设计规范；画法选择以当前绘图偏好与用户要求为准。以下是各风格共用的可读性要求，不额外指定配色、圆角或字号来覆盖当前风格。

- **画布**：`<svg viewBox="0 0 680 高" width="100%" role="img">`，左边距 40，卡片间留白充足。
- **构图**：先确定阅读顺序与主体，再安放标题、分区、说明和图例；不要把所有内容机械地套入相同卡片。
- **视觉语言**：配色、圆角、边框、连线和字号取当前风格的规则，保持全图一致；参考示例的暖色不是所有风格的强制要求。
- **连线与标注**：箭头表达真实方向，路径避开文字和节点；标签靠近对应对象，长文手动换行，不重叠、不出界。
- **字号层级**：标题、分区标题、正文与注释有明确主次，字号随画布比例协调；代码路径可用 `ui-monospace`。
- **无障碍**：每个图带 `<title>` 与一句 `<desc>`。
- 布局模式：对照＝两块语义色面板并排；时间线＝竖线＋圆点＋卡片；路线＝阶梯上行；循环＝横链＋虚线回路。
