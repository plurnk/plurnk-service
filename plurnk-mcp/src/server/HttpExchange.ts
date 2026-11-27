// {§mcp-http-server} — HTTP admission, CORS, Web Standard Request/Response bridging, and TCP backpressure.

import type { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener, once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
    Problems,
    admitBearerRequest,
    buildCorsHeaders,
    isRecord,
    parseScopedRoute,
    type BearerAdmission,
    type CredentialAuthority,
    type ProblemDetails,
    type ScopedRouteParseResult,
} from "@plurnk/plurnk-contracts";
import type { McpRequestContext, McpRouteTarget } from "./EventBus.ts";

const RECOGNIZED_MCP_METHODS: ReadonlySet<string> = new Set([
    "server/discover",
    "initialize",
    "ping",
    "tools/list",
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/read",
    "resources/subscribe",
    "resources/unsubscribe",
    "subscriptions/listen",
    "notifications/initialized",
    "notifications/cancelled",
    "notifications/progress",
]);

const isJsonContentTypeHeader = (raw: string | readonly string[] | undefined): boolean => {
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== "string") return false;
    const essence = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
    return essence === "application/json" || essence.endsWith("+json");
};

const isRecognizedMcpMessage = (value: unknown): boolean =>
    isRecord(value) &&
    value.jsonrpc === "2.0" &&
    typeof value.method === "string" &&
    RECOGNIZED_MCP_METHODS.has(value.method);

export const isRecognizedMcpPost = (
    req: IncomingMessage,
    parsedBody: unknown,
    hasParsedBody: boolean,
): boolean => {
    if (!hasParsedBody || !isJsonContentTypeHeader(req.headers["content-type"])) return false;
    if (Array.isArray(parsedBody)) {
        return parsedBody.length > 0 && parsedBody.every(isRecognizedMcpMessage);
    }
    return isRecognizedMcpMessage(parsedBody);
};

export const isInitializePayload = (parsedBody: unknown): boolean =>
    isRecord(parsedBody) && parsedBody.jsonrpc === "2.0" && parsedBody.method === "initialize";

const BASE_CORS_ALLOW_HEADERS =
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id";

const HEADER_TOKEN_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

export const applyCorsHeaders = (res: ServerResponse, origin: string, req?: IncomingMessage): void => {
    if (origin.length === 0) return;
    const requested = req?.headers["access-control-request-headers"];
    const requestedRaw = Array.isArray(requested) ? requested.join(",") : requested;
    const extraParamHeaders: string[] = [];
    if (typeof requestedRaw === "string" && requestedRaw.length > 0) {
        for (const item of requestedRaw.split(",")) {
            const token = item.trim().toLowerCase();
            if (token.startsWith("mcp-param-") && HEADER_TOKEN_PATTERN.test(token)) {
                extraParamHeaders.push(token);
            }
        }
    }
    const allowHeaders =
        extraParamHeaders.length > 0
            ? `${BASE_CORS_ALLOW_HEADERS}, ${[...new Set(extraParamHeaders)].join(", ")}`
            : BASE_CORS_ALLOW_HEADERS;
    const headers = buildCorsHeaders(origin, {
        methods: "GET, POST, DELETE, OPTIONS",
        allowHeaders,
        exposeHeaders: "Mcp-Session-Id",
    });
    for (const [key, value] of Object.entries(headers)) {
        res.setHeader(key, value);
    }
};

export const mcpHttpProblem = (
    slug: string,
    status: number,
    detail: string,
    fields: Readonly<Record<string, unknown>> = {},
): ProblemDetails =>
    Problems.create("mcp:http", slug, status, detail, { code: `mcp/http/${slug}`, ...fields });

export const serviceStoppingProblem = (): ProblemDetails =>
    mcpHttpProblem("service-stopping", 503, "The PLURNK service is shutting down.", {
        stage: "shutdown",
        retryable: true,
    });

export const writeJsonRpcHttpError = (
    res: ServerResponse,
    status: number,
    code: number,
    message: string,
    extraHeaders: Readonly<Record<string, string>> = {},
): void => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const body = JSON.stringify({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
    });
    res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...extraHeaders,
    });
    res.end(body);
};

export const admitRequest = (
    credentials: CredentialAuthority,
    req: IncomingMessage,
): Promise<BearerAdmission> =>
    admitBearerRequest(credentials, req, {
        domain: "mcp:http",
        codePrefix: "mcp/http",
    });

export const parseRouteSegments = (pathname: string): ScopedRouteParseResult =>
    parseScopedRoute(pathname, {
        mount: "/mcp",
        domain: "mcp:http",
        codePrefix: "mcp/http",
        notFoundDetail: "The requested MCP route does not exist.",
        malformedEncodingDetail: "The MCP route contains malformed percent-encoding.",
    });

export const readRequestBody = async (req: IncomingMessage): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
};

export interface ActiveHttpExchange {
    readonly controller: AbortController;
    readonly res: ServerResponse;
}

const writeWebResponse = async (
    req: IncomingMessage,
    res: ServerResponse,
    response: Response,
    signal: AbortSignal,
): Promise<void> => {
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    const headerObj: Record<string, string> = {};
    response.headers.forEach((value, key) => {
        headerObj[key] = value;
    });
    const isEventStream = (headerObj["content-type"] ?? "").toLowerCase().includes("text/event-stream");
    if (isEventStream) {
        req.socket.setTimeout(0);
        headerObj["x-accel-buffering"] = "no";
    }
    res.writeHead(response.status, headerObj);
    if (isEventStream) {
        res.flushHeaders();
    }
    if (response.body === null) {
        res.end();
        return;
    }
    const reader = response.body.getReader();
    const abortSub = addAbortListener(signal, () => {
        void reader.cancel().catch(() => undefined);
    });
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (res.writableEnded || res.destroyed) {
                await reader.cancel().catch(() => undefined);
                break;
            }
            if (!res.write(Buffer.from(value))) {
                await once(res, "drain", { signal });
            }
        }
    } finally {
        abortSub[Symbol.dispose]();
        if (!res.writableEnded && !res.destroyed) {
            res.end();
        }
    }
};

export const serveHttpExchange = async (args: {
    readonly activeExchanges: Set<ActiveHttpExchange>;
    readonly requestContext: AsyncLocalStorage<McpRequestContext>;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
    readonly url: URL;
    readonly method: string;
    readonly bodyBuffer: Buffer | null;
    readonly target: McpRouteTarget;
    readonly subject: string | null;
    readonly handle?: string;
    readonly name?: string;
    readonly canDelegateActor?: boolean;
    readonly dispatch: (webRequest: Request) => Promise<Response>;
}): Promise<void> => {
    const {
        activeExchanges,
        requestContext,
        req,
        res,
        url,
        method,
        bodyBuffer,
        target,
        subject,
        handle,
        name,
        canDelegateActor,
        dispatch,
    } = args;
    const controller = new AbortController();
    const exchange: ActiveHttpExchange = { controller, res };
    activeExchanges.add(exchange);
    const onAbort = (): void => {
        if (!controller.signal.aborted) {
            controller.abort(new Error("HTTP client disconnected"));
        }
    };
    req.once("aborted", onAbort);
    res.once("close", () => {
        activeExchanges.delete(exchange);
        if (!res.writableEnded) onAbort();
    });

    try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === "string") {
                headers.set(key, value);
            } else if (Array.isArray(value)) {
                for (const item of value) headers.append(key, item);
            }
        }
        const webRequest = new Request(url.href, {
            method,
            headers,
            signal: controller.signal,
            ...(bodyBuffer !== null && bodyBuffer.byteLength > 0 ? { body: new Uint8Array(bodyBuffer) } : {}),
        });

        const response = await requestContext.run(
            {
                target,
                subject,
                ...(handle !== undefined ? { handle } : {}),
                ...(name !== undefined ? { name } : {}),
                ...(canDelegateActor === true ? { canDelegateActor: true } : {}),
            },
            () => dispatch(webRequest),
        );
        await writeWebResponse(req, res, response, controller.signal);
    } finally {
        req.off("aborted", onAbort);
        activeExchanges.delete(exchange);
    }
};
