<#
.SYNOPSIS
    岛形态的 Win32 探针：验证"关窗口 = 变形为岛、进程不退出"。

.DESCRIPTION
    `vitest` 与 `e2e:shell` 都跑在浏览器里，看不到任何窗口属性。这个脚本对**真实
    进程**做一次黑盒检查：给主窗口发 WM_CLOSE（等同于点 × / Alt+F4），然后断言

      1. 进程还活着（关闭 ≠ 退出）；
      2. 窗口仍然可见（IsWindowVisible = true —— 这一点最关键：若实现成 hide()，
         前端 `visibilitychange → hidden` 会立刻锁库，"关掉主面板继续用岛"就不成立）；
      3. 窗口尺寸 ≈ 320×44（DPI 感知：150% 缩放下是 480×66，所以按"明显变小"判定）；
      4. 扩展样式置了 WS_EX_TOOLWINDOW（任务栏 / Alt+Tab 里不出现第二个条目）；
      5. 窗口样式不再有 WS_CAPTION（无标题栏）；
      6. 扩展样式置了 WS_EX_LAYERED（分层窗口，逐像素透明的前提位；无此位则
         transparent=true 也透不出桌面，只会是黑/白底）；
      7. 静态校验 tauri.conf.json 主窗口 transparent=true（创建期属性，运行时改不了，
         自动化只能验"属性齐备"，"透出来的是不是桌面"仍需人眼，见 island-persistent-verify.md 项②）。

    额外可选用 -SecondInstance 验单实例：再启一次 exe，进程数必须仍是 1。

    为什么"无标题栏"查的是 WS_CAPTION 而不是 GetWindowText：
    `set_decorations(false)` 只是去掉非客户区，**窗口标题文本仍然存在**
    （GetWindowText 照旧返回"密岛 KeyIsland"）。按设计文档原文去断言
    "GetWindowText 为空"会让一个完全正确的实现被判红。标题文本只作为信息打印。

.PARAMETER ProcessName
    进程名（不含 .exe），默认 keyisland。

.PARAMETER ExecutablePath
    可选：-SecondInstance 时要再次启动的 exe 路径。默认按进程的可执行文件路径推断。

.PARAMETER SecondInstance
    额外验证单实例语义。

.EXAMPLE
    # 先手动启动装好的密岛（或 npm run desktop:dev），然后：
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/desktop/window-probe.ps1

.EXAMPLE
    npm run desktop:probe -- -SecondInstance
#>
[CmdletBinding()]
param(
    [string]$ProcessName = 'keyisland',
    [string]$ExecutablePath = '',
    [switch]$SecondInstance
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class KiWin32
{
    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const int WS_CAPTION = 0x00C00000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_LAYERED = 0x00080000;
    public const uint WM_CLOSE = 0x0010;

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
        public int Width { get { return Right - Left; } }
        public int Height { get { return Bottom - Top; } }
    }

    public class WindowInfo
    {
        public IntPtr Handle;
        public bool Visible;
        public int Width;
        public int Height;
        public int Style;
        public int ExStyle;
        public string Title;
    }

    /** 取某进程所有顶层窗口（含不可见的，方便诊断）。 */
    public static List<WindowInfo> WindowsOf(uint processId)
    {
        List<WindowInfo> found = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == processId)
            {
                RECT rect;
                GetWindowRect(hWnd, out rect);
                StringBuilder title = new StringBuilder(512);
                GetWindowText(hWnd, title, 512);
                WindowInfo info = new WindowInfo();
                info.Handle = hWnd;
                info.Visible = IsWindowVisible(hWnd);
                info.Width = rect.Width;
                info.Height = rect.Height;
                info.Style = GetWindowLong(hWnd, GWL_STYLE);
                info.ExStyle = GetWindowLong(hWnd, GWL_EXSTYLE);
                info.Title = title.ToString();
                found.Add(info);
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
'@

$script:failed = 0

function Report([string]$Name, [bool]$Pass, [string]$Extra = '') {
    if ($Pass) {
        Write-Host ("  PASS  {0}{1}" -f $Name, $(if ($Extra) { "  ($Extra)" } else { '' })) -ForegroundColor Green
    }
    else {
        $script:failed += 1
        Write-Host ("  FAIL  {0}{1}" -f $Name, $(if ($Extra) { "  ($Extra)" } else { '' })) -ForegroundColor Red
    }
}

function Get-MainWindow([uint32]$ProcessId) {
    $windows = [KiWin32]::WindowsOf($ProcessId)
    if ($windows.Count -eq 0) { return $null }
    # 取面积最大的那个：Tauri 只有一个 main 窗口，但 WebView2 会额外建一些隐藏的辅助窗口。
    $main = $windows | Sort-Object -Property @{ Expression = { $_.Width * $_.Height } } -Descending | Select-Object -First 1
    return $main
}

Write-Host "密岛 · 岛形态 Win32 探针" -ForegroundColor Cyan

$process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
if (-not $process) {
    $process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $process) {
    Write-Host "找不到进程 $ProcessName。先启动密岛（npm run desktop:dev 或装好的 keyisland.exe），再跑这个探针。" -ForegroundColor Yellow
    exit 2
}

$exePath = $ExecutablePath
if (-not $exePath) {
    try { $exePath = $process.Path } catch { $exePath = '' }
}

$window = Get-MainWindow ([uint32]$process.Id)
if (-not $window) {
    Write-Host "进程 $($process.Id) 没有可见窗口。" -ForegroundColor Yellow
    exit 2
}

Write-Host ("  进程 {0} · 窗口 0x{1:X} · 关闭前 {2}×{3} · 标题「{4}」" -f `
    $process.Id, $window.Handle.ToInt64(), $window.Width, $window.Height, $window.Title)

# ── 发送 WM_CLOSE（等同点 × / Alt+F4）─────────────────────────────
[void][KiWin32]::SendMessage($window.Handle, [KiWin32]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
Start-Sleep -Milliseconds 1800

$alive = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
Report '关闭后进程仍存活（关闭 ≠ 退出）' ($null -ne $alive)

if (-not $alive) {
    Write-Host "`n进程已退出：说明 CloseRequested 没有被拦截（或拦截后直接 exit）。" -ForegroundColor Red
    exit 1
}

$after = Get-MainWindow ([uint32]$process.Id)
if (-not $after) {
    Report '窗口仍然存在' $false '找不到窗口句柄'
    exit 1
}

Report '窗口仍然存在' ($after.Handle -ne [IntPtr]::Zero)
# 最关键的一条：hide() 会让窗口不可见，进而触发前端 visibilitychange → 立刻锁库。
Report '窗口仍然可见（没有 hide，因此不会误触自动锁定）' ([bool]$after.Visible)
Report ("窗口已缩小（{0}×{1}，期望 ≈320×44 逻辑像素）" -f $after.Width, $after.Height) `
    (($after.Width -le 640) -and ($after.Height -le 160))
Report '扩展样式含 WS_EX_TOOLWINDOW（不占任务栏 / 不进 Alt+Tab）' `
    (($after.ExStyle -band [KiWin32]::WS_EX_TOOLWINDOW) -ne 0) `
    ("ExStyle=0x{0:X}" -f $after.ExStyle)
Report '窗口样式不含 WS_CAPTION（无标题栏）' `
    (($after.Style -band [KiWin32]::WS_CAPTION) -eq 0) `
    ("Style=0x{0:X} · 标题文本「{1}」（去装饰不清标题文本，故只作信息）" -f $after.Style, $after.Title)
Report '扩展样式含 WS_EX_LAYERED（透明窗口前提位）' `
    (($after.ExStyle -band [KiWin32]::WS_EX_LAYERED) -ne 0) `
    ("ExStyle=0x{0:X}" -f $after.ExStyle)

# ── 静态校验：创建期属性 transparent=true（运行时改不了，前置条件）──
try {
    $confPath = Resolve-Path (Join-Path $PSScriptRoot '..\..\src-tauri\tauri.conf.json') -ErrorAction Stop
    $conf = Get-Content -Raw -Path $confPath | ConvertFrom-Json
    $mainWin = $conf.app.windows | Where-Object { $_.label -eq 'main' } | Select-Object -First 1
    if (-not $mainWin) {
        Report '静态校验：找到 label=main 的主窗口配置' $false 'tauri.conf.json 无 main 窗口'
    }
    else {
        Report '静态校验：主窗口 transparent=true（岛形态透明前提）' `
            ([bool]$mainWin.transparent) `
            ("transparent=$($mainWin.transparent)")
    }
}
catch {
    Report '静态校验：读取 tauri.conf.json' $false $_.Exception.Message
}

# ── 单实例（可选）──────────────────────────────────────────────────
if ($SecondInstance) {
    if (-not $exePath) {
        Report '单实例：找不到可执行文件路径' $false '用 -ExecutablePath 指定'
    }
    else {
        $before = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue).Count
        Start-Process -FilePath $exePath | Out-Null
        Start-Sleep -Milliseconds 2500
        $afterCount = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue).Count
        Report '单实例：第二次启动没有产生新进程' ($afterCount -eq $before) ("启动前 $before · 启动后 $afterCount")
        $revealed = Get-MainWindow ([uint32]$process.Id)
        if ($revealed) {
            Report '单实例：main 已还原为全形态' (($revealed.Width -ge 900) -and ($revealed.Height -ge 600)) `
                ("{0}×{1}" -f $revealed.Width, $revealed.Height)
        }
        else {
            Report '单实例：main 已还原为全形态' $false '找不到窗口'
        }
    }
}

Write-Host ''
if ($script:failed -gt 0) {
    Write-Host ("{0} 项失败" -f $script:failed) -ForegroundColor Red
    exit 1
}
Write-Host '全部通过' -ForegroundColor Green
exit 0
