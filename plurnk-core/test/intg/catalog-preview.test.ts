// PLURNK_SERVICE_FILES_ITEMS — turn-0 catalog preview foist ({§actor-boundary}). A plurnk-origin
// FIND(scheme:///*) is foisted into the model's turn 0 for folder-capable schemes: direct
// entries plus exact `dir/**` summaries. Kernel docs remain recursively enumerated. The
// first-N cap applies only to file rows; 0/unset turns the preview off.
//
// NOTE: sets a process-global env var. node --test isolates each file in its own
// process, so this doesn't leak across files; the on/off cases run sequentially.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, rpcProblem, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

type LogRow = { op: string; pathname: string; scheme: string | null; hostname: string | null; sequence: number; signal: string | null; status_rx: number; rx: string };
const mock = () => new Mock({ contextWindow: 100000, responses: [makeMockResponse("## SEND0 [200]\ndone", 50)] });

test("PLURNK_SERVICE_FILES_ITEMS foists shallow catalogs; the files cap governs only project files (none when off)", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        // ON with a cap: =2 → the catalog is foisted at turn 0 (200). The cap is FILES-only; the
        // model memory is not governed by the file cap — its ordinary first page contains all 3 entries.
        process.env.PLURNK_SERVICE_FILES_ITEMS = "2";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "manifest-on" });
                await rpcCall(ws, 2, "op.edit", { target: "worker:///a.md", content: "alpha" });
                await rpcCall(ws, 3, "op.edit", { target: "worker:///b.md", content: "bravo" });
                await rpcCall(ws, 4, "op.edit", { target: "worker:///c.md", content: "charlie" });
                const resp = await runLoopToTerminal(ws, 5, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const cf = rows.find((r) => r.op === "FIND" && r.scheme === "worker" && r.hostname === null && r.pathname === "/*");
                assert.ok(cf !== undefined, "turn 0 foists a FIND(worker:///*) catalog preview when set");
                assert.equal(cf!.status_rx, 200, "the catalog FIND returns the scheme's rows (200)");
                const parsed = JSON.parse(cf!.rx) as { content?: string; results?: unknown[] };
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
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "no catalog FIND foisted when unset");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

// The catalog is FIND-served — there is no materialized manifest entry. With the preview
// off, the worker opens with no foisted catalog; the model FINDs each scheme on demand (the
// "always a single directory to READ" invariant retired with the manifest.json entry).
test("no manifest.json entry — the catalog is FIND-served; preview-off foists no FIND", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "0"; // preview OFF
    try {
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "catalog-find-served" });
                await rpcCall(ws, 2, "op.edit", { target: "worker:///a.md", content: "alpha" });
                const resp = await runLoopToTerminal(ws, 3, { prompt: "go" });
                const { loopId } = resp as { loopId: number };
                const entry = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "worker", pathname: "/manifest.json" });
                assert.equal(entry?.id, undefined, "no manifest.json entry — the catalog is not materialized as an entry");
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                assert.equal(rows.find((r) => r.op === "FIND"), undefined, "preview off → no catalog FIND foisted; the model FINDs on demand");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

// {§operator-config-workspace-files-items} — workspace filesItems replaces the env default outright,
// both directions: it can switch the preview off when env says on, and on when off.
test("workspace.create settings.filesItems replaces the env default at turn 0", async () => {
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

// {§operator-config-workspace-files-items} — the client surface is narrow and validated.
test("workspace.create rejects malformed settings — fail hard, no silent accept", async () => {
    await withDaemon(mock(), async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const badMI = await rpcCall(ws, 1, "workspace.create", { name: "bad-mi", settings: { filesItems: 1.5 } });
            const filesProblem = rpcProblem(badMI);
            assert.equal(filesProblem.type, "https://problems.plurnk.dev/daemon/input/setting-invalid");
            assert.equal(filesProblem.field, "settings.filesItems");
            // The retired mdDocs channel is an unsupported field, not a silent accept.
            const retired = await rpcCall(ws, 2, "workspace.create", { name: "bad-alias", settings: { mdDocs: [{ alias: "x", content: "x" }] } });
            const retiredProblem = rpcProblem(retired);
            assert.equal(retiredProblem.type, "https://problems.plurnk.dev/daemon/input/setting-not-supported");
            assert.equal(retiredProblem.field, "settings.mdDocs");
        } finally { ws.close(); }
    });
});

// {§actor-boundary-catalog-preview} — turn-0 once-per-worker foists fire on the worker's first
// loop only; later loops in the same worker already carry them in the persistent log, so re-foisting
// each loop spammed the log + burned tokens. Two loops in one worker: the manifest READ is in loop 1's
// log, absent from loop 2's.
test("turn-0 once-per-worker foists fire on the worker's first loop only, not every loop", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // preview ON
    try {
        const twoLoops = new Mock({ contextWindow: 8192, responses: [makeMockResponse("## SEND0 [200]\ndone", 50), makeMockResponse("## SEND0 [200]\ndone", 50)] });
        await withDaemon(twoLoops, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "foist-once" });
                await rpcCall(ws, 2, "op.edit", { target: "worker:///a.md", content: "alpha" });
                const r1 = await runLoopToTerminal(ws, 3, { prompt: "first" });
                const r2 = await runLoopToTerminal(ws, 4, { prompt: "second" });
                const catalogFind = async (loopId: number) => {
                    const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                    return rows.find((r) => r.op === "FIND" && r.scheme === "worker" && r.hostname === null && r.pathname === "/*");
                };
                assert.ok((await catalogFind((r1 as { loopId: number }).loopId)) !== undefined, "worker's first loop foists the catalog preview");
                assert.equal(await catalogFind((r2 as { loopId: number }).loopId), undefined, "the second loop does NOT re-foist it — it's already in the worker's log");
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("the turn-0 initialization mirrors the REAL foisted survey — dynamic, not a static print", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist each ordinary first page at turn 0
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "turn0-exemplar" });
                await rpcCall(ws, 2, "op.edit", { target: "worker:///a.md", content: "alpha" });
                await rpcCall(ws, 3, "op.edit", { target: "worker:///nested/b.md", content: "bravo" });
                const resp = await runLoopToTerminal(ws, 4, { prompt: "go" });
                const { loopId, modelWorkerId } = resp as { loopId: number; modelWorkerId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const commons = rows.find((candidate) => candidate.op === "FIND" && candidate.scheme === "worker" && candidate.hostname === null && candidate.pathname === "/*");
                assert.ok(commons !== undefined);
                const map = JSON.parse((JSON.parse(commons.rx) as { content: string }).content) as Array<Array<{ path: string; items?: number; tokens?: number }>>;
                assert.deepEqual(map.map(([item]) => item.path), ["worker:///a.md", "worker:///nested/**"]);
                assert.equal(map[1]?.[0]?.items, 1, "the automatic shallow map retains the nested subtree as a complete aggregate");
                // The worker's first turn opens with the actionless initialization at 1/1/1, born OPEN.
                const row = await db.log_read_by_coordinate.get<{ op: string | null; rx: string; attrs: string }>({ worker_id: modelWorkerId, loop_seq: 1, turn_seq: 1, sequence: 1 });
                assert.equal(row?.op, null, "the turn-0 initialization does not fabricate an operation");
                assert.equal((JSON.parse(row!.attrs) as { kind?: string }).kind, "initialization");
                const content = (JSON.parse(row!.rx) as { content: string }).content;
                // Dynamic - it carries the FIND the foist ACTUALLY dispatched (worker:///*), rendered to
                // DSL and framed PLAN → SEND. Not a frozen print: feed-as-turn-0, show-in-turn-1 are one act.
                assert.match(
                    content,
                    /^# PLAN0\n\* Discover the tooling available and survey the workspace file root\./,
                    "opens with the concrete orientation work",
                );
                assert.match(content, /## FIND0 \[\+init\] \(worker:\/\/\/\*\) <!-- workspace entries -->/, "the classified markerless shallow survey is rendered back to DSL with its annotation");
                assert.doesNotMatch(content, /## FIND0 \[\+init\] \(worker:\/\/\/\*\) <!-- workspace entries --> </, "the ordinary survey does not teach an explicit all-results scope");
                assert.match(
                    content,
                    /## SEND0 \[102\]\nNext: Address the prompt\.$/,
                    "closes by stating the next action",
                );
            } finally { ws.close(); }
        });
    } finally {
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("an empty workspace executes all six orienting FINDs and preserves empty-surface results", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    try {
        process.env.PLURNK_SERVICE_FILES_ITEMS = "2";
        await withDaemon(mock(), async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "empty-ws-find" }); // headless: zero tracked files
                const resp = await runLoopToTerminal(ws, 2, { prompt: "go" });
                const { loopId, modelWorkerId } = resp as { loopId: number; modelWorkerId: number };
                const rows = await db.test_log_entries_by_loop.all<LogRow>({ loop_id: loopId });
                const finds = rows.filter((r) => r.op === "FIND");
                assert.deepEqual(finds.map(({ scheme, hostname, pathname }) => ({ scheme, hostname, pathname })), [
                    { scheme: "worker", hostname: "plurnk", pathname: "/skills/*.md" },
                    { scheme: "worker", hostname: "plurnk", pathname: "/skills/plurnk/*.md" },
                    { scheme: "worker", hostname: "plurnk", pathname: "/tools/**" },
                    { scheme: null, hostname: null, pathname: "*" },
                    { scheme: "worker", hostname: null, pathname: "/*" },
                    { scheme: "worker", hostname: "~", pathname: "/*" },
                ], "the six surveys execute in their taught order");
                assert.deepEqual(finds.map(({ signal }) => JSON.parse(signal ?? "null")), [
                    ["+init", "+skills"], ["+init", "+skills"], ["+init", "+skills"], ["+init"], ["+init"], ["+init"],
                ]);
                const orientations = [
                    ["project files", finds.find((r) => r.scheme === null && r.pathname === "*"), true, 200],
                    ["workspace commons", finds.find((r) => r.scheme === "worker" && r.hostname === null && r.pathname === "/*"), true, 200],
                    ["own space", finds.find((r) => r.scheme === "worker" && r.hostname === "~" && r.pathname === "/*"), true, 200],
                    ["skills", finds.find((r) => r.scheme === "worker" && r.hostname === "plurnk" && r.pathname === "/skills/*.md"), true, 204],
                    ["attached tools", finds.find((r) => r.scheme === "worker" && r.hostname === "plurnk" && r.pathname === "/tools/**"), true, 200],
                    ["plurnk skills", finds.find((r) => r.scheme === "worker" && r.hostname === "plurnk" && r.pathname === "/skills/plurnk/*.md"), false, 200],
                ] as const;
                for (const [name, row, expectEmpty, expectStatus] of orientations) {
                    assert.ok(row !== undefined, `${name} FIND executes even when empty`);
                    assert.equal(row.status_rx, expectStatus, `${name} empty FIND is a ${expectStatus === 204 ? "zero-match" : "successful"} survey`);
                    const result = JSON.parse(row.rx) as { content?: string; results?: unknown[] };
                    const items = result.results ?? (result.content !== undefined ? JSON.parse(result.content) as unknown[] : []);
                    if (expectEmpty) assert.deepEqual(items, [], `${name} preserves the informative zero-result response`);
                }
                const toolSurvey = finds.find((r) => r.pathname === "/skills/plurnk/*.md");
                const toolResult = JSON.parse(toolSurvey!.rx) as { content?: string; results?: unknown[] };
                const toolItems = (toolResult.results
                    ?? (toolResult.content === undefined ? [] : JSON.parse(toolResult.content) as unknown[])) as Array<Array<{ path: string; summary?: string }>>;
                const shell = toolItems.flat().find(({ path }) => path === "worker://plurnk/skills/plurnk/sh.md");
                assert.equal(shell?.summary, "Run POSIX shell commands and scripts.", "Turn 0 carries the family summary without its invocation body");
                const shellSample = rows.find((row) => row.op === "READ" && row.scheme === "worker" && row.hostname === "plurnk" && row.pathname === "/skills/plurnk/sh.md");
                assert.equal(shellSample?.status_rx, 200, "Turn 0 pulls the enabled sh family as its one worked tool-document example");
                const shellContent = (JSON.parse(shellSample!.rx) as { content: string }).content;
                assert.equal(shellContent.split("\n").length, 17, "the worked sample stops after the complete invocation example");
                assert.match(shellContent, /```plurnk\n## EXEC0 \[sh\] <!-- Run POSIX shell commands and scripts\. -->\npwd\n```$/);
                assert.doesNotMatch(shellContent, /A shell command line/, "the deep shell reference stays pull-only");
                const exemplar = await db.log_read_by_coordinate.get<{ rx: string }>({ worker_id: modelWorkerId, loop_seq: 1, turn_seq: 1, sequence: 1 });
                const content = (JSON.parse(exemplar!.rx) as { content: string }).content;
                assert.equal(content, `# PLAN0
* Discover the tooling available and survey the workspace file root.

## READ0 [+init,+skills] (worker://plurnk/skills/plurnk/sh.md) <1,17>
## FIND0 [+init,+skills] (worker://plurnk/skills/*.md) <1,-1>
//heading[text()="Example"]
## FIND0 [+init,+skills] (worker://plurnk/skills/plurnk/*.md) <1,-1>
//heading[text()="Example"]
## FIND0 [+init,+skills] (worker://plurnk/tools/**) <1,-1> <!-- attached tools -->
## FIND0 [+init] (*) <!-- workspace files -->
## FIND0 [+init] (worker:///*) <!-- workspace entries -->
## FIND0 [+init] (worker://~/*) <!-- worker entries -->

## SEND0 [102]
Next: Address the prompt.`);
                const logTags = await db.test_log_tags_by_worker.all<{ coordinate: string; tag: string }>({ worker_id: modelWorkerId });
                const tagsBySequence = new Map<number, string[]>();
                for (const { sequence } of finds) tagsBySequence.set(sequence, []);
                for (const { coordinate, tag } of logTags) {
                    const sequence = Number(coordinate.split("/")[2]);
                    tagsBySequence.get(sequence)?.push(tag);
                }
                assert.deepEqual(finds.map(({ sequence }) => tagsBySequence.get(sequence)), [
                    ["init", "skills"], ["init", "skills"], ["init", "skills"], ["init"], ["init"], ["init"],
                ], "each FIND classifies its own durable log item; the skills surveys retain the shared init set");
                const shellTags = logTags.filter(({ coordinate }) => Number(coordinate.split("/")[2]) === shellSample?.sequence).map(({ tag }) => tag);
                assert.deepEqual(shellTags, ["init", "skills"], "the worked tool-document READ belongs to the same init/skills set");
            } finally { ws.close(); }
        });
    } finally { if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev; }
});
