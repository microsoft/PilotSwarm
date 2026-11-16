import type { Pool, PoolClient } from "pg";
import { fileTypeFromBuffer } from "file-type";
import type { FeatureOwner } from "./feature-flags.js";

export const MOTD_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const MOTD_BODY_MAX_BYTES = 16 * 1024;
export const MOTD_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export interface MotdViewer { principal: FeatureOwner | null; isAdmin: boolean }
export interface MotdImageInput { base64: string; contentType: string; alt: string }
export interface MotdCreateInput {
    startsAt?: string; endsAt?: string;
    /** Legacy aliases retained for existing clients. */
    fromAt?: string; toAt?: string; bodyMd: string; mobileBodyMd?: string;
    image?: MotdImageInput; mobileImage?: MotdImageInput;
    imagePlacement?: "above" | "beside" | "background"; requestId: string;
}
export interface MotdMessage {
    motdId: string; startsAt: string; endsAt: string | null;
    fromAt: string; toAt: string | null; bodyMd: string; mobileBodyMd: string | null;
    hasImage: boolean; imageType: string | null; imageAlt: string | null;
    hasMobileImage: boolean; mobileImageType: string | null; mobileImageAlt: string | null;
    imagePlacement: "above" | "beside" | "background"; createdAt: string; createdBy?: FeatureOwner;
}
export interface MotdHistoryMessage extends MotdMessage { status: "live" | "hidden" | "scheduled" | "ended"; dismissalCount?: number }
export class MotdError extends Error {
    constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); this.name = "MotdError"; }
}
export function validateMotdId(id: unknown): asserts id is string {
    if (typeof id !== "string" || !/^[1-9]\d*$/.test(id) || BigInt(id) > 9223372036854775807n)
        throw new MotdError("MOTD_INVALID", "Invalid message ID");
}
async function decodePicture(input: MotdImageInput | undefined): Promise<Buffer | null> {
    if (input === undefined) return null;
    if (!input || typeof input.base64 !== "string" || !input.base64.length || input.base64.length > Math.ceil(MOTD_IMAGE_MAX_BYTES / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)
        || typeof input.alt !== "string" || !input.alt.trim() || input.alt.length > 1024 || input.alt.includes("\u0000")
        || !MOTD_IMAGE_TYPES.some(type => type === input.contentType))
        throw new MotdError("MOTD_INVALID", "Pictures require PNG, JPEG, WebP or GIF, base64 and alt text");
    const bytes = Buffer.from(input.base64, "base64");
    if (!bytes.length || bytes.length > MOTD_IMAGE_MAX_BYTES || bytes.toString("base64") !== input.base64)
        throw new MotdError("MOTD_INVALID", "A picture must be at most 2 MB");
    const detected = await fileTypeFromBuffer(bytes);
    const detectedType = detected?.mime === "image/apng" ? "image/png" : detected?.mime;
    if (detectedType !== input.contentType) throw new MotdError("MOTD_INVALID", "Picture bytes do not match the declared type");
    return bytes;
}
export class MotdStore {
    private readonly schema: string;
    constructor(private readonly pool: Pool, schema: string) { this.schema = `"${schema.replace(/"/g, '""')}"`; }
    private async call<T>(name: string, viewer: MotdViewer, args: unknown[] = []): Promise<T> {
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let client: PoolClient;
        try {
            client = await Promise.race([
                this.pool.connect().then(connection => {
                    if (expired) { connection.release(); throw new Error("Message connection acquired after deadline"); }
                    return connection;
                }),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => { expired = true; reject(new Error("Message database connection timed out")); }, 5_000);
                }),
            ]);
        } finally { if (timer) clearTimeout(timer); }
        const parameters = [viewer?.principal?.provider ?? null, viewer?.principal?.subject ?? null, viewer?.isAdmin === true, ...args];
        const query = (text: string, values: unknown[] = []) => {
            const config = { text, values, query_timeout: 6_000 };
            return client.query(config);
        };
        try {
            await query("BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL lock_timeout = '5s'");
            const result = await query(`SELECT ${this.schema}.${name}(${parameters.map((_, i) => `$${i + 1}`).join(",")}) AS result`, parameters);
            await query("COMMIT"); client.release();
            return result.rows[0].result as T;
        } catch (error) {
            client.release(error instanceof Error ? error : new Error(String(error)));
            const match = /^MOTD_(FORBIDDEN|INVALID|NOT_FOUND|CONFLICT):\s*(.*)$/s.exec(error instanceof Error ? error.message : "");
            if (match) throw new MotdError(`MOTD_${match[1]}`, match[2], { FORBIDDEN: 403, INVALID: 400, NOT_FOUND: 404, CONFLICT: 409 }[match[1]]);
            throw error;
        }
    }
    current(viewer: MotdViewer): Promise<MotdMessage | null> { return this.call("cms_motd_current", viewer); }
    list(viewer: MotdViewer, limit = 50, before?: string): Promise<MotdHistoryMessage[]> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new MotdError("MOTD_INVALID", "Limit must be between 1 and 200");
        if (before !== undefined) validateMotdId(before);
        return this.call("cms_motd_list", viewer, [limit, before ?? null]);
    }
    async create(viewer: MotdViewer, input: MotdCreateInput): Promise<MotdMessage> {
        // PostgreSQL jsonb cannot hold U+0000, so reject it here as a 400
        // rather than let the insert fail as a 500.
        const textValid = (value: unknown) => typeof value === "string" && value.trim().length > 0
            && !value.includes("\u0000") && Buffer.byteLength(value, "utf8") <= MOTD_BODY_MAX_BYTES;
        const timeValid = (value: unknown) => value === undefined
            || typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
        const start = input?.startsAt ?? input?.fromAt, end = input?.endsAt ?? input?.toAt;
        if (!input || !textValid(input.bodyMd) || input.mobileBodyMd !== undefined && !textValid(input.mobileBodyMd)
            || ![input.startsAt, input.endsAt, input.fromAt, input.toAt].every(timeValid)
            || start !== undefined && end !== undefined && Date.parse(end) <= Date.parse(start)
            || input.startsAt !== undefined && input.fromAt !== undefined && Date.parse(input.startsAt) !== Date.parse(input.fromAt)
            || input.endsAt !== undefined && input.toAt !== undefined && Date.parse(input.endsAt) !== Date.parse(input.toAt)
            || typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 128 || input.requestId.includes("\u0000")
            || input.imagePlacement !== undefined && !["above", "beside", "background"].includes(input.imagePlacement))
            throw new MotdError("MOTD_INVALID", "Invalid message body, window, placement or request ID");
        const [image, mobileImage] = await Promise.all([decodePicture(input.image), decodePicture(input.mobileImage)]);
        const metadata = { fromAt: start === undefined ? null : new Date(start).toISOString(),
            toAt: end === undefined ? null : new Date(end).toISOString(),
            bodyMd: input.bodyMd, mobileBodyMd: input.mobileBodyMd ?? null, imagePlacement: input.imagePlacement ?? "above",
            requestId: input.requestId, imageType: input.image?.contentType ?? null, imageAlt: input.image?.alt ?? null,
            mobileImageType: input.mobileImage?.contentType ?? null, mobileImageAlt: input.mobileImage?.alt ?? null };
        return this.call("cms_motd_create", viewer, [metadata, image, mobileImage]);
    }
    dismiss(viewer: MotdViewer, motdId: string): Promise<{ motdId: string; dismissed: boolean }> {
        validateMotdId(motdId); return this.call("cms_motd_dismiss", viewer, [motdId]);
    }
    delete(viewer: MotdViewer, motdId: string): Promise<{ motdId: string; deleted: boolean }> {
        validateMotdId(motdId); return this.call("cms_motd_delete", viewer, [motdId]);
    }
    image(viewer: MotdViewer, motdId: string, mobile = false): Promise<MotdImageInput | null> {
        validateMotdId(motdId);
        if (typeof mobile !== "boolean") throw new MotdError("MOTD_INVALID", "Mobile must be a boolean");
        return this.call("cms_motd_image", viewer, [motdId, mobile]);
    }
}
