// {§contract-representations} {§acp-action-binding} {§client-family-commands} {§client-schedule-command}
// Runtime-neutral schedule wire types, quote-preserving slash-argument tokenizer,
// schedule command parser, Problem extractor, and row/inspect/receipt formatters.

import { isRecord } from "./guards.ts";
import Problems from "./Problems.ts";
import type { ProblemDetails } from "./types.generated.ts";

export type ScheduleStatus = "open" | "done" | "fail";

export interface ScheduledToolCall {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly aside?: string;
}

export interface ScheduledStepReceipt {
    readonly index: number;
    readonly server: string;
    readonly tool: string;
    readonly status: number;
    readonly uri?: string;
    readonly preview?: string;
    readonly problem?: ProblemDetails;
}

export interface ScheduleRunResult {
    readonly alias: string;
    readonly status: ScheduleStatus;
    readonly loopId?: number | null;
    readonly lastFiredAt?: string | null;
    readonly doneAt?: string | null;
    readonly results?: readonly ScheduledStepReceipt[];
}

export const SCHEDULE_USAGE = `usage: /schedule [list|show|inspect|discover|add|replace|run|done|reopen|enable|disable|remove] [options]

subcommands:
  list                                     List workspace schedules and macros (default).
  show <alias> | inspect <alias>           Inspect one schedule or macro definition in full.
  discover [<rule>]                        Show workspace clock or preview occurrences of <rule>.
  add <alias> <session> <rule> <prompt...> Add a prompt schedule (cron, RRULE, +duration, ISO, manual, or once).
  add <alias> [--manual|--once|--rule <r>] --target <session> [--persona <p>] [--catchup|--no-catchup] --prompt <text>
  add <alias> [--manual|--once|--rule <r>] --step <server>.<tool> ['<json>'] [--aside <label>] [--step ...]
  add <alias> [--manual|--once|--rule <r>] --run '<json-steps>'
  replace ...                              Replace an existing schedule or macro using any add form.
  run <alias>                              Execute a schedule or macro now and display step receipts.
  done <alias> | reopen <alias>            Mark an obligation done or reopen it.
  enable <alias> | disable <alias>         Enable or disable a schedule.
  remove <alias>                           Remove a workspace schedule.
`;

export const SCHEDULE_ADD_FLAGS: readonly { readonly value: string; readonly description: string }[] = Object.freeze([
    { value: "--manual", description: "Reusable on-demand trigger (default)" },
    { value: "--once", description: "Single-shot unscheduled obligation" },
    { value: "--rule", description: "Cron, RRULE, +duration, or ISO timestamp" },
    { value: "--step", description: "Add macro step: <server>.<tool> ['<json>']" },
    { value: "--run", description: "JSON array of macro tool-call steps" },
    { value: "--aside", description: "Short label for the preceding --step" },
    { value: "--target", description: "Target session://<name>" },
    { value: "--prompt", description: "Prompt text delivered to target session" },
    { value: "--persona", description: "Optional persona for auto-created session" },
    { value: "--catchup", description: "Fire missed window once on daemon wake" },
    { value: "--no-catchup", description: "Skip missed occurrences after downtime" },
]);

class FamilyCommandUsageError extends Error {
    readonly problem: ProblemDetails;

    constructor(title: string, detail: string, recovery?: string) {
        super(detail);
        this.name = "FamilyCommandUsageError";
        this.problem = Problems.create(
            "client",
            "usage",
            400,
            detail,
            recovery !== undefined ? { recovery } : {},
            { title },
        );
    }
}

const usageError = (title: string, detail: string, recovery?: string): Error =>
    new FamilyCommandUsageError(title, detail, recovery);

/**
 * {§acp-action-binding} Shell-style tokenizer for interactive slash-command arguments so quoted rules
 * (`"0 9 * * 1-5"`) and JSON step payloads (`'{"text":"echo hi"}'`) stay intact.
 */
export const tokenizeSlashArgs = (raw: string): string[] => {
    const tokens: string[] = [];
    let current = "";
    let inToken = false;
    let quote: "'" | '"' | null = null;

    for (let i = 0; i < raw.length; i += 1) {
        const ch = raw[i];
        if (quote !== null) {
            if (quote === '"' && ch === "\\" && i + 1 < raw.length) {
                const next = raw[i + 1];
                if (next === '"' || next === "\\" || next === "$" || next === "`") {
                    current += next;
                    i += 1;
                    continue;
                }
            }
            if (ch === quote) {
                quote = null;
                continue;
            }
            current += ch;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            inToken = true;
            continue;
        }
        if (ch === "\\" && i + 1 < raw.length && /\s/u.test(raw[i + 1])) {
            current += raw[i + 1];
            inToken = true;
            i += 1;
            continue;
        }
        if (/\s/u.test(ch)) {
            if (inToken) {
                tokens.push(current);
                current = "";
                inToken = false;
            }
            continue;
        }
        current += ch;
        inToken = true;
    }

    if (quote !== null) {
        throw usageError(
            "Unterminated quote",
            `Unclosed ${quote === "'" ? "single" : "double"} quote in command arguments.`,
        );
    }
    if (inToken) {
        tokens.push(current);
    }
    return tokens;
};

const normalizeTarget = (raw: string): string =>
    raw.startsWith("session://") ? raw : `session://${raw}`;

const validateToolCall = (raw: unknown, index: number): ScheduledToolCall => {
    if (!isRecord(raw)) {
        throw usageError(
            "Invalid macro step",
            `Step #${String(index)} must be a JSON object with 'server' and 'tool'.`,
            `--run '[{"server":"plurnk","tool":"sh","arguments":{"text":"echo hi"}}]'`,
        );
    }
    const server = typeof raw.server === "string" ? raw.server.trim() : "";
    const tool = typeof raw.tool === "string" ? raw.tool.trim() : "";
    if (server.length === 0 || tool.length === 0) {
        throw usageError(
            "Invalid macro step",
            `Step #${String(index)} requires non-empty 'server' and 'tool' strings.`,
            `--run '[{"server":"plurnk","tool":"sh","arguments":{"text":"echo hi"}}]'`,
        );
    }
    let stepArgs: Record<string, unknown> | undefined;
    if (raw.arguments !== undefined) {
        if (!isRecord(raw.arguments)) {
            throw usageError(
                "Invalid step arguments",
                `Step #${String(index)} (${server}.${tool}) 'arguments' must be a JSON object.`,
            );
        }
        stepArgs = raw.arguments;
    }
    let aside: string | undefined;
    if (raw.aside !== undefined) {
        if (typeof raw.aside !== "string" || raw.aside.trim().length === 0) {
            throw usageError(
                "Invalid step aside",
                `Step #${String(index)} (${server}.${tool}) 'aside' must be a non-empty string.`,
            );
        }
        aside = raw.aside.trim();
    }
    return {
        server,
        tool,
        ...(stepArgs !== undefined && Object.keys(stepArgs).length > 0 ? { arguments: stepArgs } : {}),
        ...(aside !== undefined ? { aside } : {}),
    };
};

const parseRunJson = (raw: string): readonly ScheduledToolCall[] => {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw usageError(
            "Invalid --run JSON",
            `--run requires a JSON array of { server, tool, arguments?, aside? } steps: ${err instanceof Error ? err.message : String(err)}`,
            `--run '[{"server":"plurnk","tool":"sh","arguments":{"text":"echo hi"}}]'`,
        );
    }
    const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? [parsed] : null;
    if (list === null || list.length === 0) {
        throw usageError(
            "Invalid --run steps",
            "--run must be a non-empty JSON array of { server, tool, arguments?, aside? } objects.",
            `--run '[{"server":"plurnk","tool":"sh","arguments":{"text":"echo hi"}}]'`,
        );
    }
    return list.map((item, idx) => validateToolCall(item, idx));
};

const parseStepSpec = (spec: string): { readonly server: string; readonly tool: string } => {
    const dot = spec.indexOf(".");
    if (dot <= 0 || dot === spec.length - 1) {
        throw usageError(
            "Invalid --step target",
            `--step expects <server>.<tool> (got ${JSON.stringify(spec)}).`,
            `--step plurnk.sh '{"text":"echo hi"}'`,
        );
    }
    const server = spec.slice(0, dot).trim();
    const tool = spec.slice(dot + 1).trim();
    if (server.length === 0 || tool.length === 0) {
        throw usageError(
            "Invalid --step target",
            `--step expects non-empty <server>.<tool> (got ${JSON.stringify(spec)}).`,
            `--step plurnk.sh '{"text":"echo hi"}'`,
        );
    }
    return { server, tool };
};

const requireFlagValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) {
        throw usageError("Missing option value", `${flag} requires a value.`);
    }
    return value;
};

export interface ParsedScheduleFamilyCommand {
    readonly scopePrefix: "workspace";
    readonly sub: string;
    readonly rest: readonly string[];
    readonly actionName: string;
    readonly params: Record<string, unknown>;
}

/**
 * {§acp-action-binding} Canonical `schedule` subcommand parser shared by `parseFamilyCommand`, ACP, CLI, and Web.
 */
export const parseScheduleFamilyArgs = (
    rawSub: string,
    rest: readonly string[],
): ParsedScheduleFamilyCommand => {
    const sub = rawSub.toLowerCase();

    if (sub === "list") {
        return {
            scopePrefix: "workspace",
            sub: "list",
            rest,
            actionName: "workspace.schedule.list",
            params: {},
        };
    }

    if (sub === "show" || sub === "inspect") {
        const alias = (rest[0] ?? "").trim();
        if (alias.length === 0) {
            throw usageError("Missing schedule alias", `usage: /schedule ${sub} <alias>`);
        }
        return {
            scopePrefix: "workspace",
            sub: "inspect",
            rest: [alias, ...rest.slice(1)],
            actionName: "workspace.schedule.list",
            params: {},
        };
    }

    if (sub === "discover") {
        let ruleFlag: string | undefined;
        const posArgs: string[] = [];
        for (let i = 0; i < rest.length; i += 1) {
            const tok = rest[i];
            if (tok === "--rule") {
                ruleFlag = requireFlagValue("--rule", rest[i + 1]);
                i += 1;
            } else if (tok.startsWith("--rule=")) {
                ruleFlag = tok.slice("--rule=".length);
            } else {
                posArgs.push(tok);
            }
        }
        const rule = ruleFlag ?? (posArgs.length > 0 ? posArgs.join(" ") : undefined);
        return {
            scopePrefix: "workspace",
            sub: "discover",
            rest,
            actionName: "workspace.schedule.discover",
            params: rule !== undefined && rule.length > 0 ? { rule } : {},
        };
    }

    if (sub === "enable" || sub === "disable" || sub === "remove") {
        const alias = (rest[0] ?? "").trim();
        if (alias.length === 0) {
            throw usageError("Missing schedule alias", `usage: /schedule ${sub} <alias>`);
        }
        return {
            scopePrefix: "workspace",
            sub,
            rest,
            actionName: `workspace.schedule.${sub}`,
            params: { alias },
        };
    }

    if (sub === "run") {
        const alias = (rest[0] ?? "").trim();
        if (alias.length === 0) {
            throw usageError("Missing schedule alias", "usage: /schedule run <alias>");
        }
        return {
            scopePrefix: "workspace",
            sub: "run",
            rest,
            actionName: "workspace.schedule.run",
            params: { alias },
        };
    }

    if (sub === "done" || sub === "reopen" || sub === "open") {
        const alias = (rest[0] ?? "").trim();
        if (alias.length === 0) {
            throw usageError("Missing schedule alias", `usage: /schedule ${sub} <alias>`);
        }
        return {
            scopePrefix: "workspace",
            sub: "status",
            rest,
            actionName: "workspace.schedule.status",
            params: { alias, status: sub === "done" ? "done" : "open" },
        };
    }

    if (sub === "add" || sub === "replace") {
        let timingKind: "manual" | "once" | "rule" | undefined;
        let ruleFlag: string | undefined;
        let runFlag: string | undefined;
        let targetFlag: string | undefined;
        let promptFlag: string | undefined;
        let personaFlag: string | undefined;
        let catchupFlag: boolean | undefined;
        const steps: Array<{ server: string; tool: string; arguments?: Record<string, unknown>; aside?: string }> = [];
        const posArgs: string[] = [];

        const setTiming = (kind: "manual" | "once" | "rule", value: string): void => {
            if (timingKind !== undefined) {
                throw usageError("Conflicting timing flags", "Specify at most one of --manual, --once, or --rule.");
            }
            timingKind = kind;
            ruleFlag = value;
        };

        for (let i = 0; i < rest.length; i += 1) {
            const tok = rest[i];
            if (tok === "--manual") {
                setTiming("manual", "manual");
            } else if (tok === "--once") {
                setTiming("once", "once");
            } else if (tok === "--rule") {
                setTiming("rule", requireFlagValue("--rule", rest[i + 1]));
                i += 1;
            } else if (tok.startsWith("--rule=")) {
                setTiming("rule", tok.slice("--rule=".length));
            } else if (tok === "--run") {
                runFlag = requireFlagValue("--run", rest[i + 1]);
                i += 1;
            } else if (tok.startsWith("--run=")) {
                runFlag = tok.slice("--run=".length);
            } else if (tok === "--step" || tok.startsWith("--step=")) {
                const rawSpec = tok === "--step"
                    ? requireFlagValue("--step", rest[i + 1])
                    : tok.slice("--step=".length);
                if (tok === "--step") i += 1;
                const { server, tool } = parseStepSpec(rawSpec);
                const next = rest[i + 1];
                let stepArgs: Record<string, unknown> | undefined;
                if (next !== undefined && !next.startsWith("--") && next.trim().startsWith("{")) {
                    let parsedArgs: unknown;
                    try {
                        parsedArgs = JSON.parse(next);
                    } catch (err) {
                        throw usageError(
                            "Invalid --step arguments JSON",
                            `Step ${server}.${tool} arguments must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
                        );
                    }
                    if (!isRecord(parsedArgs)) {
                        throw usageError(
                            "Invalid --step arguments JSON",
                            `Step ${server}.${tool} arguments must be a JSON object.`,
                        );
                    }
                    stepArgs = parsedArgs;
                    i += 1;
                }
                steps.push({
                    server,
                    tool,
                    ...(stepArgs !== undefined && Object.keys(stepArgs).length > 0 ? { arguments: stepArgs } : {}),
                });
            } else if (tok === "--aside" || tok.startsWith("--aside=")) {
                const asideVal = tok === "--aside"
                    ? requireFlagValue("--aside", rest[i + 1])
                    : tok.slice("--aside=".length);
                if (tok === "--aside") i += 1;
                const lastStep = steps.at(-1);
                if (lastStep === undefined) {
                    throw usageError("Unexpected --aside", "--aside must follow a --step <server>.<tool> flag.");
                }
                lastStep.aside = asideVal;
            } else if (tok === "--target") {
                targetFlag = requireFlagValue("--target", rest[i + 1]);
                i += 1;
            } else if (tok.startsWith("--target=")) {
                targetFlag = tok.slice("--target=".length);
            } else if (tok === "--prompt") {
                promptFlag = requireFlagValue("--prompt", rest[i + 1]);
                i += 1;
            } else if (tok.startsWith("--prompt=")) {
                promptFlag = tok.slice("--prompt=".length);
            } else if (tok === "--persona") {
                personaFlag = requireFlagValue("--persona", rest[i + 1]);
                i += 1;
            } else if (tok.startsWith("--persona=")) {
                personaFlag = tok.slice("--persona=".length);
            } else if (tok === "--catchup") {
                catchupFlag = true;
            } else if (tok === "--no-catchup") {
                catchupFlag = false;
            } else {
                posArgs.push(tok);
            }
        }

        const alias = (posArgs[0] ?? "").trim();
        if (alias.length === 0) {
            throw usageError(
                "Missing schedule alias",
                `usage: /schedule ${sub} <alias> [--manual|--once|--rule <rule>] (--target <session> --prompt <text> | --step <server>.<tool> ['<json>'])`,
            );
        }

        if (runFlag !== undefined && steps.length > 0) {
            throw usageError(
                "Conflicting macro flags",
                "Use either --run '<json-steps>' or repeatable --step flags, not both.",
            );
        }

        const isMacro = runFlag !== undefined || steps.length > 0;
        if (isMacro) {
            if (promptFlag !== undefined || personaFlag !== undefined) {
                throw usageError(
                    "Conflicting schedule kind",
                    "Scripted macros (--run / --step) cannot be combined with --prompt or --persona.",
                );
            }
            const runSteps = runFlag !== undefined ? parseRunJson(runFlag) : steps;
            const rawRule = ruleFlag ?? posArgs[1];
            return {
                scopePrefix: "workspace",
                sub,
                rest,
                actionName: `workspace.schedule.${sub}`,
                params: {
                    alias,
                    ...(rawRule !== undefined && rawRule.length > 0 ? { rule: rawRule } : {}),
                    run: runSteps,
                    ...(targetFlag !== undefined && targetFlag.length > 0
                        ? { target: normalizeTarget(targetFlag) }
                        : {}),
                    ...(catchupFlag !== undefined ? { catchup: catchupFlag } : {}),
                },
            };
        }

        let sessionArg = targetFlag;
        let rawRule = ruleFlag;
        let promptText = promptFlag;
        let cursor = 1;
        if (sessionArg === undefined && cursor < posArgs.length) {
            sessionArg = posArgs[cursor];
            cursor += 1;
        }
        if (rawRule === undefined && cursor < posArgs.length) {
            rawRule = posArgs[cursor];
            cursor += 1;
        }
        if (promptText === undefined && cursor < posArgs.length) {
            promptText = posArgs.slice(cursor).join(" ");
        }

        if (!sessionArg || sessionArg.trim().length === 0 || !promptText || promptText.trim().length === 0) {
            throw usageError(
                "Incomplete schedule definition",
                `usage: /schedule ${sub} <alias> <session> <rule> <prompt...> (or --target <session> --prompt <text> or --step <server>.<tool>)`,
            );
        }

        return {
            scopePrefix: "workspace",
            sub,
            rest,
            actionName: `workspace.schedule.${sub}`,
            params: {
                alias,
                ...(rawRule !== undefined && rawRule.trim().length > 0 ? { rule: rawRule.trim() } : {}),
                target: normalizeTarget(sessionArg.trim()),
                prompt: promptText.trim(),
                ...(personaFlag !== undefined && personaFlag.length > 0 ? { persona: personaFlag } : {}),
                ...(catchupFlag !== undefined ? { catchup: catchupFlag } : {}),
            },
        };
    }

    throw usageError(
        "Unknown schedule subcommand",
        `Unknown schedule subcommand '${sub}'. Use list, show, inspect, discover, add, replace, run, done, reopen, enable, disable, or remove.`,
    );
};

const summarizeStepChain = (steps: readonly unknown[]): string => {
    const names = steps.filter(isRecord).map((step) => {
        const srv = typeof step.server === "string" ? step.server : "?";
        const tool = typeof step.tool === "string" ? step.tool : "?";
        return `${srv}.${tool}`;
    });
    if (names.length === 0) return "0 steps";
    const chain = names.length <= 3 ? names.join(" → ") : `${names.slice(0, 3).join(" → ")} +${String(names.length - 3)}`;
    return `${String(names.length)} ${names.length === 1 ? "step" : "steps"}: ${chain}`;
};

const summarizeScheduleAction = (def: Readonly<Record<string, unknown>>): string => {
    if (Array.isArray(def.run)) {
        return summarizeStepChain(def.run);
    }
    const target = typeof def.target === "string" ? def.target : "";
    const persona = typeof def.persona === "string" && def.persona.length > 0 ? ` (${def.persona})` : "";
    const prompt = typeof def.prompt === "string" ? def.prompt.trim().replace(/\s+/gu, " ") : "";
    const clipped = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt;
    return [target.length > 0 ? `${target}${persona}` : "", clipped].filter((p) => p.length > 0).join(" · ");
};

const compactRuleLabel = (
    def: Readonly<Record<string, unknown>>,
    detail: Readonly<Record<string, unknown>>,
): string => {
    const rule = typeof detail.rule === "string"
        ? detail.rule
        : typeof def.rule === "string"
          ? def.rule
          : "manual";
    const compactRule = rule.includes("\n")
        ? (typeof detail.text === "string" && detail.text.length > 0 ? detail.text : rule.split(/\r?\n/u).join("; "))
        : rule;
    const next = typeof detail.next === "string" && detail.next.length > 0 ? ` (next ${detail.next})` : "";
    return `${compactRule}${next}`;
};

/** {§acp-action-binding} Formats schedule definition rows for `list`, `add`, `replace`, `enable`, and `disable`. */
export const formatScheduleRows = (result: Readonly<Record<string, unknown>>): string => {
    const definitions = Array.isArray(result.definitions) ? result.definitions : [];
    if (definitions.length === 0) {
        return "schedule: none\n";
    }
    const lines: string[] = [];
    for (const rawItem of definitions) {
        if (!isRecord(rawItem)) {
            lines.push(String(rawItem));
            continue;
        }
        const alias = typeof rawItem.alias === "string" ? rawItem.alias : "";
        const state = typeof rawItem.state === "string" ? rawItem.state : "active";
        const def = isRecord(rawItem.definition) ? rawItem.definition : {};
        const detail = isRecord(rawItem.detail) ? rawItem.detail : {};
        const isMacro = Array.isArray(def.run) || detail.kind === "run";
        const kindLabel = isMacro ? "macro" : "prompt";
        const statusLabel = typeof detail.status === "string"
            ? `status=${detail.status}`
            : state === "unavailable"
              ? "status=fail"
              : "";
        const ruleSummary = compactRuleLabel(def, detail);
        const actionSummary = summarizeScheduleAction(def);
        const problemNote = state === "unavailable" && isRecord(rawItem.problem) && typeof rawItem.problem.detail === "string"
            ? `— ${rawItem.problem.detail}`
            : "";
        const prov = isRecord(rawItem.provenance) ? rawItem.provenance : {};
        const source = typeof prov.source === "string" && prov.source.length > 0 ? `source=${prov.source}` : "";
        const parts = [alias, state, kindLabel, statusLabel, ruleSummary, actionSummary, problemNote, source]
            .filter((p) => p.length > 0);
        lines.push(parts.join("  "));
    }
    return `${lines.join("\n")}\n`;
};

/** {§acp-action-binding} Formats a full single-alias schedule inspection view (`/schedule show|inspect <alias>`). */
export const formatScheduleInspect = (entry: Readonly<Record<string, unknown>>): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "";
    const state = typeof entry.state === "string" ? entry.state : "active";
    const origin = typeof entry.origin === "string" ? entry.origin : "workspace";
    const def = isRecord(entry.definition) ? entry.definition : {};
    const detail = isRecord(entry.detail) ? entry.detail : {};
    const prov = isRecord(entry.provenance) ? entry.provenance : {};
    const isMacro = Array.isArray(def.run) || detail.kind === "run";
    const status = typeof detail.status === "string" ? detail.status : state === "unavailable" ? "fail" : "open";
    const rule = typeof detail.rule === "string" ? detail.rule : typeof def.rule === "string" ? def.rule : "manual";
    const ruleText = typeof detail.text === "string" && detail.text.length > 0 ? ` (${detail.text})` : "";

    const lines: string[] = [
        `alias:     ${alias}`,
        `kind:      ${isMacro ? "macro (run)" : "prompt"}`,
        `state:     ${state} (status=${status}, origin=${origin})`,
        `rule:      ${rule.replace(/\r?\n/gu, " / ")}${ruleText}`,
    ];
    if (typeof detail.next === "string" && detail.next.length > 0) {
        lines.push(`next:      ${detail.next}`);
    }
    if (typeof detail.zone === "string" && detail.zone.length > 0) {
        lines.push(`zone:      ${detail.zone}`);
    }
    if (typeof detail.catchup === "boolean" && rule !== "manual" && rule !== "once") {
        lines.push(`catchup:   ${String(detail.catchup)}`);
    }
    if (typeof detail.lastFiredAt === "string" && detail.lastFiredAt.length > 0) {
        lines.push(`lastFired: ${detail.lastFiredAt}`);
    }
    if (typeof detail.doneAt === "string" && detail.doneAt.length > 0) {
        lines.push(`doneAt:    ${detail.doneAt}`);
    }
    if (typeof detail.loopId === "number") {
        lines.push(`loopId:    ${String(detail.loopId)}`);
    }
    if (typeof prov.source === "string" && prov.source.length > 0) {
        lines.push(`source:    ${prov.source}`);
    }
    if (isRecord(entry.problem) && typeof entry.problem.detail === "string" && entry.problem.detail.length > 0) {
        lines.push(`problem:   ${entry.problem.detail}`);
    }

    if (isMacro && Array.isArray(def.run)) {
        if (typeof def.target === "string" && def.target.length > 0) {
            lines.push(`target:    ${def.target}`);
        }
        lines.push(`steps (${String(def.run.length)}):`);
        for (let i = 0; i < def.run.length; i += 1) {
            const rawStep = def.run[i];
            if (!isRecord(rawStep)) continue;
            const srv = typeof rawStep.server === "string" ? rawStep.server : "?";
            const tool = typeof rawStep.tool === "string" ? rawStep.tool : "?";
            const argsStr = isRecord(rawStep.arguments) && Object.keys(rawStep.arguments).length > 0
                ? `  ${JSON.stringify(rawStep.arguments)}`
                : "";
            const asideStr = typeof rawStep.aside === "string" && rawStep.aside.length > 0
                ? `  (${rawStep.aside})`
                : "";
            lines.push(`  #${String(i)}  ${srv}.${tool}${argsStr}${asideStr}`);
        }
    } else {
        if (typeof def.target === "string" && def.target.length > 0) {
            lines.push(`target:    ${def.target}`);
        }
        if (typeof def.persona === "string" && def.persona.length > 0) {
            lines.push(`persona:   ${def.persona}`);
        }
        if (typeof def.prompt === "string" && def.prompt.length > 0) {
            lines.push(`prompt:    ${def.prompt}`);
        }
    }
    return `${lines.join("\n")}\n`;
};

interface ParsedReceipt {
    readonly index: number;
    readonly server: string;
    readonly tool: string;
    readonly status: number;
    readonly uri?: string;
    readonly preview?: string;
    readonly problem?: Readonly<Record<string, unknown>>;
}

const parseStepReceipts = (raw: unknown): readonly ParsedReceipt[] => {
    if (!Array.isArray(raw)) return [];
    const out: ParsedReceipt[] = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        if (typeof item.server !== "string" || typeof item.tool !== "string" || typeof item.status !== "number") continue;
        out.push({
            index: typeof item.index === "number" ? item.index : out.length,
            server: item.server,
            tool: item.tool,
            status: item.status,
            ...(typeof item.uri === "string" ? { uri: item.uri } : {}),
            ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
            ...(isRecord(item.problem) ? { problem: item.problem } : {}),
        });
    }
    return out;
};

/** {§acp-action-binding} Formats compact per-step macro receipts (`results[]`) for CLI, ACP, and Web. */
export const formatScheduleStepReceipts = (rawResults: unknown): string[] => {
    const receipts = parseStepReceipts(rawResults);
    const lines: string[] = [];
    for (const step of receipts) {
        const uriPart = step.uri !== undefined && step.uri.length > 0 ? `  ${step.uri}` : "";
        const rawPreview = step.preview?.trim() ?? "";
        const previewLines = rawPreview.length > 0 ? rawPreview.split(/\r?\n/u) : [];
        const inlinePreview = previewLines.length === 1 ? `  — ${previewLines[0]}` : "";
        lines.push(`  #${String(step.index)}  ${step.server}.${step.tool}  ${String(step.status)}${uriPart}${inlinePreview}`);
        if (previewLines.length > 1) {
            for (const pLine of previewLines) {
                lines.push(`      ${pLine}`);
            }
        }
        if (step.problem !== undefined) {
            const detail = typeof step.problem.detail === "string"
                ? step.problem.detail
                : typeof step.problem.title === "string"
                  ? step.problem.title
                  : "";
            if (detail.length > 0) {
                lines.push(`      ! ${detail}`);
            }
        }
    }
    return lines;
};

export const formatScheduleRunResult = (
    fallbackAlias: string,
    result: Readonly<Record<string, unknown>>,
): string => {
    const alias = typeof result.alias === "string" && result.alias.length > 0 ? result.alias : fallbackAlias;
    const status = typeof result.status === "string" ? result.status : "open";
    const receipts = parseStepReceipts(result.results);
    const meta: string[] = [];
    if (receipts.length > 0) {
        meta.push(`${String(receipts.length)} ${receipts.length === 1 ? "step" : "steps"}`);
    }
    if (typeof result.loopId === "number") {
        meta.push(`loop ${String(result.loopId)}`);
    }
    if (typeof result.doneAt === "string" && result.doneAt.length > 0) {
        meta.push(`done ${result.doneAt}`);
    } else if (typeof result.lastFiredAt === "string" && result.lastFiredAt.length > 0) {
        meta.push(`fired ${result.lastFiredAt}`);
    }
    const header = meta.length > 0 ? `${alias}  ${status}  (${meta.join(" · ")})` : `${alias}  ${status}`;
    const stepLines = formatScheduleStepReceipts(receipts);
    return stepLines.length > 0 ? `${header}\n${stepLines.join("\n")}` : header;
};

export const formatScheduleStatusResult = (
    fallbackAlias: string,
    result: Readonly<Record<string, unknown>>,
): string => {
    const alias = typeof result.alias === "string" && result.alias.length > 0 ? result.alias : fallbackAlias;
    const status = typeof result.status === "string" ? result.status : "open";
    const doneNote = typeof result.doneAt === "string" && result.doneAt.length > 0 ? `  (done ${result.doneAt})` : "";
    return `${alias}  ${status}${doneNote}`;
};

/**
 * {§client-schedule-command} Extracts a structured `ProblemDetails` from a schedule usage or RPC failure,
 * attaching `recovery: "/schedule reopen <alias>"` on `409 already-done` conflicts when absent.
 */
export const extractScheduleProblem = (error: unknown, fallbackAlias?: string): ProblemDetails | null => {
    let problem = Problems.fromError(error);
    if (problem === null && isRecord(error) && isRecord(error.data)) {
        const candidate = isRecord(error.data.problem) ? error.data.problem : error.data;
        if (
            typeof candidate.type === "string"
            && typeof candidate.title === "string"
            && typeof candidate.status === "number"
            && typeof candidate.detail === "string"
        ) {
            problem = {
                ...candidate,
                type: candidate.type,
                title: candidate.title,
                status: candidate.status,
                detail: candidate.detail,
            };
        }
    }
    if (problem === null) return null;
    if (
        problem.status === 409
        && (problem.type.endsWith("/already-done") || /\balready[- ]done\b/iu.test(problem.detail))
        && (typeof problem.recovery !== "string" || problem.recovery.length === 0)
        && typeof fallbackAlias === "string"
        && fallbackAlias.trim().length > 0
    ) {
        return {
            ...problem,
            recovery: `/schedule reopen ${fallbackAlias.trim()}`,
        };
    }
    return problem;
};
