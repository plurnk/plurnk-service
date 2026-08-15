import test from "node:test";
import assert from "node:assert/strict";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { ProposalApplyRequest, SchemeCtx } from "@plurnk/plurnk-schemes";
import ProposalLifecycle from "./ProposalLifecycle.ts";
import SchemeRegistry from "./SchemeRegistry.ts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import LiveSubscriptions from "./LiveSubscriptions.ts";
import EditCollision from "../content/edit-collision.ts";

const lifecycleWithDb = (db: Db): ProposalLifecycle => new ProposalLifecycle({
    db,
    schemes: new SchemeRegistry(),
    notices: { push() {} } as unknown as NoticeChannel,
    weigh: (text) => text.length,
    executors: () => undefined,
    loopSignal: () => undefined,
    liveSubscriptions: new LiveSubscriptions(),
});

test("proposal timeout rejects every explicit non-positive or non-finite value at its owner", (t) => {
    const prior = process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
    t.after(() => {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS;
        else process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = prior;
    });
    const lifecycle = lifecycleWithDb({} as Db);

    for (const raw of ["invalid", "0", "-1", "Infinity", "NaN", " "]) {
        process.env.PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS = raw;
        assert.throws(
            () => lifecycle.awaitResolution(1),
            (error: unknown) => {
                assert.ok(error instanceof RangeError);
                assert.equal(
                    error.message,
                    `PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS must be empty or a finite positive number of milliseconds; got ${JSON.stringify(raw)}`,
                );
                return true;
            },
        );
    }
});

test("pending projection rejects malformed durable review material at its owner", async () => {
    const base = {
        logEntryId: 7,
        workspaceId: 11,
        workerId: 12,
        loopId: 13,
        turnId: 14,
        op: "EDIT",
        signal: null,
        scheme: "worker",
        pathname: "/x",
        rx: JSON.stringify({ status: 202 }),
        attrs: "{}",
        loop_flags: "{}",
    };
    const cases = [
        {
            row: { ...base, attrs: "[]" },
            error: /Pending proposal 7 has invalid attrs JSON/,
        },
        {
            row: { ...base, loop_flags: JSON.stringify({ auto: "yes" }) },
            error: /Loop 13 has invalid persisted flags/,
        },
        {
            row: { ...base, op: "SEND", signal: JSON.stringify(300), scheme: null, pathname: null },
            error: /Pending SEND signal 300 proposal 7 has no question/,
        },
    ];

    for (const { row, error } of cases) {
        const db = {
            proposal_get_pending: { get: async () => row },
            engine_target_diverged_this_turn: { get: async () => undefined },
        } as unknown as Db;
        await assert.rejects(lifecycleWithDb(db).pending(7), error);
    }
});

test("workerApply invokes a discovered scheme through the public proposal context", async () => {
    const schemes = new SchemeRegistry();
    await schemes.discoverExternal();
    const http = schemes.get("http") as {
        applyResolution?: (request: ProposalApplyRequest, ctx: SchemeCtx) => Promise<{ status: number; outcome?: string; body?: string }>;
    };
    let receivedContext: SchemeCtx | undefined;
    http.applyResolution = async (request, ctx) => {
        receivedContext = ctx;
        assert.deepEqual(request, { attrs: { operation: "publish" }, body: "accepted body" });
        assert.equal(ctx.workspaceId, 11);
        assert.equal(typeof ctx.entries.read, "function");
        return { status: 200, outcome: "published", body: "landed body" };
    };

    const lifecycle = new ProposalLifecycle({
        db: {} as Db,
        schemes,
        notices: { push() {} } as unknown as NoticeChannel,
        weigh: (text) => text.length,
        executors: () => undefined as ExecutorRegistry | undefined,
        loopSignal: () => undefined,
        liveSubscriptions: new LiveSubscriptions(),
    });
    const statement = {
        op: "EDIT",
        suffix: "",
        signal: null,
        target: {
            kind: "url",
            raw: "http:///article",
            scheme: "http",
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: "/article",
            query: null,
            fragment: null,
        },
        lineMarker: null,
        body: "proposed body",
        position: { line: 1, column: 1 },
    } as PlurnkStatement;

    const resolution = await lifecycle.workerApply(
        statement,
        { status: 202, attrs: { operation: "publish" } },
        { decision: "accept", body: "accepted body" },
        { workspaceId: 11, workerId: 12, loopId: 13, turnId: 14 },
    );

    assert.ok(receivedContext);
    assert.deepEqual(resolution, {
        resolution: {
            decision: "accept",
            body: "landed body",
            outcome: "published",
        },
        applied: {
            status: 200,
            outcome: "published",
            body: "landed body",
        },
    });
});

test("applyResolution preserves an accepted scheme's failed result and durable occurrence", async () => {
    let persisted: {
        id: number;
        state: string;
        outcome: string | null;
        status_rx: number;
        rx: string;
        weight: number;
    } | undefined;
    const db = {
        engine_log_entry_coordinate: {
            get: async () => ({
                loop_seq: 2,
                turn_seq: 3,
                sequence: 4,
                op: "EDIT",
                attrs: "{}",
                tx: JSON.stringify({ op: "EDIT", body: "stale proposal body" }),
                mimetype_tx: "application/json",
                mimetype_rx: "application/json",
            }),
        },
        engine_resolve_log_entry: {
            run: async (input: typeof persisted) => {
                persisted = input;
                return { changes: 1 };
            },
        },
    } as unknown as Db;
    const lifecycle = lifecycleWithDb(db);
    const applied = EditCollision.result("notes.md", { outcome: "edit_collision" });

    const result = await lifecycle.applyResolution(41, {
        resolution: { decision: "accept" },
        applied,
    });

    assert.equal(result, applied, "the applying scheme's exact result remains authoritative");
    assert.deepEqual(result.problem, {
        type: "https://problems.plurnk.dev/engine/edit/edit-collision",
        title: "Edit collision",
        status: 409,
        detail: "EDIT collided with another change at notes.md.",
        target: "notes.md",
        recovery: "READ notes.md again and retry the intended edit against its current coordinates.",
        retryable: true,
        instance: "log:///2/3/4/EDIT",
    });
    assert.equal(persisted?.status_rx, 409);
    assert.equal(persisted?.state, "failed");
    assert.equal(persisted?.outcome, "edit_collision");
    assert.equal(persisted?.weight, 0, "the bodyless collision replaces any proposed-body weight");
    assert.deepEqual(JSON.parse(persisted!.rx), result);
});

test("applyResolution rejects projected fields that could override the operation result contract", async () => {
    const lifecycle = lifecycleWithDb({} as Db);

    await assert.rejects(
        lifecycle.applyResolution(41, {
            resolution: {
                decision: "accept",
                result: { status: 500 },
            },
        }),
        /cannot override reserved operation result field 'status'/,
    );
});
