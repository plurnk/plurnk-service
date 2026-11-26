import { errnoCode, isRecord } from "@plurnk/plurnk-contracts";
import { constants } from "node:fs";
import { access, mkdir, mkdtempDisposable, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import ExecEnv from "../schemes/exec-env.ts";
import type HostPaths from "./HostPaths.ts";

// The client and the bench lanes read their own keys from the operator's file, too.
const FOREIGN = /^PLURNK_(?:CLIENT_|COMPOSITION_|BENCH|SWEBENCH_|PI_|CANDIDATE_)/u;
const REDACTED = "<redacted>";
const SYMBOLIC_ENV_VALUE = /^(?:(?:Bearer|Basic|Token)\s+)?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/iu;
const SECRET_FIELD_NAME = /(?:^|[-_])(?:secret|pass|password|token|api[-_]?key|bearer|credential)$|(?:Secret|Password|Token|ApiKey|Bearer|Credential)$/u;
const MALFORMED_MCP_SECRET_HINT = /(?:^|[\s"'=,:])(?:bearer\s+\S|authorization\s*[:=])/iu;

const isSymbolicEnvValue = (value: string): boolean => SYMBOLIC_ENV_VALUE.test(value.trim());

const isSecretFieldName = (field: string, env: NodeJS.ProcessEnv): boolean =>
    OperatorConfig.isSecretKey(field, env) || SECRET_FIELD_NAME.test(field);

const redactUrlUserinfo = (raw: string): string => {
    const match = /^(https?:\/\/)([^/?#@]+)@(.*)$/iu.exec(raw);
    if (match === null) return raw;
    const [, scheme, userinfo, rest] = match;
    const colon = userinfo.indexOf(":");
    if (colon < 0) {
        const user = isSymbolicEnvValue(userinfo) ? userinfo : REDACTED;
        return `${scheme}${user}@${rest}`;
    }
    const rawUser = userinfo.slice(0, colon);
    const rawPass = userinfo.slice(colon + 1);
    const user = rawUser.length === 0 || isSymbolicEnvValue(rawUser) ? rawUser : REDACTED;
    const pass = rawPass.length === 0 || isSymbolicEnvValue(rawPass) ? rawPass : REDACTED;
    return `${scheme}${user}:${pass}@${rest}`;
};

const redactStructuredSecrets = (
    input: Readonly<Record<string, unknown>>,
    env: NodeJS.ProcessEnv,
): { readonly value: Record<string, unknown>; readonly changed: boolean } => {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(input)) {
        if (typeof value === "string" && value.length > 0 && isSecretFieldName(field, env) && !isSymbolicEnvValue(value)) {
            out[field] = REDACTED;
            changed = true;
        } else if (isRecord(value)) {
            const nested = redactStructuredSecrets(value, env);
            out[field] = nested.value;
            if (nested.changed) changed = true;
        } else {
            out[field] = value;
        }
    }
    return { value: out, changed };
};

const redactMcpDefinitionValue = (rawValue: string, env: NodeJS.ProcessEnv): string => {
    if (!rawValue.trimStart().startsWith("{")) {
        return MALFORMED_MCP_SECRET_HINT.test(rawValue) ? REDACTED : redactUrlUserinfo(rawValue);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawValue);
    } catch {
        // Fail closed on malformed PLURNK_MCP_<alias> JSON that may embed literal credentials.
        return REDACTED;
    }
    if (!isRecord(parsed)) return rawValue;
    let changed = false;
    const sanitized: Record<string, unknown> = { ...parsed };
    if (typeof parsed.url === "string") {
        const redactedUrl = redactUrlUserinfo(parsed.url);
        if (redactedUrl !== parsed.url) {
            sanitized.url = redactedUrl;
            changed = true;
        }
    }
    if (isRecord(parsed.headers)) {
        const headers: Record<string, unknown> = {};
        let headersChanged = false;
        for (const [name, value] of Object.entries(parsed.headers)) {
            if (typeof value === "string" && value.length > 0 && !isSymbolicEnvValue(value)) {
                headers[name] = REDACTED;
                headersChanged = true;
            } else {
                headers[name] = value;
            }
        }
        if (headersChanged) {
            sanitized.headers = headers;
            changed = true;
        }
    }
    if (isRecord(parsed.authorization)) {
        const auth = redactStructuredSecrets(parsed.authorization, env);
        if (auth.changed) {
            sanitized.authorization = auth.value;
            changed = true;
        }
    }
    if (isRecord(parsed.env)) {
        const mcpEnv: Record<string, unknown> = {};
        let envChanged = false;
        for (const [name, value] of Object.entries(parsed.env)) {
            if (typeof value === "string" && value.length > 0 && OperatorConfig.isSecretKey(name, env) && !isSymbolicEnvValue(value)) {
                mcpEnv[name] = REDACTED;
                envChanged = true;
            } else {
                mcpEnv[name] = value;
            }
        }
        if (envChanged) {
            sanitized.env = mcpEnv;
            changed = true;
        }
    }
    return changed ? JSON.stringify(sanitized) : rawValue;
};

const BIND_TIME_EXACT = new Set([
    "PLURNK_HOST",
    "PLURNK_PORT",
    "PLURNK_SERVICE_DB_PATH",
    "PLURNK_SERVICE_STATE_ROOT",
    "PLURNK_SERVICE_AUTO_VACUUM",
]);

const exists = async (path: string): Promise<boolean> => access(path, constants.F_OK)
    .then(() => true)
    .catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return false;
        throw cause;
    });

// {§operator-config-precedence} — the user owns this one ordinary dotenv file.
// Package defaults remain package-owned and are projected on demand.
export default class OperatorConfig {
    static isBindTimeKey(key: string): boolean {
        return BIND_TIME_EXACT.has(key) || key.startsWith("PLURNK_SERVICE_SQLITE_") || key.startsWith("PLURNK_AUTH_");
    }

    static isSecretKey(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
        if (key === "OTEL_EXPORTER_OTLP_HEADERS") return true;
        if (/(?:^|_)(?:SECRET|PASS|PASSWORD|TOKEN|API_KEY|BEARER)$/u.test(key)) return true;
        if (!key.startsWith("PLURNK_") && ExecEnv.ownSecretTest(env)(key)) return true;
        return false;
    }

    // {§operator-config-precedence} Redact secret-named keys, embedded non-symbolic credentials
    // inside PLURNK_MCP_<alias> definitions, and URL userinfo before writing overrides to the
    // daemon lockfile or surfacing them in config inspection (#1575).
    static redactValue(key: string, rawValue: string, env: NodeJS.ProcessEnv = process.env): string {
        if (rawValue.length === 0) return rawValue;
        if (OperatorConfig.isSecretKey(key, env)) return REDACTED;
        if (key.startsWith("PLURNK_MCP_")) return redactMcpDefinitionValue(rawValue, env);
        return redactUrlUserinfo(rawValue);
    }
    // {§credential-authority} — the seed teaches the default loopback posture and optional external OIDC knobs.
    static renderSeed(): string {
        return [
            "# Plurnk user configuration. This file is yours and is never overwritten.",
            "# Full installed options: plurnk-service config defaults",
            "# Validate this cascade: plurnk-service config check",
            "#",
            "# Loopback listener (127.0.0.1:1066) requires no password on this machine.",
            "# Optional external OIDC / OAuth 2.1 protection (e.g. Google, Keycloak, Authentik):",
            "# PLURNK_AUTH_ISSUER=",
            "# PLURNK_AUTH_CLIENT_ID=",
            "# PLURNK_AUTH_USERS=",
            "",
            "# Choose one model profile by uncommenting its complete block.",
            "",
            "# OPENROUTER — bring any supported OpenRouter model.",
            "# PLURNK_MODEL_openrouter=\"openrouter/qwen/qwen3-coder\"",
            "# OPENROUTER_API_KEY=\"...\"",
            "# PLURNK_MODEL=openrouter",
            "",
            "# LOCAL — an OpenAI-compatible local server.",
            "# PLURNK_MODEL_local=\"openai/qwen\"",
            "# PLURNK_BASEURL_local=http://127.0.0.1:8080/v1",
            "# PLURNK_MODEL=local",
            "",
            "# AGENT SKILLS — project skills live in .agents/skills, plurnk-only skills in",
            "# $XDG_CONFIG_HOME/plurnk/skills, and user-global skills in $XDG_CONFIG_HOME/agents/skills or ~/.agents/skills.",
            "# Bind them per workspace with /skills (clients) or the skills tool (model).",
            "# Local folders stay live; Git/archive sources are retained workspace copies.",
            "",
            "# MCP SERVERS — complete definitions; declared servers are enabled unless explicitly disabled.",
            "# /mcp add saves a workspace definition without rewriting this file.",
            "# PLURNK_MCP_brave={\"type\":\"stdio\",\"command\":\"npx\",\"args\":[\"-y\",\"@brave/brave-search-mcp-server@2.1.0\"]}",
            "# PLURNK_MCP_brave_TOOLS=[\"brave_web_search\",\"brave_news_search\"]",
            "# PLURNK_MCP_brave_ENABLED=0",
            "# File membership definitions take the same form:",
            "# PLURNK_MEMBERS_docs=docs/**",
            "# PLURNK_MEMBERS_no_locks=!**/*.lock",
            "# PLURNK_MEMBERS_no_locks_ENABLED=0",
            "",
        ].join("\n");
    }

    // {§operator-config-precedence} The daemon's keys an operator file sets that no installed
    // package declares, in file order.
    static undeclared(text: string, declares: (key: string) => boolean): readonly string[] {
        return Object.keys(parseEnv(text)).filter((key) => key.startsWith("PLURNK_") && !FOREIGN.test(key) && !declares(key));
    }

    static async ensure(paths: HostPaths): Promise<boolean> {
        if (await exists(paths.configDir)) return false;
        await mkdir(dirname(paths.configDir), { recursive: true, mode: 0o700 });
        await using stage = await mkdtempDisposable(join(dirname(paths.configDir), `.${basename(paths.configDir)}-`));
        await writeFile(join(stage.path, basename(paths.configFile)), OperatorConfig.renderSeed(), { encoding: "utf8", flag: "wx", mode: 0o600 });
        await writeFile(join(stage.path, basename(paths.policyFile)), "", { encoding: "utf8", flag: "wx", mode: 0o600 });
        // {§operator-config-precedence}: only a complete seed becomes visible.
        try {
            await rename(stage.path, paths.configDir);
        } catch (cause) {
            const code = errnoCode(cause);
            if (code === "EEXIST" || code === "ENOTEMPTY") return false;
            throw cause;
        }
        return true;
    }
}
