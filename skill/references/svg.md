# SVG 图示（手写）

概念对照、时间线、成长路线、架构分工 —— 模型按设计系统手写 SVG，布局与语义配色完全自由，最出彩（参照应用的真正用法）

- 栅栏：```svg
- 引擎：dompurify@3.4.17
- 字体：该引擎自带字体。

## 语法

直接写 <svg viewBox="0 0 680 XXX" width="100%" role="img">…</svg>；必须带 <title> 与 <desc>；圆角 rx=8、边框 0.5px、暖中性配色（见参考页）

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
