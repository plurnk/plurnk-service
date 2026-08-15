// {§operator-config-shipped-defaults} The shipped floor is a direct test subject because other
// test tiers overlay it. The composed check also proves the seeded policy has one packet owner.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Paths from "../../src/Paths.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, DEFAULT_MIMETYPES, packetSection } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const shippedEnv = async (): Promise<Map<string, string>> => {
    const raw = await readFile(new URL("../../.env.defaults", import.meta.url), "utf8");
    const env = new Map<string, string>();
    for (const line of raw.split("\n")) {
        const m = /^([A-Z_][A-Za-z0-9_]*)=(.*)$/.exec(line);  // configured alias suffixes may be lowercase
        if (m) {
            assert.equal(env.has(m[1]), false, `.env.defaults declares ${m[1]} more than once`);
            env.set(m[1], m[2].replace(/^"|"$/g, ""));
        }
    }
    return env;
};

test("the template ships no double policy, no active model, ONLY service-owned knobs", async () => {
    const env = await shippedEnv();
    // Policy is a privileged section; shipping the same content as an MD entry would duplicate it.
    const mdKeys = [...env.keys()].filter((k) => k.startsWith("PLURNK_SERVICE_MD_"));
    assert.deepEqual(mdKeys, [], `no active PLURNK_SERVICE_MD_* doc default ships; got ${mdKeys.join(", ")}`);
    // {§operator-config-shipped-defaults}: model selection belongs to the operator.
    assert.equal(env.get("PLURNK_MODEL"), undefined, "no active PLURNK_MODEL ships");
    // {§operator-config-env-defaults} — a knob has exactly one owner, and this file declares ONLY
    // the service's: PLURNK_SERVICE_* plus the daemon's own unprefixed surface (HOST/PORT, the
    // QUESTIONS ceiling, the PLUGINS trust gate). Sibling knobs (PROVIDERS/EXECS/SCHEMES/
    // MIMETYPES/AGUI/MODEL/BASE) live in the owning packages' shipped .env.defaults — a stray
    // here is a boot-crash collision waiting on the next sibling pub.
    const SERVICE_OWNED = /^(PLURNK_SERVICE_|PLURNK_HOST$|PLURNK_PORT$|PLURNK_QUESTIONS$|PLURNK_PLUGINS_)/;
    const foreign = [...env.keys()].filter((k) => !SERVICE_OWNED.test(k));
    assert.deepEqual(foreign, [], `the template declares only service-owned knobs; foreign: ${foreign.join(", ")}`);
    // Provider physics ship elsewhere. Core's only active default is SAFETY;
    // virtual PROMPT_BUDGET is optional and therefore absent from the parsed floor.
    const safety = Number(env.get("PLURNK_SERVICE_SAFETY"));
    assert.ok(Number.isFinite(safety) && safety > 0, "SAFETY ships as a positive int — core's one partition knob");
    const previewLines = Number(env.get("PLURNK_SERVICE_PREVIEW_LINES"));
    const previewChars = Number(env.get("PLURNK_SERVICE_PREVIEW_CHARS"));
    assert.equal(previewLines, 16, "the shipped ordinary preview retains sixteen lines");
    assert.equal(previewChars, 2560, "the independent single-line allowance ships at 2560 characters");
    assert.equal(env.get("PLURNK_SERVICE_PROMPT_PROJECTION"), "25%", "prompt initialization ships at one quarter of the stable packet budget");
    // {§tokenomics-window-partition} — the bare partition is cloud-generous:
    // 163840 − 16384 − 49152 − 1024 = 97280 prompt
    // budget with a 65536 decode envelope the backend self-clamps (the local per-alias template
    // is the 64Ki-prompt gemma envelope). Prompt budget stays well above the decode envelope.
});

test("under the shipped policy wiring, the personality renders in the packet exactly once", async () => {
    // Mirror a fresh install: PLURNK_SERVICE_POLICY → the seed file itself (ensureHome copies
    // PLURNK_PERSONALITY.md to ~/.plurnk/AGENTS.md); no PLURNK_SERVICE_MD_* docs.
    const prevPolicy = process.env.PLURNK_SERVICE_POLICY;
    const prevMd = process.env.PLURNK_SERVICE_MD_POLICY;
    process.env.PLURNK_SERVICE_POLICY = Paths.personality;
    delete process.env.PLURNK_SERVICE_MD_POLICY;
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `shipped-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "hello");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done") as PlurnkStatement] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        const personality = (await readFile(Paths.personality, "utf8")).trim();
        const carriers = packet.sections.filter((section) => section.content === personality).map((section) => section.name);
        assert.deepEqual(carriers, ["system-policy"], `the policy rides exactly one section; got ${carriers.join(", ")}`);
        assert.equal(packetSection(packet, "system-policy"), personality, "the section carries the exact authored personality");
        assert.doesNotMatch(
            packetSection(packet, "system-policy"),
            /READ the row an error points at/,
            "the permanent policy does not prescribe retrieval for already-inline errors",
        );
        const rendered = packet.sections.map((s) => s.content).join("\n");
        assert.doesNotMatch(
            rendered,
            /You curate your own context|FOLD targets|folding reclaims their tokens|preserve headroom|KILLing irrelevant|FOLD or KILL irrelevant/i,
            "the assembled packet contains no ambient context-curation command",
        );
        assert.doesNotMatch(
            packetSection(packet, "system-policy"),
            /keep implementation, specification, documentation, and coverage aligned/i,
            "the general worker policy does not expand every task into a four-lane maintenance obligation",
        );
        assert.doesNotMatch(
            packetSection(packet, "system-policy"),
            /commit completed repository changes|plurnk@pm\.me/i,
            "the general worker policy neither orders commits nor assigns Git authorship",
        );
        // And the turn-0 foists contain no POLICY doc READ — the doc path is retired for the policy.
        const rows = await db.test_log_sequencees_by_turn.all<{ op: string; pathname: string | null }>({ turn_id: result.turnId });
        assert.ok(!rows.some((r) => r.op === "READ" && (r.pathname ?? "").includes("POLICY")), "no foisted worker://plurnk/POLICY.md READ");
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = prevPolicy;
        if (prevMd !== undefined) process.env.PLURNK_SERVICE_MD_POLICY = prevMd;
        await db.close();
    }
});
