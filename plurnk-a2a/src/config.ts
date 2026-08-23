import { isAbsolute } from "node:path";
import {
    A2A_PROTOCOL_VERSION,
    AgentCard,
    type AgentSkill,
} from "@a2a-js/sdk";

const PREFIX = "PLURNK_A2A_";
const COMPANION_SUFFIXES = ["_card_path", "_bearer", "_headers"] as const;
const CONTROL_KEYS = new Map([
    ["enabled", `${PREFIX}ENABLED`],
    ["connect_timeout", `${PREFIX}CONNECT_TIMEOUT`],
    ["request_timeout", `${PREFIX}REQUEST_TIMEOUT`],
    ["expose", `${PREFIX}EXPOSE`],
    ["host", `${PREFIX}HOST`],
    ["port", `${PREFIX}PORT`],
    ["endpoint_path", `${PREFIX}ENDPOINT_PATH`],
    ["endpoint_url", `${PREFIX}ENDPOINT_URL`],
    ["workspace", `${PREFIX}WORKSPACE`],
    ["project_root", `${PREFIX}PROJECT_ROOT`],
    ["name", `${PREFIX}NAME`],
    ["description", `${PREFIX}DESCRIPTION`],
    ["version", `${PREFIX}VERSION`],
    ["provider_organization", `${PREFIX}PROVIDER_ORGANIZATION`],
    ["provider_url", `${PREFIX}PROVIDER_URL`],
    ["documentation_url", `${PREFIX}DOCUMENTATION_URL`],
    ["icon_url", `${PREFIX}ICON_URL`],
    ["skills", `${PREFIX}SKILLS`],
]);
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u;
const INPUT_MODES = ["text/plain"];
const OUTPUT_MODES = ["text/markdown"];

type CompanionSuffix = typeof COMPANION_SUFFIXES[number];

interface EnvironmentVariable {
    readonly key: string;
    readonly value: string;
}

interface ParsedEnvironment {
    readonly targets: Map<string, EnvironmentVariable>;
    readonly companions: Map<string, Map<CompanionSuffix, EnvironmentVariable>>;
}

export interface OutboundAgentDefinition {
    readonly name: string;
    readonly target: string;
    readonly cardPath?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly authorization?: {
        readonly type: "bearer";
        /** Symbolic `${NAME}` reference; the secret remains environment-owned. */
        readonly token: string;
    };
}

export interface HostedAgentConfiguration {
    readonly host: string;
    readonly port: number;
    readonly endpointPath: string;
    readonly endpointUrl?: string;
    readonly workspace: {
        readonly name: string;
        readonly projectRoot: string | null;
    };
    readonly card: AgentCard;
}

const assertAgentName = (name: string, variable: string): void => {
    if (!AGENT_NAME.test(name)) {
        throw new Error(
            `${variable} derives invalid A2A agent name '${name}'; names must match [a-z][a-z0-9-]*.`,
        );
    }
};

const parseEnvironment = (environ: NodeJS.ProcessEnv): ParsedEnvironment => {
    const targets = new Map<string, EnvironmentVariable>();
    const companions = new Map<string, Map<CompanionSuffix, EnvironmentVariable>>();
    for (const [key, value] of Object.entries(environ)) {
        if (value === undefined || !key.startsWith(PREFIX)) continue;
        const suffix = key.slice(PREFIX.length);
        if (suffix.length === 0) continue;
        const folded = suffix.toLowerCase();
        const controlKey = CONTROL_KEYS.get(folded);
        if (controlKey !== undefined) {
            if (key !== controlKey) {
                throw new Error(
                    `${key} case-folds to ${controlKey}; that name is a reserved global and must use its canonical spelling.`,
                );
            }
            continue;
        }
        const companion = COMPANION_SUFFIXES.find((candidate) => folded.endsWith(candidate));
        if (companion !== undefined) {
            const name = folded.slice(0, -companion.length);
            const reservedGlobal = CONTROL_KEYS.get(name);
            if (reservedGlobal !== undefined) {
                throw new Error(
                    `${key} uses ${reservedGlobal} as an agent name; reserved globals cannot have agent companions.`,
                );
            }
            assertAgentName(name, key);
            const bySuffix = companions.get(name) ?? new Map<CompanionSuffix, EnvironmentVariable>();
            const existing = bySuffix.get(companion);
            if (existing !== undefined) {
                throw new Error(
                    `${existing.key} and ${key} are duplicate A2A agent companions after case-folding.`,
                );
            }
            bySuffix.set(companion, { key, value });
            companions.set(name, bySuffix);
            continue;
        }
        assertAgentName(folded, key);
        const existing = targets.get(folded);
        if (existing !== undefined) {
            throw new Error(
                `${existing.key} and ${key} both derive A2A agent name '${folded}' after case-folding.`,
            );
        }
        targets.set(folded, { key, value });
    }
    for (const [name, fields] of companions) {
        if (targets.has(name)) continue;
        const variables = [...fields.values()].map(({ key }) => key).join(", ");
        throw new Error(`${variables} has no A2A agent target ${PREFIX}${name.toUpperCase()}.`);
    }
    return { targets, companions };
};

const jsonStrings = (raw: string | undefined, field: string): string[] => {
    if (raw === undefined || raw.length === 0) return [];
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error(`${field} must be a JSON array of strings.`, { cause });
    }
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === "string")) {
        throw new Error(`${field} must be a JSON array of strings.`);
    }
    return parsed;
};

const jsonRecord = (
    raw: string | undefined,
    field: string,
): Record<string, string> | undefined => {
    if (raw === undefined || raw.length === 0) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error(`${field} must be a JSON object with string values.`, { cause });
    }
    if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
        || !Object.values(parsed).every((value) => typeof value === "string")
    ) {
        throw new Error(`${field} must be a JSON object with string values.`);
    }
    return parsed as Record<string, string>;
};

const absoluteHttpUrl = (raw: string, field: string): string => {
    let url: URL;
    try {
        url = new URL(raw);
    } catch (cause) {
        throw new Error(`${field} must be an absolute HTTP(S) URL.`, { cause });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error(`${field} must be an absolute HTTP(S) URL.`);
    }
    return raw;
};

const optionalUrl = (raw: string | undefined, field: string): string | undefined =>
    raw === undefined || raw.length === 0 ? undefined : absoluteHttpUrl(raw, field);

const required = (environ: NodeJS.ProcessEnv, field: string): string => {
    const value = environ[field];
    if (value === undefined || value.length === 0) {
        throw new Error(`${field} is required when PLURNK_A2A_EXPOSE=1.`);
    }
    return value;
};

const positiveInteger = (raw: string | undefined, field: string): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${field} must be a positive integer; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

const listenerPort = (raw: string | undefined): number => {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 65_535) {
        throw new Error(`PLURNK_A2A_PORT must be an integer from 0 through 65535; got ${JSON.stringify(raw)}.`);
    }
    return value;
};

const stringArray = (value: unknown, field: string): string[] => {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`${field} must be an array of strings.`);
    }
    return value;
};

const skills = (raw: string | undefined): AgentSkill[] => {
    const field = "PLURNK_A2A_SKILLS";
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? "[]");
    } catch (cause) {
        throw new Error(`${field} must be a JSON array of Agent Skill objects.`, { cause });
    }
    if (!Array.isArray(parsed)) throw new Error(`${field} must be a JSON array of Agent Skill objects.`);
    const ids = new Set<string>();
    return parsed.map((candidate, index) => {
        const at = `${field}[${index}]`;
        if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
            throw new Error(`${at} must be an Agent Skill object.`);
        }
        const skill = candidate as Record<string, unknown>;
        const text = (name: string): string => {
            const value = skill[name];
            if (typeof value !== "string" || value.length === 0) {
                throw new Error(`${at}.${name} must be a non-empty string.`);
            }
            return value;
        };
        const id = text("id");
        if (ids.has(id)) throw new Error(`${field} contains duplicate Agent Skill id '${id}'.`);
        ids.add(id);
        if (skill.securityRequirements !== undefined) {
            const security = skill.securityRequirements;
            if (!Array.isArray(security) || security.length > 0) {
                throw new Error(`${at}.securityRequirements must be absent or empty for an unauthenticated exposure.`);
            }
        }
        return {
            id,
            name: text("name"),
            description: text("description"),
            tags: skill.tags === undefined ? [] : stringArray(skill.tags, `${at}.tags`),
            examples: skill.examples === undefined ? [] : stringArray(skill.examples, `${at}.examples`),
            inputModes: skill.inputModes === undefined
                ? structuredClone(INPUT_MODES)
                : stringArray(skill.inputModes, `${at}.inputModes`),
            outputModes: skill.outputModes === undefined
                ? structuredClone(OUTPUT_MODES)
                : stringArray(skill.outputModes, `${at}.outputModes`),
            securityRequirements: [],
        };
    });
};

export const outboundAgentNames = (environ: NodeJS.ProcessEnv = process.env): string[] =>
    [...parseEnvironment(environ).targets.keys()].toSorted();

export const outboundAgentDefinition = (
    name: string,
    environ: NodeJS.ProcessEnv = process.env,
): OutboundAgentDefinition | null => {
    const folded = name.toLowerCase();
    const { targets, companions } = parseEnvironment(environ);
    const target = targets.get(folded);
    if (target === undefined) return null;
    if (target.value.length === 0) throw new Error(`${target.key} must not be empty.`);
    const fields = companions.get(folded);
    const cardPathField = fields?.get("_card_path");
    const cardPath = cardPathField?.value;
    if (cardPath !== undefined && (!cardPath.startsWith("/") || cardPath.includes("?") || cardPath.includes("#"))) {
        throw new Error(`${cardPathField?.key} must be an absolute URL pathname without query or fragment.`);
    }
    const headersField = fields?.get("_headers");
    const headers = jsonRecord(headersField?.value, headersField?.key ?? `${PREFIX}${folded.toUpperCase()}_HEADERS`);
    const bearer = fields?.get("_bearer");
    if (bearer !== undefined && !ENV_REFERENCE.test(bearer.value)) {
        throw new Error(`${bearer.key} must be a symbolic environment reference such as \${TOKEN}.`);
    }
    const authorizationHeader = Object.keys(headers ?? {}).find((key) => key.toLowerCase() === "authorization");
    if (bearer !== undefined && authorizationHeader !== undefined) {
        throw new Error(`${bearer.key} conflicts with Authorization in ${headersField?.key}.`);
    }
    return {
        name: folded,
        target: absoluteHttpUrl(target.value, target.key),
        ...(cardPath === undefined || cardPath.length === 0 ? {} : { cardPath }),
        ...(headers === undefined ? {} : { headers }),
        ...(bearer === undefined ? {} : {
            authorization: { type: "bearer" as const, token: bearer.value },
        }),
    };
};

export const outboundDefinitions = (
    environ: NodeJS.ProcessEnv = process.env,
): OutboundAgentDefinition[] => outboundAgentNames(environ).map((name) => {
    const definition = outboundAgentDefinition(name, environ);
    if (definition === null) throw new Error(`A2A agent '${name}' disappeared during configuration.`);
    return definition;
});

export const serviceEnabledNames = (environ: NodeJS.ProcessEnv = process.env): string[] => {
    const field = `${PREFIX}ENABLED`;
    const configured = jsonStrings(environ[field], field);
    const available = new Set(outboundAgentNames(environ));
    const enabled = new Set<string>();
    for (const name of configured) {
        assertAgentName(name, field);
        if (!available.has(name)) throw new Error(`${field} contains unknown A2A agent '${name}'.`);
        if (enabled.has(name)) throw new Error(`${field} contains duplicate A2A agent '${name}'.`);
        enabled.add(name);
    }
    return [...enabled].toSorted();
};

export const hostedAgentConfiguration = (
    environ: NodeJS.ProcessEnv = process.env,
): HostedAgentConfiguration | null => {
    const enabled = environ.PLURNK_A2A_EXPOSE;
    if (enabled === undefined || enabled.length === 0 || enabled === "0") return null;
    if (enabled !== "1") throw new Error(`PLURNK_A2A_EXPOSE must be 0 or 1; got ${JSON.stringify(enabled)}.`);
    parseEnvironment(environ);
    const endpointPath = required(environ, "PLURNK_A2A_ENDPOINT_PATH");
    if (!endpointPath.startsWith("/") || endpointPath.includes("?") || endpointPath.includes("#")) {
        throw new Error("PLURNK_A2A_ENDPOINT_PATH must be an absolute URL pathname without query or fragment.");
    }
    const projectRoot = environ.PLURNK_A2A_PROJECT_ROOT;
    if (projectRoot !== undefined && projectRoot.length > 0 && !isAbsolute(projectRoot)) {
        throw new Error("PLURNK_A2A_PROJECT_ROOT must be empty or an absolute filesystem path.");
    }
    const providerOrganization = environ.PLURNK_A2A_PROVIDER_ORGANIZATION;
    const providerUrl = environ.PLURNK_A2A_PROVIDER_URL;
    if ((providerOrganization?.length ?? 0) > 0 !== ((providerUrl?.length ?? 0) > 0)) {
        throw new Error("PLURNK_A2A_PROVIDER_ORGANIZATION and PLURNK_A2A_PROVIDER_URL must be set together.");
    }
    const endpointUrl = optionalUrl(environ.PLURNK_A2A_ENDPOINT_URL, "PLURNK_A2A_ENDPOINT_URL");
    const documentationUrl = optionalUrl(
        environ.PLURNK_A2A_DOCUMENTATION_URL,
        "PLURNK_A2A_DOCUMENTATION_URL",
    );
    const iconUrl = optionalUrl(environ.PLURNK_A2A_ICON_URL, "PLURNK_A2A_ICON_URL");
    const card = AgentCard.fromJSON({
        name: required(environ, "PLURNK_A2A_NAME"),
        description: required(environ, "PLURNK_A2A_DESCRIPTION"),
        supportedInterfaces: [{
            url: endpointUrl ?? "",
            protocolBinding: "HTTP+JSON",
            protocolVersion: A2A_PROTOCOL_VERSION,
            tenant: "",
        }],
        provider: providerOrganization === undefined || providerOrganization.length === 0
            ? undefined
            : {
                organization: providerOrganization,
                url: absoluteHttpUrl(providerUrl!, "PLURNK_A2A_PROVIDER_URL"),
            },
        version: required(environ, "PLURNK_A2A_VERSION"),
        capabilities: {
            streaming: true,
            pushNotifications: false,
            extensions: [],
            extendedAgentCard: false,
        },
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: INPUT_MODES,
        defaultOutputModes: OUTPUT_MODES,
        skills: skills(environ.PLURNK_A2A_SKILLS),
        signatures: [],
        ...(documentationUrl === undefined ? {} : { documentationUrl }),
        ...(iconUrl === undefined ? {} : { iconUrl }),
    });
    return {
        host: required(environ, "PLURNK_A2A_HOST"),
        port: listenerPort(environ.PLURNK_A2A_PORT),
        endpointPath,
        ...(endpointUrl === undefined ? {} : { endpointUrl }),
        workspace: {
            name: required(environ, "PLURNK_A2A_WORKSPACE"),
            projectRoot: projectRoot === undefined || projectRoot.length === 0 ? null : projectRoot,
        },
        card,
    };
};

export const connectTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number =>
    positiveInteger(environ.PLURNK_A2A_CONNECT_TIMEOUT, "PLURNK_A2A_CONNECT_TIMEOUT");

export const requestTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number =>
    positiveInteger(environ.PLURNK_A2A_REQUEST_TIMEOUT, "PLURNK_A2A_REQUEST_TIMEOUT");
