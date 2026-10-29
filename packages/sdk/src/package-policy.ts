import path from "node:path";
import { pathToFileURL } from "node:url";
import { packAgentPackage } from "./agent-package-format.js";

export const PACKAGE_POLICY_API_VERSION = 1;

export interface PackagePolicyInput {
    kind: "agent" | "workflow";
    root: string;
    packageSha256: string;
}

/**
 * Optional host-owned admission boundary. Policies must throw to reject content;
 * they run before package modules or workflow transitions can be imported.
 */
export async function assertPackagePolicy(input: PackagePolicyInput): Promise<void> {
    const modulePath = process.env.PILOTSWARM_PACKAGE_POLICY_MODULE?.trim();
    if (!modulePath) return;
    if (!path.isAbsolute(modulePath)) {
        throw new Error("PILOTSWARM_PACKAGE_POLICY_MODULE must be an absolute path.");
    }
    if (packAgentPackage(input.root).sha256 !== input.packageSha256) {
        throw Object.assign(new Error("Package content does not match its admitted identity."), {
            code: "PACKAGE_POLICY_CONTENT_MISMATCH",
        });
    }
    const policy = await import(pathToFileURL(path.resolve(modulePath)).href);
    if (typeof policy.authorizePackage !== "function") {
        throw new Error("PILOTSWARM_PACKAGE_POLICY_MODULE must export authorizePackage(input).");
    }
    await policy.authorizePackage(input);
}
