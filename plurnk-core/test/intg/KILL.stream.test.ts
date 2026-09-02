// KILL cancels a live stream ({§stream-control}); the untaught KILL idiom left with the signal slot.

import test from "node:test";
import assert from "node:assert/strict";
import type { KillStatement, ReadStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import {
    Results,
    type RepresentationPreparationRequest,
    type SchemeCtx,
    type StreamSubscription,
} from "@plurnk/plurnk-schemes";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const url = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const killStmt = (target: UrlPath): KillStatement => ({
    metadata: null,
    op: "KILL", annotation: null, delimiter: "", target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const readStmt = (target: UrlPath): ReadStatement => ({
    metadata: null,
    op: "READ", annotation: null, delimiter: "", target, lineMarker: null, body: null,
    position: { line: 1, column: 1 },
});

const setup = async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    return { db, ...env, engine };
};

const dispatch = (engine: Engine, env: { workspaceId: number; workerId: number; loopId: number; turnId: number }, statement: KillStatement) =>
    engine.dispatch({ statement, ...env, sequence: 1, origin: "client" });
test("KILL on nonexistent entry returns 404", async () => {
    const { db, workspaceId, workerId, loopId, turnId, engine } = await setup();
    try {
        const r = await dispatch(engine, { workspaceId, workerId, loopId, turnId }, killStmt(url("worker", "nope")));
        assert.equal(r.status, 404);
    } finally { await db.close(); }
});
test("End-to-end: synthetic streaming scheme — KILL tears down subscription, transitions state, closes record", async () => {
    const { db, workspaceId, workerId, loopId, turnId } = await setup();
    try {
        const teardownCalls: string[] = [];
        const handle = "fake-stream-1";

        class FakeStream {
            static manifest = {
                name: "fakestream", channels: { data: "text/plain" }, defaultChannel: "data",
                category: "data" as const,
                entryOwner: "worker" as const,
                inherit: "none" as const,
                writableBy: ["model" as const, "client" as const], volatile: true, modelVisible: true,
            };
            async prepareRepresentation(
                request: RepresentationPreparationRequest,
                ctx: SchemeCtx,
            ): Promise<{ status: number }> {
                const path = request.target;
                if (path === null || path.kind !== "url") {
                    return Results.failure(
                        "scheme:teststream",
                        "target-required",
                        400,
                        "The stream fixture requires a URL target.",
                        {},
                        { stage: "validate", retryable: false },
                    );
                }
                await ctx.entries.write(request.pathname, {
                    channels: { data: { content: "", mimetype: "text/plain", state: "active" } },
                });
                let subscription: StreamSubscription | undefined;
                subscription = await ctx.subscriptions.open(request.pathname, {
                    cancel: async () => {
                        teardownCalls.push(handle);
                        if (subscription === undefined) throw new Error("stream subscription missing");
                        await subscription.close(
                            Results.failure("scheme:teststream", "cancelled", 499, "The stream was cancelled by KILL."),
                            "cancelled by KILL",
                        );
                    },
                });
                return { status: 102 };
            }
        }

        const schemes = new SchemeRegistry();
        schemes.register("fakestream", new FakeStream());
        const engine = new Engine({ db, schemes });
        const opened = await engine.dispatch({
            statement: readStmt(url("fakestream", "/feed/x")),
            workspaceId, workerId, loopId, turnId,
            sequence: 1, origin: "client",
        });
        assert.equal(opened.status, 102, "scheme opened the subscription through public capabilities");
        const entry = await db.test_get_entry_by_path.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "fakestream", pathname: "/feed/x",
        });
        if (entry === undefined) throw new Error("stream entry missing");
        const entryId = entry.id;
        const activeBefore = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        if (activeBefore === null) throw new Error("subscription missing");
        const subId = activeBefore.id;

        const result = await engine.dispatch({
            statement: killStmt(url("fakestream", "/feed/x")),
            workspaceId, workerId, loopId, turnId,
            sequence: 2, origin: "client",
        });

        assert.equal(result.status, 200, "scheme accepts cancel");
        assert.deepEqual(teardownCalls, [handle], "teardown callback fired with subscription handle");

        const sub = await db.test_get_subscription.get<{
            closed_at: string | null;
            close_status: number | null;
            close_result: string | null;
        }>({ id: subId });
        assert.ok(sub?.closed_at !== null, "subscription marked closed");
        assert.equal(sub?.close_status, 499, "close_status = 499");
        const terminal = JSON.parse(sub?.close_result ?? "null") as {
            status?: number;
            problem?: { type?: string; status?: number; detail?: string };
        };
        assert.equal(terminal.status, 499);
        assert.equal(terminal.problem?.status, 499);
        assert.equal(terminal.problem?.type, "https://problems.plurnk.xyz/scheme/teststream/cancelled");
        assert.equal(terminal.problem?.detail, "The stream was cancelled by KILL.");

        const channelState = (await db.test_get_channel.get<{ state: string }>({ entry_id: entryId, name: "data" }))?.state;
        assert.equal(channelState, "errored", "cancelled content remains readable but is not marked complete");

        const active = await ChannelWrite.findActiveSubscription(db, { workerId, entryId });
        assert.equal(active, null, "no active subscription remaining");
    } finally { await db.close(); }
});
