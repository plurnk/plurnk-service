// {§mcp-http-server} — MCP resource projections (`mcp:///plurnk.*`, `plurnk:///*`, `log:///`, `workspace:///`) and subscriptions.

import {
    ProtocolError,
    ProtocolErrorCode,
    ResourceNotFoundError,
    ResourceTemplate,
    type McpServer,
    type RegisteredTool,
    type WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { Problems, type ClientEntryChannel, type EntryReadResult } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { MimetypeClassifier } from "@plurnk/plurnk-schemes";
import { logCoordinateOf, type McpRouteTarget } from "./EventBus.ts";

export interface LegacyMcpSession {
    sessionId: string | null;
    readonly subject: string | null;
    readonly target: McpRouteTarget;
    readonly server: McpServer;
    readonly transport: WebStandardStreamableHTTPServerTransport;
    readonly subscribedUris: Set<string>;
    readonly registeredTools: Map<string, RegisteredTool>;
    toolsDirty: boolean;
    unsubscribeBus: (() => void) | null;
    closed: boolean;
    close: () => Promise<void>;
}

const isSubscribableMcpResourceUri = (uri: string): boolean => {
    if (
        uri === "mcp:///plurnk.md" ||
        uri === "mcp:///plurnk.json" ||
        uri === "plurnk:///status.json" ||
        uri === "plurnk:///recent.json"
    ) {
        return true;
    }
    if (uri.startsWith("workspace:///") && uri.length > "workspace:///".length) return true;
    if (/^mcp:\/\/\/plurnk\/[^/]+\.json$/u.test(uri)) return true;
    if (/^log:\/\/\/\d+\/\d+\/\d+\/[^/]+$/u.test(uri)) return true;
    return false;
};

const resourceReadError = (uri: string, status: number, detail: string): ProtocolError => {
    if (status === 404) {
        return new ResourceNotFoundError(uri, detail);
    }
    if (status >= 500) {
        return new ProtocolError(ProtocolErrorCode.InternalError, detail, { uri, status });
    }
    return new ProtocolError(ProtocolErrorCode.InvalidParams, detail, { uri, status });
};

const requireEntryChannel = (uri: string, read: EntryReadResult, missingMessage?: string): ClientEntryChannel => {
    if (read.entry === null) {
        throw resourceReadError(uri, read.status, read.problem.detail);
    }
    const channel = read.entry.channels.body ?? Object.values(read.entry.channels)[0];
    if (channel === undefined) {
        throw new ResourceNotFoundError(uri, missingMessage);
    }
    return channel;
};

export const registerMcpResources = (args: {
    readonly server: McpServer;
    readonly seam: ApplicationPort;
    readonly target: McpRouteTarget;
    readonly era: "modern" | "legacy";
    readonly legacySession?: LegacyMcpSession;
}): void => {
    const { server, seam, target, era, legacySession } = args;
    const { workspaceId, sessionId, runtimeSessionId } = target;

    if (era === "legacy") {
        server.server.setRequestHandler("resources/subscribe", async (request) => {
            const uri = request.params.uri;
            let parsedUri: URL;
            try {
                parsedUri = new URL(uri);
            } catch {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource URI ${uri} is invalid`, {
                    uri,
                    reason: "invalid_uri",
                });
            }
            if (!isSubscribableMcpResourceUri(parsedUri.href) && !isSubscribableMcpResourceUri(uri)) {
                throw new ResourceNotFoundError(uri);
            }
            legacySession?.subscribedUris.add(parsedUri.href);
            legacySession?.subscribedUris.add(uri);
            return {};
        });
        server.server.setRequestHandler("resources/unsubscribe", async (request) => {
            const uri = request.params.uri;
            let parsedUri: URL;
            try {
                parsedUri = new URL(uri);
            } catch {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Resource URI ${uri} is invalid`, {
                    uri,
                    reason: "invalid_uri",
                });
            }
            legacySession?.subscribedUris.delete(parsedUri.href);
            legacySession?.subscribedUris.delete(uri);
            return {};
        });
    }

    const registerFixedEntryResource = (
        name: string,
        uriSpec: string,
        title: string,
        description: string,
        mimeType: string,
    ): void => {
        server.registerResource(
            name,
            uriSpec,
            { title, description, mimeType },
            async (uri) => {
                const read = await seam.readEntry({ workspaceId, sessionId, target: uriSpec });
                const channel = requireEntryChannel(uri.href, read);
                return {
                    contents: [{ uri: uri.href, mimeType, text: channel.content }],
                };
            },
        );
    };

    registerFixedEntryResource(
        "plurnk-docs",
        "mcp:///plurnk.md",
        "Plurnk Server Documentation",
        "Overview and invocation signatures for all Plurnk server tools.",
        "text/markdown",
    );
    registerFixedEntryResource(
        "plurnk-catalog",
        "mcp:///plurnk.json",
        "Plurnk Tool Catalog",
        "JSON tool definitions for all Plurnk server tools.",
        "application/json",
    );
    registerFixedEntryResource(
        "plurnk-status",
        "plurnk:///status.json",
        "Plurnk Session Status",
        "Live workspace, session, loops, inbox, open streams, pending proposals, and pending interactions.",
        "application/json",
    );
    registerFixedEntryResource(
        "plurnk-recent",
        "plurnk:///recent.json",
        "Plurnk Recent Log Entries",
        "Recent durable log entries (with canonical log:/// coordinates) for the active session and runtime.",
        "application/json",
    );

    server.registerResource(
        "log-entry",
        new ResourceTemplate("log:///{loopSeq}/{turnSeq}/{sequence}/{op}", { list: undefined }),
        {
            title: "Plurnk Durable Log Entry",
            description: "Read a durable log entry by coordinate (`log:///<loopSeq>/<turnSeq>/<sequence>/<op>`).",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const rawLoopSeq = Array.isArray(variables.loopSeq) ? variables.loopSeq[0] : variables.loopSeq;
            const rawTurnSeq = Array.isArray(variables.turnSeq) ? variables.turnSeq[0] : variables.turnSeq;
            const rawSequence = Array.isArray(variables.sequence) ? variables.sequence[0] : variables.sequence;
            const rawOp = Array.isArray(variables.op) ? variables.op[0] : variables.op;
            if (
                typeof rawLoopSeq !== "string" ||
                !/^\d+$/u.test(rawLoopSeq) ||
                typeof rawTurnSeq !== "string" ||
                !/^\d+$/u.test(rawTurnSeq) ||
                typeof rawSequence !== "string" ||
                !/^\d+$/u.test(rawSequence) ||
                typeof rawOp !== "string" ||
                rawOp.length === 0
            ) {
                throw new ProtocolError(
                    ProtocolErrorCode.InvalidParams,
                    `Log coordinate '${uri.href}' must contain non-negative integer coordinates and an operation name.`,
                    { uri: uri.href, status: 400 },
                );
            }
            const loopSeq = Number(rawLoopSeq);
            const turnSeq = Number(rawTurnSeq);
            const sequence = Number(rawSequence);
            if (
                !Number.isSafeInteger(loopSeq) ||
                !Number.isSafeInteger(turnSeq) ||
                !Number.isSafeInteger(sequence)
            ) {
                throw new ProtocolError(
                    ProtocolErrorCode.InvalidParams,
                    `Log coordinate '${uri.href}' exceeds safe integer range.`,
                    { uri: uri.href, status: 400 },
                );
            }
            let rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
            try {
                const primaryRows = await seam.readLog({
                    workspaceId,
                    sessionId,
                    loopSeq,
                    turnSeq,
                    sequence,
                    limit: 1,
                });
                rows =
                    primaryRows.length > 0 || runtimeSessionId === sessionId
                        ? primaryRows
                        : await seam.readLog({
                              workspaceId,
                              sessionId: runtimeSessionId,
                              loopSeq,
                              turnSeq,
                              sequence,
                              limit: 1,
                          });
            } catch (cause) {
                const problem = Problems.fromError(cause);
                if (problem !== null) {
                    throw resourceReadError(uri.href, problem.status, problem.detail);
                }
                throw cause;
            }
            const row = rows[0];
            if (
                row === undefined ||
                (typeof row.op === "string" && row.op.length > 0 && row.op.toLowerCase() !== rawOp.toLowerCase())
            ) {
                throw new ResourceNotFoundError(uri.href, `Log entry not found at '${uri.href}'.`);
            }
            const payload = { ...row, coordinate: logCoordinateOf(row) ?? uri.href };
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: "application/json",
                        text: JSON.stringify(payload, null, 2),
                    },
                ],
            };
        },
    );

    server.registerResource(
        "plurnk-tool-schema",
        new ResourceTemplate("mcp:///plurnk/{tool}.json", { list: undefined }),
        {
            title: "Plurnk Tool Schema",
            description: "JSON schema and invocation metadata for an individual Plurnk tool.",
            mimeType: "application/json",
        },
        async (uri, variables) => {
            const rawTool = Array.isArray(variables.tool) ? variables.tool[0] : variables.tool;
            const tool = typeof rawTool === "string" ? rawTool : "";
            if (tool.length === 0) {
                throw new ProtocolError(
                    ProtocolErrorCode.InvalidParams,
                    `Tool name is required in '${uri.href}'.`,
                    { uri: uri.href, status: 400 },
                );
            }
            const read = await seam.readEntry({
                workspaceId,
                sessionId,
                target: `mcp:///plurnk/${tool}.json`,
            });
            const channel = requireEntryChannel(uri.href, read, `Tool schema not found for '${tool}'.`);
            return {
                contents: [{ uri: uri.href, mimeType: "application/json", text: channel.content }],
            };
        },
    );

    server.registerResource(
        "workspace-entry",
        new ResourceTemplate("workspace:///{+path}", { list: undefined }),
        {
            title: "Workspace Entry",
            description: "Read a workspace file or directory entry by path (`workspace:///<path>`).",
            mimeType: "text/plain",
        },
        async (uri, variables) => {
            const rawPath = Array.isArray(variables.path) ? variables.path.join("/") : (variables.path ?? "");
            const read = await seam.readEntry({
                workspaceId,
                sessionId,
                target: `workspace:///${rawPath}`,
            });
            const channel = requireEntryChannel(uri.href, read);
            const mimeType = channel.mimetype.length > 0 ? channel.mimetype : "text/plain";
            return {
                contents: [
                    MimetypeClassifier.isBinary(mimeType)
                        ? { uri: uri.href, mimeType, blob: channel.content }
                        : { uri: uri.href, mimeType, text: channel.content },
                ],
            };
        },
    );
};
