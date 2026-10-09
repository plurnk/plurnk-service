import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { TREE_SITTER_REGISTRY } from "./registry.ts";
import { loadRefsQuery } from "./reference-query.ts";

test("{§mimetype-query-assets} missing assets surface their I/O failure", async () => {
    await assert.rejects(loadRefsQuery("missing-query-fixture"), { code: "ENOENT" });
});

test("{§mimetype-query-assets} every reference mapping uses its packaged query asset", async () => {
    const assets = new Set((await readdir(new URL("../../queries/", import.meta.url)))
        .filter((name) => name.endsWith(".scm")));
    const used = new Set<string>();
    for (const entry of TREE_SITTER_REGISTRY) {
        const mapping = await entry.importMapping();
        if (mapping.refsQuery === undefined) continue;
        const names = entry.slug === "tsx" ? ["typescript", "tsx"] : [entry.slug];
        const sources = await Promise.all(names.map((name) => {
            used.add(`${name}.scm`);
            return readFile(new URL(`../../queries/${name}.scm`, import.meta.url), "utf8");
        }));
        assert.equal(mapping.refsQuery, sources.join(""), entry.slug);
        assert.match(mapping.refsQuery, /@ref\./u, `${entry.slug} has actual capture patterns`);
    }
    assert.ok(used.size > 0, "reference assets are exercised");
    assert.deepEqual(used, assets, "every shipped query serves an installed mapping");
});
