// Is the deepfire grammar actually reaching Fireworks through the service path?
// Replicate the .env.fireflash cascade + Engine grammar resolution, instantiate
// the active provider the way the service does, mock fetch, and inspect the body.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ProviderInstantiate from "./src/core/ProviderInstantiate.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";

process.loadEnvFile(".env.fireflash");
process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

const variant = process.env.PLURNK_PROVIDERS_GBNF;
console.log("PLURNK_PROVIDERS_GBNF:", variant);
let grammar: string | undefined;
if (variant && variant !== "0" && variant !== "") {
    const path = variant.startsWith("/") || variant.startsWith(".")
        ? variant : fileURLToPath(import.meta.resolve(`@plurnk/plurnk-grammar/${variant}`));
    grammar = await readFile(path, "utf8");
}
console.log("grammar loaded:", !!grammar, "len:", grammar?.length, "has <think> rule:", grammar?.includes('think ::= "<think>"'));
console.log("active alias:", JSON.stringify(resolveActiveAlias()));

const provider = await ProviderInstantiate.loadActiveProvider();
if (!provider) throw new Error("no provider");

let sentBody: any = null;
globalThis.fetch = (async (url: string, init: any) => {
    if (String(url).includes("chat/completions")) sentBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "<<SEND[200]:x:SEND" }, finish_reason: "stop" }], usage: { completion_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

await provider.generate({ runId: "verify", messages: [{ role: "user", content: "hi" }], grammar, maxTokens: 100 });

console.log("\n── what the service put on the wire ──");
console.log("model           :", sentBody?.model);
console.log("stream          :", sentBody?.stream ?? "(absent → non-streamed)");
console.log("response_format :", sentBody?.response_format ? `type=${sentBody.response_format.type}, grammar ${String(sentBody.response_format.grammar?.length)} bytes, has <think>: ${sentBody.response_format.grammar?.includes('think ::= "<think>"')}` : "ABSENT — grammar NOT sent");
