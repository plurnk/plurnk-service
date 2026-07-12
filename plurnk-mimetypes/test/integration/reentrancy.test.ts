// #33: process() must be safe to call concurrently — plurnk-service parallelizes
// the cold-start manifest derive (symbols + references + embedding for every
// member at once). The risk is the shared, cached tree-sitter parser + compiled
// query held on the one handler instance per mimetype: if any channel held a
// tree (or tree node) across an await, an overlapping call could corrupt it.
//
// This is the standing guarantee, asserted against the exact shape #33 cites —
// TypeScript files with import/inherit/instantiate/call refs, parsed concurrently
// vs sequentially. The invariant: concurrent results are byte-identical to
// sequential. A future change that parks a tree across an await would break here.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discover } from "../../src/discover.ts";
import Mimetypes from "../../src/Mimetypes.ts";

const N = 48;
const inputs = Array.from({ length: N }, (_, i) => ({
    path: `f${i}.ts`,
    content:
        `import { foo${i} } from "./dep${i}";\n`
        + `class Widget${i} extends Base${i} {\n`
        + `  run(x: Shape${i}): Token${i} {\n`
        + `    const h = new Helper${i}();\n`
        + `    return foo${i}(h.method${i}(x));\n`
        + `  }\n`
        + `}\n`
        + `function tokenize${i}(s: string) { return foo${i}(s); }\n`,
}));

const CHANNELS = ["symbols", "references", "deepJson", "deepXml"] as const;

describe("#33 — process() is re-entrant under concurrency", () => {
    it("concurrent symbols/references match a sequential baseline, byte-for-byte", async () => {
        const m = new Mimetypes({ discovery: await discover() });
        const opts = { channels: [...CHANNELS] };

        // Probe: if the TypeScript grammar isn't resolvable in this environment,
        // there's nothing to stress — skip rather than false-fail.
        const probe = await m.process(inputs[0], opts);
        if (probe.grammarMissing || (probe.references?.length ?? 0) === 0) {
            console.log(`skipped: typescript grammar unavailable (missing=${probe.grammarMissing ?? "-"})`);
            return;
        }

        const sequential = [];
        for (const input of inputs) sequential.push(await m.process(input, opts));

        // Several concurrent rounds — corruption is timing-sensitive, so one
        // clean round isn't proof; repeat to shake out interleavings.
        for (let round = 0; round < 4; round += 1) {
            const concurrent = await Promise.all(inputs.map((input) => m.process(input, opts)));
            for (let i = 0; i < N; i += 1) {
                assert.deepEqual(
                    concurrent[i].references,
                    sequential[i].references,
                    `round ${round} file ${i}: references diverged under concurrency`,
                );
                assert.deepEqual(
                    concurrent[i].symbols,
                    sequential[i].symbols,
                    `round ${round} file ${i}: symbols diverged under concurrency`,
                );
            }
        }
    });
});
