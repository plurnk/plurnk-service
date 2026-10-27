import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Retention, { retentionPolicy } from "../../src/server/Retention.ts";
import Daemon from "../../src/server/Daemon.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import EvidenceReader from "../../src/evidence/EvidenceReader.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import EntryFts from "../../src/schemes/_entry-fts.ts";
import Turn from "../../src/core/Turn.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import NativeContent from "../../src/core/NativeContent.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { providerRequestSettlementParams } from "../../src/core/provider-accounting.ts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import { Digest } from "@plurnk/plurnk-digest";
import { type DurablePacket } from "../../src/core/StoredPacket.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { insertLoop, insertPacketTurn, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel, insertTurn } from "./_db.ts";
// eslint-disable-next-line no-restricted-imports -- {§content-store}: witness reads sqlite_master after daemon close; no persistence happens outside SqlRite.
import { DatabaseSync } from "node:sqlite";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { provider as reasoningProvider, statement as reasoningStatement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { parseDsl } from "./_mock.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { waitForDb } from "./_rpc.ts";
import { type Db } from "../../src/core/Db.ts";
import { namedModelSession } from "./_sessions.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { launch } from "./_launcher.ts";

describe("retention", () => {
// {§content-store} — packet/response retirement preserves the durable record;
// unreferenced content has a separate collection policy.

















const counts = ({ reclaimedPages: _reclaimed, collectedContents: _contents, ...rest }: Awaited<ReturnType<Retention["run"]>>) => rest;
const KEEP_ALL = { PLURNK_SERVICE_RETAIN_PACKET_TURNS: "-1", PLURNK_SERVICE_RETAIN_PACKET_MS: "-1", PLURNK_SERVICE_RETAIN_RESPONSE_TURNS: "-1", PLURNK_SERVICE_RETAIN_RESPONSE_MS: "-1", PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "1", PLURNK_SERVICE_COLLECT_DERIVATIONS: "1", PLURNK_SERVICE_COLLECT_CONTENTS: "1", PLURNK_SERVICE_RETENTION_INTERVAL_MS: "3600000", PLURNK_SERVICE_AUTO_VACUUM: "incremental", PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES: "0" };
const CAPACITY = JSON.stringify({ decision: "admit", contextWindow: 1001, maxInputTokens: null, maxOutputTokens: null, outputBudget: 1, reasoningBudget: null, inputCapacity: 1000, prompt: { kind: "exact", tokens: 10, source: "retention-fixture" } });
const record = (n: number): string => `### log:///1/1/${n}/READ\n{"status":200}\n1:line ${n}`;
const packet = (upTo: number): DurablePacket => {
    const items = Array.from({ length: upTo }, (_, i) => record(i + 1));
    return { weight: 1, sections: [{ name: "log", slot: "user", header: "Log", content: items.join("\n\n"), weight: 1, items }], attributions: [] };
};

test("{§configuration-repair-path}: invalid retention withholds collection and storage conversion through shutdown", async (t) => {
    const key = "PLURNK_SERVICE_RETAIN_PACKET_TURNS";
    const previous = process.env[key];
    process.env[key] = "invalid";
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "retention-repair");
    const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/released.md", channel: "body", content: "must remain", mimetype: "text/plain" });
    await db.crud_delete_entry.run({ entry_id: entryId });
    const before = await db.test_content_store_count.get({});
    assert.equal(before?.n, 1);
    const mode = await db.retention_auto_vacuum_mode.get({});
    const daemon = new Daemon({ db });
    try {
        await daemon.start();
        assert.ok(daemon.configurationNotices().some((notice) => notice.key === key));
        assert.deepEqual(await db.retention_auto_vacuum_mode.get({}), mode, "an invalid policy cannot choose a storage conversion");
    } finally { await daemon.stop(); }
    assert.deepEqual(await db.test_content_store_count.get({}), before, "no collector ran at startup or shutdown");
});

test("{§content-store}: the shipped panel bounds transient data by age and keeps the durable record (#788)", () => {
    // The intg tier loads .env.defaults, so this is the real panel, not a fixture.
    const shipped = retentionPolicy(process.env);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    assert.equal(shipped.retainPacketMs, thirtyDays, "packets are transient evidence, collected after thirty days");
    assert.equal(shipped.retainResponseMs, thirtyDays, "so are raw response bodies");
    assert.equal(shipped.retainPacketTurns, -1, "a loop is already bounded by its own turns; age is what grows without limit");
    assert.equal(shipped.retainResponseTurns, -1);
});

test("{§content-store}: the keep-everything fixture retires nothing and refuses malformed knobs", async () => {
    const policy = retentionPolicy(KEEP_ALL);
    assert.deepEqual(policy, { retainPacketTurns: -1, retainPacketMs: -1, retainResponseTurns: -1, retainResponseMs: -1, collectPacketItems: true, collectDerivations: true, collectContents: true, intervalMs: 3_600_000, autoVacuum: "incremental", reclaimMinFreeBytes: 0 });
    for (const [key, value] of [
        ["PLURNK_SERVICE_RETAIN_PACKET_TURNS", "-2"],
        ["PLURNK_SERVICE_COLLECT_DERIVATIONS", "yes"],
        ["PLURNK_SERVICE_AUTO_VACUUM", "full"],
        ["PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES", "-1"],
        ["PLURNK_SERVICE_RETENTION_INTERVAL_MS", ""],
    ]) assert.throws(() => retentionPolicy({ ...KEEP_ALL, [key]: value }), (cause: unknown) => {
        assert.ok(cause instanceof ConfigurationError);
        assert.equal(cause.key, key);
        assert.ok(cause.message.includes(key));
        return true;
    });
    assert.throws(() => retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETENTION_INTERVAL_MS: undefined }),
        /PLURNK_SERVICE_RETENTION_INTERVAL_MS is missing from the assembled environment floor/u);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-defaults-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertSession(db, workspaceId), 1, "go");
        const turns = [];
        for (let sequence = 1; sequence <= 3; sequence += 1) turns.push(await insertPacketTurn(db, loopId, sequence, packet(sequence), 200));
        const pass = await new Retention(db, policy).run();
        assert.deepEqual(counts(pass), { retiredPackets: 0, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 }, "the keep-all fixture preserves every packet");
        for (const id of turns) assert.equal((await db.test_turn_sections_count.get<{ n: number }>({ turn_id: id }))!.n, 1);
    } finally { await db.close(); }
});

test("{§content-store}: a count policy keeps the newest packets of each loop; retired compositions release only their own items", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-count-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertSession(db, workspaceId), 1, "go");
        const turns = [];
        for (let sequence = 1; sequence <= 4; sequence += 1) turns.push(await insertPacketTurn(db, loopId, sequence, packet(sequence), 200));
        const live = await db.test_open_inference_turn.get<{ id: number }>({ loop_id: loopId, sequence: 5 });
        assert.ok(live);
        const pass = await new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "2" })).run();
        assert.deepEqual(counts(pass), { retiredPackets: 2, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 }, "turns 1 and 2 retire; every one of their records is still cited by turns 3 and 4");
        assert.deepEqual(await Promise.all(turns.map(async (id) => (await db.test_turn_sections_count.get<{ n: number }>({ turn_id: id }))!.n)), [0, 0, 1, 1]);
        const bag = await db.test_bag_of_turn.get<{ packet: string | null }>({ id: turns[0] });
        assert.ok(bag?.packet, "the retired turn keeps its bag: weight, attributions, and any admitted response");
        const assembled = await db.test_get_packet.get<{ packet: string }>({ id: turns[0] });
        assert.deepEqual(JSON.parse(assembled!.packet).sections, [], "a retired packet reads back with no sections");

        const again = await new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "0" })).run();
        assert.deepEqual(counts(again), { retiredPackets: 2, retiredResponses: 0, collectedItems: 4, collectedDerivations: 0 }, "keeping none retires the rest; the four records nothing cites now leave");
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 0);
        const keep = await new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_PACKET_TURNS: "0", PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "0" })).run();
        assert.deepEqual(counts(keep), { retiredPackets: 0, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 }, "the open turn is never retired");
    } finally { await db.close(); }
});

test("{§content-store}: a response policy retires bodies while the call's evidence and admission stay, and a body never changes", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-responses-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertSession(db, workspaceId), 1, "go");
        const calls: number[] = [];
        const turns: number[] = [];
        for (let sequence = 1; sequence <= 3; sequence += 1) {
            const turn = await db.test_context_insert_turn.get<{ id: number }>({ loop_id: loopId, sequence, curation_budget: null, curation_weight: 10 });
            await db.test_complete_turn_at.run({ id: turn!.id, completed_at: `2026-09-0${sequence}T00:00:00.000Z` });
            const call = await db.test_context_insert_model_call.get<{ id: number }>({ turn_id: turn!.id, sequence: 1, kind: "emission" });
            const request = await db.engine_open_provider_request.get<{ id: number }>({
                inference_call_id: call!.id, sequence: 1, provider: "fixture", model: "fixture",
            });
            assert.ok(request);
            await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, {
                provider: "fixture", model: "fixture", outcome: "response",
                usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
                cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture rates" },
            }, { content: `Original response ${sequence}`, reasoning: `Original reasoning ${sequence}` }));
            await db.test_context_close_model_call.run({ id: call!.id, capacity: CAPACITY });
            calls.push(call!.id);
            turns.push(turn!.id);
        }
        const requests = () => Promise.all(turns.map((turn_id) => db.test_provider_requests.all<{ evidence: string | null; usage_total: number; cost_amount: string }>({ turn_id })));
        const preservedRequests = await requests();
        assert.deepEqual(preservedRequests.flat().map(({ evidence, usage_total, cost_amount }) => ({
            evidence: JSON.parse(evidence!), usage_total, cost_amount,
        })), [1, 2, 3].map((sequence) => ({
            evidence: { content: `Original response ${sequence}`, reasoning: `Original reasoning ${sequence}` },
            usage_total: 7, cost_amount: "0.01",
        })), "each request starts with its captured response, reasoning and accounting");
        await assert.rejects(db.test_context_close_model_call.run({ id: calls[0], capacity: CAPACITY }), /model call observation is immutable/, "a settled call refuses a second observation");
        await assert.rejects(db.test_update_model_call_response.run({ id: calls[0], response: "{}" }), /model call response is immutable/, "a body never changes");
        const bodies = async () => (await db.test_model_call_bodies.all<{ id: number; state: string; has_body: number; has_capacity: number }>({ loop_id: loopId })).map(({ state, has_body, has_capacity }) => `${state}:${has_body}:${has_capacity}`);
        assert.deepEqual(await bodies(), ["response:1:1", "response:1:1", "response:1:1"]);
        const keepAll = await new Retention(db, retentionPolicy(KEEP_ALL)).run();
        assert.equal(keepAll.retiredResponses, 0, "the keep-all fixture preserves every response body");

        const byCount = await new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_RESPONSE_TURNS: "1" })).run();
        assert.equal(byCount.retiredResponses, 2, "the two older bodies of the loop retire; the newest stays");
        assert.deepEqual(await bodies(), ["response:0:1", "response:0:1", "response:1:1"], "the calls stay settled with their capacity; only the bodies went");
        assert.deepEqual(await requests(), preservedRequests.map((rows, index) => rows.map((row) => ({
            ...row, evidence: index < 2 ? null : row.evidence,
        }))), "count-based retirement removes payloads while retaining every request and accounting fact");

        const byAge = await new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_RESPONSE_MS: String(24 * 3_600_000) })).run(Date.parse("2026-09-05T00:00:00.000Z"));
        assert.equal(byAge.retiredResponses, 1, "an age policy retires the remaining body by its turn's completion");
        assert.deepEqual(await bodies(), ["response:0:1", "response:0:1", "response:0:1"]);
        assert.deepEqual(await requests(), preservedRequests.map((rows) => rows.map((row) => ({
            ...row, evidence: null,
        }))), "age-based retirement retains request identities, failures and accounting, not bulky payloads");
    } finally { await db.close(); }
});

test("{§content-store}: an age policy retires by completion time, and a disabled collector keeps orphaned items", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-age-${crypto.randomUUID()}`);
        const loopId = await insertLoop(db, await insertSession(db, workspaceId), 1, "go");
        const old = await insertPacketTurn(db, loopId, 1, packet(1), 200);
        const fresh = await insertPacketTurn(db, loopId, 2, packet(2), 200);
        await db.test_complete_turn_at.run({ id: old, completed_at: "2026-01-01T00:00:00.000Z" });
        const policy = retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_PACKET_MS: String(7 * 24 * 3_600_000), PLURNK_SERVICE_COLLECT_PACKET_ITEMS: "0" });
        const pass = await new Retention(db, policy).run(Date.parse("2026-09-12T00:00:00.000Z"));
        assert.deepEqual(counts(pass), { retiredPackets: 1, retiredResponses: 0, collectedItems: 0, collectedDerivations: 0 });
        assert.equal((await db.test_turn_sections_count.get<{ n: number }>({ turn_id: old }))!.n, 0);
        assert.equal((await db.test_turn_sections_count.get<{ n: number }>({ turn_id: fresh }))!.n, 1);
        assert.equal((await db.test_packet_item_count.get<{ n: number }>({}))!.n, 2, "the collector is off: the shared record and the fresh record stay, nothing else existed");
    } finally { await db.close(); }
});

test("{§content-store}: failed retries expire with one logical call while open work and accounting survive", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-retired-evidence-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const dbPath = join(directory, "plurnk.db");
    await using db = await openMigrated(dbPath);
    const workspaceId = await insertWorkspace(db, "failed-payload-retention");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1);
    const calls: number[] = [];
    const turns: number[] = [];
    const requests: number[] = [];
    for (let sequence = 1; sequence <= 3; sequence++) {
        const turn = await db.test_open_inference_turn.get<{ id: number }>({ loop_id: loopId, sequence });
        assert.ok(turn);
        turns.push(turn.id);
        const call = await db.test_context_insert_model_call.get<{ id: number }>({ turn_id: turn.id, sequence: 1, kind: "emission" });
        assert.ok(call);
        calls.push(call.id);
        for (let retry = 1; retry <= (sequence === 1 ? 2 : 1); retry++) {
            const request: { id: number } | undefined = await db.engine_open_provider_request.get({ inference_call_id: call.id, sequence: retry, provider: "fixture", model: "fixture" });
            assert.ok(request);
            requests.push(request.id);
            await db.engine_settle_provider_request.run(providerRequestSettlementParams(request.id, {
                provider: "fixture", model: "fixture", outcome: sequence === 2 ? "response" : "error", status: sequence === 2 ? 200 : 413,
                ...(retry === 1 ? {} : { usage: { inputTokens: 9, outputTokens: 4, totalTokens: 13 } }),
                cost: retry === 1 ? { kind: "unknown", reason: "No billing response arrived." }
                    : { kind: "charged", amount: { amount: "0.02", currency: "USD" }, source: "fixture response" },
            }, { reasoning: `Retained partial output ${sequence}/${retry}`, content: "captured text" }));
        }
        if (sequence === 3) continue;
        if (sequence === 2) await db.test_context_close_model_call.run({ id: call.id, capacity: CAPACITY });
        else await db.test_context_fail_model_call.run({ id: call.id, capacity: CAPACITY });
        await Turn.complete(db, turn.id, sequence === 2 ? 200 : 413);
    }
    const captured = () => Promise.all(turns.map((turn_id) => db.test_provider_requests.all({ turn_id })));
    const before = await captured();
    await assert.rejects(db.test_request_payload_rewrite.run({ id: requests[0], evidence: "{}" }), /payload is immutable/);
    const byCount = new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_RESPONSE_TURNS: "2" }));
    assert.equal((await byCount.run()).retiredResponses, 1, "both failed retries belong to one expired logical call");
    assert.deepEqual((await captured()).flat().map(({ evidence }) => evidence === null), [true, true, false, false]);
    const first = await db.test_retirement_state.get({ id: calls[0] });
    assert.match(String(first?.payloads_retired_at), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal((await byCount.run()).retiredResponses, 0, "retired calls do not change the count window");
    await assert.rejects(db.test_retirement_rewrite.run({ id: calls[0], value: null }), /retirement.*occurs once/);
    await assert.rejects(db.test_retirement_rewrite.run({ id: calls[2], value: new Date().toISOString() }), /retirement requires completed work/);
    const byAge = new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RETAIN_RESPONSE_MS: "0" }));
    assert.equal((await byAge.run(Date.now() + 1000)).retiredResponses, 1);
    assert.deepEqual((await captured()).flat().map(({ evidence }) => evidence === null), [true, true, true, false]);
    const facts = (rows: Awaited<ReturnType<typeof captured>>) => rows.flat().map(({ evidence: _evidence, ...row }) => row);
    assert.deepEqual(facts(await captured()), facts(before), "no request, failure, usage, price, or unknown-billing fact is erased");
    await db.test_context_fail_model_call.run({ id: calls[2], capacity: CAPACITY });
    await Turn.complete(db, turns[2], 413);
    assert.equal((await byAge.run(Date.now() + 1000)).retiredResponses, 1);
    assert.deepEqual((await captured()).flat().map(({ evidence }) => evidence), [null, null, null, null]);

    const digestDir = join(directory, "digest");
    Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir });
    const report = JSON.parse(await readFile(join(digestDir, "digest.json"), "utf8"));
    assert.deepEqual(report.provider_requests.map(({ id }: { id: number }) => id), requests);
    for (const row of report.provider_requests) {
        assert.match(row.payloadsRetiredAt, /^\d{4}-\d{2}-\d{2}T/);
        const markdown = await readFile(join(digestDir, `requests/${row.id}.md`), "utf8");
        assert.ok(markdown.includes(`Payload retention applied at ${row.payloadsRetiredAt}`));
        assert.ok(!markdown.includes("Retained partial output"), "expired payloads are not reconstructed");
    }
    assert.equal(report.provider_requests[0].accounting.outcome, "error");
    assert.equal(report.provider_requests[0].accounting.cost.kind, "unknown", "expiry does not turn missing billing into zero cost");
    assert.equal(report.provider_requests[1].accounting.cost.amount.amount, "0.02");
});

test("{§content-store}: a superseded derivation and its full-text shadow are collected; a cited one stays", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `retention-derivations-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const entryId = await seedEntryWithChannel(db, { workspaceId, pathname: "/notes.md", content: "first edition\n", mimetype: "text/markdown" });
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        await SearchIndex.maintain(ctx);
        assert.equal((await db.test_derivation_state_counts.get<{ complete: number }>({}))!.complete, 1);
        assert.equal((await db.test_fts_count.get<{ n: number }>({}))!.n, 1);
        await db.test_set_channel_content.run({ entry_id: entryId, content: "second edition\n" });
        await SearchIndex.maintain(ctx);
        assert.equal((await db.test_derivation_state_counts.get<{ complete: number }>({}))!.complete, 2, "the superseded derivation is still resident before retention");

        const kept = await new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_COLLECT_DERIVATIONS: "0" })).run();
        assert.equal(kept.collectedDerivations, 0);
        const pass = await new Retention(db, retentionPolicy(KEEP_ALL)).run();
        assert.equal(pass.collectedDerivations, 1, "the edition no channel cites leaves");
        assert.equal((await db.test_derivation_state_counts.get<{ complete: number }>({}))!.complete, 1);
        assert.equal((await db.test_fts_count.get<{ n: number }>({}))!.n, 1, "its full-text row left with it through derivations_delete_fts");
        assert.deepEqual(await db.test_fts_search.all({ query: "second", workspace_id: workspaceId }), [{ pathname: "/notes.md" }], "the cited edition still searches");
    } finally { await db.close(); }
});

test("{§derivation-in-flight}: collection preserves unattached search snapshots through derivation and query", async (t) => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `snapshot-retention-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
    const retention = new Retention(db, retentionPolicy(KEEP_ALL));
    const process = DEFAULT_MIMETYPES.process.bind(DEFAULT_MIMETYPES);
    t.mock.method(DEFAULT_MIMETYPES, "process", async (...args: Parameters<typeof process>) => {
        const collected = await retention.run();
        assert.equal(collected.collectedDerivations, 0, "a building artifact is still owned by its producer");
        return process(...args);
    });
    const source = { content: "a needle in an unattached snapshot", mimetype: "text/plain", pathname: "/snapshot", scheme: "workspace" };
    await SearchIndex.snapshot(ctx, source, async ({ deepHash }) => {
        assert.equal((await retention.run()).collectedDerivations, 0, "a completed snapshot remains held until its query ends");
        const result = await EntryFts.rankCandidates(db, [{ key: "snapshot", deepHash }], "needle");
        assert.equal(result.status, 200);
        assert.deepEqual(result.matches[0]?.matches, [{ region: { startLine: 1, startColumn: 3, endLine: 1, endColumn: 9 }, matched: "needle" }]);
    });
    assert.equal((await retention.run()).collectedDerivations, 1, "unattached evidence is collectible when no operation holds it");
    assert.equal((await db.test_fts_count.get({}))?.n, 0);
    await assert.rejects(SearchIndex.snapshot(ctx, source, async () => { throw new Error("query failed"); }), /query failed/);
    assert.equal((await retention.run()).collectedDerivations, 1, "a failed query also releases its snapshot");
});

test("{§content-store}: the daemon converts its database to incremental auto-vacuum once, and every pass returns freed pages", async () => {
    const db = await openMigrated();
    try {
        const retention = new Retention(db, retentionPolicy(KEEP_ALL));
        const first = await retention.prepareStorage();
        assert.equal(first.converted, true, "a fresh SQLite file starts with auto_vacuum off");
        assert.deepEqual(await db.retention_auto_vacuum_mode.get({}), { auto_vacuum: 2 });
        assert.equal((await retention.prepareStorage()).converted, false, "conversion happens once");
        await dropBodies(db);
        const pass = await retention.run();
        assert.equal(pass.collectedContents, 40, "the bodies nothing holds leave the content store");
        assert.ok(pass.reclaimedPages > 0, "the pass returns the pages they occupied");
        assert.equal((await db.retention_page_counts.get<{ free: number }>({}))?.free, 0);
    } finally { await db.close(); }
});

// Forty distinct bodies stored and then released: their entries go, their bodies stay in the
// content store until a pass collects them.
const dropBodies = async (db: Awaited<ReturnType<typeof openMigrated>>): Promise<void> => {
    const workspaceId = await insertWorkspace(db, `reclaim-${crypto.randomUUID()}`);
    const entries: number[] = [];
    for (let index = 0; index < 40; index += 1) {
        entries.push(await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: `/bulk-${index}.md`, channel: "body", content: `${index}`.padEnd(50_000, "x"), mimetype: "text/markdown" }));
    }
    for (const entryId of entries) await db.crud_delete_entry.run({ entry_id: entryId });
};

test("{§content-store}: a pass leaves no write-ahead log behind (#786)", async () => {
    const path = join(tmpdir(), `wal-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    try {
        const retention = new Retention(db, retentionPolicy(KEEP_ALL));
        await retention.prepareStorage();
        await dropBodies(db);
        assert.ok((await stat(`${path}-wal`)).size > 0, "forty stored and released bodies went through the log");
        await retention.run();
        assert.equal((await stat(`${path}-wal`)).size, 0, "reclaimed pages are not held hostage by the log");
    } finally { await db.close(); }
});

test("{§content-store}: below the reclaim floor a pass leaves free pages for reuse", async () => {
    const db = await openMigrated();
    try {
        const retention = new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_RECLAIM_MIN_FREE_BYTES: String(1 << 30) }));
        await retention.prepareStorage();
        await dropBodies(db);
        const pass = await retention.run();
        assert.equal(pass.collectedContents, 40);
        assert.equal(pass.reclaimedPages, 0, "a gigabyte floor is far above what the fixture frees");
        assert.ok((await db.retention_page_counts.get<{ free: number }>({}))!.free > 0, "freed pages stay for reuse");
    } finally { await db.close(); }
});

test("{§content-store}: auto_vacuum=none converts an incremental file back and never steps a vacuum", async () => {
    const db = await openMigrated();
    try {
        await new Retention(db, retentionPolicy(KEEP_ALL)).prepareStorage();
        const retention = new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_AUTO_VACUUM: "none" }));
        assert.equal((await retention.prepareStorage()).converted, true);
        assert.deepEqual(await db.retention_auto_vacuum_mode.get({}), { auto_vacuum: 0 });
        assert.equal((await retention.prepareStorage()).converted, false);
        await dropBodies(db);
        const pass = await retention.run();
        assert.equal(pass.collectedContents, 40);
        assert.equal(pass.reclaimedPages, 0);
        assert.ok((await db.retention_page_counts.get<{ free: number }>({}))!.free > 0, "freed pages stay in the file");
    } finally { await db.close(); }
});

test("{§content-store}: a body is stored once however many workspaces hold it, and leaves when the last lets go", async () => {
    const db = await openMigrated();
    try {
        const book = "Chapter 1\n".repeat(200_000);
        const entries: number[] = [];
        for (let index = 0; index < 3; index += 1) {
            const workspaceId = await insertWorkspace(db, `book-${index}-${crypto.randomUUID()}`);
            entries.push(await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/book.md", channel: "body", content: book, mimetype: "text/markdown" }));
        }
        assert.deepEqual(await db.test_content_store_count.get({}), { n: 1, bytes: book.length }, "three workspaces, one stored body");
        const retention = new Retention(db, retentionPolicy(KEEP_ALL));
        await db.crud_delete_entry.run({ entry_id: entries[0] });
        await db.crud_delete_entry.run({ entry_id: entries[1] });
        assert.equal((await retention.run()).collectedContents, 0, "a body still held stays");
        await db.crud_delete_entry.run({ entry_id: entries[2] });
        assert.equal((await retention.run()).collectedContents, 1);
        assert.deepEqual(await db.test_content_store_count.get({}), { n: 0, bytes: null });
        const kept = new Retention(db, retentionPolicy({ ...KEEP_ALL, PLURNK_SERVICE_COLLECT_CONTENTS: "0" }));
        const workspaceId = await insertWorkspace(db, `book-kept-${crypto.randomUUID()}`);
        await db.crud_delete_entry.run({ entry_id: await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/book.md", channel: "body", content: book, mimetype: "text/markdown" }) });
        assert.equal((await kept.run()).collectedContents, 0, "a disabled collector keeps released bodies");
    } finally { await db.close(); }
});
});

describe("db-maintenance", () => {
// {§content-store} — the daemon leaves planner statistics behind when it stops.




const stat1 = (path: string): number => {
    const raw = new DatabaseSync(path, { readOnly: true });
    try {
        const table = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'").get();
        return table === undefined ? 0 : (raw.prepare("SELECT count(*) AS n FROM sqlite_stat1").get() as { n: number }).n;
    } finally { raw.close(); }
};

test("{§content-store}: stopping the daemon runs PRAGMA optimize on the writer, so the next open plans from statistics", async () => {
    const path = join(tmpdir(), `maintenance-${crypto.randomUUID()}.db`);
    const db = await openMigrated(path);
    const daemon = new Daemon({ db, provider: null, mimetypes: DEFAULT_MIMETYPES });
    await daemon.start();
    try {
        const workspaceId = await insertWorkspace(db, "maintenance");
        await LoopDocs.materialize(daemon.engine, db, workspaceId);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        await daemon.engine.runTurn({ workspaceId, sessionId, loopId, provider: reasoningProvider("thought",
            `${PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`), messages: [] });
        assert.equal((await clientRead(daemon.engine, db, { workspaceId, sessionId, statement: reasoningStatement("````READ (reasoning://alice/1/2) <1,-1>````") })).status, 200);
        assert.equal(stat1(path), 0, "a fresh baseline carries no statistics");
    } finally {
        await daemon.stop();
        await db.close();
    }
    assert.ok(stat1(path) > 0, "shutdown analyzed the tables the writer planned against");
});
});

describe("native-retention", () => {
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const collector = (db: Awaited<ReturnType<typeof openMigrated>>) => new Retention(db, {
    ...retentionPolicy(), autoVacuum: "none", retainPacketMs: -1, retainResponseMs: -1,
    retainPacketTurns: -1, retainResponseTurns: -1,
});

for (const publicationFails of [false, true]) test(`{§content-store}: a native READ is protected through ${publicationFails ? "failed" : "successful"} publication`, async (t) => {
    serverProposals(t, "accept");
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "native-read-retention");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Inspect the picture.");
    const turnId = await insertTurn(db, loopId, 1);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, loopId, turnId, mimetypes: DEFAULT_MIMETYPES });
    assert.equal((await EntryCrud.writeEntry({ authority: "", pathname: "/picture.png" }, {
        channels: { body: { content: "", bytes: PNG, mimetype: "image/png" } },
    }, ctx, "workspace")).status, 201);
    const retention = collector(db);
    const retain = NativeContent.retain.bind(NativeContent);
    let hash = "";
    t.mock.method(NativeContent, "retain", async (database: Db, bytes: Uint8Array) => {
        hash = await retain(database, bytes);
        await retention.run();
        assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG, "collection cannot race between capture and receipt");
        return hash;
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const dispatch = (source: string, sequence: number) => {
        const [statement] = parseDsl(source);
        assert.ok(statement);
        return engine.dispatch({ workspaceId, sessionId, loopId, turnId, statement, sequence, origin: "model" });
    };
    const failure = new Error("fixture receipt write failed");
    if (publicationFails) {
        t.mock.method(db.engine_insert_log_entry, "get", async () => { throw failure; });
        await assert.rejects(dispatch("````READ (workspace:///picture.png)\n````", 1), (cause) => cause === failure);
    } else {
        const result = await dispatch("````READ (workspace:///picture.png)\n````", 1);
        assert.equal(result.status, 200);
        assert.equal(result.nativeContentHash, hash);
        assert.equal((await dispatch("````KILL (log:///1/1/1/READ)\n````", 2)).status, 200);
        assert.equal((await dispatch("````KILL (workspace:///picture.png)\n````", 3)).status, 200);
    }
    assert.notEqual(hash, "", "the real READ path captured native bytes");
    await retention.run();
    if (publicationFails) {
        await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
    } else {
        assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG, "curation and source deletion preserve receipt evidence");
        await db.test_delete_session.run({ id: sessionId });
        await retention.run();
        await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
    }
});

test("{§content-store}: a packet alone pins its native snapshot until containing history deletion", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "native-packet-retention");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1);
    const hash = await NativeContent.retain(db, PNG);
    await insertPacketTurn(db, loopId, 1, {
        sections: [], attributions: [], weight: 1,
        attachments: [{ contentHash: hash, coordinate: "1/1/1/READ", path: "workspace:///picture.png", scheme: "workspace",
            pathname: "/picture.png", mimetype: "image/png", kind: "image", weight: 1 }],
    });
    const retention = collector(db);
    await retention.run();
    assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG);
    await db.test_delete_session.run({ id: sessionId });
    await retention.run();
    await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
});

test("{§content-store}: disabling content collection retains an unreferenced snapshot", async () => {
    await using db = await openMigrated();
    const hash = await NativeContent.retain(db, PNG);
    const retention = new Retention(db, { ...retentionPolicy(), autoVacuum: "none", collectContents: false });
    await retention.run();
    assert.deepEqual(Buffer.from(await NativeContent.read(db, hash)), PNG);
    assert.equal((await collector(db).run()).collectedContents, 1);
    await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
});

test("{§content-store}: message admission and attachment-only replies retain bytes after source and log curation", async (t) => {
    serverProposals(t, "accept");
    await using db = await openMigrated();
    const provider = new Mock({ contextWindow: 100_000, responses: [{ assistant: { reasoning: null,
        content: '````SEND [200,{"attachments":["workspace:///reply.txt"]}]\n````\n\n````KILL (log:///**)\n````' } }] });
    const daemon = new Daemon({ db, provider });
    const retention = collector(db);
    const original = NativeContent.retain.bind(NativeContent);
    const hashes = new Set<string>();
    t.mock.method(NativeContent, "retain", async (database: Db, bytes: Uint8Array) => {
        const hash = await original(database, bytes);
        hashes.add(hash);
        await retention.run();
        assert.deepEqual(Buffer.from(await NativeContent.read(database, hash)), Buffer.from(bytes));
        return hash;
    });
    try {
        await daemon.start();
        const { workspaceId } = await daemon.createWorkspace({ name: "native-message-retention", projectRoot: null });
        const sessionId = await namedModelSession(daemon, workspaceId, "main");
        const statements = (source: string) => parseDsl(source);
        await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: statements("````EDIT (workspace:///reply.txt)\nOriginal answer.\n````") });
        const started = await daemon.runLoop({ workspaceId, sessionId, prompt: "Return the attachment.",
            attachments: [{ name: "input.bin", mediaType: "application/octet-stream", bytes: new Uint8Array([1, 2, 3, 4]) }] });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await waitForDb(() => lifecycle.status(started.loopId), (status) => status === 200 || status >= 400), 200);
        const messages = await daemon.readMessages({ workspaceId, sessionId, loopId: started.loopId });
        assert.equal(messages.length, 2);
        assert.deepEqual(messages.map(({ attachments }) => attachments.map(({ bytes }) => Buffer.from(bytes))),
            [[Buffer.from([1, 2, 3, 4])], [Buffer.from("Original answer.")]]);
        const input = messages[0].attachments[0].target;
        const results = await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: sessionId, statements: statements([
            `\`\`\`\`KILL (${input})\n\`\`\`\``,
            "````KILL (workspace:///reply.txt)\n````",
        ].join("\n\n")) });
        assert.ok(results.every(({ status }) => status < 400), JSON.stringify(results));
        await retention.run();
        assert.deepEqual(await daemon.readMessages({ workspaceId, sessionId, loopId: started.loopId }), messages);
        await daemon.stop();
        await db.test_delete_session.run({ id: sessionId });
        await retention.run();
        for (const hash of hashes) await assert.rejects(NativeContent.read(db, hash), /Missing immutable native content/);
    } finally { await daemon.stop(); }
});
});

describe("sqlite-durability", () => {
const SERVICE = resolve(import.meta.dirname, "../../src/service.ts");
const BUILT_SERVICE = resolve(import.meta.dirname, "../../dist/service.js");
const PRELOAD = resolve(import.meta.dirname, "../fixtures/sqlite-durability/preload.mjs");
const CONDITIONS = process.execArgv.filter((arg) => arg.startsWith("--conditions"));

type Posture = { synchronous: number; journal_mode: string };
type Witness = {
    writer: Posture;
    readers: Posture[];
    history: Array<Posture & { stage: string }>;
    integrity: { integrity_check: string };
};

const witness = (stderr: string): Witness => {
    const match = /^durability-witness: (.+)$/mu.exec(stderr);
    assert.ok(match, `launcher must expose the connection witness: ${stderr}`);
    return JSON.parse(match[1]) as Witness;
};

const invoke = (dir: string, args: string[], overrides: Record<string, string> = {}, entrypoint = SERVICE) => {
    const env = { ...process.env };
    delete env.PLURNK_MODEL;
    delete env.PLURNK_SERVICE_SQLITE_SYNCHRONOUS;
    return spawnSync(process.execPath, [...(entrypoint === SERVICE ? CONDITIONS : []), `--import=${PRELOAD}`, entrypoint, ...args], {
        cwd: dir,
        env: {
            ...env,
            HOME: dir,
            XDG_CONFIG_HOME: join(dir, "config"),
            XDG_DATA_HOME: join(dir, "data"),
            PLURNK_SERVICE_DB_PATH: join(dir, "plurnk.db"),
            PLURNK_SERVICE_SQLITE_READERS: "2",
            ...overrides,
        },
        encoding: "utf8",
        timeout: 30_000,
    });
};

for (const [mode, value] of [[undefined, 2], ["OFF", 0], ["NORMAL", 1], ["FULL", 2], ["EXTRA", 3]] as const) {
    test(`{§db-durability}: launcher ${mode ?? "floor"} applies before migration/INIT, on every connection and reopen`, async (t) => {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
        t.after(() => rm(dir, { recursive: true, force: true }));
        const posture = { synchronous: value, journal_mode: "wal" };
        for (const opening of [0, 1]) {
            const result = invoke(dir, ["migrate"], mode === undefined ? {} : { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: mode });
            assert.equal(result.status, 0, result.stderr);
            const seen = witness(result.stderr);
            assert.deepEqual(seen.writer, posture);
            assert.deepEqual(seen.readers, [posture, posture]);
            assert.deepEqual(seen.history, ["migration", "init", "writer", ...(opening === 1 ? ["init", "writer"] : [])]
                .map((stage) => ({ stage, ...posture })));
            assert.deepEqual(seen.integrity, { integrity_check: "ok" });
        }
    });
}

test("{§db-durability}: CLI overrides the environment and reopening retains committed data", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const normal = invoke(dir, ["migrate"], { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "NORMAL" });
    assert.equal(normal.status, 0, normal.stderr);
    const full = invoke(dir, ["migrate", "--service-sqlite-synchronous=FULL"], { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "NORMAL" });
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(witness(full.stderr).history.map(({ synchronous }) => synchronous), [1, 1, 1, 2, 2]);
});

test("{§db-durability}: invalid modes are diagnosed offline and refuse database admission without blocking config inspection", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const mode of ["", "full", "2", "BROKEN"]) {
        for (const args of [["config", "check"], ["migrate"]]) {
            const result = invoke(dir, args, { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: mode });
            assert.equal(result.status, 1, `${args.join(" ")}: ${result.stderr}`);
            assert.match(result.stderr, /PLURNK_SERVICE_SQLITE_SYNCHRONOUS must be one of OFF, NORMAL, FULL, EXTRA/);
            assert.equal(existsSync(join(dir, "plurnk.db")), false, "invalid policy must not write a database");
        }
    }
    const repair = invoke(dir, ["config", "defaults"], { PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "BROKEN" });
    assert.equal(repair.status, 0, repair.stderr);
    assert.match(repair.stdout, /^PLURNK_SERVICE_SQLITE_SYNCHRONOUS=FULL$/mu);
});

test("{§db-durability}: daemon startup uses the same connection policy as migrate", async () => {
    const result = await launch({
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${PRELOAD}`,
        PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "FULL",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(witness(result.stderr).writer, { synchronous: 2, journal_mode: "wal" });
    const invalid = await launch({ PLURNK_SERVICE_SQLITE_SYNCHRONOUS: "BROKEN" });
    assert.equal(invalid.code, 1, invalid.stderr);
    assert.match(invalid.stderr, /PLURNK_SERVICE_SQLITE_SYNCHRONOUS must be one of OFF, NORMAL, FULL, EXTRA/);
    assert.equal(invalid.dbConnections, null, "invalid policy must not admit the daemon");
});

test("{§db-durability}: the built launcher applies the floor and explicit CLI policy", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-durability-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const full = invoke(dir, ["migrate"], {}, BUILT_SERVICE);
    assert.equal(full.status, 0, full.stderr);
    assert.deepEqual(witness(full.stderr).writer, { synchronous: 2, journal_mode: "wal" });
    const normal = invoke(dir, ["migrate", "--service-sqlite-synchronous=NORMAL"], {}, BUILT_SERVICE);
    assert.equal(normal.status, 0, normal.stderr);
    assert.deepEqual(witness(normal.stderr).history.map(({ synchronous }) => synchronous), [2, 2, 2, 1, 1]);
});
});
