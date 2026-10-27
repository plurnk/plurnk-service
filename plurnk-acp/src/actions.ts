// {§acp-action-binding} {§acp-daemon-client} `_plurnk/action` dispatch, discovery advertisement, and slash commands.

import { RequestError, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { Validator, isRecord, type AcpDiscovery } from "@plurnk/plurnk-contracts";
import type { ApplicationPort } from "@plurnk/plurnk-contracts/port";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import SessionTranslator from "./SessionTranslator.ts";
import {
    OWNER_ADDRESS,
    parseSessionId,
    resolveWorkspace,
    type AcpPeer,
    type BoundSession,
} from "./sessions.ts";

export const buildDiscovery = async (seam: ApplicationPort): Promise<AcpDiscovery> => {
    const display = (await seam.listClientDisplayCapabilities?.()) ?? [];
    const moduleActions = seam.listModuleActions?.() ?? [];
    const objSchema = { type: "object", additionalProperties: true } as const;
    const actions: Record<
        string,
        {
            readonly scope: "daemon" | "workspace" | "session";
            readonly inputSchema: Record<string, unknown>;
            readonly outputSchema: Record<string, unknown>;
        }
    > = {
        ping: { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
        discover: { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
        "models.list": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
        "service.update": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.create": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.attach": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.list": { scope: "daemon", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.sessions": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.rename": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.share": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.rollback": { scope: "session", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.capabilities.get": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.capabilities.set": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        "workspace.prompts": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        "session.loops": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
        "log.read": { scope: "session", inputSchema: objSchema, outputSchema: objSchema },
        "entry.read": { scope: "session", inputSchema: objSchema, outputSchema: objSchema },
        "op.parse": { scope: "workspace", inputSchema: objSchema, outputSchema: objSchema },
    };
    for (const act of moduleActions) {
        actions[act.name] = {
            scope: act.scope,
            inputSchema: act.inputSchema,
            outputSchema: act.outputSchema,
        };
    }
    return {
        schemaVersion: 1,
        actions,
        notifications: {
            "session/update": { payloadSchema: objSchema },
        },
        display,
    };
};

export const resolveActionTarget = async (
    seam: ApplicationPort,
    rawParams: Record<string, unknown>,
    params: Record<string, unknown>,
    createWorkspace = true,
): Promise<{
    readonly workspaceId: number;
    readonly sessionName: string;
    readonly sessionId: number;
    readonly hasSession: boolean;
}> => {
    const sessionHint = typeof rawParams.sessionId === "string"
        ? rawParams.sessionId
        : typeof params.sessionId === "string"
          ? params.sessionId
          : undefined;
    const parsedSession = sessionHint !== undefined ? parseSessionId(sessionHint) : null;
    const explicitWsId = typeof rawParams.workspaceId === "number"
        ? rawParams.workspaceId
        : typeof params.workspaceId === "number"
          ? params.workspaceId
          : parsedSession?.workspaceId;
    const workspaceHint = typeof rawParams.workspace === "string"
        ? rawParams.workspace
        : typeof params.workspace === "string"
          ? params.workspace
          : undefined;
    const cwdHint = typeof rawParams.cwd === "string"
        ? rawParams.cwd
        : typeof params.cwd === "string"
          ? params.cwd
          : undefined;
    const explicitProjectRoot = rawParams.projectRoot === null || typeof rawParams.projectRoot === "string"
        ? rawParams.projectRoot
        : params.projectRoot === null || typeof params.projectRoot === "string"
          ? params.projectRoot
          : undefined;
    const ws = await resolveWorkspace(
        seam,
        cwdHint,
        explicitWsId,
        workspaceHint,
        createWorkspace,
        explicitProjectRoot,
    );
    const explicitSessionName = typeof rawParams.session === "string"
        ? rawParams.session
        : typeof params.session === "string"
          ? params.session
          : parsedSession?.sessionName;
    let session = explicitSessionName !== undefined
        ? await seam.readSession({ workspaceId: ws.workspaceId, identity: { name: explicitSessionName } })
        : null;
    if (session === null && sessionHint !== undefined && parsedSession === null) {
        const ref = await seam.readSessionReference({ namespace: "acp", reference: sessionHint });
        if (ref !== null && ref.workspaceId === ws.workspaceId) {
            session = await seam.readSession({ workspaceId: ws.workspaceId, identity: { id: ref.sessionId } });
        } else {
            session = await seam.readSession({ workspaceId: ws.workspaceId, identity: { name: sessionHint } });
        }
    }
    if (session === null && explicitSessionName === undefined) {
        session = await seam.readSession({ workspaceId: ws.workspaceId, identity: { name: "user" } });
    }
    const sessionName = session?.name ?? explicitSessionName ?? sessionHint ?? "user";
    return {
        workspaceId: ws.workspaceId,
        sessionName,
        sessionId: session?.id ?? 1,
        hasSession: session !== null,
    };
};

export const handlePlurnkAction = async (
    seam: ApplicationPort,
    origin: string,
    rawParams: unknown,
    peer: AcpPeer | undefined,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
): Promise<unknown> => {
    if (!isRecord(rawParams) || typeof rawParams.kind !== "string") {
        throw RequestError.invalidParams({ detail: "_plurnk/action requires a string 'kind'." });
    }
    const kind = rawParams.kind;
    const params = isRecord(rawParams.params) ? rawParams.params : {};
    const sessionHint = typeof rawParams.sessionId === "string" && rawParams.sessionId.length > 0
        ? rawParams.sessionId
        : "1#user";

    if (kind === "ping") {
        return {};
    }

    if (kind === "discover") {
        if (peer !== undefined && peer.client !== null) {
            const tempTranslator = new SessionTranslator({
                acpSessionId: sessionHint,
                workspaceId: 1,
                sessionId: 1,
                origin,
            });
            for (const notice of seam.configurationNotices()) {
                for (const { update } of tempTranslator.notice(notice)) {
                    notifyPeerSession(peer, sessionHint, update);
                }
            }
        }
        return await buildDiscovery(seam);
    }

    if (kind === "workspace.create") {
        const created = await seam.createWorkspace({
            ...(typeof params.name === "string" ? { name: params.name } : {}),
            ...(typeof params.projectRoot === "string" || params.projectRoot === null ? { projectRoot: params.projectRoot } : {}),
            ...(typeof params.settings === "string" || isRecord(params.settings) ? { settings: params.settings } : {}),
        });
        return {
            ...created,
            id: created.workspaceId,
            name: created.workspaceName,
        };
    }

    if (kind === "workspace.attach") {
        const wsId = typeof params.id === "number"
            ? params.id
            : typeof params.workspaceId === "number"
              ? params.workspaceId
              : undefined;
        const attached = await seam.attachWorkspace(
            wsId !== undefined
                ? { workspaceId: wsId }
                : typeof params.name === "string"
                  ? { name: params.name }
                  : { projectRoot: typeof params.projectRoot === "string" ? params.projectRoot : "" },
        );
        return {
            ...attached,
            id: attached.workspaceId,
            name: attached.workspaceName,
        };
    }

    if (kind === "models.list") {
        return seam.listModels({
            ...(typeof params.search === "string" ? { search: params.search } : {}),
            ...(typeof params.provider === "string" ? { provider: params.provider } : {}),
            ...(typeof params.all === "boolean" ? { all: params.all } : {}),
            ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
        });
    }

    if (kind === "service.update") {
        if (typeof seam.updateService !== "function") {
            throw RequestError.internalError({ detail: "service.update is not supported by this daemon." });
        }
        try {
            return await seam.updateService();
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw RequestError.invalidParams({ detail });
        }
    }

    if (kind === "workspace.list") {
        const workspaces = await seam.listWorkspaces({
            ...(typeof params.hidden === "boolean" ? { hidden: params.hidden } : {}),
        });
        return { workspaces };
    }

    if (kind === "workspace.sessions") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const sessions = await seam.listSessions(target.workspaceId, {
            ...(typeof params.hidden === "boolean" ? { hidden: params.hidden } : {}),
        });
        return { sessions };
    }

    if (kind === "workspace.rename") {
        const fromHint = typeof params.from === "string" ? params.from : undefined;
        const target = await resolveActionTarget(
            seam,
            fromHint ? { ...rawParams, workspace: fromHint } : rawParams,
            params,
            false,
        );
        const nextName = typeof params.name === "string" ? params.name : typeof params.to === "string" ? params.to : "";
        return await seam.renameWorkspace(target.workspaceId, nextName);
    }

    if (kind === "workspace.share") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        return await seam.shareWorkspace({
            workspaceId: target.workspaceId,
            folder: typeof params.folder === "string" ? params.folder : "",
        });
    }

    if (kind === "workspace.rollback") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        return await seam.rollback({
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            actor: OWNER_ADDRESS,
            to: typeof params.to === "string" ? params.to : "",
        });
    }

    if (kind === "workspace.capabilities.get") {
        const target = await resolveActionTarget(seam, rawParams, params);
        return await seam.readWorkspaceCapabilities({ workspaceId: target.workspaceId });
    }

    if (kind === "workspace.capabilities.set") {
        const target = await resolveActionTarget(seam, rawParams, params);
        const policyObj: Parameters<ApplicationPort["setWorkspaceCapabilities"]>[0]["policy"] =
            isRecord(params.policy) ? params.policy : {};
        return await seam.setWorkspaceCapabilities({
            workspaceId: target.workspaceId,
            policy: policyObj,
        });
    }

    if (kind === "workspace.prompts") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const prompts = await seam.listPrompts(
            target.workspaceId,
            typeof params.limit === "number" ? params.limit : undefined,
            typeof params.sessionId === "number" ? params.sessionId : undefined,
        );
        return { prompts };
    }

    if (kind === "session.loops") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const items = await seam.listSessionLoops({ workspaceId: target.workspaceId, sessionId: target.sessionId });
        return { items };
    }

    if (kind === "log.read") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        const entries = await seam.readLog({
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            ...(typeof params.loopId === "number" ? { loopId: params.loopId } : {}),
            ...(typeof params.turnId === "number" ? { turnId: params.turnId } : {}),
            ...(typeof params.sinceId === "number" ? { sinceId: params.sinceId } : {}),
            ...(typeof params.beforeId === "number" ? { beforeId: params.beforeId } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
            ...(typeof params.loopSeq === "number" ? { loopSeq: params.loopSeq } : {}),
            ...(typeof params.turnSeq === "number" ? { turnSeq: params.turnSeq } : {}),
            ...(typeof params.sequence === "number" ? { sequence: params.sequence } : {}),
        });
        return { entries };
    }

    if (kind === "entry.read") {
        const target = await resolveActionTarget(seam, rawParams, params, false);
        return await seam.readEntry({
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
            target: typeof params.target === "string" ? params.target : "",
            ...(typeof params.channel === "string" ? { channel: params.channel } : {}),
            ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
        });
    }

    if (kind === "op.parse") {
        const target = await resolveActionTarget(seam, rawParams, params, true);
        await seam.activateWorkspace?.({ workspaceId: target.workspaceId });
        const text = typeof params.text === "string" ? params.text : "";
        const executors = seam.executorTags?.(target.workspaceId) ?? ["sh", "js"];
        const parsed = PlurnkParser.parseStatements(text, { executors });
        const parseErrors = parsed.items.filter(
            (i): i is Extract<typeof i, { kind: "error" }> => i.kind === "error" && i.error.severity === "error",
        );
        const statements = parsed.items
            .filter((i): i is Extract<typeof i, { kind: "statement" }> => i.kind === "statement")
            .map((i) => i.statement);
        if (parseErrors.length > 0 || parsed.unparsedTail !== undefined || statements.length === 0) {
            const msg = parseErrors[0]?.error.message ?? PlurnkParser.NO_VALID_OPERATION;
            return {
                results: [
                    {
                        status: 400,
                        message: msg,
                        content: msg,
                        mimetype: "text/plain",
                    },
                ],
            };
        }
        await seam.ensureRuntimeSession(target.workspaceId);
        const results = await seam.dispatchClientAction({
            workspaceId: target.workspaceId,
            actor: OWNER_ADDRESS,
            ...(target.hasSession ? { contextSessionId: target.sessionId } : {}),
            statements,
        });
        return { results };
    }

    const moduleActions = seam.listModuleActions?.() ?? [];
    const registered = moduleActions.find((a) => a.name === kind);
    if (!registered) {
        throw new RequestError(
            -32601,
            `Action '${kind}' is not registered. Recovery: Use an action advertised by discover.`,
        );
    }

    if (isRecord(registered.inputSchema)) {
        const validation = Validator.validateJsonSchemaInstance(registered.inputSchema, params);
        if (!validation.valid) {
            throw new RequestError(-32602, `Action '${kind}' rejected parameters.`);
        }
    }

    if (registered.scope === "daemon") {
        return await seam.invokeModuleAction(kind, params, { scope: "daemon" });
    }
    const target = await resolveActionTarget(seam, rawParams, params);
    if (peer !== undefined && peer.client !== null) {
        const preparation = seam.workspacePreparationStatus?.(target.workspaceId) ?? [];
        const activity = seam.workspaceDerivationStatus?.(target.workspaceId) ?? null;
        notifyPeerSession(peer, sessionHint, {
            sessionUpdate: "notice",
            severity: "info",
            title: "workspace:state",
            _meta: {
                plurnk: {
                    workspace: {
                        id: target.workspaceId,
                        preparation,
                        activity,
                    },
                },
            },
        });
    }
    if (registered.scope === "session") {
        return await seam.invokeModuleAction(kind, params, {
            scope: "session",
            workspaceId: target.workspaceId,
            sessionId: target.sessionId,
        });
    }
    return await seam.invokeModuleAction(kind, params, {
        scope: "workspace",
        workspaceId: target.workspaceId,
    });
};

export const executeSlashCommand = async (
    seam: ApplicationPort,
    origin: string,
    bound: BoundSession,
    cmd: string,
    rest: string,
    peer: AcpPeer | undefined,
    notifyPeerSession: (peer: AcpPeer, sessionId: string, update: SessionUpdate) => void,
): Promise<string> => {
    const envelope = {
        sessionId: bound.acpSessionId,
        workspaceId: bound.workspaceId,
        workspace: bound.workspaceName,
        session: bound.sessionName,
    };
    const invoke = (action: Record<string, unknown>): Promise<unknown> =>
        handlePlurnkAction(seam, origin, action, peer, notifyPeerSession);

    if (cmd === "script") {
        const res = await invoke({ ...envelope, kind: "op.parse", params: { text: rest } });
        if (isRecord(res) && Array.isArray(res.results)) {
            return res.results
                .map((r) => {
                    if (!isRecord(r)) return String(r);
                    if (typeof r.content === "string") return r.content;
                    if (typeof r.message === "string") return r.message;
                    if (typeof r.status === "number") return String(r.status);
                    return "200";
                })
                .join("\n");
        }
        return `Executed /${cmd}`;
    }
    if (cmd === "rollback") {
        const res = await invoke({ ...envelope, kind: "workspace.rollback", params: { to: rest } });
        return typeof res === "string" ? res : JSON.stringify(res);
    }
    if (cmd === "share") {
        const res = await invoke({ ...envelope, kind: "workspace.share", params: { folder: rest } });
        return typeof res === "string" ? res : JSON.stringify(res);
    }
    if (cmd === "update") {
        const res = await invoke({ ...envelope, kind: "service.update", params: {} });
        if (isRecord(res) && isRecord(res.catalog) && isRecord(res.npm)) {
            const added = typeof res.catalog.addedModels === "number" && res.catalog.addedModels > 0
                ? `, +${res.catalog.addedModels} new`
                : "";
            const catLine = `catalog: ${String(res.catalog.status)} (${String(res.catalog.models)} models across ${String(res.catalog.providers)} providers${added})`;
            const npmLine = res.npm.status === "source"
                ? `npm: ${String(res.npm.package)}@${String(res.npm.currentVersion)} (source checkout)`
                : res.npm.status === "updated"
                  ? `npm: ${String(res.npm.package)} ${String(res.npm.previousVersion)} -> ${String(res.npm.currentVersion)}`
                  : `npm: ${String(res.npm.package)}@${String(res.npm.currentVersion)} (unchanged)`;
            return `${catLine}\n${npmLine}`;
        }
        return typeof res === "string" ? res : JSON.stringify(res);
    }
    const tokens = rest.length > 0 ? rest.split(/\s+/u) : [];
    const verb = tokens[0] ?? "list";
    const alias = tokens[1];
    const actionName = `workspace.${cmd}.${verb}`;
    const actionParams: Record<string, unknown> = alias !== undefined ? { alias } : {};
    try {
        const res = await invoke({ ...envelope, kind: actionName, params: actionParams });
        if (isRecord(res)) {
            const definitions = Array.isArray(res.definitions)
                ? res.definitions
                : Array.isArray(res.items)
                  ? res.items
                  : null;
            if (definitions !== null) {
                if (definitions.length === 0) {
                    return `${cmd}: none`;
                }
                return definitions
                    .map((item) => {
                        if (!isRecord(item)) return String(item);
                        const name = typeof item.alias === "string"
                            ? item.alias
                            : typeof item.name === "string"
                              ? item.name
                              : "";
                        const state = typeof item.state === "string" ? item.state : "active";
                        return `${name}  ${state}`;
                    })
                    .join("\n");
            }
        }
        return `Executed /${cmd}`;
    } catch {
        return `Executed /${cmd}`;
    }
};
