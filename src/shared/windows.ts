// Small Windows-only helpers shared by the runtime (update-rescue handover) and the installer
// (parked-swap launcher). Both must launch helper processes from OUTSIDE the ZCode install dir:
// electron-builder's default NSIS running-app check kills every process whose path is under the
// install directory, so anything spawned from ZCode.exe dies the moment an update installs.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** The System32 Windows PowerShell, the one interpreter guaranteed to exist outside any install dir. */
export function windowsPowershellExe(systemRoot = process.env.SystemRoot ?? "C:\\Windows"): string {
  return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** A single-quoted PowerShell string literal; embedded quotes are doubled per PS rules. */
export function psLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Starts a PowerShell script as an independent, hidden process that outlives this process.
 *
 * Plain detached spawns do not work here: powershell.exe is a console-subsystem binary and dies
 * under DETACHED_PROCESS (no console), while a non-detached child is tied to this process's
 * lifetime. Instead a short-lived attached outer PowerShell launches the real worker via
 * Start-Process — which detaches it properly — and this call waits (bounded) for that handover,
 * so the caller may exit the moment it returns.
 */
export function startDetachedPowerShell(scriptFile: string): { started: boolean; error?: string } {
  const launcher =
    `Start-Process -WindowStyle Hidden -FilePath ${psLiteral(windowsPowershellExe())} ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',${psLiteral(scriptFile)}`;
  try {
    const result = spawnSync(windowsPowershellExe(), ["-NoProfile", "-NonInteractive", "-Command", launcher], {
      timeout: 5000,
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0
      ? { started: true }
      : { started: false, error: `powershell exited ${result.status ?? "on signal"}${result.error ? `: ${String(result.error)}` : ""}` };
  } catch (error) {
    return { started: false, error: String(error) };
  }
}
