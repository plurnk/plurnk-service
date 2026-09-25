import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Results } from "@plurnk/plurnk-schemes";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { AnchoredReadResult } from "../../src/content/read-projector.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";

const statements = (program: string) => PlurnkParser.parse(program).items.map((item) => {
    assert.equal(item.kind, "statement", program);
    if (item.kind !== "statement") throw new Error("Expected an operation");
    return item.statement;
});

const runtime = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const env = await seedEnvelope(db, `context-anchors-${crypto.randomUUID()}`);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    let sequence = 0;
    const run = (program: string) => {
        const ops = statements(program);
        assert.equal(ops.length, 1);
        return engine.dispatch({ ...env, statement: ops[0]!, sequence: ++sequence, origin: "model" });
    };
    const batch = (program: string) => {
        const ops = statements(program);
        const fromSequence = sequence + 1;
        sequence += ops.length;
        return engine.executeAdmittedTurn({ ...env, statements: ops, source: null, fromSequence, origin: "model" });
    };
    const read = async (path: string, scope = "1,-1") =>
        Results.assertReadResult(await run(`\`\`\`READ (${path}) <${scope}>\n\`\`\``)) as AnchoredReadResult;
    const write = (path: string, body: string, scope = "") => run(`\`\`\`EDIT (${path}) ${scope}\n${body}\n\`\`\``);
    return { run, batch, read, write };
};

const repeated = (body: string) => {
    const block = (label: string) => [label, "before-2", "before-1", body, "after-1", "after-2", `end-${label}`];
    return [
        ...Array.from({ length: 10 }, (_, i) => `head-${i}`),
        ...block("a"), ...block("b"),
        ...Array.from({ length: 10 }, (_, i) => `tail-${i}`),
    ];
};

for (const op of ["EDIT", "KILL", "COPY", "MOVE"] as const) {
    test(`{§line-anchor-disambiguation}: ${op} uses contextual READ handles after a separate operation shifts the resource`, async (t) => {
        const { run, read, write } = await runtime(t);
        const source = "worker:///source.md";
        const destination = "worker:///destination.md";
        const sourceLines = repeated("source-target");
        const destinationLines = repeated("destination-target");
        const selected = sourceLines.indexOf("source-target");
        const other = sourceLines.lastIndexOf("source-target");
        assert.equal((await write(source, sourceLines.join("\n"))).status, 201);
        assert.equal((await write(destination, destinationLines.join("\n"))).status, 201);
        const full = await read(source);
        assert.notEqual(full.lineAnchors![selected], full.lineAnchors![other]);
        const slice = await read(source, String(selected + 1));
        assert.equal(slice.content, "source-target");
        const anchor = slice.lineAnchors![0]!;
        assert.equal(anchor, full.lineAnchors![selected], "scope does not discard the distinguishing context");
        const destinationAnchor = (await read(destination, String(other + 1))).lineAnchors![0]!;

        assert.equal((await write(source, "prefix\nhead-0", "<1>")).status, 200);
        assert.equal((await write(destination, "prefix\nhead-0", "<1>")).status, 200);
        assert.equal((await read(source, anchor)).content, "source-target");
        const program = op === "EDIT"
            ? `\`\`\`EDIT (${source}) <${anchor}>\nchanged\n\`\`\``
            : op === "KILL"
                ? `\`\`\`KILL (${source}) <${anchor}>\n\`\`\``
                : `\`\`\`${op} (${source}) <${anchor}> (${destination}) <${destinationAnchor}>\n\`\`\``;
        const result = await run(program);
        assert.equal(result.status, 200, JSON.stringify(result));

        const expectedSource = ["prefix", ...sourceLines];
        const expectedDestination = ["prefix", ...destinationLines];
        if (op === "EDIT") expectedSource[selected + 1] = "changed";
        if (op === "KILL" || op === "MOVE") expectedSource.splice(selected + 1, 1);
        if (op === "COPY" || op === "MOVE") expectedDestination[other + 1] = "source-target";
        assert.equal((await read(source)).content, expectedSource.join("\n"), "only the selected copy is changed or removed");
        assert.equal((await read(destination)).content, expectedDestination.join("\n"), "the destination independently resolves its contextual anchor");
    });
}

test("{§line-anchor-disambiguation}: changed extended context refuses EDIT without changing either twin", async (t) => {
    const { read, write, run } = await runtime(t);
    const path = "worker:///stale.md";
    const lines = repeated("target");
    const target = lines.indexOf("target");
    assert.equal((await write(path, lines.join("\n"))).status, 201);
    const anchor = (await read(path, String(target + 1))).lineAnchors![0]!;
    assert.equal((await write(path, "changed section", `<${target - 2}>`)).status, 200);
    const changed = lines.with(target - 3, "changed section").join("\n");
    const refused = await run(`\`\`\`EDIT (${path}) <${anchor}>\nwrong\n\`\`\``);
    assert.equal(refused.status, 409);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
    assert.equal(refused.problem?.retryable, false);
    assert.equal((await read(path)).content, changed);
    const current = (await read(path, String(target + 1))).lineAnchors![0]!;
    assert.notEqual(current, anchor);
    assert.equal((await run(`\`\`\`EDIT (${path}) <${current}>\ncorrect\n\`\`\``)).status, 200);
    assert.equal((await read(path)).content, lines.with(target - 3, "changed section").with(target, "correct").join("\n"));
});

test("{§edit-anchor-continuity}: introducing a twin in one program retains the original binding through real EDIT dispatch", async (t) => {
    const { read, write, batch } = await runtime(t);
    const path = "worker:///continuity.md";
    assert.equal((await write(path, "one\ntwo\nthree\nfour\nfive\nsix")).status, 201);
    const anchor = (await read(path, "3")).lineAnchors![0]!;
    const result = await batch(`\`\`\`EDIT (${path}) <6>
six
one
two
three
four
five
\`\`\`

\`\`\`EDIT (${path}) <${anchor}>
THREE
\`\`\``);
    assert.deepEqual(result.outcomes.map(({ status }) => status), [200, 200]);
    assert.equal((await read(path)).content, "one\ntwo\nTHREE\nfour\nfive\nsix\none\ntwo\nthree\nfour\nfive");
});
