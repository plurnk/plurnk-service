import { parsePath } from "@plurnk/plurnk-grammar";
import type { Notice } from "@plurnk/plurnk-contracts";
import type { ExecStatement, FindStatement, ReadStatement } from "@plurnk/plurnk-grammar";
import { Policy, type ChannelState } from "@plurnk/plurnk-execs";
import type { ExecResult as ExecutorResult } from "@plurnk/plurnk-execs";
import { WebFetcher, type WebFetchResult } from "@plurnk/plurnk-schemes-http";
import type { Executor } from "../core/ExecutorRegistry.ts";
import WorkspaceSettings from "../core/workspace-settings.ts";
import EffectPolicy from "./EffectPolicy.ts";
import type { Effect } from "@plurnk/plurnk-execs";
import type { SchemeManifest, PlurnkSchemeContext } from "../core/scheme-types.ts";
import EntryOps from "./_entry-ops.ts";
import EntryCrud from "./_entry-crud.ts";
import Owner from "../core/Owner.ts";
import { foldAuthorityIntoPath } from "../core/plurnk-uri.ts";
import { decodePathParens } from "../core/path-decode.ts";
import EntryFind from "./_entry-find.ts";
import type { ReadResult } from "./_entry-ops.ts";
import type { EntryData, ReadEntryResult, WriteEntryResult, DeleteEntryResult } from "./_entry-crud.ts";
import type { FindResult } from "./_entry-find.ts";
import ChannelWrite, { type StreamCoordinate } from "../core/ChannelWrite.ts";
import ExecEnv from "./exec-env.ts";
import ExecAbort from "./exec-abort.ts";
import { renderAddress } from "../core/plurnk-uri.ts";
import { writeFile, unlink, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CoreSchemeAdapterBase } from "../core/CoreSchemeServices.ts";
import type { CoreSchemeCallContext } from "../core/CoreSchemeServices.ts";
import Results, { type SchemeResult, type SchemeResultBase } from "../core/results.ts";

type ExecResult = SchemeResultBase & { body?: string; attrs?: object };

interface ExecAttrs {
    runtime: string;        // "" (default shell), "sh", "bash", "node", "python", etc.
    cwd: string | null;     // process working directory = the workspace workspace (project_root), or null (headless). A relative target resolves against it. (execs 0.4.26 §2)
    target: string | null;  // the parsed (target) slot — the executor's DATA SOURCE (jq input file / sqlite db / wasm module); null = no source (subprocess ignores it). (#15)
    command: string;        // body of the EXEC op
    pathname: string;       // stamped by Dispatcher.#writeLog as /<loop>/<turn>/<seq>; entry persists under the RUNTIME TAG scheme — <runtime>:///<pathname> (e.g. sh:///1/1/2), §exec/#240. exec:// is process-control only.
    inline?: boolean;       // effect=read/pure → auto-run (no human gate); output streams like any exec
    schemeTarget?: { scheme: string; pathname: string; fragment: string | null };  // #201 — a plurnk-scheme target resolved to content at apply-time (empty body → run-as-command; non-empty body → temp-materialize to cwd)
    timeoutSec?: number;    // `<T,P>` mark[0] > 0: kill the spawn after T seconds (504). Absent/-1 = unbounded.
    turnScoped?: boolean;   // `<0>`: turn-scoped — reaped at the worker's next pre-turn, never surviving into the subsequent turn. {§exec-poll}
    pollSec?: number;       // `<T,P>` mark[1]: while the loop hibernates (202), wake it every P seconds to check this stream. Absent/≤0 = no poll-wake. {§exec-poll}
}

// Executors are discovered + probed at boot into ExecutorRegistry and reach
// the scheme through ctx.executors (plurnk-service#181). Each runtime tag
// resolves to its sibling executor; the scheme itself stays runtime-agnostic.

// The local path a subprocess EXEC's `(target)` slot names — a bare local path or a file:/// URL (both
// decode to a filesystem path). Stat-routed at dispatch (#462): a directory becomes cwd, a file is the
// program/data-source. A plurnk-scheme target is NOT local — schemeTargetOf handles that.
const localPathFromTarget = (target: ExecStatement["target"]): string | null => {
    if (target === null) return null;
    if (target.kind === "local") return target.raw;
    if (target.kind === "url" && (target.scheme === null || target.scheme === "file")) {
        return target.pathname;
    }
    return null;
};

// #201 — a plurnk-scheme target (known/exec/log/…), distinct from file/local
// (which localPathFromTarget handles as a path). Its content is resolved at apply-time;
// executors stay scheme-blind (SPEC §5), so the scheme — not the executor — reads it.
const schemeTargetOf = (target: ExecStatement["target"]): { scheme: string; pathname: string; fragment: string | null } | null => {
    if (target === null || target.kind !== "url") return null;
    if (target.scheme === null || target.scheme === "file") return null;
    return { scheme: target.scheme, pathname: target.pathname, fragment: target.fragment };
};

// EXEC's pathname is <runtime>/<loop_seq>/<turn_seq>/<sequence> (stamped by
// Dispatcher.#writeLog). Exec owns this convention, so it — not the client — turns
// the pathname into the entry's coordinate, mirrored onto stream payloads so
// waterfall clients read fields instead of parsing the URI (#224). The
// coordinate is the trailing three segments (runtime-agnostic); a pathname that
// isn't a numeric triple yields undefined (no coordinate on the wire).
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
// streams need no qualifier, so a fan-out sibling's identical coordinate can never be yours (#526).
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

// §exec-entry-sink / #455 — the guarded web-fetch the sink calls when the executor hands content:null:
// schemes-http's WebFetcher (SSRF-guarded byte acquisition + lazy browser
// fallback, dead-as-null). Injectable because the guard refuses localhost.
export type WebFetch = (url: string, opts?: { signal?: AbortSignal }) => Promise<WebFetchResult | null>;

export default class Exec extends CoreSchemeAdapterBase {
    static manifest: SchemeManifest = {
        name: "exec",
        channels: { stdout: "text/stream", stderr: "text/stream" },
        defaultChannel: "stdout",
        category: "data",
        scope: "workspace",
        writableBy: ["model", "client"],
        volatile: true,
        modelVisible: true,
        example: "<<EXEC[sqlite]:SELECT 22.0 / 7.0:EXEC",
        documentation: "Runs a command in a runtime — `<<EXEC[runtime](cwd):command:EXEC` — output streams into the worker's `<runtime>:///<loop>/<turn>/<seq>` entry on the runtime's own channels (a subprocess → stdout/stderr; a computational runtime like sqlite/jq → a JSON `results` channel). A host-effecting command proposes for review before it runs; a read-only/pure one runs ungated. Either way you never fetch the output: the engine surfaces each turn's new stream bytes to you automatically — folded while the command runs, opened when it finishes.",
        flags: {
            excludedInAsk: true,
        },
    };

    // The web-fetch the entry sink calls on content:null (§exec-entry-sink / #455). Default = schemes-http's
    // guarded WebFetcher over one warm-Chromium pool shared across this handler's
    // fallback renders; injectable so tests substitute the network.
    readonly #fetchWeb: WebFetch;
    readonly #closeWebFetcher: () => Promise<void>;
    constructor(fetchWeb?: WebFetch) {
        super();
        const webFetcher = new WebFetcher();
        if (fetchWeb === undefined) {
            this.#fetchWeb = (url, opts) => webFetcher.fetch(url, opts);
            this.#closeWebFetcher = () => webFetcher.close();
        } else {
            this.#fetchWeb = fetchWeb;
            this.#closeWebFetcher = async () => {};
        }
    }

    #activeAborts = new Map<number, { workerId: number; pathname: string; runtime: string; effect: Effect; controller: AbortController; unlink: () => void }>();
    #activeSpawns = new Map<number, Promise<SchemeResult>>();

    async idle(): Promise<void> {
        await Promise.allSettled([...this.#activeSpawns.values()]);
        await this.#closeWebFetcher();
    }

    // Whether the worker has an in-flight spawn (a background exec). The daemon
    // reads this only for loop.cancel's cancelled=true/false answer — the
    // teardown itself rides the worker's cancellation scope (the spawn's
    // ctx.signal), so even a spawn registering after the cancel self-aborts.
    hasActiveSpawns(workerId: number): boolean {
        for (const { workerId: r } of this.#activeAborts.values()) if (r === workerId) return true;
        return false;
    }

    // §exec-hold-until-concluded — does the worker hold an in-flight spawn whose RUNTIME is in the
    // operator's hold set? The turn-hold exception (owner ruling): for streams we know and
    // control (the search family — one final JSON digest, seconds-bounded), the engine holds
    // the next packet until conclusion instead of giving the model a turn it can only waste.
    hasActiveHoldSpawns(workerId: number, holdSet: ReadonlySet<string>): boolean {
        for (const { workerId: r, runtime, effect } of this.#activeAborts.values()) if (r === workerId && (holdSet.has(runtime) || holdSet.has(`${runtime}:${effect}`))) return true;
        return false;
    }

    // Process-KILL (plurnk-service#203). A running (host/background) exec is
    // addressable by its coordinate pathname; KILL aborts that spawn's controller with
    // the model's signal — KILL[code] → exactly that signal once (KILL[9] = SIGKILL), a
    // bare KILL → the executor's SIGHUP default. The model owns escalation, so there
    // is no auto-escalation here. The full #203 status matrix: 200 killed (in-flight) · 410
    // killed-earlier (a prior abort closed the stream 499) · 409 already-terminal
    // (closed with any other terminal status) · 404 unknown.
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
        // internal `exec` scheme (#527, {§fs-answer-in-canon}) — the model KILLs what it addressed.
        const terminal = await ChannelWrite.execTerminalStatus(core.db, {
            workspaceId: core.workspaceId,
            workerId: core.workerId,
            scheme,
            pathname,
        });
        if (terminal === null) return Results.failure("scheme:exec", "stream-not-found", 404, `No stream exists at ${scheme}://${pathname}.`);
        if (terminal === 499) return Results.failure("scheme:exec", "stream-already-killed", 410, `${scheme}://${pathname} was killed earlier.`);
        return Results.failure(
            "scheme:exec",
            "stream-already-terminal",
            409,
            `${scheme}://${pathname} already concluded with status ${terminal}.`,
            {},
            { terminalStatus: terminal },
        );
    }

    // EXEC op handler — the actual model-facing entry point per plurnk.md.
    // `<<EXEC[runtime](cwd):command:EXEC` →
    //   signal=runtime, target=cwd (ParsedPath local/file or null), body=command.
    //
    // Proposes (status=202) with attrs={runtime, cwd, command, pathname}.
    // applyResolution spawns the subprocess; output streams into the
    // coordinate-stamped <runtime>:///<pathname> entry's stdout/stderr channels
    // (e.g. sh:///1/1/2, §exec/#240). The model READs that entry on a subsequent turn.
    async exec(statement: ExecStatement, ctx: CoreSchemeCallContext): Promise<ExecResult> {
        const core = this.coreContext(ctx);
        let command = statement.body ?? "";
        // #201 — a plurnk-scheme target carries content the scheme resolves at
        // apply-time; an empty body is then legal (the target IS the script).
        const schemeTarget = schemeTargetOf(statement.target);
        // #462 — stat-route the local (target): a DIRECTORY overrides cwd (run the body IN it); a FILE is
        // the program/data-source the executor runs (body = stdin). A stat-miss falls to the file arm so the
        // runtime reports its own not-found, never a dispatch 400. cwd otherwise = the workspace workspace
        // (project_root) — the directory File writes to, and what a data-source target resolves against.
        const workspaceRow = await core.db.envelope_get_workspace.get<{ project_root: string | null }>({ id: core.workspaceId });
        const projectRoot = workspaceRow?.project_root ?? null;
        const localTarget = localPathFromTarget(statement.target);
        let routedTarget = localTarget;
        let cwd: string | null = projectRoot;
        if (localTarget !== null) {
            const abs = projectRoot !== null ? resolve(projectRoot, localTarget) : localTarget;
            try { if ((await stat(abs)).isDirectory()) { cwd = abs; routedTarget = null; } } catch { /* stat-miss → file arm; the runtime reports its own not-found */ }
        }
        // Empty body is legal when the target IS the program: a #201 scheme target (the target is the
        // script) or a #462 FILE target (run it, no stdin). Empty body with a directory target (nothing
        // to run) or no target at all → 400.
        if (command.length === 0 && schemeTarget === null && routedTarget === null) {
            return Results.failure("scheme:exec", "command-required", 400, "EXEC requires a command body or a scheme target to run.") as ExecResult;
        }

        const requested = typeof statement.signal === "string" ? statement.signal : "";
        const runtime = requested === "" ? "sh" : requested; // empty signal = default shell
        if (core.executors === undefined) throw new Error("exec dispatched without an executor registry");
        const workspaceExecs = (await WorkspaceSettings.read(core.db, core.workspaceId)).execs;
        // §exec-registry-resolves — a non-empty tag selects exactly one registered executable
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
                `\`${runtime}\` is not a registered executable tool. Use a registered tag, or run complete shell commands with bare EXEC or EXEC[sh]. Available to this workspace: ${available.join(", ") || "(none)"}.`,
            ) as ExecResult;
        }
        // #328 — per-workspace client policy narrows the boot-registered set (subtractive). A tag the
        // workspace's client layer disables is ABSENT for this workspace — refused like an unavailable
        // runtime. Bare EXEC resolves to sh before this gate, so disabling sh also disables the default.
        if (workspaceExecs !== null && !Policy.isEnabled(runtime, workspaceExecs)) {
            return Results.failure("scheme:exec", "runtime-disabled", 501, `\`${runtime}\` is disabled for this workspace by client policy (PLURNK_EXECS_*).`) as ExecResult;
        }
        if (!resolved.available) {
            const why = resolved.detail === undefined ? "" : `: ${resolved.detail}`;
            return Results.failure("scheme:exec", "runtime-unavailable", 501, `\`${runtime}\` is unavailable${why}.`) as ExecResult;
        }
        // The (target) slot the executor receives — its DATA SOURCE / program (jq input, sqlite db, or a
        // subprocess program run with the body as stdin; #15). A #462 directory target routed to cwd above
        // leaves this null (the body is the command, run in that directory).
        const target = routedTarget;
        // Effect classifies by the target only, never by parsing the command (#289): host → propose,
        // read/pure → auto-run inline (plurnk-service#182).
        const policy = EffectPolicy.decide(resolved.executor.effect(target, command));
        // cwd is the workspace WORKSPACE (project_root) — the directory File writes to and a relative
        // data-source target resolves against (execs 0.4.26 §2) — UNLESS a #462 directory target overrode
        // it above, in which case the body runs in that directory. A file/data-source target never moves cwd.
        // Pathname is assigned by Dispatcher.#writeLog as <runtime>/<loop_seq>/
        // <turn_seq>/<sequence> (executor-domain + coordinate, e.g. sh/1/1/2).
        // `pathname` is stamped into attrs at log-write time; applyResolution
        // reads it back here.
        // EXEC repurposes the `<L>` slot as `<timeout, poll>` (seconds): mark[0] caps the spawn's
        // lifetime, mark[1] sets the hibernation poll-wake cadence (§exec-poll). N>0 → deadline (504);
        // -1 / absent → unbounded (loop-life bounded); 0 → turn-scoped (reaped at the next pre-turn,
        // never surviving into the subsequent turn).
        const marks = statement.lineMarker?.marks;
        const timeoutSec = typeof marks?.[0] === "number" && marks[0] > 0 ? Math.floor(marks[0]) : undefined;
        const turnScoped = typeof marks?.[0] === "number" && marks[0] === 0;
        const pollSec = typeof marks?.[1] === "number" && marks[1] > 0 ? Math.floor(marks[1]) : undefined;
        const attrs: ExecAttrs = {
            runtime, cwd, command, target, pathname: "", inline: policy === "auto",
            ...(schemeTarget !== null ? { schemeTarget } : {}),
            ...(timeoutSec !== undefined ? { timeoutSec } : {}),
            ...(turnScoped ? { turnScoped: true } : {}),
            ...(pollSec !== undefined ? { pollSec } : {}),
        };
        // Body shown to client during proposal review — `$ command` is the
        // most-readable summary regardless of runtime.
        const preview = runtime !== "" ? `[${runtime}] ${command}` : `$ ${command}`;
        return { status: 202, body: preview, attrs };  // host runtime proposes with 202 — §exec-host-proposes
    }

    async applyResolution(
        args: { attrs: object; body?: string },
        ctx: CoreSchemeCallContext,
    ): Promise<SchemeResultBase & { outcome?: string; body?: string }> {
        const core = this.coreContext(ctx);
        const attrs = args.attrs as Partial<ExecAttrs>;
        let command = typeof attrs.command === "string" ? attrs.command : "";
        const pathname = attrs.pathname;
        const runtime = (typeof attrs.runtime === "string" && attrs.runtime !== "") ? attrs.runtime : "sh";
        const cwd = (typeof attrs.cwd === "string" && attrs.cwd.length > 0) ? attrs.cwd : null;
        let target = (typeof attrs.target === "string" && attrs.target.length > 0) ? attrs.target : null;
        if (typeof pathname !== "string" || pathname.length === 0) {
            return Results.failure("scheme:exec", "stream-path-missing", 500, "The accepted EXEC proposal is missing its stream pathname.", {
                outcome: "missing_pathname",
            });
        }

        // #201 — resolve a scheme-URI target to content (executors stay scheme-blind).
        // Empty body → the resolved content IS the command (run a stored script).
        // Non-empty body → materialize the content to a temp file whose path becomes
        // the runtime's data-source TARGET (the input for filters/sqlite/wasm).
        let tempPath: string | null = null;
        if (attrs.schemeTarget !== undefined) {
            const { scheme, pathname: tPath, fragment } = attrs.schemeTarget;
            const read = await EntryCrud.readEntry(tPath, core, scheme);
            if (read.entry === null) {
                return Results.failure("scheme:exec", "scheme-target-not-found", 404, read.problem?.detail ?? `No entry exists at ${scheme}://${tPath}.`, {
                    outcome: "scheme_target_not_found",
                });
            }
            const channels = read.entry.channels;
            const channelName = fragment ?? (channels.body !== undefined ? "body" : Object.keys(channels)[0]);
            const content = channelName === undefined ? undefined : channels[channelName]?.content;
            // §channel-selection-unknown-channel-400 sibling fact — the miss names what exists.
            if (content === undefined) {
                return Results.failure(
                    "scheme:exec",
                    "scheme-target-channel-not-found",
                    404,
                    `No channel #${channelName ?? fragment} exists at ${scheme}:///${tPath.replace(/^\//, "")}; channels: ${Object.keys(channels).join(", ")}.`,
                    { outcome: "scheme_target_channel_not_found" },
                );
            }
            if (command.length === 0) {
                command = content;
            } else {
                tempPath = join(tmpdir(), `plurnk-exec-${core.workspaceId}-${pathname.replace(/[^a-zA-Z0-9]/g, "-")}`);
                await writeFile(tempPath, content, "utf8");
                target = tempPath;
            }
        }
        // #500 — the accept-half mirrors the propose-half's #462 stat-route: an empty body with a
        // LOCAL FILE target is legal (the target IS the program — the executor runs it as its script
        // positional, transient exec per the owner ruling). Empty body with no target of any kind
        // remains the contradiction.
        if (command.length === 0 && target === null) {
            return Results.failure("scheme:exec", "command-missing", 500, "The accepted EXEC proposal has neither a command nor a target.", {
                outcome: "missing_command",
            });
        }

        // Resolve the runtime's executor from the boot registry, then seed
        // channels from its declared topology (Q1(b) in plurnk-service#174 —
        // executor declares, scheme honors). Each executor declares its own
        // shape (subprocess → stdout/stderr; search → results; etc.).
        if (core.executors === undefined) {
            return Results.failure("scheme:exec", "executor-registry-missing", 500, "The executor registry is unavailable.", {
                outcome: "no_executor_registry",
            });
        }
        const resolved = core.executors.entry(runtime);
        if (resolved === undefined) {
            return Results.failure("scheme:exec", "executor-missing", 500, `The '${runtime}' executor disappeared after proposal.`, {
                outcome: "no_executor",
            });
        }
        // #485 — the per-tool effect (execs Effect: read/host/pure) rides the hold predicate so a
        // suffixed PLURNK_SERVICE_EXEC_HOLD entry (`github:read`) can hold one tool-class and not another.
        const effect = resolved.executor.effect(target, command);
        const seedChannels: EntryData["channels"] = {};
        for (const [name, decl] of Object.entries(resolved.executor.channels)) {
            seedChannels[name] = {
                content: "",
                mimetype: decl.mimetype,
                state: decl.defaultState ?? "active",
            };
        }
        const seed: EntryData = { channels: seedChannels, tags: [] };
        // §exec — the stream entry's scheme IS the runtime tag (sh/node), so it addresses by
        // tag authority (sh:///l/t/s). The engine registers each runtime tag → this handler.
        const { entryId } = await EntryCrud.writeEntry(pathname, seed, core, runtime, core.workerId);
        if (entryId === null) {
            return Results.failure("scheme:exec", "stream-entry-write-failed", 500, `The ${runtime} stream entry could not be created.`, {
                outcome: "entry_write_failed",
            });
        }

        const subscriptionId = await ChannelWrite.openSubscription(core.db, {
            workerId: core.workerId, entryId, scheme: runtime,
            handle: runtime !== "" ? `${runtime}: ${command}` : command,
            pollSeconds: typeof attrs.pollSec === "number" ? attrs.pollSec : null, // §exec-poll — hibernation wake cadence
            turnScoped: attrs.turnScoped === true, // §exec-poll — `<0>` reaped at the next pre-turn
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
            // doubled fire is harmless. §exec-timeout
            const onParentAbort = (): void => controller.abort(ExecAbort.teardownReason());
            parent.addEventListener("abort", onParentAbort, { once: true });
            unlink = (): void => parent.removeEventListener("abort", onParentAbort);
            if (parent.aborted) controller.abort(ExecAbort.teardownReason());
        }
        this.#activeAborts.set(subscriptionId, { workerId: core.workerId, pathname, runtime, effect, controller, unlink });
        this.liveSubscriptions().register(subscriptionId, {
            cancel: () => controller.abort(ExecAbort.teardownReason()),
        });

        const tail = this.#runExecutor({
            executor: resolved.executor,
            runtime, command, cwd, target, ctx: core, pathname,
            entryId, subscriptionId, signal: controller.signal, controller, tempPath,
            timeoutSec: typeof attrs.timeoutSec === "number" ? attrs.timeoutSec : null,
        });

        // Every exec backgrounds + streams (§exec-stream): no same-turn receipt — the output
        // surfaces as the environment-observation injector's delta on the next turn (folded while
        // it runs, opened when it finishes). Pure/read commands still auto-accept (attrs.inline =
        // no human gate); they just resolve a turn later, uniformly with host streams.
        this.#activeSpawns.set(subscriptionId, tail);
        return { status: 200, outcome: "started" };
    }

    // Bridge the executor's sink-style contract (write/setState/emit)
    // onto plurnk-service's storage primitives (appendToChannel,
    // setChannelState, ctx.pushNotice). Per plurnk-service#174 Q3,
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
        runtime: string; command: string; cwd: string | null; target: string | null; ctx: PlurnkSchemeContext;
        pathname: string; entryId: number; subscriptionId: number; signal: AbortSignal;
        controller: AbortController; timeoutSec: number | null;
        tempPath: string | null;
    }): Promise<SchemeResult> {
        const { executor, runtime, command, cwd, target, ctx, pathname, entryId, subscriptionId, signal, controller, timeoutSec, tempPath } = opts;
        const db = ctx.db;
        const coordinate = coordinateFromPathname(pathname);  // #224 — stamped on stream/event + stream/concluded
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
        );
        let exitLabel = "did not conclude";
        let stdoutLength = 0;
        let stderrLength = 0;
        // §exec-entry-sink (#340) — the executor's entry() materialization request. The executor
        // owns zero substrate: it hands us (path, content, {tags, mimetype}) and WE create/update
        // the entry (writeEntry upsert; tags UNIONED — writeEntry alone replaces), then narrate ONE
        // EDIT row in the reserved plurnk worker's log (the fs-fiction pattern, source = the calling
        // run) — the existing env-delta ambience folds it into every worker's next packet. The row is a
        // FULL fiction: tx carries the statement (body = the written content — the journal records
        // the write, replay/fork-complete), rx carries the span (§edit-result-render, the whole
        // content numbered — a wholesale write's span IS the content; no diff, which would be a
        // pathological cost against a rewritten multi-MB page). Rendered folded by default, so no
        // body rides a packet uninvited — the meta line carries the honest OPEN weight.
        // Serialized: parallel entry() calls (allSettled) write in order; a rejection prunes that
        // survivor executor-side without breaking the chain. Lazy narration context: one plurnk-run
        // turn per spawn, not per entry.
        let entryChain: Promise<unknown> = Promise.resolve();
        let narration: { workerId: number; loopId: number; turnId: number; seq: number } | null = null;
        const entrySink = (path: string, content: string | null, opts: { tags: string[]; mimetype?: string }): Promise<string> => {
            const parsed = parsePath(path);
            if (parsed === null || parsed.kind !== "url" || parsed.scheme === null) return Promise.reject(new Error(`entry(): '${path.slice(0, 80)}' is not a URL`));
            if (content !== null && opts.mimetype === undefined) return Promise.reject(new Error("entry(): mimetype is required when content is provided"));
            // §exec-entry-sink / #455 — content:null ⇒ core fetches the page through schemes-http's guarded
            // primitive. The fetch STARTS HERE, OFF the write-serialization chain, so concurrent entry() calls
            // fetch in PARALLEL (owner ruling: search fetches must not freeze the agent); only the entry WRITE
            // serializes on entryChain (db-write ordering). A null fetch is dead (guard-refused / unreachable /
            // non-2xx / non-textual / empty) and REJECTS, so the executor prunes that survivor. Non-null content
            // is the materialize-given-body path — the caller already holds the bytes and states their mimetype.
            const materialized: Promise<WebFetchResult | null> = content === null
                ? this.#fetchWeb(path, { signal })
                : Promise.resolve({ body: content, mimetype: opts.mimetype as string });
            const op = async (): Promise<string> => {
                const fetched = await materialized;
                if (fetched === null) throw new Error(`entry(): '${path.slice(0, 80)}' is dead`);
                let { body, mimetype } = fetched;
                // External URLs arrive in transport-safe spelling, while entry identity uses
                // the grammar's canonical resolved path. Store the decoded identity; renderers
                // encode parentheses again when the address returns to the model.
                const pathname = decodePathParens(foldAuthorityIntoPath(parsed.hostname, parsed.pathname));
                const prior = await EntryCrud.readEntry(pathname, ctx, parsed.scheme);
                const tags = [...new Set([...(prior.entry?.tags ?? []), ...opts.tags])];
                // The web-fetch entry point: a fetched html page stores the handler's readable
                // projection as the decisive `body` (text/markdown — what READ serves, FIND matches,
                // FTS indexes, every weight reports) with the raw page under `html` (xpath + archive).
                // Scoped HERE, not writeEntry: only auto-fetched web content projects; authored files
                // stay verbatim (a `<user email=…>` roster's attribute data must survive a default READ).
                let channels: EntryData["channels"] = { body: { content: body, mimetype } };
                if (fetched.header !== undefined) channels.header = { content: fetched.header, mimetype: "text/plain" };
                let decisive = body;
                if (mimetype === "text/html") {
                    if (ctx.mimetypes === undefined) throw new Error("entry(): HTML materialization requires the mimetype registry");
                    let projected = (await ctx.mimetypes.process({ content: body, hint: "text/html" }, { channels: ["content"] })).content;
                    if ((typeof projected !== "string" || projected.length === 0) && fetched.render !== undefined) {
                        const rendered = await fetched.render();
                        if (rendered !== null) {
                            body = rendered.body;
                            mimetype = rendered.mimetype;
                            projected = (await ctx.mimetypes.process({ content: body, hint: "text/html" }, { channels: ["content"] })).content;
                        }
                    }
                    if (typeof projected !== "string" || projected.length === 0) {
                        throw new Error(`entry(): '${path.slice(0, 80)}' has no readable HTML projection`);
                    }
                    channels = {
                        body: { content: projected, mimetype: "text/markdown" },
                        html: { content: body, mimetype },
                        ...(fetched.header === undefined ? {} : { header: { content: fetched.header, mimetype: "text/plain" } }),
                    };
                    decisive = projected;
                }
                const written = await EntryCrud.writeEntry(pathname, { channels, tags }, ctx, parsed.scheme);
                if (narration === null) {
                    const run = await db.envelope_get_worker_by_name.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: "plurnk" })
                        ?? await db.envelope_insert_worker.get<{ id: number }>({ workspace_id: ctx.workspaceId, name: "plurnk", origin: "plurnk" });
                    if (run === undefined) throw new Error("entry(): plurnk worker resolution returned no row");
                    const loop = await db.envelope_insert_client_loop.get<{ id: number }>({ worker_id: run.id });
                    if (loop === undefined) throw new Error("entry(): loop insert returned no row");
                    const seqRow = await db.client_turn_next_sequence.get<{ next: number }>({ loop_id: loop.id });
                    const turn = await db.client_turn_insert.get<{ id: number }>({ loop_id: loop.id, sequence: seqRow?.next ?? 1, packet: "{}" });
                    if (turn === undefined) throw new Error("entry(): turn insert returned no row");
                    narration = { workerId: run.id, loopId: loop.id, turnId: turn.id, seq: 1 };
                }
                await db.engine_insert_log_entry.get({
                    worker_id: narration.workerId, loop_id: narration.loopId, turn_id: narration.turnId, sequence: narration.seq++,
                    // signal carries the tags — the SAME slot a model's EDIT[tags] uses, so the
                    // ambient row renders its tags natively everywhere (packet meta line, digest).
                    origin: "plurnk", source: String(ctx.workerId), op: "EDIT", suffix: "", signal: JSON.stringify(tags),
                    scheme: parsed.scheme, username: null, password: null, hostname: null, port: null,
                    pathname, params: null, fragment: null, lineMarker: null,
                    tx: JSON.stringify({ op: "EDIT", body }), mimetype_tx: "application/json",
                    rx: JSON.stringify({
                        status: written.status, entryId: written.entryId, tags,
                        span: decisive.split("\n").map((l, n) => `${n + 1}:${l}`).join("\n"),
                    }), mimetype_rx: "application/json",
                    status_rx: written.status, tokens: ctx.tokenize?.(decisive) ?? 0, state: "resolved", outcome: null,
                    // Durable provenance for clients/forensics. This is machine
                    // ambience, not a human/model action waterfall item.
                    attrs: JSON.stringify({ tags, kind: "entry_materialized" }),
                });
                return renderAddress(parsed.scheme, pathname);
            };
            const run = entryChain.then(op, op);
            entryChain = run.then(() => undefined, () => undefined);
            return run;
        };
        try {
            try {
                const reported: ExecutorResult = await executor.run({
                    runtime, command, cwd, target, signal,
                    entry: entrySink,
                    env: ExecEnv.scoped(),  // SPEC §exec {§exec-env-scoped} — never plurnk's own secrets
                    write: (channel, chunk) => enqueue(() => ChannelWrite.appendToChannel(db, {
                        entryId, channel, chunk, notify: ctx.streamEventNotify, coordinate,
                    })),
                    setState: (channel, state: ChannelState) => enqueue(() => ChannelWrite.setChannelState(db, {
                        entryId, channel, state, notify: ctx.streamEventNotify, coordinate,
                    })),
                    emit: (event) => {
                        // The executor plugin's Notice predates grammar's required `level`;
                        // inject a default (forwarding the producer's own severity when it supplies one). #276
                        const level = (event as { level?: Notice["level"] }).level ?? "info";
                        ctx.pushNotice?.({ ...event, level } as Notice);
                    },
                });
                // Drain the queue so the subscription doesn't close before
                // final chunk events / state transitions have committed.
                await queue;
                try {
                    result = Results.assert(reported);
                } catch (cause) {
                    result = Results.failure(
                        "scheme:exec",
                        "executor-invalid-result",
                        500,
                        `The '${runtime}' executor returned an invalid operation result: ${cause instanceof Error ? cause.message : String(cause)}`,
                    );
                }
            } catch (cause) {
                // A rejecting driver must still CONCLUDE its stream — uncaught, the subscription sat
                // open forever and the floating spawn promise was an unhandled rejection.
                result = Results.failure(
                    "scheme:exec",
                    "executor-threw",
                    500,
                    `The '${runtime}' executor threw: ${cause instanceof Error ? cause.message : String(cause)}`,
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
                    { runtime, timeoutSeconds: timeoutSec },
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
                    { runtime },
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
            // §exec-entry-sink — drain the entry()/narration writes so the tail (hence idle()) is a
            // COMPLETE quiescence barrier: a consumer woken below, or a teardown awaiting idle(), must
            // not race an in-flight entry() write into a closing db (#432 teardown race). Each op is
            // enqueued as `.then(op, op)`, so entryChain never rejects — awaiting it in finally is safe.
            await entryChain;
            if (timeoutTimer !== null) clearTimeout(timeoutTimer); // a finished spawn leaves no pending timer
            // #201 — a materialized data-source temp file outlives the spawn it fed;
            // unlink it once the worker settles (open-unlink is safe on Linux).
            if (tempPath !== null) await unlink(tempPath).catch(() => {});
            this.#activeAborts.get(subscriptionId)?.unlink();
            this.#activeAborts.delete(subscriptionId);
            this.liveSubscriptions().unregister(subscriptionId);
            this.#activeSpawns.delete(subscriptionId);

            // Every worker backgrounds now (§exec-stream) — wake a parked loop on completion so the
            // run resumes to the turn where the stream's terminal delta surfaces.
            if (ctx.wakeWorkerNotify !== undefined) {
                ctx.wakeWorkerNotify({
                    workspaceId: ctx.workspaceId, workerId: ctx.workerId,
                    entryId, target: `${runtime}://${pathname}`, subscriptionId, result,
                    scheme: runtime,
                    summary: `${runtime}://${pathname} completed (${exitLabel}); stdout=${stdoutLength} bytes, stderr=${stderrLength} bytes`,
                    ...coordinate,
                });
            }
        }
        return result;
    }

    async read(statement: ReadStatement, ctx: CoreSchemeCallContext): Promise<ReadResult> {
        const core = this.coreContext(ctx);
        const owner = await resolveStreamStatement(statement, core);
        if (owner === null) {
            return Results.failure("scheme:exec", "stream-not-found", 404, "No visible stream exists at the requested address.", {
                content: null, mimetype: null, channel: null,
            }) as ReadResult;
        }
        return EntryOps.readWorkspaceEntry(owner.statement, core, Exec.manifest, owner.ownerId);
    }

    async find(statement: FindStatement, ctx: CoreSchemeCallContext): Promise<FindResult> {
        const core = this.coreContext(ctx);
        const owner = await resolveStreamStatement(statement, core);
        if (owner === null) {
            return Results.failure("scheme:exec", "stream-not-found", 404, "No visible stream exists at the requested address.", {
                content: null, mimetype: null, results: [], itemsTokenTotal: 0, pathnames: [], matches: [],
            }) as FindResult;
        }
        return EntryFind.findWorkspaceEntries(owner.statement, core, Exec.manifest, owner.ownerId);
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
