// {§contract-representations} {§client-interactive-commands} {§client-composer-sigils}
// Browser/Node-neutral interactive client command inventory, composer sigil classifier,
// inline skill prompt-block builder, and multi-token completion state machine.

import { PLURNK_OPS, PROPOSAL_POLICIES } from "./types.ts";
import {
    FAMILY_DISCOVER_FLAGS_BY_FAMILY,
    FAMILY_LIST_FLAGS,
    LIST_ORIGINS,
    LIST_STATES,
    MODELS_LIST_FLAGS,
} from "./CollectionCommand.ts";
import { SCHEDULE_ADD_FLAGS } from "./ScheduleCommand.ts";

export interface InteractiveCommandSpec {
    readonly name: string;
    readonly usage: string;
    readonly summary: string;
    readonly settingsSection?: string;
    readonly clientOnly?: "term" | "web";
}

export interface FamilySubcommandSpec {
    readonly value: string;
    readonly description: string;
}

export const INTERACTIVE_COMMANDS: readonly InteractiveCommandSpec[] = Object.freeze([
    { name: "help", usage: "/help [verb]", summary: "Show the command index or one command's usage.", settingsSection: "help" },
    { name: "update", usage: "/update", summary: "Update the model catalog and show how to update Plurnk packages." },
    { name: "models", usage: "/models [search] [--provider <id>] [--all] [--offset <n>] [--limit <n>]", summary: "Search the bounded model catalog.", settingsSection: "models" },
    { name: "workspaces", usage: "/workspaces", summary: "List daemon workspaces." },
    { name: "sessions", usage: "/sessions", summary: "List this workspace's sessions as a tree, each with its state." },
    { name: "loops", usage: "/loops", summary: "List this session's loops: each one's number and opening line." },
    { name: "loop", usage: "/loop [n]", summary: "Print loop n whole, or the current loop." },
    { name: "model", usage: "/model [selector] [effort]", summary: "Inspect or select this session's durable model, and its effort with it.", settingsSection: "session" },
    { name: "child", usage: "/child [selector|inherit]", summary: "Inspect or select the inherited child model.", settingsSection: "session" },
    { name: "effort", usage: "/effort [policy]", summary: "Inspect or select reasoning effort.", settingsSection: "session" },
    { name: "persona", usage: "/persona [name|none]", summary: "Inspect, select, or clear this session's persona role.", settingsSection: "session" },
    { name: "mode", usage: "/mode [review|accept|reject]", summary: "Inspect or select this session's proposal review mode.", settingsSection: "session" },
    { name: "yolo", usage: "/yolo", summary: "Toggle proposal auto-accept (Shift-Tab)." },
    { name: "workspace", usage: "/workspace [name]", summary: "Open or create a workspace.", settingsSection: "workspace" },
    { name: "rename", usage: "/rename <name>", summary: "Rename this workspace's mutable handle.", settingsSection: "workspace" },
    { name: "share", usage: "/share <folder>", summary: "Write this workspace's share into <folder> for a bug report." },
    { name: "rollback", usage: "/rollback <loop>/<turn>/<item>", summary: "Reverse the bound session's file mutations after a log coordinate, latest first, as your own operations." },
    { name: "session", usage: "/session [name]", summary: "Show this session, or go to the named one; a new name makes a new session.", settingsSection: "session" },
    { name: "fork", usage: "/fork [name]", summary: "Fork this session into a child that keeps its history, and go there." },
    { name: "parent", usage: "/parent", summary: "Hop to the bound session's parent (Alt-h)." },
    { name: "enter", usage: "/enter", summary: "Hop into the bound session's newest child (Alt-l)." },
    { name: "older", usage: "/older", summary: "Hop to the next older sibling session, wrapping (Alt-j)." },
    { name: "newer", usage: "/newer", summary: "Hop to the next newer sibling session, wrapping (Alt-k)." },
    { name: "mcp", usage: "/mcp [--scope workspace|service] [subcommand]", summary: "List or manage MCP servers.", settingsSection: "mcp" },
    { name: "skills", usage: "/skills [--scope workspace|service] [subcommand]", summary: "List or manage Agent Skills.", settingsSection: "skills" },
    { name: "members", usage: "/members [subcommand]", summary: "List or manage file members.", settingsSection: "members" },
    { name: "env", usage: "/env [--scope session|workspace|service] [subcommand]", summary: "Manage session, workspace, or service environment defaults.", settingsSection: "env" },
    { name: "schedule", usage: "/schedule [subcommand]", summary: "List or manage schedules and macros.", settingsSection: "schedule" },
    { name: "personas", usage: "/personas [--scope workspace|service] [subcommand]", summary: "List or manage persona roles.", settingsSection: "personas" },
    { name: "import", usage: "/import <path>", summary: "Insert a local file into the composer.", clientOnly: "term" },
    { name: "script", usage: "/script <path>", summary: "Submit MCP expressions through op.exec.", clientOnly: "term" },
    { name: "editor", usage: "/editor", summary: "Compose the current value in $EDITOR.", clientOnly: "term" },
    { name: "review", usage: "/review", summary: "Inspect pending proposals or questions." },
    { name: "approve", usage: "/approve @<id> [optionId]", summary: "Approve the identified proposal or gate." },
    { name: "accept", usage: "/accept @<id> [optionId]", summary: "Accept the identified proposal or gate." },
    { name: "reject", usage: "/reject @<id> [optionId]", summary: "Reject the identified proposal or gate." },
    { name: "cancel", usage: "/cancel @<id>", summary: "Cancel the identified proposal or question." },
    { name: "edit", usage: "/edit @<id> <body...>", summary: "Edit and accept the identified proposal." },
    { name: "answer", usage: "/answer @<id> <json>", summary: "Answer the identified elicitation or question." },
    { name: "login", usage: "/login", summary: "Sign in to the daemon through the browser and keep the grant.", clientOnly: "term" },
    { name: "logout", usage: "/logout", summary: "Forget the stored token for this daemon." },
    { name: "learn", usage: "/learn [--scope project|plurnk] [instructions]", summary: "Distill reusable workflow from this session into a SKILL.md." },
    { name: "stop", usage: "/stop", summary: "Cancel the running loop." },
    { name: "quit", usage: "/quit", summary: "Exit the interactive client.", clientOnly: "term" },
]);

export const FAMILY_SUBCOMMANDS_BY_FAMILY: Readonly<Record<string, readonly FamilySubcommandSpec[]>> = Object.freeze({
    mcp: Object.freeze([
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "replace", description: "Replace definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
        { value: "skills", description: "Inspect MCP server skills" },
        { value: "complete", description: "Complete MCP prompt or resource" },
        { value: "oauth", description: "Authorize MCP server" },
    ]),
    skills: Object.freeze([
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "replace", description: "Replace definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
    ]),
    personas: Object.freeze([
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "replace", description: "Replace definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
    ]),
    members: Object.freeze([
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
    ]),
    env: Object.freeze([
        { value: "list", description: "List variables" },
        { value: "discover", description: "Discover variables" },
        { value: "add", description: "Add variable" },
        { value: "replace", description: "Replace variable" },
        { value: "set", description: "Set NAME=value" },
        { value: "unset", description: "Remove variable" },
        { value: "enable", description: "Enable variable" },
        { value: "disable", description: "Disable variable" },
        { value: "remove", description: "Remove variable" },
        { value: "import", description: "Import dotenv file" },
        { value: "--scope", description: "Select session, workspace, or service scope" },
    ]),
    schedule: Object.freeze([
        { value: "list", description: "List schedules and macros" },
        { value: "show", description: "Inspect one schedule or macro" },
        { value: "inspect", description: "Inspect one schedule or macro" },
        { value: "discover", description: "Show clock or preview rule occurrences" },
        { value: "add", description: "Add a prompt schedule or macro" },
        { value: "replace", description: "Replace an existing schedule or macro" },
        { value: "run", description: "Trigger a schedule or macro now" },
        { value: "done", description: "Mark an obligation done" },
        { value: "reopen", description: "Reopen a completed obligation" },
        { value: "enable", description: "Enable a schedule" },
        { value: "disable", description: "Disable a schedule" },
        { value: "remove", description: "Remove a schedule" },
    ]),
});

export interface InteractiveCompletionItem {
    readonly value: string;
    readonly description: string;
    readonly trailingSpace: boolean;
}

export interface InteractiveCompletionResult {
    readonly suggestions: readonly InteractiveCompletionItem[];
    readonly prefix: string;
}

export interface InteractiveCompletionSnapshot {
    readonly surface?: "term" | "web";
    readonly projectRoot?: string | null;
    readonly models?: readonly string[];
    readonly efforts?: readonly string[];
    readonly effortsForModel?: (selector: string) => readonly string[] | null | undefined;
    readonly personas?: readonly string[];
    readonly familyAliases?: Readonly<Record<string, readonly string[]>>;
    readonly sessionNames?: readonly string[];
    readonly workspaceNames?: readonly string[];
    readonly pendingGateIds?: readonly string[];
    readonly loopSequences?: readonly string[];
    readonly skills?: readonly { readonly name: string; readonly description?: string }[];
    readonly advertisedCommands?: readonly { readonly name: string; readonly description?: string }[];
    readonly promptSuggestions?: readonly string[];
}

const filterPrefix = (
    candidates: readonly string[],
    frag: string,
    describe: (value: string) => string,
    trailingSpace: (value: string) => boolean = () => false,
): InteractiveCompletionResult => {
    const lower = frag.toLowerCase();
    const hits = candidates.filter((c) => c.toLowerCase().startsWith(lower));
    return {
        suggestions: hits.map((value) => ({
            value,
            description: describe(value),
            trailingSpace: trailingSpace(value),
        })),
        prefix: frag,
    };
};

export const completeInteractiveCommand = (
    line: string,
    snapshot: InteractiveCompletionSnapshot = {},
): InteractiveCompletionResult => {
    if (line.length === 0) {
        const prompts = snapshot.promptSuggestions ?? [];
        if (prompts.length === 0) return { suggestions: [], prefix: "" };
        return {
            suggestions: prompts.map((value) => ({
                value,
                description: "suggested prompt",
                trailingSpace: false,
            })),
            prefix: "",
        };
    }

    const surface = snapshot.surface ?? "term";
    const visibleCommands = INTERACTIVE_COMMANDS.filter((c) =>
        surface === "web" ? c.clientOnly !== "term" : c.clientOnly !== "web",
    );

    const rootMatch = /^\/([-\w:]*)$/u.exec(line);
    if (rootMatch !== null) {
        const typed = rootMatch[1].toLowerCase();
        const seen = new Set<string>();
        const merged: InteractiveCompletionItem[] = [];
        for (const c of visibleCommands) {
            if (!c.name.startsWith(typed)) continue;
            seen.add(c.name);
            merged.push({
                value: `/${c.name}`,
                description: c.summary,
                trailingSpace: c.usage.includes(" "),
            });
        }
        for (const adv of snapshot.advertisedCommands ?? []) {
            if (seen.has(adv.name) || !adv.name.toLowerCase().startsWith(typed)) continue;
            seen.add(adv.name);
            merged.push({
                value: `/${adv.name}`,
                description: adv.description ?? "command",
                trailingSpace: true,
            });
        }
        merged.sort((a, b) => (a.value === `/${typed}` ? 0 : 1) - (b.value === `/${typed}` ? 0 : 1));
        return { suggestions: merged, prefix: line };
    }

    const helpMatch = /^\/help\s+(\w*)$/u.exec(line);
    if (helpMatch !== null) {
        const summaryByName = new Map(visibleCommands.map((c) => [c.name, c.summary]));
        return filterPrefix(
            [...summaryByName.keys()],
            helpMatch[1],
            (v) => summaryByName.get(v) ?? "command",
        );
    }

    const learnScopeMatch = /^\/learn\s+--scope(?:\s+|=)(\w*)$/u.exec(line);
    if (learnScopeMatch !== null) {
        const scopes = snapshot.projectRoot === null ? ["plurnk"] : ["project", "plurnk"];
        return filterPrefix(
            scopes,
            learnScopeMatch[1],
            (v) => (v === "plurnk" ? "user-wide Plurnk skills" : "project .agents/skills"),
            () => true,
        );
    }

    const learnFlagMatch = /^\/learn\s+(--\w*)$/u.exec(line);
    if (learnFlagMatch !== null) {
        return filterPrefix(["--scope"], learnFlagMatch[1], () => "skill target scope", () => true);
    }

    const familyScopeMatch = /^\/(mcp|skills|personas|env)\s+--scope(?:\s+|=)(\w*)$/u.exec(line);
    if (familyScopeMatch !== null) {
        const family = familyScopeMatch[1];
        const scopes = family === "env" ? ["session", "workspace", "service"] : ["workspace", "service"];
        return filterPrefix(
            scopes,
            familyScopeMatch[2],
            (v) => (
                v === "service"
                    ? "daemon-wide service defaults"
                    : v === "workspace"
                        ? "workspace defaults"
                        : "session overrides"
            ),
            () => true,
        );
    }

    const familyMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace|service)\s+)?([-\w]*)$/u.exec(line);
    if (familyMatch !== null) {
        const family = familyMatch[1];
        const subs = (FAMILY_SUBCOMMANDS_BY_FAMILY[family] ?? []).filter(
            (s) => !(surface === "web" && family === "env" && s.value === "import"),
        );
        const descBySub = new Map(subs.map((s) => [s.value, s.description]));
        return filterPrefix(
            subs.map((s) => s.value),
            familyMatch[2],
            (v) => descBySub.get(v) ?? "subcommand",
            (v) => v !== "list",
        );
    }

    const familyAliasMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace|service)\s+)?(show|inspect|replace|enable|disable|remove|unset|oauth|skills|run|done|reopen)\s+(\S*)$/u.exec(line);
    if (familyAliasMatch !== null) {
        const family = familyAliasMatch[1];
        const sub = familyAliasMatch[2];
        const validForFamily =
            ((sub !== "show" && sub !== "inspect") || family === "schedule")
            && (sub !== "replace" || family !== "members");
        if (validForFamily) {
            const aliases = snapshot.familyAliases?.[family] ?? [];
            return filterPrefix(
                aliases,
                familyAliasMatch[3],
                () => `${family} definition`,
                () => sub === "replace",
            );
        }
    }

    const familyListStateMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace|service)\s+)?(?:list\s+)?(?:.*\s+)?--state(?:\s+|=)([-\w]*)$/u.exec(line);
    if (familyListStateMatch !== null) {
        return filterPrefix(LIST_STATES, familyListStateMatch[2], () => "definition state", () => true);
    }

    const familyListOriginMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace|service)\s+)?(?:list\s+)?(?:.*\s+)?--origin(?:\s+|=)([-\w]*)$/u.exec(line);
    if (familyListOriginMatch !== null) {
        return filterPrefix(LIST_ORIGINS, familyListOriginMatch[2], () => "definition origin", () => true);
    }

    const familyListFlagMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace|service)\s+)?list(?:\s+.*)?\s+(--[-\w]*)$/u.exec(line);
    if (familyListFlagMatch !== null) {
        const descByFlag = new Map(FAMILY_LIST_FLAGS.map((f) => [f.value, f.description]));
        return filterPrefix(
            FAMILY_LIST_FLAGS.map((f) => f.value),
            familyListFlagMatch[2],
            (v) => descByFlag.get(v) ?? "list option",
            () => true,
        );
    }

    const familyDiscoverFlagMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace|service)\s+)?discover(?:\s+.*)?\s+(--[-\w]*)$/u.exec(line);
    if (familyDiscoverFlagMatch !== null) {
        const flags = FAMILY_DISCOVER_FLAGS_BY_FAMILY[familyDiscoverFlagMatch[1]] ?? [];
        const descByFlag = new Map(flags.map((f) => [f.value, f.description]));
        return filterPrefix(
            flags.map((f) => f.value),
            familyDiscoverFlagMatch[2],
            (v) => descByFlag.get(v) ?? "discover option",
            () => true,
        );
    }

    const scheduleFlagMatch = /^\/schedule\s+(?:add|replace)\s+\S+(?:\s+.*)?\s+(--[-\w]*)$/u.exec(line);
    if (scheduleFlagMatch !== null) {
        const descByFlag = new Map(SCHEDULE_ADD_FLAGS.map((f) => [f.value, f.description]));
        return filterPrefix(
            SCHEDULE_ADD_FLAGS.map((f) => f.value),
            scheduleFlagMatch[1],
            (v) => descByFlag.get(v) ?? "schedule option",
            (v) => v !== "--manual" && v !== "--once" && v !== "--catchup" && v !== "--no-catchup",
        );
    }

    const gateMatch = /^\/(approve|accept|reject|cancel|edit|answer)\s+@?([0-9a-f]*)$/iu.exec(line);
    if (gateMatch !== null) {
        const verb = gateMatch[1].toLowerCase();
        const typed = gateMatch[2].toLowerCase();
        const tokenPrefix = line.slice(line.lastIndexOf(" ") + 1);
        const ids = (snapshot.pendingGateIds ?? [])
            .filter((id) => id.toLowerCase().startsWith(typed))
            .map((id) => `@${id}`);
        return {
            suggestions: ids.map((value) => ({
                value,
                description: "pending gate",
                trailingSpace: verb === "edit" || verb === "answer",
            })),
            prefix: tokenPrefix,
        };
    }

    const loopMatch = /^\/loop\s+(\d*)$/u.exec(line);
    if (loopMatch !== null) {
        return filterPrefix(snapshot.loopSequences ?? [], loopMatch[1], () => "loop");
    }

    const sessionMatch = /^\/session\s+(\S*)$/u.exec(line);
    if (sessionMatch !== null) {
        return filterPrefix(snapshot.sessionNames ?? [], sessionMatch[1], () => "session");
    }

    const workspaceMatch = /^\/workspace\s+(\S*)$/u.exec(line);
    if (workspaceMatch !== null) {
        return filterPrefix(snapshot.workspaceNames ?? [], workspaceMatch[1], () => "workspace");
    }

    const modelsFlagMatch = /^\/models(?:\s+.*)?\s+(--[-\w]*)$/u.exec(line);
    if (modelsFlagMatch !== null) {
        const descByFlag = new Map(MODELS_LIST_FLAGS.map((f) => [f.value, f.description]));
        return filterPrefix(
            MODELS_LIST_FLAGS.map((f) => f.value),
            modelsFlagMatch[1],
            (v) => descByFlag.get(v) ?? "models option",
            (v) => v !== "--all",
        );
    }

    const modelMatch = /^\/(model|models|child)\s+(\S*)$/u.exec(line);
    if (modelMatch !== null) {
        const verb = modelMatch[1];
        const models = snapshot.models ?? [];
        const candidates = verb === "child" ? ["inherit", ...models.filter((m) => m !== "inherit")] : models;
        return filterPrefix(
            candidates,
            modelMatch[2],
            (v) => (v === "inherit" ? "inherit parent route" : "model"),
            () => verb === "model",
        );
    }

    const modelEffortMatch = /^\/model\s+(\S+)\s+(\S*)$/u.exec(line);
    if (modelEffortMatch !== null) {
        const selector = modelEffortMatch[1];
        const efforts = snapshot.effortsForModel?.(selector) ?? snapshot.efforts ?? [];
        return filterPrefix(efforts, modelEffortMatch[2], () => "reasoning effort");
    }

    const effortMatch = /^\/effort\s+(\S*)$/u.exec(line);
    if (effortMatch !== null) {
        return filterPrefix(snapshot.efforts ?? [], effortMatch[1], () => "reasoning effort");
    }

    const personaMatch = /^\/persona\s+(\S*)$/u.exec(line);
    if (personaMatch !== null) {
        const personas = snapshot.personas ?? ["none"];
        return filterPrefix(
            personas,
            personaMatch[1],
            (v) => (v === "none" ? "clear persona role" : "persona"),
        );
    }

    const modeMatch = /^\/mode\s+(\S*)$/u.exec(line);
    if (modeMatch !== null) {
        return filterPrefix(PROPOSAL_POLICIES, modeMatch[1], () => "proposal review mode");
    }

    const dslMatch = /^((?:await\s+)?plurnk\.)([A-Za-z]*)$/u.exec(line);
    if (dslMatch !== null) {
        const opPrefix = dslMatch[1];
        const typed = dslMatch[2];
        return filterPrefix(
            PLURNK_OPS.map((op) => `${opPrefix}${op.toLowerCase()}`),
            `${opPrefix}${typed}`,
            () => "MCP expression",
        );
    }

    const skillMatch = /(?:^|[\s([{,])\$(\S*)$/u.exec(line);
    if (skillMatch !== null) {
        const skills = snapshot.skills ?? [];
        const descByName = new Map(skills.map((s) => [s.name, s.description ?? "skill"]));
        const tokenPrefix = `$${skillMatch[1]}`;
        const hits = skills
            .filter((s) => s.name.toLowerCase().startsWith(skillMatch[1].toLowerCase()))
            .map((s) => ({
                value: `$${s.name}`,
                description: descByName.get(s.name) ?? "skill",
                trailingSpace: true,
            }));
        return { suggestions: hits, prefix: tokenPrefix };
    }

    return { suggestions: [], prefix: line };
};

/**
 * {§client-interactive-commands} Computes the longest shared prefix across completion candidates
 * on Unicode code-point boundaries without splitting surrogate pairs.
 */
export const longestCommonPrefix = (values: readonly string[]): string => {
    if (values.length === 0) return "";
    let shared = Array.from(values[0] ?? "");
    for (let i = 1; i < values.length && shared.length > 0; i += 1) {
        const chars = Array.from(values[i] ?? "");
        const maxLen = Math.min(shared.length, chars.length);
        let matchLen = 0;
        while (matchLen < maxLen && shared[matchLen] === chars[matchLen]) {
            matchLen += 1;
        }
        shared = shared.slice(0, matchLen);
    }
    return shared.join("");
};

export type ComposerInputClassification =
    | { readonly kind: "empty" }
    | { readonly kind: "help" }
    | { readonly kind: "review"; readonly text: string }
    | { readonly kind: "continue"; readonly text: string }
    | { readonly kind: "statement"; readonly text: string }
    | { readonly kind: "statement-empty" }
    | { readonly kind: "shell"; readonly command: string }
    | { readonly kind: "shell-empty" }
    | { readonly kind: "slash"; readonly name: string; readonly argsText: string }
    | { readonly kind: "prompt"; readonly text: string };

/**
 * {§client-composer-sigils} Classifies raw interactive composer input into canonical sigil and command forms
 * (`?`, `? <text>`, `... [text]`, `: <stmt>`, `! <cmd>`, `[await ]plurnk.<op>(`, `/<cmd>`, or `prompt`).
 */
export const classifyComposerInput = (raw: string): ComposerInputClassification => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { kind: "empty" };
    if (trimmed === "?") return { kind: "help" };
    if (/^\?\s+/u.test(trimmed)) {
        return { kind: "review", text: trimmed.slice(1).trim() };
    }
    if (trimmed === "..." || /^\.\.\.\s+/u.test(trimmed)) {
        return { kind: "continue", text: trimmed.slice(3).trim() };
    }
    if (trimmed.startsWith(":")) {
        const body = trimmed.slice(1).trim();
        return body.length === 0 ? { kind: "statement-empty" } : { kind: "statement", text: body };
    }
    if (trimmed.startsWith("!")) {
        const command = trimmed.slice(1).trim();
        return command.length === 0 ? { kind: "shell-empty" } : { kind: "shell", command };
    }
    if (/^(?:await\s+)?plurnk\.[a-z][a-z0-9_]*\s*\(/iu.test(trimmed)) {
        return { kind: "statement", text: trimmed };
    }
    const slashMatch = /^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
    if (slashMatch !== null) {
        return {
            kind: "slash",
            name: slashMatch[1] ?? "",
            argsText: (slashMatch[2] ?? "").trim(),
        };
    }
    return { kind: "prompt", text: raw };
};

export type PromptContentBlock =
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "skill"; readonly name: string };

/**
 * {§client-composer-sigils} Splits composer text on enabled inline `$<skill>` tokens into interleaved
 * ACPv2 `{ type: "text", text }` and `{ type: "skill", name }` prompt blocks, leaving unknown `$tokens` as text.
 */
export const buildPromptBlocks = (
    text: string,
    availableSkills?: ReadonlySet<string>,
): readonly PromptContentBlock[] => {
    if (text.length === 0) return [];
    if (availableSkills === undefined || availableSkills.size === 0) {
        return [{ type: "text", text }];
    }
    const pattern = /(^|[\s([{,])\$([A-Za-z0-9][A-Za-z0-9_-]{0,62})(?=$|[\s)\]}.,;:!?])/gu;
    const blocks: PromptContentBlock[] = [];
    let buffer = "";
    let cursor = 0;

    for (const match of text.matchAll(pattern)) {
        const matchIndex = match.index ?? 0;
        const prefix = match[1] ?? "";
        const skillName = match[2] ?? "";
        if (!availableSkills.has(skillName)) {
            continue;
        }
        buffer += text.slice(cursor, matchIndex) + prefix;
        if (buffer.length > 0) {
            blocks.push({ type: "text", text: buffer });
            buffer = "";
        }
        blocks.push({ type: "skill", name: skillName });
        cursor = matchIndex + match[0].length;
    }

    buffer += text.slice(cursor);
    if (buffer.length > 0) {
        blocks.push({ type: "text", text: buffer });
    }
    return blocks;
};
