// KILL dispatch: entry, channel, and worker termination, split out of Dispatcher.
import type { ParsedPath, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import WorkerControlAddress from "./WorkerControlAddress.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { entryCoordinateOf, renderAddress, schemeNameOf } from "./plurnk-uri.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "./scheme-types.ts";
import { type CancelWorkerNotify } from "./ChannelWrite.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import { InvalidOperationResultError, type SchemeCtx, type SchemeResult } from "@plurnk/plurnk-schemes";
import { type BoundEntryAddress as ResolvedDataEntryAddress, type EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import type { DispatchResult, SchemeWithEntryAddress } from "./Dispatcher.ts";
import type { TextLineMarker } from "@plurnk/plurnk-contracts";
import ChannelWrite from "./ChannelWrite.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";

export default class KillHandler {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #cancelWorker: CancelWorkerNotify | undefined;
    readonly #resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; }) => Promise<PreparedRepresentation>;
    readonly #boundEntryContext: (routedScheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => SchemeCtxImpl | null;
    readonly #handlerContext: (scheme: string, ctx: PlurnkSchemeContext, authority?: string) => Promise<SchemeCtxImpl | null>;
    readonly #deleteEntry: (scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => Promise<DeleteEntryResult>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    readonly #liveSubscriptions: LiveSubscriptions;

    constructor({ db, schemes, liveSubscriptions, cancelWorker, resolveDataEntryAddress, boundEntryContext, handlerContext, deleteEntry, failure }: {
        db: Db;
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        cancelWorker: CancelWorkerNotify | undefined;
        resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; }) => Promise<PreparedRepresentation>;
        boundEntryContext: (routedScheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => SchemeCtxImpl | null;
        handlerContext: (scheme: string, ctx: PlurnkSchemeContext, authority?: string) => Promise<SchemeCtxImpl | null>;
        deleteEntry: (scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => Promise<DeleteEntryResult>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#liveSubscriptions = liveSubscriptions;
        this.#cancelWorker = cancelWorker;
        this.#resolveDataEntryAddress = resolveDataEntryAddress;
        this.#boundEntryContext = boundEntryContext;
        this.#handlerContext = handlerContext;
        this.#deleteEntry = deleteEntry;
        this.#failure = failure;
    }

    // KILL is target-polymorphic. Scheme handlers own the optional numeric code's
    // meaning; core retains worker and entry dispatch. {§operation-code-polymorphism}
    async handleKill(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<DispatchResult> {
        if (statement.op !== "KILL") throw new Error("unreachable");
        const path = statement.target;
        if (path === null) {
            return this.#failure("kill-target-required", 400, "KILL requires a target path.", {}, { retryable: false });
        }
        const schemeName = schemeNameOf(path);
        if (schemeName === null) {
            return this.#failure(
                "kill-target-scheme-required",
                400,
                "KILL target requires a scheme.",
                {},
                { retryable: false },
            );
        }
        const manifest = this.#schemes.manifestFor(schemeName, ctx.functionalityWorkerId);
        const coordinate = entryCoordinateOf(path, manifest?.authority ?? "namespace");
        // log:/// KILL has already gone through the projection-curation owner.
        // This path owns scheme-specific world and process KILL semantics.
        // Process-KILL: any scheme whose handler exposes kill() aborts a live stream — the
        // exec handler, registered as "exec" + under every runtime tag (sh/node), so a tag-
        // addressed stream (sh:///l/t/s) routes here, not to deleteEntry. {§exec}
        const killable = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as { kill?: (pathname: string, scope: TextLineMarker | null, ctx: SchemeCtx, scheme?: string) => Promise<SchemeResult> } | undefined;
        if (killable !== undefined && typeof killable.kill === "function") {
            // Pass the model's OWN scheme so a stream-KILL error answers in the runtime tag the
            // model addressed (sh:///…), not the internal `exec` ({§fs-answer-in-canon}).
            let handlerCtx: SchemeCtxImpl | null;
            if (manifest?.category === "data") {
                const resolved = await this.#resolveDataEntryAddress({
                    target: path,
                    routedScheme: schemeName,
                    handler: killable as SchemeWithEntryAddress,
                    manifest,
                    ctx,
                });
                if (resolved.result !== null) return resolved.result;
                if (resolved.address === null) {
                    return this.#failure(
                        "entry-not-found",
                        404,
                        `No entry exists at ${renderAddress({ scheme: schemeName, ...coordinate })}.`,
                    );
                }
                handlerCtx = this.#boundEntryContext(schemeName, resolved.address, ctx);
            } else {
                handlerCtx = await this.#handlerContext(schemeName, ctx, coordinate.authority);
            }
            if (handlerCtx === null) {
                throw new InvalidOperationResultError(`Registered scheme '${schemeName}' has no dispatch context.`);
            }
            return await killable.kill(coordinate.pathname, statement.lineMarker, handlerCtx, schemeName);
        }
        if (schemeName === "worker") {
            // Entry-path present → KILL a private owner-held entry (delete it), self-only —
            // NOT worker cancellation. The authority (hostname) names the owner, the pathname the
            // entry; only the path-ABSENT form (worker://<name>) terminates the worker-as-actor. {§worker-scheme}
            const entryPath = path.kind === "url" ? (path.pathname ?? "") : "";
            if (entryPath !== "" && entryPath !== "/") {
                const workerHandler = this.#schemes.get("worker") as SchemeWithEntryAddress & { killEntry: (s: PlurnkStatement, c: SchemeCtx) => Promise<SchemeResult> };
                if (manifest?.category !== "data") {
                    throw new InvalidOperationResultError("Registered scheme 'worker' is not entry-bearing.");
                }
                const resolved = await this.#resolveDataEntryAddress({
                    target: path,
                    routedScheme: "worker",
                    handler: workerHandler,
                    manifest,
                    ctx,
                });
                if (resolved.result !== null) return resolved.result;
                if (resolved.address === null) {
                    return this.#failure("entry-not-found", 404, "The worker entry does not exist.");
                }
                const handlerCtx = this.#boundEntryContext("worker", resolved.address, ctx);
                if (handlerCtx === null) {
                    throw new InvalidOperationResultError("Registered scheme 'worker' has no dispatch context.");
                }
                const cancelled = await this.#cancelLiveSubscription("worker", resolved.address, ctx);
                if (cancelled !== null) return cancelled;
                return await workerHandler.killEntry(statement, handlerCtx);
            }
            const address = WorkerControlAddress.resolve(path, "KILL");
            if (!address.ok) return address.result;
            // `~` is the sole current-worker sigil; every other authority is a literal name.
            // An idle worker is a no-op 200; a missing named worker is 404. {§worker-control-addressing}
            const name = address.authority;
            let workerId = ctx.workerId;
            if (name !== "~") {
                const row = await this.#db.worker_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
                if (row === undefined) {
                    return this.#failure(
                        "worker-not-found",
                        404,
                        `Worker '${name}' does not exist in this workspace.`,
                        {},
                        { worker: name, retryable: false },
                    );
                }
                workerId = row.id;
            }
            if (this.#cancelWorker === undefined) throw new Error("worker kill: cancelWorker capability absent");
            // {§op-synchronous} — KILL is decisive. Await the one lifecycle owner so the
            // same-turn pending-work gate observes the complete subtree as terminal.
            await this.#cancelWorker(workerId, "killed via worker:// KILL");
            return { status: 200 };
        }
        if (!this.#schemes.has(schemeName, ctx.functionalityWorkerId)) {
            return this.#failure(
                "scheme-not-found",
                501,
                `Scheme '${schemeName}' is not registered.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        const handler = this.#schemes.get(schemeName, ctx.functionalityWorkerId) as SchemeWithEntryAddress | undefined;
        if (handler === undefined || manifest?.category !== "data") {
            return this.#failure(
                "entry-operation-unsupported",
                400,
                `KILL requires an entry-bearing target; '${schemeName}' does not provide one.`,
                {},
                { scheme: schemeName, retryable: false },
            );
        }
        const resolved = await this.#resolveDataEntryAddress({
            target: path,
            routedScheme: schemeName,
            handler,
            manifest,
            ctx,
        });
        if (resolved.result !== null) return resolved.result;
        if (resolved.address === null) {
            return this.#failure("entry-not-found", 404, "The KILL target does not exist.");
        }
        const cancelled = await this.#cancelLiveSubscription(schemeName, resolved.address, ctx);
        if (cancelled !== null) return cancelled;
        // A host-effecting delete (file) returns 202 to PROPOSE — pass its attrs through so the proposal
        // carries the delete target to review (#isProposal fires on 202). Plurnk-internal deletes execute inline.
        return this.#deleteEntry(schemeName, resolved.address, ctx);
    }

    // {§stream-control} — KILL of an entry with a live subscription cancels the stream through the
    // owning scheme's stored handle and leaves the entry readable; a plain entry is deleted.
    async #cancelLiveSubscription(schemeName: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext): Promise<DispatchResult | null> {
        const entry = await this.#db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: ctx.workspaceId,
            owner_id: address.ownerId,
            scheme: address.scheme,
            authority: address.authority,
            pathname: address.pathname,
        });
        if (entry === undefined) return null;
        const subscription = await ChannelWrite.findActiveSubscription(this.#db, { workerId: ctx.workerId, entryId: entry.id });
        if (subscription === null || subscription.scheme !== schemeName) return null;
        const cancelled = await this.#liveSubscriptions.cancel(subscription.id);
        if (!cancelled) {
            throw new InvalidOperationResultError(`Subscription ${subscription.id} is durable but has no live cancellation handle.`);
        }
        return { status: 200 };
    }

}
