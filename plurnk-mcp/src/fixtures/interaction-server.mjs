import {
    McpServer,
    acceptedContent,
    inputRequired,
    inputResponse,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

const firstState = "round-one::\u03b1\nopaque";
const secondState = "round-two::\u03b2\nopaque";
const stateOnly = "state-only::\u03b3\nopaque";

const confirmationRequest = (message) => inputRequired.elicit({
    message,
    requestedSchema: {
        type: "object",
        properties: {
            confirm: { type: "boolean" },
        },
        required: ["confirm"],
        additionalProperties: false,
    },
});

const server = new McpServer({
    name: "interaction-fixture",
    version: "1.0.0",
});

server.registerTool(
    "batch",
    {
        description: "Request two independent client decisions in one round.",
        inputSchema: z.object({}),
    },
    async (_args, ctx) => {
        const profile = inputResponse(ctx.mcpReq.inputResponses, "profile");
        const approval = inputResponse(ctx.mcpReq.inputResponses, "approval");
        if (profile.kind === "missing" || approval.kind === "missing") {
            return inputRequired({
                inputRequests: {
                    profile: inputRequired.elicit({
                        message: "Who is making this request?",
                        requestedSchema: {
                            type: "object",
                            properties: {
                                name: { type: "string", minLength: 1 },
                            },
                            required: ["name"],
                            additionalProperties: false,
                        },
                    }),
                    approval: confirmationRequest("Continue the batch operation?"),
                },
            });
        }
        return {
            content: [{
                type: "text",
                text: JSON.stringify({ profile, approval }),
            }],
        };
    },
);

server.registerTool(
    "round-trip",
    {
        description: "Require two serial interaction rounds with opaque continuation state.",
        inputSchema: z.object({}),
    },
    async (_args, ctx) => {
        const state = ctx.mcpReq.requestState();
        if (state === undefined) {
            return inputRequired({
                inputRequests: {
                    name: inputRequired.elicit({
                        message: "Name the operator.",
                        requestedSchema: {
                            type: "object",
                            properties: { name: { type: "string" } },
                            required: ["name"],
                            additionalProperties: false,
                        },
                    }),
                },
                requestState: firstState,
            });
        }
        if (state === firstState) {
            const profile = acceptedContent(ctx.mcpReq.inputResponses, "name", z.object({
                name: z.string(),
            }));
            if (profile?.name !== "Ada") throw new Error("First interaction response was not preserved.");
            return inputRequired({
                inputRequests: {
                    confirm: confirmationRequest("Confirm Ada as the operator?"),
                },
                requestState: secondState,
            });
        }
        if (state === secondState) {
            const answer = acceptedContent(ctx.mcpReq.inputResponses, "confirm", z.object({
                confirm: z.boolean(),
            }));
            if (answer?.confirm !== true) throw new Error("Second interaction response was not preserved.");
            return { content: [{ type: "text", text: "Ada confirmed" }] };
        }
        throw new Error("Opaque requestState changed in transit.");
    },
);

server.registerTool(
    "url",
    {
        description: "Request a standard URL-mode elicitation.",
        inputSchema: z.object({}),
    },
    async (_args, ctx) => {
        const response = inputResponse(ctx.mcpReq.inputResponses, "authorize");
        if (response.kind === "missing") {
            return inputRequired({
                inputRequests: {
                    authorize: inputRequired.elicitUrl({
                        message: "Authorize the fixture in a browser.",
                        elicitationId: "fixture-authorization",
                        url: "https://example.test/authorize",
                    }),
                },
            });
        }
        return {
            content: [{
                type: "text",
                text: response.kind === "elicit" ? response.action : response.kind,
            }],
        };
    },
);

server.registerTool(
    "state-only",
    {
        description: "Exercise an input-required continuation without client input.",
        inputSchema: z.object({}),
    },
    async (_args, ctx) => ctx.mcpReq.requestState() === undefined
        ? inputRequired({ requestState: stateOnly })
        : { content: [{ type: "text", text: ctx.mcpReq.requestState() === stateOnly ? "continued" : "corrupt" }] },
);

server.registerTool(
    "loop",
    {
        description: "Never complete an elicitation cycle.",
        inputSchema: z.object({}),
    },
    async () => inputRequired({
        inputRequests: {
            confirm: confirmationRequest("Continue looping?"),
        },
    }),
);

server.registerTool(
    "sampling",
    {
        description: "Attempt an unsupported sampling request.",
        inputSchema: z.object({}),
    },
    async () => inputRequired({
        inputRequests: {
            sample: inputRequired.createMessage({
                messages: [{
                    role: "user",
                    content: { type: "text", text: "Say hello." },
                }],
                maxTokens: 32,
            }),
        },
    }),
);

server.registerResource(
    "guarded",
    "fixture://guarded",
    { mimeType: "text/plain" },
    async (uri, ctx) => {
        const response = inputResponse(ctx.mcpReq.inputResponses, "read");
        if (response.kind === "missing") {
            return inputRequired({
                inputRequests: {
                    read: confirmationRequest("Read the guarded resource?"),
                },
            });
        }
        return {
            contents: [{
                uri: uri.href,
                mimeType: "text/plain",
                text: response.kind === "elicit" ? `read:${response.action}` : response.kind,
            }],
        };
    },
);

server.registerPrompt(
    "guarded",
    {
        description: "Return a prompt after client confirmation.",
        argsSchema: z.object({ topic: z.string() }),
    },
    async ({ topic }, ctx) => {
        const response = inputResponse(ctx.mcpReq.inputResponses, "prompt");
        if (response.kind === "missing") {
            return inputRequired({
                inputRequests: {
                    prompt: confirmationRequest(`Build the ${String(topic)} prompt?`),
                },
            });
        }
        return {
            messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: `${String(topic)}:${response.kind === "elicit" ? response.action : response.kind}`,
                },
            }],
        };
    },
);

serveStdio(() => server, {
    legacy: "reject",
});
