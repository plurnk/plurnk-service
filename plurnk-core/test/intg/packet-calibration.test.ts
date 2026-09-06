import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TokenCalibration from "../../src/core/TokenCalibration.ts";
import StoredPacket, { type RequestPacket } from "../../src/core/StoredPacket.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import {
    DEFAULT_MIMETYPES, insertLoop, insertTurn, insertWorker, insertWorkspace,
    logEntries, openMigrated, packetSection,
} from "./_helpers.ts";
import { editStmt, findStmt, killStmt, readStmt, sendStmt, urlPath } from "./_dsl.ts";

const messages = [{ role: "system" as const, content: "S" }, { role: "user" as const, content: "review" }];
const outputBudget = Number(process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET);
const providerAt = (capacity: number | null, responses: MockResponse[] = [], model = "mock"): Mock =>
    new class extends Mock { override get model(): string { return model; } }({
        contextWindow: capacity === null ? null : capacity + outputBudget,
        responses,
    });
const response = (reported = 0): MockResponse => ({
    assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done")] },
    usage: { inputTokens: reported, totalTokens: reported },
});

const fixture = async (t: TestContext, prompt = "review") => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `packet-units-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, prompt);
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const packets = new PacketBuilder({ db, schemes, executors: () => undefined });
    const build = (provider = providerAt(100_000)) => packets.buildRequestPacket({
        workspaceId, workerId, loopId, provider,
        initialMessages: messages, currentTurnSeq: 10, gitStatus: null,
    });
    return { db, workspaceId, workerId, loopId, engine, packets, build };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

const recordSamples = async ({ db, engine }: Fixture, counts = [300, 300, 300], model = "mock") => {
    const workspaceId = await insertWorkspace(db, `sample-source-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "sample");
    const provider = providerAt(100_000, counts.map(response), model);
    const recorded: Array<{ turnId: number; packet: string }> = [];
    for (let sample = 0; sample < counts.length; sample++) {
        const result = await engine.runTurn({ workspaceId, workerId, loopId, provider, messages });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(row);
        recorded.push({ turnId: result.turnId, packet: row.packet });
    }
    return recorded;
};

const prepareLog = async ({ db, workspaceId, workerId, loopId, engine }: Fixture) => {
    const turnId = await insertTurn(db, loopId, 1);
    const args = { workspaceId, workerId, loopId, turnId, origin: "model" as const };
    const target = urlPath("worker", "/notes.txt");
    const content = "alpha beta gamma ".repeat(2_000);
    const created = await engine.dispatch({ ...args, sequence: 1, statement: editStmt(target, content) });
    assert.equal(created.status, 201);
    let readId = 0;
    const read = await engine.dispatch({
        ...args, sequence: 2, statement: readStmt(target, { marks: [1, -1] }),
        onDispatch: (id) => { readId = id; },
    });
    assert.equal(read.status, 200);
    assert.equal((await engine.dispatch({ ...args, sequence: 3, statement: findStmt(target) })).status, 200);
    assert.equal((await engine.dispatch({
        ...args, sequence: 4, statement: killStmt(urlPath("log", "/1/1/1/EDIT")),
    })).status, 200);
    return { args, content, readId };
};

const budgetOf = (packet: RequestPacket): {
    tokensActiveTotal: number;
    tokensActiveMax: number;
    tokensResponseMax: number;
    tokensActiveLargest?: Array<{ path: string; tokensBody: number; tokensActive: number }>;
} => JSON.parse(packetSection(packet, "budget").split("\n")[0]!);

test("{§packet-token-accounting} non-unit calibration preserves one ruler for READ, FIND, inventory and total", async (t) => {
    const f = await fixture(t);
    await prepareLog(f);
    const uncalibrated = await f.build();
    await recordSamples(f);
    const factor = await TokenCalibration.forModel(f.db, "mock");
    assert.ok(factor > 0 && factor < 1);
    const provider = providerAt(Math.floor(uncalibrated.weight / 0.85 * factor));
    const packet = await f.build(provider);
    const state = budgetOf(packet);
    const rows = logEntries(packet);
    const read = rows.find(({ path }) => path === "log:///1/1/2/READ")!;
    assert.ok(Number(read.tokensActive) < state.tokensActiveTotal, "a visible READ cannot outweigh its complete packet");
    assert.equal(state.tokensActiveTotal, packet.weight, "the total retains the measured curation ruler");
    assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0));
    assert.equal(state.tokensActiveMax, Math.floor(provider.inputCapacity! / factor));
    assert.equal(state.tokensResponseMax, provider.outputBudget! - provider.reasoningBudget!);
    assert.deepEqual(rows, logEntries(uncalibrated), "neither receipt nor FIND item costs are rewritten by calibration");
    const find = rows.find(({ path }) => path === "log:///1/1/3/FIND")!;
    assert.ok(Number(find.itemsTokenTotal) > 0, "the FIND witness has real resource accounting");
    assert.ok(state.tokensActiveLargest?.some(({ path }) => path === read.path), "pressure identifies the dominant body");
    for (const item of state.tokensActiveLargest!) {
        const row = rows.find(({ path }) => path === item.path)!;
        assert.equal(item.tokensActive, row.tokensActive, "the same row has the same cost in the pressure inventory");
        assert.equal(item.tokensBody, row.tokensBody);
    }
    assert.equal(f.packets.curationOverflow(packet), null);
});

test("{§tokenomics-prompt-projection-share} new shared-model samples cannot resize the cached log or prompt prefix", async (t) => {
    const prompt = "A".repeat(40_000);
    const f = await fixture(t, prompt);
    const provider = providerAt(20_000, [response()]);
    const turn = await f.engine.runTurn({
        ...f, provider, messages: [{ role: "system", content: "S" }, { role: "user", content: prompt }],
    });
    const persisted = (await f.db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet;
    const before = await f.build(provider);
    const promptRow = logEntries(before).find(({ path }) => String(path).endsWith("/prompt"));
    assert.ok(promptRow && typeof promptRow.body === "string" && promptRow.body.length > 16 && promptRow.body.length < prompt.length);
    assert.ok(promptRow.chunk, "the cached prompt is genuinely bounded, not a vacuous short fixture");
    await recordSamples(f);
    const after = await f.build(provider);
    assert.notEqual(budgetOf(before).tokensActiveMax, budgetOf(after).tokensActiveMax, "the ceiling uses new model evidence");
    assert.equal(packetSection(after, "log"), packetSection(before, "log"), "all historical rows, including the bounded prompt, stay byte-identical");
    const prefix = (packet: RequestPacket) => PacketWire.packetToWireMessages(packet)
        .map(({ content }) => content.split("## Context Token Budget")[0]).join("\n");
    assert.equal(prefix(after), prefix(before), "the complete prefix before the volatile budget remains reusable");
    await recordSamples(f, [10_000, 10_000, 10_000, 10_000, 10_000]);
    const tighter = await f.build(provider);
    assert.ok(budgetOf(tighter).tokensActiveMax < budgetOf(before).tokensActiveMax, "the inverse direction is exercised too");
    assert.equal(prefix(tighter), prefix(before), "a shrinking allowance does not resize cached historical content either");
    assert.equal((await f.db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet, persisted, "calibration never rewrites request history");
});

test("{§tokenomics-calibrated-readout} only the latest five positive emission samples inform the shared model", async (t) => {
    const f = await fixture(t);
    const counts = [100, 200, 300, 400, 500, 600, 700];
    const recorded = await recordSamples(f, counts);
    const weights = recorded.map(({ packet }) => StoredPacket.parse(packet)!.weight);
    const factor = counts.slice(-5).reduce((sum, count) => sum + count, 0)
        / weights.slice(-5).reduce((sum, weight) => sum + weight, 0);
    assert.equal(await TokenCalibration.forModel(f.db, "mock"), factor);
    await recordSamples(f, [0, 0, 0]);
    await recordSamples(f, [10_000, 10_000, 10_000], "other-model");
    assert.equal(await TokenCalibration.forModel(f.db, "mock"), factor, "zero counts and other models cannot displace eligible evidence");
    assert.equal(budgetOf(await f.build()).tokensActiveMax, Math.floor(100_000 / factor), "a different worker consumes the same model evidence");
});

test("{§tokenomics-calibrated-readout} overflow and attribution copies use the allowance captured at packet build", async (t) => {
    const f = await fixture(t);
    await prepareLog(f);
    const provider = providerAt(15_000);
    const before = await f.build(provider);
    const expected = { weight: before.weight, budget: 15_000, excess: before.weight - 15_000 };
    assert.ok(expected.excess > 0);
    await recordSamples(f);
    const after = await f.build(provider);
    assert.equal(f.packets.curationOverflow(after), null, "new packets may use the larger converted allowance");
    assert.deepEqual(f.packets.curationOverflow(before), expected, "new samples do not reinterpret an older candidate");
    assert.deepEqual(f.packets.curationOverflow({ ...before, attributions: [] }), expected);
    assert.equal(f.packets.curationBudgetFor(before), budgetOf(before).tokensActiveMax);
    assert.throws(() => f.packets.curationOverflow({ ...before, sections: [...before.sections] }), /packet was not built by this PacketBuilder/u);
});

test("{§tokenomics-client-gauge} the response cannot retroactively change its own packet allowance or physical usage", async (t) => {
    const f = await fixture(t);
    const recorded = await recordSamples(f);
    const priorFactor = await TokenCalibration.forModel(f.db, "mock");
    const provider = providerAt(50_000, [response(17_000)]);
    const result = await f.engine.runTurn({ ...f, provider, messages });
    const raw = (await f.db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet;
    const packet = StoredPacket.parse(raw)!;
    const state = budgetOf(packet);
    const usage = await f.engine.loopUsage(f.loopId);
    assert.notEqual(await TokenCalibration.forModel(f.db, "mock"), priorFactor, "the response changes the conversion for subsequent packets");
    assert.equal(state.tokensActiveMax, Math.floor(provider.inputCapacity! / priorFactor));
    assert.equal(usage.curationBudget, state.tokensActiveMax);
    assert.equal(usage.curationWeight, state.tokensActiveTotal);
    assert.equal(usage.curationWeight, packet.weight);
    assert.equal(usage.contextCapacity, provider.inputCapacity, "physical capacity is not converted");
    assert.equal(usage.contextTokens, 17_000, "reported usage stays provider-token evidence");
    assert.equal(usage.accounting.usage?.inputTokens, 17_000);
    for (const saved of recorded) {
        assert.equal((await f.db.test_get_packet.get<{ packet: string }>({ id: saved.turnId }))!.packet, saved.packet);
    }
});

test("{§tokenomics-client-gauge} failed and rejected provider attempts retain their captured curation pair", async (t) => {
    for (const scenario of ["provider failure", "invalid emissions", "cancellation"] as const) {
        await t.test(scenario, async (t) => {
            const f = await fixture(t);
            await recordSamples(f);
            const factor = await TokenCalibration.forModel(f.db, "mock");
            const rejected: MockResponse = {
                assistant: { content: "not an operation", reasoning: null },
                usage: { inputTokens: 17_000, totalTokens: 17_000 },
            };
            const responses = scenario === "invalid emissions"
                ? Array.from({ length: Number(process.env.PLURNK_SERVICE_EMISSION_ATTEMPTS) }, () => rejected)
                : [];
            const provider = providerAt(50_000, responses);
            const cancellation = new AbortController();
            const reason = new Error("cancel calibration witness");
            if (scenario === "cancellation") {
                t.mock.method(provider, "generate", async () => {
                    cancellation.abort(reason);
                    throw reason;
                });
            }
            const run = f.engine.runTurn({ ...f, provider, messages, signal: cancellation.signal });
            if (scenario === "cancellation") await assert.rejects(run, (error) => error === reason);
            else assert.equal((await run).status, scenario === "invalid emissions" ? 102 : 502);
            const turns = await f.db.test_list_turns_in_loop.all<{ status: number; packet: string }>({ loop_id: f.loopId });
            const attempted = turns.at(-1)!;
            if (scenario === "cancellation") assert.equal(attempted.status, 499);
            const packet = StoredPacket.parse(attempted.packet)!;
            const usage = await f.engine.loopUsage(f.loopId);
            assert.equal("assistant" in packet, false, "no failed or rejected request invents an accepted assistant response");
            assert.equal(usage.curationWeight, packet.weight);
            assert.equal(budgetOf(packet).tokensActiveTotal, packet.weight);
            assert.equal(usage.curationBudget, Math.floor(provider.inputCapacity! / factor));
            assert.equal(usage.curationBudget, budgetOf(packet).tokensActiveMax);
        });
    }
});

test("{§packet-token-accounting} scoped and whole KILL reclaim stable costs without altering source or forensic bytes", async (t) => {
    const f = await fixture(t);
    const { args, content, readId } = await prepareLog(f);
    await recordSamples(f);
    const raw = await f.db.tok_log_weight.get<{ rx: string; weight: number }>({ id: readId });
    const before = await f.build();
    const read = logEntries(before).find(({ path }) => path === "log:///1/1/2/READ")!;
    assert.equal((await f.engine.dispatch({ ...args, sequence: 5, statement: killStmt(urlPath("log", "/1/1/2/READ"), { marks: [1, -1] }) })).status, 200);
    const trimmed = await f.build();
    const trimmedRead = logEntries(trimmed).find(({ path }) => path === read.path)!;
    assert.equal(trimmedRead.body, undefined);
    const renderedRead = (packet: RequestPacket) => packetSection(packet, "log")
        .split("\n\n").find((row) => row.startsWith(`### ${String(read.path)}\n`))!;
    assert.equal(read.tokensBody, contentWeight(renderedRead(before).split("\n").slice(2).join("\n")));
    assert.equal(Number(read.tokensActive) - Number(trimmedRead.tokensActive),
        contentWeight(renderedRead(before)) - contentWeight(renderedRead(trimmed)),
        "the scoped KILL's saving is the actual row-size change, without a conversion multiplier");
    assert.ok(trimmed.weight < before.weight, "the large body removal more than pays for its receipt");
    assert.equal((await f.engine.dispatch({ ...args, sequence: 6, statement: killStmt(urlPath("log", "/1/1/2/READ")) })).status, 200);
    const killed = await f.build();
    assert.equal(logEntries(killed).some(({ path }) => path === read.path), false);
    for (const packet of [before, trimmed, killed]) {
        assert.equal(budgetOf(packet).tokensActiveTotal, packet.weight);
        assert.equal(packet.weight, PacketWire.packetToWireMessages(packet).reduce((sum, { content }) => sum + contentWeight(content), 0));
        assert.equal(budgetOf(packet).tokensActiveMax, budgetOf(before).tokensActiveMax);
    }
    assert.deepEqual(await f.db.tok_log_weight.get({ id: readId }), raw, "curation cannot alter the immutable READ result or its write-time weight");
    const source = await f.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.txt", scheme: "worker", name: "body" });
    assert.equal(source?.content, content, "log curation does not delete source content");
});

test("{§tokenomics-calibrated-readout} unknown and unseen-model capacities do not borrow another model's conversion", async (t) => {
    const f = await fixture(t);
    await recordSamples(f);
    const fresh = await f.build(providerAt(25_000, [], "unseen-model"));
    assert.equal(budgetOf(fresh).tokensActiveMax, 25_000);
    assert.equal(budgetOf(fresh).tokensActiveTotal, fresh.weight);
    const unknown = await f.build(providerAt(null));
    assert.equal(packetSection(unknown, "budget"), "");
    assert.equal(f.packets.curationBudgetFor(unknown), null);
    assert.equal(f.packets.curationOverflow(unknown), null);
});

test("{§tokenomics-calibrated-readout} a converted zero allowance takes ordinary overflow recovery, not a provider request", async (t) => {
    const f = await fixture(t);
    await recordSamples(f, [10_000, 10_000, 10_000]);
    const provider = providerAt(1);
    const packet = await f.build(provider);
    assert.equal(budgetOf(packet).tokensActiveMax, 0);
    assert.deepEqual(f.packets.curationOverflow(packet), { weight: packet.weight, budget: 0, excess: packet.weight });
    const result = await f.engine.runTurn({ ...f, provider, messages });
    assert.equal(result.status, 413);
    assert.equal(result.curationFailure?.problem?.ceiling, 0);
    assert.equal(provider.received.length, 0, "no representable curation allowance cannot produce an admitted request");
});
