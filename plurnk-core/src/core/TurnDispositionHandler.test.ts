import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import type LoopLifecycle from "./LoopLifecycle.ts";
import TurnDispositionHandler from "./TurnDispositionHandler.ts";

test("{§session-wait-timing} the maximum park has one positive configured duration", (t) => {
    const previous = process.env.PLURNK_SERVICE_WAIT_SEC;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
        else process.env.PLURNK_SERVICE_WAIT_SEC = previous;
    });
    for (const seconds of [1, 300, 600]) {
        process.env.PLURNK_SERVICE_WAIT_SEC = String(seconds);
        assert.equal(TurnDispositionHandler.configuredWaitSeconds(), seconds);
    }
    for (const invalid of ["0", "-1", "0.5", "later", ""]) {
        process.env.PLURNK_SERVICE_WAIT_SEC = invalid;
        assert.throws(() => TurnDispositionHandler.configuredWaitSeconds(), ConfigurationError);
    }
});

test("{§session-wait-timing} {§loop-completion} WAIT distinguishes live work, pending completions, and truly idle turns (#1584)", async () => {
    const stmt = (seconds: number | null = null) => ({
        op: "wait" as const,
        aside: null,
        target: null,
        lineMarker: null,
        body: null,
        seconds,
        position: { line: 1, column: 1 },
    });
    const ctx = { sessionId: 1, loopId: 2, turnId: 3, origin: "model" as const };
    const make = (hasLiveWork: boolean, hasPendingCompletions: boolean) => new TurnDispositionHandler({
        db: {} as Db,
        lifecycle: {} as LoopLifecycle,
        unobservedFailureCount: async () => 0,
        pendingSet: async () => ({ pending: [], receipts: [], unreadReceipts: 0 }),
        hasLiveWork: async () => hasLiveWork,
        hasPendingCompletions: async () => hasPendingCompletions,
    });

    assert.deepEqual(
        await make(true, false).handle(ctx, stmt(30)),
        { status: 202, attrs: { waiting: 30 } },
        "live work with positive wait duration requests parking",
    );
    assert.deepEqual(
        await make(true, false).handle(ctx, stmt(0)),
        { status: 102, attrs: { waiting: 0 } },
        "live work with seconds=0 explicitly declines parking",
    );
    assert.deepEqual(
        await make(false, true).handle(ctx, stmt(null)),
        { status: 102, detail: "Pending results are ready. Continuing." },
        "completed work with undelivered results never claims nothing is in flight",
    );
    assert.deepEqual(
        await make(false, false).handle(ctx, stmt(null)),
        { status: 102, detail: "Nothing is in flight. Continuing." },
        "truly idle wait reports nothing in flight",
    );
});
