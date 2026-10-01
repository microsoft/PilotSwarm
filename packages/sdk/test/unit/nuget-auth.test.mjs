import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
    protectNuGetPassword,
    renderNuGetConfig,
} from "../../dist/nuget-auth.js";

const CIPHERTEXT = Buffer.from("encrypted-password", "utf8").toString("base64");

test("NuGet DPAPI protection passes the password only through stdin", () => {
    let request;
    const originalAdoPat = process.env.ADO_PAT;
    process.env.ADO_PAT = "environment-secret";
    let protectedPassword;
    try {
        protectedPassword = protectNuGetPassword("secret-password", {
            platform: "win32",
            run(input) {
                request = input;
                return {
                    status: 0,
                    stdout: CIPHERTEXT,
                    stderr: "",
                };
            },
        });
    } finally {
        if (originalAdoPat === undefined) {
            delete process.env.ADO_PAT;
        } else {
            process.env.ADO_PAT = originalAdoPat;
        }
    }

    assert.equal(protectedPassword, CIPHERTEXT);
    assert.equal(
        request.input,
        Buffer.from("secret-password", "utf8").toString("base64"),
    );
    assert.equal(request.input.includes("secret-password"), false);
    assert.equal(request.file, "powershell.exe");
    assert.equal(request.args.includes("secret-password"), false);
    assert.equal(JSON.stringify(request.args).includes("secret-password"), false);
    assert.equal(request.env.ADO_PAT, undefined);
    assert.equal(JSON.stringify(request.env).includes("environment-secret"), false);
});

test("NuGet DPAPI protection rejects unsupported or invalid results", () => {
    assert.throws(
        () => protectNuGetPassword("secret", { platform: "linux" }),
        /requires Windows/,
    );
    assert.throws(
        () => protectNuGetPassword("", { platform: "win32" }),
        /must be non-empty/,
    );
    assert.throws(
        () => protectNuGetPassword("secret", {
            platform: "win32",
            run: () => ({ status: 1, stdout: "", stderr: "DPAPI unavailable" }),
        }),
        /DPAPI unavailable/,
    );
    assert.throws(
        () => protectNuGetPassword("secret", {
            platform: "win32",
            run: () => ({ status: 0, stdout: "not base64", stderr: "" }),
        }),
        /invalid ciphertext/,
    );
});

test("NuGet config contains only encrypted feed credentials", () => {
    const xml = renderNuGetConfig({
        feeds: ["https://example.test/feed?a=1&b=2"],
        localSources: ['C:\\packages\\"preview"'],
        credential: {
            username: 'runtime&identity',
            password: "secret-password",
        },
        protectPassword(password) {
            assert.equal(password, "secret-password");
            return CIPHERTEXT;
        },
    });

    assert.match(xml, /key="Password"/);
    assert.doesNotMatch(xml, /ClearTextPassword/);
    assert.doesNotMatch(xml, /secret-password/);
    assert.match(xml, new RegExp(CIPHERTEXT));
    assert.match(xml, /runtime&amp;identity/);
    assert.match(xml, /a=1&amp;b=2/);
    assert.match(xml, /&quot;preview&quot;/);
});

test("NuGet config omits private feeds when no credential is available", () => {
    const xml = renderNuGetConfig({
        feeds: ["https://example.test/private"],
        localSources: ["C:\\packages"],
    });

    assert.doesNotMatch(xml, /example\.test/);
    assert.doesNotMatch(xml, /packageSourceCredentials/);
    assert.match(xml, /C:\\packages/);
});

test("NuGet config does not protect a password for local-only sources", () => {
    const xml = renderNuGetConfig({
        feeds: [],
        localSources: ["C:\\packages"],
        credential: {
            username: "unused",
            password: "unused-password",
        },
        protectPassword() {
            throw new Error("password protection should not run");
        },
    });

    assert.doesNotMatch(xml, /packageSourceCredentials/);
    assert.match(xml, /C:\\packages/);
});

test(
    "NuGet DPAPI ciphertext round-trips with NuGet's Windows parameters",
    { skip: process.platform !== "win32" },
    () => {
        const plaintext = "p\u00e4ss\u{1f512}-unit-test";
        const ciphertext = protectNuGetPassword(plaintext);
        const script = [
            "$ErrorActionPreference='Stop'",
            "$ProgressPreference='SilentlyContinue'",
            "Add-Type -AssemblyName System.Security",
            "$ciphertext=[Console]::In.ReadToEnd()",
            "$entropy=[Text.Encoding]::UTF8.GetBytes('NuGet')",
            "$bytes=[System.Security.Cryptography.ProtectedData]::Unprotect(" +
                "[Convert]::FromBase64String($ciphertext),$entropy," +
                "[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
            "[Console]::Out.Write([Convert]::ToBase64String($bytes))",
        ].join("; ");
        const result = spawnSync(
            "powershell.exe",
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                script,
            ],
            {
                input: ciphertext,
                encoding: "utf8",
                windowsHide: true,
            },
        );

        assert.equal(result.status, 0, result.stderr);
        assert.equal(
            Buffer.from(result.stdout, "base64").toString("utf8"),
            plaintext,
        );
    },
);
