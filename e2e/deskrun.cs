// E2E launcher: runs the app on a hidden desktop in the user's session, so test windows never reach the screen
// or take focus. e2e/lib.mjs compiles it on first use (csc.exe from .NET Framework, part of Windows).
// deskrun run <desktop> <exe> [args...]   start exe on a hidden desktop, print "PID <n>", wait, exit with its code
// deskrun close <desktop> <pid>           post WM_CLOSE to pid's visible top-level window on that desktop
using System;
using System.Runtime.InteropServices;
using System.Text;

static class DeskRun
{
    const uint GENERIC_ALL = 0x10000000;
    const int STARTF_USESTDHANDLES = 0x100;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint WM_CLOSE = 0x10;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION Basic; public IO_COUNTERS Io; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, uint flags, uint access, IntPtr sa);
    [DllImport("user32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenDesktop(string name, uint flags, bool inherit, uint access);
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32")] static extern bool EnumDesktopWindows(IntPtr desk, EnumWindowsProc fn, IntPtr lParam);
    [DllImport("user32")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32")] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

    static IntPtr Desktop(string name)
    {
        IntPtr d = OpenDesktop(name, 0, false, GENERIC_ALL);
        if (d == IntPtr.Zero) d = CreateDesktop(name, IntPtr.Zero, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (d == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
        return d;
    }

    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
        return "\"" + a.Replace("\"", "\\\"") + "\"";
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length >= 3 && args[0] == "close") return Close(args[1], int.Parse(args[2]));
            if (args.Length >= 3 && args[0] == "run") return Run(args);
            Console.Error.WriteLine("usage: deskrun run <desktop> <exe> [args...] | deskrun close <desktop> <pid>");
            return 2;
        }
        catch (Exception e) { Console.Error.WriteLine("deskrun: " + e.Message); return 3; }
    }

    static int Run(string[] args)
    {
        Desktop(args[1]); // the handle stays open for our lifetime, which keeps the desktop alive
        var cmd = new StringBuilder();
        for (int i = 2; i < args.Length; i++) { if (i > 2) cmd.Append(' '); cmd.Append(Quote(args[i])); }
        var si = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), lpDesktop = "WinSta0\\" + args[1], dwFlags = STARTF_USESTDHANDLES, hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
        PROCESS_INFORMATION pi;
        if (!CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi))
            throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
        // Kill the app (and its WebView2 children) if we are killed.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        AssignProcessToJobObject(job, pi.hProcess);
        Console.Out.WriteLine("PID " + pi.dwProcessId);
        Console.Out.Flush();
        WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
        uint code;
        GetExitCodeProcess(pi.hProcess, out code);
        return (int)code;
    }

    static int Close(string desktop, int pid)
    {
        IntPtr d = Desktop(desktop);
        IntPtr target = IntPtr.Zero;
        EnumDesktopWindows(d, (h, l) =>
        {
            int owner;
            GetWindowThreadProcessId(h, out owner);
            if (owner == pid && IsWindowVisible(h) && GetWindow(h, 4 /* GW_OWNER */) == IntPtr.Zero) { target = h; return false; }
            return true;
        }, IntPtr.Zero);
        if (target == IntPtr.Zero) { Console.Out.WriteLine("False"); return 1; }
        PostMessage(target, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        Console.Out.WriteLine("True");
        return 0;
    }
}
