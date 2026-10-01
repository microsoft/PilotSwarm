import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../../scripts/run-tests.sh", import.meta.url));

function bashExecutable() {
    if (process.platform !== "win32") return "bash";
    const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const gitRoot = resolve(gitExecPath, "../../..");
    const bash = join(gitRoot, "bin", "bash.exe");
    assert.ok(existsSync(bash), `Git Bash not found at ${bash}`);
    return bash;
}

function bashPath(file) {
    if (process.platform !== "win32") return file;
    return `/${file[0].toLowerCase()}${file.slice(2).replaceAll("\\", "/")}`;
}

function loadEnvFunction() {
    const source = readFileSync(SCRIPT, "utf8");
    const start = source.indexOf("load_env_file() {");
    assert.notEqual(start, -1, "run-tests.sh has no load_env_file function");
    const end = source.indexOf("\n}", start);
    assert.notEqual(end, -1, "load_env_file function has no closing brace");
    return source.slice(start, end + 2);
}

test("run-tests env loader strips CRLF without interpreting values as shell", () => {
    const directory = mkdtempSync(join(tmpdir(), "pilotswarm-env-loader-"));
    try {
        const envFile = join(directory, ".env");
        writeFileSync(
            envFile,
            [
                "CRLF_PLAIN=plain-value",
                "CRLF_AMPERSAND=postgres://host/db?sslmode=require&connect_timeout=10",
                'CRLF_QUOTED="quoted value"',
                "",
            ].join("\r\n"),
            "utf8",
        );

        const program = `${loadEnvFunction()}
load_env_file "$1"
printf '%s\\n' "$CRLF_PLAIN"
printf '%s\\n' "$CRLF_AMPERSAND"
printf '%s\\n' "$CRLF_QUOTED"
`;
        const output = execFileSync(
            bashExecutable(),
            ["-c", program, "env-loader-test", bashPath(envFile)],
            { encoding: "utf8" },
        );

        assert.equal(
            output,
            "plain-value\n" +
            "postgres://host/db?sslmode=require&connect_timeout=10\n" +
            "quoted value\n",
        );
        assert.doesNotMatch(output, /\r/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
