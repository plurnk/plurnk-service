// {§db-schema-baseline} — every prepared statement's plan, read from the baseline schema, must not
// scan a table that only grows. Written as the witness for the #614 audit: it prints the offending
// plans so the audit reasons from EXPLAIN QUERY PLAN, never from a grep of index names.
import test from "node:test";
import assert from "node:assert/strict";
import SqlRiteCore from "@possumtech/sqlrite/core";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
// eslint-disable-next-line no-restricted-imports -- {§db-fk-indexes}: this test only plans the registry's SQL; no persistence happens outside SqlRite.
import type { DatabaseSync } from "node:sqlite";
import { openMigrated } from "./_db.ts";
import { sqlFunctionPaths } from "../../src/core/sql-functions.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
// Workload-scaled tables; retention does not make a full scan a bounded lookup.
const GROWING = new Set(["log_entries", "entries", "entry_channel_rows", "contents", "subscriptions", "workers", "loops", "turns", "symbol_defs", "symbol_refs", "derivations", "ambient_events", "provider_requests", "inference_calls", "model_calls", "turn_attempts", "log_entry_projections", "native_contents", "client_interactions", "turn_sources", "packet_items", "turn_sections", "turn_section_items"]);
// Statements that read a whole table on purpose (forensic digest, startup recovery, whole-workspace listings).
// A retention collector considers every row of its table by definition ({§retention-policy}).
// A write through the entry_channels view ({§content-store}) plans as a SEARCH of its rows plus a
// SCAN of the matched rows SQLite has already copied aside; the view itself is not a table.
const VIEWS = new Set(["entry_channels"]);
const WHOLE_TABLE_BY_DESIGN = /^(digest_|recovery_|test_|envelope_list_|retention_collect_|drain_scheduled_loops$|drain_claim_next_loop$|drain_ready_loop$)/;

const collectStatements = async (): Promise<Array<{ name: string; file: string; sql: string }>> => {
    return SqlRiteCore.getFiles(resolve(PROJECT_ROOT, "src")).flatMap((file) =>
        SqlRiteCore.parseSql([file]).PREP.map(({ name, sql }) => ({ name, sql, file: file.slice(PROJECT_ROOT.length + 1) })),
    );
};

// Plan with the same function declarations and SQL parser as the runtime.
const planRegistry = async (): Promise<{ plans: Array<{ name: string; file: string; rows: string[] }>; raw: DatabaseSync; close: () => Promise<void> }> => {
    const path = join(tmpdir(), `plans-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    const raw = SqlRiteCore.openDb({ path, readOnly: true });
    const close = async (): Promise<void> => { raw.close(); await db.close(); };
    try {
        SqlRiteCore.initDb(raw);
        await SqlRiteCore.registerFunctions(raw, sqlFunctionPaths);
        const plans: Array<{ name: string; file: string; rows: string[] }> = [];
        for (const { name, file, sql } of await collectStatements()) {
            const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
            plans.push({ name, file, rows: rows.map(({ detail }) => detail) });
        }
        return { plans, raw, close };
    } catch (error) {
        await close();
        throw error;
    }
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
                if (VIEWS.has(table)) continue;
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
