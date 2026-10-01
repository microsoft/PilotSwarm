import { spawnSync } from "node:child_process";

const NUGET_DPAPI_POWERSHELL = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    "$encoded=[Console]::In.ReadToEnd()",
    "$entropy=[Text.Encoding]::UTF8.GetBytes('NuGet')",
    "$bytes=[Convert]::FromBase64String($encoded)",
    "$protected=[System.Security.Cryptography.ProtectedData]::Protect(" +
        "$bytes,$entropy,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($protected))",
].join("; ");

export interface NuGetDpapiProcessRequest {
    file: string;
    args: readonly string[];
    input: string;
    env: NodeJS.ProcessEnv;
}

export interface NuGetDpapiProcessResult {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
}

export type NuGetDpapiProcessRunner = (
    request: NuGetDpapiProcessRequest,
) => NuGetDpapiProcessResult;

export interface ProtectNuGetPasswordOptions {
    platform?: NodeJS.Platform;
    run?: NuGetDpapiProcessRunner;
}

export interface NuGetFeedCredential {
    username: string;
    password: string;
}

export interface RenderNuGetConfigOptions {
    feeds: readonly string[];
    localSources?: readonly string[];
    credential?: NuGetFeedCredential;
    protectPassword?: (password: string) => string;
}

function runNuGetDpapiProcess(
    request: NuGetDpapiProcessRequest,
): NuGetDpapiProcessResult {
    const result = spawnSync(request.file, [...request.args], {
        input: request.input,
        encoding: "utf8",
        env: request.env,
        windowsHide: true,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error,
    };
}

function nuGetDpapiEnvironment(
    source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (
        const name of [
            "APPDATA",
            "ComSpec",
            "LOCALAPPDATA",
            "PATH",
            "PATHEXT",
            "SystemRoot",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "WINDIR",
        ]
    ) {
        if (source[name] !== undefined) {
            environment[name] = source[name];
        }
    }
    return environment;
}

function isBase64(value: string): boolean {
    if (!value || value.length % 4 !== 0) return false;
    try {
        return Buffer.from(value, "base64").toString("base64") === value;
    } catch {
        return false;
    }
}

export function protectNuGetPassword(
    password: string,
    options: ProtectNuGetPasswordOptions = {},
): string {
    if (!password) {
        throw new Error("NuGet password must be non-empty.");
    }
    if ((options.platform ?? process.platform) !== "win32") {
        throw new Error("NuGet DPAPI password protection requires Windows.");
    }

    const result = (options.run ?? runNuGetDpapiProcess)({
        file: "powershell.exe",
        args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            NUGET_DPAPI_POWERSHELL,
        ],
        input: Buffer.from(password, "utf8").toString("base64"),
        env: nuGetDpapiEnvironment(),
    });
    if (result.error) {
        throw new Error(
            `NuGet DPAPI password protection could not start: ${result.error.message}`,
        );
    }
    if (result.status !== 0) {
        const detail = result.stderr.trim();
        throw new Error(
            "NuGet DPAPI password protection failed" +
                (detail ? `: ${detail}` : "."),
        );
    }

    const protectedPassword = result.stdout.trim();
    if (!isBase64(protectedPassword)) {
        throw new Error(
            "NuGet DPAPI password protection returned invalid ciphertext.",
        );
    }
    return protectedPassword;
}

function escapeXml(value: string): string {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

export function renderNuGetConfig(
    options: RenderNuGetConfigOptions,
): string {
    const sources: string[] = [];
    const credentials: string[] = [];
    const credential = options.credential;
    const protectedPassword = credential && options.feeds.length > 0
        ? (options.protectPassword ?? protectNuGetPassword)(
            credential.password,
        )
        : undefined;

    if (credential && protectedPassword) {
        options.feeds.forEach((url, index) => {
            const key = `ado_feed_${index}`;
            sources.push(
                `    <add key="${key}" value="${escapeXml(url)}" />`,
            );
            credentials.push(
                `    <${key}>\n` +
                    `      <add key="Username" value="${
                        escapeXml(credential.username)
                    }" />\n` +
                    `      <add key="Password" value="${
                        escapeXml(protectedPassword)
                    }" />\n` +
                    `    </${key}>`,
            );
        });
    }

    (options.localSources ?? []).forEach((directory, index) => {
        sources.push(
            `    <add key="local_src_${index}" value="${
                escapeXml(directory)
            }" />`,
        );
    });

    const credentialsXml = credentials.length > 0
        ? `  <packageSourceCredentials>\n${
            credentials.join("\n")
        }\n  </packageSourceCredentials>\n`
        : "";
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n' +
        "<configuration>\n" +
        "  <packageSources>\n" +
        `${sources.join("\n")}\n` +
        "  </packageSources>\n" +
        credentialsXml +
        "</configuration>\n"
    );
}
