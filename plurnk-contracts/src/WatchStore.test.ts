import assert from "node:assert/strict";
import test from "node:test";
import {
    createWatchState,
    hydrateWatchState,
    projectWatchOverview,
    reduceWatchNotification,
    toDaemonControlEnvelope,
    toDaemonNotification,
    Validator,
    watchSessionKey,
    type ClientInteractionProjection,
    type ProposalProjection,
} from "./index.ts";

test("{§application-session-observation} {§notifications} WatchStore homomorphism and idempotence matrix across snapshot, workspace, session, loop, reply, and gate transitions", () => {
    const proposal: ProposalProjection = {
        logEntryId: 41,
        sessionId: 10,
        session: "main",
        loopId: 3,
        turnId: 1,
        coordinate: "1/1/1",
        op: "sh",
        target: { scheme: "exec", authority: null, pathname: "/sh/1" },
        body: "echo hi",
        attrs: {},
        owner: "acp://operator",
        subject: {
            type: "command",
            command: "echo hi",
            cwd: "/tmp/alpha",
        },
        disposition: { decision: "review" },
    };
    const autoAcceptProposal: ProposalProjection = {
        ...proposal,
        logEntryId: 42,
        disposition: { decision: "accept" },
    };
    const interaction: ClientInteractionProjection = {
        interactionId: 77,
        sessionId: 11,
        loopId: 4,
        turnId: 1,
        recipient: "acp://operator",
        request: {
            toolName: "question",
            mode: "form",
            message: "Proceed?",
            requestedSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
    };

    const snapshotEnvelope = toDaemonControlEnvelope(
        0,
        null,
        null,
        "notifications/snapshot",
        {
            reason: "initial",
            epoch: "a1b2c3d4e5f6",
            latestId: 0,
            workspaces: [{ id: 1, name: "alpha", projectRoot: "/tmp/alpha", projectLabel: "~/alpha" }],
            sessions: [
                {
                    workspaceId: 1,
                    id: 10,
                    name: "main",
                    parentSessionId: null,
                    parentName: null,
                    parentOrigin: null,
                    kind: "root",
                    lifecycle: "idle",
                    gates: 0,
                    reply: null,
                },
            ],
            proposals: [],
            interactions: [],
            omitted: 0,
        },
        1700000000000,
    );
    Validator.assertDaemonNotification(snapshotEnvelope);

    let state = createWatchState();
    assert.equal(state.hydrated, false);
    const hydrated = reduceWatchNotification(state, snapshotEnvelope);
    assert.equal(hydrated.changed, true);
    assert.equal(hydrated.resyncRequired, false);
    state = hydrated.state;
    assert.equal(state.hydrated, true);
    assert.equal(state.epoch, "a1b2c3d4e5f6");

    const deltas = [
        toDaemonNotification(1, null, "workspace/created", {
            id: 2,
            name: "beta",
            projectRoot: null,
            projectLabel: null,
        }),
        toDaemonNotification(2, 1, "session/created", {
            id: 11,
            workspaceId: 1,
            workspaceName: "alpha",
            projectRoot: "/tmp/alpha",
            projectLabel: "~/alpha",
            name: "worker",
            parentSessionId: 10,
            origin: "model",
            kind: "work",
            lifecycle: "idle",
            persona: "reviewer",
        }),
        toDaemonNotification(3, 1, "loop/started", {
            sessionId: 10,
            loopId: 3,
            loopSeq: 1,
            opening: "Audit notifications plane",
        }),
        toDaemonNotification(4, 1, "loop/proposal", autoAcceptProposal),
        toDaemonNotification(5, 1, "loop/proposal", proposal),
        // Duplicate delivery of the exact same review proposal must be idempotent (gates stays 1, not 2)
        toDaemonNotification(5, 1, "loop/proposal", proposal),
        toDaemonNotification(6, 1, "loop/interaction", interaction),
        toDaemonNotification(7, 1, "session/titled", { id: 10, title: "Watch Overhaul" }),
        toDaemonNotification(8, 1, "session/policy", {
            sessionId: 11,
            model: null,
            childModel: null,
            persona: "architect",
        }),
        toDaemonNotification(9, 1, "session/replied", {
            sessionId: 10,
            loopId: 3,
            loopSeq: 1,
            reply: {
                id: 90,
                coordinate: "1/1/3",
                completion: 200,
                at: 1700000005000,
                excerpt: "Watch plane aligned.",
                continued: false,
            },
            repliedToActors: [{ id: "sub-1", handle: "alice", name: "Alice" }],
        }),
        toDaemonNotification(10, 1, "workspace/renamed", { id: 1, name: "alpha-renamed" }),
        toDaemonNotification(11, 1, "loop/gate-settled", {
            kind: "proposal",
            sessionId: 10,
            loopId: 3,
            logEntryId: 41,
            decision: "accept",
            outcome: "approved",
        }),
        // Duplicate gate settlement is idempotent (gates stays 0, never negative)
        toDaemonNotification(11, 1, "loop/gate-settled", {
            kind: "proposal",
            sessionId: 10,
            loopId: 3,
            logEntryId: 41,
            decision: "accept",
            outcome: "approved",
        }),
        toDaemonNotification(12, 1, "loop/parked", {
            sessionId: 10,
            loopId: 3,
            loopSeq: 1,
            status: 202,
        }),
    ];

    for (const delta of deltas) {
        Validator.assertDaemonNotification(delta);
        state = reduceWatchNotification(state, delta).state;
    }

    assert.equal(state.sessions.get(watchSessionKey(1, 10))?.gates, 0);
    assert.equal(state.sessions.get(watchSessionKey(1, 10))?.workspaceName, "alpha-renamed");
    assert.equal(state.sessions.get(watchSessionKey(1, 10))?.opening, "Audit notifications plane");
    assert.equal(state.sessions.get(watchSessionKey(1, 11))?.parentName, "main");
    assert.equal(state.sessions.get(watchSessionKey(1, 11))?.parentOrigin, "model");
    assert.equal(state.sessions.get(watchSessionKey(1, 11))?.gates, 1);
    assert.equal(state.sessions.get(watchSessionKey(1, 11))?.persona, "architect");

    const projected = projectWatchOverview(state);
    const rehydrated = hydrateWatchState({
        ...projected,
        epoch: "a1b2c3d4e5f6",
        latestId: 12,
    });
    assert.deepEqual(
        projectWatchOverview(rehydrated),
        projected,
        "Snapshot ⊕ Deltas round-trips losslessly through hydrateWatchState and projectWatchOverview",
    );

    // loop/terminated clears any remaining open session gates and updates lifecycle
    const terminated = toDaemonNotification(13, 1, "loop/terminated", {
        sessionId: 11,
        loopId: 4,
        loopSeq: 1,
        result: {
            status: 499,
            problem: {
                type: "https://problems.plurnk.xyz/engine/loop/cancelled",
                title: "Cancelled",
                status: 499,
                detail: "Loop cancelled.",
            },
        },
        hitMaxTurns: false,
        turnIds: [1],
        attributions: [],
        terminatedAt: 1700000009000,
        usage: {
            accounting: {
                requests: [],
                usage: null,
                knownUsage: null,
                costUsd: null,
                knownCostUsd: null,
            },
            curationWeight: null,
            curationBudget: null,
            contextTokens: null,
            contextCapacity: null,
            meta: {},
        },
    });
    Validator.assertDaemonNotification(terminated);
    state = reduceWatchNotification(state, terminated).state;
    assert.equal(state.sessions.get(watchSessionKey(1, 11))?.gates, 0);
    assert.equal(state.sessions.get(watchSessionKey(1, 11))?.lifecycle, "cancelled");
    assert.equal(state.interactions.size, 0);

    // Subtree archive removes both parent and child sessions
    const archived = toDaemonNotification(14, 1, "session/archived", {
        id: 10,
        archivedAt: "2026-11-28T00:00:00.000Z",
        sessionIds: [10, 11],
    });
    state = reduceWatchNotification(state, archived).state;
    assert.equal(state.sessions.size, 0);

    // ?since=now tail resync frame sets resyncRequired without wiping existing store
    const resync = toDaemonControlEnvelope(20, null, null, "notifications/resync", {
        reason: "evicted",
        epoch: "a1b2c3d4e5f6",
        latestId: 20,
    });
    Validator.assertDaemonNotification(resync);
    const resyncOutcome = reduceWatchNotification(state, resync);
    assert.equal(resyncOutcome.resyncRequired, true);
    assert.equal(resyncOutcome.state.lastEventId, 20);
});

test("{§application-session-observation} {§notifications} WatchStore retains active lifecycles past limit and materializes woken omitted sessions cleanly", () => {
    const initial = toDaemonControlEnvelope(
        10,
        1,
        null,
        "notifications/snapshot",
        {
            reason: "initial",
            epoch: "e1",
            latestId: 10,
            workspaces: [{ id: 1, name: "alpha", projectRoot: "/tmp/alpha", projectLabel: "~/alpha" }],
            sessions: [
                {
                    workspaceId: 1,
                    id: 3,
                    name: "recent-2",
                    parentSessionId: null,
                    parentName: null,
                    parentOrigin: null,
                    kind: "root",
                    lifecycle: "completed",
                    gates: 0,
                    reply: { id: 30, coordinate: "1/1/1", completion: 200, at: 3000, excerpt: "r3", continued: false },
                },
                {
                    workspaceId: 1,
                    id: 2,
                    name: "recent-1",
                    parentSessionId: null,
                    parentName: null,
                    parentOrigin: null,
                    kind: "root",
                    lifecycle: "completed",
                    gates: 0,
                    reply: { id: 20, coordinate: "1/1/1", completion: 200, at: 2000, excerpt: "r2", continued: false },
                },
                {
                    workspaceId: 1,
                    id: 4,
                    name: "live-worker",
                    parentSessionId: 3,
                    parentName: "recent-2",
                    parentOrigin: "model",
                    kind: "work",
                    lifecycle: "running",
                    gates: 0,
                    opening: "Background audit",
                    reply: null,
                },
            ],
            proposals: [],
            interactions: [],
            omitted: 1, // session #1 (completed, reply.id = 10) was omitted past limit = 2
        },
        1700000000000,
    );
    Validator.assertDaemonNotification(initial);

    let state = reduceWatchNotification(createWatchState(), initial).state;
    // Active unreplied session #4 (`running`) stays retained past `limit = 2`!
    const heldInitial = projectWatchOverview(state, { limit: 2 });
    assert.deepEqual(heldInitial.sessions.map((s) => s.id), [3, 2, 4]);
    assert.equal(heldInitial.omitted, 1);

    // Omitted session #1 wakes with a follow-up loop (`loop/started` carries `session` summary)
    const wakeOmitted = toDaemonNotification(11, 1, "loop/started", {
        sessionId: 1,
        loopId: 5,
        loopSeq: 2,
        opening: "Follow-up question",
        session: {
            workspaceId: 1,
            id: 1,
            name: "oldest",
            parentSessionId: null,
            parentName: null,
            parentOrigin: null,
            kind: "root",
            lifecycle: "running",
            gates: 0,
            opening: "Original loop-1 prompt",
            title: "Historical Thread",
            reply: { id: 10, coordinate: "1/1/1", completion: 200, at: 1000, excerpt: "r1", continued: false },
        },
    });
    Validator.assertDaemonNotification(wakeOmitted);
    const wakeOutcome = reduceWatchNotification(state, wakeOmitted);
    assert.equal(wakeOutcome.resyncRequired, false, "loop/started.session materializes omitted session without resync");
    assert.equal(wakeOutcome.changed, true);
    state = wakeOutcome.state;
    assert.equal(state.omitted, 0, "materializing an omitted session decrements state.omitted");

    // Woken session #1 opens a review proposal — retained in both sessions and proposals!
    const gateOnWoken = toDaemonNotification(12, 1, "loop/proposal", {
        logEntryId: 88,
        sessionId: 1,
        session: "oldest",
        loopId: 5,
        turnId: 1,
        coordinate: "2/1/1",
        op: "sh",
        target: { scheme: "exec", authority: null, pathname: "/sh/1" },
        body: "ls",
        attrs: {},
        owner: "acp://operator",
        subject: { type: "command", command: "ls", cwd: "/tmp/alpha" },
        disposition: { decision: "review" },
    });
    state = reduceWatchNotification(state, gateOnWoken).state;
    const heldDuringGate = projectWatchOverview(state, { limit: 2 });
    assert.deepEqual(heldDuringGate.sessions.map((s) => [s.id, s.gates]), [[3, 0], [2, 0], [1, 1], [4, 0]]);
    assert.equal(heldDuringGate.proposals.length, 1);
    assert.equal(heldDuringGate.omitted, 0);

    // Woken session #1 settles gate, replies (`reply.id = 40`), and terminates (`completed`)
    state = reduceWatchNotification(
        state,
        toDaemonNotification(13, 1, "loop/gate-settled", {
            kind: "proposal",
            sessionId: 1,
            loopId: 5,
            logEntryId: 88,
            decision: "accept",
            outcome: "ok",
        }),
    ).state;
    state = reduceWatchNotification(
        state,
        toDaemonNotification(14, 1, "session/replied", {
            sessionId: 1,
            loopId: 5,
            loopSeq: 2,
            reply: { id: 40, coordinate: "2/1/2", completion: 200, at: 4000, excerpt: "r1-new", continued: false },
        }),
    ).state;
    state = reduceWatchNotification(
        state,
        toDaemonNotification(15, 1, "loop/terminated", {
            sessionId: 1,
            loopId: 5,
            loopSeq: 2,
            result: { status: 200 },
            hitMaxTurns: false,
            turnIds: [1],
            attributions: [],
            terminatedAt: 4100,
            usage: {
                accounting: { requests: [], usage: null, knownUsage: null, costUsd: null, knownCostUsd: null },
                curationWeight: null,
                curationBudget: null,
                contextTokens: null,
                contextCapacity: null,
                meta: {},
            },
        }),
    ).state;

    // Session #1 (`reply.id = 40`) now leads [1, 3], active worker #4 stays held, and settled #2 becomes omitted = 1!
    const heldAfterSettle = projectWatchOverview(state, { limit: 2 });
    assert.deepEqual(heldAfterSettle.sessions.map((s) => s.id), [1, 3, 4]);
    assert.equal(heldAfterSettle.sessions[0]?.opening, "Original loop-1 prompt");
    assert.equal(heldAfterSettle.sessions[0]?.title, "Historical Thread");
    assert.equal(heldAfterSettle.omitted, 1);

    // Defensive fallback: if state.omitted > 0 and a delta without `session` targets an unknown sessionId, resyncRequired is true
    const fallbackState = hydrateWatchState({
        ...heldAfterSettle,
        epoch: "e1",
        latestId: 15,
    });
    assert.equal(
        reduceWatchNotification(
            fallbackState,
            toDaemonNotification(16, 1, "loop/started", { sessionId: 999, loopId: 9, loopSeq: 1 }),
        ).resyncRequired,
        true,
    );
    assert.equal(
        reduceWatchNotification(
            fallbackState,
            toDaemonNotification(17, 1, "session/archived", { id: 2, archivedAt: null, sessionIds: [2] }),
        ).resyncRequired,
        true,
    );
});
