import test from "node:test";
import assert from "node:assert/strict";
import FunctionalityManager, { FUNCTIONALITY_VERBS, functionalityRuntimeDecl, type FunctionalityVerb } from "./FunctionalityManager.ts";
import type { JsonSchema } from "@plurnk/plurnk-contracts";
import type Functionality from "./Functionality.ts";

const invocations: Array<{ family: string; verb: string; params: unknown; caller: string }> = [];
const emptySchema = { type: "object" };
const inputSchemas: Record<FunctionalityVerb, JsonSchema> = {
    list: emptySchema, discover: emptySchema, add: emptySchema,
    enable: emptySchema, disable: emptySchema, remove: emptySchema,
};
const coordinator = {
    invoke: async (family: string, verb: string, params: unknown, _identity: unknown, caller: string) => {
        invocations.push({ family, verb, params, caller });
        return { status: verb === "add" ? 201 : 200, body: { family, verb, params } };
    },
} as unknown as Functionality;

const args = (target: string | null, body: string) => {
    const written: string[] = [];
    const states: string[] = [];
    return {
        args: {
            runtime: "fx", body, cwd: null, target, signal: new AbortController().signal,
            write: (_channel: string, chunk: string) => { written.push(chunk); },
            setState: (_channel: string, state: string) => { states.push(state); },
            emit: () => undefined,
            interact: async () => ({ status: "cancelled" as const }),
        } as never,
        written,
        states,
    };
};

test("{§functionality-model-projection} all verbs carry their coordinator schemas without a second signature or field-table definition", () => {
    const definitionSchema = {
        type: "object", required: ["kind"],
        properties: {
            kind: { enum: ["ok", "slow"], description: "The fixture kind." },
            options: { type: "object", properties: { retries: { type: "integer", description: "Attempts before giving up." } } },
        },
    };
    const schemas = { ...inputSchemas, add: {
        type: "object", required: ["definition"], properties: { alias: { type: "string" }, definition: definitionSchema },
    } };
    const manager = new FunctionalityManager({
        family: "fx", workspaceId: 1, workerId: 2, coordinator,
        inputSchemas: schemas,
        example: { alias: "a", definition: { kind: "ok" } },
        discovery: { details: "`source` is one fixture locator." },
    });
    const tool = (target: string) => manager.toolRegistry().tools.find((candidate) => candidate.target === target)!;
    for (const verb of FUNCTIONALITY_VERBS) {
        assert.deepEqual(tool(verb).invocation.inputSchema, schemas[verb]);
        assert.equal(tool(verb).invocation.signature, undefined);
    }
    assert.match(tool("add").details ?? "", /\n### EXEC0 \[fx\] \(add\)\n\{"alias":"a","definition":\{"kind":"ok"\}\}\n/u, "one exact example rides the add teaching");
    assert.doesNotMatch(tool("add").details ?? "", /\| Field|options\.retries/u);
    assert.match(tool("discover").details ?? "", /fixture locator/u);
});

test("{§functionality-model-projection} the family manager exposes exactly the six verbs with read/host effects", () => {
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, workerId: 2, coordinator, inputSchemas });
    assert.deepEqual(manager.toolRegistry().tools.map(({ target }) => target), [...FUNCTIONALITY_VERBS]);
    assert.deepEqual(manager.toolRegistry().tools.map(({ invocation }) => invocation.body.required),
        [false, true, true, true, true, true], "documentation changes do not alter the invocation's body-presence contract");
    assert.deepEqual(FUNCTIONALITY_VERBS.map((verb) => manager.effect(verb)), ["read", "read", "host", "host", "host", "host"]);
    assert.equal(manager.effect("destroy"), "host", "an unregistered verb can never run ungated");
    assert.equal(manager.manifest.name, "fx");
    assert.equal(functionalityRuntimeDecl("fx", "Manage fixtures.").invocation.target?.kind, "literal");
});

test("{§functionality-model-projection} a verb runs through the coordinator as an operation and streams its JSON result", async () => {
    invocations.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, workerId: 2, coordinator, inputSchemas });
    const { args: runArgs, written, states } = args("add", '{"alias":"a","definition":{"kind":"ok"}}');
    const result = await manager.run(runArgs);
    assert.equal(result.status, 201);
    assert.deepEqual(invocations, [{ family: "fx", verb: "add", params: { alias: "a", definition: { kind: "ok" } }, caller: "operation" }]);
    assert.deepEqual(states, ["active", "closed"]);
    assert.deepEqual(JSON.parse(written.join("")), { family: "fx", verb: "add", params: { alias: "a", definition: { kind: "ok" } } });
});

test("{§functionality-model-projection} an empty body is an empty argument object; a non-JSON body and an unknown verb are exact refusals", async () => {
    invocations.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, workerId: 2, coordinator, inputSchemas });
    assert.equal((await manager.run(args("list", "   ").args)).status, 200);
    assert.deepEqual(invocations.at(-1)?.params, {});
    const refused = await manager.run(args("discover", "not json").args);
    assert.equal(refused.status, 400);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/functionality/arguments-not-json");
    const unknown = await manager.run(args("destroy", "").args);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/functionality/verb-unknown");
    assert.equal(invocations.length, 1, "refusals never reach the coordinator");
});
