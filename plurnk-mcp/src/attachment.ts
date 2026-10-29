import { isDeepStrictEqual } from "node:util";
import { SdkHttpError, UnauthorizedError } from "@modelcontextprotocol/client";
import type { PluginContext } from "./PluginConfiguration.ts";
import {
    Problems,
    Validator,
    isRecord,
    type FunctionalityPreparedDefinition,
    type McpAuthorization,
    type McpOAuthCompletionResult,
    type McpServerDefinition,
    type ProblemDetails,
    type WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { ModuleActionContext } from "@plurnk/plurnk-modules";
import type ServerConnection from "./client.ts";
import {
    causeOf,
    isClientCredentialsRejection,
    McpRedirectError,
} from "./client.ts";
import type McpExecutor from "./McpExecutor.ts";
import { UnavailableServerExecutor, runtimeDecl, runtimeServerSummary } from "./McpExecutor.ts";
import { OAuthSetupError } from "./oauth.ts";

export const OWNER = "@plurnk/plurnk-mcp";
export const FAMILY = "mcp";

export interface McpBinding extends FunctionalityPreparedDefinition {
    readonly definition: McpServerDefinition;
    readonly context?: PluginContext;
}

export interface ActiveAttachment extends McpBinding {
    readonly kind: "active";
    readonly connection: ServerConnection;
    readonly executor: McpExecutor;
    readonly runtime: RuntimeRegistration;
    readonly resident?: boolean;
}

export interface AuthorizationAttachment extends McpBinding {
    readonly kind: "authorization-required";
    readonly connection: ServerConnection;
    readonly authorizationUrl: string | undefined;
}

export interface UnavailableAttachment extends McpBinding {
    readonly kind: "unavailable";
    readonly problem: ProblemDetails;
}

export type ConnectedAttachment = ActiveAttachment | AuthorizationAttachment;
export type Attachment = ConnectedAttachment | UnavailableAttachment;
// The committed attachments a preparation hands the coordinator, by server name.
export type Snapshot = ReadonlyMap<string, Attachment>;

export const attachmentConnection = (attachment: Attachment): ServerConnection | undefined =>
    attachment.kind === "unavailable" ? undefined : attachment.connection;

// {§mcp-configuration} An enabled server that cannot run still answers to its alias: a call to it is refused with
// the state that keeps it from running, never as a name nothing registered.
export const unavailableRuntime = (attachment: AuthorizationAttachment | UnavailableAttachment): RuntimeRegistration => {
    const { name } = attachment.definition;
    const detail = attachment.kind === "authorization-required"
        ? "it awaits the operator's sign-in"
        : typeof attachment.problem.diagnostic === "string" ? attachment.problem.diagnostic : attachment.problem.detail;
    return {
        namespaceOwner: OWNER,
        decl: runtimeDecl(name, runtimeServerSummary(name, undefined), false),
        executor: new UnavailableServerExecutor(name, detail),
        availability: { available: false, detail },
    };
};

// {§oauth-continuation} — a pending authorization is process memory per
// (workspace, alias): the challenged connection, its URL, the workspace residency it
// holds, and the accepted grant awaiting capability publication.
export interface PendingAuthorization extends McpBinding {
    readonly connection: ServerConnection;
    readonly releaseWorkspace: () => void;
    prepared?: ActiveAttachment;
    authorized?: boolean;
    completion?: { readonly callbackUrl: string; readonly result: Promise<McpOAuthCompletionResult> };
}

export class ModuleActionError extends Error {
    readonly problem: ProblemDetails;

    constructor(problem: ProblemDetails, cause?: unknown) {
        super(problem.detail, { cause });
        this.name = "ModuleActionError";
        this.problem = problem;
    }
}

export const actionError = (
    code: string,
    status: number,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
    cause?: unknown,
): ModuleActionError => new ModuleActionError(
    Problems.create("mcp:management", code, status, detail, {
        stage: "mcp-management",
        ...extensions,
    }),
    cause,
);

export const errorsOf = (error: unknown): unknown[] =>
    error instanceof AggregateError ? [...error.errors] : [error];

export const preparationError = (
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
            `MCP server '${definition.name}' preparation and cleanup failed.`,
        );
    const setup = causeOf(cause, OAuthSetupError);
    if (setup !== undefined) return actionError(setup.code, 502, setup.message,
        { server: definition.name, ...(setup.recovery === undefined ? {} : { recovery: setup.recovery }), retryable: false }, completeCause);
    // {§oauth-client-credentials} — a rejected grant is an authorization fact,
    // never a generic unavailability.
    if (authorization?.type === "client-credentials" && isClientCredentialsRejection(cause)) {
        return actionError(
            "oauth-client-credentials-failed",
            502,
            `MCP server '${definition.name}' rejected the client-credentials grant.`,
            {
                server: definition.name,
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
            { server: definition.name, url: redirect.url, ...(redirect.location === null ? {} : { location: redirect.location }), retryable: false },
            completeCause,
        );
    }
    const http = causeOf(cause, SdkHttpError);
    if (http?.status === 401 || causeOf(cause, UnauthorizedError) !== undefined) {
        return actionError("server-authentication-failed", 502,
            `MCP server '${definition.name}' rejected authentication (HTTP 401).`,
            { server: definition.name, upstreamStatus: 401, retryable: false }, completeCause);
    }
    return actionError(
        "server-unavailable",
        502,
        `Configured MCP server '${definition.name}' is unavailable.`,
        {
            server: definition.name,
            type: definition.type,
            retryable: true,
            ...observation,
        },
        completeCause,
    );
};

export const objectOf = (value: unknown): Record<string, unknown> | null => isRecord(value) ? value : null;

export const assertActionKeys = (
    params: Readonly<Record<string, unknown>>,
    allowed: readonly string[],
): void => {
    const extras = Object.keys(params).filter((key) => !allowed.includes(key));
    if (extras.length > 0) {
        throw actionError(
            "parameters-invalid",
            400,
            `Unsupported parameter(s): ${extras.join(", ")}.`,
            { retryable: false },
        );
    }
};

export const requiredString = (
    params: Readonly<Record<string, unknown>>,
    key: string,
): string => {
    const value = params[key];
    if (typeof value !== "string" || value.length === 0) {
        throw actionError(
            "parameters-invalid",
            400,
            `'${key}' must be a non-empty string.`,
            { field: key, retryable: false },
        );
    }
    return value;
};

export const workspaceIdentityOf = (context: ModuleActionContext): WorkspaceCapabilityIdentity => {
    if (context.scope !== "workspace") throw new Error("MCP actions require a workspace-scoped context.");
    return { workspaceId: context.workspaceId };
};

export const sameBinding = (left: McpBinding, right: McpBinding): boolean =>
    isDeepStrictEqual([left.definition, left.context], [right.definition, right.context]);

// The coordinator hands this module its own admitted definitions back as the contract's objects: the
// definition is read through its schema, the plugin context through the two paths it names.
const isPluginContext = (value: object): value is PluginContext =>
    "root" in value && typeof value.root === "string" && "data" in value && typeof value.data === "string";
const pluginContextOf = (value: object): PluginContext => {
    if (!isPluginContext(value)) throw new TypeError("An MCP binding's plugin context names its root and data paths.");
    return value;
};
export const bindingOf = (value: FunctionalityPreparedDefinition): McpBinding => ({
    definition: Validator.assertMcpServerDefinition(value.definition),
    ...(value.context === undefined ? {} : { context: pluginContextOf(value.context) }),
});

export const statusOf = (error: unknown): number | null => {
    if (typeof error !== "object" || error === null) return null;
    const problem = (error as { problem?: { status?: unknown } }).problem
        ?? (error as { result?: { problem?: { status?: unknown } } }).result?.problem;
    return typeof problem?.status === "number" ? problem.status : null;
};

// An active alias's detail: its server's catalog, and the summary of a grant its connection presents ({§oauth-continuation}).
export const activeDetail = ({ executor: { catalog }, connection }: ActiveAttachment): object => {
    const grant = connection.oauthGrant?.summary;
    return {
        protocolVersion: catalog.protocolVersion,
        server: catalog.server ?? null,
        capabilities: catalog.capabilities,
        tools: catalog.tools.map(({ name }) => name).toSorted(),
        resources: catalog.resources.length,
        resourceTemplates: catalog.resourceTemplates.length,
        prompts: catalog.prompts.length,
        ...(grant === undefined ? {} : { grant }),
    };
};
