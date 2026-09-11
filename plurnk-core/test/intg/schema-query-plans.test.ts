// {§db-schema-baseline} — every prepared statement's plan, read from the baseline schema, must not
// scan a table that only grows. Written as the witness for the #614 audit: it prints the offending
// plans so the audit reasons from EXPLAIN QUERY PLAN, never from a grep of index names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- {§db-fk-indexes}: this test only plans the registry's SQL; no persistence happens outside SqlRite.
import { DatabaseSync } from "node:sqlite";
import { openMigrated } from "./_helpers.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
// Tables that grow with use and are never pruned ({§db-schema-baseline} has no retention today).
const GROWING = new Set(["log_entries", "entries", "entry_channels", "subscriptions", "workers", "loops", "turns", "symbol_defs", "symbol_refs", "derivations", "ambient_events", "provider_requests", "inference_calls", "model_calls", "turn_attempts", "log_entry_projections", "native_contents", "client_interactions", "turn_sources"]);
// Statements that read a whole table on purpose (forensic digest, startup recovery, whole-workspace listings).
const WHOLE_TABLE_BY_DESIGN = /^(digest_|recovery_|test_|fork_get_|envelope_list_|drain_scheduled_loops$|drain_claim_next_loop$|drain_ready_loop$)/;

const collectStatements = async (): Promise<Array<{ name: string; file: string; sql: string }>> => {
    const out: Array<{ name: string; file: string; sql: string }> = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) { if (entry.name !== "node_modules") await walk(path); continue; }
            if (!entry.name.endsWith(".sql")) continue;
            const text = await readFile(path, "utf8");
            const blocks = text.split(/^-- PREP: /m).slice(1);
            for (const block of blocks) {
                const [head, ...rest] = block.split("\n");
                const sql = rest.filter((line) => !line.startsWith("--")).join("\n").trim();
                if (sql.length > 0) out.push({ name: head!.trim(), file: path.slice(PROJECT_ROOT.length + 1), sql });
            }
        }
    };
    await walk(resolve(PROJECT_ROOT, "src"));
    return out;
};

// Every registry statement's plan rows, read from a fresh baseline database. The registry
// registers application functions on the live connection; planning needs only their names, so
// unknown ones are stubbed as they are met.
const planRegistry = async (): Promise<{ plans: Array<{ name: string; file: string; rows: string[] }>; raw: DatabaseSync; close: () => Promise<void> }> => {
    const path = join(tmpdir(), `plans-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    const raw = new DatabaseSync(path, { readOnly: true });
    const plans: Array<{ name: string; file: string; rows: string[] }> = [];
    for (const { name, file, sql } of await collectStatements()) {
        let rows: Array<{ detail: string }> | null = null;
        for (let attempt = 0; rows === null && attempt < 16; attempt++) {
            try { rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>; }
            catch (cause) {
                const missing = /no such function: (\w+)/.exec((cause as Error).message)?.[1];
                if (missing === undefined) throw new Error(`${file} ${name}: cannot plan: ${(cause as Error).message}`, { cause });
                raw.function(missing, { deterministic: true, varargs: true }, () => null);
            }
        }
        if (rows === null) throw new Error(`${file} ${name}: cannot plan after stubbing functions`);
        plans.push({ name, file, rows: rows.map(({ detail }) => detail) });
    }
    return { plans, raw, close: async () => { raw.close(); await db.close(); } };
};

test("{§db-schema-baseline}: no registry statement scans a growing table without an index", async () => {
    const { plans, close } = await planRegistry();
    const offenders: string[] = [];
    try {
        for (const { name, file, rows } of plans) {
            if (WHOLE_TABLE_BY_DESIGN.test(name)) continue;
            for (const detail of rows) {
                const scan = /^SCAN (\S+)/.exec(detail);
                if (scan === null) continue;
                const table = scan[1]!;
                if (GROWING.has(table) && !/USING (COVERING )?INDEX/.test(detail)) offenders.push(`${file} ${name}: ${detail}`);
            }
        }
    } finally { await close(); }
    assert.deepEqual(offenders, [], `full scans of growing tables:\n${offenders.join("\n")}`);
});

// {§db-index-owners} — an index earns its place by a plan that uses it, a foreign key whose
// check it serves (its leading column is a foreign-key column), or a uniqueness constraint. Anything
// else is a write cost on every insert with no reader, and this test names it.
test("{§db-index-owners}: every explicit index is used by a registry plan, backs a foreign key, or enforces uniqueness", async () => {
    const { plans, raw, close } = await planRegistry();
    const unowned: string[] = [];
    try {
        const used = new Set<string>();
        for (const { rows } of plans) {
            for (const detail of rows) {
                const index = /USING (?:COVERING )?INDEX (\S+)/.exec(detail)?.[1];
                if (index !== undefined) used.add(index);
            }
        }
        const declared = raw.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY tbl_name, name").all() as Array<{ name: string; tbl_name: string; sql: string }>;
        for (const { name, tbl_name, sql } of declared) {
            if (used.has(name) || /UNIQUE/u.test(sql)) continue;
            const leading = /\(\s*([A-Za-z_]\w*)/u.exec(sql.slice(sql.indexOf(" ON ")))?.[1];
            const foreignKeys = (raw.prepare(`PRAGMA foreign_key_list(${tbl_name})`).all() as Array<{ from: string }>).map(({ from }) => from);
            if (leading !== undefined && foreignKeys.includes(leading)) continue;
            unowned.push(`${tbl_name}.${name}: no plan uses it, leading column ${leading ?? "?"} is not a foreign key, and it is not unique`);
        }
    } finally { await close(); }
    assert.deepEqual(unowned, [], `indexes without an owner:\n${unowned.join("\n")}`);
});
