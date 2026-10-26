// {§place-hiding} — what a hide covers and refuses, the group it marks, what brings a place back, and where a hidden
// place is left out.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import type { ProblemDetails } from "@plurnk/plurnk-contracts";
import { insertSession, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { connect, rpcCall, runLoopToTerminal, subscribeNotifications, waitFor, withDaemon } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { viableWindow } from "./_provider.ts";
import Places, { type PlaceGates } from "../../src/server/Places.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import type { Db } from "../../src/core/Db.ts";

const refusal = async (attempt: Promise<unknown>): Promise<ProblemDetails> => {
    try {
        await attempt;
    } catch (error) {
        assert.ok(error instanceof OperationFailureError, `a Problem, not ${String(error)}`);
        return error.result.problem;
    }
    assert.fail("the call was not refused");
};

const sorted = (ids: readonly number[]): number[] => ids.toSorted((a, b) => a - b);

type Mark = { place: "workspace" | "session"; id: number; hidden_at: string | null; hidden_by: number | null };
const marks = async (db: Db, workspaceId: number): Promise<Mark[]> => db.test_place_marks.all<Mark>({ workspace_id: workspaceId });
const groups = async (db: Db, workspaceId: number): Promise<Record<number, number | null>> =>
    Object.fromEntries((await marks(db, workspaceId)).filter(({ place }) => place === "session").map(({ id, hidden_by }) => [id, hidden_by]));

const NO_GATES: PlaceGates = async () => ({ proposals: [], questions: [] });

// The work a place can hold, and what of it is live: a loop queued, running or parked ({§session-lifecycle-live}), an
// open stream, detached or not, and a gate the engine reports.
const WORK = ["none", "queued", "running", "parked", "concluded", "stream", "detached stream", "closed stream", "proposal", "question"] as const;
type Work = typeof WORK[number];
const COUNTS: Readonly<Record<Work, { loops: number; streams: number; proposals: number; questions: number } | null>> = {
    none: null, concluded: null, "closed stream": null,
    queued: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    running: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    parked: { loops: 1, streams: 0, proposals: 0, questions: 0 },
    stream: { loops: 0, streams: 1, proposals: 0, questions: 0 },
    "detached stream": { loops: 0, streams: 1, proposals: 0, questions: 0 },
    proposal: { loops: 0, streams: 0, proposals: 1, questions: 0 },
    question: { loops: 0, streams: 0, proposals: 0, questions: 1 },
};

const seedWork = async (db: Db, workspaceId: number, sessionId: number, work: Work): Promise<void> => {
    if (work === "queued" || work === "running" || work === "parked") {
        const status = { queued: 100, running: 102, parked: 202 }[work];
        await db.test_loops_insert_with_status.run({ session_id: sessionId, sequence: 1, status, prompt: "work", terminal_result: null });
    } else if (work === "concluded") {
        await db.test_loops_insert_with_status.run({ session_id: sessionId, sequence: 1, status: 200, prompt: "work", terminal_result: JSON.stringify({ status: 200 }) });
    } else if (work === "stream" || work === "detached stream" || work === "closed stream") {
        const entryId = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: `/${sessionId}/1/1/sh`, channel: "stdout", content: "", state: "active" });
        const stream = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: entryId, detached: work === "detached stream" ? 1 : 0 });
        assert.ok(stream !== undefined);
        if (work === "closed stream") await db.test_close_subscription.run({ id: stream.id });
    }
};

// Where the work sits: on the place (the session, or a root of the workspace), beneath it (a grandchild of the session,
// or a child in the workspace), or outside it (a sibling of the session, or a session of another workspace).
const POSITIONS = ["at", "beneath", "outside"] as const;

for (const target of ["workspace", "session"] as const) {
    test(`{§place-hiding} a ${target}'s hide is refused, naming what is live, exactly while live work sits on it or beneath it; nothing is marked by a refusal`, async () => {
        const db = await openMigrated();
        try {
            for (const position of POSITIONS) {
                for (const work of WORK) {
                    const label = `${work} ${position} the ${target}`;
                    const workspaceId = await insertWorkspace(db, `matrix-${crypto.randomUUID()}`);
                    const other = await insertWorkspace(db, `matrix-other-${crypto.randomUUID()}`);
                    const root = await insertSession(db, workspaceId, null, "root");
                    const child = await insertSession(db, workspaceId, root, "child");
                    const grandchild = await insertSession(db, workspaceId, child, "grandchild");
                    const sibling = await insertSession(db, workspaceId, null, "sibling");
                    const stranger = await insertSession(db, other, null, "stranger");
                    const holder = target === "workspace"
                        ? { at: root, beneath: child, outside: stranger }[position]
                        : { at: root, beneath: grandchild, outside: sibling }[position];
                    const holderWorkspace = holder === stranger ? other : workspaceId;
                    await seedWork(db, holderWorkspace, holder, work);
                    const gates: PlaceGates = async (id) => ({
                        proposals: work === "proposal" && id === holderWorkspace ? [{ sessionId: holder }] : [],
                        questions: work === "question" && id === holderWorkspace ? [{ sessionId: holder }] : [],
                    });
                    const before = await marks(db, workspaceId);
                    const hide = target === "workspace"
                        ? Places.setWorkspaceHidden(db, gates, workspaceId, true).then(({ hiding }) => hiding)
                        : Places.setSessionHidden(db, gates, workspaceId, root, true);
                    const live = position === "outside" ? null : COUNTS[work];
                    if (live === null) {
                        assert.equal(typeof (await hide).hidden_at, "string", `${label}: hidden`);
                        continue;
                    }
                    const problem = await refusal(hide);
                    assert.equal(problem.status, 409, label);
                    assert.ok(problem.type.endsWith("/live-work"), `${label}: ${problem.type}`);
                    assert.deepEqual({ loops: problem.loops, streams: problem.streams, proposals: problem.proposals, questions: problem.questions }, live, label);
                    assert.deepEqual(await marks(db, workspaceId), before, `${label}: a refused hide marks nothing`);
                }
            }
        } finally { await db.close(); }
    });
}

test("{§place-hiding} a session's hide marks its subtree as one group: a group inside joins it, a session created beneath joins it, a second hide changes nothing, and showing any member shows the group", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `groups-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const a = await insertSession(db, workspaceId, root, "a");
        const a1 = await insertSession(db, workspaceId, a, "a1");
        const b = await insertSession(db, workspaceId, root, "b");
        const sibling = await insertSession(db, workspaceId, null, "sibling");

        const inner = await Places.setSessionHidden(db, NO_GATES, workspaceId, a, true);
        assert.deepEqual(sorted(inner.sessionIds), sorted([a, a1]));
        assert.deepEqual(await groups(db, workspaceId), { [root]: null, [a]: a, [a1]: a, [b]: null, [sibling]: null }, "a hide marks the session and every session beneath it");
        const outer = await Places.setSessionHidden(db, NO_GATES, workspaceId, root, true);
        assert.deepEqual(sorted(outer.sessionIds), sorted([root, a, a1, b]));
        assert.deepEqual(await groups(db, workspaceId), { [root]: root, [a]: root, [a1]: root, [b]: root, [sibling]: null }, "a group hidden inside joins the outer one");
        assert.deepEqual(await Places.setSessionHidden(db, NO_GATES, workspaceId, a1, true), { id: a1, hidden_at: outer.hidden_at, sessionIds: [] }, "hiding a hidden session changes nothing");
        const late = await insertSession(db, workspaceId, a, "late");
        assert.equal((await groups(db, workspaceId))[late], root, "a session created beneath a hidden session joins its group");

        const shown = await Places.setSessionHidden(db, NO_GATES, workspaceId, a1, false);
        assert.deepEqual(shown, { id: a1, hidden_at: null, sessionIds: sorted([root, a, a1, b, late]) });
        assert.ok((await marks(db, workspaceId)).every(({ hidden_at }) => hidden_at === null), "showing any member shows the whole group");
        assert.deepEqual(await Places.setSessionHidden(db, NO_GATES, workspaceId, sibling, false), { id: sibling, hidden_at: null, sessionIds: [] }, "showing a shown session changes nothing");

        const hiddenWorkspace = await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true);
        assert.equal(hiddenWorkspace.changed, true);
        assert.ok((await marks(db, workspaceId)).every(({ place, hidden_at }) => (place === "workspace") === (hidden_at !== null)), "a workspace's mark is its own");
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true), { hiding: hiddenWorkspace.hiding, changed: false }, "a second hide keeps the first mark");
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, false), { hiding: { id: workspaceId, hidden_at: null }, changed: true });
        assert.deepEqual(await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, false), { hiding: { id: workspaceId, hidden_at: null }, changed: false });

        const other = await insertWorkspace(db, `groups-other-${crypto.randomUUID()}`);
        for (const hidden of [true, false]) {
            assert.equal((await refusal(Places.setSessionHidden(db, NO_GATES, other, root, hidden))).status, 404, "a session of another workspace is not found");
            assert.equal((await refusal(Places.setWorkspaceHidden(db, NO_GATES, Number.MAX_SAFE_INTEGER, hidden))).status, 404, "a workspace that does not exist is not found");
        }
    } finally { await db.close(); }
});

test("{§place-hiding} a live loop starting on a hidden session brings back its group and its workspace; concluded history brings nothing back", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `return-${crypto.randomUUID()}`);
        const root = await insertSession(db, workspaceId, null, "root");
        const child = await insertSession(db, workspaceId, root, "child");
        const sibling = await insertSession(db, workspaceId, null, "sibling");
        await Places.setWorkspaceHidden(db, NO_GATES, workspaceId, true);
        await Places.setSessionHidden(db, NO_GATES, workspaceId, root, true);
        await Places.setSessionHidden(db, NO_GATES, workspaceId, sibling, true);
        const hidden = await marks(db, workspaceId);

        await db.test_loops_insert_with_status.run({ session_id: child, sequence: 1, status: 200, prompt: "history", terminal_result: JSON.stringify({ status: 200 }) });
        assert.deepEqual(await marks(db, workspaceId), hidden, "a concluded loop is history, never work");

        await db.test_insert_queued_loop.get({ session_id: child, sequence: 2, prompt: "work" });
        assert.deepEqual((await marks(db, workspaceId)).map(({ place, id, hidden_at }) => [place, id, hidden_at !== null]), [
            ["session", root, false], ["session", child, false], ["session", sibling, true], ["workspace", workspaceId, false],
        ], "the loop's group and workspace are shown; another group stays hidden");
    } finally { await db.close(); }
});

test("{§place-hiding} {§methods-session-list} listings filter by the mark only when asked; the overview leaves out hidden sessions and, in the daemon's scope, every session of a hidden workspace", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const shownWorkspace = await daemon.createWorkspace({ name: `shown-${crypto.randomUUID()}` });
        const hiddenWorkspace = await daemon.createWorkspace({ name: `hidden-${crypto.randomUUID()}` });
        const shown = await daemon.createSession({ workspaceId: shownWorkspace.workspaceId, name: "shown" });
        const hidden = await daemon.createSession({ workspaceId: shownWorkspace.workspaceId, name: "hidden" });
        const inside = await daemon.createSession({ workspaceId: hiddenWorkspace.workspaceId, name: "inside" });
        await daemon.setSessionHidden({ workspaceId: shownWorkspace.workspaceId, sessionId: hidden.sessionId, hidden: true });
        await daemon.setWorkspaceHidden({ workspaceId: hiddenWorkspace.workspaceId, hidden: true });

        const names = async (hiddenFilter?: boolean): Promise<string[]> => (await daemon.listSessions(shownWorkspace.workspaceId, {
            origin: "model", ...(hiddenFilter === undefined ? {} : { hidden: hiddenFilter }),
        })).map(({ name }) => name).toSorted();
        assert.deepEqual(await names(), ["hidden", "shown"], "an unfiltered listing holds every session");
        assert.deepEqual(await names(false), ["shown"]);
        assert.deepEqual(await names(true), ["hidden"]);
        const ids = async (hiddenFilter?: boolean): Promise<number[]> => (await daemon.listWorkspaces(hiddenFilter === undefined ? {} : { hidden: hiddenFilter }))
            .map(({ id }) => id).filter((id) => id === shownWorkspace.workspaceId || id === hiddenWorkspace.workspaceId).toSorted((a, b) => a - b);
        assert.deepEqual(await ids(), sorted([shownWorkspace.workspaceId, hiddenWorkspace.workspaceId]));
        assert.deepEqual(await ids(false), [shownWorkspace.workspaceId]);
        assert.deepEqual(await ids(true), [hiddenWorkspace.workspaceId]);
        assert.equal(typeof (await daemon.readSession({ workspaceId: shownWorkspace.workspaceId, identity: { name: "hidden" } }))?.hidden_at, "string", "a direct read finds a hidden session");
        assert.equal((await daemon.attachWorkspace({ name: hiddenWorkspace.workspaceName })).workspaceId, hiddenWorkspace.workspaceId, "an attach finds a hidden workspace");
        assert.deepEqual(await ids(true), [hiddenWorkspace.workspaceId], "and leaves it hidden");

        const overview = async (workspaceId?: number) => {
            const read = await daemon.readSessionOverview({ ...(workspaceId === undefined ? {} : { workspaceId }), limit: 100, excerptChars: 40 });
            return { sessions: read.sessions.map(({ id }) => id).filter((id) => [shown.sessionId, hidden.sessionId, inside.sessionId].includes(id)), workspaces: read.workspaces.map(({ id }) => id) };
        };
        assert.deepEqual(await overview(), { sessions: [shown.sessionId], workspaces: [shownWorkspace.workspaceId] }, "the daemon's overview");
        assert.deepEqual(await overview(shownWorkspace.workspaceId), { sessions: [shown.sessionId], workspaces: [shownWorkspace.workspaceId] }, "a workspace's overview");
        assert.deepEqual(await overview(hiddenWorkspace.workspaceId), { sessions: [inside.sessionId], workspaces: [hiddenWorkspace.workspaceId] }, "a hidden workspace's own overview holds its shown sessions");

        for (const attempt of [
            () => daemon.setWorkspaceHidden({ workspaceId: shownWorkspace.workspaceId, hidden: "yes" as unknown as boolean }),
            () => daemon.setSessionHidden({ workspaceId: shownWorkspace.workspaceId, sessionId: shown.sessionId, hidden: 1 as unknown as boolean }),
            () => daemon.listSessions(shownWorkspace.workspaceId, { hidden: "no" as unknown as boolean }),
            () => daemon.listWorkspaces({ hidden: null as unknown as boolean }),
        ]) {
            const problem = await refusal(attempt());
            assert.equal(problem.status, 400);
            assert.ok(problem.type.endsWith("/flag-invalid"), problem.type);
        }
    });
});

test("{§methods-workspace-hide} {§methods-session-hide} {§notifications-workspace-hidden} {§notifications-session-hidden} {§workspace-name} each change is announced once in its workspace; creating by the folder selects and shows a hidden workspace; an explicit name it holds conflicts", async () => {
    const folder = await mkdtemp(join(tmpdir(), "plurnk-hidden-"));
    try {
        await withDaemon(null, async (_db, daemon) => {
            const events: Array<[number | null, string, unknown]> = [];
            const unsubscribe = daemon.subscribeToEvents((workspaceId, method, params) => {
                if (method === "workspace/hidden" || method === "session/hidden") events.push([workspaceId, method, params]);
            });
            const created = await daemon.createWorkspace({ projectRoot: folder });
            const hidden = await daemon.setWorkspaceHidden({ workspaceId: created.workspaceId, hidden: true });
            assert.equal(typeof hidden.hidden_at, "string");
            assert.deepEqual(await daemon.setWorkspaceHidden({ workspaceId: created.workspaceId, hidden: true }), hidden, "a second hide keeps the first mark");
            const selected = await daemon.createWorkspace({ projectRoot: folder });
            assert.equal(selected.workspaceId, created.workspaceId, "creating by the folder selects the hidden workspace");
            assert.equal((await daemon.listWorkspaces()).find(({ id }) => id === created.workspaceId)?.hidden_at, null, "and shows it");

            const named = await daemon.createWorkspace({ name: `named-${crypto.randomUUID()}` });
            const namedHidden = await daemon.setWorkspaceHidden({ workspaceId: named.workspaceId, hidden: true });
            const conflict = await refusal(daemon.createWorkspace({ name: named.workspaceName }));
            assert.equal(conflict.status, 409);
            assert.ok(conflict.type.endsWith("/name-conflict"), conflict.type);
            assert.match(conflict.detail ?? "", /by a hidden workspace/u, "the conflict says the name's holder is hidden");

            const session = await daemon.createSession({ workspaceId: created.workspaceId, name: "quiet" });
            const sessionHidden = await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: true });
            assert.deepEqual(sessionHidden.sessionIds, [session.sessionId]);
            await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: true });
            const sessionShown = await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: false });
            await daemon.setSessionHidden({ workspaceId: created.workspaceId, sessionId: session.sessionId, hidden: false });
            unsubscribe();
            assert.deepEqual(events, [
                [created.workspaceId, "workspace/hidden", hidden],
                [created.workspaceId, "workspace/hidden", { id: created.workspaceId, hidden_at: null }],
                [named.workspaceId, "workspace/hidden", namedHidden],
                [created.workspaceId, "session/hidden", sessionHidden],
                [created.workspaceId, "session/hidden", { id: session.sessionId, hidden_at: null, sessionIds: [session.sessionId] }],
            ], "a call that changes nothing announces nothing");
            assert.deepEqual(sessionShown, { id: session.sessionId, hidden_at: null, sessionIds: [session.sessionId] });
        });
    } finally { await rm(folder, { recursive: true, force: true }); }
});

test("{§place-hiding} a hide is refused over a gate the daemon holds; a loop run on a hidden session brings it and its workspace back", async () => {
    const gated = new Mock({ contextWindow: 16384, responses: [
        // A host execution the server reviews: the loop waits on its proposal.
        makeMockResponse("\n````sh\necho pending\n````\n\n````NOTE\nproposed\n````", 10),
    ] });
    await withDaemon(gated, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: `gated-${crypto.randomUUID()}` })).result as { id: number }).id;
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const { modelSessionId } = (await rpcCall(ws, 2, "loop.run", { prompt: "go" })).result as { modelSessionId: number };
            await waitFor(() => proposals(), (seen) => seen.length >= 1, { timeoutMs: 10_000 });
            for (const attempt of [
                () => daemon.setSessionHidden({ workspaceId, sessionId: modelSessionId, hidden: true }),
                () => daemon.setWorkspaceHidden({ workspaceId, hidden: true }),
            ]) {
                const problem = await refusal(attempt());
                assert.equal(problem.status, 409);
                assert.equal(problem.proposals, 1, "the pending proposal is named");
                assert.equal(problem.loops, 1, "with the loop that waits on it");
            }
        } finally { ws.close(); }
    });

    const answering = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(answering, async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: `returning-${crypto.randomUUID()}` })).result as { id: number }).id;
            const { sessionId } = await daemon.createSession({ workspaceId, name: "returning" });
            await daemon.setSessionHidden({ workspaceId, sessionId, hidden: true });
            await daemon.setWorkspaceHidden({ workspaceId, hidden: true });
            const run = await runLoopToTerminal(ws, 2, { prompt: "go", sessionId });
            assert.equal(run.finalStatus, 200);
            assert.ok((await daemon.listWorkspaces({ hidden: false })).some(({ id }) => id === workspaceId), "the workspace is shown");
            assert.ok((await daemon.listSessions(workspaceId, { hidden: false })).some(({ id }) => id === sessionId), "the session is shown");
        } finally { ws.close(); }
    });
});
