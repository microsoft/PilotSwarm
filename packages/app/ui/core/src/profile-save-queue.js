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
         * Queue one write. `owner` is the account that queued it,
         * `currentOwner()` the account signed in when its turn comes, and
         * `send()` performs the write. Resolves to send()'s result, or to
         * { skipped } when the write was dropped.
         */
        async save(key, { owner, currentOwner, send }) {
            const generation = generationOf(key);
            const previous = tails.get(key) || Promise.resolve();
            const next = previous.catch(() => {}).then(() => {
                if (generationOf(key) !== generation) return { skipped: "invalidated" };
                if ((typeof currentOwner === "function" ? currentOwner() : null) !== owner) return { skipped: "account-changed" };
                return send();
            });
            tails.set(key, next);
            try { return await next; }
            finally { if (tails.get(key) === next) tails.delete(key); }
        },
    };
}
