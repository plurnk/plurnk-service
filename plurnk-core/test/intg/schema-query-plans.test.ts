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

test("{§db-schema-baseline}: no registry statement scans a growing table without an index", async () => {
    const path = join(tmpdir(), `plans-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    const raw = new DatabaseSync(path, { readOnly: true });
    const offenders: string[] = [];
    try {
        for (const { name, file, sql } of await collectStatements()) {
            if (WHOLE_TABLE_BY_DESIGN.test(name)) continue;
            // The registry registers application functions on the live connection; planning
            // needs only their names, so unknown ones are stubbed as they are met.
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
            for (const { detail } of rows) {
                const scan = /^SCAN (\S+)/.exec(detail);
                if (scan === null) continue;
                const table = scan[1]!;
                if (GROWING.has(table) && !/USING (COVERING )?INDEX/.test(detail)) offenders.push(`${file} ${name}: ${detail}`);
            }
        }
    } finally { raw.close(); await db.close(); }
    assert.deepEqual(offenders, [], `full scans of growing tables:\n${offenders.join("\n")}`);
});
