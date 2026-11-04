// Third-party notices for the portal's browser bundle (dist/THIRD-PARTY-NOTICES.txt), written by vite.config.ts through
// rollup-plugin-license. Each component is listed with its name, version, license and full license text.
//
// A few packages ship another package's code already bundled inside their own files, with no import the license
// plugin can see. Those components are named here (BUNDLED_COMPONENTS) and added whenever the package that carries
// them is in the bundle, with the license text of the installed package, so the notices name every component whose code
// ships. Today that is @dagrejs/graphlib, which @dagrejs/dagre's dist bundles (batch 5 notices follow-up).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Dual-licensed components, and the license PilotSwarm uses them under. */
export const ELECTED_LICENSES = Object.freeze({ dompurify: "Apache-2.0" });

/** Components bundled inside another package's dist: `name`, carried `within` that package. */
export const BUNDLED_COMPONENTS = Object.freeze([
    Object.freeze({ name: "@dagrejs/graphlib", within: "@dagrejs/dagre" }),
]);

const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "license", "license.md"];

/**
 * One installed package as a notices entry ({ name, version, license, repository, licenseText }), read from its own
 * package.json and license file; null when it is not installed.
 */
export function installedComponent(name, requireFrom = import.meta.url) {
    let manifestPath;
    try {
        manifestPath = createRequire(requireFrom).resolve(`${name}/package.json`);
    } catch {
        return null;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const directory = path.dirname(manifestPath);
    const licenseFile = LICENSE_FILES.map(file => path.join(directory, file)).find(file => fs.existsSync(file));
    const repository = typeof manifest.repository === "string" ? { url: manifest.repository } : manifest.repository ?? null;
    return {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? null,
        repository,
        licenseText: licenseFile ? fs.readFileSync(licenseFile, "utf8") : null,
        noticeText: null,
    };
}

/** The bundled components to add to `dependencies`: those whose carrying package is listed and that are not listed themselves. */
export function bundledComponents(dependencies, requireFrom = import.meta.url) {
    const listed = new Set(dependencies.map(dependency => dependency.name));
    return BUNDLED_COMPONENTS
        .filter(component => listed.has(component.within) && !listed.has(component.name))
        .map(component => installedComponent(component.name, requireFrom))
        .filter(Boolean);
}

/** The notices file's text for `dependencies` (rollup-plugin-license's list), with the bundled components added. */
export function thirdPartyNotices(dependencies, { requireFrom = import.meta.url } = {}) {
    const all = [...dependencies, ...bundledComponents(dependencies, requireFrom)];
    const sorted = all.sort((a, b) => a.name.localeCompare(b.name) || String(a.version).localeCompare(String(b.version)));
    const header = [
        "THIRD-PARTY SOFTWARE NOTICES",
        "",
        "The PilotSwarm web portal includes the following third-party software.",
        "Each component is listed with its license and license text.",
        "",
    ];
    const sections = sorted.map((dependency) => [
        "=".repeat(78),
        `${dependency.name} ${dependency.version}`,
        `License: ${dependency.license || "see below"}`,
        ELECTED_LICENSES[dependency.name] ? `Used under: ${ELECTED_LICENSES[dependency.name]}` : null,
        dependency.repository?.url ? `Source: ${dependency.repository.url}` : null,
        "",
        String(dependency.licenseText || dependency.noticeText || "(no license text in the package)").trim(),
        dependency.noticeText && dependency.licenseText ? `\nNOTICE:\n${String(dependency.noticeText).trim()}` : null,
        "",
    ].filter((line) => line !== null).join("\n"));
    return `${header.join("\n")}\n${sections.join("\n")}\n`;
}
