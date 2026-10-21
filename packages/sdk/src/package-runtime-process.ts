import { hostname, platform } from "node:os";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const powershell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
let host: Promise<string> | undefined;
export function runtimeHostKey(): Promise<string> {
    return host ??= (async () => {
        if (platform() === "linux") {
            await exec("/usr/bin/python3", ["-I", "-c",
                "import os,signal; fd=os.pidfd_open(os.getpid()); signal.pidfd_send_signal(fd,0); os.close(fd)"], { timeout: 5000 });
            return `${hostname()}:${(await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()}:${(await fs.stat("/proc/self/ns/pid")).ino}`;
        }
        if (platform() === "win32") {
            const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command",
                "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"], { timeout: 5000 });
            return `${hostname()}:${stdout.trim()}`;
        }
        throw new Error("Package process recovery requires Linux or Windows process identity support");
    })().catch(error => {
        host = undefined;
        throw error;
    });
}
/** A recycled PID must never authorize killing the unrelated replacement. */
export async function runtimeProcessToken(pid: number): Promise<string | null> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid process identity");
    if (platform() === "linux") {
        try {
            const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            return fields[0] === "Z" ? null : fields[19];
        } catch (error: any) { if (error.code === "ENOENT") return null; throw error; }
    }
    if (platform() === "win32") {
        const { stdout } = await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command",
            `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){$p.CreationDate.ToUniversalTime().ToString('o')}`], { timeout: 5000 });
        return stdout.trim() || null;
    }
    throw new Error("Unsupported package process identity platform");
}
export async function terminateRecordedProcess(pid: number, token: string): Promise<void> {
    if (pid === process.pid) throw new Error("Refusing to fence the recovery process");
    if (await runtimeProcessToken(pid) !== token) return;
    if (platform() === "win32") {
        // Keep an OS handle open across identity verification and termination:
        // a separate token-check followed by kill(pid) can race PID recycling.
        await exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference='Stop'
try {$p=[System.Diagnostics.Process]::GetProcessById(${pid})} catch [System.ArgumentException] {exit 0}
try {
 $handle=$p.Handle
 if($p.HasExited){exit 0}
 $start=$p.StartTime.ToUniversalTime()
 # CIM records microseconds; Process.StartTime also exposes the final 100ns digit.
 $start=[DateTime]::new($start.Ticks-($start.Ticks%10),[DateTimeKind]::Utc)
 if($start.ToString('o') -cne '${token.replace(/'/g, "''")}'){exit 0}
 $p.Kill()
 if(-not $p.WaitForExit(3000)){throw 'Recorded process exit not observed'}
} finally {$p.Dispose()}
`], { timeout: 5000 });
        return;
    }
    if (platform() === "linux") {
        // pidfd targets an OS process identity, never an unrelated replacement.
        // Missing Python/kernel support denies recovery instead of using kill(pid).
        await exec("/usr/bin/python3", ["-I", "-c", `
import os, select, signal, sys
pid, expected = int(sys.argv[1]), sys.argv[2]
try:
    fd = os.pidfd_open(pid)
except ProcessLookupError:
    sys.exit(0)
try:
    try:
        stat = open("/proc/%d/stat" % pid).read()
    except FileNotFoundError:
        stat = None
    if stat is not None:
        fields = stat[stat.rfind(")") + 2:].split()
        if fields[19] != expected or fields[0] == "Z":
            sys.exit(0)
        try:
            signal.pidfd_send_signal(fd, signal.SIGKILL)
        except ProcessLookupError:
            pass
    poller = select.poll()
    poller.register(fd, select.POLLIN)
    if not poller.poll(3000):
        raise RuntimeError("Recorded process exit not observed")
finally:
    os.close(fd)
`, String(pid), token], { timeout: 5000 });
        return;
    }
    throw new Error("Unsupported atomic process recovery platform");
}
