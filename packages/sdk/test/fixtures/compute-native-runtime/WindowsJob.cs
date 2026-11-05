using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

#pragma warning disable CS0649 // Native layout fields are populated by Windows.
// Test-only Windows writer scope. No breakaway permission, assignment before
// the first instruction, and kernel job membership rather than parent-PID exit.
internal static class Program
{
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits
    {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr Min, Max;
        public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits
    {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct Startup
    {
        public int Size; public string? Reserved, Desktop, Title; public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] public bool Inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr data, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetShortPathName(string path, StringBuilder result, uint length);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(
        string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit,
        uint flags, IntPtr environment, string directory, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFile(
        string name, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value)
    {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes).Append(c); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static ProcessInfo Start(string executable, string[] arguments, string directory, Dictionary<string, string>? environment, string output, uint flags)
    {
        var attributes = new Security { Length = Marshal.SizeOf<Security>(), Inherit = true };
        using var log = CreateFile(output, 0x40000000, 3, ref attributes, 4, 0x80, IntPtr.Zero);
        using var input = CreateFile("NUL", 0x80000000, 3, ref attributes, 3, 0x80, IntPtr.Zero);
        if (log.IsInvalid || input.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var startup = new Startup { Size = Marshal.SizeOf<Startup>(), Flags = 0x100,
            Input = input.DangerousGetHandle(), Output = log.DangerousGetHandle(), Error = log.DangerousGetHandle() };
        IntPtr block = IntPtr.Zero;
        try {
            if (environment is not null) block = Marshal.StringToHGlobalUni(string.Join('\0', environment.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).Select(pair => $"{pair.Key}={pair.Value}")) + "\0\0");
            Check(CreateProcess(executable, new StringBuilder(string.Join(' ', new[] { Quote(executable) }.Concat(arguments.Select(Quote)))),
                IntPtr.Zero, IntPtr.Zero, true, flags | 0x400 | 0x08000000, block, directory, ref startup, out var info));
            return info;
        } finally { if (block != IntPtr.Zero) Marshal.FreeHGlobal(block); }
    }
    static uint[] Members(IntPtr job)
    {
        int size = 8 + 64 * IntPtr.Size; IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Check(QueryInformationJobObject(job, 3, buffer, (uint)size, out _));
            int count = Marshal.ReadInt32(buffer, 4);
            return Enumerable.Range(0, count).Select(i => (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64()).ToArray();
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static void KillAndDrain(IntPtr job)
    {
        var handles = new List<IntPtr>();
        try {
            foreach (uint pid in Members(job)) {
                var handle = OpenProcess(0x00100000, false, pid);
                if (handle == IntPtr.Zero) {
                    if (Marshal.GetLastWin32Error() != 87) throw new Win32Exception(Marshal.GetLastWin32Error());
                } else handles.Add(handle);
            }
            Check(TerminateJobObject(job, 137));
            var deadline = Stopwatch.StartNew();
            foreach (var handle in handles) {
                uint remaining = (uint)Math.Max(0, 10000 - deadline.ElapsedMilliseconds);
                if (WaitForSingleObject(handle, remaining) != 0) throw new TimeoutException("A native writer process has not exited");
            }
            while (Members(job).Length != 0) {
                if (deadline.Elapsed > TimeSpan.FromSeconds(10)) throw new TimeoutException("Kernel job still has active writers");
                Thread.Sleep(10);
            }
        } finally { foreach (var handle in handles) CloseHandle(handle); }
    }
    static int Main(string[] args)
    {
        foreach (int descriptor in new[] { -10, -11, -12 }) {
            var handle = GetStdHandle(descriptor);
            if (handle != IntPtr.Zero && handle != new IntPtr(-1)) Check(SetHandleInformation(handle, 1, 0));
        }
        if (args.Length != 0 && args[0] == "--short-path") {
            var result = new StringBuilder(32768);
            uint length = GetShortPathName(args[1], result, (uint)result.Capacity);
            if (length == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (length >= result.Capacity) throw new InvalidOperationException("Short-path result exceeded its owned buffer");
            Console.WriteLine(result);
            return 0;
        }
        if (args.Length != 0 && args[0] == "--writer") {
            for (int i = 0; i < 2400; i++) { File.AppendAllText(args[1], $"{i}\n"); Thread.Sleep(25); }
            return 0;
        }
        if (args.Length != 0 && args[0] == "--spawn-writer") {
            string executable = Environment.ProcessPath!, dll = typeof(Program).Assembly.Location;
            var child = Start(executable, [dll, "--writer", args[1]], Environment.CurrentDirectory, null, args[1] + ".output", 0x200);
            CloseHandle(child.Thread); CloseHandle(child.Process);
            bool blocked;
            try {
                var escape = Start(executable, [dll, "--writer", args[1] + ".escape"], Environment.CurrentDirectory, null, args[1] + ".escape-output", 0x01000000 | 4);
                TerminateProcess(escape.Process, 137); CloseHandle(escape.Thread); CloseHandle(escape.Process);
                blocked = false;
            } catch (Win32Exception error) when (error.NativeErrorCode == 5) { blocked = true; }
            Console.WriteLine(JsonSerializer.Serialize(new { writerPid = child.Pid, breakawayBlocked = blocked }));
            return blocked ? 0 : 2;
        }
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        try {
            var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = 0x2000 | 8 | 0x200, ActiveLimit = 32 },
                JobMemory = (UIntPtr)(1024UL * 1024 * 1024) };
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf<ExtendedLimits>()));
            string? line;
            while ((line = Console.ReadLine()) is not null) {
                using var document = JsonDocument.Parse(line); var request = document.RootElement;
                int id = request.GetProperty("id").GetInt32();
                try {
                    object result;
                    switch (request.GetProperty("op").GetString()) {
                        case "start":
                            var info = Start(request.GetProperty("executable").GetString()!,
                                request.GetProperty("arguments").Deserialize<string[]>()!, request.GetProperty("directory").GetString()!,
                                request.GetProperty("environment").Deserialize<Dictionary<string, string>>()!, request.GetProperty("output").GetString()!, 4);
                            try {
                                try { Check(AssignProcessToJobObject(job, info.Process)); }
                                catch { TerminateProcess(info.Process, 137); throw; }
                                if (ResumeThread(info.Thread) == uint.MaxValue) { TerminateProcess(info.Process, 137); throw new Win32Exception(Marshal.GetLastWin32Error()); }
                                result = new { pid = info.Pid, members = Members(job) };
                            } finally { CloseHandle(info.Thread); CloseHandle(info.Process); }
                            break;
                        case "inspect": result = new { members = Members(job) }; break;
                        case "stop": KillAndDrain(job); result = new { members = Members(job), stopped = true }; break;
                        default: throw new ArgumentException("Unknown writer-scope operation");
                    }
                    Console.WriteLine(JsonSerializer.Serialize(new { id, ok = true, result }));
                } catch (Exception error) { Console.WriteLine(JsonSerializer.Serialize(new { id, ok = false, error = error.Message })); }
            }
        } finally { KillAndDrain(job); CloseHandle(job); }
        return 0;
    }
}
