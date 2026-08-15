import { parsePath, TagSignal } from "@plurnk/plurnk-contracts";
import type { ExecStatement, FindStatement, ParsedPath, ReadStatement } from "@plurnk/plurnk-contracts";
import { Policy, type ChannelState } from "@plurnk/plurnk-execs";
import type { ExecResult as ExecutorResult } from "@plurnk/plurnk-execs";
import {
    WebFetcher,
    WebMaterializationError,
    type WebFetchResult,
    type WebMaterializedResult,
} from "@plurnk/plurnk-schemes-http";
import type { Executor } from "../core/ExecutorRegistry.ts";
import WorkspaceSettings from "../core/workspace-settings.ts";
import EffectPolicy from "./EffectPolicy.ts";
import type { Effect } from "@plurnk/plurnk-execs";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryCrud from "./_entry-crud.ts";
import Owner from "../core/Owner.ts";
import EntryFind from "./_entry-find.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import ChannelWrite, { type StreamCoordinate } from "../core/ChannelWrite.ts";
import ExecEnv from "./exec-env.ts";
import ExecAbort from "./exec-abort.ts";
import { entryPathnameOf, renderAddress } from "../core/plurnk-uri.ts";
import { writeFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreEntryAddress, CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import Results, { OperationFailureError, type SchemeResult, type SchemeResultBase } from "../core/results.ts";
import { InvalidOperationResultError, NetworkAddress } from "@plurnk/plurnk-schemes";
import DbProjectionCaps from "../core/caps/DbProjectionCaps.ts";
import WorkerControlAddress from "../core/WorkerControlAddress.ts";
import JournalTurn from "../core/JournalTurn.ts";
import LogEntryProjection from "../core/LogEntryProjection.ts";
import { setTimeout as delay } from "node:timers/promises";

type ExecResult = SchemeResultBase & { body?: string; attrs?: object };

interface ExecAttrs {
    runtime: string;        // "" (default shell), "sh", "bash", "node", "python", etc.
    cwd: string | null;     // selected project working directory, or null when the workspace has none ({§executor-sinks})
    target: string | null;  // consumer-routed EXEC target; each executor owns its mapping ({§executor-sinks})
    body: string;           // body of the EXEC op
    pathname: string;       // stamped by Dispatcher.#writeLog as /<loop>/<turn>/<seq>; output persists under the runtime tag, e.g. sh:///1/1/2 ({§executor-output-address}).
    effect: Effect;         // one admission fact, preserved through apply and stream/hold bookkeeping
    resourceSource?: string; // complete authored non-file resource address, resolved through ordinary READ at apply time
    timeoutSec?: number;    // `<T,P>` mark[0] > 0: kill the spawn after T seconds (504). Absent/-1 = unbounded.
    turnScoped?: boolean;   // `<0>`: turn-scoped — reaped at the worker's next pre-turn, never surviving into the subsequent turn. {§exec-poll}
    pollSec?: number;       // `<T,P>` mark[1]: absent = default backoff; 0 = disabled; positive = fixed cadence. {§exec-poll}
}

// Executors are discovered + probed at boot into ExecutorRegistry and reach
// the scheme through ctx.executors ({§exec-registry-resolves}). Each runtime tag
// resolves to its sibling executor; the scheme itself stays runtime-agnostic.

// Extract the local arm of {§exec-target-routing}; non-file schemes are
// classified separately by resourceSourceOf.
const localPathFromTarget = (target: ExecStatement["target"]): string | null => {
    if (target === null) return null;
    if (target.kind === "local") return target.raw;
    if (target.kind === "url" && (target.scheme === null || target.scheme === "file")) {
        return target.pathname;
    }
    return null;
};

// A non-file scheme target is distinct from the local path handled above. The
// consumer resolves its content at apply time; executors stay scheme-blind
// ({§executor-role}).
const resourceSourceOf = (target: ExecStatement["target"]): string | null => {
    if (target === null || target.kind !== "url") return null;
    if (target.scheme === null || target.scheme === "file") return null;
    return target.raw;
};

// EXEC's pathname is <runtime>/<loop_seq>/<turn_seq>/<sequence> (stamped by
// Dispatcher.#writeLog). Exec owns this convention, so it — not the client — turns
// the pathname into the entry's coordinate, mirrored onto stream payloads so
// clients read fields instead of parsing the URI. The
// coordinate is the trailing three segments (runtime-agnostic); a pathname that
// isn't a numeric triple yields undefined (no coordinate on the wire).
// {§notifications-stream-event-on-channel-change}, {§notifications-stream-concluded}
const coordinateFromPathname = (pathname: string): StreamCoordinate | undefined => {
    const seg = pathname.split("/").filter(Boolean);
    if (seg.length < 3) return undefined;
    const [loop_seq, turn_seq, sequence] = seg.slice(-3).map(Number);
    if (![loop_seq, turn_seq, sequence].every(Number.isInteger)) return undefined;
    return { loop_seq, turn_seq, sequence };
};

// {§stream-owner-scoped} — resolve a stream statement's authority to the owning worker and hand
// back the statement authority-stripped (the storage path is the bare loop coordinate; the owner
// rides the owner_id column, never the pathname). Empty authority = the CALLING worker — your own
// streams need no qualifier, so a fan-out sibling's identical coordinate can never be yours
// ({§stream-owner-scoped}).
// A named authority = that worker's streams, ancestry-gated (reader must be the owner or an
// ancestor); an unknown name or unpermitted reader resolves null → the face 404s, no existence leak.
export const resolveStreamStatement = async <S extends { target: ReadStatement["target"] }>(
    statement: S,
    ctx: PlurnkSchemeContext,
): Promise<{ statement: S; ownerId: number } | null> => {
    const t = statement.target;
    const hostname = t !== null && t.kind === "url" ? t.hostname : null;
    const ownerId = await Owner.resolveStreamOwner(hostname, ctx);
    if (ownerId === null) return null;
    if (hostname === null || t === null || t.kind !== "url") return { statement, ownerId };
    return { statement: { ...statement, target: { ...t, hostname: null } }, ownerId };
};

// {§exec-entry-sink}: the web-fetch the sink calls when the executor hands content:null:
// schemes-http's WebFetcher (checked byte acquisition, dead-as-null; caller
// cancellation rejects per {§prefetch}).
// Injectable because automatic acquisition refuses localhost.
export type WebFetch = (url: string, opts?: { signal?: AbortSignal }) => Promise<WebFetchResult | null>;

export default class Exec extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "exec",
        channels: { stdout: "text/stream", stderr: "text/stream" },
        defaultChannel: "stdout",
        category: "data",
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
        documentation: "Runs a registered executable tool — `## EXEC0 [executor] (target) <timeout,poll>\nbody` — using the tool's table-declared target and body contract. Output streams into the worker's `<executor>:///<loop>/<turn>/<seq>` entry on that tool's own channels. A host-effecting invocation proposes for review before it runs; a read-only or pure one runs ungated. Either way you never fetch the output: the engine surfaces each turn's new stream bytes automatically — folded while it runs, opened when it finishes.",
        flags: {
            excludedInAsk: true,
        },
    };

    // The web-fetch the entry sink calls on content:null ({§exec-entry-sink}).
    // Default = schemes-http's checked WebFetcher; injectable for tests.
    readonly #fetchWeb: WebFetch;
    constructor(fetchWeb?: WebFetch) {
        super();
        if (fetchWeb === undefined) {
            const webFetcher = new WebFetcher();
            this.#fetchWeb = (url, opts) => webFetcher.fetch(url, opts);
        } else {
            this.#fetchWeb = fetchWeb;
        }
    }

    #activeAborts = new Map<number, { workerId: number; turnId: number; pathname: string; runtime: string; effect: Effect; controller: AbortController; unlink: () => void }>();
    #activeSpawns = new Map<number, Promise<SchemeResult>>();

    async idle(): Promise<void> {
        await Promise.allSettled([...this.#activeSpawns.values()]);
    }

    // {§handler-lifecycle} — idle is the streaming drain barrier.
    async close(): Promise<void> {
        await this.idle();
    }

    // Whether the worker has an in-flight spawn (a background exec). The daemon
    // reads this only for loop.cancel's cancelled=true/false answer — the
    // teardown itself rides the worker's cancellation scope (the spawn's
    // ctx.signal), so even a spawn registering after the cancel self-aborts.
    hasActiveSpawns(workerId: number): boolean {
        for (const { workerId: r } of this.#activeAborts.values()) if (r === workerId) return true;
        return false;
    }

    // {§worker-optimistic-settlement} — wait on exactly the spawns initiated by
    // this turn, ending immediately when all settle and never extending the
    // opportunity to streams inherited from an earlier turn.
    async settleTurnSpawns(
        workerId: number,
        turnId: number,
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<boolean> {
        signal?.throwIfAborted();
        const pending = [...this.#activeAborts.entries()]
            .filter(([, active]) => active.workerId === workerId && active.turnId === turnId)
            .map(([subscriptionId]) => {
                const spawn = this.#activeSpawns.get(subscriptionId);
                if (spawn === undefined) {
                    throw new Error(`Active EXEC subscription ${subscriptionId} has no spawn settlement promise.`);
                }
                return spawn;
            });
        if (pending.length === 0) return true;
        if (timeoutMs === 0) return false;
        return await Promise.race([
            Promise.allSettled(pending).then(() => true),
            delay(timeoutMs, false, { signal, ref: false }),
        ]);
    }

    // {§exec-hold-until-concluded} — match active spawns against the
    // operator's runtime or runtime:effect hold selectors.
    hasActiveHoldSpawns(workerId: number, holdSet: ReadonlySet<string>): boolean {
        for (const { workerId: r, runtime, effect } of this.#activeAborts.values()) if (r === workerId && (holdSet.has(runtime) || holdSet.has(`${runtime}:${effect}`))) return true;
        return false;
    }

    // {§stream-control} — active KILL routes through the live controller;
    // terminal and missing outcomes resolve from the durable subscription.
    async kill(pathname: string, signal: number | null, ctx: CoreSchemeCallContext, scheme = "exec"): Promise<SchemeResultBase> {
        const core = this.coreContext(ctx);
        for (const entry of this.#activeAborts.values()) {
            if (entry.workerId === core.workerId && entry.pathname === pathname) {
                entry.controller.abort(ExecAbort.killReason(signal));
                return { status: 200 };
            }
        }
        // Not running — settle the outcome from the closed subscription's status, scoped to the
        // caller's own subscription (coordinates duplicate across workers, {§stream-owner-scoped}).
        // The error answers in the model's OWN runtime-tag address (sh:///…), never the retired
        // internal `exec` machinery ({§fs-answer-in-canon}) — the model KILLs what it addressed.
        const terminal = await ChannelWrite.execTerminalStatus(core.db, {
            workspaceId: core.workspaceId,
            workerId: core.workerId,
            scheme,
            pathname,
        });
        const target = renderAddress(scheme, pathname);
        if (terminal === null) {
            return Results.failure(
                "scheme:exec",
                "stream-not-found",
                404,
                `No stream exists at ${target}.`,
                {},
                { target },
            );
        }
        if (terminal === 499) {
            return Results.failure(
                "scheme:exec",
                "stream-already-killed",
                410,
                `Stream ${target} was already killed.`,
                {},
                {
                    target,
                    retryable: false,
                },
            );
        }
        return Results.failure(
            "scheme:exec",
            "stream-already-terminal",
            409,
            `${target} already concluded with status ${terminal}.`,
            {},
            {
                target,
                terminalStatus: terminal,
                retryable: false,
            },
        );
    }

    // EXEC op handler — the actual model-facing entry point per plurnk.md.
    // `## EXEC0 [runtime] (target)\nbody` → runtime-owned invocation buckets.
    //
    // Proposes (status=202) with attrs={runtime, cwd, body, pathname}.
    // applyResolution spawns the subprocess; output streams into the
    // coordinate-stamped <runtime>:///<pathname> entry's stdout/stderr channels
    // (e.g. sh:///1/1/2, {§exec}). The model READs that entry on a subsequent turn.
    async exec(statement: ExecStatement, ctx: CoreSchemeCallContext): Promise<ExecResult> {
        const core = this.coreContext(ctx);
        const body = statement.body ?? "";
        const requested = typeof statement.signal === "string" ? statement.signal : "";
        const runtime = requested === "" ? "sh" : requested; // empty signal = default shell
        if (core.executors === undefined) throw new Error("exec dispatched without an executor registry");
        const workspaceExecs = (await WorkspaceSettings.read(core.db, core.workspaceId)).execs;
        // {§exec-registry-resolves} — a non-empty tag selects exactly one registered executable
        // tool. Unknown tags are not reinterpreted as shell command words: that would make the
        // executed command differ from the authored body. Bare EXEC remains the default-shell form.
        const resolved = core.executors.entry(runtime);
        if (resolved === undefined) {
            const available = core.executors.availableRuntimes()
                .filter((tag) => workspaceExecs === null || Policy.isEnabled(tag, workspaceExecs));
            return Results.failure(
                "scheme:exec",
                "runtime-not-registered",
                501,
                `Executable tool '${runtime}' is not registered in this workspace.`,
                {},
                {
                    requestedRuntime: runtime,
                    availableRuntimes: available,
                    ...(available.length > 0
                        ? {
                            recovery: available.includes("sh")
                                ? `Use bare EXEC for a shell command or select a registered executable tool: ${available.join(", ")}.`
                                : `Select a registered executable tool: ${available.join(", ")}.`,
                        }
                        : {}),
                    retryable: false,
                },
            ) as ExecResult;
        }
        // {§operator-config-workspace-execs} — the workspace layer only narrows
        // the registered set. Bare EXEC resolves to sh before the same gate.
        if (workspaceExecs !== null && !Policy.isEnabled(runtime, workspaceExecs)) {
            const available = core.executors.availableRuntimes()
                .filter((tag) => Policy.isEnabled(tag, workspaceExecs));
            return Results.failure(
                "scheme:exec",
                "runtime-disabled",
                501,
                `Executable tool '${runtime}' is disabled by workspace policy.`,
                {},
                {
                    requestedRuntime: runtime,
                    availableRuntimes: available,
                    recovery: available.length > 0
                        ? `Use an enabled executable tool: ${available.join(", ")}.`
                        : "Continue without executing a tool in this workspace.",
                    retryable: false,
                },
            ) as ExecResult;
        }
        if (!resolved.available) {
            const why = resolved.detail === undefined ? "" : `: ${ErrorDetail.preview(resolved.detail)}`;
            return Results.failure(
                "scheme:exec",
                "runtime-unavailable",
                501,
                `Executable tool '${runtime}' is unavailable${why}.`,
                {},
                {
                    requestedRuntime: runtime,
                    retryable: false,
                },
            ) as ExecResult;
        }

        const invocation = resolved.invocation;
        const hasBody = body.length > 0;
        const hasTarget = statement.target !== null;
        const refuse = (
            code: string,
            detail: string,
            recovery: string,
            extensions: Readonly<Record<string, unknown>> = {},
        ): ExecResult => Results.failure(
            "scheme:exec",
            code,
            400,
            detail,
            {},
            { runtime, recovery, retryable: false, ...extensions },
        ) as ExecResult;

        if (invocation.body.required && !hasBody) {
            return refuse(
                "body-required",
                `Executable tool '${runtime}' requires a ${invocation.body.role} body.`,
                `Provide the ${invocation.body.role} in the EXEC body.`,
            );
        }
        if (invocation.target === undefined && hasTarget) {
            return refuse(
                "target-not-supported",
                `Executable tool '${runtime}' does not accept a target.`,
                `Remove the target and provide the ${invocation.body.role} in the body.`,
            );
        }
        if (invocation.target?.required === true && !hasTarget) {
            return refuse(
                "target-required",
                `Executable tool '${runtime}' requires a ${invocation.target.role} target.`,
                `Provide the ${invocation.target.role} in (target).`,
            );
        }
        if (!hasBody && !hasTarget) {
            return refuse(
                "input-required",
                `Executable tool '${runtime}' requires a body or target.`,
                `Provide ${invocation.target === undefined ? "a body" : "a body or target"}.`,
            );
        }
        if (invocation.exclusive === true && hasBody && hasTarget) {
            return refuse(
                "input-conflict",
                `Executable tool '${runtime}' accepts its ${invocation.body.role} body and ${invocation.target?.role ?? "target"} target only as alternatives.`,
                "Provide either the body or target, not both.",
            );
        }

        const workspaceRow = await core.db.envelope_get_workspace.get<{ project_root: string | null }>({ id: core.workspaceId });
        const projectRoot = workspaceRow?.project_root ?? null;
        let cwd: string | null = projectRoot;
        let target: string | null = null;
        let resourceSource: string | null = null;
        const targetDecl = invocation.target;
        if (statement.target !== null && targetDecl !== undefined) {
            if (targetDecl.kind === "literal") {
                target = statement.target.raw;
            } else {
                const localTarget = localPathFromTarget(statement.target);
                if (localTarget !== null) {
                    target = localTarget;
                } else if (targetDecl.kind === "resource") {
                    resourceSource = resourceSourceOf(statement.target);
                    if (resourceSource === null) {
                        throw new Error(`EXEC '${runtime}' resource target could not be classified`);
                    }
                } else {
                    return refuse(
                        "target-kind-invalid",
                        `Executable tool '${runtime}' accepts only a local or file:// ${targetDecl.role} target.`,
                        `Use a local or file:// ${targetDecl.role} target.`,
                        { target: statement.target.raw, targetKind: targetDecl.kind },
                    );
                }
            }
        }

        if (target !== null && targetDecl?.directory === "cwd") {
            const inspected = isAbsolute(target)
                ? target
                : projectRoot === null ? null : resolve(projectRoot, target);
            if (inspected !== null) {
                try {
                    if ((await stat(inspected)).isDirectory()) {
                        cwd = inspected;
                        target = null;
                    }
                } catch (cause) {
                    if ((cause as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
                        console.error(`EXEC target classification failed for '${inspected}':`, cause);
                        return Results.failure(
                            "scheme:exec",
                            "target-classification-failed",
                            500,
                            `EXEC target '${target}' could not be inspected: ${ErrorDetail.preview(cause)}`,
                            {},
                            { target, stage: "target-classification" },
                        ) as ExecResult;
                    }
                }
            }
        }
        if (!hasBody && target === null && resourceSource === null) {
            return refuse(
                "input-required",
                `Executable tool '${runtime}' has no executable body or realized target.`,
                `Provide a ${invocation.body.role} body or a non-directory target.`,
            );
        }

        // One logical target derives one effect fact before policy consumes it.
        // A non-file resource keeps its exact authored address until materialization.
        const effectTarget = resourceSource ?? target;
        const effect = resolved.executor.effect(effectTarget);
        // cwd is the workspace project_root unless target routing selected a
        // directory override. {§exec-target-routing}, {§executor-sinks}
        // Pathname is assigned by Dispatcher.#writeLog as <runtime>/<loop_seq>/
        // <turn_seq>/<sequence> (executor-domain + coordinate, e.g. sh/1/1/2).
        // `pathname` is stamped into attrs at log-write time; applyResolution
        // reads it back here.
        // EXEC repurposes the `<L>` slot as `<timeout, poll>` (seconds): mark[0] caps the spawn's
        // lifetime, mark[1] sets the hibernation poll-wake cadence ({§exec-poll}). N>0 → deadline (504);
        // -1 / absent → unbounded (loop-life bounded); 0 → turn-scoped (reaped at the next pre-turn,
        // never surviving into the subsequent turn).
        const marks = statement.lineMarker?.marks;
        const timeoutSec = typeof marks?.[0] === "number" && marks[0] > 0 ? Math.floor(marks[0]) : undefined;
        const turnScoped = typeof marks?.[0] === "number" && marks[0] === 0;
        const pollSec = typeof marks?.[1] === "number" && marks[1] >= 0 ? Math.floor(marks[1]) : undefined;
        const attrs: ExecAttrs = {
            runtime, cwd, body, target, pathname: "", effect,
            ...(resourceSource !== null ? { resourceSource } : {}),
            ...(timeoutSec !== undefined ? { timeoutSec } : {}),
            ...(turnScoped ? { turnScoped: true } : {}),
            ...(pollSec !== undefined ? { pollSec } : {}),
        };
        const previewInput = body !== "" ? body : statement.target?.raw ?? "";
        const preview = runtime !== "" ? `[${runtime}] ${previewInput}` : `$ ${previewInput}`;
        return { status: 202, body: preview, attrs };  // host runtime proposes with 202 — {§exec-host-proposes}
    }

    async applyResolution(
        args: { attrs: object; body?: string },
        ctx: CoreSchemeCallContext,
    ): Promise<SchemeResultBase & { outcome?: string; body?: string }> {
        const core = this.coreContext(ctx);
        const attrs = args.attrs as Partial<ExecAttrs>;
        const body = typeof attrs.body === "string" ? attrs.body : "";
        const pathname = attrs.pathname;
        const runtime = (typeof attrs.runtime === "string" && attrs.runtime !== "") ? attrs.runtime : "sh";
        const cwd = (typeof attrs.cwd === "string" && attrs.cwd.length > 0) ? attrs.cwd : null;
        let target = (typeof attrs.target === "string" && attrs.target.length > 0) ? attrs.target : null;
        const effect = attrs.effect;
        if (typeof pathname !== "string" || pathname.length === 0) {
            throw new InvalidOperationResultError("The accepted EXEC proposal is missing its stream pathname.");
        }
        if (!EffectPolicy.isEffect(effect)) {
            throw new InvalidOperationResultError("The accepted EXEC proposal is missing its canonical effect fact.");
        }

        // Every non-file resource becomes a temporary executor target after
        // acceptance; body presence never changes the target's role.
        let tempPath: string | null = null;
        if (attrs.resourceSource !== undefined) {
            const sourceTarget = parsePath(attrs.resourceSource);
            if (sourceTarget?.kind !== "url" || sourceTarget.scheme === null || sourceTarget.scheme === "file") {
                throw new InvalidOperationResultError("The accepted EXEC proposal has an invalid scheme source address.");
            }
            const read = await this.readExecSource({
                op: "READ",
                suffix: "",
                signal: null,
                target: sourceTarget,
                lineMarker: { marks: [1, -1] },
                body: null,
                position: { line: 0, column: 0 },
            }, core);
            if (read.status >= 400) {
                return Results.assert({ ...read, outcome: "scheme_source_read_failed" });
            }
            const content = (read as { content?: unknown }).content;
            if (typeof content !== "string") {
                return Results.failure(
                    "scheme:exec",
                    "source-content-unavailable",
                    422,
                    `Scheme '${sourceTarget.scheme}' did not supply content for the EXEC source.`,
                    { outcome: "scheme_source_content_unavailable" },
                    {
                        scheme: sourceTarget.scheme,
                        sourceStatus: read.status,
                        retryable: false,
                    },
                );
            }
            tempPath = join(tmpdir(), `plurnk-exec-${core.workspaceId}-${pathname.replace(/[^a-zA-Z0-9]/g, "-")}`);
            await writeFile(tempPath, content, "utf8");
            target = tempPath;
        }
        if (body.length === 0 && target === null) {
            throw new InvalidOperationResultError("The accepted EXEC proposal has neither a body nor a realized target.");
        }

        // Resolve the runtime's executor from the boot registry, then seed
        // channels from its declared topology ({§executor-channels}). Each executor declares its own
        // shape (subprocess → stdout/stderr; search → results; etc.).
        if (core.executors === undefined) {
            throw new InvalidOperationResultError("An accepted EXEC proposal has no executor registry.");
        }
        const resolved = core.executors.entry(runtime);
        if (resolved === undefined) {
            throw new InvalidOperationResultError(`The '${runtime}' executor disappeared after its EXEC proposal.`);
        }
        // {§executor-effect}, {§exec-hold-until-concluded}, #107: the admitted
        // effect fact rides the hold predicate unchanged through application.
        const seedChannels: EntryData["channels"] = {};
        for (const [name, decl] of Object.entries(resolved.executor.channels)) {
            seedChannels[name] = {
                content: "",
                mimetype: decl.mimetype,
                state: decl.defaultState ?? "active",
            };
        }
        const seed: EntryData = { channels: seedChannels };
        // {§exec} — the stream entry's scheme IS the runtime tag (sh/node), so it addresses by
        // tag authority (sh:///l/t/s). The engine registers each runtime tag → this handler.
        const { entryId } = await EntryCrud.writeEntry(pathname, seed, core, runtime, core.workerId);
        if (entryId === null) {
            return Results.failure("scheme:exec", "stream-entry-write-failed", 500, `The ${runtime} stream entry could not be created.`, {
                outcome: "entry_write_failed",
            }, {
                runtime,
                stage: "stream-creation",
                retryable: false,
            });
        }

        const subscriptionId = await ChannelWrite.openSubscription(core.db, {
            workerId: core.workerId, entryId, scheme: runtime,
            handle: runtime !== "" ? `${runtime}: ${body !== "" ? body : target ?? ""}` : body,
            pollSeconds: typeof attrs.pollSec === "number" ? attrs.pollSec : null, // {§exec-poll} — hibernation wake cadence
            turnScoped: attrs.turnScoped === true, // {§exec-poll} — `<0>` reaped at the next pre-turn
        });

        const controller = new AbortController();
        let unlink = (): void => {};
        if (core.signal !== undefined) {
            const parent = core.signal;
            // The spawn's kill binds to its loop's cancellation epoch (ctx.signal —
            // captured here, stable for the loop). The parent only aborts on FORCEFUL loop
            // teardown — a 202-graceful loop lets its spawns outlive, never firing this — so
            // the reason is always the bounded housekeeping reap. Attach the listener FIRST,
            // then re-check `aborted`: a listener added to an already-aborted signal never
            // fires, so a check-then-attach order LOSES an abort that lands in the gap (R1's
            // TOCTOU leak). Attach-then-check closes it; controller.abort is idempotent, so a
            // doubled fire is harmless. {§exec-timeout}
            const onParentAbort = (): void => controller.abort(ExecAbort.teardownReason());
            parent.addEventListener("abort", onParentAbort, { once: true });
            unlink = (): void => parent.removeEventListener("abort", onParentAbort);
            if (parent.aborted) controller.abort(ExecAbort.teardownReason());
        }
        this.#activeAborts.set(subscriptionId, { workerId: core.workerId, turnId: core.turnId, pathname, runtime, effect, controller, unlink });
        this.liveSubscriptions().register(subscriptionId, {
            cancel: () => controller.abort(ExecAbort.teardownReason()),
        });

        const tail = this.#runExecutor({
            executor: resolved.executor,
            runtime, body, cwd, target, ctx: core, pathname,
            entryId, subscriptionId, signal: controller.signal, controller, tempPath,
            timeoutSec: typeof attrs.timeoutSec === "number" ? attrs.timeoutSec : null,
        });

        // Every exec backgrounds + streams ({§exec-stream}): no same-turn receipt — the output
        // surfaces as the environment-observation injector's delta on the next turn (folded while
        // it runs, opened when it finishes). Pure/read commands still auto-accept
        // from the preserved effect fact; they resolve a turn later, uniformly
        // with host streams.
        this.#activeSpawns.set(subscriptionId, tail);
        return { status: 200, outcome: "started" };
    }

    // Bridge the executor's sink-style contract (write/setState/emit)
    // onto plurnk-service's storage primitives (appendToChannel,
    // setChannelState, ctx.pushNotice). Under {§executor-results},
    // executor Notices flow through the same engine path as
    // grammar parse advisories: emit, buffer, next packet, and live notify.
    //
    // write() and setState() callbacks must run in emission order:
    // appendToChannel reads channel state AFTER the append commits, so
    // a setState("closed") that races a prior write() can flip the
    // notify's reported state to "closed" before the chunk event fires
    // as "active." Chain through a single promise queue to serialize.
    async #runExecutor(opts: {
        executor: Executor;
        runtime: string; body: string; cwd: string | null; target: string | null; ctx: PlurnkSchemeContext;
        pathname: string; entryId: number; subscriptionId: number; signal: AbortSignal;
        controller: AbortController; timeoutSec: number | null;
        tempPath: string | null;
    }): Promise<SchemeResult> {
        const { executor, runtime, body, cwd, target, ctx, pathname, entryId, subscriptionId, signal, controller, timeoutSec, tempPath } = opts;
        const db = ctx.db;
        const coordinate = coordinateFromPathname(pathname);
        // grammar 0.74.20 EXEC `<T>` — kill the spawn after T seconds. unref'd so a pending timer never
        // holds the process open; cleared in finally so a spawn that finishes first leaves no timer.
        let timedOut = false;
        const timeoutTimer = timeoutSec !== null
            ? setTimeout(() => { timedOut = true; controller.abort(ExecAbort.timeoutReason()); }, timeoutSec * 1000)
            : null;
        timeoutTimer?.unref();
        let queue: Promise<void> = Promise.resolve();
        const enqueue = (op: () => Promise<void>): void => {
            queue = queue.then(op, op);
        };
        let result: SchemeResult = Results.failure(
            "scheme:exec",
            "executor-did-not-conclude",
            500,
            `The '${runtime}' executor did not produce a terminal result.`,
            {},
            {
                runtime,
                stage: "execution",
                retryable: false,
            },
        );
        let exitLabel = "did not conclude";
        let stdoutLength = 0;
        let stderrLength = 0;
        // {§exec-entry-sink} {§env-delta-entry-materialization} — serialize
        // executor entry() materializations and narrate them through the one
        // reserved-worker turn owned by this spawn.
        let entryChain: Promise<unknown> = Promise.resolve();
        let narration: {
            workerId: number;
            loopId: number;
            loopSeq: number;
            turnId: number;
            turnSeq: number;
            seq: number;
        } | null = null;
        let callerSource: string | undefined;
        const resolveCallerSource = async (): Promise<string> => {
            if (callerSource !== undefined) return callerSource;
            const caller = await db.worker_name_by_id.get<{ name: string }>({ worker_id: ctx.workerId });
            if (caller === undefined) throw new Error(`entry(): calling worker ${ctx.workerId} does not exist`);
            callerSource = WorkerControlAddress.render(caller.name);
            return callerSource;
        };
        const entrySink = (path: string, content: string | null, opts: { tags: string[]; mimetype?: string }): Promise<string> => {
            const parsed = parsePath(path);
            if (parsed === null || parsed.kind !== "url") return Promise.reject(new Error(`entry(): '${path.slice(0, 80)}' is not a URL`));
            if (content !== null && opts.mimetype === undefined) return Promise.reject(new Error("entry(): mimetype is required when content is provided"));
            const address = NetworkAddress.supports(parsed.scheme) ? NetworkAddress.from(parsed) : null;
            if (address?.hasCredentials === true) return Promise.reject(new Error("entry(): network URL userinfo is not allowed"));
            const fetchAddress = address !== null && (address.scheme === "http" || address.scheme === "https")
                ? address
                : null;
            const pathname = address?.pathname ?? entryPathnameOf(parsed);
            const scheme = address?.scheme ?? parsed.scheme;
            // {§exec-entry-sink}/{§web-search-retrieval} — start content:null
            // acquisition before the write chain so fetches run in parallel;
            // only durable entry writes serialize. A null result rejects the sink.
            let materialized: Promise<WebFetchResult | null>;
            if (content === null) {
                if (fetchAddress === null) return Promise.reject(new Error("entry(): content:null requires an http(s):// URL"));
                materialized = this.#fetchWeb(fetchAddress.url, { signal });
            } else {
                materialized = Promise.resolve({
                    url: fetchAddress?.url ?? "http://localhost",
                    body: content,
                    mimetype: opts.mimetype as string,
                    allowTavily: false,
                });
            }
            const op = async (): Promise<string> => {
                const fetched = await materialized;
                if (fetched === null) throw new Error(`entry(): '${path.slice(0, 80)}' is dead`);
                let web: WebMaterializedResult | null;
                try {
                    web = await WebFetcher.materialize(fetched, new DbProjectionCaps(ctx));
                } catch (error) {
                    if (!signal.aborted && error instanceof WebMaterializationError) {
                        console.error("entry() web materialization failed", { path, error });
                    }
                    throw error;
                }
                if (web === null) throw new Error(`entry(): '${path.slice(0, 80)}' has no readable projection`);
                if (web.body === undefined) {
                    throw new Error(
                        web.bodyOutcome.failure?.detail
                        ?? `entry(): '${path.slice(0, 80)}' produced no readable body`,
                    );
                }
                const tags = TagSignal.applied(opts.tags.map((tag) => `+${tag}`)).add;
                const tagSignal = tags.map((tag) => `+${tag}`);
                // {§exec-entry-sink}/{§html-materialization} The shared
                // materializer owns the decisive projection and its provenance.
                const channels: EntryData["channels"] = WebFetcher.materializedChannels(
                    web,
                    content === null && fetchAddress !== null
                        ? { url: fetchAddress.url, method: "GET" }
                        : undefined,
                );
                const decisive = web.body.content;
                const source = web.html?.content ?? decisive;
                const causalSource = await resolveCallerSource();
                const written = Results.assert(
                    await EntryCrud.writeEntry(pathname, { channels }, ctx, scheme),
                );
                if (narration === null) {
                    const worker = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: "plurnk" })
                        ?? await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: "plurnk", origin: "plurnk" });
                    if (worker === undefined) throw new Error("entry(): plurnk worker resolution returned no row");
                    const loop = await db.envelope_insert_client_loop.get<{ id: number; sequence: number }>({ worker_id: worker.id });
                    if (loop === undefined) throw new Error("entry(): loop insert returned no row");
                    const turn = await JournalTurn.insert(db, loop.id);
                    narration = {
                        workerId: worker.id,
                        loopId: loop.id,
                        loopSeq: loop.sequence,
                        turnId: turn.id,
                        turnSeq: turn.sequence,
                        seq: 1,
                    };
                }
                const sequence = narration.seq++;
                const narrationAttrs = { kind: "entry_materialized" } as const;
                if (written.problem !== undefined) {
                    const coordinate = LogEntryProjection.coordinate(
                        `${narration.loopSeq}/${narration.turnSeq}/${sequence}`,
                        { origin: "plurnk", op: "EDIT", attrs: narrationAttrs },
                    );
                    Results.attachInstance(
                        written,
                        `log:///${coordinate}`,
                    );
                }
                const logRow = await db.engine_insert_log_entry.get<{ id: number }>({
                    worker_id: narration.workerId, loop_id: narration.loopId, turn_id: narration.turnId, sequence,
                    // signal carries additive tag terms through the same slot a model's EDIT uses, so the
                    // ambient row renders its tags natively everywhere (packet meta line, digest).
                    origin: "plurnk", source: causalSource, model_call_id: null,
                    op: "EDIT", suffix: "", signal: JSON.stringify(tagSignal),
                    scheme, username: null, password: null, hostname: null, port: null,
                    pathname, query: null, fragment: null, lineMarker: null,
                    tx: JSON.stringify({ op: "EDIT", body: source }), mimetype_tx: "application/json",
                    rx: JSON.stringify(written.problem === undefined
                        ? {
                            ...written,
                            span: decisive.split("\n").map((l, n) => `${n + 1}:${l}`).join("\n"),
                        }
                        : written),
                    mimetype_rx: "application/json",
                    status_rx: written.status, tokens: ctx.tokenize?.(decisive) ?? 0, state: "resolved", outcome: null,
                    // Durable provenance for clients/forensics. This is machine
                    // ambience, not a human/model action waterfall item.
                    attrs: JSON.stringify(narrationAttrs),
                });
                if (logRow === undefined) throw new Error("entry(): log insert returned no row");
                if (written.problem !== undefined) throw new OperationFailureError(written);
                return renderAddress(scheme, pathname);
            };
            const run = entryChain.then(op, op);
            entryChain = run.then(() => undefined, () => undefined);
            return run;
        };
        try {
            try {
                const reported: ExecutorResult = await executor.run({
                    runtime, body, cwd, target, signal,
                    entry: entrySink,
                    env: ExecEnv.scoped(),  // SPEC {§exec} {§exec-env-scoped} — never plurnk's own secrets
                    write: (channel, chunk, mimetype) => enqueue(() => ChannelWrite.appendToChannel(db, {
                        entryId, channel, chunk, mimetype, notify: ctx.streamEventNotify, coordinate,
                    })),
                    setState: (channel, state: ChannelState) => enqueue(() => ChannelWrite.setChannelState(db, {
                        entryId, channel, state, notify: ctx.streamEventNotify, coordinate,
                    })),
                    emit: (event) => ctx.pushNotice?.(event),
                });
                // Drain the queue so the subscription doesn't close before
                // final chunk events / state transitions have committed.
                await queue;
                try {
                    result = Results.assert(reported);
                } catch (cause) {
                    console.error(`Executor '${runtime}' returned an invalid operation result:`, cause);
                    result = Results.failure(
                        "scheme:exec",
                        "executor-invalid-result",
                        500,
                        `The '${runtime}' executor returned an invalid operation result.`,
                        {},
                        {
                            runtime,
                            stage: "result-validation",
                            retryable: false,
                        },
                    );
                }
            } catch (cause) {
                // A rejecting driver must still CONCLUDE its stream — uncaught, the subscription sat
                // open forever and the floating spawn promise was an unhandled rejection.
                console.error(`Executor '${runtime}' threw outside its operation result contract:`, cause);
                result = Results.failure(
                    "scheme:exec",
                    "executor-threw",
                    500,
                    `The '${runtime}' executor failed outside its operation result contract.`,
                    {},
                    {
                        runtime,
                        stage: "execution",
                        retryable: false,
                    },
                );
            }

            const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
            // A timeout aborts the spawn → the executor reports 499; replace the
            // complete result so status and Problem remain one valid truth.
            if (timedOut) {
                result = Results.failure(
                    "scheme:exec",
                    "execution-timeout",
                    504,
                    `Execution of '${runtime}' exceeded its ${timeoutSec}-second deadline.`,
                    exitCode === null ? {} : { exitCode },
                    {
                        runtime,
                        timeoutSeconds: timeoutSec,
                        stage: "execution",
                        retryable: false,
                    },
                );
            // The service's own abort knowledge outranks a driver's claim: a
            // spawn we reaped did not succeed, whatever it resolved under abort.
            } else if (signal.aborted && result.status < 400) {
                result = Results.failure(
                    "scheme:exec",
                    "execution-cancelled",
                    499,
                    `Execution of '${runtime}' was cancelled by the service.`,
                    exitCode === null ? {} : { exitCode },
                    {
                        runtime,
                        stage: "execution",
                        retryable: false,
                    },
                );
            }
            exitLabel = timedOut
                ? `timed out after ${timeoutSec}s`
                : result.status === 499
                    ? "aborted"
                    : exitCode !== null
                        ? `exit ${exitCode}`
                        : result.problem?.title.toLowerCase() ?? "completed";
            await ChannelWrite.closeSubscription(db, { subscriptionId, result });

            const stdoutMeta = await db.channel_meta.get<{ contentLength: number }>({ entry_id: entryId, channel: "stdout" });
            const stderrMeta = await db.channel_meta.get<{ contentLength: number }>({ entry_id: entryId, channel: "stderr" });
            stdoutLength = stdoutMeta?.contentLength ?? 0;
            stderrLength = stderrMeta?.contentLength ?? 0;
        } finally {
            // {§exec-entry-sink} — the spawn tail owns every serialized entry/narration write.
            await entryChain;
            if (timeoutTimer !== null) clearTimeout(timeoutTimer); // a finished spawn leaves no pending timer
            // {§exec-source-temporary} — cleanup cannot rewrite the settled
            // executor result, but an exceptional failure remains observable.
            if (tempPath !== null) {
                await unlink(tempPath).catch((cause: unknown) => {
                    console.error(`EXEC source temporary cleanup failed for '${tempPath}':`, cause);
                });
            }
            this.#activeAborts.get(subscriptionId)?.unlink();
            this.#activeAborts.delete(subscriptionId);
            this.liveSubscriptions().unregister(subscriptionId);
            this.#activeSpawns.delete(subscriptionId);

            // Every worker backgrounds now ({§exec-stream}) — wake a parked loop on completion so the
            // worker resumes to the turn where the stream's terminal delta surfaces.
            if (ctx.wakeWorkerNotify !== undefined) {
                ctx.wakeWorkerNotify({
                    workspaceId: ctx.workspaceId, workerId: ctx.workerId,
                    entryOwnerId: ctx.workerId, entryId, target: `${runtime}://${pathname}`, subscriptionId, result,
                    scheme: runtime,
                    summary: `${runtime}://${pathname} completed (${exitLabel}); stdout=${stdoutLength} bytes, stderr=${stderrLength} bytes`,
                    ...coordinate,
                });
            }
        }
        return result;
    }

    async resolveEntryAddress(
        target: ParsedPath,
        ctx: CoreSchemeCallContext,
    ): Promise<CoreEntryAddress | SchemeResultBase | null> {
        if (target.kind !== "url") return null;
        const ownerId = await Owner.resolveStreamOwner(target.hostname, this.coreContext(ctx));
        return ownerId === null
            ? Results.failure(
                "scheme:exec",
                "stream-not-found",
                404,
                "No visible stream exists at the requested address.",
            )
            : { pathname: target.pathname, ownerId };
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const owner = await resolveStreamStatement(statement, core);
        if (owner === null) {
            return Results.failure("scheme:exec", "stream-not-found", 404, "No visible stream exists at the requested address.", {
                content: null, mimetype: null, results: [], itemsTokenTotal: 0, returnedItemsTokenTotal: 0,
                matchingPathCount: 0, matchLocationCount: 0,
            }) as FindResult;
        }
        return EntryFind.findWorkspaceEntries(owner.statement, core, Exec.manifest, { ownerId: owner.ownerId });
    }

    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return EntryCrud.readEntry(pathname, core, Exec.manifest.name, core.workerId);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        return EntryCrud.writeEntry(pathname, entry, this.coreContext(ctx), Exec.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        return EntryCrud.deleteEntry(pathname, this.coreContext(ctx), Exec.manifest.name);
    }
}
