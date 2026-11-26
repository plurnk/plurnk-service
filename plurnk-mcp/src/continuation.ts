import { isDeepStrictEqual } from "node:util";
import { CompleteRequestParamsSchema } from "@modelcontextprotocol/core";
import { GuardBlockedError } from "@plurnk/plurnk-meta";
import type {
    FunctionalityOrigin,
    McpOAuthBeginResult,
    McpOAuthCompletionResult,
    McpServerDefinition,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type ServerConnection from "./client.ts";
import { AuthorizationRequiredError, awaitsSignIn, causeOf } from "./client.ts";
import type { OAuthGrant } from "./oauth.ts";
import {
    actionError,
    assertActionKeys,
    attachmentConnection,
    ModuleActionError,
    objectOf,
    requiredString,
    sameBinding,
    type ActiveAttachment,
    type Attachment,
    type ConnectedAttachment,
    type McpBinding,
    type PendingAuthorization,
} from "./attachment.ts";
import { preparationError } from "./attachment-runtime.ts";

export interface PendingServiceAuthorization extends McpBinding {
    readonly connection: ServerConnection;
    completion?: { readonly callbackUrl: string; readonly result: Promise<McpOAuthCompletionResult> };
}

export interface ServiceContinuationHost {
    isClosed(): boolean;
    readonly servicePending: Map<string, PendingServiceAuthorization>;
    readonly authorizing: Set<string>;
    readServiceDefinition(alias: string): Promise<{
        readonly alias: string;
        readonly origin: FunctionalityOrigin;
        readonly definition: McpServerDefinition;
    } | null>;
    createServiceOAuthConnection(
        alias: string,
        origin: FunctionalityOrigin,
        definition: McpServerDefinition,
        redirectUrl: string,
    ): Promise<ServerConnection>;
    recordServiceGrant(entry: McpBinding & { readonly grant: OAuthGrant }): Promise<void>;
    refreshServiceWorkspaces(alias: string): Promise<void>;
    closeOwned(connections: readonly ServerConnection[]): Promise<void>;
}

const assertOAuthRedirectUrl = (redirectUrl: string): void => {
    const redirect = URL.parse(redirectUrl);
    if (redirect === null || redirect.username || redirect.password || redirect.hash || redirect.port === "0"
        || !(redirect.protocol === "https:" || (redirect.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(redirect.hostname)))) {
        throw actionError("oauth-redirect-invalid", 400, "The OAuth callback must use HTTPS or HTTP loopback with a usable port.", { retryable: false });
    }
};

const assertInteractiveOAuthDefinition = (alias: string, definition: McpServerDefinition, redirectUrl: string): void => {
    if (definition.type !== "streamable-http"
        || (definition.authorization !== undefined && definition.authorization.type !== "oauth")
        || Object.keys(definition.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
        || (definition.authorization?.redirectUrl !== undefined && definition.authorization.redirectUrl !== redirectUrl)) {
        throw actionError("oauth-configuration-conflict", 409,
            `MCP server '${alias}' is not configured for this interactive OAuth callback.`, { retryable: false });
    }
};

const scrubOAuthDiagnostic = (rawDiagnostic: string | undefined, callbackUrl: string): string | undefined => {
    if (rawDiagnostic === undefined) return undefined;
    const callbackSecrets = (() => {
        const parsed = URL.parse(callbackUrl);
        if (parsed === null) return [];
        return ["code", "state", "token", "access_token", "refresh_token", "client_secret"]
            .flatMap((param) => parsed.searchParams.getAll(param))
            .filter((value) => value.length >= 4);
    })();
    return callbackSecrets.reduce(
        (text, secret) => text.split(secret).join("__redacted__"),
        rawDiagnostic.replace(
            /([?&](?:code|state|token|access_token|refresh_token|client_secret)=)[^&#\s"']+/giu,
            "$1__redacted__",
        ),
    ).trim() || undefined;
};

export interface ContinuationHost {
    isClosed(): boolean;
    readonly attachments: Map<number, ReadonlyMap<string, Attachment>>;
    readonly pending: Map<string, PendingAuthorization>;
    readonly authorizing: Set<string>;
    readonly challenged: Set<string>;
    readonly dirty: Map<string, symbol>;
    readonly grants: Map<string, McpBinding & { readonly grant: OAuthGrant }>;
    recordGrant(workspaceId: number, entry: McpBinding & { readonly grant: OAuthGrant }): Promise<void>;
    pendingKey(workspaceId: number, name: string): string;
    retain(workspaceId: number): () => void;
    closeOwned(connections: readonly ServerConnection[]): Promise<void>;
    prepareAttachment(
        workspaceId: number,
        binding: McpBinding,
        connection?: ServerConnection,
        oauthRedirectUrl?: string,
        signal?: AbortSignal,
    ): Promise<Attachment>;
    refreshCatalog(workspaceId: number, name: string, attempt?: number): void;
}

// {§oauth-continuation} The SDK's authorization starts on the connection; one it finds authorized stays active.
const beginUnchallenged = async (host: ContinuationHost, connected: ActiveAttachment): Promise<ConnectedAttachment> => {
    let authorizationUrl: string | undefined;
    try {
        authorizationUrl = await connected.connection.beginAuthorization();
    } catch (cause) {
        let closeCause: unknown;
        try {
            await host.closeOwned([connected.connection]);
        } catch (error) {
            closeCause = error;
        }
        const { alias, definition } = connected;
        throw preparationError(alias, definition, definition.type === "streamable-http" ? definition.authorization : undefined, cause, closeCause);
    }
    if (authorizationUrl === undefined) return connected;
    return {
        alias: connected.alias,
        ...(connected.origin === undefined ? {} : { origin: connected.origin }),
        definition: connected.definition,
        kind: "authorization-required",
        connection: connected.connection,
        authorizationUrl,
    };
};

// {§oauth-continuation} Client callback state travels with the prepared connection, not its definition.
export const beginOAuth = async (
    host: ContinuationHost,
    identity: WorkspaceCapabilityIdentity,
    params: Readonly<Record<string, unknown>>,
): Promise<McpOAuthBeginResult> => {
    assertActionKeys(params, ["alias", "redirectUrl"]);
    const alias = requiredString(params, "alias");
    const redirectUrl = requiredString(params, "redirectUrl");
    assertOAuthRedirectUrl(redirectUrl);
    const current = host.attachments.get(identity.workspaceId)?.get(alias);
    if (current === undefined) throw actionError("server-not-connected", 409, `MCP server '${alias}' is not connected for this workspace.`, { retryable: false });
    if (current.kind === "active") return { status: 200, alias };
    assertInteractiveOAuthDefinition(alias, current.definition, redirectUrl);
    const key = host.pendingKey(identity.workspaceId, alias);
    if (host.pending.get(key)?.authorized === true) return { status: 202, alias };
    if (host.authorizing.has(key)) throw actionError("oauth-busy", 409, `MCP server '${alias}' is already starting authorization.`, { retryable: true });
    host.authorizing.add(key);
    try {
        const connected = await host.prepareAttachment(identity.workspaceId, current, undefined, redirectUrl);
        if (connected.kind === "unavailable") throw new Error("OAuth preparation returned an unavailable attachment.");
        // {§oauth-continuation} An alias awaiting a sign-in for a refused request starts one on a connection its
        // server never challenges; one whose connection was challenged and is no longer is accepted as it is.
        const prepared = connected.kind === "active" && host.challenged.has(key) ? await beginUnchallenged(host, connected) : connected;
        if (host.attachments.get(identity.workspaceId)?.get(alias) !== current) {
            await host.closeOwned([prepared.connection]);
            throw actionError("oauth-target-conflict", 409, `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                { workspaceId: identity.workspaceId, alias, recovery: "Start authorization again from the server's current definition.", retryable: false });
        }
        const previous = host.pending.get(key);
        const pending: PendingAuthorization = {
            ...prepared,
            releaseWorkspace: host.retain(identity.workspaceId),
            ...(prepared.kind === "active" ? { prepared, authorized: true } : {}),
        };
        host.pending.set(key, pending);
        if (previous !== undefined) {
            previous.releaseWorkspace();
            if (previous.connection !== attachmentConnection(current)) await host.closeOwned([previous.connection]);
        }
        if (prepared.kind === "authorization-required") {
            if (prepared.authorizationUrl === undefined) throw new Error("OAuth preparation with a callback omitted its authorization URL.");
            return { status: 202, alias, authorization: { url: prepared.authorizationUrl } };
        }
        host.dirty.set(key, Symbol());
        host.refreshCatalog(identity.workspaceId, alias);
        return { status: 202, alias };
    } finally { host.authorizing.delete(key); }
};

// {§oauth-continuation} — grant acceptance precedes ordinary catalog publication.
export const completeOAuth = async (
    host: ContinuationHost,
    identity: WorkspaceCapabilityIdentity,
    params: Readonly<Record<string, unknown>>,
): Promise<McpOAuthCompletionResult> => {
    assertActionKeys(params, ["alias", "callbackUrl"]);
    const alias = requiredString(params, "alias");
    const callbackUrl = requiredString(params, "callbackUrl");
    const key = host.pendingKey(identity.workspaceId, alias);
    const pending = host.pending.get(key);
    if (pending === undefined) {
        // {§oauth-continuation} — restart during pending authorization surfaces
        // as a factual not-pending state, never a secret replay.
        throw actionError(
            "oauth-not-pending",
            404,
            `MCP server '${alias}' has no pending OAuth authorization.`,
            { workspaceId: identity.workspaceId, alias, retryable: false },
        );
    }
    const current = host.attachments.get(identity.workspaceId)?.get(alias);
    if (current === undefined || !sameBinding(current, pending)) {
        throw actionError(
            "oauth-target-conflict",
            409,
            `MCP server '${alias}' changed while its OAuth authorization was pending.`,
            { workspaceId: identity.workspaceId, alias, recovery: "Start authorization again from the server's current definition.", retryable: false },
        );
    }
    if (pending.completion !== undefined) {
        if (pending.completion.callbackUrl !== callbackUrl) throw actionError(
            "oauth-callback-invalid", 400,
            `OAuth authorization for MCP server '${alias}' could not be completed.`,
            { workspaceId: identity.workspaceId, alias, retryable: false },
        );
        return pending.completion.result;
    }
    const result = (async (): Promise<McpOAuthCompletionResult> => {
        try {
            await pending.connection.finishAuthorization(callbackUrl);
        } catch (cause) {
            delete pending.completion;
            const blocked = causeOf(cause, GuardBlockedError);
            if (blocked !== undefined) {
                throw actionError(
                    "mcp-url-forbidden",
                    403,
                    `MCP server '${alias}' targets a non-public URL forbidden by operator policy.`,
                    {
                        workspaceId: identity.workspaceId,
                        server: alias,
                        url: blocked.url,
                        recovery: "Use a public http(s):// URL.",
                        retryable: false,
                    },
                    cause,
                );
            }
            const scrubbedDiagnostic = scrubOAuthDiagnostic(
                pending.connection.preparationDiagnostic(cause).diagnostic,
                callbackUrl,
            );
            throw actionError(
                "oauth-callback-invalid",
                400,
                `OAuth authorization for MCP server '${alias}' could not be completed.`,
                {
                    workspaceId: identity.workspaceId,
                    alias,
                    ...(scrubbedDiagnostic === undefined ? {} : { diagnostic: scrubbedDiagnostic }),
                    retryable: false,
                },
                cause,
            );
        }
        if (host.pending.get(key) !== pending || host.isClosed()) throw actionError(
            "oauth-target-conflict", 409,
            `MCP server '${alias}' changed while its OAuth authorization was pending.`,
            { workspaceId: identity.workspaceId, alias, retryable: false },
        );
        pending.authorized = true;
        // {§oauth-continuation} The accepted sign-in is the alias's grant, replacing any before it.
        const grant = pending.connection.oauthGrant;
        if (grant !== undefined) {
            await host.recordGrant(identity.workspaceId, {
                alias: pending.alias,
                ...(pending.origin === undefined ? {} : { origin: pending.origin }),
                definition: pending.definition,
                grant,
            });
        }
        host.dirty.set(key, Symbol());
        host.refreshCatalog(identity.workspaceId, alias);
        return { status: 202, alias };
    })();
    pending.completion = { callbackUrl, result };
    return result;
};

// {§oauth-continuation} Daemon-wide OAuth sign-in for service-scoped MCP servers.
export const beginServiceOAuth = async (
    host: ServiceContinuationHost,
    params: Readonly<Record<string, unknown>>,
): Promise<McpOAuthBeginResult> => {
    assertActionKeys(params, ["alias", "redirectUrl"]);
    const alias = requiredString(params, "alias");
    const redirectUrl = requiredString(params, "redirectUrl");
    assertOAuthRedirectUrl(redirectUrl);
    const entry = await host.readServiceDefinition(alias);
    if (entry === null) {
        throw actionError("server-not-found", 404, `MCP server '${alias}' is not enabled in service scope.`, {
            alias,
            retryable: false,
        });
    }
    assertInteractiveOAuthDefinition(alias, entry.definition, redirectUrl);
    const key = `service:${alias}`;
    if (host.authorizing.has(key)) {
        throw actionError("oauth-busy", 409, `MCP server '${alias}' is already starting authorization.`, { retryable: true });
    }
    host.authorizing.add(key);
    try {
        const connection = await host.createServiceOAuthConnection(alias, entry.origin, entry.definition, redirectUrl);
        let authorizationUrl: string | undefined;
        try {
            await connection.connect();
            authorizationUrl = await connection.beginAuthorization();
        } catch (cause) {
            if (cause instanceof AuthorizationRequiredError && cause.authorizationUrl !== undefined) {
                authorizationUrl = cause.authorizationUrl;
            } else {
                let closeCause: unknown;
                try {
                    await host.closeOwned([connection]);
                } catch (error) {
                    closeCause = error;
                }
                if (cause instanceof ModuleActionError && closeCause === undefined) throw cause;
                throw preparationError(
                    alias,
                    entry.definition,
                    entry.definition.type === "streamable-http" ? entry.definition.authorization : undefined,
                    cause,
                    closeCause,
                    { ...connection.preparationDiagnostic(cause) },
                );
            }
        }
        if (authorizationUrl === undefined) {
            await host.closeOwned([connection]);
            return { status: 200, alias };
        }
        const latest = await host.readServiceDefinition(alias);
        if (latest === null || !isDeepStrictEqual(latest.definition, entry.definition) || host.isClosed()) {
            await host.closeOwned([connection]);
            throw actionError(
                "oauth-target-conflict",
                409,
                `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                { alias, recovery: "Start authorization again from the server's current definition.", retryable: false },
            );
        }
        const previous = host.servicePending.get(alias);
        host.servicePending.set(alias, {
            alias,
            origin: entry.origin,
            definition: entry.definition,
            connection,
        });
        if (previous !== undefined) {
            await host.closeOwned([previous.connection]);
        }
        return { status: 202, alias, authorization: { url: authorizationUrl } };
    } finally {
        host.authorizing.delete(key);
    }
};

// {§oauth-continuation} Persist a daemon-wide OAuth grant and wake active workspaces inheriting the server.
export const completeServiceOAuth = async (
    host: ServiceContinuationHost,
    params: Readonly<Record<string, unknown>>,
): Promise<McpOAuthCompletionResult> => {
    assertActionKeys(params, ["alias", "callbackUrl"]);
    const alias = requiredString(params, "alias");
    const callbackUrl = requiredString(params, "callbackUrl");
    const pending = host.servicePending.get(alias);
    if (pending === undefined) {
        throw actionError(
            "oauth-not-pending",
            404,
            `MCP server '${alias}' has no pending OAuth authorization.`,
            { alias, retryable: false },
        );
    }
    const current = await host.readServiceDefinition(alias);
    if (current === null || !isDeepStrictEqual(current.definition, pending.definition)) {
        throw actionError(
            "oauth-target-conflict",
            409,
            `MCP server '${alias}' changed while its OAuth authorization was pending.`,
            { alias, recovery: "Start authorization again from the server's current definition.", retryable: false },
        );
    }
    if (pending.completion !== undefined) {
        if (pending.completion.callbackUrl !== callbackUrl) {
            throw actionError(
                "oauth-callback-invalid",
                400,
                `OAuth authorization for MCP server '${alias}' could not be completed.`,
                { alias, retryable: false },
            );
        }
        return pending.completion.result;
    }
    const result = (async (): Promise<McpOAuthCompletionResult> => {
        try {
            await pending.connection.finishAuthorization(callbackUrl);
        } catch (cause) {
            delete pending.completion;
            const blocked = causeOf(cause, GuardBlockedError);
            if (blocked !== undefined) {
                throw actionError(
                    "mcp-url-forbidden",
                    403,
                    `MCP server '${alias}' targets a non-public URL forbidden by operator policy.`,
                    {
                        server: alias,
                        url: blocked.url,
                        recovery: "Use a public http(s):// URL.",
                        retryable: false,
                    },
                    cause,
                );
            }
            const scrubbedDiagnostic = scrubOAuthDiagnostic(
                pending.connection.preparationDiagnostic(cause).diagnostic,
                callbackUrl,
            );
            throw actionError(
                "oauth-callback-invalid",
                400,
                `OAuth authorization for MCP server '${alias}' could not be completed.`,
                {
                    alias,
                    ...(scrubbedDiagnostic === undefined ? {} : { diagnostic: scrubbedDiagnostic }),
                    retryable: false,
                },
                cause,
            );
        }
        if (host.servicePending.get(alias) !== pending || host.isClosed()) {
            throw actionError(
                "oauth-target-conflict",
                409,
                `MCP server '${alias}' changed while its OAuth authorization was pending.`,
                { alias, retryable: false },
            );
        }
        const grant = pending.connection.oauthGrant;
        host.servicePending.delete(alias);
        if (grant !== undefined) {
            await host.recordServiceGrant({
                alias: pending.alias,
                ...(pending.origin === undefined ? {} : { origin: pending.origin }),
                definition: pending.definition,
                grant,
            });
        }
        await host.closeOwned([pending.connection]);
        await host.refreshServiceWorkspaces(alias);
        return { status: 202, alias };
    })();
    pending.completion = { callbackUrl, result };
    return result;
};

export const completePromptOrResource = async (
    host: ContinuationHost,
    workspaceId: number,
    params: Readonly<Record<string, unknown>>,
): Promise<unknown> => {
    assertActionKeys(params, ["server", "ref", "argument", "context"]);
    const server = requiredString(params, "server");
    const attachment = host.attachments.get(workspaceId)?.get(server);
    if (attachment === undefined || attachment.kind !== "active") {
        throw actionError(
            "server-not-connected",
            409,
            `MCP server '${server}' is not connected for this workspace.`,
            { workspaceId, name: server, retryable: false },
        );
    }
    // The protocol's own schema proves the completion's parameters; a context that is not an object is not sent.
    const completion = CompleteRequestParamsSchema.safeParse({
        ref: params.ref,
        argument: params.argument,
        ...(objectOf(params.context) === null ? {} : { context: params.context }),
    });
    if (!completion.success) {
        const issues = completion.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
        throw actionError("completion-parameters-invalid", 400, `MCP completion parameters do not match the protocol: ${issues}.`, { retryable: false });
    }
    try {
        return await attachment.connection.complete(completion.data);
    } catch (cause) {
        if (cause instanceof AuthorizationRequiredError) {
            // {§mcp-host-composition}
            throw actionError("authorization-required", 401, awaitsSignIn(server), { workspaceId, name: server, retryable: false }, cause);
        }
        throw cause;
    }
};
