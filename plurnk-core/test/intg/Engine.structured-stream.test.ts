import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import type { KillStatement } from "@plurnk/plurnk-contracts";
import { Results } from "@plurnk/plurnk-schemes";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_helpers.ts";
import { sendStmt, urlPath } from "./_dsl.ts";

class StructuredFixture {
    static manifest = {
        name: "structured-fixture",
        channels: { results: "application/json" },
        defaultChannel: "results",
        category: "data",
        entryOwner: "worker",
        inherit: "none",
        writableBy: ["_plurnk"],
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

const setup = async (
    mimetype: string,
    content: string,
    responses: ConstructorParameters<typeof Mock>[0]["responses"] = [response(102), response(200)],
) => {
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
    const provider = new Mock({ contextWindow: 100000, responses });
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
        sequence: number;
        scheme: string;
        op: string;
        origin: string;
        rx: string;
        attrs: string;
    }>({ turn_id: turnId }).then((rows) => rows.filter((row) =>
        row.scheme === "structured-fixture" && row.op === "READ" && row.origin === "_plurnk"));

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
        // {§exec-stream-page} — the conclusion is a markerless READ: first page, extent.
        assert.deepEqual(result, {
            status: 200,
            content: '[{"n":1},{"n":2}]',
            mimetype: "application/json",
            startLine: 1,
            range: { unit: "line", total: 1, requested: [1, 16], returned: [1, 1] },
        });
        assert.deepEqual(JSON.parse(row.attrs), { streamEnd: 17, terminal: true });
    } finally {
        await fixture.db.close();
    }
});

test("application/jsonl publishes nothing while active; its records arrive once, at close", async () => {
    const fixture = await setup("application/jsonl", '{"n":1}\n{"n":');
    try {
        const active = await fixture.runTurn();
        assert.deepEqual(await structuredRows(fixture.db, active.turnId), [], "an active stream enters the Log only as its Child Streams pointer");

        await close(fixture, "2}\n");

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            content: '{"n":1}\n{"n":2}\n',
            mimetype: "application/jsonl",
            startLine: 1,
            range: { unit: "line", total: 2, requested: [1, 16], returned: [1, 2] },
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 16, terminal: true });
    } finally {
        await fixture.db.close();
    }
});

test("an active text channel publishes nothing; its content arrives once, at close", async () => {
    const fixture = await setup("text/plain; charset=utf-8", "event one\n");
    try {
        const active = await fixture.runTurn();
        assert.deepEqual(await structuredRows(fixture.db, active.turnId), [], "an active stream enters the Log only as its Child Streams pointer");

        await close(fixture, "event two\n");

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            content: "event one\nevent two\n",
            mimetype: "text/plain; charset=utf-8",
            startLine: 1,
            range: { unit: "line", total: 2, requested: [1, 16], returned: [1, 2] },
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 20, terminal: true });
    } finally {
        await fixture.db.close();
    }
});

test("a stream that closes with no new content still emits exactly one conclusion — its first page", async () => {
    const fixture = await setup("application/jsonl", '{"n":1}\n');
    try {
        const active = await fixture.runTurn();
        assert.equal((await structuredRows(fixture.db, active.turnId)).length, 0);

        await close(fixture);

        const terminal = await fixture.runTurn();
        const terminalRow = await structuredRow(fixture, terminal.turnId);
        assert.deepEqual(JSON.parse(terminalRow.rx), {
            status: 200,
            content: '{"n":1}\n',
            mimetype: "application/jsonl",
            startLine: 1,
            range: { unit: "line", total: 1, requested: [1, 16], returned: [1, 1] },
        });
        assert.deepEqual(JSON.parse(terminalRow.attrs), { streamEnd: 8, terminal: true });
    } finally {
        await fixture.db.close();
    }
});

test("a published channel materializes its exact terminal result override", async () => {
    const fixture = await setup("application/json", '{"ok":false}');
    const channelFailure = Results.failure(
        "scheme:structured-fixture",
        "channel-failed",
        500,
        "The selected representation failed.",
    );
    try {
        await ChannelWrite.closeSubscription(fixture.db, {
            subscriptionId: fixture.subscriptionId,
            result: { status: 200 },
            channelResults: { results: channelFailure },
        });

        const terminal = await fixture.runTurn();
        const row = await structuredRow(fixture, terminal.turnId);
        const result = JSON.parse(row.rx) as {
            status: number;
            content: string;
            mimetype: string;
            problem?: { detail?: string };
        };
        assert.equal(result.status, 500, "the channel override, not the universal success, reaches the model");
        assert.equal(result.problem?.detail, "The selected representation failed.");
        assert.equal(result.content, '{"ok":false}');
        assert.equal(result.mimetype, "application/json");
    } finally {
        await fixture.db.close();
    }
});

test("KILLing a terminal observation cannot erase its subscription delivery transition", async () => {
    const kill: KillStatement = {
        metadata: null,
        op: "KILL",
        annotation: null,
        delimiter: "",
        signal: null,
        target: urlPath("log", "/1/2/2"),
        lineMarker: null,
        body: null,
        position: { line: 1, column: 1 },
    };
    const fixture = await setup("application/json", "", [
        response(102),
        {
            assistant: {
                content: "",
                reasoning: null,
                ops: [kill, sendStmt(102, null, "failure observed")],
            },
        },
        response(200),
    ]);
    try {
        await ChannelWrite.setChannelState(fixture.db, {
            entryId: fixture.entryId,
            channel: "results",
            state: "errored",
        });
        await ChannelWrite.closeSubscription(fixture.db, {
            subscriptionId: fixture.subscriptionId,
            result: Results.failure(
                "scheme:structured-fixture",
                "expected-failure",
                500,
                "The fixture failed as expected.",
                {},
                { retryable: false },
            ),
        });

        const observed = await fixture.runTurn();
        const terminal = await structuredRow(fixture, observed.turnId);
        assert.equal(terminal.sequence, 2, "the terminal observation is the pre-model row addressed by the curation turn");
        assert.equal((JSON.parse(terminal.rx) as { status: number }).status, 500);
        assert.deepEqual(
            await fixture.db.test_subscription_publications.all({ id: fixture.subscriptionId }),
            [{ channel: "results", published_end: 0, terminal_published: 1 }],
            "the terminal READ advances the subscription-owned channel cursor",
        );

        const curated = await fixture.runTurn();
        assert.deepEqual(curated.outcomes, [
            { op: "KILL", status: 200 },
            { op: "SEND", status: 102 },
        ]);
        assert.deepEqual(
            await structuredRows(fixture.db, observed.turnId),
            [],
            "the curation turn physically removed the terminal observation row",
        );
        assert.deepEqual(
            await fixture.db.test_subscription_publications.all({ id: fixture.subscriptionId }),
            [{ channel: "results", published_end: 0, terminal_published: 1 }],
            "KILLing the log row leaves the subscription-owned transition intact",
        );

        const completed = await fixture.runTurn();
        assert.deepEqual(
            await structuredRows(fixture.db, completed.turnId),
            [],
            "the terminal result is not published again after its observation row is curated away",
        );
        assert.deepEqual(completed.outcomes, [{ op: "SEND", status: 200 }],
            "log curation cannot make an already-published terminal result pending again");
        const source = await fixture.db.test_get_subscription.get<{ close_result: string }>({
            id: fixture.subscriptionId,
        });
        assert.equal(
            (JSON.parse(source?.close_result ?? "null") as { status?: number } | null)?.status,
            500,
            "curating the observation leaves the durable source failure intact",
        );
    } finally {
        await fixture.db.close();
    }
});
