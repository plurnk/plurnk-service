import {
    A2A_PROTOCOL_VERSION,
    type AgentCard,
    type StreamResponse,
} from "@a2a-js/sdk";
import assert from "node:assert/strict";
import { A2a, type A2aClientResolver } from "@plurnk/plurnk-a2a";
import type Engine from "../../src/core/Engine.ts";
import ExecutorRegistry, { type Executor } from "../../src/core/ExecutorRegistry.ts";
import type { RuntimeRegistration } from "../../src/server/DaemonModule.ts";

// The listener a test exposes, stated whole: the module holds no default of its own.
export const A2A_LISTENER = Object.freeze({ host: "127.0.0.1", port: 0, endpointPath: "/a2a", proposals: "reject" } as const);

// {§a2a-scheme-face} — the `a2a` runtime reduced to what a face test needs: a manager that is never
// run, carrying the package's own scheme face over the test's resolver.
const MANAGER = {
    runtime: "a2a", glyph: "🧩",
    get manifest() {
        return {
            name: "a2a", authority: "namespace", channels: { results: "application/json" }, defaultChannel: "results",
            category: "data", writableBy: ["plugin"], volatile: true, modelVisible: true, folderScopes: true, traits: ["web"],
        } as never;
    },
    get defaultChannel() { return "results"; },
    get channels() { return { results: { mimetype: "application/json" } }; },
    run: async () => ({ status: 200 }),
    probe: async () => ({ available: true, detail: "fixture" }),
    effect: () => "read",
} as unknown as Executor;
const INVOCATION = { body: { role: "JSON arguments for the verb", required: false }, target: { role: "lifecycle verb", required: true, kind: "literal" }, example: { target: "list" } } as const;

export const a2aFace = (resolve: A2aClientResolver): RuntimeRegistration => ({
    namespaceOwner: "@plurnk/plurnk-a2a",
    decl: { name: "a2a", glyph: "🧩", summary: "Manage A2A agents", invocation: INVOCATION },
    executor: MANAGER,
    availability: { available: true, detail: "fixture" },
    scheme: new A2a(resolve),
});

export const registerA2aFace = (engine: Engine, resolve: A2aClientResolver): void => {
    engine.setExecutors(new ExecutorRegistry(new Map()));
    engine.registerRuntime("a2a", {
        executor: MANAGER, namespaceOwner: { kind: "module", name: "@plurnk/plurnk-a2a" },
        glyph: "🧩", summary: "Manage A2A agents", invocation: INVOCATION, details: "", available: true, detail: "fixture",
    }, new A2a(resolve));
};

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
    defaultInputModes: ["*/*"],
    defaultOutputModes: ["*/*"],
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
