# 主题格式（format 1）

一个主题就是 `~/.zcode-canvas/themes/<id>/` 目录下的一个文件夹：

```
my-theme/
├─ theme.json
├─ wallpaper.jpg        （可选；也可以按模式分成 wallpaper-dark.jpg / wallpaper-light.jpg）
└─ logo.png             （可选）
```

`theme.json` 里的相对路径都相对于主题目录解析。用户主题目录里的主题会覆盖同 id 的内置主题。

## 兼容性约定

- 当前格式版本是 **1**，写在 `"format": 1`。不写时按 1 处理。
- format 1 之内只做**向后兼容的新增**：新字段、新的可选值。已有字段的含义和写法不会再变。
- 真有不兼容的改动时，format 会升到 2。Canvas 遇到比自己新的 format 仍会尽力加载，但会给出警告，提示升级 zcode-canvas。
- 不认识的顶层字段会被忽略，并在 `zcode-canvas themes` 和运行日志里给出警告，拼错字段名可以很快发现。

## 编辑器校验

在 `theme.json` 开头加上 `$schema`，VS Code 等编辑器会按 [schema/theme.schema.json](../schema/theme.schema.json) 做补全和校验：

```json
{
  "$schema": "https://raw.githubusercontent.com/Kevinzzz6/zcode-canvas/main/schema/theme.schema.json",
  "format": 1,
  "name": "我的主题"
}
```

`zcode-canvas new <id>` 生成的主题已经带上了这两行。

## 字段一览

| 字段 | 类型 | 说明 |
|---|---|---|
| `$schema` | 字符串 | 编辑器用的 schema 地址，Canvas 不读取 |
| `format` | 数字 | 格式版本，目前是 `1` |
| `name` | 字符串 | **必填**，显示名 |
| `description` | 字符串 | 一句话说明 |
| `author` | 字符串 | 作者 |
| `version` | 字符串 | 主题自身的版本，如 `"1.0.0"` |
| `license` | 字符串 | SPDX 许可证标识，如 `"MIT"` |
| `source` | 字符串 | 主题或其改编来源的地址 |
| `modes` | 数组 | 主题适配的模式：`["dark"]`、`["light"]` 或两者；不写表示两者都适配 |
| `colors` | 对象 | ZCode 颜色 token，按 `dark` / `light` 分开 |
| `accent` | 字符串或按模式 | 强调色，只补 `colors` 没有写的 token |
| `radius` | 数字 | 圆角倍数，`1` 为官方，`0` 为全直角 |
| `vars` | 对象 | 没有专门字段的其他 CSS 自定义属性 |
| `wallpaper` | 对象或 `null` | 壁纸，可以按模式细化 |
| `glass` | 对象 | 窗口材质与界面半透明 |
| `startup` | 对象 | 启动画面 |

## 完整示例

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Kevinzzz6/zcode-canvas/main/schema/theme.schema.json",
  "format": 1,
  "name": "我的主题",
  "description": "一句话说明",
  "author": "you",
  "version": "1.0.0",
  "license": "MIT",
  "modes": ["dark", "light"],

  // ZCode 颜色 token，按暗色 / 亮色分开。
  // 键可以省略前缀（"sidebar" 就是 --color-sidebar），也可以写完整名（"--color-sidebar"）。
  "colors": {
    "dark":  { "background": "#0c1220", "sidebar": "#080d18", "foreground": "#d5deef" },
    "light": { "background": "#fff7fa", "primary": "#1f2937" }
  },

  // 强调色：补上 --color-primary / --color-brand / --color-ring，
  // 以及按对比度自动选黑或白的 --color-primary-foreground。
  // colors 里显式写了的 token 以 colors 为准：上例亮色的 primary 保持 #1f2937，brand 和 ring 取强调色。
  // 可以写一个值，也可以写成 { "dark": ..., "light": ... }。
  "accent": "#5eead4",

  "radius": 0.5,                // 圆角减半；0 = 全直角

  // 其他 CSS 自定义属性。顶层写的对两种模式都生效，dark / light 里写的只对该模式生效并覆盖顶层。
  "vars": {
    "--my-gap": "6px",
    "dark": { "--my-gap": "8px" }
  },

  // 壁纸。顶层字段对两种模式都生效；dark / light 里的字段只对该模式生效并覆盖顶层；
  // 写 "light": null 表示亮色模式不要壁纸。
  "wallpaper": {
    "fit": "cover",             // cover | contain | fill | tile | center
    "position": "center",       // CSS background-position
    "blur": 0,                  // 壁纸模糊半径，px
    "dim": 0.35,                // 遮罩强度 0~1
    "overlay": null,            // 遮罩颜色，默认暗色模式为黑、亮色模式为白
    "dark":  { "image": "wallpaper-dark.jpg" },
    "light": { "image": "wallpaper-light.jpg", "dim": 0.15 }
  },

  "glass": {
    "material": "acrylic",      // acrylic | mica | tabbed | none。Windows 用原生材质；
                                // macOS 一律映射为原生毛玻璃，none 关闭；Linux 忽略此项
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

实际的 `theme.json` 是标准 JSON，不能写注释。只有一种壁纸时直接写 `"wallpaper": { "image": "wallpaper.jpg" }` 即可。

## 合并规则

最终外观由两层叠成：先是主题，再是用户的 `~/.zcode-canvas/config.json`（`zcode-canvas set` 写的就是它）。

- 用户配置**逐字段**覆盖主题，例如只设 `glass.blur` 不会影响主题的 `glass.opacity`。
- 写 `null` 表示去掉主题设置的这一项，例如 `"wallpaper": null`、`"radius": null`、`"accent": null`。
- `wallpaper` 和 `vars` 都遵循同一条"按模式细化"规则：顶层字段对两种模式生效，`dark` / `light` 里的字段只对该模式生效，并覆盖顶层；某个模式写 `null` 表示只在该模式下去掉。
- `accent` 和 `colors` 同时出现时，`colors` 里显式写的 token 优先，`accent` 只补空缺。

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

`colors` 只放颜色 token。在里面写 `--radius-xl` 这类别的自定义属性仍然会生效，但会得到警告，请改用 `radius` 或 `vars`。

## 圆角

ZCode 的 `rounded-sm`、`rounded-xl` 等类都读 Tailwind 的 `--radius-xs` … `--radius-4xl` 变量。`radius` 按倍数缩放这一整组变量：`0` 是全直角，`0.5` 是官方圆角的一半，`1` 等于不设置。`rounded-full` 不走这些变量，所以头像、开关、状态点始终是圆的。

## vars

`vars` 用来设置没有专门字段的 CSS 自定义属性，键必须以 `--` 开头，值要写成字符串（例如 `"0"` 而不是 `0`）。它是兜底手段：依赖 ZCode 内部变量名的主题，在 ZCode 改名后可能失效。常用的需求会逐步变成专门字段。

## 透明度是怎么算的

`glass.opacity` 小于 1 时，Canvas 把下面三层表面调成半透明：

- **外框层**：`background-win-alt`、`background-alt`、`sidebar`，不透明度为 `opacity × 0.7`。ZCode 在 Windows 和 Linux 上外框用 `background-win-alt`，macOS 用 `background-alt`（叠在原生 vibrancy 上），两层 token 都会被调整；
- **内容层**：`background`、`panel`、`header`、`tab`、`terminal-bg` 等。它们叠在外框层上面，所以自身的不透明度是反推出来的，保证两层叠加后正好等于 `opacity`；
- **凸起层**：`card`、`input`、`secondary`，比内容层更不透明一些，保证文字清晰。

透出来的东西按平台不同：Windows 是 acrylic/mica 材质，macOS 是原生 vibrancy，Linux 是窗口本身的透明（需要合成器支持；不支持时毛玻璃退化为纯色，壁纸不受影响，因为壁纸绘制在页面内部）。

弹出层（菜单、对话框、提示）挂在 `#root` 外面，始终保持不透明。

## 按模式区分的壁纸与启动画面

ZCode 在首帧之后才给页面加上亮色 / 暗色的 class，启动画面出现时还不知道当前模式。所以：

- 两种模式用同一张壁纸时，壁纸在启动画面后面就可见；
- 两种模式的壁纸不同时，启动画面期间不显示壁纸，界面淡入时再显示对应模式的那一张，避免先闪一下另一个模式的壁纸。想让启动画面有底色，请设置 `startup.background`。

`startup` 本身不区分模式，原因相同。

## 安全限制

颜色和 CSS 值里不能包含 `;`、`{`、`}`、`<`、`>`、`url(`、`@import`，否则这一项会被忽略，并在 `~/.zcode-canvas/runtime.log` 里记录警告。图片只能通过 `wallpaper.image`（含 `wallpaper.dark.image` / `wallpaper.light.image`）和 `startup.logo` 引用本地文件，主题无法加载远程资源。Canvas 不接受任意 CSS；需要新的界面能力时，会以白名单字段的形式加入格式。

## 调试

```sh
zcode-canvas themes   # 列出主题，并显示每个主题的格式警告
zcode-canvas css      # 打印当前生成的 CSS
```

运行日志在 `~/.zcode-canvas/runtime.log`。
