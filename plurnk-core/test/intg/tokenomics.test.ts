import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { sendStmt } from "./_dsl.ts";

// {§tokenomics}: entry and log content-depth is stamped at write time in the
// model-independent ruler used by production: ceil(chars/2). Provider-reported
// usage and provider-owned hard context-envelope admission are separate quantities.

const urlPath = (pathname: string): UrlPath => ({
    kind: "url", raw: `worker:///${pathname}`, scheme: "worker",
    username: null, password: null, hostname: null, port: null,
    pathname: `/${pathname}`, query: null, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null,
    target: urlPath(pathname), lineMarker: null, body,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `tok-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "p");
    const turnId = await insertTurn(db, loopId, 1, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    return { db, engine, workspaceId, workerId, loopId, turnId };
};

test("EDIT stores entry_channels.tokens from the model-agnostic ruler", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const content = "alpha beta gamma delta";
        const result = await engine.dispatch({
            statement: editStmt("/notes", content),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        }) as { status: number; entryId: number | null };
        assert.equal(result.status, 201);
        assert.ok(result.entryId !== null);
        const ch = await db.tok_channel_tokens.get<{ tokens: number }>({ entry_id: result.entryId, name: "body" });
        // The write-time stamp is the model-agnostic ruler ({§tokenomics-agnostic-ruler}): ceil(len/2).
        assert.equal(ch?.tokens, Math.ceil(content.length / 2));
        assert.ok((ch?.tokens ?? 0) > 0, "tokens populated at write, not the old hardcoded 0");
    } finally { await db.close(); }
});

test("dispatched op stores log_entries.tokens from tx+rx", async () => {
    const { db, engine, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        let logEntryId = 0;
        await engine.dispatch({
            statement: editStmt("/x", "hello world"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id: number) => { logEntryId = id; },
        });
        assert.ok(logEntryId > 0, "a log entry was written");
        const row = await db.tok_log_tokens.get<{ tokens: number }>({ id: logEntryId });
        assert.ok((row?.tokens ?? 0) > 0, "log row tokens populated from tx+rx, not 0");
    } finally { await db.close(); }
});

test("entry_channels.tokens honors an injected ruler override (test seam)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-prov-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const turnId = await insertTurn(db, loopId, 1, 200);
        // Inject a distinctive tokenizer (constant 100) — unmistakably not ceil(len/4).
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, tokenize: () => 100 });
        const result = await engine.dispatch({
            statement: editStmt("/notes", "alpha beta gamma"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        }) as { status: number; entryId: number | null };
        const ch = await db.tok_channel_tokens.get<{ tokens: number }>({ entry_id: result.entryId, name: "body" });
        assert.equal(ch?.tokens, 100, "the write stamp honors the injected tokenize (test seam); production injects the chars/2 ruler");
    } finally { await db.close(); }
});

test("budget headline carries a populated ceiling/usage/free ledger", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-bud-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        const packet = JSON.parse(row!.packet) as { tokens: number };
        const budget = packetSection(packet, "budget");
        const m = budget.match(/Token Ceiling (\d+) · Token Usage\s+(\d+) \(\s*(?:<1|\d+)%\) · Tokens Free\s+(\d+)/);
        assert.ok(m, `budget headline carries ceiling/usage/free; got: ${budget}`);
        assert.equal(budget.split("\n").length, 1, "the model-facing budget is one line");
        const ceiling = Number(m![1]); const usage = Number(m![2]); const free = Number(m![3]);
        assert.ok(usage > 0, "usage is populated, not zero or a leftover placeholder");
        assert.equal(usage, packet.tokens, "displayed usage is the exact persisted request render-weight");
        assert.equal(usage + free, ceiling, "usage + free = ceiling (the accounting closes)");
    } finally { await db.close(); }
});

test("budget headline shows usage as a percent of the ceiling", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `tok-pct-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const budget = packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const m = budget.match(/Token Ceiling (\d+) · Token Usage\s+(\d+) \(\s*(<1|\d+)%\) · Tokens Free\s+(\d+)/);
        assert.ok(m, `headline carries usage percent; got: ${budget}`);
        const ceiling = Number(m![1]); const usage = Number(m![2]); const pct = m![3];
        const exact = (usage / ceiling) * 100;
        // The budget-% fix: a positive usage under 1% renders "<1", not a rounded-down 0%.
        if (exact > 0 && exact < 1) {
            assert.equal(pct, "<1", `sub-1% usage renders as <1, not 0%; exact=${exact}`);
        } else {
            assert.equal(Number(pct), Math.round(exact), "percent reconciles to round(usage/ceiling)");
        }
    } finally { await db.close(); }
});

test("a hard context-envelope rejection preserves negative curation debt and over-100% pressure in its stored evidence", async () => {
    const db = await openMigrated();
    const partitionKeys = ["PLURNK_PROVIDERS_REASONING_RESERVE", "PLURNK_PROVIDERS_COMPLETION_RESERVE", "PLURNK_SERVICE_SAFETY"] as const;
    const previousPartition = partitionKeys.map((key) => process.env[key]);
    try {
        const workspaceId = await insertWorkspace(db, `tok-over-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "p");
        // {§tokenomics-window-partition} — the envelope rides the provider: an 11-token window with the 1+1 reserve floor
        // and SAFETY 0 → promptBudget 9, same arithmetic as the retired env pin.
        process.env.PLURNK_PROVIDERS_REASONING_RESERVE = "1";
        process.env.PLURNK_PROVIDERS_COMPLETION_RESERVE = "1";
        process.env.PLURNK_SERVICE_SAFETY = "0";
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // An 11-token provider window − 1 − 1 reserves → promptBudget 9; the packet's own
        // scaffolding alone blows past it and CANNOT fold under
        // (turn 1, nothing to roll back) → the un-foldable corner case. The loop hard-413s rather than
        // DELIVER an over-budget packet; the stored record below is engine forensics, NOT a packet the
        // model saw. The ruler may otherwise remain above 100% when authoritative
        // context-envelope admission proves that the request still fits.
        const provider = new Mock({ contextWindow: 11, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.equal(result.status, 413, "un-foldable → hard-413; the loop fails rather than deliver an over-budget packet");
        // The STORED failure record renders the overshoot honestly — never clamped to hide the degenerate state.
        const budget = packetSection(JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet), "budget");
        const m = budget.match(/Token Ceiling (\d+) · Token Usage\s+(\d+) \(\s*(\d+)%\) · Tokens Free\s+(-?\d+)/);
        assert.ok(m, `headline present; got: ${budget}`);
        const ceiling = Number(m![1]); const usage = Number(m![2]); const percent = Number(m![3]); const free = Number(m![4]);
        assert.ok(usage > ceiling, `usage ${usage} exceeds the ceiling of ${ceiling}`);
        assert.equal(free, ceiling - usage, "free tokens preserve the exact negative curation debt");
        assert.ok(percent > 100, `percent ${percent} honestly recorded past 100 in the failure record`);
        assert.equal(
            budget.match(/Context Token Budget Panic: YOU MUST FOLD or KILL enough less-relevant log items to restore free tokens\./gu)?.length,
            1,
            "negative debt carries exactly one transient curation instruction",
        );
    } finally {
        partitionKeys.forEach((key, index) => {
            const previous = previousPartition[index];
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
        await db.close();
    }
});

test("content_hash is a stable per-content identity — identical content, identical hash; no per-model keying", async () => {
    const { contentHash } = await import("../../src/core/content-hash.ts");
    const h = contentHash("same bytes");
    assert.equal(h, contentHash("same bytes"), "deterministic: identical content → identical hash");
    assert.notEqual(h, contentHash("other bytes"), "distinct content → distinct hash");
    assert.match(h, /^[0-9a-f]{64}$/, "a sha256 hex identity");
});
