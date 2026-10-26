import test from "node:test";
import assert from "node:assert/strict";
import FunctionalityManager, { FUNCTIONALITY_VERBS, plurnkRuntimeDecl, type FunctionalityVerb } from "./FunctionalityManager.ts";
import { Problems, type JsonSchema } from "@plurnk/plurnk-contracts";
import { OperationFailureError } from "../core/results.ts";
import type Functionality from "./Functionality.ts";

const invocations: Array<{ family: string; verb: string; params: unknown; caller: string }> = [];
const identities: unknown[] = [];
const emptySchema = { type: "object" };
const inputSchemas: Record<FunctionalityVerb, JsonSchema> = {
    list: emptySchema, discover: emptySchema, add: emptySchema, replace: emptySchema,
    enable: emptySchema, disable: emptySchema, remove: emptySchema,
};
const coordinator = {
    invoke: async (family: string, verb: string, params: unknown, identity: unknown, caller: string) => {
        assert.equal((identity as { workspaceId: number }).workspaceId, 1, "every invocation carries the workspace the manager closed over");
        identities.push(identity);
        invocations.push({ family, verb, params, caller });
        return { status: verb === "add" ? 201 : 200, body: { family, verb, params } };
    },
} as unknown as Functionality;

const args = (target: string | null, body: string) => {
    const written: string[] = [];
    const states: string[] = [];
    const emitted: unknown[] = [];
    return {
        args: {
            runtime: "plurnk", body, cwd: null, target, signal: new AbortController().signal,
            write: (_channel: string, chunk: string) => { written.push(chunk); },
            setState: (_channel: string, state: string) => { states.push(state); },
            emit: (notice: unknown) => { emitted.push(notice); },
            interact: async () => ({ status: "cancelled" as const }),
        } as never,
        written,
        states,
        emitted,
    };
};

test("{§functionality-model-projection} each family tool carries its verb union and coordinator properties without a second signature or field-table definition", () => {
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
        family: "fx", workspaceId: 1, coordinator,
        inputSchemas: schemas,
        example: { alias: "a", definition: { kind: "ok" } },
        discovery: { inputs: ["source"], details: "`source` is one fixture locator." },
    });
    const tool = manager.toolRegistry().tools.find((candidate) => candidate.target === "fx")!;
    assert.deepEqual(tool.invocation.inputSchema, {
        type: "object",
        additionalProperties: false,
        required: ["verb"],
        properties: {
            verb: {
                type: "string",
                enum: [...FUNCTIONALITY_VERBS],
                description: "The lifecycle verb to run (defaults to list when the body is empty).",
            },
            alias: { type: "string" },
            definition: definitionSchema,
        },
    });
    assert.equal(tool.invocation.signature, undefined);
    assert.match(tool.details ?? "", /\n```plurnk \(fx\)\n\{"verb":"add","alias":"a","definition":\{"kind":"ok"\}\}\n/u, "one exact example rides the family teaching");
    assert.doesNotMatch(tool.details ?? "", /\| Field|options\.retries/u);
    assert.match(tool.details ?? "", /fixture locator/u);
});

test("{§functionality-addressing} an addressing family's tool teaches its own add input, selects by its operand, and offers no replace", () => {
    const { replace: _replace, ...addressed } = {
        ...inputSchemas,
        add: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
        enable: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
        disable: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
        remove: { type: "object", required: ["file"], properties: { file: { type: "string" } } },
    };
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas: addressed, example: { files: ["docs/**"] } });
    const [tool] = manager.toolRegistry().tools;
    assert.equal(tool.target, "fx");
    const verbProp = (tool.invocation.inputSchema?.properties as Record<string, { enum?: string[] }> | undefined)?.verb;
    assert.deepEqual(verbProp?.enum, FUNCTIONALITY_VERBS.filter((verb) => verb !== "replace"));
    assert.match(tool.details ?? "", /\n```plurnk \(fx\)\n\{"verb":"add","files":\["docs\/\*\*"\]\}\n/u, "the example is the family's add input, verbatim");
});

test("{§functionality-model-projection} the plurnk manager exposes family tools and question with read/host effects", () => {
    const manager = new FunctionalityManager({
        family: "fx", workspaceId: 1, coordinator, inputSchemas,
        documentBody: "# fx\n\nAuthored body.",
        includeQuestion: true,
    });
    assert.deepEqual(manager.toolRegistry().tools.map(({ target }) => target), ["fx", "question"]);
    assert.deepEqual(
        FUNCTIONALITY_VERBS.map((verb) => manager.effectForInvocation("fx", JSON.stringify({ verb }))),
        ["read", "read", "host", "host", "host", "host", "host"],
    );
    assert.equal(manager.effectForInvocation("fx", ""), "read", "an empty body defaults to list (read)");
    assert.equal(manager.effectForInvocation("fx", '{"verb":"destroy"}'), "host", "an unregistered verb can never run ungated");
    assert.equal(manager.effectForInvocation("question", '{"message":"?"}'), "read", "question is always a read");
    assert.equal(manager.manifest.name, "plurnk");
    assert.equal(plurnkRuntimeDecl.invocation.target?.kind, "literal");
    assert.equal(plurnkRuntimeDecl.resourcesPath, "/tools");
    assert.equal(plurnkRuntimeDecl.expandTools, true);
    const fxTool = manager.toolRegistry().tools.find(({ target }) => target === "fx")!;
    assert.match(fxTool.details ?? "", /Authored body\./u, "the family's doc-file body rides the tool's details");
});

test("{§functionality-discover-advertisement} a family without discovery has no discover verb, and its manager names the verbs it has", async () => {
    invocations.length = 0;
    const { discover: _discover, ...served } = inputSchemas;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas: served });
    const [tool] = manager.toolRegistry().tools;
    const verbProp = (tool.invocation.inputSchema?.properties as Record<string, { enum?: string[] }> | undefined)?.verb;
    assert.deepEqual(verbProp?.enum, ["list", "add", "replace", "enable", "disable", "remove"]);
    const refused = await manager.run(args("fx", '{"verb": "discover", "query": "x"}').args);
    assert.equal(refused.status, 400);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/functionality/verb-unknown");
    assert.equal(refused.problem?.detail, "'discover' is not a fx lifecycle verb.");
    assert.equal(refused.problem?.recovery, "Select one of list, add, replace, enable, disable, remove.");
    assert.deepEqual(invocations, [], "the refusal never reaches the coordinator");
});

test("{§functionality-model-projection} a verb runs through the coordinator as an operation and streams its JSON result", async () => {
    invocations.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas });
    const { args: runArgs, written, states } = args("fx", '{"verb":"add","alias":"a","definition":{"kind":"ok"}}');
    const result = await manager.run(runArgs);
    assert.equal(result.status, 201);
    assert.deepEqual(invocations, [{ family: "fx", verb: "add", params: { alias: "a", definition: { kind: "ok" } }, caller: "operation" }]);
    assert.deepEqual(states, ["active", "closed"]);
    assert.deepEqual(JSON.parse(written.join("")), { family: "fx", verb: "add", params: { alias: "a", definition: { kind: "ok" } } });
});

test("{§functionality-model-projection} every family's owned refusal survives its management executor", async () => {
    const problem = Problems.create("fixture:management", "unavailable", 502, "The source could not be inspected.", {
        source: "fixture", recovery: "Inspect the configured source.", retryable: false,
    });
    const result = { status: 502, problem };
    for (const cause of [new OperationFailureError(result), Object.assign(new Error(problem.detail), { problem })]) {
        const manager = new FunctionalityManager({
            family: "fx", workspaceId: 1, inputSchemas,
            coordinator: { invoke: async () => { throw cause; } } as unknown as Functionality,
        });
        const { args: runArgs, written, states } = args("fx", '{"verb":"discover"}');
        assert.deepEqual(await manager.run(runArgs), result);
        assert.deepEqual(JSON.parse(written.join("")), result);
        assert.deepEqual(states, ["active", "errored"]);
    }
});

test("{§functionality-model-mutation} a pending resource sign-in emits an authorization notice while holding for the settled outcome", async () => {
    const body = { status: 201, family: "mcp", alias: "remote", definition: {
        alias: "remote", origin: "workspace", state: "active",
    } };
    const manager = new FunctionalityManager({
        family: "mcp", workspaceId: 1, inputSchemas,
        coordinator: { invoke: async (_f: string, _v: string, _p: unknown, _i: unknown, _c: string, options?: { onAuthorizationRequired?: (aliases: readonly string[]) => void }) => {
            options?.onAuthorizationRequired?.(["remote"]);
            return { status: 201, body };
        } } as unknown as Functionality,
    });
    const { args: runArgs, written, states, emitted } = args("mcp", '{"verb":"add"}');
    assert.deepEqual(await manager.run(runArgs), { status: 201 });
    assert.deepEqual(emitted, [{
        source: "functionality:mcp",
        kind: "authorization_required",
        level: "info",
        message: "MCP server 'remote' awaits sign-in (/mcp oauth remote).",
    }]);
    assert.deepEqual(states, ["active", "closed"]);
    assert.deepEqual(JSON.parse(written.join("")), body);
});

test("{§functionality-model-projection} an unexpected exception is not reclassified as a managed refusal", async () => {
    for (const cause of [new Error("internal fixture failure"), Object.assign(new Error("malformed failure"), { problem: { status: 502 } })]) {
        const manager = new FunctionalityManager({
            family: "fx", workspaceId: 1, inputSchemas,
            coordinator: { invoke: async () => { throw cause; } } as unknown as Functionality,
        });
        const { args: runArgs, written, states } = args("fx", '{"verb":"discover"}');
        await assert.rejects(() => manager.run(runArgs), (error) => error === cause);
        assert.deepEqual(written, []);
        assert.deepEqual(states, []);
    }
});

test("{§functionality-model-projection} an empty body defaults to list; a non-JSON body and an unknown verb are exact refusals", async () => {
    invocations.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas });
    assert.equal((await manager.run(args("fx", "   ").args)).status, 200);
    assert.deepEqual(invocations.at(-1), { family: "fx", verb: "list", params: {}, caller: "operation" });
    const refused = await manager.run(args("fx", "not json").args);
    assert.equal(refused.status, 400);
    assert.equal(refused.problem?.type, "https://problems.plurnk.xyz/functionality/arguments-not-json");
    const unknown = await manager.run(args("fx", '{"verb":"destroy"}').args);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.problem?.type, "https://problems.plurnk.xyz/functionality/verb-unknown");
    assert.equal(invocations.length, 1, "refusals never reach the coordinator");
});

// {§functionality-scope} — the published manager closes over the coordinator; Core binds the invoking
// workspace and session per operation, and the binding is never retained.
test("{§functionality-model-projection} Core binds the invoking session at the operation; the published manager stays workspace-wide", async () => {
    invocations.length = 0;
    identities.length = 0;
    const manager = new FunctionalityManager({ family: "fx", workspaceId: 1, coordinator, inputSchemas });
    assert.equal((await manager.run(args("fx", "").args)).status, 200);
    assert.equal((await manager.forSession(7).run(args("fx", "").args)).status, 200);
    assert.equal((await manager.run(args("fx", "").args)).status, 200);
    assert.deepEqual(identities, [{ workspaceId: 1 }, { workspaceId: 1, sessionId: 7 }, { workspaceId: 1 }],
        "the bound instance names its session; the published instance never does");
    assert.deepEqual(manager.forSession(7).toolRegistry().tools.map(({ target }) => target), ["fx"], "binding changes the identity, not the teaching");
});
