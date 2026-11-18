#!/usr/bin/env node
/**
 * Patch @github/copilot-sdk to fix ESM import of vscode-jsonrpc.
 * The SDK's session.js imports "vscode-jsonrpc/node" without the .js extension,
 * which breaks ESM module resolution. This patch adds the .js extension.
 *
 * See: https://github.com/github/copilot-sdk/issues (not yet filed)
 * Can be removed once the SDK ships the fix.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkDist = path.join(__dirname, "..", "node_modules", "@github", "copilot-sdk", "dist");

const files = ["session.js", "session.d.ts"];
let patched = 0;

// Walks up from startDir to the first node_modules/vscode-jsonrpc/package.json and
// reports whether its "exports" has a "./node" key. require.resolve is not used
// because vscode-jsonrpc 10.x does not export "./package.json".
function jsonrpcExportsNode(startDir) {
    let dir = startDir;
    while (true) {
        const pkgPath = path.join(dir, "node_modules", "vscode-jsonrpc", "package.json");
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                return pkg.exports !== null
                    && typeof pkg.exports === "object"
                    && Object.prototype.hasOwnProperty.call(pkg.exports, "./node");
            } catch {
                return false;
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) return false;
        dir = parent;
    }
}

for (const file of files) {
    const filePath = path.join(sdkDist, file);
    if (!fs.existsSync(filePath)) continue;
    let content = fs.readFileSync(filePath, "utf-8");
    if (content.includes('"vscode-jsonrpc/node"') && !content.includes('"vscode-jsonrpc/node.js"')) {
        if (jsonrpcExportsNode(path.dirname(filePath))) {
            console.log("postinstall: vscode-jsonrpc exports ./node, rewrite skipped");
            continue;
        }
        content = content.replace(/from "vscode-jsonrpc\/node"/g, 'from "vscode-jsonrpc/node.js"');
        fs.writeFileSync(filePath, content, "utf-8");
        patched++;
    }
}

if (patched > 0) {
    console.log(`[postinstall] Patched ${patched} file(s) in @github/copilot-sdk for ESM compatibility`);
}
