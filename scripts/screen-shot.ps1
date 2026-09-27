# Dev-only: bring the sandbox ZCode window to the front and capture it from the screen, so native
# window materials (acrylic / mica) show up, which CDP screenshots cannot see.
#   powershell -File scripts/screen-shot.ps1 -Out shot.png [-PathLike 'D:\code\zai\_sandbox\*']
param([Parameter(Mandatory)] [string]$Out, [string]$PathLike = 'D:\code\zai\_sandbox\*')
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
"@
[W]::SetProcessDPIAware() | Out-Null
$p = Get-Process -Name ZCode -ErrorAction SilentlyContinue | Where-Object { $_.Path -like $PathLike -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw "sandbox window not found" }
[W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900
# Windows may refuse to change the foreground window; never capture whatever else is on screen.
if ([W]::GetForegroundWindow() -ne $p.MainWindowHandle) { throw "sandbox window is not in the foreground; not capturing" }
$r = New-Object W+RECT
[W]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
"saved $Out ($($bmp.Width)x$($bmp.Height))"
