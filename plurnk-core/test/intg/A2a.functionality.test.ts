// {§a2a-agents-functionality} {§a2a-agents-catalog} — outbound A2A agents as the
// workspace `agents` family through the daemon: the environment baseline,
// per-alias catalog, shared hot enable/disable, and exact Problems.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProblemDetails, UrlPath } from "@plurnk/plurnk-contracts";
import { OutboundModule } from "@plurnk/plurnk-a2a";
import Daemon from "../../src/server/Daemon.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { startDemoAgent } from "../../../plurnk-a2a/test/fixtures/DemoAgent.ts";
import { insertWorkspace, insertWorker, openMigrated } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";
import type { Db } from "../../src/core/Db.ts";

const target = (alias: string): UrlPath => ({
    kind: "url", raw: `a2a://${alias}`, scheme: "a2a", username: null, password: null,
    hostname: alias, port: null, pathname: "", query: null, fragment: null,
});

const rejectedProblem = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        const problem = (error as { problem?: ProblemDetails }).problem ?? (error as OperationFailureError).result?.problem;
        assert.ok(problem !== undefined, `expected a Problem, got ${String(error)}`);
        return problem;
    }
    assert.fail("Expected the action to reject.");
};

test("{§a2a-agents-functionality} outbound agents are workspace Functionality: baseline, catalog, shared hot enable/disable, exact Problems", async () => {
    const agent = await startDemoAgent();
    const db: Db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `a2a-agents-${crypto.randomUUID()}`);
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const peer = await insertWorker(db, workspaceId, null, "peer", "model");
    const client = await insertWorker(db, workspaceId, null, "client-1", "client");
    const daemon = new Daemon({ db, provider: null });
    daemon.registerModule(OutboundModule.init({
        PLURNK_A2A_ERROR_DETAIL_LIMIT: "512",
        PLURNK_A2A_RESEARCHER: agent.baseUrl,
        PLURNK_A2A_ENABLED: '["researcher"]',
        PLURNK_A2A_SCRIBE: "http://127.0.0.1:9",
    }));
    await daemon.start();
    const invoke = <T>(verb: string, params: Readonly<Record<string, unknown>>): Promise<T> =>
        daemon.invokeModuleAction(`workspace.agents.${verb}`, params, { scope: "workspace", workspaceId }) as Promise<T>;
    type Listed = { alias: string; origin: string; state: string; detail?: { name: string; skills: string[] }; problem?: ProblemDetails };
    const states = async (): Promise<string[]> =>
        (await invoke<{ definitions: Listed[] }>("list", {})).definitions.map(({ alias, origin, state }) => `${alias}:${origin}:${state}`);
    const document = async (alias: string, workerId = model): Promise<string | undefined> => {
        const references = await daemon.engine.referenceEntries(workspaceId, workerId);
        return references.find(({ pathname }) => pathname === `/_plurnk/agents/${alias}.md`)?.content;
    };
    const send = (alias: string, workerId = client) =>
        daemon.dispatchAsClient({ workspaceId, workerId, statement: { ...sendStmt(target(alias), "ping"), target: target(alias) } });
    try {
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith("workspace.agents.")),
            ["workspace.agents.add", "workspace.agents.disable", "workspace.agents.discover", "workspace.agents.enable", "workspace.agents.list", "workspace.agents.remove"],
        );
        // The environment baseline: researcher enabled by default, scribe available but disabled.
        assert.deepEqual(await states(), ["researcher:service:active", "scribe:service:disabled"]);
        const researcher = (await invoke<{ definitions: Listed[] }>("list", {})).definitions.find(({ alias }) => alias === "researcher")!;
        assert.deepEqual(researcher.detail?.skills, ["echo"]);
        const catalog = await document("researcher");
        assert.match(catalog ?? "", /^# researcher\n\n## Summary\n\na2a:\/\/researcher — Plurnk A2A protocol witness v1\.0\.0: Independent deterministic A2A v1 test agent\n/u);
        assert.doesNotMatch(catalog ?? "", /## Skills/u);
        assert.equal(await document("scribe"), undefined, "a disabled alias publishes no catalog document");
        // The scheme routes through the workspace snapshot.
        const started = await send("researcher");
        assert.equal(started.status, 102, "an enabled alias answers with the Task receipt");
        // Disable withdraws the alias at the scheme and from the catalog before the next operation.
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: "researcher" })).definition.state, "disabled");
        assert.equal(await document("researcher"), undefined);
        const refused = await send("researcher");
        assert.equal(refused.status, 404);
        assert.equal((refused.problem as ProblemDetails).type, "https://problems.plurnk.xyz/scheme/a2a/agent-not-configured");
        assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: "researcher" })).definition.state, "active");
        assert.equal((await send("researcher")).status, 102);
        // Enabling an unreachable service alias is an explicit client mutation: it rejects with the exact Problem.
        const unreachable = await rejectedProblem(() => invoke("enable", { alias: "scribe" }));
        assert.equal(unreachable.type, "https://problems.plurnk.xyz/a2a/functionality/card-unreachable");
        assert.deepEqual(await states(), ["researcher:service:active", "scribe:service:disabled"]);
        // Admission and discovery are exact and inert.
        assert.equal((await rejectedProblem(() => invoke("add", { alias: "peer", definition: { name: "other", url: agent.baseUrl } }))).type, "https://problems.plurnk.xyz/a2a/functionality/alias-mismatch");
        const discovered = await invoke<{ candidates: Array<{ alias: string; definition: { url: string } }> }>("discover", { source: agent.baseUrl });
        assert.deepEqual(discovered.candidates.map(({ alias, definition }) => ({ alias, url: definition.url })), [{ alias: "plurnk-a2a-protocol-witness", url: agent.baseUrl }]);
        assert.deepEqual(await states(), ["researcher:service:active", "scribe:service:disabled"], "discovery persisted nothing");
        // A workspace definition shadows the service baseline for every worker.
        const added = await invoke<{ status: number; definition: { origin: string; state: string } }>("add", { alias: "scribe", definition: { name: "scribe", url: agent.baseUrl } });
        assert.equal(added.status, 201);
        assert.equal(added.definition.origin, "workspace");
        assert.equal(added.definition.state, "active");
        assert.equal((await send("scribe", peer)).status, 102, "the peer uses the shared agent");
        assert.equal((await send("scribe", model)).status, 102, "the first worker uses the same agent");
        assert.match(await document("scribe", peer) ?? "", /a2a:\/\/scribe — Plurnk A2A protocol witness/u);
        assert.equal(await document("scribe", model), await document("scribe", peer));
        // Remove forgets the workspace definition and reveals the service baseline, disabled.
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: "scribe" })).removed, true);
        assert.deepEqual(await states(), ["researcher:service:active", "scribe:service:disabled"]);
        assert.equal((await send("scribe", peer)).status, 404);
    } finally {
        await daemon.stop();
        await db.close();
        await agent.close();
    }
});
