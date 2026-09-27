/**
 * P-256 keys (ECDSA with SHA-256) for the cluster and for each host.
 *
 * P-256 and not Ed25519, so a cluster key can later live inside Azure Key
 * Vault and never leave it: Key Vault signs with EC P-256 but does not
 * support Ed25519. Signatures use the fixed 64-byte r||s form (IEEE P1363),
 * the same form Key Vault returns.
 */

import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign,
    verify,
    type KeyObject,
} from "node:crypto";

export interface KeyPairPems {
    privateKeyPem: string;
    publicKeyPem: string;
    fingerprint: string;
}

function requireP256(key: KeyObject, what: string): KeyObject {
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
        throw new Error(`${what} must be an EC P-256 key`);
    }
    return key;
}

/** "sha256:" + base64url of the SHA-256 of the public key (SPKI DER). */
export function fingerprintOf(publicKey: KeyObject): string {
    const der = publicKey.export({ type: "spki", format: "der" });
    return `sha256:${createHash("sha256").update(der).digest("base64url")}`;
}

export function publicKeyFromPem(pem: string, what = "the public key"): KeyObject {
    return requireP256(createPublicKey(pem), what);
}

export function fingerprintOfPem(pem: string): string {
    return fingerprintOf(publicKeyFromPem(pem));
}

export function generateKeyPair(): KeyPairPems {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    return {
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        fingerprint: fingerprintOf(publicKey),
    };
}

/** Holds a private key and signs with it. The key is a #private field, so it never prints. */
export class KeySigner {
    readonly fingerprint: string;
    readonly publicKeyPem: string;
    readonly #privateKey: KeyObject;

    constructor(privateKeyPem: string, what = "the private key") {
        this.#privateKey = requireP256(createPrivateKey(privateKeyPem), what);
        const publicKey = createPublicKey(this.#privateKey);
        this.publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
        this.fingerprint = fingerprintOf(publicKey);
    }

    signBytes(data: Buffer): string {
        return sign("sha256", data, { key: this.#privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    }
}

export type { KeyObject };

/** False for any bad input; never throws. */
export function verifyBytes(publicKey: KeyObject, data: Buffer, signature: unknown): boolean {
    if (typeof signature !== "string" || signature.length === 0) return false;
    try {
        return verify("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
    } catch {
        return false;
    }
}
