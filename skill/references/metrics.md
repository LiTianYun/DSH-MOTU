# 指标卡

一排读数（指标、容量、健康度），带阈值色与迷你趋势 —— 表格顶替不了时用它

- 栅栏：```metrics
- 引擎：内置于插件（无第三方引擎，投影在本地计算）
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON：{ "items": [{ "label": "待机电流", "value": "12.4", "unit": "mA", "tone": "ok", "delta": "比上次 +0.8" }], "spark": [11.9, 12.1, 12.0] }；tone 用 ok / warn / bad / idle（缺省 idle）；spark 是数字数组，至少两个才画趋势

## 易错点

- JSON：{ "items": [{ "label": "待机电流", "value": "12.4", "unit": "mA", "tone": "ok", "delta": "比上次 +0.8" }], "spark": [11.9, 12.1, 12.0] }；tone 用 ok / warn / bad / idle（缺省 idle）；spark 是数字数组，至少两个才画趋势

## 完整示例

```metrics
{
  "title": "RK3576 待机功耗",
  "desc": "一排读数：待机电流、SoC 温度、RSSI 与守护进程状态。",
  "items": [
    { "label": "待机电流", "value": "12.4", "unit": "mA", "tone": "ok", "delta": "比上次 +0.8" },
    { "label": "SoC 温度", "value": "48.2", "unit": "°C", "tone": "warn", "delta": "阈值 55" },
    { "label": "8821CU RSSI", "value": "-58", "unit": "dBm", "tone": "ok" },
    { "label": "守护进程", "value": "3/3", "tone": "ok", "delta": "全部在线" }
  ],
  "spark": [11.9, 12.1, 12.0, 12.3, 12.2, 12.4]
}
```
