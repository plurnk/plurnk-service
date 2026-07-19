// Shared harness for the live + demo tiers — the ones that drive a REAL model.
// Both tiers run the SAME prod loop production runs: boot the real Daemon,
// create a workspace, fire loop.run, await loop/terminated. The ONLY things that
// vary from the deterministic intg tier are the provider (a real one here, a
// Mock there) and tasteful .env tunings. There is no engine reconstruction —
// executors, the system prompt, and doc materialization all come from loop.run.
//
// liveWorkspace boots + holds the workspace (db stays open for post-loop forensic
// asserts); liveLoop is the single loop-driver (always server-YOLO, the live/demo
// stance). Everything funnels through these two so the tier has exactly one path.

import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import Owner from "../src/core/Owner.ts";
import { rmSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import type SeamSocket from "./intg/_seam.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../src/core/ProviderInstantiate.ts";
import Daemon from "../src/server/Daemon.ts";
import type { Db, PrepMethod } from "../src/core/Db.ts";
import { openMigrated } from "./intg/_helpers.ts";
import { connect, rpcCall, runLoopToTerminal } from "./intg/_rpc.ts";

export interface LiveWorkspace {
    db: Db;
    ws: SeamSocket;
    workspaceId: number;
    runDir: string;
    cleanup: () => Promise<void>;
}

// §archaeology (#410) — a failed live/demo run must PRESERVE itself, not depend on a human racing
// the next `.tmp` pre-clean. So a worker's db is BORN in `benchmarks/run<N>-<lane>/` and KEPT by
// default: a missed cleanup leaves harmless clutter, never a lost specimen — the inverse of
// copy-on-failure, where a missed hook loses the worker forever. Passing workers are swept at worker exit
// (best-effort, safe); failures stay, greppable by workspace name (the `workspace` file inside).
const BENCHMARKS = process.env.PLURNK_BENCHMARKS ?? resolve(homedir(), "repo/plurnk/benchmarks");
const LANE = process.env.PLURNK_LANE ?? "core";
const createdRuns: string[] = [];

// Atomic claim: mkdir fails if the dir exists, so a concurrent worker (or a sibling lane) can never
// take the same run number — the run46 meta/bench collision the issue names. Numbers are sparse by
// design (owner ruling): passing workers are swept, so a worker number is a findable id, not a count.
const claimRunDir = async (workspace: string): Promise<string> => {
    await mkdir(BENCHMARKS, { recursive: true });
    let n = 1;
    for (const e of readdirSync(BENCHMARKS)) { const m = /^run(\d+)-/.exec(e); if (m) n = Math.max(n, Number(m[1]) + 1); }
    for (;;) {
        const dir = join(BENCHMARKS, `run${n}-${LANE}`);
        try { await mkdir(dir); await writeFile(join(dir, "workspace"), `${workspace}\n`); return dir; }
        catch (e) { if ((e as { code?: string }).code !== "EEXIST") throw e; n++; }
    }
};

// Delete-on-pass, best-effort: node:test sets process.exitCode truthy iff a test in THIS file
// failed. All-passed → the file's runs were noise, sweep them; any failure → KEEP every worker this
// worker created (coarse but SAFE — the point is never to lose a failure; a spare passing run is fine).
let _sweepArmed = false;
const armSweep = (): void => {
    if (_sweepArmed) return;
    _sweepArmed = true;
    process.on("exit", () => {
        if (process.exitCode) return; // a failure occurred — preserve every worker this file created
        // #488 — a drill is a FORENSIC context: run78 passed its assertions on a FABRICATED answer,
        // so delete-on-pass swept the one specimen that mattered (a green file is not a clean file
        // when the rail is in question). PRESERVE_WORKERS=1 keeps everything; the drill sets it.
        if (process.env.PLURNK_SERVICE_PRESERVE_WORKERS === "1") return;
        for (const dir of createdRuns) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it — clutter beats loss */ } }
    });
};

// Resolve the active env provider the launcher way (PLURNK_MODEL →
// loadActiveProvider). Live/demo runners set the model via .env, so an
// unconfigured model is a hard error, not a silent skip.
export const liveProvider = async (): Promise<Provider> => {
    const alias = resolveActiveAlias();
    if (alias === null) throw new Error("PLURNK_MODEL not set; the live/demo tiers require a configured model alias");
    const provider = await ProviderInstantiate.loadActiveProvider();
    if (provider === null) throw new Error("loadActiveProvider returned null despite a resolved alias");
    return provider;
};

// Boot the prod Daemon against a real provider, create a workspace, hand back the
// db + ws + workspaceId + cleanup. Unlike withDaemon (which auto-closes on callback
// return), the db stays OPEN so the caller can run post-loop forensic asserts;
// cleanup stops the daemon and closes the db. workspace.create uses rpc id 1, so
// callers drive loop.run from id 2. This owns only the boot + open-db lifecycle.
export const liveWorkspace = async (opts: { name: string; projectRoot?: string }): Promise<LiveWorkspace> => {
    const provider = await liveProvider();
    armSweep();
    // §archaeology (#410) — born in benchmarks/, kept by default; the exit sweep reclaims it only if
    // the file passed. So a failure is preserved with zero capture logic — no racing, no copy.
    const runDir = await claimRunDir(opts.name);
    const db = await openMigrated(join(runDir, "plurnk.db"));
    createdRuns.push(runDir);
    const daemon = new Daemon({ db, provider });
    await daemon.start(); // listenerless — the harness rides the seam (#364)
    const ws = await connect({ daemon });
    // SANDBOX: every live/demo workspace roots at a fresh empty dir, NEVER the host repo. With
    // PLURNK_SERVICE_GIT_ALLOWED=1 + PLURNK_SERVICE_GIT_AUTO=1 + PLURNK_SERVICE_FILES_ITEMS=-1 (the live/demo .env), an
    // in-repo projectRoot makes git membership materialize + embed ALL of plurnk-service every turn
    // — the embed cycle that turns a 7s task into a 240s timeout. seedEntry writes to the DB, so an
    // empty root costs the tests nothing. Caller may override (e.g. with a fixture git repo).
    const ownsSandbox = opts.projectRoot === undefined;
    const projectRoot = opts.projectRoot ?? await mkdtemp(join(tmpdir(), "plurnk-sandbox-"));
    const created = (await rpcCall(ws, 1, "workspace.create", {
        name: opts.name, projectRoot,
    })).result as { id: number };
    return {
        db, ws, workspaceId: created.id, runDir,
        cleanup: async () => {
            // The worker dir is intentionally LEFT on disk (§archaeology preserve-default); the exit
            // sweep removes it iff this file's tests all passed. Only the ephemeral sandbox is torn down.
            ws.close(); await daemon.stop(); await db.close();
            if (ownsSandbox) await rm(projectRoot, { recursive: true, force: true });
        },
    };
};

// The single loop-driver for the live/demo tier: fire loop.run (server-YOLO — the
// tier auto-accepts so an unattended model worker isn't blocked on review), await
// loop/terminated, and return the outcome + the model's final reply. modelWorkerId
// (the worker the model's ops landed in, for worker-scoped forensic queries) is
// guaranteed by loop.run; absence is a hard failure, not a silent 0.
export const liveLoop = async (
    s: { ws: SeamSocket; db: Db },
    id: number,
    params: { prompt: string; maxTurns?: number; flags?: Record<string, unknown> },
    opts: { timeoutMs: number },
): Promise<{ finalStatus: number; hitMaxTurns: boolean; turnIds: number[]; modelWorkerId: number; lastContent: string }> => {
    const term = await runLoopToTerminal(s.ws, id, {
        prompt: params.prompt, flags: { yolo: true, ...params.flags },
        ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
    }, opts);
    if (term.modelWorkerId === undefined) throw new Error("liveLoop: loop.run returned no modelWorkerId");
    const lastContent = await lastReply(s.db, term.turnIds);
    return {
        finalStatus: term.finalStatus, hitMaxTurns: term.hitMaxTurns ?? false,
        turnIds: term.turnIds ?? [], modelWorkerId: term.modelWorkerId, lastContent,
    };
};

// The model's final reply — the last terminated turn's packet assistant content.
const lastReply = async (db: Db, turnIds: number[] | undefined): Promise<string> => {
    const lastTurnId = turnIds?.[turnIds.length - 1];
    if (lastTurnId === undefined) return "";
    const row = await (db.test_get_turn as PrepMethod).get<{ packet: string }>({ id: lastTurnId });
    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
    return packet.assistant?.content ?? "";
};

// Seed a workspace entry + body channel — a test PRECONDITION (the state the prompt
// references), written through the prod crud statements (the same writes the File
// scheme / git-membership use) so seeding can't drift from how entries really exist.
// The model still has to emit the op to reach it; nothing is auto-shown.
export const seedEntry = async (
    db: Db, workspaceId: number,
    opts: { scheme?: string | null; pathname: string; content: string; mimetype?: string },
): Promise<number> => {
    // worker:///lines.md resolves to pathname "/lines.md" — the prod write path canonicalizes to that
    // leading-slash form, so storing the bare arg ("lines.md") 404'd the model's READ by one char.
    // Honor the convention. (readWorkspaceEntry is a direct scheme+pathname+channel lookup — no
    // membership filter — so a plain workspace entry resolves; no git materialization needed.)
    const pathname = opts.pathname.startsWith("/") ? opts.pathname : `/${opts.pathname}`;
    const e = await (db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({
        workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: opts.scheme ?? "worker", pathname,
    });
    if (e === undefined) throw new Error("seedEntry: insert returned no row");
    await (db.crud_write_channel as PrepMethod).run({
        entry_id: e.id, name: "body", content: opts.content, mimetype: opts.mimetype ?? "text/markdown", tokens: 0, state: "static",
    });
    return e.id;
};

// Forensic read-back: an entry's body content by pathname (undefined once the
// channel/entry is gone). Assert what the OP did to the db, never the model's words.
export const readBody = async (db: Db, pathname: string): Promise<string | undefined> => {
    const canonical = pathname.startsWith("/") ? pathname : `/${pathname}`;  // match seedEntry's canonical form
    const row = await (db.test_get_body_by_pathname as PrepMethod).get<{ content: string }>({ pathname: canonical });
    return row?.content;
};

// Forensic read-back: the latest rx the engine logged for an op in the model worker
// (what a READ actually sliced / a FIND actually matched). modelWorkerId rides the
// loop/terminated event (liveLoop returns it).
export const lastRx = async (db: Db, modelWorkerId: number, op: string): Promise<string> => {
    const row = await (db.test_get_log_rx_by_run_op as PrepMethod).get<{ rx: string }>({ worker_id: modelWorkerId, op });
    return row?.rx ?? "";
};

// Pin the window partition for the demo/live tier's ACTIVE alias. A real model carries its window
// as PLURNK_SERVICE_*_<alias> knobs in .env, and those SUFFIX knobs win over bare PLURNK_SERVICE_*
// via scopeEnvToAlias — so a ceiling-pinning test that sets bare vars is silently overridden by the
// model's real window (the budget-grind/-meta/floor-probe regression: turboderp's 35840 leaked
// past a tight pin). Setting the ACTIVE alias's suffix wins over its own .env knobs; alias-agnostic,
// so it holds when the demo model pivots (turboderp ↔ gbuild). Returns a restore fn.
export const pinAliasPartition = (part: { CONTEXT_WINDOW: string; REASONING: string; COMPLETION: string; SAFETY: string }): (() => void) => {
    const alias = resolveActiveAlias(process.env)?.alias ?? "";
    // #507 — window + reserves pin PROVIDER-tier (the envelope moved); SAFETY stays core's.
    const entries: Array<readonly [string, string]> = [
        [`PLURNK_PROVIDERS_CONTEXT_WINDOW_${alias}`, part.CONTEXT_WINDOW],
        [`PLURNK_PROVIDERS_REASONING_RESERVE_${alias}`, part.REASONING],
        [`PLURNK_PROVIDERS_COMPLETION_RESERVE_${alias}`, part.COMPLETION],
        [`PLURNK_SERVICE_SAFETY_${alias}`, part.SAFETY],
    ];
    const prev = entries.map(([k]) => [k, process.env[k]] as const);
    for (const [k, v] of entries) process.env[k] = v;
    return () => { for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
};
