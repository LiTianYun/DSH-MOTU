# 体素模型

体素方块模型 —— 用方块表达体量、密度与"切掉一角看内部"（ASCII 图层直接摆方块，最省 token）

- 栅栏：```voxel / ```voxel-interactive
- 引擎：内置于插件（无第三方引擎，投影在本地计算）
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

JSON：{ "grid": 17, "palette": { "#": "amber", "o": "purple" }, "shapes": [{ "shape": "shell", "r": 7, "thickness": 1.6, "fill": "#" }] }；shapes 可用 shell/ball/box/cluster/collapse，或直接写 "layers": ["#####\n#...#"]（每层一段，z 从下往上）；颜色用语义令牌或 #rrggbb

## 易错点

- JSON：{ "grid": 17, "palette": { "#": "amber", "o": "purple" }, "shapes": [{ "shape": "shell", "r": 7, "thickness": 1.6, "fill": "#" }] }；shapes 可用 shell/ball/box/cluster/collapse，或直接写 "layers": ["#####\n#...#"]（每层一段，z 从下往上）；颜色用语义令牌或 #rrggbb

## 完整示例

```voxel
{
  "grid": 13,
  "cut": true,
  "height": 320,
  "title": "体素剖面 · 薄壳与核心",
  "desc": "蓝色只有薄薄一层壳，里面是琥珀色的结构层与绿色核心；切开一角就看得到。",
  "palette": {
    "#": "blue",
    "o": "amber",
    "@": "green"
  },
  "shapes": [
    {
      "shape": "ball",
      "r": 6,
      "fill": "#"
    },
    {
      "shape": "ball",
      "r": 5.1,
      "fill": "o"
    },
    {
      "shape": "cluster",
      "count": 8,
      "r": 2.6,
      "fill": "@",
      "seed": 7
    }
  ],
  "legend": [
    {
      "color": "blue",
      "text": "薄壳"
    },
    {
      "color": "amber",
      "text": "结构层"
    },
    {
      "color": "green",
      "text": "核心"
    }
  ]
}
```
