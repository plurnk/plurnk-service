import {
    A2A_PROTOCOL_VERSION,
    type AgentCard,
    type StreamResponse,
} from "@a2a-js/sdk";
import assert from "node:assert/strict";

export const a2aCard = (): AgentCard => ({
    name: "Plurnk composed A2A agent",
    description: "Deterministic Plurnk Core composition witness",
    supportedInterfaces: [{
        url: "",
        protocolBinding: "HTTP+JSON",
        protocolVersion: A2A_PROTOCOL_VERSION,
        tenant: "",
    }],
    provider: {
        organization: "Plurnk",
        url: "https://plurnk.xyz",
    },
    version: "1.0.0",
    capabilities: {
        streaming: true,
        pushNotifications: false,
        extensions: [],
        extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/markdown"],
    skills: [{
        id: "general",
        name: "General agent",
        description: "Completes general work inside its Plurnk workspace",
        tags: ["general"],
        examples: ["Compare the evidence and report the result."],
        inputModes: ["text/plain"],
        outputModes: ["text/markdown"],
        securityRequirements: [],
    }],
    documentationUrl: "",
    signatures: [],
});

export const streamPayload = (
    event: StreamResponse,
): NonNullable<StreamResponse["payload"]> => {
    assert.ok(event.payload, "the A2A stream item carries a payload");
    return event.payload;
};
