import { serverProposals } from "./_approval.ts";
// {§session-obligations} a message a session sent to another session holds the sender: its authored WAIT parks,
// and the recipient's completion, 200 or 499, wakes the same loop. {§message-abandonment}: a recipient loop
// that ends without answering is answered 499 by the daemon, and that completion wakes the sender too.
// The ping/pong here is child to parent, a direction no child obligation covers: without the rule the child's
// WAIT would read "nothing in flight", continue, and ask for its next turn before the parent answered.
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { viableWindow } from "./_provider.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications, waitForDb, waitFor } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import type { Db } from "../../src/core/Db.ts";

// A step yields fenced operations, or `{ raw }` for text the engine must parse and judge on its own terms.
type Emission = string | { raw: string };
type Step = (db: Db) => Promise<Emission> | Emission;

// One script per session, routed by the identity block each packet carries ({§child-orientation}), so the
// order in which two sessions ask for their turns never matters. A step may read the database when it runs,
// since the parent answers the child's message by the address the daemon minted for it.
class Scripted extends Mock {
    readonly #scripts: Record<string, Step[]>;
    readonly #db: () => Db;
    constructor(db: () => Db, scripts: Record<string, Step[]>) {
        super({ contextWindow: viableWindow(), responses: [] });
        this.#scripts = Object.fromEntries(Object.entries(scripts).map(([name, steps]) => [name, [...steps]]));
        this.#db = db;
    }
    left(name: string): number { return this.#scripts[name]?.length ?? 0; }
    override get remaining(): number { return Object.values(this.#scripts).reduce((sum, steps) => sum + steps.length, 0); }
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const packet = args[0].messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
        const name = Object.keys(this.#scripts).find((candidate) => candidate !== "root" && packet.includes(`"path":"session://${candidate}","parent":`)) ?? "root";
        const step = this.#scripts[name]?.shift();
        if (step === undefined) throw new Error(`scripted provider: '${name}' asked for a turn its script does not have`);
        const emission = await step(this.#db());
        const response = typeof emission === "string" ? makeMockResponse(emission, 10) : makeRawMockResponse(emission.raw, 10);
        const once = new Mock({ contextWindow: viableWindow(), responses: [response] });
        return once.generate(...args);
    }
}

// The child learns its parent's minted name from its task: the message the parent sent it names its source.
const parentOf = async (db: Db, workspaceId: number, child: string): Promise<string> => {
    const session = await waitForDb(() => db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: child }), (row) => row !== undefined);
    const task = await waitForDb(() => db.test_messages_by_session.all<{ ordinal: number; source: string | null }>({ session_id: session!.id }), (rows) => rows.some((row) => row.ordinal === 1));
    return task.find((row) => row.ordinal === 1)!.source!;
};

const openMessageFrom = async (db: Db, workspaceId: number, sender: string): Promise<string> => {
    const row = await waitForDb(
        () => db.test_open_message_from.get<{ path: string }>({ workspace_id: workspaceId, source: `session://${sender}` }),
        (found) => found !== undefined,
    );
    return row!.path;
};

const sessionIdOf = async (db: Db, workspaceId: number, name: string): Promise<number> =>
    (await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name }))!.id;

const loopsOf = async (db: Db, sessionId: number): Promise<number> =>
    (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: sessionId }))!.n;

const inferenceStatuses = async (db: Db, sessionId: number): Promise<number[]> => {
    const loops = await db.test_list_loops_all.all<{ id: number; session_id: number }>({});
    const loop = loops.find((row) => row.session_id === sessionId)!;
    const turns = await db.test_list_turns_in_loop.all<{ kind: string; status: number }>({ loop_id: loop.id });
    return turns.filter((turn) => turn.kind === "inference").map((turn) => turn.status);
};

for (const [name, completion, answer] of [["answered 200", 200, "the code is 4815"], ["declined 499", 499, "no code for you"]] as const) {
    test(`{§session-obligations} a child's message to its parent holds the child's WAIT, and the parent's completion (${name}) wakes the same loop`, async (approvalContext) => {
        serverProposals(approvalContext, "accept");
        let db!: Db;
        let workspaceId = 0;
        const provider = new Scripted(() => db, {
            root: [
                () => "````WORK (session://kid)\nask me for the code, then report what I said\n````\n\n````WAIT\nawaiting kid\n````",
                async (d) => `\`\`\`\`SEND (${await openMessageFrom(d, workspaceId, "kid")}) [${completion}]\n${answer}\n\`\`\`\`\n\n\`\`\`\`WAIT\nstill awaiting kid\n\`\`\`\``,
                () => "````SEND [200]\nkid is done\n````",
            ],
            kid: [
                async (d) => `\`\`\`\`SEND (${await parentOf(d, workspaceId, "kid")})\nwhat is the code?\n\`\`\`\`\n\n\`\`\`\`WAIT\nawaiting the parent's answer\n\`\`\`\``,
                () => "````SEND [200]\nreported\n````",
            ],
        });
        await withDaemon(provider, async (database, _daemon, addr) => {
            db = database;
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: `message-hold-${completion}` });
                workspaceId = (created.result as { id: number }).id;
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn kid and answer it" });
                assert.equal(finalStatus, 200, "the parent concluded after kid reported");
                assert.equal(provider.remaining, 0, "every scripted turn of both sessions ran");
                const kid = await sessionIdOf(db, workspaceId, "kid");
                assert.equal(await loopsOf(db, kid), 1, "the completion woke kid's parked loop; no fresh loop was minted");
                assert.equal((await inferenceStatuses(db, kid))[0], 202, "kid's WAIT parked on its message to the parent, nothing else being live");
                const completed = await db.test_message_completions_from.all<{ status: number; origin: string }>({ workspace_id: workspaceId, source: "session://kid" });
                assert.deepEqual(completed.map((row) => [row.status, row.origin]), [[completion, "model"]], "the parent's reply completed kid's message as authored");
                const [kidEnded] = await waitFor(
                    () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId === kid),
                    (events) => events.length > 0,
                );
                assert.equal(kidEnded.result.status, 200, "kid concluded 200 after the parent's");
            } finally { ws.close(); }
        });
    });
}

test("{§message-abandonment} a parent that strikes out with the child's message unanswered: the daemon completes it 499 and the child wakes", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    let db!: Db;
    let workspaceId = 0;
    // A turn ceiling would end the child too ({§turn-cap-counts-the-tree}); strikes are the parent's alone. The
    // parent wakes on the question and answers with prose carrying no operation, turn after turn, until its
    // strike threshold ends its loop with the question unanswered.
    const provider = new Scripted(() => db, {
        root: [
            () => "````WORK (session://kid)\nask me for the code, then report what happened\n````\n\n````WAIT\nawaiting kid\n````",
            ...Array.from({ length: 16 }, () => () => ({ raw: "I am thinking about the code and will answer soon." })),
        ],
        kid: [
            async (d) => `\`\`\`\`SEND (${await parentOf(d, workspaceId, "kid")})\nwhat is the code?\n\`\`\`\`\n\n\`\`\`\`WAIT\nawaiting the parent's answer\n\`\`\`\``,
            () => "````SEND [200]\nthe parent went away without answering\n````",
        ],
    });
    await withDaemon(provider, async (database, _daemon, addr) => {
        db = database;
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "message-abandoned" });
            workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn kid and stall" });
            assert.ok(finalStatus >= 400 && finalStatus !== 499, `the parent's loop ended by its own strikes, not a cancellation; got ${finalStatus}`);
            const completed = await waitForDb(
                () => db.test_message_completions_from.all<{ status: number; origin: string }>({ workspace_id: workspaceId, source: "session://kid" }),
                (rows) => rows.length > 0,
            );
            assert.deepEqual(completed.map((row) => [row.status, row.origin]), [[499, "_plurnk"]], `the daemon completed kid's message 499 by its own hand; saw ${JSON.stringify(completed)} after the parent ended ${finalStatus}`);
            const kid = await sessionIdOf(db, workspaceId, "kid");
            const kidDone = await waitForDb(
                () => db.test_list_loops_all.all<{ status: number; session_id: number }>({}),
                (loops) => loops.some((loop) => loop.session_id === kid && loop.status === 200),
            );
            assert.ok(kidDone.length > 0);
            assert.equal(provider.left("kid"), 0, "kid woke on the 499 and reported");
            assert.equal(await loopsOf(db, kid), 1, "the same parked loop woke; none was minted");
            assert.equal((await inferenceStatuses(db, kid))[0], 202, "kid's WAIT had parked on its message");
            const [kidEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId === kid),
                (events) => events.length > 0,
            );
            assert.equal(kidEnded.result.status, 200, "kid concluded 200");
        } finally { ws.close(); }
    });
});
