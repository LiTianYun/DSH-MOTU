# Vega-Lite

分层、分面、多视图统计图 —— 表达力最强，适合复杂的数据关系

- 栅栏：```vega-lite / ```vegalite / ```vega
- 引擎：vega@6.4.0, vega-lite@6.5.0
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

Vega-Lite v6 JSON：{ "$schema": "…/v6.json", "data": { "values": [...] }, "mark": "bar", "encoding": { … } }；叠加用 "layer": [ … ]

## 完整示例

```vega-lite
{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "data": { "values": [
    { "月": "1月", "销售额": 128, "目标": 120 },
    { "月": "2月", "销售额": 142, "目标": 130 },
    { "月": "3月", "销售额": 168, "目标": 150 }
  ] },
  "layer": [
    { "mark": { "type": "bar", "color": "#5b7cc4" }, "encoding": { "y": { "field": "销售额", "type": "quantitative" } } },
    { "mark": { "type": "line", "color": "#e0a458" }, "encoding": { "y": { "field": "目标", "type": "quantitative" } } }
  ],
  "encoding": { "x": { "field": "月", "type": "nominal" } }
}
```
