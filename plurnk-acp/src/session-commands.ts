// {§acp-action-binding} {§acp-daemon-client} Slash-command advertisement and skill/MCP-prompt command resolution.

import type { AvailableCommand } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";

const AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([
    {
        type: "command",
        name: "mcp",
        description: "Manage workspace MCP servers",
        input: { type: "text", hint: "<list|add|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "skills",
        description: "Manage workspace skills",
        input: { type: "text", hint: "<list|discover|add|replace|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "personas",
        description: "Manage workspace personas",
        input: { type: "text", hint: "<list|discover|add|replace|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "members",
        description: "Manage workspace members",
        input: { type: "text", hint: "<list|add|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "env",
        description: "Manage workspace environment variables",
        input: { type: "text", hint: "<list|set|unset> ..." },
    },
    {
        type: "command",
        name: "schedule",
        description: "Manage workspace schedules",
        input: { type: "text", hint: "<list|add|remove|enable|disable> ..." },
    },
    {
        type: "command",
        name: "rollback",
        description: "Roll back reversible session operations",
        input: { type: "text", hint: "<coordinate>" },
    },
    {
        type: "command",
        name: "share",
        description: "Write a diagnostic digest of the workspace",
        input: { type: "text", hint: "<folder>" },
    },
    {
        type: "command",
        name: "script",
        description: "Execute PLURNK statements directly",
        input: { type: "text", hint: "<statements>" },
    },
    { type: "command", name: "update", description: "Update the model catalog" },
]);

export const buildAvailableCommands = async (
    seam: ApplicationPort,
    workspaceId?: number,
): Promise<AvailableCommand[]> => {
    const commands: AvailableCommand[] = [...AVAILABLE_COMMANDS];
    if (workspaceId === undefined) return commands;
    const registeredActions = seam.listModuleActions?.() ?? [];

    if (registeredActions.some((a) => a.name === "workspace.skills.list")) {
        const listed = await seam
            .invokeModuleAction("workspace.skills.list", {}, { scope: "workspace", workspaceId })
            .catch(() => null);
        if (isRecord(listed)) {
            const items = Array.isArray(listed.definitions)
                ? listed.definitions
                : Array.isArray(listed.items)
                  ? listed.items
                  : [];
            for (const item of items) {
                if (!isRecord(item) || typeof item.alias !== "string" || item.alias.length === 0) continue;
                if (item.state === "disabled" || item.enabled === false || item.state === "unavailable") continue;
                const name = AVAILABLE_COMMANDS.some((c) => c.name === item.alias)
                    ? `skill:${item.alias}`
                    : item.alias;
                const description =
                    isRecord(item.detail) &&
                    typeof item.detail.description === "string" &&
                    item.detail.description.length > 0
                        ? item.detail.description
                        : isRecord(item.definition) &&
                            typeof item.definition.description === "string" &&
                            item.definition.description.length > 0
                          ? item.definition.description
                          : `Invoke Agent Skill '${item.alias}'`;
                commands.push({
                    type: "command",
                    name,
                    description,
                    input: { type: "text", hint: "<instructions>" },
                    _meta: {
                        plurnk: {
                            kind: "skill",
                            alias: item.alias,
                            target: `skill://${item.alias}/SKILL.md`,
                        },
                    },
                });
            }
        }
    }

    if (registeredActions.some((a) => a.name === "workspace.mcp.list")) {
        const listed = await seam
            .invokeModuleAction("workspace.mcp.list", {}, { scope: "workspace", workspaceId })
            .catch(() => null);
        if (isRecord(listed)) {
            const items = Array.isArray(listed.definitions)
                ? listed.definitions
                : Array.isArray(listed.items)
                  ? listed.items
                  : [];
            for (const item of items) {
                if (!isRecord(item) || typeof item.alias !== "string" || item.alias.length === 0) continue;
                if (item.state !== "active" || item.enabled === false) continue;
                const promptDefs =
                    isRecord(item.detail) && Array.isArray(item.detail.promptDefinitions)
                        ? item.detail.promptDefinitions
                        : isRecord(item.detail) && Array.isArray(item.detail.prompts)
                          ? item.detail.prompts
                          : Array.isArray(item.prompts)
                            ? item.prompts
                            : [];
                for (const prompt of promptDefs) {
                    if (!isRecord(prompt) || typeof prompt.name !== "string" || prompt.name.length === 0) continue;
                    const cmdName = `${item.alias}:${prompt.name}`;
                    const description =
                        typeof prompt.description === "string" && prompt.description.length > 0
                            ? prompt.description
                            : `Invoke MCP prompt '${prompt.name}' on '${item.alias}'`;
                    const argHint =
                        Array.isArray(prompt.arguments) && prompt.arguments.length > 0
                            ? prompt.arguments
                                  .filter(
                                      (a): a is Record<string, unknown> & { readonly name: string } =>
                                          isRecord(a) && typeof a.name === "string",
                                  )
                                  .map((a) => `${a.name}=<value>`)
                                  .join(" ") || "<arguments>"
                            : "<arguments>";
                    commands.push({
                        type: "command",
                        name: cmdName,
                        description,
                        input: { type: "text", hint: argHint },
                        _meta: {
                            plurnk: {
                                kind: "mcp_prompt",
                                server: item.alias,
                                prompt: prompt.name,
                                target: `${item.alias}:///prompts/${encodeURIComponent(prompt.name)}`,
                            },
                        },
                    });
                }
            }
        }
    }

    return commands;
};

export type ResolvedPromptCommand =
    | { readonly kind: "builtin"; readonly cmd: string; readonly rest: string }
    | { readonly kind: "open_path"; readonly target: string; readonly text: string };

const formatMcpPromptTarget = (server: string, promptName: string, inputText: string): { readonly target: string; readonly text: string } => {
    const baseTarget = `${server}:///prompts/${encodeURIComponent(promptName)}`;
    const trimmed = inputText.trim();
    if (trimmed.length === 0) {
        return { target: baseTarget, text: "" };
    }
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (isRecord(parsed)) {
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(parsed)) {
                    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
                        params.set(k, String(v));
                    }
                }
                const qs = params.toString();
                return { target: qs.length > 0 ? `${baseTarget}?${qs}` : baseTarget, text: "" };
            }
        } catch {
            // Fall through to key=value or free-form text
        }
    }
    const tokens = trimmed.split(/\s+/u);
    if (tokens.length > 0 && tokens.every((t) => /^[A-Za-z_][A-Za-z0-9_-]*=/u.test(t))) {
        const params = new URLSearchParams();
        for (const token of tokens) {
            const eqIdx = token.indexOf("=");
            params.set(token.slice(0, eqIdx), token.slice(eqIdx + 1));
        }
        const qs = params.toString();
        return { target: qs.length > 0 ? `${baseTarget}?${qs}` : baseTarget, text: "" };
    }
    return { target: baseTarget, text: trimmed };
};

export const resolvePromptCommand = async (
    seam: ApplicationPort,
    workspaceId: number,
    rawName: string,
    rawInput: unknown,
): Promise<ResolvedPromptCommand | null> => {
    const name = rawName.trim().replace(/^\/+/u, "");
    if (name.length === 0) return null;
    const inputText =
        typeof rawInput === "string"
            ? rawInput.trim()
            : isRecord(rawInput) && typeof rawInput.text === "string"
              ? rawInput.text.trim()
              : "";
    const lower = name.toLowerCase();
    if (AVAILABLE_COMMANDS.some((c) => c.name === lower)) {
        return { kind: "builtin", cmd: lower, rest: inputText };
    }
    const commands = await buildAvailableCommands(seam, workspaceId);
    const matched = commands.find(
        (c) =>
            c.name === name ||
            (name.startsWith("skill:") &&
                isRecord(c._meta) &&
                isRecord(c._meta.plurnk) &&
                c._meta.plurnk.kind === "skill" &&
                c._meta.plurnk.alias === name.slice("skill:".length)),
    );
    if (matched === undefined || !isRecord(matched._meta) || !isRecord(matched._meta.plurnk)) {
        return null;
    }
    const meta = matched._meta.plurnk;
    if (meta.kind === "skill" && typeof meta.alias === "string") {
        return {
            kind: "open_path",
            target: `skill://${meta.alias}/SKILL.md`,
            text: inputText,
        };
    }
    if (meta.kind === "mcp_prompt" && typeof meta.server === "string" && typeof meta.prompt === "string") {
        const formatted = formatMcpPromptTarget(meta.server, meta.prompt, inputText);
        return {
            kind: "open_path",
            target: formatted.target,
            text: formatted.text,
        };
    }
    return null;
};
