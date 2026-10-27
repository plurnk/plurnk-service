// {§acp-http-authorization} {§acp-body-reference} {§acp-history-window} HTTP/WebSocket transport admission, CORS, and resource routes.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Problems, type CredentialAuthority, type ProblemDetails } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import type { ResolvedModuleOptions } from "./config.ts";
import SessionTranslator from "./SessionTranslator.ts";

export const HEADER_CONNECTION_ID = "Acp-Connection-Id";

export const httpProblem = (
    slug: string,
    status: number,
    detail: string,
    fields: Readonly<Record<string, unknown>> = {},
): ProblemDetails => Problems.create("acp:http", slug, status, detail, { code: `acp/http/${slug}`, ...fields });

export const serviceStoppingProblem = (): ProblemDetails =>
    httpProblem("service-stopping", 503, "The PLURNK service is shutting down.", {
        stage: "shutdown",
        retryable: true,
    });

export const credentialRevokedProblem = (): ProblemDetails =>
    httpProblem("credential-revoked", 401, "The credential this stream was admitted under has been revoked.", {
        stage: "authorization",
        recovery: "Obtain a new access token from this daemon's token endpoint.",
        retryable: false,
    });

export const writeHttpProblem = (res: ServerResponse, problem: ProblemDetails): void => {
    res.writeHead(problem.status, { "content-type": "application/problem+json" });
    res.end(JSON.stringify(problem));
};

export const writeSocketProblem = (
    socket: Duplex,
    problem: ProblemDetails,
    extraHeaders: Readonly<Record<string, string>> = {},
): void => {
    const body = JSON.stringify(problem);
    const headerLines = [
        `HTTP/1.1 ${problem.status} Error`,
        "Content-Type: application/problem+json",
        "Connection: close",
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        "\r\n",
    ];
    socket.end(`${headerLines.join("\r\n")}${body}`);
};

export const applyCorsHeaders = (res: ServerResponse, allowOrigin: string): void => {
    res.setHeader("access-control-allow-origin", allowOrigin);
    res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
        "access-control-allow-headers",
        "authorization, content-type, acp-connection-id, acp-session-id, accept",
    );
    res.setHeader("access-control-expose-headers", "acp-connection-id, acp-session-id");
};

export const admitRequest = (
    credentials: CredentialAuthority,
    req: IncomingMessage,
    allowQueryToken = false,
):
    | { readonly ok: true; readonly family: string | null }
    | { readonly ok: false; readonly problem: ProblemDetails; readonly challenge: string } => {
    const face = credentials.face();
    const issuer = face?.issuer(req);
    if (face === null || issuer === undefined) {
        return { ok: true, family: null };
    }

    const header = req.headers.authorization;
    const challenge = (parameters: string): string =>
        `Bearer realm="plurnk"${parameters}, resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
    let presented = header === undefined ? null : /^Bearer(?:\s+(.*))?$/iu.exec(header);
    if (presented === null && allowQueryToken) {
        const url = new URL(req.url ?? "/acp", "http://listener");
        const queryToken = url.searchParams.get("access_token");
        if (queryToken !== null) presented = /^Bearer(?:\s+(.*))?$/iu.exec(`Bearer ${queryToken}`);
    }
    if (presented === null) {
        return {
            ok: false,
            challenge: challenge(""),
            problem: httpProblem("bearer-token-required", 401, "The request did not provide a bearer token.", {
                stage: "authorization",
                recovery: "Present an access token issued by this daemon as `Authorization: Bearer <token>`.",
                retryable: false,
            }),
        };
    }
    const token = (presented[1] ?? "").trim();
    const claims = credentials.verify(token);
    if (claims === null || claims.kind !== "access") {
        return {
            ok: false,
            challenge: challenge(
                ', error="invalid_token", error_description="The access token is unknown, expired or revoked."',
            ),
            problem: httpProblem("bearer-token-invalid", 401, "The access token is unknown, expired or revoked.", {
                stage: "authorization",
                recovery: "Obtain a new access token from this daemon's token endpoint.",
                retryable: false,
            }),
        };
    }
    if (!claims.scopes.includes("acp")) {
        return {
            ok: false,
            challenge: challenge(', error="insufficient_scope", scope="acp"'),
            problem: httpProblem(
                "bearer-scope-insufficient",
                403,
                "The access token does not carry the scope acp.",
                {
                    stage: "authorization",
                    scope: "acp",
                    recovery: "Obtain an access token with the scope acp.",
                    retryable: false,
                },
            ),
        };
    }
    return { ok: true, family: claims.family };
};

export const handleEntryRoute = async (
    seam: ApplicationPort,
    res: ServerResponse,
    workspaceId: number,
    sessionId: number,
    url: URL,
): Promise<void> => {
    const target = url.searchParams.get("target");
    if (!target || target.trim().length === 0) {
        writeHttpProblem(
            res,
            httpProblem("entry-target-required", 400, "Query parameter 'target' is required.", {
                stage: "validation",
                retryable: false,
            }),
        );
        return;
    }
    const channel = url.searchParams.get("channel") ?? "body";
    const offsetParam = url.searchParams.get("offset");
    const offset = offsetParam !== null && /^\d+$/.test(offsetParam) ? Number(offsetParam) : undefined;
    const readResult = await seam.readEntry({
        workspaceId,
        sessionId,
        target,
        channel,
        ...(offset !== undefined ? { offset } : {}),
    });
    if (readResult.entry === null) {
        writeHttpProblem(res, readResult.problem);
        return;
    }
    const entryChannel = readResult.entry.channels[channel];
    const content = entryChannel?.content ?? "";
    const mimetype = entryChannel?.mimetype ?? "text/plain";
    res.writeHead(200, { "content-type": mimetype });
    res.end(content);
};

export const handleMessagesRoute = async (
    seam: ApplicationPort,
    opts: ResolvedModuleOptions,
    origin: string,
    res: ServerResponse,
    workspaceId: number,
    sessionId: number,
    url: URL,
): Promise<void> => {
    const acpSessionId = url.searchParams.get("session") ?? `${workspaceId}#user`;
    const beforeParam = url.searchParams.get("before");
    const loopParam = url.searchParams.get("loop");
    const [allEntries, inbox] = await Promise.all([
        seam.readLog({ workspaceId, sessionId }),
        seam.readInbox({ workspaceId, sessionId }),
    ]);
    const targetLoop = loopParam !== null && /^\d+$/.test(loopParam) ? Number(loopParam) : undefined;
    const beforeLoop = beforeParam !== null && /^\d+$/.test(beforeParam) ? Number(beforeParam) : undefined;
    const translator = new SessionTranslator({
        acpSessionId,
        workspaceId,
        sessionId,
        origin,
    });
    const replayed = SessionTranslator.replay(translator, allEntries, inbox, {
        historyLoops: opts.historyLoops,
        ...(targetLoop !== undefined ? { exactLoopSeq: targetLoop } : {}),
        ...(beforeLoop !== undefined ? { beforeLoopSeq: beforeLoop } : {}),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
        JSON.stringify({
            session: acpSessionId,
            updates: replayed.map((r) => r.update),
            history: replayed.history,
        }),
    );
};
