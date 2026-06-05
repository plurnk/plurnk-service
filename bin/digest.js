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
//   test/digest/packetNNN.system.json     BYTE-FOR-BYTE the system message
//                                         the LLM received on turn id NNN.
//   test/digest/packetNNN.user.json       Same for the user message.
//   test/digest/packetNNN.assistant.json  Parsed model emission (Packet.json
//                                         §assistant: content + ops + reasoning).
//   test/digest/packetNNN.assistantRaw.json  Opaque provider response.
//
// packet files are byte-identical to what Engine.#packetToWireMessages
// emits (JSON.stringify of the Packet.json §system / §user sections). No
// invented separators, no compact rendering — wire and digest CANNOT
// structurally drift because they're produced from the same JSON form.
//
// Adapts rummy's bin/digest.js to plurnk-service's schema:
//   - rummy: entries + run_views + log://N/T/S/action paths
//   - plurnk: log_entries (dedicated table) + turns.packet (full JSON)
//
// Usage:
//   node bin/digest.js                          uses ./plurnk.db
//   node bin/digest.js <path-to-plurnk.db>      explicit DB path
//
// npm hook:
//   npm run test:digest [-- path/to/plurnk.db]

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import PacketWire from "../src/core/packet-wire.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const DIGEST_DIR = join(PROJECT_ROOT, "test", "digest");

const dbArg = process.argv[2] ?? join(PROJECT_ROOT, "plurnk.db");
const dbPath = resolve(dbArg);

if (!existsSync(dbPath)) {
    console.error(`digest: no DB at ${dbPath}`);
    process.exit(1);
}

// Wipe-then-recreate the digest dir so each run is a clean snapshot —
// orphaned packet*.* files from a prior run (different DB, fewer turns,
// etc.) don't linger and pollute forensics.
rmSync(DIGEST_DIR, { recursive: true, force: true });
mkdirSync(DIGEST_DIR, { recursive: true });

const summarize = (text, n = 80) => {
    if (text == null) return "";
    const flat = String(text).replace(/\s+/g, " ").trim();
    if (flat.length <= n) return flat;
    return `${flat.slice(0, n)}…`;
};

const parseJson = (s, fallback = null) => {
    if (s == null) return fallback;
    try { return JSON.parse(s); } catch { return fallback; }
};

// --- Read all the things ---------------------------------------------------

// Open without readOnly so WAL-mode dbs (the daemon's normal operating mode)
// can be inspected while or after the daemon has run. node:sqlite's
// `readOnly: true` blocks WAL recovery on open and throws SQLITE_IOERR.
// This script never writes — discipline is in our hands, not the flag.
const db = new DatabaseSync(dbPath);

// Snapshot consistency: wrap every read in a single deferred transaction
// so all queries see the same committed-state. Without this, the daemon
// committing rows while digest is iterating produces inconsistent counts
// (e.g., turns query sees N rows, log_entries query a millisecond later
// sees rows that reference turn N+1 which the earlier query didn't
// include). BEGIN DEFERRED takes a read lock on first query; reads stay
// consistent until COMMIT.
db.exec("BEGIN DEFERRED");
let sessions, runs, loops, turns, logEntries, entryChannels;
try {
    sessions = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    runs = db.prepare("SELECT * FROM runs ORDER BY id").all();
    loops = db.prepare(
        `SELECT id, run_id, sequence, status, prompt, flags FROM loops ORDER BY run_id, sequence`,
    ).all();
    turns = db.prepare(
        `SELECT id, loop_id, sequence, status, packet,
                usage_prompt, usage_completion, usage_cached, usage_cost_pico,
                finish_reason, model, timestamp
         FROM turns ORDER BY loop_id, sequence`,
    ).all();
    logEntries = db.prepare(
        `SELECT id, run_id, loop_id, turn_id, sequence, at, origin,
                op, suffix, signal,
                scheme, pathname,
                tx, rx, status_rx, mimetype_rx,
                state, outcome, attrs
         FROM log_entries ORDER BY loop_id, turn_id, sequence`,
    ).all();
    entryChannels = db.prepare(
        `SELECT ec.entry_id, ec.name AS channel, ec.mimetype, ec.tokens, ec.state, ec.content,
                e.scheme, e.pathname, e.session_id
         FROM entry_channels ec
         JOIN entries e ON e.id = ec.entry_id
         ORDER BY ec.entry_id, ec.name`,
    ).all();
    // Sanity recount of counts that go into the digest header. If these
    // diverge from the data we already loaded, something is wrong with the
    // snapshot (would be a bug). Hard-fail rather than report stale numbers.
    const turnsRecount = db.prepare("SELECT COUNT(*) AS n FROM turns").get().n;
    const logsRecount = db.prepare("SELECT COUNT(*) AS n FROM log_entries").get().n;
    if (turnsRecount !== turns.length) {
        throw new Error(`digest: snapshot inconsistency — turns rows ${turns.length} vs recount ${turnsRecount}`);
    }
    if (logsRecount !== logEntries.length) {
        throw new Error(`digest: snapshot inconsistency — log_entries rows ${logEntries.length} vs recount ${logsRecount}`);
    }
} finally {
    db.exec("COMMIT");
}

db.close();

// --- Index helpers ---------------------------------------------------------

const loopsByRun = new Map();
for (const l of loops) {
    const arr = loopsByRun.get(l.run_id) ?? [];
    arr.push(l);
    loopsByRun.set(l.run_id, arr);
}
const turnsByLoop = new Map();
for (const t of turns) {
    const arr = turnsByLoop.get(t.loop_id) ?? [];
    arr.push(t);
    turnsByLoop.set(t.loop_id, arr);
}
const logEntriesByTurn = new Map();
for (const le of logEntries) {
    const arr = logEntriesByTurn.get(le.turn_id) ?? [];
    arr.push(le);
    logEntriesByTurn.set(le.turn_id, arr);
}
const sessionsById = new Map(sessions.map((s) => [s.id, s]));
const runsById = new Map(runs.map((r) => [r.id, r]));
const loopsById = new Map(loops.map((l) => [l.id, l]));
const channelsByEntry = new Map();
for (const c of entryChannels) {
    const arr = channelsByEntry.get(c.entry_id) ?? [];
    arr.push(c);
    channelsByEntry.set(c.entry_id, arr);
}

// --- Rendering -------------------------------------------------------------

const renderOpLine = (le) => {
    const target = le.scheme !== null && le.pathname !== null
        ? `${le.scheme}://${le.pathname}`
        : le.pathname ?? "—";
    const state = le.state !== "resolved" ? ` state=${le.state}` : "";
    const outcome = le.outcome !== null ? ` outcome=${le.outcome}` : "";
    const fail = le.status_rx >= 400 ? " ✗" : "";
    // For non-2xx outcomes, surface the error string (or body) from rx so
    // the waterfall view explains WHY each failure happened without making
    // a reader open packets.md for every op.
    let errLine = "";
    if (le.status_rx >= 400) {
        const rx = parseJson(le.rx, {});
        const msg = rx.error ?? rx.body ?? null;
        if (typeof msg === "string" && msg.length > 0) {
            errLine = `\n    → ${summarize(msg, 140)}`;
        }
    }
    return `  ← ${le.op}[${le.status_rx}] ${target}${state}${outcome}${fail}${errLine}`;
};

const renderTurnLine = (turn) => {
    const packet = parseJson(turn.packet, {});
    const assistant = packet.assistant ?? {};
    const content = typeof assistant.content === "string" ? assistant.content : "";
    const reasoning = typeof assistant.reasoning === "string" ? assistant.reasoning : null;
    const tokens = `prompt=${turn.usage_prompt} completion=${turn.usage_completion} cached=${turn.usage_cached}`;
    const cost = turn.usage_cost_pico > 0 ? ` cost=$${(turn.usage_cost_pico / 1e12).toFixed(6)}` : "";
    const finishReason = turn.finish_reason ?? "—";
    const model = turn.model ?? "—";
    const head = `T${turn.sequence}: status=${turn.status} finish=${finishReason} model=${model} ${tokens}${cost}`;
    const summary = content.length > 0 ? `  ↳ emission: ${summarize(content, 100)}` : `  ↳ emission: (empty)`;
    const reasoningLine = reasoning && reasoning.length > 0
        ? `  ↳ reasoning: ${summarize(reasoning, 100)}`
        : null;
    const opLines = (logEntriesByTurn.get(turn.id) ?? []).map(renderOpLine);
    return [head, summary, ...(reasoningLine ? [reasoningLine] : []), ...opLines].join("\n");
};

const renderRunShape = (run) => {
    const runLoops = loopsByRun.get(run.id) ?? [];
    const runTurns = runLoops.flatMap((l) => turnsByLoop.get(l.id) ?? []);
    let lastStatus = null;
    let totalCost = 0;
    let totalPrompt = 0;
    let totalCompletion = 0;
    let totalCached = 0;
    const opCounts = new Map();
    for (const t of runTurns) {
        lastStatus = t.status;
        totalCost += t.usage_cost_pico ?? 0;
        totalPrompt += t.usage_prompt ?? 0;
        totalCompletion += t.usage_completion ?? 0;
        totalCached += t.usage_cached ?? 0;
        const turnLogs = logEntriesByTurn.get(t.id) ?? [];
        for (const le of turnLogs) {
            opCounts.set(le.op, (opCounts.get(le.op) ?? 0) + 1);
        }
    }
    const opMix = [...opCounts.entries()]
        .toSorted((a, b) => b[1] - a[1])
        .map(([op, n]) => `${op}=${n}`)
        .join(" ");
    const costStr = totalCost > 0 ? `$${(totalCost / 1e12).toFixed(6)}` : "$0";
    return [
        `Loops:      ${runLoops.length}`,
        `Turns:      ${runTurns.length}`,
        `Last turn:  ${lastStatus !== null ? `status=${lastStatus}` : "(none)"}`,
        `Tokens:     prompt=${totalPrompt} completion=${totalCompletion} cached=${totalCached}`,
        `Cost:       ${costStr} (DB rollup runs.cost_pico=${run.cost_pico})`,
        `Op mix:     ${opMix || "(no ops)"}`,
    ].join("\n");
};

const renderWaterfall = () => {
    const lines = [];
    lines.push(`# plurnk-service digest`);
    lines.push("");
    lines.push(`DB: ${dbPath}`);
    lines.push(`Sessions: ${sessions.length}  Runs: ${runs.length}  Loops: ${loops.length}  Turns: ${turns.length}  Log entries: ${logEntries.length}`);
    for (const session of sessions) {
        lines.push("");
        lines.push(`## Session #${session.id} — ${session.name}`);
        const sessionRuns = runs.filter((r) => r.session_id === session.id);
        for (const run of sessionRuns) {
            lines.push("");
            lines.push(`### Run #${run.id} — ${run.name}`);
            lines.push("");
            lines.push("```");
            lines.push(renderRunShape(run));
            lines.push("```");
            const runLoops = loopsByRun.get(run.id) ?? [];
            for (const loop of runLoops) {
                lines.push("");
                lines.push(`#### Loop ${loop.sequence} (id=${loop.id}, status=${loop.status})`);
                lines.push("");
                lines.push(`Prompt: ${summarize(loop.prompt, 160)}`);
                const flags = parseJson(loop.flags, {});
                const flagSummary = Object.entries(flags).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ");
                if (flagSummary.length > 0) lines.push(`Flags: ${flagSummary}`);
                lines.push("");
                lines.push("```");
                const loopTurns = turnsByLoop.get(loop.id) ?? [];
                for (const t of loopTurns) lines.push(renderTurnLine(t));
                lines.push("```");
            }
        }
    }
    return lines.join("\n");
};

const renderReasoning = () => {
    const lines = [];
    lines.push(`# plurnk-service reasoning`);
    lines.push("");
    lines.push("Per-turn reasoning_content extracted from turns.packet.assistant.reasoning.");
    for (const t of turns) {
        const loop = loopsById.get(t.loop_id);
        const run = loop ? runsById.get(loop.run_id) : null;
        const packet = parseJson(t.packet, {});
        const reasoning = packet.assistant?.reasoning ?? null;
        lines.push("");
        lines.push(`## Run ${run?.id ?? "?"} / Loop ${loop?.sequence ?? "?"} / Turn ${t.sequence} (id=${t.id})`);
        lines.push("");
        if (reasoning && reasoning.length > 0) {
            lines.push(reasoning);
        } else {
            lines.push("(no reasoning_content)");
        }
    }
    return lines.join("\n");
};

// Per-turn packet files. Each turn produces four files:
//   packetNNN.system.md         — system message content (markdown), BYTE-
//                                 IDENTICAL to what the LLM received on the
//                                 wire (Engine and digest both call
//                                 renderSystemContent from packet-wire.js).
//   packetNNN.user.md           — user message content (markdown), same.
//   packetNNN.assistant.md      — model's raw DSL emission (string).
//   packetNNN.assistantRaw.json — opaque provider response. JSON because
//                                 it's structured (the provider's wire envelope).
//
// Wire ↔ digest cannot drift because they call the same projection function.
const writePacketFiles = () => {
    const written = [];
    for (const t of turns) {
        const packet = parseJson(t.packet, {});
        const padded = String(t.id).padStart(3, "0");
        const systemMd = PacketWire.renderSystemContent(packet.system ?? {});
        const userMd = PacketWire.renderUserContent(packet.user ?? {});
        const assistantText = packet.assistant?.content ?? "";
        const assistantRawJson = JSON.stringify(packet.assistantRaw ?? null, null, 2);
        const files = [
            [`packet${padded}.system.md`, systemMd],
            [`packet${padded}.user.md`, userMd],
            [`packet${padded}.assistant.md`, assistantText],
            [`packet${padded}.assistantRaw.json`, assistantRawJson],
        ];
        for (const [file, body] of files) {
            writeFileSync(join(DIGEST_DIR, file), body);
            written.push(file);
        }
    }
    return written;
};

const renderJson = () => {
    return JSON.stringify({
        dbPath,
        sessions: sessions.map((s) => ({ id: s.id, name: s.name, cost_pico: s.cost_pico })),
        runs: runs.map((r) => ({ id: r.id, session_id: r.session_id, name: r.name, cost_pico: r.cost_pico })),
        loops: loops.map((l) => ({
            id: l.id, run_id: l.run_id, sequence: l.sequence, status: l.status,
            prompt: l.prompt, flags: parseJson(l.flags, {}),
        })),
        turns: turns.map((t) => ({
            id: t.id, loop_id: t.loop_id, sequence: t.sequence, status: t.status,
            usage_prompt: t.usage_prompt, usage_completion: t.usage_completion,
            usage_cached: t.usage_cached, usage_cost_pico: t.usage_cost_pico,
            finish_reason: t.finish_reason, model: t.model,
        })),
        log_entries: logEntries.map((le) => ({
            id: le.id, turn_id: le.turn_id, sequence: le.sequence,
            op: le.op, target: `${le.scheme ?? ""}://${le.pathname ?? ""}`,
            status_rx: le.status_rx, state: le.state, outcome: le.outcome,
        })),
    }, null, 2);
};

// --- Write outputs ---------------------------------------------------------

writeFileSync(join(DIGEST_DIR, "digest.md"), renderWaterfall());
writeFileSync(join(DIGEST_DIR, "digest.json"), renderJson());
writeFileSync(join(DIGEST_DIR, "reasoning.md"), renderReasoning());
const packetFiles = writePacketFiles();

console.log(`digest: wrote test/digest/{digest.md,digest.json,reasoning.md} + ${packetFiles.length} packet section files`);
console.log(`  source: ${dbPath}`);
console.log(`  sessions=${sessions.length} runs=${runs.length} loops=${loops.length} turns=${turns.length} log_entries=${logEntries.length}`);
