import test from "node:test";
import assert from "node:assert/strict";
import {
    connectTimeoutMs,
    hostedAgentConfiguration,
    outboundAgentDefinition,
    outboundAgentNames,
    outboundDefinitions,
    requestTimeoutMs,
    serviceEnabledNames,
} from "./config.ts";

const floor = {
    PLURNK_A2A_CONNECT_TIMEOUT: "30000",
    PLURNK_A2A_REQUEST_TIMEOUT: "86400000",
    PLURNK_A2A_ERROR_DETAIL_LIMIT: "512",
    PLURNK_A2A_PROPOSALS: "reject",
};

test("outbound configuration preserves standard discovery targets and environment-owned credentials", () => {
    const env = {
        ...floor,
        PLURNK_A2A_RESEARCH: "https://agent.example",
        PLURNK_A2A_RESEARCH_CARD_PATH: "/agents/research/card.json",
        PLURNK_A2A_RESEARCH_BEARER: "${RESEARCH_TOKEN}",
        PLURNK_A2A_RESEARCH_HEADERS: '{"X-Tenant":"${RESEARCH_TENANT}"}',
        PLURNK_A2A_ENABLED: '["research"]',
    };
    assert.deepEqual(outboundAgentNames(env), ["research"]);
    assert.deepEqual(serviceEnabledNames(env), ["research"]);
    assert.deepEqual(outboundAgentDefinition("RESEARCH", env), {
        name: "research",
        url: "https://agent.example",
        cardPath: "/agents/research/card.json",
        headers: { "X-Tenant": "${RESEARCH_TENANT}" },
        authorization: { type: "bearer", token: "${RESEARCH_TOKEN}" },
    });
});

test("{§a2a-environment-projection} empty targets mask definitions and ignore their companions and inherited enabledness", () => {
    const env = {
        ...floor,
        PLURNK_A2A_RESEARCH: "",
        PLURNK_A2A_RESEARCH_CARD_PATH: "not a path",
        PLURNK_A2A_RESEARCH_HEADERS: "not JSON",
        PLURNK_A2A_RESEARCH_BEARER: "not a reference",
        PLURNK_A2A_OTHER: "https://agent.example",
        PLURNK_A2A_ENABLED: '["research","other"]',
    };
    assert.equal(outboundAgentDefinition("RESEARCH", env), null);
    assert.deepEqual(outboundAgentNames(env), ["other"]);
    assert.deepEqual(outboundDefinitions(env), [{ name: "other", url: "https://agent.example" }]);
    assert.deepEqual(serviceEnabledNames(env), ["other"]);
    assert.throws(() => serviceEnabledNames({ ...env, PLURNK_A2A_ENABLED: '["missing"]' }), /unknown A2A agent 'missing'/);
    assert.throws(() => outboundAgentNames({ ...env, PLURNK_A2A_research: "https://agent.example" }), /both derive A2A agent name 'research'/);
});

test("outbound configuration rejects ambiguous aliases, companions, enabledness, and credentials", () => {
    assert.throws(
        () => outboundAgentNames({
            ...floor,
            PLURNK_A2A_RESEARCH: "https://agent.example",
            PLURNK_A2A_research: "https://other.example",
        }),
        /PLURNK_A2A_RESEARCH.*PLURNK_A2A_research.*research/,
    );
    assert.throws(
        () => outboundAgentNames({
            ...floor,
            PLURNK_A2A_RESEARCH_HEADERS: "{}",
        }),
        /PLURNK_A2A_RESEARCH_HEADERS.*PLURNK_A2A_RESEARCH/,
    );
    assert.throws(
        () => serviceEnabledNames({
            ...floor,
            PLURNK_A2A_ENABLED: '["missing"]',
        }),
        /PLURNK_A2A_ENABLED.*unknown A2A agent 'missing'/,
    );
    assert.throws(
        () => serviceEnabledNames({
            ...floor,
            PLURNK_A2A_RESEARCH: "https://agent.example",
            PLURNK_A2A_ENABLED: '["research","research"]',
        }),
        /PLURNK_A2A_ENABLED.*duplicate A2A agent 'research'/,
    );
    assert.throws(
        () => outboundAgentDefinition("research", {
            ...floor,
            PLURNK_A2A_RESEARCH: "https://agent.example",
            PLURNK_A2A_RESEARCH_BEARER: "literal-secret",
        }),
        /PLURNK_A2A_RESEARCH_BEARER.*symbolic environment reference/,
    );
    assert.throws(
        () => outboundAgentDefinition("research", {
            ...floor,
            PLURNK_A2A_RESEARCH: "https://agent.example",
            PLURNK_A2A_RESEARCH_BEARER: "${RESEARCH_TOKEN}",
            PLURNK_A2A_RESEARCH_HEADERS: '{"authorization":"custom"}',
        }),
        /BEARER.*conflicts with Authorization.*HEADERS/,
    );
});

test("{§a2a-hosted-card} the hosted card derives identity from environment and protocol claims from implementation", () => {
    const config = hostedAgentConfiguration({
        ...floor,
        PLURNK_A2A_EXPOSE: "1",
        PLURNK_A2A_HOST: "127.0.0.1",
        PLURNK_A2A_PORT: "0",
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
        PLURNK_A2A_HOST: "127.0.0.1",
        PLURNK_A2A_PORT: "0",
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
            PLURNK_A2A_HOST: "127.0.0.1",
            PLURNK_A2A_PORT: "4100",
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
            PLURNK_A2A_HOST: "127.0.0.1",
            PLURNK_A2A_PORT: "4100",
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

test("timeouts are positive integer configuration", () => {
    assert.equal(connectTimeoutMs(floor), 30_000);
    assert.equal(requestTimeoutMs(floor), 86_400_000);
    assert.throws(
        () => connectTimeoutMs({ PLURNK_A2A_CONNECT_TIMEOUT: "0" }),
        /positive integer/,
    );
});
