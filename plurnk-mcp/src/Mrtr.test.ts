import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
    ClientInteractionRequest,
} from "@plurnk/plurnk-contracts";
import ServerConnection, { type ClientInteractionHandler } from "./client.ts";
import { stdioServer } from "../test/definitions.ts";

const fixture = fileURLToPath(new URL("./fixtures/interaction-server.mjs", import.meta.url));
const env = {
    PLURNK_MCP_CONNECT_TIMEOUT: "30000",
    PLURNK_MCP_REQUEST_TIMEOUT: "30000", PLURNK_MCP_RETRY_FLOOR_MS: "250", PLURNK_MCP_RETRY_CEILING_MS: "5000",
};

const configured = (): ServerConnection => new ServerConnection(stdioServer("interaction", [fixture]), env);

test("{§mcp-host-composition} embedded elicitations map directly to form and URL client interactions", async () => {
    const connection = configured();
    const requests: ClientInteractionRequest[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        requests.push(request);
        if (request.message === "Who is making this request?") {
            return { action: "accept", content: { name: "Ada" } };
        }
        return { action: "decline" };
    };
    try {
        const result = await connection.callTool("batch", {}, undefined, undefined, interact);
        assert.equal(requests.length, 2);
        assert.ok(requests.every((r) => r.toolName === "mcp_input_required" && r.mode === "form"));
        assert.deepEqual(
            requests.map((r) => r.message).toSorted(),
            ["Continue the batch operation?", "Who is making this request?"],
        );
        assert.equal(JSON.stringify(requests).includes("round-one"), false);
        assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Ada/);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} multi-round tool calls preserve opaque state and fresh interaction responses", async () => {
    const connection = configured();
    const requests: ClientInteractionRequest[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        requests.push(request);
        return requests.length === 1
            ? { action: "accept", content: { name: "Ada" } }
            : { action: "accept", content: { confirm: true } };
    };
    try {
        const result = await connection.callTool("round-trip", {}, undefined, undefined, interact);
        assert.deepEqual(requests.map((r) => r.message), ["Name the operator.", "Confirm Ada as the operator?"]);
        assert.ok(requests.every((request) => !JSON.stringify(request).includes("opaque")));
        assert.deepEqual(result.content, [{ type: "text", text: "Ada confirmed" }]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} client cancellation becomes a standard elicitation cancellation response", async () => {
    const connection = configured();
    try {
        const result = await connection.callTool(
            "batch",
            {},
            undefined,
            undefined,
            async () => ({ action: "cancel" }),
        );
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        assert.match(text, /"action":"cancel"/);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} form and URL responses are validated before retrying the origin", async () => {
    const connection = configured();
    try {
        await assert.rejects(
            () => connection.callTool(
                "batch",
                {},
                undefined,
                undefined,
                async (request) => request.message === "Who is making this request?"
                    ? { action: "accept", content: { name: 42 } }
                    : { action: "accept", content: { confirm: true } },
            ),
            /client interaction response.*profile/i,
        );
        const result = await connection.callTool(
            "url",
            {},
            undefined,
            undefined,
            async (request) => {
                assert.equal(request.mode, "url");
                if (request.mode === "url") {
                    assert.equal(request.message, "Authorize the fixture in a browser.");
                    assert.equal(request.elicitationId, "fixture-authorization");
                    assert.equal(request.url, "https://example.test/authorize");
                }
                return { action: "accept" };
            },
        );
        assert.deepEqual(result.content, [{ type: "text", text: "accept" }]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-core-matrix} resource reads and prompt retrievals share the same interaction contract", async () => {
    const connection = configured();
    const messages: string[] = [];
    const interact: ClientInteractionHandler = async (request) => {
        messages.push(request.message);
        return { action: "accept", content: { confirm: true } };
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
        assert.deepEqual(messages, ["Read the guarded resource?", "Build the MCP prompt?"]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} requestState-only continuation needs no fabricated client response", async () => {
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
                return { action: "cancel" };
            },
        );
        assert.equal(interactions, 0);
        assert.deepEqual(result.content, [{ type: "text", text: "continued" }]);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} interactive continuation fails explicitly without an interaction owner", async () => {
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

test("{§mcp-host-composition} one operation rejects a non-converging server at the standard ten-round bound", async () => {
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
                    return { action: "accept", content: { confirm: true } };
                },
            ),
            /still required input after 10 rounds/i,
        );
        assert.equal(interactions, 10);
    } finally {
        await connection.close();
    }
});

test("{§mcp-host-composition} unclaimed input families fail without opening a client interaction", async () => {
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
                    return { action: "cancel" };
                },
            ),
            /sampling|capabilit/i,
        );
        assert.equal(interactions, 0);
    } finally {
        await connection.close();
    }
});
