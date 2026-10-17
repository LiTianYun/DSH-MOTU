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
  "grid": 15,
  "title": "体素剖面 · 中空壳体与核心",
  "desc": "外壳是方块墙、中心一列琥珀色核心，切掉靠近观察者的一角看到内部。",
  "cut": true,
  "palette": { "#": "blue", "o": "amber", "@": "ink" },
  "shapes": [
    { "shape": "shell", "r": 6.4, "thickness": 1.5, "fill": "#" },
    { "shape": "cluster", "count": 12, "r": 4.2, "fill": "o", "seed": 5 },
    { "shape": "ball", "r": 1.6, "fill": "@" }
  ],
  "legend": [
    { "color": "blue", "text": "壳体" },
    { "color": "amber", "text": "结构单元" },
    { "color": "ink", "text": "核心" }
  ]
}
```
