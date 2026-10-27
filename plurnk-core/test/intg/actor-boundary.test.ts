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
import SessionName from "../../src/core/SessionName.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import SeamSocket from "./_seam.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results, { OperationFailureError } from "../../src/core/results.ts";
import PacketBuilder from "../../src/core/PacketBuilder.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import ClientInteractions from "../../src/core/ClientInteractions.ts";
import CapabilityPolicies from "../../src/core/CapabilityPolicies.ts";
import DbChannelCaps from "../../src/core/caps/DbChannelCaps.ts";
import { serverProposals, TEST_OWNER, ownSession } from "./_approval.ts";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertOperationTurn, insertTurn, seedEntryWithChannel } from "./_db.ts";
import { Mock, chatMessageText, ProviderError } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb, HARNESS_WAIT_MS, rpcProblem, subscribeNotifications, waitFor } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors, userText } from "./_mock.ts";
import { Validator, Problems, type EditStatement, type UrlPath, type ParsedPath, type ClientEntry, type EntryReadResult as EntryReadWire, type KillStatement, type NoteStatement, type SessionOwner } from "@plurnk/plurnk-contracts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { copyStmt, editStmt, fullReplace, moveStmt, urlPath, readStmt } from "./_dsl.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { modelOperation } from "./_sessions.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { schemeManifest, DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { Shell } from "@plurnk/plurnk-execs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";
import { viableWindow } from "./_provider.ts";
import { provider as reasoningProvider, statement as reasoningStatement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { testExecutors } from "./_execs.ts";
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

test("{§session-initialization-entry} runtime-owned entry work is an ordinary administrative turn in the addressed session", async () => {
    // The AGENTS stunt ({§session-initialization-entry}) is operation-shaped runtime work,
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

test("{§env-delta-child-activity} received messages remain local observations, not child-authored activity", async () => {
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

test("{§env-delta-no-coalescing} {§env-delta-commons-mutation} commons mutations broadcast one occurrence identity and deduplicate the direct parent audience", async () => {
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

describe("catalog-preview", () => {
// PLURNK_SERVICE_FILES_ITEMS — turn-0 catalog preview foist ({§actor-boundary}). A plurnk-origin
// FIND(scheme:///*) is foisted into the model's turn 0 for folder-capable schemes: direct
// entries plus exact `dir/**` summaries. Kernel docs remain recursively enumerated. The
// first-N cap applies only to file rows; 0/unset turns the preview off.
//
// NOTE: sets a process-global env var. node --test isolates each file in its own
// process, so this doesn't leak across files; the on/off cases run sequentially.










type LogRow = { op: string | null; pathname: string; scheme: string | null; hostname: string | null; sequence: number; turn_id: number; signal: string | null; status_rx: number; tx: string; rx: string; attrs: string; folded: string; origin: string };
const mock = () => new Mock({ contextWindow: 100000, responses: [makeMockResponse("```SEND [200]\ndone\n```", 50)] });

test("{§actor-boundary} PLURNK_SERVICE_FILES_ITEMS foists shallow catalogs; the files cap governs only project files (none when off)", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        // ON with a cap: =2 → the catalog is foisted at turn 0 (200). The cap is FILES-only; the
        // model memory is not governed by the file cap — its survey contains all 3 entries.
        process.env.PLURNK_SERVICE_FILES_ITEMS = "2";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "manifest-on" });
                await rpcCall(ws, 2, "op.edit", { target: "workspace:///a.md", content: "alpha" });
                await rpcCall(ws, 3, "op.edit", { target: "workspace:///b.md", content: "bravo" });
                await rpcCall(ws, 4, "op.edit", { target: "workspace:///c.md", content: "charlie" });
                const resp = await runLoopToTerminal(ws, 5, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const cf = rows.find((r) => r.op === "FIND" && r.scheme === "workspace" && r.hostname === null && r.pathname === "/*");
                assert.ok(cf !== undefined, "turn 0 foists a FIND(workspace:///*) catalog preview when set");
                assert.equal(cf.status_rx, 200, "the catalog FIND returns the scheme's rows (200)");
                const parsed = JSON.parse(cf.rx) as { content?: string; results?: unknown[] };
                const items = parsed.results ?? (parsed.content !== undefined ? JSON.parse(parsed.content) as unknown[] : []);
                assert.equal(items.length, 4, "the project-file cap does not govern the model's own memory map");
            } finally { ws.close(); }
        });

        // OFF: unset → no manifest READ at turn 0.
        delete process.env.PLURNK_SERVICE_FILES_ITEMS;
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "manifest-off" });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "no catalog FIND foisted when unset");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

// The catalog is FIND-served — there is no materialized manifest entry. With the preview
// off, the session opens with no foisted catalog; the model FINDs each scheme on demand.
test("{§operator-config-workspace-settings} no manifest.json entry — the catalog is FIND-served; preview-off foists no FIND", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "0"; // preview OFF
    try {
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "catalog-find-served" });
                await rpcCall(ws, 2, "op.edit", { target: "workspace:///a.md", content: "alpha" });
                const resp = await runLoopToTerminal(ws, 3, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const entry = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname: "/manifest.json" });
                assert.equal(entry?.id, undefined, "no manifest.json entry — the catalog is not materialized as an entry");
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "preview off → no catalog FIND foisted; the model FINDs on demand");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

// {§operator-config-workspace-settings} — workspace filesItems replaces the env default outright,
// both directions: it can switch the preview off when env says on, and on when off.
test("{§operator-config-workspace-settings} workspace.create settings.filesItems replaces the env default at turn 0", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        // env ON (full) but the client's workspace asks for OFF (0) → no preview foisted.
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mi-off", settings: { filesItems: 0 } });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "workspace filesItems:0 replaces env -1 — no catalog FIND foisted");
            } finally { ws.close(); }
        });
        // env OFF (0) but the client's workspace asks for ON (-1) → preview appears.
        process.env.PLURNK_SERVICE_FILES_ITEMS = "0";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mi-on", settings: { filesItems: -1 } });
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const cf = rows.find((r) => r.op === "FIND" && r.status_rx === 200);
                assert.ok(cf !== undefined, "workspace filesItems:-1 replaces env 0 — catalog FIND foisted");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

// {§operator-config-workspace-settings} — the client surface is narrow and validated.
test("{§session-initialization-entry} workspace.create rejects malformed settings — fail hard, no silent accept", async () => {
    await withDaemon(mock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMI = await rpcCall(ws, 1, "workspace.create", { name: "bad-mi", settings: { filesItems: 1.5 } });
            const filesProblem = rpcProblem(badMI);
            assert.equal(filesProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-invalid");
            assert.equal(filesProblem.field, "settings.filesItems");
            // An unknown setting is refused, not silently accepted.
            const unknown = await rpcCall(ws, 2, "workspace.create", { name: "bad-alias", settings: { nosuch: true } });
            const unknownProblem = rpcProblem(unknown);
            assert.equal(unknownProblem.type, "https://problems.plurnk.xyz/daemon/input/setting-not-supported");
            assert.equal(unknownProblem.field, "settings.nosuch");
        } finally { ws.close(); }
    });
});

// {§session-initialization-entry} — turn-0 once-per-session foists fire on the session's first
// loop only; later loops in the same session already carry them in the persistent log. Two loops in
// one session: the manifest READ is in loop 1's log, absent from loop 2's.
test("{§actor-boundary} turn-0 once-per-session foists fire on the session's first loop only, not every loop", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // preview ON
    try {
        const twoLoops = new Mock({ contextWindow: 8192, responses: [makeMockResponse("```SEND [200]\ndone\n```", 50), makeMockResponse("```SEND [200]\ndone\n```", 50)] });
        await withDaemon(twoLoops, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "foist-once" });
                await rpcCall(ws, 2, "op.edit", { target: "workspace:///a.md", content: "alpha" });
                const r1 = await runLoopToTerminal(ws, 3, { prompt: "first" });
                const r2 = await runLoopToTerminal(ws, 4, { prompt: "second" });
                const catalogFind = async (loopId: number) => {
                    const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                    return rows.find((r) => r.op === "FIND" && r.scheme === "workspace" && r.hostname === null && r.pathname === "/*");
                };
                assert.ok((await catalogFind((r1 as { loopId: number }).loopId)) !== undefined, "session's first loop foists the catalog preview");
                assert.equal(await catalogFind((r2 as { loopId: number }).loopId), undefined, "the second loop does NOT re-foist it — it's already in the session's log");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§turn-source-resources} the turn-0 initialization consists of the real orienting operations", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist each survey whole at turn 0
        const provider = mock();
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "turn0-exemplar" });
                await rpcCall(ws, 2, "op.edit", { target: "workspace:///a.md", content: "alpha" });
                await rpcCall(ws, 3, "op.edit", { target: "workspace:///nested/b.md", content: "bravo" });
                const resp = await runLoopToTerminal(ws, 4, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const commons = rows.find((candidate) => candidate.op === "FIND" && candidate.scheme === "workspace" && candidate.hostname === null && candidate.pathname === "/*");
                assert.ok(commons !== undefined);
                const map = JSON.parse((JSON.parse(commons.rx) as { content: string }).content) as Array<Array<{ path: string; items?: number; tokens?: number }>>;
                assert.deepEqual(map.map(([item]) => item.path), ["workspace:///_plurnk/**", "workspace:///a.md", "workspace:///nested/**"]);
                assert.equal(map.find(([item]) => item.path === "workspace:///nested/**")?.[0]?.items, 1,
                    "the automatic shallow map retains the nested subtree as a complete aggregate");
                const initializationRows = rows.filter((row) => row.turn_id === commons.turn_id);
                const ops = initializationRows.map(({ op }) => op);
                assert.deepEqual([ops[0], ops.at(-1)], ["NOTE", "NOTE"], "initialization opens and closes with its NOTEs");
                assert.ok(ops.length > 2 && ops.slice(1, -1).every((op) => op === "FIND"),
                    "between them only the environment surveys: no READ of its own program, no reasoning demonstration");
                for (const row of initializationRows.filter(({ op }) => op === "FIND")) {
                    const result = JSON.parse(row.rx) as { content?: string; results?: unknown[] };
                    const items = result.results ?? (result.content === undefined ? [] : JSON.parse(result.content) as unknown[]);
                    assert.ok(items.length > 0, `the ${row.scheme ?? "file"}:${row.pathname} survey runs because it selects something`);
                }
                assert.equal(initializationRows.some(LogEntryProjection.isEmission), false,
                    "`_plurnk` initialization has no content emission ({§turn-source-resources})");
                const turn = await db.test_get_turn.get<{ producer: string; kind: string; status: number; completed_at: string | null }>({ id: commons.turn_id });
                assert.deepEqual(
                    { producer: turn?.producer, kind: turn?.kind, status: turn?.status },
                    { producer: "_plurnk", kind: "initialization", status: 200 },
                );
                assert.ok(turn?.completed_at !== null, "a completed continuation turn is distinct from an open turn");
                assert.equal(initializationRows.some(({ scheme }) => scheme === "reasoning"), false, "initialization neither reads nor surveys reasoning ({§session-initialization-entry})");
                const program = (await db.test_turn_sources_by_turn.all<{ kind: string; content: string }>({ turn_id: commons.turn_id })).find(({ kind }) => kind === "ops");
                assert.ok(program, "the survey is the initialization turn's ops source");
                assert.deepEqual(provider.received[0].filter(({ role }) => role === "assistant"), [],
                    "the program reaches the first request through its results, never assistant history");
                assert.deepEqual(
                    program.content.split("\n\n").flatMap((block) => /^```([A-Z]+)/.exec(block)?.[1] ?? []),
                    initializationRows.map(({ op }) => op),
                    "{§statement-rendering}: every operation is separated by a blank line and has exactly one ordinary receipt",
                );
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§session-initialization-entry} an empty workspace runs only the surveys that select something, in their taught order", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        process.env.PLURNK_SERVICE_FILES_ITEMS = "2";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "empty-ws-find" }); // headless: zero tracked files
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId, modelSessionId } = resp as { loopId: number; modelSessionId: number };
                const sessionName = await SessionName.forId(db, modelSessionId);
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const finds = rows.filter((r) => r.op === "FIND");
                // Nothing is in it: no project files, agents or members definitions, and the session is new.
                assert.deepEqual(finds.map(({ scheme, hostname, pathname }) => ({ scheme, hostname, pathname })), [
                    { scheme: "skill", hostname: "*", pathname: "/SKILL.md" },
                    { scheme: "workspace", hostname: null, pathname: "/_plurnk/plurnk/*.md" },
                    { scheme: "workspace", hostname: null, pathname: "/_plurnk/tools/*.md" },
                    { scheme: "workspace", hostname: null, pathname: "/_plurnk/tools/plurnk.md" },
                    { scheme: "workspace", hostname: null, pathname: "/*" },
                ], "the surveys that select something run, in their taught order; the empty surfaces are left out ({§session-initialization-entry})");
                assert.deepEqual(
                    finds.map(({ tx }) => (JSON.parse(tx) as { aside: string | null }).aside),
                    [null, null, null, null, "workspace knowledgebase entries"],
                    "asides name what each namespace is",
                );
                for (const row of finds) {
                    assert.equal(row.status_rx, 200, `${row.scheme}:${row.pathname} has its catalog contract status`);
                    const result = JSON.parse(row.rx) as { content?: string; results?: unknown[] };
                    const items = result.results ?? (result.content !== undefined ? JSON.parse(result.content) as unknown[] : []);
                    assert.ok(items.length > 0, `${row.scheme}:${row.pathname} selected something`);
                }
                assert.equal(sessionName.length > 0, true);
                assert.ok(
                    finds.every(({ tx }) => (JSON.parse(tx) as { body?: unknown }).body === null),
                    "Turn 0 catalogs documents without imposing a body-shape eligibility gate",
                );
                const skillsSurvey = finds.find((r) => r.pathname === "/SKILL.md");
                const skillsResult = JSON.parse(skillsSurvey!.rx) as { content?: string; results?: unknown[] };
                const skillItems = (skillsResult.results
                    ?? (skillsResult.content === undefined ? [] : JSON.parse(skillsResult.content) as unknown[])) as Array<Array<{ path: string; aside?: string }>>;
                assert.deepEqual(skillItems.flat().map(({ path }) => path), ["skill://plurnk/SKILL.md"], "an empty project still has Plurnk's ordinary service skill");
                assert.ok(skillItems[0]?.[0]?.aside, "the skill arrives with its standard description");
                const toolSurvey = finds.find((r) => r.pathname === "/_plurnk/plurnk/*.md");
                const toolResult = JSON.parse(toolSurvey!.rx) as { content?: string; results?: unknown[] };
                const toolItems = (toolResult.results
                    ?? (toolResult.content === undefined ? [] : JSON.parse(toolResult.content) as unknown[])) as Array<Array<{ path: string; aside?: string }>>;
                const shell = toolItems.flat().find(({ path }) => path === "workspace:///_plurnk/plurnk/sh.md");
                assert.equal(
                    shell?.aside,
                    `\`\`\`sh <!-- ${Shell.summary(Shell.current())} -->\ngit status --short\n\`\`\``,
                    "Turn 0 teaches a compact executable witness with its aside naming the shell that runs ({§executor-shell}), as plain text rather than a code span",
                );
                const python = toolItems.flat().find(({ path }) => path === "workspace:///_plurnk/plurnk/python3.md");
                assert.equal(
                    python?.aside,
                    "```python3 <!-- Run Python 3 code or scripts. -->\nprint(42)\n```",
                    "the interpreter aside teaches an executable inline program without requiring a document READ",
                );
                for (const [index, name] of ["https", "session", "wss"].entries()) {
                    const resource = toolItems.flat().find(({ path }) => path === `workspace:///_plurnk/plurnk/${name}.md`);
                    assert.ok(resource !== undefined && resource.aside !== undefined && resource.aside.trim() !== "",
                        `${name} reference depth is visible with an orienting aside`);
                    const response = await rpcCall(ws, 10 + index, "entry.read", { target: resource.path });
                    const reference = Validator.assertEntryReadResult(response.result);
                    assert.equal(reference.status, 200);
                    assert.ok(reference.entry?.channels.body.content.replace(/\s+/g, " ").includes(resource.aside.replace(/\s+/g, " ")),
                        `${name} orientation comes from the readable reference, without pinning its prose`);
                }
                const shellSample = rows.find((row) => row.op === "READ" && row.scheme === "workspace" && row.hostname === null && row.pathname === "/_plurnk/plurnk/sh.md");
                assert.equal(shellSample, undefined, "Turn 0 does not privilege the shell skill with an automatic READ");
                const initializationTurnId = finds[0].turn_id;
                const initializationRows = rows.filter((row) => row.turn_id === initializationTurnId);
                assert.deepEqual(
                    initializationRows.filter(({ op }) => op !== null).map(({ op }) => op),
                    ["NOTE", "FIND", "FIND", "FIND", "FIND", "FIND", "NOTE"],
                    "initialization contains its opening NOTE, the five surveys that select something, its closing NOTE, and nothing else",
                );
                assert.equal(initializationRows.some(({ scheme }) => scheme === "ops"), false,
                    "turn 0 reads none of its own program, and it announces no emission ({§turn-source-resources})");
            } finally { ws.close(); }
        });
    } finally { if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev; }
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

describe("inject-fold-posture", () => {
// {§methods-workspace-create} — folded prompts preserve durable loop configuration.





const heldLoopMock = () => new Mock({ contextWindow: 16384, responses: [
    // A non-auto execution proposal holds loop 1 live (paused at the review) while injects arrive.
    makeMockResponse("\n````sh\necho hold\n````\n\n````NOTE\nworking\n````", 10),
    makeMockResponse("````SEND [200]\ndone\n````", 10),
    makeMockResponse("````SEND [200]\ndone again\n````", 10),
] });

test("{§session-ownership}: injecting a message preserves the owner's pending review", async () => {
    await withDaemon(heldLoopMock(), async (_db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "owned-injection" });
            const workspaceId = (created.result as { id: number }).id;
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const started = await rpcCall(ws, 2, "loop.run", { prompt: "start working" });
            const { modelSessionId } = started.result as { modelSessionId: number };
            const pending = await waitFor(() => proposals() as Array<{ logEntryId: number }>, (items) => items.length === 1);
            const folded = await rpcCall(ws, 3, "loop.run", { prompt: "also do this" });
            assert.equal((folded.result as { action: string }).action, "injected_next_turn");
            assert.equal((await daemon.readSession({ workspaceId, identity: { id: modelSessionId } }))?.owner, TEST_OWNER);
            assert.equal((await daemon.pendingProposals(workspaceId)).length, 1);
            await rpcCall(ws, 5, "loop.resolve", { logEntryId: pending[0].logEntryId, decision: "reject" });
        } finally { ws.close(); }
    });
});

test("{§methods-workspace-create}: a folded prompt cannot replace the durable turn ceiling", async () => {
    await withDaemon(heldLoopMock(), async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "max-turns-conflict" });
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const started = await rpcCall(ws, 2, "loop.run", { prompt: "start working", maxTurns: 5 });
            const loopId = (started.result as { loopId: number }).loopId;
            await waitFor(() => proposals(), (p) => p.length >= 1, { timeoutMs: 10_000 });

            const omitted = await rpcCall(ws, 3, "loop.run", { prompt: "keep the ceiling" });
            assert.equal((omitted.result as { action: string }).action, "injected_next_turn");
            assert.equal(
                (await db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId }))?.max_turns,
                5,
                "an omitted ceiling leaves the durable selection unchanged",
            );

            const matching = await rpcCall(ws, 4, "loop.run", { prompt: "same ceiling", maxTurns: 5 });
            assert.equal((matching.result as { action: string }).action, "injected_next_turn");

            const conflicted = await rpcCall(ws, 5, "loop.run", { prompt: "different ceiling", maxTurns: 6 });
            const problem = rpcProblem(conflicted);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/loop/turn-ceiling-conflict");
            assert.equal(problem.selectedMaximumTurns, 5);
            assert.equal(problem.requestedMaximumTurns, 6);
            assert.match(problem.recovery ?? "", /Cancel or conclude/);
        } finally {
            ws.close();
        }
    });
});

test("{§methods-workspace-create}: an omitted ceiling resumes a parked loop unchanged", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const mock = new Mock({
        contextWindow: 16384,
        responses: [
            makeMockResponse("````sh\nsleep 30\n````\n\n````WAIT\npark\n````", 10),
            makeMockResponse("````SEND [200]\ndone\n````", 10),
        ],
    });

    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "parked-max-turns" });
            const started = await rpcCall(ws, 2, "loop.run", {
                prompt: "start and park",

                maxTurns: 5,
            });
            const loopId = (started.result as { loopId: number }).loopId;
            await waitForDb(
                async () => (await db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId }))?.max_turns,
                (maxTurns) => maxTurns === 5,
            );
            await waitForDb(
                async () => (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
                (status) => status === 202,
                { timeoutMs: 10_000 },
            );

            const conflicted = await rpcCall(ws, 3, "loop.run", { prompt: "different ceiling", maxTurns: 6 });
            assert.equal(rpcProblem(conflicted).type, "https://problems.plurnk.xyz/daemon/loop/turn-ceiling-conflict");

            const omitted = await rpcCall(ws, 4, "loop.run", { prompt: "resume with the durable ceiling" });
            assert.equal((omitted.result as { action: string }).action, "injected_next_turn");
            assert.equal((omitted.result as { loopId: number }).loopId, loopId, "the parked loop resumes in place");
            assert.equal(
                (await db.drain_get_loop_max_turns.get<{ max_turns: number }>({ loop_id: loopId }))?.max_turns,
                5,
            );
        } finally {
            ws.close();
        }
    });
});
});

describe("local-instructions", () => {
// {§session-initialization-entry} The root AGENTS.local.md rides turn 0 after AGENTS.md: read from disk whatever its git
// status, hidden only by an exclusion, root only; absent, nothing.











const execFileP = promisify(execFile);
const LOCAL = "# Local\nThis machine's rules.\n";

// Each standing the root AGENTS.local.md can have in the repository, with and without the project AGENTS.md beside it.
for (const standing of ["absent", "ignored", "untracked", "tracked", "excluded"] as const) {
    for (const withAgents of [true, false]) {
        const projected = standing !== "absent" && standing !== "excluded";
        test(`{§session-initialization-entry}: an AGENTS.local.md ${standing}${withAgents ? " beside AGENTS.md" : ""} is ${projected ? "read at turn 0" : "not projected"}`, async () => {
            const prior = Object.fromEntries(["PLURNK_SERVICE_GIT_ALLOWED", "PLURNK_SERVICE_GIT_AUTO", "PLURNK_MEMBERS_ENABLED", "PLURNK_MEMBERS_no_local"]
                .map((key) => [key, process.env[key]]));
            process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
            process.env.PLURNK_SERVICE_GIT_AUTO = "1";
            process.env.PLURNK_MEMBERS_ENABLED = "1";
            // An operator exclusion ({§members-configuration}).
            if (standing === "excluded") process.env.PLURNK_MEMBERS_no_local = "!AGENTS.local.md";
            const dir = await mkdtemp(join(tmpdir(), "plurnk-local-instructions-"));
            try {
                await execFileP("git", ["init", "-q"], { cwd: dir, env: hermeticGitEnv() });
                if (standing === "ignored") await writeFile(join(dir, ".gitignore"), "AGENTS.local.md\n", "utf8");
                if (withAgents) await writeFile(join(dir, "AGENTS.md"), "# Project\nShared rules.\n", "utf8");
                if (standing !== "absent") await writeFile(join(dir, "AGENTS.local.md"), LOCAL, "utf8");
                if (standing === "tracked") await execFileP("git", ["add", "AGENTS.local.md"], { cwd: dir, env: hermeticGitEnv() });
                await mkdir(join(dir, "packages", "web"), { recursive: true });
                await writeFile(join(dir, "packages", "web", "AGENTS.local.md"), "# Nested\n", "utf8");
                const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
                await withDaemon(mock, async (db, _daemon, addr) => {
                    const ws = await connect(addr);
                    try {
                        const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: "local-instructions", projectRoot: dir })).result as { id: number }).id;
                        const { loopId, finalStatus } = (await runLoopToTerminal(ws, 2, { prompt: "go" })) as { loopId: number; finalStatus: number };
                        assert.equal(finalStatus, 200);
                        const entry = await db.crud_find_workspace_entry.get<{ id: number }>({
                            workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/_plurnk/AGENTS.local.md",
                        });
                        assert.equal(entry !== undefined, projected, projected ? "the local file is projected" : "nothing is projected");
                        if (entry !== undefined) {
                            const body = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
                            assert.equal(body?.content, LOCAL, "the projection mirrors the file");
                        }
                        const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string; hostname: string | null; pathname: string; status_rx: number }>({ loop_id: loopId });
                        const reads = rows.filter((row) => row.op === "READ" && row.scheme === "workspace" && row.hostname === null && /^\/_plurnk\/AGENTS(\.local)?\.md$/u.test(row.pathname));
                        assert.deepEqual(reads.map(({ pathname, status_rx }) => [pathname, status_rx]),
                            [...withAgents ? [["/_plurnk/AGENTS.md", 200]] : [], ...projected ? [["/_plurnk/AGENTS.local.md", 200]] : []],
                            "turn 0 reads AGENTS.md, then its local override, each found");
                        const nested = await db.crud_find_workspace_entry.get<{ id: number }>({
                            workspace_id: workspaceId, scheme: "workspace", authority: "", pathname: "/_plurnk/instructions/packages/web/AGENTS.local.md",
                        });
                        assert.equal(nested, undefined, "a nested AGENTS.local.md is never projected");
                    } finally { ws.close(); }
                });
            } finally {
                await rm(dir, { recursive: true, force: true });
                for (const [key, value] of Object.entries(prior)) {
                    if (value === undefined) delete process.env[key];
                    else process.env[key] = value;
                }
            }
        });
    }
}
});

describe("mcp-catalog-composition", () => {
process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "60000";
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";

const boundaries = ["notification during refresh", "aborted publication", "failed listing"] as const;
const verifyRefresh = async (t: TestContext, boundary: typeof boundaries[number]): Promise<void> => {
    let tool = "first";
    let pauseNextList = false;
    let failNextList = false;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const secondQueued = Promise.withResolvers<void>();
    const refreshes: Promise<void>[] = [];
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "changing-catalog", version: "1.0.0" });
        const name = tool;
        server.registerTool(name, { description: `Observe ${name}.` }, async () => ({
            content: [{ type: "text", text: `Observed ${name} from the server.` }],
        }));
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler, async (request) => {
        const body = await request.clone().json();
        if (body.method === "tools/list" && failNextList) {
            failNextList = false;
            return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Transient listing failure." } });
        }
        if (body.method !== "tools/list" || !pauseNextList) return null;
        pauseNextList = false;
        const response = await handler.fetch(request);
        entered.resolve();
        await release.promise;
        return response;
    });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        "````fixture (third)\n{}\n````\n\n````WAIT\nObserve the result.\n````",
        "````SEND [200]\nCatalog tool result observed.\n````",
    ].map(makeMockResponse) });
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, hostPaths });
    const mcp = McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "5000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } });
    daemon.registerModule({
        setup: (seam) => mcp.setup({
            readWorkspacePlugins: (workspaceId) => seam.readWorkspacePlugins(workspaceId),
            workspacePaths: (workspaceId) => seam.workspacePaths(workspaceId),
            readWorkspaceEnvironment: (workspaceId) => seam.readWorkspaceEnvironment(workspaceId),
            operatorEnvironment: () => seam.operatorEnvironment(),
            workspaceStateDirectory: (workspaceId, owner) => seam.workspaceStateDirectory(workspaceId, owner),
            registerModuleAction: (registration) => seam.registerModuleAction(registration),
            registerFunctionalityAdapter: (adapter) => {
                const handle = seam.registerFunctionalityAdapter(adapter);
                return { ...handle, refresh: (...args) => {
                    const pending = handle.refresh(...args);
                    refreshes.push(pending);
                    if (refreshes.length === 2) secondQueued.resolve();
                    return pending;
                } };
            },
        }),
        stop: () => mcp.stop(),
    }, "@plurnk/plurnk-mcp");
    t.after(async () => { release.resolve(); await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "catalog-race" });
    const sessionId = await insertSession(db, workspaceId, null, "reader", "model");
    // Tool documents are workspace resources ({§session-scheme}): a person reads them
    // ({§connection-lifecycle}), leaving the model session's next call under test.
    const read = async (path: string) => {
        const source = PlurnkParser.frame(`READ (${path}) <1,-1>`, null);
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement");
        if (item?.kind !== "statement") throw new Error("Expected one READ");
        return (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [item.statement] }))[0];
    };
    const toolsDocument = async (extension = "md"): Promise<string> => {
        const document = await read(`workspace:///_plurnk/tools/fixture.${extension}`);
        assert.equal(document.status, 200);
        assert.equal(typeof document.content, "string");
        return document.content as string;
    };
    // {§mcp-configuration} The first read makes the workspace resident.
    assert.match(await toolsDocument(), /fixture \(first\)/);
    // {§executor-tool-catalog} The catalog shares the same refresh and withdrawal boundary.
    const listRequests = () => served.requests.filter(({ body }) => (body as { method?: string }).method === "tools/list").length;
    const beforeRead = listRequests();
    const names = async (): Promise<string[]> => JSON.parse(await toolsDocument("json")).tools.map((entry: { name: string }) => entry.name);
    assert.deepEqual(await names(), ["first"]);
    assert.equal(listRequests(), beforeRead, "catalog READ reuses discovery rather than listing MCP tools again");
    const catalog = async () => (await daemon.invokeModuleAction("workspace.mcp.list", {}, {
        scope: "workspace", workspaceId,
    })) as { definitions: { alias: string; detail: { tools: string[] } }[] };
    assert.deepEqual((await catalog()).definitions.find(({ alias }) => alias === "fixture")?.detail.tools, ["first"]);

    if (boundary === "notification during refresh") {
        tool = "second";
        pauseNextList = true;
        handler.notify.toolsChanged();
        await entered.promise;
        tool = "third";
        handler.notify.toolsChanged();
    } else {
        tool = "third";
        if (boundary === "aborted publication") {
            t.mock.method(daemon, "replaceWorkspaceCapabilities", async () => {
                throw new OperationFailureError(Results.failure("daemon:workspace-functionality", "workspace-busy", 409,
                    "The fixture holds the publication boundary."));
            }, { times: 1 });
        } else {
            failNextList = true;
        }
        handler.notify.toolsChanged();
    }
    await secondQueued.promise;
    release.resolve();
    const settled = await Promise.allSettled(refreshes);
    assert.deepEqual(settled.map(({ status }) => status), boundary === "aborted publication"
        ? ["rejected", "fulfilled"] : ["fulfilled", "fulfilled"]);
    if (settled[0]?.status === "rejected") {
        assert.ok(settled[0].reason instanceof OperationFailureError);
        assert.equal(settled[0].reason.result.status, 409);
    }

    assert.deepEqual((await catalog()).definitions.find(({ alias }) => alias === "fixture")?.detail.tools, ["third"],
        "the second invalidation must not disappear when the earlier catalog commits");
    const document = await toolsDocument();
    assert.match(document, /fixture \(third\)/);
    assert.doesNotMatch(document, /fixture \((?:first|second)\)/);
    assert.deepEqual(await names(), ["third"]);
    assert.equal((await read("workspace:///_plurnk/tools/fixture/first.json")).status, 404,
        "refresh removes the old per-tool schema as well as its catalog definition");
    assert.equal(provider.received.length, 0, "catalog updates do not invoke the model");
    const terminated = Promise.withResolvers<void>();
    const unsubscribe = daemon.subscribeToEvents((scope, method) => {
        if (scope === workspaceId && method === "loop/terminated") terminated.resolve();
    });
    t.after(unsubscribe);
    serverProposals(t, "accept");
    const loop = await daemon.runLoop({ workspaceId, sessionId, prompt: "Use the current tool." });
    const lifecycle = new LoopLifecycle(db);
    // {§module-workspace-residency}: the stored result precedes turn-gate release.
    await terminated.promise;
    assert.equal(await lifecycle.status(loop.loopId), 200);
    assert.equal(provider.received.length, 2);
    assert.match(provider.received[1].map(chatMessageText).join("\n"), /Observed third from the server\./);
    await daemon.invokeModuleAction("workspace.mcp.disable", { alias: "fixture" }, { scope: "workspace", workspaceId });
    for (const path of ["fixture.md", "fixture.json", "fixture/third.json"]) {
        assert.equal((await read(`workspace:///_plurnk/tools/${path}`)).status, 404,
            `disabled tools leave no generated resource: ${path}`);
    }
};

for (const boundary of boundaries) {
    test(`{§mcp-catalog-refresh-in-place} ${boundary} preserves the current tools, docs, and next model call`,
        { timeout: 15000 }, (t) => verifyRefresh(t, boundary));
}
});

describe("mcp-subscription-composition", () => {
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "60000";

const step = (op = "NOTE") => PlurnkParser.frame(op, op === "NOTE" ? "Inspect the result." : "Resource inspected.");
const read = (uri: string) => PlurnkParser.frame(`READ (fixture://${resourcePath(uri)}) <1,-1>`, null);

test("{§mcp-host-composition} {§actor-boundary} resource updates refresh a later READ without changing history or waking unrelated sessions", { timeout: 20_000 }, async (t) => {
    serverProposals(t, "accept");
    const alpha = "fixture://alpha";
    const beta = "fixture://beta";
    const documents = new Map([[alpha, "alpha-version-one"], [beta, "beta-version-one"]]);
    const reads = new Map([[alpha, 0], [beta, 0]]);
    const handler = createMcpHandler(() => {
        const server = new McpServer({ name: "resource-observation", version: "1.0.0" }, {
            capabilities: { resources: { subscribe: true } },
        });
        for (const [uri] of documents) {
            server.registerResource(uri, uri, {
                mimeType: "text/plain", cacheHint: { ttlMs: 60_000, cacheScope: "private" },
            }, async () => {
                reads.set(uri, reads.get(uri)! + 1);
                return { contents: [{ uri, mimeType: "text/plain", text: documents.get(uri)! }] };
            });
        }
        return server;
    }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
    const served = await serveMcpHttp(t, handler);
    const { hostPaths, env: mcpEnv } = await mcpFixture(t, { fixture: httpEntry(served.url) });
    const provider = new Mock({ contextWindow: 1_000_000, responses: [
        `${read(alpha)}\n\n${read(beta)}\n\n${step("NOTE")}`,
        step("SEND [200]"),
        step("SEND [200]"),
        `${read(alpha)}\n\n${step("NOTE")}`,
        step("SEND [200]"),
    ].map(makeMockResponse) });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider, nodeModulesPath: resolve("node_modules"), hostPaths });
    daemon.registerModule(McpModule.init({ env: { ...mcpEnv,
        PLURNK_MCP_CONNECT_TIMEOUT: "5000", PLURNK_MCP_REQUEST_TIMEOUT: "10000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
    } }), "@plurnk/plurnk-mcp");
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const { workspaceId } = await daemon.createWorkspace({ name: "mcp-resource-observation" });
    const alice = await insertSession(db, workspaceId, null, "alice", "model");
    const bob = await insertSession(db, workspaceId, null, "bob", "model");
    const lifecycle = new LoopLifecycle(db);
    const run = async (sessionId: number) => {
        const result = await daemon.runLoop({ workspaceId, sessionId, prompt: "Inspect the resource." });
        await waitForDb(() => lifecycle.status(result.loopId), (status) => status === 200);
        return result;
    };
    const packet = (index: number) => provider.received[index].map(chatMessageText).join("\n");
    const viewerRead = async (uri: string) => {
        const source = read(uri);
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement");
        if (item?.kind !== "statement") throw new Error("Expected one READ");
        // A person viewing the resource ({§connection-lifecycle}).
        return (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [item.statement] }))[0];
    };
    const first = await run(alice);
    assert.equal(provider.received.length, 2);
    assert.match(packet(1), /alpha-version-one/u);
    assert.match(packet(1), /beta-version-one/u);
    const history = await db.test_log_entries_by_loop.all({ loop_id: first.loopId });
    assert.equal((await viewerRead(alpha)).content, "alpha-version-one");
    assert.equal((await viewerRead(beta)).content, "beta-version-one");
    assert.deepEqual([...reads.values()], [1, 1], "a second actor reads the same workspace attachment's cached resources");
    const subscriptions = served.requests.flatMap(({ body }) => {
        const message = body as { method?: string; params?: { notifications?: { resourceSubscriptions?: string[] } } };
        return message.method === "subscriptions/listen" ? [message.params?.notifications?.resourceSubscriptions ?? []] : [];
    });
    assert.deepEqual(subscriptions.at(-1), [alpha, beta], "both READs joined the acknowledged resource filter");

    documents.set(alpha, "alpha-version-two");
    for (let index = 0; index < 32; index++) handler.notify.resourceUpdated(alpha);
    const refreshed = await waitForDb(() => viewerRead(alpha), (result) => result.content === "alpha-version-two");
    assert.equal(refreshed.status, 200);
    assert.equal((await viewerRead(beta)).content, "beta-version-one");
    assert.deepEqual([...reads.values()], [2, 1], "the selected resource is invalidated; the other cached body stays valid");
    assert.equal(provider.received.length, 2, "neither resource notifications nor client READs invoke a model");
    assert.deepEqual(await db.test_log_entries_by_loop.all({ loop_id: first.loopId }), history,
        "refreshing a source never rewrites the earlier operation receipts");
    assert.deepEqual(await db.test_loops_statuses_by_session.all({ session_id: bob }), [], "an unrelated session acquired no loop");

    await run(bob);
    assert.equal(provider.received.length, 3);
    assert.doesNotMatch(packet(2), /(?:alpha|beta)-version-/u, "ordinary remote changes create no ambient resource rows");
    await run(alice);
    assert.equal(provider.received.length, 5);
    assert.match(packet(3), /alpha-version-one/u, "the next loop still sees its own original observation");
    assert.doesNotMatch(packet(3), /alpha-version-two/u, "updated content is not pushed into the session's packet");
    assert.match(packet(4), /alpha-version-two/u, "an explicit model READ receives the updated source");
    assert.deepEqual([...reads.values()], [2, 1], "the model shares the refreshed cache rather than fetching again");
    assert.deepEqual(await db.test_log_entries_by_loop.all({ loop_id: first.loopId }), history);
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

describe("packet-current-turn", () => {
// {§child-orientation} — the Session block opens the footer and names the coordinate the
// packet's response becomes, so the model's own `reasoning://alice/L/T` and `ops://alice/L/T` need no guessing.












test("{§child-orientation}: the Session block carries the loop and turn sequence the packet opens, after log and continuity", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-current-turn");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 3);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const packet = await packets.buildRequestPacket({
            initialMessages: [], workspaceId, sessionId, loopId, currentTurnSeq: 7, provider: reasoningProvider(), gitStatus: null,
        });
        const block = JSON.parse(packetSection(packet, "session")) as { loop: number; turn: number; path: string };
        assert.deepEqual([block.loop, block.turn], [3, 7]);
        assert.match(block.path, /^session:\/\//);
        const names = packet.sections.map(({ name }) => name);
        assert.ok(names.indexOf("session") > names.indexOf("log"), "in the status clump, below the initial log");
    } finally { await db.close(); }
});

test("{§child-orientation}: the coordinate on the packet is the one whose reasoning the model's READ resolves as its own", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-current-turn-own");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const context = { workspaceId, sessionId, loopId };
        const mock = reasoningProvider("Own reasoning for this very turn.",
            `${PlurnkParser.frame("READ (reasoning://alice/1/2) <1,-1>", null)}\n\n${PlurnkParser.frame("SEND", "Ready.")}`);
        const ran = await engine.runTurn({ ...context, provider: mock, messages: [] });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: ran.turnId });
        assert.equal(turn?.sequence, 2);
        const user = userText(mock.received.at(-1)!);
        assert.match(user, /## Session\n\{"path":"session:\/\/alice","parent":null,"loop":1,"turn":2,"owner":\{"address":"[^"]+","interactive":(?:true|false)\}\}/, "the packet the model answered named turn 1/2 and its owner in its Session block");
        assert.ok(user.indexOf("## Log") < user.indexOf("## Session"), "below the log");
        const own = await clientRead(engine, db, { ...context, statement: reasoningStatement("````READ (reasoning://alice/1/2) <1,-1>````") });
        assert.equal(own.status, 200);
        assert.ok("content" in own);
        assert.equal(own.content, "Own reasoning for this very turn.");
    } finally { await db.close(); }
});
});

describe("packet-preflight", () => {
test("{§session-initialization-entry}: packet preflight preserves stream growth until an actual provider request", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-preflight");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const schemes = new SchemeRegistry();
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, authority: await SessionName.forId(db, sessionId), scheme: "workspace", pathname: "/progress",
            channel: "stdout", content: "running\n", mimetype: "text/stream", state: "active",
        });
        await db.test_seed_channel.run({
            entry_id: entryId, name: "body", content: "", mimetype: "text/plain", state: "static",
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId, entryId, scheme: "session", handle: "fixture", publishedChannel: "stdout",
        });
        const model = reasoningProvider();
        const packets = new PacketBuilder({ db, schemes, executors: () => undefined });
        const build = () => packets.buildRequestPacket({
            initialMessages: [], workspaceId, sessionId, loopId, currentTurnSeq: 1, provider: model, gitStatus: null,
        });
        const cursor = async () => (await db.test_subscription_publications.all<{ published_end: number }>({ id: subscriptionId }))[0].published_end;
        const now = Date.now();
        t.mock.method(Date, "now", () => now);
        const first = await build();
        const second = await build();
        assert.equal(await cursor(), 0);
        assert.deepEqual(first.sections, second.sections, "measuring the candidate cannot consume the stream's growth pointer");
        assert.match(second.sections.find(({ name }) => name === "work")!.content, /\(\+8 bytes\)/);
        const attributed = { ...second, attributions: [] };
        assert.equal(packets.curationOverflow(attributed), null, "ordinary attribution copies preserve measured admission identity");
        await packets.recordObservations(attributed);
        assert.equal(await cursor(), 8);
        await ChannelWrite.appendToChannel(db, { entryId, producerSessionId: sessionId, channel: "stdout", chunk: "more\n" });
        const newer = await build();
        assert.equal(await cursor(), 8);
        assert.match(newer.sections.find(({ name }) => name === "work")!.content, /\(\+5 bytes\)/);
        const engine = new Engine({ db, schemes });
        await engine.runTurn({ workspaceId, sessionId, loopId, provider: model, messages: [] });
        assert.equal(await cursor(), 13, "the composed provider path acknowledges the actual request");
        await packets.recordObservations(first);
        assert.equal(await cursor(), 13, "acknowledging an earlier snapshot never rewinds the cursor");
    } finally { await db.close(); }
});
});

describe("packet-session-block", () => {
// {§child-orientation} — the Session block follows the log and carries the actor, its parent, the
// coordinate this packet's response becomes and its owner with whether a person attends; the packet
// carries no date, time or zone.








test("{§child-orientation}: the Session block follows the log with path, parent, loop, turn and owner, and nothing dated", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "packet-session-block");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const packet = await packets.buildRequestPacket({
            initialMessages: [], workspaceId, sessionId, loopId, currentTurnSeq: 3, provider: reasoningProvider(), gitStatus: null,
        });
        const block = JSON.parse(packetSection(packet, "session")) as { path: string; parent: string | null; loop: number; turn: number; owner: { address: string; interactive: boolean } };
        assert.match(block.path, /^session:\/\//);
        assert.equal(block.parent, null, "a root session states parent: null");
        assert.deepEqual([block.loop, block.turn], [1, 3], "the coordinate this packet's response becomes");
        assert.deepEqual(block.owner, { address: "_plurnk", interactive: false }, "a runtime-owned session is told that nobody attends its owner");
        assert.deepEqual(Object.keys(block), ["path", "parent", "loop", "turn", "owner"], "the block carries nothing else: no date, time or zone");
        const user = packet.sections.filter(({ slot }) => slot === "user").map(({ name }) => name);
        assert.ok(user.indexOf("session") > user.indexOf("log"), "the Session block sits in the status clump below the log");
        assert.equal(user[0], "log", "nothing volatile precedes the log");
        const rendered = PacketWire.renderSlot(packet.sections, "user");
        assert.ok(rendered.indexOf("## Log") < rendered.indexOf("## Session"), "on the wire the Session block is below the log");
        assert.doesNotMatch(rendered, /"date"|"timezone"|\d{4}-\d{2}-\d{2}T/, "no date, time or zone anywhere in the user slot");
        assert.doesNotMatch(PacketWire.renderSlot(packet.sections, "system"), /\d{4}-\d{2}-\d{2}/, "nor in the system slot");
    } finally { await db.close(); }
});
});

describe("session-capabilities", () => {
const downProvider = (): Mock => {
    const provider = new Mock({ contextWindow: 100000, responses: [] });
    provider.generate = async () => { throw new ProviderError("plurnk", "network_failure", "connection refused"); };
    return provider;
};

// {§engine-rails} A park waits for a person: approving alone, as a yolo client does, attends nothing.
for (const [label, owner] of [
    ["parks for an interactive owner", { tools: ["request_approval", "question", "mcp_input_required"], interactive: true }],
    ["concludes for an owner that approves but is not interactive", { tools: ["request_approval"], interactive: false }],
    ["concludes for the runtime owner", null],
] as const) {
    const parks = owner?.interactive === true;
    test(`{§session-ownership}: exhausted provider recovery ${label}`, async () => {
        await using db = await openMigrated();
        const workspaceId = await insertWorkspace(db, `recovery-${label.split(" ").at(-1)}-${owner === null ? "runtime" : owner.interactive}`);
        const sessionId = await insertSession(db, workspaceId);
        if (owner !== null) await ownSession(db, workspaceId, sessionId, [...owner.tools], owner.interactive);
        const loopId = await insertLoop(db, sessionId, 1, "go");
        const notices: string[] = [];
        const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_sid, { notice }) => {
            if (notice.source === "engine:provider" && notice.level === "error") notices.push(notice.message ?? "");
        } });
        const run = await engine.runLoop({ workspaceId, sessionId, loopId, provider: downProvider(), messages: [], maxTurns: 2 });
        const lifecycle = new LoopLifecycle(db);
        assert.equal(run.reason, "provider_unavailable");
        if (parks) {
            assert.equal(run.result.status, 202);
            assert.equal(await lifecycle.status(loopId), 202);
            assert.equal(await lifecycle.result(loopId), null);
            assert.match(notices.at(-1)!, /parked and resumes on the next prompt or wake/);
        } else {
            assert.equal(run.result.status, 503);
            assert.equal(run.result.problem?.type, "https://problems.plurnk.xyz/provider/plurnk/network-failure");
            assert.equal(run.result.problem?.detail, "connection refused");
            assert.equal((await lifecycle.result(loopId))?.status, 503);
            assert.match(notices.at(-1)!, /nobody attends the session's owner, so the loop ends here/);
        }
    });
}

test("{§session-ownership}: a delegated child inherits its owner's attendance, so exhausted recovery concludes when nobody attends", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "recovery-delegated");
    const parentId = await insertSession(db, workspaceId);
    await ownSession(db, workspaceId, parentId, ["request_approval"], false);
    const childId = await insertSession(db, workspaceId, parentId, "child", "model");
    const loopId = await insertLoop(db, childId, 1, "delegated task");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const run = await engine.runLoop({ workspaceId, sessionId: childId, loopId, provider: downProvider(), messages: [], maxTurns: 2 });
    assert.equal(run.reason, "provider_unavailable");
    assert.equal(run.result.status, 503, "the child concludes on the provider's exact failure instead of parking for nobody");
    assert.equal((await new LoopLifecycle(db).result(loopId))?.status, 503);
});

test("{§session-ownership}: unsupported requests fail without parking; supported requests wait for their recipient", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "interaction-capabilities");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    const turnId = await insertTurn(db, loopId, 1);
    const ids = { workspaceId, sessionId, loopId, turnId };
    const interactions = new ClientInteractions(db);
    const request = { toolName: "question" as const, mode: "form" as const, message: "Answer?", requestedSchema: { type: "object" } };
    await assert.rejects(interactions.request(request, ids), (error: unknown) => {
        const result = (error as { result: { status: number; problem: { detail: string } } }).result;
        assert.equal(result.status, 501);
        assert.equal(result.problem.detail, "No recipient implements 'question' for this session.");
        return true;
    });
    assert.deepEqual(await interactions.list(workspaceId), []);
    await ownSession(db, workspaceId, sessionId, ["question"], false);
    await assert.rejects(interactions.request(request, ids), (error: unknown) => {
        assert.equal((error as { result: { status: number } }).result.status, 501, "a declared tool with nobody attending is no recipient");
        return true;
    });
    await ownSession(db, workspaceId, sessionId, ["question"]);
    const response = interactions.request(request, ids);
    const [pending] = await waitForDb(() => interactions.list(workspaceId), (items) => items.length === 1);
    assert.equal(pending.recipient, TEST_OWNER);
    await assert.rejects(interactions.resolve(pending.interactionId, { action: "accept", content: {} }, { workspaceId, address: "test://other" }), /Only the interaction's recipient/);
    assert.equal((await interactions.list(workspaceId)).length, 1);
    await interactions.resolve(pending.interactionId, { action: "accept", content: { answer: "main" } }, { workspaceId, address: TEST_OWNER });
    assert.deepEqual(await response, { action: "accept", content: { answer: "main" } });
    assert.deepEqual(await interactions.list(workspaceId), []);
});

test("{§session-ownership}: parking requires either an obligation or an interactive owner", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "park-waker");
    const sessionId = await insertSession(db, workspaceId);
    const lifecycle = new LoopLifecycle(db);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    await assert.rejects(lifecycle.park(loopId, { wakenBy: null }), /cannot park without a waker or an interactive owner/);
    assert.notEqual(await lifecycle.status(loopId), 202);
    assert.equal(await lifecycle.park(loopId, { wakenBy: "obligations" }), true);
    await ownSession(db, workspaceId, sessionId, ["request_approval"], false);
    const approving = await insertLoop(db, sessionId, 3, "go");
    await assert.rejects(lifecycle.park(approving, { wakenBy: null }), /cannot park without a waker or an interactive owner/, "approval alone attends nothing");
    await ownSession(db, workspaceId, sessionId);
    const owned = await insertLoop(db, sessionId, 2, "go");
    assert.equal(await lifecycle.park(owned, { wakenBy: null }), true);
});

test("{§question-tool}: the workspace layers carry no owner ring; ownership shapes only what an asking session is offered", async () => {
    await using db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "capability-rings");
    const sessionId = await insertSession(db, workspaceId);
    assert.deepEqual((await CapabilityPolicies.layers(db, workspaceId)).map(({ scope }) => scope), ["service", "workspace"]);
    await ownSession(db, workspaceId, sessionId);
    assert.deepEqual((await CapabilityPolicies.layers(db, workspaceId)).map(({ scope }) => scope), ["service", "workspace"]);
});
});

describe("stream-timing", () => {
test("{§child-orientation}: a quiet stream's packet reports elapsed runtime and output inactivity", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "stream-timing");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, scheme: "sh", authority: "", pathname: "/1234abcd",
            channel: "stdout", content: "", mimetype: "text/stream", state: "active",
        });
        const subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId, entryId, scheme: "sh", handle: "quiet-command",
        });
        const row = await db.test_stream_opened_at.get<{ opened_at: string }>({ id: subscriptionId });
        assert.ok(row);
        t.mock.method(Date, "now", () => Date.parse(row.opened_at) + 125_500);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const build = () => packets.buildRequestPacket({
            initialMessages: [], workspaceId, sessionId, loopId, currentTurnSeq: 1,
            provider: reasoningProvider(), gitStatus: null,
        });
        const first = await build();
        assert.deepEqual(JSON.parse(first.sections.find(({ name }) => name === "work")!.content), {
            sessions: [],
            streams: [{
                status: "active", path: "sh:///1234abcd",
                detail: "elapsed 125s; output unchanged 125s; stdout 0 lines (+0 bytes)",
            }],
            messages: [],
        });
        await packets.recordObservations(first);
        const second = await build();
        assert.equal(second.sections.find(({ name }) => name === "work")!.content,
            first.sections.find(({ name }) => name === "work")!.content,
            "observing an empty stream does not reset its inactivity");
        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        const terminal = await build();
        assert.deepEqual(JSON.parse(terminal.sections.find(({ name }) => name === "work")!.content),
            { sessions: [], streams: [], messages: [] }, "closed streams leave the active inventory");
    } finally { await db.close(); }
});

test("{§child-orientation}: only changes to published output reset the durable stream clock", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "stream-clock-writes");
        const sessionId = await insertSession(db, workspaceId);
        const pathname = "/abcd1234";
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, scheme: "sh", authority: "", pathname,
            channel: "stdout", content: "alpha", mimetype: "text/stream", state: "active",
        });
        for (const name of ["stderr", "internal"]) await db.test_seed_channel.run({
            entry_id: entryId, name, content: "", mimetype: "text/stream", state: "active",
        });
        let subscriptionId = await ChannelWrite.openSubscription(db, {
            sessionId, entryId, scheme: "sh", handle: "fixture", publishedChannel: "stdout",
        });
        const channels = new DbChannelCaps(makeSchemeCtx({ db, workspaceId, sessionId }), "sh", "");
        const executors = await testExecutors();
        const schemes = new SchemeRegistry();
        schemes.registerRuntimeSchemes(executors);
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        engine.setExecutors(executors);
        const original = "2026-01-01T00:00:00.000Z";
        const clock = () => db.test_stream_clock.get<{ opened_at: string; output_changed_at: string | null }>({ id: subscriptionId });
        const rebase = () => db.test_stream_set_clock.run({
            id: subscriptionId, opened_at: original, output_changed_at: original,
        });
        for (const specimen of [
            { name: "unpublished stderr", changed: false, write: () => channels.append(pathname, "stderr", "hidden") },
            { name: "mimetype", changed: false, write: () => db.set_channel_mimetype.run({ entry_id: entryId, channel: "stdout", mimetype: "text/plain" }) },
            { name: "state closure", changed: false, write: () => channels.setState(pathname, "stdout", "closed") },
            { name: "state reopening", changed: false, write: () => channels.setState(pathname, "stdout", "active") },
            { name: "empty append", changed: false, write: () => channels.append(pathname, "stdout", "") },
            { name: "identical replacement", changed: false, write: () => channels.replace(pathname, "stdout", "alpha") },
            { name: "equal-sized replacement", changed: true, write: () => channels.replace(pathname, "stdout", "bravo") },
            { name: "clearing content", changed: true, write: () => channels.replace(pathname, "stdout", "") },
            { name: "empty-to-empty replacement", changed: false, write: () => channels.replace(pathname, "stdout", "") },
            { name: "executor append", changed: true, write: () => ChannelWrite.appendToChannel(db, { entryId, producerSessionId: sessionId, channel: "stdout", chunk: "visible\n" }) },
            { name: "ordinary stream READ", changed: false, write: () => clientRead(engine, db, { workspaceId, sessionId, statement: readStmt(urlPath("sh", pathname, "stdout"), { marks: [1, -1] }) }) },
        ]) await t.test(specimen.name, async () => {
            await rebase();
            const result = await specimen.write();
            if (result !== undefined && "status" in result) assert.equal(result.status, 200, specimen.name);
            const after = await clock();
            assert.equal(after?.opened_at, original, "activity never restarts elapsed runtime");
            if (specimen.changed) assert.ok(after?.output_changed_at !== null && after.output_changed_at > original,
                `${specimen.name} advances the output clock`);
            else assert.equal(after?.output_changed_at, original, `${specimen.name} is not output activity`);
        });

        await rebase();
        await assert.rejects(db.replace_channel_content.all({
            entry_id: entryId, channel: "stdout", content: "rejected", weight: -1,
        }), /CHECK constraint failed/u);
        assert.equal((await clock())?.output_changed_at, original, "a rejected content write cannot advance the clock");
        assert.equal((await db.test_get_channel.get<{ content: string }>({ entry_id: entryId, name: "stdout" }))?.content,
            "visible\n", "content and the clock roll back together");

        await ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        await channels.append(pathname, "stdout", "after close");
        assert.equal((await clock())?.output_changed_at, original, "a closed subscription's clock is settled");
        subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sh", handle: "all-channels" });
        await rebase();
        await channels.append(pathname, "stderr", "published\n");
        assert.ok((await clock())!.output_changed_at! > original, "another published channel also resets the one stream clock");
    } finally { await db.close(); }
});

test("{§child-orientation}: packet durations advance independently, clamp clock rollback, and retain unknown evidence", async (t) => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "stream-clock-packets");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const entryId = await seedEntryWithChannel(db, {
            workspaceId, scheme: "sh", authority: "", pathname: "/1234abcd",
            channel: "stdout", content: "ready\n", mimetype: "text/stream", state: "active",
        });
        await db.test_seed_channel.run({ entry_id: entryId, name: "stderr", content: "", mimetype: "text/stream", state: "active" });
        const subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "sh", handle: "fixture" });
        const openedAt = "2026-01-01T00:00:00.000Z";
        const changedAt = "2026-01-01T00:01:40.000Z";
        await db.test_stream_set_clock.run({ id: subscriptionId, opened_at: openedAt, output_changed_at: changedAt });
        let now = Date.parse(openedAt) + 300_900;
        t.mock.method(Date, "now", () => now);
        const packets = new PacketBuilder({ db, schemes: new SchemeRegistry(), executors: () => undefined });
        const build = () => packets.buildRequestPacket({
            initialMessages: [], workspaceId, sessionId, loopId, currentTurnSeq: 1, provider: reasoningProvider(), gitStatus: null,
        });
        const first = await build();
        assert.equal(JSON.parse(first.sections.find(({ name }) => name === "work")!.content).streams[0].detail,
            "elapsed 300s; output unchanged 200s; stderr 0 lines (+0 bytes); stdout 1 lines (+6 bytes)");
        await packets.recordObservations(first);
        now += 20_000;
        const next = await build();
        assert.equal(JSON.parse(next.sections.find(({ name }) => name === "work")!.content).streams[0].detail,
            "elapsed 320s; output unchanged 220s; stderr 0 lines (+0 bytes); stdout 1 lines (+0 bytes)");
        assert.equal(packetSection(next, "log"), packetSection(first, "log"),
            "volatile timing stays in the status footer, not the cacheable log prefix");
        now = Date.parse(openedAt) - 1_000;
        const backwards = await build();
        assert.match(JSON.parse(backwards.sections.find(({ name }) => name === "work")!.content).streams[0].detail,
            /^elapsed 0s; output unchanged 0s;/u);
        await db.test_stream_set_clock.run({ id: subscriptionId, opened_at: openedAt, output_changed_at: null });
        const unknown = await build();
        assert.match(JSON.parse(unknown.sections.find(({ name }) => name === "work")!.content).streams[0].detail,
            /^elapsed 0s; output timing unknown;/u);
    } finally { await db.close(); }
});
});
