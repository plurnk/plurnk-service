/**
 * GBNF contract tests. Two directions:
 *
 * Corpus — every plurnk.md example must be derivable from the GBNF model
 * (dictated generation ⊂ prescribed canon). README examples are NOT corpus:
 * they document the permissive parse layer (word suffixes, dash ranges).
 *
 * Fuzz — seeded random derivations from the model must parse via PlurnkParser
 * with zero errors (L(GBNF) ⊂ L(ANTLR)).
 *
 * The recognizer and sampler below operate on the generator's exported rule
 * model, not on the serialized .gbnf text.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PlurnkParser } from "../../src/index.ts";
import { buildModel, serializeGbnf, type GItem, type GModel, type GSeq } from "../../scriptify/generate-gbnf.ts";

const model = buildModel();

// -------------------------------------------------------------------------
// Recognizer: memoized set-of-end-positions matcher (no left recursion in model)
// -------------------------------------------------------------------------

const inClass = (item: Extract<GItem, { kind: "cls" }>, cp: number): boolean => {
    const hit = item.ranges.some(([a, b]) => cp >= a && cp <= b);
    return item.negate ? !hit : hit;
};

const derives = (entry: string, input: string): boolean => {
    const memo = new Map<string, number[]>();

    const matchItem = (item: GItem, pos: number): number[] => {
        switch (item.kind) {
            case "lit":
                return input.startsWith(item.text, pos) ? [pos + item.text.length] : [];
            case "cls": {
                if (pos >= input.length) return [];
                const cp = input.codePointAt(pos)!;
                return inClass(item, cp) ? [pos + String.fromCodePoint(cp).length] : [];
            }
            case "ref":
                return matchRule(item.name, pos);
            case "rep": {
                const reached = new Set<number>(item.min === 0 ? [pos] : []);
                let frontier = [pos];
                let count = 0;
                while (frontier.length > 0 && count < item.max) {
                    const next = new Set<number>();
                    for (const p of frontier) {
                        for (const q of matchItem(item.item, p)) {
                            if (q > p && !reached.has(q)) next.add(q);
                        }
                    }
                    count++;
                    if (count >= item.min) for (const q of next) reached.add(q);
                    frontier = [...next];
                }
                return [...reached];
            }
        }
    };

    const matchSeq = (seq: GSeq, pos: number): number[] => {
        let positions = [pos];
        for (const item of seq) {
            const next = new Set<number>();
            for (const p of positions) for (const q of matchItem(item, p)) next.add(q);
            positions = [...next];
            if (positions.length === 0) return [];
        }
        return positions;
    };

    const matchRule = (name: string, pos: number): number[] => {
        const key = `${name}:${pos}`;
        const cached = memo.get(key);
        if (cached) return cached;
        memo.set(key, []);
        const rule = model.get(name);
        assert.ok(rule, `GBNF model has no rule named ${name}`);
        const ends = new Set<number>();
        for (const alt of rule) for (const q of matchSeq(alt, pos)) ends.add(q);
        const result = [...ends];
        memo.set(key, result);
        return result;
    };

    return matchRule(entry, 0).includes(input.length);
};

// -------------------------------------------------------------------------
// Sampler: seeded random derivation with a length budget
// -------------------------------------------------------------------------

const mulberry32 = (seed: number): (() => number) => () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Minimum derivation length per rule, for budget-exhausted alternative choice.
const minLens = (() => {
    const lens = new Map<string, number>([...model.keys()].map((k) => [k, Infinity]));
    const itemMin = (item: GItem): number => {
        switch (item.kind) {
            case "lit": return item.text.length;
            case "cls": return 1;
            case "ref": return lens.get(item.name)!;
            case "rep": return item.min * itemMin(item.item);
        }
    };
    let changed = true;
    while (changed) {
        changed = false;
        for (const [name, alts] of model) {
            const next = Math.min(...alts.map((seq) => seq.reduce((sum, item) => sum + itemMin(item), 0)));
            if (next < lens.get(name)!) { lens.set(name, next); changed = true; }
        }
    }
    return lens;
})();

const SAMPLE_POOL = [...Array.from({ length: 0x7F - 0x20 }, (_, i) => 0x20 + i), 0x0A];

const sample = (entry: string, rng: () => number): string => {
    let budget = 240;
    const sampleSeq = (seq: GSeq): string => seq.map(sampleItem).join("");
    const sampleItem = (item: GItem): string => {
        switch (item.kind) {
            case "lit":
                budget -= item.text.length;
                return item.text;
            case "cls": {
                budget -= 1;
                const pool = item.negate
                    ? SAMPLE_POOL.filter((cp) => inClass(item, cp))
                    : item.ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a + i));
                return String.fromCodePoint(pool[Math.floor(rng() * pool.length)]);
            }
            case "ref": {
                const alts = model.get(item.name)!;
                const seqMin = (seq: GSeq): number => seq.reduce((sum, it) => {
                    if (it.kind === "ref") return sum + minLens.get(it.name)!;
                    if (it.kind === "rep") return sum + (it.min === 0 ? 0 : seqMin([it.item]));
                    return sum + (it.kind === "lit" ? it.text.length : 1);
                }, 0);
                const pick = budget <= 0
                    ? alts.toSorted((a, b) => seqMin(a) - seqMin(b))[0]
                    : alts[Math.floor(rng() * alts.length)];
                return sampleSeq(pick);
            }
            case "rep": {
                let count = item.min;
                while (count < item.max && budget > 0 && rng() < 0.6) count++;
                return Array.from({ length: count }, () => sampleItem(item.item)).join("");
            }
        }
    };
    return sampleSeq([{ kind: "ref", name: entry }]);
};

// -------------------------------------------------------------------------
// Corpus: plurnk.md examples derive from root
// -------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plurnkMd = readFileSync(join(repoRoot, "plurnk.md"), "utf8");

// The root encodes the turn shape (#29): ops closed by exactly one SEND. The
// teaching corpus is not a turn (it ends with three SEND variants), so corpus
// derivability is asserted per-statement; the turn shape is asserted separately.
test("GBNF: every plurnk.md example derives from statement", () => {
    const headingMatch = /^## Examples\s*$/m.exec(plurnkMd);
    assert.ok(headingMatch, "plurnk.md is missing its `## Examples` section");
    const rest = plurnkMd.substring(headingMatch.index + headingMatch[0].length);
    const nextHeading = /^## /m.exec(rest);
    const block = rest.substring(0, nextHeading ? nextHeading.index : rest.length).trim();

    const result = PlurnkParser.parse(block);
    const statements = result.items.filter((item) => item.kind === "statement");
    assert.ok(statements.length > 0, "no statements extracted from the examples block");
    const lines = block.split("\n");
    const offsetOf = (line: number, column: number): number =>
        lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + column;
    for (let i = 0; i < statements.length; i++) {
        const start = offsetOf(statements[i].statement.position.line, statements[i].statement.position.column);
        const next = statements[i + 1];
        const end = next ? offsetOf(next.statement.position.line, next.statement.position.column) : block.length;
        const text = block.slice(start, end).trim();
        assert.equal(derives("statement", text), true, `example not GBNF-derivable: ${JSON.stringify(text)}`);
    }
});

test("GBNF: root accepts a batch of ops closed by a final status SEND", () => {
    const batch = "<<EDIT[france](known://capital.md):Paris:EDIT\n\n<<FOLD(log://**/get)<1,10>::FOLD\n<<SEND[200]:Paris:SEND\n";
    assert.equal(derives("root", batch), true);
});

test("GBNF: root accepts a bare status-SEND turn", () => {
    assert.equal(derives("root", "<<SEND[102]:still working:SEND"), true);
});

test("GBNF: root accepts mid-batch SENDs (targeted; pathless non-status) before the final", () => {
    const batch = "<<SEND[102](agent://supervisor):decomposition complete:SEND\n<<SEND[400]:{\"reason\":\"bad op\"}:SEND\n<<SEND[200]:done:SEND";
    assert.equal(derives("root", batch), true);
});

test("GBNF: root rejects a batch with no final status SEND", () => {
    assert.equal(derives("root", "<<EDIT(known://a.md):x:EDIT"), false);
    assert.equal(derives("root", "<<EDIT(known://a.md):x:EDIT\n<<SEND[400]:err:SEND"), false);
});

test("GBNF: root rejects a targeted SEND as the turn closer", () => {
    assert.equal(derives("root", "<<SEND[200](agent://supervisor):done:SEND"), false);
});

test("GBNF: root rejects any statement after the final status SEND", () => {
    const after = "<<SEND[200]:done:SEND\n<<EDIT(known://a.md):x:EDIT\n<<SEND[200]:again:SEND";
    assert.equal(derives("root", after), false);
});

test("GBNF: PLAN derives bare and sits mid-batch only", () => {
    assert.equal(derives("statement", "<<PLAN:think first, then act:PLAN"), true);
    assert.equal(derives("statement", "<<PLAN[tagged]:thoughts:PLAN"), false); // dictated form is slotless
    assert.equal(derives("root", "<<PLAN:reason:PLAN\n<<SEND[102]:working:SEND"), true);
    assert.equal(derives("root", "<<SEND[102]:working:SEND\n<<PLAN:reason:PLAN"), false); // nothing follows the status SEND
    assert.equal(derives("root", "<<PLAN:reason:PLAN"), false); // a turn still needs its status SEND
});

test("GBNF: root rejects two consecutive status SENDs", () => {
    assert.equal(derives("root", "<<SEND[102]:a:SEND\n<<SEND[200]:b:SEND"), false);
});

test("GBNF: digit-suffixed statement quoting an inner op derives", () => {
    const quoted = "<<EDIT1(known://demo):\nquoted: <<EDIT(known://inner):hello:EDIT\n:EDIT1";
    assert.equal(derives("statement", quoted), true);
});

// -------------------------------------------------------------------------
// Canon boundaries: parse-side-only forms must NOT derive
// -------------------------------------------------------------------------

test("GBNF: word suffix is parse-side only — not derivable", () => {
    assert.equal(derives("statement", "<<EDITouter(known://demo):x:EDITouter"), false);
});

test("GBNF: dash line-marker separator is parse-side only — not derivable", () => {
    assert.equal(derives("statement", "<<READ(a.md)<1-5>::READ"), false);
});

test("GBNF: SEND signal must be three digits", () => {
    assert.equal(derives("statement", "<<SEND[20]:x:SEND"), false);
    assert.equal(derives("statement", "<<SEND[200]:x:SEND"), true);
});

test("GBNF: READ without a target is not derivable", () => {
    assert.equal(derives("statement", "<<READ:x:READ"), false);
});

test("GBNF: unsuffixed body cannot contain its own close literal", () => {
    const collision = "<<EDIT(known://demo):quoted: <<EDIT(known://inner):hello:EDIT\n:EDIT";
    assert.equal(derives("statement", collision), false);
});

// -------------------------------------------------------------------------
// Fuzz: L(GBNF) ⊂ L(ANTLR)
// -------------------------------------------------------------------------

test("GBNF: 100 seeded random turn batches parse cleanly and end in SEND", () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 100; i++) {
        const turn = sample("root", rng);
        const result = PlurnkParser.parse(turn);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 0, `batch ${i} produced parse errors\nbatch: ${JSON.stringify(turn)}`);
        assert.ok(statements.length >= 1, `batch ${i} produced no statements`);
        assert.equal(result.unparsedTail, undefined, `batch ${i} left an unparsed tail`);
        const last = statements.at(-1)!;
        assert.ok(last.kind === "statement", `batch ${i} last item is not a statement`);
        if (last.kind !== "statement") continue;
        assert.equal(last.statement.op, "SEND", `batch ${i} does not end in SEND\nbatch: ${JSON.stringify(turn)}`);
        assert.equal(last.statement.target, null, `batch ${i} final SEND has a target\nbatch: ${JSON.stringify(turn)}`);
        assert.ok(
            last.statement.signal === 102 || last.statement.signal === 200,
            `batch ${i} final SEND signal is ${last.statement.signal}, not 102/200\nbatch: ${JSON.stringify(turn)}`,
        );
    }
});

test("GBNF: 300 seeded random derivations all parse cleanly", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 300; i++) {
        const sentence = sample("statement", rng);
        const result = PlurnkParser.parse(sentence);
        const statements = result.items.filter((item) => item.kind === "statement");
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(
            errors.length, 0,
            `sample ${i} produced parse errors: ${errors.map((e) => e.kind === "error" ? e.error.message : "").join(" | ")}\nsample: ${JSON.stringify(sentence)}`,
        );
        assert.equal(statements.length, 1, `sample ${i} produced ${statements.length} statements\nsample: ${JSON.stringify(sentence)}`);
        assert.equal(result.unparsedTail, undefined, `sample ${i} left an unparsed tail\nsample: ${JSON.stringify(sentence)}`);
    }
});

// -------------------------------------------------------------------------
// Serialization sanity
// -------------------------------------------------------------------------

test("GBNF: serialized grammar has a root rule and every ref is defined", () => {
    const text = serializeGbnf(model);
    assert.match(text, /^root ::= /m);
    const collectRefs = (item: GItem): string[] => {
        if (item.kind === "ref") return [item.name];
        if (item.kind === "rep") return collectRefs(item.item);
        return [];
    };
    for (const [name, alts] of model) {
        for (const refName of alts.flat().flatMap(collectRefs)) {
            assert.ok(model.has(refName), `rule ${name} references undefined rule ${refName}`);
        }
    }
});
