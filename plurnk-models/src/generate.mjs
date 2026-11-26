// {§model-catalog-build} owns generation; {§model-fact-resolution} owns runtime precedence.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providers as source, generatedAt } from "@opencode-ai/models/snapshot";
import { usage } from "../../scripts/lib/usage.mjs";
import { projectCatalog } from "./project.ts";
import { writeCatalogDatabase } from "./store.ts";

usage(import.meta, `
usage: npm run generate   (from plurnk-models)
Projects the locked models.dev snapshot into the shipped SQLite catalog ({§model-catalog-build}).
Reads: @opencode-ai/models/snapshot.
Writes: src/catalog.db.
`);

export { projectCatalog };

if (import.meta.main) {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const projected = projectCatalog(source);
    const targetPath = path.join(dir, "catalog.db");
    const tmpPath = path.join(dir, `.catalog.db.tmp-${process.pid}-${Date.now()}`);
    try {
        writeCatalogDatabase(tmpPath, projected, { updatedAt: generatedAt });
        await fs.rename(tmpPath, targetPath);
    } catch (cause) {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        throw cause;
    }
    const count = Object.values(projected.catalog).reduce((total, models) => total + Object.keys(models).length, 0);
    console.log(`generated ${count} models across ${Object.keys(projected.catalog).length} providers into catalog.db from Models.dev snapshot ${generatedAt}`);
}
