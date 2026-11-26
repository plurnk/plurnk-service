import { isDeepStrictEqual } from "node:util";
import {
    Problems,
    Validator,
    isRecord,
    type FunctionalityPreparedDefinition,
    type McpOAuthCompletionResult,
    type McpServerDefinition,
    type ProblemDetails,
    type WorkspaceCapabilityIdentity,
} from "@plurnk/plurnk-contracts";
import type { RuntimeRegistration } from "@plurnk/plurnk-execs";
import type { ModuleActionContext } from "@plurnk/plurnk-modules";
import type ServerConnection from "./client.ts";
import type McpExecutor from "./McpExecutor.ts";
import { instructionsLead, summaryLine } from "./Summary.ts";

export const OWNER = "@plurnk/plurnk-mcp";
export const FAMILY = "mcp";

export interface McpBinding extends FunctionalityPreparedDefinition {
    readonly alias: string;
    readonly definition: McpServerDefinition;
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
    (left.origin ?? undefined) === (right.origin ?? undefined)
    && isDeepStrictEqual(left.definition, right.definition);

export const bindingOf = (alias: string, value: FunctionalityPreparedDefinition): McpBinding => ({
    alias,
    ...(value.origin === undefined ? {} : { origin: value.origin }),
    definition: Validator.assertMcpServerDefinition(value.definition),
});

export const statusOf = (error: unknown): number | null => {
    if (typeof error !== "object" || error === null) return null;
    const problem = (error as { problem?: { status?: unknown } }).problem
        ?? (error as { result?: { problem?: { status?: unknown } } }).result?.problem;
    return typeof problem?.status === "number" ? problem.status : null;
};

// An active alias's detail: its server's catalog, and the summary of a grant its connection presents ({§oauth-continuation}).
export const activeDetail = ({ alias, executor: { catalog }, connection }: ActiveAttachment): object => {
    const grant = connection.oauthGrant?.summary;
    const skills = catalog.skills ?? [];
    const server = catalog.server === undefined
        ? null
        : (() => {
            const { icons: _icons, ...rest } = catalog.server;
            return rest;
        })();
    const description = summaryLine(catalog.server?.description)
        ?? instructionsLead(catalog.instructions)
        ?? summaryLine(catalog.server?.title);
    return {
        ...(description === undefined || description.length === 0 ? {} : { description }),
        docs: `mcp:///${alias}.md`,
        ...(catalog.instructions !== undefined && catalog.instructions.trim().length > 0
            ? { instructions: catalog.instructions.trim() }
            : {}),
        protocolVersion: catalog.protocolVersion,
        server,
        capabilities: catalog.capabilities,
        tools: catalog.tools.map(({ name }) => name).toSorted(),
        resources: catalog.resources.length,
        resourceTemplates: catalog.resourceTemplates.length,
        prompts: catalog.prompts.length,
        ...(skills.length > 0
            ? {
                  skills: skills.map((s) => s.frontmatter.name).toSorted(),
              }
            : {}),
        ...(catalog.prompts.length > 0
            ? {
                  promptDefinitions: catalog.prompts.map((p) => ({
                      name: p.name,
                      ...(p.description !== undefined ? { description: p.description } : {}),
                      ...(p.arguments !== undefined ? { arguments: p.arguments } : {}),
                  })),
              }
            : {}),
        ...(grant === undefined ? {} : { grant }),
    };
};
