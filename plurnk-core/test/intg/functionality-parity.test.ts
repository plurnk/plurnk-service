// {§functionality-coordinator} — lifecycle parity across the three real
// families. One family-neutral matrix runs against Agent Skills, MCP, and
// outbound A2A agents with their representative standards peers beneath: the
// same client verbs, the same model verbs through the real proposal boundary,
// the same hotload/withdrawal at the next packet, the same persistence,
// inheritance, isolation, concurrency, and rollback. No step encodes a family's
// management grammar; only the definition payloads and the liveness probe differ.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import type { PlurnkStatement, ProblemDetails, UrlPath } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { Module as McpModule } from "@plurnk/plurnk-mcp";
import { OutboundModule as A2aOutboundModule } from "@plurnk/plurnk-a2a";
import Daemon from "../../src/server/Daemon.ts";
import HostPaths from "../../src/core/HostPaths.ts";
import { StandardSkillsToolchain } from "../../src/server/SkillsFunctionality.ts";
import { OperationFailureError } from "../../src/core/results.ts";
import { startDemoAgent } from "../../../plurnk-a2a/test/fixtures/DemoAgent.ts";
import { awaitExecOutcome, insertWorkspace, insertWorker, openMigrated, viableWindow } from "./_helpers.ts";
import { makeMockResponse, waitFor, waitForDb } from "./_rpc.ts";
import { sendStmt } from "./_dsl.ts";
import type { Db } from "../../src/core/Db.ts";

type Definition = { readonly alias: string; readonly definition: object; readonly probe: (context: Context) => Promise<number> };

interface Context {
    readonly daemon: Daemon;
    readonly db: Db;
    readonly workspaceId: number;
    readonly functionalityWorkerId: number;
    readonly clientWorkerId: number;
}

interface Family {
    readonly family: string;
    readonly documentOf: (alias: string) => string;
    readonly service: Definition;              // enabled by default from configuration
    readonly addable: Definition;              // a second live definition
    readonly conflicting: Definition;          // same alias as addable, different definition
    readonly unreachable: Definition;          // admits, fails preparation
    readonly discover: Readonly<Record<string, unknown>>;
    readonly collidingAlias?: string;          // a publication the host refuses
    readonly projectRoot?: string;             // the workspace's project root, when the family needs one
    boot(db: Db, provider: Mock): Promise<{ daemon: Daemon }>;
    close(): Promise<void>;
}

class PacketCapturingMock extends Mock {
    readonly requests: string[] = [];

    override generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        this.requests.push(args[0].messages.map(({ content }) => content).join("\n\n"));
        return super.generate(...args);
    }
}

const parseOne = (input: string): PlurnkStatement => {
    const parsed = PlurnkParser.parse(`# PLAN0\n${input}`);
    const item = parsed.items.find((x) => x.kind === "statement" && x.statement.op !== "PLAN");
    if (item?.kind !== "statement") throw new Error(`no statement parsed from ${input}`);
    return item.statement;
};

const LIVE = new Set([102, 200]);
// Absent: unknown or disabled (404/501) or unavailable with its exact Problem (5xx).
const isAbsent = (status: number): boolean => status >= 400;

const dispatch = (context: Context, statement: PlurnkStatement) =>
    context.daemon.dispatchAsClient({ workspaceId: context.workspaceId, workerId: context.clientWorkerId, functionalityWorkerId: context.functionalityWorkerId, statement });

const documentPresent = async (context: Context, pathname: string): Promise<number> => {
    const rows = await context.db.test_entries_by_coordinate_owners.all<{ owner_id: number }>({ scheme: "worker", authority: "", pathname });
    return rows.some(({ owner_id }) => owner_id === context.functionalityWorkerId) ? 200 : 404;
};

const a2aTarget = (alias: string): UrlPath => ({
    kind: "url", raw: `a2a://${alias}`, scheme: "a2a", username: null, password: null,
    hostname: alias, port: null, pathname: "", query: null, fragment: null,
});

const problemOf = async (run: () => Promise<unknown>): Promise<ProblemDetails> => {
    try { await run(); } catch (error) {
        const problem = (error as { problem?: ProblemDetails }).problem ?? (error as OperationFailureError).result?.problem;
        assert.ok(problem !== undefined, `expected a Problem, got ${String(error)}`);
        return problem;
    }
    assert.fail("Expected the action to reject.");
};

const mockProvider = (): PacketCapturingMock => new PacketCapturingMock({
    contextWindow: viableWindow() * 2,
    responses: Array.from({ length: 12 }, () => makeMockResponse("## SEND0 [200]\ndone", 20)),
});

// ───────────────────────── families ─────────────────────────

const skillsFamily = async (): Promise<Family> => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-parity-skills-"));
    const home = join(base, "home");
    const project = join(base, "project");
    const sourceA = join(base, "source-a");
    const sourceB = join(base, "source-b");
    const hostPaths = new HostPaths({ home, env: {} });
    const skill = async (root: string, name: string, description: string) => {
        await mkdir(join(root, name), { recursive: true });
        await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nUse ${name}.\n`);
    };
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    await skill(hostPaths.projectSkillsDir(project), "grep", "Find text");
    await skill(sourceA, "extra", "Extra from source A");
    await skill(sourceB, "extra", "Extra from source B");
    const toolchain = new StandardSkillsToolchain({ PLURNK_SERVICE_SKILLS_CLI: `${process.execPath} ${resolve(import.meta.dirname, "_skills-cli.mjs")}`, PLURNK_SERVICE_SKILLS_REGISTRY_URL: "" });
    const doc = (alias: string) => `/_plurnk/skills/${alias}.md`;
    const probe = (alias: string) => (context: Context) => documentPresent(context, doc(alias));
    return {
        family: "skills",
        documentOf: doc,
        service: { alias: "grep", definition: { name: "grep", scope: "project" }, probe: probe("grep") },
        addable: { alias: "extra", definition: { name: "extra", scope: "project", source: sourceA }, probe: probe("extra") },
        conflicting: { alias: "extra", definition: { name: "extra", scope: "global", source: sourceB }, probe: probe("extra") },
        unreachable: { alias: "ghost", definition: { name: "ghost", scope: "project", source: sourceA }, probe: probe("ghost") },
        discover: { source: sourceA },
        boot: async (db, provider) => {
            const daemon = new Daemon({ db, provider, skills: { hostPaths, toolchain } });
            return { daemon };
        },
        close: () => rm(base, { recursive: true, force: true }),
        projectRoot: project,
    };
};

const mcpFamily = async (): Promise<Family> => {
    const echo = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/echo-server.mjs", import.meta.url));
    const legacy = fileURLToPath(new URL("../../../plurnk-mcp/src/fixtures/legacy-server.mjs", import.meta.url));
    // A started stream is an active request; the probe waits for its results
    // channel to close so a following mutation meets a quiescent server.
    const exec = (alias: string, tool: string) => async (context: Context) => {
        const before = (await context.db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: context.workspaceId, scheme: alias, prefix: "/%" })).length;
        const { status } = await dispatch(context, parseOne(`## EXEC0 [${alias}] (${tool})\n{"message":"parity"}`));
        if (status !== 200) return status;
        await waitForDb(async () => {
            const outputs = await context.db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: context.workspaceId, scheme: alias, prefix: "/%" });
            if (outputs.length <= before) return false;
            for (const { pathname } of outputs) {
                const channel = await context.db.test_get_channel_by_pathname_scheme.get<{ state: string }>({ pathname, scheme: alias, name: "body" });
                if (channel !== undefined && channel.state !== "closed" && channel.state !== "errored") return false;
            }
            return true;
        }, (closed) => closed, { timeoutMs: 20_000 });
        return status;
    };
    return {
        family: "mcp",
        documentOf: (alias) => `/_plurnk/tools/${alias}.md`,
        // `read` declares the probe tools read-effect so a client EXEC runs ungated; everything else proposes.
        service: { alias: "fixture", definition: { name: "fixture", transport: "stdio", command: process.execPath, args: [echo], read: ["echo"] }, probe: exec("fixture", "echo") },
        addable: { alias: "extra", definition: { name: "extra", transport: "stdio", command: process.execPath, args: [echo], tools: ["echo"], read: ["echo"] }, probe: exec("extra", "echo") },
        conflicting: { alias: "extra", definition: { name: "extra", transport: "stdio", command: process.execPath, args: [legacy], read: ["legacy_echo"] }, probe: exec("extra", "legacy_echo") },
        unreachable: { alias: "ghost", definition: { name: "ghost", transport: "stdio", command: process.execPath, args: [join(tmpdir(), "no-such-mcp-server.mjs")] }, probe: exec("ghost", "echo") },
        discover: { source: `${process.execPath} ${echo}` },
        collidingAlias: "sh",
        boot: async (db, provider) => {
            const daemon = new Daemon({ db, provider });
            daemon.registerModule(McpModule.init({ env: {
                PLURNK_MCP_CONNECT_TIMEOUT: "30000",
                PLURNK_MCP_REQUEST_TIMEOUT: "30000",
                PLURNK_MCP_FIXTURE: process.execPath,
                PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([echo]),
                PLURNK_MCP_FIXTURE_READ: '["echo"]',
                PLURNK_MCP_ENABLED: '["fixture"]',
            } }));
            return { daemon };
        },
        close: async () => {},
    };
};

const agentsFamily = async (): Promise<Family> => {
    const agentA = await startDemoAgent();
    const agentB = await startDemoAgent();
    const send = (alias: string) => async (context: Context) =>
        (await dispatch(context, { ...sendStmt(200, a2aTarget(alias), "parity"), target: a2aTarget(alias) })).status;
    return {
        family: "agents",
        documentOf: (alias) => `/_plurnk/agents/${alias}.md`,
        service: { alias: "researcher", definition: { name: "researcher", url: agentA.baseUrl }, probe: send("researcher") },
        addable: { alias: "extra", definition: { name: "extra", url: agentA.baseUrl }, probe: send("extra") },
        conflicting: { alias: "extra", definition: { name: "extra", url: agentB.baseUrl }, probe: send("extra") },
        unreachable: { alias: "ghost", definition: { name: "ghost", url: "http://127.0.0.1:9" }, probe: send("ghost") },
        discover: { source: agentB.baseUrl },
        boot: async (db, provider) => {
            const daemon = new Daemon({ db, provider });
            daemon.registerModule(A2aOutboundModule.init({ PLURNK_A2A_RESEARCHER: agentA.baseUrl, PLURNK_A2A_ENABLED: '["researcher"]' }));
            return { daemon };
        },
        close: async () => { await agentA.close(); await agentB.close(); },
    };
};

// ───────────────────────── the matrix ─────────────────────────

const matrix = async (family: Family): Promise<void> => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `parity-${family.family}-${crypto.randomUUID()}`);
    if (family.projectRoot !== undefined) await db.test_set_workspace_root.run({ id: workspaceId, project_root: family.projectRoot });
    const model = await insertWorker(db, workspaceId, null, "conversation", "model");
    const peer = await insertWorker(db, workspaceId, null, "peer", "model");
    const clientA = await insertWorker(db, workspaceId, null, "client-a", "client");
    const clientB = await insertWorker(db, workspaceId, null, "client-b", "client");
    let provider = mockProvider();
    let { daemon } = await family.boot(db, provider);
    await daemon.start();
    const context = (functionalityWorkerId = model, clientWorkerId = clientA): Context => ({ daemon, db, workspaceId, functionalityWorkerId, clientWorkerId });
    // A client retries the one retryable refusal: 409 workspace-busy while a
    // just-settled stream still holds the workspace ({§module-worker-quiescence}).
    const invoke = async <T>(verb: string, params: Readonly<Record<string, unknown>>, workerId = model): Promise<T> => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await daemon.invokeModuleAction(`worker.${family.family}.${verb}`, params, { scope: "worker", workspaceId, workerId }) as T;
            } catch (error) {
                const problem = (error as { problem?: ProblemDetails }).problem ?? (error as OperationFailureError).result?.problem;
                if (problem?.type.endsWith("/workspace-busy") === true && attempt < 100) {
                    await new Promise((r) => setTimeout(r, 20));
                    continue;
                }
                throw error;
            }
        }
    };
    type Listed = { alias: string; origin: string; state: string; problem?: ProblemDetails };
    const listed = async (workerId = model): Promise<Listed[]> => (await invoke<{ definitions: Listed[] }>("list", {}, workerId)).definitions;
    const stateOf = async (alias: string, workerId = model): Promise<string | undefined> => (await listed(workerId)).find((entry) => entry.alias === alias)?.state;
    const live = async (definition: Definition, workerId = model, clientWorkerId = clientA): Promise<boolean> => {
        const status = await definition.probe(context(workerId, clientWorkerId));
        assert.ok(LIVE.has(status) || isAbsent(status), `${family.family}: probe of ${definition.alias} answered ${status}`);
        return LIVE.has(status);
    };
    const document = (alias: string, workerId = model) => documentPresent(context(workerId), family.documentOf(alias));
    // Model verbs: the family's EXEC manager streams JSON into its output entry.
    const exec = (program: string) => dispatch(context(), parseOne(program));
    const verbResult = () => awaitExecOutcome(db, { workspaceId, scheme: family.family, timeoutMs: 10_000 });
    const proposals: number[] = [];
    const events: Array<{ method: string; params: unknown }> = [];
    let unsubscribe = daemon.subscribeToEvents((_w, method, params) => {
        events.push({ method, params });
        if (method === "loop/proposal") proposals.push((params as { logEntryId: number }).logEntryId);
    });
    // An EXEC verb starts a stream: the dispatch reports `started`, the verb's
    // JSON outcome closes the family's results channel, and an accepted
    // mutation's publication settles at the turn boundary.
    const proposed = async (program: string, decision: "accept" | "reject") => {
        const seen = proposals.length;
        const outputsBefore = (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: family.family, prefix: "/%" })).length;
        const pending = exec(program);
        await waitFor(() => proposals, (list) => list.length > seen, { timeoutMs: 10_000 });
        await daemon.resolveProposal(proposals[seen]!, { decision });
        const result = await pending;
        if (decision === "accept") {
            await waitForDb(async () => (await db.test_entries_by_scheme_prefix.all<{ pathname: string }>({ workspace_id: workspaceId, scheme: family.family, prefix: "/%" })).length, (count) => count > outputsBefore, { timeoutMs: 10_000 });
            await verbResult();
            await daemon.settleFunctionality(model);
        }
        return result;
    };
    // A model loop: the next packet is what the model actually sees.
    const nextPacket = async (): Promise<string> => {
        const before = provider.requests.length;
        const started = await daemon.runLoop({ workspaceId, workerId: model, prompt: `parity ${provider.requests.length}`, flags: { auto: true } });
        await waitFor(() => events.filter((e) => e.method === "loop/terminated" && (e.params as { loopId?: number }).loopId === started.loopId), (t) => t.length > 0, { timeoutMs: 20_000 });
        const packet = provider.requests[before];
        assert.ok(packet !== undefined, `${family.family}: the loop produced no packet`);
        return packet;
    };
    const add = (definition: Definition, workerId = model) => invoke<{ status: number; definition: { state: string } }>("add", { alias: definition.alias, definition: definition.definition }, workerId);

    try {
        // 1. Registration: the six common actions, nothing family-specific in the grammar.
        assert.deepEqual(
            daemon.listModuleActions().map(({ name }) => name).filter((name) => name.startsWith(`worker.${family.family}.`) && !name.includes(".oauth.") && !name.endsWith(".complete")).toSorted(),
            ["add", "disable", "discover", "enable", "list", "remove"].map((verb) => `worker.${family.family}.${verb}`),
        );
        // 2. Configuration baseline is service-origin and live.
        assert.equal(await stateOf(family.service.alias), "active");
        assert.equal((await listed()).find((entry) => entry.alias === family.service.alias)?.origin, "service");
        assert.equal(await live(family.service), true, "the configured definition is live");
        assert.equal(await document(family.service.alias), 200, "the active definition has its generated document");
        // 3. Discovery from the representative source is inert.
        const discovered = await invoke<{ candidates: Array<{ alias?: string; provenance: { kind: string; source: string } }> }>("discover", family.discover);
        assert.ok(discovered.candidates.length > 0, "the representative source yields candidates");
        assert.ok(discovered.candidates.every(({ provenance }) => typeof provenance.kind === "string" && typeof provenance.source === "string"), "every candidate carries exact provenance");
        assert.equal((await listed()).some((entry) => discovered.candidates.some((candidate) => candidate.alias === entry.alias && entry.origin === "worker")), false, "discovery added nothing");
        // 4. Client add → live and documented before the next operation.
        assert.equal(await live(family.addable), false, "the alias is absent before add");
        const added = await add(family.addable);
        assert.equal(added.status, 201);
        assert.equal(added.definition.state, "active");
        assert.equal(await live(family.addable), true, "add hotloads the definition before the next operation");
        assert.equal(await document(family.addable.alias), 200);
        // 5. The next model packet carries the publication; disable withdraws it; the packet after shows the withdrawal.
        const afterAdd = await nextPacket();
        assert.match(afterAdd, new RegExp(`worker://~${family.documentOf(family.addable.alias).replaceAll("/", "\\/").replaceAll(".", "\\.")}`), "the first subsequent packet shows the hotloaded document");
        assert.equal((await invoke<{ definition: { state: string } }>("disable", { alias: family.addable.alias })).definition.state, "disabled");
        assert.equal(await live(family.addable), false, "disable withdraws the definition before the next operation");
        assert.equal(await document(family.addable.alias), 404, "disable withdraws the generated document");
        const afterDisable = await nextPacket();
        assert.match(afterDisable, /"KILL"|\/KILL"/, "the first subsequent packet shows the withdrawal");
        assert.equal((await invoke<{ definition: { state: string } }>("enable", { alias: family.addable.alias })).definition.state, "active");
        assert.equal(await live(family.addable), true);
        // 6. Enabled-unavailable: an accepted model add of an unreachable peer publishes unavailable with its exact Problem;
        //    the explicit client retry rejects with the same Problem; remove recovers.
        const viaModel = await proposed(`## EXEC0 [${family.family}] (add)\n${JSON.stringify({ alias: family.unreachable.alias, definition: family.unreachable.definition })}`, "accept");
        assert.equal(viaModel.status, 200, "the accepted add settled inside the turn");
        await exec(`## EXEC0 [${family.family}] (list)`);
        const downListed = (await listed()).find((entry) => entry.alias === family.unreachable.alias);
        assert.equal(downListed?.state, "unavailable");
        assert.ok((downListed?.problem?.status ?? 0) >= 400, "the enabled definition keeps its exact Problem");
        assert.equal(await live(family.unreachable), false);
        assert.equal(await document(family.unreachable.alias), 404, "an unavailable definition publishes no document");
        const retried = await problemOf(() => invoke("enable", { alias: family.unreachable.alias }));
        assert.equal(retried.type, downListed?.problem?.type, "an explicit retry reports the same exact Problem");
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: family.unreachable.alias })).removed, true);
        assert.equal(await stateOf(family.unreachable.alias), undefined);
        // 7. Model verbs through the generated manager: read ungated, host verbs propose, rejection performs nothing.
        assert.equal((await exec(`## EXEC0 [${family.family}] (list)`)).status, 200);
        assert.equal((await verbResult()).family, family.family);
        const rejected = await proposed(`## EXEC0 [${family.family}] (remove)\n${JSON.stringify({ alias: family.addable.alias })}`, "reject");
        assert.equal(rejected.status, 400, "a rejected proposal settles 400");
        assert.equal(await stateOf(family.addable.alias), "active", "rejection changed nothing");
        assert.equal(await live(family.addable), true);
        const viaModelDisable = await proposed(`## EXEC0 [${family.family}] (disable)\n${JSON.stringify({ alias: family.addable.alias })}`, "accept");
        assert.equal(viaModelDisable.status, 200);
        assert.equal(await live(family.addable), false, "an accepted model mutation is published before the next operation");
        await invoke("enable", { alias: family.addable.alias });
        // 8. A client add the service refuses rejects and persists nothing (rollback).
        const refused = await problemOf(() => add(family.unreachable));
        assert.ok(refused.status >= 400);
        assert.equal(await stateOf(family.unreachable.alias), undefined, "a rejected client add persists nothing");
        if (family.collidingAlias !== undefined) {
            await assert.rejects(() => add({ ...family.addable, alias: family.collidingAlias!, definition: { ...(family.addable.definition as object), name: family.collidingAlias } }));
            assert.equal(await stateOf(family.collidingAlias), undefined, "a publication the host refuses rolls back");
            assert.equal(await live(family.service), true, "the previous snapshot stays authoritative");
        }
        // 9. Two clients attached to one Worker see and use one state.
        assert.equal(await live(family.addable, model, clientB), true, "a second client uses the same Worker's definitions");
        await invoke("disable", { alias: family.addable.alias });
        assert.equal(await live(family.addable, model, clientB), false, "a mutation through one client is observed by the other");
        await invoke("enable", { alias: family.addable.alias });
        // 10. Two independent root Workers hold the same textual alias with conflicting definitions.
        assert.notEqual((await listed(peer)).find((entry) => entry.alias === family.conflicting.alias)?.origin, "worker", "the peer Worker never sees the first Worker's own definition as its own");
        const conflict = await add(family.conflicting, peer);
        assert.equal(conflict.definition.state, "active");
        assert.equal((await listed(peer)).find((entry) => entry.alias === family.conflicting.alias)?.origin, "worker");
        assert.equal(await live(family.conflicting, peer), true, "the peer Worker's definition is live for the peer");
        assert.equal(await live(family.addable, model), true, "the first Worker's definition stays live for the first Worker");
        await invoke("disable", { alias: family.conflicting.alias }, peer);
        assert.equal(await live(family.addable, model), true, "a peer mutation does not leak");
        assert.equal(await stateOf(family.addable.alias, model), "active");
        await invoke("remove", { alias: family.conflicting.alias }, peer);
        // 11. Child inheritance by value, later parent independence.
        const child = await insertWorker(db, workspaceId, model, "child", "model");
        assert.equal(await stateOf(family.addable.alias, child), "active", "a child inherits the parent's snapshot at birth");
        assert.equal(await live(family.addable, child), true);
        await invoke("disable", { alias: family.addable.alias });
        assert.equal(await stateOf(family.addable.alias, child), "active", "a later parent mutation does not reach the child");
        await invoke("disable", { alias: family.addable.alias }, child);
        await invoke("enable", { alias: family.addable.alias });
        assert.equal(await stateOf(family.addable.alias, child), "disabled", "a child mutation does not reach the parent");
        assert.equal(await stateOf(family.addable.alias, model), "active");
        // 12. Concurrent mutations serialize to one consistent outcome.
        await Promise.all([
            invoke("disable", { alias: family.addable.alias }),
            invoke("enable", { alias: family.addable.alias }),
            invoke("disable", { alias: family.addable.alias }),
            invoke("enable", { alias: family.addable.alias }),
        ]);
        const settled = await stateOf(family.addable.alias);
        assert.equal(settled, "active", "the last serialized mutation wins");
        assert.equal(await live(family.addable), true, "liveness agrees with the listed state");
        // 13. Restart: durable state reconstructs every Worker's Functionality.
        unsubscribe();
        await daemon.stop();
        provider = mockProvider();
        ({ daemon } = await family.boot(db, provider));
        await daemon.start();
        unsubscribe = daemon.subscribeToEvents(() => {});
        assert.equal(await stateOf(family.service.alias), "active");
        assert.equal(await stateOf(family.addable.alias), "active", "the Worker's own definition survives restart");
        assert.equal(await live(family.addable), true);
        assert.equal(await document(family.addable.alias), 200);
        assert.equal(await stateOf(family.addable.alias, child), "disabled", "the child's divergent state survives restart");
        assert.notEqual((await listed(peer)).find((entry) => entry.alias === family.conflicting.alias)?.origin, "worker", "the peer forgot its own definition across restart");
        // 14. Remove forgets the Worker definition and withdraws everything.
        assert.equal((await invoke<{ removed: boolean }>("remove", { alias: family.addable.alias })).removed, true);
        assert.equal(await live(family.addable), false);
        assert.equal(await document(family.addable.alias), 404);
    } finally {
        unsubscribe();
        await daemon.stop();
        await db.close();
    }
};

for (const make of [skillsFamily, mcpFamily, agentsFamily]) {
    test(`{§functionality-coordinator} lifecycle parity: ${make.name.replace("Family", "")}`, async () => {
        const family = await make();
        try {
            await matrix(family);
        } finally {
            await family.close();
        }
    });
}
