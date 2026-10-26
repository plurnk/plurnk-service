// {§model-catalog-build} owns generation; {§model-fact-resolution} owns runtime precedence.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { providers as source, generatedAt } from "@opencode-ai/models/snapshot";
import { usage } from "../../scripts/lib/usage.mjs";
import { projectCatalog } from "./project.ts";

usage(import.meta, `
usage: npm run generate   (from plurnk-models)
Projects the locked models.dev snapshot into the shipped catalog ({§model-catalog-build}).
Reads: @opencode-ai/models/snapshot.
Writes: src/catalog.json and src/providers.json.
`);

export { projectCatalog };

if (import.meta.main) {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const projected = projectCatalog(source);
    for (const [name, data] of Object.entries(projected)) {
        await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(data) + "\n", "utf8");
    }
    const count = Object.values(projected.catalog).reduce((total, models) => total + Object.keys(models).length, 0);
    console.log(`generated ${count} models across ${Object.keys(projected.catalog).length} providers from Models.dev snapshot ${generatedAt}`);
}
