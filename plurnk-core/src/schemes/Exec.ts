import { parsePath } from "@plurnk/plurnk-parser";
import { errnoCode, isExecutionOp, PathSyntax } from "@plurnk/plurnk-contracts";
import { type ExecStatement, type FindStatement, type KillStatement, type SendStatement } from "@plurnk/plurnk-contracts";
import type { ChannelState, ExecResult as ExecutorResult, Executor, Effect, RuntimeInvocationDecl } from "@plurnk/plurnk-execs";
import {
    InvalidOperationResultError,
    MetadataOptions,
    type ProposalApplyRequest,
    type SchemeHandler,
    type WebMaterializer,
} from "@plurnk/plurnk-schemes";
import FunctionalityManager from "../server/FunctionalityManager.ts";
import EffectPolicy from "./EffectPolicy.ts";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryCrud from "./_entry-crud.ts";
import EntryFind from "./_entry-find.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import ChannelWrite, { type StreamCoordinate } from "../core/ChannelWrite.ts";
import LiveSubscription from "../core/LiveSubscription.ts";
import EnvFunctionality, { type EnvRecord } from "../server/EnvFunctionality.ts";
import ExecAbort from "./exec-abort.ts";
import { LIFETIME_SYNTAX, formatLifetime, parseExecLifetime, type ExecLifetime } from "./exec-lifetime.ts";
import { entryCoordinateOf, generatedPathname, isGeneratedPathname, renderAddress } from "../core/plurnk-uri.ts";
import { writeFile, unlink, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type ExecutorRegistry from "../core/ExecutorRegistry.ts";
import type { RegistryEntry } from "../core/ExecutorRegistry.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import ErrorDetail from "../core/ErrorDetail.ts";
import Results, { OperationFailureError, type SchemeResult, type SchemeResultBase } from "../core/results.ts";
import ToolResources from "../core/ToolResources.ts";
import { setTimeout as delay } from "node:timers/promises";
import ExecScheduler, { readExecConcurrency } from "./ExecScheduler.ts";
import type HostPaths from "../core/HostPaths.ts";
import ExecScratch from "./ExecScratch.ts";
import ExecutionInput from "./ExecutionInput.ts";
import { execRouteOf } from "./exec-runtime.ts";
import ExecEntrySink, { type WebFetch } from "./exec-entry-sink.ts";

type ExecResult = SchemeResultBase & { body?: string; attrs?: object };
// What an accepted execution proposal's application reports: started, queued, or the refusal.
type ApplyOutcome = SchemeResultBase & { outcome?: string; body?: string; result?: object };

interface ExecAttrs {
    runtime: string;        // "" (default shell), "sh", "js", "python3", etc.
    cwd: string | null;     // the working directory the command runs in: project root, or the shell's own cwd when the workspace has none ({§executor-sinks})
    input?: "open";         // the preparation declared that the invocation registers an input receiver ({§executor-live-input})
    target: string | null;  // consumer-routed execution target; each executor owns its mapping ({§executor-sinks})
    body: string;           // the fence body
    pathname: string;       // workspace output claim ({§execution-output-identity})
    coordinate?: StreamCoordinate;
    effect: Effect;         // one admission fact, preserved through apply and stream/hold bookkeeping
    resourceSource?: string; // complete authored non-file resource address, resolved through ordinary READ at apply time
    // {§exec-lifetime} — `[{"lifetime": …}]`, one field, absent = loop-bound.
    timeoutSec?: number;    // a duration: kill the spawn at the deadline (504).
    turnScoped?: boolean;   // "turn": reaped at the worker's next pre-turn, never surviving into the subsequent turn.
    detached?: boolean;     // "detached": the spawn outlives its loop — never bound to the loop's teardown, nobody's obligation; KILL, the worker's total reap, and daemon shutdown still end it.
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

export type { WebFetch } from "./exec-entry-sink.ts";

export default class Exec extends CoreSchemeAdapterBase implements Pick<SchemeHandler, "kill"> {
    static validateConfiguration(hostPaths?: HostPaths): void {
        readExecConcurrency();
        ExecutionInput.configuredTimeout();
        ExecScratch.directory(process.env, hostPaths);
    }

    // The record goes on the output the spawn produces ({§execution-output-identity}) — the log row
    // is the model's proposal and stays immutable. An output that is not there is a defect in the
    // provenance chain, never a spawn that quietly runs unrecorded.
    static async #recordEnv(db: PlurnkSchemeContext["db"], entryId: number, record: Record<string, EnvRecord>): Promise<void> {
        const { changes } = await db.execution_record_env.run({ entry_id: entryId, env: JSON.stringify(record) });
        if (changes !== 1) throw new Error(`spawn output entry ${entryId} is not there to record the environment on`);
    }

    // The slot contract, stated when a resource source cannot be read: the resource IS the program and the
    // body its stdin. The other reading of the fence is not offered ({§diagnostic-observation}).
    static sourceRecovery(source: string, upstream: unknown): string {
        const contract = `The target \`${source}\` names the program resource; the body is its stdin.`;
        return typeof upstream === "string" && upstream.length > 0 ? `${contract} ${upstream}` : contract;
    }

    static manifest: SchemeManifest = {
        name: "exec",
        authority: "namespace",
        channels: { stdout: "text/stream", stderr: "text/stream" },
        defaultChannel: "stdout",
        category: "data",
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
        metadataModifier: true,
        documentation: "The opening fence names a registered executor or MCP service; its target, body, metadata, and timing follow that tool's invocation contract. Output streams into the workspace's `<executor>:///<id>` entry on that tool's own channels. A host-effecting invocation proposes for review before it runs; a read-only or pure one runs ungated. While it runs, the packet's `## Open Work` streams list reports channel size and growth and READ can inspect any range; when it finishes, one terminal READ becomes visible automatically.",
    };

    // The web-fetch the entry sink calls on content:null ({§exec-entry-sink}); default = the
    // registry's web materializer, injectable for tests. Materialization always goes through
    // the registry ({§web-materialization-contract}): core names no extension package.
    readonly #fetchWeb: WebFetch;
    readonly #materializer: () => WebMaterializer;
    #execution: { scheduler: ExecScheduler; inputTimeoutMs: number } | null = null;
    #scratch: ExecScratch | null = null;
    constructor(fetchWeb: WebFetch | undefined, materializer: () => WebMaterializer) {
        super();
        this.#materializer = materializer;
        this.#fetchWeb = fetchWeb ?? ((url, opts) => materializer().fetch(url, opts));
    }

    // {§configuration-repair-path}: validate before admission, not while constructing the repair environment.
    #prepareExecution(): { scheduler: ExecScheduler; inputTimeoutMs: number } {
        return this.#execution ??= {
            inputTimeoutMs: ExecutionInput.configuredTimeout(),
            scheduler: new ExecScheduler(),
        };
    }

    #sourceScratch(hostPaths?: HostPaths): ExecScratch {
        return this.#scratch ??= new ExecScratch(process.env, hostPaths);
    }

    #activeAborts = new Map<number, { workspaceId: number; workerId: number; turnId: number; pathname: string; runtime: string; effect: Effect; controller: AbortController; detached: boolean; input: ExecutionInput; invocation: ExecStatement; executor: Executor }>();
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
        for (const { workerId: r, detached } of this.#activeAborts.values()) if (r === workerId && !detached) return true;
        return false;
    }

    // {§exec-lifetime} — a detached spawn ends with the daemon: nothing else ever aborts it, so the
    // stop sequence reaps it (bounded housekeeping) before the streaming drain barrier.
    abortDetached(): void {
        for (const { controller, detached } of this.#activeAborts.values()) if (detached) controller.abort(ExecAbort.teardownReason());
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
            .filter(([, active]) => active.workerId === workerId && active.turnId === turnId && !active.detached)
            .map(([subscriptionId]) => {
                const spawn = this.#activeSpawns.get(subscriptionId);
                if (spawn === undefined) {
                    throw new Error(`Active execution subscription ${subscriptionId} has no spawn settlement promise.`);
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

    // {§exec-near-miss} — an execution id written under another runtime (`sh:///5e8ea474` for
    // `python3:///5e8ea474`) names the address it holds (#1005).
    static async #nearMiss(core: { readonly db: Parameters<typeof ChannelWrite.execAddressesAt>[0]; readonly workspaceId: number }, pathname: string): Promise<string | undefined> {
        const addresses = await ChannelWrite.execAddressesAt(core.db, { workspaceId: core.workspaceId, authority: "", pathname });
        return addresses.length === 0 ? undefined : `The execution at ${pathname} is ${addresses.map((address) => `\`${address}\``).join(", ")}.`;
    }

    // {§stream-control} — active KILL routes through the live controller;
    // terminal and missing outcomes resolve from the durable subscription.
    async kill(statement: KillStatement, ctx: CoreSchemeCallContext): Promise<SchemeResultBase> {
        if (statement.target?.kind !== "url") throw new InvalidOperationResultError("Execution KILL requires a runtime URL.");
        const { scheme } = statement.target;
        const { pathname } = entryCoordinateOf(statement.target, "namespace");
        const core = this.coreContext(ctx);
        for (const [subscriptionId, entry] of this.#activeAborts) {
            if (entry.workspaceId === core.workspaceId && entry.pathname === pathname && (scheme === "exec" || entry.runtime === scheme)) {
                if (core.writer === "model") this.liveSubscriptions().asked(subscriptionId, core.workerId);
                entry.controller.abort(ExecAbort.killReason(null));
                if (!await this.liveSubscriptions().cancel(subscriptionId)) {
                    throw new Error(`Active execution subscription ${subscriptionId} has no cancellation owner.`);
                }
                return { status: 200 };
            }
        }
        const terminal = await ChannelWrite.execTerminalStatus(core.db, {
            workspaceId: core.workspaceId,
            scheme,
            authority: "",
            pathname,
        });
        const target = renderAddress({ scheme, authority: "", pathname });
        if (terminal === null) {
            const recovery = await Exec.#nearMiss(core, pathname);
            return Results.failure(
                "scheme:exec",
                "stream-not-found",
                404,
                `No stream exists at ${target}.`,
                {},
                { target, ...(recovery === undefined ? {} : { recovery }) },
            );
        }
        // {§stream-control} — the process is already not running, which is what KILL asks for; the
        // receipt says how it ended instead of refusing a cleanup that raced the exit (#757).
        return { status: 200, terminalStatus: terminal };
    }

    // Execution handler — the model-facing entry point per plurnk.md.
    // Named executable fences lower to runtime-owned invocation buckets.
    //
    // Proposes (status=202) with attrs={runtime, cwd, body, pathname}.
    // applyResolution spawns the subprocess; output streams into the
    // coordinate-stamped <runtime>:///<pathname> entry's stdout/stderr channels
    // (e.g. sh:///1/1/2/sh, {§exec}). The model READs that entry on a subsequent turn.
    //
    // Admission runs in the order its refusals are owed — the executor, its tool, the fence's shape,
    // the target's routing, the service's reserved metadata, the executor's preparation, a script
    // target's existence — and each step returns either the refusal or what the next step needs.
    async exec(statement: ExecStatement, ctx: CoreSchemeCallContext): Promise<ExecResult> {
        const core = this.coreContext(ctx);
        const body = statement.body ?? "";
        const { executors } = core;
        if (executors === undefined) throw new Error("exec dispatched without an executor registry");
        // {§exec-executor-slot}: the fence names the executor; the path is its program.
        const route = execRouteOf(statement);
        const runtime = route.runtime;
        const resolved = Exec.#admitRuntime(executors, core.workspaceId, runtime);
        if ("status" in resolved) return resolved;

        this.#prepareExecution();

        const invocation = Exec.#admitTool(executors, core.workspaceId, resolved, runtime, route.target === null ? null : route.target.raw);
        if ("status" in invocation) return invocation;
        const hasBody = body.length > 0;
        const execTarget = route.target;
        const hasTarget = execTarget !== null;
        const shape = Exec.#checkInvocationShape(invocation, runtime, execTarget?.raw, hasBody, hasTarget);
        if (shape !== null) return shape;

        const routed = await this.#routeTarget(core, { runtime, invocation, execTarget, hasBody });
        if ("status" in routed) return routed;
        const { defaultCwd, resourceSource } = routed;
        let { target } = routed;
        let cwd: string | null = defaultCwd;
        let inputDeclared = false;

        const lifetime = Exec.#readReservedMetadata(statement, runtime);
        if ("status" in lifetime) return lifetime;
        // {§executor-metadata} Options belong to the invoked executor for every source kind.
        const prepared = await Exec.#prepareInvocation(resolved.executor, statement, { runtime, body, target: resourceSource ?? target, cwd });
        if ("status" in prepared) return prepared;
        ({ cwd, inputDeclared } = prepared);
        // A `script` target must be an existing file; other kinds pass through as declared.
        if (target !== null && invocation.target?.kind === "script") {
            const inspected = await Exec.#inspectScriptTarget(core, { runtime, target, cwd, defaultCwd, hasBody });
            if ("status" in inspected) return inspected;
            ({ target, cwd } = inspected);
        }
        if (!hasBody && target === null && resourceSource === null) {
            return Exec.#refuse(
                runtime,
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
        // The log writer claims the workspace output address before proposal application.
        // {§exec-lifetime} — how long the spawn may live is the metadata's one field; the scope slot
        // is text coordinates, which an execution has none of.
        const attrs: ExecAttrs = {
            runtime, cwd, body, target, pathname: "", effect,
            ...(inputDeclared ? { input: "open" as const } : {}),
            ...(resourceSource !== null ? { resourceSource } : {}),
            ...lifetime,
        };
        const previewInput = body !== "" ? body : execTarget?.raw ?? "";
        const preview = runtime !== "" ? `[${runtime}] ${previewInput}` : `$ ${previewInput}`;
        return { status: 202, body: preview, attrs };  // host runtime proposes with 202 — {§exec-host-proposes}
    }

    // A refusal of the fence as written: 400, the runtime named, and the working form when there is one.
    static #refuse(
        runtime: string,
        code: string,
        detail: string,
        recovery: string | undefined,
        extensions: Readonly<Record<string, unknown>> = {},
    ): ExecResult {
        return Results.failure(
            "scheme:exec",
            code,
            400,
            detail,
            {},
            { runtime, ...(recovery === undefined ? {} : { recovery }), retryable: false, ...extensions },
        );
    }

    // The executor the fence names, or the refusal: unregistered, unavailable, or unconfigured.
    static #admitRuntime(executors: ExecutorRegistry, workspaceId: number, runtime: string): RegistryEntry | ExecResult {
        // {§exec-registry-resolves} — a non-empty tag selects exactly one registered executable
        // tool. Unknown tags are not reinterpreted as shell command words: that would make the
        // executed command differ from the authored body.
        const resolved = executors.entry(runtime, workspaceId);
        if (resolved === undefined) {
            return Results.failure(
                "scheme:exec",
                "executor-not-registered",
                400,
                `No executor or MCP service named \`${runtime}\` is registered for this worker.`,
                {},
                {
                    requestedRuntime: runtime,
                    executors: executors.availableRuntimes(workspaceId),
                    retryable: false,
                },
            );
        }
        if (!resolved.available) {
            if (resolved.configurationError !== undefined) return Results.configurationFailure(resolved.configurationError);
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
            );
        }
        return resolved;
    }

    // The invocation contract the fence runs under: a family runtime's registered tool, named exactly, or
    // the executor's own declaration.
    static #admitTool(executors: ExecutorRegistry, workspaceId: number, resolved: RegistryEntry, runtime: string, exactTarget: string | null): RuntimeInvocationDecl | ExecResult {
        const registry = executors.toolRegistry(runtime, workspaceId);
        const registeredTool = registry?.tools.find((tool) => tool.target === exactTarget);
        if (registry !== null && registeredTool === undefined) {
            const availableTargets = registry.tools.map((tool) => tool.target);
            // {§executor-blank-invocation} No target: every enabled target's fence. An unknown one: the document listing them.
            const recovery = availableTargets.length === 0 ? {}
                : exactTarget === null ? { recovery: registry.tools.map((tool) => ToolResources.fence(runtime, tool.invocation, tool.target)).join("\n\n") }
                    : { recovery: `Select a target from worker://${ToolResources.documentPath(runtime, resolved.resourcesPath)}.` };
            return Results.failure(
                "scheme:exec",
                exactTarget === null ? "target-required" : "target-not-registered",
                exactTarget === null ? 400 : 404,
                exactTarget === null
                    ? `Runtime '${runtime}' requires one registered tool target.`
                    : `Runtime '${runtime}' has no registered target '${exactTarget}'.`,
                {},
                {
                    runtime,
                    availableTargetCount: availableTargets.length,
                    ...recovery,
                    retryable: false,
                },
            );
        }
        return registeredTool?.invocation ?? resolved.invocation;
    }

    // The fence's body and target against the invocation's declaration, refused by name. {§executor-blank-invocation} An
    // absent input is answered with the invocation's own fence.
    static #checkInvocationShape(invocation: RuntimeInvocationDecl, runtime: string, exactTarget: string | undefined, hasBody: boolean, hasTarget: boolean): ExecResult | null {
        const fence = (): string => ToolResources.fence(runtime, invocation, exactTarget);
        if (invocation.body.required && !hasBody) {
            return Exec.#refuse(
                runtime,
                "body-required",
                `Executable tool '${runtime}' requires a ${invocation.body.role} body.`,
                fence(),
            );
        }
        if (invocation.target === undefined && hasTarget) {
            return Exec.#refuse(
                runtime,
                "target-not-supported",
                `Executable tool '${runtime}' does not accept a target.`,
                `Remove the target and provide the ${invocation.body.role} in the body.`,
            );
        }
        if (invocation.target?.required === true && !hasTarget) {
            return Exec.#refuse(
                runtime,
                "target-required",
                `Executable tool '${runtime}' requires a ${invocation.target.role} target.`,
                fence(),
            );
        }
        if (!hasBody && !hasTarget) {
            return Exec.#refuse(
                runtime,
                "input-required",
                `Executable tool '${runtime}' requires a body or target.`,
                fence(),
            );
        }
        if (invocation.exclusive === true && hasBody && hasTarget) {
            return Exec.#refuse(
                runtime,
                "input-conflict",
                `Executable tool '${runtime}' accepts its ${invocation.body.role} body and ${invocation.target?.role ?? "target"} target only as alternatives.`,
                "Provide either the body or target, not both.",
            );
        }
        return null;
    }

    // {§exec-target-routing} The working directory the run can always name, and the target as the executor
    // will receive it: a literal, a local path, or a non-file resource realized at apply time.
    async #routeTarget(core: PlurnkSchemeContext, args: {
        runtime: string; invocation: RuntimeInvocationDecl; execTarget: ExecStatement["target"]; hasBody: boolean;
    }): Promise<{ defaultCwd: string; target: string | null; resourceSource: string | null } | ExecResult> {
        const { runtime, invocation, execTarget, hasBody } = args;
        const workspaceRow = await core.db.envelope_get_workspace.get<{ project_root: string | null }>({ id: core.workspaceId });
        const projectRoot = workspaceRow?.project_root ?? null;
        // The working directory is always concrete — the project root, or the shell's own
        // cwd when the workspace has none — so every receipt can name it ({§exec-target-routing}).
        const defaultCwd = projectRoot ?? process.cwd();
        let target: string | null = null;
        let resourceSource: string | null = null;
        const targetDecl = invocation.target;
        if (execTarget !== null && targetDecl !== undefined) {
            if (targetDecl.kind === "literal") {
                target = execTarget.raw;
            } else {
                const localTarget = localPathFromTarget(execTarget);
                if (localTarget !== null) {
                    target = localTarget;
                } else if (targetDecl.kind === "resource" || targetDecl.kind === "script") {
                    resourceSource = resourceSourceOf(execTarget);
                    if (resourceSource === null) {
                        throw new Error(`'${runtime}' resource target could not be classified`);
                    }
                } else {
                    return Exec.#refuse(
                        runtime,
                        "target-kind-invalid",
                        `Executable tool '${runtime}' accepts only a local or file:// ${targetDecl.role} target.`,
                        `Use a local or file:// ${targetDecl.role} target.`,
                        { target: execTarget.raw, targetKind: targetDecl.kind },
                    );
                }
            }
        }

        // {§exec-target-near-miss} — a target in this executor's own scheme whose path can never be a
        // stream (`sh:///daemon-env`; streams are eight hex digits) is the writer's name for the run,
        // not a program: with a body present, the body runs as if targetless. Never taught.
        if (resourceSource !== null && hasBody && execTarget?.kind === "url" && execTarget.scheme === runtime
            && !/^\/[0-9a-f]{8}(?:[/#]|$)/u.test(execTarget.pathname ?? "")) {
            resourceSource = null;
        }

        // {§exec-target-documentation} — the generated reference under worker:///_plurnk/ describes a
        // runtime; it is never a program. Realizing it as a temporary script fails where the runtime
        // cannot see the host's temporary directory, and runs markdown where it can.
        if (resourceSource !== null && execTarget?.kind === "url" && execTarget.scheme === "worker"
            && isGeneratedPathname(PathSyntax.decodeParens(execTarget.pathname ?? ""))) {
            return Exec.#refuse(
                runtime,
                "target-is-documentation",
                `\`${execTarget.raw}\` is reference documentation the harness generated, not a program; ${runtime} cannot run it.`,
                undefined,
                { target: execTarget.raw },
            );
        }

        // {§exec-scratch-directory} — a standalone source is realized under the scratch directory,
        // where its executor must be able to read it; a directory the daemon cannot create or
        // write refuses here, never mid-run.
        if (resourceSource !== null && execTarget !== null) {
            const scratch = this.#sourceScratch(core.hostPaths);
            const unavailable = await scratch.unavailable();
            if (unavailable !== null) {
                return Exec.#refuse(
                    runtime,
                    "scratch-unavailable",
                    `The execution scratch directory \`${scratch.directory}\` named by ${ExecScratch.KNOB} cannot be created or written (${unavailable}), so the ${runtime} source \`${execTarget.raw}\` cannot be realized.`,
                    `The operator points ${ExecScratch.KNOB} at a writable absolute directory the ${runtime} executor can also read; meanwhile, target a program file the executor can reach, or put the command beneath a ${runtime} heading with no target.`,
                    { target: execTarget.raw, scratch: scratch.directory, configuration: ExecScratch.KNOB },
                );
            }
        }
        return { defaultCwd, target, resourceSource };
    }

    // {§exec-lifetime} {§env-option} The service's reserved keys, read before the executor sees its options.
    static #readReservedMetadata(statement: ExecStatement, runtime: string): ExecLifetime | ExecResult {
        // {§exec-lifetime} — the scope slot is text coordinates, and an execution has none.
        if (statement.lineMarker !== null) return Exec.#refuse(runtime, "scope-unsupported", "An execution takes no scope.", undefined);

        // {§env-option} — the fence's own environment is the service's key: refused here by name,
        // so the model learns why, never dropped at the spawn. The executor never sees it.
        try {
            EnvFunctionality.modifier(statement.metadata);
        } catch (cause) {
            if (!(cause instanceof OperationFailureError)) throw cause;
            return cause.result;
        }
        // {§exec-lifetime} — the service's other reserved key, read before the executor's options so
        // an unreadable lifetime is refused by name rather than spawning under a wrong bound. A block
        // that is not the option-array shape carries no lifetime for the service to read: it is the
        // invoked executor's to accept or refuse ({§executor-metadata}), exactly as `env` is.
        const read = MetadataOptions.parse(statement.metadata, "scheme:exec", { runtime });
        const lifetime = parseExecLifetime("failure" in read ? undefined : read.lifetime);
        if ("invalid" in lifetime) {
            return Results.failure("scheme:exec", "lifetime-invalid", 400, lifetime.invalid, {}, {
                runtime, recovery: `State one lifetime: ${LIFETIME_SYNTAX}.`, retryable: false,
            });
        }
        return lifetime;
    }

    // {§executor-metadata} The executor's preparation of its own options: the working directory it chose
    // and whether the invocation registers an input receiver; metadata without a preparer is refused.
    static async #prepareInvocation(executor: Executor, statement: ExecStatement, args: {
        runtime: string; body: string; target: string | null; cwd: string | null;
    }): Promise<{ cwd: string | null; inputDeclared: boolean } | ExecResult> {
        const { runtime, body, target, cwd } = args;
        if (executor.prepare !== undefined) {
            const prepared = Results.assert(await executor.prepare({ runtime, body, target, cwd, metadata: statement.metadata }));
            if (prepared.status >= 400) return prepared;
            if (prepared.status !== 200 || (prepared.cwd !== null && (typeof prepared.cwd !== "string" || !isAbsolute(prepared.cwd)))) {
                throw new InvalidOperationResultError(`Executable tool '${runtime}' returned invalid invocation preparation.`);
            }
            return { cwd: prepared.cwd, inputDeclared: prepared.input === "open" };
        }
        if ((statement.metadata?.length ?? 0) > 0) {
            return Results.failure("scheme:exec", "metadata-unsupported", 400,
                `Executable tool '${runtime}' does not accept metadata.`, {}, { runtime, retryable: false });
        }
        return { cwd, inputDeclared: false };
    }

    // A script target as it exists: a file runs, a directory with a body is where the body runs
    // ({§exec-target-near-miss}), and a missing one is refused as what it is ({§diagnostic-observation}).
    static async #inspectScriptTarget(core: PlurnkSchemeContext, args: {
        runtime: string; target: string; cwd: string | null; defaultCwd: string; hasBody: boolean;
    }): Promise<{ target: string | null; cwd: string | null } | ExecResult> {
        const { runtime, defaultCwd, hasBody } = args;
        let { cwd } = args;
        let target: string | null = args.target;
        const inspected = isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target);
        let kind: "file" | "directory" | "missing" = "missing";
        try {
            kind = (await stat(inspected)).isDirectory() ? "directory" : "file";
        } catch (cause) {
            if (errnoCode(cause) !== "ENOENT") {
                console.error(`Execution target classification failed for '${inspected}':`, cause);
                return Results.failure(
                    "scheme:exec",
                    "target-classification-failed",
                    500,
                    `${runtime} target '${target}' could not be inspected: ${ErrorDetail.preview(cause)}`,
                    {},
                    { target, stage: "target-classification" },
                );
            }
        }
        // {§exec-target-near-miss} — a directory is never a program: with a body and no explicit
        // cwd, it is where the body runs. Never taught.
        if (kind === "directory" && hasBody && cwd === defaultCwd) {
            cwd = inspected;
            target = null;
        } else if (kind === "directory") {
            return Exec.#refuse(
                runtime,
                "target-not-a-program",
                `${runtime} target '${target}' is a directory, not a program.`,
                undefined,
                { target },
            );
        }
        if (kind === "missing") {
            // The target is not a script here, but it may be a registered tool of another executor or an
            // executor itself: that is what exists, said as found (#388, {§diagnostic-observation}).
            const executors = core.executors;
            const ownerRuntimes = executors === undefined
                ? []
                : executors.availableRuntimes(core.workspaceId)
                    .filter((tag) => executors.toolRegistry(tag, core.workspaceId)?.tools.some((tool) => tool.target === target) === true);
            const runtimeTarget = executors !== undefined && target !== null && target !== runtime
                && executors.availableRuntimes(core.workspaceId).includes(target);
            const recovery = ownerRuntimes.length > 0
                ? `The tool \`${target}\` is registered under executor \`${ownerRuntimes[0]}\`.`
                : runtimeTarget
                    ? `\`${target}\` is its own executor.`
                    : "The target must name an existing program resource.";
            return Exec.#refuse(
                runtime,
                "target-not-found",
                `The ${runtime} program does not resolve as a script or a registered tool for this executor.`,
                recovery,
                { target, ...(ownerRuntimes.length === 0 ? {} : { toolRuntimes: ownerRuntimes }) },
            );
        }
        return { target, cwd };
    }

    async #inputRecipient(statement: SendStatement, ctx: CoreSchemeCallContext, runtime: string) {
        const core = this.coreContext(ctx);
        const target = statement.target;
        const failure = (code: string, status: number, detail: string) => ({
            failure: Results.failure("scheme:exec", code, status, detail, {}, { retryable: false }),
        });
        if (target?.kind !== "url" || target.scheme !== runtime || target.fragment !== null
            || target.query !== null || statement.lineMarker !== null) {
            // {§problems-exec}
            return failure("invalid-input-target", 400, "SEND input addresses an execution, without a channel or scope.");
        }
        const coordinate = entryCoordinateOf(target, "namespace");
        const found = [...this.#activeAborts.entries()].find(([, entry]) =>
            entry.workspaceId === core.workspaceId && entry.runtime === runtime && entry.pathname === coordinate.pathname);
        if (found !== undefined) {
            if (core.executors?.entry(runtime, core.workspaceId)?.executor !== found[1].executor) {
                return failure("input-unavailable", 409, "This execution's input receiver is no longer enabled.");
            }
            return { found };
        }
        const terminal = await ChannelWrite.execTerminalStatus(core.db, {
            workspaceId: core.workspaceId, scheme: runtime, ...coordinate,
        });
        if (terminal !== null) return failure("input-closed", 410, "Execution input is closed.");
        const recovery = await Exec.#nearMiss(core, coordinate.pathname);
        return recovery === undefined
            ? failure("stream-not-found", 404, "No execution exists at the requested address.")
            : { failure: Results.failure("scheme:exec", "stream-not-found", 404, "No execution exists at the requested address.", {}, { recovery, retryable: false }) };
    }

    async sendInput(statement: SendStatement, ctx: CoreSchemeCallContext, runtime: string): Promise<SchemeResult> {
        const recipient = await this.#inputRecipient(statement, ctx, runtime);
        if ("failure" in recipient) return recipient.failure;
        const [subscriptionId, entry] = recipient.found;
        const unavailable = entry.input.unavailable();
        if (unavailable !== null) return unavailable;
        const denied = await this.capabilityDenial(entry.invocation, ctx);
        if (denied !== null) return denied;
        return {
            status: 202,
            attrs: { inputSubscription: subscriptionId, inputBody: statement.body?.raw ?? "", inputTarget: statement.target!.raw, effect: entry.effect },
        };
    }

    async applyInput(args: ProposalApplyRequest, ctx: CoreSchemeCallContext, runtime: string): Promise<SchemeResult> {
        const attrs = args.attrs as { inputSubscription?: unknown; inputBody?: unknown; inputTarget?: unknown };
        if (typeof attrs.inputSubscription !== "number" || typeof attrs.inputBody !== "string" || typeof attrs.inputTarget !== "string") {
            throw new InvalidOperationResultError("Execution input proposal is missing its invocation or body.");
        }
        const body = args.body ?? attrs.inputBody;
        const statement: SendStatement = {
            op: "SEND", aside: null, metadata: args.metadata === null ? null : [...args.metadata],
            target: parsePath(attrs.inputTarget), lineMarker: null, body: { raw: body, json: null }, position: { line: 1, column: 1 },
        };
        const recipient = await this.#inputRecipient(statement, ctx, runtime);
        if ("failure" in recipient) return recipient.failure;
        const [subscriptionId, entry] = recipient.found;
        if (subscriptionId !== attrs.inputSubscription) {
            return Results.failure("scheme:exec", "input-closed", 410,
                "The proposed execution input is no longer live.", {}, { retryable: false });
        }
        const denied = await this.capabilityDenial(statement, ctx) ?? await this.capabilityDenial(entry.invocation, ctx);
        if (denied !== null) return denied;
        return entry.input.deliver(body, args.metadata, ctx.signal);
    }

    async applyResolution(
        args: ProposalApplyRequest,
        ctx: CoreSchemeCallContext,
    ): Promise<ApplyOutcome> {
        const core = this.coreContext(ctx);
        const execution = this.#prepareExecution();
        const attrs = args.attrs as Partial<ExecAttrs>;
        const body = typeof attrs.body === "string" ? attrs.body : "";
        const pathname = attrs.pathname;
        const runtime = (typeof attrs.runtime === "string" && attrs.runtime !== "") ? attrs.runtime : "sh";
        const cwd = (typeof attrs.cwd === "string" && attrs.cwd.length > 0) ? attrs.cwd : null;
        let target = (typeof attrs.target === "string" && attrs.target.length > 0) ? attrs.target : null;
        const effect = attrs.effect;
        if (typeof pathname !== "string" || pathname.length === 0) {
            throw new InvalidOperationResultError("The accepted execution proposal is missing its stream pathname.");
        }
        if (!EffectPolicy.isEffect(effect)) {
            throw new InvalidOperationResultError("The accepted execution proposal is missing its canonical effect fact.");
        }
        if (!isExecutionOp(runtime)) {
            throw new InvalidOperationResultError(`The accepted execution proposal names runtime '${runtime}', which is not a runtime tag.`);
        }
        const invocation: ExecStatement = {
            runtime, aside: null, metadata: null,
            target: attrs.resourceSource ? parsePath(attrs.resourceSource) : target === null ? null : parsePath(target),
            lineMarker: null, body, position: { line: 1, column: 1 },
        };

        // {§exec-source-temporary} Admission precedes source realization. Native
        // files retain their environment; only standalone sources need a copy.
        let tempPath: string | null = null;
        if (attrs.resourceSource !== undefined) {
            const realized = await this.#realizeSource(attrs.resourceSource, runtime, core);
            if ("status" in realized) return realized;
            ({ target, tempPath } = realized);
        }
        if (body.length === 0 && target === null) {
            throw new InvalidOperationResultError("The accepted execution proposal has neither a body nor a realized target.");
        }

        const stream = await Exec.#openStreamEntry(core, runtime, pathname);
        if ("status" in stream) return stream;
        const { resolved, entryId } = stream;
        const { subscriptionId, controller, input, lifecycle } = await this.#bindSpawnLifecycle({
            core, attrs, resolved, runtime, body, target, pathname, entryId, effect, invocation,
            inputTimeoutMs: execution.inputTimeoutMs,
        });

        const run = async () => {
            input.started();
            return this.#runExecutor({
                executor: resolved.executor,
                runtime, body, cwd, target, metadata: args.metadata, ctx: core, pathname, coordinate: attrs.coordinate,
                entryId, lifecycle, signal: controller.signal, controller, tempPath, input,
                timeoutSec: typeof attrs.timeoutSec === "number" ? attrs.timeoutSec : null,
            });
        };

        // {§functionality-model-mutation} Configuration is an ordered core operation,
        // not a background job competing for an external-execution slot.
        if (resolved.executor instanceof FunctionalityManager) {
            const tail = run();
            this.#activeSpawns.set(subscriptionId, tail);
            return await tail;
        }

        const admission = execution.scheduler.admit(core.workspaceId, controller.signal);
        const tail = admission.ready.then(async (release) => {
            try { return await run(); }
            finally { release(); }
        });

        // External executions background + stream ({§exec-stream}): the output
        // surfaces as the environment-observation injector's terminal delta (nothing while it runs,
        // one visible READ when it finishes). Pure/read commands still auto-accept
        // from the preserved effect fact; they resolve a turn later, uniformly
        // with host streams.
        this.#activeSpawns.set(subscriptionId, tail);
        void tail.catch((cause: unknown) => { console.error(`Execution '${runtime}' failed to settle:`, cause); });
        return admission.queued
            ? {
                status: 202,
                outcome: "queued",
                result: {
                    executionsAhead: admission.executionsAhead,
                    concurrency: admission.concurrency,
                },
            }
            : { status: 200, outcome: "started" };
    }

    // {§exec-source-temporary} A standalone source read through its own scheme and realized where the executor can
    // run it: a native file is its own path; anything else is written once under the scratch directory
    // ({§exec-scratch-directory}). A failed read stays the owning READ's failure.
    async #realizeSource(resourceSource: string, runtime: string, core: PlurnkSchemeContext): Promise<{ target: string; tempPath: string | null } | ApplyOutcome> {
        const sourceTarget = parsePath(resourceSource);
        if (sourceTarget?.kind !== "url" || sourceTarget.scheme === null || sourceTarget.scheme === "file") {
            throw new InvalidOperationResultError("The accepted execution proposal has an invalid scheme source address.");
        }
        const source = await this.readExecSource({
            op: "READ",
            aside: null,
            target: sourceTarget,
            metadata: null,
            lineMarker: { marks: [1, -1] },
            matcher: null,
            body: null,
            position: { line: 0, column: 0 },
        }, core);
        const read = source.result;
        if (read.status >= 400) {
            // {§exec-target-routing} — the failure stays the owning READ's (#163); the execution
            // contract rides its recovery, because a stream address in the target slot is
            // almost always a command that belonged beneath a targetless heading (#425 F4).
            const problem = read.problem === undefined ? undefined : {
                ...read.problem,
                recovery: Exec.sourceRecovery(resourceSource, read.problem.recovery),
            };
            return Results.assert({ ...read, outcome: "scheme_source_read_failed", ...(problem === undefined ? {} : { problem }) });
        }
        const { content } = read;
        if (typeof content !== "string") {
            return Results.failure(
                "scheme:exec",
                "source-content-unavailable",
                422,
                `Scheme '${sourceTarget.scheme}' did not supply content for the ${runtime} source.`,
                { outcome: "scheme_source_content_unavailable" },
                {
                    scheme: sourceTarget.scheme,
                    sourceStatus: read.status,
                    retryable: false,
                },
            );
        }
        if (source.nativePath !== null) return { target: source.nativePath, tempPath: null };
        const tempPath = this.#sourceScratch(core.hostPaths).path(extname(sourceTarget.pathname)); // {§exec-scratch-directory}
        await writeFile(tempPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        return { target: tempPath, tempPath };
    }

    // Resolve the runtime's executor from the boot registry, then seed the stream entry's channels from its
    // declared topology ({§executor-channels}): each executor declares its own shape (subprocess → stdout/stderr;
    // search → results; etc.).
    static async #openStreamEntry(core: PlurnkSchemeContext, runtime: string, pathname: string): Promise<{ resolved: RegistryEntry; entryId: number } | ApplyOutcome> {
        if (core.executors === undefined) {
            throw new InvalidOperationResultError("An accepted execution proposal has no executor registry.");
        }
        const resolved = core.executors.entry(runtime, core.workspaceId);
        if (resolved === undefined || !resolved.available) {
            throw new InvalidOperationResultError(`The '${runtime}' executor disappeared after its proposal.`);
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
        // {§exec} — the stream entry's scheme IS the runtime tag (sh/js), so it addresses by
        // tag authority (sh:///l/t/s). The engine registers each runtime tag → this handler.
        const { entryId } = await EntryCrud.writeEntry({ authority: "", pathname }, seed, core, runtime, {
            defaultChannel: resolved.executor.defaultChannel, output: true,
        });
        if (entryId === null) {
            return Results.failure("scheme:exec", "stream-entry-write-failed", 500, `The ${runtime} stream entry could not be created.`, {
                outcome: "entry_write_failed",
            }, {
                runtime,
                stage: "stream-creation",
                retryable: false,
            });
        }
        return { resolved, entryId };
    }

    // The spawn's live subscription and cancellation scope: the stream subscription opened, the controller bound
    // to the loop's teardown unless detached ({§exec-lifetime}), the input receiver, the abort registry entry, and
    // the LiveSubscription whose release unbinds them all.
    async #bindSpawnLifecycle(args: {
        core: PlurnkSchemeContext;
        attrs: Partial<ExecAttrs>;
        resolved: RegistryEntry;
        runtime: string;
        body: string;
        target: string | null;
        pathname: string;
        entryId: number;
        effect: Effect;
        invocation: ExecStatement;
        inputTimeoutMs: number;
    }): Promise<{ subscriptionId: number; controller: AbortController; input: ExecutionInput; lifecycle: LiveSubscription }> {
        const { core, attrs, resolved, runtime, body, target, pathname, entryId, effect, invocation, inputTimeoutMs } = args;
        const subscriptionId = await ChannelWrite.openSubscription(core.db, {
            workerId: core.workerId, entryId, scheme: runtime,
            handle: runtime !== "" ? `${runtime}: ${body !== "" ? body : target ?? ""}` : body,
            turnScoped: attrs.turnScoped === true, // {§exec-lifetime} — "turn" is reaped at the next pre-turn
            detached: attrs.detached === true, // {§worker-obligations} — "detached" is nobody's obligation
            publishedChannel: resolved.executor.publishedChannel,
            source: attrs.coordinate === undefined ? undefined
                : `log:///${attrs.coordinate.loop_seq}/${attrs.coordinate.turn_seq}/${attrs.coordinate.sequence}/${runtime}`,
        });

        const controller = new AbortController();
        let detachParent = (): void => {};
        // {§exec-lifetime} — a detached spawn outlives the loop: it never binds to the loop's teardown;
        // only KILL, the worker's total reap, and daemon shutdown end it.
        if (core.signal !== undefined && attrs.detached !== true) {
            const parent = core.signal;
            // {§worker-lifecycle-exec-epoch-bound}
            // The spawn's kill binds to its loop's cancellation epoch (ctx.signal —
            // captured here, stable for the loop). The parent only aborts on FORCEFUL loop
            // teardown — a 202-graceful loop lets its spawns outlive, never firing this — so
            // the reason is always the bounded housekeeping reap. Attach the listener FIRST,
            // then re-check `aborted`: a listener added to an already-aborted signal never
            // fires, so a check-then-attach order LOSES an abort that lands in the gap (R1's
            // TOCTOU leak). Attach-then-check closes it; controller.abort is idempotent, so a
            // doubled fire is harmless. {§exec-lifetime}
            const onParentAbort = (): void => controller.abort(ExecAbort.teardownReason());
            parent.addEventListener("abort", onParentAbort, { once: true });
            detachParent = (): void => parent.removeEventListener("abort", onParentAbort);
            if (parent.aborted) controller.abort(ExecAbort.teardownReason());
        }
        const input = new ExecutionInput(controller.signal, inputTimeoutMs, attrs.input === "open");
        this.#activeAborts.set(subscriptionId, { workspaceId: core.workspaceId, workerId: core.workerId, turnId: core.turnId, pathname, runtime, effect, controller, detached: attrs.detached === true, input, invocation, executor: resolved.executor });
        const lifecycle = new LiveSubscription({
            db: core.db, registry: this.liveSubscriptions(),
            identity: {
                workspaceId: core.workspaceId, workerId: core.workerId, entryId,
                target: `${runtime}://${pathname}`, subscriptionId, scheme: runtime, ...attrs.coordinate,
            },
            handle: { cancel: () => controller.abort(ExecAbort.teardownReason()) },
            reaperLoopId: core.signal !== undefined && attrs.detached !== true ? core.loopId : null,
            release: () => {
                detachParent();
                this.#activeAborts.delete(subscriptionId);
                this.#activeSpawns.delete(subscriptionId);
            },
            notify: core.streamEventNotify, wake: core.wakeWorkerNotify,
        });
        return { subscriptionId, controller, input, lifecycle };
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
    // {§exec-tool-fall-through} — a bare shell command whose program is really the name of a tool
    // of an enabled runtime (`brave_web_search {…}` under the default shell) ends with the shell's
    // exit 127. The receipt states that fact at the failure site, with the tool's own document,
    // so the model recovers in one turn instead of by rereading docs.
    #namedToolFallThrough(result: SchemeResult, runtime: string, body: string, ctx: PlurnkSchemeContext): SchemeResult {
        const core = this.coreContext(ctx);
        const executors = core.executors;
        if (executors === undefined) return result;
        const program = body.trim().split(/\s+/u, 1)[0] ?? "";
        if (program.length === 0) return result;
        const owners = executors.availableRuntimes(core.workspaceId)
            .filter((tag) => tag !== runtime
                && executors.toolRegistry(tag, core.workspaceId)?.tools.some((tool) => tool.target === program) === true);
        if (owners.length === 0) return result;
        const owner = owners[0];
        // The tool's own document, where its family publishes it ({§tools-resource-materialization}).
        const root = executors.entry(owner, core.workspaceId)?.resourcesPath ?? "/plurnk";
        const contract = `worker://${generatedPathname(`${root}/${owner}/${ToolResources.targetSegment(program)}.json`)}`;
        return Results.failure(
            "scheme:exec",
            "program-is-a-tool",
            404,
            `'${runtime}' exited with code 127; \`${program}\` is a registered tool of \`${owner}\`.`,
            { exitCode: 127 },
            {
                runtime,
                stage: "execution",
                recovery: `\`${program}\`'s contract: ${contract}.`,
                toolRuntimes: owners,
                tool: program,
                retryable: false,
            },
        );
    }

    async #runExecutor(opts: {
        executor: Executor;
        runtime: string; body: string; cwd: string | null; target: string | null; metadata: readonly string[] | null; ctx: PlurnkSchemeContext;
        pathname: string; entryId: number; lifecycle: LiveSubscription; signal: AbortSignal;
        coordinate?: StreamCoordinate;
        controller: AbortController; timeoutSec: number | null;
        tempPath: string | null;
        input: ExecutionInput;
    }): Promise<SchemeResult> {
        const { runtime, body, cwd, target, metadata, ctx, pathname, entryId, lifecycle, signal, controller, timeoutSec, tempPath, input, coordinate } = opts;
        // {§functionality-model-projection} — a Core-owned manager acts for the invoking Worker. The
        // framework's ExecArgs carries no Worker identity, so Core binds it here, at the operation.
        const executor = opts.executor instanceof FunctionalityManager ? opts.executor.forWorker(ctx.workerId) : opts.executor;
        const db = ctx.db;
        // an execution's `<T>` — kill the spawn after T seconds. unref'd so a pending timer never
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
        let channelSizes: ReadonlyArray<readonly [string, number]> = [];
        // {§exec-entry-sink} — the executor's entry() sink and the narration turn it owns live in their own owner;
        // this spawn's tail settles them.
        const sink = new ExecEntrySink({
            ctx, runtime, pathname, signal, executor,
            bindEntryAddress: (parsed, context) => this.bindEntryAddress(parsed, context),
            fetchWeb: this.#fetchWeb,
            materializer: this.#materializer,
        });
        const executionFailures: unknown[] = [];
        const cancelled = (exitCode?: number): SchemeResult => Results.failure(
            "scheme:exec",
            "execution-cancelled",
            499,
            `Execution of '${runtime}' was cancelled by the service.`,
            exitCode === undefined ? {} : { exitCode },
            { runtime, stage: "execution", retryable: false },
        );
        try {
            // A cancellation may land while the environment resolves; a listener added to an
            // already-aborted signal never fires, so the run never receives a dead signal.
            const composed = signal.aborted ? null
                : await EnvFunctionality.resolve(
                    db,
                    ctx.workspaceId,
                    ctx.workerId,
                    EnvFunctionality.modifier(metadata),
                    undefined,
                    ctx.hostPaths,
                );
            if (composed !== null) await Exec.#recordEnv(db, entryId, composed.record);
            if (composed === null || signal.aborted) {
                result = cancelled();
            } else try {
                const reported: ExecutorResult = await executor.run({
                    registerInput: (receiver) => input.register(receiver),
                    runtime, body, cwd, target, metadata, signal,
                    entry: sink.entry,
                    // {§executor-interaction-sink} — the executor's signal narrows the execution's, never replaces it.
                    interact: (request, interactionSignal) => {
                        if (ctx.requestInteraction === undefined) {
                            throw new Error("The execution's client interaction capability is unavailable.");
                        }
                        return ctx.requestInteraction(request, interactionSignal === undefined ? signal
                            : AbortSignal.any([signal, interactionSignal]));
                    },
                    env: composed.env,  // SPEC {§exec} {§exec-env-scoped}
                    write: (channel, chunk, mimetype) => enqueue(() => ChannelWrite.appendToChannel(db, {
                        producerWorkerId: ctx.workerId,
                        entryId, channel, chunk, mimetype, notify: ctx.streamEventNotify, coordinate,
                    })),
                    setState: (channel, state: ChannelState) => enqueue(() => ChannelWrite.setChannelState(db, {
                        producerWorkerId: ctx.workerId,
                        entryId, channel, state, notify: ctx.streamEventNotify, coordinate,
                    })),
                    emit: (event) => ctx.pushNotice?.(event),
                });
                input.close();
                // Drain the queue so the subscription doesn't close before
                // final chunk events / state transitions have committed.
                await queue;
                try {
                    result = Results.assertChannelProducerResult(reported);
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
                input.close();
                // {§executor-results} — an abort rejection is not an executor crash.
                if (signal.aborted && (cause === signal.reason || (cause instanceof Error && cause.name === "AbortError"))) {
                    result = cancelled();
                } else {
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
            }

            result = this.#settleExecutionResult({ result, timedOut, timeoutSec, signal, target, runtime, body, ctx });
            // {§exec-conclusion-summary} — the summary sizes the channels this executor declares, in its order.
            channelSizes = await Promise.all(Object.keys(executor.channels).map(async (channel) => [
                channel,
                (await db.channel_meta.get<{ contentLength: number }>({ entry_id: entryId, channel }))?.contentLength ?? 0,
            ] as const));
        } catch (cause) {
            executionFailures.push(cause);
        }
        {
            // {§exec-entry-sink} — the spawn tail settles the entry chain and its narration turn before anything else.
            const finalizationErrors = [...executionFailures, ...await sink.settle()];
            if (timeoutTimer !== null) clearTimeout(timeoutTimer); // a finished spawn leaves no pending timer
            // {§exec-source-temporary} — cleanup cannot rewrite the settled
            // executor result, but an exceptional failure remains observable.
            if (tempPath !== null) {
                await unlink(tempPath).catch((cause: unknown) => {
                    console.error(`Execution source temporary cleanup failed for '${tempPath}':`, cause);
                });
            }
            try {
                await lifecycle.close(result, Exec.#closeSummary(`${runtime}://${pathname}`, result, channelSizes));
            } catch (cause) { finalizationErrors.push(cause); }
            if (finalizationErrors.length === 1) throw finalizationErrors[0];
            if (finalizationErrors.length > 1) {
                throw new AggregateError(finalizationErrors, `Execution narration ${sink.narrationTurnId ?? "unknown"} failed to settle`);
            }
        }
        return result;
    }

    // One valid truth for the settled execution: a timeout outranks the executor's report, the service's own abort
    // knowledge outranks a driver's claim, and a shell's 127 on a tool's name is that tool's refusal
    // ({§exec-tool-fall-through}).
    #settleExecutionResult(args: {
        result: SchemeResult; timedOut: boolean; timeoutSec: number | null; signal: AbortSignal;
        target: string | null; runtime: string; body: string; ctx: PlurnkSchemeContext;
    }): SchemeResult {
        const { timedOut, timeoutSec, signal, target, runtime, body, ctx } = args;
        let { result } = args;
        const cancelled = (exitCode?: number): SchemeResult => Results.failure(
            "scheme:exec",
            "execution-cancelled",
            499,
            `Execution of '${runtime}' was cancelled by the service.`,
            exitCode === undefined ? {} : { exitCode },
            { runtime, stage: "execution", retryable: false },
        );
        const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
        // A timeout aborts the spawn → the executor reports 499; replace the
        // complete result so status and Problem remain one valid truth.
        if (timedOut) {
            const lifetime = formatLifetime(timeoutSec ?? 0);
            result = Results.failure(
                "scheme:exec",
                "execution-timeout",
                504,
                `Execution of '${runtime}' outlived its ${lifetime} lifetime.`,
                exitCode === null ? {} : { exitCode },
                {
                    runtime,
                    lifetime,
                    stage: "execution",
                    retryable: false,
                },
            );
        // The service's own abort knowledge outranks a driver's claim: a
        // spawn we reaped did not succeed, whatever it resolved under abort.
        } else if (signal.aborted && result.status < 400) {
            result = cancelled(exitCode ?? undefined);
        } else if (result.status < 400 && exitCode === 127 && target === null) {
            result = this.#namedToolFallThrough(result, runtime, body, ctx);
        }
        return result;
    }

    // {§exec-conclusion-summary} — the stream's address, how its settled result ended, and each declared channel's size.
    static #closeSummary(address: string, result: SchemeResult, channels: ReadonlyArray<readonly [string, number]>): string {
        const ended = Results.isFailed(result) ? result.problem.title.toLowerCase()
            : typeof result.exitCode === "number" ? `completed (exit ${result.exitCode})` : "completed";
        const sizes = channels.map(([channel, size]) => `${channel}=${size} bytes`).join(", ");
        return `${address} ${ended}${sizes === "" ? "" : `; ${sizes}`}`;
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        return EntryFind.findWorkspaceEntries(statement, core, Exec.manifest, { });
    }

    async readEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<ReadEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx
            ? ctx.entries.read(pathname)
            : EntryCrud.readEntry({ authority: "", pathname }, core, Exec.manifest.name);
    }

    async writeEntry(pathname: string, entry: EntryData, ctx: CoreSchemeCallContext): Promise<WriteEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx
            ? ctx.entries.write(pathname, entry)
            : EntryCrud.writeEntry({ authority: "", pathname }, entry, core, Exec.manifest.name);
    }

    async deleteEntry(pathname: string, ctx: CoreSchemeCallContext): Promise<DeleteEntryResult> {
        const core = this.coreContext(ctx);
        return "entries" in ctx
            ? ctx.entries.delete(pathname)
            : EntryCrud.deleteEntry({ authority: "", pathname }, core, Exec.manifest.name);
    }
}
