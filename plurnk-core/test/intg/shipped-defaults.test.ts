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
    // {§operator-config-shipped-defaults}: model selection belongs to the operator.
    assert.equal(env.get("PLURNK_MODEL"), undefined, "no active PLURNK_MODEL ships");
    // {§operator-config-env-defaults} — a knob has exactly one owner, and this file declares ONLY
    // the service's: PLURNK_SERVICE_* plus the daemon's own unprefixed surface (HOST/PORT, the
    // PLUGINS trust gate). Sibling knobs (PROVIDERS/EXECS/SCHEMES/
    // MIMETYPES/AGUI/MODEL/BASE) live in the owning packages' shipped .env.defaults — a stray
    // here is a boot-crash collision waiting on the next sibling pub.
    const SERVICE_OWNED = /^(PLURNK_SERVICE_|PLURNK_HOST$|PLURNK_PORT$|PLURNK_PLUGINS_)/;
    const foreign = [...env.keys()].filter((k) => !SERVICE_OWNED.test(k));
    assert.deepEqual(foreign, [], `the template declares only service-owned knobs; foreign: ${foreign.join(", ")}`);
    // Provider physics and generation policy ship in the provider package.
    // Core has no parallel token budget or packing-margin contract.
    assert.equal(env.get("PLURNK_SERVICE_PROMPT_BUDGET"), undefined);
    assert.equal(env.get("PLURNK_SERVICE_SAFETY"), undefined);
    const previewLines = Number(env.get("PLURNK_SERVICE_PREVIEW_LINES"));
    const previewChars = Number(env.get("PLURNK_SERVICE_PREVIEW_CHARS"));
    assert.equal(previewLines, 16, "the shipped ordinary preview retains sixteen lines");
    assert.equal(previewChars, 2560, "the independent single-line allowance ships at 2560 characters");
    assert.equal(env.get("PLURNK_SERVICE_PROMPT_PROJECTION"), "25%", "prompt initialization ships at one quarter of the derived curation budget");
    assert.equal(env.get("PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES"), "104857600", "filesystem snapshots ship with a 100 MiB safety ceiling");
    assert.equal(env.get("PLURNK_SERVICE_MAX_EMBED_SIZE"), "262144", "vectors ship with a 256 KiB body-eligibility ceiling");
});

test("under the shipped policy wiring, the shipped policy renders in the packet exactly once", async () => {
    // Mirror a fresh install: PLURNK_SERVICE_POLICY → the seed file itself (ensureHome copies
    // POLICY.md to the XDG configuration AGENTS.md).
    const prevPolicy = process.env.PLURNK_SERVICE_POLICY;
    process.env.PLURNK_SERVICE_POLICY = Paths.policy;
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `shipped-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "hello");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [sendStmt(200, null, "done") as PlurnkStatement] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        const policy = (await readFile(Paths.policy, "utf8")).trim();
        const carriers = packet.sections.filter((section) => section.content === policy).map((section) => section.name);
        assert.deepEqual(carriers, ["system-policy"], `the policy rides exactly one section; got ${carriers.join(", ")}`);
        assert.equal(packetSection(packet, "system-policy"), policy, "the section carries the exact authored policy");
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
        assert.ok(!rows.some((r) => r.op === "READ" && (r.pathname ?? "").includes("POLICY")), "no foisted POLICY document READ");
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = prevPolicy;
        await db.close();
    }
});
