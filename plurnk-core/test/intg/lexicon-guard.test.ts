// {§lexicon} → [§lexicon] (#477, #472, #486) — the standing guard: retired and misleading terms
// fail CI here, not the next audit. TWO STANDARDS BY LAYER: the operator/wire/storage layers
// follow the industry lexicon (OpenAI where the concept is standard); the MODEL-FACING packet
// follows the training distribution (ops mirror HTTP/shell, display mirrors CSS) and is OUT OF
// SCOPE for this guard — renaming packet vocabulary to API-speak would trade the resonance the
// plurnkdown razor is built on for a standard the model never sees at that layer.
//
// Scope: src/ non-test + SPEC.md. Test files may QUOTE retired words (retired-list tests,
// parsing fixtures — quotations are not usages); the shed code names retired knobs inside
// its own regex/error strings, which the scanner's line-level allow markers exempt.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const walk = (d: string, a: string[] = []): string[] => {
    for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, a);
        else if (/\.(ts|sql)$/.test(e) && !/\.test\./.test(e)) a.push(p);
    }
    return a;
};

// Each entry: the banned pattern and the canonical term the violation must become.
const BANNED: Array<{ label: string; re: RegExp; canon: string }> = [
    { label: "thinking", re: /\bthinking\b/i, canon: "reasoning (the #472 lexicon ruling)" },
    { label: "session (noun)", re: /\bsessions?\b/i, canon: "workspace — retired EMPTY by #486; never reuse" },
    { label: "contextSize", re: /contextSize/, canon: "contextWindow (the provider window) or promptBudget (the derived denominator) — #472/#481" },
    { label: "decodeBudget", re: /decodeBudget/, canon: "maxTokensFor — it IS the standard max_tokens concept (#477)" },
    { label: "usage_context_size", re: /usage_context_size/, canon: "usage_prompt_budget (#477)" },
    { label: "retired partition knobs", re: /PLURNK_SERVICE_(CTX|ASSISTANT|CONTEXT_WINDOW|REASONING(?!_)|COMPLETION)/, canon: "PLURNK_PROVIDERS_{CONTEXT_WINDOW,REASONING_RESERVE,COMPLETION_RESERVE} (#507) — only the shed may name these" },
    // #511 — QUOTED WIRE STRINGS are lexicon too: the endpoint agent caught `Plurnk-Run-Id` shipping
    // a workerId under the retired noun, invisible to identifier-shaped bans. Exact-string bans only
    // (the run noun is unguardable as a word — verbs are legal); extend per retired wire name.
    { label: "retired wire header", re: /Plurnk-Run-Id/, canon: "Plurnk-Worker-Id (#486/#511)" },
];

test("retired terms never reappear in src or SPEC — drift fails CI, not the next audit", () => {
    const files = [...walk(join(ROOT, "src")), join(ROOT, "SPEC.md")];
    const violations: string[] = [];
    for (const f of files) {
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((line, i) => {
            if (line.includes("lexicon-allow")) return; // the shed's own regex/error strings carry the marker
            for (const { label, re, canon } of BANNED) {
                if (re.test(line)) violations.push(`${f.slice(ROOT.length + 1)}:${i + 1} [${label}] → ${canon}`);
            }
        });
    }
    assert.deepEqual(violations, [], `retired lexicon found:\n${violations.join("\n")}`);
});
