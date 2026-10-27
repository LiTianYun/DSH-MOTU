# 代码差异

代码改动、补丁、版本对比 —— 逐行增删上色，行号取自 hunk 头

- 栅栏：```diff / ```patch
- 引擎：内置于插件（无第三方引擎，投影在本地计算）
- 字体：字体使用宿主应用的字体栈，与正文同字号（13px），无需你处理。

## 语法

直接贴 unified diff 原文（diff --git / --- a/… / +++ b/… / @@ -17,23 +17,23 @@ / 行首 + - 空格），不要包成 JSON

## 易错点

- 直接贴 unified diff 原文（diff --git / --- a/… / +++ b/… / @@ -17,23 +17,23 @@ / 行首 + - 空格），不要包成 JSON

## 完整示例

```diff
--- a/user/main.c
+++ b/user/main.c
@@ -17,7 +17,7 @@
 #ifdef TEMP_100K
-    #define _VER_    "10A1"
+    #define _VER_    "10A3"
 #else
-    #define _VER_    "1001"
+    #define _VER_    "1003"
 #endif
```
