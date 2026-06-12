// Would the model reason INSIDE a grammar-legal DSL body (PLAN-style op)
// under the eager mask, with native thinking suppressed? Stand-in: SEND[100]
// body as the "plan" channel, since GBNF statement bodies are free text.
import { readFileSync } from "node:fs";

const BASE = "http://127.0.0.1:11435";
const grammar = readFileSync("../plurnk-service/node_modules/@plurnk/plurnk-grammar/dist/plurnk.gbnf", "utf8");

const ask = "Compute 17*23 minus the number of letters in the word 'plurnk'.";

const run = async (label, userContent) => {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages: [{ role: "user", content: userContent }],
            max_tokens: 600,
            temperature: 0,
            grammar,
            repeat_penalty: 1.15,
        }),
        signal: AbortSignal.timeout(120_000),
    });
    const j = await res.json();
    const m = j.choices[0].message;
    console.log(`${label}: ${Date.now() - t0}ms finish=${j.choices[0].finish_reason} reasoning=${(m.reasoning_content ?? "").length}B`);
    console.log((m.content ?? "").slice(0, 700));
    console.log("─".repeat(60));
};

await run("direct (no plan channel)", `${ask} Deliver the answer with a SEND statement.`);
await run("PLAN-style first body  ", `${ask}
First emit <<SEND[100]:...:SEND whose body is your private step-by-step reasoning (work the arithmetic out loud there).
Then emit <<SEND[200]:...:SEND whose body is ONLY the final number.`);
