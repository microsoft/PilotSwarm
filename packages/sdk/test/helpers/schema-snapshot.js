/**
 * A comparable snapshot of everything a schema holds, read from the PostgreSQL catalog: its relations (with persistence,
 * row security and privileges), every table's columns in order (type, NOT NULL, default, identity, generated, collation,
 * privileges), constraints (pg_get_constraintdef), indexes (pg_get_indexdef, validity), functions and procedures
 * (pg_get_functiondef, volatility, security, settings, privileges), triggers (pg_get_triggerdef, enabled), views
 * (pg_get_viewdef), sequences (their parameters and owning column), types and enum labels, policies, comments, the
 * schema's privileges, and the rows of every table (a digest per table).
 *
 * Column positions are ranks among the live columns, so a column dropped along the way leaves no trace; every
 * occurrence of the schema's name reads `<schema>`, so two schemas compare equal when they hold the same thing. The
 * migration ledger (`ledger`) is left out: how a schema got its shape is not its shape.
 */
export async function schemaSnapshot(query, schema, { ledger = "schema_migrations" } = {}) {
    const rows = async (sql) => (await query(sql, [schema])).rows;
    const snapshot = {
        schemaAcl: await rows(`SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = $1`),
        relations: await rows(`
            SELECT c.relname, c.relkind, c.relpersistence, c.relrowsecurity, c.relforcerowsecurity, c.relacl::text AS acl
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
             ORDER BY c.relname`),
        columns: await rows(`
            SELECT c.relname, a.attname,
                   rank() OVER (PARTITION BY c.oid ORDER BY a.attnum) AS position,
                   format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS default,
                   a.attidentity, a.attgenerated, co.collname, a.attacl::text AS acl
              FROM pg_attribute a
              JOIN pg_class c ON c.oid = a.attrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              LEFT JOIN pg_collation co ON co.oid = a.attcollation AND a.attcollation <> 100
             WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND a.attnum > 0 AND NOT a.attisdropped
             ORDER BY c.relname, a.attnum`),
        constraints: await rows(`
            SELECT COALESCE(c.relname, t.typname) AS owner, k.conname, k.contype, pg_get_constraintdef(k.oid) AS definition,
                   k.condeferrable, k.condeferred, k.convalidated
              FROM pg_constraint k
              JOIN pg_namespace n ON n.oid = k.connamespace
              LEFT JOIN pg_class c ON c.oid = k.conrelid
              LEFT JOIN pg_type t ON t.oid = k.contypid
             WHERE n.nspname = $1
             ORDER BY 1, 2`),
        indexes: await rows(`
            SELECT x.relname AS index, c.relname AS "table", pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid
              FROM pg_index i
              JOIN pg_class x ON x.oid = i.indexrelid
              JOIN pg_class c ON c.oid = i.indrelid
              JOIN pg_namespace n ON n.oid = x.relnamespace
             WHERE n.nspname = $1
             ORDER BY x.relname`),
        functions: await rows(`
            SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments, p.prokind,
                   pg_get_functiondef(p.oid) AS definition, p.provolatile, p.prosecdef, p.proconfig::text AS config,
                   p.proacl::text AS acl
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = $1 AND p.prokind IN ('f', 'p', 'w')
             ORDER BY 1, 2`),
        triggers: await rows(`
            SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid) AS definition, t.tgenabled
              FROM pg_trigger t
              JOIN pg_class c ON c.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND NOT t.tgisinternal
             ORDER BY 1, 2`),
        views: await rows(`
            SELECT c.relname, pg_get_viewdef(c.oid) AS definition
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind IN ('v', 'm')
             ORDER BY 1`),
        sequences: await rows(`
            SELECT c.relname, format_type(s.seqtypid, NULL) AS type, s.seqstart, s.seqincrement, s.seqmax, s.seqmin,
                   s.seqcache, s.seqcycle, owner.relname AS owned_by_table, a.attname AS owned_by_column, d.deptype
              FROM pg_sequence s
              JOIN pg_class c ON c.oid = s.seqrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid
                   AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
              LEFT JOIN pg_class owner ON owner.oid = d.refobjid
              LEFT JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE n.nspname = $1
             ORDER BY 1`),
        types: await rows(`
            SELECT t.typname, t.typtype,
                   (SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
              FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = $1 AND t.typtype IN ('e', 'd', 'r', 'm')
                OR (n.nspname = $1 AND t.typtype = 'c'
                    AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
             ORDER BY 1`),
        policies: await rows(`
            SELECT c.relname, p.polname, p.polcmd, p.polpermissive, p.polroles::text AS roles,
                   pg_get_expr(p.polqual, p.polrelid) AS using, pg_get_expr(p.polwithcheck, p.polrelid) AS check
              FROM pg_policy p
              JOIN pg_class c ON c.oid = p.polrelid
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1
             ORDER BY 1, 2`),
        comments: await rows(`
            SELECT d.classoid::regclass::text AS catalog,
                   COALESCE(c.relname, p.proname, k.conname, t.tgname) AS object, d.objsubid, d.description
              FROM pg_description d
              LEFT JOIN pg_class c ON d.classoid = 'pg_class'::regclass AND c.oid = d.objoid
              LEFT JOIN pg_proc p ON d.classoid = 'pg_proc'::regclass AND p.oid = d.objoid
              LEFT JOIN pg_constraint k ON d.classoid = 'pg_constraint'::regclass AND k.oid = d.objoid
              LEFT JOIN pg_trigger t ON d.classoid = 'pg_trigger'::regclass AND t.oid = d.objoid
              LEFT JOIN pg_class tc ON tc.oid = t.tgrelid
              JOIN pg_namespace n ON n.oid = COALESCE(c.relnamespace, p.pronamespace, k.connamespace, tc.relnamespace)
             WHERE n.nspname = $1
             ORDER BY 1, 2, 3`),
        data: [],
    };
    // Rows by their values, times left out (a row a migration seeds carries the time it ran).
    const tables = snapshot.relations.filter(relation => ["r", "p"].includes(relation.relkind) && relation.relname !== ledger);
    for (const { relname } of tables) {
        const columns = snapshot.columns
            .filter(column => column.relname === relname && !/^(timestamp|date|time)/.test(column.type))
            .map(column => `"${column.attname}"`);
        const values = columns.length ? `ROW(${columns.join(", ")})::text` : "''";
        const [row] = (await query(`SELECT count(*)::int AS rows, md5(COALESCE(string_agg(${values}, E'\\n' ORDER BY ${values}), '')) AS digest
                                      FROM "${schema}"."${relname}"`)).rows;
        snapshot.data.push({ table: relname, ...row });
    }
    return JSON.parse(JSON.stringify(snapshot).split(schema).join("<schema>"));
}

/** The keys of two snapshots whose entries differ, each with the entries only one of them has. */
export function snapshotDifferences(a, b) {
    const differences = {};
    for (const key of Object.keys(a)) {
        const left = new Set(a[key].map(item => JSON.stringify(item)));
        const right = new Set(b[key].map(item => JSON.stringify(item)));
        const onlyA = [...left].filter(item => !right.has(item)).map(item => JSON.parse(item));
        const onlyB = [...right].filter(item => !left.has(item)).map(item => JSON.parse(item));
        if (onlyA.length || onlyB.length) differences[key] = { onlyA, onlyB };
    }
    return differences;
}
