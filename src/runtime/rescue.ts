// The Windows leg of the update rescue, kept free of electron imports so it can be tested outside
// ZCode. main.ts only wires it to a detached powershell.exe at quit.
//
// Why a PowerShell waiter: the rescue helper itself must run as ZCode.exe (as Node), whose file
// lives in the install dir — and electron-builder's NSIS installer kills every process running
// from there before writing any files. So at quit the runtime only starts System32's
// powershell.exe, which survives the installer's sweep. The waiter then:
//   1. waits for the update installer to appear — electron-updater runs the staged installer
//      directly from the updater cache's pending dir, so any process under that dir is it
//      (a plain quit with a downloaded-but-not-installed update never sees one and exits);
//   2. waits for that installer to exit — only then is "the patch is gone" a settled fact, not
//      a race against a UAC prompt, ZCode's own child-process shutdown or the installer's retry;
//   3. hands over to the NEW ZCode.exe running the Canvas CLI copy as Node.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { psLiteral } from "../shared/windows.ts";

/**
 * The updater cache dir (`<cache root>/<updaterCacheDirName>` from resources/app-update.yml) that
 * electron-updater stages downloads in, or null when the install ships no updater metadata.
 */
export function stagedUpdateCacheDir(resourcesPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const yml = readFileSync(join(resourcesPath, "app-update.yml"), "utf8");
    const name = /^updaterCacheDirName:\s*(\S+)/m.exec(yml)?.[1];
    if (!name) return null;
    const cacheRoot =
      process.platform === "win32"
        ? env.LOCALAPPDATA
        : process.platform === "darwin"
          ? join(homedir(), "Library", "Caches")
          : env.XDG_CACHE_HOME || join(homedir(), ".cache");
    if (!cacheRoot) return null;
    return join(cacheRoot, name);
  } catch {
    return null;
  }
}

/** True when a downloaded update is staged and will install on this quit (auto-install or explicit). */
export function stagedUpdateIsPresent(resourcesPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const cache = stagedUpdateCacheDir(resourcesPath, env);
  if (!cache) return false;
  try {
    return readdirSync(join(cache, "pending")).length > 0;
  } catch {
    return false;
  }
}

export interface WaiterOptions {
  /** Where the staged installer runs from (the updater cache dir — matched with a prefix test). */
  updaterCacheDir: string;
  /** The new ZCode.exe the waiter hands over to once the installer is done. */
  rescueExe: string;
  /** The Canvas CLI copy (`<canvas home>/runtime/cli.mjs`). */
  cliCopy: string;
  installDir: string;
  canvasHome: string;
  /** Where the waiter appends its own log lines (the Canvas runtime log). */
  logFile: string;
  /** How long to wait for the installer to appear before concluding this is an ordinary quit. */
  waitForInstallerSeconds?: number;
  /** Poll interval for both waits. */
  pollMilliseconds?: number;
}

/** Processes running from the updater cache dir, excluding the waiter itself. */
const INSTALLER_FILTER = `$_.Path -and $_.Path.StartsWith(__CACHE__, [System.StringComparison]::OrdinalIgnoreCase) -and $_.Id -ne $PID`;

/** The full -Command body of the rescue waiter. */
export function windowsRescueWaiterCommand(options: WaiterOptions): string {
  const waitForInstallerSeconds = options.waitForInstallerSeconds ?? 600;
  const poll = options.pollMilliseconds ?? 3000;
  const filter = INSTALLER_FILTER.replace("__CACHE__", psLiteral(`${options.updaterCacheDir}\\`));
  return `
$ErrorActionPreference = 'SilentlyContinue'
${psLiteral(options.logFile)} | ForEach-Object { $script:LogFile = $_ }
function Log($message) { Add-Content -LiteralPath $LogFile -Value "$([DateTime]::UtcNow.ToString('o')) rescue-waiter: $message" }
$installers = { Get-Process | Where-Object { ${filter} } }
Log "waiting up to ${waitForInstallerSeconds}s for the update installer to appear"
$deadline = (Get-Date).AddSeconds(${waitForInstallerSeconds})
while ((Get-Date) -lt $deadline) {
  if (@(& $installers).Length -gt 0) { break }
  Start-Sleep -Milliseconds ${poll}
}
if (@(& $installers).Length -eq 0) { Log "no installer appeared; ordinary quit"; exit 0 }
Log "installer is running; waiting for it to exit"
do {
  Start-Sleep -Milliseconds ${poll}
} while (@(& $installers).Length -gt 0)
Start-Sleep -Seconds 2
if (-not (Test-Path -LiteralPath ${psLiteral(options.cliCopy)})) { Log "cli copy is gone; nothing to hand over to"; exit 0 }
Log "installer finished; handing over to the rescue helper"
$env:ELECTRON_RUN_AS_NODE = '1'
& ${psLiteral(options.rescueExe)} ${psLiteral(options.cliCopy)} '__rescue' ${psLiteral(options.installDir)} ${psLiteral(options.canvasHome)} 2>$null
exit $LASTEXITCODE
`
    .trim()
    .replace(/\n\s+/g, "\n");
}
