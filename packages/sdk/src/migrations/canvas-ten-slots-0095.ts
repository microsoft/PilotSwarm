/**
 * Migration 0095: canvas slots 1-10.
 *
 * Widens the slot CHECK on the four canvas tables (0045 session_canvases, 0047 canvas_live, 0048 canvas_share_links,
 * 0064 canvas_kv). Each existing slot CHECK is found in the catalog by its column, not by an assumed name, then
 * replaced by one named <table>_slot_range. Existing rows hold slots 1-5 and stay valid. The number is written here
 * literally: a later limit needs a new migration. The range is never narrowed again.
 */
export function canvasTenSlotsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    const widen = (table: string) => `
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
        WHERE conrelid = '${s}.${table}'::regclass AND contype = 'c'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                             WHERE attrelid = '${s}.${table}'::regclass AND attname = 'slot')]::smallint[]
    LOOP EXECUTE format('ALTER TABLE ${s}.${table} DROP CONSTRAINT %I', c.conname); END LOOP;
END;
$$;
ALTER TABLE ${s}.${table} ADD CONSTRAINT ${table}_slot_range CHECK (slot BETWEEN 1 AND 10);`;
    return `SET LOCAL lock_timeout = '5s';
${["session_canvases", "canvas_live", "canvas_share_links", "canvas_kv"].map(widen).join("\n")}
`;
}
