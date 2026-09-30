// The Workspace pane's markdown preview (read-only): GitHub-flavored
// markdown through `marked`, made safe with `dompurify`. Loaded only when a
// markdown file is shown in Preview.
//
// Nothing loads from elsewhere by default: images (from the internet or from
// other files) stay placeholders until the person chooses to show them, and
// styles, frames, media and forms are removed. Links work: a link to the web
// opens in a new tab, "#heading" scrolls the preview, and a link to another
// file in the folder opens it in the pane (the pane handles the click).
import { marked } from "marked";
import DOMPurify from "dompurify";

// Also no image maps (an <area> link would move the portal itself), and no
// class: a file must not borrow the portal's own styles (a fixed, full-page
// "dialog" over the portal is one class away).
const FORBID_TAGS = ["style", "link", "iframe", "frame", "object", "embed", "form", "video", "audio", "source", "picture", "track", "base", "meta", "svg", "math", "map", "area"];
const FORBID_ATTR = ["style", "srcset", "background", "poster", "formaction", "ping", "action", "class", "usemap"];

/** Front matter (the `---` block at the top of agent and skill files), then the body. */
export function splitFrontMatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text ?? ""));
    if (!match) return { frontMatter: null, body: String(text ?? "") };
    return { frontMatter: match[1], body: String(text).slice(match[0].length) };
}

/** An image address that is inline data (no loading from anywhere). */
export function isInlineImage(src) {
    return /^data:image\//i.test(String(src || ""));
}

/** An address on the internet (http, https, or protocol-relative). */
export function isRemoteAddress(src) {
    return /^(https?:)?\/\//i.test(String(src || "").trim());
}

/** A heading's anchor, the way GitHub makes it: lower case, punctuation out, spaces to hyphens. */
export function headingSlug(text) {
    return String(text || "").trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/**
 * Safe HTML for a markdown file.
 *
 * `images` maps an image's original address to the address to show it from;
 * an image not in the map (or all of them, when `images` is omitted) becomes
 * a placeholder with its alt text. Inline data images always show.
 * Returns the HTML, the front matter, and the addresses of the images that
 * were held back.
 */
export function renderMarkdown(text, { images = null } = {}) {
    const { frontMatter, body } = splitFrontMatter(text);
    const clean = DOMPurify.sanitize(marked.parse(body, { gfm: true, async: false }), {
        USE_PROFILE: { html: true },
        FORBID_TAGS,
        FORBID_ATTR,
        // A file's own ids and names get the "user-content-" prefix, as on
        // GitHub, so none can stand in for an element the portal looks up.
        SANITIZE_NAMED_PROPS: true,
    });
    const template = document.createElement("template");
    template.innerHTML = clean;
    // Headings get GitHub's anchors, prefixed as GitHub does so no id can
    // stand in for a name the page uses.
    const slugs = new Map();
    for (const heading of Array.from(template.content.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
        const slug = headingSlug(heading.textContent);
        const seen = slugs.get(slug) ?? 0;
        slugs.set(slug, seen + 1);
        heading.id = `user-content-${seen ? `${slug}-${seen}` : slug}`;
    }
    for (const link of Array.from(template.content.querySelectorAll("a[href]"))) {
        const href = link.getAttribute("href") || "";
        if (href.startsWith("#")) {
            link.setAttribute("data-ws-anchor", href.slice(1));
        } else if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
            link.setAttribute("target", "_blank");
            link.setAttribute("rel", "noopener noreferrer");
        } else {
            // Another file: the pane opens it. Never the portal's own address.
            link.setAttribute("data-ws-path", href);
            link.setAttribute("href", "#");
            link.setAttribute("title", `Open ${href}`);
        }
    }
    const blocked = [];
    for (const img of Array.from(template.content.querySelectorAll("img"))) {
        const src = img.getAttribute("src") || "";
        if (isInlineImage(src)) continue;
        const shown = images && Object.prototype.hasOwnProperty.call(images, src) ? images[src] : null;
        if (shown) {
            img.setAttribute("src", shown);
            img.setAttribute("loading", "lazy");
            img.setAttribute("referrerpolicy", "no-referrer");
            continue;
        }
        blocked.push(src);
        const placeholder = document.createElement("span");
        placeholder.className = "ps-ws-img-blocked";
        placeholder.setAttribute("title", src ? `Not shown: ${src}` : "Not shown");
        placeholder.textContent = img.getAttribute("alt") || "image";
        img.replaceWith(placeholder);
    }
    // An image button fetches its picture too: never, in a preview.
    for (const input of Array.from(template.content.querySelectorAll("input"))) {
        if (String(input.getAttribute("type") || "").toLowerCase() !== "image") continue;
        const src = input.getAttribute("src") || "";
        const placeholder = document.createElement("span");
        placeholder.className = "ps-ws-img-blocked";
        placeholder.setAttribute("title", src ? `Not shown: ${src}` : "Not shown");
        placeholder.textContent = input.getAttribute("alt") || "image";
        input.replaceWith(placeholder);
    }
    return { frontMatter, html: template.innerHTML, blocked };
}
