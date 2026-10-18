# 用例矩阵

跑了一堆用例的结果（自测、联调、验收清单），状态与汇总自动生成

- 栅栏：```matrix
- 引擎：内置于插件（无第三方引擎，投影在本地计算）
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON：{ "cases": [{ "name": "serial-cmd.py 查 uname", "status": "pass", "ms": 820, "note": "115200 8N1" }] }；status 用 pass / fail / warn / skip / running（缺省 skip）；ms 可为 null（显示 —）；卡底汇总由渲染器算，不用你写

## 易错点

- JSON：{ "cases": [{ "name": "serial-cmd.py 查 uname", "status": "pass", "ms": 820, "note": "115200 8N1" }] }；status 用 pass / fail / warn / skip / running（缺省 skip）；ms 可为 null（显示 —）；卡底汇总由渲染器算，不用你写

## 完整示例

```matrix
{
  "title": "连板前自测",
  "desc": "六条用例的结果与耗时，卡底自动汇总。",
  "cases": [
    { "name": "serial-cmd.py 查 uname", "status": "pass", "ms": 820, "note": "115200 8N1" },
    { "name": "i2cdetect 查 bq28z620", "status": "fail", "ms": 3010, "note": "地址 0x0b 无应答" },
    { "name": "iperf3 打流", "status": "warn", "ms": 10050, "note": "丢包 0.6%" },
    { "name": "tio 抓 U-Boot 日志", "status": "skip", "ms": null, "note": "未插板" },
    { "name": "烧录校验", "status": "pass", "ms": 4200 },
    { "name": "RTC 走时", "status": "running" }
  ]
}
```
