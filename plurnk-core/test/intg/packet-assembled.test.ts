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
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel, packetSection, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string }> }> =>
    JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId }))!.packet);

test("[§render-rule-find-renders-result] assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1"; // foist the full per-scheme catalog at turn 0
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-backbone-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "what do I have?"); // worker's first loop → foist fires (#269)
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "known", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // THE REGRESSION GUARD: the foisted FIND(known:///**) renders its RESULT into the
        // log (§render-rule-find-renders-result) — the model SEES the catalog rows, not just
        // its own echoed query. The invisible-catalog bug rendered only `<<FIND(...)::FIND`.
        assert.match(log, /known:\/\/\/note\.md/, "the foisted catalog FIND renders the entry into the packet's log");
        assert.match(log, /"op":"FIND"/, "the catalog foist appears as a FIND op in the log");

        // Section slots are a TRUST boundary (§packet-assembly): system holds framework-authored,
        // non-injectable sections (definition → schemes → policy → errors → git → budget-the-law, NO log);
        // the user slot holds injectable content (log) and the PRIMARY prompt, plus the requirements
        // footer — ordered log → prompt → requirements (the primary prompt sits at the action point).
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system").filter((n) => ["definition", "schemes", "log"].includes(n)), ["definition", "schemes"], "system slot: definition → schemes, no log (the log is injectable data, not a privileged rule)");
        assert.ok(slot("system").includes("errors") && slot("system").includes("git"), "errors + git ride system — framework status (pointers / counts), not injection surfaces");
        assert.equal(slot("system").at(-1), "prompt", "the User Prompts paths-list is the system slot's very bottom (§prompt-auto-read, owner)");
        assert.equal(slot("system").at(-2), "budget", "budget (LAW) rides just above it");
        const usr = slot("user");
        assert.ok(!usr.includes("git") && !usr.includes("errors"), "no framework status in the user slot — only injectable content + the requirements footer");
        assert.deepEqual(usr.slice(-2), ["log", "requirements"], "user slot ends: log → requirements footer (the prompts paths-list moved to the system bottom, §prompt-auto-read)");
        assert.ok(packetSection(packet, "requirements").length > 0, "requirements section carries content");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("assembled packet: the docs foist — FIND(plurnk://docs/**) surfaces materialized docs into the log", async () => {
    const prev = process.env.PLURNK_SERVICE_FILES_ITEMS;
    process.env.PLURNK_SERVICE_FILES_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pkt-docs-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "go");
        // A materialized scheme doc (what loop_run writes in production — the demo's runLoop doesn't).
        await seedEntryWithChannel(db, { workspaceId, workerId, scheme: "plurnk", pathname: "/docs/known.md", channel: "body", content: "# known\nYour persistent memory.", mimetype: "text/markdown" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const log = packetSection(await getPacket(db, result.turnId), "log");

        // The plurnk catalog is scoped to its docs subtree, and the FIND renders its result —
        // the materialized doc reaches the model via FIND, not an inline link (#270).
        assert.match(log, /"target":"plurnk:\/\/docs\/\*\*"/, "the foist scopes the plurnk catalog to the docs subtree");
        assert.match(log, /plurnk:\/\/docs\/known\.md/, "the materialized doc surfaces in the foist's rendered result");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_SERVICE_FILES_ITEMS; else process.env.PLURNK_SERVICE_FILES_ITEMS = prev;
    }
});

test("[§policy-sections] assembled packet: PLURNK_SERVICE_POLICY + PLURNK_SERVICE_PROJECT render as privileged system-slot policy sections", async () => {
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

test("[§child-orientation] the live things a worker holds — child workers — surface as terse pointers in the system slot", async () => {
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
        // Framework status, NOT an injection surface — rides the system slot, above budget-the-law.
        const sys = packet.sections.filter((x) => x.slot === "system").map((x) => x.name);
        assert.ok(sys.includes("child-workers"), "child-runs rides the system slot");
        assert.ok(sys.indexOf("child-workers") < sys.indexOf("budget"), "child-runs sits in the volatile-status tail above budget-the-law");
    } finally { await db.close(); }
});

test("[§child-orientation] no live children or streams → the orientation sections are omitted (like errors)", async () => {
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
