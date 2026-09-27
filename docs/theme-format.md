# 主题格式

一个主题就是 `~/.zcode-canvas/themes/<id>/` 目录下的一个文件夹：

```
my-theme/
├─ theme.json
├─ wallpaper.jpg     （可选）
└─ logo.png          （可选）
```

`theme.json` 里的相对路径都相对于主题目录解析。用户在 `config.json` 或 `zcode-canvas set` 里写的同名字段会逐项覆盖主题的值；如果写成 `null`，表示去掉主题设置的这一项，例如 `"wallpaper": null`。

用户主题目录里的主题会覆盖同 id 的内置主题。

## 完整示例

```jsonc
{
  "name": "我的主题",
  "author": "you",
  "description": "一句话说明",

  // ZCode 设计 token，按暗色 / 亮色分开。
  // 键可以省略前缀（"sidebar" 就是 --color-sidebar），也可以写完整的自定义属性名（"--color-sidebar"）。
  "colors": {
    "dark":  { "background": "#0c1220", "sidebar": "#080d18", "foreground": "#d5deef" },
    "light": { "background": "#fff7fa" }
  },

  // 强调色：同时设置 --color-primary / --color-brand / --color-ring；
  // --color-primary-foreground 按对比度自动选黑或白（也可以在 colors 里显式指定）。
  // 可以写一个值，也可以写成 { "dark": ..., "light": ... }。
  "accent": "#5eead4",

  "wallpaper": {
    "image": "wallpaper.jpg",   // png / jpg / webp / avif / gif / svg
    "fit": "cover",             // cover | contain | fill | tile | center
    "position": "center",       // CSS background-position
    "blur": 0,                  // 壁纸模糊半径，px
    "dim": 0.35,                // 遮罩强度 0~1
    "overlay": null             // 遮罩颜色，默认暗色模式为黑、亮色模式为白
  },

  "glass": {
    "material": "acrylic",      // acrylic | mica | tabbed | none（Windows 窗口材质）
    "opacity": 0.6,             // 主内容区的最终不透明度 0~1；1 = 官方外观
    "blur": 16                  // 主内容区的背景模糊半径，px
  },

  "startup": {
    "background": null,         // 启动画面背景，颜色或渐变
    "logo": "logo.png",         // 替换中间的 ZCode logo
    "logoSize": 96,             // px
    "animation": "pop"          // pop（官方）| fade | none
  }
}
```

实际的 `theme.json` 是标准 JSON，不能写注释。

## 常用 token

下面是 ZCode 在 `packages/ui/src/styles.css` 里定义的 token 的一部分：

| 用途 | token |
|---|---|
| 窗口外框 / 侧栏底 | `background-win-alt`, `sidebar` |
| 主内容区 | `background`, `panel`, `header` |
| 卡片、输入框 | `card`, `input`, `secondary` |
| 弹出层 | `popover`, `popover-header`, `menu`, `menu-hover`, `tooltip`, `toast` |
| 文字 | `foreground`, `foreground-subtle`, `foreground-subtlest` |
| 线与状态 | `border`, `border-hover`, `hover`, `selected`, `surface`, `surface-hover` |
| 强调 | `primary`, `primary-foreground`, `brand`, `accent`, `ring` |
| 终端 | `terminal-bg`, `terminal-fg`, `terminal-cursor`, `terminal-*` |

## 透明度是怎么算的

`glass.opacity` 小于 1 时，Canvas 把下面三层表面调成半透明：

- **外框层**：`background-win-alt`、`background-alt`、`sidebar`，不透明度为 `opacity × 0.7`；
- **内容层**：`background`、`panel`、`header`、`tab`、`terminal-bg` 等。它们叠在外框层上面，所以自身的不透明度是反推出来的，保证两层叠加后正好等于 `opacity`；
- **凸起层**：`card`、`input`、`secondary`，比内容层更不透明一些，保证文字清晰。

弹出层（菜单、对话框、提示）挂在 `#root` 外面，始终保持不透明。

## 安全限制

颜色和 CSS 值里不能包含 `;`、`{`、`}`、`<`、`>`、`url(`、`@import`，否则这一项会被忽略，并在 `~/.zcode-canvas/runtime.log` 里记录警告。图片只能通过 `wallpaper.image` 和 `startup.logo` 引用本地文件，主题无法加载远程资源。

## 调试

```powershell
zcode-canvas css      # 打印当前生成的 CSS
```

运行日志在 `~/.zcode-canvas/runtime.log`。
