// Why isn't GBNF happening on gemma? Replicate the service path: resolve the
// grammar like Engine, instantiate the active provider (real probe against the
// local llama-server), and inspect exactly what it puts on the wire.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ProviderInstantiate from "./src/core/ProviderInstantiate.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";

process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

console.log("alias                :", JSON.stringify(resolveActiveAlias()));
console.log("PLURNK_PROVIDERS_GBNF :", JSON.stringify(process.env.PLURNK_PROVIDERS_GBNF));
console.log("REASONING_BUDGET     :", process.env.PLURNK_PROVIDERS_REASONING_BUDGET);

// resolve the grammar exactly like Engine.#grammarConstraint
const variant = process.env.PLURNK_PROVIDERS_GBNF;
let grammar: string | undefined;
if (variant && variant !== "" && variant !== "0") {
    try {
        const path = variant.startsWith("/") || variant.startsWith(".")
            ? variant : fileURLToPath(import.meta.resolve(`@plurnk/plurnk-grammar/${variant}`));
        grammar = await readFile(path, "utf8");
        console.log("grammar resolved     :", path.split("/").pop(), `${grammar.length} bytes`);
    } catch (e: any) { console.log("grammar resolution FAILED:", e.message); }
} else console.log("grammar DISABLED (GBNF unset/empty/0)");

const provider = await ProviderInstantiate.loadActiveProvider();
if (!provider) throw new Error("no provider");
console.log("provider model       :", (provider as any).model, "| contextSize:", provider.contextSize);

let body: any = null;
globalThis.fetch = (async (url: string, init: any) => {
    if (String(url).includes("chat/completions")) body = JSON.parse(init.body);
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]")); c.close(); } }), { status: 200 });
}) as typeof fetch;

await provider.generate({ runId: "d", messages: [{ role: "user", content: "hi" }], grammar, maxTokens: 50 });

console.log("\n── what gemma put on the wire ──");
console.log("grammar (llamacpp top-level) :", body?.grammar ? `PRESENT (${String(body.grammar.length)}b)` : "ABSENT  ← GBNF not happening");
console.log("repeat_penalty               :", body?.repeat_penalty);
console.log("response_format              :", body?.response_format ? "present" : "absent");
console.log("chat_template_kwargs (reason):", JSON.stringify(body?.chat_template_kwargs));
console.log("think                        :", body?.think);
