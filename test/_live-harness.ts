// Shared harness for the live + demo tiers — the ones that drive a REAL model.
// Both tiers run the SAME prod loop production runs: boot the real Daemon,
// create a session, fire loop.run, await loop/terminated. The ONLY things that
// vary from the deterministic intg tier are the provider (a real one here, a
// Mock there) and tasteful .env tunings. There is no engine reconstruction —
// executors, the system prompt, and doc materialization all come from loop.run.
//
// liveSession boots + holds the session (db stays open for post-loop forensic
// asserts); liveLoop is the single loop-driver (always server-YOLO, the live/demo
// stance). Everything funnels through these two so the tier has exactly one path.

import type { WebSocket } from "ws";
import { resolveActiveAlias } from "@plurnk/plurnk-providers";
import type { Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "../src/core/ProviderInstantiate.ts";
import Daemon from "../src/server/Daemon.ts";
import type { Db, PrepMethod } from "../src/core/Db.ts";
import { openMigrated } from "./intg/_helpers.ts";
import { connect, rpcCall, runLoopToTerminal } from "./intg/_rpc.ts";

export interface LiveSession {
    db: Db;
    ws: WebSocket;
    sessionId: number;
    cleanup: () => Promise<void>;
}

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

// Boot the prod Daemon against a real provider, create a session, hand back the
// db + ws + sessionId + cleanup. Unlike withDaemon (which auto-closes on callback
// return), the db stays OPEN so the caller can run post-loop forensic asserts;
// cleanup stops the daemon and closes the db. session.create uses rpc id 1, so
// callers drive loop.run from id 2. This owns only the boot + open-db lifecycle.
export const liveSession = async (opts: { name: string; projectRoot?: string }): Promise<LiveSession> => {
    const provider = await liveProvider();
    const db = await openMigrated();
    const daemon = new Daemon({ db, provider });
    const addr = await daemon.start({ host: "127.0.0.1", port: 0 });
    const ws = await connect(addr);
    const created = (await rpcCall(ws, 1, "session.create", {
        name: opts.name, ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    })).result as { id: number };
    return {
        db, ws, sessionId: created.id,
        cleanup: async () => { ws.close(); await daemon.stop(); await db.close(); },
    };
};

// The single loop-driver for the live/demo tier: fire loop.run (server-YOLO — the
// tier auto-accepts so an unattended model run isn't blocked on review), await
// loop/terminated, and return the outcome + the model's final reply. modelRunId
// (the run the model's ops landed in, for run-scoped forensic queries) is
// guaranteed by loop.run; absence is a hard failure, not a silent 0.
export const liveLoop = async (
    s: { ws: WebSocket; db: Db },
    id: number,
    params: { prompt: string; maxTurns?: number },
    opts: { timeoutMs: number },
): Promise<{ finalStatus: number; hitMaxTurns: boolean; turnIds: number[]; modelRunId: number; lastContent: string }> => {
    const term = await runLoopToTerminal(s.ws, id, {
        prompt: params.prompt, flags: { yolo: true },
        ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
    }, opts);
    if (term.modelRunId === undefined) throw new Error("liveLoop: loop.run returned no modelRunId");
    const lastContent = await lastReply(s.db, term.turnIds);
    return {
        finalStatus: term.finalStatus, hitMaxTurns: term.hitMaxTurns ?? false,
        turnIds: term.turnIds ?? [], modelRunId: term.modelRunId, lastContent,
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

// Seed a session entry + body channel — a test PRECONDITION (the state the prompt
// references), written through the prod crud statements (the same writes the File
// scheme / git-membership use) so seeding can't drift from how entries really exist.
// The model still has to emit the op to reach it; nothing is auto-shown.
export const seedEntry = async (
    db: Db, sessionId: number,
    opts: { scheme?: string | null; pathname: string; content: string; mimetype?: string },
): Promise<number> => {
    const e = await (db.crud_insert_session_entry as PrepMethod).get<{ id: number }>({
        session_id: sessionId, scheme: opts.scheme ?? "known", pathname: opts.pathname,
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
    const row = await (db.test_get_body_by_pathname as PrepMethod).get<{ content: string }>({ pathname });
    return row?.content;
};

// Forensic read-back: the latest rx the engine logged for an op in the model run
// (what a READ actually sliced / a FIND actually matched). modelRunId rides the
// loop/terminated event (liveLoop returns it).
export const lastRx = async (db: Db, modelRunId: number, op: string): Promise<string> => {
    const row = await (db.test_get_log_rx_by_run_op as PrepMethod).get<{ rx: string }>({ run_id: modelRunId, op });
    return row?.rx ?? "";
};
