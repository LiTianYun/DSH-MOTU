# 等距展示

等距剖面 —— 要转动、缩放、切开看内部，或同一结构要反复改角度改配色时用它（一次性插图手写 SVG 更灵活）

- 栅栏：```isometric / ```isometric-interactive
- 引擎：内置于插件（无第三方引擎，投影在本地计算）
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON：{ "objects": [{ "type": "shell", "r": 1.3, "thickness": 0.16, "color": "amber" }] }；图元 box/ball/shell/cylinder/ring，或直接用零件配方 { "type": "part", "part": "stack", "layers": 3 }（base/stack/rack/grid/tower/dial/rail/post）；颜色用语义令牌（amber/blue/green/purple/red/ink/muted）或 #rrggbb

## 易错点

- kind 只能是 solid 或 voxel；两种都是 JSON，不能有注释或尾随逗号。
- 颜色写语义令牌（amber/blue/green/purple/red/ink/muted）或 #rrggbb；voxel 的 palette 键必须是单个字符。
- voxel 的 layers 与 shapes 二选一；用 shapes 时只有会放置体素的形状需要 fill（collapse 是挖空，不需要）。
- 不要自己算缩放与取景 —— 引擎会自动把场景放进画布，你只描述有什么、在哪、什么颜色。
- 需要转动或切开看内部时用 ```isometric-interactive；静态图用 ```isometric。

## 完整示例

```isometric
{
  "title": "分层部署 · 零件配方",
  "desc": "底座、三层服务、机架与节点阵列，都由零件配方一次写成。",
  "case": [6.4, 6.4, 4.6],
  "cut": 2.6,
  "objects": [
    { "type": "part", "part": "base", "at": [0, 0, -2.0], "size": [5.6, 5.6], "color": "ink", "label": "底座" },
    { "type": "part", "part": "stack", "at": [-1.45, -1.45, -1.2], "layers": 3, "size": [2.2, 2.2], "gap": 0.72, "colors": ["amber", "green", "blue"], "label": "三层服务" },
    { "type": "part", "part": "rack", "at": [1.5, -1.5, -0.5], "size": [1.4, 1.4], "height": 2.6, "slots": 6, "color": "ink", "label": "机架" },
    { "type": "part", "part": "grid", "at": [-1.5, 1.5, -1.67], "count": [3, 2], "size": [0.44, 0.44, 0.44], "spacing": [0.8, 0.8], "color": "purple", "label": "节点阵列" }
  ],
  "callouts": [
    { "at": [-1.45, -1.45, 0.24], "text": "三层服务" },
    { "at": [1.5, -1.5, 0.6], "text": "机架" }
  ]
}
```
## 零件配方

图元是积木，配方是成品件。写 `{ "type": "part", "part": "stack", "layers": 3 }` 比一个个摆板子省得多，也更不容易摆歪。公共参数是 `at`（中心）、`color`、`label`。

| 配方 | 是什么 | 参数 |
| --- | --- | --- |
| `base` | 底座 + 四角支脚，给场景一个落地感 | size, thickness, footHeight, feet |
| `stack` | 分层堆叠：每层一块板，层间留空 | layers, size, gap, thickness, colors[] |
| `rack` | 机架：四柱 + 顶底 + 槽位 | size, height, slots, post |
| `grid` | 阵列：集群 / 机柜排 / 节点网格 | count[列,行], size, spacing |
| `tower` | 塔楼：角柱 + 楼板 | size, floors, floorHeight, slab, post |
| `dial` | 表盘：盘面 + 表圈 + 指针 | r, height, needle（弧度 0..1）, needleColor |
| `rail` | 导轨 + 滑台 + 两端限位 | length, gauge, rail, carriage, carriageAt(0..1), carriageColor |
| `post` | 立柱 + 底座法兰 + 卡箍 | height, r, clampAt(0..1), clampColor |

`case` 可以是数字（立方体）或 `[宽, 深, 高]`（扁柜子）——宽而矮的场景塞进立方体会浪费大半画幅。

关系检查会跑在配方上：引线必须落在某个配方或图元的包围盒内。**配方内部不做互穿判定**——它的几何是展开出来的，只有包围盒，而按包围盒判互穿会报出并不存在的重叠。
