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
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import Owner from "../src/core/Owner.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type SeamSocket from "./intg/_seam.ts";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../src/core/ProviderInstantiate.ts";
import Daemon from "../src/server/Daemon.ts";
import type { Db } from "../src/core/Db.ts";
import { openMigrated } from "./intg/_helpers.ts";
import { connect, rpcCall, runLoopToTerminal } from "./intg/_rpc.ts";
import Digest from "../src/digest/Digest.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { Module as McpModule } from "@plurnk/plurnk-mcp";

export interface LiveWorkspace {
    db: Db;
    ws: SeamSocket;
    provider: Provider;
    workspaceId: number;
    runDir: string;
    cleanup: () => Promise<void>;
}

// Every live/demo worker is a self-contained benchmark artifact. The filesystem
// allocates a unique, human-readable directory; nothing counts, reuses, moves,
// or conditionally sweeps it. DB, workspace label, and digest stay together.
const BENCHMARKS = process.env.PLURNK_BENCHMARKS ?? resolve(import.meta.dirname, "../../../..", "benchmarks");

// A test-file process owns one plugin generation, matching production's long-lived daemon
// lifetime without coupling its independent workspace databases. Reconstructing a host-sized
// local embedding pool for every story retained native high-water memory across generations.
const mimetypes = new Mimetypes({ defaultMimetype: "text/markdown" });
after(async () => { await mimetypes.dispose(); });

const claimRunDir = async (workspace: string): Promise<string> => {
    await mkdir(BENCHMARKS, { recursive: true });
    const label = workspace
        .replace(/-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .slice(0, 80) || "worker";
    const dir = await mkdtemp(join(BENCHMARKS, `${label}-`));
    await writeFile(join(dir, "workspace"), `${workspace}\n`);
    return dir;
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
    const runDir = await claimRunDir(opts.name);
    const dbPath = join(runDir, "plurnk.db");
    const db = await openMigrated(dbPath);
    const daemon = new Daemon({ db, provider, mimetypes });
    // The harness mirrors the service's default composition: the MCP host is a
    // first-class module, so demo stories exercise ordinary MCP attachments
    // exactly as a production daemon does.
    daemon.registerModule(McpModule.init());
    await daemon.start(); // {§rpc} — the harness rides the listenerless seam
    const ws = await connect({ daemon });
    // SANDBOX: every live/demo workspace roots at a fresh empty dir, NEVER the host repo. With
    // With Git permitted plus PLURNK_SERVICE_GIT_AUTO=1 + PLURNK_SERVICE_FILES_ITEMS=-1 (the real-model profile), an
    // in-repo projectRoot makes git membership materialize + embed ALL of plurnk-service every turn
    // — the embed cycle that turns a 7s task into a 240s timeout. seedEntry writes to the DB, so an
    // empty root costs the tests nothing. Caller may override (e.g. with a fixture git repo).
    const ownsSandbox = opts.projectRoot === undefined;
    const projectRoot = opts.projectRoot ?? await mkdtemp(join(tmpdir(), "plurnk-sandbox-"));
    const created = (await rpcCall(ws, 1, "workspace.create", {
        name: opts.name, projectRoot,
    })).result as { id: number };
    return {
        db, ws, provider, workspaceId: created.id, runDir,
        cleanup: async () => {
            ws.close(); await daemon.stop(); await db.close();
            Digest.run({ dbPath, digestDir: join(runDir, "digest") });
            if (ownsSandbox) await rm(projectRoot, { recursive: true, force: true });
        },
    };
};

// The single loop-driver for the live/demo tier: fire loop.run (loop auto — the
// tier auto-accepts so an unattended model worker isn't blocked on review), await
// loop/terminated, and return the outcome + the model's final reply. modelWorkerId
// (the worker the model's ops landed in, for worker-filtered forensic queries) is
// guaranteed by loop.run; absence is a hard failure, not a silent 0.
export const liveLoop = async (
    s: { ws: SeamSocket; db: Db },
    id: number,
    params: { prompt: string; maxTurns?: number; flags?: Record<string, unknown> },
    opts?: { timeoutMs?: number },
): Promise<{ finalStatus: number; hitMaxTurns: boolean; turnIds: number[]; modelWorkerId: number; lastContent: string }> => {
    const timeoutMs = opts?.timeoutMs ?? Number(process.env.PLURNK_SERVICE_LIVE_TIMEOUT ?? 600_000);
    let term;
    try {
        term = await runLoopToTerminal(s.ws, id, {
            prompt: params.prompt, flags: { auto: true, ...params.flags },
            ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
        }, { timeoutMs });
    } catch (error) {
        // {§methods-loop-cancel}/{§crash-only-stop} — a harness timeout explicitly cancels before the
        // rejection propagates, so cleanup (daemon.stop) never doubles as the
        // only cancellation path and a wedged child can't wedge the teardown.
        try {
            await rpcCall(s.ws, id + 10_000, "loop.cancel", { reason: "harness_timeout" });
        } catch {
            // best-effort; the timeout error is the real failure
        }
        throw error;
    }
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
    const row = await db.test_get_turn.get<{ packet: string }>({ id: lastTurnId });
    const packet = JSON.parse(row?.packet ?? "{}") as { assistant?: { content?: string } };
    return packet.assistant?.content ?? "";
};

// Seed a workspace entry + body channel — a test PRECONDITION (the state the prompt
// references), written through the prod crud statements (the same writes the File
// scheme / git-membership use) so seeding can't drift from how entries really exist.
// The model still has to emit the op to reach it; nothing is auto-shown.
export const seedEntry = async (
    db: Db, workspaceId: number,
    opts: { scheme?: string; pathname: string; content: string; mimetype?: string },
): Promise<number> => {
    // worker:///lines.md resolves to pathname "/lines.md" — the prod write path canonicalizes to that
    // leading-slash form, so storing the bare arg ("lines.md") 404'd the model's READ by one char.
    // Honor the convention. (readWorkspaceEntry is a direct scheme+pathname+channel lookup — no
    // membership filter — so a plain workspace entry resolves; no git materialization needed.)
    const pathname = opts.pathname.startsWith("/") ? opts.pathname : `/${opts.pathname}`;
    const e = await db.crud_insert_workspace_entry.get<{ id: number }>({
        workspace_id: workspaceId, owner_id: await Owner.commonsId(db, workspaceId), scheme: opts.scheme ?? "worker", pathname,
    });
    if (e === undefined) throw new Error("seedEntry: insert returned no row");
    await db.crud_write_channel.run({
        entry_id: e.id, name: "body", content: opts.content, mimetype: opts.mimetype ?? "text/markdown", weight: 0, state: "static",
    });
    return e.id;
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
    const active = resolveActiveAlias(process.env);
    if (active === null) throw new Error("PLURNK_MODEL not set; cannot pin the active alias input capacity");

    // Preserve the naturally resolved output envelope measured by the floor
    // probe. Only its input side is tightened for the pressure experiment.
    const contextWindow = inputCapacity + outputBudget;
    const entries: Array<readonly [string, string]> = [
        [`PLURNK_PROVIDERS_CONTEXT_WINDOW_${active.alias}`, String(contextWindow)],
        [`PLURNK_PROVIDERS_OUTPUT_BUDGET_${active.alias}`, String(outputBudget)],
    ];
    const prev = entries.map(([k]) => [k, process.env[k]] as const);
    for (const [k, v] of entries) process.env[k] = v;
    return () => { for (const [k, v] of prev) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
};
