#!/usr/bin/env node

import type { Tool } from "@modelcontextprotocol/client";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
    McpServerDefinition,
} from "@plurnk/plurnk-contracts";
import ServerConnection, { AuthorizationRequiredError } from "../src/client.ts";

interface ConformanceContext {
    readonly client_id?: string;
    readonly client_secret?: string;
    readonly toolCalls?: readonly {
        readonly name: string;
        readonly arguments: Record<string, unknown>;
    }[];
}

const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const serverUrl = process.argv[2];
if (scenario === undefined || serverUrl === undefined) {
    throw new Error("MCP_CONFORMANCE_SCENARIO and the conformance server URL are required.");
}

const context = process.env.MCP_CONFORMANCE_CONTEXT === undefined
    ? {} satisfies ConformanceContext
    : JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT) as ConformanceContext;

const definition = (
    authorization?: McpServerDefinition["authorization"],
): McpServerDefinition => ({
    name: "conformance",
    transport: "http",
    url: serverUrl,
    ...(authorization === undefined ? {} : { authorization }),
});

const interaction = async (
    request: ClientInteractionRequest,
): Promise<ClientInteractionResolution> => {
    const requests = request.arguments.requests as Record<string, {
        readonly method?: string;
        readonly params?: { readonly mode?: string };
    }>;
    return {
        status: "resolved",
        payload: Object.fromEntries(Object.entries(requests).map(([key, value]) => [
            key,
            value.params?.mode === "url"
                ? { action: "accept" }
                : { action: "accept", content: { confirmed: true } },
        ])),
    };
};

const withConnection = async <T>(
    connection: ServerConnection,
    run: () => Promise<T>,
): Promise<T> => {
    try {
        const result = await run();
        await connection.close();
        return result;
    } catch (cause) {
        try {
            await connection.close();
        } catch (closeCause) {
            throw new AggregateError(
                [cause, closeCause],
                "MCP conformance operation and connection shutdown both failed.",
            );
        }
        throw cause;
    }
};

const authorize = async (connection: ServerConnection, authorizationUrl: string): Promise<void> => {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    const location = response.headers.get("location");
    if (location === null) {
        throw new Error(`Authorization endpoint returned ${response.status} without a callback location.`);
    }
    await connection.finishAuthorization(new URL(location, authorizationUrl).href);
};

const withInteractiveAuthorization = async <T>(
    connection: ServerConnection,
    operation: () => Promise<T>,
): Promise<T> => {
    for (let round = 0; round < 3; round += 1) {
        try {
            return await operation();
        } catch (error) {
            if (!(error instanceof AuthorizationRequiredError)) throw error;
            await authorize(connection, error.authorizationUrl);
        }
    }
    throw new Error("MCP OAuth authorization did not converge after three user authorization rounds.");
};

const findTool = (tools: readonly Tool[], name: string): Tool => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Conformance server did not advertise tool '${name}'.`);
    return tool;
};

const runCore = async (): Promise<void> => {
    const connection = new ServerConnection(definition());
    await withConnection(connection, async () => {
        if (scenario === "request-metadata" || scenario === "json-schema-ref-no-deref") {
            await connection.tools();
            return;
        }
        if (scenario === "tools_call") {
            const tools = await connection.tools();
            const tool = findTool(tools, "add_numbers");
            await connection.callTool(tool.name, { a: 2, b: 3 }, undefined, undefined, undefined, tool);
            return;
        }
        if (scenario === "sep-2322-client-request-state") {
            const tools = await connection.tools();
            for (const name of [
                "test_mrtr_echo_state",
                "test_mrtr_no_state",
                "test_mrtr_unrelated",
            ]) {
                const tool = findTool(tools, name);
                await connection.callTool(name, {}, undefined, undefined, interaction, tool);
            }
            const invalid = findTool(tools, "test_mrtr_no_result_type");
            try {
                await connection.callTool(invalid.name, {}, undefined, undefined, interaction, invalid);
            } catch (error) {
                if (!String(error).includes("missing required resultType")) throw error;
            }
            return;
        }
        if (scenario === "http-standard-headers") {
            const tools = await connection.tools();
            const prompts = await connection.prompts();
            const tool = tools[0];
            const prompt = prompts[0];
            if (tool !== undefined) {
                await connection.callTool(tool.name, {}, undefined, undefined, undefined, tool);
            }
            try {
                await connection.resources();
            } catch (error) {
                if (!String(error).includes("resources/templates/list")) throw error;
            }
            await connection.readResource("file:///path/to/file%20name.txt");
            if (prompt !== undefined) await connection.getPrompt(prompt.name, undefined);
            return;
        }
        if (scenario === "http-custom-headers") {
            const tools = await connection.tools();
            for (const call of context.toolCalls ?? []) {
                const tool = findTool(tools, call.name);
                await connection.callTool(
                    tool.name,
                    call.arguments,
                    undefined,
                    undefined,
                    undefined,
                    tool,
                );
            }
            return;
        }
        if (scenario === "http-invalid-tool-headers") {
            const tools = await connection.tools();
            const valid = findTool(tools, "valid_tool");
            await connection.callTool(
                valid.name,
                { region: "us-west1" },
                undefined,
                undefined,
                undefined,
                valid,
            );
            for (const tool of tools.filter((candidate) => candidate.name.startsWith("invalid_"))) {
                try {
                    await connection.callTool(
                        tool.name,
                        {},
                        undefined,
                        undefined,
                        undefined,
                        tool,
                    );
                } catch {
                    // Invalid x-mcp-header declarations must be rejected before transport admission.
                }
            }
            return;
        }
        if (scenario === "json-schema-2020-12-preservation") {
            const tools = await connection.tools();
            const source = findTool(tools, "json_schema_2020_12_tool");
            const echo = findTool(tools, "json_schema_echo");
            await connection.callTool(
                echo.name,
                { schema: source.inputSchema },
                undefined,
                undefined,
                undefined,
                echo,
            );
            return;
        }
        throw new Error(`No Plurnk conformance flow is defined for '${scenario}'.`);
    });
};

const runClientCredentials = async (): Promise<void> => {
    if (context.client_id === undefined || context.client_secret === undefined) {
        throw new Error(`Conformance scenario '${scenario}' omitted client credentials.`);
    }
    const environment = { ...process.env, MCP_CONFORMANCE_CLIENT_SECRET: context.client_secret };
    const connection = new ServerConnection(definition({
        type: "client-credentials",
        clientId: context.client_id,
        clientSecret: "${MCP_CONFORMANCE_CLIENT_SECRET}",
    }), environment);
    await withConnection(connection, async () => {
        await connection.tools();
    });
};

const runOAuth = async (): Promise<void> => {
    const preRegistered = scenario === "auth/pre-registration";
    const environment = preRegistered && context.client_secret !== undefined
        ? { ...process.env, MCP_CONFORMANCE_CLIENT_SECRET: context.client_secret }
        : process.env;
    const authorization: McpServerDefinition["authorization"] = preRegistered
        ? {
            type: "oauth",
            redirectUrl: "http://localhost:3000/callback",
            clientId: context.client_id ?? "",
            clientSecret: "${MCP_CONFORMANCE_CLIENT_SECRET}",
        }
        : {
            type: "oauth",
            redirectUrl: "http://localhost:3000/callback",
            clientMetadataUrl: "https://conformance-test.local/client-metadata.json",
        };
    const connection = new ServerConnection(definition(authorization), environment);
    await withConnection(connection, async () => {
        const tools = await withInteractiveAuthorization(connection, () => connection.tools());
        const tool = tools.find((candidate) => candidate.name === "test-tool");
        if (tool !== undefined) {
            await withInteractiveAuthorization(connection, () => connection.callTool(
                tool.name,
                {},
                undefined,
                undefined,
                undefined,
                tool,
            ));
        }
    });
};

if (scenario === "auth/client-credentials-basic") {
    await runClientCredentials();
} else if (scenario.startsWith("auth/") && ![
    "auth/client-credentials-jwt",
    "auth/enterprise-managed-authorization",
    "auth/dpop",
    "auth/dpop-nonce",
    "auth/wif-jwt-bearer",
].includes(scenario)) {
    await runOAuth();
} else if (scenario.startsWith("auth/")) {
    throw new Error(`Plurnk does not advertise optional MCP extension scenario '${scenario}'.`);
} else {
    await runCore();
}
