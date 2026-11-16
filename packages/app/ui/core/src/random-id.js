// crypto.randomUUID exists only on secure origins (HTTPS or localhost). A
// portal reached over plain HTTP still needs ids, so fall back to a version 4
// UUID built from crypto.getRandomValues, which every origin has.
export function randomUuid(cryptoApi = globalThis.crypto) {
    if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
    const bytes = new Uint8Array(16);
    if (typeof cryptoApi?.getRandomValues === "function") cryptoApi.getRandomValues(bytes);
    else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
