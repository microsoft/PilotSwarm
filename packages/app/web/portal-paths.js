const BASE_META = '<meta name="pilotswarm-base-path" content="/" />';
const BASE_ELEMENT = '<base href="/" />';
const CONTROL = /[\u0000-\u001f\u007f]/u;

export function normalizePortalBasePath(value = "/") {
    if (typeof value !== "string") throw new TypeError("PORTAL_BASE_PATH must be a string.");
    if (value === "" || value === "/") return "/";
    const base = value.endsWith("/") ? value.slice(0, -1) : value;
    if (!base.startsWith("/") || base.slice(1).split("/").some(
        (segment) => !/^[A-Za-z0-9._~-]+$/u.test(segment) || segment === "." || segment === "..",
    )) {
        throw new Error("PORTAL_BASE_PATH must be / or unreserved ASCII path segments without empty or dot segments.");
    }
    return base;
}

function canonicalSegment(segment) {
    let decoded;
    try {
        decoded = decodeURIComponent(segment);
    } catch (error) {
        if (error instanceof URIError) return false;
        throw error;
    }
    // Inspect nested escapes without using their decoded value for routing.
    // Each pass shrinks the input; cap nesting rather than normalizing aliases.
    for (let depth = 0; depth < 8; depth++) {
        if (decoded === "." || decoded === ".." || /[/\\]/u.test(decoded) || CONTROL.test(decoded)) return false;
        const next = decoded.replace(/%([0-9a-f]{2})/giu, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
        if (next === decoded) return true;
        decoded = next;
    }
    return false;
}

/** Inspect the original request target before any URL or router normalization. */
export function canonicalRequestPath(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl.startsWith("/") || CONTROL.test(rawUrl)) return null;
    const pathname = rawUrl.split("?", 1)[0];
    if (pathname.includes("#") || pathname.includes("\\") || pathname.includes("//") || pathname.includes(" ")) return null;
    if (!pathname.split("/").every(canonicalSegment)) return null;
    return pathname;
}

export function createPortalPaths(value = "/") {
    const basePath = normalizePortalBasePath(value);
    const mountPath = basePath === "/" ? "" : basePath;
    const entryPath = `${mountPath}/`;

    function contains(rawUrl) {
        const pathname = canonicalRequestPath(rawUrl);
        return pathname !== null && (!mountPath || pathname === mountPath || pathname.startsWith(entryPath));
    }

    function localPath(rawUrl) {
        return contains(rawUrl) ? canonicalRequestPath(rawUrl).slice(mountPath.length) || "/" : null;
    }

    function path(localUrl = "/") {
        if (typeof localUrl !== "string" || CONTROL.test(localUrl)) throw new TypeError("Portal path must be a local URL.");
        const delimiter = localUrl.search(/[?#]/u);
        const pathname = delimiter < 0 ? localUrl : localUrl.slice(0, delimiter);
        if (canonicalRequestPath(pathname) === null) throw new Error("Portal path must be a canonical absolute local path.");
        return `${mountPath}${localUrl}`;
    }

    function redirect(rawUrl) {
        const pathname = canonicalRequestPath(rawUrl);
        if (!mountPath || pathname !== mountPath) return null;
        return `${entryPath}${rawUrl.slice(pathname.length)}`;
    }

    return Object.freeze({ basePath, mountPath, entryPath, contains, localPath, path, redirect });
}

export function isLegacyPortalPath(rawUrl) {
    const pathname = canonicalRequestPath(rawUrl);
    if (pathname === null) return false;
    const decoded = decodeURIComponent(pathname);
    return decoded === "/app.js" || decoded === "/public" || decoded.startsWith("/public/");
}

export function isPortalNavigationPath(rawUrl) {
    const pathname = canonicalRequestPath(rawUrl);
    if (pathname === null || isLegacyPortalPath(pathname)) return false;
    const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments.some((segment) => segment.startsWith("."))) return false;
    if (/^(?:api|assets|src|node_modules|portal-ws|__portal_hmr|@vite|@id|@fs|@react-refresh)$/iu.test(segments[0] || "")) return false;
    return !segments.at(-1)?.includes(".");
}

/** Only portal index.html uses these markers; never apply this to canvas HTML. */
export function renderPortalShell(html, paths) {
    if (html.split(BASE_META).length !== 2 || html.split(BASE_ELEMENT).length !== 2) {
        throw new Error("Portal shell is missing its unique base-path bootstrap markers; rebuild the browser bundle.");
    }
    const entry = createPortalPaths(paths.basePath).entryPath;
    return html
        .replace(BASE_META, `<meta name="pilotswarm-base-path" content="${entry}" />`)
        .replace(BASE_ELEMENT, `<base href="${entry}" />`);
}

export function composePortalAuthConfig(config, basePath = "/") {
    const paths = createPortalPaths(basePath);
    const redirectUri = config?.client?.redirectUri;
    if (!paths.mountPath || typeof redirectUri !== "string") return config;
    const parsed = new URL(redirectUri);
    if (parsed.pathname !== "/") return config;
    const delimiter = redirectUri.search(/[?#]/u);
    const location = delimiter < 0 ? redirectUri : redirectUri.slice(0, delimiter);
    const suffix = delimiter < 0 ? "" : redirectUri.slice(delimiter);
    const authority = location.endsWith("/") ? location.slice(0, -1) : location;
    return {
        ...config,
        client: { ...config.client, redirectUri: `${authority}${paths.entryPath}${suffix}` },
    };
}
