import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Daemon from "../../src/server/Daemon.ts";
import Dsl from "./dsl.ts";
import Turn from "../../src/core/Turn.ts";
import Fork from "../../src/core/fork.ts";
import SessionOwners from "../../src/core/SessionOwners.ts";
import ProposalPolicies from "../../src/core/ProposalPolicies.ts";
import DispatchAsPlurnk from "../../src/server/dispatch-as-plurnk.ts";
import Envelope from "../../src/server/envelope.ts";
import LoopDocs from "../../src/server/loopDocs.ts";
import SeamSocket from "./_seam.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertOperationTurn, insertTurn } from "./_db.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb, HARNESS_WAIT_MS, rpcProblem, subscribeNotifications, waitFor } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";
import { Validator, Problems, type EditStatement, type UrlPath, type ParsedPath, type ClientEntry, type EntryReadResult as EntryReadWire, type KillStatement, type NoteStatement, type SessionOwner } from "@plurnk/plurnk-contracts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { copyStmt, editStmt, fullReplace, moveStmt, urlPath } from "./_dsl.ts";
import { logEntries } from "./_packet.ts";
import { modelOperation } from "./_sessions.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { schemeManifest } from "./_scheme.ts";
import { viableWindow } from "./_provider.ts";
import type { EntryEditResult, ResolvedEditStatement, SchemeCtx, SchemeHandler } from "@plurnk/plurnk-schemes";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";


describe("actor-boundary", () => {
// SPEC {§actor-boundary} — the actor boundary (isolation by session, two doors, self-hosting).
// Composed coverage for structural log isolation, the environment/voice doors,
// and ordinary runtime-owned operations through the runtime session `_plurnk`.

test("{§actor-boundary} two sessions in one workspace both write the same shared entry — no lock", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { sessionId, loopId, turnId };
        };
        const a = await spawn();
        const b = await spawn();
        const target = urlPath("workspace", "/shared.md");
        const resultA = await engine.dispatch({ statement: editStmt(target, "from session A"), workspaceId, sessionId: a.sessionId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        const resultB = await engine.dispatch({ statement: editStmt(target, "from session B", fullReplace), workspaceId, sessionId: b.sessionId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // Wild west = both writers succeed (no lock rejects the second). A creates
        // the shared entry (201), B updates it (200); neither is a 409/lock refusal.
        assert.ok([200, 201].includes(resultA.status), `session A's write to the shared entry succeeds (got ${resultA.status})`);
        assert.ok([200, 201].includes(resultB.status), `session B's write to the SAME entry also succeeds — no mutual exclusion (got ${resultB.status})`);
    } finally { db.close(); }
});

test("{§actor-boundary} a packet renders one session's log; a sibling session's log is absent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { sessionId, loopId, turnId };
        };
        // Two sibling sessions in one workspace — e.g. two independent model sessions.
        const a = await spawn();
        const b = await spawn();
        await engine.dispatch({ statement: editStmt(urlPath("workspace", "/from-a.md"), "a"), workspaceId, sessionId: a.sessionId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt(urlPath("workspace", "/from-b.md"), "b"), workspaceId, sessionId: b.sessionId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // Session A's packet is rendered from session A's log alone.
        const packetA = await db.engine_render_log.all<{ pathname: string }>({ session_id: a.sessionId });
        assert.ok(packetA.some((r) => r.pathname.includes("from-a")), "session A's own log renders in its packet");
        assert.ok(packetA.every((r) => !r.pathname.includes("from-b")), "sibling session B's log never enters session A's packet — invisibility is by session, no origin filter");
    } finally { db.close(); }
});

test("{§connection-lifecycle} origin is attribution (provenance), never read to hide a row at render", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        // A person's client operations journal in the runtime session ({§connection-lifecycle}).
        const sessionId = await RuntimeSession.ensure(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertOperationTurn(db, loopId, 1, "client");
        // A CLIENT-origin row living IN this session must still render: the renderer
        // scopes by session, never hides by origin.
        await engine.dispatch({ statement: editStmt(urlPath("workspace", "/in-session.md"), "x"), workspaceId, sessionId, loopId, turnId, sequence: 1, origin: "client" });
        const packet = await db.engine_render_log.all<{ pathname: string; origin: string }>({ session_id: sessionId });
        const row = packet.find((r) => r.pathname.includes("in-session"));
        assert.ok(row !== undefined, "an in-session row renders regardless of origin");
        assert.equal(row.origin, "client", "origin is carried as attribution, not consumed to hide the row");
    } finally { db.close(); }
});

// The voice door (inject) and the negative (a delta must not wake) are locked here;
// the stream-status door — a slept (202) loop's stream concluding RESUMES it in place,
// an active loop folds the conclusion into its next turn — is locked in
// Daemon.exec-wake.test.ts. Together they discharge {§actor-boundary}'s two-trigger contract.
test("{§env-delta} an idle session wakes on an inject (voice), never on a delta (a sibling's shared-entry edit)", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({ contextWindow: 8192, responses: [
        makeMockResponse("````SEND [200]\nfirst done\n````", 10),
        makeMockResponse("````SEND [200]\nwoke done\n````", 10),
        makeMockResponse("````SEND [200]\nextra\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "passive-wake" });
            // Run a loop to completion → the model session is now IDLE (one loop).
            const ran = await runLoopToTerminal(ws, 2, { prompt: "first" });
            const { loopId } = ran as { loopId: number };
            const modelSessionId = (await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId }))!.session_id;
            const loopsIdle = (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }))!.n;

            // A delta: a client op.edit journals in the workspace's runtime session, never the
            // model session ({§connection-lifecycle}), and touches a shared entry.
            // This is the environment door; it must NOT wake the idle model session.
            await rpcCall(ws, 3, "op.edit", { target: "workspace:///shared.md", content: "a sibling edit — ambient, not addressed to the model session" });
            const loopsAfterDelta = (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }))!.n;
            assert.equal(loopsAfterDelta, loopsIdle, "a delta (sibling shared-entry edit) does NOT wake the idle session — no new loop enqueued");

            // The VOICE door: inject a prompt into the same idle session → it wakes, a fresh
            // loop is enqueued on the model session.
            const injected = await rpcCall(ws, 4, "loop.inject", { prompt: "BTW — wake up" });
            assert.equal((injected.result as { action: string }).action, "enqueued_new_loop", "an inject (voice) wakes the idle session");
            const loopsAfterInject = (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: modelSessionId }))!.n;
            assert.equal(loopsAfterInject, loopsIdle + 1, "the inject enqueued exactly one new loop — the wake the delta did not cause");
        } finally { ws.close(); }
    });
});

test("{§session-initialization-entry} runtime-owned entry work is an ordinary administrative turn in the addressed session", async () => {
    // The AGENTS stunt ({§session-initialization-entry}) is operation-shaped runtime work,
    // so it uses DispatchAsPlurnk. Its generated resource and causal operation
    // history belong to the same Session that receives the resulting Turn-0 READ.
    const dir = await mkdtemp(join(tmpdir(), "plurnk-selfhost-"));
    await writeFile(join(dir, "AGENTS.md"), "# Self-hosting\nThe runtime is an actor.\n", "utf8");
    // #346 — a nested AGENTS.md is admitted at its project path; noise dirs
    // contribute nothing.
    await mkdir(join(dir, "packages", "web"), { recursive: true });
    await writeFile(join(dir, "packages", "web", "AGENTS.md"), "# Web subtree\nPrefer vanilla CSS.\n", "utf8");
    await mkdir(join(dir, "node_modules", "dep"), { recursive: true });
    await writeFile(join(dir, "node_modules", "dep", "AGENTS.md"), "never seen", "utf8");
    try {
        const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: "selfhost", projectRoot: dir })).result as { id: number }).id;
                const { loopId } = (await runLoopToTerminal(ws, 2, { prompt: "go" })) as { loopId: number };

                const entry = await db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId,
                    scheme: "file",
                    authority: "",
                    pathname: "AGENTS.md",
                });
                assert.ok(entry !== undefined, "the project AGENTS.md is admitted at its project path");

                const nested = await db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId,
                    scheme: "file",
                    authority: "",
                    pathname: "packages/web/AGENTS.md",
                });
                assert.ok(nested !== undefined, "a nested AGENTS.md materializes with its subtree path preserved (#346)");
                const noise = await db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId,
                    scheme: "file",
                    authority: "",
                    pathname: "node_modules/dep/AGENTS.md",
                });
                assert.equal(noise, undefined, "noise directories contribute no instructions");

                const sessionLog = await db.test_log_entries_by_session.all<{
                    op: string | null; scheme: string | null; pathname: string; origin: string;
                    turn_id: number; status_rx: number;
                }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
                const matEdit = sessionLog.find((row) => row.op === "EDIT" && row.scheme === "plurnk" && row.pathname === "/session.md");
                assert.ok(matEdit !== undefined, "the materialization is durable operation evidence, not a privileged write");
                assert.equal(matEdit.origin, "_plurnk", "the runtime producer remains explicit");

                const adminTurn = await db.test_get_turn.get<{
                    producer: string; kind: string; status: number; completed_at: string | null;
                }>({ id: matEdit.turn_id });
                assert.deepEqual(
                    { producer: adminTurn?.producer, kind: adminTurn?.kind, status: adminTurn?.status },
                    { producer: "_plurnk", kind: "maintenance", status: 200 },
                    "generated resources are authored by a terminal maintenance turn — durable and READable, packet-suppressed (#338)",
                );
                const adminRows = await db.test_log_entries_by_turn.all<{
                    op: string | null; initial_folded: string; folded: string; attrs: string;
                }>({ turn_id: matEdit.turn_id });
                const adminOps = adminRows.map(({ op }) => op);
                assert.equal(adminOps[0], "EDIT");
                assert.ok(adminOps.slice(0, -1).every((op) => op === "EDIT"), "the program's mutations are explicit EDITs");
                assert.deepEqual(adminOps.slice(-1), ["NOTE"], "the maintenance program records its purpose without inventing a terminal operation");
                assert.equal(adminRows.find(({ op }) => op === "EDIT")?.folded, "[]", "maintenance visibility is a render rule, not a fabricated self-curation effect");
                const programs = await db.test_turn_sources.all<{ turn_id: number; kind: string; content: string }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
                assert.ok(programs.some(({ turn_id, kind, content }) => turn_id === matEdit.turn_id && kind === "ops" && content.includes("```NOTE")),
                    "maintenance retains its exact source independently of packet visibility");

                const modelLoopLog = await db.test_log_entries_by_loop.all<{
                    op: string | null; scheme: string | null; hostname: string | null; pathname: string; status_rx: number;
                }>({ loop_id: loopId });
                const docRead = modelLoopLog.find((row) => row.op === "READ" && (row.scheme === null || row.scheme === "file")
                    && row.hostname === null && row.pathname === "AGENTS.md");
                assert.ok(docRead !== undefined && docRead.status_rx === 200, "Turn 0 reads the addressed Session's generated policy entry");
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
});

describe("Daemon.entry-read-wire", () => {
class Notes implements SchemeHandler {
    static manifest: SchemeManifest = {
        name: "notes", authority: "resource",
        channels: { body: "text/markdown" },
        defaultChannel: "body",
        category: "data",
        writableBy: ["client"],
        volatile: false,
        modelVisible: true,
    };

    async resolveEntryAddress(target: ParsedPath): Promise<{ authority: string; pathname: string } | null> {
        return target.kind === "url"
            ? { authority: target.hostname ?? "", pathname: target.pathname }
            : null;
    }

    async editBatch(statements: readonly ResolvedEditStatement[], ctx: SchemeCtx): Promise<EntryEditResult> {
        return ctx.entries.operations.editBatch(statements);
    }
}

const body = (result: EntryReadWire): ClientEntry => {
    const exact = Validator.assertEntryReadResult(result);
    assert.equal(exact.status, 200);
    assert.ok(exact.entry !== null);
    return exact.entry;
};

test("{§scheme-address} entry.read resolves one owner-aware client entry and returns the exact shared wire", async () => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    schemes.register("notes", new Notes());
    const daemon = new Daemon({ db, schemes, provider: null });
    await daemon.start();
    try {
        const workspace = await daemon.createWorkspace({ name: `entry-wire-${crypto.randomUUID()}` });
        const parent = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "entry-parent" });
        const child = await daemon.forkSession({ workspaceId: workspace.workspaceId, sessionId: parent.sessionId, name: "entry-child" });

        // A person seeds each named space; an authority is a namespace, not a principal ({§session-scheme}).
        for (const [name, content] of [
            ["entry-parent", "A😀éZ"],
            ["entry-child", "child"],
        ] as const) {
            const [written] = await daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId,
                actor: TEST_OWNER,
                statements: [Dsl.buildEdit({
                    target: `notes://${name}/same`,
                    content,
                })],
            });
            assert.equal(written.status, 201);
        }

        const parentRead = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "notes://entry-parent/same",
        }));
        assert.deepEqual(parentRead, {
            entryId: parentRead.entryId,
            target: "notes://entry-parent/same",
            channels: {
                body: {
                    content: "A😀éZ",
                    contentOffset: 0,
                    contentLength: 4,
                    mimetype: "text/markdown",
                    weight: contentWeight("A😀éZ"),
                    state: "static",
                },
            },
        });

        const childRead = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "notes://entry-child/same",
        }));
        assert.equal(childRead.channels.body?.content, "child");
        assert.notEqual(childRead.entryId, parentRead.entryId);

        const slice = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "notes://entry-parent/same",
            channel: "body",
            offset: 2,
        }));
        assert.deepEqual(slice.channels.body, {
            content: "éZ",
            contentOffset: 2,
            contentLength: 4,
            mimetype: "text/markdown",
            weight: contentWeight("A😀éZ"),
            state: "static",
        });

        const caughtUp = body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "notes://entry-parent/same#ignored",
            channel: "body",
            offset: 100,
        }));
        assert.equal(caughtUp.channels.body?.content, "");
        assert.equal(caughtUp.channels.body?.contentOffset, 4);
        assert.equal(caughtUp.target, "notes://entry-parent/same");
    } finally {
        await daemon.stop();
        await db.close();
    }
});

test("{§scheme-address} entry.read applies session authority across the workspace: a child reads its parent's named space (#394)", async () => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    await daemon.start();
    try {
        const workspace = await daemon.createWorkspace({ name: `entry-owner-${crypto.randomUUID()}` });
        const parent = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "owner-parent" });
        const child = await daemon.forkSession({ workspaceId: workspace.workspaceId, sessionId: parent.sessionId, name: "owner-child" });
        for (const [name, content] of [
            ["owner-parent", "parent"],
            ["owner-child", "child"],
        ] as const) {
            const [written] = await daemon.dispatchClientAction({
                workspaceId: workspace.workspaceId,
                actor: TEST_OWNER,
                statements: [Dsl.buildEdit({ target: `session://${name}/same`, content })],
            });
            assert.equal(written.status, 201);
        }

        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "session://owner-parent/same",
        })).channels.body?.content, "parent");
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "session://owner-child/same",
        })).channels.body?.content, "child");
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: parent.sessionId,
            target: "session://owner-child/same",
        })).channels.body?.content, "child");

        // {§session-scheme} — any session of the workspace reads a named space: the child its parent's (#394).
        assert.equal(body(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "session://owner-parent/same",
        })).channels.body?.content, "parent");
        const unknown = Validator.assertEntryReadResult(await daemon.readEntry({
            workspaceId: workspace.workspaceId,
            sessionId: child.sessionId,
            target: "session://no-such-session/same",
        }));
        assert.equal(unknown.status, 404);
        assert.equal(unknown.entry, null);
    } finally {
        await daemon.stop();
        await db.close();
    }
});
});

describe("Engine.ambient-topology", () => {
// Topology-scoped occurrence delivery: {§actor-boundary},
// {§actor-boundary}, and {§machine-processes}.












const messages = [
    { role: "system" as const, content: "You are an agent." },
    { role: "user" as const, content: "continue" },
];

const continueResponse = () => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [{
            op: "NOTE",
            aside: null,
            metadata: null,
            target: null,
            lineMarker: null,
            body: "continue",
            position: { line: 1, column: 1 },
        } as NoteStatement],
    },
});

const path = (scheme: string, pathname: string): UrlPath => ({
    kind: "url",
    raw: `${scheme}://${pathname}`,
    scheme,
    username: null,
    password: null,
    hostname: null,
    port: null,
    pathname,
    query: null,
    fragment: null,
});

const kill = (target: UrlPath): KillStatement => ({
    metadata: null,
    op: "KILL",
    aside: null,
    target,
    lineMarker: null,
    matcher: null, body: null,
    position: { line: 1, column: 1 },
});

test("{§actor-boundary} direct-child activity reaches its parent without leaking to a grandparent or independent root", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lineage-activity-${crypto.randomUUID()}`);
        const grandparent = await insertSession(db, workspaceId, null, "grandparent");
        const parent = await insertSession(db, workspaceId, grandparent, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const independent = await insertSession(db, workspaceId, null, "independent");
        const grandparentLoop = await insertLoop(db, grandparent, 1, "observe");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const independentLoop = await insertLoop(db, independent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "work");
        const { id: childTurn } = await Turn.open(db, { loopId: childLoop, producer: "model", kind: "inference" });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({
            contextWindow: 100_000,
            responses: Array.from({ length: 6 }, continueResponse),
        });

        await engine.runTurn({ provider, workspaceId, sessionId: grandparent, loopId: grandparentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages, turnNumber: 1 });

        assert.equal((await engine.dispatch({
            statement: editStmt({ ...path("session", "/finding.md"), hostname: "child", raw: "session://child/finding.md" }, "Record the direct-child finding."),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence: 1,
            origin: "model",
        })).status, 201);
        assert.equal((await engine.dispatch({
            statement: editStmt(path("missing", "/evidence"), "A failed action."),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence: 2,
            origin: "model",
        })).status, 501);

        await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 2 });
        await engine.runTurn({ provider, workspaceId, sessionId: grandparent, loopId: grandparentLoop, messages, turnNumber: 2 });
        await engine.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages, turnNumber: 2 });

        const observedFromChild = async (sessionId: number) => (await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
            initial_folded: string;
            folded: string;
        }>({ session_id: sessionId })).filter(({ origin, source }) => origin === "_plurnk" && source === "session://child");

        assert.deepEqual(
            (await observedFromChild(parent)).map(({ op }) => op),
            ["EDIT", "EDIT"],
            "the parent receives successful and failed child actions in causal order",
        );
        assert.ok(
            (await observedFromChild(parent)).every(({ initial_folded, folded }) => initial_folded === "[[1,-1]]" && folded === "[]"),
            "intermediate child activity is born body-suppressed, not trimmed",
        );
        assert.deepEqual(await observedFromChild(grandparent), [], "observer rows never recursively republish to the grandparent");
        assert.deepEqual(await observedFromChild(independent), [], "an independent root receives no lineage activity");
    } finally {
        await db.close();
    }
});

test("{§env-delta} received messages remain local observations, not child-authored activity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `lineage-prompt-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        await insertSession(db, workspaceId, null, "peer");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "inspect the delegated evidence");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            messages,
            turnNumber: 1,
        });
        const arrivals = [
            { source: null, body: "inspect the delegated evidence" },
            { source: "session://parent", body: "An updated request from the parent." },
            { source: "session://peer", body: "An unrelated peer's request." },
            { source: "acp://operator/threads/child/messages/m1", body: "An external client's request." },
        ];
        for (const { source, body } of arrivals.slice(1)) {
            assert.ok(await engine.injectIntoLoop(childLoop, body, [], source!));
        }
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            messages,
            turnNumber: 2,
        });
        const childRows = await db.engine_render_log.all<{
            attrs: string;
            source: string | null;
            tx: string;
        }>({ session_id: child });
        assert.deepEqual(
            childRows.filter(({ attrs }) => JSON.parse(attrs).kind === "message")
                .map(({ source, tx }) => ({ source, body: JSON.parse(tx).body.raw })),
            arrivals,
            "initial and mid-loop messages retain their original sender and body in the recipient's log",
        );
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 1,
        });

        const rows = await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
        }>({ session_id: parent });
        assert.deepEqual(
            rows.filter(({ origin, source }) => origin === "_plurnk" && source === "session://child"),
            [],
            "receiving a request does not become an action attributed to its recipient",
        );
    } finally {
        await db.close();
    }
});

test("{§actor-boundary} a fork inherits parent activity pending at its snapshot but not later sibling activity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `fork-activity-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const sibling = await insertSession(db, workspaceId, parent, "sibling");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const siblingLoop = await insertLoop(db, sibling, 1, "work");
        const siblingTurn = await insertTurn(db, siblingLoop, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const parentProvider = new Mock({ contextWindow: 100_000, responses: [continueResponse(), continueResponse()] });

        await engine.runTurn({
            provider: parentProvider,
            workspaceId,
            sessionId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 1,
        });
        assert.equal((await engine.dispatch({
            statement: editStmt({ ...path("session", "/finding.md"), hostname: "sibling", raw: "session://sibling/finding.md" }, "pending before fork"),
            workspaceId,
            sessionId: sibling,
            loopId: siblingLoop,
            turnId: siblingTurn,
            sequence: 1,
            origin: "model",
        })).status, 201);

        const branch = await Fork.fork(db, parent, "branch");
        const branchLoop = await insertLoop(db, branch, 2, "continue");

        assert.equal((await engine.dispatch({
            statement: editStmt(path("missing", "/after-fork"), "A failed action."),
            workspaceId,
            sessionId: sibling,
            loopId: siblingLoop,
            turnId: siblingTurn,
            sequence: 2,
            origin: "model",
        })).status, 501);

        await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [continueResponse()] }),
            workspaceId,
            sessionId: branch,
            loopId: branchLoop,
            messages,
            turnNumber: 1,
        });
        await engine.runTurn({
            provider: parentProvider,
            workspaceId,
            sessionId: parent,
            loopId: parentLoop,
            messages,
            turnNumber: 2,
        });

        const childOps = async (sessionId: number) => (await db.engine_render_log.all<{
            op: string;
            origin: string;
            source: string | null;
        }>({ session_id: sessionId }))
            .filter(({ origin, source }) => origin === "_plurnk" && source === "session://sibling")
            .map(({ op }) => op);

        assert.deepEqual(await childOps(branch), ["EDIT"], "the branch receives only the pending parent event inside its fork boundary");
        assert.deepEqual(await childOps(parent), ["EDIT", "EDIT"], "the parent independently receives both child events");
    } finally {
        await db.close();
    }
});

test("{§env-delta} {§env-delta} commons mutations broadcast one occurrence identity and deduplicate the direct parent audience", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `commons-audience-${crypto.randomUUID()}`);
        const parent = await insertSession(db, workspaceId, null, "parent");
        const child = await insertSession(db, workspaceId, parent, "child");
        const independent = await insertSession(db, workspaceId, null, "independent");
        const parentLoop = await insertLoop(db, parent, 1, "observe");
        const independentLoop = await insertLoop(db, independent, 1, "observe");
        const childLoop = await insertLoop(db, child, 1, "mutate");
        const childTurn = await insertTurn(db, childLoop, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const dispatch = (statement: Parameters<Engine["dispatch"]>[0]["statement"], sequence: number) => engine.dispatch({
            statement,
            workspaceId,
            sessionId: child,
            loopId: childLoop,
            turnId: childTurn,
            sequence,
            origin: "model",
        });

        assert.equal((await dispatch(editStmt(path("workspace", "/source"), "shared"), 1)).status, 201);
        assert.ok([200, 201].includes((await dispatch(copyStmt(path("workspace", "/source"), path("workspace", "/copy")), 2)).status));
        assert.ok([200, 201].includes((await dispatch(moveStmt(path("workspace", "/copy"), path("workspace", "/moved")), 3)).status));
        assert.equal((await dispatch(kill(path("workspace", "/moved")), 4)).status, 200);
        assert.equal((await dispatch(editStmt(path("workspace", "/doomed"), "temporary"), 5)).status, 201);
        assert.equal((await dispatch(kill(path("workspace", "/doomed")), 6)).status, 200);
        assert.equal((await dispatch(editStmt(path("workspace", "/source"), "shared", fullReplace), 7)).status, 304);

        const late = await insertSession(db, workspaceId, null, "late");
        const lateLoop = await insertLoop(db, late, 1, "observe");
        const provider = new Mock({ contextWindow: 100_000, responses: [continueResponse(), continueResponse(), continueResponse()] });
        const parentTurn = await engine.runTurn({ provider, workspaceId, sessionId: parent, loopId: parentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: independent, loopId: independentLoop, messages, turnNumber: 1 });
        await engine.runTurn({ provider, workspaceId, sessionId: late, loopId: lateLoop, messages, turnNumber: 1 });

        // {§log-wire-format}: the real parent packet retains both operands and the actor.
        const storedPacket = await db.test_get_packet.get<{ packet: string }>({ id: parentTurn.turnId });
        const activity = logEntries(JSON.parse(storedPacket!.packet)).filter(({ source }) => source === "session://child");
        for (const [op, from, to] of [["COPY", "source", "copy"], ["MOVE", "copy", "moved"]]) {
            const receipt = activity.find(({ logPath }) => logPath.endsWith(`/${op}`));
            assert.ok(receipt, `the parent sees the child's ${op}`);
            assert.equal(receipt.source, "session://child");
            assert.equal(receipt.from, `workspace:///${from}`);
            assert.equal(receipt.to, `workspace:///${to}`);
            assert.equal(receipt.path, undefined);
            assert.equal(receipt.destination, undefined);
        }

        type Row = { op: string; origin: string; source: string | null; ambient_event_id: number | null; status_rx: number };
        const mutations = async (sessionId: number) => (await db.test_log_entries_by_session.all<Row>({ session_id: sessionId }))
            .filter(({ op }) => ["EDIT", "COPY", "MOVE", "KILL", "SEND"].includes(op));
        const source = await mutations(child);
        const parentRows = (await mutations(parent)).filter((row) => row.source === "session://child");
        const independentRows = (await mutations(independent)).filter((row) => row.source === "session://child");
        const lateRows = (await mutations(late)).filter((row) => row.source === "session://child");

        assert.deepEqual(parentRows.map(({ op }) => op), ["EDIT", "COPY", "MOVE", "KILL", "EDIT", "KILL", "EDIT"], "the parent gets one row per child operation, not lineage plus broadcast duplicates");
        assert.deepEqual(independentRows.map(({ op }) => op), ["EDIT", "COPY", "MOVE", "KILL", "EDIT", "KILL"], "every mutation kind that lands a commons effect broadcasts");
        assert.equal(parentRows.at(-1)?.status_rx, 304, "the parent still supervises its child's no-op operation");
        assert.ok(!independentRows.some(({ status_rx }) => status_rx === 304), "a no-op does not fabricate a commons state-change broadcast");
        assert.deepEqual(lateRows, [], "a session created after the mutations does not inherit broadcast history");
        assert.deepEqual(
            parentRows.map(({ ambient_event_id }) => ambient_event_id),
            source.map(({ ambient_event_id }) => ambient_event_id),
            "the parent rows retain the source occurrence identities",
        );
        assert.deepEqual(
            independentRows.map(({ ambient_event_id }) => ambient_event_id),
            source.slice(0, -1).map(({ ambient_event_id }) => ambient_event_id),
            "the workspace audience observes those same identities",
        );
        assert.ok(source.every(({ ambient_event_id }) => ambient_event_id !== null));
        await db.test_workspaces_delete.run({ id: workspaceId });
        assert.equal(
            (await db.test_sessions_count.get<{ n: number }>())?.n,
            0,
            "workspace teardown cascades the complete occurrence graph",
        );
    } finally {
        await db.close();
    }
});
});

describe("Session.ownership", () => {
const owner: SessionOwner = { address: "acp://operator", tools: ["request_approval", "question"], interactive: true };

test("{§session-ownership}: every session has a durable runtime owner before client attachment", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const workspace = await daemon.createWorkspace({ name: "owner-default" });
        const model = await daemon.createSession({ workspaceId: workspace.workspaceId, name: "model" });
        const sessions = await daemon.listSessions(workspace.workspaceId);
        assert.ok(sessions.some(({ id }) => id === model.sessionId));
        for (const session of sessions) {
            assert.equal(Reflect.get(session, "owner"), "_plurnk", `${session.name} must have a real owner, not an absent binding`);
        }
    });
});

test("{§session-ownership}: control claims model descendants; later delegation inherits and the runtime actor is never claimable", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-inheritance" });
        const parent = await daemon.createSession({ workspaceId, name: "parent" });
        const before = await daemon.forkSession({ workspaceId, sessionId: parent.sessionId, name: "before" });
        await daemon.registerSessionOwner(workspaceId, owner);
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId, sessionId: parent.sessionId, owner: owner.address }), owner);
        const after = await daemon.forkSession({ workspaceId, sessionId: parent.sessionId, name: "after" });
        const grandchild = await daemon.forkSession({ workspaceId, sessionId: after.sessionId, name: "grandchild" });
        for (const sessionId of [parent.sessionId, before.sessionId, after.sessionId, grandchild.sessionId]) {
            assert.equal((await daemon.readSession({ workspaceId, identity: { id: sessionId } }))?.owner, owner.address);
        }
        const successor: SessionOwner = { address: "acp://operator", tools: ["request_approval"], interactive: true };
        await daemon.registerSessionOwner(workspaceId, successor);
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId, sessionId: parent.sessionId, owner: successor.address }), successor,
            "claiming a model session transfers it and its model descendants to the claiming owner");
        for (const sessionId of [parent.sessionId, before.sessionId, after.sessionId, grandchild.sessionId]) {
            assert.equal((await daemon.readSession({ workspaceId, identity: { id: sessionId } }))?.owner, successor.address);
        }
        const runtimeId = await insertSession(db, workspaceId, null, "_plurnk", "_plurnk");
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId, sessionId: runtimeId, owner: owner.address }),
            { address: "_plurnk", tools: [], interactive: false }, "the runtime actor itself is never claimable");
    });
});

test("{§session-ownership}: disconnected owners keep their declared capabilities and addresses are workspace-scoped", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const first = await daemon.createWorkspace({ name: "owner-first" });
        const second = await daemon.createWorkspace({ name: "owner-second" });
        const one = await daemon.createSession({ workspaceId: first.workspaceId, name: "primary" });
        const two = await daemon.createSession({ workspaceId: second.workspaceId, name: "primary" });
        await daemon.registerSessionOwner(first.workspaceId, owner);
        await daemon.registerSessionOwner(second.workspaceId, { ...owner, tools: [] });
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId: first.workspaceId, sessionId: one.sessionId, owner: owner.address }), owner);
        assert.deepEqual(await daemon.claimSessionOwner({ workspaceId: second.workspaceId, sessionId: two.sessionId, owner: owner.address }), { ...owner, tools: [] });
        assert.equal((await daemon.readSession({ workspaceId: first.workspaceId, identity: { id: one.sessionId } }))?.owner, owner.address);
    });
});

test("{§session-ownership}: fresh model children inherit an existing parent without copying its history or origin", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-fresh-model" });
        await daemon.registerSessionOwner(workspaceId, owner);
        const parent = await daemon.createSession({ workspaceId, name: "parent", owner: owner.address });
        const child = await daemon.createSession({ workspaceId, name: "context", parentSessionId: parent.sessionId });
        const projected = await daemon.readSession({ workspaceId, identity: { id: child.sessionId } });
        assert.equal(projected?.parentSessionId, parent.sessionId);
        assert.equal(projected?.owner, owner.address);
        assert.equal(projected?.origin, "model");
        assert.deepEqual(await daemon.listSessionLoops({ workspaceId, sessionId: child.sessionId }), []);
        const runtimeId = await insertSession(db, workspaceId, null, "_plurnk", "_plurnk");
        const runtimeChild = await daemon.createSession({ workspaceId, name: "runtime-context", parentSessionId: runtimeId });
        const runtimeProjection = await daemon.readSession({ workspaceId, identity: { id: runtimeChild.sessionId } });
        assert.equal(runtimeProjection?.origin, "model");
        assert.equal(runtimeProjection?.owner, "_plurnk");
        assert.equal(runtimeProjection?.parentSessionId, runtimeId);
    });
});

test("{§session-ownership}: unknown owners and parents from another workspace fail without creating sessions", async () => {
    await withDaemon(null, async (_db, daemon) => {
        const first = await daemon.createWorkspace({ name: "owner-invalid-first" });
        const second = await daemon.createWorkspace({ name: "owner-invalid-second" });
        const parent = await daemon.createSession({ workspaceId: second.workspaceId, name: "parent" });
        const failure = (code: string) => (error: unknown): boolean => error instanceof OperationFailureError &&  error.result.problem?.type.endsWith(`/${code}`);
        await assert.rejects(daemon.createSession({ workspaceId: first.workspaceId, name: "unowned", owner: owner.address }), failure("owner-not-found"));
        await assert.rejects(daemon.createSession({ workspaceId: first.workspaceId, name: "wrong-parent", parentSessionId: parent.sessionId }), failure("session-not-found"));
        assert.equal((await daemon.listSessions(first.workspaceId)).some(({ name }) => name === "unowned" || name === "wrong-parent"), false);
        await daemon.registerSessionOwner(second.workspaceId, owner);
        await daemon.claimSessionOwner({ workspaceId: second.workspaceId, sessionId: parent.sessionId, owner: owner.address });
        await assert.rejects(daemon.claimSessionOwner({ workspaceId: second.workspaceId, sessionId: parent.sessionId, owner: "not-registered" }), failure("owner-not-found"));
    });
});

test("{§session-ownership}: only the recorded owner resolves a proposal, including while no client is connected", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-resolution" });
        await daemon.registerSessionOwner(workspaceId, owner);
        const { sessionId } = await daemon.createSession({ workspaceId, name: "controlled", owner: owner.address });
        const statement = PlurnkParser.parseStatements(PlurnkParser.frame("sh", "echo owner-approved")).items.find((item) => item.kind === "statement");
        assert.equal(statement?.kind, "statement");
        // The session's own operation: its owner reviews it.
        const operation = modelOperation(daemon, db, { workspaceId, sessionId, statement: statement.statement });
        try {
            const [proposal] = await waitForDb(() => daemon.pendingProposals(workspaceId), (items) => items.length === 1);
            assert.equal(proposal.owner, owner.address);
            assert.deepEqual(proposal.disposition, { decision: "review" });
            await daemon.registerSessionOwner(workspaceId, { ...owner, tools: [] });
            assert.deepEqual((await daemon.pendingProposals(workspaceId))[0]?.disposition, { decision: "review" },
                "a later capability declaration cannot hide or reinterpret an outstanding review");
            await assert.rejects(daemon.resolveProposal(proposal.logEntryId, { decision: "accept" }, {
                workspaceId, address: "acp://somebody-else",
            }), (error: unknown) => error instanceof OperationFailureError && error.result.problem.type.endsWith("/owner-mismatch"));
            assert.equal((await daemon.pendingProposals(workspaceId)).length, 1, "an unrelated sender does not consume the gate");
            await daemon.resolveProposal(proposal.logEntryId, { decision: "accept" }, { workspaceId, address: owner.address });
            assert.equal((await operation).status, 200);
        } finally {
            await daemon.stop();
            await operation;
        }
    });
});

test("{§session-ownership}: runtime-owned work cannot hang awaiting a reviewer it does not have", async () => {
    await withDaemon(null, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "owner-incapable" });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "unclaimed" });
        const statement = PlurnkParser.parseStatements(PlurnkParser.frame("sh", "echo must-not-run")).items.find((item) => item.kind === "statement");
        assert.equal(statement?.kind, "statement");
        const operation = modelOperation(daemon, db, { workspaceId, sessionId, statement: statement.statement });
        try {
            const result = await Promise.race([
                operation,
                new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("runtime-owned proposal never settled")), HARNESS_WAIT_MS).unref()),
            ]);
            assert.equal(result.status, 400);
            assert.match((result.problem as { type: string }).type, /\/rejected$/);
            assert.equal(result.outcome, "no_review_channel");
            assert.deepEqual(await daemon.pendingProposals(workspaceId), []);
        } finally {
            await daemon.stop();
            await operation;
        }
    });
});
});

describe("administrative-policy", () => {
function panel(t: TestContext, values: Record<string, string>): void {
    const prior = Object.keys(values).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, values);
    t.after(() => {
        for (const [key, value] of prior) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
}

test("{§proposal-disposition}: reference publication is independent of invalid interactive policy", async (t) => {
    panel(t, {
        PLURNK_SERVICE_PROPOSALS: "invalid",
    });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "bookkeeping-documents");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    await LoopDocs.materialize(engine, db, workspaceId);
    const entries = await db.loop_docs_materialized.all({ workspace_id: workspaceId });
    assert.ok(entries.length > 0, "the real generated reference tree is available");
    const sessionId = await RuntimeSession.ensure(db, workspaceId);
    const loop = await db.test_get_loop_by_session.get<{ id: number }>({ session_id: sessionId });
    assert.ok(loop);
    assert.deepEqual(await SessionOwners.read(db, sessionId), { address: "_plurnk", tools: [], interactive: false });
});

test("{§session-ownership}: administrative loop creation does not read proposal defaults; proposal admission does", async (t) => {
    panel(t, { PLURNK_SERVICE_PROPOSALS: "invalid" });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "client-policy");
    const sessionId = await RuntimeSession.ensure(db, workspaceId);
    const loopId = await Envelope.ensureClientLoop(db, sessionId, "test://primary");
    await Envelope.closeClientLoop(db, loopId, { status: 200 });
    assert.throws(() => ProposalPolicies.disposition([], { maintenance: false, clientOperation: true }), (cause: unknown) => {
        const problem = Problems.fromError(cause);
        assert.equal(problem?.status, 503);
        assert.equal(problem?.key, "PLURNK_SERVICE_PROPOSALS");
        return true;
    });
});

test("{§proposal-disposition}: an unexpected proposal is refused even when ordinary effect policy auto-accepts", async (t) => {
    panel(t, {
        PLURNK_SERVICE_EFFECT_HOST: "auto",
        PLURNK_SERVICE_PROPOSALS: "accept",
    });
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "bookkeeping-rejection");
    const sessionId = await RuntimeSession.ensure(db, workspaceId);
    const schemes = new SchemeRegistry();
    let applied = 0;
    schemes.register("proposing-test", {
        manifest: schemeManifest("proposing-test"),
        async editBatch() { return { status: 202, attrs: { effect: "host" } }; },
        async applyResolution() { applied++; return { status: 201 }; },
    });
    const engine = new Engine({ db, schemes });
    await assert.rejects(
        DispatchAsPlurnk.dispatch(engine, db, workspaceId, sessionId, [editStmt(urlPath("proposing-test", "/unexpected"), "new effect")]),
        (cause: unknown) => {
            const problem = Problems.fromError(cause);
            assert.ok(problem, String(cause));
            assert.equal(problem.status, 400);
            assert.equal(problem.type, "https://problems.plurnk.xyz/proposal/rejected");
            return true;
        },
    );
    assert.deepEqual(await engine.pendingProposals(workspaceId), []);
    const row = await db.test_get_log_rx_by_session_op.get<{ rx: string }>({ session_id: sessionId, op: "EDIT" });
    assert.ok(row);
    assert.equal(JSON.parse(row.rx).outcome, "runtime_bookkeeping");
    assert.equal(applied, 0, "the scheme never receives authority to apply its proposal");
});
});


describe("client-isolation", () => {
// {§connection-lifecycle} / {§actor-boundary} — a person's client operations journal in the
// workspace's runtime session, end-to-end.
//
// A client `op.*` lands in the runtime session `_plurnk`; `loop.run` runs the model in its own model
// session; the packet renders the model session, so no client-origin row ever reaches the model's log —
// invisibility by session, no origin filter. This proves the server wiring (op.* → runtime session,
// loop.run → model session) that the engine-level {§actor-boundary} guarantee rests on.
//
// {§machine-processes}: a client READS the model session by id —
// loop.run returns its modelSessionId and log.read({ sessionId }) targets it, ownership-gated.








test("{§machine-processes} a client operation cannot SEND the runtime actor into model inference", async () => {
    const mock = new Mock({
        contextWindow: 8192,
        responses: [makeMockResponse("````SEND [200]\nthis must remain unused\n````", 50)],
    });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "client-runtime-send" });
            const response = await rpcCall(ws, 2, "op.send", {
                recipient: "session://_plurnk",
                body: "run a model in the runtime actor",
            });
            const problem = rpcProblem(response);
            assert.equal(problem.status, 409);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/model-session-required");
            assert.equal(mock.remaining, 1, "the refused runtime actor consumes no model response");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} {§actor-boundary} a client op.* journals in the runtime session and never enters the model's packet", async () => {
    // The model just terminates; we only care where the client op landed.
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "client-isolation" });
            const workspaceId = (created.result as { id: number }).id;
            // A client op — lands in the workspace's runtime session.
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///secret", content: "client-only" });
            // The model works in its own session.
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const loopId = (result as { loopId: number }).loopId;

            const modelSession = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId });
            assert.ok(modelSession !== undefined, "the model loop has a session");

            // The model's packet is rendered from the model session alone.
            const modelLog = await db.engine_render_log.all<{ origin: string; pathname: string }>({ session_id: modelSession.session_id });
            assert.ok(modelLog.length > 0, "the model's packet carries its own log");
            assert.ok(
                modelLog.every((r) => r.origin !== "client"),
                "no client-origin op reaches the model's packet — the person's operation journals in the runtime session",
            );

            // The client still sees its own op: log.read reads the runtime session, where the op.edit lives.
            const own = await rpcCall(ws, 4, "log.read");
            const entries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(entries.some((e) => e.op === "EDIT" && e.origin === "client"), "the client reads its own op from the runtime session");
            const runtime = await daemon.readSession({ workspaceId, identity: { name: "_plurnk" } });
            assert.equal(runtime?.origin, "_plurnk");
            assert.notEqual(runtime?.id, modelSession.session_id, "the runtime session is distinct from the model session");
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} a connection reads the model session by id — loop.run returns modelSessionId, log.read targets it, ownership-gated", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "model-session-readable" });
            const workspaceId = (created.result as { id: number }).id;
            // A client op lands in the workspace's runtime session.
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///note", content: "client-only" });
            // Drive the model — it works in its own session, whose id loop.run returns.
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { loopId, modelSessionId } = result as { loopId: number; modelSessionId: number };
            assert.equal(typeof modelSessionId, "number", "loop.run returns the model session's id");
            assert.notEqual(modelSessionId, await daemon.ensureRuntimeSession(workspaceId), "the model session is distinct from the runtime session");
            const byLoop = await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId });
            assert.equal(byLoop!.session_id, modelSessionId, "the returned modelSessionId is the session the loop actually ran in");

            // Default log.read (no sessionId) → the runtime session: the op.edit.
            const own = await rpcCall(ws, 4, "log.read");
            const ownEntries = (own.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(ownEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "default log.read reads the runtime session");

            // log.read({ sessionId }) → the MODEL session's log: readable by id,
            // and a DISTINCT session — the client's op is absent from it.
            const modelRead = await rpcCall(ws, 5, "log.read", { sessionId: modelSessionId });
            const modelEntries = (modelRead.result as { entries: Array<{ origin: string; op: string }> }).entries;
            assert.ok(modelEntries.length > 0, "the model session's log is readable by id");
            assert.ok(!modelEntries.some((e) => e.op === "EDIT" && e.origin === "client"), "the model session is distinct — the client's op is absent from it");

            // Ownership: a session in a DIFFERENT workspace is refused from this connection.
            const foreignWorkspace = await insertWorkspace(db, `foreign-${crypto.randomUUID()}`);
            const foreignSession = await insertSession(db, foreignWorkspace, null, undefined, "model");
            const denied = await rpcCall(ws, 6, "log.read", { sessionId: foreignSession });
            const problem = rpcProblem(denied);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/session/workspace-mismatch");
            assert.equal(problem.sessionId, foreignSession);
            assert.equal(problem.actualWorkspaceId, foreignWorkspace);
        } finally { ws.close(); }
    });
});

test("{§connection-lifecycle} workspace.sessions tags each session with its actor — the model session is found by origin, not name", async () => {
    const mock = new Mock({ contextWindow: 8192, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "session-origin" });
            await rpcCall(ws, 2, "op.edit", { target: "workspace:///note", content: "x" });
            const result = await runLoopToTerminal(ws, 3, { prompt: "go" });
            const { modelSessionId } = result as { modelSessionId: number };

            const listed = (await rpcCall(ws, 4, "workspace.sessions")).result as { sessions: Array<{ id: number; name: string; origin: string }> };
            const model = listed.sessions.find((r) => r.id === modelSessionId);
            assert.equal(model?.origin, "model", "the model session is tagged origin=model");
            assert.equal(model?.name, SeamSocket.session);
            // A person's operations journal in the runtime session, the workspace's one `_plurnk` actor.
            assert.deepEqual(listed.sessions.filter((r) => r.origin !== "model").map(({ name, origin }) => ({ name, origin })),
                [{ name: "_plurnk", origin: "_plurnk" }], "the only other session is the runtime actor");
            // A client picks the model session by actor — no name parsing.
            assert.deepEqual(listed.sessions.filter((r) => r.origin === "model").map((r) => r.id), [modelSessionId], "exactly one model session, found by origin");
        } finally { ws.close(); }
    });
});
});


describe("owner-approval", () => {
// {§session-ownership} Server disposition and session owners use one proposal lifecycle.










class ProposingTest {
    readonly batches: number[] = [];
    static manifest: SchemeManifest = {
        name: "proposing-test",
        channels: {},
        defaultChannel: "body",
        category: "data",
        writableBy: ["model", "client"],
        volatile: false,
        modelVisible: true,
    };

    async editBatch(statements: readonly EditStatement[]): Promise<{ status: number; attrs: object; body: string }> {
        this.batches.push(statements.length);
        return {
            status: 202,
            body: "--- proposed-test\n+++ proposed-test\n@@ +x @@",
            attrs: { target: "/proposed-test" },
        };
    }
}

test("{§op-methods-op-dispatch}: each EDIT waits for its own proposal before preparing the next", async () => {
    const dsl = "````EDIT (proposing-test://x) <1>\none\n````\n\n````EDIT (proposing-test://x) <3>\nthree\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [makeMockResponse(dsl, 50)] });
    await withDaemon(mock, async (db, daemon, addr) => {
        const scheme = new ProposingTest();
        daemon.schemes.register("proposing-test", scheme);
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 1, "workspace.create", { name: "one-resource-proposal" });
            const loopPromise = rpcCall(ws, 2, "loop.run", { prompt: "batch" });
            const pending = await waitFor(
                () => proposals() as Array<{ logEntryId: number }>,
                (items) => items.length === 1,
            );
            assert.deepEqual(scheme.batches, [1], "the second EDIT has not been prepared");
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "accept" });
            const decision = await db.test_proposal_decision.get({ id: pending[0].logEntryId });
            assert.equal(decision?.resolver, TEST_OWNER, "the public client seam retains the actual resolving owner");
            assert.equal(decision?.decision, "accept");
            const next = await waitFor(
                () => proposals() as Array<{ logEntryId: number }>,
                (items) => items.length === 2,
            );
            await rpcCall(ws, 4, "loop.resolve", { logEntryId: next[1].logEntryId, decision: "accept" });
            const run = await loopPromise;
            const loopId = (run.result as { loopId: number }).loopId;
            await waitFor(() => terminated() as Array<{ loopId: number }>, (events) => events.some((event) => event.loopId === loopId));
            assert.deepEqual(scheme.batches, [1, 1]);
            assert.equal(proposals().length, 2);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string; status_rx: number }>({ loop_id: loopId });
            const edits = rows.filter((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.equal(edits.length, 2);
            assert.ok(edits.every((row) => row.status_rx === 200));
        } finally { ws.close(); }
    });
});

test("{§session-ownership} server acceptance resolves through Core without a client resolver", async (t) => {
    serverProposals(t, "accept");
    const first = "````EDIT (proposing-test://x)\ny\n````\n\n````SEND\ndone\n````";
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse(first, 50),
        makeMockResponse("````SEND [200]\ndone\n````", 0),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-accept" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal",
            });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string }>({ loop_id: result.loopId });
            const edit = rows.find((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.ok(edit !== undefined);
            assert.notEqual(edit.status_rx, 202);
        } finally { ws.close(); }
    });
});

test("{§proposal-disposition} server rejection settles the same admitted proposal without becoming a capability denial", async (t) => {
    serverProposals(t, "reject");
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````EDIT (proposing-test://x)\ny\n````\n\n````SEND\ndone\n````", 50),
        makeMockResponse("````SEND [200]\nthe edit was declined; concluding\n````", 50),
    ] });
    await withDaemon(mock, async (db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-reject" });
            const result = await runLoopToTerminal(ws, 2, {
                prompt: "trigger proposal",
            });
            assert.equal(result.result.status, 200);
            const rows = await db.test_log_entries_by_loop.all<{ op: string; status_rx: number; scheme: string; rx: string }>({ loop_id: result.loopId });
            const edit = rows.find((row) => row.op === "EDIT" && row.scheme === "proposing-test");
            assert.equal(edit?.status_rx, 400, "the admitted action was declined, not denied at capability admission");
            const refusal = JSON.parse(edit.rx) as { outcome?: string };
            assert.equal(refusal.outcome, "policy_veto");
            const [proposal] = await waitFor(
                () => proposals() as Array<{ disposition?: unknown; owner?: string }>,
                (items) => items.length > 0,
            );
            assert.deepEqual(proposal.disposition, { decision: "reject", outcome: "policy_veto" });
            assert.equal(proposal.owner, TEST_OWNER);
        } finally { ws.close(); }
    });
});

test("{§notifications} proposal notification projects the durable owner and selected disposition", async () => {
    const mock = new Mock({ contextWindow: viableWindow(), responses: [
        makeMockResponse("````EDIT (proposing-test://x)\ny\n````\n\n````SEND\ndone\n````", 50),
    ] });
    await withDaemon(mock, async (_db, daemon, addr) => {
        daemon.schemes.register("proposing-test", new ProposingTest());
        const ws = await connect(addr);
        try {
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 1, "workspace.create", { name: "proposal-review" });
            const run = rpcCall(ws, 2, "loop.run", {
                prompt: "trigger",
            });
            const [proposal] = await waitFor(
                () => proposals() as Array<{ logEntryId: number; sessionId?: number; owner?: string; disposition?: unknown }>,
                (items) => items.length > 0,
            );
            assert.equal(typeof proposal.sessionId, "number");
            assert.equal(proposal.owner, TEST_OWNER);
            assert.deepEqual(proposal.disposition, { decision: "review" });
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: proposal.logEntryId, decision: "accept" });
            await run;
        } finally { ws.close(); }
    });
});
});

