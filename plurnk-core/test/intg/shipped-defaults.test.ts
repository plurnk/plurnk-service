// {§operator-config-shipped-defaults} The shipped floor is a direct test subject because other
// test tiers overlay it. The composed check also proves the seeded policy has one packet owner.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Meta from "@plurnk/plurnk-meta";
import { PROVIDERS_KNOBS } from "@plurnk/plurnk-providers";
import Paths from "../../src/Paths.ts";
import EnvCatalog from "../../src/core/env-catalog.ts";
import EnvDefaults from "../../src/core/env-defaults.ts";
import OperatorConfig from "../../src/core/OperatorConfig.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop } from "./_db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { packetSection } from "./_packet.ts";
import { concludeStmt, } from "./_dsl.ts";

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
    // the service's: PLURNK_SERVICE_* plus the daemon's own unprefixed surface (the EXTENSIONS
    // trust gate and the members Functionality family, which core itself implements). HOST and
    // PORT are shared with every client, so contracts declares them
    // ({§operator-config-shared-keys}). Sibling knobs (PROVIDERS/EXECS/SCHEMES/
    // MIMETYPES/AGUI/MODEL/BASE) live in the owning packages' shipped .env.defaults — a stray
    // here is a boot-crash collision waiting on the next sibling pub.
    const SERVICE_OWNED = /^(PLURNK_SERVICE_|PLURNK_EXTENSIONS_|PLURNK_MEMBERS_)/;
    const foreign = [...env.keys()].filter((k) => !SERVICE_OWNED.test(k));
    assert.deepEqual(foreign, [], `the template declares only service-owned knobs; foreign: ${foreign.join(", ")}`);
    assert.equal(env.get("PLURNK_SERVICE_MAX_TURNS"), "-1", "model-call ceilings are opt-in, not a lifetime allowance");
    // {§markerless-first-page} — the page's two knobs ship: 100 lines, 16000 characters.
    assert.equal(env.get("PLURNK_SERVICE_PREVIEW_LINES"), "100", "the only correct default is 100");
    assert.equal(env.get("PLURNK_SERVICE_PREVIEW_CHARS"), "16000");
    assert.equal(env.get("PLURNK_SERVICE_BUDGET_LARGEST_ITEMS"), "5", "the gauge names the five largest retained rows");
    assert.equal(env.get("PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES"), "104857600", "filesystem snapshots ship with a 100 MiB safety ceiling");
});

test("under the shipped policy wiring, the shipped policy has one packet owner", async () => {
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
        const provider = new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [concludeStmt("done") as PlurnkStatement] } }] });
        const result = await engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet) as { sections: Array<{ name: string; content: string }> };
        const policy = (await readFile(Paths.policy, "utf8")).trim();
        assert.equal(packet.sections.filter((section) => section.name === "system-policy").length, 1);
        const carriers = packet.sections.filter((section) => section.content !== "" && section.content === policy).map((section) => section.name);
        assert.deepEqual(carriers, policy === "" ? [] : ["system-policy"], "nonempty policy content appears only in its owned section");
        assert.equal(packetSection(packet, "system-policy"), policy, "the section carries the exact authored policy");
        const rows = await db.test_log_sequencees_by_turn.all<{ op: string; pathname: string | null }>({ turn_id: result.turnId });
        assert.deepEqual(rows.map(({ op, pathname }) => ({ op, pathname })), [{ op: "SEND", pathname: null }, { op: "KILL", pathname: null }],
            "the turn holds the message arrival and the conclusion; the policy rides only its section");
    } finally {
        if (prevPolicy === undefined) delete process.env.PLURNK_SERVICE_POLICY; else process.env.PLURNK_SERVICE_POLICY = prevPolicy;
        await db.close();
    }
});

test("{§operator-config-shared-keys} a key the daemon and its clients both read is declared by contracts, and only there", async () => {
    const contracts = await readFile(new URL("../../../plurnk-contracts/.env.defaults", import.meta.url), "utf8");
    const declared = new Map([...contracts.matchAll(/^(?:# )?(PLURNK_[A-Z_]+)=(.*)$/gmu)].map((match) => [match[1]!, match[2]!]));
    assert.deepEqual([...declared.keys()], ["PLURNK_HOST", "PLURNK_PORT", "PLURNK_AGUI_URL"]);
    assert.equal(declared.get("PLURNK_HOST"), "127.0.0.1", "local-only unless the operator says otherwise");
    const core = await shippedEnv();
    for (const key of declared.keys()) assert.equal(core.get(key), undefined, `${key} has one owner, and it is not the service`);
});

test("{§operator-config-undeclared-key} the installed panels declare every family their packages read, and a fresh seed draws no notice", async () => {
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const { files } = await EnvDefaults.collect(root, Meta.nearestNodeModules(root) ?? join(root, "node_modules"));
    const declares = EnvCatalog.declares(files);
    const computed = [
        ...PROVIDERS_KNOBS.map((knob) => `${knob}_fixture`),  // every provider knob, scoped to an alias
        "PLURNK_PROVIDERS_GBNF_fixture",
        "PLURNK_MODEL_fixture", "PLURNK_BASEURL_fixture",
        "PLURNK_PROVIDERS_PROVIDER_XIAOMI_REASONING_ON_BODY",
        "PLURNK_EXECS_NODE",
        ...["MCP", "A2A", "SCHEDULE", "MEMBERS"].flatMap((family) => [`PLURNK_${family}_fixture`, `PLURNK_${family}_fixture_ENABLED`]),
        "PLURNK_MCP_fixture_TOOLS", "PLURNK_SKILLS_分析", "PLURNK_SKILLS_分析_ENABLED",
    ];
    assert.deepEqual(computed.filter((key) => !declares(key)), [], "a key a package reads by a computed name belongs to a declared family");
    assert.deepEqual(OperatorConfig.undeclared(OperatorConfig.renderSeed(), declares), []);
});
