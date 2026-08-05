// {§lexicon} The providers-lane standing guard (OpenAI
// lexicon). Retired terms fail CI here, not at the next audit — the mirror of
// core's plurnk-core guard, tuned to what PROVIDERS retired. Scope: src/ non-test
// + SPEC.md. A `lexicon-allow` line marker exempts the shed's own call sites
// (shedRenamed) that must NAME a retired knob to point off it. PLURNK_SERVICE_*
// knobs are CORE's — its own guard polices them; this one stays in-lane.
//
// The `thinking` rule differs from core's on purpose: in the PROVIDER (wire)
// layer, `thinking` is legitimate backend VOCABULARY — anthropic's `thinking`
// wire object, a backend's `thinking` SSE field, gemini's "thinking models"
// brand. So the rule catches OUR-VOICE prose drift while exempting the wire
// forms (a `thinking` object key, a `.thinking` field read, a `thinking` object/
// model reference). Core, a consumer that never speaks the wire, bans it flat.
import test from "node:test";
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const walk = (d: string, a: string[] = []): string[] => {
    for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p, a);
        else if (/\.ts$/.test(e) && !/\.test\./.test(e)) a.push(p);
    }
    return a;
};

// `thinking` as backend wire vocabulary (never our-voice): a wire object key,
// a field read, a backtick-named param, the "thinking object/model" references.
const WIRE_THINKING = /enable_thinking|`thinking`|thinking\s*:|\.thinking\b|thinking (?:model|object)/i;

// Each entry: the banned pattern and the canonical term the violation must become.
const BANNED: Array<{ label: string; re: RegExp; canon: string; exempt?: RegExp }> = [
    { label: "thinking (our-voice)", re: /\bthinking\b/i, canon: "reasoning ({§lexicon})", exempt: WIRE_THINKING },
    { label: "contextSize", re: /\bcontextSize\b/, canon: "contextWindow — the provider window ({§model-fact-resolution})" },
    { label: "retired providers knob", re: /PLURNK_PROVIDERS_(THINKING|LOGPROB\b|CONTEXT_SIZE\b)/, canon: "PLURNK_PROVIDERS_{REASONING,TOP_LOGPROBS,CONTEXT_WINDOW} ({§provider-configuration}) — only the shed may name these" },
    // Catch the retired run/session noun in the wire-header form too (a
    // quoted string, not an identifier — the hole the old `Plurnk-Run-Id` hid in),
    // alongside the coordinate identifiers.
    { label: "run/session (retired noun — coordinate or wire header)", re: /\b(sessionId|runId)\b|Plurnk-(Run|Session)-Id/, canon: "workerId/workspaceId, Plurnk-Worker-Id/Plurnk-Workspace-Id ({§lifecycle-terms})" },
];

test("retired provider terms never reappear in src or SPEC — drift fails CI, not the next audit", () => {
    const files = [...walk(join(ROOT, "src")), join(ROOT, "SPEC.md")];
    const violations: string[] = [];
    for (const f of files) {
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
            if (line.includes("lexicon-allow")) return; // the shed's own regex/error strings + migration notes carry the marker
            for (const { label, re, canon, exempt } of BANNED) {
                if (exempt !== undefined && exempt.test(line)) continue;
                if (re.test(line)) violations.push(`${f.slice(ROOT.length + 1)}:${i + 1} [${label}] → ${canon}`);
            }
        });
    }
    assert.deepEqual(violations, [], `retired lexicon found:\n${violations.join("\n")}`);
});
