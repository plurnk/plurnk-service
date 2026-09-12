// {§db-schema-baseline} — the baseline declares shape: tables, indexes, views, and the constraint
// triggers that are a table's invariants. {§db-process-triggers} — a trigger that writes rows is a
// process, declared as an INIT block beside the statements that fire it, dropped and recreated on
// every open so its definition is current on any database whose shape is current (#624).
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- this witness reads sqlite_master; no persistence happens outside SqlRite.
import { DatabaseSync } from "node:sqlite";
import { openMigrated } from "./_helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const TRIGGER = /CREATE TRIGGER(?: IF NOT EXISTS)? (\w+)\s+(BEFORE|AFTER|INSTEAD OF)\s+(INSERT|UPDATE|DELETE)(?:\s+OF\s+[\w,\s]+?)?\s+ON (\w+)[\s\S]*?\nEND;/g;
const WRITES = /\b(INSERT INTO|UPDATE \w+\s+SET|DELETE FROM)\b/i;
const body = (block: string): string => block.slice(block.indexOf("BEGIN"));

const sqlFiles = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "node_modules") out.push(...await sqlFiles(path)); continue; }
        if (entry.name.endsWith(".sql")) out.push(path);
    }
    return out;
};

const baselineTriggers = async (): Promise<Array<{ name: string; when: string; writes: boolean }>> => {
    const text = await readFile(resolve(PROJECT_ROOT, "migrations/001_schema.sql"), "utf8");
    assert.equal((text.match(/^-- MIGRATE: /gm) ?? []).length, 1, "one MIGRATE block, the baseline");
    assert.equal((text.match(/^-- INIT: /gm) ?? []).length, 0, "the baseline holds shape only; processes live beside their owners");
    return [...text.matchAll(TRIGGER)].map((m) => ({ name: m[1]!, when: m[2]!, writes: WRITES.test(body(m[0])) }));
};

const initTriggers = async (): Promise<Array<{ file: string; init: string; name: string; dropsFirst: boolean; writes: boolean }>> => {
    const out: Array<{ file: string; init: string; name: string; dropsFirst: boolean; writes: boolean }> = [];
    for (const path of await sqlFiles(resolve(PROJECT_ROOT, "src"))) {
        const text = await readFile(path, "utf8");
        for (const block of text.split(/^-- INIT: /m).slice(1)) {
            const init = block.split("\n")[0]!.trim();
            for (const m of block.matchAll(TRIGGER)) {
                out.push({
                    file: path.slice(PROJECT_ROOT.length + 1),
                    init,
                    name: m[1]!,
                    dropsFirst: new RegExp(`DROP TRIGGER IF EXISTS ${m[1]};\\s*\\nCREATE TRIGGER ${m[1]}\\b`).test(block),
                    writes: WRITES.test(body(m[0])),
                });
            }
        }
    }
    return out;
};

test("{§db-schema-baseline}: every trigger in the baseline guards its table; only the view's INSTEAD OF trigger writes", async () => {
    const triggers = await baselineTriggers();
    assert.ok(triggers.length > 0);
    const processes = triggers.filter(({ writes, when }) => writes && when !== "INSTEAD OF").map(({ name }) => name);
    assert.deepEqual(processes, [], "a trigger that writes rows is a process and belongs beside its owner");
    const guards = triggers.filter(({ writes }) => !writes);
    assert.ok(guards.every(({ when }) => when === "BEFORE" || when === "AFTER"));
});

test("{§db-process-triggers}: every INIT trigger writes rows, is named after itself, and is dropped before it is created", async () => {
    const triggers = await initTriggers();
    assert.ok(triggers.length >= 21, `the 21 processes moved out of the baseline are declared as INIT blocks (found ${triggers.length})`);
    for (const t of triggers) {
        assert.equal(t.init, t.name, `${t.file}: INIT block ${t.init} declares trigger ${t.name}; the block is named after its trigger`);
        assert.ok(t.dropsFirst, `${t.file} ${t.name}: DROP TRIGGER IF EXISTS precedes CREATE TRIGGER, so the definition is current on every open`);
        assert.ok(t.writes, `${t.file} ${t.name}: an INIT trigger is a process; a guard belongs with its table in the baseline`);
    }
    const names = triggers.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length, "one owner per process trigger");
});

test("{§db-process-triggers}: a fresh database holds exactly the declared triggers, and a reopen keeps every one", async () => {
    const declared = [...(await baselineTriggers()).map(({ name }) => name), ...(await initTriggers()).map(({ name }) => name)].sort();
    assert.equal(new Set(declared).size, declared.length, "no trigger is declared twice");
    const path = join(tmpdir(), `composition-${crypto.randomUUID()}.db`);
    const live = (): string[] => {
        const raw = new DatabaseSync(path, { readOnly: true });
        try { return (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name); }
        finally { raw.close(); }
    };
    const first = await openMigrated(path);
    try { assert.deepEqual(live(), declared, "the live trigger set is the declared set"); } finally { await first.close(); }
    const second = await openMigrated(path);
    try { assert.deepEqual(live(), declared, "the second open drops and recreates every process trigger and loses none"); } finally { await second.close(); }
});
