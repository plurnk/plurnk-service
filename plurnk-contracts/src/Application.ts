import { isRecord } from "./guards.ts";
import {
    formatDiscoverPageFooter,
    formatListPageFooter,
    parseFamilyDiscoverArgs,
    parseFamilyListArgs,
} from "./CollectionCommand.ts";
import {
    formatScheduleRows,
    formatScheduleRunResult,
    formatScheduleStatusResult,
    parseScheduleFamilyArgs,
} from "./ScheduleCommand.ts";
import type { DaemonNotification, DaemonNotificationEvent } from "./ApplicationNotifications.ts";
import type { FunctionalityScope } from "./Functionality.ts";
import type { LoopLifecycle } from "./LoopLifecycle.ts";
import type { LogAddressColumns } from "./LogRow.ts";
import type { Effort, JsonSchema, ModelRoute, OperationResult } from "./types.ts";
import type { RequestHeaders } from "./HttpOrigin.ts";

export type ProposalDecision = "accept" | "reject" | "cancel";
export type ProposalScope = "once" | "always";

/** {§operator-config-workspace-settings} Operator project-root confinement posture. */
export const PROJECT_ROOT_CONFINEMENTS = ["unrestricted", "confined", "none"] as const;
export type ProjectRootConfinement = typeof PROJECT_ROOT_CONFINEMENTS[number];

/** {§mcp-configuration} Admitted workspace MCP transports. */
export const MCP_WORKSPACE_TRANSPORTS = ["stdio", "streamable-http"] as const;
export type McpWorkspaceTransport = typeof MCP_WORKSPACE_TRANSPORTS[number];

/** {§mcp-configuration} Operator-enforced workspace MCP confinement posture. */
export interface ApplicationMcpPolicy {
    readonly workspaceTransports: readonly McpWorkspaceTransport[];
    readonly publicOnly: boolean;
}

/** {§skills-module} Admitted workspace skill source kinds. */
export const SKILL_WORKSPACE_SOURCES = ["mcp", "git", "local"] as const;
export type SkillWorkspaceSource = typeof SKILL_WORKSPACE_SOURCES[number];

/** {§skills-module} Operator-enforced workspace skill confinement posture. */
export interface ApplicationSkillsPolicy {
    readonly workspaceSources: readonly SkillWorkspaceSource[];
    readonly publicOnly: boolean;
}

/** {§operator-config-precedence} Operator-enforced client configuration policy advertised to clients. */
export interface ApplicationConfigPolicy {
    readonly allowlist: readonly string[];
    readonly writable: boolean;
}

/** {§operator-config-workspace-settings} Operator-enforced daemon policy advertised to clients. */
export interface ApplicationDaemonPolicy {
    readonly projectRoot: ProjectRootConfinement;
    readonly families?: readonly string[];
    readonly familyScopes?: Readonly<Record<string, readonly FunctionalityScope[]>>;
    readonly config?: ApplicationConfigPolicy;
    readonly mcp?: ApplicationMcpPolicy;
    readonly skills?: ApplicationSkillsPolicy;
}

export interface ApplicationOwnerIdentity {
    readonly workspaceId: number;
    readonly address: string;
}

export interface ProposalResolution {
    readonly decision: ProposalDecision;
    readonly scope?: ProposalScope;
    readonly body?: string;
    readonly outcome?: string;
}

export type ApplicationActionContext =
    | { readonly scope: "daemon" }
    | { readonly scope: "workspace"; readonly workspaceId: number }
    | { readonly scope: "session"; readonly workspaceId: number; readonly sessionId: number };

export interface ApplicationActionDescriptor {
    readonly name: string;
    readonly scope: ApplicationActionContext["scope"];
    readonly inputSchema: JsonSchema;
    readonly outputSchema: JsonSchema;
}

// The bound workspace. Binding one mints nothing: a client operation journals in the workspace's
// runtime session ({§connection-lifecycle}), and the session a thread binds is resolved separately by the
// client-interface module.
export interface ClientEnvelope {
    readonly workspaceId: number;
    readonly workspaceName: string;
    readonly projectRoot: string | null;
    /** {§execution-output-identity} The folder as the daemon spells it for display; null without a folder. */
    readonly projectLabel: string | null;
}

export type ApplicationSessionOrigin = "model" | "_plurnk";

// {§application-session-observation} — `kind` is how the session was minted (a root session, a FORK
// child with a forked log, a WORK child with a fresh log); `lifecycle` projects its representative loop
// through the shared {§application-session-observation}, so a directory row can carry the same glyph the
// bound session's own status gauge shows. Neither is inferred by a client.
export type ApplicationSessionKind = "root" | "fork" | "work";
export interface ApplicationSessionProjection {
    readonly id: number;
    readonly name: string;
    readonly createdAt: string;
    readonly origin: ApplicationSessionOrigin;
    readonly owner: string;
    readonly parentSessionId: number | null;
    readonly kind: ApplicationSessionKind;
    readonly lifecycle: LoopLifecycle;
    /** {§machine-processes} When the session was archived, or null while it is unarchived. */
    readonly archivedAt: string | null;
    /** {§machine-processes} Optional human-readable title set via `session/set_title`. */
    readonly title?: string | null;
    /** {§persona-discovery} Durable workspace persona bound to this session, or null when unset. */
    readonly persona?: string | null;
}

/** {§application-session-observation} A session's latest finished reply ({§message-completion}). */
export interface ApplicationSessionReply {
    /** The reply's durable log row. */
    readonly id: number;
    /** Its log coordinate `L/T/S` in its session's log. */
    readonly coordinate: string;
    /** The message completion its receipt records. */
    readonly completion: 200 | 499;
    /** When it was recorded, Unix milliseconds. */
    readonly at: number;
    /** {§application-session-observation} */
    readonly excerpt: string;
    readonly continued: boolean;
}

/** {§application-session-observation} One place of the overview and what waits there. */
export interface ApplicationOverviewSession {
    readonly workspaceId: number;
    readonly id: number;
    readonly name: string;
    readonly parentSessionId: number | null;
    readonly kind: ApplicationSessionKind;
    readonly lifecycle: LoopLifecycle;
    /** The proposals and client interactions it waits on. */
    readonly gates: number;
    readonly reply: ApplicationSessionReply | null;
    readonly title?: string | null;
    readonly persona?: string | null;
}

/** {§application-session-observation} A workspace the overview's places belong to. */
export interface ApplicationOverviewWorkspace {
    readonly id: number;
    readonly name: string;
    readonly projectRoot: string | null;
    /** {§execution-output-identity} */
    readonly projectLabel: string | null;
}

/** {§application-session-observation} The places in a scope, most recently finished first, and the workspaces they belong to. */
export interface ApplicationSessionOverview {
    readonly sessions: readonly ApplicationOverviewSession[];
    readonly workspaces: readonly ApplicationOverviewWorkspace[];
    /** The places in scope the overview leaves out. */
    readonly omitted: number;
}

/** {§machine-processes} A workspace's mark after an archive or unarchive. */
export interface ApplicationWorkspaceArchiving {
    readonly id: number;
    /** When the workspace was archived, or null while it is unarchived. */
    readonly archivedAt: string | null;
}

/** {§machine-processes} A session's mark after an archive or unarchive. */
export interface ApplicationSessionArchiving {
    readonly id: number;
    /** When the session was archived, or null while it is unarchived. */
    readonly archivedAt: string | null;
    /** The sessions whose mark the call changed, in id order: the group it archived or unarchived, none when nothing changed. */
    readonly sessionIds: readonly number[];
}

/** {§machine-processes} A session subtree removed by `deleteSession`. */
export interface ApplicationSessionDeletion {
    readonly id: number;
    /** Every session id deleted in the subtree, in id order. */
    readonly sessionIds: readonly number[];
}

/** {§machine-processes} A session's normalized title stored by `setSessionTitle`. */
export interface ApplicationSessionTitling {
    readonly id: number;
    readonly title: string;
}

export interface ApplicationSessionQuery {
    readonly origin?: ApplicationSessionOrigin;
    /** Omitted means every lineage position; null means roots only. */
    readonly parentSessionId?: number | null;
    /** {§machine-processes} Omitted lists every session; true only archived ones, false only unarchived ones. */
    readonly archived?: boolean;
}

export type ApplicationSessionIdentity =
    | { readonly id: number; readonly name?: never }
    | { readonly id?: never; readonly name: string };

export type ApplicationSessionCreation = {
    readonly workspaceId: number;
    readonly name?: string;
    readonly persona?: string | null;
} & (
    | { readonly parentSessionId: number; readonly owner?: never }
    | { readonly parentSessionId?: never; readonly owner?: string }
);

export interface ApplicationLoopProjection {
    readonly id: number;
    readonly sessionId: number;
    readonly sequence: number;
    readonly status: number;
    readonly prompt: string;
    readonly promptSource: string | null;
    /** When the loop first ran ({§session-wait-timing}), ISO 8601 UTC; null until it has. */
    readonly claimedAt: string | null;
    /** When the loop concluded, ISO 8601 UTC; null while it is unfinished. */
    readonly terminatedAt: string | null;
    readonly terminalResult: OperationResult | null;
    /** Exact count of durable packet-bearing turns; retries and administrative turns do not contribute. */
    readonly packetCount: number;
    /** Durable observation deadline, Unix milliseconds; null outside bounded parks. */
    readonly waitUntil: number | null;
    /**
     * {§loop-completion} The operation that opened the loop, by sending its first message: its session and its log
     * address in that session's log. Null when no session's operation did, or none was recorded.
     */
    readonly invocation: { readonly sessionId: number; readonly address: string } | null;
}

export interface ApplicationLoopPacket {
    readonly sessionId: number;
    readonly loopId: number;
    /** The loop's number among its session's loops, the L of its log coordinates. */
    readonly loopSeq: number;
    readonly packetCount: number;
    /** The loop's client gauge once this packet's turn has its call. */
    readonly gauge: ApplicationGauge;
}

/** {§tokenomics} The client gauge: a packet's curation pair and the physical pair of its emission call. */
export interface ApplicationGauge {
    readonly curationWeight: number | null;
    readonly curationBudget: number | null;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
}

// Every log entry carries its logical coordinate — loopSeq/turnSeq/sequence — so the
// client renders ordering without re-deriving it from DB keys. {§methods-invocation}
// A type alias, not an interface: a serialized wire bag must satisfy index-signature
// consumers (Record<string, unknown>), which TypeScript grants aliases but not interfaces.
export type LogEntryWire = LogAddressColumns & {
    id: number;
    sessionId: number;
    // {§methods-invocation} The session whose log holds the row, by its immutable name.
    sessionName: string;
    loopId: number;
    loopSeq: number;
    turnId: number;
    turnSeq: number;
    sequence: number;
    at: string;
    origin: string;
    source: string | null;
    op: string | null;
    signal: unknown;
    lineMarker: unknown;
    tx: unknown;
    mimetypeTx: string;
    rx: unknown;
    mimetypeRx: string;
    statusRx: number;
    weight: number;
    attrs: unknown;
    // {§proposal} The row's lifecycle: `proposed` while its operation awaits its decision.
    state: "proposed" | "resolved" | "failed" | "cancelled";
    reasoning?: string;
    // {§methods-invocation} The request that streamed `reasoning`; absent for history a FORK inherited.
    reasoningModelCallId?: number;
    reasoningRequestSequence?: number;
    // {§methods-invocation} On a row that discharges an obligation, the log address of the operation that opened it.
    invocation?: string;
    // {§methods-invocation} On a reply to a message this session's operation sent, the log address of that operation.
    answering?: string;
    // {§message-completion} On a reply (`send`, `done`, `fail`) or bodied `wait`, the originating source/address URIs.
    repliedToSources?: readonly string[];
};
/** {§methods} A prompt's admission: its acknowledgement, the loop it landed on and how it landed. */
export type ApplicationLoopAdmission = OperationResult & {
    readonly action: "injected_next_turn" | "enqueued_new_loop";
    readonly loopId: number;
    readonly turnSeq?: number;
};

/** {§acp-status-descendants} A declared alias as the route a session seeded from it gets, its configured effort included. */
export type ApplicationProviderAlias = ModelRoute & {
    readonly alias: string;
    readonly active: boolean;
    readonly inputCapacity: number | null;
};

/** {§startup-admission} Result of an explicit operator-triggered model catalog refresh. */
export interface ApplicationServiceUpdateResult {
    readonly catalog: {
        readonly status: "updated" | "unchanged";
        readonly providers: number;
        readonly models: number;
        readonly addedModels: number;
        readonly updatedAt: string;
        readonly path: string;
    };
    readonly service: {
        readonly package: string;
        readonly version: string;
        readonly artifact: "source" | "dist";
        readonly upgradeCommand: string;
    };
}

/** {§startup-admission} Formats an operator-triggered model catalog refresh result. */
export const formatServiceUpdateReport = (result: ApplicationServiceUpdateResult | Record<string, unknown>): string => {
    const cat = isRecord(result.catalog) ? result.catalog : {};
    const svc = isRecord(result.service) ? result.service : {};
    const addedModels = typeof cat.addedModels === "number" ? cat.addedModels : 0;
    const added = addedModels > 0 ? `, +${addedModels} new` : "";
    const status = typeof cat.status === "string" ? cat.status : "updated";
    const models = typeof cat.models === "number" ? cat.models : 0;
    const providers = typeof cat.providers === "number" ? cat.providers : 0;
    const catLine = `catalog: ${status} (${models} models across ${providers} providers${added})`;
    const suffix = svc.artifact === "source" ? " (source checkout)" : "";
    const pkg = typeof svc.package === "string" ? svc.package : "@plurnk/plurnk-service";
    const ver = typeof svc.version === "string" ? svc.version : "";
    const upgradeCmd = typeof svc.upgradeCommand === "string"
        ? svc.upgradeCommand
        : "npm install -g --ignore-scripts @plurnk/plurnk-service@latest @plurnk/plurnk@latest";
    const verLine = `version: ${pkg}@${ver}${suffix} — to update packages, stop the daemon and run: ${upgradeCmd}`;
    return `${catLine}\n${verLine}`;
};

export interface ParsedFamilyCommand {
    readonly scopePrefix: "service" | "workspace" | "session";
    readonly sub: string;
    readonly rest: readonly string[];
    readonly actionName: string;
    readonly params: Record<string, unknown>;
}

const SERVICE_SCOPED_FAMILIES: ReadonlySet<string> = new Set(["mcp", "skills", "personas", "env"]);

/** {§acp-action-binding} {§client-family-commands} Parses a family command (`mcp`, `skills`, `personas`, `members`, `env`, `schedule`) into its action kind and parameters. */
export const parseFamilyCommand = (family: string, args: readonly string[]): ParsedFamilyCommand => {
    let scopePrefix: "service" | "workspace" | "session" = family === "env" ? "session" : "workspace";
    const parseScope = (raw: string): "service" | "workspace" | "session" => {
        if (raw === "service" && SERVICE_SCOPED_FAMILIES.has(family)) return "service";
        if (raw === "workspace") return "workspace";
        return family === "env" ? "session" : "workspace";
    };
    const filteredArgs: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
        const tok = args[i] ?? "";
        if (tok === "--scope" && args[i + 1] !== undefined) {
            scopePrefix = parseScope(args[i + 1] ?? "");
            i += 1;
            continue;
        }
        if (tok.startsWith("--scope=")) {
            scopePrefix = parseScope(tok.slice("--scope=".length));
            continue;
        }
        if (tok.length > 0) {
            filteredArgs.push(tok);
        }
    }
    const headArg = filteredArgs[0];
    const isListOption = headArg !== undefined
        && /^--(query|state|origin|offset|limit)(?:=|$)/u.test(headArg);
    const rawSub = isListOption ? "list" : (headArg ?? "list");
    const rest = isListOption ? filteredArgs : filteredArgs.slice(1);
    if (family === "schedule") {
        return parseScheduleFamilyArgs(rawSub, rest);
    }
    const sub = family === "env" && rawSub === "set"
        ? "replace"
        : family === "env" && rawSub === "unset"
          ? "remove"
          : rawSub;
    const actionName = `${scopePrefix}.${family}.${sub}`;

    if (sub === "list") {
        return { scopePrefix, sub, rest, actionName, params: parseFamilyListArgs(rest) };
    }
    if (sub === "discover") {
        return { scopePrefix, sub, rest, actionName, params: parseFamilyDiscoverArgs(family, rest) };
    }
    if (sub === "enable" || sub === "disable" || sub === "remove") {
        const target = rest[0] ?? "";
        return {
            scopePrefix,
            sub,
            rest,
            actionName,
            params: family === "members" ? { file: target } : { alias: target },
        };
    }
    if ((sub === "add" || sub === "replace") && family === "mcp") {
        let urlFlag: string | undefined;
        let commandFlag: string | undefined;
        const argFlags: string[] = [];
        const envObj: Record<string, string> = {};
        const posArgs: string[] = [];
        for (let i = 0; i < rest.length; i += 1) {
            const tok = rest[i] ?? "";
            if (tok === "--url" && rest[i + 1] !== undefined) {
                urlFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--url=")) {
                urlFlag = tok.slice("--url=".length);
            } else if (tok === "--command" && rest[i + 1] !== undefined) {
                commandFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--command=")) {
                commandFlag = tok.slice("--command=".length);
            } else if (tok === "--arg" && rest[i + 1] !== undefined) {
                argFlags.push(rest[i + 1] ?? "");
                i += 1;
            } else if (tok.startsWith("--arg=")) {
                argFlags.push(tok.slice("--arg=".length));
            } else if (tok === "--env" && rest[i + 1] !== undefined) {
                const pair = rest[i + 1] ?? "";
                const eq = pair.indexOf("=");
                if (eq > 0) envObj[pair.slice(0, eq)] = pair.slice(eq + 1);
                i += 1;
            } else if (tok.startsWith("--env=")) {
                const pair = tok.slice("--env=".length);
                const eq = pair.indexOf("=");
                if (eq > 0) envObj[pair.slice(0, eq)] = pair.slice(eq + 1);
            } else {
                posArgs.push(tok);
            }
        }
        const alias = posArgs[0] ?? "";
        const target = urlFlag ?? commandFlag ?? posArgs[1] ?? "";
        const extraArgs = argFlags.length > 0 ? argFlags : posArgs.slice(2);
        const params = /^https?:\/\//iu.test(target)
            ? { alias, type: "streamable-http", url: target }
            : {
                  alias,
                  type: "stdio",
                  command: target,
                  ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
                  ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
              };
        return {
            scopePrefix,
            sub,
            rest,
            actionName: `${scopePrefix}.mcp.${sub}`,
            params,
        };
    }
    if (sub === "skills" && family === "mcp") {
        let serverFlag: string | undefined;
        let skillFlag: string | undefined;
        let includeFiles: boolean | undefined;
        let verify: boolean | undefined;
        const posArgs: string[] = [];
        for (let i = 0; i < rest.length; i += 1) {
            const tok = rest[i] ?? "";
            if ((tok === "--server" || tok === "--alias") && rest[i + 1] !== undefined) {
                serverFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--server=")) {
                serverFlag = tok.slice("--server=".length);
            } else if (tok.startsWith("--alias=")) {
                serverFlag = tok.slice("--alias=".length);
            } else if (tok === "--skill" && rest[i + 1] !== undefined) {
                skillFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--skill=")) {
                skillFlag = tok.slice("--skill=".length);
            } else if (tok === "--include-files") {
                includeFiles = true;
            } else if (tok === "--verify") {
                verify = true;
            } else {
                posArgs.push(tok);
            }
        }
        const server = serverFlag ?? posArgs[0] ?? "";
        const skill = skillFlag ?? (serverFlag !== undefined ? posArgs[0] : posArgs[1]);
        return {
            scopePrefix,
            sub,
            rest,
            actionName: "workspace.mcp.skills",
            params: {
                server,
                ...(skill !== undefined && skill.length > 0 ? { skill } : {}),
                ...(includeFiles === true ? { includeFiles: true } : {}),
                ...(verify === true ? { verify: true } : {}),
            },
        };
    }
    if (sub === "oauth" && family === "mcp") {
        const alias = rest[0] ?? "";
        const callbackUrl = rest[1];
        const oauthPrefix = scopePrefix === "service" ? "service" : "workspace";
        if (callbackUrl !== undefined && callbackUrl.length > 0) {
            return {
                scopePrefix,
                sub,
                rest,
                actionName: `${oauthPrefix}.mcp.oauth.complete`,
                params: { alias, callbackUrl },
            };
        }
        return {
            scopePrefix,
            sub,
            rest,
            actionName: `${oauthPrefix}.mcp.oauth.begin`,
            params: { alias, redirectUrl: "http://127.0.0.1/callback" },
        };
    }
    if (sub === "secrets" && family === "mcp") {
        const secretsPrefix = scopePrefix === "service" ? "service" : "workspace";
        const secHead = rest[0];
        const secVerb = secHead === "set" || secHead === "unset" || secHead === "list" ? secHead : "list";
        const secArgs = secHead === "set" || secHead === "unset" || secHead === "list" ? rest.slice(1) : rest;
        if (secVerb === "set") {
            const alias = secArgs[0] ?? "";
            const secrets: Record<string, string> = {};
            for (const pair of secArgs.slice(1)) {
                const eq = pair.indexOf("=");
                if (eq > 0) secrets[pair.slice(0, eq)] = pair.slice(eq + 1);
            }
            return {
                scopePrefix: secretsPrefix,
                sub: "secrets.set",
                rest,
                actionName: `${secretsPrefix}.mcp.secrets.set`,
                params: { alias, secrets },
            };
        }
        if (secVerb === "unset") {
            const alias = secArgs[0] ?? "";
            const keys = secArgs.slice(1).filter((k) => k.length > 0);
            return {
                scopePrefix: secretsPrefix,
                sub: "secrets.unset",
                rest,
                actionName: `${secretsPrefix}.mcp.secrets.unset`,
                params: keys.length > 0 ? { alias, keys } : { alias },
            };
        }
        const alias = secArgs[0];
        return {
            scopePrefix: secretsPrefix,
            sub: "secrets.list",
            rest,
            actionName: `${secretsPrefix}.mcp.secrets.list`,
            params: alias !== undefined && alias.length > 0 ? { alias } : {},
        };
    }
    if (sub === "complete" && family === "mcp") {
        let serverFlag: string | undefined;
        let promptFlag: string | undefined;
        let uriFlag: string | undefined;
        let nameFlag: string | undefined;
        let valueFlag: string | undefined;
        const posArgs: string[] = [];
        for (let i = 0; i < rest.length; i += 1) {
            const tok = rest[i] ?? "";
            if ((tok === "--server" || tok === "--alias") && rest[i + 1] !== undefined) {
                serverFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--server=")) {
                serverFlag = tok.slice("--server=".length);
            } else if (tok.startsWith("--alias=")) {
                serverFlag = tok.slice("--alias=".length);
            } else if (tok === "--prompt" && rest[i + 1] !== undefined) {
                promptFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--prompt=")) {
                promptFlag = tok.slice("--prompt=".length);
            } else if (tok === "--uri" && rest[i + 1] !== undefined) {
                uriFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--uri=")) {
                uriFlag = tok.slice("--uri=".length);
            } else if (tok === "--name" && rest[i + 1] !== undefined) {
                nameFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--name=")) {
                nameFlag = tok.slice("--name=".length);
            } else if (tok === "--value" && rest[i + 1] !== undefined) {
                valueFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--value=")) {
                valueFlag = tok.slice("--value=".length);
            } else {
                posArgs.push(tok);
            }
        }
        if (promptFlag !== undefined || uriFlag !== undefined || nameFlag !== undefined || valueFlag !== undefined || serverFlag !== undefined) {
            const server = serverFlag ?? posArgs[0] ?? "";
            const remPos = serverFlag !== undefined ? posArgs : posArgs.slice(1);
            const ref = promptFlag !== undefined
                ? { type: "ref/prompt", name: promptFlag }
                : { type: "ref/resource", uri: uriFlag ?? "" };
            const argument = {
                name: nameFlag ?? remPos[0] ?? "",
                value: valueFlag ?? remPos[1] ?? "",
            };
            return {
                scopePrefix,
                sub,
                rest,
                actionName: "workspace.mcp.complete",
                params: { server, ref, argument },
            };
        }
        let server = "";
        let ref: Record<string, string> = { type: "ref/prompt", name: "" };
        let argTokens: readonly string[] = [];
        const uriMatch = /^([a-z0-9_-]+):\/\/\/(prompts|resources)\/(.+)$/iu.exec(rest[0] ?? "");
        if (uriMatch) {
            server = uriMatch[1] ?? "";
            const kind = (uriMatch[2] ?? "").toLowerCase();
            const target = decodeURIComponent(uriMatch[3] ?? "");
            ref = kind === "resources"
                ? { type: "ref/resource", uri: target }
                : { type: "ref/prompt", name: target };
            argTokens = rest.slice(1);
        } else {
            server = rest[0] ?? "";
            const rawKind = (rest[1] ?? "prompt").toLowerCase();
            const target = rest[2] ?? "";
            ref = rawKind === "resource" || rawKind === "ref/resource"
                ? { type: "ref/resource", uri: target }
                : { type: "ref/prompt", name: target };
            argTokens = rest.slice(3);
        }
        const firstArg = argTokens[0] ?? "";
        const eqIdx = firstArg.indexOf("=");
        const argument = eqIdx >= 0
            ? { name: firstArg.slice(0, eqIdx), value: firstArg.slice(eqIdx + 1) }
            : { name: firstArg, value: argTokens[1] ?? "" };
        const contextArgs: Record<string, string> = {};
        for (const extra of argTokens.slice(eqIdx >= 0 ? 1 : 2)) {
            const cEq = extra.indexOf("=");
            if (cEq > 0) {
                contextArgs[extra.slice(0, cEq)] = extra.slice(cEq + 1);
            }
        }
        return {
            scopePrefix,
            sub,
            rest,
            actionName: "workspace.mcp.complete",
            params: {
                server,
                ref,
                argument,
                ...(Object.keys(contextArgs).length > 0 ? { context: { arguments: contextArgs } } : {}),
            },
        };
    }
    if ((sub === "add" || sub === "replace") && family === "skills") {
        let sourceFlag: string | undefined;
        let ref: string | undefined;
        const posArgs: string[] = [];
        for (let i = 0; i < rest.length; i += 1) {
            const tok = rest[i] ?? "";
            if (tok === "--source" && rest[i + 1] !== undefined) {
                sourceFlag = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--source=")) {
                sourceFlag = tok.slice("--source=".length);
            } else if (tok === "--ref" && rest[i + 1] !== undefined) {
                ref = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--ref=")) {
                ref = tok.slice("--ref=".length);
            } else {
                posArgs.push(tok);
            }
        }
        const alias = posArgs[0] ?? "";
        const source = sourceFlag ?? posArgs[1] ?? "";
        return {
            scopePrefix,
            sub,
            rest,
            actionName: `${scopePrefix}.skills.${sub}`,
            params: {
                alias,
                source,
                ...(ref !== undefined ? { ref } : {}),
            },
        };
    }
    if ((sub === "add" || sub === "replace") && family === "personas") {
        let source: string | undefined;
        let model: string | undefined;
        let effort: string | undefined;
        let description: string | undefined;
        let body: string | undefined;
        const posArgs: string[] = [];
        for (let i = 0; i < rest.length; i += 1) {
            const tok = rest[i] ?? "";
            if (tok === "--source" && rest[i + 1] !== undefined) {
                source = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--source=")) {
                source = tok.slice("--source=".length);
            } else if (tok === "--model" && rest[i + 1] !== undefined) {
                model = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--model=")) {
                model = tok.slice("--model=".length);
            } else if (tok === "--effort" && rest[i + 1] !== undefined) {
                effort = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--effort=")) {
                effort = tok.slice("--effort=".length);
            } else if (tok === "--description" && rest[i + 1] !== undefined) {
                description = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--description=")) {
                description = tok.slice("--description=".length);
            } else if (tok === "--body" && rest[i + 1] !== undefined) {
                body = rest[i + 1];
                i += 1;
            } else if (tok.startsWith("--body=")) {
                body = tok.slice("--body=".length);
            } else {
                posArgs.push(tok);
            }
        }
        const alias = posArgs[0] ?? "";
        const secondArg = posArgs[1];
        const looksLikePath = source === undefined
            && posArgs.length === 2
            && secondArg !== undefined
            && (secondArg.endsWith(".md") || secondArg.includes("/") || secondArg.includes("\\"));
        const resolvedSource = source ?? (looksLikePath ? secondArg : undefined);
        const resolvedDescription = description ?? (resolvedSource === undefined ? secondArg : undefined);
        const resolvedBody = body ?? (resolvedSource === undefined && posArgs.length > 2 ? posArgs.slice(2).join(" ") : undefined);
        return {
            scopePrefix,
            sub,
            rest,
            actionName: `${scopePrefix}.personas.${sub}`,
            params: {
                alias,
                ...(resolvedSource !== undefined ? { source: resolvedSource } : {}),
                ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {}),
                ...(resolvedBody !== undefined ? { body: resolvedBody } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(effort !== undefined ? { effort } : {}),
            },
        };
    }
    if (sub === "add" && family === "members") {
        return {
            scopePrefix,
            sub,
            rest,
            actionName: `${scopePrefix}.members.add`,
            params: { files: rest },
        };
    }
    if ((sub === "add" || sub === "replace") && family === "env") {
        const first = rest[0] ?? "";
        const eqIdx = rest.length === 1 ? first.indexOf("=") : -1;
        const alias = eqIdx > 0 ? first.slice(0, eqIdx) : first;
        const value = eqIdx > 0 ? first.slice(eqIdx + 1) : rest.slice(1).join(" ");
        return {
            scopePrefix,
            sub,
            rest,
            actionName: `${scopePrefix}.env.${sub}`,
            params: { alias, value },
        };
    }
    return {
        scopePrefix,
        sub,
        rest,
        actionName,
        params: rest.length > 0 ? { args: rest } : {},
    };
};

/** {§acp-action-binding} Formats definition rows for `list` and multi-definition `members` mutations across CLI, ACP, and Web. */
export const formatFamilyRows = (family: string, result: Readonly<Record<string, unknown>>): string => {
    if (family === "schedule") {
        return formatScheduleRows(result);
    }
    const definitions = Array.isArray(result.definitions) ? result.definitions : [];
    const footer = formatListPageFooter(result);
    if (definitions.length === 0) {
        return footer !== null ? `${family}: none\n${footer}\n` : `${family}: none\n`;
    }
    const lines: string[] = [];
    for (const item of definitions) {
        if (!isRecord(item)) {
            lines.push(String(item));
            continue;
        }
        const alias = typeof item.alias === "string" ? item.alias : "";
        const state = typeof item.state === "string" ? item.state : "active";
        const def = isRecord(item.definition) ? item.definition : {};
        const detail = isRecord(item.detail) ? item.detail : {};
        const type = typeof def.type === "string" ? def.type : "";
        const target =
            typeof def.command === "string"
                ? def.command
                : typeof def.url === "string"
                  ? def.url
                  : typeof def.source === "string"
                    ? def.source
                    : typeof def.value === "string"
                      ? def.value
                      : family === "members"
                        ? [
                              typeof detail.effect === "string" ? detail.effect : "",
                              typeof detail.matched === "number" ? `matched=${String(detail.matched)}` : "",
                          ]
                              .filter((p) => p.length > 0)
                              .join("  ")
                        : typeof def.description === "string"
                          ? def.description
                          : "";
        const extra =
            family === "personas"
                ? [
                      typeof def.model === "string" && def.model.length > 0 ? `model=${def.model}` : "",
                      typeof def.effort === "string" && def.effort.length > 0 ? `effort=${def.effort}` : "",
                  ]
                      .filter((p) => p.length > 0)
                      .join("  ")
                : "";
        const prov = isRecord(item.provenance) ? item.provenance : {};
        const source = typeof prov.source === "string" && prov.source.length > 0 ? `source=${prov.source}` : "";
        const rowParts = [alias, state, type, target, extra, source].filter((p) => p.length > 0);
        lines.push(rowParts.join("  "));
    }
    if (footer !== null) {
        lines.push(footer);
    }
    return `${lines.join("\n")}\n`;
};

/** {§acp-action-binding} Formats any family action result (`list`, `discover`, `add`, `replace`, `remove`, `enable`, `disable`, `skills`, `complete`, `oauth`, `run`, `status`) into structured human-readable text. */
export const formatFamilyResult = (
    family: string,
    actionName: string,
    params: Readonly<Record<string, unknown>>,
    result: unknown,
): string => {
    if (!isRecord(result)) {
        return `Executed /${family}`;
    }
    if (
        actionName === "workspace.mcp.oauth.begin"
        || actionName === "workspace.mcp.oauth.complete"
        || actionName === "service.mcp.oauth.begin"
        || actionName === "service.mcp.oauth.complete"
    ) {
        const alias = typeof result.alias === "string"
            ? result.alias
            : typeof params.alias === "string"
              ? params.alias
              : "";
        if (isRecord(result.authorization) && typeof result.authorization.url === "string") {
            return `${alias}: authorization required: ${result.authorization.url}`;
        }
        if (result.status === 202) {
            return `${alias}: Sign-in accepted; tools awaiting activation.`;
        }
        if (result.status === 200) {
            return `${alias}  active`;
        }
    }
    if (
        actionName === "workspace.mcp.secrets.list"
        || actionName === "service.mcp.secrets.list"
        || actionName === "workspace.mcp.secrets.set"
        || actionName === "service.mcp.secrets.set"
        || actionName === "workspace.mcp.secrets.unset"
        || actionName === "service.mcp.secrets.unset"
    ) {
        if (actionName.endsWith(".list") && isRecord(result.byServer) && typeof params.alias !== "string") {
            const rows = Object.entries(result.byServer).flatMap(([srv, val]) => {
                if (Array.isArray(val)) {
                    const ks = val.filter((k): k is string => typeof k === "string");
                    return ks.length > 0 ? [`${srv}  ${ks.join(", ")}`] : [];
                }
                if (isRecord(val)) {
                    const ks = Array.isArray(val.keys) ? val.keys.filter((k): k is string => typeof k === "string") : [];
                    const inh = Array.isArray(val.inheritedKeys) ? val.inheritedKeys.filter((k): k is string => typeof k === "string") : [];
                    const parts = [
                        ...(ks.length > 0 ? [ks.join(", ")] : []),
                        ...(inh.length > 0 ? [`inherited: ${inh.join(", ")}`] : []),
                    ];
                    return parts.length > 0 ? [`${srv}  ${parts.join(" · ")}`] : [];
                }
                return [];
            });
            return rows.length > 0 ? rows.join("\n") : "mcp secrets: none";
        }
        const alias = typeof result.alias === "string"
            ? result.alias
            : typeof params.alias === "string"
              ? params.alias
              : "";
        const keys = Array.isArray(result.keys)
            ? result.keys.filter((k): k is string => typeof k === "string")
            : [];
        return keys.length > 0 ? `${alias}  secrets: ${keys.join(", ")}` : `${alias}  secrets: none`;
    }
    if (isRecord(result.completion) && Array.isArray(result.completion.values)) {
        const values = result.completion.values.filter((v): v is string => typeof v === "string");
        return values.length === 0 ? `${family} complete: none` : values.join("\n");
    }
    if (actionName === "workspace.mcp.skills") {
        if (result.found === false) {
            return "mcp skills: none";
        }
        if (isRecord(result.skill) && typeof result.skill.name === "string") {
            return `${result.skill.name}  verified`;
        }
        if (Array.isArray(result.skills)) {
            if (result.skills.length === 0) return "mcp skills: none";
            return result.skills
                .map((item) => {
                    if (!isRecord(item)) return String(item);
                    const name = typeof item.name === "string" ? item.name : "";
                    const summary = typeof item.description === "string" && item.description.length > 0
                        ? `  ${item.description}`
                        : "";
                    return `${name}${summary}`;
                })
                .join("\n");
        }
    }
    if (Array.isArray(result.candidates)) {
        const footer = formatDiscoverPageFooter(result);
        if (result.candidates.length === 0) {
            return footer !== null ? `${family} discover: none\n${footer}` : `${family} discover: none`;
        }
        const lines = result.candidates.map((item) => {
            if (!isRecord(item)) return String(item);
            const alias = typeof item.alias === "string" && item.alias.length > 0 ? item.alias : "";
            const summary = typeof item.summary === "string" && item.summary.length > 0 ? item.summary : "";
            return alias.length > 0 && summary.length > 0
                ? `${alias}  ${summary}`
                : alias.length > 0
                  ? alias
                  : summary;
        });
        if (footer !== null) {
            lines.push(footer);
        }
        return lines.join("\n");
    }
    if (actionName === "workspace.schedule.run") {
        const alias = typeof params.alias === "string" ? params.alias : "";
        return formatScheduleRunResult(alias, result);
    }
    if (actionName === "workspace.schedule.status") {
        const alias = typeof params.alias === "string" ? params.alias : "";
        return formatScheduleStatusResult(alias, result);
    }
    if (result.removed === true && typeof result.alias === "string") {
        return `${result.alias}  removed`;
    }
    if (isRecord(result.definition) && typeof result.definition.alias === "string") {
        return formatFamilyRows(family, { definitions: [result.definition] }).trimEnd();
    }
    if (Array.isArray(result.definitions)) {
        return formatFamilyRows(family, result).trimEnd();
    }
    return `Executed /${family}`;
};

export type LearnCommandScope = "project" | "plurnk";
export type LearnCommandExpansion =
    | { readonly ok: true; readonly scope: LearnCommandScope; readonly prompt: string }
    | { readonly ok: false; readonly error: string };

/** {§acp-action-binding} {§client-composer-sigils} Expands `/learn [--scope project|plurnk] [instructions]` with folder-aware skill target resolution. */
export const expandLearnCommand = (
    rawLine: string,
    options?: { readonly projectRoot?: string | null },
): LearnCommandExpansion | null => {
    const trimmed = rawLine.trim();
    if (trimmed !== "/learn" && !trimmed.startsWith("/learn ")) {
        return null;
    }
    const restText = trimmed.slice("/learn".length).trim();
    const tokens = restText.length > 0 ? restText.split(/\s+/u) : [];
    let explicitScope: string | undefined;
    const instructionTokens: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i] ?? "";
        if (tok === "--scope") {
            const next = tokens[i + 1];
            if (next === undefined || next.startsWith("--")) {
                return { ok: false, error: "Missing /learn --scope value: expected 'project' or 'plurnk'." };
            }
            explicitScope = next;
            i += 1;
        } else if (tok.startsWith("--scope=")) {
            explicitScope = tok.slice("--scope=".length);
        } else {
            instructionTokens.push(tok);
        }
    }
    if (explicitScope !== undefined && explicitScope !== "project" && explicitScope !== "plurnk") {
        return {
            ok: false,
            error: `Invalid /learn scope '${explicitScope}': expected 'project' or 'plurnk'.`,
        };
    }
    if (explicitScope === "project" && options?.projectRoot === null) {
        return {
            ok: false,
            error: "This workspace has no project folder; use `/learn --scope plurnk` to save under $XDG_CONFIG_HOME/plurnk/skills.",
        };
    }
    const scope: LearnCommandScope = explicitScope ?? (options?.projectRoot === null ? "plurnk" : "project");
    const targetPath = scope === "plurnk"
        ? "${XDG_CONFIG_HOME:-~/.config}/plurnk/skills/<name>/SKILL.md"
        : ".agents/skills/<name>/SKILL.md";
    const instructions = instructionTokens.join(" ");
    const basePrompt =
        `Distill reusable workflow, setup, or domain knowledge from this session into an Agent Skill at \`${targetPath}\` ` +
        "(read `mcp:///plurnk/skills.json` first, write a concise `SKILL.md` with YAML frontmatter `name` and `description`, and verify discovery with the `skills` tool).";
    return {
        ok: true,
        scope,
        prompt: instructions.length > 0 ? `${basePrompt}\n\nFocus: ${instructions}` : basePrompt,
    };
};

export type ApplicationEventHandler = (
    workspaceId: number | null,
    method: DaemonNotificationEvent,
    params: unknown,
    notification: DaemonNotification,
) => void;

/**
 * {§credential-authority} The verified identity claims extracted from a presented OIDC / OAuth 2.1
 * bearer token (`sub`, plus optional `email` and `expiresAt`).
 */
export interface VerifiedBearerClaims {
    readonly subject: string;
    readonly email?: string;
    readonly scopes?: readonly string[];
    readonly expiresAt?: number;
    /** {§auth-oauth} True when the operator authorized this subject to attribute exterior speakers (`_meta.plurnk.actor`). */
    readonly canDelegateActor?: boolean;
}

/**
 * {§credential-authority} The resource-server credential verifier published at setup by an
 * authentication module (such as `@plurnk/plurnk-auth` when `PLURNK_AUTH_ISSUER` is configured):
 * resolves the daemon's public resource origin for RFC 9728 `resource_metadata` challenges
 * ({§http-host}) and verifies presented bearer tokens. Published, the daemon authenticates every
 * mounted resource; absent, every mounted resource admits without bearer tokens.
 */
export interface CredentialFace {
    readonly issuer: (req?: RequestHeaders) => string;
    readonly authorizationServer?: string;
    readonly verify: (token: string) => Promise<VerifiedBearerClaims | null> | VerifiedBearerClaims | null;
}

/**
 * {§credential-authority} The daemon's one authority over bearer credentials presented to its
 * listener. Every exterior adapter verifies through it; at most one authentication module publishes
 * the active `CredentialFace` at `setup()`.
 */
export interface CredentialAuthority {
    /** Verifies a presented bearer token against the published face; null when invalid or unconfigured. */
    verify(token: string): Promise<VerifiedBearerClaims | null> | VerifiedBearerClaims | null;
    /** Publishes the one credential face; a second publication is a configuration fault. */
    publish(face: CredentialFace): void;
    /** The published face, or null when no authentication module is active. */
    face(): CredentialFace | null;
}

export interface ApplicationPersonaProjection {
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly source: string;
    readonly model?: string;
    readonly effort?: Effort;
}
