import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { themeSchemaProblems } from "./schema.ts";
import { buildCss } from "../shared/css.ts";
import {
  canvasHome,
  checkManifest,
  FORMAT_VERSION,
  listThemes,
  loadLook,
  MATERIALS,
  MODES,
  paths,
  readConfig,
  SCHEMA_URL,
  STARTUP_ANIMATIONS,
  WALLPAPER_FITS,
  type CanvasConfig,
  type ThemeEntry,
  type ThemeManifest,
  type WallpaperLayer,
} from "../shared/look.ts";
import {
  applyPatch,
  deployRuntime,
  hasPendingSwap,
  isZCodeRunning,
  locateZCode,
  packageVersion,
  readState,
  removePatch,
  runPendingSwap,
  type ReplaceOutcome,
} from "../installer/zcode.ts";

const cliPath = fileURLToPath(import.meta.url);
const packageRoot = dirname(dirname(cliPath));
const home = canvasHome();
const packagedThemes = join(packageRoot, "themes");

const HELP = `ZCode Canvas ${packageVersion(packageRoot)} — 官方 ZCode 的主题 / 壁纸 / 毛玻璃 / 启动画面

用法: zcode-canvas <命令> [参数]

  status                 查看 ZCode 安装、补丁和当前主题状态
  apply                  安装运行时并给 ZCode 打补丁（ZCode 更新后重新执行一次）
  restore [--purge]      还原官方 app.asar；--purge 同时删除 ~/.zcode-canvas
  themes                 列出可用主题
  use <主题|none>         切换主题（ZCode 运行中实时生效）
  set <键> <值>           修改单项设置，如: set wallpaper.image ~/pic.jpg
  unset <键>              删除设置（可以是整组，如 wallpaper），回到主题默认值
  new <id>               以当前设置新建一个主题（会复制用到的图片）
  css                    打印当前生成的 CSS
  open                   在文件管理器中打开 ~/.zcode-canvas

通用参数:
  --zcode <目录>          ZCode 安装目录（默认自动查找；macOS 也可传 ZCode.app 所在目录）

可设置的键:
  enabled                     true | false
  theme                       主题 id
  accent                      强调色，如 #7c5cff（也可 accent.dark / accent.light）
  colors.dark.<token>         暗色 token，如 colors.dark.sidebar "#101418"
  colors.light.<token>        亮色 token
  radius                      圆角倍数，1 = 官方，0 = 全直角
  vars.<--属性>               其他 CSS 自定义属性（也可 vars.dark.<--属性> / vars.light.<--属性>）
  wallpaper.image             图片路径 (png/jpg/webp/avif/gif/svg)
  wallpaper.fit               ${WALLPAPER_FITS.join(" | ")}
  wallpaper.position          CSS background-position，如 "right bottom"
  wallpaper.blur              壁纸模糊 px
  wallpaper.dim               遮罩强度 0~1
  wallpaper.overlay           遮罩颜色（默认暗色黑 / 亮色白）
  wallpaper.dark.<项>         只对暗色生效的壁纸设置，如 wallpaper.dark.image；亮色同理
  glass.material              ${MATERIALS.join(" | ")}（Windows 窗口材质；macOS 映射为原生
                             毛玻璃，none 关闭；Linux 忽略此项，透明度由窗口本身决定）
  glass.opacity               界面表面不透明度 0~1，1 = 官方外观
  glass.blur                  主内容区背景模糊 px
  startup.background          启动画面背景（颜色或渐变）
  startup.logo                启动 logo 图片路径
  startup.logoSize            启动 logo 尺寸 px
  startup.animation           ${STARTUP_ANIMATIONS.join(" | ")}
`;

interface Args {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (name === "zcode" && next !== undefined) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else positional.push(arg);
  }
  return { command: positional.shift(), positional, flags };
}

function writeConfig(config: CanvasConfig) {
  mkdirSync(home, { recursive: true });
  writeFileSync(paths.config(home), `${JSON.stringify(config, null, 2)}\n`);
}

const FILE_KEYS = new Set(["wallpaper.image", "wallpaper.dark.image", "wallpaper.light.image", "startup.logo"]);
const ALLOWED_KEY = /^(enabled|theme|accent|accent\.(dark|light)|colors\.(dark|light)\.(--color-)?[a-z0-9][a-z0-9-]*|radius|vars\.((dark|light)\.)?--[\w-]+|wallpaper\.((dark|light)\.)?(image|fit|position|blur|dim|overlay)|glass\.(material|opacity|blur)|startup\.(background|logo|logoSize|animation))$/;
const UNSETTABLE_GROUP = /^(colors|colors\.(dark|light)|vars|vars\.(dark|light)|wallpaper|wallpaper\.(dark|light)|glass|startup)$/;

function parseValue(key: string, raw: string): unknown {
  // Colors and custom property values are CSS text; "0" must stay a string rather than become a number.
  if (/^(colors|vars|accent)\./.test(key) || key === "accent") return raw;
  if (FILE_KEYS.has(key)) {
    const file = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    if (!existsSync(file)) throw new Error(`文件不存在: ${file}`);
    return file;
  }
  if (raw === "true" || raw === "false" || raw === "null") return JSON.parse(raw);
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function setPath(target: Record<string, unknown>, key: string, value: unknown) {
  const parts = key.split(".");
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
    node = node[part] as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete node[last];
  else node[last] = value;
}

function describeOutcome(outcome: ReplaceOutcome, action: string) {
  if (outcome === "replaced") console.log(`✓ 已${action}。重新启动 ZCode 后生效。`);
  else
    console.log(
      `✓ 已准备好${action}，但 ZCode 正在运行，app.asar 被占用。\n` +
        "  请从托盘彻底退出 ZCode（关闭窗口只会缩到托盘），后台助手会在退出后自动替换，然后再启动 ZCode 即可。",
    );
}

function permissionTip(): string {
  if (process.platform === "win32") return "  ZCode 装在受保护目录（如 Program Files）时，请用管理员身份运行终端。";
  if (process.platform === "linux")
    return "  Linux 下 ZCode 通常装在 /opt/ZCode（属于 root），请用 sudo 重试，例如: sudo zcode-canvas apply\n  （运行时和配置仍会装到你的用户目录，不会放到 /root 下）";
  return "  ZCode 所在位置不可写，请用 sudo 重试，例如: sudo zcode-canvas apply";
}

function revealInFileManager(path: string) {
  const tool = process.platform === "win32" ? "explorer" : process.platform === "darwin" ? "open" : "xdg-open";
  spawn(tool, [path], { detached: true, stdio: "ignore" }).unref();
}

/** Everything wrong with a theme's manifest: the shallow checks plus the full schema. */
function themeProblems(entry: ThemeEntry): string[] {
  return [...checkManifest(entry.id, entry.manifest), ...themeSchemaProblems(packageRoot, entry.manifest)];
}

function status(explicit?: string) {
  const install = locateZCode(explicit);
  const state = readState(install);
  const config = readConfig(home);
  const runtimeVersionFile = join(paths.runtime(home), "version.json");
  const runtimeVersion = existsSync(runtimeVersionFile)
    ? (JSON.parse(readFileSync(runtimeVersionFile, "utf8")) as { version: string }).version
    : null;
  const { warnings } = loadLook(home, [packagedThemes]);
  console.log(`ZCode 安装目录   ${install.dir}`);
  console.log(`ZCode 版本       ${state.zcodeVersion}`);
  console.log(`补丁             ${state.patched ? `已安装 (Canvas ${state.restore?.canvasVersion})` : "未安装"}${hasPendingSwap(install) ? "（有待 ZCode 退出后替换的文件）" : ""}`);
  console.log(`运行时           ${runtimeVersion ? `${runtimeVersion} @ ${paths.runtime(home)}` : "未安装"}`);
  console.log(`ZCode 运行中     ${isZCodeRunning(install) ? "是" : "否"}`);
  console.log(`Canvas           ${config.enabled === false ? "已关闭" : "开启"}`);
  console.log(`当前主题         ${config.theme ?? "（无）"}`);
  const active = config.theme ? listThemes(home, [packagedThemes]).find((t) => t.id === config.theme) : undefined;
  for (const warning of [...warnings, ...(active ? themeProblems(active) : [])]) console.log(`! ${warning}`);
  if (!state.patched) console.log("\n运行 `zcode-canvas apply` 安装。若 ZCode 刚更新过，也需要重新 apply。");
}

function apply(explicit?: string) {
  const install = locateZCode(explicit);
  deployRuntime(packageRoot, home);
  if (!existsSync(paths.config(home))) writeConfig({ enabled: true, theme: null });
  console.log(`✓ 运行时已安装到 ${paths.runtime(home)}`);
  const state = readState(install);
  console.log(`  ZCode ${state.zcodeVersion} @ ${install.dir}`);
  const outcome = applyPatch(install, packageVersion(packageRoot), cliPath);
  if (outcome === "unchanged") console.log("✓ 补丁已是最新。运行时的更新在下次启动 ZCode 时生效。");
  else describeOutcome(outcome, "给 ZCode 打补丁");
}

function restore(explicit: string | undefined, purge: boolean) {
  const install = locateZCode(explicit);
  const outcome = removePatch(install, cliPath);
  if (outcome === "not-patched") console.log("app.asar 没有 Canvas 补丁，无需还原。");
  else describeOutcome(outcome, "还原官方 app.asar");
  if (purge) {
    rmSync(home, { recursive: true, force: true });
    console.log(`✓ 已删除 ${home}`);
  }
}

function themes() {
  const config = readConfig(home);
  const all = listThemes(home, [packagedThemes]);
  if (all.length === 0) console.log("没有找到主题。先运行 `zcode-canvas apply`。");
  for (const theme of all) {
    const mark = theme.id === config.theme ? "*" : " ";
    const tag = theme.builtin ? "" : " [自定义]";
    const modes = theme.manifest.modes ?? MODES;
    const fit = modes.length === 1 ? (modes[0] === "dark" ? " [暗色]" : " [亮色]") : "";
    console.log(`${mark} ${theme.id.padEnd(18)} ${theme.manifest.name}${fit}${tag}${theme.manifest.description ? ` — ${theme.manifest.description}` : ""}`);
    for (const problem of themeProblems(theme)) console.log(`    ! ${problem}`);
  }
  console.log(`\n自定义主题目录: ${paths.userThemes(home)}`);
}

function use(id: string | undefined) {
  if (!id) throw new Error("用法: zcode-canvas use <主题|none>");
  const config = readConfig(home);
  if (id === "none") config.theme = null;
  else {
    const entry = listThemes(home, [packagedThemes]).find((t) => t.id === id);
    if (!entry) throw new Error(`没有主题 "${id}"，运行 \`zcode-canvas themes\` 查看。`);
    const problems = themeProblems(entry);
    if (problems.length) throw new Error(`主题 "${id}" 的 theme.json 未通过校验:\n  - ${problems.join("\n  - ")}`);
    config.theme = id;
  }
  writeConfig(config);
  console.log(`✓ 主题: ${config.theme ?? "（无）"}`);
}

function set(key: string | undefined, raw: string | undefined, remove = false) {
  if (!key || (!remove && raw === undefined)) throw new Error(remove ? "用法: zcode-canvas unset <键>" : "用法: zcode-canvas set <键> <值>");
  if (!ALLOWED_KEY.test(key) && !(remove && UNSETTABLE_GROUP.test(key))) throw new Error(`未知的键 "${key}"，运行 \`zcode-canvas help\` 查看可设置的键。`);
  const config = readConfig(home) as Record<string, unknown>;
  setPath(config, key, remove ? undefined : parseValue(key, raw!));
  writeConfig(config as CanvasConfig);
  console.log(remove ? `✓ 已删除 ${key}` : `✓ ${key} = ${JSON.stringify(parseValue(key, raw!))}`);
}

function newTheme(id: string | undefined) {
  if (!id || !/^[\w-]+$/.test(id)) throw new Error("用法: zcode-canvas new <id>（只能包含字母、数字、- 和 _）");
  const dir = join(paths.userThemes(home), id);
  if (existsSync(dir)) throw new Error(`主题目录已存在: ${dir}`);
  mkdirSync(dir, { recursive: true });
  const config = readConfig(home);
  const manifest: ThemeManifest = { $schema: SCHEMA_URL, format: FORMAT_VERSION, name: id };
  for (const key of ["colors", "accent", "radius", "vars", "glass"] as const) if (config[key] !== undefined) Object.assign(manifest, { [key]: config[key] });
  const copyInto = (file: string | null | undefined, name: string) => {
    if (!file || !existsSync(file)) return file;
    const target = `${name}${extname(file)}`;
    copyFileSync(file, join(dir, target));
    return target;
  };
  if (config.wallpaper) {
    const wallpaper: WallpaperLayer = { ...config.wallpaper };
    if (wallpaper.image) wallpaper.image = copyInto(wallpaper.image, "wallpaper");
    for (const mode of MODES) {
      const own = wallpaper[mode];
      if (own?.image) wallpaper[mode] = { ...own, image: copyInto(own.image, `wallpaper-${mode}`) };
    }
    manifest.wallpaper = wallpaper;
  }
  if (config.startup) manifest.startup = { ...config.startup, logo: copyInto(config.startup.logo, "logo") };
  writeFileSync(join(dir, "theme.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ 已创建主题 ${dir}`);
  console.log(`  编辑 theme.json 后运行 \`zcode-canvas use ${id}\`。`);
}

function printCss() {
  const { look, warnings } = loadLook(home, [packagedThemes]);
  for (const warning of warnings) console.error(`! ${warning}`);
  if (!look) return console.error("Canvas 已关闭 (enabled=false)。");
  const result = buildCss(look);
  for (const warning of result.warnings) console.error(`! ${warning}`);
  process.stdout.write(result.css || "/* 当前设置不产生任何 CSS */\n");
  console.error(`窗口材质: ${look.glass.material}`);
}

async function main() {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));
  const zcode = typeof flags.zcode === "string" ? flags.zcode : undefined;
  switch (command) {
    case "status":
      return status(zcode);
    case "apply":
      return apply(zcode);
    case "restore":
      return restore(zcode, flags.purge === true);
    case "themes":
      return themes();
    case "use":
      return use(positional[0]);
    case "set":
      return set(positional[0], positional.slice(1).join(" ") || undefined);
    case "unset":
      return set(positional[0], undefined, true);
    case "new":
      return newTheme(positional[0]);
    case "css":
      return printCss();
    case "open":
      mkdirSync(home, { recursive: true });
      return revealInFileManager(home);
    case "__swap":
      return runPendingSwap(positional[0]!, positional[1]!);
    case undefined:
    case "help":
    case "-h":
      return console.log(HELP);
    default:
      console.error(`未知命令 "${command}"\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const e = error as NodeJS.ErrnoException;
  if (e.code === "EPERM" || e.code === "EACCES" || e.code === "EROFS") {
    console.error(`✗ 没有写入权限: ${e.path ?? ""}\n${permissionTip()}`);
  } else console.error(`✗ ${e.message ?? String(error)}`);
  process.exitCode = 1;
});

