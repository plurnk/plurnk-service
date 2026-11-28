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
