import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Daemon from "../../src/server/Daemon.ts";
import SessionName from "../../src/core/SessionName.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
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
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel } from "./_db.ts";
import { Mock, chatMessageText, ProviderError } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, waitForDb, rpcProblem, subscribeNotifications, waitFor } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors, userText } from "./_mock.ts";
import { urlPath, readStmt } from "./_dsl.ts";
import { packetSection } from "./_packet.ts";
import { PlurnkParser, parsePath } from "@plurnk/plurnk-parser";
import { DEFAULT_MIMETYPES, makeSchemeCtx } from "./_scheme.ts";
import { Shell } from "@plurnk/plurnk-execs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { serveMcpHttp } from "../../../plurnk-mcp/test/http-fixture.ts";
import { httpEntry, mcpFixture } from "./_mcp-config.ts";
import { resourcePath } from "../../../plurnk-mcp/src/McpResources.ts";
import { provider as reasoningProvider, statement as reasoningStatement } from "./reasoning-fixture.ts";
import { clientRead } from "./_client-read.ts";
import { testExecutors } from "./_execs.ts";


describe("catalog-preview", () => {
// PLURNK_SERVICE_FILES_ITEMS — turn-0 catalog preview foist ({§actor-boundary}). A plurnk-origin
// FIND(scheme:///*) is foisted into the model's turn 0 for folder-capable schemes: direct
// entries plus exact `dir/**` summaries. Kernel docs remain recursively enumerated. The
// first-N cap applies only to file rows; 0/unset turns the preview off.
//
// NOTE: sets a process-global env var. node --test isolates each file in its own
// process, so this doesn't leak across files; the on/off cases run sequentially.










type LogRow = { op: string | null; pathname: string; scheme: string | null; hostname: string | null; sequence: number; turn_id: number; signal: string | null; status_rx: number; tx: string; rx: string; attrs: string; folded: string; origin: string };
const mock = () => new Mock({ contextWindow: 100000, responses: [makeMockResponse("await plurnk.done({\"text\":\"done\"});", 50)] });

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
                const cf = rows.find((r) => r.op === "find" && r.scheme === "workspace" && r.hostname === null && r.pathname === "/*");
                assert.ok(cf !== undefined, "turn 0 foists a FIND(workspace:///*) catalog preview when set");
                assert.equal(cf.status_rx, 200, "the catalog FIND returns the scheme's rows (200)");
                const parsed = JSON.parse(cf.rx) as { content?: string; results?: unknown[] };
                const items = parsed.results ?? (parsed.content !== undefined ? JSON.parse(parsed.content) as unknown[] : []);
                assert.equal(items.length, 3, "the project-file cap does not govern the model's own memory map");
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
                assert.equal(rows.find((r) => r.op === "find"), undefined, "no catalog FIND foisted when unset");
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
                assert.equal(rows.find((r) => r.op === "find"), undefined, "preview off → no catalog FIND foisted; the model FINDs on demand");
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
                assert.equal(rows.find((r) => r.op === "find"), undefined, "workspace filesItems:0 replaces env -1 — no catalog FIND foisted");
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
                const cf = rows.find((r) => r.op === "find" && r.status_rx === 200);
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
        const twoLoops = new Mock({ contextWindow: 8192, responses: [makeMockResponse("await plurnk.done({\"text\":\"done\"});", 50), makeMockResponse("await plurnk.done({\"text\":\"done\"});", 50)] });
        await withDaemon(twoLoops, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "foist-once" });
                await rpcCall(ws, 2, "op.edit", { target: "workspace:///a.md", content: "alpha" });
                const r1 = await runLoopToTerminal(ws, 3, { prompt: "first" });
                const r2 = await runLoopToTerminal(ws, 4, { prompt: "second" });
                const catalogFind = async (loopId: number) => {
                    const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                    return rows.find((r) => r.op === "find" && r.scheme === "workspace" && r.hostname === null && r.pathname === "/*");
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
                const commons = rows.find((candidate) => candidate.op === "find" && candidate.scheme === "workspace" && candidate.hostname === null && candidate.pathname === "/*");
                assert.ok(commons !== undefined);
                const map = JSON.parse((JSON.parse(commons.rx) as { content: string }).content) as Array<Array<{ path: string; items?: number; tokens?: number }>>;
                assert.deepEqual(map.map(([item]) => item.path), ["workspace:///a.md", "workspace:///nested/**"]);
                assert.equal(map.find(([item]) => item.path === "workspace:///nested/**")?.[0]?.items, 1,
                    "the automatic shallow map retains the nested subtree as a complete aggregate");
                const initializationRows = rows.filter((row) => row.turn_id === commons.turn_id);
                assert.equal(initializationRows.filter(LogEntryProjection.isEmission).length, 1,
                    "`_plurnk` initialization announces its ops:// emission ({§turn-source-resources})");
                const surveyRows = initializationRows.filter((row) => !LogEntryProjection.isEmission(row));
                const ops = surveyRows.map(({ op }) => op);
                assert.equal(ops.at(-1), "note", "initialization closes with a single plan NOTE");
                assert.ok(ops.length > 1 && ops.slice(0, -1).every((op) => op === "find" || op === "plurnk" || op === "read"),
                    "before the closing NOTE only the environment surveys: no opening NOTE, no READ of its own program, no reasoning demonstration");
                for (const row of surveyRows.filter(({ op }) => op === "find")) {
                    const result = JSON.parse(row.rx) as { content?: string; results?: unknown[] };
                    const items = result.results ?? (result.content === undefined ? [] : JSON.parse(result.content) as unknown[]);
                    if (row.scheme === "session") {
                        assert.equal(row.status_rx, 200, "the session scratch survey runs even when empty so the session sees its namespace");
                        assert.equal(items.length, 0);
                    } else {
                        assert.ok(items.length > 0, `the ${row.scheme ?? "file"}:${row.pathname} survey runs because it selects something`);
                    }
                }
                const turn = await db.test_get_turn.get<{ producer: string; kind: string; status: number; completed_at: string | null }>({ id: commons.turn_id });
                assert.deepEqual(
                    { producer: turn?.producer, kind: turn?.kind, status: turn?.status },
                    { producer: "_plurnk", kind: "initialization", status: 200 },
                );
                assert.ok(turn?.completed_at !== null, "a completed continuation turn is distinct from an open turn");
                assert.equal(initializationRows.some(({ scheme }) => scheme === "reasoning"), false, "initialization neither reads nor surveys reasoning ({§session-initialization-entry})");
                const program = (await db.test_turn_sources_by_turn.all<{ kind: string; content: string }>({ turn_id: commons.turn_id })).find(({ kind }) => kind === "ops");
                assert.ok(program, "the survey is the initialization turn's ops source");
                assert.deepEqual(provider.received[0].filter(({ role }) => role === "assistant"), [{ role: "assistant", content: program.content }],
                    "the initialization program replays as the opening assistant turn in emission-history ({§emission-history})");
                assert.deepEqual(
                    PlurnkParser.parseStatements(program.content, { executors: ["plurnk"] }).items.flatMap((item) =>
                        item.kind === "statement" ? ["runtime" in item.statement ? item.statement.runtime : item.statement.op] : []),
                    surveyRows.map(({ op }) => op),
                    "{§fence-pairing}: every operation is separated by a blank line and has exactly one ordinary receipt",
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
        await withDaemon(mock(), async (db, daemon, addr) => {
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: "empty-ws-find" }); // headless: zero tracked files
                const workspaceId = (created.result as { id: number }).id;
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId, modelSessionId } = resp as { loopId: number; modelSessionId: number };
                const sessionName = await SessionName.forId(db, modelSessionId);
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const finds = rows.filter((r) => r.op === "find");
                // Nothing is in it: no project files, workspace entries, agents or members definitions, and the session is new.
                assert.deepEqual(finds.map(({ scheme, hostname, pathname }) => ({ scheme, hostname, pathname })), [
                    { scheme: "skill", hostname: "*", pathname: "/SKILL.md" },
                    { scheme: "skill", hostname: "plurnk", pathname: "/*.md" },
                    { scheme: "mcp", hostname: null, pathname: "/*.md" },
                    { scheme: "session", hostname: sessionName, pathname: "/*" },
                ], "the surveys that select something and the session scratch survey run, in their taught order; the other empty surfaces are left out ({§session-initialization-entry})");
                assert.deepEqual(
                    finds.map(({ tx }) => (JSON.parse(tx) as { aside: string | null }).aside),
                    [null, "Plurnk", null, "session knowledgebase entries"],
                    "asides name what each namespace is",
                );
                for (const row of finds) {
                    const result = JSON.parse(row.rx) as { content?: string; results?: unknown[] };
                    const items = result.results ?? (result.content !== undefined ? JSON.parse(result.content) as unknown[] : []);
                    if (row.scheme === "session") {
                        assert.equal(row.status_rx, 200, "the empty session scratch survey runs to orient the session to its own namespace");
                        assert.equal(items.length, 0);
                    } else {
                        assert.equal(row.status_rx, 200, `${row.scheme}:${row.pathname} has its catalog contract status`);
                        assert.ok(items.length > 0, `${row.scheme}:${row.pathname} selected something`);
                    }
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
                const harnessSurvey = finds.find((r) => r.hostname === "plurnk" && r.pathname === "/*.md");
                assert.ok(harnessSurvey !== undefined && harnessSurvey.status_rx === 200, "Turn 0 surveys skill://plurnk/*.md");
                const harnessItems = ((JSON.parse(harnessSurvey.rx) as { results?: unknown[]; content?: string }).results
                    ?? JSON.parse((JSON.parse(harnessSurvey.rx) as { content: string }).content)) as Array<Array<{ path: string; aside?: string }>>;
                assert.equal(harnessItems.length, 11, "all 11 Plurnk Harness markdown references are cataloged");
                assert.ok(harnessItems.flat().every(({ aside }) => Boolean(aside)), "every Plurnk Harness chapter arrives with its 1-line summary aside");
                const patternItem = harnessItems.flat().find(({ path }) => path === "skill://plurnk/pattern.md");
                assert.match(patternItem?.aside ?? "", /regex \(\/re\/im\).*XPath \(\/\/fn\[name='x'\]\).*JSONPath \(\$\.a\.b\).*symbol \(&Foo/u, "pattern.md summary aside carries the pattern dialect syntax tokens");
                const plurnkRead = rows.find((row) => row.op === "read" && row.scheme === "mcp" && row.hostname === null && row.pathname === "/plurnk.md");
                assert.ok(plurnkRead !== undefined && plurnkRead.status_rx === 200, "Turn 0 introspects mcp:///plurnk.md");
                const plurnkContent = (JSON.parse(plurnkRead.rx) as { content: string }).content;
                assert.ok(
                    plurnkContent.includes(`plurnk.sh({"text":"git status --short"}) // ${Shell.summary(Shell.current())}`),
                    "Turn 0 teaches a compact executable witness with its aside naming the shell that runs ({§executor-subprocess}), as plain text rather than a code span",
                );
                assert.match(
                    plurnkContent,
                    /plurnk\.python3\(\{"text":"print\(42\)"\}\) \/\/ Run Python 3 code or scripts in the workspace with python3(?: \(v\d+(?:\.\d+)+\))?\./u,
                    "the interpreter aside teaches an executable inline program without requiring a document READ",
                );
                const editSchemaRead = rows.find((row) => row.op === "read" && row.scheme === "mcp" && row.hostname === null && row.pathname === "/plurnk/edit.json");
                assert.ok(editSchemaRead !== undefined && editSchemaRead.status_rx === 200, "Turn 0 reads mcp:///plurnk/edit.json");
                for (const name of ["https", "recipes", "session", "wss"]) {
                    const [reference] = await daemon.dispatchClientAction({
                        workspaceId,
                        actor: TEST_OWNER,
                        statements: [readStmt(parsePath(`skill://plurnk/${name}.md`), { marks: [1, -1] })],
                    });
                    assert.equal(reference.status, 200);
                    assert.ok(typeof reference.content === "string" && reference.content.trim().length > 0,
                        `${name} reference is readable under skill://plurnk/`);
                }
                const shellSample = rows.find((row) => row.op === "read" && row.scheme === "mcp" && row.hostname === null && row.pathname === "/plurnk/sh.json");
                assert.equal(shellSample, undefined, "Turn 0 does not privilege the shell schema with an automatic READ");
                const initializationTurnId = finds[0].turn_id;
                const initializationRows = rows.filter((row) => row.turn_id === initializationTurnId);
                assert.equal(initializationRows.filter(LogEntryProjection.isEmission).length, 1,
                    "turn 0 announces its ops:// emission ({§turn-source-resources})");
                assert.deepEqual(
                    initializationRows.filter((row) => row.op !== null && !LogEntryProjection.isEmission(row)).map(({ op }) => op),
                    ["find", "find", "find", "read", "read", "find", "note"],
                    "initialization contains the surveys, its closing plan NOTE, and nothing else",
                );
            } finally { ws.close(); }
        });
    } finally { if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev; }
});
});


describe("inject-fold-posture", () => {
// {§methods-workspace-create} — folded prompts preserve durable loop configuration.





const heldLoopMock = () => new Mock({ contextWindow: 16384, responses: [
    // A non-auto execution proposal holds loop 1 live (paused at the review) while injects arrive.
    makeMockResponse("await plurnk.sh({\"command\":\"echo hold\"});\n\nawait plurnk.note({\"text\":\"working\"});", 10),
    makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
    makeMockResponse("await plurnk.done({\"text\":\"done again\"});", 10),
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
            makeMockResponse("await plurnk.sh({\"command\":\"sleep 30\"});\n\nawait plurnk.wait({\"text\":\"park\"});", 10),
            makeMockResponse("await plurnk.done({\"text\":\"done\"});", 10),
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
        test(`{§session-initialization-entry}: an AGENTS.local.md ${standing}${withAgents ? " beside AGENTS.md" : ""} is ${projected ? "delivered in system-policy" : "not projected"}`, async () => {
            const prior = Object.fromEntries(["PLURNK_SERVICE_GIT_ALLOWED", "PLURNK_SERVICE_GIT_AUTO", "PLURNK_MEMBERS_ENABLED", "PLURNK_MEMBERS_no_local"]
                .map((key) => [key, process.env[key]]));
            process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
            process.env.PLURNK_SERVICE_GIT_AUTO = "1";
            process.env.PLURNK_MEMBERS_ENABLED = "1";
            // An operator exclusion ({§tools-resource-materialization}).
            if (standing === "excluded") process.env.PLURNK_MEMBERS_no_local = "!**/AGENTS.local.md";
            const dir = await mkdtemp(join(tmpdir(), "plurnk-local-instructions-"));
            try {
                await execFileP("git", ["init", "-q"], { cwd: dir, env: hermeticGitEnv() });
                if (standing === "ignored") await writeFile(join(dir, ".gitignore"), "AGENTS.local.md\n", "utf8");
                if (withAgents) await writeFile(join(dir, "AGENTS.md"), "# Project\nShared rules.\n", "utf8");
                if (standing !== "absent") await writeFile(join(dir, "AGENTS.local.md"), LOCAL, "utf8");
                if (standing === "tracked") await execFileP("git", ["add", "AGENTS.local.md"], { cwd: dir, env: hermeticGitEnv() });
                await mkdir(join(dir, "packages", "web"), { recursive: true });
                if (standing !== "absent") {
                    await writeFile(join(dir, "packages", "web", "AGENTS.local.md"), "# Nested\n", "utf8");
                }
                const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("await plurnk.done({\"text\":\"done\"});", 50)] });
                await withDaemon(mock, async (db, _daemon, addr) => {
                    const ws = await connect(addr);
                    try {
                        const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: "local-instructions", projectRoot: dir })).result as { id: number }).id;
                        const { loopId, modelSessionId, finalStatus } = (await runLoopToTerminal(ws, 2, { prompt: "go" })) as { loopId: number; modelSessionId: number; finalStatus: number };
                        assert.equal(finalStatus, 200);
                        const entry = await db.crud_find_workspace_entry.get<{ id: number }>({
                            workspace_id: workspaceId, scheme: "file", authority: "", pathname: "AGENTS.local.md",
                        });
                        assert.equal(entry !== undefined, projected, projected ? "the local file is projected" : "nothing is projected");
                        if (entry !== undefined) {
                            const body = await db.test_get_channel.get<{ content: string }>({ entry_id: entry.id, name: "body" });
                            assert.equal(body?.content, LOCAL, "the projection mirrors the file");
                        }
                        const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string | null; hostname: string | null; pathname: string; status_rx: number }>({ loop_id: loopId });
                        const reads = rows.filter((row) => row.op === "read" && row.scheme === null && row.hostname === null && /^AGENTS(\.local)?\.md$/u.test(row.pathname));
                        assert.deepEqual(reads, [], "turn 0 does not foist READs of root AGENTS(.local).md");
                        const latestPacket = await db.engine_session_latest_packet.get<{ packet: string }>({ session_id: modelSessionId });
                        assert.ok(latestPacket, "session recorded its request packet");
                        const systemText = packetSection(JSON.parse(latestPacket.packet), "system-policy");
                        if (withAgents) assert.match(systemText, /# Project\nShared rules\./u, "project AGENTS.md rides system-policy");
                        else assert.doesNotMatch(systemText, /# Project\nShared rules\./u);
                        if (projected) assert.match(systemText, new RegExp(LOCAL.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), "projected AGENTS.local.md rides system-policy");
                        else assert.doesNotMatch(systemText, new RegExp(LOCAL.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
                        const nested = await db.crud_find_workspace_entry.get<{ id: number }>({
                            workspace_id: workspaceId, scheme: "file", authority: "", pathname: "packages/web/AGENTS.local.md",
                        });
                        assert.equal(nested !== undefined, projected, "a nested AGENTS.local.md is projected at packages/web/AGENTS.local.md unless absent or excluded");
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

test("{§session-initialization-entry} {§session-scheme}: a pre-populated session://<name>/AGENTS.md rides system-policy on that session", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                makeMockResponse([
                    "await plurnk.edit({\"path\":\"session://child/AGENTS.md\",\"content\":\"# Child Role\\nFocus only on parser recovery.\"});",
                    "await plurnk.work({\"target\":\"session://child\",\"prompt\":\"Inspect the grammar.\"});",
                    "await plurnk.wait({});",
                ].join("\n\n"), 50),
                makeMockResponse("await plurnk.done({\"text\":\"Child finished.\"});", 50),
                makeMockResponse("await plurnk.done({\"text\":\"Parent finished.\"});", 50),
            ],
        });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const { id: workspaceId } = (await rpcCall(ws, 1, "workspace.create", { name: "session-agents-turn0" })).result as { id: number };
                const { finalStatus } = (await runLoopToTerminal(ws, 2, { prompt: "delegate with session instructions" })) as { finalStatus: number };
                assert.equal(finalStatus, 200);
                const childSession = await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: "child" });
                assert.ok(childSession, "child session was created");
                const childLoops = await db.test_loop_queue_by_session.all<{ id: number }>({ session_id: childSession.id });
                assert.equal(childLoops.length, 1);
                const rows = await db.test_log_entries_by_loop.all<{
                    origin: string; op: string; scheme: string; hostname: string | null; pathname: string; status_rx: number; rx: string;
                }>({ loop_id: childLoops[0].id });
                const agentsRead = rows.find((row) => row.origin === "_plurnk" && row.op === "read" && row.scheme === "session" && row.hostname === "child" && row.pathname === "/AGENTS.md");
                assert.equal(agentsRead, undefined, "child turn 0 does not foist a READ of session://child/AGENTS.md");
                const childPacket = await db.engine_session_latest_packet.get<{ packet: string }>({ session_id: childSession.id });
                assert.ok(childPacket, "child session recorded its request packet");
                const childSystemText = packetSection(JSON.parse(childPacket.packet), "system-policy");
                assert.match(childSystemText, /# Child Role\nFocus only on parser recovery\./u, "session://child/AGENTS.md rides system-policy");
                const sessionSurvey = rows.find((row) => row.origin === "_plurnk" && row.op === "find" && row.scheme === "session" && row.hostname === "child" && row.pathname === "/*");
                assert.ok(sessionSurvey, "child turn 0 still surveys session://child/*");
                assert.equal(sessionSurvey.status_rx, 200);
                assert.match(sessionSurvey.rx, /session:\/\/child\/AGENTS\.md/u);
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});
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
        "await fixture.third({});\n\nawait plurnk.wait({\"text\":\"Observe the result.\"});",
        "await plurnk.done({\"text\":\"Catalog tool result observed.\"});",
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
        const source = `await plurnk.read({"path":"${path}","range":"1,-1"});`;
        const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = parsed.items[0];
        assert.equal(item?.kind, "statement");
        if (item?.kind !== "statement") throw new Error("Expected one READ");
        return (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, statements: [item.statement] }))[0];
    };
    const toolsDocument = async (extension = "md"): Promise<string> => {
        const document = await read(`mcp:///fixture.${extension}`);
        assert.equal(document.status, 200);
        assert.equal(typeof document.content, "string");
        return document.content as string;
    };
    // {§mcp-configuration} The first read makes the workspace resident.
    assert.match(await toolsDocument(), /fixture\.first\(\{\}\)/);
    // {§executor-discovery} The catalog shares the same refresh and withdrawal boundary.
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
    assert.match(document, /fixture\.third\(\{\}\)/);
    assert.doesNotMatch(document, /fixture\.(?:first|second)\(\{\}\)/);
    assert.deepEqual(await names(), ["third"]);
    assert.equal((await read("mcp:///fixture/first.json")).status, 404,
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
        assert.equal((await read(`mcp:///${path}`)).status, 404,
            `disabled tools leave no generated resource: ${path}`);
    }
};

for (const boundary of boundaries) {
    test(`{§mcp-setup} ${boundary} preserves the current tools, docs, and next model call`,
        { timeout: 15000 }, (t) => verifyRefresh(t, boundary));
}
});

describe("mcp-subscription-composition", () => {
process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
process.env.PLURNK_SERVICE_WORKSPACE_WARM_MS = "60000";

const step = (op = "note") => `await plurnk.${op.toLowerCase()}(${JSON.stringify({ text: op === "note" ? "Inspect the result." : "Resource inspected." })});`;
const read = (uri: string) => `await plurnk.read({"path":"fixture://${resourcePath(uri)}","range":"1,-1"});`;

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
        `${read(alpha)}\n\n${read(beta)}\n\n${step("note")}`,
        step("done"),
        step("done"),
        `${read(alpha)}\n\n${step("note")}`,
        step("done"),
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
            `await plurnk.read({"path":"reasoning://alice/1/2","range":"1,-1"});\n\nawait plurnk.send({"text":"Ready."});`);
        const ran = await engine.runTurn({ ...context, provider: mock, messages: [] });
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: ran.turnId });
        assert.equal(turn?.sequence, 2);
        const user = userText(mock.received.at(-1)!);
        assert.match(user, /## Session\n\{"path":"session:\/\/alice","parent":null,"loop":1,"turn":2,"owner":\{"address":"[^"]+","interactive":(?:true|false)\}\}/, "the packet the model answered named turn 1/2 and its owner in its Session block");
        assert.ok(user.indexOf("## Log") < user.indexOf("## Session"), "below the log");
        const own = await clientRead(engine, db, { ...context, statement: reasoningStatement("await plurnk.read({\"path\":\"reasoning://alice/1/2\",\"range\":\"1,-1\"});") });
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

