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
| `palette` | 对象或 `null` | 智能配色：从一个种子色生成两种模式的整套颜色 token |
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

  // 智能配色（可选）：从种子色生成两种模式的全部颜色 token，上面的 colors 在它之上再细化。
  "palette": {
    "seed": "#5eead4",          // 只取它的色相和彩度
    "variant": "natural",       // natural | vivid | soft | oled | contrast
    "backdrop": null            // 可选，壁纸平均色；有它时会检查透明表面上的文字对比度
  },

  // 其他 CSS 自定义属性。顶层写的对两种模式都生效，dark / light 里写的只对该模式生效并覆盖顶层。
  "vars": {
    "--my-gap": "6px",
    "dark": { "--my-gap": "8px" }
  },

  // 壁纸。顶层字段对两种模式都生效；dark / light 里的字段只对该模式生效并覆盖顶层；
  // 写 "light": null 表示亮色模式不要壁纸。
  "wallpaper": {
    "fit": "cover",             // cover | contain | fill | tile | center
    "position": "center",       // CSS background-position，也是缩放的锚点
    "blur": 0,                  // 壁纸模糊半径，px
    "dim": 0.35,                // 遗留遮罩强度 0~1；新导入图片无个人设置时会使用 0
    "overlay": null,            // 可选遮罩颜色；省略时依模式使用默认颜色
    "scale": 1,                 // 缩放倍数 0.1~4，以 position 为锚点，1 = 原样
    "saturate": 1,              // 饱和度 0~4，1 = 不调整
    "brightness": 1,            // 亮度 0~2，1 = 不调整
    "contrast": 1,              // 对比度 0~2，1 = 不调整
    "grayscale": 0,             // 灰度 0~1，0 = 彩色
    "dark":  { "image": "wallpaper-dark.jpg" },
    "light": { "image": "wallpaper-light.jpg", "dim": 0.15 }
  },

  "glass": {
    "material": "acrylic",      // acrylic | mica | tabbed | none。Windows 用原生材质；
                                // macOS 一律映射为原生毛玻璃，none 关闭；Linux 忽略此项
    "opacity": 0.6,             // 主内容区的最终不透明度 0~1；1 = 官方外观
    "blur": 16,                 // 主内容区的背景模糊半径，px
    "regions": {                // 可选，按区域单独设置；没写的区域或字段跟随上面两项
      "frame": { "opacity": 0.4 },              // 窗口与侧栏（只能调透明度）
      "input": { "opacity": 0.85, "blur": 24 }  // 另有 main、card
    }
  },

  // 启动画面。系统开启「减少动画」时 logo 一律静止显示，与官方一致；
  // animation 为 none 时也是静止的，停留时间与官方动画相同。
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

- 用户配置**逐字段**覆盖主题，例如只设 `glass.blur` 不会影响主题的 `glass.opacity`。外观中心“恢复主题默认”会删除个人 `glass`、`accent`、`radius` 覆盖并保留壁纸选择。
- 写 `null` 表示去掉主题设置的这一项，例如 `"wallpaper": null`、`"radius": null`、`"accent": null`。
- `wallpaper` 和 `vars` 都遵循同一条"按模式细化"规则：顶层字段对两种模式生效，`dark` / `light` 里的字段只对该模式生效，并覆盖顶层；某个模式写 `null` 表示只在该模式下去掉。
- 主题 `accent` 和主题 `colors` 同时出现时，`colors` 里显式写的 token 优先，`accent` 只补空缺。用户 `config.accent` 会覆盖主题提供的 `primary`、`brand`、`ring` 和 `primary-foreground`（包括主题 `colors` 中的显式值）；用户 `config.colors` 中显式写的 token 仍优先。
- `palette` 生成的 token 放在它所在的那一层：用户配置里的 `palette` 会覆盖主题 `colors` 里的同名 token（即“给主题换一套配色”），主题自己的 `colors` 则在主题 `palette` 之上细化。`palette` 生成的主色同样会被用户 `config.accent` 覆盖。用户配置写 `"palette": null` 会去掉主题的智能配色。
- `glass.regions` 按区域、按字段合并：用户只设 `regions.main.blur` 不会影响主题的 `regions.main.opacity`。

外观中心拖动控件时，主进程只读校验请求并生成完整 CSS，当前窗口即时替换预览样式；预览不会写配置或广播，较早返回的预览会忽略。松手后才原子保存并同步其他主窗口。

新导入的壁纸（包括 CLI 导入）在个人配置没有设置顶层或按模式的 `dim` 时会写入 `dim: 0`，避免继承主题遮罩。既有配置不会自动迁移；旧版非零遮罩会在外观中心图片亮度控制旁提示并可清除。`dim` 是兼容保留的遮罩强度，不代表图片亮度。

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

`colors` 只放颜色 token，键只能是 token 名（`sidebar` 或 `--color-sidebar`，小写字母、数字和 `-`）。在里面写 `--radius-xl` 这类其他自定义属性会被忽略并给出警告，请改用 `radius` 或 `vars`。

## 智能配色

`palette` 只需要一个种子色，Canvas 会在 OKLCH 色彩空间里按固定的明度阶梯生成两种模式的约 50 个 token：窗口、侧栏、主区域、卡片、输入框、弹出层、边框与悬停、三级文字、强调色（`primary` / `brand` / `ring` 等）、终端，以及成功 / 警告 / 错误色。同一套明度对所有色相一致，所以换种子色不会让界面忽明忽暗。

五种风格：

| `variant` | 效果 |
|---|---|
| `natural` | 默认。表面带一点种子色倾向，强调色饱和度适中 |
| `vivid` | 表面与强调色都更鲜艳 |
| `soft` | 低饱和，接近灰阶 |
| `oled` | 暗色模式的窗口和主区域是纯黑；亮色模式同 `natural` |
| `contrast` | 高对比：文字更亮 / 更暗，边框更明显，对比度目标更高 |

种子色几乎是灰色（OKLCH 彩度低于 0.02）时，整套配色保持单色，不会凭空造出一个色相。

**对比度保护。** 每个承载文字的 token 生成后都会按 WCAG 对比度对照它所在的表面检查，不达标就沿远离背景的方向调整明度，直到达标：正文 ≥ 7:1，次级文字和强调色 ≥ 4.5:1，最弱的提示文字 ≥ 3:1（`contrast` 风格分别是 12 / 7 / 4.5），按钮和状态徽标上的文字 ≥ 4.5:1。

写了 `backdrop`（壁纸平均色，外观中心取色时会自动带上）并且当前模式有壁纸、主区域半透明时，正文还会对照“表面叠在壁纸上实际显示的颜色”再检查一次，壁纸自身的亮度和遮罩也计入。壁纸太亮、透明度太高，正文已经调到最亮仍低于 4.5:1（`contrast` 风格为 7:1）时，外观中心会提示调低界面透明或图片亮度。Canvas 不会替你改透明度。

外观中心的「智能配色」会从当前壁纸取出最多 5 个种子色；也可以自选任意颜色作种子。

## 分区玻璃

`glass.regions` 让下面四个区域各用自己的透明度（`opacity`）和模糊（`blur`）。没有写的区域或字段跟随 `glass.opacity` / `glass.blur`，所以只调一个区域时其余保持不变。

| 区域 | 包含的表面 | 可调 |
|---|---|---|
| `frame` | 窗口外框。ZCode 的侧栏没有自己的背景，看到的就是它 | 透明度 |
| `main` | 主内容区、侧边面板、标签、终端底色 | 透明度、模糊 |
| `card` | 卡片、代码块、次级按钮 | 透明度、模糊 |
| `input` | 输入框，包括对话输入框聚焦时 | 透明度、模糊 |

几条由叠放关系决定的规则：

- `frame` 是整个窗口的最底层。它不透明（`opacity: 1`）时，壁纸和原生材质都看不到，其他区域也只能透出它的颜色。
- `main` 叠在 `frame` 上面，看起来不会比 `frame` 更通透；设得比它还低时，主区域自身完全透明，显示的就是 `frame`。
- `frame` 不能设模糊：外框上的背景模糊会截断主区域对壁纸的模糊。

每个区域的数值和整体 `glass.opacity` 含义相同，只是只作用于这个区域，计算方式见「透明度是怎么算的」。

## 圆角

ZCode 的 `rounded-sm`、`rounded-xl` 等类都读 Tailwind 的 `--radius-xs` … `--radius-4xl` 变量。`radius` 按倍数缩放这一整组变量：`0` 是全直角，`0.5` 是官方圆角的一半，`1` 等于不设置。`rounded-full` 不走这些变量，所以头像、开关、状态点始终是圆的。

## vars

`vars` 用来设置没有专门字段的 CSS 自定义属性，键必须以 `--` 开头，值要写成字符串（例如 `"0"` 而不是 `0`）。它是兜底手段：依赖 ZCode 内部变量名的主题，在 ZCode 改名后可能失效。常用的需求会逐步变成专门字段。

## 透明度是怎么算的

`glass.opacity` 小于 1 时，Canvas 把下面三层表面调成半透明：

- **外框层**：`background-win-alt`、`background-alt`、`sidebar`，不透明度为 `opacity × 0.7`。ZCode 在 Windows 和 Linux 上外框用 `background-win-alt`，macOS 用 `background-alt`（叠在原生 vibrancy 上），两层 token 都会被调整；
- **内容层**：`background`、`panel`、`header`、`tab`、`terminal-bg` 等。它们叠在外框层上面，所以自身的不透明度是反推出来的，保证两层叠加后正好等于 `opacity`；
- **凸起层**：`card`、`secondary`、`input`、`input-focused`，比内容层更不透明一些，保证文字清晰。

设置了 `glass.regions` 时，每一层用所属区域自己的 `opacity` 代入上面的公式；内容层按外框层实际的不透明度反推。某个区域的 `opacity` 为 1 时，它的 token 保持官方颜色不动。

透出来的东西按平台不同：Windows 是 acrylic/mica 材质，macOS 是原生 vibrancy，Linux 是窗口本身的透明（需要合成器支持；不支持时毛玻璃退化为纯色，壁纸不受影响，因为壁纸绘制在页面内部）。

弹出层（菜单、对话框、提示）挂在 `#root` 外面，始终保持不透明。

## 按模式区分的壁纸与启动画面

ZCode 在首帧之后才给页面加上亮色 / 暗色的 class，启动画面出现时还不知道当前模式。所以：

- 两种模式用同一张壁纸时，壁纸在启动画面后面就可见；
- 两种模式的壁纸不同时，启动画面期间不显示壁纸，界面淡入时再显示对应模式的那一张，避免先闪一下另一个模式的壁纸。想让启动画面有底色，请设置 `startup.background`。

`startup` 本身不区分模式，原因相同。

## 安全限制

主题值不是过滤出来的，而是按字段限定语法生成的；`schema/theme.schema.json` 里的规则与运行时完全一致（测试保证两者同步）：

- 颜色字段（`colors`、`accent`、`wallpaper.overlay`）：十六进制、命名颜色和颜色函数 `rgb()` / `hsl()` / `oklch()` / `color-mix()` 等；
- `startup.background`：颜色，外加 `linear-gradient()` 等渐变函数；
- `wallpaper.position`：方位词、长度、百分比和 `calc()`；
- `vars` 的值最宽松：还允许引号（字体栈）和 `var()` 引用，但函数白名单相同。

所有值都不能包含 `;` `{` `}` `<` `>` `@`、反斜杠、引号（`vars` 除外）或控制字符，函数名用小写；函数调用只允许白名单里的名字。因此 `ur\6c(...)`、`image-set(...)` 这类绕过写法和 `url()` 一样会被拒绝。不合规的项被忽略，并在 `~/.zcode-canvas/runtime.log` 里记录警告。`colors` 的键只接受颜色 token 名。图片只能通过 `wallpaper.image`（含 `wallpaper.dark.image` / `wallpaper.light.image`）和 `startup.logo` 引用本地文件，主题无法加载远程资源。Canvas 不接受任意 CSS；需要新的界面能力时，会以白名单字段的形式加入格式。

`zcode-canvas use` 和 `themes` 还会按同一份 schema 对 `theme.json` 做完整结构校验（嵌套字段的类型、枚举、未知键），不合格的主题无法启用；运行时则保持宽容，只记录警告，保证 ZCode 总能启动。

## 调试

```sh
zcode-canvas themes   # 列出主题，并显示每个主题的格式与 schema 校验警告
zcode-canvas css      # 打印当前生成的 CSS
```

运行日志在 `~/.zcode-canvas/runtime.log`。
