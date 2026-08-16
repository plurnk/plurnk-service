import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";
import ServerConnection, { type ClientInteractionHandler } from "./client.ts";

const fixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000",
};

const configured = (): ServerConnection => new ServerConnection({
    name: "interaction",
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
}, env);

const resolved = (payload: unknown): ClientInteractionResolution => ({
    status: "resolved",
    payload,
});

test("one input_required round becomes one atomic client interaction", async () => {
    const connection = configured();
    const requests: ClientInteractionRequest[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        requests.push(request);
        return resolved({
            profile: { action: "accept", content: { name: "Ada" } },
            approval: { action: "decline" },
        });
    };
    try {
        const result = await connection.callTool("batch", {}, undefined, undefined, interact);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]?.toolName, "mcp_input_required");
        assert.equal(requests[0]?.arguments.server, "interaction");
        assert.equal(requests[0]?.arguments.operation, "tools/call");
        assert.deepEqual(Object.keys(requests[0]?.arguments.requests as object).toSorted(), [
            "approval",
            "profile",
        ]);
        assert.equal(JSON.stringify(requests[0]).includes("round-one"), false);
        assert.deepEqual(
            (requests[0]?.responseSchema.properties as Record<string, unknown> | undefined)
                && Object.keys(requests[0]!.responseSchema.properties as object).toSorted(),
            ["approval", "profile"],
        );
        assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Ada/);
    } finally {
        await connection.close();
    }
});

test("multi-round tool calls preserve opaque state and fresh interaction responses", async () => {
    const connection = configured();
    const requests: ClientInteractionRequest[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        requests.push(request);
        return requests.length === 1
            ? resolved({ name: { action: "accept", content: { name: "Ada" } } })
            : resolved({ confirm: { action: "accept", content: { confirm: true } } });
    };
    try {
        const result = await connection.callTool("round-trip", {}, undefined, undefined, interact);
        assert.deepEqual(requests.map(({ arguments: args }) =>
            Object.keys(args.requests as object)), [["name"], ["confirm"]]);
        assert.ok(requests.every((request) => !JSON.stringify(request).includes("opaque")));
        assert.deepEqual(result.content, [{ type: "text", text: "Ada confirmed" }]);
    } finally {
        await connection.close();
    }
});

test("client cancellation becomes a standard elicitation cancellation response", async () => {
    const connection = configured();
    try {
        const result = await connection.callTool(
            "batch",
            {},
            undefined,
            undefined,
            async () => ({ status: "cancelled" }),
        );
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        assert.match(text, /\"action\":\"cancel\"/);
    } finally {
        await connection.close();
    }
});

test("form and URL responses are validated before retrying the origin", async () => {
    const connection = configured();
    try {
        await assert.rejects(
            () => connection.callTool(
                "batch",
                {},
                undefined,
                undefined,
                async () => resolved({
                    profile: { action: "accept", content: { name: 42 } },
                    approval: { action: "accept", content: { confirm: true } },
                }),
            ),
            /client interaction response.*profile/i,
        );
        const result = await connection.callTool(
            "url",
            {},
            undefined,
            undefined,
            async (request) => {
                assert.equal(
                    (request.arguments.requests as Record<string, { params?: { mode?: string } }>)
                        .authorize?.params?.mode,
                    "url",
                );
                return resolved({ authorize: { action: "accept" } });
            },
        );
        assert.deepEqual(result.content, [{ type: "text", text: "accept" }]);
    } finally {
        await connection.close();
    }
});

test("resource reads and prompt retrievals share the same interaction contract", async () => {
    const connection = configured();
    const operations: unknown[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        operations.push(request.arguments.operation);
        const key = Object.keys(request.arguments.requests as object)[0]!;
        return resolved({ [key]: { action: "accept", content: { confirm: true } } });
    };
    try {
        const resource = await connection.readResource("fixture://guarded", undefined, interact);
        assert.equal(resource.contents[0] && "text" in resource.contents[0]
            ? resource.contents[0].text
            : "", "read:accept");
        const prompt = await connection.getPrompt("guarded", { topic: "MCP" }, undefined, interact);
        assert.equal(prompt.messages[0]?.content.type === "text"
            ? prompt.messages[0].content.text
            : "", "MCP:accept");
        assert.deepEqual(operations, ["resources/read", "prompts/get"]);
    } finally {
        await connection.close();
    }
});

test("requestState-only continuation needs no fabricated client response", async () => {
    const connection = configured();
    let interactions = 0;
    try {
        const result = await connection.callTool(
            "state-only",
            {},
            undefined,
            undefined,
            async () => {
                interactions += 1;
                return { status: "cancelled" };
            },
        );
        assert.equal(interactions, 0);
        assert.deepEqual(result.content, [{ type: "text", text: "continued" }]);
    } finally {
        await connection.close();
    }
});

test("interactive continuation fails explicitly without an interaction owner", async () => {
    const connection = configured();
    try {
        await assert.rejects(
            () => connection.callTool("batch", {}),
            /requires client input.*no client interaction owner/i,
        );
    } finally {
        await connection.close();
    }
});

test("one operation rejects a non-converging server at the standard ten-round bound", async () => {
    const connection = configured();
    let interactions = 0;
    try {
        await assert.rejects(
            () => connection.callTool(
                "loop",
                {},
                undefined,
                undefined,
                async () => {
                    interactions += 1;
                    return resolved({
                        confirm: { action: "accept", content: { confirm: true } },
                    });
                },
            ),
            /still required input after 10 rounds/i,
        );
        assert.equal(interactions, 10);
    } finally {
        await connection.close();
    }
});

test("unclaimed input families fail without opening a client interaction", async () => {
    const connection = configured();
    let interactions = 0;
    try {
        await assert.rejects(
            () => connection.callTool(
                "sampling",
                {},
                undefined,
                undefined,
                async () => {
                    interactions += 1;
                    return { status: "cancelled" };
                },
            ),
            /sampling|capabilit/i,
        );
        assert.equal(interactions, 0);
    } finally {
        await connection.close();
    }
});
