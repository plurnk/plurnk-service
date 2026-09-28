// {§digest-edit-census} (#893) — the recorded-packet replay. The fixture is run6's T13 packet from
// the django-15819 K3 rollout (the packet on which K3 picked the hash of line 136 for line 135),
// sent as recorded, with one arrival appended asking for exactly the edit the model made. Every
// READ row is re-rendered under one of the row forms below before sending; today's row form is F.
// A paid experiment, never a test: run from plurnk-core with a declared alias.
// usage: node --conditions=plurnk-dev test/replay/hash-replay-recorded.mjs <alias> <samplesPerCard> <concurrency> <out.jsonl> [renderings=A] [cards=old,new]
import { readFileSync, appendFileSync } from "node:fs";
import { loadActiveProvider } from "@plurnk/plurnk-providers";
import { resolve } from "node:path";

const [alias, samplesArg, concurrencyArg, out, renderingsArg = "A", cardsArg = "old,new"] = process.argv.slice(2);
const samples = Number(samplesArg ?? 6);
const concurrency = Number(concurrencyArg ?? 3);
process.loadEnvFile(`${process.env.HOME}/.config/plurnk/.env`);
const provider = await loadActiveProvider({ ...process.env, PLURNK_MODEL: alias });

const FIXTURE = resolve(import.meta.dirname, "fixtures", "run6-django-15819-kmax-T13");
const CARDS = {
    old: readFileSync(`${FIXTURE}.system.md`, "utf8"),
    new: readFileSync(resolve(import.meta.dirname, "../../../plurnk-contracts/plurnk.md"), "utf8"),
};
const recorded = readFileSync(`${FIXTURE}.user.md`, "utf8");
// The task, as one more arrival at the end of the log, before the packet's closing sections.
const task = "In django/core/management/commands/inspectdb.py, replace the line `column_to_field_name = {}  # Maps column names to names of model fields` with the same line followed by a new line `used_relations = set()  # Holds foreign keys used in the table.` (same indentation). One EDIT, nothing else this turn.";
const marker = "\n## Worker\n";
const at = recorded.indexOf(marker);
if (at < 0) throw new Error("recorded packet has no Worker section");
const RENDER = {
    A: (line) => line,
    B: (line) => line.replace(/^@([0-9A-Za-z]{5}) +(\d+):/u, (_, h, n) => `${n.padStart(3)} @${h}:`),
    C: (line) => { const m = /^@([0-9A-Za-z]{5}) +(\d+):(.*)$/u.exec(line); return m ? `${m[2].padStart(3)}:${m[3]}  \u2190 @${m[1]}` : line; },
    // The trailing hash as the scope the EDIT will take, and bare.
    D: (line) => { const m = /^@([0-9A-Za-z]{5}) +(\d+):(.*)$/u.exec(line); return m ? `${m[2].padStart(3)}:${m[3]}  <@${m[1]}>` : line; },
    E: (line) => { const m = /^@([0-9A-Za-z]{5}) +(\d+):(.*)$/u.exec(line); return m ? `${m[2].padStart(3)}:${m[3]}  @${m[1]}` : line; },
    // The operator's form: the scope literal is the delimiter; the document starts right after it.
    F: (line) => { const m = /^@([0-9A-Za-z]{5}) +(\d+):(.*)$/u.exec(line); return m ? `${m[2].padStart(3)}<@${m[1]}>${m[3]}` : line; },
    // The symmetric row: the scope literal opens and closes the text, the number outside both.
    G: (line) => { const m = /^@([0-9A-Za-z]{5}) +(\d+):(.*)$/u.exec(line); return m ? `${m[2].padStart(3)}<@${m[1]}>${m[3]}<@${m[1]}>${m[2]}` : line; },
    // The operator's uniform grammar: number and anchor in the opening bracket, the number alone closing.
    H: (line) => { const m = /^@([0-9A-Za-z]{5}) +(\d+):(.*)$/u.exec(line); return m ? `<${m[2].padStart(3)}@${m[1]}>${m[3]}<${m[2]}>` : line; },
    // The operator's leanest form: the scope literal opens, the number closes; a read-only row would be bare text with the closer.
    I: (line) => { const m = /^@([0-9A-Za-z]{5}) +(\d+):(.*)$/u.exec(line); return m ? `<@${m[1]}>${m[3]}<${m[2]}>` : line; },
};
const packetFor = (rendering) => {
    const body = recorded.slice(0, at).split("\n").map(RENDER[rendering]).join("\n");
    return `${body}\n### log:///1/12/9/SEND · 80\n{"lines":1,"origin":"user","resource":"message://caf7e8bb/probe","status":200}\n 1:${task}\n${recorded.slice(at)}`;
};

// The rows as the packet renders them: hash → line.
const hashLine = new Map();
for (const line of recorded.split("\n")) { const m = /^@([0-9A-Za-z]{5}) +(\d+):/u.exec(line); if (m) hashLine.set(m[1], Number(m[2])); }
const INTENDED = 135;
const score = (content) => {
    // A local constrained model emits the op line without its fence; a pattern EDIT carries no scope.
    const m = /(?:^|\n)`{0,4}EDIT\s*\([^)]*\)\s*<([^>]*)>/u.exec(content);
    if (!m) {
        const pattern = /(?:^|\n)`{0,4}EDIT\s*\([^)]*\)\s*\/(.+?)\/[^\n]*\n/u.exec(content);
        if (pattern) return { kind: "pattern", marks: null, pattern: pattern[1].slice(0, 80) };
        return { kind: "no-edit-scope", marks: null };
    }
    const marks = m[1].split(",").map((s) => s.trim());
    const lines = marks.filter((s) => s.startsWith("@")).map((s) => hashLine.get(s.slice(1)) ?? null);
    if (lines.length === 0) return { kind: "numeric", marks };
    const first = lines[0];
    if (first === null) return { kind: "unknown-hash", marks };
    return { kind: first === INTENDED ? "exact" : first === INTENDED + 1 ? "N+1" : first === INTENDED - 1 ? "N-1" : "other", marks, lines };
};

const cells = [];
for (const rendering of renderingsArg.split(",")) for (const card of cardsArg.split(",")) for (let i = 0; i < samples; i += 1) cells.push({ rendering, card, i });
let next = 0;
const worker = async () => {
    while (next < cells.length) {
        const cell = cells[next++];
        const messages = [{ role: "system", content: CARDS[cell.card] }, { role: "user", content: packetFor(cell.rendering) }];
        const t0 = Date.now();
        let result;
        try {
            const r = await provider.generate({ workerId: `recorded-${cell.rendering}-${cell.card}-${cell.i}`, messages });
            const content = r.assistant?.content ?? "";
            const usage = r.accounting?.[0]?.usage ?? {};
            result = { ...score(content), seconds: Math.round((Date.now() - t0) / 1000), inputTokens: usage.inputTokens ?? null, reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? null, head: content.slice(0, 200) };
        } catch (error) {
            result = { kind: "error", error: String(error).slice(0, 200) };
        }
        const row = { alias, rendering: cell.rendering, card: cell.card, i: cell.i, ...result };
        appendFileSync(out, `${JSON.stringify(row)}\n`);
        console.log(JSON.stringify(row).slice(0, 200));
    }
};
await Promise.all(Array.from({ length: concurrency }, worker));
console.log("done");
