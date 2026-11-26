// {§mcp-configuration} — Lazy-loaded attachment helpers that inspect `@modelcontextprotocol/client`
// errors or construct unavailable runtime executors (#1578).
import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import type { McpAuthorization, McpServerDefinition } from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import { GuardBlockedError } from "@plurnk/plurnk-meta";
import {
    OWNER,
    actionError,
    type AuthorizationAttachment,
    type ModuleActionError,
    type UnavailableAttachment,
} from "./attachment.ts";
import {
    causeOf,
    isClientCredentialsRejection,
    McpRedirectError,
} from "./client.ts";
import { UnavailableServerExecutor, runtimeDecl, runtimeServerSummary } from "./McpExecutor.ts";
import { OAuthSetupError } from "./oauth.ts";

// {§mcp-configuration} An enabled server that cannot run still answers to its alias: a call to it is refused with
// the state that keeps it from running, never as a name nothing registered.
export const unavailableRuntime = (attachment: AuthorizationAttachment | UnavailableAttachment): RuntimeRegistration => {
    const name = attachment.alias;
    const detail = attachment.kind === "authorization-required"
        ? "it awaits the operator's sign-in"
        : typeof attachment.problem.diagnostic === "string" ? attachment.problem.diagnostic : attachment.problem.detail;
    return {
        namespaceOwner: OWNER,
        decl: runtimeDecl(name, runtimeServerSummary(name, undefined)),
        executor: new UnavailableServerExecutor(name, detail),
        availability: { available: false, detail },
    };
};

export const preparationError = (
    alias: string,
    definition: McpServerDefinition,
    authorization: McpAuthorization | undefined,
    cause: unknown,
    closeCause?: unknown,
    observation: Readonly<Record<string, unknown>> = {},
): ModuleActionError => {
    const completeCause = closeCause === undefined
        ? cause
        : new AggregateError(
            [cause, closeCause],
            `MCP server '${alias}' preparation and cleanup failed.`,
        );
    // {§mcp-configuration} — public-address SSRF block on a workspace HTTP endpoint or OAuth hop.
    const blocked = causeOf(cause, GuardBlockedError);
    if (blocked !== undefined) {
        return actionError(
            "mcp-url-forbidden",
            403,
            `MCP server '${alias}' targets a non-public URL forbidden by operator policy.`,
            { server: alias, url: blocked.url, recovery: "Use a public http(s):// URL.", retryable: false },
            completeCause,
        );
    }
    const setup = causeOf(cause, OAuthSetupError);
    if (setup !== undefined) return actionError(setup.code, 502, setup.message,
        { server: alias, ...(setup.recovery === undefined ? {} : { recovery: setup.recovery }), retryable: false }, completeCause);
    // {§oauth-client-credentials} — a rejected grant is an authorization fact,
    // never a generic unavailability.
    if (authorization?.type === "client-credentials" && isClientCredentialsRejection(cause)) {
        return actionError(
            "oauth-client-credentials-failed",
            502,
            `MCP server '${alias}' rejected the client-credentials grant.`,
            {
                server: alias,
                type: definition.type,
                clientId: authorization.clientId,
                ...(authorization.issuer === undefined
                    ? {}
                    : { issuer: authorization.issuer }),
                retryable: false,
            },
            completeCause,
        );
    }
    // {§mcp-transports} — the operator corrects the endpoint; retrying cannot.
    const redirect = causeOf(cause, McpRedirectError);
    if (redirect !== undefined) {
        return actionError(
            "server-redirected",
            502,
            redirect.message,
            { server: alias, url: redirect.url, ...(redirect.location === null ? {} : { location: redirect.location }), retryable: false },
            completeCause,
        );
    }
    const http = causeOf(cause, SdkHttpError);
    if (http?.status === 401 || causeOf(cause, UnauthorizedError) !== undefined) {
        return actionError("server-authentication-failed", 502,
            `MCP server '${alias}' rejected authentication (HTTP 401).`,
            { server: alias, upstreamStatus: 401, retryable: false }, completeCause);
    }
    return actionError(
        "server-unavailable",
        502,
        `Configured MCP server '${alias}' is unavailable.`,
        {
            server: alias,
            type: definition.type,
            retryable: true,
            ...observation,
        },
        completeCause,
    );
};
