import { serverProposals } from "./_approval.ts";
// SPEC {§actor-boundary} — the actor boundary (isolation by session, two doors, self-hosting).
// Composed coverage for structural log isolation, the environment/voice doors,
// and ordinary runtime-owned operations through the runtime session `_plurnk`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EditStatement, LineMarker, UrlPath } from "@plurnk/plurnk-contracts";
import RuntimeSession from "../../src/core/RuntimeSession.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertOperationTurn, insertTurn } from "./_db.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: UrlPath, body: string, marker: LineMarker | null = null): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null, target, lineMarker: marker, body,
    matcher: null, position: { line: 1, column: 1 },
});

test("{§actor-boundary-no-mutex} two sessions in one workspace both write the same shared entry — no lock", async () => {
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
// Daemon.exec-wake.test.ts. Together they discharge {§actor-boundary-passive-wake}'s two-trigger contract.
test("{§env-delta-passive} an idle session wakes on an inject (voice), never on a delta (a sibling's shared-entry edit)", async (approvalContext) => {
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

test("{§turn0-agents-stunt} runtime-owned entry work is an ordinary administrative turn in the addressed session", async () => {
    // The AGENTS stunt ({§turn0-agents-stunt}) is operation-shaped runtime work,
    // so it uses DispatchAsPlurnk. Its generated resource and causal operation
    // history belong to the same Session that receives the resulting Turn-0 READ.
    const dir = await mkdtemp(join(tmpdir(), "plurnk-selfhost-"));
    await writeFile(join(dir, "AGENTS.md"), "# Self-hosting\nThe runtime is an actor.\n", "utf8");
    // #346 — a nested AGENTS.md materializes under _plurnk/instructions with
    // its subtree path preserved; noise dirs contribute nothing.
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
                    scheme: "workspace",
                    authority: "",
                    pathname: "/_plurnk/AGENTS.md",
                });
                assert.ok(entry !== undefined, "the generated document is structurally owned by the addressed Session");

                const nested = await db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId,
                    scheme: "workspace",
                    authority: "",
                    pathname: "/_plurnk/instructions/packages/web/AGENTS.md",
                });
                assert.ok(nested !== undefined, "a nested AGENTS.md materializes with its subtree path preserved (#346)");
                const noise = await db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId,
                    scheme: "workspace",
                    authority: "",
                    pathname: "/_plurnk/instructions/node_modules/dep/AGENTS.md",
                });
                assert.equal(noise, undefined, "noise directories contribute no instructions");

                const sessionLog = await db.test_log_entries_by_session.all<{
                    op: string | null; scheme: string | null; pathname: string; origin: string;
                    turn_id: number; status_rx: number;
                }>({ session_id: await RuntimeSession.ensure(db, workspaceId) });
                const matEdit = sessionLog.find((row) => row.op === "EDIT" && row.scheme === "workspace" && row.pathname === "/_plurnk/AGENTS.md");
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
                const docRead = modelLoopLog.find((row) => row.op === "READ" && row.scheme === "workspace"
                    && row.hostname === null && row.pathname === "/_plurnk/AGENTS.md");
                assert.ok(docRead !== undefined && docRead.status_rx === 200, "Turn 0 reads the addressed Session's generated policy entry");
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
