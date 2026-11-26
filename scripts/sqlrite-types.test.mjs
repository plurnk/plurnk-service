import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncSqlRiteTypes } from "./sqlrite-types.mjs";

test("{§lint-gate} sqlrite-types generates, checks, and detects stale or missing SqlRite declarations", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-sqlrite-types-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "sql"), { recursive: true });
    await writeFile(
        join(root, "sql", "queries.sql"),
        "-- PREP: find_item\nSELECT id FROM items WHERE id = $id AND scope = :scope;\n",
    );

    await assert.rejects(
        syncSqlRiteTypes({ cwd: root, directories: [] }),
        /name at least one SQL directory/,
    );
    await assert.rejects(
        syncSqlRiteTypes({ cwd: root, directories: ["sql"], out: "src/SqlRite.d.ts" }),
        /src\/SqlRite\.d\.ts is missing; run npm run types:sqlrite:write/,
    );

    await syncSqlRiteTypes({ cwd: root, directories: ["sql"], out: "src/SqlRite.d.ts", write: true });
    const generated = await readFile(join(root, "src", "SqlRite.d.ts"), "utf8");
    assert.match(generated, /find_item: SqlRiteSyncPreparedStatements<Record<string, unknown>, \{ id: unknown; scope: unknown \}>;/);

    await syncSqlRiteTypes({ cwd: root, directories: ["sql"], out: "src/SqlRite.d.ts" });

    await writeFile(join(root, "src", "SqlRite.d.ts"), "// drifted\n");
    await assert.rejects(
        syncSqlRiteTypes({ cwd: root, directories: ["sql"], out: "src/SqlRite.d.ts" }),
        /src\/SqlRite\.d\.ts is stale; run npm run types:sqlrite:write/,
    );
});
