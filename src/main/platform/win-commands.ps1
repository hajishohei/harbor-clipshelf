# HarboR ClipShelf - Windows window commands. One JSON request per stdin line,
# one JSON response per stdout line. Coordinates are physical pixels
# (the thread is per-monitor DPI aware) of the *visible* window frame.
$ErrorActionPreference = 'Stop'
Add-Type -IgnoreWarnings -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ClipShelfWin {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder name, int max);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint flags);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfo")] static extern bool SystemParametersInfoGet(uint action, uint param, ref uint value, uint flags);

    public static void UsePerMonitorDpi() {
        try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    }

    static RECT Visible(IntPtr h) {
        RECT r;
        if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) { GetWindowRect(h, out r); }
        return r;
    }

    static int Border(int v) { return (v < 0 || v > 64) ? 0 : v; }

    public static long Foreground() {
        IntPtr h = GetForegroundWindow();
        if (h == IntPtr.Zero) { return 0; }
        IntPtr root = GetAncestor(h, 2);
        return (root == IntPtr.Zero ? h : root).ToInt64();
    }

    public static uint ProcessOf(long hwnd) {
        uint pid;
        GetWindowThreadProcessId(new IntPtr(hwnd), out pid);
        return pid;
    }

    public static string ClassOf(long hwnd) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(new IntPtr(hwnd), sb, sb.Capacity);
        return sb.ToString();
    }

    public static int[] Frame(long hwnd) {
        IntPtr h = new IntPtr(hwnd);
        RECT r = Visible(h);
        return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top, IsZoomed(h) ? 1 : 0, IsIconic(h) ? 1 : 0 };
    }

    public static void Place(long hwnd, int x, int y, int width, int height) {
        IntPtr h = new IntPtr(hwnd);
        if (IsZoomed(h) || IsIconic(h)) { ShowWindow(h, 9); }
        for (int i = 0; i < 2; i++) {
            RECT outer;
            GetWindowRect(h, out outer);
            RECT vis = Visible(h);
            int l = Border(vis.Left - outer.Left);
            int t = Border(vis.Top - outer.Top);
            int r = Border(outer.Right - vis.Right);
            int b = Border(outer.Bottom - vis.Bottom);
            SetWindowPos(h, IntPtr.Zero, x - l, y - t, width + l + r, height + t + b, 0x0014);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public INPUTUNION u; }
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    static INPUT Key(ushort vk, bool up) {
        INPUT i = new INPUT();
        i.type = 1;
        i.u.ki.wVk = vk;
        i.u.ki.dwFlags = up ? 2u : 0u;
        return i;
    }

    // Ctrl+V into whatever has focus. Modifiers the user is still holding
    // (e.g. Shift from Shift+Enter) are released first so they don't turn
    // the paste into something else.
    public static bool Paste() {
        System.Collections.Generic.List<INPUT> list = new System.Collections.Generic.List<INPUT>();
        foreach (int vk in new int[] { 0x10, 0x12, 0x5B, 0x5C }) {
            if ((GetAsyncKeyState(vk) & 0x8000) != 0) { list.Add(Key((ushort)vk, true)); }
        }
        bool ctrlHeld = (GetAsyncKeyState(0x11) & 0x8000) != 0;
        if (!ctrlHeld) { list.Add(Key(0x11, false)); }
        list.Add(Key(0x56, false));
        list.Add(Key(0x56, true));
        if (!ctrlHeld) { list.Add(Key(0x11, true)); }
        INPUT[] arr = list.ToArray();
        return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))) == (uint)arr.Length;
    }

    public static bool Activate(long hwnd) {
        IntPtr h = new IntPtr(hwnd);
        if (!IsWindow(h)) { return false; }
        if (IsIconic(h)) { ShowWindow(h, 9); }
        IntPtr fg = GetForegroundWindow();
        uint dummy;
        uint fgThread = GetWindowThreadProcessId(fg, out dummy);
        uint me = GetCurrentThreadId();
        bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
        BringWindowToTop(h);
        bool ok = SetForegroundWindow(h);
        if (attached) { AttachThreadInput(me, fgThread, false); }
        return ok;
    }

    public static uint GetSpi(uint action) {
        uint v = 0;
        SystemParametersInfoGet(action, 0, ref v, 0);
        return v;
    }

    public static bool SetSpi(uint action, uint value) {
        return SystemParametersInfo(action, 0, new IntPtr((long)value), 3);
    }
}
'@
[ClipShelfWin]::UsePerMonitorDpi()

function Send-Json($obj) {
    $json = $obj | ConvertTo-Json -Compress -Depth 6
    # ASCII only: the console code page (e.g. cp932) must never reach the JSON.
    $json = [regex]::Replace($json, '[^\x00-\x7F]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Invoke-ClipShelfCommand($req) {
    switch ([string]$req.cmd) {
        'ping' { return 'pong' }
        'getFront' {
            $h = [ClipShelfWin]::Foreground()
            if ($h -eq 0) { return $null }
            $procId = [ClipShelfWin]::ProcessOf($h)
            if ([int64]$procId -eq [int64]$req.ownPid) { return $null }
            $cls = [ClipShelfWin]::ClassOf($h)
            if (@('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd') -contains $cls) { return $null }
            $f = [ClipShelfWin]::Frame($h)
            return @{ hwnd = [string]$h; pid = [int]$procId; cls = $cls; x = $f[0]; y = $f[1]; width = $f[2]; height = $f[3]; maximized = ($f[4] -eq 1); minimized = ($f[5] -eq 1) }
        }
        'setFrame' {
            $h = [int64]$req.hwnd
            [ClipShelfWin]::Place($h, [int]$req.x, [int]$req.y, [int]$req.width, [int]$req.height)
            $f = [ClipShelfWin]::Frame($h)
            return @{ x = $f[0]; y = $f[1]; width = $f[2]; height = $f[3] }
        }
        'foreground' {
            $h = [ClipShelfWin]::Foreground()
            if ($h -eq 0) { return $null }
            return @{ hwnd = [string]$h; pid = [int]([ClipShelfWin]::ProcessOf($h)) }
        }
        'activate' {
            return [ClipShelfWin]::Activate([int64]$req.hwnd)
        }
        'appPath' {
            try { return [System.Diagnostics.Process]::GetProcessById([int]$req.pid).MainModule.FileName } catch { return $null }
        }
        'paste' {
            return [ClipShelfWin]::Paste()
        }
        'getXMouse' {
            return @{
                enabled = ([ClipShelfWin]::GetSpi(0x1000) -ne 0)
                raise = ([ClipShelfWin]::GetSpi(0x100C) -ne 0)
                delayMs = [int]([ClipShelfWin]::GetSpi(0x2002))
            }
        }
        'setXMouse' {
            $on = [uint32]0
            if ($req.enabled) { $on = [uint32]1 }
            $raise = [uint32]0
            if ($req.raise) { $raise = [uint32]1 }
            $null = [ClipShelfWin]::SetSpi(0x1001, $on)
            $null = [ClipShelfWin]::SetSpi(0x100D, $raise)
            $null = [ClipShelfWin]::SetSpi(0x2003, [uint32]$req.delayMs)
            return $true
        }
        default { throw ('unknown-command:' + $req.cmd) }
    }
}

Send-Json @{ ready = $true }
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }
    try { $req = $line | ConvertFrom-Json } catch { continue }
    try {
        $result = Invoke-ClipShelfCommand $req
        Send-Json @{ id = $req.id; ok = $true; result = $result }
    } catch {
        Send-Json @{ id = $req.id; ok = $false; error = $_.Exception.Message }
    }
}
