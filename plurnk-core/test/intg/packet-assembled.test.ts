// Assembled-packet regression coverage — the backbone the invisible-catalog bug
// exposed as missing. Isolated render-fn tests (packet-wire.test.ts) green while
// the ASSEMBLED packet shipped a query with no results, because nothing asserted
// the full system+user message a real turn produces. These tests run a real turn
// (Mock provider), read the stored turns.packet, and assert section content —
// catching section-level + assembly regressions the unit tests can't.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import Paths from "../../src/Paths.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { InvalidLoopPolicyError, PlurnkParser, Validator } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, packetSection, logEntries, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { copyStmt, editStmt, readStmt, findStmt, regex, sendStmt, urlPath } from "./_dsl.ts";

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string; header: string | null; content: string; weight: number }> }> =>
    JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);

test("assembled packet: editable READ lines carry copyable anchors without changing their visible ordinals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-line-anchor-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "inspect notes");
        const schemes = new SchemeRegistry();
        const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
        const target = urlPath("worker", "/anchored.md");
        const source = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [
                    editStmt(target, source),
                    readStmt(target, { marks: [9, 10] }),
                    sendStmt(102),
                ] } },
                { assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } },
            ],
        });

        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const read = logEntries(await getPacket(db, second.turnId)).find((entry) =>
            entry.target === "worker:///anchored.md"
            && typeof entry.path === "string"
            && entry.path.endsWith("/READ"));
        assert.equal(read?.target, "worker:///anchored.md");
        assert.match(String(read?.body), /^@[0-9A-Za-z]{5}   9:line 9\n@[0-9A-Za-z]{5}  10:line 10\n$/);
    } finally { await db.close(); }
});

test("assembled packet: landed EDIT receipts expose causal parser-recovery evidence only when relevant", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-edit-parse-issues-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "edit Go sources");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const brokenTarget = urlPath("worker", "/broken.go");
        const cleanTarget = urlPath("worker", "/clean.go");
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [
                    editStmt(brokenTarget, "package sample\nfunc broken("),
                    editStmt(cleanTarget, "package sample\nfunc valid() {}"),
                    sendStmt(102),
                ] } },
                { assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } },
            ],
        });

        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const edits = logEntries(await getPacket(db, second.turnId)).filter((entry) =>
            typeof entry.path === "string" && entry.path.endsWith("/EDIT"));
        const broken = edits.find((entry) => entry.target === "worker:///broken.go");
        const clean = edits.find((entry) => entry.target === "worker:///clean.go");
        assert.match(String(broken?.parseIssues), /^0→[1-9]\d*$/);
        assert.equal(clean !== undefined && "parseIssues" in clean, false);
    } finally { await db.close(); }
});

test("packet assembly surfaces contract-invalid persisted loop policy at the same owner (#169)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-policy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        await db.engine_set_loop_policy.run({
            loop_id: loopId,
            policy: JSON.stringify({ capabilities: {}, proposals: "sometimes" }),
        });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }],
        });

        await assert.rejects(
            engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(error.message, `Loop ${loopId} has invalid persisted policy.`);
                assert.ok(error.cause instanceof InvalidLoopPolicyError);
                return true;
            },
        );
    } finally { await db.close(); }
});

test("assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist markerless shallow maps at turn 0
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-backbone-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what do I have?"); // {§actor-boundary-catalog-preview}: first loop foists
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/nested/deep.md", channel: "body", content: "nested", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/.env.defaults", channel: "body", content: "KNOB=1", mimetype: "text/plain" });
        await seedEntryWithChannel(db, { workspaceId, scheme: "worker", pathname: "/.github/settings.yml", channel: "body", content: "setting: true", mimetype: "text/yaml" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const rows = await db.test_log_entries_by_loop.all<{ id: number; op: string | null; origin: string; tx: string; rx: string; attrs: string }>({ loop_id: loopId });
        const foists = rows
            .filter(({ op, origin }) => origin === "_plurnk" && (op === "FIND" || op === "READ"));
        assert.ok(foists.length > 0, "the first turn persists its structural observation foists");
        const turnOps = rows.find(({ op, origin, attrs }) => op === null
            && origin === "_plurnk"
            && (JSON.parse(attrs) as { kind?: string }).kind === "turnOps");
        assert.ok(turnOps !== undefined, "the initialization source accompanies its operation outcomes");
        const source = (JSON.parse(turnOps.rx) as { content: string }).content;
        const sourceFoists = PlurnkParser.parse(source).items.flatMap((item) => item.kind === "statement" ? [item.statement] : [])
            .filter(({ op }) => op === "FIND" || op === "READ");
        assert.equal(sourceFoists.length, foists.length, "the exact source accounts for every structural observation");
        for (const [index, { tx }] of foists.entries()) {
            const statement = JSON.parse(tx) as { position?: unknown };
            assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
            assert.deepEqual(
                statement.position,
                sourceFoists[index]!.position,
                "the dispatched statement preserves its coordinate in the exact initialization source",
            );
        }
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // THE REGRESSION GUARD: the foisted FIND(worker:///*) renders its RESULT into the
        // log ({§render-rule-find-renders-result}) — the model SEES the catalog groups, not just
        // its own echoed query. The invisible-catalog bug rendered only `## FIND0 (...)`.
        assert.match(log, /worker:\/\/\/note\.md/, "the foisted catalog FIND renders a direct entry into the packet's log");
        assert.match(log, /worker:\/\/\/\.env\.defaults/, "the one-level page includes direct dot entries");
        assert.match(log, /"path":"worker:\/\/\/\.github\/\*\*","items":1,"tokens":\d+/, "a dot directory renders as an actionable recursive summary");
        assert.match(log, /"path":"worker:\/\/\/nested\/\*\*","items":1,"tokens":\d+/, "a directory renders as an actionable recursive summary");
        assert.doesNotMatch(log, /worker:\/\/\/nested\/deep\.md/, "the opening map does not dump a summarized descendant");
        for (const path of [".env.defaults", ".github/**", "nested/**", "note.md"]) {
            const target = `worker:///${path}`;
            const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            assert.match(
                log,
                new RegExp(`\\n\\d+:\\[{1,2}\\{"path":"${escaped}`),
                `${target} begins its own universally numbered FIND row`,
            );
        }
        assert.match(log, /"path":"log:\/\/\/[^"]+\/FIND"/, "the catalog foist appears as a FIND op in the log address");
        const initialization = logEntries(packet)
            .filter(({ path }) => String(path).startsWith("log:///1/1/"));
        const initializationOutcomes = initialization.filter(({ path }) => !String(path).endsWith("/ops"));
        assert.deepEqual(
            initializationOutcomes.map(({ path }) => String(path).split("/").at(-1)),
            ["PLAN", "COPY", "FIND", "FIND", "FIND", "FIND", "FIND", "FIND", "FIND", "FIND", "SEND"],
            "turn 0 exposes the real PLAN → prompt archive → surveys → SEND outcome sequence",
        );
        assert.deepEqual(
            initialization.filter(({ path }) => String(path).endsWith("/ops")).map((row) => ({ open: "body" in row, origin: row.origin })),
            [{ open: true, origin: "_plurnk" }],
            "turn 0 also exposes its exact open source as one ordinary turnOps row (#338)",
        );
        assert.deepEqual(
            initializationOutcomes.filter(({ target }) => target !== undefined).slice(0, 6).map(({ target }) => target),
            [
                "worker://~/_plurnk/skills/*.md",
                "worker://~/_plurnk/plurnk/*.md",
                "worker://~/_plurnk/tools/*.md",
                "worker://~/_plurnk/agents/*.md",
                "worker://~/_plurnk/members/*.md",
                "*",
            ],
            "reference discovery precedes workspace discovery",
        );
        assert.doesNotMatch(log, /worker:\/\/~\/_plurnk\/plurnk\/sh\.md/, "turn-0 never privileges the sh skill with an orientation READ");

    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("{§retrieval-packet-metadata}: exact matcher FIND shows flat surgical coordinates with one compact extent", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-matches-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "find the target");
        await seedEntryWithChannel(db, {
            workspaceId,
            scheme: "worker",
            pathname: "/notes.md",
            channel: "body",
            content: "heading\ntarget one\ncontext\ntarget two",
            mimetype: "text/markdown",
        });

        const matchedFind = {
            ...findStmt(urlPath("worker", "/notes.md")),
            body: regex("target"),
        };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [matchedFind, sendStmt(102)] } },
                { assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } },
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const log = packetSection(await getPacket(db, second.turnId), "log");

        assert.match(log, /"matcher":"\/target\/"/);
        assert.match(log, /"range":\{"unit":"matchLocation","total":2,"requested":\[1,16\],"returned":\[1,2\]\}/);
        assert.doesNotMatch(log, /"matchLocationCount":2/);
        assert.doesNotMatch(log, /"matchingPathCount":1/);
        // A regex row carries its matched text ({§find-result-projection}).
        assert.match(log, /1:\[\{"channel":"body","region":\{"startLine":2,"startColumn":1,"endLine":2,"endColumn":7\},"matched":"target"\},/);
        assert.match(log, /2:\{"channel":"body","region":\{"startLine":4,"startColumn":1,"endLine":4,"endColumn":7\},"matched":"target"\}\]/);
        assert.match(log, /worker:\/\/\/notes\.md/);
    } finally { await db.close(); }
});

test("assembled packet: scoped COPY reports both operands and its landed text materialization", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-copy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "copy the selected lines");
        const source = urlPath("worker", "/src.md");
        const destination = urlPath("worker", "/slice.md");
        const scopedCopy = copyStmt(source, destination, null, { marks: [2, 3] });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                {
                    assistant: {
                        content: "",
                        reasoning: null,
                        ops: [
                            editStmt(source, "one\ntwo\nthree\nfour"),
                            scopedCopy,
                            scopedCopy,
                            sendStmt(102),
                        ],
                    },
                },
                { assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } },
            ],
        });

        const first = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.deepEqual(first.outcomes, [
            { op: "EDIT", status: 201, problemType: null },
            { op: "COPY", status: 201, problemType: null },
            { op: "COPY", status: 304, problemType: null },
            { op: "SEND", status: 102, problemType: null },
        ]);
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        // Turn 0 archives the prompt by COPY (log:///1/1/…); the model's two are under test.
        const copies = logEntries(packet).filter(({ path }) => String(path).endsWith("/COPY") && !String(path).startsWith("log:///1/1/"));

        assert.equal(copies.length, 2);
        assert.equal(copies[0]?.source, "worker:///src.md<2,3>");
        assert.equal(copies[0]?.destination, "worker:///slice.md");
        assert.equal(copies[0]?.status, 201);
        assert.ok(Array.isArray(copies[0]?.effects));
        const [effect] = copies[0].effects as Array<Record<string, unknown>>;
        assert.equal(effect?.target, "worker:///slice.md");
        assert.equal(effect?.action, "create");
        assert.match(String(effect?.rev), /^[a-f0-9]{8}$/);
        assert.equal(effect?.extent, "lines 0->2");
        assert.equal(effect?.change, "-0 +2");
        assert.equal(effect?.range, "<1,-1> 1^->1-2");
        assert.ok(copies[0] !== undefined && "body" in copies[0], "the landed materialization is open (body present, #338)");
        assert.equal(copies[1]?.source, "worker:///src.md<2,3>");
        assert.equal(copies[1]?.destination, "worker:///slice.md");
        assert.equal(copies[1]?.status, 304);
        assert.equal(copies[1]?.effects, undefined);
        assert.ok(copies[1] !== undefined && !("body" in copies[1]) && !("tokensBody" in copies[1]), "the whole-channel effect has no text body (#338)");

        assert.match(packetSection(packet, "log"), /1:two\n(?:@[0-9A-Za-z]{5} +)?2:three/);
    } finally { await db.close(); }
});

test("the default wire preserves canonical order and projects the Recap override last", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-monotone-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({
            provider,
            recap: "CUSTOM_RECAP_SENTINEL",
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = await getPacket(db, result.turnId);

        // {§packet-cache-monotone}: trusted control-plane sections precede the user slot;
        // append-mostly log precedes per-turn status, active prompt pointers, and Recap.
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system"), ["definition", "system-policy", "schemes"], "stable privileged policy leads the resource directory");
        assert.deepEqual(slot("user"), ["log", "child-streams", "child-workers", "parent-worker", "errors", "notices", "git", "budget", "prompt", "recap"], "user slot: log -> status clump -> active prompt paths -> Recap");
        assert.equal(packet.sections.find((section) => section.name === "prompt")?.header, "Active User Prompts");
        assert.equal(packet.sections.at(-1)?.header, "Recap");
        assert.equal(packet.sections.at(-1)?.content, "CUSTOM_RECAP_SENTINEL");
    } finally { await db.close(); }
});

test("the empty default Recap source omits the rendered footer", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-recap-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });

        const result = await engine.runTurn({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const packet = await getPacket(db, result.turnId);

        assert.equal(packetSection(packet, "recap"), await readFile(Paths.defaultRecap, "utf8"));
        assert.doesNotMatch(PacketWire.renderSlot(packet.sections, "user"), /^## Recap$/m);
    } finally { await db.close(); }
});

test("assembled packet: the skills foist surfaces the Worker's materialized skills into its log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-docs-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A materialized scheme doc is an ordinary entry owned by the Worker
        // whose effective Functionality it describes.
        await seedEntryWithChannel(db, { workspaceId, ownerId: workerId, scheme: "worker", pathname: "/_plurnk/plurnk/worker.md", channel: "body", content: "# worker\n\n## Summary\n\nManage shared worker entries.\n\n## Invocation\n\n## EDIT0 (worker:///notes.md)\nNotes.", mimetype: "text/markdown" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const log = packetSection(await getPacket(db, result.turnId), "log");

        // The materialized doc reaches the model through its private FIND, not
        // an inline packet link ({§schemes-directory}).
        assert.match(log, /"target":"worker:\/\/~\/_plurnk\/plurnk\/\*\.md"/, "the foist scopes discovery to the Worker's skills tree");
        assert.match(log, /worker:\/\/~\/_plurnk\/plurnk\/worker\.md/, "the materialized skill surfaces in the foist's rendered result");
        assert.match(log, /"summary":"Manage shared worker entries\."/, "the catalog projects the document's Summary without opening its body");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("assembled packet: the bodyless Worker reference catalog succeeds when no references are materialized", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "2";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-empty-docs-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });

        const rows = await db.test_log_entries_by_loop.all<{ op: string; scheme: string | null; hostname: string | null; pathname: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const docs = rows.find((row) => row.op === "FIND" && row.scheme === "worker" && row.hostname === "~" && row.pathname === "/_plurnk/plurnk/*.md");
        assert.ok(docs !== undefined, "the Worker skills FIND executes without relying on materialized skills");
        assert.equal(docs.status_rx, 200, "an empty bodyless catalog remains a successful scope query");
        const result = JSON.parse(docs.rx) as { content?: string; results?: unknown[] };
        const items = result.results ?? (result.content !== undefined ? JSON.parse(result.content) as unknown[] : []);
        assert.deepEqual(items, [], "the empty Worker skills survey preserves its zero-result response");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("assembled packet: PLURNK_SERVICE_POLICY renders the single privileged system-slot policy section", async () => {
    const priorPolicy = process.env.PLURNK_SERVICE_POLICY;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-policy-"));
    const db = await openMigrated();
    try {
        const sysPath = join(dir, "system-AGENTS.md");
        await writeFile(sysPath, "# House rules\nNEVER guess a file path.");
        process.env.PLURNK_SERVICE_POLICY = sysPath;

        const workspaceId = await insertWorkspace(db, `pkt-policy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // Policy is the client's foot in the privileged zone — the system slot
        // carries the operator's authoritative rules. Project guidance now
        // rides turn 0 as the foisted agents.md entry ({§turn0-agents-stunt}).
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.ok(slot("system").includes("system-policy"), "PLURNK_SERVICE_POLICY rides the system slot — privileged, not a READable entry");
        assert.ok(!slot("system").includes("project-policy"), "the retired project-policy section never renders");
        assert.match(packetSection(packet, "system-policy"), /NEVER guess a file path/, "the system policy content reaches the model");
    } finally {
        await db.close();
        if (priorPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = priorPolicy;
        await rm(dir, { recursive: true, force: true });
    }
});

test("the live things a worker holds — child workers — surface as terse pointers in the status clump", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `child-orient-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A live child worker this worker holds (parent_worker_id = workerId; insertLoop's default status 102 = live).
        const child = await insertWorker(db, workspaceId, workerId, "worker-x");
        await insertLoop(db, child, 1, "working");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // The live child surfaces as a terse `* <status> worker://<name>` pointer — orienting state, not advice.
        assert.match(packetSection(packet, "child-workers"), /^\* 102 worker:\/\/worker-x$/m, "the live child worker is a status+path pointer the model READs/KILLs itself");
        // Framework status in the user slot's clump ({§packet-cache-monotone}), above budget-the-law.
        const usr = packet.sections.filter((x) => x.slot === "user").map((x) => x.name);
        assert.ok(usr.includes("child-workers"), "child-workers rides the status clump");
        assert.ok(usr.indexOf("log") < usr.indexOf("child-workers") && usr.indexOf("child-workers") < usr.indexOf("budget"), "the clump sits after the log, child-workers above budget-the-law");
    } finally { await db.close(); }
});

test("no live children or streams → the orientation sections are omitted (like errors)", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `child-orient-empty-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        // Empty content ⇒ the section renders to nothing (renderSlot drops zero-length sections), so the
        // model never sees a bare header — same as the errors section when there are no errors.
        const packet = await getPacket(db, result.turnId);
        assert.equal(packetSection(packet, "child-workers"), "", "no live child workers → child-workers renders nothing");
        assert.equal(packetSection(packet, "child-streams"), "", "no open streams → child-streams renders nothing");
    } finally { await db.close(); }
});

test("assembled packet: definition tables compact without changing other whitespace", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-definition-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const definition = [
            "# Definition",
            "",
            "| OP     | purpose                 |",
            "|:-------|------------------------:|",
            "| FIND   | list matching paths     |",
            "| `A \\| B` | preserve escaped pipes |",
            "| ------- | data dashes stay intact  |",
            "",
            "```text",
            "| fenced   | content   |",
            "```",
            "",
            "Prose  spacing remains exact.",
        ].join("\n");
        const expected = [
            "# Definition",
            "",
            "| OP | purpose |",
            "|:---|---:|",
            "| FIND | list matching paths |",
            "| `A \\| B` | preserve escaped pipes |",
            "| ------- | data dashes stay intact |",
            "",
            "```text",
            "| fenced   | content   |",
            "```",
            "",
            "Prose  spacing remains exact.",
        ].join("\n");

        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: definition }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        assert.equal(packetSection(packet, "definition"), expected, "the stored model-facing definition is the compact projection");
        assert.equal(packet.sections.find((section) => section.name === "definition")?.weight, contentWeight(expected), "definition render-weight measures the compact projection");
    } finally { await db.close(); }
});

test("{§definition-table-projection}: canonical inline operation examples survive packet projection", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-definition-grammar-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const definition = await readFile(Paths.instructionsSystem, "utf8");

        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: definition }, { role: "user", content: "go" }] });
        const projected = packetSection(await getPacket(db, result.turnId), "definition");
        const inlineGrammar = [...definition.matchAll(/`(#{1,2} [A-Z]+[A-Za-z0-9_]*(?: [^`\n]*)?)`/gu)].map((match) => match[0]);

        assert.ok(inlineGrammar.length > 0, "canonical definition must contain inline grammar examples");
        for (const example of inlineGrammar) {
            assert.ok(projected.includes(example), `packet projection changed canonical inline grammar ${JSON.stringify(example)}`);
        }
    } finally { await db.close(); }
});

test("{§schemes-directory}: the assembled packet renders complete fenced scheme examples", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-shape-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // The grammar (plurnk.md) must reach the model — a dropped definition section is a dead packet.
        assert.ok(packetSection(packet, "definition").length > 0, "the definition (grammar) section carries content");
        // Every resource-directory heading is a complete authored operation.
        const schemesSection = packetSection(packet, "schemes");
        assert.equal(packet.sections.find((section) => section.name === "schemes")?.header, "Resources");
        assert.ok(schemesSection.startsWith("```plurnk"), "the resource catalogue is a fenced plurnk block, not a bullet list");
        const schemeLines = schemesSection.split("\n").filter((line) => line.startsWith("## "));
        assert.ok(schemeLines.length > 0, "the resource directory lists entries");
        for (const line of schemeLines) assert.match(line, /^## (?:FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|SEND|EXEC|WORK|FORK|KILL)0(?:$| )/, `resource directory heading must be canonical: ${line}`);
        const headingOffsets = [...schemesSection.matchAll(/^## /gmu)].map((match) => match.index);
        for (const offset of headingOffsets.slice(1)) {
            assert.equal(schemesSection.slice(offset - 2, offset), "\n\n", "resource operation examples are separated by one blank line");
        }
    } finally { await db.close(); }
});
