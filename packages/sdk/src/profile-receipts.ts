/**
 * The profile's "seen" receipts survive a stale whole-profile save (Workflow Simplified stage 2, FU-20; review UI2-F2).
 *
 * A portal saves the whole `profile_settings` document. Its `canvasPrefs` map holds, per canvas, what this person has
 * had on screen: the canvas's `lastViewedRev` and `lastViewedDataRev`, and the Workflow panel's `lastViewedWorkflowAt`
 * (owner F4: the Workflow button's dot). A second device that read the profile earlier would write its older receipts
 * back over newer ones, and the dot (or the canvas's badge) would show again for something already seen. At the write,
 * each receipt is the larger of the stored one and the written one; a stored entry the write leaves out is kept when it
 * holds a receipt and its session still exists (the writer may simply not have read it), and dropped otherwise (the
 * client prunes entries that can never matter, and that pruning still works).
 */

/** The receipt fields of a canvasPrefs entry, each merged by MAX. */
export const PROFILE_RECEIPT_FIELDS: readonly string[] = ["lastViewedRev", "lastViewedDataRev", "lastViewedWorkflowAt"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const receiptOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** The session a canvasPrefs key names: "<session>" or "<session>#<slot 2-5>". */
export function profileReceiptSessionId(key: string): string {
    const match = /^(.*)#([2-5])$/.exec(String(key));
    return match ? match[1] : String(key);
}

/** Whether a canvasPrefs entry holds a receipt (any receipt field above zero). */
function holdsReceipt(entry: unknown): boolean {
    return isRecord(entry) && PROFILE_RECEIPT_FIELDS.some(field => receiptOf(entry[field]) > 0);
}

/** The stored entries' sessions the written document leaves out (each a candidate to keep). Pure. */
export function profileReceiptOmittedSessions(stored: unknown, written: unknown): string[] {
    const storedPrefs = isRecord(stored) && isRecord(stored.canvasPrefs) ? stored.canvasPrefs : null;
    const writtenPrefs = isRecord(written) && isRecord(written.canvasPrefs) ? written.canvasPrefs : null;
    if (!storedPrefs || !writtenPrefs) return [];
    const out = new Set<string>();
    for (const [key, entry] of Object.entries(storedPrefs)) {
        if (!Object.prototype.hasOwnProperty.call(writtenPrefs, key) && holdsReceipt(entry)) out.add(profileReceiptSessionId(key));
    }
    return [...out];
}

/**
 * The document to store: `written`, with each canvasPrefs receipt the larger of the stored and the written value, and the
 * stored entries the write left out kept when they hold a receipt and `live(sessionId)` says their session still exists.
 * A write without a canvasPrefs map (an older client, or one that never sends it) is stored as written. Pure; `written`
 * is not changed.
 */
export function mergeProfileReceipts(stored: unknown, written: Record<string, unknown>, live: (sessionId: string) => boolean = () => false): Record<string, unknown> {
    const storedPrefs = isRecord(stored) && isRecord(stored.canvasPrefs) ? stored.canvasPrefs : null;
    const writtenPrefs = isRecord(written.canvasPrefs) ? written.canvasPrefs : null;
    if (!storedPrefs || !writtenPrefs) return written;
    const prefs: Record<string, unknown> = {};
    let changed = false;
    for (const [key, entry] of Object.entries(writtenPrefs)) {
        const before = storedPrefs[key];
        if (!isRecord(entry) || !isRecord(before)) {
            prefs[key] = entry;
            continue;
        }
        const next: Record<string, unknown> = { ...entry };
        for (const field of PROFILE_RECEIPT_FIELDS) {
            const kept = receiptOf(before[field]);
            if (kept > receiptOf(entry[field])) {
                next[field] = kept;
                changed = true;
            }
        }
        prefs[key] = next;
    }
    for (const [key, entry] of Object.entries(storedPrefs)) {
        if (Object.prototype.hasOwnProperty.call(writtenPrefs, key) || !holdsReceipt(entry) || !live(profileReceiptSessionId(key))) continue;
        prefs[key] = entry;
        changed = true;
    }
    return changed ? { ...written, canvasPrefs: prefs } : written;
}
