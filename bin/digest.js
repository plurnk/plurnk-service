#!/usr/bin/env node
//
// Run-digest tool for plurnk-service DBs. Reads a sqlite plurnk*.db and
// emits per-run forensic artifacts to test/digest/. First-order forensic
// surface; read-only; safe to re-run.
//
//   test/digest/digest.md     Run-shape header + waterfall (per-turn line:
//                             status, model emission summary, indented op
//                             list with target + status, reasoning excerpt)
//   test/digest/digest.json   Same data, machine-queryable
//   test/digest/reasoning.md  Per-turn reasoning text (full)
//   test/digest/packets.md    Per-turn assembled wire packet (system,
//                             user, assistant sections from turns.packet)
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
//   npm run dev:digest [-- path/to/plurnk.db]

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const DIGEST_DIR = join(PROJECT_ROOT, "test", "digest");

const dbArg = process.argv[2] ?? join(PROJECT_ROOT, "plurnk.db");
const dbPath = resolve(dbArg);

if (!existsSync(dbPath)) {
    console.error(`digest: no DB at ${dbPath}`);
    process.exit(1);
}

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

const db = new DatabaseSync(dbPath, { readOnly: true });

const sessions = db.prepare("SELECT * FROM sessions ORDER BY id").all();
const runs = db.prepare("SELECT * FROM runs ORDER BY id").all();
const loops = db.prepare(
    `SELECT id, run_id, sequence, status, prompt, flags FROM loops ORDER BY run_id, sequence`,
).all();
const turns = db.prepare(
    `SELECT id, loop_id, sequence, status, packet,
            usage_prompt, usage_completion, usage_cached, usage_cost_pico,
            finish_reason, model, timestamp
     FROM turns ORDER BY loop_id, sequence`,
).all();
const logEntries = db.prepare(
    `SELECT id, run_id, loop_id, turn_id, action_index, at, origin,
            op, suffix, signal,
            target_scheme, target_pathname,
            tx, rx, status_rx, mimetype_rx,
            state, outcome, attrs
     FROM log_entries ORDER BY loop_id, turn_id, action_index`,
).all();
const entryChannels = db.prepare(
    `SELECT ec.entry_id, ec.name AS channel, ec.mimetype, ec.tokens, ec.state, ec.content,
            e.scheme, e.pathname, e.session_id
     FROM entry_channels ec
     JOIN entries e ON e.id = ec.entry_id
     ORDER BY ec.entry_id, ec.name`,
).all();

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
    const target = le.target_scheme !== null && le.target_pathname !== null
        ? `${le.target_scheme}://${le.target_pathname}`
        : le.target_pathname ?? "—";
    const state = le.state !== "resolved" ? ` state=${le.state}` : "";
    const outcome = le.outcome !== null ? ` outcome=${le.outcome}` : "";
    const fail = le.status_rx >= 400 ? " ✗" : "";
    return `  ← ${le.op}[${le.status_rx}] ${target}${state}${outcome}${fail}`;
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

const renderPackets = () => {
    const lines = [];
    lines.push(`# plurnk-service packets`);
    lines.push("");
    lines.push("Per-turn assembled wire packet. `system` and `user` are what the engine sent");
    lines.push("to the LLM (system_definition + persona + index + log entries; user prompt +");
    lines.push("telemetry); `assistant` is the model's parsed emission (content + ops +");
    lines.push("reasoning); `assistantRaw` is the unparsed wire response (for forensic detail).");
    for (const t of turns) {
        const loop = loopsById.get(t.loop_id);
        const run = loop ? runsById.get(loop.run_id) : null;
        const packet = parseJson(t.packet, {});
        lines.push("");
        lines.push(`## Run ${run?.id ?? "?"} / Loop ${loop?.sequence ?? "?"} / Turn ${t.sequence} (id=${t.id})`);
        lines.push("");
        lines.push(`Status: ${t.status}  Finish: ${t.finish_reason ?? "—"}  Model: ${t.model ?? "—"}`);
        lines.push(`Usage:  prompt=${t.usage_prompt} completion=${t.usage_completion} cached=${t.usage_cached} cost_pico=${t.usage_cost_pico}`);
        lines.push(`Packet token subtotals: total=${packet.tokens ?? 0} system=${packet.system?.tokens ?? 0} user=${packet.user?.tokens ?? 0}`);
        lines.push("");
        lines.push("### system");
        lines.push("");
        lines.push("```");
        if (packet.system) {
            const sys = packet.system;
            if (sys.system_definition) {
                lines.push("--- system_definition ---");
                lines.push(sys.system_definition);
            }
            if (typeof sys.persona === "string" && sys.persona.length > 0) {
                lines.push("");
                lines.push("--- persona ---");
                lines.push(sys.persona);
            }
            if (Array.isArray(sys.index)) {
                lines.push("");
                lines.push(`--- index (${sys.index.length} entries) ---`);
                for (const entry of sys.index) {
                    lines.push(`  ${entry.scheme ?? "?"}://${entry.pathname ?? ""}`);
                    for (const [chanName, chan] of Object.entries(entry.channels ?? {})) {
                        const c = chan;
                        lines.push(`    ${chanName} (${c.mimetype}, ${c.tokens}t): ${summarize(c.content, 100)}`);
                    }
                }
            }
            if (Array.isArray(sys.log)) {
                lines.push("");
                lines.push(`--- log (${sys.log.length} entries) ---`);
                for (const entry of sys.log) {
                    lines.push(`  [${entry.coordinate ?? "?"}] ${entry.op ?? "?"} status=${entry.status_rx ?? "?"} ${summarize(JSON.stringify(entry.rx), 100)}`);
                }
            }
        }
        lines.push("```");
        lines.push("");
        lines.push("### user");
        lines.push("");
        lines.push("```");
        if (packet.user) {
            const u = packet.user;
            if (u.prompt) {
                lines.push("--- prompt ---");
                lines.push(u.prompt);
            }
            if (u.telemetry) {
                const t = u.telemetry;
                if (t.budget && t.budget.length > 0) {
                    lines.push("");
                    lines.push("--- telemetry.budget ---");
                    lines.push(t.budget);
                }
                if (Array.isArray(t.errors) && t.errors.length > 0) {
                    lines.push("");
                    lines.push(`--- telemetry.errors (${t.errors.length}) ---`);
                    for (const err of t.errors) lines.push(JSON.stringify(err));
                }
            }
            if (u.system_requirements) {
                lines.push("");
                lines.push("--- system_requirements ---");
                lines.push(u.system_requirements);
            }
        }
        lines.push("```");
        lines.push("");
        lines.push("### assistant");
        lines.push("");
        lines.push("```");
        if (packet.assistant) {
            const a = packet.assistant;
            if (a.content) {
                lines.push("--- content (raw DSL) ---");
                lines.push(a.content);
            }
            if (Array.isArray(a.ops) && a.ops.length > 0) {
                lines.push("");
                lines.push(`--- ops (${a.ops.length} parsed) ---`);
                for (const op of a.ops) {
                    const path = op.path === null ? "(broadcast)"
                        : op.path?.kind === "url" ? `${op.path.scheme}://${op.path.pathname}`
                        : op.path?.raw ?? "?";
                    lines.push(`  ${op.op} ${path}`);
                }
            }
            if (a.reasoning) {
                lines.push("");
                lines.push("--- reasoning ---");
                lines.push(summarize(a.reasoning, 240));
            }
        }
        lines.push("```");
        lines.push("");
        lines.push("### assistantRaw");
        lines.push("");
        lines.push("```");
        lines.push(JSON.stringify(packet.assistantRaw ?? null, null, 2));
        lines.push("```");
    }
    return lines.join("\n");
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
            id: le.id, turn_id: le.turn_id, action_index: le.action_index,
            op: le.op, target: `${le.target_scheme ?? ""}://${le.target_pathname ?? ""}`,
            status_rx: le.status_rx, state: le.state, outcome: le.outcome,
        })),
    }, null, 2);
};

// --- Write outputs ---------------------------------------------------------

writeFileSync(join(DIGEST_DIR, "digest.md"), renderWaterfall());
writeFileSync(join(DIGEST_DIR, "digest.json"), renderJson());
writeFileSync(join(DIGEST_DIR, "reasoning.md"), renderReasoning());
writeFileSync(join(DIGEST_DIR, "packets.md"), renderPackets());

console.log(`digest: wrote test/digest/{digest.md,digest.json,reasoning.md,packets.md}`);
console.log(`  source: ${dbPath}`);
console.log(`  sessions=${sessions.length} runs=${runs.length} loops=${loops.length} turns=${turns.length} log_entries=${logEntries.length}`);
