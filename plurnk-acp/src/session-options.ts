// {§acp-daemon-client} {§acp-session-owner} ACP session configOptions, session/options preflight, and additionalDirectories binding.

import { isAbsolute, relative, resolve, sep } from "node:path";
import {
    RequestError,
    SessionConfigOption,
    type InitialSessionConfigOption,
    type SessionOptionsRequest,
    type SessionOptionsResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { isRecord } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { buildAvailableCommands } from "./session-commands.ts";
import {
    applySystemPrompt,
    clearSystemPrompt,
    extractPlurnkMeta,
    extractProblemFromError,
    lookupSessionTarget,
    resolveWorkspace,
    tryListProviders,
    type BoundSession,
} from "./sessions.ts";

export const buildConfigOptions = async (
    seam: ApplicationPort,
    workspaceId?: number,
    sessionId?: number,
): Promise<SessionConfigOption[]> => {
    const providerCatalog = tryListProviders(seam);
    const aliases = providerCatalog.aliases ?? [];
    const [{ model, spawnModel }, capabilities, personas, session] = await Promise.all([
        workspaceId !== undefined && sessionId !== undefined
            ? seam.readSessionModel({ workspaceId, sessionId })
            : Promise.resolve({ model: null, spawnModel: null }),
        workspaceId !== undefined
            ? seam.readWorkspaceCapabilities({ workspaceId })
            : Promise.resolve(null),
        workspaceId !== undefined
            ? (seam.listPersonas?.({ workspaceId }) ?? Promise.resolve([]))
            : Promise.resolve([]),
        workspaceId !== undefined && sessionId !== undefined
            ? seam.readSession({ workspaceId, identity: { id: sessionId } }).catch(() => null)
            : Promise.resolve(null),
    ]);
    const agentsEntry =
        session === null || workspaceId === undefined || sessionId === undefined
            ? null
            : await seam
                  .readEntry({
                      workspaceId,
                      sessionId,
                      target: `session://${session.name}/AGENTS.md`,
                  })
                  .catch(() => null);
    const rawAgentsBody = agentsEntry !== null && agentsEntry.status === 200
        ? (agentsEntry.entry?.channels.body?.content ?? "").trim()
        : "";
    const matchedPersona = rawAgentsBody.length > 0
        ? personas.find((p) => p.body.trim() === rawAgentsBody)
        : undefined;
    const currentPersonaValue = rawAgentsBody.length === 0
        ? "none"
        : (matchedPersona?.name ?? "custom");
    const personaOptions = [
        { value: "none", name: "None (default)", description: null },
        ...personas.map((p) => ({
            value: p.name,
            name: p.name,
            description: p.description,
        })),
        ...(currentPersonaValue === "custom"
            ? [{ value: "custom", name: "Custom (session AGENTS.md)", description: null }]
            : []),
    ];
    const activeAlias = aliases.find((a) => a.active);
    const catalogItems = (() => {
        try {
            return seam.listModels?.({})?.items ?? [];
        } catch {
            return [];
        }
    })();
    const activeCatalogEfforts =
        activeAlias !== undefined
            ? catalogItems.find((e) => e.provider === activeAlias.provider && e.model === activeAlias.model)
                  ?.capabilities?.efforts
            : undefined;
    const effortInfo =
        model !== null && workspaceId !== undefined && sessionId !== undefined
            ? await seam.readSessionEffort({ workspaceId, sessionId })
            : {
                  effort: activeAlias?.effort ?? null,
                  supportedEfforts:
                      activeCatalogEfforts !== undefined && activeCatalogEfforts.length > 0
                          ? activeCatalogEfforts
                          : activeAlias?.effort
                            ? [activeAlias.effort]
                            : ([] as const),
              };

    const modelOptions = aliases.map((a) => ({
        value: a.alias,
        name: `${a.alias} (${a.provider}/${a.model})`,
        description: a.inputCapacity ? `${Math.round(a.inputCapacity / 1000)}k context` : null,
    }));
    for (const entry of catalogItems) {
        if (!entry.readiness?.ready) continue;
        if (modelOptions.some((o) => o.value === entry.selector)) continue;
        const cap = entry.limits?.inputTokens ?? entry.limits?.contextTokens;
        modelOptions.push({
            value: entry.selector,
            name:
                entry.modelName && entry.modelName !== entry.selector
                    ? `${entry.selector} (${entry.modelName})`
                    : entry.selector,
            description:
                typeof cap === "number" && cap > 0
                    ? `${String(Math.round(cap / 1000))}k context`
                    : null,
        });
    }
    const resolvedModelValue = model !== null
        ? (model.alias ?? `${model.provider}/${model.model}`)
        : (activeAlias?.alias ?? "");
    const currentModelValue = resolvedModelValue.length > 0 ? resolvedModelValue : "none";
    if (resolvedModelValue.length > 0 && !modelOptions.some((o) => o.value === resolvedModelValue)) {
        modelOptions.unshift({
            value: resolvedModelValue,
            name: resolvedModelValue,
            description: null,
        });
    }
    const selectModelOptions =
        resolvedModelValue.length === 0
            ? [{ value: "none", name: "None (unselected)", description: null }, ...modelOptions]
            : modelOptions;

    const effortLevels = effortInfo.supportedEfforts;
    const currentEffort = effortInfo.effort ?? "";

    const spawnOptions = [
        { value: "inherit", name: "Inherit from parent", description: null },
        ...modelOptions,
    ];
    const currentSpawnValue = spawnModel !== null
        ? (spawnModel.alias ?? `${spawnModel.provider}/${spawnModel.model}`)
        : "inherit";

    const wsPolicy = capabilities?.workspace;
    const wsDeny = wsPolicy?.deny;
    const wsAllow = wsPolicy?.allow;
    const currentPolicy = Array.isArray(wsDeny) && wsDeny.length > 0
        ? "deny"
        : Array.isArray(wsAllow) && wsAllow.length > 0
            ? "allow"
            : "propose";

    const options: SessionConfigOption[] = [
        {
            configId: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: currentModelValue,
            options: selectModelOptions,
        },
        {
            configId: "thought_level",
            name: "Thinking Effort",
            category: "thought_level",
            type: "select",
            currentValue: currentEffort,
            options: effortLevels.map((lvl) => ({
                value: lvl,
                name: lvl,
                description: null,
            })),
        },
        {
            configId: "spawn_model",
            name: "Child Session Model",
            category: "model_config",
            type: "select",
            currentValue: currentSpawnValue,
            options: spawnOptions,
        },
        {
            configId: "mode",
            name: "Approval Policy",
            category: "mode",
            type: "select",
            currentValue: currentPolicy,
            options: [
                { value: "propose", name: "Ask before external mutations", description: null },
                { value: "allow", name: "Auto-approve all operations", description: null },
                { value: "deny", name: "Deny gated operations", description: null },
            ],
        },
        {
            configId: "persona",
            name: "Persona",
            category: "_persona",
            type: "select",
            currentValue: currentPersonaValue,
            options: personaOptions,
        },
    ];

    if (workspaceId !== undefined) {
        const registeredActions = seam.listModuleActions?.() ?? [];
        for (const family of ["mcp", "skills", "schedule", "personas"] as const) {
            if (!registeredActions.some((a) => a.name === `workspace.${family}.list`)) continue;
            const listed = await seam
                .invokeModuleAction(`workspace.${family}.list`, {}, { scope: "workspace", workspaceId })
                .catch(() => null);
            if (!isRecord(listed)) continue;
            const items = Array.isArray(listed.definitions)
                ? listed.definitions
                : Array.isArray(listed.items)
                  ? listed.items
                  : [];
            for (const item of items) {
                if (!isRecord(item) || typeof item.alias !== "string" || item.alias.length === 0) continue;
                const enabled = item.state !== "disabled" && item.enabled !== false;
                options.push({
                    configId: `${family}:${item.alias}`,
                    name: `${family}:${item.alias}`,
                    category: "other",
                    type: "boolean",
                    currentValue: enabled,
                });
            }
        }
    }

    return options;
};

export const applyConfigOption = async (
    seam: ApplicationPort,
    bound: BoundSession,
    configId: string,
    rawValue: unknown,
): Promise<SessionConfigOption[]> => {
    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    switch (configId) {
        case "model":
            await seam.setSessionModel({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                selector: value,
            });
            break;
        case "thought_level":
            await seam.setSessionEffort({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                effort: value,
            });
            break;
        case "spawn_model":
            await seam.setSessionSpawnModel({
                workspaceId: bound.workspaceId,
                sessionId: bound.sessionId,
                selector: value === "inherit" ? null : value,
            });
            break;
        case "mode":
            if (value === "propose") {
                await seam.setWorkspaceCapabilities({
                    workspaceId: bound.workspaceId,
                    policy: {},
                });
            } else if (value === "allow") {
                await seam.setWorkspaceCapabilities({
                    workspaceId: bound.workspaceId,
                    policy: {
                        allow: [
                            { access: "observe" },
                            { access: "mutate" },
                            { access: "execute" },
                            { access: "interact" },
                            { access: "control" },
                        ],
                    },
                });
            } else if (value === "deny") {
                await seam.setWorkspaceCapabilities({
                    workspaceId: bound.workspaceId,
                    policy: { deny: [{ access: "mutate" }, { access: "execute" }, { access: "control" }] },
                });
            } else {
                throw RequestError.invalidParams({ detail: `Unsupported mode '${value}'.` });
            }
            break;
        case "persona": {
            if (value === "none") {
                await clearSystemPrompt(seam, bound.workspaceId, bound.sessionId, bound.sessionName);
                break;
            }
            const personas = (await seam.listPersonas?.({ workspaceId: bound.workspaceId })) ?? [];
            const matched = personas.find((p) => p.name === value);
            if (matched === undefined) {
                throw RequestError.invalidParams({ detail: `Unknown persona '${value}'.` });
            }
            await applySystemPrompt(seam, bound.workspaceId, bound.sessionId, bound.sessionName, {
                mode: "append",
                content: [{ type: "text", text: matched.body }],
            });
            if (matched.model !== undefined || matched.effort !== undefined) {
                const { model } = await seam.readSessionModel({
                    workspaceId: bound.workspaceId,
                    sessionId: bound.sessionId,
                });
                if (model === null && matched.model !== undefined) {
                    await seam.setSessionModel({
                        workspaceId: bound.workspaceId,
                        sessionId: bound.sessionId,
                        selector: matched.model,
                        ...(matched.effort === undefined ? {} : { effort: matched.effort }),
                    });
                } else if (matched.effort !== undefined && model?.effortSource !== "explicit") {
                    const effortInfo = await seam.readSessionEffort({
                        workspaceId: bound.workspaceId,
                        sessionId: bound.sessionId,
                    }).catch(() => null);
                    if (
                        effortInfo !== null &&
                        effortInfo.source !== "explicit" &&
                        effortInfo.effort !== null &&
                        (effortInfo.supportedEfforts.length === 0 ||
                            effortInfo.supportedEfforts.includes(matched.effort))
                    ) {
                        await seam.setSessionEffort({
                            workspaceId: bound.workspaceId,
                            sessionId: bound.sessionId,
                            effort: matched.effort,
                        });
                    }
                }
            }
            break;
        }
        default: {
            const colonIdx = configId.indexOf(":");
            const family = colonIdx > 0 ? configId.slice(0, colonIdx) : "";
            const alias = colonIdx > 0 ? configId.slice(colonIdx + 1) : "";
            if ((family === "mcp" || family === "skills" || family === "schedule" || family === "personas") && alias.length > 0) {
                const enabled = rawValue === true || value === "true" || value === "1" || value === "on";
                const verb = enabled ? "enable" : "disable";
                await seam.invokeModuleAction(
                    `workspace.${family}.${verb}`,
                    { alias },
                    { scope: "workspace", workspaceId: bound.workspaceId },
                );
                break;
            }
            throw RequestError.invalidParams({ detail: `Unknown configId '${configId}'.` });
        }
    }
    return await buildConfigOptions(seam, bound.workspaceId, bound.sessionId);
};

export const applyInitialConfigOptions = async (
    seam: ApplicationPort,
    bound: BoundSession,
    raw: readonly InitialSessionConfigOption[] | null | undefined,
): Promise<void> => {
    if (!Array.isArray(raw) || raw.length === 0) return;
    let currentOptions = await buildConfigOptions(seam, bound.workspaceId, bound.sessionId);
    for (const entry of raw) {
        const matched = currentOptions.find((opt) => opt.configId === entry.configId);
        if (matched === undefined) continue;
        if (SessionConfigOption.isSelect(matched)) {
            if (entry.type !== "id" || typeof entry.value !== "string") continue;
            const allowed = matched.options.some((optOrGroup) =>
                "value" in optOrGroup
                    ? optOrGroup.value === entry.value
                    : optOrGroup.options.some((choice) => choice.value === entry.value),
            );
            if (!allowed) continue;
        } else if (SessionConfigOption.isBoolean(matched)) {
            if (entry.type !== "boolean" || typeof entry.value !== "boolean") continue;
        } else {
            continue;
        }
        try {
            currentOptions = await applyConfigOption(seam, bound, entry.configId, entry.value);
        } catch {
            currentOptions = await buildConfigOptions(seam, bound.workspaceId, bound.sessionId);
        }
    }
};

export const resolveSessionOptions = async (
    seam: ApplicationPort,
    params: SessionOptionsRequest,
): Promise<SessionOptionsResponse> => {
    if (!isRecord(params) || typeof params.cwd !== "string" || !isAbsolute(params.cwd)) {
        throw RequestError.invalidParams({
            detail: "session/options requires an absolute 'cwd' path.",
        });
    }
    if (params.additionalDirectories !== undefined && params.additionalDirectories !== null) {
        if (
            !Array.isArray(params.additionalDirectories) ||
            !params.additionalDirectories.every((dir) => typeof dir === "string" && isAbsolute(dir))
        ) {
            throw RequestError.invalidParams({
                detail: "session/options 'additionalDirectories' entries must be absolute paths.",
            });
        }
    }
    if (params.sessionId !== undefined && params.sessionId !== null) {
        if (typeof params.sessionId !== "string" || params.sessionId.length === 0) {
            throw RequestError.invalidParams({
                detail: "session/options 'sessionId' must be a non-empty string when provided.",
            });
        }
        const target = await lookupSessionTarget(seam, params.sessionId, params.cwd, params._meta);
        const [configOptions, availableCommands] = await Promise.all([
            buildConfigOptions(seam, target.workspaceId, target.session.id),
            buildAvailableCommands(seam, target.workspaceId),
        ]);
        return {
            configOptions,
            availableCommands,
        };
    }

    const plurnkMeta = extractPlurnkMeta(params._meta);
    let existingWorkspaceId: number | undefined;
    try {
        const resolved = await resolveWorkspace(
            seam,
            params.cwd,
            plurnkMeta.workspaceId,
            plurnkMeta.workspaceName,
            false,
            plurnkMeta.projectRoot,
        );
        existingWorkspaceId = resolved.workspaceId;
    } catch (err) {
        const problem = extractProblemFromError(err);
        if (problem === null || problem.status !== 404) {
            throw err;
        }
    }

    const [configOptions, availableCommands] = await Promise.all([
        buildConfigOptions(seam, existingWorkspaceId),
        buildAvailableCommands(seam, existingWorkspaceId),
    ]);
    return {
        configOptions,
        availableCommands,
    };
};

export const applyAdditionalDirectories = async (
    seam: ApplicationPort,
    workspaceId: number,
    projectRoot: string | null,
    additionalDirectories: readonly string[] | null | undefined,
): Promise<void> => {
    if (!Array.isArray(additionalDirectories) || additionalDirectories.length === 0) return;
    const files: string[] = [];
    for (const rawDir of additionalDirectories) {
        if (typeof rawDir !== "string" || rawDir.trim().length === 0) continue;
        const normalized = rawDir.trim().replace(/\/+$/u, "");
        if (normalized.length === 0) continue;
        if (projectRoot !== null && projectRoot.length > 0 && isAbsolute(normalized)) {
            const rel = relative(projectRoot, resolve(normalized)).split(sep).join("/");
            files.push(rel.length === 0 ? "**" : `${rel}/**`);
        } else {
            files.push(`${normalized}/**`);
        }
    }
    if (files.length === 0) return;
    await seam.invokeModuleAction(
        "workspace.members.add",
        { files },
        { scope: "workspace", workspaceId },
    );
};
