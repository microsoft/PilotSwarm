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
         * Queue one write. `owner` is the account that queued it — or, for a
         * write queued before anyone was known, a promise of the FIRST account
         * that becomes known, captured when it becomes known (not when this
         * write reaches the front). `currentOwner()` is the account signed in
         * when its turn comes, and `send()` performs the write. Resolves to
         * send()'s result, or to { skipped } when the write was dropped.
         */
        async save(key, { owner, currentOwner, send }) {
            const generation = generationOf(key);
            const previous = tails.get(key) || Promise.resolve();
            const next = previous.catch(() => {}).then(async () => {
                if (generationOf(key) !== generation) return { skipped: "invalidated" };
                let boundOwner = owner;
                if (boundOwner && typeof boundOwner.then === "function") {
                    boundOwner = await boundOwner;
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

/**
 * The account the controller first resolves to (`auth.resolved`, set by
 * auth/context), captured synchronously in the store notification that
 * resolves it — so a later switch to another account cannot change it.
 */
function firstResolvedOwner(controller) {
    return new Promise((resolve) => {
        const unsubscribe = controller.subscribe(() => {
            const auth = controller.getState?.()?.auth;
            if (auth?.resolved !== true) return;
            unsubscribe?.();
            resolve(profileOwnerKey(auth.principal));
        });
    });
}

/**
 * The portal's whole-document profile write for one controller: queued in
 * edit order on `queue`, bound to the account signed in when it was queued.
 * A write queued before the controller knows who is signed in
 * (`auth.resolved`) is NOT bound to "nobody": it is bound, at the moment the
 * account becomes known, to that first account, and sent only if that is
 * still the account signed in when its turn comes. (An unknown principal is
 * not "anonymous"; binding it would drop that same person's write once
 * their principal arrives. Binding at dequeue would send it to whoever is
 * signed in by then.) Resolves to the transport's answer, or { skipped }
 * when the write was dropped.
 */
export async function saveControllerProfileDocument(queue, controller, settings) {
    if (typeof controller?.transport?.setCurrentUserProfileSettings !== "function") return null;
    const ownerNow = () => profileOwnerKey(controller.getState?.()?.auth?.principal);
    const resolved = controller.getState?.()?.auth?.resolved === true;
    return queue.save(controller, {
        // Subscribed NOW, at enqueue, so the owner is the first resolved account.
        owner: resolved ? ownerNow() : firstResolvedOwner(controller),
        currentOwner: ownerNow,
        send: () => controller.transport.setCurrentUserProfileSettings({ settings }),
    });
}

/** True when a save result is a dropped write, which must never be reported as saved. */
export function isSkippedProfileSave(result) {
    return Boolean(result && typeof result === "object" && result.skipped);
}
