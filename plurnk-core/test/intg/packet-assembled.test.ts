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
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, packetSection, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string }> }> =>
    JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);

test("assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist the full per-scheme catalog at turn 0
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-backbone-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what do I have?"); // worker's first loop → foist fires (#269)
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "worker", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // THE REGRESSION GUARD: the foisted FIND(worker:///**) renders its RESULT into the
        // log (§render-rule-find-renders-result) — the model SEES the catalog rows, not just
        // its own echoed query. The invisible-catalog bug rendered only `<<FIND(...)::FIND`.
        assert.match(log, /worker:\/\/\/note\.md/, "the foisted catalog FIND renders the entry into the packet's log");
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
        assert.deepEqual(slot("user"), ["log", "child-streams", "child-workers", "errors", "notices", "git", "budget", "prompt", "requirements"], "user slot: log → status clump → recap (§prompt-auto-read: the prompts paths-list closes the clump)");
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
        // Framework status in the user slot's clump ([§packet-cache-monotone]), above budget-the-law.
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
        assert.equal(packetSection(packet, "child-workers"), "", "no live child workers → child-runs renders nothing");
        assert.equal(packetSection(packet, "child-streams"), "", "no open streams → child-streams renders nothing");
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
