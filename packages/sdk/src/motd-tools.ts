import { defineTool } from "@github/copilot-sdk";
import { MotdError, MOTD_IMAGE_MAX_BYTES, type MotdCreateInput, type MotdImageInput, type MotdStore, type MotdViewer } from "./motd-store.js";

export const MOTD_OPERATION_SPECS = [
    { method: "getCurrentMotd", name: "get_current_motd", kind: "current", access: "authed", description: "Read the newest active deployment message. Returns null if you dismissed it; older messages do not resurface." },
    { method: "dismissMotd", name: "dismiss_motd", kind: "dismiss", access: "authed", description: "Dismiss a message for yourself permanently. Later messages still show." },
    { method: "getMotdImage", name: "get_motd_image", kind: "image", access: "authed", description: "Read a message picture. Mobile falls back to the main picture." },
    { method: "listMotds", name: "list_motds", kind: "list", access: "authed", description: "Read message history, windows and overlap status. Use before for older messages. Creator identity and dismissal counts are admin-only." },
    { method: "createMotd", name: "create_motd", kind: "create", access: "fleet:admin", description: "Admin: create a deployment-wide message. Omit startsAt to show it from server creation. Omit endsAt to keep it until replaced or deleted. Pictures are at most 2 MB each. Reuse requestId unchanged for retries." },
    { method: "deleteMotd", name: "delete_motd", kind: "delete", access: "fleet:admin", description: "Admin: delete a message and its pictures. Dismissals remain; no audit record is written." },
] as const;
export type MotdOperationSpec = typeof MOTD_OPERATION_SPECS[number];
export interface MotdArtifactImage { sessionId?: string; filename: string; alt: string }
export type MotdArgs = Partial<Omit<MotdCreateInput, "image" | "mobileImage">> & {
    motdId?: string; mobile?: boolean; limit?: number; before?: string;
    image?: MotdImageInput | MotdArtifactImage; mobileImage?: MotdImageInput | MotdArtifactImage;
};
export interface MotdToolProperty {
    type: string; description?: string; enum?: string[]; pattern?: string;
    minimum?: number; maximum?: number; minLength?: number; maxLength?: number; default?: string;
    properties?: Record<string, MotdToolProperty>; required?: string[]; additionalProperties?: boolean;
}
export function motdToolParameters(spec: MotdOperationSpec, { artifactPictures = false } = {}) {
    const picture = artifactPictures
        ? { type: "object", properties: { sessionId: { type: "string" }, filename: { type: "string" }, alt: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["filename", "alt"], additionalProperties: false }
        : { type: "object", properties: { base64: { type: "string", maxLength: Math.ceil(MOTD_IMAGE_MAX_BYTES / 3) * 4 }, contentType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"] }, alt: { type: "string", minLength: 1, maxLength: 1024 } }, required: ["base64", "contentType", "alt"], additionalProperties: false };
    const properties: Record<string, MotdToolProperty> = {};
    const required: string[] = [];
    if (["dismiss", "image", "delete"].includes(spec.kind)) { properties.motdId = { type: "string", pattern: "^[1-9][0-9]*$" }; required.push("motdId"); }
    if (spec.kind === "image") properties.mobile = { type: "boolean" };
    if (spec.kind === "list") {
        properties.limit = { type: "integer", minimum: 1, maximum: 200 };
        properties.before = { type: "string", pattern: "^[1-9][0-9]*$" };
    }
    if (spec.kind === "create") {
        Object.assign(properties, { startsAt: { type: "string", description: "Optional ISO 8601 start with UTC offset. Omit for server creation time." },
            endsAt: { type: "string", description: "Optional future ISO 8601 end, exclusive. Omit endsAt to keep it until replaced or deleted." },
            fromAt: { type: "string", description: "Legacy startsAt alias." }, toAt: { type: "string", description: "Legacy endsAt alias." },
            bodyMd: { type: "string", minLength: 1, maxLength: 16384 }, mobileBodyMd: { type: "string", maxLength: 16384 },
            requestId: { type: "string", minLength: 1, maxLength: 128 },
            imagePlacement: { type: "string", enum: ["above", "beside", "background"], default: "above" },
            image: picture, mobileImage: picture });
        required.push("bodyMd", "requestId");
    }
    return { type: "object" as const, properties, required, additionalProperties: false };
}
export function motdCreateInput(args: MotdArgs): MotdCreateInput {
    if (!args.bodyMd || !args.requestId
        || args.image && !("base64" in args.image) || args.mobileImage && !("base64" in args.mobileImage))
        throw new MotdError("MOTD_INVALID", "Message body, request ID and resolved pictures are required");
    return { startsAt: args.startsAt, endsAt: args.endsAt, fromAt: args.fromAt, toAt: args.toAt, bodyMd: args.bodyMd, requestId: args.requestId,
        mobileBodyMd: args.mobileBodyMd, imagePlacement: args.imagePlacement, image: args.image, mobileImage: args.mobileImage };
}
export function runMotdStoreOperation(store: MotdStore, spec: MotdOperationSpec, viewer: MotdViewer, args: MotdArgs = {}) {
    switch (spec.kind) {
        case "current": return store.current(viewer);
        case "list": return store.list(viewer, args.limit, args.before);
        case "dismiss": return store.dismiss(viewer, args.motdId!);
        case "delete": return store.delete(viewer, args.motdId!);
        case "image": return store.image(viewer, args.motdId!, args.mobile);
        case "create": return store.create(viewer, motdCreateInput(args));
    }
}
export function createMotdTools(store: MotdStore, resolveViewer: () => Promise<MotdViewer>,
    readPicture: (image: MotdArtifactImage, viewer: MotdViewer) => Promise<MotdImageInput>, { includeAdmin = true } = {}) {
    return MOTD_OPERATION_SPECS.filter(spec => includeAdmin || spec.access !== "fleet:admin").map(spec => defineTool(spec.name, {
        description: spec.description,
        parameters: motdToolParameters(spec, { artifactPictures: true }),
        handler: async (args: MotdArgs) => {
            const viewer = await resolveViewer();
            if (!viewer.principal?.provider || !viewer.principal.subject)
                throw new MotdError("MOTD_FORBIDDEN", "Message tools require an authenticated owner", 403);
            if (spec.access === "fleet:admin" && !viewer.isAdmin)
                throw new MotdError("MOTD_FORBIDDEN", "Message management requires admin", 403);
            const resolved = { ...args };
            if (spec.kind === "create") {
                for (const key of ["image", "mobileImage"] as const) {
                    const image = args[key];
                    if (image) {
                        if ("base64" in image) throw new MotdError("MOTD_INVALID", "Agent pictures must use an artifact reference");
                        resolved[key] = await readPicture(image, viewer);
                    }
                }
            }
            // Pictures must not consume model context. The agent can read the
            // metadata; create reads the image bytes directly from its artifact.
            const result = await runMotdStoreOperation(store, spec, viewer, resolved);
            return JSON.stringify(spec.kind === "image" && result && "base64" in result
                ? { contentType: result.contentType, alt: result.alt, hasImage: true } : result);
        },
    }));
}
