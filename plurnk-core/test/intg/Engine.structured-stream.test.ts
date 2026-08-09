import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

class StructuredFixture {
    static manifest = {
        name: "structured-fixture",
        channels: { results: "application/json" },
        defaultChannel: "results",
        category: "data",
        writableBy: ["plurnk"],
        volatile: true,
        modelVisible: false,
    } as const;
}

const response = (status: number) => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [sendStmt(status, null, status === 200 ? "done" : "continue")],
    },
});

const setup = async (mimetype: string, content: string) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `structured-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "observe structured output");
    const schemes = new SchemeRegistry();
    schemes.register("structured-fixture", new StructuredFixture());
    const engine = new Engine({ db, schemes });
    const entryId = await seedEntryWithChannel(db, {
        workspaceId,
        ownerId: workerId,
        scheme: "structured-fixture",
        pathname: "/1/0/1",
        channel: "results",
        content,
        mimetype,
        state: "active",
    });
    const subscriptionId = await ChannelWrite.openSubscription(db, {
        workerId,
        entryId,
        scheme: "structured-fixture",
        handle: "fixture",
        publishedChannel: "results",
    });
    const provider = new Mock({ contextWindow: 100000, responses: [response(102), response(200)] });
    const runTurn = () => engine.runTurn({
        provider,
        workspaceId,
        workerId,
        loopId,
        messages: [
            { role: "system" as const, content: "Observe the result." },
            { role: "user" as const, content: "Continue." },
        ],
    });
    return { db, entryId, subscriptionId, runTurn };
};

const structuredRows = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number) =>
    db.test_log_entries_by_turn.all<{
        scheme: string;
        op: string;
        origin: string;
        rx: string;
        attrs: string;
    }>({ turn_id: turnId }).then((rows) => rows.filter((row) =>
        row.scheme === "structured-fixture" && row.op === "READ" && row.origin === "plurnk"));

type Fixture = Awaited<ReturnType<typeof setup>>;

const structuredRow = async (fixture: Fixture, turnId: number) => {
    const rows = await structuredRows(fixture.db, turnId);
    assert.equal(rows.length, 1);
    return rows[0]!;
};

const close = async (fixture: Fixture, chunk?: string): Promise<void> => {
    if (chunk !== undefined) {
        await ChannelWrite.appendToChannel(fixture.db, {
            entryId: fixture.entryId,
            channel: "results",
            chunk,
        });
    }
    await ChannelWrite.setChannelState(fixture.db, {
        entryId: fixture.entryId,
        channel: "results",
        state: "closed",
    });
    await ChannelWrite.closeSubscription(fixture.db, {
        subscriptionId: fixture.subscriptionId,
        result: { status: 200 },
    });
};

test("an atomic application/json channel remains hidden until its complete terminal document exists", async () => {
    const fixture = await setup("application/json", '[{"n":1},');
    try {
        const active = await fixture.runTurn();
        assert.deepEqual(
            await structuredRows(fixture.db, active.turnId),
            [],
            "an active fragment is not surfaced as malformed JSON",
        );

        await close(fixture, '{"n":2}]');

        const terminal = await fixture.runTurn();
        const row = await structuredRow(fixture, terminal.turnId);
        const result = JSON.parse(row.rx) as { content: string; mimetype: string; startLine?: number };
        assert.deepEqual(result, {
            status: 200,
            content: '[{"n":1},{"n":2}]',
            mimetype: "application/json",
            startLine: 1,
        });
        assert.deepEqual(JSON.parse(row.attrs), { streamEnd: 17, terminal: true });
    } finally {
        await fixture.db.close();
    }
});

test("application/jsonl publishes complete records without exposing an active partial record", async () => {
    const fixture = await setup("application/jsonl", '{"n":1}\n{"n":');
    try {
        const active = await fixture.runTurn();
        const activeRow = await structuredRow(fixture, active.turnId);
        assert.deepEqual(JSON.parse(activeRow.rx), {
            status: 200,
            content: '{"n":1}\n',
            mimetype: "application/jsonl",
            startLine: 1,
        });
        assert.deepEqual(JSON.parse(activeRow.attrs), { streamEnd: 8, terminal: false });

        await close(fixture, "2}\n");

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            content: '{"n":2}\n',
            mimetype: "application/jsonl",
            startLine: 2,
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 16, terminal: true });
    } finally {
        await fixture.db.close();
    }
});

test("an active text channel retains incremental publication", async () => {
    const fixture = await setup("text/plain; charset=utf-8", "event one\n");
    try {
        const active = await fixture.runTurn();
        const activeRow = await structuredRow(fixture, active.turnId);
        assert.deepEqual(JSON.parse(activeRow.rx), {
            status: 200,
            content: "event one\n",
            mimetype: "text/plain; charset=utf-8",
            startLine: 1,
        });

        await close(fixture, "event two\n");

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            content: "event two\n",
            mimetype: "text/plain; charset=utf-8",
            startLine: 2,
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 20, terminal: true });
    } finally {
        await fixture.db.close();
    }
});

test("a structured stream that closes after publication emits one typed conclusion without replay", async () => {
    const fixture = await setup("application/jsonl", '{"n":1}\n');
    try {
        const active = await fixture.runTurn();
        assert.equal((await structuredRows(fixture.db, active.turnId)).length, 1);

        await close(fixture);

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            content: "",
            mimetype: "application/jsonl",
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 8, terminal: true });
    } finally {
        await fixture.db.close();
    }
});
