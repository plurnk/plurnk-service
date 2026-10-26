// {§module-discovery} — a daemon with nothing registered composes the installed default modules
// by discovery alone, as the service does.
import assert from "node:assert/strict";
import test from "node:test";
import type { JsonSchema } from "@plurnk/plurnk-contracts";
import Daemon from "../../src/server/Daemon.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { bindListener } from "./_http.ts";
import { insertWorkspace, openMigrated } from "./_db.ts";

const VERBS = ["add", "disable", "discover", "enable", "list", "remove", "replace"];

test("{§mcp-module} {§schedule-module} a bare daemon discovers the MCP and schedule families", async (t) => {
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    const names = daemon.listModuleActions().map(({ name }) => name);
    for (const family of ["mcp", "schedule"]) {
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
    "workspace.env.discover": { inputs: ["query", "source"], emptyListsAll: true },
    "session.env.discover": { inputs: ["query", "source"], emptyListsAll: true },
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
    for (const [name, { inputs }] of Object.entries(DISCOVERY).filter(([action]) => action.startsWith("workspace."))) {
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

test("{§acp-daemon-client} {§module-http-mounts} a bare daemon with a listener discovers the client interface at /acp", async (t) => {
    const db = await openMigrated();
    const http = await bindListener();
    const daemon = new Daemon({ db, provider: null, http });
    t.after(async () => { await daemon.stop(); await http.close(); await db.close(); });
    await daemon.start();
    const url = `http://127.0.0.1:${http.httpAddress().port}/acp`;
    const initRes = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: "init",
            method: "initialize",
            params: { protocolVersion: 2, info: { name: "test", version: "1.0.0" }, capabilities: {} },
        }),
    });
    assert.equal(initRes.status, 200);
    const connId = initRes.headers.get("acp-connection-id");
    assert.ok(connId);
    const sseAbort = new AbortController();
    t.after(() => sseAbort.abort());
    const sseRes = await fetch(url, {
        method: "GET",
        headers: { accept: "text/event-stream", "acp-connection-id": connId },
        signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "acp-connection-id": connId },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "_plurnk/action",
            params: { kind: "discover", params: {} },
        }),
    });
    assert.equal(response.status, 202);
    // {§acp-plurnk-metadata} The JSON-RPC response returns the action's result on the SSE stream.
    let rpc: { id?: number; result?: { actions?: Record<string, unknown> } } | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of sseRes.body!) {
        buf += decoder.decode(chunk, { stream: true });
        for (const frame of buf.split("\n\n")) {
            if (!frame.startsWith("data: ")) continue;
            const parsed = JSON.parse(frame.slice(6)) as { id?: number; result?: { actions?: Record<string, unknown> } };
            if (parsed.id === 1) {
                rpc = parsed;
                break;
            }
        }
        if (rpc !== undefined) break;
    }
    sseAbort.abort();
    assert.ok(rpc?.result?.actions !== undefined, "the discovered client interface answers discover");
});

test("{§mcp-module} {§module-contained-configuration} an invalid registry setting is reported and MCP management keeps working", async (t) => {
    const prior = process.env.PLURNK_MCP_REGISTRY_URL;
    process.env.PLURNK_MCP_REGISTRY_URL = "ftp://example";
    t.after(() => { if (prior === undefined) delete process.env.PLURNK_MCP_REGISTRY_URL; else process.env.PLURNK_MCP_REGISTRY_URL = prior; });
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider: null });
    t.after(async () => { await daemon.stop(); await db.close(); });
    await daemon.start();
    assert.ok(daemon.listModuleActions().some(({ name }) => name === "workspace.mcp.list"), "the MCP family is registered");
    assert.deepEqual(
        daemon.configurationNotices().filter(({ owner }) => owner === "module:@plurnk/plurnk-mcp").map(({ key }) => key),
        ["PLURNK_MCP_REGISTRY_URL"],
        "the contained setting is the module's own configuration notice",
    );
});
