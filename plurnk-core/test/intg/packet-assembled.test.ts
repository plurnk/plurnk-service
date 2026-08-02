// Assembled-packet regression coverage — the backbone the invisible-catalog bug
// exposed as missing. Isolated render-fn tests (packet-wire.test.ts) green while
// the ASSEMBLED packet shipped a query with no results, because nothing asserted
// the full system+user message a real turn produces. These tests run a real turn
// (Mock provider), read the stored turns.packet, and assert section content —
// catching section-level + assembly regressions the unit tests can't.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { rulerCount } from "../../src/core/token-ruler.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, packetSection, logEntries, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { copyStmt, editStmt, readStmt, regex, sendStmt, urlPath } from "./_dsl.ts";

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string; content: string; tokens: number }> }> =>
    JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);

test("assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist complete shallow maps at turn 0
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-backbone-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what do I have?"); // worker's first loop → foist fires (#269)
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/nested/deep.md", channel: "body", content: "nested", mimetype: "text/markdown" });
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/.env.defaults", channel: "body", content: "KNOB=1", mimetype: "text/plain" });
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/.github/settings.yml", channel: "body", content: "setting: true", mimetype: "text/yaml" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // THE REGRESSION GUARD: the foisted FIND(worker:///*) renders its RESULT into the
        // log ({§render-rule-find-renders-result}) — the model SEES the catalog rows, not just
        // its own echoed query. The invisible-catalog bug rendered only `<<FIND(...)::FIND`.
        assert.match(log, /worker:\/\/\/note\.md/, "the foisted catalog FIND renders a direct entry into the packet's log");
        assert.match(log, /worker:\/\/\/\.env\.defaults/, "the complete one-level map includes direct dot entries");
        assert.match(log, /"path":"worker:\/\/\/\.github\/\*\*","items":1,"tokens":\d+/, "a dot directory renders as an actionable recursive summary");
        assert.match(log, /"path":"worker:\/\/\/nested\/\*\*","items":1,"tokens":\d+/, "a directory renders as an actionable recursive summary");
        assert.doesNotMatch(log, /worker:\/\/\/nested\/deep\.md/, "the opening map does not dump a summarized descendant");
        for (const path of [".env.defaults", ".github/**", "nested/**", "note.md"]) {
            const target = `worker:///${path}`;
            const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            assert.match(
                log,
                new RegExp(`\\n\\d+:\\[?\\{"path":"${escaped}`),
                `${target} begins its own universally numbered FIND row`,
            );
        }
        assert.match(log, /"op":"FIND"/, "the catalog foist appears as a FIND op in the log");
        assert.match(
            log,
            /<<SEND\[102\]:Next, address the prompt from the initialized context\.:SEND/,
            "the turn-0 exemplar teaches SEND[102] as an explicit next action",
        );

    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("assembled packet: matcher READ shows the resource and surgical coordinates together", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-matches-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "find the target");
        await seedEntryWithChannel(db, {
            workspaceId,
            workerId,
            scheme: "worker",
            pathname: "/notes.md",
            channel: "body",
            content: "heading\ntarget one\ncontext\ntarget two",
            mimetype: "text/markdown",
        });

        const matchedRead = {
            ...readStmt(urlPath("worker", "/notes.md")),
            body: regex("target"),
        };
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                { assistant: { content: "", reasoning: null, ops: [matchedRead, sendStmt(102)] } },
                { assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } },
            ],
        });
        await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const log = packetSection(await getPacket(db, second.turnId), "log");

        assert.match(log, /"matcher":"\/target\/"/);
        assert.match(log, /"matches":\[\{"region":\{"startLine":2,"startColumn":1,"endLine":2,"endColumn":7\}\},\{"region":\{"startLine":4,"startColumn":1,"endLine":4,"endColumn":7\}\}\]/);
        assert.match(log, /<<:::worker:\/\/\/notes\.md\n1:heading\n2:target one\n3:context\n4:target two\n:::worker:\/\/\/notes\.md/);
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
        assert.deepEqual(first.statuses, [201, 201, 304, 102]);
        const second = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] });
        const packet = await getPacket(db, second.turnId);
        const copies = logEntries(packet).filter(({ op }) => op === "COPY");

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
        assert.equal(copies[0]?.display, "open");
        assert.equal(copies[1]?.source, "worker:///src.md<2,3>");
        assert.equal(copies[1]?.destination, "worker:///slice.md");
        assert.equal(copies[1]?.status, 304);
        assert.equal(copies[1]?.effects, undefined);
        assert.equal(copies[1]?.display, "none");
        assert.equal(copies[1]?.body, "");
        assert.match(packetSection(packet, "log"), /1:two\n2:three/);
    } finally { await db.close(); }
});

test("the wire is monotone in volatility — byte-stable system; user: log → status clump → recap", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-monotone-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // (#531, owner ruling) system = the timeless (byte-stable doctrine, the message-granular
        // cache breakpoint); user = the situated — append-mostly log first (its frozen head extends
        // the cache prefix), then the per-turn status clump nearest the generation point, then the
        // recap footer. Trust is the one-way admission rule: system admits only framework-authored,
        // non-injectable content — NO log.
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system"), ["definition", "tools", "schemes", "system-policy", "project-policy"], "system slot is the byte-stable doctrine, in teaching order, nothing volatile");
        assert.deepEqual(slot("user"), ["log", "child-streams", "child-workers", "errors", "notices", "git", "budget", "prompt", "requirements"], "user slot: log -> status clump -> recap; the prompt paths list closes the clump");
        assert.ok(packetSection(packet, "requirements").length > 0, "requirements section carries content");
    } finally { await db.close(); }
});

test("assembled packet: the docs foist — FIND(worker://plurnk/docs/**) surfaces materialized docs into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-docs-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A materialized scheme doc (what loop_run writes in production — the demo's runLoop doesn't) —
        // kernel-owned at worker://plurnk/docs/… ({§entry-owner}).
        const Owner = (await import("../../src/core/Owner.ts")).default;
        await seedEntryWithChannel(db, { workspaceId, workerId, ownerId: await Owner.kernelId(db, workspaceId), scheme: "worker", pathname: "/docs/worker.md", channel: "body", content: "# worker\nYour shared blackboard.", mimetype: "text/markdown" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const log = packetSection(await getPacket(db, result.turnId), "log");

        // The kernel surface is scoped to its docs subtree, and the FIND renders its result —
        // the materialized doc reaches the model via FIND, not an inline link (#270).
        assert.match(log, /"target":"worker:\/\/plurnk\/docs\/\*\*"/, "the foist scopes the kernel surface to the docs subtree");
        assert.match(log, /worker:\/\/plurnk\/docs\/worker\.md/, "the materialized doc surfaces in the foist's rendered result");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("assembled packet: the kernel docs FIND executes successfully when no docs are materialized", async () => {
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
        const docs = rows.find((row) => row.op === "FIND" && row.scheme === "worker" && row.hostname === "plurnk" && row.pathname === "/docs/**");
        assert.ok(docs !== undefined, "the kernel docs FIND executes without relying on materialized docs");
        assert.equal(docs.status_rx, 200, "an empty kernel docs survey succeeds");
        const result = JSON.parse(docs.rx) as { content?: string; results?: unknown[] };
        const items = result.results ?? (result.content !== undefined ? JSON.parse(result.content) as unknown[] : []);
        assert.deepEqual(items, [], "the empty kernel docs survey preserves its zero-result response");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("assembled packet: PLURNK_SERVICE_POLICY + PLURNK_SERVICE_PROJECT render as privileged system-slot policy sections", async () => {
    const priorPolicy = process.env.PLURNK_SERVICE_POLICY;
    const priorProject = process.env.PLURNK_SERVICE_PROJECT;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-policy-"));
    const db = await openMigrated();
    try {
        const sysPath = join(dir, "system-AGENTS.md");
        const projPath = join(dir, "project-AGENTS.md");
        await writeFile(sysPath, "# House rules\nNEVER guess a file path.");
        await writeFile(projPath, "# Project rules\nThe budget is law.");
        process.env.PLURNK_SERVICE_POLICY = sysPath;
        process.env.PLURNK_SERVICE_PROJECT = projPath;

        const workspaceId = await insertWorkspace(db, `pkt-policy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // Policy is the client's foot in the privileged zone — both sections ride the SYSTEM slot
        // (not user, not a curatable READable entry), carrying the operator's authoritative rules.
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.ok(slot("system").includes("system-policy"), "PLURNK_SERVICE_POLICY rides the system slot — privileged, not a READable entry");
        assert.ok(slot("system").includes("project-policy"), "PLURNK_SERVICE_PROJECT rides the system slot");
        assert.match(packetSection(packet, "system-policy"), /NEVER guess a file path/, "the system policy content reaches the model");
        assert.match(packetSection(packet, "project-policy"), /budget is law/, "the project policy content reaches the model");
    } finally {
        await db.close();
        if (priorPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = priorPolicy;
        if (priorProject === undefined) delete process.env.PLURNK_SERVICE_PROJECT; else process.env.PLURNK_SERVICE_PROJECT = priorProject;
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
        assert.equal(packet.sections.find((section) => section.name === "definition")?.tokens, rulerCount(expected), "definition render-weight measures the compact projection");
    } finally { await db.close(); }
});

test("assembled packet: the grammar definition reaches the packet + the schemes directory renders well-formed << heredocs", async () => {
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
        // Every scheme-directory line is a well-formed heredoc — the service-side guard for the
        // <<-less example class (a render dropping the << teaches the model malformed ops, the
        // exact failure mode the EXEC examples shipped). Covers the part the service controls.
        const schemesSection = packetSection(packet, "schemes");
        assert.ok(schemesSection.startsWith("```plurnk"), "the schemes catalog is a fenced plurnk block (#436), not a bullet list");
        const schemeLines = schemesSection.split("\n").filter((l) => l.startsWith("<<"));
        assert.ok(schemeLines.length > 0, "the schemes directory lists entries");
        for (const line of schemeLines) assert.match(line, /^<</, `scheme directory line must be a << heredoc: ${line}`);
    } finally { await db.close(); }
});
