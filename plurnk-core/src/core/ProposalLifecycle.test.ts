import test from "node:test";
import assert from "node:assert/strict";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { Results, type ProposalApplyRequest, type SchemeCtx } from "@plurnk/plurnk-schemes";
import ProposalLifecycle from "./ProposalLifecycle.ts";
import SchemeRegistry from "./SchemeRegistry.ts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import LiveSubscriptions from "./LiveSubscriptions.ts";

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
        tokenize: (text) => text.length,
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
    } | undefined;
    const db = {
        engine_log_entry_coordinate: {
            get: async () => ({ loop_seq: 2, turn_seq: 3, sequence: 4, op: "EDIT" }),
        },
        engine_resolve_log_entry: {
            run: async (input: typeof persisted) => {
                persisted = input;
                return { changes: 1 };
            },
        },
    } as unknown as Db;
    const lifecycle = new ProposalLifecycle({
        db,
        schemes: new SchemeRegistry(),
        notices: { push() {} } as unknown as NoticeChannel,
        tokenize: (text) => text.length,
        executors: () => undefined,
        loopSignal: () => undefined,
        liveSubscriptions: new LiveSubscriptions(),
    });
    const applied = Results.failure(
        "scheme:file",
        "write-conflict",
        409,
        "The file changed after review.",
        { outcome: "write_conflict" },
    );

    const result = await lifecycle.applyResolution(41, {
        resolution: { decision: "accept" },
        applied,
    });

    assert.equal(result, applied, "the applying scheme's exact result remains authoritative");
    assert.deepEqual(result.problem, {
        type: "https://problems.plurnk.dev/scheme/file/write-conflict",
        title: "Write conflict",
        status: 409,
        detail: "The file changed after review.",
        instance: "log:///2/3/4/EDIT",
    });
    assert.equal(persisted?.status_rx, 409);
    assert.equal(persisted?.state, "failed");
    assert.equal(persisted?.outcome, "write_conflict");
    assert.deepEqual(JSON.parse(persisted!.rx), result);
});

test("applyResolution rejects projected fields that could override the operation result contract", async () => {
    const lifecycle = new ProposalLifecycle({
        db: {} as Db,
        schemes: new SchemeRegistry(),
        notices: { push() {} } as unknown as NoticeChannel,
        tokenize: (text) => text.length,
        executors: () => undefined,
        loopSignal: () => undefined,
        liveSubscriptions: new LiveSubscriptions(),
    });

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
