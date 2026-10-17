// {§a2a-functionality} — the adapter's protocol truth against an
// independent agent: environment definitions, inert discovery, admission,
// preparation outcomes, the per-workspace resolver, and the catalog document.
import assert from "node:assert/strict";
import { test } from "node:test";
import A2aFunctionality, { aliasOfCard, renderAgent, A2aFunctionalityError } from "../../src/Functionality.ts";
import { ERROR_DETAIL_LIMIT } from "../../src/ErrorDetail.ts";
import { startDemoAgent } from "../fixtures/DemoAgent.ts";

const diagnosticEnv = { [ERROR_DETAIL_LIMIT]: "512", PLURNK_A2A_ENABLED: "1" };

const preparation = (workspaceId: number, enabled: Record<string, object>, options: { previous?: unknown; failure?: "publish-unavailable" | "reject"; force?: string } = {}) => ({
    workspaceId,
    signal: new AbortController().signal,
    enabled: new Map(Object.entries(enabled).map(([alias, definition]) => [alias, { definition }])),
    previous: options.previous ?? null,
    failure: options.failure ?? "publish-unavailable",
    ...(options.force === undefined ? {} : { force: options.force }),
    admissions: [],
    retain: () => () => {},
    progress: () => undefined,
});

const problemOf = async (run: () => Promise<unknown>): Promise<{ type: string; status: number; detail: string; diagnostic?: string }> => {
    try { await run(); } catch (error) {
        assert.ok(error instanceof A2aFunctionalityError, `expected an A2aFunctionalityError, got ${String(error)}`);
        return error.problem as { type: string; status: number; detail: string; diagnostic?: string };
    }
    assert.fail("expected a Problem");
};

for (const phase of ["card", "token"] as const) {
    test(`{§functionality-preparation-cancellation} A2A cancels ${phase} requests without publishing an unavailable agent`, async (t) => {
        const agent = await startDemoAgent("complete", undefined, { clientId: "plurnk", clientSecret: "agent-secret" });
        t.after(() => agent.close());
        const family = new A2aFunctionality({ ...diagnosticEnv, SECRET: "agent-secret" });
        const lifetime = new AbortController();
        const reason = new DOMException("fixture stopping", "AbortError");
        const entered = Promise.withResolvers<void>();
        const original = globalThis.fetch;
        let held = 0;
        t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = input instanceof Request ? input.url : String(input);
            if (phase === "token" && !url.endsWith("/oauth/token")) return original(input, init);
            assert.equal(init?.signal, lifetime.signal);
            held++;
            entered.resolve();
            return new Promise<Response>((_resolve, reject) => lifetime.signal.addEventListener("abort", () => reject(lifetime.signal.reason), { once: true }));
        });
        const definition = { name: "peer", url: agent.baseUrl, authorization: { type: "oauth2", clientId: "plurnk", clientSecret: "${SECRET}" } };
        const work = assert.rejects(family.prepare({ ...preparation(1, { peer: definition, later: { ...definition, name: "later" } }), signal: lifetime.signal }), (cause) => cause === reason);
        try { await entered.promise; }
        finally { lifetime.abort(reason); }
        await work;
        assert.equal(held, 1, "the next agent is not prepared after shutdown");
        assert.equal(family.resolve("peer", 1), null);
    });
}

test("{§a2a-environment-projection} environment definitions are the service baseline with PLURNK_A2A_ENABLED as the newborn default", async () => {
    const family = new A2aFunctionality({
        ...diagnosticEnv,
        PLURNK_A2A_researcher: JSON.stringify({ name: "researcher", url: "https://agent.example", authorization: { type: "bearer", token: "${RESEARCHER_TOKEN}" } }),
        PLURNK_A2A_scribe: JSON.stringify({ name: "scribe", url: "https://scribe.example", cardPath: "/cards/scribe.json" }),
        PLURNK_A2A_ENABLED: "1",
        PLURNK_A2A_scribe_ENABLED: "0",
    });
    assert.deepEqual(await family.available(), [
        { alias: "researcher", definition: { name: "researcher", url: "https://agent.example", authorization: { type: "bearer", token: "${RESEARCHER_TOKEN}" } }, enabled: true, provenance: { kind: "environment", source: "PLURNK_A2A_researcher" } },
        { alias: "scribe", definition: { name: "scribe", url: "https://scribe.example", cardPath: "/cards/scribe.json" }, enabled: false, provenance: { kind: "environment", source: "PLURNK_A2A_scribe" } },
    ]);
});

test("{§a2a-problem-detail} A2A Problems bound caught diagnostics and keep request facts out of prose", async (t) => {
    // {§error-detail-bound}: the bound is the system environment's, not the offered configuration's.
    const prior = process.env[ERROR_DETAIL_LIMIT];
    process.env[ERROR_DETAIL_LIMIT] = "4";
    t.after(() => { if (prior === undefined) delete process.env[ERROR_DETAIL_LIMIT]; else process.env[ERROR_DETAIL_LIMIT] = prior; });
    const family = new A2aFunctionality(diagnosticEnv);
    const invalidSource = await problemOf(() => family.discover({ source: "ftp://sensitive.example" }));
    assert.equal(invalidSource.detail, "A2A discovery requires an absolute HTTP(S) agent URL."); // {§problems-a2a}
    assert.doesNotMatch(invalidSource.detail, /sensitive/u);

    const invalidConfiguration = await problemOf(() => family.discover({ configuration: { PLURNK_A2A_bad: "not JSON" } }));
    assert.equal(invalidConfiguration.detail, "The offered A2A configuration is invalid."); // {§problems-a2a}
    assert.equal(invalidConfiguration.diagnostic?.length, 7);
    assert.match(invalidConfiguration.diagnostic ?? "", /\.\.\.$/u);
    assert.doesNotMatch(JSON.stringify(invalidConfiguration), /not a url/u);
});

test("discovery is inert: a URL yields one card-derived candidate, configuration yields overlay candidates", async () => {
    const agent = await startDemoAgent();
    try {
        const family = new A2aFunctionality(diagnosticEnv);
        const [candidate] = await family.discover({ source: agent.baseUrl });
        assert.deepEqual(candidate, {
            alias: "plurnk-a2a-protocol-witness",
            summary: "Independent deterministic A2A v1 test agent",
            definition: { name: "plurnk-a2a-protocol-witness", url: agent.baseUrl },
            provenance: { kind: "agent-card", source: agent.baseUrl, reference: "Plurnk A2A protocol witness" },
        });
        assert.deepEqual(await family.discover({ configuration: { PLURNK_A2A_local: JSON.stringify({ name: "local", url: agent.baseUrl }), IGNORED: 1 } }), [
            { alias: "local", definition: { name: "local", url: agent.baseUrl }, provenance: { kind: "client-configuration", source: "PLURNK_A2A_local" } },
        ]);
        assert.equal((await problemOf(() => family.discover({ source: "ftp://nope" }))).type, "https://problems.plurnk.xyz/a2a/functionality/source-invalid");
        assert.equal((await problemOf(() => family.discover({ source: "http://127.0.0.1:9" }))).type, "https://problems.plurnk.xyz/a2a/functionality/card-unreachable");
        assert.equal((await problemOf(() => family.discover({ configuration: { PLURNK_A2A_bad: "not JSON" } }))).type, "https://problems.plurnk.xyz/a2a/functionality/configuration-invalid");
    } finally {
        await agent.close();
    }
});

test("admission validates the exact definition and the alias/name identity", async () => {
    const family = new A2aFunctionality(diagnosticEnv);
    assert.deepEqual(await family.admit({ alias: "peer", definition: { name: "peer", url: "https://peer.example" } }), { alias: "peer", definition: { name: "peer", url: "https://peer.example" } });
    assert.equal((await problemOf(() => family.admit({ alias: "other", definition: { name: "peer", url: "https://peer.example" } }))).type, "https://problems.plurnk.xyz/a2a/functionality/alias-mismatch");
    assert.equal((await problemOf(() => family.admit({ alias: "peer", definition: { name: "peer", url: "https://peer.example", authorization: { type: "bearer", token: "literal-secret" } } }))).type, "https://problems.plurnk.xyz/a2a/functionality/definition-invalid");
    assert.equal((await problemOf(() => family.admit({ definition: { name: "peer", url: "https://" } }))).type, "https://problems.plurnk.xyz/a2a/functionality/definition-invalid");
    assert.equal((await problemOf(() => family.admit({ definition: { name: "peer", url: "https://peer.example", headers: { authorization: "custom" }, authorization: { type: "bearer", token: "${TOKEN}" } } }))).type, "https://problems.plurnk.xyz/a2a/functionality/definition-invalid");
    assert.equal(aliasOfCard({ name: "  Weird/Name 9 " } as never), "weird-name-9");
    assert.equal(aliasOfCard({ name: "42" } as never), "agent-42");
});

test("preparation attaches through the discovered card, reuses unchanged attachments, isolates failures, and resolves per workspace", async () => {
    const agent = await startDemoAgent();
    try {
        const family = new A2aFunctionality({ ...diagnosticEnv, TOKEN: "s3cret" });
        const researcher = { name: "researcher", url: agent.baseUrl, authorization: { type: "bearer", token: "${TOKEN}" } };
        const ghost = { name: "ghost", url: "http://127.0.0.1:9" };
        const first = await family.prepare(preparation(7, { researcher, ghost }));
        assert.equal("runtimes" in first, false, "outbound agents hold no processes; runtimes is the resident family's facet");
        const active = first.outcomes.get("researcher");
        assert.equal(active?.state, "active");
        assert.deepEqual((active as { detail: object }).detail, {
            name: "Plurnk A2A protocol witness",
            version: "1.0.0",
            description: "Independent deterministic A2A v1 test agent",
            skills: ["echo"],
            streaming: true,
        });
        const unavailable = first.outcomes.get("ghost");
        assert.equal(unavailable?.state, "unavailable");
        assert.equal((unavailable as { problem: { type: string } }).problem.type, "https://problems.plurnk.xyz/a2a/functionality/card-unreachable");
        assert.deepEqual(first.documents.map(({ pathname }) => pathname), ["a2a/researcher.md"]);
        assert.equal(first.documents[0]!.content, renderAgent("researcher", agent.card));
        assert.match(first.documents[0]!.content, /^# researcher\n\n## Summary\n\na2a:\/\/researcher — Plurnk A2A protocol witness v1\.0\.0: Independent deterministic A2A v1 test agent\n/u);
        assert.doesNotMatch(first.documents[0]!.content, /## Skills/u, "skills live only in the pulled card");
        assert.match(first.documents[0]!.content, /```SEND \(a2a:\/\/researcher\)/u);

        // Before commit the Worker resolves nothing; after commit it resolves its own aliases only.
        assert.equal(family.resolve("researcher", 7), null);
        await first.commit();
        assert.ok(family.resolve("researcher", 7) !== null, "an active alias resolves to its client");
        assert.equal(family.resolve("researcher", 8), null, "another Worker sees nothing");
        assert.equal(family.resolve("missing", 7), null);
        assert.throws(() => family.resolve("ghost", 7), (error: A2aFunctionalityError) => error.problem.type === "https://problems.plurnk.xyz/a2a/functionality/card-unreachable", "an unavailable alias raises its exact Problem");

        // A client mutation on an unrelated alias does not re-reject the carried failure; retrying ghost does.
        const second = await family.prepare(preparation(7, { researcher, ghost }, { previous: first.snapshot, failure: "reject" }));
        assert.equal(second.outcomes.get("ghost")?.state, "unavailable");
        assert.equal((await problemOf(() => family.prepare(preparation(7, { researcher, ghost }, { previous: first.snapshot, failure: "reject", force: "ghost" })))).type, "https://problems.plurnk.xyz/a2a/functionality/card-unreachable");
        // Disabling withdraws the attachment and document.
        const third = await family.prepare(preparation(7, {}, { previous: first.snapshot }));
        assert.deepEqual(third.documents, []);
        await third.commit();
        assert.equal(family.resolve("researcher", 7), null);
        await family.teardown(third.snapshot, { workspaceId: 7 });
    } finally {
        await agent.close();
    }
});

test("symbolic references that cannot be resolved make the alias unavailable without contacting the host", async () => {
    const family = new A2aFunctionality(diagnosticEnv);
    const prepared = await family.prepare(preparation(3, { peer: { name: "peer", url: "http://127.0.0.1:9", headers: { "X-Key": "${MISSING_KEY}" } } }));
    const outcome = prepared.outcomes.get("peer") as { state: string; problem: { type: string; retryable?: boolean } };
    assert.equal(outcome.state, "unavailable");
    assert.equal(outcome.problem.type, "https://problems.plurnk.xyz/a2a/functionality/authorization-unresolved");
    assert.equal(outcome.problem.retryable, false, "the same unresolved environment reference cannot be replayed automatically");
});

test("{§a2a-outbound-credentials} an oauth2 definition obtains its token from the card's flow, presents it, obtains it again on 401, and names what the agent refuses", async () => {
    const agent = await startDemoAgent("complete", undefined, { clientId: "plurnk", clientSecret: "agent-secret" });
    try {
        const family = new A2aFunctionality({ ...diagnosticEnv, SECRET: "agent-secret", WRONG: "nope" });
        const definition = (clientSecret: string) => ({ name: "peer", url: agent.baseUrl, authorization: { type: "oauth2", clientId: "plurnk", clientSecret } });
        const prepared = await family.prepare(preparation(3, { peer: definition("${SECRET}") }));
        assert.equal(prepared.outcomes.get("peer")?.state, "active", JSON.stringify(prepared.outcomes.get("peer")));
        assert.deepEqual(agent.tokenRequests, [{ clientId: "plurnk", clientSecret: "agent-secret", scope: "echo" }], "preparation minted once, with the card's scope, after discovering the card without it");
        await prepared.commit();
        const client = family.resolve("peer", 3);
        assert.ok(client !== null);
        await assert.rejects(client.getTask({ tenant: "", id: "missing-task", historyLength: 0 }), /not found/iu, "the token admits the client at the agent");
        await assert.rejects(client.getTask({ tenant: "", id: "missing-task", historyLength: 0 }), /not found/iu);
        assert.equal(agent.tokenRequests.length, 1, "a live token is reused across requests");

        const refused = await family.prepare(preparation(4, { peer: definition("${WRONG}") }));
        assert.equal(refused.outcomes.get("peer")?.state, "unavailable", "a wrong secret is a preparation outcome");
        const problem = (refused.outcomes.get("peer") as { problem: { type: string; diagnostic?: string } }).problem;
        assert.equal(problem.type, "https://problems.plurnk.xyz/a2a/functionality/token-unobtainable");
        assert.match(String(problem.diagnostic), /invalid_client: The client secret is wrong\./u);
    } finally { await agent.close(); }
    const silent = await startDemoAgent("complete", undefined, { clientId: "plurnk", clientSecret: "agent-secret", declared: false });
    try {
        const family = new A2aFunctionality({ ...diagnosticEnv, SECRET: "agent-secret" });
        const unknown = await family.prepare(preparation(5, { peer: { name: "peer", url: silent.baseUrl, authorization: { type: "oauth2", clientId: "plurnk", clientSecret: "${SECRET}" } } }));
        assert.equal(unknown.outcomes.get("peer")?.state, "unavailable");
        assert.equal((unknown.outcomes.get("peer") as { problem: { type: string } }).problem.type, "https://problems.plurnk.xyz/a2a/functionality/token-endpoint-unknown");
        const named = await family.prepare(preparation(6, { peer: { name: "peer", url: silent.baseUrl, authorization: { type: "oauth2", clientId: "plurnk", clientSecret: "${SECRET}", tokenUrl: `${silent.baseUrl}/oauth/token`, scope: "echo" } } }));
        assert.equal(named.outcomes.get("peer")?.state, "active", "a definition may name the endpoint the card does not");
        assert.deepEqual(silent.tokenRequests, [{ clientId: "plurnk", clientSecret: "agent-secret", scope: "echo" }]);
    } finally { await silent.close(); }
});
