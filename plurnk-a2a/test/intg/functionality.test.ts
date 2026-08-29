// {§a2a-agents-functionality} — the adapter's protocol truth against an
// independent agent: environment definitions, inert discovery, admission,
// preparation outcomes, the per-Worker resolver, and the catalog document.
import assert from "node:assert/strict";
import { test } from "node:test";
import A2aFunctionality, { aliasOfCard, renderAgent, A2aFunctionalityError } from "../../src/Functionality.ts";
import { ERROR_DETAIL_LIMIT } from "../../src/ErrorDetail.ts";
import { startDemoAgent } from "../fixtures/DemoAgent.ts";

const diagnosticEnv = { [ERROR_DETAIL_LIMIT]: "512" };

const preparation = (workerId: number, enabled: Record<string, object>, options: { previous?: unknown; failure?: "publish-unavailable" | "reject"; force?: string } = {}) => ({
    workspaceId: 1,
    workerId,
    enabled: new Map(Object.entries(enabled)),
    previous: options.previous ?? null,
    failure: options.failure ?? "publish-unavailable",
    ...(options.force === undefined ? {} : { force: options.force }),
    retain: () => () => {},
});

const problemOf = async (run: () => Promise<unknown>): Promise<{ type: string; status: number; detail: string; diagnostic?: string }> => {
    try { await run(); } catch (error) {
        assert.ok(error instanceof A2aFunctionalityError, `expected an A2aFunctionalityError, got ${String(error)}`);
        return error.problem as { type: string; status: number; detail: string; diagnostic?: string };
    }
    assert.fail("expected a Problem");
};

test("environment definitions are the service baseline with PLURNK_A2A_ENABLED as the newborn default", async () => {
    const family = new A2aFunctionality({
        ...diagnosticEnv,
        PLURNK_A2A_RESEARCHER: "https://agent.example",
        PLURNK_A2A_RESEARCHER_BEARER: "${RESEARCHER_TOKEN}",
        PLURNK_A2A_SCRIBE: "https://scribe.example",
        PLURNK_A2A_SCRIBE_CARD_PATH: "/cards/scribe.json",
        PLURNK_A2A_ENABLED: '["researcher"]',
    });
    assert.deepEqual(await family.available(), [
        { alias: "researcher", definition: { name: "researcher", url: "https://agent.example", authorization: { type: "bearer", token: "${RESEARCHER_TOKEN}" } }, enabled: true },
        { alias: "scribe", definition: { name: "scribe", url: "https://scribe.example", cardPath: "/cards/scribe.json" }, enabled: false },
    ]);
});

test("A2A Problems bound caught diagnostics and keep request facts out of prose", async () => {
    const family = new A2aFunctionality({ [ERROR_DETAIL_LIMIT]: "4" });
    const invalidSource = await problemOf(() => family.discover({ source: "ftp://sensitive.example" }));
    assert.equal(invalidSource.detail, "A2A discovery requires an absolute HTTP(S) agent URL.");
    assert.doesNotMatch(invalidSource.detail, /sensitive/u);

    const invalidConfiguration = await problemOf(() => family.discover({ configuration: { PLURNK_A2A_BAD: "not a url" } }));
    assert.equal(invalidConfiguration.detail, "The offered A2A configuration is invalid.");
    assert.equal(invalidConfiguration.diagnostic?.length, 7);
    assert.match(invalidConfiguration.diagnostic ?? "", /\.\.\.$/u);
    assert.doesNotMatch(JSON.stringify(invalidConfiguration), /not a url/u);
});

test("discovery is inert: a URL yields one card-derived candidate, configuration yields overlay candidates, a query is refused", async () => {
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
        assert.deepEqual(await family.discover({ configuration: { PLURNK_A2A_LOCAL: agent.baseUrl, PLURNK_A2A_ENABLED: '["local"]', IGNORED: 1 } }), [
            { alias: "local", definition: { name: "local", url: agent.baseUrl }, provenance: { kind: "client-configuration", source: "PLURNK_A2A_LOCAL" } },
        ]);
        assert.equal((await problemOf(() => family.discover({ source: "ftp://nope" }))).type, "https://problems.plurnk.xyz/a2a/functionality/source-invalid");
        assert.equal((await problemOf(() => family.discover({ source: "http://127.0.0.1:9" }))).type, "https://problems.plurnk.xyz/a2a/functionality/card-unreachable");
        assert.equal((await problemOf(() => family.discover({ query: "research" }))).status, 501);
        assert.equal((await problemOf(() => family.discover({ configuration: { PLURNK_A2A_BAD: "not a url" } }))).type, "https://problems.plurnk.xyz/a2a/functionality/configuration-invalid");
    } finally {
        await agent.close();
    }
});

test("admission validates the exact definition and the alias/name identity", async () => {
    const family = new A2aFunctionality(diagnosticEnv);
    assert.deepEqual(await family.admit({ alias: "peer", definition: { name: "peer", url: "https://peer.example" } }), { alias: "peer", definition: { name: "peer", url: "https://peer.example" } });
    assert.equal((await problemOf(() => family.admit({ alias: "other", definition: { name: "peer", url: "https://peer.example" } }))).type, "https://problems.plurnk.xyz/a2a/functionality/alias-mismatch");
    assert.equal((await problemOf(() => family.admit({ alias: "peer", definition: { name: "peer", url: "https://peer.example", authorization: { type: "bearer", token: "literal-secret" } } }))).type, "https://problems.plurnk.xyz/a2a/functionality/definition-invalid");
    assert.equal(aliasOfCard({ name: "  Weird/Name 9 " } as never), "weird-name-9");
    assert.equal(aliasOfCard({ name: "42" } as never), "agent-42");
});

test("preparation attaches through the discovered card, reuses unchanged attachments, isolates failures, and resolves per Worker", async () => {
    const agent = await startDemoAgent();
    try {
        const family = new A2aFunctionality({ ...diagnosticEnv, TOKEN: "s3cret" });
        const researcher = { name: "researcher", url: agent.baseUrl, authorization: { type: "bearer", token: "${TOKEN}" } };
        const ghost = { name: "ghost", url: "http://127.0.0.1:9" };
        const first = await family.prepare(preparation(7, { researcher, ghost }));
        assert.equal(first.runtimes.length, 0);
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
        assert.deepEqual(first.documents.map(({ pathname }) => pathname), ["agents/researcher.md"]);
        assert.equal(first.documents[0]!.content, renderAgent("researcher", agent.card));
        assert.match(first.documents[0]!.content, /^# researcher\n\n## Summary\n\na2a:\/\/researcher — Plurnk A2A protocol witness v1\.0\.0: Independent deterministic A2A v1 test agent\n/u);
        assert.doesNotMatch(first.documents[0]!.content, /## Skills/u, "skills live only in the pulled card");
        assert.match(first.documents[0]!.content, /## SEND0 \[200\] \(a2a:\/\/researcher\)/u);

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
        await family.teardown(third.snapshot, { workspaceId: 1, workerId: 7 });
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
