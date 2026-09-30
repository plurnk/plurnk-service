import type { A2AAgentDefinition as A2aAgentDefinition } from "@plurnk/plurnk-contracts";
import { Knob, ResourceEnvironment } from "@plurnk/plurnk-meta";
import { isAbsolute } from "node:path";
import { readDefinition } from "./definition.ts";
import {
    A2A_PROTOCOL_VERSION,
    AgentCard,
    type AgentSkill,
} from "@a2a-js/sdk";

const PREFIX = "PLURNK_A2A_";
const CONTROLS = [
    "CONNECT_TIMEOUT", "REQUEST_TIMEOUT", "ERROR_DETAIL_LIMIT", "EXPOSE", "TOKEN",
    "ENDPOINT_PATH", "ENDPOINT_URL", "WORKSPACE", "PROJECT_ROOT", "PROPOSALS",
    "NAME", "DESCRIPTION", "VERSION", "PROVIDER_ORGANIZATION", "PROVIDER_URL",
    "DOCUMENTATION_URL", "ICON_URL", "SKILLS",
];
const INPUT_MODES = ["*/*"];
const OUTPUT_MODES = ["*/*"];

// The environment's projection of one outbound agent is exactly the
// coordinator's `A2aAgentDefinition` contract.
export type OutboundAgentDefinition = A2aAgentDefinition;

export interface HostedAgentConfiguration {
    /** The bearer the endpoint requires and the card declares; empty = an unauthenticated exposure. */
    readonly token: string;
    readonly endpointPath: string;
    readonly endpointUrl?: string;
    readonly workspace: {
        readonly name: string;
        readonly projectRoot: string | null;
    };
    readonly proposals: HostedProposals;
    readonly card: AgentCard;
}

// A2A carries no review channel, so an inbound loop settles its own proposals.
const HOSTED_PROPOSALS = ["accept", "reject"] as const;
export type HostedProposals = typeof HOSTED_PROPOSALS[number];

// {§http-host} — the exposure rides the service listener, so it has no address knobs (#641).
// A still-set one fails hard naming the successor; it never silently binds nothing, and it never
// case-folds into an alias definition. Spelled out only here, as the refusal's own evidence.
const shedRetiredListener = (environ: NodeJS.ProcessEnv): void => {
    for (const name of ["PLURNK_A2A_HOST", "PLURNK_A2A_PORT"] as const) {
        if (environ[name] !== undefined) {
            throw new Error(
                `${name} is retired: the A2A exposure is mounted on the service listener, whose address is PLURNK_HOST and PLURNK_PORT ({§http-host}); remove it.`,
            );
        }
    }
};

const parseEnvironment = (environ: NodeJS.ProcessEnv): ResourceEnvironment => {
    shedRetiredListener(environ);
    const environment = new ResourceEnvironment(PREFIX, { controls: CONTROLS, settings: [] }, environ);
    return environment;
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

const hostedProposals = (raw: string): HostedProposals => {
    if (!(HOSTED_PROPOSALS as readonly string[]).includes(raw)) {
        throw new Error(`PLURNK_A2A_PROPOSALS must be one of ${HOSTED_PROPOSALS.join(", ")}; got ${JSON.stringify(raw)}.`);
    }
    return raw as HostedProposals;
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
                throw new Error(`${at}.securityRequirements must be absent or empty; security is the exposure's, card-wide.`);
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

export const outboundDefinitions = (
    environ: NodeJS.ProcessEnv = process.env,
): Array<{ alias: string; definition: OutboundAgentDefinition; enabled: boolean }> => {
    const environment = parseEnvironment(environ);
    return [...environment.definitions].map(([alias, { key, value }]) => {
        let definition: OutboundAgentDefinition;
        try {
            definition = readDefinition(JSON.parse(value));
        } catch (cause) {
            throw new Error(`${key} must be an A2A agent definition.`, { cause });
        }
        if (definition.name !== alias) throw new Error(`${key} must define name '${alias}'.`);
        return { alias, definition, enabled: environment.enabled(alias) };
    });
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
    // {§operator-config-only-home} — an absent key is a broken floor, never a silent "no
    // authentication": only the panel's own empty value may say that the exposure is open.
    const token = environ.PLURNK_A2A_TOKEN;
    if (token === undefined) throw new Error("PLURNK_A2A_TOKEN is missing from the assembled environment floor.");
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
        token,
        endpointPath,
        ...(endpointUrl === undefined ? {} : { endpointUrl }),
        workspace: {
            name: required(environ, "PLURNK_A2A_WORKSPACE"),
            projectRoot: projectRoot === undefined || projectRoot.length === 0 ? null : projectRoot,
        },
        proposals: hostedProposals(required(environ, "PLURNK_A2A_PROPOSALS")),
        card,
    };
};

export const connectTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number =>
    Knob.integer("PLURNK_A2A_CONNECT_TIMEOUT", 1, environ);

export const requestTimeoutMs = (environ: NodeJS.ProcessEnv = process.env): number =>
    Knob.integer("PLURNK_A2A_REQUEST_TIMEOUT", 1, environ);
