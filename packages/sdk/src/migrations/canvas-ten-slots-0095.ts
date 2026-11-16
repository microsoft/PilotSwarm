/**
 * Migration 0095: canvas slots 1-10.
 *
 * Widens the slot CHECK on the four canvas tables (0045 session_canvases, 0047 canvas_live, 0048 canvas_share_links,
 * 0064 canvas_kv). Each existing slot CHECK is found in the catalog by its column, not by an assumed name, then
 * replaced by one named <table>_slot_range. Existing rows hold slots 1-5 and stay valid. The number is written here
 * literally: a later limit needs a new migration. The range is never narrowed again.
 *
 * The schema reaches SQL two ways: as a quoted identifier, and as a quoted text literal inside the DO block (resolved
 * with format('%I.%I')::regclass), so any schema name PostgreSQL accepts works.
 */
const DO_TAG = "$canvas_slots_0095$";

export function canvasTenSlotsMigration(schema: string): string {
    if (schema.includes(DO_TAG)) throw new Error(`schema name must not contain ${DO_TAG}`);
    const s = `"${schema.replace(/"/g, '""')}"`;
    const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
    const widen = (table: string) => `
DO ${DO_TAG}
DECLARE
    rel regclass := format('%I.%I', ${literal(schema)}, ${literal(table)})::regclass;
    c RECORD;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
        WHERE conrelid = rel AND contype = 'c'
        AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = rel AND attname = 'slot')]::smallint[]
    LOOP EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', rel, c.conname); END LOOP;
END;
${DO_TAG};
ALTER TABLE ${s}.${table} ADD CONSTRAINT ${table}_slot_range CHECK (slot BETWEEN 1 AND 10);`;
    return `SET LOCAL lock_timeout = '5s';
${["session_canvases", "canvas_live", "canvas_share_links", "canvas_kv"].map(widen).join("\n")}
`;
}
