// Live e2e through the service on framework 0.10.0: drive a real Engine.runTurn
// against Fireworks via the `firefast` alias with GBNF on (plurnk-free.gbnf).
// Proves the full path — modelPrefix wire id, response_format grammar, the
// per-request streaming demotion (grammar output arrives as content, not
// reasoning_content) — works end-to-end, not just at the raw wire.
import { readFile } from "node:fs/promises";
import Engine from "./src/core/Engine.ts";
import SchemeRegistry from "./src/core/SchemeRegistry.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./src/core/ProviderInstantiate.ts";
import { Paths } from "./src/index.ts";
import { openMigrated, insertSession, insertRun, insertLoop } from "./test/intg/_helpers.ts";
import type { PrepMethod } from "./src/core/Db.ts";

// env cascade, set-if-unset, matching bin/plurnk-service.ts --config fire:
// .env.fire > .env > .env.example.
process.loadEnvFile(".env.fire");
process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

const alias = resolveActiveAlias();
console.log("active alias        :", alias);
console.log("GBNF variant        :", process.env.PLURNK_PROVIDERS_GBNF);

const provider = await ProviderInstantiate.loadActiveProvider();
if (provider === null) throw new Error("loadActiveProvider returned null");
console.log("provider wire model :", (provider as { model: string }).model);

const SYSTEM_PROMPT = await readFile(Paths.instructionsSystem, "utf8");
const db = await openMigrated();
const mimetypes = new Mimetypes();
await mimetypes.ready();

try {
    const userPrompt = "What is the capital of France? Store the answer under known:///france/capital and reply with a single SEND[200] message containing the answer.";
    const sessionId = await insertSession(db, `live-fire-${crypto.randomUUID()}`);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1, userPrompt);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes });

    const t0 = performance.now();
    const result = await engine.runTurn({
        provider, sessionId, runId, loopId,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
    });
    const elapsed = Math.round(performance.now() - t0);

    const turn = await (db.test_get_turn as PrepMethod).get<{ id: number; status: number; usage_completion: number; packet: string }>({ id: result.turnId });
    const packet = JSON.parse(turn?.packet ?? "{}") as { assistant: { content: string; reasoning: string | null; ops: unknown[] } };

    console.log(`\n=== runTurn: status ${result.status}, ${elapsed}ms wall ===`);
    console.log("op statuses         :", result.statuses);
    console.log("completion tokens   :", turn?.usage_completion);
    console.log("content chars       :", packet.assistant.content.length);
    console.log("reasoning chars     :", packet.assistant.reasoning?.length ?? 0);
    console.log("ops dispatched      :", packet.assistant.ops.length);
    console.log("\n--- model content (arrived as `content`, proving the streaming demotion) ---");
    console.log(packet.assistant.content.slice(0, 800));

    const entries = await (db.test_parser_entries_first as PrepMethod).all<{ scheme: string; pathname: string }>();
    console.log("\n--- entries written ---");
    for (const e of entries) console.log(`  ${e.scheme}://${e.pathname}`);

    // Pass criteria: a real turn landed, the grammar-constrained DSL produced
    // non-empty content (NOT stuck on reasoning_content), and at least one op
    // dispatched. The capital-of-france entry is the semantic check.
    const ok = packet.assistant.content.length > 0 && packet.assistant.ops.length > 0 && (turn?.status ?? 0) >= 100;
    console.log(`\n=== ${ok ? "PASS" : "FAIL"}: grammar-constrained turn through the service on 0.10.0 ===`);
    if (!ok) process.exitCode = 1;
} finally {
    await db.close();
}
