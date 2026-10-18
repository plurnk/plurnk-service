// Shared harness for the live + demo tiers — the ones that drive a REAL model.
// Both tiers run the SAME prod loop production runs: boot the real Daemon,
// create a workspace, fire loop.run, await loop/terminated. The ONLY things that
// vary from the deterministic intg tier are the provider (a real one here, a
// Mock there) and tasteful .env tunings. There is no engine reconstruction —
// executors, the system prompt, and doc materialization all come from loop.run.
//
// liveWorkspace boots + holds the workspace (db stays open for post-loop forensic
// asserts); liveLoop is the single loop-driver (always loop-auto, the live/demo
// stance). Everything funnels through these two so the tier has exactly one path.

import { after } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { benchmarksRoot, tierRunPath } from "../../scripts/lib/test-artifacts.ts";
import { join } from "node:path";
import type SeamSocket from "./intg/_seam.ts";
import { resolveActiveRoute } from "@plurnk/plurnk-providers";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../src/core/ProviderInstantiate.ts";
import { contentWeight } from "../src/core/content-weight.ts";
import EntryCrud from "../src/schemes/_entry-crud.ts";
import Daemon from "../src/server/Daemon.ts";
import HostPaths from "../src/core/HostPaths.ts";
import type { Db } from "../src/core/Db.ts";
import { openMigrated } from "./intg/_db.ts";
import { lastReply } from "./intg/_packet.ts";
import { connect, rpcCall, runLoopToTerminal, WaitTimeoutError } from "./intg/_rpc.ts";
import { Digest } from "@plurnk/plurnk-digest";
import EvidenceReader from "@plurnk/plurnk-service/evidence";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { failAfterCleanup } from "./live-failure.ts";
import { currentSpecimen, type LiveSpecimen, liveTimeoutMs } from "./live-test.ts";

export interface LiveWorkspace {
    daemon: Daemon;
    db: Db;
    ws: SeamSocket;
    provider: Provider;
    workspaceId: number;
    runDir: string;
    invokeWorkspaceAction: (name: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
    cleanup: () => Promise<void>;
}

// Every live/demo worker is a self-contained benchmark artifact. The filesystem
// allocates a unique, human-readable directory; nothing counts, reuses, moves,
// or conditionally sweeps it. DB, workspace label, and digest stay together.
// {§tier-census} — under a stamped tier run, every worker lands inside the run's own directory.
const BENCHMARKS = benchmarksRoot();

// A test-file process owns one extension generation, matching production's long-lived daemon
// lifetime without coupling its independent workspace databases. Reconstructing a host-sized
// handler graph for every story retained native high-water memory across generations.
const mimetypes = new Mimetypes({ defaultMimetype: "text/markdown" });
after(async () => { await mimetypes.dispose(); });

const claimRunDir = async (workspace: string): Promise<string> => {
    const home = tierRunPath() ?? BENCHMARKS;
    await mkdir(home, { recursive: true });
    const label = workspace
        .replace(/-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .slice(0, 80) || "worker";
    const dir = await mkdtemp(join(home, `${label}-`));
    await writeFile(join(dir, "workspace"), `${workspace}\n`);
    return dir;
};

export interface WorkerCensus {
    readonly specimen: string | null;
    readonly label: string;
    readonly runDir: string;
    readonly loops: number;
    readonly turns: number;
    readonly requests: number;
    readonly tokens: { readonly input: number; readonly output: number };
    readonly cost: { readonly usd: number; readonly kinds: readonly string[] };
}

// {§tier-census} — what one worker's digest says it did, named by the specimen that drove it; a run
// that kept no database (a tier driven elsewhere) counts nothing.
const workerCensus = (runDir: string, label: string, specimen: LiveSpecimen | undefined): WorkerCensus => {
    type Request = { accounting?: { usage?: { inputTokens?: number; outputTokens?: number }; cost?: { kind?: string; amount?: { amount?: string; currency?: string } } } };
    const digestPath = join(runDir, "digest", "digest.json");
    const digest = (existsSync(digestPath) ? JSON.parse(readFileSync(digestPath, "utf8")) : {}) as {
        loops?: unknown[]; turns?: unknown[]; provider_requests?: Request[];
    };
    const requests = digest.provider_requests ?? [];
    let input = 0;
    let output = 0;
    let usd = 0;
    const kinds = new Set<string>();
    for (const { accounting } of requests) {
        input += accounting?.usage?.inputTokens ?? 0;
        output += accounting?.usage?.outputTokens ?? 0;
        const cost = accounting?.cost;
        if (cost?.amount?.currency === "USD" && cost.amount.amount !== undefined) {
            usd += Number(cost.amount.amount);
            if (cost.kind !== undefined) kinds.add(cost.kind);
        }
    }
    return {
        specimen: specimen?.name ?? null, label, runDir,
        loops: digest.loops?.length ?? 0, turns: digest.turns?.length ?? 0, requests: requests.length,
        tokens: { input, output }, cost: { usd, kinds: [...kinds].toSorted() },
    };
};

export interface LiveRun {
    readonly runDir: string;
    readonly dbPath: string;
    readonly hostPaths: HostPaths;
    // After the database is closed: the digest, then the worker's census row beside it.
    finish(): void;
}

// One worker's run directory: its database path, its own host beside its evidence
// ({§host-path-layout}: the operator's installed plugins, skills and workspace state neither shape a
// run nor receive its writes), and the finish that writes its digest and census. A specimen that
// drives a daemon elsewhere keeps no database here and says so; its finish writes the census alone.
export const liveRun = async (name: string, opts: { database?: boolean } = {}): Promise<LiveRun> => {
    const runDir = await claimRunDir(name);
    const dbPath = join(runDir, "plurnk.db");
    const hostPaths = new HostPaths({ home: join(runDir, "home"), env: {} });
    const specimen = currentSpecimen();
    return {
        runDir, dbPath, hostPaths,
        finish: () => {
            if (opts.database !== false) Digest.run({ openEvidence: EvidenceReader.open, dbPath, digestDir: join(runDir, "digest") });
            writeFileSync(join(runDir, "census.json"), `${JSON.stringify(workerCensus(runDir, name, specimen), null, 2)}\n`);
        },
    };
};

// Resolve the active env provider the launcher way (PLURNK_MODEL →
// loadActiveProvider). Live/demo runners set the model via .env, so an
// unconfigured model is a hard error, not a silent skip.
export const liveProvider = async (): Promise<Provider> => {
    const route = resolveActiveRoute();
    if (route === null) throw new Error("PLURNK_MODEL not set; the live/demo tiers require a configured model route");
    const provider = await ProviderInstantiate.loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null despite a resolved model route");
    return provider;
};

// Boot the prod Daemon against a real provider, create a workspace, hand back the
// db + ws + workspaceId + cleanup. Unlike withDaemon (which auto-closes on callback
// return), the db stays OPEN so the caller can run post-loop forensic asserts;
// cleanup stops the daemon and closes the db. workspace.create uses rpc id 1, so
// callers drive loop.run from id 2. This owns only the boot + open-db lifecycle.
export const liveWorkspace = async (opts: { name: string; projectRoot?: string }): Promise<LiveWorkspace> => {
    const provider = await liveProvider();
    const run = await liveRun(opts.name);
    const { runDir } = run;
    const db = await openMigrated(run.dbPath);
    const daemon = new Daemon({ db, provider, mimetypes, hostPaths: run.hostPaths });
    let ws: SeamSocket | undefined;
    let projectRoot = opts.projectRoot;
    const ownsSandbox = projectRoot === undefined;
    const lifetime = new AsyncDisposableStack();
    lifetime.defer(async () => { if (ownsSandbox && projectRoot !== undefined) await rm(projectRoot, { recursive: true, force: true }); });
    lifetime.defer(async () => { run.finish(); });
    lifetime.defer(async () => { await db.close(); });
    lifetime.defer(async () => { await daemon.stop(); });
    lifetime.defer(async () => { ws?.close(); });
    const cleanup = () => lifetime.disposeAsync();
    try {
        await daemon.start(); // {§rpc} — the harness rides the listenerless seam
        ws = await connect({ daemon });
        // Every live/demo roots at a disposable fixture, never the host repository.
        projectRoot ??= await mkdtemp(join(tmpdir(), "plurnk-sandbox-"));
        const created = (await rpcCall(ws, 1, "workspace.create", {
            name: opts.name, projectRoot,
        })).result as { id: number };
        return {
            daemon, db, ws, provider, workspaceId: created.id, runDir,
            invokeWorkspaceAction: async (name, params) => daemon.invokeModuleAction(
                name,
                params,
                { scope: "workspace", workspaceId: created.id },
            ),
            cleanup,
        };
    } catch (error) {
        return await failAfterCleanup(error, cleanup);
    }
};

// The live/demo profile declares server approval; this driver only submits input, awaits
// loop/terminated, and return the outcome + the model's final reply. modelWorkerId
// (the worker the model's ops landed in, for worker-filtered forensic queries) is
// guaranteed by loop.run; absence is a hard failure, not a silent 0.
export const liveLoop = async (
    s: { ws: SeamSocket; db: Db },
    id: number,
    params: { prompt: string; workerId?: number; maxTurns?: number; openPaths?: string[] },
    opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ finalStatus: number; hitMaxTurns: boolean; turnIds: number[]; modelWorkerId: number; loopId: number; lastContent: string }> => {
    const timeoutMs = opts?.timeoutMs ?? liveTimeoutMs();
    opts?.signal?.throwIfAborted();
    let term;
    try {
        term = await runLoopToTerminal(s.ws, id, {
            prompt: params.prompt,
            ...(params.workerId !== undefined ? { workerId: params.workerId } : {}),
            ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
            ...(params.openPaths !== undefined ? { openPaths: params.openPaths } : {}),
        }, { timeoutMs, signal: opts?.signal });
    } catch (error) {
        // {§methods-loop-cancel}/{§crash-only-stop} — a harness timeout explicitly cancels before the
        // rejection propagates, so cleanup (daemon.stop) never doubles as the
        // only cancellation path and a wedged child can't wedge the teardown.
        return await failAfterCleanup(error, async () => {
            const reason = error instanceof WaitTimeoutError ? "harness_timeout"
                : `harness_cancelled: ${error instanceof Error ? error.message : String(error)}`;
            const cancelled = await rpcCall(s.ws, id + 10_000, "loop.cancel", { reason });
            if (cancelled.error !== undefined) {
                throw new Error(`loop.cancel RPC failed (${cancelled.error.code}): ${cancelled.error.message}`);
            }
        });
    }
    if (term.modelWorkerId === undefined) throw new Error("liveLoop: loop.run returned no modelWorkerId");
    const lastContent = await lastReply(s.db, term.loopId);
    return {
        finalStatus: term.finalStatus, hitMaxTurns: term.hitMaxTurns ?? false,
        turnIds: term.turnIds ?? [], modelWorkerId: term.modelWorkerId, loopId: term.loopId, lastContent,
    };
};

// Seed a workspace resource as a prompt precondition, not as model-visible output.
// The model still has to emit an operation to reach it.
export const seedEntry = async (
    db: Db, workspaceId: number,
    opts: { scheme?: string; pathname: string; content: string; mimetype?: string },
): Promise<number> => {
    const pathname = opts.pathname.startsWith("/") ? opts.pathname : `/${opts.pathname}`;
    const published = await EntryCrud.writeEntry({ authority: "", pathname }, {
        channels: { body: { content: opts.content, mimetype: opts.mimetype ?? "text/markdown" } },
    }, {
        db, workspaceId, workerId: 0, loopId: 0, turnId: 0,
        writer: "_plurnk", signal: undefined, mimetypes, weigh: contentWeight,
    }, opts.scheme ?? "worker");
    if (published.entryId === null) throw new Error("seedEntry: publication returned no entry");
    return published.entryId;
};

// Forensic read-back: an entry's body content by pathname (undefined once the
// channel/entry is gone). Assert what the OP did to the db, never the model's words.
export const readBody = async (db: Db, pathname: string): Promise<string | undefined> => {
    const canonical = pathname.startsWith("/") ? pathname : `/${pathname}`;  // match seedEntry's canonical form
    const row = await db.test_get_body_by_pathname.get<{ content: string }>({ pathname: canonical });
    return row?.content;
};

// Forensic read-back: the latest rx the engine logged for an op in the model worker
// (what a READ actually sliced / a FIND actually matched). modelWorkerId rides the
// loop/terminated event (liveLoop returns it).
export const lastRx = async (db: Db, modelWorkerId: number, op: string): Promise<string> => {
    const row = await db.test_get_log_rx_by_worker_op.get<{ rx: string }>({ worker_id: modelWorkerId, op });
    return row?.rx ?? "";
};

// Request a provider-derived input-capacity target for the ACTIVE alias. The
// suffix wins over ambient operator settings and remains alias-agnostic when a
// demo pivots models. There is deliberately no Core-only pressure gauge: the
// context window and total output envelope derive both the curation calibration
// and the physical request capacity through the production provider path. A
// model's stricter natural context or input cap may lower the effective result.
export const pinAliasInputCapacity = ({
    inputCapacity,
    outputBudget,
}: {
    inputCapacity: number;
    outputBudget: number;
}): (() => void) => {
    if (!Number.isSafeInteger(inputCapacity) || inputCapacity <= 0) {
        throw new TypeError(`inputCapacity must be a positive safe integer; got ${inputCapacity}`);
    }
    if (!Number.isSafeInteger(outputBudget) || outputBudget <= 0) {
        throw new TypeError(`outputBudget must be a positive safe integer; got ${outputBudget}`);
    }
    const active = resolveActiveRoute(process.env);
    if (active === null) throw new Error("PLURNK_MODEL not set; cannot pin the active model input capacity");

    // Preserve the naturally resolved output envelope measured by the floor
    // probe. Only its input side is tightened for the pressure experiment.
    const contextWindow = inputCapacity + outputBudget;
    const suffix = active.alias === undefined ? "" : `_${active.alias}`;
    const entries: Array<readonly [string, string]> = [
        [`PLURNK_PROVIDERS_CONTEXT_WINDOW${suffix}`, String(contextWindow)],
        [`PLURNK_PROVIDERS_OUTPUT_BUDGET${suffix}`, String(outputBudget)],
    ];
    const prev = entries.map(([k]) => [k, process.env[k]] as const);
    for (const [k, v] of entries) process.env[k] = v;
    return () => { for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
};
