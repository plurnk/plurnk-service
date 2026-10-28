import { CompleteRequestParamsSchema } from "@modelcontextprotocol/core";
import type {
    McpOAuthBeginResult,
    McpOAuthCompletionResult,
    WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type ServerConnection from "./client.ts";
import { AuthorizationRequiredError, awaitsSignIn } from "./client.ts";
import type { OAuthGrant } from "./oauth.ts";
import {
    actionError,
    assertActionKeys,
    attachmentConnection,
    objectOf,
    preparationError,
    requiredString,
    sameBinding,
    type ActiveAttachment,
    type Attachment,
    type ConnectedAttachment,
    type McpBinding,
    type PendingAuthorization,
} from "./attachment.ts";

export interface ContinuationHost {
    isClosed(): boolean;
    readonly attachments: Map<number, ReadonlyMap<string, Attachment>>;
    readonly pending: Map<string, PendingAuthorization>;
    readonly authorizing: Set<string>;
    readonly challenged: Set<string>;
    readonly dirty: Map<string, symbol>;
    readonly grants: Map<string, McpBinding & { readonly grant: OAuthGrant }>;
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
        const { definition } = connected;
        throw preparationError(definition, definition.type === "streamable-http" ? definition.authorization : undefined, cause, closeCause);
    }
    if (authorizationUrl === undefined) return connected;
    return {
        definition: connected.definition,
        ...(connected.context === undefined ? {} : { context: connected.context }),
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
    const redirect = URL.parse(redirectUrl);
    if (redirect === null || redirect.username || redirect.password || redirect.hash || redirect.port === "0"
        || !(redirect.protocol === "https:" || (redirect.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(redirect.hostname)))) {
        throw actionError("oauth-redirect-invalid", 400, "The OAuth callback must use HTTPS or HTTP loopback with a usable port.", { retryable: false });
    }
    const current = host.attachments.get(identity.workspaceId)?.get(alias);
    if (current === undefined) throw actionError("server-not-connected", 409, `MCP server '${alias}' is not connected for this workspace.`, { retryable: false });
    if (current.kind === "active") return { status: 200, alias };
    const definition = current.definition;
    if (definition.type !== "streamable-http"
        || (definition.authorization !== undefined && definition.authorization.type !== "oauth")
        || Object.keys(definition.headers ?? {}).some((name) => name.toLowerCase() === "authorization")
        || (definition.authorization?.redirectUrl !== undefined && definition.authorization.redirectUrl !== redirectUrl)) {
        throw actionError("oauth-configuration-conflict", 409,
            `MCP server '${alias}' is not configured for this interactive OAuth callback.`, { retryable: false });
    }
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
            throw actionError(
                "oauth-callback-invalid",
                400,
                `OAuth authorization for MCP server '${alias}' could not be completed.`,
                { workspaceId: identity.workspaceId, alias, retryable: false },
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
            host.grants.set(key, { definition: pending.definition, ...(pending.context === undefined ? {} : { context: pending.context }), grant });
        }
        host.dirty.set(key, Symbol());
        host.refreshCatalog(identity.workspaceId, alias);
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
