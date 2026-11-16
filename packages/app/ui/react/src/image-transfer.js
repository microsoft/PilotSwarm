/** Shared by chat attachments and editors that accept a raster picture. */
export function imageFiles(files) {
    return Array.from(files || []).filter(file => file && typeof file.type === "string" && file.type.startsWith("image/"));
}
export function clipboardImageFiles(data) {
    return Array.from(data?.items || [])
        .filter(item => item.kind === "file" && item.type.startsWith("image/"))
        .map(item => item.getAsFile()).filter(Boolean);
}
export function handleImagePaste(event, stage, { consumeRejected = false, preferText = false } = {}) {
    if (preferText && event.target?.matches?.('textarea, input:not([type]), input[type="text"], input[type="search"]')
        && event.clipboardData?.getData?.("text/plain")) return;
    const files = clipboardImageFiles(event.clipboardData);
    if (!files.length) return;
    const accepted = stage(files);
    if (accepted > 0 || consumeRejected) event.preventDefault();
}
export function hasFileDrag(data) {
    return Array.from(data?.types || []).includes("Files");
}
export function handleImageDrop(event, stage) {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    stage(event.dataTransfer.files);
}
