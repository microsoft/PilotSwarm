/**
 * An in-memory stand-in for the @azure/storage-blob ContainerClient, only as far as
 * SessionBlobStore uses it for snapshots: block blobs with metadata, etags,
 * If-Match / If-None-Match conditions (412 / 409 like the service), listing by prefix,
 * and hooks that run before a read, upload or delete so a test can place another
 * writer exactly between two steps of the store. No credentials, no network.
 */
import fs from "node:fs";
import { Readable } from "node:stream";

// The service's own error codes for the statuses this fake raises, as a real RestError carries them (`code`).
const STORAGE_ERROR_CODES = { 404: "BlobNotFound", 409: "BlobAlreadyExists", 412: "ConditionNotMet" };

function storageError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode, code: STORAGE_ERROR_CODES[statusCode] });
}

export function makeFakeContainer() {
    const blobs = new Map();
    let counter = 0;
    const hooks = { beforeDelete: null, afterDelete: null, beforeRead: null, beforeList: null, beforeUpload: null, afterUpload: null, beforeSetMetadata: null, afterSetMetadata: null, afterList: null };
    const nextEtag = () => `"0x${(++counter).toString(16)}"`;

    function checkConditions(name, conditions) {
        if (!conditions) return;
        const entry = blobs.get(name);
        if (conditions.ifNoneMatch === "*" && entry) throw storageError(409, `blob ${name} already exists`);
        if (conditions.ifMatch !== undefined) {
            if (!entry || entry.etag !== conditions.ifMatch) throw storageError(412, `condition not met for ${name}`);
        }
    }

    function blobClient(name) {
        return {
            exists: async () => blobs.has(name),
            getProperties: async () => {
                if (hooks.beforeRead) await hooks.beforeRead(name, "getProperties");
                const entry = blobs.get(name);
                if (!entry) throw storageError(404, `blob ${name} not found`);
                return { etag: entry.etag, metadata: { ...entry.metadata }, contentLength: entry.body.length };
            },
            download: async () => {
                if (hooks.beforeRead) await hooks.beforeRead(name, "download");
                const entry = blobs.get(name);
                if (!entry) throw storageError(404, `blob ${name} not found`);
                return { etag: entry.etag, metadata: { ...entry.metadata }, contentLength: entry.body.length, readableStreamBody: Readable.from([Buffer.from(entry.body)]) };
            },
            downloadToFile: async (filePath) => {
                const entry = blobs.get(name);
                if (!entry) throw storageError(404, `blob ${name} not found`);
                fs.writeFileSync(filePath, entry.body);
                return { etag: entry.etag, metadata: { ...entry.metadata } };
            },
            upload: async (body, _length, options = {}) => {
                if (hooks.beforeUpload) await hooks.beforeUpload(name);
                checkConditions(name, options.conditions);
                const etag = nextEtag();
                blobs.set(name, { body: Buffer.from(body), metadata: { ...(options.metadata ?? {}) }, etag });
                if (hooks.afterUpload) await hooks.afterUpload(name);
                return { etag };
            },
            setMetadata: async (metadata, options = {}) => {
                if (hooks.beforeSetMetadata) await hooks.beforeSetMetadata(name);
                if (!blobs.has(name)) throw storageError(404, `blob ${name} not found`);
                checkConditions(name, options.conditions);
                const entry = blobs.get(name);
                const etag = nextEtag();
                blobs.set(name, { ...entry, metadata: { ...metadata }, etag });
                // After the write has happened: a hook that throws here is a lost response.
                if (hooks.afterSetMetadata) await hooks.afterSetMetadata(name);
                return { etag };
            },
            deleteIfExists: async (options = {}) => {
                if (hooks.beforeDelete) await hooks.beforeDelete(name);
                if (!blobs.has(name)) return { succeeded: false };
                checkConditions(name, options.conditions);
                blobs.delete(name);
                if (hooks.afterDelete) await hooks.afterDelete(name);
                return { succeeded: true };
            },
        };
    }

    const containerClient = {
        getBlockBlobClient: blobClient,
        listBlobsFlat: (options = {}) => {
            const prefix = options.prefix ?? "";
            return (async function* () {
                if (hooks.beforeList) await hooks.beforeList(prefix);
                const names = [...blobs.keys()].filter((name) => name.startsWith(prefix)).sort();
                for (const name of names) yield { name };
                // After the names were taken (a snapshot) and handed over: whatever a hook does here is NOT in the answer the caller already has.
                if (hooks.afterList) await hooks.afterList(prefix);
            })();
        },
    };

    return {
        containerClient,
        hooks,
        names: (prefix = "") => [...blobs.keys()].filter((name) => name.startsWith(prefix)).sort(),
        /** Give a blob a chosen ETag: lets a test make two different blobs share one, which a real service does not promise never to do. */
        forceEtag: (name, etag) => { const entry = blobs.get(name); if (entry) blobs.set(name, { ...entry, etag }); },
        /** A blob's body as text ("" when absent): for tests that look for text that must never be stored. */
        text: (name) => (blobs.get(name)?.body ?? Buffer.alloc(0)).toString("utf8"),
        /** Write a blob directly, bypassing conditions: another writer replacing an object. */
        replace: (name, body, metadata = {}) => { blobs.set(name, { body: Buffer.from(body), metadata: { ...metadata }, etag: nextEtag() }); },
    };
}
