import test from "node:test";
import assert from "node:assert/strict";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { ProposalApplyRequest, SchemeCtx } from "@plurnk/plurnk-schemes";
import ProposalLifecycle from "./ProposalLifecycle.ts";
import SchemeRegistry from "./SchemeRegistry.ts";
import type { Db } from "./Db.ts";
import type ExecutorRegistry from "./ExecutorRegistry.ts";
import type TelemetryChannel from "./TelemetryChannel.ts";

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
        assert.equal("db" in ctx, false, "plugins receive the public capability context");
        assert.equal(ctx.workspaceId, 11);
        assert.equal(typeof ctx.entries.read, "function");
        return { status: 200, outcome: "published", body: "landed body" };
    };

    const lifecycle = new ProposalLifecycle({
        db: {} as Db,
        schemes,
        telemetry: { push() {} } as unknown as TelemetryChannel,
        tokenize: (text) => text.length,
        executors: () => undefined as ExecutorRegistry | undefined,
        loopSignal: () => undefined,
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
            params: {},
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
        decision: "accept",
        body: "landed body",
        outcome: "published",
    });
});
