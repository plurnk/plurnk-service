import {
    errnoCode,
    isRecord,
    type ApplicationOperatorEnvEntry,
} from "@plurnk/plurnk-contracts";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtempDisposable, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { parseEnv } from "node:util";
import ExecEnv from "../schemes/exec-env.ts";
import type HostPaths from "./HostPaths.ts";
import Results, { OperationFailureError } from "./results.ts";

// The client and the bench lanes read their own keys from the operator's file, too.
const FOREIGN = /^PLURNK_(?:CLIENT_|COMPOSITION_|BENCH|SWEBENCH_|PI_|CANDIDATE_)/u;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SAFE_UNQUOTED_VALUE = /^[A-Za-z0-9_./:@-]+$/u;

const BIND_TIME_EXACT = new Set([
    "PLURNK_HOST",
    "PLURNK_PORT",
    "PLURNK_SERVICE_DB_PATH",
    "PLURNK_SERVICE_STATE_ROOT",
    "PLURNK_AUTH",
    "PLURNK_SECRET",
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
        return BIND_TIME_EXACT.has(key) || key.startsWith("PLURNK_SERVICE_SQLITE_");
    }

    static isImmutableOverAcp(key: string): boolean {
        return OperatorConfig.isBindTimeKey(key) || key === "PLURNK_PASS";
    }

    static isSecretKey(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
        if (key === "OTEL_EXPORTER_OTLP_HEADERS") return true;
        if (/(?:^|_)(?:SECRET|PASS|PASSWORD|TOKEN|API_KEY|BEARER)$/u.test(key)) return true;
        if (!key.startsWith("PLURNK_") && ExecEnv.ownSecretTest(env)(key)) return true;
        return false;
    }

    static encodeDotenvValue(key: string, value: string): string | null {
        if (!ENV_NAME.test(key) || value.includes("\0") || value.includes("\r")) return null;
        let encoded: string;
        if (value.length === 0) {
            encoded = "''";
        } else if (SAFE_UNQUOTED_VALUE.test(value)) {
            encoded = value;
        } else if (!value.includes("'") && !value.includes("\n")) {
            encoded = `'${value}'`;
        } else if (!value.includes("\"")) {
            encoded = `"${value.replaceAll("\n", "\\n")}"`;
        } else {
            return null;
        }
        const check = parseEnv(`${key}=${encoded}\n`);
        return check[key] === value ? encoded : null;
    }

    // {§operator-config-precedence} Atomic 0600 upsert/unset onto the operator .env file, preserving comments and line order.
    static async upsert(
        filePath: string,
        updates: Readonly<Record<string, string | null>>,
    ): Promise<void> {
        if (!isRecord(updates) || Object.keys(updates).length === 0) {
            throw new OperationFailureError(
                Results.failure(
                    "daemon:operator-env",
                    "empty-env-updates",
                    400,
                    "Operator environment update requires at least one key.",
                    {},
                    { stage: "input-validation", recovery: "Provide one or more { KEY: value | null } updates.", retryable: false },
                ),
            );
        }

        const encodedUpdates = new Map<string, string | null>();
        for (const [key, value] of Object.entries(updates)) {
            if (!ENV_NAME.test(key)) {
                throw new OperationFailureError(
                    Results.failure(
                        "daemon:operator-env",
                        "invalid-env-name",
                        400,
                        `'${key}' is not a valid environment variable name.`,
                        {},
                        { key, stage: "input-validation", recovery: "Use ASCII letters, digits, and underscores starting with a letter or underscore.", retryable: false },
                    ),
                );
            }
            if (OperatorConfig.isImmutableOverAcp(key)) {
                throw new OperationFailureError(
                    Results.failure(
                        "daemon:operator-env",
                        "env-key-bind-time",
                        403,
                        `'${key}' governs listener binding, storage, or authentication and cannot be modified over ACP.`,
                        {},
                        { key, configFile: filePath, stage: "authorization", recovery: `Edit ${filePath} on the host and restart the daemon.`, retryable: false },
                    ),
                );
            }
            if (value === null) {
                encodedUpdates.set(key, null);
                continue;
            }
            if (typeof value !== "string") {
                throw new OperationFailureError(
                    Results.failure(
                        "daemon:operator-env",
                        "invalid-env-value",
                        400,
                        `Value for '${key}' must be a string or null.`,
                        {},
                        { key, stage: "input-validation", retryable: false },
                    ),
                );
            }
            const encoded = OperatorConfig.encodeDotenvValue(key, value);
            if (encoded === null) {
                throw new OperationFailureError(
                    Results.failure(
                        "daemon:operator-env",
                        "invalid-env-value",
                        400,
                        `Value for '${key}' cannot be represented in ${filePath}.`,
                        {},
                        { key, stage: "input-validation", recovery: "Remove NUL/CR characters or mixed single and double quotes with newlines.", retryable: false },
                    ),
                );
            }
            encodedUpdates.set(key, encoded);
        }

        const parentDir = dirname(filePath);
        await mkdir(parentDir, { recursive: true, mode: 0o700 });
        let existing = "";
        try {
            existing = await readFile(filePath, "utf8");
        } catch (cause) {
            if (errnoCode(cause) !== "ENOENT") throw cause;
        }
        const lines = existing.length > 0 ? existing.replace(/\r\n/gu, "\n").split("\n") : [];
        if (lines.at(-1) === "") lines.pop();

        const handled = new Set<string>();
        const rewritten: string[] = [];
        for (const line of lines) {
            const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
            if (match !== null && encodedUpdates.has(match[1])) {
                const key = match[1];
                if (!handled.has(key)) {
                    handled.add(key);
                    const encoded = encodedUpdates.get(key) ?? null;
                    if (encoded !== null) rewritten.push(`${key}=${encoded}`);
                }
                continue;
            }
            rewritten.push(line);
        }
        for (const [key, encoded] of encodedUpdates) {
            if (!handled.has(key) && encoded !== null) {
                rewritten.push(`${key}=${encoded}`);
            }
        }
        const nextText = rewritten.length > 0 ? `${rewritten.join("\n")}\n` : "";

        await using stage = await mkdtempDisposable(join(parentDir, `.${basename(filePath)}-`));
        const stagedPath = join(stage.path, basename(filePath));
        await writeFile(stagedPath, nextText, { encoding: "utf8", mode: 0o600 });
        try {
            await chmod(stagedPath, 0o600);
        } catch {
            // Ignore chmod errors on filesystems without POSIX mode bits.
        }
        await rename(stagedPath, filePath);
    }

    static async projectEntries({
        configFile,
        env = process.env,
        sources,
        defaultsMap,
    }: {
        readonly configFile: string;
        readonly env?: NodeJS.ProcessEnv;
        readonly sources?: ReadonlyMap<string, string>;
        readonly defaultsMap?: ReadonlyMap<string, { readonly value: string; readonly owner: string }>;
    }): Promise<ApplicationOperatorEnvEntry[]> {
        let fileParsed: Record<string, string | undefined> = {};
        try {
            fileParsed = parseEnv(await readFile(configFile, "utf8"));
        } catch (cause) {
            if (errnoCode(cause) !== "ENOENT") throw cause;
        }
        const secretTest = ExecEnv.ownSecretTest(env);
        const candidateKeys = new Set<string>();
        for (const key of Object.keys(fileParsed)) {
            if (ENV_NAME.test(key)) candidateKeys.add(key);
        }
        for (const [key, rawValue] of Object.entries(env)) {
            if (rawValue === undefined || !ENV_NAME.test(key)) continue;
            const source = sources?.get(key);
            if (source !== undefined && source.startsWith("defaults (")) continue;
            const def = defaultsMap?.get(key);
            if (def !== undefined && rawValue === def.value && source === undefined) continue;
            const isProviderSecret = !key.startsWith("PLURNK_") && secretTest(key);
            const isModelOrOperatorKey = key.startsWith("PLURNK_MODEL") || key.startsWith("PLURNK_BASEURL_") || (key.startsWith("PLURNK_") && def !== undefined && rawValue !== def.value);
            const fromExplicitSource = source !== undefined && source !== "process environment" && !source.startsWith("defaults (");
            if (isProviderSecret || isModelOrOperatorKey || fromExplicitSource) {
                candidateKeys.add(key);
            }
        }

        const out: ApplicationOperatorEnvEntry[] = [];
        for (const key of [...candidateKeys].toSorted()) {
            const inFile = Object.hasOwn(fileParsed, key) && fileParsed[key] !== undefined;
            const effectiveValue = env[key] ?? fileParsed[key] ?? "";
            const effectiveSource = sources?.get(key) ?? (inFile ? configFile : "process environment");
            const overriddenBy =
                inFile && effectiveSource !== configFile && !effectiveSource.startsWith("defaults (")
                    ? effectiveSource
                    : undefined;
            const secret = OperatorConfig.isSecretKey(key, env);
            out.push({
                key,
                configured: effectiveValue.length > 0,
                secret,
                ...(secret ? {} : { value: effectiveValue }),
                source: effectiveSource,
                ...(overriddenBy !== undefined ? { overriddenBy } : {}),
            });
        }
        return out;
    }

    // {§credential-authority} — the seed teaches the posture and mints nothing: the daemon mints its
    // own durable operator secret into `secret` beside its database, where the operator's tools read
    // it, so a fresh install authenticates without a line set here.
    static renderSeed(): string {
        return [
            "# Plurnk user configuration. This file is yours and is never overwritten.",
            "# Full installed options: plurnk-service config defaults",
            "# Validate this cascade: plurnk-service config check",
            "#",
            "# Authentication is on (PLURNK_AUTH=1): your tools present credentials this daemon issues.",
            "# The daemon maintains its durable client secret in the file `secret` beside its database,",
            "# where your own tools read it; set one here instead for a tool on another host or under",
            "# another user. Anything that can reach the port can drive the daemon.",
            "# PLURNK_SECRET=",
            "# A remote browser signs in with PLURNK_PASS; on this host, `plurnk web` signs in directly.",
            "# PLURNK_PASS=",
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
