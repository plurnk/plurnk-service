#!/usr/bin/env node
//
// Run-digest tool for plurnk-service DBs. Reads a sqlite plurnk*.db and
// emits per-run forensic artifacts to test/digest/. First-order forensic
// surface; read-only; safe to re-run.
//
//   test/digest/digest.md           Run-shape header + waterfall (per-turn:
//                                   status, model emission summary, indented
//                                   op list with target + status + error)
//   test/digest/digest.json         Same data, machine-queryable
//   test/digest/reasoning.md        Per-turn reasoning text (full)
//   test/digest/packetNNN.system.md       BYTE-FOR-BYTE the system message
//                                         the LLM received on turn id NNN.
//   test/digest/packetNNN.user.md         Same for the user message.
//   test/digest/packetNNN.assistant.md     Model emission (content string).
//   test/digest/packetNNN.assistantRaw.json  Opaque provider response.
//
// packet files are byte-identical to what Engine emits, because Engine and
// digest both project through PacketWire (one renderer, no drift).
//
// SQL lives in the co-located digest.sql; opened the sqlrite way (SqlRiteSync,
// the sync CLI/script facade). Each PREP block is read through its own accessor.

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import PacketWire from "../src/core/packet-wire.ts";

// DB row shapes — only the columns this tool reads. JSON columns (packet,
// flags, tx, rx) arrive as strings, parsed on use.
interface SessionRow { id: number; name: string; cost_pico: number }
interface RunRow { id: number; session_id: number; name: string; cost_pico: number }
interface LoopRow { id: number; run_id: number; sequence: number; status: number; prompt: string; flags: string }
interface TurnRow {
    id: number; loop_id: number; sequence: number; status: number; packet: string;
    usage_prompt: number; usage_completion: number; usage_cached: number; usage_cost_pico: number;
    finish_reason: string | null; model: string | null;
}
interface LogRow {
    id: number; turn_id: number; sequence: number;
    op: string; scheme: string | null; pathname: string | null;
    rx: string | null; status_rx: number; state: string; outcome: string | null;
}
interface RunRollupRow {
    run_id: number; loops: number; turns: number;
    total_prompt: number; total_completion: number; total_cached: number; total_cost_pico: number;
    last_status: number | null;
}
interface OpMixRow { run_id: number; op: string; n: number }

// The SqlRiteSync handle's type (sync per-PREP accessors) is declared in
// src/types/sqlrite.d.ts; digest reads each block through its own accessor.

// Loaded snapshot + derived index maps, threaded through the renderers so the
// data flow is explicit (no hidden module-level state).
interface DigestModel {
    dbPath: string;
    digestDir: string;
    sessions: SessionRow[];
    runs: RunRow[];
    loops: LoopRow[];
    turns: TurnRow[];
    logEntries: LogRow[];
    runsBySession: Map<number, RunRow[]>;
    loopsByRun: Map<number, LoopRow[]>;
    turnsByLoop: Map<number, TurnRow[]>;
    logEntriesByTurn: Map<number, LogRow[]>;
    loopsById: Map<number, LoopRow>;
    runsById: Map<number, RunRow>;
    runRollups: Map<number, RunRollupRow>;
    opMixByRun: Map<number, OpMixRow[]>;
}

// Programmatic entry options (#264 — plurnk-bench reuses Digest without the CLI).
// dbPath is required; digestDir defaults to the bin's test/digest; an optional
// runId/sessionId narrows the digest to one scope instead of the whole DB.
interface DigestOptions {
    dbPath: string;
    digestDir?: string;
    runId?: number;
    sessionId?: number;
}

export default class Digest {
    static #summarize(text: unknown, n = 80): string {
        if (text === null || text === undefined) return "";
        const flat = String(text).replace(/\s+/g, " ").trim();
        if (flat.length <= n) return flat;
        return `${flat.slice(0, n)}…`;
    }

    static #parseJson(s: unknown, fallback: unknown = null): unknown {
        if (s === null || s === undefined) return fallback;
        try { return JSON.parse(String(s)); } catch { return fallback; }
    }

    static #renderOpLine(le: LogRow): string {
        const target = le.scheme !== null && le.pathname !== null
            ? `${le.scheme}://${le.pathname}`
            : le.pathname ?? "—";
        const state = le.state !== "resolved" ? ` state=${le.state}` : "";
        const outcome = le.outcome !== null ? ` outcome=${le.outcome}` : "";
        const fail = le.status_rx >= 400 ? " ✗" : "";
        // For non-2xx outcomes, surface the error string (or body) from rx so
        // the waterfall explains WHY each failure happened without opening packets.
        let errLine = "";
        if (le.status_rx >= 400) {
            const rx = Digest.#parseJson(le.rx, {}) as { error?: unknown; body?: unknown };
            const msg = rx.error ?? rx.body ?? null;
            if (typeof msg === "string" && msg.length > 0) {
                errLine = `\n    → ${Digest.#summarize(msg, 140)}`;
            }
        }
        return `  ← ${le.op}[${le.status_rx}] ${target}${state}${outcome}${fail}${errLine}`;
    }

    static #renderTurnLine(turn: TurnRow, m: DigestModel): string {
        const packet = Digest.#parseJson(turn.packet, {}) as { assistant?: { content?: unknown; reasoning?: unknown } };
        const assistant = packet.assistant ?? {};
        const content = typeof assistant.content === "string" ? assistant.content : "";
        const reasoning = typeof assistant.reasoning === "string" ? assistant.reasoning : null;
        const tokens = `prompt=${turn.usage_prompt} completion=${turn.usage_completion} cached=${turn.usage_cached}`;
        const cost = turn.usage_cost_pico > 0 ? ` cost=$${(turn.usage_cost_pico / 1e12).toFixed(6)}` : "";
        const finishReason = turn.finish_reason ?? "—";
        const model = turn.model ?? "—";
        const head = `T${turn.sequence}: status=${turn.status} finish=${finishReason} model=${model} ${tokens}${cost}`;
        const summary = content.length > 0 ? `  ↳ emission: ${Digest.#summarize(content, 100)}` : `  ↳ emission: (empty)`;
        const reasoningLine = reasoning && reasoning.length > 0
            ? `  ↳ reasoning: ${Digest.#summarize(reasoning, 100)}`
            : null;
        const opLines = (m.logEntriesByTurn.get(turn.id) ?? []).map((le) => Digest.#renderOpLine(le));
        return [head, summary, ...(reasoningLine ? [reasoningLine] : []), ...opLines].join("\n");
    }

    static #renderRunShape(run: RunRow, m: DigestModel): string {
        // every run has exactly one rollup row — digest_run_rollups is FROM runs
        const roll = m.runRollups.get(run.id)!;
        const opMix = (m.opMixByRun.get(run.id) ?? []).map((o) => `${o.op}=${o.n}`).join(" ");
        const costStr = roll.total_cost_pico > 0 ? `$${(roll.total_cost_pico / 1e12).toFixed(6)}` : "$0";
        return [
            `Loops:      ${roll.loops}`,
            `Turns:      ${roll.turns}`,
            `Last turn:  ${roll.last_status !== null ? `status=${roll.last_status}` : "(none)"}`,
            `Tokens:     prompt=${roll.total_prompt} completion=${roll.total_completion} cached=${roll.total_cached}`,
            `Cost:       ${costStr} (DB rollup runs.cost_pico=${run.cost_pico})`,
            `Op mix:     ${opMix.length > 0 ? opMix : "(no ops)"}`,
        ].join("\n");
    }

    static #renderWaterfall(m: DigestModel): string {
        const lines: string[] = [];
        lines.push(`# plurnk-service digest`);
        lines.push("");
        lines.push(`DB: ${m.dbPath}`);
        lines.push(`Sessions: ${m.sessions.length}  Runs: ${m.runs.length}  Loops: ${m.loops.length}  Turns: ${m.turns.length}  Log entries: ${m.logEntries.length}`);
        for (const session of m.sessions) {
            lines.push("");
            lines.push(`## Session #${session.id} — ${session.name}`);
            const sessionRuns = m.runsBySession.get(session.id) ?? [];
            for (const run of sessionRuns) {
                lines.push("");
                lines.push(`### Run #${run.id} — ${run.name}`);
                lines.push("");
                lines.push("```");
                lines.push(Digest.#renderRunShape(run, m));
                lines.push("```");
                const runLoops = m.loopsByRun.get(run.id) ?? [];
                for (const loop of runLoops) {
                    lines.push("");
                    lines.push(`#### Loop ${loop.sequence} (id=${loop.id}, status=${loop.status})`);
                    lines.push("");
                    lines.push(`Prompt: ${Digest.#summarize(loop.prompt, 160)}`);
                    const flags = Digest.#parseJson(loop.flags, {}) as Record<string, unknown>;
                    const flagSummary = Object.entries(flags).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
                    if (flagSummary.length > 0) lines.push(`Flags: ${flagSummary}`);
                    lines.push("");
                    lines.push("```");
                    for (const t of m.turnsByLoop.get(loop.id) ?? []) lines.push(Digest.#renderTurnLine(t, m));
                    lines.push("```");
                }
            }
        }
        return lines.join("\n");
    }

    static #renderReasoning(m: DigestModel): string {
        const lines: string[] = [];
        lines.push(`# plurnk-service reasoning`);
        lines.push("");
        lines.push("Per-turn reasoning_content extracted from turns.packet.assistant.reasoning.");
        for (const t of m.turns) {
            const loop = m.loopsById.get(t.loop_id);
            const run = loop ? m.runsById.get(loop.run_id) : undefined;
            const packet = Digest.#parseJson(t.packet, {}) as { assistant?: { reasoning?: unknown } };
            const reasoning = packet.assistant?.reasoning ?? null;
            lines.push("");
            lines.push(`## Run ${run?.id ?? "?"} / Loop ${loop?.sequence ?? "?"} / Turn ${t.sequence} (id=${t.id})`);
            lines.push("");
            if (typeof reasoning === "string" && reasoning.length > 0) lines.push(reasoning);
            else lines.push("(no reasoning_content)");
        }
        return lines.join("\n");
    }

    // Per-turn packet files, byte-identical to the wire (Engine and digest both
    // project through PacketWire). system/user are markdown; assistantRaw is JSON.
    static #writePacketFiles(m: DigestModel): string[] {
        const written: string[] = [];
        for (const t of m.turns) {
            const packet = Digest.#parseJson(t.packet, {}) as {
                sections?: unknown; assistant?: { content?: unknown }; assistantRaw?: unknown;
            };
            const padded = String(t.id).padStart(3, "0");
            const sections = (Array.isArray(packet.sections) ? packet.sections : []) as Parameters<typeof PacketWire.renderSlot>[0];
            const systemMd = PacketWire.renderSlot(sections, "system");
            const userMd = PacketWire.renderSlot(sections, "user");
            const assistantText = typeof packet.assistant?.content === "string" ? packet.assistant.content : "";
            const assistantRawJson = JSON.stringify(packet.assistantRaw ?? null, null, 2);
            const files: Array<[string, string]> = [
                [`packet${padded}.system.md`, systemMd],
                [`packet${padded}.user.md`, userMd],
                [`packet${padded}.assistant.md`, assistantText],
                [`packet${padded}.assistantRaw.json`, assistantRawJson],
            ];
            for (const [file, body] of files) {
                writeFileSync(join(m.digestDir, file), body);
                written.push(file);
            }
        }
        return written;
    }

    static #renderJson(m: DigestModel): string {
        return JSON.stringify({
            dbPath: m.dbPath,
            sessions: m.sessions.map((s) => ({ id: s.id, name: s.name, cost_pico: s.cost_pico })),
            runs: m.runs.map((r) => ({ id: r.id, session_id: r.session_id, name: r.name, cost_pico: r.cost_pico })),
            loops: m.loops.map((l) => ({
                id: l.id, run_id: l.run_id, sequence: l.sequence, status: l.status,
                prompt: l.prompt, flags: Digest.#parseJson(l.flags, {}),
            })),
            turns: m.turns.map((t) => ({
                id: t.id, loop_id: t.loop_id, sequence: t.sequence, status: t.status,
                usage_prompt: t.usage_prompt, usage_completion: t.usage_completion,
                usage_cached: t.usage_cached, usage_cost_pico: t.usage_cost_pico,
                finish_reason: t.finish_reason, model: t.model,
            })),
            log_entries: m.logEntries.map((le) => ({
                id: le.id, turn_id: le.turn_id, sequence: le.sequence,
                op: le.op, target: `${le.scheme ?? ""}://${le.pathname ?? ""}`,
                status_rx: le.status_rx, state: le.state, outcome: le.outcome,
            })),
        }, null, 2);
    }

    // Default DB path — mirrors the service (`Service.#expandHome(PLURNK_DB_PATH)`; the
    // `.env.example` floor is `~/.plurnk/plurnk.db`). The old repo-local default broke when
    // the DB moved to `~/.plurnk`; a no-arg digest now reads the service's actual DB.
    static defaultDbPath(): string {
        const env = process.env.PLURNK_DB_PATH;
        if (env !== undefined && env.length > 0) {
            if (env === "~") return homedir();
            return env.startsWith("~/") ? resolve(homedir(), env.slice(2)) : env;
        }
        return resolve(homedir(), ".plurnk", "plurnk.db");
    }

    static run(opts: DigestOptions): void {
        const binDir = dirname(fileURLToPath(import.meta.url));
        const dbPath = resolve(opts.dbPath);
        if (!existsSync(dbPath)) throw new Error(`digest: no DB at ${dbPath}`);
        const digestDir = opts.digestDir ?? join(resolve(binDir, ".."), "test", "digest");

        // Opens without readOnly so WAL-mode DBs (the daemon's normal operating
        // mode) inspect cleanly; this tool only reads. The DB is quiescent at
        // digest time, so each PREP reads on its own — no cross-query snapshot.
        const db = new SqlRiteSync({ path: dbPath, dir: [binDir] });
        let sessions = db.digest_sessions.all<SessionRow>();
        let runs = db.digest_runs.all<RunRow>();
        let loops = db.digest_loops.all<LoopRow>();
        let turns = db.digest_turns.all<TurnRow>();
        let logEntries = db.digest_log_entries.all<LogRow>();
        let runRollupRows = db.digest_run_rollups.all<RunRollupRow>();
        let opMixRows = db.digest_run_op_mix.all<OpMixRow>();
        db.close();

        // Optional run/session selector — narrow to one run or session; everything
        // cascades from the kept runs (loops→turns→log entries→rollups), so a consumer
        // (plurnk-bench) digests just the scope it cares about, not the whole DB. #264.
        if (opts.runId !== undefined) runs = runs.filter((r) => r.id === opts.runId);
        if (opts.sessionId !== undefined) runs = runs.filter((r) => r.session_id === opts.sessionId);
        if (opts.runId !== undefined || opts.sessionId !== undefined) {
            const keptRunIds = new Set(runs.map((r) => r.id));
            const keptSessionIds = new Set(runs.map((r) => r.session_id));
            sessions = sessions.filter((s) => keptSessionIds.has(s.id));
            loops = loops.filter((l) => keptRunIds.has(l.run_id));
            const keptLoopIds = new Set(loops.map((l) => l.id));
            turns = turns.filter((t) => keptLoopIds.has(t.loop_id));
            const keptTurnIds = new Set(turns.map((t) => t.id));
            logEntries = logEntries.filter((le) => keptTurnIds.has(le.turn_id));
            runRollupRows = runRollupRows.filter((r) => keptRunIds.has(r.run_id));
            opMixRows = opMixRows.filter((o) => keptRunIds.has(o.run_id));
        }

        // Wipe-then-recreate the digest dir so each run is a clean snapshot —
        // orphaned packet*.* files from a prior run don't linger.
        rmSync(digestDir, { recursive: true, force: true });
        mkdirSync(digestDir, { recursive: true });

        const runsBySession = new Map<number, RunRow[]>();
        for (const r of runs) { const arr = runsBySession.get(r.session_id) ?? []; arr.push(r); runsBySession.set(r.session_id, arr); }
        const loopsByRun = new Map<number, LoopRow[]>();
        for (const l of loops) { const arr = loopsByRun.get(l.run_id) ?? []; arr.push(l); loopsByRun.set(l.run_id, arr); }
        const turnsByLoop = new Map<number, TurnRow[]>();
        for (const t of turns) { const arr = turnsByLoop.get(t.loop_id) ?? []; arr.push(t); turnsByLoop.set(t.loop_id, arr); }
        const logEntriesByTurn = new Map<number, LogRow[]>();
        for (const le of logEntries) { const arr = logEntriesByTurn.get(le.turn_id) ?? []; arr.push(le); logEntriesByTurn.set(le.turn_id, arr); }
        const loopsById = new Map(loops.map((l) => [l.id, l]));
        const runsById = new Map(runs.map((r) => [r.id, r]));
        const runRollups = new Map(runRollupRows.map((r) => [r.run_id, r]));
        const opMixByRun = new Map<number, OpMixRow[]>();
        for (const o of opMixRows) { const arr = opMixByRun.get(o.run_id) ?? []; arr.push(o); opMixByRun.set(o.run_id, arr); }

        const m: DigestModel = {
            dbPath, digestDir, sessions, runs, loops, turns, logEntries,
            runsBySession, loopsByRun, turnsByLoop, logEntriesByTurn, loopsById, runsById,
            runRollups, opMixByRun,
        };

        writeFileSync(join(digestDir, "digest.md"), Digest.#renderWaterfall(m));
        writeFileSync(join(digestDir, "digest.json"), Digest.#renderJson(m));
        writeFileSync(join(digestDir, "reasoning.md"), Digest.#renderReasoning(m));
        const packetFiles = Digest.#writePacketFiles(m);

        console.log(`digest: wrote ${digestDir}/{digest.md,digest.json,reasoning.md} + ${packetFiles.length} packet section files`);
        console.log(`  source: ${dbPath}`);
        console.log(`  sessions=${sessions.length} runs=${runs.length} loops=${loops.length} turns=${turns.length} log_entries=${logEntries.length}`);
    }
}

// CLI entry — guarded so `import Digest from ".../bin/digest.ts"` has NO side effect
// (the #264 blocker for plurnk-bench). Default DB = the SERVICE's DB (PLURNK_DB_PATH,
// ~/.plurnk/plurnk.db floor), NOT the repo-local db; same test/digest output, same
// exit-1 on a missing DB.
if (import.meta.main) {
    try {
        Digest.run({ dbPath: process.argv[2] ?? Digest.defaultDbPath() });
    } catch (err) {
        process.stderr.write(`${(err as Error).message}\n`);
        process.exit(1);
    }
}
