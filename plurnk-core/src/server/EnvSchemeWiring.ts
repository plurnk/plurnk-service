// {§env-functionality} {§exec} — Daemon wiring for `EnvFunctionality`, `EnvScheme`, and `Exec` env sinks.

import { isSafeInteger, type ApplicationSessionIdentity, type ApplicationSessionProjection } from "@plurnk/plurnk-contracts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import { contentWeight } from "../core/content-weight.ts";
import type { Db } from "../core/Db.ts";
import type HostPaths from "../core/HostPaths.ts";
import { OperationFailureError } from "../core/results.ts";
import type SchemeRegistry from "../core/SchemeRegistry.ts";
import Paths from "../Paths.ts";
import EntryCrud from "../schemes/_entry-crud.ts";
import EnvScheme from "../schemes/Env.ts";
import Exec from "../schemes/Exec.ts";
import EnvFunctionality from "./EnvFunctionality.ts";
import type Functionality from "./Functionality.ts";
import type WorkspaceResidency from "./WorkspaceResidency.ts";

const envEntryCtx = (db: Db, mimetypes: Mimetypes, workspaceId: number, sessionId = 0) => ({
    db,
    workspaceId,
    sessionId,
    loopId: 0,
    turnId: 0,
    writer: "_plurnk" as const,
    signal: undefined,
    mimetypes,
    weigh: contentWeight,
});

export const createDaemonEnvFunctionality = (args: {
    readonly db: Db;
    readonly hostPaths: HostPaths;
    readonly mimetypes: Mimetypes;
    readonly nodeModulesPath: string;
    readonly functionality: Functionality;
    readonly readSession: (a: {
        readonly workspaceId: number;
        readonly identity: ApplicationSessionIdentity;
    }) => Promise<ApplicationSessionProjection | null>;
    readonly listSessions: (workspaceId: number) => Promise<ApplicationSessionProjection[]>;
}): EnvFunctionality => {
    const { db, hostPaths, mimetypes, nodeModulesPath, functionality, readSession, listSessions } = args;
    return new EnvFunctionality(
        EnvFunctionality.defaultsReader(Paths.packageRoot, nodeModulesPath),
        new EnvScheme({
            resolveWorkspace: async (workspaceId) => (await EnvFunctionality.workspace(db, workspaceId, hostPaths))(),
            resolveSession: async (workspaceId, authority) => {
                const trimmed = authority.trim();
                if (trimmed.length === 0) return null;
                try {
                    const byName = await readSession({ workspaceId, identity: { name: trimmed } });
                    if (byName !== null) return { id: byName.id, name: byName.name, origin: byName.origin };
                } catch (cause) {
                    if (!(cause instanceof OperationFailureError)) throw cause;
                }
                if (/^[1-9]\d*$/u.test(trimmed) && isSafeInteger(Number(trimmed))) {
                    const byId = await readSession({ workspaceId, identity: { id: Number(trimmed) } });
                    if (byId !== null) return { id: byId.id, name: byId.name, origin: byId.origin };
                }
                return null;
            },
            sessionOverrides: (_workspaceId, sessionId) => EnvFunctionality.sessionOverrides(db, sessionId),
            listSessionScopes: async (workspaceId) => {
                const sessions = await listSessions(workspaceId);
                const out: Array<{ name: string; overrides: Readonly<Record<string, string>> }> = [];
                for (const session of sessions) {
                    if (session.origin === "_plurnk") continue;
                    out.push({
                        name: session.name,
                        overrides: await EnvFunctionality.sessionOverrides(db, session.id),
                    });
                }
                return out;
            },
            writeProjection: async (workspaceId, authority, pathname, value) =>
                EntryCrud.writeEntry(
                    { authority, pathname },
                    { channels: { body: { content: value, mimetype: "text/plain" } } },
                    envEntryCtx(db, mimetypes, workspaceId),
                    "env",
                    { defaultChannel: "body" },
                ),
            deleteProjection: async (workspaceId, authority, pathname) => {
                await EntryCrud.deleteEntry({ authority, pathname }, envEntryCtx(db, mimetypes, workspaceId), "env");
            },
            invoke: (verb, params, identity) => functionality.invoke("env", verb, params, identity, "operation"),
        }),
        hostPaths,
        db,
    );
};

export const bindDaemonExecScheme = (args: {
    readonly db: Db;
    readonly mimetypes: Mimetypes;
    readonly schemes: SchemeRegistry;
    readonly residency: WorkspaceResidency;
    readonly functionality: Functionality;
}): void => {
    const { db, mimetypes, schemes, residency, functionality } = args;
    const execScheme = schemes.get("exec");
    if (!(execScheme instanceof Exec)) return;
    execScheme.bindWorkspaceResidency((workspaceId) =>
        residency.isActive(workspaceId) ? residency.retain(workspaceId) : null,
    );
    execScheme.bindEnvSink(async ({ workspaceId, sessionId, text }) => {
        const parsed = EnvFunctionality.parseSink(text);
        if ("status" in parsed) return parsed;
        if (parsed.entries.length === 0) return null;
        const runtimeId = (await db.runtime_session_get.get<{ id: number }>({ workspace_id: workspaceId }))?.id;
        const isRuntime = runtimeId === sessionId;
        const sessionRow = isRuntime
            ? undefined
            : await db.envelope_get_session_by_id.get<{ name: string }>({ id: sessionId });
        const authority = isRuntime ? "" : (sessionRow?.name ?? "");
        const identity = isRuntime
            ? { workspaceId, scope: "workspace" as const }
            : { workspaceId, sessionId, scope: "session" as const };
        for (const { alias, value } of parsed.entries) {
            try {
                await functionality.invoke("env", "replace", { alias, value }, identity, "action");
                await EntryCrud.deleteEntry(
                    { authority, pathname: `/${alias}` },
                    envEntryCtx(db, mimetypes, workspaceId, sessionId),
                    "env",
                );
            } catch (cause) {
                if (cause instanceof OperationFailureError) return cause.result;
                throw cause;
            }
        }
        return null;
    });
};
