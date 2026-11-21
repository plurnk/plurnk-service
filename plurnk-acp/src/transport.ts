// {§acp-http-authorization} {§acp-body-reference} {§acp-history-window} HTTP/WebSocket transport admission, CORS, and resource routes.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import {
    Problems,
    admitBearerRequest,
    type BearerAdmission,
    type CredentialAuthority,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { MimetypeClassifier } from "@plurnk/plurnk-schemes";
import type { ResolvedModuleOptions } from "./config.ts";
import { readAllLogEntries } from "./log-entry-projection.ts";
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
    if (allowOrigin.length === 0) return;
    res.setHeader("access-control-allow-origin", allowOrigin);
    res.setHeader("access-control-allow-methods", "GET, HEAD, POST, DELETE, OPTIONS");
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
): BearerAdmission =>
    admitBearerRequest(credentials, req, {
        domain: "acp:http",
        codePrefix: "acp/http",
        requiredScope: "acp",
        allowQueryToken,
    });

export const handleEntryRoute = async (
    seam: ApplicationPort,
    res: ServerResponse,
    workspaceId: number,
    sessionId: number,
    url: URL,
    method: "GET" | "HEAD" = "GET",
): Promise<void> => {
    for (const key of url.searchParams.keys()) {
        if (key !== "target" && key !== "channel" && key !== "offset" && key !== "access_token") {
            writeHttpProblem(
                res,
                httpProblem("entry-query-invalid", 400, `Unsupported query parameter '${key}'.`, {
                    stage: "validation",
                    retryable: false,
                }),
            );
            return;
        }
    }
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
    const channelParam = url.searchParams.get("channel");
    if (channelParam !== null && channelParam.trim().length === 0) {
        writeHttpProblem(
            res,
            httpProblem("entry-query-invalid", 400, "Query parameter 'channel' must not be empty.", {
                stage: "validation",
                retryable: false,
            }),
        );
        return;
    }
    const offsetParam = url.searchParams.get("offset");
    if (offsetParam !== null && !/^\d+$/.test(offsetParam)) {
        writeHttpProblem(
            res,
            httpProblem("entry-query-invalid", 400, "Query parameter 'offset' must be a non-negative integer.", {
                stage: "validation",
                retryable: false,
            }),
        );
        return;
    }
    const offset = offsetParam !== null ? Number(offsetParam) : undefined;
    const readResult =
        channelParam === null && offset === undefined
            ? await seam.readEntryChannel({ workspaceId, sessionId, target })
            : await seam.readEntry({
                  workspaceId,
                  sessionId,
                  target,
                  ...(channelParam !== null ? { channel: channelParam } : {}),
                  ...(offset !== undefined ? { offset } : {}),
              });
    if (readResult.entry === null) {
        writeHttpProblem(res, readResult.problem);
        return;
    }
    const entryChannel =
        channelParam !== null
            ? readResult.entry.channels[channelParam]
            : Object.values(readResult.entry.channels)[0];
    const content = entryChannel?.content ?? "";
    const rawMimetype = entryChannel?.mimetype ?? "text/plain";
    const essence = (rawMimetype.split(";", 1)[0] ?? "").trim().toLowerCase();
    if (MimetypeClassifier.isBinary(essence)) {
        const bytes = Buffer.from(content, "base64");
        res.writeHead(200, {
            "content-type": essence || "application/octet-stream",
            "content-length": String(bytes.byteLength),
            "cache-control": "no-store",
        });
        if (method === "HEAD") {
            res.end();
            return;
        }
        res.end(bytes);
        return;
    }
    const contentType = rawMimetype.toLowerCase().includes("charset=")
        ? rawMimetype
        : `${rawMimetype}; charset=utf-8`;
    const bodyBytes = Buffer.from(content, "utf8");
    res.writeHead(200, {
        "content-type": contentType,
        "content-length": String(bodyBytes.byteLength),
        "cache-control": "no-store",
    });
    if (method === "HEAD") {
        res.end();
        return;
    }
    res.end(bodyBytes);
};

export const handleMessagesRoute = async (
    seam: ApplicationPort,
    opts: ResolvedModuleOptions,
    origin: string,
    res: ServerResponse,
    workspaceId: number,
    sessionId: number,
    url: URL,
    subject?: string | null,
): Promise<void> => {
    const acpSessionId = url.searchParams.get("session") ?? `${workspaceId}#session1`;
    const beforeParam = url.searchParams.get("before");
    const afterParam = url.searchParams.get("after");
    const loopParam = url.searchParams.get("loop");
    const reasoningMode = url.searchParams.get("reasoning") === "link" ? "link" : undefined;
    const bodiesMode = url.searchParams.get("bodies") === "link" ? "link" : undefined;
    const targetLoop = loopParam !== null && /^\d+$/.test(loopParam) ? Number(loopParam) : undefined;
    const beforeLoop = beforeParam !== null && /^\d+$/.test(beforeParam) ? Number(beforeParam) : undefined;
    const afterLoop = afterParam !== null && /^\d+$/.test(afterParam) ? Number(afterParam) : undefined;
    const isNamedPrincipal =
        typeof subject === "string" &&
        subject.length > 0 &&
        subject !== "operator" &&
        subject !== "anonymous";
    const [allEntries, olderProbe, newerProbe, inbox, streams] = await Promise.all([
        isNamedPrincipal
            ? readAllLogEntries(seam, { workspaceId, sessionId })
            : targetLoop !== undefined
              ? readAllLogEntries(seam, { workspaceId, sessionId, loopSeq: targetLoop })
              : beforeLoop !== undefined
                ? readAllLogEntries(seam, {
                      workspaceId,
                      sessionId,
                      beforeLoopSeq: beforeLoop,
                      lastLoops: opts.historyLoops + 1,
                  })
                : afterLoop !== undefined
                  ? readAllLogEntries(seam, {
                        workspaceId,
                        sessionId,
                        afterLoopSeq: afterLoop,
                        lastLoops: opts.historyLoops + 1,
                    })
                  : readAllLogEntries(seam, {
                        workspaceId,
                        sessionId,
                        lastLoops: opts.historyLoops + 1,
                    }),
        !isNamedPrincipal && (targetLoop !== undefined || afterLoop !== undefined)
            ? seam.readLog({
                  workspaceId,
                  sessionId,
                  beforeLoopSeq: targetLoop ?? (afterLoop! + 1),
                  lastLoops: 1,
                  limit: 1,
              })
            : Promise.resolve([]),
        !isNamedPrincipal && (targetLoop !== undefined || beforeLoop !== undefined)
            ? seam.readLog({
                  workspaceId,
                  sessionId,
                  afterLoopSeq: targetLoop ?? Math.max(0, beforeLoop! - 1),
                  lastLoops: 1,
                  limit: 1,
              })
            : Promise.resolve([]),
        seam.readInbox({ workspaceId, sessionId }),
        seam.readStreams({ workspaceId, sessionId }),
    ]);
    const translator = new SessionTranslator({
        acpSessionId,
        workspaceId,
        sessionId,
        origin,
        ...(reasoningMode !== undefined ? { reasoningMode } : {}),
        ...(bodiesMode !== undefined ? { bodiesMode } : {}),
        ...(targetLoop === undefined ? { historyPageChars: opts.historyPageChars } : {}),
    });
    const replayed = SessionTranslator.replay(translator, allEntries, inbox, {
        historyLoops: opts.historyLoops,
        historyPageChars: opts.historyPageChars,
        openStreamTargets: new Set(streams.map((s) => s.target)),
        subject,
        ...(olderProbe.length > 0 ? { hasOlderHint: true } : {}),
        ...(newerProbe.length > 0 ? { hasNewerHint: true } : {}),
        ...(targetLoop !== undefined ? { exactLoopSeq: targetLoop } : {}),
        ...(beforeLoop !== undefined ? { beforeLoopSeq: beforeLoop } : {}),
        ...(afterLoop !== undefined ? { afterLoopSeq: afterLoop } : {}),
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
