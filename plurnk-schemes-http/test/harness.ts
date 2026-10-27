import { after, before, beforeEach, mock } from "node:test";
import { buffer } from "node:stream/consumers";
import { resolve } from "node:path";
import MaterializerRegistry from "../src/Materializer.ts";
import {
    MimetypeClassifier,
    NetworkAddress,
    Results,
    type ChannelCaps,
    type ChannelState,
    type EntryCaps,
    type EntryData,
    type EntryStorageReadResult,
    type EntryStorageWriteResult,
    type FindStatement,
    type KillStatement,
    type NotifyCaps,
    type ProjectionCaps,
    type ProposalResult,
    type ReadStatement,
    type RepresentationPreparationResult,
    type ResolvedEditStatement,
    type SchemeCtx,
    type SchemeResult,
    type SendStatement,
    type StoredEntryData,
    type StreamSubscription,
    type SubscriptionCaps,
    type SubscriptionHandle,
    type UrlPath,
} from "@plurnk/plurnk-schemes";
import Http from "../src/Http.ts";
import Guard from "../src/Guard.ts";
import { schemeCtx } from "../../plurnk-schemes/test/scheme-ctx.ts";
import { CACHE_VARIANT_HEADER, MATERIALIZER_ENV } from "../src/WebFetcher.ts";
import { requestUrl } from "../../scripts/lib/test-fetch.ts";

export const STUB_DIR = resolve(import.meta.dirname, "fixtures", "materializer-stub");

export const registerMaterializerStub = (): void => {
    const originalMaterializer = process.env[MATERIALIZER_ENV];
    before(async () => {
        await MaterializerRegistry.current().discover({
            packageDirs: [{ dir: STUB_DIR, name: "@plurnk/test-materializer-stub" }],
        });
    });
    beforeEach(() => {
        delete process.env[MATERIALIZER_ENV];
    });
    after(() => {
        if (originalMaterializer === undefined) delete process.env[MATERIALIZER_ENV];
        else process.env[MATERIALIZER_ENV] = originalMaterializer;
    });
};

export const projectionCaps = (overrides: Partial<ProjectionCaps> = {}): ProjectionCaps => ({
    async readable(content, mimetype) {
        const text = content.replace(/<[^>]+>/g, "").trim();
        return text.length > 0 ? {
            content: text,
            mimetype: "text/markdown",
            sourceMimetype: mimetype,
            projectionIdentity: `test:${mimetype}`,
        } : null;
    },
    async binary(chunks, mimetype) {
        return { bytes: await buffer(chunks), readable: null, projectionIdentity: `test:${mimetype}` };
    },
    async identity(mimetype) { return `test:${mimetype}`; },
    async isBinary(mimetype) { return MimetypeClassifier.isBinary(mimetype); },
    ...overrides,
    parseIssues: overrides.parseIssues ?? (async () => undefined),
});

export interface CtxOverrides {
    readonly read?: (pathname: string) => Promise<EntryStorageReadResult>;
    readonly write?: (pathname: string, entry: EntryData) => Promise<EntryStorageWriteResult>;
    readonly delete?: (pathname: string) => Promise<SchemeResult>;
    readonly projection?: ProjectionCaps;
    readonly signal?: AbortSignal;
}

export type ClosedSubscription = {
    result: Parameters<StreamSubscription["close"]>[0];
    summary?: string;
    channelResults?: Parameters<StreamSubscription["close"]>[2];
};

export interface CtxInspection {
    chunks: Array<{ channel: string; chunk: string; mimetype?: string }>;
    opened: { pathname: string; handle: SubscriptionHandle; publishedChannel?: string } | null;
    closed: ClosedSubscription | null;
    deleted: string | null;
    wrote: { pathname: string; entry: EntryData } | null;
    storedEntry: StoredEntryData | null;
    observedStorageRead: string | null;
    seq: string[];
}

export interface TestCtxHandle {
    ctx: SchemeCtx;
    inspect: () => CtxInspection;
    forceCancel: () => void | Promise<void> | undefined;
    awaitClosed: () => Promise<ClosedSubscription>;
}

export const makeCtx = (priorEntry: StoredEntryData | null = null, overrides: CtxOverrides = {}): TestCtxHandle => {
    const chunks: Array<{ channel: string; chunk: string; mimetype?: string }> = [];
    let opened: { pathname: string; handle: SubscriptionHandle; publishedChannel?: string } | null = null;
    let closed: ClosedSubscription | null = null;
    const settled = Promise.withResolvers<ClosedSubscription>();
    let deleted: string | null = null;
    let wrote: { pathname: string; entry: EntryData } | null = null;
    let observedStorageRead: string | null = null;
    let storedEntry = priorEntry;
    const seq: string[] = []; // {§http-lifecycle} operation order
    const localAbort = new AbortController();

    const entries: EntryCaps = {
        async address() { throw new Error("entry addressing is outside the HTTP specimen"); },
        operations: {
            async editBatch() { return { status: 501, entryId: null, channel: null }; },
            async find() { return { status: 501, content: null, mimetype: null, results: [], itemsWeightTotal: 0, returnedItemsWeightTotal: 0, matchingPathCount: 0, matchLocationCount: 0 }; },
            async send() { return { status: 501 }; },
        },
        async read(pathname) {
            observedStorageRead = pathname;
            if (overrides.read !== undefined) return overrides.read(pathname);
            return storedEntry === null
                ? Results.failure(
                    "scheme:test",
                    "entry-not-found",
                    404,
                    `No entry exists at ${pathname}.`,
                    { entry: null },
                )
                : Results.assert({ status: 200, entry: storedEntry });
        },
        async write(pathname, entry) {
            wrote = { pathname, entry };
            seq.push("write");
            if (overrides.write !== undefined) return overrides.write(pathname, entry);
            storedEntry = {
                channels: Object.fromEntries(Object.entries(entry.channels).map(([channel, value]) => [
                    channel,
                    { ...value, state: value.state ?? "static" },
                ])),
                ...(entry.attributes === undefined ? {} : { attributes: entry.attributes }),
            };
            return { status: 201, created: true, entryId: 1 };
        },
        async delete(pathname) {
            deleted = pathname;
            if (overrides.delete !== undefined) return overrides.delete(pathname);
            storedEntry = null;
            return { status: 200 };
        },
    };
    const channels: ChannelCaps = {
        async append() { return { status: 200 }; },
        async replace() { return { status: 200 }; },
        async setState() { return { status: 200 }; },
    };
    const notify: NotifyCaps = { streamEvent() {} };
    const projection = overrides.projection ?? projectionCaps();
    const notifyChunk: StreamSubscription["notifyChunk"] = async (channel, chunk, mimetype) => {
        chunks.push({ channel, chunk, mimetype });
    };
    const close: StreamSubscription["close"] = async (result, summary, channelResults) => {
        closed = { result, summary, channelResults };
        settled.resolve(closed);
    };
    const subscriptions: SubscriptionCaps = {
        async open(pathname, handle) {
            opened = { pathname, handle };
            seq.push("open");
            return Object.assign(localAbort.signal, { notifyChunk, close });
        },
    };
    const ctx = schemeCtx({
        signal: overrides.signal,
        entries, channels, notify, projection, subscriptions,
        interactions: { request: async () => ({ action: "cancel" }) },
    });
    return {
        ctx,
        inspect: () => ({ chunks, opened, closed, deleted, wrote, storedEntry, observedStorageRead, seq }),
        forceCancel: () => opened?.handle.cancel(),
        awaitClosed: () => settled.promise,
    };
};

export const urlTarget = (raw: string, pathname: string, fragment: string | null = null): UrlPath => {
    const url = new URL(raw);
    return {
        kind: "url", raw, scheme: url.protocol.slice(0, -1),
        username: url.username || null, password: url.password || null,
        hostname: url.hostname || null, port: url.port === "" ? null : Number(url.port),
        pathname, query: url.search === "" ? null : url.search.slice(1), fragment,
    };
};

export const readStmt = (
    target: UrlPath | null,
    lineMarker: ReadStatement["lineMarker"] = null,
    metadata: ReadStatement["metadata"] = null,
): ReadStatement => ({
    op: "READ", aside: null, target, metadata, lineMarker, matcher: null, body: null,
    position: { line: 0, column: 0 },
});
export const sendStmt = (target: UrlPath | null, body?: string, metadata: SendStatement["metadata"] = null): SendStatement => ({
    op: "SEND", aside: null, target, metadata, lineMarker: null,
    body: body === undefined ? null : { raw: body, json: null },
    position: { line: 0, column: 0 },
});
export const editStmt = (target: UrlPath | null, body: string | null, lineMarker: ResolvedEditStatement["lineMarker"] = null, metadata: ResolvedEditStatement["metadata"] = null): ResolvedEditStatement => ({
    op: "EDIT", aside: null, target, metadata, lineMarker, matcher: null, body,
    position: { line: 0, column: 0 },
});
export const killStmt = (target: UrlPath | null, matcher: KillStatement["matcher"] = null, metadata: KillStatement["metadata"] = null): KillStatement => ({
    op: "KILL", aside: null, target, metadata, lineMarker: null, matcher, body: null,
    position: { line: 0, column: 0 },
});
export const settle = async (http: Http, ctx: SchemeCtx, metadata: readonly string[] | null, result: SchemeResult): Promise<SchemeResult> => {
    if (result.status !== 202) return result;
    return http.applyResolution({ attrs: (result as ProposalResult).attrs ?? {}, metadata }, ctx);
};
export const sendSettled = async (http: Http, statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult> =>
    settle(http, ctx, statement.metadata, await http.send(statement, ctx));
export const editSettled = async (http: Http, statement: ResolvedEditStatement, ctx: SchemeCtx): Promise<SchemeResult> =>
    settle(http, ctx, statement.metadata, await http.edit(statement, ctx));
export const killSettled = async (http: Http, statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> =>
    settle(http, ctx, statement.metadata, await http.kill(statement, ctx));
export const httpSend = (statement: SendStatement, ctx: SchemeCtx): Promise<SchemeResult> => sendSettled(new Http(), statement, ctx);
export const httpEdit = (statement: ResolvedEditStatement, ctx: SchemeCtx): Promise<SchemeResult> => editSettled(new Http(), statement, ctx);
export const httpKill = (statement: KillStatement, ctx: SchemeCtx): Promise<SchemeResult> => killSettled(new Http(), statement, ctx);

export const findStmt = (target: UrlPath | null, matcher: FindStatement["matcher"] = null, metadata: FindStatement["metadata"] = null): FindStatement => ({
    op: "FIND", aside: null, target, metadata, lineMarker: null, matcher, body: null,
    position: { line: 0, column: 0 },
});
export const prepareExactFind = (http: Http, statement: FindStatement, ctx: SchemeCtx): Promise<RepresentationPreparationResult> => {
    const target = statement.target;
    if (target === null || target.kind !== "url") {
        throw new TypeError("prepareExactFind requires one exact URL target");
    }
    const address = NetworkAddress.from(target);
    return http.prepareRepresentation({
        target: { ...target, fragment: null },
        metadata: statement.metadata,
        authority: address.authority,
        pathname: address.pathname,
    }, ctx);
};

export const prepareRepresentation = (http: Http, statement: ReadStatement, ctx: SchemeCtx): Promise<RepresentationPreparationResult> => {
    const target = statement.target;
    if (target === null || target.kind !== "url") {
        return http.prepareRepresentation({
            target: target ?? { kind: "local", raw: "" },
            metadata: statement.metadata,
            authority: "",
            pathname: "",
        }, ctx);
    }
    const address = NetworkAddress.from(target);
    return http.prepareRepresentation({
        target: { ...target, fragment: null },
        metadata: statement.metadata,
        authority: address.authority,
        pathname: address.pathname,
    }, ctx);
};

export const mockFetch = (
    status: number,
    statusText: string,
    bodyChunks: ReadonlyArray<string | Uint8Array>,
    headers: Record<string, string> = {},
): (() => Promise<Response>) => {
    const enc = new TextEncoder();
    const stream = bodyChunks.length === 0 ? null : new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of bodyChunks) {
                controller.enqueue(typeof chunk === "string" ? enc.encode(chunk) : chunk);
            }
            controller.close();
        },
    });
    return async () => new Response(stream, { status, statusText, headers });
};

export const withFetch = async (
    impl: typeof fetch | (() => Promise<Response>),
    fn: () => Promise<void>,
    allowAllTargets = true,
    answerLlmsText = false,
): Promise<void> => {
    const original = globalThis.fetch;
    const publicUrl = allowAllTargets ? mock.method(Guard, "isPublicUrl", async () => true) : null;
    const wrapped = answerLlmsText
        ? impl
        : async (input: string | URL | Request, init?: RequestInit) =>
            requestUrl(input).endsWith("/llms.txt")
                ? new Response(null, { status: 404 })
                : (impl)(input, init);
    globalThis.fetch = wrapped;
    try { await fn(); } finally {
        globalThis.fetch = original;
        publicUrl?.mock.restore();
    }
};

export const flush = (): Promise<void> => new Promise<void>((done) => setImmediate(done));

export const priorEntry = (
    body: string,
    mimetype: string,
    header: string,
    readable?: string,
    state: ChannelState = "closed",
): StoredEntryData => ({
    channels: {
        body: { content: body, mimetype, state },
        header: { content: header, mimetype: "text/plain", state },
        ...(readable === undefined ? {} : { readable: { content: readable, mimetype: "text/markdown", state } }),
    },
});

export const stampedHeader = (
    ageMs: number,
    extra = "",
    variant: "default" | "bypass" = "default",
): string => [
    `HTTP 200 OK${extra}`,
    "x-plurnk-request-method: GET",
    `x-plurnk-fetched-at: ${new Date(Date.now() - ageMs).toISOString()}`,
    `${CACHE_VARIANT_HEADER}: ${variant}`,
].join("\n");

export const withTtl = async (ttl: string | undefined, fn: () => Promise<void>): Promise<void> => {
    const prev = process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    if (ttl === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
    else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = ttl;
    try { await fn(); } finally {
        if (prev === undefined) delete process.env.PLURNK_SCHEMES_HTTP_TTL_MS;
        else process.env.PLURNK_SCHEMES_HTTP_TTL_MS = prev;
    }
};
