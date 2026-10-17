# 等距展示

等距剖面 —— 要转动、缩放、切开看内部，或同一结构要反复改角度改配色时用它（一次性插图手写 SVG 更灵活）

- 栅栏：```isometric / ```isometric-interactive
- 引擎：内置于插件（无第三方引擎，投影在本地计算）
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON：{ "kind": "solid", "objects": [{ "type": "shell", "r": 1.3, "thickness": 0.16, "color": "amber" }] }；颜色用语义令牌（amber/blue/green/purple/red/ink/muted）或 #rrggbb

## 易错点

- kind 只能是 solid 或 voxel；两种都是 JSON，不能有注释或尾随逗号。
- 颜色写语义令牌（amber/blue/green/purple/red/ink/muted）或 #rrggbb；voxel 的 palette 键必须是单个字符。
- voxel 的 layers 与 shapes 二选一；用 shapes 时只有会放置体素的形状需要 fill（collapse 是挖空，不需要）。
- 不要自己算缩放与取景 —— 引擎会自动把场景放进画布，你只描述有什么、在哪、什么颜色。
- 需要转动或切开看内部时用 ```isometric-interactive；静态图用 ```isometric。

## 完整示例

```isometric
{
  "kind": "solid",
  "title": "分层服务的等距剖面",
  "desc": "展示柜里的三层服务与共享数据层，切开前四分之一看到内部依赖。",
  "case": 2.2,
  "cut": 0.7,
  "objects": [
    { "type": "box", "at": [0, 0, -1.2], "size": [2.4, 2.4, 0.3], "color": "ink", "label": "共享数据层" },
    { "type": "cylinder", "at": [-0.7, -0.7, -0.4], "r": 0.42, "h": 1.2, "color": "blue", "label": "接入层" },
    { "type": "cylinder", "at": [0.7, 0.7, -0.4], "r": 0.42, "h": 1.2, "color": "green", "label": "业务层" },
    { "type": "ring", "at": [0, 0, 0.6], "r": 1.1, "count": 6, "size": [0.34, 0.34, 0.34], "color": "purple", "label": "计算节点" }
  ],
  "callouts": [
    { "at": [-0.7, -0.7, 0.2], "text": "接入层" },
    { "at": [0.7, 0.7, 0.2], "text": "业务层" },
    { "at": [0, 0, 0.6], "text": "计算节点" }
  ]
}
```
