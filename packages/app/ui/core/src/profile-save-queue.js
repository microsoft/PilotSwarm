/**
 * Ordered whole-document profile writes, bound to the account that made them.
 *
 * The portal saves the viewer's profile (layout, pins, the Admin tree's
 * collapsed nodes, …) as one document, one write at a time so a slow earlier
 * request never lands after a newer one. A queued write must also never be
 * sent for a DIFFERENT person: after a same-tab sign-out and sign-in, the
 * transport's token getter answers for the new account, so a write Alice
 * queued would otherwise land in Bob's profile. Each write remembers who
 * queued it and the host's mount generation; a write whose owner or
 * generation no longer matches is dropped before any credential is read.
 */

/** The account a profile write belongs to (null when authentication is off). */
export function profileOwnerKey(principal) {
    const provider = principal?.provider;
    const subject = principal?.subject;
    return provider && subject ? `${provider}\u0000${subject}` : null;
}

/** The owner of a write queued before the controller knew who is signed in. */
export const UNRESOLVED_OWNER = Symbol("profile-owner-unresolved");

export function createProfileSaveQueue() {
    const tails = new WeakMap();
    const generations = new WeakMap();
    const generationOf = (key) => generations.get(key) || 0;
    return {
        /** Drop every write queued so far for this key (the host unmounted or changed account). */
        invalidate(key) {
            generations.set(key, generationOf(key) + 1);
        },
        /**
         * Queue one write. `owner` is the account that queued it,
         * `currentOwner()` the account signed in when its turn comes, and
         * `send()` performs the write. Resolves to send()'s result, or to
         * { skipped } when the write was dropped.
         */
        async save(key, { owner, resolveOwner = null, currentOwner, send }) {
            const generation = generationOf(key);
            const previous = tails.get(key) || Promise.resolve();
            const next = previous.catch(() => {}).then(async () => {
                if (generationOf(key) !== generation) return { skipped: "invalidated" };
                // A write queued before anyone was known belongs to the
                // account that becomes known first (same tab, same token).
                let boundOwner = owner;
                if (boundOwner === UNRESOLVED_OWNER && typeof resolveOwner === "function") {
                    boundOwner = await resolveOwner();
                    if (generationOf(key) !== generation) return { skipped: "invalidated" };
                }
                if ((typeof currentOwner === "function" ? currentOwner() : null) !== boundOwner) return { skipped: "account-changed" };
                return send();
            });
            tails.set(key, next);
            try { return await next; }
            finally { if (tails.get(key) === next) tails.delete(key); }
        },
    };
}

/** Resolves once the controller knows who is signed in (`auth.resolved`, set by auth/context). */
function whenAuthResolved(controller) {
    if (controller.getState?.()?.auth?.resolved === true) return Promise.resolve();
    return new Promise((resolve) => {
        const unsubscribe = controller.subscribe(() => {
            if (controller.getState?.()?.auth?.resolved !== true) return;
            unsubscribe?.();
            resolve();
        });
    });
}

/**
 * The portal's whole-document profile write for one controller: queued in
 * edit order on `queue`, bound to the account signed in when it was queued.
 * A write queued before the controller knows who is signed in
 * (`auth.resolved`) is NOT bound to "nobody": it waits in the queue and is
 * bound to the account that becomes known, then sent for it. (An unknown
 * principal is not "anonymous"; binding it would drop that same person's
 * write once their principal arrives.) Resolves to the transport's answer,
 * or { skipped } when the write was dropped.
 */
export async function saveControllerProfileDocument(queue, controller, settings) {
    if (typeof controller?.transport?.setCurrentUserProfileSettings !== "function") return null;
    const ownerNow = () => profileOwnerKey(controller.getState?.()?.auth?.principal);
    const resolved = controller.getState?.()?.auth?.resolved === true;
    return queue.save(controller, {
        owner: resolved ? ownerNow() : UNRESOLVED_OWNER,
        resolveOwner: async () => { await whenAuthResolved(controller); return ownerNow(); },
        currentOwner: ownerNow,
        send: () => controller.transport.setCurrentUserProfileSettings({ settings }),
    });
}

/** True when a save result is a dropped write, which must never be reported as saved. */
export function isSkippedProfileSave(result) {
    return Boolean(result && typeof result === "object" && result.skipped);
}
