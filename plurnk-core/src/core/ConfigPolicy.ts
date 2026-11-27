// {§operator-config-precedence} {§operator-config-workspace-settings}
// Single authority for what configuration keys may cross into service or workspace tiers,
// how the client allowlist (`PLURNK_SERVICE_CLIENT_CONFIG`) gates writes, how values are
// validated on write, and how ceiling keys compose monotonically (most-restrictive-wins).

import { EFFORTS, PROPOSAL_POLICIES } from "@plurnk/plurnk-contracts";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import ExecEnv from "../schemes/exec-env.ts";
import FileCreationPolicy, { FILE_CREATE_SCOPES, type FileCreateScope } from "./file-creation-policy.ts";
import OperatorConfig from "./OperatorConfig.ts";
import Results, { OperationFailureError } from "./results.ts";

export type ConfigScope = "service" | "workspace";

export type HostOnlyReason =
    | { readonly kind: "bind-time" }
    | { readonly kind: "confinement" }
    | { readonly kind: "family-managed"; readonly family: "mcp" | "skills" | "personas" | "schedule" | "members" };

export type ConfigEditDecision =
    | { readonly ok: true; readonly secret: boolean }
    | {
        readonly ok: false;
        readonly status: 400 | 403;
        readonly code:
            | "config-key-invalid"
            | "config-host-only"
            | "config-family-managed"
            | "config-not-allowed"
            | "config-secret-service-only"
            | "config-scope-unsupported";
        readonly detail: string;
        readonly recovery: string;
        readonly extensions?: Readonly<Record<string, unknown>>;
    };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ALLOWLIST_PREFIX_PATTERN = /^(?:[A-Za-z_][A-Za-z0-9_]*)?\*$/u;

const isValidSelectorPattern = (pattern: string): boolean => {
    if (pattern.length === 0) return false;
    if (pattern.toLowerCase() === "credentials") return true;
    if (ALLOWLIST_PREFIX_PATTERN.test(pattern)) return true;
    return ENV_NAME.test(pattern) && pattern.toLowerCase() !== "none";
};

const matchesSelectorPattern = (
    key: string,
    pattern: string,
    getCredentials: () => ReadonlySet<string>,
    caseInsensitive = false,
): boolean => {
    if (!isValidSelectorPattern(pattern)) return false;
    if (pattern.toLowerCase() === "credentials") {
        if (!caseInsensitive) return getCredentials().has(key);
        const upperKey = key.toUpperCase();
        for (const cred of getCredentials()) {
            if (cred.toUpperCase() === upperKey) return true;
        }
        return false;
    }
    const lhs = caseInsensitive ? key.toUpperCase() : key;
    const rhs = caseInsensitive ? pattern.toUpperCase() : pattern;
    if (rhs.endsWith("*")) {
        return lhs.startsWith(rhs.slice(0, -1));
    }
    return lhs === rhs;
};

// Host confinement and infrastructure knobs that never move beneath the host tier,
// regardless of PLURNK_SERVICE_CLIENT_CONFIG.
const HOST_CONFINEMENT_EXACT = new Set<string>([
    "PLURNK_SERVICE_CLIENT_CONFIG",
    "PLURNK_SERVICE_PROJECT_ROOT_BASE",
    "PLURNK_SERVICE_EXEC_ENV_INHERIT",
    "PLURNK_SERVICE_EXEC_ENV_EXCLUDE",
    "PLURNK_SERVICE_EXEC_SCRATCH",
    "PLURNK_SERVICE_EXEC_CONCURRENCY",
    "PLURNK_SERVICE_SHARE_FOLDER",
    "PLURNK_SERVICE_UPDATEABLE",
    "PLURNK_SERVICE_ROOTS",
    "PLURNK_SERVICE_POLICY",
    "PLURNK_SERVICE_NOTIFICATIONS_ALLOW_ORIGIN",
]);

const HOST_CONFINEMENT_PREFIXES: readonly string[] = [
    "PLURNK_ACP_",
    "PLURNK_EXECS_",
    "PLURNK_EXTENSIONS_",
    "PLURNK_OTEL_",
    "OTEL_",
    "PLURNK_WEB_",
];

// Knobs that have workspace-aware readers in plurnk-core.
// Setting any other key at workspace scope would persist an unread row and is refused cleanly.
const WORKSPACE_KEYS = new Set<string>([
    "PLURNK_SERVICE_FILES_ITEMS",
    "PLURNK_SERVICE_MAX_COMMANDS",
    "PLURNK_SERVICE_MAX_TURNS",
    "PLURNK_SERVICE_GIT_ALLOWED",
    "PLURNK_SERVICE_GIT_AUTO",
    "PLURNK_SERVICE_FILE_CREATE_SCOPE",
    "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE",
    "PLURNK_SERVICE_PROPOSALS",
    "PLURNK_MODEL",
    "PLURNK_MODEL_CHILD",
    "PLURNK_PROVIDERS_EFFORT",
]);

// Monotonically narrowing ceilings: inner tiers may tighten, never widen.
const CEILING_KEYS = new Set<string>([
    "PLURNK_SERVICE_GIT_ALLOWED",
    "PLURNK_MEMBERS_AUTO_ADD",
    "PLURNK_SERVICE_FILE_CREATE_SCOPE",
    "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE",
    "PLURNK_SERVICE_MAX_COMMANDS",
    "PLURNK_SERVICE_MAX_TURNS",
]);

const BOOLEAN_FLAG_KEYS = new Set<string>([
    "PLURNK_SERVICE_GIT_ALLOWED",
    "PLURNK_SERVICE_GIT_AUTO",
    "PLURNK_MEMBERS_AUTO_ADD",
]);

const SCOPE_KEYS = new Set<string>([
    "PLURNK_SERVICE_FILE_CREATE_SCOPE",
    "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE",
]);

const INTEGER_MIN_MINUS_ONE_KEYS = new Set<string>([
    "PLURNK_SERVICE_FILES_ITEMS",
    "PLURNK_SERVICE_MAX_COMMANDS",
    "PLURNK_SERVICE_MAX_TURNS",
]);

const INTEGER_MIN_ZERO_KEYS = new Set<string>([
    "PLURNK_SERVICE_OPTIMISTIC_WAIT_MS",
    "PLURNK_SERVICE_BUDGET_LARGEST_ITEMS",
    "PLURNK_SERVICE_BUDGET_OUTLIER_TOKENS",
    "PLURNK_SERVICE_LINE_ANCHOR_CONTEXT_LINES",
    "PLURNK_SERVICE_EDIT_RECEIPT_CONTEXT_LINES",
    "PLURNK_SERVICE_EDIT_RECEIPT_REMOVED_LINES",
]);

const INTEGER_MIN_ONE_KEYS = new Set<string>([
    "PLURNK_SERVICE_PREVIEW_LINES",
    "PLURNK_SERVICE_PREVIEW_CHARS",
    "PLURNK_SERVICE_WAIT_SEC",
    "PLURNK_SERVICE_LOOP_TIMEOUT_MS",
    "PLURNK_SERVICE_MAX_STRIKES",
    "PLURNK_SERVICE_MIN_CYCLES",
    "PLURNK_SERVICE_MAX_CYCLE_PERIOD",
    "PLURNK_SERVICE_EMISSION_ATTEMPTS",
    "PLURNK_SERVICE_EXEC_HOLD_MS",
]);

const EMISSION_HISTORY_MODES = ["none", "latest", "all"] as const;

const parseStrictInteger = (raw: string): number | null => {
    if (!/^-?\d+$/u.test(raw)) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const isFileCreateScope = (value: string): value is FileCreateScope =>
    (FILE_CREATE_SCOPES as readonly string[]).includes(value);

const failConfig = (
    status: 400 | 403,
    code: string,
    detail: string,
    extensions: Readonly<Record<string, unknown>> = {},
): OperationFailureError => new OperationFailureError(
    Results.failure("daemon:config", code, status, detail, {}, { retryable: false, ...extensions }),
);

export default class ConfigPolicy {
    static readonly WORKSPACE_CONFIG_KEYS: ReadonlySet<string> = WORKSPACE_KEYS;
    static readonly CEILING_CONFIG_KEYS: ReadonlySet<string> = CEILING_KEYS;

    static isValidKey(key: string): boolean {
        return ENV_NAME.test(key);
    }

    static isWorkspaceKey(key: string): boolean {
        return WORKSPACE_KEYS.has(key);
    }

    static isCeilingKey(key: string): boolean {
        return CEILING_KEYS.has(key);
    }

    // {§operator-config-precedence} Unconditional hard floor: keys that belong strictly to the host
    // environment or to a Functionality family.
    static classifyHostOnly(key: string): HostOnlyReason | null {
        if (OperatorConfig.isBindTimeKey(key)) return { kind: "bind-time" };
        if (HOST_CONFINEMENT_EXACT.has(key)) return { kind: "confinement" };
        if (key.startsWith("PLURNK_PROVIDERS_PROVIDER_") && key.endsWith("_API_KEY_ENV")) {
            return { kind: "confinement" };
        }
        for (const prefix of HOST_CONFINEMENT_PREFIXES) {
            if (key.startsWith(prefix)) return { kind: "confinement" };
        }
        if (key.startsWith("PLURNK_MCP_")) return { kind: "family-managed", family: "mcp" };
        if (key.startsWith("PLURNK_SKILLS_")) return { kind: "family-managed", family: "skills" };
        if (key.startsWith("PLURNK_PERSONAS_")) return { kind: "family-managed", family: "personas" };
        if (key.startsWith("PLURNK_SCHEDULE_")) return { kind: "family-managed", family: "schedule" };
        if (key.startsWith("PLURNK_MEMBERS_") && key !== "PLURNK_MEMBERS_AUTO_ADD") {
            return { kind: "family-managed", family: "members" };
        }
        return null;
    }

    static isHostOnly(key: string): boolean {
        return ConfigPolicy.classifyHostOnly(key) !== null;
    }

    // {§operator-config-precedence} Fail-safe client allowlist parsed from the host baseline's
    // PLURNK_SERVICE_CLIENT_CONFIG. Empty or `none` disables all client config mutations;
    // `!`-prefixed selectors (`!KEY`, `!PREFIX_*`, `!credentials`) deny matching keys regardless of order.
    static isValidAllowlistToken(token: string): boolean {
        const trimmed = token.trim();
        if (trimmed.length === 0) return false;
        const pattern = trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
        return isValidSelectorPattern(pattern);
    }

    static parseAllowlist(hostEnv: NodeJS.ProcessEnv = process.env): readonly string[] {
        const raw = hostEnv.PLURNK_SERVICE_CLIENT_CONFIG;
        if (raw === undefined) return [];
        const tokens = raw
            .split(",")
            .map((part) => part.trim())
            .filter((part) => part.length > 0);
        if (tokens.length === 0) return [];
        if (tokens.length === 1 && tokens[0].toLowerCase() === "none") return [];
        return tokens;
    }

    static validateAllowlist(hostEnv: NodeJS.ProcessEnv = process.env): void {
        const tokens = ConfigPolicy.parseAllowlist(hostEnv);
        for (const token of tokens) {
            if (!ConfigPolicy.isValidAllowlistToken(token)) {
                throw new ConfigurationError(
                    "PLURNK_SERVICE_CLIENT_CONFIG",
                    `PLURNK_SERVICE_CLIENT_CONFIG contains invalid selector ${JSON.stringify(token)}; expected an environment variable name, trailing-* prefix glob, 'credentials', optional leading '!' exclusion, or 'none'.`,
                );
            }
        }
    }

    static isAllowlistWritable(allowlist: readonly string[]): boolean {
        if (allowlist.length === 0) return false;
        if (allowlist.some((token) => !ConfigPolicy.isValidAllowlistToken(token))) return false;
        if (allowlist.some((token) => token.trim() === "!*")) return false;
        return allowlist.some((token) => !token.trim().startsWith("!"));
    }

    static matchesAllowlist(
        key: string,
        allowlist: readonly string[],
        hostEnv: NodeJS.ProcessEnv = process.env,
    ): boolean {
        if (allowlist.length === 0) return false;
        if (allowlist.some((token) => !ConfigPolicy.isValidAllowlistToken(token))) return false;
        let credentials: ReadonlySet<string> | null = null;
        const getCredentials = (): ReadonlySet<string> => {
            credentials ??= ExecEnv.providerCredentialNames(hostEnv);
            return credentials;
        };
        let matchedPositive = false;
        for (const rawSelector of allowlist) {
            const selector = rawSelector.trim();
            if (selector.startsWith("!")) {
                if (matchesSelectorPattern(key, selector.slice(1), getCredentials, true)) {
                    return false;
                }
                continue;
            }
            if (!matchedPositive && matchesSelectorPattern(key, selector, getCredentials)) {
                matchedPositive = true;
            }
        }
        return matchedPositive;
    }

    static checkEditable(
        key: string,
        scope: ConfigScope,
        hostEnv: NodeJS.ProcessEnv = process.env,
        options: { readonly enforceAllowlist?: boolean } = {},
    ): ConfigEditDecision {
        if (!ConfigPolicy.isValidKey(key)) {
            return {
                ok: false,
                status: 400,
                code: "config-key-invalid",
                detail: `${JSON.stringify(key)} is not a valid configuration key name.`,
                recovery: "Use an ASCII environment variable identifier (e.g. PLURNK_MODEL).",
                extensions: { key, scope },
            };
        }
        const hostOnly = ConfigPolicy.classifyHostOnly(key);
        if (hostOnly !== null) {
            if (hostOnly.kind === "family-managed") {
                return {
                    ok: false,
                    status: 403,
                    code: "config-family-managed",
                    detail: `${key} belongs to the '${hostOnly.family}' Functionality family and cannot be edited through config.`,
                    recovery: `Manage it with service.${hostOnly.family}.* or workspace.${hostOnly.family}.* actions instead.`,
                    extensions: { key, scope, family: hostOnly.family },
                };
            }
            return {
                ok: false,
                status: 403,
                code: "config-host-only",
                detail: `${key} is host-only (${hostOnly.kind}) and cannot be changed at ${scope} scope.`,
                recovery: "Configure this key in the host environment or operator .env file.",
                extensions: { key, scope, reason: hostOnly.kind },
            };
        }
        const enforceAllowlist = options.enforceAllowlist ?? true;
        if (enforceAllowlist) {
            const allowlist = ConfigPolicy.parseAllowlist(hostEnv);
            if (!ConfigPolicy.matchesAllowlist(key, allowlist, hostEnv)) {
                return {
                    ok: false,
                    status: 403,
                    code: "config-not-allowed",
                    detail: `${key} is not admitted by PLURNK_SERVICE_CLIENT_CONFIG.`,
                    recovery: "Add this key or prefix to PLURNK_SERVICE_CLIENT_CONFIG in the host configuration, or edit it on the host.",
                    extensions: { key, scope },
                };
            }
        }
        const secret = OperatorConfig.isSecretKey(key, hostEnv);
        if (scope === "workspace") {
            if (secret) {
                return {
                    ok: false,
                    status: 403,
                    code: "config-secret-service-only",
                    detail: `${key} is a secret key and may only be stored at service scope.`,
                    recovery: "Store credentials at service scope (service.config.set) so they stay encrypted outside plurnk.db.",
                    extensions: { key, scope },
                };
            }
            if (!WORKSPACE_KEYS.has(key)) {
                return {
                    ok: false,
                    status: 400,
                    code: "config-scope-unsupported",
                    detail: `${key} is a daemon-wide configuration key and has no workspace scope.`,
                    recovery: "Set this key at service scope (service.config.set) instead.",
                    extensions: { key, scope, workspaceKeys: [...WORKSPACE_KEYS] },
                };
            }
        }
        return { ok: true, secret };
    }

    static assertEditable(
        key: string,
        scope: ConfigScope,
        hostEnv: NodeJS.ProcessEnv = process.env,
        options: { readonly enforceAllowlist?: boolean } = {},
    ): { readonly secret: boolean } {
        const decision = ConfigPolicy.checkEditable(key, scope, hostEnv, options);
        if (!decision.ok) {
            throw failConfig(decision.status, decision.code, decision.detail, {
                recovery: decision.recovery,
                ...decision.extensions,
            });
        }
        return { secret: decision.secret };
    }

    // {§operator-config-precedence} Validate typed knob values at write time so invalid settings are
    // refused immediately rather than deferred to the next turn.
    static validateValue(key: string, value: unknown): string {
        if (typeof value !== "string") {
            throw failConfig(400, "config-value-invalid", `${key} value must be a string.`, {
                key,
                recovery: "Provide a string value.",
            });
        }
        if (value.includes("\0") || !value.isWellFormed()) {
            throw failConfig(400, "config-value-invalid", `${key} contains invalid control or unpaired surrogate characters.`, {
                key,
                recovery: "Provide a well-formed UTF-8 string without NUL bytes.",
            });
        }
        if (BOOLEAN_FLAG_KEYS.has(key)) {
            if (value !== "0" && value !== "1") {
                throw failConfig(400, "config-value-invalid", `${key} must be '0' or '1'; got ${JSON.stringify(value)}.`, {
                    key,
                    recovery: "Use '1' to enable or '0' to disable.",
                });
            }
            return value;
        }
        if (SCOPE_KEYS.has(key)) {
            if (!isFileCreateScope(value)) {
                throw failConfig(
                    400,
                    "config-value-invalid",
                    `${key} must be one of ${FILE_CREATE_SCOPES.join(", ")}; got ${JSON.stringify(value)}.`,
                    { key, allowedValues: [...FILE_CREATE_SCOPES], recovery: `Use one of ${FILE_CREATE_SCOPES.join(", ")}.` },
                );
            }
            return value;
        }
        if (key === "PLURNK_SERVICE_PROPOSALS") {
            if (!(PROPOSAL_POLICIES as readonly string[]).includes(value)) {
                throw failConfig(
                    400,
                    "config-value-invalid",
                    `${key} must be one of ${PROPOSAL_POLICIES.join(", ")}; got ${JSON.stringify(value)}.`,
                    { key, allowedValues: [...PROPOSAL_POLICIES], recovery: `Use one of ${PROPOSAL_POLICIES.join(", ")}.` },
                );
            }
            return value;
        }
        if (key === "PLURNK_PROVIDERS_EFFORT") {
            if (!(EFFORTS as readonly string[]).includes(value)) {
                throw failConfig(
                    400,
                    "config-value-invalid",
                    `${key} must be one of ${EFFORTS.join(", ")}; got ${JSON.stringify(value)}.`,
                    { key, allowedValues: [...EFFORTS], recovery: `Use one of ${EFFORTS.join(", ")}.` },
                );
            }
            return value;
        }
        if (key === "PLURNK_SERVICE_EMISSION_HISTORY") {
            if (!(EMISSION_HISTORY_MODES as readonly string[]).includes(value)) {
                throw failConfig(
                    400,
                    "config-value-invalid",
                    `${key} must be one of ${EMISSION_HISTORY_MODES.join(", ")}; got ${JSON.stringify(value)}.`,
                    { key, allowedValues: [...EMISSION_HISTORY_MODES], recovery: `Use one of ${EMISSION_HISTORY_MODES.join(", ")}.` },
                );
            }
            return value;
        }
        if (INTEGER_MIN_MINUS_ONE_KEYS.has(key)) {
            const parsed = parseStrictInteger(value);
            if (parsed === null || parsed < -1) {
                throw failConfig(400, "config-value-invalid", `${key} must be an integer >= -1; got ${JSON.stringify(value)}.`, {
                    key,
                    recovery: "Use -1 for unlimited or a non-negative integer.",
                });
            }
            return String(parsed);
        }
        if (INTEGER_MIN_ZERO_KEYS.has(key)) {
            const parsed = parseStrictInteger(value);
            if (parsed === null || parsed < 0) {
                throw failConfig(400, "config-value-invalid", `${key} must be a non-negative integer; got ${JSON.stringify(value)}.`, {
                    key,
                    recovery: "Use a non-negative integer.",
                });
            }
            return String(parsed);
        }
        if (INTEGER_MIN_ONE_KEYS.has(key)) {
            const parsed = parseStrictInteger(value);
            if (parsed === null || parsed < 1) {
                throw failConfig(400, "config-value-invalid", `${key} must be a positive integer; got ${JSON.stringify(value)}.`, {
                    key,
                    recovery: "Use a positive integer.",
                });
            }
            return String(parsed);
        }
        if (key === "PLURNK_SERVICE_PROPOSAL_TIMEOUT_MS") {
            if (value.length === 0) return value;
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
                throw failConfig(
                    400,
                    "config-value-invalid",
                    `${key} must be empty or a positive finite number of milliseconds; got ${JSON.stringify(value)}.`,
                    { key, recovery: "Use an empty string for no deadline, or a positive millisecond timeout." },
                );
            }
            return value;
        }
        if (key === "PLURNK_SERVICE_BUDGET_PRESSURE") {
            if (!/^(?:100|[1-9]?\d)%$/u.test(value)) {
                throw failConfig(
                    400,
                    "config-value-invalid",
                    `${key} must be a percentage between 0% and 100%; got ${JSON.stringify(value)}.`,
                    { key, recovery: "Use a percentage such as '80%'." },
                );
            }
            return value;
        }
        return value;
    }

    // {§operator-config-precedence} {§operator-config-workspace-settings}
    // Compose outer and inner values for one key. Ceiling keys strictly narrow (most-restrictive-wins);
    // ordinary choice/definition keys let the inner tier override.
    static composeCeiling(key: string, outerValue: string | undefined, innerValue: string): string {
        if (outerValue === undefined || !CEILING_KEYS.has(key)) return innerValue;
        if (key === "PLURNK_SERVICE_GIT_ALLOWED" || key === "PLURNK_MEMBERS_AUTO_ADD") {
            return outerValue === "0" || innerValue === "0" ? "0" : innerValue;
        }
        if (key === "PLURNK_SERVICE_FILE_CREATE_SCOPE" || key === "PLURNK_SERVICE_MEMBERS_MODEL_SCOPE") {
            if (isFileCreateScope(outerValue) && isFileCreateScope(innerValue)) {
                return FileCreationPolicy.effective(outerValue, innerValue);
            }
            return outerValue;
        }
        if (key === "PLURNK_SERVICE_MAX_COMMANDS" || key === "PLURNK_SERVICE_MAX_TURNS") {
            const outer = parseStrictInteger(outerValue);
            const inner = parseStrictInteger(innerValue);
            if (outer === null) return innerValue;
            if (inner === null) return outerValue;
            const outerCap = outer < 0 ? Number.POSITIVE_INFINITY : outer;
            const innerCap = inner < 0 ? Number.POSITIVE_INFINITY : inner;
            const effective = Math.min(outerCap, innerCap);
            return Number.isFinite(effective) ? String(effective) : "-1";
        }
        return innerValue;
    }
}
