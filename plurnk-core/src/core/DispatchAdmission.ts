import { TurnDisposition, isExecution, type CapabilityProjection, type ForkStatement, type ParsedPath, type PlurnkOp, type PlurnkStatement, type WorkStatement } from "@plurnk/plurnk-contracts";
import type { SchemeResult } from "@plurnk/plurnk-schemes";
import type SchemeRegistry from "./SchemeRegistry.ts";
import ExecOutputScheme from "../schemes/ExecOutputScheme.ts";
import CapabilityResolver from "./CapabilityResolver.ts";
import ResourceBindings from "./ResourceBindings.ts";
import Results from "./results.ts";
import { schemeNameOf } from "./plurnk-uri.ts";
import type { PlurnkSchemeContext, WriterTier } from "./scheme-types.ts";
import type { DispatchResult } from "./Dispatcher.ts";

// SPEC {§scheme-surface}: writer must be in target scheme's manifest.writableBy.
// READ/FIND are not gated — they read, never mutating an entry.
const MUTATING_OPS: ReadonlySet<PlurnkOp> = new Set(["EDIT", "SEND", "COPY", "MOVE", "KILL", "FORK", "WORK"]);

export default class DispatchAdmission {
    // {§matcher-prefix-claims} — a matcher the parser could not read refuses its one operation with the parser's
    // diagnostic and working form: the operation's own row, soft on the rail, never a contract strike.
    static unreadableMatcher(statement: PlurnkStatement): DispatchResult | null {
        const matchers = statement.op === "COPY" || statement.op === "MOVE"
            ? [statement.source.matcher, statement.destination.matcher]
            : ["matcher" in statement ? statement.matcher : null];
        const unreadable = matchers.find((matcher) => matcher !== null && matcher !== undefined && matcher.dialect === "unreadable");
        if (unreadable === undefined || unreadable === null || unreadable.dialect !== "unreadable") return null;
        return Results.failure("grammar:matcher", "unreadable-pattern", 400, unreadable.message, {},
            { stage: "matcher", recovery: unreadable.recovery, retryable: false });
    }

    readonly #schemes: SchemeRegistry;
    readonly #capabilities: CapabilityResolver;
    readonly #failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;

    constructor({
        schemes,
        capabilities,
        failure,
    }: {
        schemes: SchemeRegistry;
        capabilities: CapabilityResolver;
        failure: (code: string, status: number, detail: string, fields?: Readonly<Record<string, unknown>>, extensions?: Readonly<Record<string, unknown>>) => DispatchResult;
    }) {
        this.#schemes = schemes;
        this.#capabilities = capabilities;
        this.#failure = failure;
    }

    // SPEC {§scheme-surface}: engine rejects writes whose origin is outside the target
    // scheme's manifest.writableBy.
    // - Read-side ops (READ and FIND) are not gated.
    // - SEND broadcast (path=null) has no target scheme; not gated.
    // - COPY: dst scheme writableBy applies.
    // - MOVE: both src (delete) and dst (write) schemes' writableBy apply.
    checkWritable(statement: PlurnkStatement, origin: WriterTier, workspaceId: number): DispatchResult | null {
        if (!isExecution(statement) && !MUTATING_OPS.has(statement.op)) return null;
        if (TurnDisposition.is(statement) || statement.op === "SEND" && statement.target === null) return null;

        // An execution's operation authority always belongs to the exec scheme;
        // runtime-specific resource authority is gated separately below.
        if (isExecution(statement)) {
            return this.#denyIfDisallowed("exec", origin, workspaceId);
        }

        // {§stream-control}: process control and facet-claimed SEND are not writes to
        // stored output. The workspace execution binding owns KILL and SEND.
        if (statement.op === "KILL" || statement.op === "SEND") {
            const target = schemeNameOf(statement.target);
            if (target !== null && this.#schemes.isRuntimeScheme(target, workspaceId)) {
                const handler = this.#schemes.get(target, workspaceId);
                if (statement.op === "SEND" || !(handler instanceof ExecOutputScheme) || handler.kills(statement.target)) {
                    return null;
                }
            }
        }

        // Session control (FORK/WORK → session://<name>, spawn or fork) is gated by session://'s writableBy — its
        // body is a seed prompt, not a dst path, so the entry-COPY dst-parse below doesn't apply.
        // {§machine-processes}
        if (this.#isSessionControl(statement)) return this.#denyIfDisallowed("session", origin, workspaceId, statement.target);

        if (statement.op === "COPY" || statement.op === "MOVE") {
            const dst = statement.destination.target;
            const dstScheme = schemeNameOf(dst);
            const dstDenial = this.#denyIfDisallowed(dstScheme, origin, workspaceId, dst);
            if (dstDenial !== null) return dstDenial;
            if (statement.op === "MOVE") {
                const srcScheme = schemeNameOf(statement.source.target);
                if (srcScheme !== dstScheme) {
                    const srcDenial = this.#denyIfDisallowed(srcScheme, origin, workspaceId, statement.source.target);
                    if (srcDenial !== null) return srcDenial;
                }
            }
            return null;
        }

        const target = schemeNameOf(statement.target);
        const denial = this.#denyIfDisallowed(target, origin, workspaceId, statement.target);
        // {§send} — SEND addresses recipients, not otherwise
        // read-only resources. State that boundary without guessing whether the
        // model intended a reply, deletion, or directed message.
        if (denial !== null && statement.op === "SEND" && origin === "model") {
            return this.#failure(
                "send-target-not-a-recipient",
                400,
                "The addressed scheme is not a SEND recipient.",
                {},
                {
                    target: statement.target?.raw ?? String(target),
                    stage: "dispatch",
                    recovery: "Name a message address or a recipient that implements SEND.",
                    retryable: false,
                },
            );
        }
        return denial;
    }

    // {§execution-output-identity} The manifest that governs the coordinate decides: a runtime
    // scheme's facet may make its claimed resources writable where the stored output is not.
    #denyIfDisallowed(schemeName: string | null, origin: WriterTier, workspaceId: number, target: ParsedPath | null = null): DispatchResult | null {
        if (schemeName === null) return null;
        const handler = this.#schemes.get(schemeName, workspaceId);
        if (handler === undefined) return null;
        const manifest = this.#schemes.manifestAt(schemeName, target, workspaceId);
        if (manifest === undefined) throw new Error(`registered scheme '${schemeName}' has no manifest`);
        if (manifest.writableBy.includes(origin)) return null;
        return this.#failure(
            "writer-forbidden",
            403,
            `Writer '${origin}' cannot modify scheme '${schemeName}'.`,
            {},
            {
                writer: origin,
                scheme: schemeName,
                allowedWriters: [...manifest.writableBy],
                retryable: false,
            },
        ); // {§scheme-surface}
    }

    // {§capability-admission} — one resolver gates every operation route before
    // execution or proposal handling. Unknown routes continue to their ordinary
    // owner; a known policy denial is one factual, non-presumptuous 403.
    async checkCapabilities(
        statement: PlurnkStatement,
        ctx: PlurnkSchemeContext,
    ): Promise<DispatchResult | null> {
        const denied = await this.#capabilities.denial(
            statement,
            ctx.workspaceId,
            ctx.writer,
            async (target) => (await ResourceBindings.resolve(target, ctx))?.manifest,
            ctx.sessionId,
        );
        if (denied === null) return null;
        const { descriptor, scope } = denied;
        const route = [
            descriptor.operation,
            descriptor.scheme,
            descriptor.runtime,
            descriptor.tool,
        ].filter((part) => part !== undefined).join("/");
        return this.#failure(
            "capability-denied",
            403,
            `Capability '${route}' is denied by ${scope} policy.`,
            {},
            {
                ...descriptor,
                policyScope: scope,
                // {§question-tool} Every other ring is operator configuration and speaks for itself.
                ...(scope === "owner" ? { recovery: CapabilityResolver.UNATTENDED_RECOVERY } : {}),
                retryable: false,
            },
        );
    }

    capabilityDenial(statement: PlurnkStatement, ctx: PlurnkSchemeContext): Promise<SchemeResult | null> {
        return ResourceBindings.using(this.#schemes, ctx,
            (boundCtx) => this.checkCapabilities(statement, boundCtx));
    }

    referenceVisibility(ctx: PlurnkSchemeContext): Promise<(pathname: string) => boolean> {
        return this.#capabilities.referenceVisibility(ctx.workspaceId, ctx.sessionId);
    }

    capabilityProjection(workspaceId: number): Promise<CapabilityProjection> {
        return this.#capabilities.projection(workspaceId);
    }

    // Session control is FORK/WORK (grammar 0.74.55), not COPY — its body
    // is the new session's seed prompt, not a destination path. The COPY gates and ResourceMutations.handleCopy
    // branch on this so they never parse the prompt as a dst path.
    #isSessionControl(statement: PlurnkStatement): statement is ForkStatement | WorkStatement {
        return statement.op === "FORK" || statement.op === "WORK"; // session control targets session://<name> (grammar 0.74.55)
    }
}
