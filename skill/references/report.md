# 任务报告

一轮任务结束后附报告：结论、改动、验证与风险；sections[].flow 画一张内联 SVG 流程图；点「查看」跳到报告面板，或用「浏览器」打开独立网页；自动归档到项目

- 栅栏：```report
- 引擎：内置于插件（无第三方引擎，投影在本地计算）
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON：{ "title": "…", "round": "第 N 轮 · 日期", "status": "done|partial|blocked|failed", "verdict": "一两句说清交付了什么", "badges": [{ "tone": "done|partial|blocked|failed|info|neutral", "text": "…" }], "facts": ["要点"], "meta": { "基线": "…" }, "notice": { "tone": "warn|ok|info", "text": "…" }, "sections": [{ "title": "改动流程", "flow": { "direction": "LR", "nodes": [{ "id": "a", "label": "输入", "sub": "可选副标题" }, { "id": "b", "label": "处理" }], "edges": [{ "from": "a", "to": "b", "label": "可选" }] } }, { "title": "改了什么", "table": { "head": ["文件", "改动"], "rows": [["lib/client.js", "…"]] } }, { "title": "验证与风险", "items": ["…"], "details": { "summary": "未测范围", "items": ["…"] } }], "sources": [{ "label": "改动", "text": "lib/client.js" }] }；查看 / 下载得到自包含网页

## 易错点

- **正文必须是一个 JSON 对象**：栅栏里不要写「结论：…」这种行文，也不要写 Markdown 列表 —— 直接写 `{ "title": "…", "status": "done", "verdict": "…" }`。
- JSON 用英文双引号，不能有注释或尾随逗号；「改动 / 验证 / 风险」分别放进 `sections` 的 `items`。
- 只写实际跑过的验证；没跑就写「未验证」，不要写「应该没问题」。
- verdict 要回答「交付了什么」，不要写成「我做了以下工作」的流水账。
- 改动表只列真实改过的文件；不要把计划、建议或未做的改动写进去。
- 状态与徽章要一致：`partial` 时不要给「已完成」徽章。
- `sections[].flow` 画内联 SVG 流程图：2–6 个节点，`nodes[].id` 唯一，`edges[].from/to` 必须指向已声明的 id；不要写坐标、颜色或 SVG 源码。
- 流程图是"结构 / 流程"的补充，不是替代正文；改动流程、数据流、调用链最适合画，纯清单不必硬塞。

## 完整示例

```report
{
  "title": "同页自绘图共享调色板 · 修复交付",
  "round": "第 18 轮 · 2026-10-19 · 0.18.0",
  "status": "done",
  "verdict": "定位并修掉了「同页所有自绘图共享最后一张调色板」的根因：类名是文档级的，撞了互相覆盖。",
  "badges": [
    { "tone": "done", "text": "已完成" },
    { "tone": "info", "text": "仅本机验证" }
  ],
  "facts": [
    "根因：内联 SVG 的 style 是全局的，c0/c1 撞名后谁最后画谁说了算",
    "修法：svgDocument 给类名加内容哈希前缀，一处修好全部自绘渲染器",
    "回归：同页异色图必须拿到不同前缀，相同输入必须逐字节一致"
  ],
  "meta": {
    "基线": "0.17.0 三层底色透明",
    "验证": "243 单测 / 10-10 渲染器 / 21 组 Chromium"
  },
  "notice": { "tone": "warn", "text": "未测：真实长对话里 20 张以上图同时换主题的耗时。" },
  "sections": [
    {
      "title": "改动流程",
      "flow": {
        "direction": "LR",
        "nodes": [
          { "id": "fence", "label": "报告栅栏", "sub": "JSON spec" },
          { "id": "spec", "label": "校验与默认值", "sub": "reportSpecOf" },
          { "id": "svg", "label": "内联流程图", "sub": "reportFlowSvg" },
          { "id": "page", "label": "自包含网页", "sub": "查看 / 浏览器" }
        ],
        "edges": [
          { "from": "fence", "to": "spec", "label": "解析" },
          { "from": "spec", "to": "svg", "label": "flow" },
          { "from": "svg", "to": "page", "label": "归档" }
        ]
      }
    },
    { "title": "用户能感知到的变化", "items": ["两张不同颜色的等距图不再互相污染", "换风格后颜色跟随当前风格"] },
    {
      "title": "改了什么",
      "table": {
        "head": ["文件", "改动"],
        "rows": [
          ["lib/client.js", "svgDocument 给类名加内容哈希前缀"],
          ["test/report.test.mjs", "新增同页异色与确定性断言"]
        ]
      }
    },
    {
      "title": "验证与未测",
      "items": ["npm test：243/243 通过", "真实浏览器：三张图三种颜色"],
      "details": { "summary": "明确未验证的范围", "items": ["长对话 20 张以上图同时换主题的耗时"] }
    }
  ],
  "sources": [{ "label": "改动", "text": "lib/client.js · svgDocument" }]
}
```

## 什么时候写

任务收尾时，只在**改过文件或运行过命令**后写；纯问答、纯解释不写。报告是给用户看的交付档案，不是过程流水账。

## 内容清单

1. **结论**：`status` + 一句话 `verdict`，先说交付了什么。
2. **用户能感知到的变化**：用户会看到或用到的变化，不是 commit 列表。
3. **改了什么**：文件 → 改动，用 `table`；只列实际改过的。
4. **验证**：实际跑过的命令与结果；没跑就写「未验证」，不要编。
5. **未测范围 / 风险**：用 `details` 折叠，写清楚为什么没测。
6. **来源**：文件路径或链接，纯文本；下载页与对话里都不发外部请求。

## 纪律

- 只写实际发生的事；不确定就写不确定。
- 改动表用 `table`，验证用列表或表；不要把所有内容都塞进 `facts`。
- 同一轮只写一份；不要重复报告。
- 报告页与摘要卡都跟随当前风格；正文里不要指定颜色、字号或版式。
- 自动归档到项目的 `.dsh/visual-kit/reports/`，正文里不需要贴路径。
