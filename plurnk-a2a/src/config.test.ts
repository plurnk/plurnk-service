import test from "node:test";
import assert from "node:assert/strict";
import {
    connectTimeoutMs,
    hostedAgentConfiguration,
    outboundDefinitions,
    requestTimeoutMs,
    validateConfiguration,
} from "./config.ts";

const floor = {
    PLURNK_A2A_ENABLED: "1",
    PLURNK_A2A_CONNECT_TIMEOUT: "30000",
    PLURNK_A2A_REQUEST_TIMEOUT: "86400000",
    PLURNK_A2A_ERROR_DETAIL_LIMIT: "512",
    PLURNK_A2A_PROPOSALS: "reject",
    PLURNK_A2A_TOKEN: "",
};

test("{§operator-config-offline-validation} A2A validation checks definitions, exposure and bounds without discovery", () => {
    assert.doesNotThrow(() => validateConfiguration({ ...floor, PLURNK_A2A_future_ENABLED: "0" }));
    for (const [key, value] of Object.entries({
        PLURNK_A2A_CONNECT_TIMEOUT: "0", PLURNK_A2A_REQUEST_TIMEOUT: "0", PLURNK_A2A_ERROR_DETAIL_LIMIT: "-1",
        PLURNK_A2A_EXPOSE: "yes", PLURNK_A2A_future_ENABLED: "bad", PLURNK_A2A_invalid: "{}",
    })) {
        assert.throws(() => validateConfiguration({ ...floor, [key]: value }), (error: Error) => error.message.includes(key));
    }
});

test("{§a2a-environment-projection} whole definitions preserve discovery targets and symbolic credentials", () => {
    const definition = {
        name: "code-search", url: "https://agent.example", cardPath: "/agents/research/card.json",
        headers: { "X-Tenant": "${RESEARCH_TENANT}" },
        authorization: { type: "bearer", token: "${RESEARCH_TOKEN}" },
    };
    const env = { ...floor, PLURNK_A2A_code_search: JSON.stringify(definition), PLURNK_A2A_code_search_ENABLED: "0" };
    assert.deepEqual(outboundDefinitions(env), [{ alias: "code-search", definition, enabled: false }]);
    assert.deepEqual(outboundDefinitions({ ...env, PLURNK_A2A_code_search_ENABLED: "1" }), [{ alias: "code-search", definition, enabled: true }]);
    assert.deepEqual(outboundDefinitions(floor), []);
    const replacement = { name: "code-search", url: "https://other.example" };
    assert.deepEqual(outboundDefinitions({ ...env, PLURNK_A2A_code_search: JSON.stringify(replacement) }), [
        { alias: "code-search", definition: replacement, enabled: false },
    ], "a replacement cannot inherit headers, authorization or a card path from the old endpoint");
});

test("{§a2a-environment-projection} lowercase aliases remain distinct from uppercase controls", () => {
    const definitions = outboundDefinitions({
        ...floor, PLURNK_A2A_ENABLED: "0", PLURNK_A2A_name_ENABLED: "1",
        PLURNK_A2A_port: JSON.stringify({ name: "port", url: "https://port.example" }),
        PLURNK_A2A_name: JSON.stringify({ name: "name", url: "https://name.example" }),
        PLURNK_A2A_NAME: "Hosted name",
    });
    assert.deepEqual(definitions.map(({ alias, enabled }) => ({ alias, enabled })), [
        { alias: "name", enabled: true }, { alias: "port", enabled: false },
    ]);
    for (const key of ["PLURNK_A2A_RESEARCH", "PLURNK_A2A_Research", "PLURNK_A2A_code-search"]) {
        assert.throws(() => outboundDefinitions({ ...floor, [key]: "private-definition" }), new RegExp(key + " .*lowercase", "u"));
    }
    assert.throws(() => outboundDefinitions({ ...floor, PLURNK_A2A_research_HEADERS: "{}" }), /PLURNK_A2A_research_HEADERS names unsupported resource setting/u);
    assert.deepEqual(outboundDefinitions({ ...floor, PLURNK_A2A_missing_ENABLED: "0" }), [], "controls for future definitions do not manufacture agents");
    assert.throws(() => outboundDefinitions({ ...floor, PLURNK_A2A_missing_ENABLED: "true" }), /PLURNK_A2A_missing_ENABLED must be 0 or 1/u);
    assert.throws(() => outboundDefinitions({ ...floor, PLURNK_A2A_ENABLED: '["research"]' }), /PLURNK_A2A_ENABLED must be 0 or 1/u);
    const { PLURNK_A2A_ENABLED: _unset, ...missing } = floor;
    assert.throws(() => outboundDefinitions(missing), /PLURNK_A2A_ENABLED is missing from the assembled environment floor/u);
});

test("{§a2a-environment-projection} empty and invalid definitions fail even when disabled, without disclosing their values", () => {
    for (const raw of ["", " \t"]) {
        assert.throws(() => outboundDefinitions({ ...floor, PLURNK_A2A_research: raw, PLURNK_A2A_research_ENABLED: "0" }), /PLURNK_A2A_research must contain a definition/u);
    }
    const definition = { name: "research", url: "https://agent.example" };
    const invalid = [
        "not json", "null", "[]", "{}",
        JSON.stringify({ ...definition, url: "https://" }),
        JSON.stringify({ ...definition, url: "file:///private-definition" }),
        JSON.stringify({ ...definition, cardPath: "/path?query=1" }),
        JSON.stringify({ ...definition, authorization: { type: "bearer", token: "literal-secret" } }),
        JSON.stringify({ ...definition, authorization: { type: "bearer", token: "${TOKEN}" }, headers: { aUtHoRiZaTiOn: "private-definition" } }),
    ];
    for (const raw of invalid) {
        assert.throws(() => outboundDefinitions({ ...floor, PLURNK_A2A_research: raw, PLURNK_A2A_research_ENABLED: "0" }), {
            message: "PLURNK_A2A_research must be an A2A agent definition.",
        });
    }
    assert.throws(() => outboundDefinitions({ ...floor, PLURNK_A2A_other: JSON.stringify(definition) }), {
        message: "PLURNK_A2A_other must define name 'other'.",
    });
});

test("{§a2a-hosted-card} the hosted card derives identity from environment and protocol claims from implementation", () => {
    const config = hostedAgentConfiguration({
        ...floor,
        PLURNK_A2A_EXPOSE: "1",
        PLURNK_A2A_ENDPOINT_PATH: "/a2a",
        PLURNK_A2A_ENDPOINT_URL: "https://agent.example/a2a",
        PLURNK_A2A_WORKSPACE: "research",
        PLURNK_A2A_PROJECT_ROOT: "/srv/research",
        PLURNK_A2A_NAME: "Research agent",
        PLURNK_A2A_DESCRIPTION: "Researches questions through Plurnk",
        PLURNK_A2A_VERSION: "1.0.0",
        PLURNK_A2A_PROVIDER_ORGANIZATION: "Example",
        PLURNK_A2A_PROVIDER_URL: "https://example.com",
        PLURNK_A2A_DOCUMENTATION_URL: "https://example.com/docs",
        PLURNK_A2A_ICON_URL: "https://example.com/icon.svg",
        PLURNK_A2A_SKILLS: JSON.stringify([{
            id: "research",
            name: "Research",
            description: "Researches a question",
            tags: ["research"],
            examples: ["Compare two accounts."],
        }]),
    });
    assert.ok(config !== null);
    assert.equal(config.token, "", "the floor's empty token is an unauthenticated exposure");
    assert.deepEqual(config.workspace, {
        name: "research",
        projectRoot: "/srv/research",
    });
    assert.deepEqual(config.card.supportedInterfaces, [{
        url: "https://agent.example/a2a",
        protocolBinding: "HTTP+JSON",
        protocolVersion: "1.0",
        tenant: "",
    }]);
    assert.deepEqual(config.card.capabilities, {
        streaming: true,
        pushNotifications: false,
        extensions: [],
        extendedAgentCard: false,
    });
    assert.deepEqual(config.card.securitySchemes, {});
    assert.deepEqual(config.card.securityRequirements, []);
    assert.deepEqual(config.card.defaultInputModes, ["*/*"]);
    assert.deepEqual(config.card.defaultOutputModes, ["*/*"]);
    assert.deepEqual(config.card.skills, [{
        id: "research",
        name: "Research",
        description: "Researches a question",
        tags: ["research"],
        examples: ["Compare two accounts."],
        inputModes: ["*/*"],
        outputModes: ["*/*"],
        securityRequirements: [],
    }]);
});

test("{§a2a-hosted-proposals} an inbound loop settles its own proposals, and review is outside the vocabulary", () => {
    const hosted = {
        ...floor,
        PLURNK_A2A_EXPOSE: "1",
        PLURNK_A2A_ENDPOINT_PATH: "/a2a",
        PLURNK_A2A_WORKSPACE: "research",
        PLURNK_A2A_NAME: "Research agent",
        PLURNK_A2A_DESCRIPTION: "Researches questions",
        PLURNK_A2A_VERSION: "1.0.0",
        PLURNK_A2A_SKILLS: "[]",
    };
    assert.equal(hostedAgentConfiguration(hosted)?.proposals, "reject");
    assert.equal(hostedAgentConfiguration({ ...hosted, PLURNK_A2A_PROPOSALS: "accept" })?.proposals, "accept");
    assert.throws(
        () => hostedAgentConfiguration({ ...hosted, PLURNK_A2A_PROPOSALS: "review" }),
        /PLURNK_A2A_PROPOSALS must be one of accept, reject; got "review"/,
    );
    const { PLURNK_A2A_PROPOSALS: _unset, ...missing } = hosted;
    assert.throws(() => hostedAgentConfiguration(missing), /PLURNK_A2A_PROPOSALS is required when PLURNK_A2A_EXPOSE=1/);
});

test("hosted exposure is disabled without identity requirements and rejects unsupported declarations", () => {
    assert.equal(hostedAgentConfiguration({ ...floor, PLURNK_A2A_EXPOSE: "0" }), null);
    assert.equal(hostedAgentConfiguration(floor), null);
    assert.throws(
        () => hostedAgentConfiguration({
            ...floor,
            PLURNK_A2A_EXPOSE: "1",
            PLURNK_A2A_ENDPOINT_PATH: "/a2a",
            PLURNK_A2A_WORKSPACE: "research",
            PLURNK_A2A_NAME: "Research agent",
            PLURNK_A2A_DESCRIPTION: "Researches questions",
            PLURNK_A2A_VERSION: "1.0.0",
            PLURNK_A2A_PROVIDER_ORGANIZATION: "Example",
            PLURNK_A2A_SKILLS: "[]",
        }),
        /PROVIDER_ORGANIZATION.*PROVIDER_URL.*together/,
    );
    assert.throws(
        () => hostedAgentConfiguration({
            ...floor,
            PLURNK_A2A_EXPOSE: "1",
            PLURNK_A2A_ENDPOINT_PATH: "/a2a",
            PLURNK_A2A_WORKSPACE: "research",
            PLURNK_A2A_NAME: "Research agent",
            PLURNK_A2A_DESCRIPTION: "Researches questions",
            PLURNK_A2A_VERSION: "1.0.0",
            PLURNK_A2A_SKILLS: '[{"id":"x","name":"X","description":"X","securityRequirements":[{}]}]',
        }),
        /securityRequirements.*absent or empty/,
    );
});

test("{§env-knob} A2A timeouts use the shared safe-integer reader", () => {
    assert.equal(connectTimeoutMs(floor), 30_000);
    assert.equal(requestTimeoutMs(floor), 86_400_000);
    assert.throws(
        () => connectTimeoutMs({ PLURNK_A2A_CONNECT_TIMEOUT: "0" }),
        { message: 'PLURNK_A2A_CONNECT_TIMEOUT must be a safe integer of at least 1; got "0".' },
    );
    assert.throws(() => requestTimeoutMs({ PLURNK_A2A_REQUEST_TIMEOUT: "9007199254740992" }), {
        message: 'PLURNK_A2A_REQUEST_TIMEOUT must be a safe integer of at least 1; got "9007199254740992".',
    });
    assert.throws(() => connectTimeoutMs({}), {
        message: "PLURNK_A2A_CONNECT_TIMEOUT is missing from the assembled environment floor.",
    });
});

test("{§a2a-hosted-bearer} the token is the floor's to state: empty is open, a value is the bearer, absence is a broken floor", () => {
    const hosted = {
        ...floor,
        PLURNK_A2A_EXPOSE: "1",
        PLURNK_A2A_ENDPOINT_PATH: "/a2a",
        PLURNK_A2A_WORKSPACE: "research",
        PLURNK_A2A_NAME: "Research agent",
        PLURNK_A2A_DESCRIPTION: "Researches questions",
        PLURNK_A2A_VERSION: "1.0.0",
        PLURNK_A2A_SKILLS: "[]",
    };
    assert.equal(hostedAgentConfiguration(hosted)?.token, "");
    assert.equal(hostedAgentConfiguration({ ...hosted, PLURNK_A2A_TOKEN: "s3cret" })?.token, "s3cret");
    const { PLURNK_A2A_TOKEN: _unset, ...missing } = hosted;
    assert.throws(() => hostedAgentConfiguration(missing), /PLURNK_A2A_TOKEN is missing from the assembled environment floor/);
    assert.deepEqual(outboundDefinitions({ ...floor, PLURNK_A2A_TOKEN: "s3cret" }), [], "the token is a reserved global, never an alias");
});

test("{§a2a-environment-projection} a key that once named the exposure's own listener fails hard, naming the service listener", () => {
    for (const key of ["PLURNK_A2A_HOST", "PLURNK_A2A_PORT"]) {
        assert.throws(
            () => outboundDefinitions({ ...floor, [key]: "4100" }),
            new RegExp(`^Error: ${key} is retired: .*PLURNK_HOST and PLURNK_PORT .*remove it\\.$`, "u"),
            key,
        );
    }
    assert.throws(() => outboundDefinitions({ ...floor, PLURNK_A2A_HOST: "" }), /PLURNK_A2A_HOST is retired/u);
});
