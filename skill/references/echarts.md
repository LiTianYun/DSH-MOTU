# ECharts

数量、占比、趋势、对比 —— 数据图表首选，中文排版友好

- 栅栏：```echarts
- 引擎：echarts@6.1.0
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON 配置：{ "xAxis": { "type": "category", "data": [...] }, "series": [{ "type": "bar", "data": [...] }] }；饼图用 "type": "pie"

## 完整示例

```echarts
{
  "title": { "text": "流量来源" },
  "series": [
    {
      "type": "pie",
      "radius": ["40%", "68%"],
      "data": [
        { "value": 1048, "name": "搜索引擎" },
        { "value": 735, "name": "直接访问" },
        { "value": 580, "name": "社交媒体" },
        { "value": 484, "name": "邮件营销" }
      ]
    }
  ]
}
```
