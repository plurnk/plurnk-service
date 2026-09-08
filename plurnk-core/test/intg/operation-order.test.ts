import { TurnDisposition } from "@plurnk/plurnk-contracts";
import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import Turn from "../../src/core/Turn.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import { openMigrated, seedEnvelope } from "./_helpers.ts";
import { rpcCall, connect, withDaemon, makeMockResponse, runLoopToTerminal } from "./_rpc.ts";

const target = "worker:///ordered.md";
const content = "one\ntwo\nthree\nfour\nfive\nsix";
const anchors = LineAnchors.tokens(target, content);
const cases = [
    {
        name: "READs observe the state at their authored position, not a future EDIT",
        ops: [`\`\`\`READ (${target}) <1,-1>\`\`\``, `\`\`\`EDIT (${target}) <2>
TWO
extra
\`\`\``, `\`\`\`READ (${target}) <1,-1>\`\`\``, `\`\`\`EDIT (${target}) <4>
THREE
\`\`\``, `\`\`\`READ (${target}) <1,-1>\`\`\``],
        order: ["READ", "EDIT", "READ", "EDIT", "READ"],
        reads: [content, "one\nTWO\nextra\nthree\nfour\nfive\nsix", "one\nTWO\nextra\nTHREE\nfour\nfive\nsix"],
        statuses: [200, 200],
    },
    {
        name: "an EDIT can create a resource and a later EDIT can change it in the same turn",
        ops: ["```EDIT (worker:///new.md)\nalpha\nbeta\n```", "```EDIT (worker:///new.md) <2>\nBETA\n```", "```READ (worker:///new.md) <1,-1>```"],
        order: ["EDIT", "EDIT", "READ"],
        reads: ["alpha\nBETA"],
        statuses: [201, 200],
    },
    {
        name: "an invalid EDIT does not roll back an earlier effect or suppress a later one",
        ops: [`\`\`\`EDIT (${target}) <1>
ONE
\`\`\``, `\`\`\`EDIT (${target}) <99>
invalid
\`\`\``, `\`\`\`EDIT (${target}) <2>
TWO
\`\`\``, `\`\`\`READ (${target}) <1,-1>\`\`\``],
        order: ["EDIT", "EDIT", "EDIT", "READ"],
        reads: ["ONE\nTWO\nthree\nfour\nfive\nsix"],
        statuses: [200, 416, 200],
    },
    {
        name: "a surviving hash follows its target through an adjacent numeric insertion",
        ops: [`\`\`\`EDIT (${target}) <0>
prefix
\`\`\``, `\`\`\`READ (${target}) <1,-1>\`\`\``, `\`\`\`EDIT (${target}) <${anchors[1]}>
TWO
\`\`\``, `\`\`\`READ (${target}) <1,-1>\`\`\``],
        order: ["EDIT", "READ", "EDIT", "READ"],
        reads: [`prefix\n${content}`, "prefix\none\nTWO\nthree\nfour\nfive\nsix"],
        statuses: [200, 200],
    },
    {
        name: "an overwritten hash target is not rebound to replacement content",
        ops: [`\`\`\`EDIT (${target}) <${anchors[1]}>
replacement
\`\`\``, `\`\`\`EDIT (${target}) <${anchors[1]}>
wrong
\`\`\``, `\`\`\`READ (${target}) <1,-1>\`\`\``],
        order: ["EDIT", "EDIT", "READ"],
        reads: ["one\nreplacement\nthree\nfour\nfive\nsix"],
        statuses: [200, 409],
    },
    {
        name: "an untouched hash range survives a preceding scoped entry KILL",
        ops: [`\`\`\`KILL (${target}) <1>\`\`\``, `\`\`\`EDIT (${target}) <${anchors[2]},${anchors[3]}>
THREE
FOUR
\`\`\``, `\`\`\`READ (${target}) <1,-1>\`\`\``],
        order: ["KILL", "EDIT", "READ"],
        reads: ["two\nTHREE\nFOUR\nfive\nsix"],
        statuses: [200],
    },
];

for (const fixture of cases) test(`{§op-execution-order}: ${fixture.name}`, async () => {
    const mock = new Mock({ contextWindow: 32768, responses: [
        makeMockResponse(`\`\`\`EDIT (${target})
${content}
\`\`\`
\`\`\`NEXT
created
\`\`\``, 10),
        makeMockResponse(`${fixture.ops.join("\n")}
\`\`\`NEXT
verify
\`\`\``, 10),
        makeMockResponse("```DONE\ndone\n```", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "ordered" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "run", policy: { proposals: "accept" } });
            assert.equal(result.finalStatus, 200);
            const rows = (await db.test_log_entries_by_loop.all<{ op: string; origin: string; rx: string }>({ loop_id: result.loopId }))
                .filter(({ origin, op }) => origin === "model" && op !== "SEND" && op !== "PLAN" && !TurnDisposition.isOp(op)).slice(1);
            assert.deepEqual(rows.map(({ op }) => op), fixture.order);
            assert.deepEqual(rows.filter(({ op }) => op === "READ").map(({ rx }) => JSON.parse(rx).content), fixture.reads);
            assert.deepEqual(rows.filter(({ op }) => op === "EDIT").map(({ rx }) => JSON.parse(rx).status), fixture.statuses);
        } finally { ws.close(); }
    });
});

for (const origin of ["client", "_plurnk"] as const) {
    for (const failOnOperationError of [false, true]) test(`{§op-execution-order}: ${origin} preserves effects and source with failOnOperationError=${failOnOperationError}`, async () => {
        const db = await openMigrated();
        try {
            const env = await seedEnvelope(db, `ordered-${origin}`, { producer: origin });
            env.turnId = (await Turn.open(db, { loopId: env.loopId, producer: origin, kind: "operation" })).id;
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            const source = `\`\`\`PLAN
[]
\`\`\`
\`\`\`EDIT (${target})
${content}
\`\`\`
\`\`\`READ (${target}) <1,-1>\`\`\`
\`\`\`EDIT (${target}) <99>
invalid
\`\`\`
\`\`\`EDIT (${target}) <2>
TWO
\`\`\`
\`\`\`NEXT\`\`\``;
            const execution = engine.executeAdmittedTurn({
                ...env, origin, source, sourceFolded: true, statements: TurnOps.parseInternal(source),
                fromSequence: 1, failOnOperationError,
            });
            if (failOnOperationError) await assert.rejects(execution, OperationFailureError);
            else assert.equal((await execution).status, 102);
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: env.turnId });
            assert.deepEqual(rows.filter(({ op }) => op !== null).map(({ op }) => op),
                failOnOperationError ? ["PLAN", "EDIT", "READ", "EDIT"] : ["PLAN", "EDIT", "READ", "EDIT", "EDIT", "NEXT"]);
            assert.equal(JSON.parse(rows.find(({ op }) => op === "READ")!.rx).content, content);
            assert.equal(JSON.parse(rows.find(({ op }) => op === null)!.rx).content, source, "the submitted program remains durable even when execution stops at an error");
            const body = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/ordered.md", name: "body" });
            assert.equal(body?.content, failOnOperationError ? content : content.replace("two", "TWO"));
        } finally { await db.close(); }
    });
}
