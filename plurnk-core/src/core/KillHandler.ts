// KILL dispatch: entry, channel, and session termination, split out of Dispatcher.
import type { ParsedPath, PlurnkStatement } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import SessionControlAddress from "./SessionControlAddress.ts";
import type SchemeRegistry from "./SchemeRegistry.ts";
import type { DeleteEntryResult } from "../schemes/_entry-crud.ts";
import { entryAddress, entryCoordinateOf, missDetail, missExtensions, schemeNameOf } from "./plurnk-uri.ts";
import { unregisteredSchemeRecovery } from "./unregistered-scheme.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "./scheme-types.ts";
import { type CancelSessionNotify } from "./ChannelWrite.ts";
import SchemeCtxImpl from "./caps/SchemeCtxImpl.ts";
import { InvalidOperationResultError, type SchemeCtx, type SchemeResult } from "@plurnk/plurnk-schemes";
import { type BoundEntryAddress as ResolvedDataEntryAddress, type EntryAddressResolution as PreparedRepresentation } from "./EntryAddressBinding.ts";
import type { DispatchResult, SchemeWithEntryAddress } from "./Dispatcher.ts";
import ResourceBindings from "./ResourceBindings.ts";
import ExecOutputScheme from "../schemes/ExecOutputScheme.ts";
import ChannelWrite from "./ChannelWrite.ts";
import FileAddress from "./FileAddress.ts";
import type LiveSubscriptions from "./LiveSubscriptions.ts";

export default class KillHandler {
    readonly #db: Db;
    readonly #schemes: SchemeRegistry;
    readonly #cancelSession: CancelSessionNotify | undefined;
    readonly #resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; access?: "read" | "write"; }) => Promise<PreparedRepresentation>;
    readonly #boundEntryContext: (routedScheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => SchemeCtxImpl | null;
    readonly #handlerContext: (scheme: string, ctx: PlurnkSchemeContext, authority?: string) => Promise<SchemeCtxImpl | null>;
    readonly #deleteEntry: (scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => Promise<DeleteEntryResult>;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    readonly #liveSubscriptions: LiveSubscriptions;

    // {§session-scheme} The session scheme's entry deletion: its own hook, beside the handler surface.
    static #killsEntries(handler: object | undefined): handler is SchemeWithEntryAddress & { killEntry: (s: PlurnkStatement, c: SchemeCtx) => Promise<SchemeResult> } {
        return handler !== undefined && "killEntry" in handler && typeof handler.killEntry === "function";
    }

    constructor({ db, schemes, liveSubscriptions, cancelSession, resolveDataEntryAddress, boundEntryContext, handlerContext, deleteEntry, failure }: {
        db: Db;
        schemes: SchemeRegistry;
        liveSubscriptions: LiveSubscriptions;
        cancelSession: CancelSessionNotify | undefined;
        resolveDataEntryAddress: (arg0: { target: ParsedPath; routedScheme: string; handler: SchemeWithEntryAddress; manifest: SchemeManifest; ctx: PlurnkSchemeContext; access?: "read" | "write"; }) => Promise<PreparedRepresentation>;
        boundEntryContext: (routedScheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => SchemeCtxImpl | null;
        handlerContext: (scheme: string, ctx: PlurnkSchemeContext, authority?: string) => Promise<SchemeCtxImpl | null>;
        deleteEntry: (scheme: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext) => Promise<DeleteEntryResult>;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#db = db;
        this.#schemes = schemes;
        this.#liveSubscriptions = liveSubscriptions;
        this.#cancelSession = cancelSession;
        this.#resolveDataEntryAddress = resolveDataEntryAddress;
        this.#boundEntryContext = boundEntryContext;
        this.#handlerContext = handlerContext;
        this.#deleteEntry = deleteEntry;
        this.#failure = failure;
    }

    // {§scheme-operation-dispatch} The resource owner receives the complete KILL.
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
        const binding = await ResourceBindings.resolve(path, ctx);
        const manifest = binding?.manifest;
        // {§kill-pattern} — a pattern selects log rows or an entry's lines; both leave before this
        // point. A KILL that still carries one addresses a session, a stream, or a scheme with no
        // lines, and is refused rather than silently widened to its whole target.
        if (statement.matcher !== null) {
            return this.#failure(
                "kill-pattern-unsupported",
                400,
                `A KILL pattern selects log rows or an entry's lines; ${schemeName}:// has neither.`,
                {},
                { retryable: false },
            );
        }
        const coordinate = entryCoordinateOf(path, manifest?.authority ?? "namespace");
        // log:/// KILL has already gone through the projection-curation owner.
        // This path owns scheme-specific resource and process KILL semantics.
        const killable = binding?.handler;
        if (killable !== undefined && typeof killable.kill === "function"
            && (!(killable instanceof ExecOutputScheme) || killable.kills(path))) {
            let handlerCtx: SchemeCtxImpl | null;
            if (manifest?.category === "data") {
                const resolved = await this.#resolveDataEntryAddress({
                    target: path,
                    routedScheme: schemeName,
                    handler: killable,
                    manifest,
                    ctx,
                    access: "write",
                });
                if (resolved.result !== null) return resolved.result;
                if (resolved.address === null) {
                    const target = entryAddress(schemeName, coordinate.authority, coordinate.pathname,
                        schemeName === "file" ? await FileAddress.projectRoot(ctx) : null);
                    return this.#failure("entry-not-found", 404, missDetail(schemeName, target), {}, missExtensions(schemeName, target));
                }
                handlerCtx = new SchemeCtxImpl(ctx, resolved.address.scheme, manifest, this.#liveSubscriptions, {
                    authority: resolved.address.authority,
                });
            } else {
                handlerCtx = await this.#handlerContext(schemeName, ctx, coordinate.authority);
            }
            if (handlerCtx === null) {
                throw new InvalidOperationResultError(`Registered scheme '${schemeName}' has no dispatch context.`);
            }
            return await killable.kill(statement, handlerCtx);
        }
        if (schemeName === "session") {
            // {§session-scheme}: an entry path deletes scratch; a pathless target cancels an actor.
            const entryPath = path.kind === "url" ? (path.pathname ?? "") : "";
            if (entryPath !== "" && entryPath !== "/") {
                const sessionHandler = this.#schemes.get("session");
                if (manifest?.category !== "data") {
                    throw new InvalidOperationResultError("Registered scheme 'session' is not entry-bearing.");
                }
                if (!KillHandler.#killsEntries(sessionHandler)) {
                    throw new InvalidOperationResultError("Registered scheme 'session' has no killEntry hook.");
                }
                const resolved = await this.#resolveDataEntryAddress({
                    target: path,
                    routedScheme: "session",
                    handler: sessionHandler,
                    manifest,
                    ctx,
                    access: "write",
                });
                if (resolved.result !== null) return resolved.result;
                if (resolved.address === null) {
                    return this.#failure("entry-not-found", 404, "The session entry does not exist.");
                }
                const handlerCtx = this.#boundEntryContext("session", resolved.address, ctx);
                if (handlerCtx === null) {
                    throw new InvalidOperationResultError("Registered scheme 'session' has no dispatch context.");
                }
                const cancelled = await this.#cancelLiveSubscription("session", resolved.address, ctx);
                if (cancelled !== null) return cancelled;
                return await sessionHandler.killEntry(statement, handlerCtx);
            }
            const address = SessionControlAddress.resolve(path, "KILL");
            if (!address.ok) return address.result;
            // An idle session is a no-op 200; a missing named session is 404. {§session-control-addressing}
            const name = address.authority;
                const row = await this.#db.session_resolve_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name });
                if (row === undefined) {
                    return this.#failure(
                        "session-not-found",
                        404,
                        `Session '${name}' does not exist in this workspace.`,
                        {},
                        { session: name, retryable: false },
                    );
                }
            const sessionId = row.id;
            if (this.#cancelSession === undefined) throw new Error("session kill: cancelSession capability absent");
            // {§op-synchronous} — KILL is decisive. Await the one lifecycle owner so the
            // same-turn pending-work gate observes the complete subtree as terminal.
            await this.#cancelSession(sessionId, "killed via session:// KILL");
            return { status: 200 };
        }
        if (binding === undefined) {
            return this.#failure(
                "scheme-not-found",
                501,
                `Scheme '${schemeName}' is not registered.`,
                {},
                {
                    scheme: schemeName,
                    recovery: unregisteredSchemeRecovery(this.#schemes.list(ctx.workspaceId)),
                    retryable: false,
                },
            );
        }
        const handler = binding?.handler as SchemeWithEntryAddress | undefined;
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
            access: "write",
        });
        if (resolved.result !== null) return resolved.result;
        if (resolved.address === null) {
            return this.#failure("entry-not-found", 404, "The KILL target does not exist.");
        }
        const cancelled = await this.#cancelLiveSubscription(schemeName, resolved.address, ctx);
        if (cancelled !== null) return cancelled;
        if (KillHandler.#killsEntries(handler)) {
            const handlerCtx = this.#boundEntryContext(schemeName, resolved.address, ctx);
            if (handlerCtx === null) {
                throw new InvalidOperationResultError(`Registered scheme '${schemeName}' has no dispatch context.`);
            }
            return await handler.killEntry(statement, handlerCtx);
        }
        // A host-effecting delete (file) returns 202 to PROPOSE — pass its attrs through so the proposal
        // carries the delete target to review (#isProposal fires on 202). Plurnk-internal deletes execute inline.
        return this.#deleteEntry(schemeName, resolved.address, ctx);
    }

    // {§stream-control} — KILL of an entry with a live subscription cancels the stream through the
    // owning scheme's stored handle and leaves the entry readable; a plain entry is deleted.
    async #cancelLiveSubscription(schemeName: string, address: ResolvedDataEntryAddress, ctx: PlurnkSchemeContext): Promise<DispatchResult | null> {
        const entry = await this.#db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: ctx.workspaceId,
            scheme: address.scheme,
            authority: address.authority,
            pathname: address.pathname,
        });
        if (entry === undefined) return null;
        const subscription = await ChannelWrite.findActiveSubscription(this.#db, { entryId: entry.id });
        if (subscription === null || subscription.scheme !== schemeName) return null;
        if (ctx.writer === "model") this.#liveSubscriptions.asked(subscription.id, ctx.sessionId);
        const cancelled = await this.#liveSubscriptions.cancel(subscription.id);
        if (!cancelled) {
            throw new InvalidOperationResultError(`Subscription ${subscription.id} is durable but has no live cancellation handle.`);
        }
        return { status: 200 };
    }

}
