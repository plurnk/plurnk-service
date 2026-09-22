// {§recorded-emissions} Build the recorded-emission corpus from drill digests.
//
// Every live/demo drill writes each model turn's exact emission beside the digest that
// recorded what the engine made of it. Those emissions are the only test inputs nobody
// wrote to pass a test: a fixture encodes what we believe a model emits, a recording
// encodes what one did. The suites stayed green through #802 and through #809's weak-rail
// regressions precisely because every fixture was ours.
//
// Volume is not the point — shape coverage is. One real exemplar per distinct parse shape
// covers the contract surface in ~50 KB, against ~88 MB for every emission ever recorded.
//
//   node --conditions=plurnk-dev scriptify/extract-emission-corpus.ts <drill-root> [--write]
//
// The drill root is named, never derived: where a drill writes is the operator's to say
// and `scripts/host-path-policy.mjs` keeps home-directory knowledge in one module.
//
// Without --write it reports what would change, so a drift is visible before it is adopted.
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PlurnkParser } from "../src/index.ts";

export type CorpusRecord = {
    /** Where this emission came from, so any row can be traced back to the run that produced it. */
    readonly specimen: string;
    readonly packet: string;
    /** What the engine did with it when it ran. Provenance, never an assertion: the contract
     *  has changed since, and a recording is evidence of history, not of current law. */
    readonly recordedStatus: number;
    /** How the contract reads it now. This is what the replay asserts. */
    readonly ops: readonly (string | null)[];
    readonly outsideText: boolean;
    readonly bareKills: number;
    /** How many recorded turns shared this shape. A shape seen once and a shape seen four
     *  hundred times are both one row here, and the difference matters when one moves. */
    readonly turns: number;
    readonly emission: string;
};

const TURN = /model turn \d+ · (packet\d+)\): producer=model kind=inference status=(\d+)/u;

export const classify = (emission: string): Pick<CorpusRecord, "ops" | "outsideText" | "bareKills"> => {
    const parsed = PlurnkParser.parse(emission, {});
    const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
    return {
        // A statement the grammar closed without an operation name is kept as null rather
        // than dropped: "the parser produced an op-less statement here" is a fact about the
        // contract, and silently filtering it would hide the shape it belongs to.
        ops: statements.map(({ op }) => op ?? null),
        outsideText: parsed.items.some(({ kind }) => kind === "text"),
        // {§kill-conclusion} — a parameterless KILL is the only completion request.
        bareKills: statements.filter((s) => s.op === "KILL" && s.target === null && s.lineMarker === null
            && s.matcher === null && s.metadata === null).length,
    };
};

// One exemplar per shape; the shape is everything the contract decides about the turn,
// plus the recorded status, so the same program reaching two different dispositions is
// kept as two cases rather than collapsed into one.
const shapeOf = (r: Omit<CorpusRecord, "specimen" | "packet" | "emission" | "turns">): string =>
    JSON.stringify([[...new Set(r.ops)].sort(), r.ops.length, r.outsideText, r.bareKills, r.recordedStatus]);

export const harvest = (root: string): CorpusRecord[] => {
    const chosen = new Map<string, CorpusRecord>();
    const seen = new Map<string, number>();
    for (const specimen of readdirSync(root).sort()) {
        const digest = join(root, specimen, "digest");
        const index = join(digest, "digest.md");
        if (!existsSync(index)) continue;
        for (const line of readFileSync(index, "utf8").split("\n")) {
            const match = TURN.exec(line);
            if (match === null) continue;
            const file = join(digest, `${match[1]!}.assistant.md`);
            if (!existsSync(file)) continue;
            const emission = readFileSync(file, "utf8");
            const record: CorpusRecord = {
                specimen, packet: match[1]!, recordedStatus: Number(match[2]),
                ...classify(emission), turns: 0, emission,
            };
            const shape = shapeOf(record);
            seen.set(shape, (seen.get(shape) ?? 0) + 1);
            // Smallest exemplar wins: the corpus is committed, and a shape is proved by its
            // least verbose witness just as well as by its most.
            const held = chosen.get(shape);
            if (held === undefined || emission.length < held.emission.length) chosen.set(shape, record);
        }
    }
    for (const [shape, record] of chosen) chosen.set(shape, { ...record, turns: seen.get(shape)! });
    return [...chosen.values()].sort((a, b) => a.specimen.localeCompare(b.specimen) || a.packet.localeCompare(b.packet));
};

export const CORPUS = new URL("../test/fixtures/recorded-emissions.jsonl", import.meta.url).pathname;

// The replay suite imports `classify` and `CORPUS` from here, so the CLI runs only when this
// file IS the program. Harvesting walks every drill digest on disk; importing must not.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { values, positionals } = parseArgs({ options: { write: { type: "boolean", default: false } }, allowPositionals: true });
    const root = positionals[0];
    if (root === undefined) throw new Error("name the drill root, e.g. scriptify/extract-emission-corpus.ts ~/benchmarks --write");
    const records = harvest(root);
    const serialized = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const previous = existsSync(CORPUS) ? readFileSync(CORPUS, "utf8") : "";
    const drifted = records.filter((r) => r.recordedStatus === 200 && r.bareKills === 0);
    const driftTurns = drifted.reduce((sum, r) => sum + r.turns, 0);

    console.log(`${records.length} shapes from ${root} (${serialized.length} bytes)`);
    console.log(`${drifted.length} shapes (${driftTurns} recorded turns) concluded when they ran but carry no parameterless KILL: the contract moved beneath them`);
    if (values.write) {
        writeFileSync(CORPUS, serialized);
        console.log(previous === serialized ? "corpus unchanged" : `corpus written to ${CORPUS}`);
    } else if (previous !== serialized) {
        console.log("corpus would change; re-run with --write to adopt");
    }
}
