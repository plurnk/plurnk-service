// {§contract-representations} Browser/Node-neutral interactive client command inventory and multi-token completion state machine.

import { PLURNK_OPS, PROPOSAL_POLICIES } from "./types.ts";
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
    { name: "models", usage: "/models [search]", summary: "Search the bounded model catalog.", settingsSection: "models" },
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
    { name: "mcp", usage: "/mcp [subcommand]", summary: "List or manage this workspace's MCP servers.", settingsSection: "mcp" },
    { name: "skills", usage: "/skills [subcommand]", summary: "List or manage this workspace's Agent Skills.", settingsSection: "skills" },
    { name: "members", usage: "/members [subcommand]", summary: "List or manage this workspace's file members.", settingsSection: "members" },
    { name: "env", usage: "/env [--scope session|workspace] [subcommand]", summary: "Manage session overrides or shared workspace environment defaults.", settingsSection: "env" },
    { name: "schedule", usage: "/schedule [subcommand]", summary: "List or manage this workspace's schedules and macros.", settingsSection: "schedule" },
    { name: "personas", usage: "/personas [subcommand]", summary: "List or manage this workspace's persona roles.", settingsSection: "personas" },
    { name: "import", usage: "/import <path>", summary: "Insert a local file into the composer.", clientOnly: "term" },
    { name: "script", usage: "/script <path>", summary: "Submit MCP expressions through op.exec." },
    { name: "editor", usage: "/editor", summary: "Compose the current value in $EDITOR.", clientOnly: "term" },
    { name: "review", usage: "/review", summary: "Inspect pending proposals or questions." },
    { name: "approve", usage: "/approve @<id> [optionId]", summary: "Approve the identified proposal or gate." },
    { name: "accept", usage: "/accept @<id> [optionId]", summary: "Accept the identified proposal or gate." },
    { name: "reject", usage: "/reject @<id> [optionId]", summary: "Reject the identified proposal or gate." },
    { name: "cancel", usage: "/cancel @<id>", summary: "Cancel the identified proposal or question." },
    { name: "edit", usage: "/edit @<id> <body...>", summary: "Edit and accept the identified proposal." },
    { name: "answer", usage: "/answer @<id> <json>", summary: "Answer the identified elicitation or question." },
    { name: "login", usage: "/login", summary: "Sign in to the daemon through the browser and keep the grant.", clientOnly: "term" },
    { name: "logout", usage: "/logout", summary: "Forget the stored token for this daemon.", clientOnly: "term" },
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
        { value: "--scope", description: "Select session or workspace scope" },
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

    const envScopeMatch = /^\/env\s+--scope(?:\s+|=)(\w*)$/u.exec(line);
    if (envScopeMatch !== null) {
        return filterPrefix(
            ["session", "workspace"],
            envScopeMatch[1],
            (v) => (v === "workspace" ? "workspace environment defaults" : "session environment overrides"),
            () => true,
        );
    }

    const familyMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace)\s+)?([-\w]*)$/u.exec(line);
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

    const familyAliasMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace)\s+)?(show|inspect|replace|enable|disable|remove|unset|oauth|skills|run|done|reopen)\s+(\S*)$/u.exec(line);
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
