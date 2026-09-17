# HarboR ClipShelf - Windows monitor. Streams tab-separated events on stdout:
#   READY <seq> / CLIP <seq> <pid> <empty> <name> / FRONT <pid> <empty> <name> / CAPS <0|1>
#   DRAG 1 <unknown> <alt 0|1> <pid> / DRAG 0   (shell drag-and-drop in progress / ended)
$ErrorActionPreference = 'Stop'
Add-Type -IgnoreWarnings -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ClipShelfMonitor {
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] static extern short GetKeyState(int nVirtKey);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);
    public static int LeftButton() {
        int vk = GetSystemMetrics(23) != 0 ? 0x02 : 0x01;
        return (GetAsyncKeyState(vk) & 0x8000) != 0 ? 1 : 0;
    }
    public static int AltDown() {
        return (GetAsyncKeyState(0x12) & 0x8000) != 0 ? 1 : 0;
    }
    public static int DragImageVisible() {
        IntPtr h = FindWindow("SysDragImage", null);
        return (h != IntPtr.Zero && IsWindowVisible(h)) ? 1 : 0;
    }
    public static uint PidOf(IntPtr hWnd) {
        uint pid = 0;
        if (hWnd != IntPtr.Zero) { GetWindowThreadProcessId(hWnd, out pid); }
        return pid;
    }
    public static int CapsLock() {
        return (GetKeyState(0x14) & 1) != 0 ? 1 : 0;
    }
}
'@
$useForms = $true
try { Add-Type -AssemblyName System.Windows.Forms } catch { $useForms = $false }

$parentId = 0
[void][int]::TryParse([string]$env:CLIPSHELF_PPID, [ref]$parentId)

function Send-Line([string]$line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

function Get-ProcName([uint32]$procId) {
    if ($procId -eq 0) { return '' }
    try {
        return [Uri]::EscapeDataString([System.Diagnostics.Process]::GetProcessById([int]$procId).ProcessName)
    } catch {
        return ''
    }
}

$lastSeq = [ClipShelfMonitor]::GetClipboardSequenceNumber()
$lastCaps = -1
$lastFront = [uint32]0
$tick = 0
$dragging = $false
Send-Line ("READY`t" + $lastSeq)

while ($true) {
    $tick++
    if ($parentId -gt 0 -and ($tick % 8) -eq 0) {
        try { $null = [System.Diagnostics.Process]::GetProcessById($parentId) } catch { break }
    }
    $seq = [ClipShelfMonitor]::GetClipboardSequenceNumber()
    if ($seq -ne $lastSeq) {
        $lastSeq = $seq
        $owner = [ClipShelfMonitor]::PidOf([ClipShelfMonitor]::GetClipboardOwner())
        if ($owner -eq 0) { $owner = [ClipShelfMonitor]::PidOf([ClipShelfMonitor]::GetForegroundWindow()) }
        Send-Line ("CLIP`t" + $seq + "`t" + $owner + "`t`t" + (Get-ProcName $owner))
    }
    $fg = [ClipShelfMonitor]::PidOf([ClipShelfMonitor]::GetForegroundWindow())
    if ($fg -ne $lastFront) {
        $lastFront = $fg
        Send-Line ("FRONT`t" + $fg + "`t`t" + (Get-ProcName $fg))
    }
    $caps = 0
    if ($useForms) {
        try {
            if ([System.Windows.Forms.Control]::IsKeyLocked([System.Windows.Forms.Keys]::CapsLock)) { $caps = 1 }
        } catch {
            $caps = [ClipShelfMonitor]::CapsLock()
        }
    } else {
        $caps = [ClipShelfMonitor]::CapsLock()
    }
    if ($caps -ne $lastCaps) {
        $lastCaps = $caps
        Send-Line ("CAPS`t" + $caps)
    }
    $button = [ClipShelfMonitor]::LeftButton()
    if ($button -eq 1 -and -not $dragging -and [ClipShelfMonitor]::DragImageVisible() -eq 1) {
        $dragging = $true
        Send-Line ("DRAG`t1`tunknown`t" + [ClipShelfMonitor]::AltDown() + "`t" + $fg)
    }
    if ($dragging -and $button -eq 0) {
        $dragging = $false
        Send-Line "DRAG`t0"
    }
    if ($button -eq 1) { Start-Sleep -Milliseconds 40 } else { Start-Sleep -Milliseconds 200 }
}
