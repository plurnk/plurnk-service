import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated } from "./_helpers.ts";

const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules", "@plurnk", "plurnk-grammar", "dist", "schema");

type FieldStorage =
    | { kind: "direct"; column: string }
    | { kind: "decomposed"; columns: string[] }
    | { kind: "json"; column: string }
    | { kind: "joinTable"; table: string };

type SchemaMapping =
    | { kind: "table"; table: string; fields: Record<string, FieldStorage> }
    | { kind: "embedded"; table: string; fields: Record<string, FieldStorage> }
    | { kind: "skip"; reason: string };

const direct = (column: string): FieldStorage => ({ kind: "direct", column });
const json = (column: string): FieldStorage => ({ kind: "json", column });
const decomposed = (...columns: string[]): FieldStorage => ({ kind: "decomposed", columns });
const joinTable = (table: string): FieldStorage => ({ kind: "joinTable", table });

// grammar 0.65–0.67 scoped the contract to the PROTOCOL (statements, paths, scheme/provider
// registration, telemetry, channels) and DROPPED the persistence schemas — Entry, Session,
// Run, Loop, Turn, LogEntry, Packet, Agent are gone. Those shapes are the SERVICE's now,
// owned by our migrations + tests, not grammar. So this aligns only the protocol schemas that
// still map to a table; the persistence tables (sessions/runs/loops/turns/entries/log_entries)
// are ours and validated elsewhere.
const MAPPING: Record<string, SchemaMapping> = {
    ChannelContent: {
        kind: "embedded", table: "entry_channels", fields: {
            content: direct("content"), mimetype: direct("mimetype"),
            tokens: direct("tokens"), state: direct("state"),
        },
    },
    SchemeRegistration: {
        kind: "table", table: "schemes", fields: {
            name: direct("name"), model_visible: direct("model_visible"), category: direct("category"),
            default_scope: direct("default_scope"), default_channel: direct("default_channel"),
            writable_by: json("writable_by"), volatile: direct("volatile"), handler: direct("handler"),
        },
    },
    ProviderDeclaration: {
        kind: "table", table: "providers", fields: {
            provider: direct("provider"), family: direct("family"), model: direct("model"),
            contextSize: direct("contextSize"), currency: direct("currency"),
        },
    },

    Position:        { kind: "skip", reason: "AST shape; embedded in log_entries.* and other JSON fields" },
    LineMarker:      { kind: "skip", reason: "AST shape; embedded in log_entries.lineMarker JSON column" },
    Params:          { kind: "skip", reason: "embedded in entries.params + log_entries.params JSON" },
    ParsedPath:      { kind: "skip", reason: "AST shape; URL parts already decomposed at entry/log_entries level" },
    MatcherBody:     { kind: "skip", reason: "AST shape; not persisted" },
    SendBody:        { kind: "skip", reason: "AST shape; embedded in log_entries.tx for SEND rows" },
    PlurnkStatement: { kind: "skip", reason: "AST shape; embedded in turn.packet.assistant.ops JSON" },
    TelemetryEvent:  { kind: "skip", reason: "ecosystem error/telemetry envelope; embedded in turn.packet.user.telemetry.events[] JSON" },
};

const TABLE_PREP: Record<string, string> = {
    sessions: "test_align_cols_sessions",
    runs: "test_align_cols_runs",
    loops: "test_align_cols_loops",
    turns: "test_align_cols_turns",
    entries: "test_align_cols_entries",
    entry_channels: "test_align_cols_entry_channels",
    entry_tags: "test_align_cols_entry_tags",
    log_entries: "test_align_cols_log_entries",
    schemes: "test_align_cols_schemes",
    providers: "test_align_cols_providers",
};

const loadSchema = async (name: string): Promise<{ required: string[] }> => {
    const text = await readFile(join(SCHEMA_DIR, `${name}.json`), "utf8");
    const parsed = JSON.parse(text) as { required?: string[] };
    return { required: parsed.required ?? [] };
};

const columnsOf = async (db: Db, table: string): Promise<Map<string, { notnull: number; type: string }>> => {
    const prepName = TABLE_PREP[table];
    if (prepName === undefined) throw new Error(`no test_align_cols_<${table}> PREP registered`);
    const rows = await (db[prepName] as PrepMethod).all<{ name: string; type: string }>();
    return new Map(rows.map((r) => [r.name, { notnull: 0, type: r.type }]));
};

const tableExists = async (db: Db, table: string): Promise<boolean> => {
    const row = await (db.test_align_table_exists as PrepMethod).get<{ name: string }>({ name: table });
    return row !== undefined;
};

const verifyField = async (db: Db, table: string, fieldName: string, storage: FieldStorage): Promise<string[]> => {
    const errors: string[] = [];
    const cols = await columnsOf(db, table);
    if (storage.kind === "direct" || storage.kind === "json") {
        const info = cols.get(storage.column);
        if (info === undefined) errors.push(`field '${fieldName}' → column '${storage.column}' missing from table '${table}'`);
    } else if (storage.kind === "decomposed") {
        for (const c of storage.columns) {
            const info = cols.get(c);
            if (info === undefined) errors.push(`field '${fieldName}' → decomposed column '${c}' missing from table '${table}'`);
        }
    } else if (storage.kind === "joinTable") {
        if (!(await tableExists(db, storage.table))) errors.push(`field '${fieldName}' → join table '${storage.table}' does not exist`);
    }
    return errors;
};

test("alignment: every schema in plurnk-grammar/schema/ is claimed by a mapping", async () => {
    const files = (await readdir(SCHEMA_DIR)).filter((f) => f.endsWith(".json"));
    const schemaNames = files.map((f) => f.replace(/\.json$/, "")).toSorted();
    const claimed = Object.keys(MAPPING).toSorted();
    const unclaimed = schemaNames.filter((s) => !claimed.includes(s));
    const stale = claimed.filter((c) => !schemaNames.includes(c));
    assert.deepEqual(
        { unclaimed, stale },
        { unclaimed: [], stale: [] },
        `Schema/MAPPING drift detected. Unclaimed: ${JSON.stringify(unclaimed)}. Stale: ${JSON.stringify(stale)}.`,
    );
});

for (const [schemaName, mapping] of Object.entries(MAPPING)) {
    if (mapping.kind === "skip") {
        test(`alignment: ${schemaName} is explicitly skipped (${mapping.reason})`, () => {
            assert.equal(mapping.kind, "skip");
        });
        continue;
    }

    test(`alignment: ${schemaName} required fields all resolve to ${mapping.kind === "table" ? "columns/tables" : "embedded columns"} on '${mapping.table}'`, async () => {
        const db = await openMigrated();
        try {
            assert.ok(await tableExists(db, mapping.table), `mapping table '${mapping.table}' does not exist`);
            const schema = await loadSchema(schemaName);
            const errors: string[] = [];
            const unmappedFields: string[] = [];
            for (const fieldName of schema.required) {
                const storage = mapping.fields[fieldName];
                if (storage === undefined) {
                    unmappedFields.push(fieldName);
                    continue;
                }
                errors.push(...(await verifyField(db, mapping.table, fieldName, storage)));
            }
            assert.deepEqual(
                { unmapped: unmappedFields, resolution: errors },
                { unmapped: [], resolution: [] },
                `${schemaName}: unmapped ${JSON.stringify(unmappedFields)}; resolution ${JSON.stringify(errors)}`,
            );
        } finally { await db.close(); }
    });
}

test("alignment: every 'direct' mapping points to an existing column", async () => {
    const db = await openMigrated();
    try {
        const violations: string[] = [];
        for (const [, mapping] of Object.entries(MAPPING)) {
            if (mapping.kind === "skip") continue;
            const cols = await columnsOf(db, mapping.table);
            for (const [, storage] of Object.entries(mapping.fields)) {
                if (storage.kind === "direct" || storage.kind === "json") {
                    const info = cols.get(storage.column);
                    if (info === undefined) violations.push(`${mapping.table}.${storage.column} missing entirely`);
                }
            }
        }
        assert.deepEqual(violations, [], JSON.stringify(violations));
    } finally { await db.close(); }
});
