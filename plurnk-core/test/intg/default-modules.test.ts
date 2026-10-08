// {§module-discovery} — a daemon with nothing registered composes the installed default modules
// by discovery alone, as the service does.
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonSchema } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { bindListener } from "./_a2a.ts";
import { insertWorkspace, openMigrated } from "./_db.ts";

const VERBS = ["add", "disable", "discover", "enable", "list", "remove"];

test("{§mcp-module} {§schedule-module} {§a2a-module} a bare daemon discovers the MCP, schedule and A2A families", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const names = daemon.listModuleActions().map(({ name }) => name);
    for (const family of ["mcp", "schedule", "a2a"]) {
        assert.deepEqual(
            names.filter((name) => name.startsWith(`workspace.${family}.`)).map((name) => name.slice(`workspace.${family}.`.length)).filter((verb) => VERBS.includes(verb)).toSorted(),
            VERBS,
            `the ${family} family arrives without explicit composition`,
        );
    }
});

// {§functionality-discover-advertisement} — the inputs each family declares, as its discover action
// advertises them. The test floor configures the MCP Registry, so the mcp family serves discovery.
const DISCOVERY: Readonly<Record<string, { readonly inputs: readonly string[]; readonly emptyListsAll?: true }>> = {
    "workspace.skills.discover": { inputs: ["source"] },
    "workspace.schedule.discover": { inputs: ["source"] },
    "workspace.mcp.discover": { inputs: ["query"] },
    "workspace.a2a.discover": { inputs: ["source", "configuration"] },
    "workspace.env.discover": { inputs: ["query", "source"], emptyListsAll: true },
    "worker.env.discover": { inputs: ["query", "source"], emptyListsAll: true },
    "workspace.members.discover": { inputs: ["query"] },
};
const INPUTS = ["query", "source", "configuration"];

test("{§functionality-discover-advertisement} each family's discover advertises exactly the inputs it serves, and any other is refused by name", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const actions = new Map(daemon.listModuleActions().map((action) => [action.name, action]));
    assert.deepEqual([...actions.keys()].filter((name) => name.endsWith(".discover")).toSorted(), Object.keys(DISCOVERY).toSorted(),
        "every family serving discovery has its discover action, and no other has one");
    for (const [name, { inputs, emptyListsAll }] of Object.entries(DISCOVERY)) {
        const schema = actions.get(name)!.inputSchema as JsonSchema & { properties: Readonly<Record<string, unknown>> };
        assert.deepEqual(Object.keys(schema.properties).filter((key) => key !== "scope"), inputs, `${name} advertises exactly its inputs`);
        assert.equal(schema.additionalProperties, false, `${name} admits no other input`);
        const atLeastOne = inputs.length === 1 ? { required: inputs } : { anyOf: inputs.map((input) => ({ required: [input] })) };
        assert.deepEqual({ required: schema.required, anyOf: schema.anyOf }, emptyListsAll === true ? { required: undefined, anyOf: undefined } : { required: undefined, anyOf: undefined, ...atLeastOne },
            `${name} ${emptyListsAll === true ? "lists everything for a request naming no input" : "requires one of its inputs"}`);
    }
    const workspaceId = await insertWorkspace(db, `discover-advertisement-${crypto.randomUUID()}`);
    for (const [name, { inputs }] of Object.entries(DISCOVERY).filter(([name]) => name.startsWith("workspace."))) {
        for (const field of INPUTS.filter((input) => !inputs.includes(input))) {
            const error = await daemon.invokeModuleAction(name, { [field]: field === "configuration" ? {} : "x" }, { scope: "workspace", workspaceId })
                .then(() => null, (cause: unknown) => cause);
            assert.ok(error instanceof OperationFailureError, `${name} refuses ${field}: ${String(error)}`);
            const { problem } = error.result;
            assert.ok(problem !== undefined, `${name} refuses ${field} with a Problem`);
            assert.equal(problem.type, "https://problems.plurnk.xyz/functionality/arguments-invalid", `${name} refuses ${field} by the shared schema check`);
            assert.ok((problem.errors as Array<{ error: string }>).some(({ error: message }) => message.includes(`"${field}"`)), `${name}'s refusal names ${field}`);
        }
    }
});

test("{§agui-daemon-client} {§module-http-mounts} a bare daemon with a listener discovers the client interface at /agui", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const response = await fetch(`http://127.0.0.1:${http.httpAddress().port}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            threadId: "discover", runId: "discover", state: {}, messages: [], tools: [], context: [],
            forwardedProps: { plurnk: { action: { kind: "discover" } } },
        }),
    });
    assert.equal(response.status, 200);
    const result = (await response.text()).split("\n\n").filter((frame) => frame.startsWith("data: "))
        .map((frame) => JSON.parse(frame.slice(6)) as { type: string; name?: string; value?: { ok?: boolean } })
        .find(({ type, name }) => type === "CUSTOM" && name === "plurnk.action.result");
    assert.equal(result?.value?.ok, true, "the discovered client interface answers discover");
});

test("{§a2a-module} {§module-contained-configuration} an invalid exposure setting is reported and outbound A2A keeps working", async (t) => {
    const prior = process.env.PLURNK_A2A_EXPOSE;
    process.env.PLURNK_A2A_EXPOSE = "yes";
    t.after(() => { if (prior === undefined) delete process.env.PLURNK_A2A_EXPOSE; else process.env.PLURNK_A2A_EXPOSE = prior; });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(daemon.listModuleActions().some(({ name }) => name === "workspace.a2a.list"), "the outbound family is registered");
    assert.deepEqual(
        daemon.configurationNotices().filter(({ owner }) => owner === "module:@plurnk/plurnk-a2a").map(({ key }) => key),
        ["PLURNK_A2A_EXPOSE"],
        "the contained setting is the module's own configuration notice",
    );
});
