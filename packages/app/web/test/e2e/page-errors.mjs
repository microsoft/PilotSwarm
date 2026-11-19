/**
 * Page errors the Workflow specs collect (page.on("pageerror")): every error, except a browser's report that a
 * ResizeObserver's notifications waited for the next frame. That report is the browser's, not the page's: WebKit raises it
 * as a page error ("ResizeObserver loop completed with undelivered notifications."), Chromium's older wording is
 * "ResizeObserver loop limit exceeded". Exactly these two messages are left out; any other error is kept.
 */
export const IGNORED_PAGE_ERRORS = Object.freeze([
    "ResizeObserver loop completed with undelivered notifications.",
    "ResizeObserver loop limit exceeded",
]);

/** Whether a page error's message is one the Workflow specs leave out (IGNORED_PAGE_ERRORS, compared whole). */
export function ignoredPageError(message) {
    return IGNORED_PAGE_ERRORS.includes(String(message ?? ""));
}

/** The pageerror listener the Workflow specs use: it adds every message to `errors` but the ignored ones. */
export function collectPageErrors(errors) {
    return (error) => {
        if (!ignoredPageError(error?.message)) errors.push(error.message);
    };
}
