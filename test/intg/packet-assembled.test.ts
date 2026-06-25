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
import { openMigrated, insertSession, insertRun, insertLoop, seedEntryWithChannel, packetSection, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const getPacket = async (db: Awaited<ReturnType<typeof openMigrated>>, turnId: number): Promise<{ sections: Array<{ name: string; slot: string }> }> =>
    JSON.parse((await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: turnId }))!.packet);

test("[§render-rule-find-renders-result] assembled packet: the turn-0 catalog foist renders its entries into the log", async () => {
    const prev = process.env.PLURNK_MANIFEST_ITEMS;
    process.env.PLURNK_MANIFEST_ITEMS = "-1"; // foist the full per-scheme catalog at turn 0
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `pkt-backbone-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "what do I have?"); // run's first loop → foist fires (#269)
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "known", pathname: "/note.md", channel: "body", content: "the answer is 42", mimetype: "text/markdown" });

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);
        const log = packetSection(packet, "log");

        // THE REGRESSION GUARD: the foisted FIND(known:///**) renders its RESULT into the
        // log (§render-rule-find-renders-result) — the model SEES the catalog rows, not just
        // its own echoed query. The invisible-catalog bug rendered only `<<FIND(...)::FIND`.
        assert.match(log, /known:\/\/\/note\.md/, "the foisted catalog FIND renders the entry into the packet's log");
        assert.match(log, /"op":"FIND"/, "the catalog foist appears as a FIND op in the log");

        // Section presence + order: system holds the rules (definition → schemes, NO log); the log
        // is data, so it lives at the bottom of the user slot — just above requirements (the action point).
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.deepEqual(slot("system").filter((n) => ["definition", "schemes", "log"].includes(n)), ["definition", "schemes"], "system slot: definition → schemes, no log (the log is data, not a privileged rule)");
        assert.ok(slot("system").includes("budget"), "budget lives in system — it's LAW (the ceiling), a privileged constraint, not status");
        assert.ok(!slot("system").includes("git"), "git stays in user — workspace status, not law");
        const usr = slot("user");
        assert.deepEqual(usr.slice(-3), ["log", "git", "requirements"], "user slot ends: log → git → requirements");
        assert.ok(packetSection(packet, "requirements").length > 0, "requirements section carries content");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});

test("assembled packet: the docs foist — FIND(plurnk://docs/**) surfaces materialized docs into the log", async () => {
    const prev = process.env.PLURNK_MANIFEST_ITEMS;
    process.env.PLURNK_MANIFEST_ITEMS = "-1";
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `pkt-docs-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        // A materialized scheme doc (what loop_run writes in production — the demo's runLoop doesn't).
        await seedEntryWithChannel(db, { sessionId, runId, scheme: "plurnk", pathname: "/docs/known.md", channel: "body", content: "# known\nYour persistent memory.", mimetype: "text/markdown" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const log = packetSection(await getPacket(db, result.turnId), "log");

        // The plurnk catalog is scoped to its docs subtree, and the FIND renders its result —
        // the materialized doc reaches the model via FIND, not an inline link (#270).
        assert.match(log, /"target":"plurnk:\/\/docs\/\*\*"/, "the foist scopes the plurnk catalog to the docs subtree");
        assert.match(log, /plurnk:\/\/docs\/known\.md/, "the materialized doc surfaces in the foist's rendered result");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_MANIFEST_ITEMS; else process.env.PLURNK_MANIFEST_ITEMS = prev;
    }
});

test("[§policy-sections] assembled packet: PLURNK_POLICY + PLURNK_PROJECT render as privileged system-slot policy sections", async () => {
    const priorPolicy = process.env.PLURNK_POLICY;
    const priorProject = process.env.PLURNK_PROJECT;
    const dir = await mkdtemp(join(tmpdir(), "plurnk-policy-"));
    const db = await openMigrated();
    try {
        const sysPath = join(dir, "system-AGENTS.md");
        const projPath = join(dir, "project-AGENTS.md");
        await writeFile(sysPath, "# House rules\nNEVER guess a file path.");
        await writeFile(projPath, "# Project rules\nThe budget is law.");
        process.env.PLURNK_POLICY = sysPath;
        process.env.PLURNK_PROJECT = projPath;

        const sessionId = await insertSession(db, `pkt-policy-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // Policy is the client's foot in the privileged zone — both sections ride the SYSTEM slot
        // (not user, not a curatable READable entry), carrying the operator's authoritative rules.
        const slot = (s: string): string[] => packet.sections.filter((x) => x.slot === s).map((x) => x.name);
        assert.ok(slot("system").includes("system-policy"), "PLURNK_POLICY rides the system slot — privileged, not a READable entry");
        assert.ok(slot("system").includes("project-policy"), "PLURNK_PROJECT rides the system slot");
        assert.match(packetSection(packet, "system-policy"), /NEVER guess a file path/, "the system policy content reaches the model");
        assert.match(packetSection(packet, "project-policy"), /budget is law/, "the project policy content reaches the model");
    } finally {
        await db.close();
        if (priorPolicy === undefined) delete process.env.PLURNK_POLICY; else process.env.PLURNK_POLICY = priorPolicy;
        if (priorProject === undefined) delete process.env.PLURNK_PROJECT; else process.env.PLURNK_PROJECT = priorProject;
        await rm(dir, { recursive: true, force: true });
    }
});

test("assembled packet: the grammar definition reaches the packet + the schemes directory renders well-formed << heredocs", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `pkt-shape-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200)] } }] });
        const result = await engine.runTurn({ provider, sessionId, runId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = await getPacket(db, result.turnId);

        // The grammar (plurnk.md) must reach the model — a dropped definition section is a dead packet.
        assert.ok(packetSection(packet, "definition").length > 0, "the definition (grammar) section carries content");
        // Every scheme-directory line is a well-formed heredoc — the service-side guard for the
        // <<-less example class (a render dropping the << teaches the model malformed ops, the
        // exact failure mode the EXEC examples shipped). Covers the part the service controls.
        const schemeLines = packetSection(packet, "schemes").split("\n").filter((l) => l.startsWith("* "));
        assert.ok(schemeLines.length > 0, "the schemes directory lists entries");
        for (const line of schemeLines) assert.match(line, /^\* <</, `scheme directory line must be a << heredoc: ${line}`);
    } finally { await db.close(); }
});
