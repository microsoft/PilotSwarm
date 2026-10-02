import React from "react";
import { useControllerSelector } from "./use-controller-state.js";

// The Workspace tab of the side pane: the session's folders, a file tree, and
// a viewer/editor, for the session's owner. Every call goes through the Web
// API (`listSessionWorkspaceFolders`, `sessionWorkspaceFiles`); the portal
// reads and writes the files on its own mount of the workspace roots.
//
// The editor (CodeMirror) and the markdown preview load on demand, so they
// are not part of the portal's first load.

const h = React.createElement;

const IMAGE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon" };
const MARKDOWN_NAME = /\.(md|markdown|mdx)$/i;
const POLL_MS = 10_000;
// While a turn runs and no folder is open yet: a session's first turn opens
// its folders, so look again sooner than the regular poll.
const OPENING_POLL_MS = 2_000;
const CODES = {
    CONFLICT: "WORKSPACE_FILES_CONFLICT",
    EXISTS: "WORKSPACE_FILES_EXISTS",
    TOO_LARGE: "WORKSPACE_FILES_TOO_LARGE",
    NOT_FOUND: "WORKSPACE_FILES_NOT_FOUND",
    NOT_EMPTY: "WORKSPACE_FILES_NOT_EMPTY",
    READ_ONLY: "WORKSPACE_FILES_READ_ONLY",
    DISABLED: "WORKSPACE_FILES_DISABLED",
    NOT_OPENED: "WORKSPACE_FILES_NOT_OPENED",
    ROOT_UNAVAILABLE: "WORKSPACE_FILES_ROOT_UNAVAILABLE",
    TIMEOUT: "WORKSPACE_FILES_TIMEOUT",
    OUTSIDE: "WORKSPACE_FILES_OUTSIDE",
    BUSY: "WORKSPACE_FILES_BUSY",
};

let editorModule = null;
const loadEditor = () => (editorModule ??= import("./workspace-editor.js"));
let markdownModule = null;
const loadMarkdown = () => (markdownModule ??= import("./workspace-markdown.js"));

// Unsaved edits, per session and file, so switching files or sessions keeps them.
const drafts = new Map();
// They live only in this page: leaving it (a reload, closing the tab) asks first.
if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", (event) => {
        if (drafts.size === 0) return;
        event.preventDefault();
        event.returnValue = "";
    });
}
const draftKey = (sessionId, folderId, path) => `${sessionId}\u0000${folderId}\u0000${path}`;
const dirKey = (folderId, path) => `${folderId}\u0000${path}`;

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * A file's text, or null when its bytes are not UTF-8 (saving them as text
 * would replace every other byte for good). Also what saving must keep: a
 * leading byte-order mark, and CRLF when every line ends in it.
 */
export function readText(bytes) {
    let text;
    try { text = strictDecoder.decode(bytes); } catch { return null; }
    const bom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
    const crlf = text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
    return { text, bom, crlf };
}

/** The bytes to save for a text, with the byte-order mark the file had. */
export function textBytes(text, { bom = false } = {}) {
    const body = encoder.encode(text);
    if (!bom) return body;
    const bytes = new Uint8Array(body.length + 3);
    bytes.set([0xEF, 0xBB, 0xBF]);
    bytes.set(body, 3);
    return bytes;
}

function bytesFromBase64(value) {
    const binary = atob(value || "");
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

/**
 * An address to show image bytes from. An SVG gets a data: address: a blob:
 * address has the portal's origin, so an SVG opened from it in a new tab
 * would run its script as the portal. A data: document has no origin.
 */
export function imageAddress(bytes, type) {
    if (type === "image/svg+xml") return `data:image/svg+xml;base64,${base64FromBytes(bytes)}`;
    return URL.createObjectURL(new Blob([bytes], { type }));
}

function base64FromBytes(bytes) {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
}

function looksBinary(bytes) {
    const end = Math.min(bytes.length, 8000);
    for (let index = 0; index < end; index++) if (bytes[index] === 0) return true;
    return false;
}

// The agent's tool calls, from the session's chat: how many have finished,
// and which files the running editing calls name. One string, so the pane
// re-renders only when it changes.
const FILE_TOOL = /^(edit|create|write|str_replace|str_replace_editor|apply_patch|insert|write_file|create_file|edit_file|multi_edit)$/i;
const RECENT_MS = 60_000;
const activityByChat = new WeakMap();
export function workspaceToolActivity(state, sessionId) {
    const chat = state?.history?.bySessionId?.get?.(sessionId)?.chat;
    if (!Array.isArray(chat)) return "0\u0001";
    // The chat array is replaced when it changes, so one scan per version
    // serves every subscriber and every unrelated state change.
    const cached = activityByChat.get(chat);
    if (cached !== undefined) return cached;
    const value = scanToolActivity(chat);
    activityByChat.set(chat, value);
    return value;
}
function scanToolActivity(chat) {
    let finished = 0;
    const running = [];
    for (const item of chat) {
        if (item?.kind !== "chat-call") continue;
        if (item.status === "Done" || item.status === "Failed") finished++;
        else if (item.status === "Called" && FILE_TOOL.test(String(item.name || ""))) {
            const args = item.arguments && typeof item.arguments === "object" ? item.arguments : {};
            const target = args.path ?? args.file_path ?? args.filePath ?? args.file;
            if (typeof target === "string" && target) running.push(target);
        }
    }
    return `${finished}\u0001${running.join("\u0002")}`;
}

/** Where a path from a tool call is: { folderId, path } in one of the session's folders, or null. */
export function locateToolPath(folders, toolPath) {
    const text = String(toolPath || "");
    if (!text) return null;
    if (!text.startsWith("/")) {
        const working = folders.find((f) => f.role === "working");
        return working ? { folderId: working.id, path: text.replace(/^\.\//, "").replace(/\/+$/, "") } : null;
    }
    let best = null;
    for (const folder of folders) {
        const base = String(folder.base || "").replace(/\/+$/, "");
        if (!base || (text !== base && !text.startsWith(`${base}/`))) continue;
        if (!best || base.length > best.base.length) best = { base, folderId: folder.id };
    }
    return best ? { folderId: best.folderId, path: text.slice(best.base.length + 1) } : null;
}

const joinPath = (dir, name) => (dir ? `${dir}/${name}` : name);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseName = (path) => (path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path);
const extensionOf = (name) => (name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "");
const isMarkdown = (name) => MARKDOWN_NAME.test(name);
const isDirEntry = (entry) => entry.kind === "dir" || (entry.kind === "link" && entry.target === "dir");

export function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A folder zip's count for the toast: "1 file", "3 files", and whether .git was left out. */
export function zipNote(result) {
    const count = Number(result?.files) || 0;
    const skipped = Array.isArray(result?.skipped) && result.skipped.includes(".git") ? "; .git left out" : "";
    return `${count} ${count === 1 ? "file" : "files"}${skipped}`;
}

/** What to tell the person about a failed call. */
export function workspaceErrorText(error) {
    const code = error?.code;
    if (error?.status === 403 && !String(code || "").startsWith("WORKSPACE_FILES")) return "Only the session's owner can see its folders.";
    if (error?.status === 404 && !String(code || "").startsWith("WORKSPACE_FILES")) return "Only the session's owner can see its folders.";
    switch (code) {
        case CODES.READ_ONLY: return error.message && !/^the folder or file is read-only$/.test(error.message) ? `Read-only: ${error.message}.` : "This folder or file is read-only.";
        case CODES.TOO_LARGE: return `Too large: ${error.message}.`;
        case CODES.NOT_FOUND: return "Not found. It may have been moved or deleted.";
        case CODES.EXISTS: return "Something with that name is already there.";
        case CODES.NOT_EMPTY: return "The folder is not empty.";
        case CODES.DISABLED: return "Workspace files are not set up on this portal.";
        case CODES.NOT_OPENED: return "The session's worker has not opened this folder yet.";
        case CODES.ROOT_UNAVAILABLE: return "This portal does not serve this folder.";
        case CODES.TIMEOUT: return "The folder did not answer in time.";
        case CODES.OUTSIDE: return "This points outside the folder, so it cannot be opened here.";
        case CODES.BUSY: return "The portal is busy with other file calls. Try again in a moment.";
        default: return error?.message || String(error || "Something went wrong.");
    }
}

/**
 * Files changed through the portal (this pane or a canvas app): the others
 * refresh now rather than at their next check. `source` is "pane" or "canvas".
 */
export const WORKSPACE_CHANGED_EVENT = "pilotswarm:workspace-files-changed";
export function announceWorkspaceChange(sessionId, source) {
    try {
        window.dispatchEvent(new CustomEvent(WORKSPACE_CHANGED_EVENT, { detail: { sessionId, source } }));
    } catch {
        // No window (tests): nothing listens.
    }
}

/** Saves base64 content as a file on the person's computer. */
export function downloadBase64(contentBase64, filename, type) {
    downloadBytes(bytesFromBase64(contentBase64), filename, type);
}

function downloadBytes(bytes, filename, type = "application/octet-stream") {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function freeName(name, taken) {
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; n < 1000; n++) {
        const candidate = `${stem} (${n})${ext}`;
        if (!taken.has(candidate)) return candidate;
    }
    return `${stem} (${Date.now()})${ext}`;
}

// ─── Glyphs ───────────────────────────────────────────────────────────

function Icon({ d, size = 14, fill = "none" }) {
    return h("svg", { width: size, height: size, viewBox: "0 0 24 24", fill, stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true },
        (Array.isArray(d) ? d : [d]).map((path, index) => h("path", { key: index, d: path })));
}
const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const HOME = "M4 11l8-7 8 7v9H4z";
const SEARCH = ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M20 20l-4-4"];
const CHECKS = ["M4 7l2 2 4-4", "M13 8h7", "M4 15l2 2 4-4", "M13 16h7"];

// Scrolls `container` so `row` shows: "nearest" moves it only as far as
// needed; "center" puts it in the middle (after a jump from elsewhere).
function bringIntoView(container, row, block) {
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (block === "center") container.scrollTop = Math.max(0, top - (container.clientHeight - row.offsetHeight) / 2);
    else if (top < container.scrollTop) container.scrollTop = top;
    else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
}
const PEOPLE = ["M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M3 20c0-3 3-5 6-5s6 2 6 5", "M16 5a3 3 0 0 1 0 6", "M18 15c2 .5 3 2.5 3 5"];
const FILE = ["M6 3h8l4 4v14H6z", "M14 3v4h4"];
const LOCK = ["M6 11h12v10H6z", "M8 11V8a4 4 0 0 1 8 0v3"];
const UPLOAD = ["M12 16V4", "M7 9l5-5 5 5", "M4 20h16"];
const DOWNLOAD = ["M12 4v12", "M7 11l5 5 5-5", "M4 20h16"];
const REFRESH = ["M20 11a8 8 0 1 0-2.3 5.7", "M20 5v6h-6"];
const PLUS_FILE = ["M6 3h8l4 4v14H6z", "M12 11v6", "M9 14h6"];
const PLUS_FOLDER = [FOLDER, "M12 10v6", "M9 13h6"];
const PENCIL = ["M4 20h4L19 9l-4-4L4 16z"];
const TRASH = ["M4 7h16", "M9 7V4h6v3", "M6 7l1 13h10l1-13"];
const BRANCH = ["M6 3v12", "M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M18 9a9 9 0 0 1-9 9"];
const COPY = ["M8 8h12v12H8z", "M16 8V4H4v12h4"];
const PLUS_MINUS = ["M12 3v8", "M8 7h8", "M8 18h8"];
const CLOCK = ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"];
const ARROW_UP = ["M12 19V5", "M5 12l7-7 7 7"];
const ARROW_DOWN = ["M12 5v14", "M19 12l-7 7-7-7"];
const OPEN_FILE = ["M14 3h7v7", "M21 3l-9 9", "M19 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"];
const CLOSE = ["M6 6l12 12", "M18 6L6 18"];
const BACK = ["M15 18l-6-6 6-6"];

// The repository picker's value for "none picked".
const NO_REPO = "\u0000none";
// A second click on a selected folder within this time opens or closes it.
const FOLDER_TOGGLE_MS = 8_000;
// A diff shows side by side only when the viewer is this wide; narrower, inline (as VS Code does).
const DIFF_SPLIT_MIN_WIDTH = 640;
// A file bigger than this is not compared (the git side has the same limit).
const DIFF_MAX_BYTES = 5 * 1024 * 1024;
const DIFF_LAYOUT_KEY = "pilotswarm.workspace.diffLayout";
function readDiffLayout() {
    try { return localStorage.getItem(DIFF_LAYOUT_KEY) === "inline" ? "inline" : "split"; } catch { return "split"; }
}
function saveDiffLayout(value) {
    try { localStorage.setItem(DIFF_LAYOUT_KEY, value); } catch { /* private window: the choice lasts this visit */ }
}

// ─── Git, for a folder that is a repository ───────────────────────────

const GIT_WORDS = { M: "Modified", A: "Added", D: "Deleted", R: "Renamed", U: "Untracked: new, not added to git", C: "Conflict" };
// A folder's dot shows the change inside it that matters most.
const GIT_RANK = { C: 5, D: 4, M: 3, R: 2, A: 1, U: 0 };

// A commit's date and time, 24-hour, as the chat shows times.
let gitDateFormat = null;
export function gitDateTime(seconds) {
    gitDateFormat ??= new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    return gitDateFormat.format(new Date(seconds * 1000));
}
// A folder dot's tooltip: the change inside that matters most.
const GIT_DOT_WORDS = { M: "Changed files inside", A: "Added files inside", D: "A file inside was deleted", R: "A renamed file inside", U: "New files inside", C: "A conflict inside" };

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function gitTimeAgo(seconds, now = Date.now()) {
    const s = Math.max(0, Math.round(now / 1000 - seconds));
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    const days = Math.floor(s / 86400);
    if (days < 30) return days === 1 ? "yesterday" : `${days} days ago`;
    return new Date(seconds * 1000).toLocaleDateString();
}

/**
 * The file tree's git marks, from a git status: the letter of a changed
 * path (a file inside an untracked folder is untracked too), and the dot of
 * a folder with changes inside.
 */
export function gitTreeMarks(files) {
    const letters = new Map();
    const dirs = new Map();
    const untrackedDirs = [];
    for (const f of files || []) {
        letters.set(f.path, f.letter);
        if (f.dir) untrackedDirs.push(`${f.path}/`);
        for (let at = parentOf(f.path); at; at = parentOf(at)) {
            const before = dirs.get(at);
            if (!before || GIT_RANK[f.letter] > GIT_RANK[before]) dirs.set(at, f.letter);
        }
    }
    return {
        letter: (path) => letters.get(path) ?? (untrackedDirs.some((dir) => path.startsWith(dir)) ? "U" : null),
        dir: (path) => dirs.get(path) ?? (letters.get(path) === "U" ? "U" : null),
    };
}

export function FolderGlyph() {
    return h(Icon, { d: FOLDER });
}

// ─── Editor and previews ──────────────────────────────────────────────

function CodeEditor({ docKey, initialText, name, readOnly, onChange, onSave, position, onPosition, onReady, lineSeparator }) {
    const ref = React.useRef(null);
    const handle = React.useRef(null);
    const onChangeRef = React.useRef(onChange);
    const onSaveRef = React.useRef(onSave);
    const onPositionRef = React.useRef(onPosition);
    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onPositionRef.current = onPosition;
    const [failed, setFailed] = React.useState(null);
    React.useEffect(() => {
        let cancelled = false;
        let editor = null;
        loadEditor()
            .then((module) => module.createEditor(ref.current, {
                doc: initialText,
                name,
                readOnly,
                onChange: (text) => onChangeRef.current?.(text),
                onSave: () => onSaveRef.current?.(),
                position,
                onPosition: (where) => onPositionRef.current?.(where),
                lineSeparator,
            }))
            .then((created) => {
                if (cancelled) created.destroy();
                else {
                    editor = created;
                    handle.current = created;
                    onReady?.(created);
                }
            })
            .catch((error) => { if (!cancelled) setFailed(error); });
        return () => {
            cancelled = true;
            editor?.destroy();
            handle.current = null;
            onReady?.(null);
        };
        // One editor per document; docKey changes when the text is replaced.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docKey]);
    React.useEffect(() => { handle.current?.setReadOnly(readOnly); }, [readOnly]);
    if (failed) return h("div", { className: "ps-ws-message" }, `The editor did not load: ${failed.message || failed}`);
    return h("div", { className: "ps-ws-editor", ref });
}

function CompareEditor({ theirs, mine, name, onReady, lineSeparator }) {
    const ref = React.useRef(null);
    React.useEffect(() => {
        let cancelled = false;
        let compare = null;
        loadEditor()
            .then((module) => module.createCompare(ref.current, { theirs, mine, name, lineSeparator }))
            .then((created) => {
                if (cancelled) created.destroy();
                else {
                    compare = created;
                    onReady(created);
                }
            });
        return () => {
            cancelled = true;
            compare?.destroy();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return h("div", { className: "ps-ws-compare", ref });
}

/** A read-only git diff (CodeMirror's merge view), side by side or inline. */
function DiffEditor({ original, modified, name, layout, whole, onReady }) {
    const ref = React.useRef(null);
    const [failed, setFailed] = React.useState(null);
    React.useEffect(() => {
        let cancelled = false;
        let made = null;
        loadEditor()
            .then((module) => module.createDiff(ref.current, { original, modified, name, layout, whole }))
            .then((created) => {
                if (cancelled) created.destroy();
                else {
                    made = created;
                    onReady(created);
                }
            })
            .catch((error) => { if (!cancelled) setFailed(error); });
        return () => {
            cancelled = true;
            made?.destroy();
            onReady(null);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [original, modified, name, layout, whole]);
    if (failed) return h("div", { className: "ps-ws-message" }, `The diff did not load: ${failed.message || failed}`);
    return h("div", { className: "ps-ws-compare ps-ws-diff", ref });
}

/** A path relative to a file's folder, or null when it leaves the folder or is an address. */
export function resolveRelativePath(dir, src) {
    const raw = String(src || "").split(/[?#]/)[0];
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) return null;
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return null; }
    const parts = decoded.startsWith("/") ? [] : (dir ? dir.split("/") : []);
    for (const segment of decoded.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") {
            if (parts.length === 0) return null;
            parts.pop();
        } else parts.push(segment);
    }
    return parts.length ? parts.join("/") : null;
}

// Preview holds back every image until the person asks: an image from the
// internet tells that site who is looking, and one from a file is a read.
function MarkdownPreview({ text, resolveImage, onOpenLink, scrollTop = 0, onScrollTop }) {
    const [module, setModule] = React.useState(null);
    const boxRef = React.useRef(null);
    const restoredRef = React.useRef(false);
    const scrollTimer = React.useRef(null);
    const [show, setShow] = React.useState(false);
    const [images, setImages] = React.useState(null);
    React.useEffect(() => {
        let cancelled = false;
        loadMarkdown().then((loaded) => { if (!cancelled) setModule(loaded); });
        return () => { cancelled = true; };
    }, []);
    const held = React.useMemo(() => (module ? module.renderMarkdown(text) : null), [module, text]);
    React.useEffect(() => {
        if (!show || !module || !held) return undefined;
        let cancelled = false;
        const made = [];
        (async () => {
            const map = {};
            for (const src of new Set(held.blocked)) {
                if (module.isRemoteAddress(src)) {
                    map[src] = src;
                    continue;
                }
                try {
                    const url = await resolveImage(src);
                    if (url && cancelled) URL.revokeObjectURL(url);
                    else if (url) {
                        made.push(url);
                        map[src] = url;
                    }
                } catch {
                    // Missing or not an image: it stays a placeholder.
                }
            }
            if (!cancelled) setImages(map);
        })();
        return () => {
            cancelled = true;
            made.forEach((url) => URL.revokeObjectURL(url));
            setImages(null);
        };
    }, [show, module, held, resolveImage]);
    // Back where the person was, once the page is there to scroll.
    React.useLayoutEffect(() => {
        if (!held || restoredRef.current || !boxRef.current) return;
        restoredRef.current = true;
        if (scrollTop > 0) boxRef.current.scrollTop = scrollTop;
    }, [held, scrollTop]);
    React.useEffect(() => () => clearTimeout(scrollTimer.current), []);
    if (!held) return h("div", { className: "ps-ws-message" }, "Rendering…");
    const rendered = show && images ? module.renderMarkdown(text, { images }) : held;
    const count = held.blocked.length;
    return h("div", {
        className: "ps-ws-md-preview",
        ref: boxRef,
        onScroll: (event) => {
            const top = event.currentTarget.scrollTop;
            clearTimeout(scrollTimer.current);
            scrollTimer.current = setTimeout(() => onScrollTop?.(top), 250);
        },
    },
        count > 0 ? h("div", { className: "ps-ws-md-images", role: "status" },
            show
                ? h("span", null, images ? "Showing images." : "Loading images…")
                : h("span", null, `${count} image${count === 1 ? " is" : "s are"} not shown. Images can come from the internet or from other files.`),
            h("button", { type: "button", className: "ps-ws-btn", onClick: () => setShow((value) => !value) }, show ? "Hide images" : "Show images")) : null,
        rendered.frontMatter ? h("pre", { className: "ps-ws-frontmatter", title: "Front matter" }, rendered.frontMatter) : null,
        h("div", {
            className: "ps-ws-md-body",
            dangerouslySetInnerHTML: { __html: rendered.html },
            // "#heading" scrolls here; a link to another file opens it in the pane.
            onClick: (event) => {
                const any = event.target instanceof Element ? event.target.closest("a[href], area[href]") : null;
                // Only a web link (a new tab) may leave; nothing moves the portal itself.
                if (any && any.getAttribute("target") !== "_blank") event.preventDefault();
                const link = event.target instanceof Element ? event.target.closest("a[data-ws-anchor], a[data-ws-path]") : null;
                if (!link) return;
                event.preventDefault();
                const anchor = link.getAttribute("data-ws-anchor");
                if (anchor === null) {
                    onOpenLink?.(link.getAttribute("data-ws-path"));
                    return;
                }
                let name = anchor;
                try { name = decodeURIComponent(anchor); } catch { /* as written */ }
                const heading = Array.from(event.currentTarget.querySelectorAll("[id]")).find((el) => el.id === `user-content-${name}`);
                heading?.scrollIntoView({ block: "start" });
            },
        }));
}

// ─── The view, remembered per session in this browser ─────────────────
// Per session: the folder shown and the folders opened in the tree. Per
// folder: the file open in it, Edit or Preview, and how far the tree was
// scrolled. Per file (the latest 30): where the person was in it. Coming
// back to a session, or to a folder, shows them again; a file that is no
// longer there leaves that folder with no file open. The latest 100
// sessions are kept.

const VIEWS_KEY = "pilotswarm.workspace.views";
const VIEWS_KEPT = 100;
const POSITIONS_KEPT = 30;

function readViews() {
    try {
        const all = JSON.parse(window.localStorage.getItem(VIEWS_KEY) || "{}");
        return all && typeof all === "object" && !Array.isArray(all) ? all : {};
    } catch {
        return {};
    }
}

/** One session's remembered view: { folderId, expanded, folders, positions }, or null. */
export function readWorkspaceView(sessionId) {
    const saved = readViews()[sessionId];
    if (!saved || typeof saved !== "object") return null;
    const folders = saved.folders && typeof saved.folders === "object" && !Array.isArray(saved.folders) ? { ...saved.folders } : {};
    // The first saves kept one file for the whole session.
    if (saved.file && typeof saved.file === "object" && typeof saved.file.folderId === "string" && !folders[saved.file.folderId]) {
        folders[saved.file.folderId] = { file: saved.file.path, mdMode: saved.mdMode };
    }
    return {
        folderId: typeof saved.folderId === "string" ? saved.folderId : null,
        expanded: Array.isArray(saved.expanded) ? saved.expanded.filter((key) => typeof key === "string") : [],
        folders,
        positions: saved.positions && typeof saved.positions === "object" && !Array.isArray(saved.positions) ? saved.positions : {},
    };
}

/** Changes one session's view: `change(previous)` returns the new one. */
function saveWorkspaceView(sessionId, change) {
    try {
        const all = readViews();
        const previous = readWorkspaceView(sessionId) ?? { folderId: null, expanded: [], folders: {}, positions: {} };
        const next = change(previous);
        const positions = Object.entries(next.positions || {})
            .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
            .slice(0, POSITIONS_KEPT);
        all[sessionId] = {
            folderId: next.folderId ?? null,
            expanded: (next.expanded || []).slice(0, 60),
            folders: next.folders || {},
            positions: Object.fromEntries(positions),
            at: Date.now(),
        };
        const kept = Object.entries(all).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, VIEWS_KEPT);
        window.localStorage.setItem(VIEWS_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
        // Private windows and blocked storage: the view lasts until reload.
    }
}

// ─── The divider between the file list and the viewer ─────────────────
// Drag it, or focus it and use the arrow keys; double-click puts it back.
// The size is kept per browser. On a narrow screen the list sits above the
// viewer, so the divider moves up and down.

const SPLIT_KEY = "pilotswarm.workspace.split";
const STACKED_QUERY = "(max-width: 720px)";

function readSplit() {
    try {
        const saved = JSON.parse(window.localStorage.getItem(SPLIT_KEY) || "null");
        return {
            width: Number.isFinite(saved?.width) ? saved.width : null,
            height: Number.isFinite(saved?.height) ? saved.height : null,
        };
    } catch {
        return { width: null, height: null };
    }
}

function saveSplit(split) {
    try {
        window.localStorage.setItem(SPLIT_KEY, JSON.stringify(split));
    } catch {
        // Private windows and blocked storage: the size lasts until reload.
    }
}

function useStacked() {
    const query = typeof window !== "undefined" && window.matchMedia ? window.matchMedia(STACKED_QUERY) : null;
    const [stacked, setStacked] = React.useState(() => Boolean(query?.matches));
    React.useEffect(() => {
        if (!query) return undefined;
        const onChange = () => setStacked(query.matches);
        query.addEventListener?.("change", onChange);
        onChange();
        return () => query.removeEventListener?.("change", onChange);
    }, []);
    return stacked;
}

function Splitter({ mainRef, split, stacked, onChange }) {
    const [dragging, setDragging] = React.useState(false);
    const property = stacked ? "--ps-ws-tree-height" : "--ps-ws-tree-width";
    const key = stacked ? "height" : "width";
    const limits = () => {
        const main = mainRef.current;
        const total = (stacked ? main?.clientHeight : main?.clientWidth) || 0;
        const min = stacked ? 80 : 120;
        return { min, max: Math.max(min, total - (stacked ? 120 : 200)) };
    };
    const current = () => {
        const side = mainRef.current?.querySelector(".ps-ws-side");
        return (stacked ? side?.offsetHeight : side?.offsetWidth) || 0;
    };
    // The size for screen readers (a focusable separator must say it).
    const [now, setNow] = React.useState(null);
    const measure = (size = current()) => setNow({ value: Math.round(size), ...limits() });
    React.useLayoutEffect(() => { measure(); }, [split, stacked]); // eslint-disable-line react-hooks/exhaustive-deps
    const show = (size) => {
        mainRef.current?.style.setProperty(property, `${Math.round(size)}px`);
        measure(size);
    };
    const keep = (size) => onChange({ ...split, [key]: Math.round(size) });

    const onPointerDown = (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        const start = stacked ? event.clientY : event.clientX;
        const from = current();
        const { min, max } = limits();
        let size = from;
        handle.setPointerCapture?.(event.pointerId);
        setDragging(true);
        const move = (e) => {
            size = Math.min(max, Math.max(min, from + (stacked ? e.clientY : e.clientX) - start));
            show(size);
        };
        const end = () => {
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", end);
            handle.removeEventListener("pointercancel", end);
            setDragging(false);
            if (size !== from) keep(size);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", end);
        handle.addEventListener("pointercancel", end);
    };
    const onKeyDown = (event) => {
        const { min, max } = limits();
        let size = current();
        if (event.key === (stacked ? "ArrowUp" : "ArrowLeft")) size -= 24;
        else if (event.key === (stacked ? "ArrowDown" : "ArrowRight")) size += 24;
        else if (event.key === "Home") size = min;
        else if (event.key === "End") size = max;
        else return;
        event.preventDefault();
        size = Math.min(max, Math.max(min, size));
        show(size);
        keep(size);
    };
    const onDoubleClick = () => {
        mainRef.current?.style.removeProperty(property);
        onChange({ ...split, [key]: null });
    };
    return h("div", {
        className: `ps-ws-splitter${dragging ? " is-dragging" : ""}`,
        role: "separator",
        tabIndex: 0,
        "aria-orientation": stacked ? "horizontal" : "vertical",
        "aria-label": "Resize the file list",
        ...(now ? { "aria-valuenow": now.value, "aria-valuemin": now.min, "aria-valuemax": now.max, "aria-valuetext": `${now.value} pixels` } : {}),
        title: "Drag to resize. Double-click to reset.",
        onPointerDown,
        onKeyDown,
        onDoubleClick,
    });
}

// ─── The pane ─────────────────────────────────────────────────────────

export function WorkspacePane({ controller, sessionId, visible = true }) {
    const transport = controller?.transport;
    const supported = typeof transport?.sessionWorkspaceFiles === "function" && typeof transport?.listSessionWorkspaceFolders === "function";
    const [info, setInfo] = React.useState(null);
    const editorHandle = React.useRef(null);
    const [infoError, setInfoError] = React.useState(null);
    const [folderId, setFolderId] = React.useState(null);
    const [dirs, setDirs] = React.useState({});
    const [expanded, setExpanded] = React.useState(() => new Set());
    const [file, setFile] = React.useState(null);
    const [mdMode, setMdMode] = React.useState("edit");
    const [notice, setNotice] = React.useState(null);
    const [dialog, setDialog] = React.useState(null);
    const [compare, setCompare] = React.useState(null);
    const [inline, setInline] = React.useState(null);
    const [dropTarget, setDropTarget] = React.useState(null);
    const [busy, setBusy] = React.useState(0);
    const uploadInput = React.useRef(null);
    const uploadDir = React.useRef("");
    const fileRef = React.useRef(file);
    fileRef.current = file;
    const compareHandle = React.useRef(null);
    const mainRef = React.useRef(null);
    // The saved view, until it is applied to this session; then the session
    // whose view changes are saved.
    const restoring = React.useRef(null);
    const restoredFor = React.useRef(null);
    const treeRef = React.useRef(null);
    // The tree has one tab stop (the row last focused, else the open file's,
    // else the first); the arrow keys move between rows.
    const [focusKey, setFocusKey] = React.useState(null);
    // A row to give focus back to once it shows (after a rename or a new name).
    const refocus = React.useRef(null);
    const idBase = React.useId();
    const focusDialog = React.useCallback((el) => {
        if (el) (el.querySelector("button.is-primary") || el.querySelector("button"))?.focus();
    }, []);
    // Give focus back to a row once it shows (after a rename, a new name, Escape).
    React.useLayoutEffect(() => {
        const key = refocus.current;
        if (!key) return;
        // Never take focus from where the person went since (the chat, say).
        const active = document.activeElement;
        if (active && active !== document.body && !mainRef.current?.closest(".ps-ws-pane")?.contains(active)) {
            refocus.current = null;
            return;
        }
        const el = treeRef.current?.querySelector(`[data-key="${encodeURIComponent(key)}"]`);
        if (el) {
            refocus.current = null;
            el.focus();
        }
    });
    // The tree's remembered scroll, applied once its folders are listed.
    const pendingTreeTop = React.useRef(null);
    // A row to bring into view after the next render: { key, block }.
    const scrollTarget = React.useRef(null);
    // Where the person was in each file: dirKey -> { line, cursor, top, at }.
    const positions = React.useRef({});
    // The latest file asked for; a slower, older answer is dropped.
    const openToken = React.useRef(0);
    const savingRef = React.useRef(false);
    // Rows picked for a multiple action (Cmd/Ctrl-click, Shift-click, Select).
    const [picked, setPicked] = React.useState(() => new Set());
    const pickAnchor = React.useRef(null);
    // The folder clicked last, and when: a second click on it soon after opens
    // or closes it (a first click only selects).
    const lastFolderClick = React.useRef(null);
    const visibleRows = React.useRef([]);
    const [selectMode, setSelectMode] = React.useState(false);
    const previousDialog = React.useRef(null);
    const [findText, setFindText] = React.useState("");
    const [found, setFound] = React.useState(null);
    const [foundIndex, setFoundIndex] = React.useState(0);
    const [split, setSplit] = React.useState(readSplit);
    const stacked = useStacked();
    const changeSplit = React.useCallback((next) => {
        setSplit(next);
        saveSplit(next);
    }, []);

    // The agent's tool calls: which files it is editing now, and a count of
    // finished calls (each one refreshes the tree and the open file).
    const selectActivity = React.useCallback((state) => workspaceToolActivity(state, sessionId), [sessionId]);
    const activity = useControllerSelector(controller, selectActivity);
    const [finishedText, runningText] = String(activity || "0\u0001").split("\u0001");
    const finishedCalls = Number(finishedText) || 0;
    const selectRunning = React.useCallback((state) => state.sessions?.byId?.[sessionId]?.status === "running", [sessionId]);
    const turnRunning = useControllerSelector(controller, selectRunning);
    // Files changed on disk by someone else (the agent, a shell, another
    // session) in the last minute, and the ones this pane changed itself.
    const [recent, setRecent] = React.useState({});
    const mine = React.useRef(new Map());
    const markMine = React.useCallback((fid, path) => {
        const now = Date.now();
        let at = String(path || "");
        for (;;) {
            mine.current.set(dirKey(fid, at), now);
            if (!at) break;
            at = parentOf(at);
        }
    }, []);
    const dirsRef = React.useRef({});

    const call = React.useCallback(async (request) => {
        const result = await transport.sessionWorkspaceFiles(sessionId, request);
        if (["write", "mkdir", "move", "delete"].includes(request?.op)
            || (request?.op === "git" && (request.what === "checkout" || request.what === "restore"))) announceWorkspaceChange(sessionId, "pane");
        return result;
    }, [transport, sessionId]);

    // Git, for a folder that is a repository (info.git: this portal runs
    // git). The side column then shows Files, Changes or History.
    const [sideTab, setSideTab] = React.useState("files");
    // What Changes compares the files with: null (the last commit), "main", or a commit id.
    const [gitSince, setGitSince] = React.useState(null);
    const [gitStatus, setGitStatus] = React.useState(null);
    // History and the picked commit, per folder: going to another folder and
    // back keeps them.
    const [gitLogs, setGitLogs] = React.useState({});
    const [gitCommits, setGitCommits] = React.useState({});
    // "Changes" can also show one commit ("commit:<sha>") or two commits
    // compared ("range:<from>..<to>"): the list, from git show / compare.
    const [gitCompare, setGitCompare] = React.useState(null);
    // Commits picked in History to compare (Ctrl/Cmd- or Shift-click), per repository.
    const [gitPicks, setGitPicks] = React.useState({});
    const gitSinceRef = React.useRef(gitSince);
    // The status itself always compares with HEAD in those two views.
    gitSinceRef.current = typeof gitSince === "string" && /^(commit|range):/.test(gitSince) ? null : gitSince;
    const gitOnRef = React.useRef(false);
    // The repositories in each folder: the folder itself ("") and folders
    // inside it that hold .git (a clone in the person's own folder):
    // { [folderId]: { top, repos } }. And the one git shows, per folder.
    const [gitRepos, setGitRepos] = React.useState({});
    const [gitRepoOf, setGitRepoOf] = React.useState({});
    const gitRepoRef = React.useRef(null);
    const loadGitRepos = React.useCallback(async (fid) => {
        try {
            const result = await call({ op: "git", folder: fid, what: "repos" });
            setGitRepos((latest) => ({ ...latest, [fid]: { top: result.top === true, repos: Array.isArray(result.repos) ? result.repos : [] } }));
        } catch {
            setGitRepos((latest) => ({ ...latest, [fid]: { top: false, repos: [], failed: true } }));
        }
    }, [call]);
    const loadGitStatus = React.useCallback(async (fid, since, repo = "") => {
        try {
            const result = await call({ op: "git", folder: fid, what: "status", ...(repo ? { repo } : {}), ...(since ? { since } : {}) });
            setGitStatus({ folderId: fid, repo, since: since ?? null, result });
            // The open diff's file left its group (it was committed, staged,
            // unstaged or reverted): close it rather than show a wrong diff.
            const open = diffRef.current;
            if (open && open.folderId === fid && (open.repo ?? "") === repo && open.source !== "history" && open.group && open.group !== "commit" && open.group !== "range" && result?.repo) {
                const f = (result.files || []).find((one) => one.path === open.path);
                const still = open.group === "since" ? Boolean(f) && (result.since?.sha ?? null) === open.sinceSha
                    : open.group === "Staged" ? Boolean(f?.staged) : Boolean(f?.unstaged);
                if (!still) {
                    diffToken.current += 1;
                    setDiff(null);
                }
            }
        } catch (error) {
            setGitStatus((previous) => (previous?.folderId === fid && previous.repo === repo ? { ...previous, error } : { folderId: fid, repo, since: since ?? null, result: null, error }));
        }
    }, [call]);

    // A diff in the viewer, as in VS Code: two sides of one file, each
    // { rev: "HEAD" | "INDEX" | a commit | "WORKTREE", path, label }, or null
    // for the side where the file does not exist (added, deleted).
    const [diff, setDiff] = React.useState(null);
    const diffRef = React.useRef(diff);
    diffRef.current = diff;
    const diffToken = React.useRef(0);
    const diffHandle = React.useRef(null);
    const [diffLayout, setDiffLayout] = React.useState(readDiffLayout);
    const chooseDiffLayout = React.useCallback((value) => {
        setDiffLayout(value);
        saveDiffLayout(value);
    }, []);
    const closeDiff = React.useCallback(() => {
        diffToken.current += 1;
        setDiff(null);
    }, []);
    const [viewerWidth, setViewerWidth] = React.useState(0);
    const viewerObserver = React.useRef(null);
    const viewerRef = React.useCallback((element) => {
        viewerObserver.current?.disconnect();
        viewerObserver.current = null;
        if (!element || typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(([entry]) => setViewerWidth(Math.round(entry.contentRect.width)));
        observer.observe(element);
        viewerObserver.current = observer;
    }, []);
    const loadDiffSide = React.useCallback(async (fid, side, repo = "") => {
        if (!side) return { text: "" };
        if (side.rev === "WORKTREE") {
            try {
                const result = await call({ op: "read", folder: fid, path: repo ? `${repo}/${side.path}` : side.path });
                if (Number(result.size) > DIFF_MAX_BYTES) return { tooLarge: true };
                const bytes = bytesFromBase64(result.contentBase64);
                const read = looksBinary(bytes) ? null : readText(bytes);
                return read ? { text: read.text } : { binary: true };
            } catch (error) {
                if (error?.code === CODES.NOT_FOUND) return { text: "" };
                if (error?.code === CODES.TOO_LARGE) return { tooLarge: true };
                throw error;
            }
        }
        const result = await call({ op: "git", folder: fid, what: "file", ...(repo ? { repo } : {}), rev: side.rev, path: side.path });
        if (result.available === false) throw new Error(result.reason || "git does not run in this folder");
        if (!result.exists) return { text: "" };
        if (result.binary) return { binary: true };
        if (result.tooLarge) return { tooLarge: true };
        return { text: result.text ?? "" };
    }, [call]);
    // `quiet`: the same diff again (a check found the file changed): no
    // "Loading", and nothing redraws when neither side changed.
    const openDiff = React.useCallback(async (spec, { quiet = false } = {}) => {
        const token = ++diffToken.current;
        if (!quiet) setDiff({ ...spec, loading: true });
        try {
            const [before, after] = await Promise.all([loadDiffSide(spec.folderId, spec.left, spec.repo), loadDiffSide(spec.folderId, spec.right, spec.repo)]);
            if (token !== diffToken.current) return;
            setDiff((latest) => {
                if (quiet && (latest?.key !== spec.key || (latest.original?.text === before.text && latest.modified?.text === after.text))) return latest;
                return { ...spec, loading: false, error: null, original: before, modified: after };
            });
        } catch (error) {
            if (token !== diffToken.current || quiet) return;
            setDiff({ ...spec, loading: false, error });
        }
    }, [loadDiffSide]);
    const say = React.useCallback((text, kind = "info") => setNotice({ text, kind, at: Date.now() }), []);
    const fail = React.useCallback((error) => say(workspaceErrorText(error), "error"), [say]);
    const track = React.useCallback(async (promise) => {
        setBusy((n) => n + 1);
        try { return await promise; } finally { setBusy((n) => n - 1); }
    }, []);

    React.useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), notice.kind === "error" ? 8000 : 3500);
        return () => clearTimeout(timer);
    }, [notice]);

    const folders = info?.folders ?? [];
    const folder = folders.find((candidate) => candidate.id === folderId) ?? null;
    const gitOn = Boolean(info?.git && folder?.available);
    gitOnRef.current = gitOn;

    // The working folder keeps its id when the session moves it to another
    // place (Set workspace). Then everything shown for the old place goes:
    // its listings, git state, open diff and open file.
    const folderPlace = folder ? `${folder.root}\u0000${folder.folder ?? ""}` : null;
    const places = React.useRef(new Map());
    React.useEffect(() => {
        if (!folderId || folderPlace === null) return;
        const before = places.current.get(folderId);
        places.current.set(folderId, folderPlace);
        if (before === undefined || before === folderPlace) return;
        const prefix = `${folderId}\u0000`;
        const keep = (map) => Object.fromEntries(Object.entries(map).filter(([key]) => !key.startsWith(prefix)));
        const without = (map) => Object.fromEntries(Object.entries(map).filter(([key]) => key !== folderId));
        setGitSince(null);
        setGitStatus(null);
        setGitLogs(keep);
        setGitCommits(keep);
        setGitPicks(keep);
        setGitCompare(null);
        setGitRepos(without);
        setGitRepoOf(without);
        closeDiff();
        setDirs(keep);
        setRecent(keep);
        setExpanded((previous) => new Set([...previous].filter((key) => !key.startsWith(prefix))));
        if (fileRef.current?.folderId === folderId) {
            openToken.current += 1;
            setCompare(null);
            setFile(null);
        }
    }, [folderId, folderPlace, closeDiff]);

    // The session's folders: at first sight of the session, then on each poll.
    const loadFolders = React.useCallback(async ({ quiet = false } = {}) => {
        if (!supported || !sessionId) return;
        try {
            const result = await transport.listSessionWorkspaceFolders(sessionId);
            const saved = restoring.current?.sessionId === sessionId ? restoring.current.view : null;
            setInfo(result);
            setInfoError(null);
            setFolderId((current) => {
                if (result.folders.some((f) => f.id === current)) return current;
                const remembered = saved?.folderId ? result.folders.find((f) => f.id === saved.folderId && f.available) : null;
                return remembered?.id ?? (result.folders.find((f) => f.available) ?? result.folders[0])?.id ?? null;
            });
        } catch (error) {
            if (!quiet) setInfoError(error);
        }
    }, [supported, transport, sessionId]);

    const loadDir = React.useCallback(async (fid, path) => {
        const key = dirKey(fid, path);
        setDirs((previous) => ({ ...previous, [key]: { ...(previous[key] || {}), loading: true } }));
        try {
            const result = await call({ op: "list", folder: fid, path });
            // Changed since the last listing, and not by this pane: mark it.
            const before = dirsRef.current[key]?.entries;
            if (before) {
                const times = new Map(before.map((entry) => [entry.name, entry.mtimeMs]));
                const now = Date.now();
                const changed = {};
                for (const entry of result.entries) {
                    if (times.get(entry.name) === entry.mtimeMs) continue;
                    const entryKey = dirKey(fid, joinPath(path, entry.name));
                    if (now - (mine.current.get(entryKey) ?? 0) < RECENT_MS) continue;
                    changed[entryKey] = now;
                }
                if (Object.keys(changed).length) setRecent((previous) => ({ ...previous, ...changed }));
            }
            setDirs((previous) => ({ ...previous, [key]: { entries: result.entries, truncated: result.truncated, readOnly: result.readOnly, loading: false } }));
            return result;
        } catch (error) {
            setDirs((previous) => ({ ...previous, [key]: { ...(previous[key] || {}), loading: false, error } }));
            return null;
        }
    }, [call]);

    const [loadedSession, setLoadedSession] = React.useState(null);
    React.useEffect(() => {
        if (!visible || !sessionId || loadedSession === sessionId) return;
        setLoadedSession(sessionId);
        const view = readWorkspaceView(sessionId);
        restoring.current = { sessionId, view };
        restoredFor.current = null;
        positions.current = { ...(view?.positions ?? {}) };
        setInfo(null);
        setDirs({});
        setExpanded(new Set());
        setFile(null);
        setCompare(null);
        setDialog(null);
        setFindText("");
        setFound(null);
        setPicked(new Set());
        setSelectMode(false);
        setSideTab("files");
        setGitSince(null);
        setGitStatus(null);
        setGitLogs({});
        setGitCommits({});
        setGitRepos({});
        setGitRepoOf({});
        closeDiff();
        setMdMode(view?.folders?.[view?.folderId]?.mdMode === "preview" ? "preview" : "edit");
        loadFolders();
    }, [visible, sessionId, loadedSession, loadFolders]);

    React.useEffect(() => {
        if (folderId && !dirs[dirKey(folderId, "")]) loadDir(folderId, "");
    }, [folderId, dirs, loadDir]);
    dirsRef.current = dirs;

    // ── Opening a file ──
    const openFile = React.useCallback(async (fid, path, { remembered = false } = {}) => {
        const name = baseName(path);
        const token = ++openToken.current;
        closeDiff();
        setCompare(null);
        setDialog(null);
        setFile({ folderId: fid, path, name, kind: "loading" });
        try {
            const result = await call({ op: "read", folder: fid, path });
            if (token !== openToken.current) return;
            const bytes = bytesFromBase64(result.contentBase64);
            const imageType = IMAGE_TYPES[extensionOf(name)];
            if (imageType) {
                setFile({ folderId: fid, path, name, kind: "image", url: imageAddress(bytes, imageType), size: result.size, bytes, etag: result.etag, readOnly: result.readOnly });
                return;
            }
            const read = looksBinary(bytes) ? null : readText(bytes);
            if (!read) {
                setFile({ folderId: fid, path, name, kind: "binary", notText: !looksBinary(bytes), size: result.size, bytes, etag: result.etag, readOnly: result.readOnly });
                return;
            }
            const text = read.text;
            const draft = drafts.get(draftKey(sessionId, fid, path));
            setFile({
                folderId: fid, path, name, kind: "text", size: result.size, readOnly: result.readOnly,
                bom: read.bom,
                crlf: read.crlf,
                etag: draft ? draft.baseEtag : result.etag,
                diskEtag: result.etag,
                baseText: draft ? draft.baseText : text,
                text: draft ? draft.text : text,
                dirty: Boolean(draft),
                changedOnDisk: Boolean(draft) && draft.baseEtag !== result.etag,
                docKey: `${fid}:${path}:${Date.now()}`,
            });
        } catch (error) {
            if (token !== openToken.current) return;
            if (remembered && error?.code === CODES.NOT_FOUND) setFile(null);
            else if (error?.code === CODES.TOO_LARGE) setFile({ folderId: fid, path, name, kind: "toolarge", size: error.size });
            else setFile({ folderId: fid, path, name, kind: "error", error });
        }
    }, [call, sessionId, closeDiff]);

    // An image's object URL lives exactly as long as it is the one shown.
    const fileUrl = file?.url;
    React.useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);

    // Where the person is in the open file, kept for when they come back.
    const rememberPosition = React.useCallback((fid, path, where) => {
        const key = dirKey(fid, path);
        positions.current = { ...positions.current, [key]: { ...(positions.current[key] || {}), ...where, at: Date.now() } };
        const snapshot = positions.current;
        saveWorkspaceView(sessionId, (previous) => ({ ...previous, positions: snapshot }));
    }, [sessionId]);

    // The rest of the saved view, once the session's folders are known.
    React.useEffect(() => {
        const pending = restoring.current;
        if (!info || !pending || pending.sessionId !== sessionId || !folderId) return;
        restoring.current = null;
        const view = pending.view;
        const served = new Set((info.folders || []).filter((f) => f.available).map((f) => f.id));
        const open = (view?.expanded ?? []).filter((key) => served.has(key.slice(0, key.indexOf("\u0000"))));
        if (open.length) {
            setExpanded(new Set(open));
            for (const key of open) {
                const at = key.indexOf("\u0000");
                loadDir(key.slice(0, at), key.slice(at + 1));
            }
        }
        const entry = view?.folders?.[folderId];
        if (entry && typeof entry.file === "string" && served.has(folderId)) openFile(folderId, entry.file, { remembered: true });
        setMdMode(entry?.mdMode === "preview" ? "preview" : "edit");
        pendingTreeTop.current = { folderId, top: Number(entry?.treeTop) || 0 };
        restoredFor.current = sessionId;
    }, [info, sessionId, folderId, loadDir, openFile]);

    // Save the view as it changes (not before the saved one is applied).
    React.useEffect(() => {
        if (!sessionId || !folderId || restoredFor.current !== sessionId) return;
        saveWorkspaceView(sessionId, (previous) => {
            const before = previous.folders[folderId] || {};
            // A file that failed to open for another reason (the folder did
            // not answer, say) is kept for the next visit. A file of another
            // folder (a switch in progress) changes nothing here.
            const open = !file ? null
                : file.folderId !== folderId || file.kind === "error" ? before.file ?? null
                : file.path;
            return {
                ...previous,
                folderId,
                expanded: [...expanded],
                folders: { ...previous.folders, [folderId]: { ...before, file: open, mdMode } },
            };
        });
    }, [sessionId, folderId, file?.folderId, file?.path, file?.kind, mdMode, expanded]);

    // The tree's scroll, per folder, a moment after it stops.
    const treeScrollTimer = React.useRef(null);
    const onTreeScroll = React.useCallback((event) => {
        const top = event.currentTarget.scrollTop;
        const fid = folderId;
        if (!fid || pendingTreeTop.current) return;
        clearTimeout(treeScrollTimer.current);
        treeScrollTimer.current = setTimeout(() => {
            saveWorkspaceView(sessionId, (previous) => ({
                ...previous,
                folders: { ...previous.folders, [fid]: { ...(previous.folders[fid] || {}), treeTop: Math.round(top) } },
            }));
        }, 300);
    }, [sessionId, folderId]);
    React.useEffect(() => () => clearTimeout(treeScrollTimer.current), []);

    // Another folder chip: this folder's view is kept, that one's comes back.
    const switchFolder = React.useCallback((nextId) => {
        if (nextId === folderId) return;
        const view = readWorkspaceView(sessionId);
        const entry = view?.folders?.[nextId] ?? null;
        setFolderId(nextId);
        setPicked(new Set());
        setFindText("");
        setFound(null);
        setInline(null);
        setGitSince(null);
        setGitStatus(null);
        closeDiff();
        pendingTreeTop.current = { folderId: nextId, top: Number(entry?.treeTop) || 0 };
        setMdMode(entry?.mdMode === "preview" ? "preview" : "edit");
        if (entry && typeof entry.file === "string") openFile(nextId, entry.file, { remembered: true });
        else {
            openToken.current += 1;
            setCompare(null);
            setFile(null);
        }
    }, [folderId, sessionId, openFile]);

    const onEdit = React.useCallback((text) => {
        setFile((current) => {
            if (!current || current.kind !== "text") return current;
            const dirty = text !== current.baseText;
            const key = draftKey(sessionId, current.folderId, current.path);
            if (dirty) drafts.set(key, { text, baseText: current.baseText, baseEtag: current.etag });
            else drafts.delete(key);
            return { ...current, text, dirty };
        });
    }, [sessionId]);

    // An image a markdown file points to, from the same folder, as a blob URL.
    const resolveImage = React.useCallback(async (src) => {
        const current = fileRef.current;
        if (!current) return null;
        const target = resolveRelativePath(parentOf(current.path), src);
        const type = target ? IMAGE_TYPES[extensionOf(target)] : null;
        if (!type) return null;
        const result = await call({ op: "read", folder: current.folderId, path: target });
        return imageAddress(bytesFromBase64(result.contentBase64), type);
    }, [call]);

    // ── Saving ──
    // `replace`: the saved text replaces what the editor shows (Keep both,
    // Compare). Otherwise the editor keeps what the person typed while the
    // save was on its way, and that part stays unsaved.
    const writeText = React.useCallback(async (target, text, ifMatch, { replace = false } = {}) => {
        markMine(target.folderId, target.path);
        const result = await call({ op: "write", folder: target.folderId, path: target.path, contentBase64: base64FromBytes(textBytes(text, { bom: target.bom })), ifMatch });
        const key = draftKey(sessionId, target.folderId, target.path);
        const now = fileRef.current;
        const same = now && now.folderId === target.folderId && now.path === target.path;
        // What the person typed while the save was on its way stays unsaved:
        // in the open file, or in its draft if they opened another file.
        const later = same ? now.text : drafts.get(key)?.text;
        if (!replace && typeof later === "string" && later !== text) drafts.set(key, { text: later, baseText: text, baseEtag: result.etag });
        else drafts.delete(key);
        setFile((current) => {
            if (!current || current.folderId !== target.folderId || current.path !== target.path) return current;
            const saved = { etag: result.etag, diskEtag: result.etag, changedOnDisk: false, size: result.size };
            if (replace) return { ...current, ...saved, text, baseText: text, dirty: false, docKey: current.text === text ? current.docKey : `${current.docKey}+` };
            return { ...current, ...saved, baseText: text, dirty: current.text !== text };
        });
        loadDir(target.folderId, parentOf(target.path));
        return result;
    }, [call, sessionId, loadDir, markMine]);

    const save = React.useCallback(async () => {
        const current = fileRef.current;
        if (!current || current.kind !== "text" || current.readOnly || !current.dirty) return;
        // One save at a time: a second Cmd+S would send the same version tag
        // and come back as a conflict with the person's own text.
        if (savingRef.current) return;
        savingRef.current = true;
        try {
            await track(writeText(current, current.text, current.etag));
            say(`Saved ${current.name}`);
        } catch (error) {
            if (error?.code !== CODES.CONFLICT) {
                fail(error);
                return;
            }
            if (error.etag === null) {
                setDialog({ kind: "deleted" });
                return;
            }
            try {
                const theirs = await call({ op: "read", folder: current.folderId, path: current.path });
                const latest = fileRef.current;
                if (!latest || latest.folderId !== current.folderId || latest.path !== current.path) return;
                // Not text any more: nothing to compare or take, only mine or nothing.
                setDialog({ kind: "conflict", theirsText: readText(bytesFromBase64(theirs.contentBase64))?.text ?? null, theirsEtag: theirs.etag });
            } catch (readError) {
                fail(readError);
            }
        } finally {
            savingRef.current = false;
        }
    }, [track, writeText, say, fail, call]);

    const resolveConflict = React.useCallback(async (choice) => {
        const current = fileRef.current;
        const conflict = dialog;
        if (!current || !conflict) return;
        setDialog(null);
        try {
            if (choice === "mine") {
                await track(writeText(current, current.text, conflict.theirsEtag));
                say(`Saved ${current.name} (your version)`);
            } else if (choice === "theirs") {
                drafts.delete(draftKey(sessionId, current.folderId, current.path));
                setFile({ ...current, text: conflict.theirsText, baseText: conflict.theirsText, etag: conflict.theirsEtag, diskEtag: conflict.theirsEtag, dirty: false, changedOnDisk: false, docKey: `${current.docKey}~` });
                say("Took the version on disk");
            } else if (choice === "both") {
                const module = await loadEditor();
                const merged = module.mergeThreeWay(current.baseText, current.text, conflict.theirsText);
                if (!merged.ok) {
                    say("The changes are on the same lines. Compare them to choose.", "error");
                    setCompare({ theirsText: conflict.theirsText, theirsEtag: conflict.theirsEtag });
                    return;
                }
                await track(writeText(current, merged.text, conflict.theirsEtag, { replace: true }));
                say(`Saved ${current.name} with both sets of changes`);
            } else if (choice === "compare") {
                setCompare({ theirsText: conflict.theirsText, theirsEtag: conflict.theirsEtag });
            }
        } catch (error) {
            fail(error);
        }
    }, [dialog, track, writeText, say, fail, sessionId]);

    const saveCompared = React.useCallback(async () => {
        const current = fileRef.current;
        const merged = compareHandle.current?.getMine();
        if (!current || !compare || typeof merged !== "string") return;
        try {
            await track(writeText(current, merged, compare.theirsEtag, { replace: true }));
            setCompare(null);
            say(`Saved ${current.name}`);
        } catch (error) {
            fail(error);
        }
    }, [compare, track, writeText, say, fail]);

    // ── Tree actions ──
    const toggleDir = React.useCallback((fid, path) => {
        const key = dirKey(fid, path);
        setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(key)) next.delete(key);
            else {
                next.add(key);
                loadDir(fid, path);
            }
            return next;
        });
    }, [loadDir]);

    const refresh = React.useCallback(async () => {
        await loadFolders({ quiet: true });
        if (!folderId) return;
        const keys = [dirKey(folderId, ""), ...[...expanded].filter((key) => key.startsWith(`${folderId}\u0000`))];
        await Promise.all([
            ...[...new Set(keys)].map((key) => loadDir(folderId, key.slice(folderId.length + 1))),
            gitOnRef.current && gitRepoRef.current !== null ? loadGitStatus(folderId, gitSinceRef.current, gitRepoRef.current) : null,
        ]);
    }, [loadFolders, folderId, expanded, loadDir, loadGitStatus]);

    const downloadEntry = React.useCallback(async (fid, path, isDir) => {
        try {
            if (isDir) {
                const result = await track(call({ op: "zip", folder: fid, path }));
                const name = path ? baseName(path) : (folders.find((f) => f.id === fid)?.name || "folder");
                downloadBytes(bytesFromBase64(result.contentBase64), `${name}.zip`, "application/zip");
                say(`Downloaded ${name}.zip (${zipNote(result)})`);
            } else {
                const result = await track(call({ op: "read", folder: fid, path }));
                downloadBytes(bytesFromBase64(result.contentBase64), baseName(path), IMAGE_TYPES[extensionOf(path)] || "application/octet-stream");
            }
        } catch (error) {
            fail(error);
        }
    }, [track, call, folders, say, fail]);

    // Picked rows: one file downloads as itself; anything more as one .zip.
    const downloadPicked = React.useCallback(async (items) => {
        if (!items.length) return;
        const fid = items[0].folderId;
        if (items.length === 1 && !items[0].isDir) {
            downloadEntry(fid, items[0].path, false);
            return;
        }
        try {
            const result = await track(call({ op: "zip", folder: fid, path: "", paths: items.map((item) => item.path) }));
            const name = folders.find((f) => f.id === fid)?.name || "files";
            downloadBytes(bytesFromBase64(result.contentBase64), `${name}-${items.length}-items.zip`, "application/zip");
            say(`Downloaded ${items.length} items (${zipNote(result)})`);
        } catch (error) {
            fail(error);
        }
    }, [track, call, folders, say, fail, downloadEntry]);

    const uploadFiles = React.useCallback(async (fid, dir, list) => {
        const max = info?.maxBytes ?? 20 * 1024 * 1024;
        const files = Array.from(list || []);
        let done = 0;
        for (const upload of files) {
            if (upload.size > max) {
                say(`${upload.name} is ${formatBytes(upload.size)}; the limit is ${formatBytes(max)}.`, "error");
                continue;
            }
            const contentBase64 = base64FromBytes(new Uint8Array(await upload.arrayBuffer()));
            let target = joinPath(dir, upload.name);
            markMine(fid, target);
            try {
                await track(call({ op: "write", folder: fid, path: target, contentBase64, ifMatch: null }));
                done++;
            } catch (error) {
                if (error?.code !== CODES.EXISTS) {
                    fail(error);
                    continue;
                }
                const choice = await new Promise((resolve) => setDialog({ kind: "exists", name: upload.name, dir, resolve }));
                setDialog(null);
                try {
                    if (choice === "replace") {
                        const current = await call({ op: "stat", folder: fid, path: target });
                        await track(call({ op: "write", folder: fid, path: target, contentBase64, ifMatch: current.etag }));
                        done++;
                    } else if (choice === "both") {
                        const listing = await call({ op: "list", folder: fid, path: dir });
                        target = joinPath(dir, freeName(upload.name, new Set(listing.entries.map((e) => e.name))));
                        markMine(fid, target);
                        await track(call({ op: "write", folder: fid, path: target, contentBase64, ifMatch: null }));
                        done++;
                    }
                } catch (secondError) {
                    fail(secondError);
                }
            }
        }
        if (done) say(`Uploaded ${done} file${done === 1 ? "" : "s"}`);
        loadDir(fid, dir);
    }, [info, say, track, call, fail, loadDir, markMine]);

    // A moved or renamed item takes along the open file inside it, its
    // unsaved edits, the folders open inside it, and where the person was.
    const followMove = React.useCallback((fromFid, fromPath, toFid, toPath) => {
        const inside = (p) => p === fromPath || p.startsWith(`${fromPath}/`);
        const moved = (p) => toPath + p.slice(fromPath.length);
        setFile((current) => (current && current.folderId === fromFid && inside(current.path)
            ? { ...current, folderId: toFid, path: moved(current.path), name: baseName(moved(current.path)) }
            : current));
        for (const key of [...drafts.keys()]) {
            const [sid, fid, p] = key.split("\u0000");
            if (sid !== sessionId || fid !== fromFid || !inside(p)) continue;
            drafts.set(draftKey(sessionId, toFid, moved(p)), drafts.get(key));
            drafts.delete(key);
        }
        setExpanded((previous) => {
            let changed = false;
            const next = new Set();
            for (const key of previous) {
                const at = key.indexOf("\u0000");
                const fid = key.slice(0, at);
                const p = key.slice(at + 1);
                if (fid === fromFid && inside(p)) {
                    next.add(dirKey(toFid, moved(p)));
                    changed = true;
                } else next.add(key);
            }
            return changed ? next : previous;
        });
        let movedPositions = false;
        const nextPositions = {};
        for (const [key, where] of Object.entries(positions.current)) {
            const at = key.indexOf("\u0000");
            const fid = key.slice(0, at);
            const p = key.slice(at + 1);
            if (fid === fromFid && inside(p)) {
                nextPositions[dirKey(toFid, moved(p))] = where;
                movedPositions = true;
            } else nextPositions[key] = where;
        }
        if (movedPositions) {
            positions.current = nextPositions;
            saveWorkspaceView(sessionId, (previous) => ({ ...previous, positions: nextPositions }));
        }
    }, [sessionId]);

    const moveEntry = React.useCallback(async (from, toFolderId, toDir) => {
        const name = baseName(from.path);
        const toPath = joinPath(toDir, name);
        if (from.folderId === toFolderId && (toPath === from.path || toDir === from.path || toDir.startsWith(`${from.path}/`))) return false;
        markMine(from.folderId, from.path);
        markMine(toFolderId, toPath);
        let ok = false;
        try {
            await track(call({ op: "move", folder: from.folderId, path: from.path, toFolder: toFolderId, toPath }));
            followMove(from.folderId, from.path, toFolderId, toPath);
            ok = true;
        } catch (error) {
            fail(error);
        }
        loadDir(from.folderId, parentOf(from.path));
        loadDir(toFolderId, toDir);
        return ok;
    }, [track, call, fail, loadDir, markMine, followMove]);

    // Several items dragged at once.
    const moveEntries = React.useCallback(async (items, toFolderId, toDir) => {
        let moved = 0;
        for (const item of items) if (await moveEntry(item, toFolderId, toDir)) moved++;
        if (moved) say(moved === 1 ? `Moved ${baseName(items[0].path)}` : `Moved ${moved} items`);
        setPicked(new Set());
    }, [moveEntry, say]);

    const commitInline = React.useCallback(async (value) => {
        const edit = inline;
        setInline(null);
        const name = String(value || "").trim();
        if (!edit || !name) return;
        if (name.includes("/")) {
            say("A name cannot contain /.", "error");
            return;
        }
        try {
            if (edit.kind === "rename") {
                if (name === baseName(edit.path)) return;
                const toPath = joinPath(parentOf(edit.path), name);
                markMine(edit.folderId, edit.path);
                markMine(edit.folderId, toPath);
                await track(call({ op: "move", folder: edit.folderId, path: edit.path, toPath }));
                refocus.current = dirKey(edit.folderId, toPath);
                followMove(edit.folderId, edit.path, edit.folderId, toPath);
                loadDir(edit.folderId, parentOf(edit.path));
            } else if (edit.kind === "newFolder") {
                markMine(edit.folderId, joinPath(edit.dir, name));
                await track(call({ op: "mkdir", folder: edit.folderId, path: joinPath(edit.dir, name) }));
                refocus.current = dirKey(edit.folderId, joinPath(edit.dir, name));
                loadDir(edit.folderId, edit.dir);
            } else if (edit.kind === "newFile") {
                const path = joinPath(edit.dir, name);
                markMine(edit.folderId, path);
                await track(call({ op: "write", folder: edit.folderId, path, contentBase64: "", ifMatch: null }));
                refocus.current = dirKey(edit.folderId, path);
                await loadDir(edit.folderId, edit.dir);
                openFile(edit.folderId, path);
            }
        } catch (error) {
            fail(error);
        }
    }, [inline, say, track, call, loadDir, fail, openFile, markMine, followMove]);

    const confirmDelete = React.useCallback(async () => {
        const items = dialog?.items ?? [];
        setDialog(null);
        let deleted = 0;
        for (const target of items) {
            markMine(target.folderId, target.path);
            try {
                await track(call({ op: "delete", folder: target.folderId, path: target.path, recursive: target.isDir }));
                deleted++;
                // Unsaved edits of what is gone go too.
                for (const key of [...drafts.keys()]) {
                    const [sid, fid, p] = key.split("\u0000");
                    if (sid === sessionId && fid === target.folderId && (p === target.path || p.startsWith(`${target.path}/`))) drafts.delete(key);
                }
                const open = fileRef.current;
                if (open && open.folderId === target.folderId && (open.path === target.path || open.path.startsWith(`${target.path}/`))) setFile(null);
            } catch (error) {
                fail(error);
            }
            loadDir(target.folderId, parentOf(target.path));
        }
        if (deleted) say(deleted === 1 ? `Deleted ${baseName(items[0].path)}` : `Deleted ${deleted} items`);
        setPicked(new Set());
    }, [dialog, track, call, say, fail, loadDir, markMine, sessionId]);

    // ── Finding files by name, in the folder shown ──
    React.useEffect(() => {
        const query = findText.trim();
        if (!query || !folderId) {
            setFound(null);
            return undefined;
        }
        let cancelled = false;
        setFound((previous) => ({ ...(previous || {}), query, loading: true }));
        const timer = setTimeout(async () => {
            try {
                const result = await call({ op: "find", folder: folderId, path: "", query });
                if (cancelled) return;
                setFound({ query, matches: result.matches || [], truncated: Boolean(result.truncated), loading: false });
                setFoundIndex(0);
            } catch (error) {
                if (!cancelled) setFound({ query, matches: [], truncated: false, loading: false, error });
            }
        }, 250);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [findText, folderId, call]);

    // A found file or folder: shown in the tree (its folders opened), the file opened.
    const reveal = React.useCallback((fid, path, isDir) => {
        const parts = path.split("/");
        const opened = [];
        for (let i = 1; i < (isDir ? parts.length + 1 : parts.length); i++) opened.push(parts.slice(0, i).join("/"));
        setExpanded((previous) => {
            const next = new Set(previous);
            for (const dir of opened) next.add(dirKey(fid, dir));
            return next;
        });
        for (const dir of opened) loadDir(fid, dir);
        if (!isDir) openFile(fid, path);
        const key = dirKey(fid, path);
        setPicked(new Set([key]));
        pickAnchor.current = key;
        scrollTarget.current = { key, block: "center" };
        setFindText("");
        setFound(null);
    }, [loadDir, openFile]);

    // A link in a markdown preview to another file in this folder: show it.
    const openLink = React.useCallback(async (href) => {
        const current = fileRef.current;
        if (!current) return;
        const target = resolveRelativePath(parentOf(current.path), href);
        if (!target) {
            say("That link points outside this folder.");
            return;
        }
        try {
            const stat = await call({ op: "stat", folder: current.folderId, path: target });
            reveal(current.folderId, target, stat.kind === "dir");
        } catch (error) {
            fail(error);
        }
    }, [call, say, fail, reveal]);

    // A replaced "already there?" question answers "skip", so the rest of
    // the upload still goes up.
    React.useEffect(() => {
        const before = previousDialog.current;
        previousDialog.current = dialog;
        if (before && before !== dialog && before.kind === "exists") before.resolve("skip");
    }, [dialog]);

    // Escape closes a dialog here without doing anything, and goes no
    // further. Only Escape pressed in the pane (or with nothing focused): one
    // pressed in the chat or a portal dialog is theirs.
    React.useEffect(() => {
        if (!dialog || !visible) return undefined;
        const onKey = (event) => {
            if (event.key !== "Escape") return;
            if (event.target !== document.body && !mainRef.current?.closest(".ps-ws-pane")?.contains(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            if (dialog.kind === "exists") dialog.resolve("skip");
            else setDialog(null);
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
    }, [dialog, visible]);

    // ── Checking for changes: new folders, changed listings, the open file changed on disk ──
    const checkOnce = React.useCallback(async () => {
        await refresh();
        const shownDiff = diffRef.current;
        const live = (side) => side?.rev === "WORKTREE" || side?.rev === "INDEX";
        if (shownDiff && !shownDiff.loading && !shownDiff.error && (live(shownDiff.left) || live(shownDiff.right))) openDiff(shownDiff, { quiet: true });
        const current = fileRef.current;
        if (!current || current.kind !== "text") return;
        try {
            const stat = await call({ op: "stat", folder: current.folderId, path: current.path });
            if (!stat.etag || stat.etag === current.diskEtag) return;
            if (!current.dirty) {
                const again = await call({ op: "read", folder: current.folderId, path: current.path });
                const read = readText(bytesFromBase64(again.contentBase64));
                if (!read) {
                    openFile(current.folderId, current.path);
                    return;
                }
                const text = read.text;
                setFile((latest) => (latest && latest.folderId === current.folderId && latest.path === current.path && !latest.dirty
                    ? { ...latest, text, baseText: text, bom: read.bom, crlf: read.crlf, etag: again.etag, diskEtag: again.etag, docKey: `${latest.docKey}^` }
                    : latest));
                say(`${current.name} changed on disk; showing the new version`);
            } else {
                setFile((latest) => (latest && latest.folderId === current.folderId && latest.path === current.path ? { ...latest, diskEtag: stat.etag, changedOnDisk: true } : latest));
            }
        } catch {
            // Gone or unreadable: the next open shows why.
        }
    }, [refresh, call, say, openFile, openDiff]);
    // One check at a time: on a folder that hangs, checks would pile up.
    const checking = React.useRef(false);
    const checkNow = React.useCallback(async () => {
        if (checking.current) return;
        checking.current = true;
        try {
            await checkOnce();
        } finally {
            checking.current = false;
        }
    }, [checkOnce]);

    React.useEffect(() => {
        if (!visible || !supported || !sessionId || infoError) return undefined;
        const timer = setInterval(() => { if (!document.hidden) checkNow(); }, POLL_MS);
        return () => clearInterval(timer);
    }, [visible, supported, sessionId, infoError, checkNow]);

    const retryable = Boolean(infoError) && ![403, 404].includes(Number(infoError?.status)) && infoError?.code !== CODES.DISABLED;
    React.useEffect(() => {
        if (!visible || !retryable) return undefined;
        const timer = setInterval(() => { if (!document.hidden) loadFolders({ quiet: true }); }, POLL_MS);
        return () => clearInterval(timer);
    }, [visible, retryable, loadFolders]);

    // The folders a running turn opens show up within seconds, with their
    // files: while none is open and one is still to open (none listed yet, or
    // listed and not opened). A folder on a root this portal does not serve
    // never opens here, so it gets the regular check.
    const opening = Boolean(info) && !info.folders.some((f) => f.available)
        && (info.folders.length === 0 || info.folders.some((f) => f.opened === false));
    React.useEffect(() => {
        if (!visible || !supported || infoError || !turnRunning || !opening) return undefined;
        const timer = setInterval(() => { if (!document.hidden) refresh(); }, OPENING_POLL_MS);
        return () => clearInterval(timer);
    }, [visible, supported, infoError, turnRunning, opening, refresh]);

    // A canvas app changed files: refresh now.
    React.useEffect(() => {
        if (!visible || !supported || infoError) return undefined;
        let timer = null;
        const onChange = (event) => {
            if (event.detail?.sessionId !== sessionId || event.detail?.source === "pane") return;
            clearTimeout(timer);
            timer = setTimeout(() => { checkNow(); }, 300);
        };
        window.addEventListener(WORKSPACE_CHANGED_EVENT, onChange);
        return () => {
            clearTimeout(timer);
            window.removeEventListener(WORKSPACE_CHANGED_EVENT, onChange);
        };
    }, [visible, supported, infoError, sessionId, checkNow]);

    // A tool call finished: refresh now rather than at the next poll.
    const lastFinished = React.useRef(finishedCalls);
    React.useEffect(() => {
        if (finishedCalls === lastFinished.current) return undefined;
        lastFinished.current = finishedCalls;
        if (!visible || !supported || infoError) return undefined;
        const timer = setTimeout(() => { checkNow(); }, 400);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [finishedCalls, visible, supported, infoError]);

    // Files the agent is editing right now, as tree keys.
    const agentEditing = React.useMemo(() => {
        const keys = new Set();
        for (const toolPath of String(runningText || "").split("\u0002").filter(Boolean)) {
            const located = locateToolPath(folders, toolPath);
            if (located) keys.add(dirKey(located.folderId, located.path));
        }
        return keys;
    }, [runningText, folders]);

    // ── Git ──
    // The folder's repositories, and the one shown: the one picked, else the
    // folder itself, else the first one inside it. null: no repository.
    const reposHere = folderId ? gitRepos[folderId] ?? null : null;
    const repoChoices = reposHere ? [...(reposHere.top ? [""] : []), ...reposHere.repos] : [];
    const pickedRepo = folderId ? gitRepoOf[folderId] : undefined;
    // null picked: the person is on something outside every repository.
    const gitRepo = pickedRepo === null ? null
        : pickedRepo !== undefined && repoChoices.includes(pickedRepo) ? pickedRepo
        : (repoChoices[0] ?? null);
    gitRepoRef.current = gitRepo;
    const inRepo = (repo, path) => (repo ? `${repo}/${path}` : path);
    // The repository a folder path is in (the deepest one), or null.
    const repoFor = (path) => {
        let best = null;
        for (const repo of repoChoices) {
            if (repo === "" ? best === null : (path === repo || path.startsWith(`${repo}/`)) && (best === null || repo.length > best.length)) best = repo;
        }
        return best;
    };
    React.useEffect(() => {
        if (visible && gitOn && folderId && !gitRepos[folderId]) loadGitRepos(folderId);
    }, [visible, gitOn, folderId, gitRepos, loadGitRepos]);
    const gitHere = gitStatus?.folderId === folderId && gitStatus.repo === gitRepo ? gitStatus : null;
    const gitResult = gitHere?.result ?? null;
    // While a repository's status loads (another repository was picked), the
    // git tabs stay: hiding them moved the tree under the pointer, and the
    // second click of a double-click landed on another folder.
    const gitLoading = gitOn && gitRepo !== null && !gitHere;
    const gitReady = gitOn && gitRepo !== null && (gitLoading || (gitResult?.repo === true && gitResult.available !== false));
    const gitTab = gitReady ? sideTab : "files";
    const gitKey = folderId && gitRepo !== null ? `${folderId}\u0000${gitRepo}` : null;
    const gitLog = gitKey ? gitLogs[gitKey] ?? null : null;
    const gitCommit = gitKey ? gitCommits[gitKey] ?? null : null;
    const compareMode = typeof gitSince !== "string" ? null
        : gitSince.startsWith("commit:") ? { kind: "commit", sha: gitSince.slice(7) }
        : gitSince.startsWith("range:") ? { kind: "range", from: gitSince.slice(6).split("..")[0], to: gitSince.slice(6).split("..")[1] }
        : null;
    const statusSince = compareMode ? null : gitSince;
    React.useEffect(() => {
        if (!visible || !gitOn || !folderId || gitRepo === null) return;
        loadGitStatus(folderId, statusSince, gitRepo);
    }, [visible, gitOn, folderId, statusSince, gitRepo, loadGitStatus]);
    const compareKey = gitKey && compareMode ? `${gitKey}\u0000${gitSince}` : null;
    React.useEffect(() => {
        if (!visible || !compareKey || !compareMode) return;
        const key = compareKey;
        setGitCompare((latest) => (latest?.key === key && !latest.error ? latest : { key, loading: true }));
        const repo = gitRepo ? { repo: gitRepo } : {};
        const request = compareMode.kind === "commit"
            ? { op: "git", folder: folderId, what: "show", ...repo, sha: compareMode.sha }
            : { op: "git", folder: folderId, what: "compare", ...repo, from: compareMode.from, to: compareMode.to };
        call(request).then(
            (result) => setGitCompare((latest) => (latest?.key === key ? { key, loading: false, result } : latest)),
            (error) => setGitCompare((latest) => (latest?.key === key ? { key, loading: false, error } : latest)),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible, compareKey]);
    // Another repository: its own Changes, History and diff.
    const chooseRepo = React.useCallback((repo) => {
        if (!folderId) return;
        setGitRepoOf((latest) => ({ ...latest, [folderId]: repo }));
        setGitSince(null);
        if (diffRef.current && (diffRef.current.repo ?? "") !== (repo ?? "\u0000none")) closeDiff();
    }, [folderId, closeDiff]);
    // Git follows what the person opens, as VS Code follows the open editor.
    // Something outside every repository (a file next to the clones in
    // home): no repository, until the person picks something inside one.
    const followRepo = (path) => {
        if (!reposHere || repoChoices.length === 0) return;
        const repo = repoFor(path);
        if (repo !== gitRepo) chooseRepo(repo);
    };
    const openPath = file && file.folderId === folderId ? file.path : null;
    React.useEffect(() => {
        if (openPath !== null) followRepo(openPath);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openPath, repoChoices.join("\u0001")]);
    const gitLogsRef = React.useRef(gitLogs);
    gitLogsRef.current = gitLogs;
    const loadGitLog = React.useCallback(async (fid, repo, head, { more = false } = {}) => {
        const key = `${fid}\u0000${repo}`;
        const before = gitLogsRef.current[key] ?? null;
        if (more && before?.loading) return;
        const put = (update) => setGitLogs((latest) => ({ ...latest, [key]: update(latest[key] ?? null) }));
        put((latest) => ({ ...(latest || { folderId: fid, commits: null }), head, loading: true, error: null }));
        try {
            const result = await call({ op: "git", folder: fid, what: "log", ...(repo ? { repo } : {}), skip: more ? before?.commits?.length ?? 0 : 0 });
            put((latest) => {
                const kept = more ? latest?.commits ?? [] : [];
                const seen = new Set(kept.map((c) => c.sha));
                return { folderId: fid, head, loading: false, more: Boolean(result.more), commits: [...kept, ...(result.commits ?? []).filter((c) => !seen.has(c.sha))] };
            });
        } catch (error) {
            put((latest) => ({ ...(latest || { folderId: fid, commits: null }), head, loading: false, error }));
        }
    }, [call]);
    // History loads when it shows, and again when HEAD moves: a new commit,
    // or another branch at the same commit (its labels change).
    const gitHead = gitResult ? `${gitResult.head ?? ""}\u0000${gitResult.branch ?? ""}` : null;
    React.useEffect(() => {
        if (!visible || gitTab !== "history" || !gitKey) return;
        const shown = gitLogsRef.current[gitKey];
        if (shown && (shown.loading || (shown.commits && shown.head === gitHead))) return;
        loadGitLog(folderId, gitRepo, gitHead);
    }, [visible, gitTab, gitKey, gitHead, loadGitLog]);
    // Older commits load by themselves when the end of the list scrolls into view.
    const loadOlder = React.useRef(null);
    loadOlder.current = () => {
        if (gitKey && gitLog?.more && !gitLog.loading) loadGitLog(folderId, gitRepo, gitHead, { more: true });
    };
    const olderObserver = React.useRef(null);
    const olderRef = React.useCallback((element) => {
        olderObserver.current?.disconnect();
        olderObserver.current = null;
        if (!element || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) loadOlder.current?.(); });
        observer.observe(element);
        olderObserver.current = observer;
    }, []);
    const pickCommit = React.useCallback(async (sha) => {
        const fid = folderId;
        const repo = gitRepo ?? "";
        const key = `${fid}\u0000${repo}`;
        if (diffRef.current?.source === "history") closeDiff();
        const put = (value) => setGitCommits((latest) => (latest[key]?.sha === sha ? { ...latest, [key]: value } : latest));
        setGitCommits((latest) => ({ ...latest, [key]: { folderId: fid, sha, loading: true } }));
        try {
            const result = await call({ op: "git", folder: fid, what: "show", ...(repo ? { repo } : {}), sha });
            put({ folderId: fid, sha, loading: false, result });
        } catch (error) {
            put({ folderId: fid, sha, loading: false, error });
        }
    }, [call, folderId, gitRepo, closeDiff]);
    // A turn that ended without a tool call can still have changed files.
    const wasRunning = React.useRef(turnRunning);
    React.useEffect(() => {
        const ended = wasRunning.current && !turnRunning;
        wasRunning.current = turnRunning;
        if (!ended || !visible || !supported || infoError) return undefined;
        // The turn may have cloned a repository: look for them again.
        if (folderId && gitOnRef.current) loadGitRepos(folderId);
        const timer = setTimeout(() => { checkNow(); }, 400);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [turnRunning]);
    const gitMarks = React.useMemo(
        () => (gitReady && gitResult ? gitTreeMarks((gitResult.files || []).map((f) => ({ ...f, path: inRepo(gitRepo, f.path) }))) : null),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [gitReady, gitResult, gitRepo],
    );
    const repoRoots = new Set(gitOn ? repoChoices.filter(Boolean) : []);

    // ── Drag and drop ──
    const dragData = (event) => {
        try { return JSON.parse(event.dataTransfer.getData("application/x-ps-workspace-path") || "null"); } catch { return null; }
    };
    const dropProps = (fid, dir) => ({
        onDragOver: (event) => {
            const types = Array.from(event.dataTransfer?.types || []);
            if (!types.includes("Files") && !types.includes("application/x-ps-workspace-path")) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = types.includes("Files") ? "copy" : "move";
            setDropTarget(dirKey(fid, dir));
        },
        onDragLeave: (event) => {
            if (event.currentTarget.contains(event.relatedTarget)) return;
            setDropTarget((current) => (current === dirKey(fid, dir) ? null : current));
        },
        onDrop: (event) => {
            event.preventDefault();
            event.stopPropagation();
            setDropTarget(null);
            const moved = dragData(event);
            if (Array.isArray(moved)) moveEntries(moved, fid, dir);
            else if (moved) moveEntries([moved], fid, dir);
            else if (event.dataTransfer?.files?.length) uploadFiles(fid, dir, event.dataTransfer.files);
        },
    });

    // After each render: the tree's remembered scroll (once its folders are
    // listed), then a row to bring into view: the one a search picked
    // (centered), or the open file when it changed (only as far as needed).
    const openKey = file ? dirKey(file.folderId, file.path) : null;
    const lastShownOpen = React.useRef(null);
    React.useLayoutEffect(() => {
        const tree = treeRef.current;
        if (!tree) return;
        const pending = pendingTreeTop.current;
        if (pending && pending.folderId === folderId) {
            const root = dirs[dirKey(folderId, "")];
            const loading = [...expanded].some((key) => key.startsWith(`${folderId}\u0000`) && dirs[key]?.loading && !dirs[key]?.entries);
            if (!root?.entries || loading) return;
            tree.scrollTop = pending.top;
            pendingTreeTop.current = null;
        }
        const rowOf = (key) => tree.querySelector(`[data-key="${encodeURIComponent(key)}"]`);
        const target = scrollTarget.current;
        if (target) {
            const row = rowOf(target.key);
            if (row) {
                bringIntoView(tree, row, target.block);
                scrollTarget.current = null;
                if (target.key === openKey) lastShownOpen.current = openKey;
            }
        }
        if (openKey && lastShownOpen.current !== openKey) {
            const row = rowOf(openKey);
            if (row) {
                bringIntoView(tree, row, "nearest");
                lastShownOpen.current = openKey;
            }
        }
    });

    // ── Rendering ──
    if (!supported) return h("div", { className: "ps-ws-pane", "data-own-keys": "" }, h("div", { className: "ps-ws-message" }, "This portal does not offer workspace files."));
    if (!sessionId) return h("div", { className: "ps-ws-pane", "data-own-keys": "" }, h("div", { className: "ps-ws-message" }, "Pick a session to see its folders."));
    if (infoError) {
        return h("div", { className: "ps-ws-pane", "data-own-keys": "" }, h("div", { className: "ps-ws-message" },
            h("p", null, workspaceErrorText(infoError)),
            retryable ? h("button", { type: "button", className: "ps-ws-btn", onClick: () => loadFolders() }, "Retry") : null));
    }
    if (!info) return h("div", { className: "ps-ws-pane", "data-own-keys": "" }, h("div", { className: "ps-ws-message" }, "Loading the session's folders…"));
    if (!info.enabled) return h("div", { className: "ps-ws-pane", "data-own-keys": "" }, h("div", { className: "ps-ws-message" }, "Workspace files are not set up on this portal."));
    if (folders.length === 0) {
        return h("div", { className: "ps-ws-pane", "data-own-keys": "" }, h("div", { className: "ps-ws-message" },
            "This session has no folders. A session gets one when it starts in a repository, or when this deployment gives every session a folder: its first turn opens it."));
    }

    const rootState = folder ? dirs[dirKey(folder.id, "")] : null;
    const rootReadOnly = Boolean(rootState?.readOnly);

    const renderInlineInput = (depth) => h("div", { className: "ps-ws-row is-inline", style: { paddingLeft: 8 + depth * 14 } },
        h("span", { className: "ps-ws-twisty" }),
        h("input", {
            className: "ps-ws-inline-input",
            autoFocus: true,
            defaultValue: inline.kind === "rename" ? baseName(inline.path) : "",
            placeholder: inline.kind === "newFolder" ? "New folder name" : inline.kind === "newFile" ? "New file name" : "",
            // A rename selects the name, not its extension.
            onFocus: (event) => {
                const value = event.currentTarget.value;
                const dot = value.lastIndexOf(".");
                event.currentTarget.setSelectionRange(0, dot > 0 ? dot : value.length);
            },
            onKeyDown: (event) => {
                if (event.key === "Enter") commitInline(event.currentTarget.value);
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    refocus.current = inline.kind === "rename" ? dirKey(inline.folderId, inline.path) : inline.dir ? dirKey(inline.folderId, inline.dir) : null;
                    setInline(null);
                }
            },
            onBlur: (event) => commitInline(event.currentTarget.value),
            "aria-label": inline.kind === "rename" ? "New name" : inline.kind === "newFolder" ? "New folder name" : "New file name",
        }));

    // Rows in the order they show, for Shift-click ranges and Select all.
    const shownRows = [];
    // The tree's one tab stop: a row that shows, else the first row.
    const rowShown = (key) => {
        if (!key || !folderId) return false;
        const [fid, rowPath] = key.split("\u0000");
        if (fid !== folderId || !rowPath) return false;
        const parts = rowPath.split("/");
        for (let i = 1; i < parts.length; i++) if (!expanded.has(dirKey(fid, parts.slice(0, i).join("/")))) return false;
        return Boolean(dirs[dirKey(fid, parts.slice(0, -1).join("/"))]?.entries?.some((entry) => entry.name === parts[parts.length - 1]));
    };
    const tabKey = [focusKey, file ? dirKey(file.folderId, file.path) : null].find(rowShown) ?? null;
    const focusRow = (key) => {
        if (key) treeRef.current?.querySelector(`[data-key="${encodeURIComponent(key)}"]`)?.focus();
    };
    const pickedItems = () => shownRows.filter((row) => picked.has(row.key)).map((row) => ({ folderId: row.fid, path: row.path, isDir: row.dir }));
    // New file or folder, as in any file explorer: inside the picked folder,
    // or next to the picked file; at the top when nothing is picked.
    const newHere = (kind) => {
        if (!folder) return;
        const one = picked.size === 1 ? [...picked][0] : null;
        const row = one ? shownRows.find((shown) => shown.key === one) : null;
        const dir = row ? (row.dir ? row.path : parentOf(row.path)) : "";
        if (dir && !expanded.has(dirKey(folder.id, dir))) toggleDir(folder.id, dir);
        setInline({ kind, folderId: folder.id, dir });
    };
    const onRowClick = (event, row) => {
        if (event.shiftKey && pickAnchor.current) {
            const from = shownRows.findIndex((one) => one.key === pickAnchor.current);
            const to = shownRows.findIndex((one) => one.key === row.key);
            if (from >= 0 && to >= 0) {
                const [a, b] = from < to ? [from, to] : [to, from];
                setPicked(new Set(shownRows.slice(a, b + 1).map((one) => one.key)));
                return;
            }
        }
        if (event.metaKey || event.ctrlKey || selectMode) {
            setPicked((previous) => {
                const next = new Set(previous);
                if (next.has(row.key)) next.delete(row.key);
                else next.add(row.key);
                return next;
            });
            pickAnchor.current = row.key;
            return;
        }
        setPicked(new Set([row.key]));
        pickAnchor.current = row.key;
        if (row.fid === folderId) followRepo(row.path);
        if (!row.dir) {
            lastFolderClick.current = null;
            openFile(row.fid, row.path);
            return;
        }
        // A first click on a folder selects it. Another click on it within
        // FOLDER_TOGGLE_MS opens it, and the next one closes it. Its arrow,
        // Enter and the arrow keys open and close it at once.
        const now = Date.now();
        const last = lastFolderClick.current;
        lastFolderClick.current = { key: row.key, at: now };
        if (last && last.key === row.key && now - last.at < FOLDER_TOGGLE_MS) toggleDir(row.fid, row.path);
    };
    const onTreeKeyDown = (event) => {
        if (event.target?.tagName === "INPUT") return;
        if (event.key === "Escape" && picked.size > 0) {
            event.preventDefault();
            event.stopPropagation();
            setPicked(new Set());
            setSelectMode(false);
        } else if (event.key === "Delete" || event.key === "Backspace") {
            // The focused row, unless it is one of the picked ones: then all of them.
            const raw = event.target?.getAttribute?.("data-key");
            const focused = raw ? shownRows.find((row) => row.key === decodeURIComponent(raw)) : null;
            const chosen = focused && !picked.has(focused.key) ? [{ folderId: focused.fid, path: focused.path, isDir: focused.dir }] : pickedItems();
            const items = chosen.filter((item) => !dirs[dirKey(item.folderId, parentOf(item.path))]?.readOnly);
            if (!items.length) return;
            event.preventDefault();
            setDialog({ kind: "delete", items });
        } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setPicked(new Set(shownRows.map((row) => row.key)));
        }
    };

    const renderDir = (fid, path, depth) => {
        const state = dirs[dirKey(fid, path)];
        const rows = [];
        if (inline && inline.kind !== "rename" && inline.folderId === fid && inline.dir === path) rows.push(h(React.Fragment, { key: "__inline" }, renderInlineInput(depth)));
        // A folder that failed keeps its error while each check asks again:
        // switching to "Loading…" and back made the error blink.
        if (!state || (state.loading && !state.entries && !state.error)) {
            rows.push(h("div", { key: "__loading", className: "ps-ws-row is-muted", style: { paddingLeft: 8 + depth * 14 } }, "Loading…"));
            return rows;
        }
        if (state.error && !state.entries) {
            // The folder itself is gone, not a file in it: say which folder.
            const gone = !path && state.error?.code === CODES.NOT_FOUND;
            const place = folders.find((f) => f.id === fid);
            const text = gone && place
                ? `This folder is not on disk: ${place.root}${place.folder ? `/${place.folder}` : ""}. It may have been removed; the session's next turn can bring it back.`
                : workspaceErrorText(state.error);
            rows.push(h("div", { key: "__error", className: `ps-ws-row is-error${gone ? " is-gone" : ""}`, style: { paddingLeft: 8 + depth * 14 } }, text));
            return rows;
        }
        if (state.entries.length === 0) rows.push(h("div", { key: "__empty", className: "ps-ws-row is-muted", style: { paddingLeft: 22 + depth * 14 } }, "Empty"));
        for (const entry of state.entries) {
            const entryPath = joinPath(path, entry.name);
            const dir = isDirEntry(entry);
            const key = dirKey(fid, entryPath);
            const open = dir && expanded.has(key);
            const selected = file && file.folderId === fid && file.path === entryPath;
            const hasDraft = !dir && drafts.has(draftKey(sessionId, fid, entryPath));
            if (inline?.kind === "rename" && inline.folderId === fid && inline.path === entryPath) {
                rows.push(h(React.Fragment, { key: entryPath }, renderInlineInput(depth)));
                continue;
            }
            const readOnly = Boolean(entry.readOnly);
            const gitLetter = gitMarks && !dir ? gitMarks.letter(entryPath) : null;
            const gitDot = gitMarks && dir ? gitMarks.dir(entryPath) : null;
            const row = { key, fid, path: entryPath, dir };
            shownRows.push(row);
            const isPicked = picked.has(key);
            rows.push(h("div", {
                key: entryPath,
                "data-key": encodeURIComponent(key),
                className: `ps-ws-row${selected ? " is-selected" : ""}${isPicked ? " is-picked" : ""}${dir && dropTarget === key ? " is-drop" : ""}${entry.name.startsWith(".") ? " is-dot" : ""}`,
                style: { paddingLeft: 8 + depth * 14 },
                role: "treeitem",
                "aria-level": depth + 1,
                "aria-expanded": dir ? open : undefined,
                "aria-selected": selected || isPicked || undefined,
                tabIndex: (tabKey ? key === tabKey : shownRows.length === 1) ? 0 : -1,
                onFocus: (event) => { if (event.target === event.currentTarget) setFocusKey(key); },
                draggable: !readOnly,
                title: entry.kind === "link" ? (entry.target === "outside" ? "A link to a place outside this folder" : "A link") : entryPath,
                onClick: (event) => onRowClick(event, row),
                onKeyDown: (event) => {
                    // Keys on the row's own buttons are theirs.
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter") (dir ? toggleDir(fid, entryPath) : openFile(fid, entryPath));
                    if (event.key === "F2" && !readOnly) setInline({ kind: "rename", folderId: fid, path: entryPath });
                    // Moving around, as in any file tree.
                    const index = shownRows.findIndex((shown) => shown.key === key);
                    const to = {
                        ArrowDown: () => shownRows[index + 1]?.key,
                        ArrowUp: () => shownRows[index - 1]?.key,
                        Home: () => shownRows[0]?.key,
                        End: () => shownRows[shownRows.length - 1]?.key,
                        ArrowRight: () => (dir && open ? shownRows[index + 1]?.key : null),
                        ArrowLeft: () => (dir && open ? null : path ? dirKey(fid, path) : null),
                    }[event.key];
                    if (!to || event.metaKey || event.ctrlKey || event.altKey) return;
                    event.preventDefault();
                    if (event.key === "ArrowRight" && dir && !open) toggleDir(fid, entryPath);
                    else if (event.key === "ArrowLeft" && dir && open) toggleDir(fid, entryPath);
                    else focusRow(to());
                },
                onDragStart: (event) => {
                    // A picked row carries every picked row with it.
                    const items = isPicked && picked.size > 1 ? pickedItems().map(({ folderId, path: p }) => ({ folderId, path: p })) : [{ folderId: fid, path: entryPath }];
                    event.dataTransfer.setData("application/x-ps-workspace-path", JSON.stringify(items.length === 1 ? items[0] : items));
                    event.dataTransfer.effectAllowed = "move";
                },
                ...(dir ? dropProps(fid, entryPath) : {}),
            },
            h("span", {
                className: "ps-ws-twisty",
                "aria-hidden": true,
                onClick: dir ? (event) => {
                    event.stopPropagation();
                    setPicked(new Set([key]));
                    pickAnchor.current = key;
                    toggleDir(fid, entryPath);
                } : undefined,
            }, dir ? (open ? "▾" : "▸") : ""),
            h("span", { className: "ps-ws-row-icon", "aria-hidden": true }, h(Icon, { d: dir ? FOLDER : FILE, size: 13 })),
            h("span", { className: `ps-ws-row-name${gitLetter ? ` is-git-${gitLetter}` : ""}` }, entry.name),
            hasDraft ? h("span", { className: "ps-ws-draft-dot", title: "Unsaved changes" }) : null,
            agentEditing.has(key)
                ? h("span", { className: "ps-ws-agent-dot is-live", title: "The agent is editing this" })
                : (recent[key] && Date.now() - recent[key] < RECENT_MS ? h("span", { className: "ps-ws-agent-dot", title: "Changed in the last minute, not by you" }) : null),
            entry.kind === "link" ? h("span", { className: "ps-ws-row-badge", title: "A link" }, "↗") : null,
            gitLetter ? h("span", { className: `ps-ws-git-letter is-git-${gitLetter}`, title: GIT_WORDS[gitLetter] }, gitLetter) : null,
            gitDot ? h("span", { className: `ps-ws-git-dot is-git-${gitDot}`, title: `${GIT_DOT_WORDS[gitDot]}: see the Changes tab` }) : null,
            dir && fid === folderId && repoRoots.has(entryPath) ? h("span", { className: `ps-ws-repo-mark${entryPath === gitRepo ? " is-shown" : ""}`, title: entryPath === gitRepo ? "A git repository: the one git shows now" : "A git repository: click to show its git" }, h(Icon, { d: BRANCH, size: 11 })) : null,
            readOnly ? h("span", { className: "ps-ws-row-lock", title: "Read-only" }, h(Icon, { d: LOCK, size: 11 })) : null,
            h("span", { className: "ps-ws-row-actions", onClick: (event) => event.stopPropagation() },
                dir && !readOnly ? h("button", { type: "button", title: "New file here", "aria-label": `New file in ${entry.name}`, onClick: () => { if (!open) toggleDir(fid, entryPath); setInline({ kind: "newFile", folderId: fid, dir: entryPath }); } }, h(Icon, { d: PLUS_FILE, size: 12 })) : null,
                dir && !readOnly ? h("button", { type: "button", title: "Upload here", "aria-label": `Upload into ${entry.name}`, onClick: () => { uploadDir.current = entryPath; uploadInput.current?.click(); } }, h(Icon, { d: UPLOAD, size: 12 })) : null,
                h("button", { type: "button", title: dir ? "Download as .zip" : "Download", "aria-label": `Download ${entry.name}`, onClick: () => downloadEntry(fid, entryPath, dir) }, h(Icon, { d: DOWNLOAD, size: 12 })),
                !readOnly ? h("button", { type: "button", title: "Rename", "aria-label": `Rename ${entry.name}`, onClick: () => setInline({ kind: "rename", folderId: fid, path: entryPath }) }, h(Icon, { d: PENCIL, size: 12 })) : null,
                !readOnly ? h("button", { type: "button", title: "Delete", "aria-label": `Delete ${entry.name}`, onClick: () => setDialog({ kind: "delete", items: [{ folderId: fid, path: entryPath, isDir: dir }] }) }, h(Icon, { d: TRASH, size: 12 })) : null)));
            if (open) rows.push(h(React.Fragment, { key: `${entryPath}/` }, renderDir(fid, entryPath, depth + 1)));
        }
        if (state.truncated) rows.push(h("div", { key: "__more", className: "ps-ws-row is-muted", style: { paddingLeft: 22 + depth * 14 } }, "More files are not shown."));
        return rows;
    };

    // ── Git: the Changes and History lists, and one commit ──
    const gitCount = (gitResult?.files || []).length;
    const compareHere = compareKey && gitCompare?.key === compareKey ? gitCompare : null;
    const changesCount = compareMode ? (compareHere?.result?.files?.length ?? 0) : gitCount;
    // The tabs stay as long as the folder has a repository, so nothing moves
    // under the pointer. With none picked, Changes and History wait.
    const noRepoPicked = gitOn && repoChoices.length > 0 && gitRepo === null;
    const gitTabs = gitReady || noRepoPicked ? h("div", { className: "ps-ws-sidetabs", role: "tablist", "aria-label": "What the list shows" },
        [["files", "Files", FILE], ["changes", "Changes", PLUS_MINUS], ["history", "History", CLOCK]].map(([value, label, glyph]) => h("button", {
            key: value,
            type: "button",
            role: "tab",
            "aria-selected": gitTab === value,
            "aria-label": value === "changes" && !noRepoPicked ? `Changes: ${changesCount}` : label,
            title: noRepoPicked && value !== "files" ? `${label}: pick something inside a repository, or pick one above` : label,
            disabled: noRepoPicked && value !== "files",
            className: gitTab === value ? "is-on" : "",
            onClick: () => setSideTab(value),
        },
        // A narrow column shows only the glyphs (and the count).
        h("span", { className: "ps-ws-sidetab-glyph", "aria-hidden": true }, h(Icon, { d: glyph, size: 13 })),
        h("span", { className: "ps-ws-sidetab-label" }, label),
        value === "changes" && !noRepoPicked ? h("span", { className: "ps-ws-sidetab-count" }, String(changesCount)) : null))) : null;
    const gitCounts = (added, removed) => [
        added > 0 ? h("span", { key: "added", className: "ps-ws-git-count is-added" }, `+${added}`) : null,
        removed > 0 ? h("span", { key: "removed", className: "ps-ws-git-count is-removed" }, `−${removed}`) : null,
    ];
    const gitTotals = (files) => files.reduce((sum, f) => [sum[0] + (f.added || 0), sum[1] + (f.removed || 0)], [0, 0]);
    // Each tab keeps its own viewer: a diff opened in Changes shows in Changes
    // (and is still there when the person comes back), Files shows the file
    // picked in the tree (or a diff from its Open Changes), History its commit.
    const diffTab = !diff ? null : diff.source === "history" ? "history" : diff.source === "files" ? "files" : "changes";
    const diffHere = diff && diff.folderId === folderId && diffTab === gitTab ? diff : null;
    // A list is one Tab stop; the arrow keys, Home and End move inside it (as in the file tree).
    const onGitListKeys = (event) => {
        const step = { ArrowDown: 1, ArrowUp: -1, Home: "first", End: "last" }[event.key];
        if (step === undefined || event.metaKey || event.ctrlKey || event.altKey) return;
        const rows = [...event.currentTarget.querySelectorAll(":scope > .ps-ws-git-row, :scope > .ps-ws-git-commit, :scope > .ps-ws-git-commit-item > .ps-ws-git-commit")];
        if (!rows.length) return;
        const at = rows.indexOf(document.activeElement);
        const to = step === "first" ? 0 : step === "last" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + step));
        event.preventDefault();
        rows[to].focus();
    };
    const tabStopOf = (keys, selectedKey) => (selectedKey && keys.includes(selectedKey) ? selectedKey : keys[0]);
    const shortPath = (from, to) => (parentOf(from) === parentOf(to) ? baseName(from) : from);
    const gitFileRow = (f, key, { onOpen, title, selectable = true, counts, tabStop = false }) => {
        const at = f.path.lastIndexOf("/");
        const selected = diffHere ? diffHere.rowKey === key : selectable && file && file.folderId === folderId && file.path === inRepo(gitRepo, f.path);
        const [added, removed] = counts === undefined ? [f.added, f.removed] : [counts?.added ?? null, counts?.removed ?? null];
        return h("button", {
            key,
            type: "button",
            tabIndex: tabStop ? 0 : -1,
            "data-row-key": key,
            className: `ps-ws-row ps-ws-git-row${selected ? " is-selected" : ""}`,
            title: title ?? `${f.path}: ${GIT_WORDS[f.letter]}${f.from ? ` (was ${f.from})` : ""}`,
            onClick: () => onOpen(f),
        },
        h("span", { className: `ps-ws-row-name${f.letter === "D" ? " is-deleted" : ""}` }, (at < 0 ? f.path : f.path.slice(at + 1)) + (f.dir ? "/" : "")),
        f.from ? h("span", { className: "ps-ws-git-from" }, `← ${shortPath(f.from, f.path)}`) : null,
        at > 0 ? h("span", { className: "ps-ws-found-dir" }, f.path.slice(0, at)) : null,
        agentEditing.has(dirKey(folderId, inRepo(gitRepo, f.path))) ? h("span", { className: "ps-ws-agent-dot is-live", title: "The agent is editing this" }) : null,
        h("span", { className: "ps-ws-spacer" }),
        ...gitCounts(added, removed),
        h("span", { className: `ps-ws-git-letter is-git-${f.letter}`, title: GIT_WORDS[f.letter] }, f.letter));
    };
    const diffSpec = (source, rowKey, f, left, right, group = null, sinceSha = null) => ({
        key: [source, gitRepo ?? "", rowKey, left?.rev ?? "-", right?.rev ?? "-", f.path].join("\u0000"),
        folderId, repo: gitRepo ?? "", source, rowKey, group, sinceSha, path: f.path, from: f.from ?? null, letter: f.letter, left, right,
    });
    const WORKTREE = (path) => ({ rev: "WORKTREE", path, label: "Working Tree" });
    // As VS Code: a staged file is HEAD ↔ Index, a changed one Index ↔
    // Working Tree; "Changes since" a commit is that commit ↔ Working Tree.
    const changeSpec = (f, group, rowKey, source = "changes") => {
        const since = gitResult?.since ?? null;
        const before = f.from ?? f.path;
        if (since) {
            return diffSpec(source, rowKey, f,
                f.letter === "A" || f.letter === "U" ? null : { rev: since.sha, path: before, label: since.label },
                f.letter === "D" ? null : WORKTREE(f.path), "since", since.sha);
        }
        if (group === "Staged") {
            return diffSpec(source, rowKey, f,
                f.letter === "A" ? null : { rev: "HEAD", path: before, label: "HEAD" },
                f.letter === "D" ? null : { rev: "INDEX", path: f.path, label: "Index" }, "Staged");
        }
        const conflict = f.letter === "C";
        return diffSpec(source, rowKey, f,
            f.letter === "U" ? null : { rev: conflict ? "HEAD" : "INDEX", path: f.path, label: conflict ? "HEAD" : "Index" },
            f.letter === "D" ? null : WORKTREE(f.path), "Changes");
    };
    const commitSpec = (c, f, rowKey) => diffSpec("history", rowKey, f,
        f.letter === "A" || !c.parents.length ? null : { rev: c.parents[0], path: f.from ?? f.path, label: `${c.short}^` },
        f.letter === "D" ? null : { rev: c.sha, path: f.path, label: c.short });
    const openChange = (f, group, rowKey) => {
        if (f.dir) { setSideTab("files"); reveal(folderId, inRepo(gitRepo, f.path), true); return; }
        openDiff(changeSpec(f, group, rowKey));
    };
    // "Changes since" changed: a diff against the old base would now be wrong.
    const changeSince = (value) => {
        if (diffRef.current && diffRef.current.source !== "history") closeDiff();
        setGitSince(value || null);
    };
    // Close a diff and put focus back on the list it came from.
    const closeDiffAndFocus = () => {
        closeDiff();
        requestAnimationFrame(() => mainRef.current?.querySelector('.ps-ws-git-list [tabindex="0"]')?.focus());
    };
    // The open file's changes (the Files tab's Open Changes).
    const openChangesFor = (fullPath) => {
        const path = gitRepo ? fullPath.slice(gitRepo.length + 1) : fullPath;
        const f = (gitResult?.files || []).find((one) => one.path === path) ?? { path, letter: "U", staged: false, unstaged: true };
        const group = gitResult?.since ? "since" : f.unstaged ? "Changes" : "Staged";
        openDiff(changeSpec(f, group, `${group === "since" ? `Since ${gitResult.since.label}` : group}\u0000${f.path}`, "files"));
    };
    const short7 = (sha) => String(sha || "").slice(0, 7);
    const sincePicker = () => h("div", { className: "ps-ws-git-since" },
        h("select", { className: "ps-ws-git-select", "aria-label": "Show changes since", value: gitSince ?? "", onChange: (event) => changeSince(event.currentTarget.value) },
            h("option", { value: "" }, "Since the last commit"),
            h("option", { value: "main" }, "Since the main branch"),
            gitSince && gitSince !== "main" && !compareMode ? h("option", { value: gitSince }, `Since commit ${short7(gitSince)}`) : null,
            compareMode?.kind === "commit" ? h("option", { value: gitSince }, `In commit ${short7(compareMode.sha)}`) : null,
            compareMode?.kind === "range" ? h("option", { value: gitSince }, `Between ${short7(compareMode.from)} and ${short7(compareMode.to)}`) : null));
    // One commit's changes, or the changes between two commits.
    const renderCompare = () => {
        const result = compareHere?.result ?? null;
        const files = result?.files || [];
        const commit = compareMode.kind === "commit" ? result?.commit ?? null : null;
        const newer = compareMode.kind === "commit" ? compareMode.sha : compareMode.to;
        const title = compareMode.kind === "commit" ? `In commit ${short7(compareMode.sha)}` : `Between ${short7(compareMode.from)} and ${short7(compareMode.to)}`;
        const leftOf = (f) => (compareMode.kind === "commit"
            ? (f.letter === "A" || !commit?.parents?.length ? null : { rev: commit.parents[0], path: f.from ?? f.path, label: `${short7(newer)}^` })
            : (f.letter === "A" ? null : { rev: compareMode.from, path: f.from ?? f.path, label: short7(compareMode.from) }));
        const rightOf = (f) => (f.letter === "D" ? null : { rev: newer, path: f.path, label: short7(newer) });
        const keys = files.map((f) => `${title}\u0000${f.path}`);
        const tabKey = tabStopOf(keys, diffHere?.rowKey);
        const [added, removed] = gitTotals(files);
        return h("div", { className: "ps-ws-git-panel" },
            sincePicker(),
            h("div", { className: "ps-ws-git-summary" },
                h("span", null, files.length === 1 ? "1 file" : `${files.length} files`),
                h("span", { className: "ps-ws-spacer" }),
                ...gitCounts(added, removed)),
            commit ? h("div", { className: "ps-ws-git-note is-info" },
                h("span", { className: "ps-ws-git-note-title" }, commit.subject || "(no message)"),
                h("span", { className: "ps-ws-git-note-meta" }, `${commit.author} · ${gitDateTime(commit.time)}${commit.parents.length > 1 ? " · against the first parent" : ""}`)) : null,
            h("div", { className: "ps-ws-git-list", "aria-label": title, onKeyDown: onGitListKeys },
                !compareHere || compareHere.loading ? h("div", { className: "ps-ws-row is-muted" }, "Loading the changes…") : null,
                compareHere?.error ? h("div", { className: "ps-ws-row is-error" }, workspaceErrorText(compareHere.error)) : null,
                result && !files.length ? h("div", { className: "ps-ws-row is-muted" }, "No files changed.") : null,
                files.length ? h("div", { className: "ps-ws-git-group" }, h("span", null, title), h("span", { className: "ps-ws-git-group-count" }, String(files.length))) : null,
                files.map((f) => {
                    const rowKey = `${title}\u0000${f.path}`;
                    return gitFileRow(f, rowKey, {
                        onOpen: (one) => openDiff(diffSpec("changes", rowKey, one, leftOf(one), rightOf(one), compareMode.kind)),
                        selectable: false,
                        tabStop: rowKey === tabKey,
                    });
                }),
                result?.truncated ? h("div", { className: "ps-ws-row is-muted" }, "More files are not shown.") : null));
    };
    // ── Git: put the folder on a commit, go back, put stashed changes back ──
    const runCheckout = async (target, { stash = false } = {}) => {
        try {
            const result = await track(call({ op: "git", folder: folderId, what: "checkout", ...(gitRepo ? { repo: gitRepo } : {}), ...target, stash }));
            if (result.needsStash) {
                setDialog({ kind: "checkout", target, changes: result.changes, stash: true });
                return;
            }
            setDialog(null);
            if (!result.done) {
                say(result.error || "git did not move the folder", "error");
                return;
            }
            closeDiff();
            say(result.detached
                ? `The folder is at commit ${result.to} now${result.stashed ? "; your changes are stashed" : ""}`
                : `Back on ${result.to}${result.stashed ? "; your changes are stashed" : ""}`);
            checkNow();
        } catch (error) {
            setDialog(null);
            fail(error);
        }
    };
    // Ask first; with uncommitted changes, offer to stash them.
    const askCheckout = (target) => {
        const known = gitResult && gitResult.since === null ? (gitResult.files || []).length : null;
        if (target.branch && known === 0) {
            runCheckout(target);
            return;
        }
        setDialog({ kind: "checkout", target, changes: known ?? 0, stash: Boolean(known) });
    };
    const runRestore = async () => {
        try {
            const result = await track(call({ op: "git", folder: folderId, what: "restore", ...(gitRepo ? { repo: gitRepo } : {}) }));
            if (!result.done) {
                say(result.error || "git did not put the changes back", "error");
                return;
            }
            say("Your stashed changes are back");
            checkNow();
        } catch (error) {
            fail(error);
        }
    };
    const busyTitle = "The agent is in a turn in this folder: try again when it is idle";
    const showCommitChanges = (sha) => {
        changeSince(`commit:${sha}`);
        setSideTab("changes");
    };
    const renderChanges = () => {
        if (compareMode) return renderCompare();
        const files = gitResult?.files || [];
        const since = gitResult?.since ?? null;
        const stopped = gitResult?.state ?? null;
        const conflicts = files.filter((f) => f.letter === "C");
        // Each group counts its own part of a file that is in two groups.
        const groups = since
            ? [{ title: `Since ${since.label}`, kind: "since", files, counts: () => undefined }]
            : [
                ...(stopped ? [{ title: stopped === "merge" ? "Merge conflicts" : "Rebase conflicts", kind: "Changes", files: conflicts, counts: () => undefined }] : []),
                { title: "Staged", kind: "Staged", files: files.filter((f) => f.staged), counts: (f) => (f.staged_counts === undefined ? undefined : f.staged_counts) },
                { title: "Changes", kind: "Changes", files: files.filter((f) => f.unstaged && !(stopped && f.letter === "C")), counts: (f) => (f.unstaged_counts === undefined ? undefined : f.unstaged_counts) },
            ];
        const shown = groups.filter((g) => g.files.length);
        const keys = shown.flatMap((g) => g.files.map((f) => `${g.title}\u0000${f.path}`));
        const tabKey = tabStopOf(keys, diffHere?.rowKey);
        const [added, removed] = gitTotals(files);
        return h("div", { className: "ps-ws-git-panel" },
            sincePicker(),
            h("div", { className: "ps-ws-git-summary" },
                h("span", null, files.length === 1 ? "1 file" : `${files.length} files`),
                h("span", { className: "ps-ws-spacer" }),
                ...gitCounts(added, removed)),
            gitResult && gitResult.branch === null && gitResult.head ? h("div", { className: "ps-ws-git-note is-info", role: "status" },
                h("span", null, `The folder is at commit ${gitResult.head.slice(0, 7)} (a detached HEAD).${gitResult.stash ? " Your stashed changes come back after you return." : ""}`),
                gitResult.previousBranch ? h("button", { type: "button", className: "ps-ws-btn", disabled: turnRunning, title: turnRunning ? busyTitle : undefined, onClick: () => askCheckout({ branch: gitResult.previousBranch }) }, `Return to ${gitResult.previousBranch}`) : null) : null,
            gitResult?.stash && gitResult.branch ? h("div", { className: "ps-ws-git-note is-info", role: "status" },
                h("span", null, "Your changes from before a checkout are stashed."),
                h("button", { type: "button", className: "ps-ws-btn", disabled: turnRunning, title: turnRunning ? busyTitle : gitResult.stash.message, onClick: runRestore }, "Put them back")) : null,
            stopped ? h("div", { className: "ps-ws-git-note", role: "status" },
                `${stopped === "merge" ? "A merge" : "A rebase"} stopped: ${conflicts.length === 1 ? "1 file has a conflict" : `${conflicts.length} files have conflicts`}.`) : null,
            gitResult?.sinceError ? h("div", { className: "ps-ws-row is-error" }, gitResult.sinceError) : null,
            gitHere?.error ? h("div", { className: "ps-ws-row is-error" }, workspaceErrorText(gitHere.error)) : null,
            h("div", { className: "ps-ws-git-list", "aria-label": "Changed files", onKeyDown: onGitListKeys },
                !gitResult ? h("div", { className: "ps-ws-row is-muted" }, "Loading the changes…") : null,
                gitResult && files.length === 0 && !gitResult?.sinceError
                    ? h("div", { className: "ps-ws-row is-muted" }, since ? `Nothing changed since ${since.label}.` : "Nothing changed since the last commit.")
                    : null,
                shown.map((g) => h(React.Fragment, { key: g.title },
                    h("div", { className: "ps-ws-git-group" }, h("span", null, g.title), h("span", { className: "ps-ws-git-group-count" }, String(g.files.length))),
                    g.files.map((f) => {
                        const rowKey = `${g.title}\u0000${f.path}`;
                        return gitFileRow(f, rowKey, { onOpen: (one) => openChange(one, g.kind, rowKey), counts: g.counts(f), tabStop: rowKey === tabKey });
                    }))),
                gitResult?.truncated ? h("div", { className: "ps-ws-row is-muted" }, "More changed files are not shown.") : null));
    };
    const renderHistory = () => {
        const log = gitLog;
        const uncommitted = gitResult?.since === null ? gitCount : 0;
        const commits = log?.commits || [];
        const keys = [...(uncommitted ? ["wip"] : []), ...commits.map((c) => c.sha)];
        const tabKey = tabStopOf(keys, gitCommit?.sha);
        const picks = (gitKey && gitPicks[gitKey]) || [];
        const setPicks = (next) => setGitPicks((latest) => ({ ...latest, [gitKey]: next }));
        const togglePick = (sha) => setPicks(picks.includes(sha) ? picks.filter((one) => one !== sha) : [...picks, sha].slice(-2));
        const comparePicks = () => {
            // Older first: the list is newest first.
            const [from, to] = [...picks].sort((a, b) => commits.findIndex((c) => c.sha === b) - commits.findIndex((c) => c.sha === a));
            setPicks([]);
            changeSince(`range:${from}..${to}`);
            setSideTab("changes");
        };
        return h("div", { className: "ps-ws-git-panel" },
            picks.length ? h("div", { className: "ps-ws-git-pickbar", role: "toolbar", "aria-label": "Picked commits" },
                h("span", { className: "ps-ws-git-pickbar-text" }, picks.length === 2
                    ? `${short7(picks[0])} and ${short7(picks[1])}`
                    : `${short7(picks[0])} picked: Ctrl/⌘-click another commit to compare`),
                h("button", { type: "button", className: "ps-ws-btn is-primary", disabled: picks.length !== 2, onClick: comparePicks }, "Compare"),
                h("button", { type: "button", className: "ps-ws-btn", onClick: () => setPicks([]) }, "Clear")) : null,
            h("div", { className: "ps-ws-git-list", "aria-label": "Commits", onKeyDown: onGitListKeys },
                uncommitted ? h("button", { type: "button", tabIndex: tabKey === "wip" ? 0 : -1, className: "ps-ws-git-commit is-wip", onClick: () => setSideTab("changes") },
                    h("span", { className: "ps-ws-git-rail", "aria-hidden": true }),
                    h("span", { className: "ps-ws-git-commit-text" },
                        h("span", { className: "ps-ws-git-commit-subject" }, "Uncommitted changes"),
                        h("span", { className: "ps-ws-git-commit-meta" }, uncommitted === 1 ? "1 file" : `${uncommitted} files`))) : null,
                !log?.commits && !log?.error ? h("div", { className: "ps-ws-row is-muted" }, "Loading the commits…") : null,
                log?.error ? h("div", { className: "ps-ws-row is-error" }, workspaceErrorText(log.error)) : null,
                log?.commits && commits.length === 0 ? h("div", { className: "ps-ws-row is-muted" }, "No commits yet.") : null,
                commits.map((c) => {
                    const selected = gitCommit?.sha === c.sha;
                    const picked = picks.includes(c.sha);
                    return h("div", { key: c.sha, className: `ps-ws-git-commit-item${selected ? " is-selected" : ""}${picked ? " is-picked" : ""}` }, h("button", {
                        type: "button",
                        tabIndex: tabKey === c.sha ? 0 : -1,
                        className: `ps-ws-git-commit${selected ? " is-selected" : ""}${picked ? " is-picked" : ""}`,
                        "aria-pressed": selected,
                        title: `${c.subject}\n${c.author} <${c.email}>, ${gitDateTime(c.time)}\n${c.sha}\nCtrl/⌘- or Shift-click to pick two commits and compare them`,
                        onClick: (event) => {
                            if (event.metaKey || event.ctrlKey || event.shiftKey) togglePick(c.sha);
                            else pickCommit(c.sha);
                        },
                    },
                    h("span", { className: "ps-ws-git-rail", "aria-hidden": true }),
                    h("span", { className: "ps-ws-git-commit-text" },
                        h("span", { className: "ps-ws-git-commit-subject" }, c.subject || "(no message)"),
                        h("span", { className: "ps-ws-git-commit-meta" }, h("span", { className: "ps-ws-git-sha" }, c.short), ` · ${c.author} · ${gitTimeAgo(c.time)}`),
                        c.refs.length ? h("span", { className: "ps-ws-git-refs" }, c.refs.map((ref) => h("span", { key: ref, className: "ps-ws-git-ref" }, ref))) : null)),
                    h("button", {
                        type: "button",
                        tabIndex: -1,
                        className: "ps-ws-icon-btn ps-ws-git-commit-changes",
                        title: "Show this commit's changes in the Changes tab",
                        "aria-label": `Changes in commit ${c.short}`,
                        onClick: () => showCommitChanges(c.sha),
                    }, h(Icon, { d: PLUS_MINUS, size: 13 })));
                }),
                log?.more ? h("div", { className: "ps-ws-git-more", ref: olderRef },
                    h("button", { type: "button", className: "ps-ws-btn", disabled: Boolean(log.loading), onClick: () => loadGitLog(folderId, gitRepo, gitHead, { more: true }) }, log.loading ? "Loading…" : "Show older commits")) : null,
                commits.length && !log.more && !log.loading ? h("div", { className: "ps-ws-row is-muted ps-ws-git-end" }, "No older commits.") : null));
    };
    const renderCommit = () => {
        if (gitCommit.loading) return h("div", { className: "ps-ws-message" }, "Loading the commit…");
        if (gitCommit.error) return h("div", { className: "ps-ws-message is-error" }, workspaceErrorText(gitCommit.error));
        const c = gitCommit.result?.commit;
        if (!c) return h("div", { className: "ps-ws-message" }, gitCommit.result?.reason || "This commit could not be read.");
        const files = gitCommit.result.files || [];
        const [added, removed] = gitTotals(files);
        const keys = files.map((f) => `${c.sha}\u0000${f.path}`);
        const tabKey = tabStopOf(keys, diffHere?.rowKey);
        const copy = () => {
            Promise.resolve(navigator.clipboard?.writeText(c.sha)).then(() => say("Copied the commit id"), () => say("Could not copy the commit id", "error"));
        };
        const changed = files.length === 1 ? "1 file changed" : `${files.length} files changed`;
        return h("div", { className: "ps-ws-git-commit-view" },
            h("div", { className: "ps-ws-git-commit-head" },
                h("div", { className: "ps-ws-git-commit-title" }, c.subject || "(no message)"),
                c.body ? h("pre", { className: "ps-ws-git-commit-body" }, c.body) : null,
                h("div", { className: "ps-ws-git-commit-facts" },
                    h("span", { className: "ps-ws-git-commit-author", title: c.email }, c.author),
                    h("span", null, gitDateTime(c.time)),
                    h("span", { className: "ps-ws-git-sha", title: c.sha }, c.sha.slice(0, 12)),
                    h("button", { type: "button", className: "ps-ws-icon-btn", title: "Copy the commit id", "aria-label": "Copy the commit id", onClick: copy }, h(Icon, { d: COPY, size: 13 })),
                    c.parents.length
                        ? h("span", null, c.parents.length > 1 ? "parents " : "parent ",
                            c.parents.map((one) => h("button", { key: one, type: "button", className: "ps-ws-git-sha-link", title: `Open commit ${one.slice(0, 7)}`, onClick: () => pickCommit(one) }, one.slice(0, 7))))
                        : h("span", null, "the first commit")),
                c.refs.length ? h("div", { className: "ps-ws-git-refs" }, c.refs.map((ref) => h("span", { key: ref, className: "ps-ws-git-ref" }, ref))) : null,
                h("div", { className: "ps-ws-git-commit-actions" },
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => showCommitChanges(c.sha) }, "Show in Changes"),
                    gitResult?.head === c.sha
                        ? h("button", { type: "button", className: "ps-ws-btn", disabled: true, title: "The folder is at this commit" }, "Checked out")
                        : h("button", {
                            type: "button",
                            className: "ps-ws-btn",
                            disabled: turnRunning,
                            title: turnRunning ? busyTitle : "Put the folder on this commit, to see and run it as it was",
                            onClick: () => askCheckout({ sha: c.sha }),
                        }, "Check out this commit"),
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => { changeSince(c.sha); setSideTab("changes"); } }, "Show changes since this commit"))),
            h("div", { className: "ps-ws-git-summary" },
                h("span", null, c.parents.length > 1 ? `${changed}, against the first parent` : changed),
                h("span", { className: "ps-ws-spacer" }),
                ...gitCounts(added, removed)),
            h("div", { className: "ps-ws-git-list", onKeyDown: onGitListKeys },
                files.map((f) => {
                    const rowKey = `${c.sha}\u0000${f.path}`;
                    return gitFileRow(f, rowKey, { onOpen: (one) => openDiff(commitSpec(c, one, rowKey)), selectable: false, tabStop: rowKey === tabKey });
                }),
                gitCommit.result.truncated ? h("div", { className: "ps-ws-row is-muted" }, "More files are not shown.") : null));
    };
    const renderDiff = () => {
        const d = diffHere;
        const name = baseName(d.path);
        const sides = d.left && d.right ? `${d.left.label} ↔ ${d.right.label}` : d.right ? `${d.right.label}, added` : `${d.left.label}, deleted`;
        // The file on one side only: shown once, whole, tinted.
        const whole = d.left ? (d.right ? null : "deleted") : "added";
        const fits = !viewerWidth || viewerWidth >= DIFF_SPLIT_MIN_WIDTH;
        const layout = fits ? diffLayout : "inline";
        const back = d.source === "history" && Boolean(gitCommit);
        const same = !d.loading && !d.error && d.original?.text !== undefined && d.original?.text === d.modified?.text;
        const message = d.loading ? `Loading the changes in ${name}…`
            : d.error ? null
            : d.original?.binary || d.modified?.binary ? `${name} is a binary file: there is no text diff to show.`
            : d.original?.tooLarge || d.modified?.tooLarge ? `${name} is too large to compare here (over ${formatBytes(DIFF_MAX_BYTES)}).`
            : same && d.from ? `Renamed from ${d.from}. The content did not change.`
            : same && whole ? "The file is empty."
            : same ? "No text changed: only the file's mode or attributes did."
            : null;
        const showsDiff = !d.loading && !d.error && message === null;
        const body = d.error ? h("div", { className: "ps-ws-message is-error" }, workspaceErrorText(d.error))
            : message !== null ? h("div", { className: "ps-ws-message" }, message)
            : h(DiffEditor, {
                key: `${d.key}\u0000${layout}`,
                original: d.original.text,
                modified: d.modified.text,
                name,
                layout,
                whole,
                onReady: (handle) => { diffHandle.current = handle; },
            });
        return h(React.Fragment, null,
            h("div", { className: "ps-ws-viewer-bar ps-ws-diff-bar" },
                back ? h("button", { type: "button", className: "ps-ws-icon-btn", title: "Back to the commit", "aria-label": "Back to the commit", onClick: closeDiffAndFocus }, h(Icon, { d: BACK })) : null,
                h("span", { className: `ps-ws-git-letter is-git-${d.letter}`, title: GIT_WORDS[d.letter] }, d.letter),
                h("span", { className: "ps-ws-crumbs", title: `${d.from ? `${d.from} → ` : ""}${d.path} (${sides})` },
                    h("span", { className: "ps-ws-crumb-leaf" }, name),
                    d.from ? h("span", { className: "ps-ws-git-from" }, `← ${shortPath(d.from, d.path)}`) : null,
                    h("span", { className: "ps-ws-diff-sides" }, ` (${sides})`)),
                h("span", { className: "ps-ws-spacer" }),
                showsDiff && !whole ? h("span", { className: "ps-ws-seg", role: "group", "aria-label": "Diff layout" },
                    h("button", {
                        type: "button",
                        className: layout === "split" ? "is-on" : "",
                        "aria-pressed": layout === "split",
                        disabled: !fits,
                        title: fits ? "Side by side" : "Side by side needs a wider viewer",
                        onClick: () => chooseDiffLayout("split"),
                    }, "Side by side"),
                    h("button", { type: "button", className: layout === "inline" ? "is-on" : "", "aria-pressed": layout === "inline", onClick: () => chooseDiffLayout("inline") }, "Inline")) : null,
                showsDiff && !whole ? h("button", { type: "button", className: "ps-ws-icon-btn", title: "Previous change", "aria-label": "Previous change", onClick: () => diffHandle.current?.previous?.() }, h(Icon, { d: ARROW_UP })) : null,
                showsDiff && !whole ? h("button", { type: "button", className: "ps-ws-icon-btn", title: "Next change", "aria-label": "Next change", onClick: () => diffHandle.current?.next?.() }, h(Icon, { d: ARROW_DOWN })) : null,
                d.right ? h("button", {
                    type: "button",
                    className: "ps-ws-icon-btn",
                    title: d.source === "history" ? "Open the file as it is now" : "Open the file",
                    "aria-label": "Open the file",
                    onClick: () => {
                        if (d.source === "history") setSideTab("files");
                        openFile(folderId, inRepo(d.repo, d.path));
                    },
                }, h(Icon, { d: OPEN_FILE })) : null,
                back ? null : h("button", { type: "button", className: "ps-ws-icon-btn", title: "Close the diff", "aria-label": "Close the diff", onClick: closeDiffAndFocus }, h(Icon, { d: CLOSE }))),
            h("div", { className: "ps-ws-viewer-body" }, body));
    };
    const commitView = gitTab !== "history" ? null
        : gitCommit ? renderCommit()
        : h("div", { className: "ps-ws-message" }, "Pick a commit to see what it changed.");

    const viewer = (() => {
        if (!file) {
            return h("div", { className: "ps-ws-message" },
                "Pick a file to open it. Drop files from your computer onto a folder to upload them.");
        }
        if (file.kind === "loading") return h("div", { className: "ps-ws-message" }, `Opening ${file.name}…`);
        if (file.kind === "error") return h("div", { className: "ps-ws-message is-error" }, workspaceErrorText(file.error));
        if (file.kind === "toolarge") {
            return h("div", { className: "ps-ws-message" },
                `${file.name} is ${formatBytes(file.size)}. Files over ${formatBytes(info.maxBytes)} cannot be opened or downloaded here.`);
        }
        if (file.kind === "image") {
            return h("div", { className: "ps-ws-image" },
                h("img", {
                    src: file.url,
                    alt: file.name,
                    onLoad: (event) => {
                        const { naturalWidth, naturalHeight } = event.currentTarget;
                        setFile((current) => (current?.url === file.url ? { ...current, dimensions: `${naturalWidth} × ${naturalHeight}` } : current));
                    },
                }));
        }
        if (file.kind === "binary") {
            return h("div", { className: "ps-ws-message" },
                file.notText
                    ? `${file.name} is not UTF-8 text (${formatBytes(file.size)}), so it cannot be edited here: saving would change its bytes. `
                    : `${file.name} is a binary file (${formatBytes(file.size)}). `,
                h("button", { type: "button", className: "ps-ws-link-btn", onClick: () => downloadBytes(file.bytes, file.name) }, "Download it"));
        }
        if (compare) {
            // The hint and the two ways out on their own line: in the header
            // they squeezed out the file name.
            return h(React.Fragment, null,
                h("div", { className: "ps-ws-compare-bar" },
                    h("span", { className: "ps-ws-compare-hint", role: "note" }, "Left: on disk now. Right: yours. The arrows copy a change into yours."),
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => setCompare(null) }, "Cancel"),
                    h("button", { type: "button", className: "ps-ws-btn is-primary", onClick: saveCompared }, "Save mine")),
                h(CompareEditor, {
                    key: `compare:${file.path}`,
                    theirs: compare.theirsText,
                    mine: file.text,
                    name: file.name,
                    lineSeparator: file.crlf ? "\r\n" : null,
                    onReady: (handle) => { compareHandle.current = handle; },
                }));
        }
        const where = positions.current[dirKey(file.folderId, file.path)];
        if (isMarkdown(file.name) && mdMode === "preview") {
            return h(MarkdownPreview, {
                key: `${file.folderId}:${file.path}`,
                text: file.text,
                resolveImage,
                onOpenLink: openLink,
                scrollTop: Number(where?.top) || 0,
                onScrollTop: (top) => rememberPosition(file.folderId, file.path, { top }),
            });
        }
        return h(CodeEditor, {
            docKey: file.docKey,
            initialText: file.text,
            name: file.name,
            readOnly: Boolean(file.readOnly),
            onChange: onEdit,
            onSave: save,
            position: where ? { line: where.line, cursor: where.cursor } : null,
            onPosition: (at) => rememberPosition(file.folderId, file.path, at),
            onReady: (handle) => { editorHandle.current = handle; },
            lineSeparator: file.crlf ? "\r\n" : null,
        });
    })();

    const viewerBar = file && file.kind !== "loading" ? h("div", { className: "ps-ws-viewer-bar" },
        h("span", { className: "ps-ws-crumbs", title: file.path },
            h("span", { className: "ps-ws-crumb-folder" }, folders.find((f) => f.id === file.folderId)?.name ?? ""),
            file.path.split("/").map((part, index, parts) => h(React.Fragment, { key: index },
                h("span", { className: "ps-ws-crumb-sep" }, "›"),
                h("span", { className: index === parts.length - 1 ? "ps-ws-crumb-leaf" : undefined }, part)))),
        file.dirty ? h("span", { className: "ps-ws-dirty", title: "Unsaved changes" }, "●") : null,
        file.readOnly ? h("span", { className: "ps-ws-pill" }, "Read-only") : null,
        file.kind === "image" ? h("span", { className: "ps-ws-pill" }, [file.dimensions, formatBytes(file.size)].filter(Boolean).join(" · ")) : null,
        h("span", { className: "ps-ws-spacer" }),
        file.kind === "text" && isMarkdown(file.name) && !compare ? h("span", { className: "ps-ws-seg", role: "group", "aria-label": "Markdown view" },
            h("button", { type: "button", className: mdMode === "edit" ? "is-on" : "", "aria-pressed": mdMode === "edit", onClick: () => setMdMode("edit") }, "Edit"),
            h("button", { type: "button", className: mdMode === "preview" ? "is-on" : "", "aria-pressed": mdMode === "preview", onClick: () => setMdMode("preview") }, "Preview")) : null,
        gitMarks && file.kind === "text" && !compare && file.folderId === folderId && gitMarks.letter(file.path) ? h("button", {
            type: "button",
            className: "ps-ws-icon-btn",
            title: "Open Changes: this file's diff",
            "aria-label": "Open Changes",
            onClick: () => openChangesFor(file.path),
        }, h(Icon, { d: PLUS_MINUS })) : null,
        file.kind === "text" && !compare && !(isMarkdown(file.name) && mdMode === "preview") ? h("button", {
            type: "button",
            className: "ps-ws-icon-btn",
            title: "Find in file (Ctrl+F / ⌘F)",
            "aria-label": "Find in file",
            onClick: () => editorHandle.current?.find(),
        }, h(Icon, { d: SEARCH })) : null,
        file.kind === "text" && !compare && !file.readOnly ? h("button", {
            type: "button",
            className: `ps-ws-btn${file.dirty ? " is-primary" : ""}`,
            disabled: !file.dirty || busy > 0,
            onClick: save,
            title: "Save (Ctrl+S / ⌘S)",
        }, "Save") : null,
        file.kind !== "error" && file.kind !== "toolarge" ? h("button", { type: "button", className: "ps-ws-icon-btn", title: "Download", "aria-label": "Download this file", onClick: () => downloadEntry(file.folderId, file.path, false) }, h(Icon, { d: DOWNLOAD })) : null) : null;

    const agentOnOpen = file && agentEditing.has(dirKey(file.folderId, file.path));
    const banner = h(React.Fragment, null,
        agentOnOpen ? h("div", { className: "ps-ws-banner is-agent", role: "status" }, "The agent is editing this file. Its changes show here when it finishes.") : null,
        file?.changedOnDisk && !compare
            ? h("div", { className: "ps-ws-banner", role: "status" }, "This file changed on disk since you started editing. Saving will ask how to combine the changes.")
            : null);

    const dialogBox = (() => {
        if (!dialog) return null;
        // Modal, with focus inside: on the safe choice (the primary one, or Cancel).
        if (dialog.kind === "conflict") {
            if (dialog.theirsText === null) {
                return h("div", { className: "ps-ws-dialog", role: "dialog", "aria-modal": "true", "aria-label": "The file changed", ref: focusDialog },
                    h("strong", null, "This file changed since you opened it"),
                    h("p", null, `${file?.name} on disk is not UTF-8 text now, so there is nothing to compare. Keep yours, or cancel and keep editing.`),
                    h("div", { className: "ps-ws-dialog-actions" },
                        h("button", { type: "button", className: "ps-ws-btn is-primary", onClick: () => setDialog(null) }, "Cancel"),
                        h("button", { type: "button", className: "ps-ws-btn", onClick: () => resolveConflict("mine") }, "Keep mine")));
            }
            return h("div", { className: "ps-ws-dialog", role: "dialog", "aria-modal": "true", "aria-label": "The file changed", ref: focusDialog },
                h("strong", null, "This file changed since you opened it"),
                h("p", null, `Someone, or the agent, saved ${file?.name} after you opened it.`),
                h("div", { className: "ps-ws-dialog-actions" },
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => resolveConflict("compare") }, "Compare"),
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => resolveConflict("mine") }, "Keep mine"),
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => resolveConflict("theirs") }, "Take theirs"),
                    h("button", { type: "button", className: "ps-ws-btn is-primary", onClick: () => resolveConflict("both") }, "Keep both")));
        }
        if (dialog.kind === "checkout") {
            const target = dialog.target;
            const short = target.sha ? target.sha.slice(0, 7) : "";
            return h("div", { className: "ps-ws-dialog", role: "dialog", "aria-modal": "true", "aria-label": target.sha ? `Check out commit ${short}` : `Return to ${target.branch}`, ref: focusDialog },
                h("strong", null, target.sha ? `Check out commit ${short}?` : `Return to ${target.branch}?`),
                h("p", null, target.sha
                    ? "The folder will show the files as they were at that commit (a detached HEAD). Your branch stays as it is, and you can return to it."
                    : "The folder goes back to the branch."),
                dialog.stash ? h("p", null, `You have ${dialog.changes === 1 ? "1 uncommitted change" : `${dialog.changes} uncommitted changes`}, untracked files included. They will be stashed. After you return, "Put them back" restores them.`) : null,
                h("div", { className: "ps-ws-dialog-actions" },
                    h("button", { type: "button", className: "ps-ws-btn is-primary", onClick: () => setDialog(null) }, "Cancel"),
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => runCheckout(target, { stash: Boolean(dialog.stash) }) }, dialog.stash ? "Stash and check out" : "Check out")));
        }
        if (dialog.kind === "deleted") {
            return h("div", { className: "ps-ws-dialog", role: "dialog", "aria-modal": "true", "aria-label": "The file was deleted", ref: focusDialog },
                h("strong", null, "This file was deleted"),
                h("p", null, "It was deleted after you opened it. Save yours as a new file, or let it go."),
                h("div", { className: "ps-ws-dialog-actions" },
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => { setDialog(null); drafts.delete(draftKey(sessionId, file.folderId, file.path)); setFile(null); } }, "Let it go"),
                    h("button", { type: "button", className: "ps-ws-btn is-primary", onClick: async () => { setDialog(null); try { await track(writeText(file, file.text, null)); say(`Saved ${file.name}`); } catch (error) { fail(error); } } }, "Save as new")));
        }
        if (dialog.kind === "delete") {
            const items = dialog.items || [];
            const one = items.length === 1 ? items[0] : null;
            const names = items.slice(0, 5).map((item) => baseName(item.path)).join(", ") + (items.length > 5 ? `, and ${items.length - 5} more` : "");
            return h("div", { className: "ps-ws-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Delete", ref: focusDialog },
                h("strong", null, one ? `Delete ${baseName(one.path)}?` : `Delete ${items.length} items?`),
                one ? null : h("p", null, names),
                h("p", null, items.some((item) => item.isDir) ? "Folders are deleted with everything in them. This cannot be undone." : "This cannot be undone."),
                h("div", { className: "ps-ws-dialog-actions" },
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => setDialog(null) }, "Cancel"),
                    h("button", { type: "button", className: "ps-ws-btn is-danger", onClick: confirmDelete }, "Delete")));
        }
        if (dialog.kind === "exists") {
            return h("div", { className: "ps-ws-dialog", role: "dialog", "aria-modal": "true", "aria-label": "File exists", ref: focusDialog },
                h("strong", null, `${dialog.name} is already there`),
                h("p", null, `There is already a file with this name in ${dialog.dir || "this folder"}.`),
                h("div", { className: "ps-ws-dialog-actions" },
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => dialog.resolve("skip") }, "Skip"),
                    h("button", { type: "button", className: "ps-ws-btn", onClick: () => dialog.resolve("replace") }, "Replace"),
                    h("button", { type: "button", className: "ps-ws-btn is-primary", onClick: () => dialog.resolve("both") }, "Keep both")));
        }
        return null;
    })();

    const folderIcon = (f) => (f.home ? HOME : f.role === "working" ? FOLDER : f.name === "shared" ? PEOPLE : FOLDER);

    return h("div", { className: "ps-ws-pane", "data-own-keys": "" },
        h("div", { className: "ps-ws-chips", role: "tablist", "aria-label": "The session's folders" },
            folders.map((f) => h("button", {
                key: f.id,
                type: "button",
                role: "tab",
                className: `ps-ws-chip${f.id === folderId ? " is-on" : ""}`,
                "aria-selected": f.id === folderId,
                disabled: !f.available,
                title: f.available ? `${f.root}${f.folder ? `/${f.folder}` : ""}`
                    : f.opened === false ? "The session's worker has not opened this folder yet. It opens at the session's next turn."
                    : `This portal does not serve the "${f.root}" root`,
                onClick: () => switchFolder(f.id),
            },
            h(Icon, { d: folderIcon(f), size: 13 }),
            h("span", null, f.name),
            f.role === "working" ? h("span", { className: "ps-ws-chip-note" }, "working folder") : f.home ? h("span", { className: "ps-ws-chip-note" }, "your folder") : null))),
        folder ? h("div", { className: "ps-ws-toolbar" },
            h("span", { className: "ps-ws-folder-path", title: `${folder.root}${folder.folder ? `/${folder.folder}` : ""}` }, `${folder.root}${folder.folder ? `/${folder.folder}` : ""}`),
            rootReadOnly ? h("span", { className: "ps-ws-pill" }, "Read-only") : null,
            gitOn && (repoChoices.length > 1 || noRepoPicked) ? h("select", {
                className: `ps-ws-git-repo-select${noRepoPicked ? " is-none" : ""}`,
                "aria-label": "Repository",
                title: noRepoPicked ? "Nothing picked is inside a repository" : "The repository git shows",
                value: gitRepo ?? NO_REPO,
                onChange: (event) => chooseRepo(event.currentTarget.value === NO_REPO ? null : event.currentTarget.value),
            },
                noRepoPicked ? h("option", { value: NO_REPO }, "No repository") : null,
                repoChoices.map((repo) => h("option", { key: repo, value: repo }, repo || `${folder?.name ?? "this folder"} (the folder itself)`))) : null,
            gitReady && gitRepo && repoChoices.length === 1 ? h("span", { className: "ps-ws-git-repo-name", title: `The repository in ${gitRepo}` }, baseName(gitRepo)) : null,
            gitReady && !gitResult ? h("span", { className: "ps-ws-branch is-loading", "aria-busy": true }, h(Icon, { d: BRANCH, size: 12 }), h("span", { className: "ps-ws-branch-name" }, "…"))
            : gitReady ? h("button", {
                type: "button",
                className: "ps-ws-branch",
                title: [
                    gitResult.branch ? `Branch ${gitResult.branch}` : `No branch: HEAD is at ${(gitResult.head || "").slice(0, 7)}`,
                    gitResult.upstream ? `${gitResult.ahead} ahead of ${gitResult.upstream}, ${gitResult.behind} behind` : "No upstream branch",
                    "Show the commits",
                ].join("\n"),
                onClick: () => setSideTab("history"),
            },
                h(Icon, { d: BRANCH, size: 12 }),
                h("span", { className: "ps-ws-branch-name" }, gitResult.branch || `detached at ${(gitResult.head || "").slice(0, 7)}`),
                gitResult.ahead ? h("span", { className: "ps-ws-branch-ab" }, `↑${gitResult.ahead}`) : null,
                gitResult.behind ? h("span", { className: "ps-ws-branch-ab" }, `↓${gitResult.behind}`) : null,
                gitResult.upstream && !gitResult.ahead && !gitResult.behind ? h("span", { className: "ps-ws-branch-ab", "aria-label": `in sync with ${gitResult.upstream}` }, "✓") : null,
                gitResult.branch && !gitResult.upstream ? h("span", { className: "ps-ws-branch-ab" }, "not pushed") : null)
            : gitOn && gitResult?.repo && gitResult.available === false ? h("span", { className: "ps-ws-pill", title: gitResult.reason || "" }, "Git off")
            : null,
            gitReady && gitResult && gitResult.branch === null && gitResult.previousBranch ? h("button", {
                type: "button",
                className: "ps-ws-btn ps-ws-git-return",
                disabled: turnRunning,
                title: turnRunning ? busyTitle : `The folder is at commit ${(gitResult.head || "").slice(0, 7)}. Go back to ${gitResult.previousBranch}.`,
                onClick: () => askCheckout({ branch: gitResult.previousBranch }),
            }, `Return to ${gitResult.previousBranch}`)
            : gitOn && reposHere && repoChoices.length === 0 ? h("span", { className: "ps-ws-pill ps-ws-no-git", title: "No git repository in this folder or the folders inside it (3 levels down)." }, "No git") : null,
            h("span", { className: "ps-ws-spacer" }),
            busy > 0 ? h("span", { className: "ps-ws-busy", "aria-live": "polite" }, "Working…") : null,
            !rootReadOnly ? h("button", { type: "button", className: "ps-ws-icon-btn", title: "Upload files", "aria-label": "Upload files", onClick: () => { uploadDir.current = ""; uploadInput.current?.click(); } }, h(Icon, { d: UPLOAD })) : null,
            !rootReadOnly ? h("button", { type: "button", className: "ps-ws-icon-btn", title: "New file (in the picked folder)", "aria-label": "New file", onClick: () => newHere("newFile") }, h(Icon, { d: PLUS_FILE })) : null,
            !rootReadOnly ? h("button", { type: "button", className: "ps-ws-icon-btn", title: "New folder (in the picked folder)", "aria-label": "New folder", onClick: () => newHere("newFolder") }, h(Icon, { d: PLUS_FOLDER })) : null,
            h("button", {
                type: "button",
                className: `ps-ws-icon-btn${selectMode ? " is-on" : ""}`,
                title: selectMode ? "Stop selecting" : "Select several (or Cmd/Ctrl-click, Shift-click)",
                "aria-label": "Select several",
                "aria-pressed": selectMode,
                onClick: () => { setSelectMode((on) => !on); if (selectMode) setPicked(new Set()); },
            }, h(Icon, { d: CHECKS })),
            h("button", { type: "button", className: "ps-ws-icon-btn", title: "Download the folder as .zip", "aria-label": "Download the folder as .zip", onClick: () => downloadEntry(folder.id, "", true) }, h(Icon, { d: DOWNLOAD })),
            h("button", {
                type: "button",
                className: "ps-ws-icon-btn",
                title: "Refresh",
                "aria-label": "Refresh",
                onClick: () => {
                    if (folderId && gitOn) loadGitRepos(folderId);
                    refresh();
                },
            }, h(Icon, { d: REFRESH })),
            h("input", {
                ref: uploadInput,
                type: "file",
                multiple: true,
                hidden: true,
                onChange: (event) => {
                    const list = event.currentTarget.files;
                    if (list?.length) uploadFiles(folder.id, uploadDir.current, list);
                    event.currentTarget.value = "";
                },
            })) : null,
        h("div", {
            className: "ps-ws-main",
            ref: mainRef,
            style: {
                ...(split.width != null ? { "--ps-ws-tree-width": `${split.width}px` } : {}),
                ...(split.height != null ? { "--ps-ws-tree-height": `${split.height}px` } : {}),
            },
        },
            h("div", { className: "ps-ws-side" },
                gitTabs,
                gitTab === "changes" ? renderChanges() : gitTab === "history" ? renderHistory() : h(React.Fragment, null,
                folder ? h("div", { className: "ps-ws-finder" },
                    h(Icon, { d: SEARCH, size: 12 }),
                    h("input", {
                        className: "ps-ws-finder-input",
                        type: "text",
                        value: findText,
                        placeholder: "Find files",
                        spellCheck: false,
                        "aria-label": `Find files in ${folder.name}`,
                        role: "combobox",
                        "aria-autocomplete": "list",
                        "aria-expanded": Boolean(findText.trim()),
                        "aria-controls": `${idBase}-found`,
                        ...(found?.matches?.[foundIndex] ? { "aria-activedescendant": `${idBase}-found-${foundIndex}` } : {}),
                        onChange: (event) => setFindText(event.currentTarget.value),
                        onKeyDown: (event) => {
                            const matches = found?.matches || [];
                            if (event.key === "Escape") {
                                if (!findText) return;
                                event.preventDefault();
                                event.stopPropagation();
                                setFindText("");
                            } else if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setFoundIndex((index) => Math.max(0, Math.min(matches.length - 1, index + 1)));
                            } else if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setFoundIndex((index) => Math.max(0, index - 1));
                            } else if (event.key === "Enter" && found && !found.loading && found.query === findText.trim() && matches[foundIndex]) {
                                event.preventDefault();
                                reveal(folder.id, matches[foundIndex].path, matches[foundIndex].kind === "dir");
                            }
                        },
                    }),
                    findText ? h("button", { type: "button", className: "ps-ws-finder-clear", title: "Clear", "aria-label": "Clear the search", onClick: () => setFindText("") }, "✕") : null) : null,
                folder && findText.trim()
                    ? h("div", { className: "ps-ws-found", role: "listbox", id: `${idBase}-found`, "aria-label": `Files matching ${findText.trim()}` },
                        found?.error ? h("div", { className: "ps-ws-row is-error" }, workspaceErrorText(found.error)) : null,
                        !found?.matches && !found?.error ? h("div", { className: "ps-ws-row is-muted" }, "Looking…") : null,
                        (found?.matches || []).map((match, index) => {
                            const at = match.path.lastIndexOf("/");
                            return h("div", {
                                key: match.path,
                                id: `${idBase}-found-${index}`,
                                role: "option",
                                "aria-selected": index === foundIndex,
                                className: `ps-ws-row ps-ws-found-row${index === foundIndex ? " is-selected" : ""}`,
                                title: match.path,
                                onMouseEnter: () => setFoundIndex(index),
                                onClick: () => reveal(folder.id, match.path, match.kind === "dir"),
                            },
                            h("span", { className: "ps-ws-row-icon", "aria-hidden": true }, h(Icon, { d: match.kind === "dir" ? FOLDER : FILE, size: 13 })),
                            h("span", { className: "ps-ws-row-name" }, at < 0 ? match.path : match.path.slice(at + 1)),
                            at > 0 ? h("span", { className: "ps-ws-found-dir" }, match.path.slice(0, at)) : null);
                        }),
                        found && !found.loading && !found.error && found.matches?.length === 0 ? h("div", { className: "ps-ws-row is-muted" }, "No file or folder name has these words.") : null,
                        found?.truncated ? h("div", { className: "ps-ws-row is-muted" }, "More match: type more of the name.") : null)
                    : h(React.Fragment, null,
                        picked.size > 1 || selectMode ? h("div", { className: "ps-ws-picked-bar", role: "toolbar", "aria-label": "Selected items" },
                            h("span", { className: "ps-ws-picked-count" }, `${picked.size} selected`),
                            h("button", { type: "button", className: "ps-ws-btn", disabled: picked.size === 0, onClick: () => downloadPicked(pickedItems()) }, "Download"),
                            h("button", {
                                type: "button",
                                className: "ps-ws-btn is-danger",
                                disabled: picked.size === 0 || rootReadOnly,
                                onClick: () => setDialog({ kind: "delete", items: pickedItems() }),
                            }, "Delete"),
                            h("button", { type: "button", className: "ps-ws-btn", onClick: () => { setPicked(new Set()); setSelectMode(false); } }, "Clear")) : null,
                        h("div", {
                            ref: treeRef,
                            className: `ps-ws-tree${folder && dropTarget === dirKey(folder.id, "") ? " is-drop" : ""}${selectMode ? " is-selecting" : ""}`,
                            role: "tree",
                            "aria-label": folder ? `Files in ${folder.name}` : "Files",
                            "aria-multiselectable": true,
                            onScroll: onTreeScroll,
                            onKeyDown: onTreeKeyDown,
                            ...(folder && !rootReadOnly ? dropProps(folder.id, "") : {}),
                        }, folder && !folder.available
                            ? h("div", { className: "ps-ws-message" }, folder.opened === false
                                ? `${folder.root}${folder.folder ? `/${folder.folder}` : ""} opens at the session's next turn.`
                                : `This portal does not serve the "${folder.root}" root.`)
                            : folder ? renderDir(folder.id, "", 0) : null)))),
            h(Splitter, { mainRef, split, stacked, onChange: changeSplit }),
            h("div", { className: "ps-ws-viewer", ref: viewerRef },
                diffHere ? renderDiff() : commitView || h(React.Fragment, null,
                    viewerBar,
                    banner,
                    h("div", { className: "ps-ws-viewer-body" }, viewer)),
                dialogBox)),
        notice ? h("div", { className: `ps-ws-notice${notice.kind === "error" ? " is-error" : ""}`, role: notice.kind === "error" ? "alert" : "status" }, notice.text) : null);
}
