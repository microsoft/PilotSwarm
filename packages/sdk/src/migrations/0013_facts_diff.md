# Facts Migration 0013: Conditional Delete

Migration file: `facts-migrations.ts`, function `migration_0013_conditional_delete`.

Adds one procedure. It deletes a single fact only while the fact still has the etag the caller read. The canvas app registry's legacy migration (issue 181) uses it to remove an `apps/<name>` fact after migrating that exact revision. A replacement written after the read gets a new etag, so it survives.

## Table changes

None.

## Index changes

None. The lookup is by `scope_key`, which is unique.

## Function changes

### `facts_delete_fact_if_etag(text, bigint)`: new

```diff
+CREATE OR REPLACE FUNCTION SCHEMA.facts_delete_fact_if_etag(
+    p_scope_key TEXT,
+    p_etag BIGINT
+) RETURNS BOOLEAN AS $$
+DECLARE
+    deleted_count BIGINT;
+BEGIN
+    UPDATE SCHEMA.facts
+       SET deleted_at = now(), updated_at = now()
+     WHERE scope_key = p_scope_key
+       AND deleted_at IS NULL
+       AND etag = p_etag;
+    GET DIAGNOSTICS deleted_count = ROW_COUNT;
+    RETURN deleted_count > 0;
+END;
+$$ LANGUAGE plpgsql;
```

The delete is a soft delete, the same as `facts_delete_fact` for an exact key. The compare and the delete are one `UPDATE`, so no write can come between them.

The etag trigger from migration 0010 bumps the etag on this state change, the same as for every other delete.

It returns `FALSE` in three cases: the fact changed (its etag differs), it is already deleted, or it never existed.

## Provider surface

`FactStore.deleteFactIfEtag({ key, shared, sessionId?, etag })` is optional, and `PgFactStore` implements it. A store without it cannot give the guarantee. A caller that needs the guarantee must then keep the fact; the legacy migration does exactly that and reports why.
