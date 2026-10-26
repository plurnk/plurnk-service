// {§context-admission} {§context-wall-measure} — one request through the room, against a provider that counts
// the exact request in its own vocabulary and reports the count it charged, as a real provider does. The
// story is the shape that ended a loop before: calibrated on prose, the loop meets dense content.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock, chatMessageText, type ChatMessage, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TokenCalibration from "../../src/core/TokenCalibration.ts";
import type { RequestPacket } from "../../src/core/StoredPacket.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";

const messages = [{ role: "system" as const, content: "An agent." }, { role: "user" as const, content: "Review the evidence." }];
const note = (body: string): MockResponse => ({ assistant: { content: `\`\`\`\`NOTE\n${body}\n\`\`\`\``, reasoning: null } });
const PROSE = "Prose runs four characters to a token. ".repeat(100);
const CODE = "{[(<>)]};=".repeat(600);

// The provider's vocabulary: a bracket, a semicolon or an equals sign is a token of its own, anything else
// runs four characters to a token. `charsPerToken` 1 makes every character a token.
const vocabulary = (charsPerToken: 1 | 4) => (text: string): number => {
    let dense = 0;
    for (const char of text) if ("{}()[];=<>".includes(char)) dense++;
    return dense + Math.ceil((text.length - dense) / charsPerToken);
};

class CountingMock extends Mock {
    readonly #script: MockResponse[];
    readonly #count: (text: string) => number;
    constructor(contextWindow: number, script: MockResponse[], count: (text: string) => number) {
        super({ contextWindow, responses: script });
        this.#script = script;
        this.#count = count;
    }

    override async countPromptTokens(prompt: readonly ChatMessage[]) {
        return { kind: "exact" as const, tokens: prompt.reduce((sum, message) => sum + this.#count(chatMessageText(message)), 0), source: "test:vocabulary" };
    }

    // The usage of the next response is the count of the request it answers.
    override async generate(args: Parameters<Mock["generate"]>[0]): ReturnType<Mock["generate"]> {
        const next = this.#script[this.#script.length - this.remaining];
        if (next !== undefined) {
            const { tokens } = await this.countPromptTokens(args.messages);
            next.usage = { inputTokens: tokens, totalTokens: tokens };
        }
        return await super.generate(args);
    }
}

// The room in provider tokens: `capacity` sizes the budget, `wall` admits ({§context-wall}).
const providerAt = ({ capacity, wall }: { capacity: number; wall: number }, script: MockResponse[], charsPerToken: 1 | 4 = 4): CountingMock => {
    const keys = ["PLURNK_PROVIDERS_OUTPUT_BUDGET", "PLURNK_PROVIDERS_OUTPUT_FLOOR", "PLURNK_PROVIDERS_REASONING_BUDGET"] as const;
    const previous = keys.map((key) => process.env[key]);
    const floor = 1_000;
    try {
        process.env.PLURNK_PROVIDERS_OUTPUT_BUDGET = String(wall + floor - capacity);
        process.env.PLURNK_PROVIDERS_OUTPUT_FLOOR = String(floor);
        delete process.env.PLURNK_PROVIDERS_REASONING_BUDGET;
        return new CountingMock(wall + floor, script, vocabulary(charsPerToken));
    } finally {
        keys.forEach((key, index) => {
            if (previous[index] === undefined) delete process.env[key];
            else process.env[key] = previous[index];
        });
    }
};
const ROOMY = { capacity: 900_000, wall: 990_000 };

const fixture = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `context-admission-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "Review the evidence.");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const builder = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
    // The next request as it would be built now.
    const probe = async (provider: Mock): Promise<RequestPacket> => {
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        return await builder.buildRequestPacket({
            initialMessages: messages, workspaceId, sessionId, loopId, provider, currentTurnSeq: next!.next, gitStatus: null,
        });
    };
    return { db, workspaceId, sessionId, loopId, engine, probe };
};
const exact = (provider: CountingMock, request: readonly ChatMessage[]) => provider.countPromptTokens(request).then(({ tokens }) => tokens);

test("{§context-admission} {§context-wall-measure}: calibrated on prose, unmeasured dense code is budgeted 1:1 above the prior offset; under the wall and over budget, the complete packet and its emission history go whole with the 413 over-budget row", async () => {
    const { db, workspaceId, sessionId, loopId, engine, probe } = await fixture();
    try {
        const roomy = providerAt(ROOMY, [note(PROSE), note(PROSE), note(PROSE), note(CODE)]);
        for (let turn = 0; turn < 4; turn++) await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: roomy });
        const offset = await TokenCalibration.forLoop(db, "mock", loopId);
        assert.ok(offset > 0, "prose turns measured below their character weight");

        const full = await probe(roomy);
        const estimate = TokenCalibration.estimatedTokens(full.weight, offset);
        const exactTokens = await exact(roomy, PacketWire.packetToWireMessages(full));
        const wall = exactTokens + 200;

        const tight = providerAt({ capacity: Math.floor(estimate / 2), wall }, [note("Continuing the review.")]);
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: tight });
        assert.equal(result.status, 102, "the request was sent, not ended");
        assert.equal(tight.received.length, 1, "one inference request");
        assert.ok(await exact(tight, tight.received[0]) <= wall, "what was sent fits the wall by the provider's own count");

        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        const replay = packetSection(packet, "emission-history");
        assert.ok(replay.includes(PROSE) && replay.includes(CODE), "the previous programs stay whole in emission-history");
        const rows = logEntries(packet);
        const notes = rows.filter(({ logPath }) => logPath.endsWith("/NOTE"));
        assert.equal(notes.length, 4, "all four NOTE receipts remain in the log");
        assert.ok(notes.every(({ size }) => size === undefined), "no row is reduced to a size receipt by the daemon");
        assert.equal(rows.filter(({ logPath }) => logPath.endsWith("/error")).length, 1, "{§context-over-budget-row}: the over-budget row rides the request that fits");
        const calls = await db.test_model_calls.all<{ capacity: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(calls.map(({ capacity }) => JSON.parse(capacity ?? "null")?.decision), ["admit"], "no refused request reached the provider's generate");
    } finally { await db.close(); }
});

test("{§context-wall-measure} {§context-wall}: a request the provider refuses by exact count ends the loop on the window-overflow Problem, and nothing is sent", async () => {
    const { db, workspaceId, sessionId, loopId, engine, probe } = await fixture();
    try {
        // The loop's first response sets its offset on prose; the tight provider counts every character,
        // so the exact count exceeds the wall even when the calibrated estimate sits below it.
        const roomy = providerAt(ROOMY, [note("Reading the evidence.")]);
        await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: roomy });
        assert.ok(await TokenCalibration.forLoop(db, "mock", loopId) > 0);
        const wall = (await probe(roomy)).weight;
        const tight = providerAt({ capacity: wall, wall }, [note("Continuing the review.")], 1);
        const result = await engine.runTurn({ workspaceId, sessionId, loopId, messages, provider: tight });
        assert.equal(result.status, 413);
        assert.equal(result.capacityHardStop, false, "the window's own terminal, not a provider failure");
        assert.equal(result.curationFailure?.problem?.detail, "Context window overflow: the packet exceeds the model's window."); // {§pinned-wording-core}
        assert.ok(Number(result.curationFailure?.problem?.tokens) > wall, "the terminal names the provider's exact count over the wall");
        assert.equal(tight.received.length, 0, "no inference request");
        const turn = await db.test_get_turn.get<{ packet: string | null }>({ id: result.turnId });
        assert.equal(turn!.packet, null, "a request that was never submitted is not provider evidence");
    } finally { await db.close(); }
});
