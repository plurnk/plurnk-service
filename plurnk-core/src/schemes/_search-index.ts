// Search-index materialization for every readable workspace channel. Entry
// channels and logs attach to the same immutable, content-addressed derivation
// artifacts; FTS and graph relationships consume them uniformly.

import type { PlurnkSchemeContext } from "../core/scheme-types.ts";
import { MimetypeDerivationError, isMimetypeInputError } from "@plurnk/plurnk-mimetypes";
import type { Notice, ProcessResult } from "@plurnk/plurnk-mimetypes";
import { createHash } from "node:crypto";
import { availableParallelism } from "node:os";
import EntryGraph from "./_entry-graph.ts";
import EntryFts from "./_entry-fts.ts";
import LogBody from "../core/LogBody.ts";
import LogEntryProjection from "../core/LogEntryProjection.ts";
import LogVisibility from "../core/LogVisibility.ts";
import matchSearchExclusion from "./_search-exclusion.ts";
import { contentHash } from "../core/content-hash.ts";

// {§derivation-dedup-parallel} — an entry channel is judged from stored identity; no body here.
type EntryCandidate = {
    entry_id: number;
    scheme: string;
    authority: string;
    pathname: string;
    channel: string;
    mimetype: string;
    content_length: number;
    content_hash: string | null;
    deep_hash: string | null;
};
export type MaintenanceReport = { derived: number; acquiredBytes: number };
type DerivationArtifact = {
    id: number;
    state: "building" | "complete";
    disposition: string | null;
    reason: string | null;
};
type DerivationRow = {
    id: number;
    pathname: string;
    mimetype: string;
    contentLength: number;
    // SHA-256 of the exact representation: the channel's stored identity, or computed from a
    // body the pass had to read.
    contentHash: string;
    // The body, acquired only when its derivation runs; null when the representation moved on
    // since it was judged, which the next pass judges afresh.
    body: () => Promise<string | null>;
} & (
    | { attachment: "entry-channel"; scheme: string; authority: string; channel: string; hashed: boolean }
    | { attachment: "log"; folded: string }
    | { attachment: "turn-source"; kind: "ops" | "reasoning" }
);
type PendingDerivation = {
    r: DerivationRow;
    hash: string;
    searchExcluded: string | undefined;
    binary: boolean;
};
type DerivationCallbacks = {
    onNotice?: (notice: Notice) => void;
    onMemberFailure?: (failure: MemberFailure) => void;
};
type MemberFailure = { path: string; reason: string };
const NO_PROJECTION_IDENTITY = "projection:none";

export default class SearchIndex {
    // The index materializes one immutable artifact per exact READ representation and
    // configuration identity, then atomically attaches resource addresses to it.
    // Cancellation leaves a building artifact unattached for retry; a typed
    // invalid-source failure is terminal and observable so
    // one malformed specimen cannot hold workspace readiness hostage.
    // Hash-keyed chains serialize concurrent workspace warm requests for the same
    // artifact while distinct artifacts remain parallel.
    static #deriveChains = new Map<string, Promise<void>>();

    static async #deriveOne(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, searchExcluded: string | undefined, binary: boolean, callbacks: DerivationCallbacks = {}): Promise<void> {
        const prior = SearchIndex.#deriveChains.get(hash) ?? Promise.resolve();
        const run = prior.then(() => SearchIndex.#deriveOneUnlocked(ctx, r, hash, searchExcluded, binary, callbacks));
        const tail = run.catch(() => {}); // the chain survives a failed link; deriveOne's caller sees the rejection
        SearchIndex.#deriveChains.set(hash, tail);
        void tail.finally(() => {
            if (SearchIndex.#deriveChains.get(hash) === tail) SearchIndex.#deriveChains.delete(hash);
        });
        return run;
    }

    static async #deriveOneUnlocked(ctx: PlurnkSchemeContext, r: DerivationRow, hash: string, searchExcluded: string | undefined, binary: boolean, callbacks: DerivationCallbacks): Promise<void> {
        const { db, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("deriveOne: ctx.mimetypes is required");
        // Attach while the channel still denotes the derived representation: by its stored identity
        // when it has one, by the exact body otherwise ({§derivation-dedup-parallel}).
        const attach = async (content: string | null): Promise<void> => {
            if (r.attachment === "entry-channel") {
                const identity = { entry_id: r.id, scheme: r.scheme, authority: r.authority, pathname: r.pathname, channel: r.channel, mimetype: r.mimetype, deep_hash: hash };
                if (r.hashed) {
                    await db.crud_attach_channel_derivation_by_hash.run({ ...identity, content_hash: r.contentHash });
                    return;
                }
                const body = content ?? await r.body();
                if (body === null) return;
                await db.crud_attach_channel_derivation.run({ ...identity, content: body });
            } else if (r.attachment === "log") {
                await db.log_set_deep_hash.run({ log_entry_id: r.id, deep_hash: hash, folded: r.folded });
            } else {
                await db.turn_source_attach_derivation.run({ turn_id: r.id, kind: r.kind, deep_hash: hash });
            }
        };
        let artifact = await db.derivation_get.get<DerivationArtifact>({ deep_hash: hash });
        if (artifact?.state === "complete") {
            await attach(null);
            return;
        }
        if (artifact === undefined) {
            artifact = await db.derivation_create.get<DerivationArtifact>({ deep_hash: hash });
        }
        if (artifact === undefined) throw new Error(`failed to create derivation artifact ${hash}`);
        const derivationId = artifact.id;
        // The body crosses into the process here and nowhere earlier; a representation that moved
        // on since it was judged leaves the artifact building for the next pass to judge afresh.
        const content = await r.body();
        if (content === null) return;
        let parseIssues: number | null = null;
        let summary: string | null = null;
        const attachComplete = async (disposition: "indexed" | "excluded" | "unsearchable" | "failed", reason: string | null = null): Promise<void> => {
            await db.derivation_complete.run({
                derivation_id: derivationId,
                disposition,
                reason,
                parse_issues: parseIssues,
                summary,
            });
            await attach(content);
        };
        const wantGraph = content.length > 0 && !binary;
        if (!wantGraph) {
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntryFts.index(db, derivationId, "");
            await attachComplete(
                searchExcluded === undefined ? "unsearchable" : "excluded",
                searchExcluded ?? (content.length === 0 ? "empty" : "binary"),
            );
            return;
        }
        let result: ProcessResult;
        try {
            result = await mimetypes.process(
                { content, hint: r.mimetype, path: r.pathname },
                {
                    channels: searchExcluded === undefined ? ["symbols", "references"] : [],
                    summary: true,
                },
            );
        } catch (error) {
            if (ctx.signal?.aborted === true) throw error;
            // {§derivation-member-failure}: a typed invalid-source rejection and a handler's own
            // defect on this one member ({§mimetype-derivation-evidence}) are both that member's
            // terminal disposition, never the pass's. Anything else thrown here — a grammar not
            // installed, a contract violation outside the handler — stays fatal.
            const handlerDefect = error instanceof MimetypeDerivationError;
            if (!handlerDefect && !isMimetypeInputError(error)) throw error;
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntryFts.index(db, derivationId, "");
            const reason = searchExcluded ?? SearchIndex.#failureReason(error);
            await attachComplete(searchExcluded === undefined ? "failed" : "excluded", reason);
            if (handlerDefect && searchExcluded === undefined) callbacks.onMemberFailure?.({ path: r.pathname, reason });
            return;
        }
        ctx.signal?.throwIfAborted();
        parseIssues = result.parseIssues ?? null;
        summary = result.summary ?? null;
        for (const notice of result.notices ?? []) callbacks.onNotice?.(notice);
        if (searchExcluded !== undefined) {
            await EntryGraph.populateFrom(db, derivationId, [], []);
            await EntryFts.index(db, derivationId, "");
            await attachComplete("excluded", searchExcluded);
            return;
        }
        // Persistence operations are outside typed input-failure
        // containment. An internal/operational failure leaves the artifact
        // building and propagates so a later warm can retry; it is never
        // mislabeled as one malformed resource.
        await EntryGraph.populateFrom(db, derivationId, result.symbols ?? [], result.references ?? []);
        // Index exactly the addressed READ representation.
        await EntryFts.index(db, derivationId, content);
        await attachComplete("indexed");
    }

    static progressHeartbeatMs(): number {
        const progressHeartbeatMs = Number(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS);
        if (!Number.isInteger(progressHeartbeatMs) || progressHeartbeatMs <= 0) {
            throw new RangeError(`PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS must be a positive integer; got ${JSON.stringify(process.env.PLURNK_SERVICE_DERIVE_PROGRESS_HEARTBEAT_MS)}`);
        }
        return progressHeartbeatMs;
    }

    static producerConcurrency(): number {
        const rawConcurrency = process.env.PLURNK_SERVICE_DERIVE_CONCURRENCY;
        const cores = availableParallelism();
        const configuredConcurrency = rawConcurrency === undefined || rawConcurrency.trim() === ""
            // Bound concurrently materialized parser graphs independently of SQL readers.
            ? Math.max(1, Math.floor(Math.sqrt(cores)))
            : Number(rawConcurrency);
        if (!Number.isInteger(configuredConcurrency) || configuredConcurrency === 0 || configuredConcurrency < -1) {
            throw new RangeError(`PLURNK_SERVICE_DERIVE_CONCURRENCY must be -1 (match cores) or a positive integer; got ${JSON.stringify(rawConcurrency)}`);
        }
        return configuredConcurrency === -1 ? cores : configuredConcurrency;
    }

    // The exact reason for a member's `failed` row: the handler's invocation context plus its
    // original cause, or the typed rejection's own message.
    static #failureReason(error: unknown): string {
        if (!(error instanceof MimetypeDerivationError)) return error instanceof Error ? error.message : String(error);
        const cause = error.cause;
        const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        return `${error.message} ${detail}`;
    }

    static async maintain(ctx: PlurnkSchemeContext): Promise<MaintenanceReport> {
        const { db, workspaceId, mimetypes } = ctx;
        if (mimetypes === undefined) throw new Error("SearchIndex.maintain: ctx.mimetypes is required");
        ctx.signal?.throwIfAborted();
        const progressHeartbeatMs = SearchIndex.progressHeartbeatMs();
        // Validate global graph persistence tuning before resource-local
        // derivation containment can classify a handler failure.
        EntryGraph.storeBatch();
        // {§derivation-dedup-parallel} — entry channels are judged from stored identity: the
        // candidate statement carries no body, and a body crosses into the process only for a
        // derivation that runs, or for a channel with no stored identity (a stream), which must be
        // read to be judged. Log rows and turn sources still arrive whole.
        let acquiredBytes = 0;
        const candidates = await db.search_index_entry_candidates.all<EntryCandidate>({ workspace_id: workspaceId });
        const acquire = async (entryId: number, channel: string, storedHash: string | null): Promise<string | null> => {
            const row = await db.search_index_entry_body.get<{ content: string }>({ entry_id: entryId, channel, content_hash: storedHash });
            if (row === undefined) return null;
            acquiredBytes += row.content.length;
            return row.content;
        };
        const logRows = await db.log_derivation_rows.all<{
            id: number;
            coordinate: string;
            origin: string;
            op: string | null;
            tx: string;
            mimetype_tx: string;
            rx: string;
            mimetype_rx: string;
            deep_hash: string | null;
            attrs: string;
            folded: string;
        }>({ workspace_id: workspaceId });
        for (const row of logRows) acquiredBytes += row.tx.length + row.rx.length;
        const projectionIdentities = new Map<string, Promise<string>>();
        const projectionIdentityFor = (
            mimetype: string,
            contentLength: number,
            binary: boolean,
            searchExcluded: string | undefined,
        ): Promise<string> => {
            if (searchExcluded !== undefined || contentLength === 0 || binary) {
                return Promise.resolve(NO_PROJECTION_IDENTITY);
            }
            const cached = projectionIdentities.get(mimetype);
            if (cached !== undefined) return cached;
            const identity = mimetypes.projectionIdentity(mimetype);
            projectionIdentities.set(mimetype, identity);
            return identity;
        };
        // Compute the changed-representation worklist before scheduling so aggregate
        // progress has a stable total. {§derivation-dedup-parallel}
        const pending: PendingDerivation[] = [];
        for (const c of candidates) {
            const searchExcluded = matchSearchExclusion(c);
            const dispositionIdentity = searchExcluded === undefined ? "included" : `excluded:${searchExcluded}`;
            const binary = (await mimetypes.classify(c.mimetype)).binary;
            const projectionIdentity = await projectionIdentityFor(c.mimetype, c.content_length, binary, searchExcluded);
            // A channel without a stored identity (an open or streamed channel) is the one body the
            // metadata cannot judge; it is read now and hashed.
            let preloaded: string | null = null;
            let identity = c.content_hash;
            if (identity === null) {
                preloaded = await acquire(c.entry_id, c.channel, null);
                if (preloaded === null) continue;
                identity = contentHash(preloaded);
            }
            const hash = derivationHash({ contentHash: identity, mimetype: c.mimetype, binary, projectionIdentity, dispositionIdentity });
            if (hash === c.deep_hash) continue; // unchanged since last derivation → deep rows persist
            const body = preloaded;
            pending.push({
                r: {
                    id: c.entry_id,
                    attachment: "entry-channel",
                    scheme: c.scheme,
                    authority: c.authority,
                    channel: c.channel,
                    pathname: c.pathname,
                    mimetype: c.mimetype,
                    contentLength: c.content_length,
                    contentHash: identity,
                    hashed: c.content_hash !== null,
                    body: body === null ? () => acquire(c.entry_id, c.channel, c.content_hash) : () => Promise.resolve(body),
                },
                hash,
                searchExcluded,
                binary,
            });
        }
        for (const row of logRows) {
            const projection = LogBody.readable({
                op: row.op,
                attrs: row.attrs,
                tx: row.tx,
                rx: row.rx,
                mimetypeTx: row.mimetype_tx,
                mimetypeRx: row.mimetype_rx,
            }, LogVisibility.parse(row.folded));
            const binary = (await mimetypes.classify(projection.mimetype)).binary;
            const projectionIdentity = await projectionIdentityFor(
                projection.mimetype,
                projection.content.length,
                binary,
                undefined,
            );
            const hash = derivationHash({
                contentHash: contentHash(projection.content),
                mimetype: projection.mimetype,
                binary,
                projectionIdentity,
                dispositionIdentity: "included",
            });
            if (hash !== row.deep_hash) pending.push({
                r: {
                    id: row.id,
                    attachment: "log",
                    folded: row.folded,
                    pathname: LogEntryProjection.coordinate(row.coordinate, row),
                    mimetype: projection.mimetype,
                    contentLength: projection.content.length,
                    contentHash: contentHash(projection.content),
                    body: () => Promise.resolve(projection.content),
                },
                hash,
                searchExcluded: undefined,
                binary,
            });
        }
        const sources = await db.turn_source_derivations.all<{
            turn_id: number; kind: "ops" | "reasoning"; pathname: string; content: string; deep_hash: string | null;
        }>({ workspace_id: workspaceId });
        for (const source of sources) {
            acquiredBytes += source.content.length;
            const mimetype = source.kind === "ops" ? "text/vnd.plurnk" : "text/plain";
            const projectionIdentity = await projectionIdentityFor(mimetype, source.content.length, false, undefined);
            const identity = contentHash(source.content);
            const hash = derivationHash({ contentHash: identity, mimetype, binary: false, projectionIdentity, dispositionIdentity: "included" });
            if (hash !== source.deep_hash) pending.push({
                r: {
                    id: source.turn_id, attachment: "turn-source", kind: source.kind,
                    pathname: source.pathname, mimetype,
                    contentLength: source.content.length, contentHash: identity,
                    body: () => Promise.resolve(source.content),
                },
                hash, searchExcluded: undefined, binary: false,
            });
        }
        // {§derivation-dedup-parallel} — warm smaller projections before an
        // expensive outlier; ordering never changes exhaustive derivation. The
        // stored length orders without a body.
        pending.sort((a, b) => a.r.contentLength - b.r.contentLength);
        const total = pending.length;
        if (total === 0) return { derived: 0, acquiredBytes };
        let completed = 0;
        const memberFailures: MemberFailure[] = [];
        const projectionNotices = new Set<string>();
        const forwardProjectionNotice = (notice: Notice): void => {
            const key = JSON.stringify(notice);
            if (projectionNotices.has(key)) return;
            projectionNotices.add(key);
            ctx.pushNotice?.(notice);
        };
        const publish = (phase: "preparing" | "indexing" | "complete" | "failed", message: string, level: "info" | "warn" | "error" = "info"): void => {
            const terminal = phase === "complete";
            const current = terminal ? total : completed;
            const percent = terminal ? 100 : Math.floor((current / total) * 100);
            ctx.pushNotice?.({
                source: "engine:derivation",
                kind: "search_progress",
                phase,
                message,
                completed: current,
                total,
                percent,
                level,
            });
        };
        publish("preparing", "Preparing repository content for search indexing");

        // Each derivation identity builds one shared artifact while distinct
        // artifacts run with bounded concurrency. {§derivation-dedup-parallel}
        const groups = new Map<string, PendingDerivation[]>();
        for (const p of pending) {
            const g = groups.get(p.hash);
            if (g === undefined) groups.set(p.hash, [p]); else g.push(p);
        }
        const concurrency = SearchIndex.producerConcurrency();
        const workerPool = async (work: PendingDerivation[][]): Promise<void> => {
            let next = 0;
            const worker = async (): Promise<void> => {
                while (next < work.length) {
                    ctx.signal?.throwIfAborted();
                    const group = work[next++];
                    for (const { r, hash, searchExcluded, binary } of group) {
                        ctx.signal?.throwIfAborted();
                        await SearchIndex.#deriveOne(ctx, r, hash, searchExcluded, binary, {
                            onNotice: forwardProjectionNotice,
                            onMemberFailure: (failure) => { memberFailures.push(failure); },
                        });
                        completed++;
                    }
                }
            };
            const outcomes = await Promise.allSettled(
                Array.from({ length: Math.min(concurrency, work.length || 1) }, () => worker()),
            );
            const failures = outcomes
                .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
                .map(({ reason }) => reason);
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(failures, `${failures.length} search derivation workers failed`);
            }
        };
        // Each group stays on one worker: its representative completes the artifact, then every
        // sibling attaches that same immutable result.
        ctx.signal?.throwIfAborted();
        const heartbeat = setInterval(() => {
            if (completed < total) {
                publish("indexing", `Indexing repository search: ${Math.floor((completed / total) * 100)}% (${completed}/${total})`);
            }
        }, progressHeartbeatMs);
        heartbeat.unref();
        try {
            await workerPool([...groups.values()]);
            if (memberFailures.length === 0) {
                publish("complete", "Repository search index is ready");
            } else {
                // {§derivation-member-failure}: the pass completes; the terminal notice names the
                // first failed member and carries the count.
                const [first] = memberFailures;
                const rest = memberFailures.length - 1;
                publish(
                    "complete",
                    `Repository search index is ready; ${memberFailures.length} of ${total} derivations failed: ${JSON.stringify(first!.path)} — ${first!.reason}${rest === 0 ? "" : ` (and ${rest} more)`}`,
                    "warn",
                );
            }
            return { derived: total, acquiredBytes };
        } catch (error) {
            publish("failed", `Search indexing failed: ${error instanceof Error ? error.message : String(error)}`, "error");
            throw error;
        } finally {
            clearInterval(heartbeat);
        }
    }

}

// {§derivation-dedup-parallel} — the identity is a hash over the representation's own SHA-256
// ({§tokenomics-content-hash-identity}), never over its body, so a stored channel identity
// decides dirtiness without the body crossing into the process.
function derivationHash(input: {
    contentHash: string;
    mimetype: string;
    binary: boolean;
    projectionIdentity: string;
    dispositionIdentity: string;
}): string {
    return createHash("sha256")
        .update(input.contentHash)
        .update("\0")
        .update(input.mimetype)
        .update("\0")
        .update(input.binary ? "binary" : "text")
        .update("\0")
        .update(input.projectionIdentity)
        .update("\0")
        .update(input.dispositionIdentity)
        .digest("hex");
}
