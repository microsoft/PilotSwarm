import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";

/**
 * The CMS migration versions the migrator applies after `last`, in the registry's order (CMS_MIGRATIONS, the list the
 * migrator runs): what an upgrade from a schema recorded at `last` adds. Upgrade tests compare with it, not with a literal
 * list, so a new migration does not break them (DEV run of b1652e70: three files still ended their lists at 0109).
 */
export function cmsVersionsAfter(last) {
    return CMS_MIGRATIONS("s").map(migration => migration.version).filter(version => version > last);
}
