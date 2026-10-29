// {§mcp-open-work} — bidirectional MCP v2 session driving: workspace/session bindings,
// synthetic launch variables, workspace containment, outbound/inbound `_meta` routing,
// and `sampling/createMessage` Open Messages resolved by `SEND`.
import { randomUUID } from "node:crypto";
import { isRecord, type McpServerDefinition } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { actionError } from "./attachment.ts";
import { expandReferences, serverSettings, type ToolPolicy } from "./config.ts";
import type { SamplingMessageParams, SamplingMessageResult } from "./inputRequired.ts";

export type StartSeam = Pick<
    ApplicationPort,
    | "listWorkspaces"
    | "createWorkspace"
    | "activateWorkspace"
    | "listSessions"
    | "readSession"
    | "createSession"
    | "messageAdmission"
    | "runLoop"
    | "readInbox"
    | "subscribeToEvents"
> &
    Partial<Pick<ApplicationPort, "listProviders" | "readSessionModel" | "setSessionModel">>;

export interface ServerBinding {
    readonly operatorScoped: boolean;
    readonly workspaceScope: "*" | ReadonlySet<string>;
    readonly defaultWorkspace: string;
    readonly defaultSession?: string;
    readonly resident: boolean;
}

export interface SyntheticEnvContext {
    readonly workspaceName?: string;
    readonly sessionName?: string;
    readonly projectRoot?: string | null;
    readonly stateDir?: string;
}

export const withSyntheticEnv = (
    baseEnv: NodeJS.ProcessEnv,
    context: SyntheticEnvContext,
): NodeJS.ProcessEnv => ({
    ...baseEnv,
    ...(context.workspaceName === undefined ? {} : { PLURNK_WORKSPACE: context.workspaceName }),
    ...(context.sessionName === undefined ? {} : { PLURNK_SESSION: context.sessionName }),
    ...(context.projectRoot == null ? {} : { PLURNK_PROJECT_ROOT: context.projectRoot }),
    ...(context.stateDir === undefined ? {} : { PLURNK_STATE_DIR: context.stateDir }),
});

const expandWorkspaceSpec = (
    raw: string | readonly string[],
    environ: NodeJS.ProcessEnv,
    field: string,
): "*" | string[] => {
    const values = (typeof raw === "string" ? [raw] : [...raw]).map((item) =>
        expandReferences(item, environ, field),
    );
    if (values.includes("*")) {
        if (values.length > 1) {
            throw new Error(`${field} cannot combine '*' with named workspaces.`);
        }
        return "*";
    }
    return values;
};

export const rawWorkspaceBinding = (
    definition: McpServerDefinition,
    environ: NodeJS.ProcessEnv,
): string | readonly string[] | undefined => {
    const settings = serverSettings(definition.name, environ);
    return settings.workspace ?? definition.plurnkWorkspace;
};

export const rawSessionBinding = (
    definition: McpServerDefinition,
    environ: NodeJS.ProcessEnv,
): string | undefined => {
    const settings = serverSettings(definition.name, environ);
    return settings.session ?? definition.plurnkSession;
};

export const matchesWorkspaceBinding = (
    definition: McpServerDefinition,
    environ: NodeJS.ProcessEnv,
    workspaceName: string | undefined,
): boolean => {
    if (workspaceName === undefined) return true;
    const raw = rawWorkspaceBinding(definition, environ);
    if (raw === undefined) return true;
    try {
        const expanded = expandWorkspaceSpec(
            raw,
            withSyntheticEnv(environ, { workspaceName }),
            `${definition.name}.plurnkWorkspace`,
        );
        return expanded === "*" || expanded.includes(workspaceName);
    } catch {
        return true;
    }
};

export const assertWorkspaceDefinitionScope = (
    definition: McpServerDefinition,
    workspaceName: string | undefined,
    environ: NodeJS.ProcessEnv,
): void => {
    if (workspaceName === undefined || definition.plurnkWorkspace === undefined) return;
    let expanded: "*" | string[];
    try {
        expanded = expandWorkspaceSpec(
            definition.plurnkWorkspace,
            withSyntheticEnv(environ, { workspaceName }),
            `${definition.name}.plurnkWorkspace`,
        );
    } catch (cause) {
        throw actionError(
            "definition-invalid",
            400,
            cause instanceof Error ? cause.message : String(cause),
            { server: definition.name, retryable: false },
            cause,
        );
    }
    const forbidden = expanded === "*"
        ? "*"
        : expanded.find((candidate) => candidate !== workspaceName);
    if (forbidden !== undefined) {
        throw actionError(
            "workspace-scope-forbidden",
            403,
            `Workspace-scoped MCP server '${definition.name}' cannot bind workspace '${forbidden}'; only operator-scoped definitions may bind other workspaces or '*'.`,
            { server: definition.name, workspace: workspaceName, target: forbidden, retryable: false },
        );
    }
};

export const resolveServerBinding = ({
    definition,
    workspaceSettings,
    operatorSettings,
    operatorScoped,
    workspaceName,
    expansionEnv,
}: {
    readonly definition: McpServerDefinition;
    readonly workspaceSettings: ToolPolicy;
    readonly operatorSettings: ToolPolicy;
    readonly operatorScoped: boolean;
    readonly workspaceName: string;
    readonly expansionEnv: NodeJS.ProcessEnv;
}): ServerBinding => {
    const effectiveOperatorScope = operatorScoped || operatorSettings.workspace !== undefined;
    const rawWorkspace = operatorSettings.workspace ?? workspaceSettings.workspace ?? definition.plurnkWorkspace;
    const rawSession = operatorSettings.session ?? workspaceSettings.session ?? definition.plurnkSession;
    const envWithWorkspace = withSyntheticEnv(expansionEnv, { workspaceName });

    let workspaceScope: "*" | ReadonlySet<string>;
    if (rawWorkspace === undefined) {
        workspaceScope = new Set([workspaceName]);
    } else {
        const expanded = expandWorkspaceSpec(rawWorkspace, envWithWorkspace, `${definition.name}.plurnkWorkspace`);
        if (!effectiveOperatorScope) {
            const forbidden = expanded === "*"
                ? "*"
                : expanded.find((candidate) => candidate !== workspaceName);
            if (forbidden !== undefined) {
                throw actionError(
                    "workspace-scope-forbidden",
                    403,
                    `Workspace-scoped MCP server '${definition.name}' cannot bind workspace '${forbidden}'; only operator-scoped definitions may bind other workspaces or '*'.`,
                    { server: definition.name, workspace: workspaceName, target: forbidden, retryable: false },
                );
            }
        }
        workspaceScope = expanded === "*" ? "*" : new Set(expanded);
    }

    const defaultSession = rawSession === undefined
        ? undefined
        : expandReferences(rawSession, envWithWorkspace, `${definition.name}.plurnkSession`);
    if (defaultSession !== undefined && defaultSession.length === 0) {
        throw new Error(`${definition.name}.plurnkSession must be a non-empty string.`);
    }

    return {
        operatorScoped: effectiveOperatorScope,
        workspaceScope,
        defaultWorkspace: workspaceName,
        ...(defaultSession === undefined ? {} : { defaultSession }),
        resident: rawWorkspace !== undefined || defaultSession !== undefined,
    };
};

const extractSamplingPrompt = (params: SamplingMessageParams): string => {
    const parts: string[] = [];
    if (typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0) {
        parts.push(params.systemPrompt.trim());
    }
    const multi = params.messages.length > 1;
    for (const message of params.messages) {
        const blocks = Array.isArray(message.content) ? message.content : [message.content];
        const textBlocks: string[] = [];
        for (const block of blocks) {
            if (!isRecord(block) || typeof block.type !== "string") continue;
            if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                textBlocks.push(block.text);
            } else if (block.type === "tool_use" && typeof block.name === "string") {
                textBlocks.push(`[tool_use: ${block.name}] ${JSON.stringify(block.input ?? {})}`);
            } else if (block.type === "tool_result" && typeof block.toolUseId === "string") {
                const subTexts: string[] = [];
                if (Array.isArray(block.content)) {
                    for (const sub of block.content) {
                        if (isRecord(sub) && sub.type === "text" && typeof sub.text === "string" && sub.text.length > 0) {
                            subTexts.push(sub.text);
                        }
                    }
                }
                const rendered = subTexts.length > 0
                    ? subTexts.join("\n")
                    : block.structuredContent !== undefined
                      ? JSON.stringify(block.structuredContent)
                      : "";
                textBlocks.push(
                    rendered.length > 0
                        ? `[tool_result: ${block.toolUseId}]\n${rendered}`
                        : `[tool_result: ${block.toolUseId}]`,
                );
            } else if (
                (block.type === "image" || block.type === "audio") &&
                typeof block.mimeType === "string" &&
                block.mimeType.length > 0
            ) {
                textBlocks.push(`[${block.type}: ${block.mimeType}]`);
            }
        }
        const text = textBlocks.join("\n\n");
        if (text.length === 0) continue;
        parts.push(multi ? `[${message.role}]\n${text}` : text);
    }
    const prompt = parts.join("\n\n").trim();
    if (prompt.length === 0) {
        throw new Error("MCP sampling/createMessage request contained no text content.");
    }
    return prompt;
};

interface PendingSample {
    readonly workspaceId: number;
    readonly sessionId: number;
    readonly address: string;
    readonly prompt: string;
    readonly resolvedModel: string;
    readonly stopSequences: readonly string[];
    keyPath?: string;
    loopId: number;
    readonly chunks: string[];
    settled: boolean;
    readonly resolve: (result: SamplingMessageResult) => void;
    readonly reject: (reason: unknown) => void;
}

export class OpenWorkCoordinator {
    #seam: StartSeam | null = null;
    #unsubscribe: (() => void) | null = null;
    readonly #pending = new Map<string, PendingSample>();

    get isStarted(): boolean {
        return this.#seam !== null;
    }

    attachSeam(seam: StartSeam): void {
        if (this.#seam === seam) return;
        this.#unsubscribe?.();
        this.#seam = seam;
        this.#unsubscribe = seam.subscribeToEvents((workspaceId, method, params) => {
            this.#onEvent(workspaceId, method, params);
        });
    }

    close(): void {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#seam = null;
        for (const waiter of this.#pending.values()) {
            waiter.settled = true;
            waiter.reject(new Error(`MCP sampling request '${waiter.address}' was aborted by module shutdown.`));
        }
        this.#pending.clear();
    }

    async resolveCallerMeta(
        workspaceId: number,
        sessionId: number,
        fallbackWorkspaceName?: string,
    ): Promise<Readonly<Record<string, unknown>> | undefined> {
        if (workspaceId <= 0 || sessionId <= 0) return undefined;
        const seam = this.#seam;
        if (seam === null) {
            return fallbackWorkspaceName === undefined ? undefined : { plurnkWorkspace: fallbackWorkspaceName };
        }
        const [workspaces, session] = await Promise.all([
            seam.listWorkspaces(),
            seam.readSession({ workspaceId, identity: { id: sessionId } }).catch(() => null),
        ]);
        const workspaceName = workspaces.find((ws) => ws.id === workspaceId)?.name ?? fallbackWorkspaceName;
        if (workspaceName === undefined && session === null) return undefined;
        return {
            ...(workspaceName === undefined ? {} : { plurnkWorkspace: workspaceName }),
            ...(session === null ? {} : { plurnkSession: session.name }),
        };
    }

    async ensureWorkspace(name: string): Promise<{ readonly id: number; readonly name: string }> {
        const seam = this.#seamOrThrow();
        const existing = (await seam.listWorkspaces()).find((ws) => ws.name === name);
        if (existing !== undefined) return { id: existing.id, name: existing.name };
        const created = await seam.createWorkspace({ name, projectRoot: null });
        return { id: created.workspaceId, name: created.workspaceName };
    }

    async ensureSession(workspaceId: number, name: string): Promise<{ readonly sessionId: number; readonly sessionName: string }> {
        const seam = this.#seamOrThrow();
        const existing = await seam.readSession({ workspaceId, identity: { name } });
        if (existing !== null) return { sessionId: existing.id, sessionName: existing.name };
        return seam.createSession({ workspaceId, name });
    }

    async sample({
        server,
        binding,
        params,
        signal,
    }: {
        readonly server: string;
        readonly binding: ServerBinding;
        readonly params: SamplingMessageParams;
        readonly signal?: AbortSignal;
    }): Promise<SamplingMessageResult> {
        signal?.throwIfAborted();
        const seam = this.#seamOrThrow();
        const meta = isRecord(params._meta) ? params._meta : {};
        const requestedWorkspace = typeof meta.plurnkWorkspace === "string" && meta.plurnkWorkspace.length > 0
            ? meta.plurnkWorkspace
            : binding.defaultWorkspace;

        if (binding.workspaceScope !== "*" && !binding.workspaceScope.has(requestedWorkspace)) {
            throw new Error(
                `MCP server '${server}' is not permitted to route work to workspace '${requestedWorkspace}'.`,
            );
        }

        const requestedSession = typeof meta.plurnkSession === "string" && meta.plurnkSession.length > 0
            ? meta.plurnkSession
            : binding.defaultSession;
        if (requestedSession === undefined || requestedSession.length === 0) {
            throw new Error(
                `MCP server '${server}' requested sampling/createMessage without a target session (configure plurnkSession or supply _meta.plurnkSession).`,
            );
        }

        const prompt = extractSamplingPrompt(params);
        const workspace = await this.ensureWorkspace(requestedWorkspace);
        const session = await this.ensureSession(workspace.id, requestedSession);
        await seam.activateWorkspace({ workspaceId: workspace.id });
        signal?.throwIfAborted();

        const hints = isRecord(params.modelPreferences) && Array.isArray(params.modelPreferences.hints)
            ? params.modelPreferences.hints
            : [];
        if (hints.length > 0 && seam.listProviders !== undefined && seam.setSessionModel !== undefined) {
            const aliases = seam.listProviders().aliases;
            for (const hint of hints) {
                if (!isRecord(hint) || typeof hint.name !== "string" || hint.name.trim().length === 0) continue;
                const needle = hint.name.trim().toLowerCase();
                const matched = aliases.find(
                    (a) =>
                        a.alias.toLowerCase() === needle ||
                        `${a.provider}/${a.model}`.toLowerCase() === needle ||
                        a.model.toLowerCase().includes(needle) ||
                        `${a.provider}/${a.model}`.toLowerCase().includes(needle),
                );
                if (matched !== undefined) {
                    await seam
                        .setSessionModel({
                            workspaceId: workspace.id,
                            sessionId: session.sessionId,
                            selector: matched.alias,
                        })
                        .catch(() => null);
                    break;
                }
            }
        }
        const modelInfo = seam.readSessionModel !== undefined
            ? await seam.readSessionModel({ workspaceId: workspace.id, sessionId: session.sessionId }).catch(() => null)
            : null;
        const resolvedModel = modelInfo?.model
            ? `${modelInfo.model.provider}/${modelInfo.model.model}`
            : "plurnk";
        const stopSequences = Array.isArray(params.stopSequences)
            ? params.stopSequences.filter((s): s is string => typeof s === "string" && s.length > 0)
            : [];

        const rawId = typeof meta.plurnkMessageId === "string" && meta.plurnkMessageId.length > 0
            ? meta.plurnkMessageId
            : randomUUID();
        const address = `${server}:///messages/${encodeURIComponent(rawId)}`;
        await seam.messageAdmission({ workspaceId: workspace.id, address, body: prompt });

        const key = `${workspace.id}:${address}`;
        const settled = Promise.withResolvers<SamplingMessageResult>();
        const waiter: PendingSample = {
            workspaceId: workspace.id,
            sessionId: session.sessionId,
            address,
            prompt,
            resolvedModel,
            stopSequences,
            loopId: 0,
            chunks: [],
            settled: false,
            resolve: (result) => {
                if (waiter.settled) return;
                waiter.settled = true;
                this.#pending.delete(key);
                settled.resolve(result);
            },
            reject: (reason) => {
                if (waiter.settled) return;
                waiter.settled = true;
                this.#pending.delete(key);
                settled.reject(reason);
            },
        };
        this.#pending.set(key, waiter);

        const onAbort = (): void => {
            waiter.reject(signal?.reason ?? new Error(`MCP sampling request '${address}' was aborted.`));
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        try {
            const admission = await seam.runLoop({
                workspaceId: workspace.id,
                sessionId: session.sessionId,
                prompt,
                source: server,
                messageAddress: address,
            });
            if (waiter.loopId === 0) waiter.loopId = admission.loopId;
            return await settled.promise;
        } catch (cause) {
            waiter.reject(cause);
            throw cause;
        } finally {
            signal?.removeEventListener("abort", onAbort);
            this.#pending.delete(key);
        }
    }

    #seamOrThrow(): StartSeam {
        if (this.#seam === null) {
            throw new Error("MCP Open Work coordinator requires a started daemon seam.");
        }
        return this.#seam;
    }

    #onEvent(workspaceId: number | null, method: string, params: unknown): void {
        if (workspaceId === null || !isRecord(params)) return;
        if (method === "log/entry") {
            const entry = isRecord(params.entry) ? params.entry : params;
            if (entry.op !== "SEND" || entry.status_rx !== 200 || !isRecord(entry.rx)) return;
            const tx = isRecord(entry.tx) ? entry.tx : {};
            const txBody = typeof tx.body === "string"
                ? tx.body
                : isRecord(tx.body) && typeof tx.body.raw === "string"
                    ? tx.body.raw
                    : "";

            if (entry.origin === "_plurnk" && typeof entry.rx.resource === "string") {
                const sessionId = typeof entry.session_id === "number" ? entry.session_id : undefined;
                const loopId = typeof entry.loop_id === "number" ? entry.loop_id : undefined;
                for (const waiter of this.#pending.values()) {
                    if (waiter.settled || waiter.workspaceId !== workspaceId || waiter.keyPath !== undefined) continue;
                    if (sessionId !== undefined && waiter.sessionId !== sessionId) continue;
                    if (txBody === waiter.prompt) {
                        waiter.keyPath = entry.rx.resource;
                        if (loopId !== undefined && waiter.loopId === 0) waiter.loopId = loopId;
                        break;
                    }
                }
                return;
            }

            const repliedTo = Array.isArray(entry.rx.repliedTo) ? entry.rx.repliedTo : [];
            const explicitTarget = isRecord(tx.target) && typeof tx.target.raw === "string"
                ? [tx.target.raw]
                : [];
            const targets = new Set<string>();
            for (const candidate of [...repliedTo, ...explicitTarget]) {
                if (typeof candidate === "string") targets.add(candidate);
            }
            if (targets.size === 0) return;

            const completion = entry.rx.completion;
            for (const waiter of this.#pending.values()) {
                if (waiter.settled || waiter.workspaceId !== workspaceId) continue;
                const matched = targets.has(waiter.address)
                    || (waiter.keyPath !== undefined && targets.has(waiter.keyPath));
                if (!matched) continue;
                if (completion === 200) {
                    const rawText = [...waiter.chunks, ...(txBody.length > 0 ? [txBody] : [])].join("\n\n");
                    let text = rawText;
                    let stopReason: "endTurn" | "stopSequence" = "endTurn";
                    for (const seq of waiter.stopSequences) {
                        const idx = text.indexOf(seq);
                        if (idx >= 0) {
                            text = text.slice(0, idx);
                            stopReason = "stopSequence";
                        }
                    }
                    waiter.resolve({
                        role: "assistant",
                        content: { type: "text", text },
                        model: waiter.resolvedModel,
                        stopReason,
                    });
                } else if (completion === 499) {
                    waiter.reject(new Error(
                        txBody.length > 0
                            ? txBody
                            : `MCP sampling request '${waiter.address}' was declined (499).`,
                    ));
                } else if (txBody.length > 0) {
                    waiter.chunks.push(txBody);
                }
            }
            return;
        }
        if (method === "loop/terminated") {
            const loopId = typeof params.loopId === "number" ? params.loopId : undefined;
            const sessionId = typeof params.sessionId === "number" ? params.sessionId : undefined;
            if (loopId === undefined) return;
            const status = isRecord(params.result) && typeof params.result.status === "number"
                ? params.result.status
                : 500;
            for (const waiter of this.#pending.values()) {
                if (waiter.settled || waiter.workspaceId !== workspaceId) continue;
                if (waiter.loopId !== loopId && (waiter.loopId !== 0 || waiter.sessionId !== sessionId)) continue;
                void this.#checkTerminatedLoop(waiter, loopId, status);
            }
        }
    }

    async #checkTerminatedLoop(waiter: PendingSample, endedLoopId: number, status: number): Promise<void> {
        const seam = this.#seam;
        if (waiter.settled || seam === null) return;
        try {
            const inbox = await seam.readInbox({ workspaceId: waiter.workspaceId, sessionId: waiter.sessionId });
            const pending = inbox.find((msg) => msg.path === waiter.address);
            if (
                pending !== undefined
                && pending.loopId !== endedLoopId
                && (pending.lifecycle === "queued" || pending.lifecycle === "running" || pending.lifecycle === "parked")
            ) {
                waiter.loopId = pending.loopId;
                return;
            }
        } catch {
            // Fall through to rejection if the inbox cannot be inspected.
        }
        if (!waiter.settled && (waiter.loopId === endedLoopId || waiter.loopId === 0)) {
            waiter.reject(new Error(
                `MCP sampling request '${waiter.address}' ended without a reply (loop status ${status}).`,
            ));
        }
    }
}
