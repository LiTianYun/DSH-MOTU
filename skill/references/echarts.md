# ECharts

数量、占比、趋势、对比 —— 数据图表首选，中文排版友好

- 栅栏：```echarts / ```echarts-interactive
- 引擎：echarts@6.1.0
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON 配置：{ "xAxis": { "type": "category", "data": [...] }, "series": [{ "type": "bar", "data": [...] }] }；饼图用 "type": "pie"

## 易错点

- JSON 里不能有注释或尾随逗号；`series` 每项必须带 `type`，数据放在 `series.data`。

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

## 交互模式

需要悬停数值、图例筛选或区间缩放时，用 ```echarts-interactive 输出 ECharts JSON。使用内联数据，配置不超过 256 KiB、数据总量不超过 10,000 点，不写函数、HTML 提示框或外部资源。提示框使用 richText；需要区间缩放时声明 dataZoom，图例筛选时声明 legend。

交互初始化失败只尝试一次静态降级；降级失败保留源码与错误说明。配置页可关闭交互模式，普通 echarts 不受影响。
