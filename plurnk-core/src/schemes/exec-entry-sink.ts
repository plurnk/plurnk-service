// {§execution-output-identity} {§env-delta} — the executor's `entry()` sink. Each materialization is one
// durable entry write, serialized behind the previous, narrated as one `_plurnk` EDIT row through the one
// reserved-session turn this spawn owns; the spawn's tail settles the chain and closes that turn ({§execution-output-identity}).

import { parsePath } from "@plurnk/plurnk-parser";
import { PathSyntax, type ParsedPath } from "@plurnk/plurnk-contracts";
import type { Executor } from "@plurnk/plurnk-execs";
import {
    NetworkAddress,
    ResourceNames,
    WebMaterializationError,
    type WebFetchResult,
    type WebMaterializedResult,
    type WebMaterializer,
} from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import type { EntryAddressResolution } from "../core/EntryAddressBinding.ts";
import EntryCrud from "./_entry-crud.ts";
import type { EntryData } from "./_entry-crud.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import Results, { OperationFailureError, type SchemeResult } from "../core/results.ts";
import DbProjectionCaps from "../core/caps/DbProjectionCaps.ts";
import SessionControlAddress from "../core/SessionControlAddress.ts";
import Turn from "../core/Turn.ts";
import AdministrativeLoop from "../core/AdministrativeLoop.ts";
import RuntimeSession from "../core/RuntimeSession.ts";
import LoopLifecycle from "../core/LoopLifecycle.ts";
import LogEntryProjection from "../core/LogEntryProjection.ts";
import LogBody from "../core/LogBody.ts";

// {§execution-output-identity}: the web-fetch the sink calls when the executor hands content:null —
// the registry's web materializer ({§scheme-operation-dispatch}: checked byte acquisition,
// dead-as-null; caller cancellation rejects per {§prefetch}).
// Injectable because automatic acquisition refuses localhost.
export type WebFetch = (url: string, opts?: { signal?: AbortSignal }) => Promise<WebFetchResult | null>;

export interface EntrySinkDeps {
    readonly ctx: PlurnkSchemeContext;
    readonly runtime: string;
    readonly pathname: string;
    readonly signal: AbortSignal;
    readonly executor: Executor;
    readonly bindEntryAddress: (target: ParsedPath, ctx: PlurnkSchemeContext) => Promise<EntryAddressResolution | null>;
    readonly fetchWeb: WebFetch;
    readonly materializer: () => WebMaterializer;
}

type EntryNarration = {
    sessionId: number;
    loopId: number;
    loopSeq: number;
    turnId: number;
    turnSeq: number;
    seq: number;
};

const narrationFailed = (): SchemeResult => Results.failure(
    "scheme:exec",
    "entry-narration-failed",
    500,
    "An executor entry could not be materialized or narrated.",
    {},
    { stage: "entry-materialization", retryable: false },
);

export default class ExecEntrySink {
    readonly #deps: EntrySinkDeps;
    readonly #publishedNames = new ResourceNames();
    #entryChain: Promise<unknown> = Promise.resolve();
    #entryChainFailed = false;
    #narration: EntryNarration | null = null;
    #narrationResult: SchemeResult = { status: 200 };
    #callerSource: string | undefined;

    constructor(deps: EntrySinkDeps) {
        this.#deps = deps;
    }

    /** The narration turn this spawn opened, once an entry landed; null until then. */
    get narrationTurnId(): number | null { return this.#narration?.turnId ?? null; }

    async #resolveCallerSource(): Promise<string> {
        if (this.#callerSource !== undefined) return this.#callerSource;
        const { ctx } = this.#deps;
        const caller = await ctx.db.session_name_by_id.get<{ name: string }>({ session_id: ctx.sessionId });
        if (caller === undefined) throw new Error(`entry(): calling session ${ctx.sessionId} does not exist`);
        this.#callerSource = SessionControlAddress.render(caller.name);
        return this.#callerSource;
    }

    // The executor's `entry` callback: an address the write resolved to, or a rejection.
    readonly entry = (requestedPath: string | null, content: string | Uint8Array | null, sink: { mimetype?: string; name?: string }): Promise<string> => {
        const { ctx, runtime, pathname, signal, executor } = this.#deps;
        const db = ctx.db;
        let path = requestedPath;
        if (path === null) {
            if (content === null) return Promise.reject(new Error("entry(): an invocation resource requires supplied content"));
            path = renderAddress({ scheme: runtime, authority: "", pathname: `${pathname}/resources/${this.#publishedNames.allocate(sink.name)}` });
        }
        const parsed = parsePath(path);
        if (parsed === null || parsed.kind !== "url") return Promise.reject(new Error(`entry(): '${path.slice(0, 80)}' is not a URL`));
        if (content !== null && sink.mimetype === undefined) return Promise.reject(new Error("entry(): mimetype is required when content is provided"));
        const address = NetworkAddress.supports(parsed.scheme) ? NetworkAddress.from(parsed) : null;
        if (address?.hasCredentials === true) return Promise.reject(new Error("entry(): network URL userinfo is not allowed"));
        const fetchAddress = address !== null && (address.scheme === "http" || address.scheme === "https")
            ? address
            : null;
        const binding = requestedPath === null
            ? Promise.resolve({ address: { scheme: runtime, authority: "", pathname: parsed.pathname }, result: null })
            : this.#deps.bindEntryAddress(parsed, ctx);
        // {§execution-output-identity}/{§membership} — start content:null
        // acquisition before the write chain so fetches run in parallel;
        // only durable entry writes serialize. A null result rejects the sink.
        let materialized: Promise<WebFetchResult | null> | undefined;
        if (content === null) {
            if (fetchAddress === null) return Promise.reject(new Error("entry(): content:null requires an http(s):// URL"));
            materialized = this.#deps.fetchWeb(fetchAddress.url, { signal });
        } else if (typeof content === "string" && requestedPath !== null && sink.mimetype !== undefined) {
            materialized = Promise.resolve({
                url: fetchAddress?.url ?? "http://localhost",
                body: content,
                mimetype: sink.mimetype,
                allowConfiguredMaterializer: false,
            });
        }
        const op = async (): Promise<string> => {
            const resolved = await binding;
            if (resolved === null) {
                throw new Error(`entry(): no entry-bearing scheme is registered for '${path.slice(0, 80)}'`);
            }
            if (resolved.result !== null) throw new OperationFailureError(resolved.result);
            if (resolved.address === null) {
                throw new Error(`entry(): '${path.slice(0, 80)}' did not resolve to an entry address`);
            }
            const { authority, pathname: entryPathname, scheme } = resolved.address;
            const entryCoordinate = { authority, pathname: entryPathname };
            let channels: EntryData["channels"];
            let decisive: string;
            let source: string;
            if (materialized === undefined) {
                if (content === null) throw new Error("entry(): missing supplied content");
                const entryBody = typeof content === "string" ? { content, mimetype: sink.mimetype! }
                    : { content: "", bytes: content, mimetype: sink.mimetype! };
                const channel = requestedPath === null ? executor.defaultChannel : ctx.defaultChannelFor?.(scheme);
                if (channel === undefined) throw new Error(`entry(): no default channel for '${scheme}'`);
                channels = { [channel]: entryBody };
                decisive = typeof content === "string" ? content : `${sink.mimetype}; ${content.byteLength} bytes`;
                source = decisive;
            } else {
                const fetched = await materialized;
                if (fetched === null) throw new Error(`entry(): '${path.slice(0, 80)}' is dead`);
                let web: WebMaterializedResult;
                try {
                    web = await this.#deps.materializer().materialize(fetched, new DbProjectionCaps(ctx));
                } catch (error) {
                    if (!signal.aborted && error instanceof WebMaterializationError) {
                        console.error("entry() web materialization failed", { path, error });
                    }
                    throw error;
                }
                channels = this.#deps.materializer().materializedChannels(
                    web,
                    content === null && fetchAddress !== null ? { url: fetchAddress.url, method: "GET" } : undefined,
                );
                decisive = web.readable?.content ?? (web.body.bytes === undefined
                    ? web.body.content : `${web.body.mimetype}; ${web.body.bytes.byteLength} bytes`);
                source = web.body.bytes === undefined ? web.body.content : decisive;
            }
            const causalSource = await this.#resolveCallerSource();
            const written = Results.assert(
                await EntryCrud.writeEntry(entryCoordinate, { channels }, ctx, scheme, {
                    defaultChannel: requestedPath === null ? executor.defaultChannel : ctx.defaultChannelFor?.(scheme),
                    output: requestedPath === null,
                }),
            );
            if (this.#narration === null) {
                const sessionId = await RuntimeSession.ensure(db, ctx.workspaceId);
                const loop = await AdministrativeLoop.open(db, sessionId);
                const turn = await Turn.open(db, {
                    loopId: loop.id,
                    producer: "_plurnk",
                    kind: "operation",
                });
                this.#narration = {
                    sessionId,
                    loopId: loop.id,
                    loopSeq: loop.sequence,
                    turnId: turn.id,
                    turnSeq: turn.sequence,
                    seq: 1,
                };
            }
            const narration = this.#narration;
            if (this.#narrationResult.status < 400 || written.status >= 400) this.#narrationResult = written;
            const sequence = narration.seq++;
            const narrationAttrs = { kind: "entry_materialized" } as const;
            if (written.problem !== undefined) {
                const narrationCoordinate = LogEntryProjection.coordinate(
                    `${narration.loopSeq}/${narration.turnSeq}/${sequence}`,
                    { origin: "_plurnk", op: "EDIT", attrs: narrationAttrs },
                );
                Results.attachInstance(
                    written,
                    `log:///${narrationCoordinate}`,
                );
            }
            const tx = JSON.stringify({ op: "EDIT", body: source });
            const rx = JSON.stringify(written.problem === undefined
                ? {
                    ...written,
                    span: decisive.split("\n").map((l, n) => `${n + 1}:${l}`).join("\n"),
                }
                : written);
            const attrs = JSON.stringify(narrationAttrs);
            if (ctx.weigh === undefined) {
                throw new Error("entry(): ctx.weigh is required for curation-weight accounting");
            }
            const logRow = await db.engine_insert_log_entry.get<{ id: number }>({
                session_id: narration.sessionId, loop_id: narration.loopId, turn_id: narration.turnId, sequence,
                origin: "_plurnk", source: causalSource, model_call_id: null,
                op: "EDIT", signal: null,
                scheme, username: null, password: null,
                hostname: address === null ? null : parsed.hostname,
                port: address === null ? null : parsed.port,
                pathname: address === null ? entryPathname : PathSyntax.decodeParens(parsed.pathname),
                query: address === null ? null : parsed.query,
                fragment: null, lineMarker: null,
                tx, mimetype_tx: "application/json",
                rx,
                mimetype_rx: "application/json",
                status_rx: written.status,
                weight: LogBody.weight({
                    op: "EDIT",
                    attrs,
                    tx,
                    rx,
                    mimetypeTx: "application/json",
                    mimetypeRx: "application/json",
                }, ctx.weigh),
                state: "resolved", outcome: null,
                // Durable provenance for clients/forensics. This is machine
                // ambience, not a human/model action waterfall item.
                attrs,
                initial_folded: "[]",
            });
            if (logRow === undefined) throw new Error("entry(): log insert returned no row");
            if (written.problem !== undefined) throw new OperationFailureError(written);
            return renderAddress({ scheme, authority, pathname: entryPathname });
        };
        const run = this.#entryChain.then(op, op);
        this.#entryChain = run.then(
            () => undefined,
            () => { this.#entryChainFailed = true; },
        );
        return run;
    };

    // {§execution-output-identity} — the spawn tail owns every serialized entry/narration write: join the chain, then close the
    // narration turn and its loop with the result the entries settled on. Returns the failures the tail must report.
    async settle(): Promise<unknown[]> {
        const failures: unknown[] = [];
        if (this.#entryChainFailed && this.#narrationResult.status < 400) this.#narrationResult = narrationFailed();
        try {
            await this.#entryChain;
        } catch (cause) {
            this.#narrationResult = narrationFailed();
            failures.push(cause);
        }
        const narration = this.#narration;
        if (narration !== null) {
            try {
                await Turn.complete(this.#deps.ctx.db, narration.turnId, this.#narrationResult.status);
                const closed = await new LoopLifecycle(this.#deps.ctx.db).finish(narration.loopId, this.#narrationResult);
                if (closed === null) {
                    throw new Error(`entry(): narration loop ${narration.loopId} was not open at completion`);
                }
            } catch (cause) {
                failures.push(cause);
            }
        }
        return failures;
    }
}
