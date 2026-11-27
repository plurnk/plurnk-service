// {§operator-config-precedence} {§operator-config-workspace-settings}
// Dedicated client-only configuration plane (`service.config.{list,set,unset}` and
// `workspace.config.{list,set,unset}`), separate from `env:///`. Enforces ConfigPolicy's hard floor
// and fail-safe `PLURNK_SERVICE_CLIENT_CONFIG` allowlist, isolates secrets into ServiceSecretStore
// (never SQLite), and synchronizes service overrides with OperatorEnvCascade and warm workspaces.

import {
    Validator,
    isRecord,
    type ApplicationConfigPolicy,
    type ConfigEntry,
    type ConfigListQuery,
    type ConfigListResult,
    type ConfigMutationResult,
    type JsonSchema,
} from "@plurnk/plurnk-contracts";
import type { ModuleActionRegistration } from "@plurnk/plurnk-modules";
import ConfigPolicy from "../core/ConfigPolicy.ts";
import type { Db } from "../core/Db.ts";
import type HostPaths from "../core/HostPaths.ts";
import OperatorConfig from "../core/OperatorConfig.ts";
import type { ServiceConfigOverride } from "../core/OperatorEnvCascade.ts";
import ProviderInstantiate from "../core/ProviderInstantiate.ts";
import Results, { OperationFailureError } from "../core/results.ts";
import ServiceSecretStore from "../core/ServiceSecretStore.ts";
import WorkspaceConfig from "../core/WorkspaceConfig.ts";
import ExecEnv from "../schemes/exec-env.ts";
import ClientInput from "./client-input.ts";
import { daemonFailure } from "./daemon-results.ts";

export interface ConfigCascadeBridge {
    readonly hostEnv: () => NodeJS.ProcessEnv;
    readonly hostSources: () => ReadonlyMap<string, string>;
    readonly hostEffective: () => ReadonlyMap<string, string>;
    readonly sources: () => ReadonlyMap<string, string>;
    readonly defaultsMap: () => ReadonlyMap<string, { readonly value: string; readonly owner: string }>;
    readonly setServiceEntries: (entries: ReadonlyMap<string, ServiceConfigOverride>) => void;
}

const assertConfigParams = (params: Readonly<Record<string, unknown>>, requireValue: boolean): { readonly key: string; readonly value?: string } => {
    const key = params.key;
    if (typeof key !== "string" || key.length === 0) {
        throw new OperationFailureError(Results.failure(
            "daemon:config",
            "config-key-invalid",
            400,
            "key must be a non-empty string.",
            {},
            { field: "key", retryable: false },
        ));
    }
    if (!requireValue) return { key };
    const value = ConfigPolicy.validateValue(key, params.value);
    return { key, value };
};

const parseQuery = (params: Readonly<Record<string, unknown>>): ConfigListQuery => {
    try {
        return Validator.assertConfigListQuery(params);
    } catch (cause) {
        throw new OperationFailureError(Results.failure(
            "daemon:config",
            "config-query-invalid",
            400,
            cause instanceof Error ? cause.message : "Invalid configuration query.",
            {},
            { retryable: false },
        ), { cause });
    }
};

export interface ConfigChangedEvent {
    readonly workspaceId: number | null;
    readonly scope: "service" | "workspace";
    readonly key: string;
}

export default class ConfigService {
    readonly #db: Db;
    readonly #secrets: ServiceSecretStore;
    readonly #bridge: ConfigCascadeBridge | null;
    readonly #onServiceConfigChanged: () => Promise<void>;
    readonly #onConfigChanged: ((event: ConfigChangedEvent) => void) | undefined;
    // When Daemon runs standalone (without Service.main's OperatorEnvCascade, e.g. in tests),
    // track host baseline values for keys touched at service scope so unset and stop restore them cleanly.
    readonly #standaloneHostBaseline = new Map<string, string | undefined>();
    readonly #standaloneServiceEntries = new Map<string, ServiceConfigOverride>();

    constructor({
        db,
        hostPaths,
        bridge = null,
        onServiceConfigChanged,
        onConfigChanged,
    }: {
        readonly db: Db;
        readonly hostPaths: HostPaths;
        readonly bridge?: ConfigCascadeBridge | null;
        readonly onServiceConfigChanged: () => Promise<void>;
        readonly onConfigChanged?: (event: ConfigChangedEvent) => void;
    }) {
        this.#db = db;
        this.#secrets = new ServiceSecretStore(hostPaths);
        this.#bridge = bridge;
        this.#onServiceConfigChanged = onServiceConfigChanged;
        this.#onConfigChanged = onConfigChanged;
    }

    get secretStore(): ServiceSecretStore {
        return this.#secrets;
    }

    hostEnv(): NodeJS.ProcessEnv {
        if (this.#bridge !== null) return this.#bridge.hostEnv();
        if (this.#standaloneHostBaseline.size === 0) return process.env;
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const [key, baseline] of this.#standaloneHostBaseline) {
            if (baseline === undefined) delete env[key];
            else env[key] = baseline;
        }
        return env;
    }

    policy(): ApplicationConfigPolicy {
        const allowlist = ConfigPolicy.parseAllowlist(this.hostEnv());
        return {
            allowlist: [...allowlist],
            writable: ConfigPolicy.isAllowlistWritable(allowlist),
        };
    }

    // Load persisted non-secret rows from SQLite and encrypted secret rows from ServiceSecretStore.
    async loadServiceEntries(): Promise<Map<string, ServiceConfigOverride>> {
        const merged = new Map<string, ServiceConfigOverride>();
        if (this.#db.service_config_list !== undefined) {
            const rows = await this.#db.service_config_list.all<{ key: string; value: string }>();
            for (const { key, value } of rows) {
                if (ConfigPolicy.isHostOnly(key)) continue;
                merged.set(key, { value, secret: false });
            }
        }
        const secrets = await this.#secrets.load();
        for (const [key, value] of secrets) {
            if (ConfigPolicy.isHostOnly(key)) continue;
            merged.set(key, { value, secret: true });
        }
        return merged;
    }

    // Apply persisted service entries during Daemon.start().
    async hydrate(): Promise<void> {
        const entries = await this.loadServiceEntries();
        if (this.#bridge !== null) {
            this.#bridge.setServiceEntries(entries);
            await this.#onServiceConfigChanged();
            return;
        }
        this.#applyStandalone(entries);
    }

    // Restore process.env baseline when a standalone daemon (without an external cascade) stops.
    restoreStandalone(): void {
        if (this.#bridge !== null || this.#standaloneHostBaseline.size === 0) return;
        for (const [key, baseline] of this.#standaloneHostBaseline) {
            if (baseline === undefined) delete process.env[key];
            else process.env[key] = baseline;
        }
        this.#standaloneHostBaseline.clear();
        this.#standaloneServiceEntries.clear();
        ProviderInstantiate.advanceGeneration();
    }

    #applyStandalone(entries: ReadonlyMap<string, ServiceConfigOverride>): void {
        const hostEnv = this.hostEnv();
        // Restore any key removed from service entries.
        for (const key of [...this.#standaloneServiceEntries.keys()]) {
            if (entries.has(key)) continue;
            const baseline = this.#standaloneHostBaseline.get(key);
            if (baseline === undefined) delete process.env[key];
            else process.env[key] = baseline;
            this.#standaloneHostBaseline.delete(key);
            this.#standaloneServiceEntries.delete(key);
        }
        for (const [key, entry] of entries) {
            if (ConfigPolicy.isHostOnly(key)) continue;
            if (!this.#standaloneHostBaseline.has(key)) {
                this.#standaloneHostBaseline.set(key, process.env[key]);
            }
            const hostValue = this.#standaloneHostBaseline.get(key);
            process.env[key] = ConfigPolicy.composeCeiling(key, hostValue, entry.value);
            this.#standaloneServiceEntries.set(key, entry);
        }
        if (entries.size > 0 || hostEnv !== process.env) {
            ProviderInstantiate.advanceGeneration();
        }
    }

    async #syncServiceEntries(entries: ReadonlyMap<string, ServiceConfigOverride>): Promise<void> {
        if (this.#bridge !== null) {
            this.#bridge.setServiceEntries(entries);
            await this.#onServiceConfigChanged();
            return;
        }
        this.#applyStandalone(entries);
        await this.#onServiceConfigChanged();
    }

    #serviceEntryView(
        key: string,
        serviceEntries: ReadonlyMap<string, ServiceConfigOverride>,
        hostEnv: NodeJS.ProcessEnv,
    ): ConfigEntry | null {
        const defaults = this.#bridge?.defaultsMap();
        const hostSources = this.#bridge?.hostSources();
        const hostEffective = this.#bridge?.hostEffective();
        const override = serviceEntries.get(key);
        const hostVal = hostEffective !== undefined ? hostEffective.get(key) : hostEnv[key];
        const rawEffective = process.env[key];
        const def = defaults?.get(key);

        if (override === undefined && rawEffective === undefined && def === undefined) return null;

        const secret = override?.secret === true || OperatorConfig.isSecretKey(key, hostEnv);
        const effectiveValue = override !== undefined
            ? ConfigPolicy.composeCeiling(key, hostVal, override.value)
            : (rawEffective ?? def?.value ?? "");
        const redactedValue = OperatorConfig.redactValue(key, effectiveValue, hostEnv);
        const editable = ConfigPolicy.checkEditable(key, "service", hostEnv).ok;

        let origin: ConfigEntry["origin"];
        let source: string;
        let shadows: ConfigEntry["shadows"] | undefined;

        if (override !== undefined) {
            origin = "service";
            source = override.secret ? "service (secret)" : "service";
            const hostSource = hostSources?.get(key) ?? (hostVal !== undefined ? "process environment" : undefined);
            if (hostVal !== undefined && hostSource !== undefined && !hostSource.startsWith("defaults (") && effectiveValue !== hostVal) {
                shadows = {
                    origin: "host",
                    source: hostSource,
                    value: OperatorConfig.redactValue(key, hostVal, hostEnv),
                };
            }
        } else {
            const rawSource = this.#bridge?.sources().get(key)
                ?? (def !== undefined && rawEffective === def.value ? `defaults (${def.owner})` : "process environment");
            if (rawSource.startsWith("defaults (")) {
                origin = "default";
                source = rawSource;
            } else {
                origin = "host";
                source = rawSource;
            }
        }

        return {
            key,
            value: redactedValue,
            secret,
            origin,
            source,
            editable,
            ...(def === undefined ? {} : { owner: def.owner }),
            ...(shadows === undefined ? {} : { shadows }),
        };
    }

    inspectServiceKey(
        key: string,
        serviceEntries: ReadonlyMap<string, ServiceConfigOverride>,
    ): {
        readonly key: string;
        readonly secret: boolean;
        readonly configured: boolean;
        readonly origin?: "default" | "host" | "service";
        readonly source?: string;
        readonly value?: string;
        readonly editable: boolean;
    } {
        const hostEnv = this.hostEnv();
        const entry = this.#serviceEntryView(key, serviceEntries, hostEnv);
        const secret = entry?.secret ?? OperatorConfig.isSecretKey(key, hostEnv);
        const editable = entry?.editable ?? ConfigPolicy.checkEditable(key, "service", hostEnv).ok;
        const rawEffective = process.env[key];
        const configured = entry !== null
            && (entry.origin === "service" || entry.origin === "host" || (rawEffective !== undefined && rawEffective.length > 0))
            && entry.value.length > 0;
        const origin = entry?.origin === "default" || entry?.origin === "host" || entry?.origin === "service"
            ? entry.origin
            : undefined;
        return {
            key,
            secret,
            configured,
            ...(configured && origin !== undefined ? { origin } : {}),
            ...(configured && entry !== null ? { source: entry.source } : {}),
            ...(configured && entry !== null ? { value: entry.value } : {}),
            editable,
        };
    }

    async listService(rawQuery: Readonly<Record<string, unknown>> = {}): Promise<ConfigListResult> {
        const query = parseQuery(rawQuery);
        const hostEnv = this.hostEnv();
        const allowlist = ConfigPolicy.parseAllowlist(hostEnv);
        const serviceEntries = await this.loadServiceEntries();
        const defaults = this.#bridge?.defaultsMap();
        const providerCreds = ExecEnv.providerCredentialNames(hostEnv);

        const candidateKeys = new Set<string>();
        if (defaults !== undefined) {
            for (const key of defaults.keys()) candidateKeys.add(key);
        }
        for (const key of serviceEntries.keys()) candidateKeys.add(key);
        for (const key of Object.keys(process.env)) {
            if (
                key.startsWith("PLURNK_")
                || key.startsWith("OTEL_")
                || key === "TZ"
                || key === "OPENAI_BASE_URL"
                || providerCreds.has(key)
                || ConfigPolicy.matchesAllowlist(key, allowlist, hostEnv)
            ) {
                candidateKeys.add(key);
            }
        }

        const term = query.query?.toLowerCase();
        const entries: ConfigEntry[] = [];
        for (const key of [...candidateKeys].toSorted()) {
            const entry = this.#serviceEntryView(key, serviceEntries, hostEnv);
            if (entry === null) continue;
            if (query.origin !== undefined && entry.origin !== query.origin) continue;
            if (query.editableOnly === true && !entry.editable) continue;
            if (term !== undefined && !entry.key.toLowerCase().includes(term) && !(entry.summary ?? "").toLowerCase().includes(term)) {
                continue;
            }
            entries.push(entry);
        }

        return Validator.assertConfigListResult({
            scope: "service",
            entries,
            allowlist: [...allowlist],
        });
    }

    async setService(
        key: string,
        rawValue: unknown,
        options: { readonly enforceAllowlist?: boolean } = {},
    ): Promise<ConfigMutationResult> {
        const hostEnv = this.hostEnv();
        const { secret } = ConfigPolicy.assertEditable(key, "service", hostEnv, options);
        const value = ConfigPolicy.validateValue(key, rawValue);
        if (secret) {
            // Never persist secret values into SQLite; remove any stale plaintext row if present.
            if (this.#db.service_config_delete !== undefined) {
                await this.#db.service_config_delete.run({ key });
            }
            await this.#secrets.set(key, value);
        } else {
            await this.#db.service_config_put.run({ key, value });
            await this.#secrets.delete(key);
        }
        const entries = await this.loadServiceEntries();
        await this.#syncServiceEntries(entries);
        this.#onConfigChanged?.({ workspaceId: null, scope: "service", key });
        const entry = this.#serviceEntryView(key, entries, this.hostEnv());
        return Validator.assertConfigMutationResult({
            scope: "service",
            key,
            entry,
            removed: false,
        });
    }

    async unsetService(
        key: string,
        options: { readonly enforceAllowlist?: boolean } = {},
    ): Promise<ConfigMutationResult> {
        const hostEnv = this.hostEnv();
        ConfigPolicy.assertEditable(key, "service", hostEnv, options);
        let removed = false;
        if (this.#db.service_config_get !== undefined) {
            const existing = await this.#db.service_config_get.get<{ key: string }>({ key });
            if (existing !== undefined) {
                await this.#db.service_config_delete.run({ key });
                removed = true;
            }
        }
        const secretDeletion = await this.#secrets.delete(key);
        if (secretDeletion.removed) removed = true;
        const entries = await this.loadServiceEntries();
        await this.#syncServiceEntries(entries);
        if (removed) {
            this.#onConfigChanged?.({ workspaceId: null, scope: "service", key });
        }
        const entry = this.#serviceEntryView(key, entries, this.hostEnv());
        return Validator.assertConfigMutationResult({
            scope: "service",
            key,
            entry,
            removed,
        });
    }

    async #assertWorkspaceExists(workspaceId: number): Promise<void> {
        const row = await this.#db.envelope_get_workspace.get<{ id: number }>({ id: workspaceId });
        if (row === undefined) {
            throw daemonFailure("daemon:workspace", "workspace-not-found", 404, `Workspace ${workspaceId} does not exist.`, {
                workspaceId,
            });
        }
    }

    #workspaceEntryView(
        key: string,
        workspaceRaw: ReadonlyMap<string, string>,
        serviceEntries: ReadonlyMap<string, ServiceConfigOverride>,
        hostEnv: NodeJS.ProcessEnv,
    ): ConfigEntry | null {
        const base = this.#serviceEntryView(key, serviceEntries, hostEnv);
        const wsOverride = workspaceRaw.get(key);
        const editable = ConfigPolicy.checkEditable(key, "workspace", hostEnv).ok;

        if (wsOverride === undefined) {
            if (base === null) {
                return {
                    key,
                    value: "",
                    secret: false,
                    origin: "default",
                    source: "unset",
                    editable,
                };
            }
            return { ...base, editable };
        }

        const outerVal = process.env[key];
        const composed = ConfigPolicy.composeCeiling(key, outerVal, wsOverride);
        const shadows: ConfigEntry["shadows"] | undefined = base !== null && (base.origin === "host" || base.origin === "service")
            ? { origin: base.origin, source: base.source, value: base.value }
            : undefined;

        return {
            key,
            value: OperatorConfig.redactValue(key, composed, hostEnv),
            secret: false,
            origin: "workspace",
            source: "workspace",
            editable,
            ...(base?.owner === undefined ? {} : { owner: base.owner }),
            ...(shadows === undefined ? {} : { shadows }),
        };
    }

    async listWorkspace(workspaceId: number, rawQuery: Readonly<Record<string, unknown>> = {}): Promise<ConfigListResult> {
        const checkedId = ClientInput.assertId("workspace.config.list", "workspaceId", workspaceId);
        await this.#assertWorkspaceExists(checkedId);
        const query = parseQuery(rawQuery);
        const hostEnv = this.hostEnv();
        const allowlist = ConfigPolicy.parseAllowlist(hostEnv);
        const [workspaceRaw, serviceEntries] = await Promise.all([
            WorkspaceConfig.readRaw(this.#db, checkedId),
            this.loadServiceEntries(),
        ]);

        const term = query.query?.toLowerCase();
        const entries: ConfigEntry[] = [];
        for (const key of [...ConfigPolicy.WORKSPACE_CONFIG_KEYS].toSorted()) {
            const entry = this.#workspaceEntryView(key, workspaceRaw, serviceEntries, hostEnv);
            if (entry === null) continue;
            if (query.origin !== undefined && entry.origin !== query.origin) continue;
            if (query.editableOnly === true && !entry.editable) continue;
            if (term !== undefined && !entry.key.toLowerCase().includes(term) && !(entry.summary ?? "").toLowerCase().includes(term)) {
                continue;
            }
            entries.push(entry);
        }

        return Validator.assertConfigListResult({
            scope: "workspace",
            entries,
            allowlist: [...allowlist],
        });
    }

    async setWorkspace(workspaceId: number, key: string, rawValue: unknown): Promise<ConfigMutationResult> {
        const checkedId = ClientInput.assertId("workspace.config.set", "workspaceId", workspaceId);
        await this.#assertWorkspaceExists(checkedId);
        const hostEnv = this.hostEnv();
        ConfigPolicy.assertEditable(key, "workspace", hostEnv);
        const value = ConfigPolicy.validateValue(key, rawValue);
        await WorkspaceConfig.put(this.#db, checkedId, key, value);
        this.#onConfigChanged?.({ workspaceId: checkedId, scope: "workspace", key });
        const [workspaceRaw, serviceEntries] = await Promise.all([
            WorkspaceConfig.readRaw(this.#db, checkedId),
            this.loadServiceEntries(),
        ]);
        const entry = this.#workspaceEntryView(key, workspaceRaw, serviceEntries, hostEnv);
        return Validator.assertConfigMutationResult({
            scope: "workspace",
            key,
            entry,
            removed: false,
        });
    }

    async unsetWorkspace(workspaceId: number, key: string): Promise<ConfigMutationResult> {
        const checkedId = ClientInput.assertId("workspace.config.unset", "workspaceId", workspaceId);
        await this.#assertWorkspaceExists(checkedId);
        const hostEnv = this.hostEnv();
        ConfigPolicy.assertEditable(key, "workspace", hostEnv);
        const removed = await WorkspaceConfig.remove(this.#db, checkedId, key);
        if (removed) {
            this.#onConfigChanged?.({ workspaceId: checkedId, scope: "workspace", key });
        }
        const [workspaceRaw, serviceEntries] = await Promise.all([
            WorkspaceConfig.readRaw(this.#db, checkedId),
            this.loadServiceEntries(),
        ]);
        const entry = this.#workspaceEntryView(key, workspaceRaw, serviceEntries, hostEnv);
        return Validator.assertConfigMutationResult({
            scope: "workspace",
            key,
            entry,
            removed,
        });
    }

    // Validate and normalize an optional `config` map supplied to `workspace.create`.
    parseWorkspaceCreateConfig(raw: unknown): ReadonlyMap<string, string> {
        const out = new Map<string, string>();
        if (raw === undefined || raw === null) return out;
        if (!isRecord(raw)) {
            throw new OperationFailureError(Results.failure(
                "daemon:input",
                "config-invalid",
                400,
                "config must be an object mapping configuration keys to string values.",
                {},
                { field: "config", stage: "input-validation", retryable: false },
            ));
        }
        const hostEnv = this.hostEnv();
        for (const [key, rawValue] of Object.entries(raw)) {
            ConfigPolicy.assertEditable(key, "workspace", hostEnv);
            out.set(key, ConfigPolicy.validateValue(key, rawValue));
        }
        return out;
    }

    actions(): readonly ModuleActionRegistration[] {
        const listInput: JsonSchema = { $ref: "https://schemas.plurnk.xyz/v0/ConfigListQuery.json" };
        const listOutput: JsonSchema = { $ref: "https://schemas.plurnk.xyz/v0/ConfigListResult.json" };
        const setInput: JsonSchema = {
            type: "object",
            additionalProperties: false,
            required: ["key", "value"],
            properties: {
                key: { type: "string", minLength: 1 },
                value: { type: "string" },
            },
        };
        const unsetInput: JsonSchema = {
            type: "object",
            additionalProperties: false,
            required: ["key"],
            properties: {
                key: { type: "string", minLength: 1 },
            },
        };
        const mutationOutput: JsonSchema = { $ref: "https://schemas.plurnk.xyz/v0/ConfigMutationResult.json" };
        return [
            {
                name: "service.config.list",
                scope: "daemon",
                residency: "none",
                inputSchema: listInput,
                outputSchema: listOutput,
                handler: (params) => this.listService(params),
            },
            {
                name: "service.config.set",
                scope: "daemon",
                residency: "none",
                inputSchema: setInput,
                outputSchema: mutationOutput,
                handler: (params) => {
                    const { key, value } = assertConfigParams(params, true);
                    return this.setService(key, value);
                },
            },
            {
                name: "service.config.unset",
                scope: "daemon",
                residency: "none",
                inputSchema: unsetInput,
                outputSchema: mutationOutput,
                handler: (params) => {
                    const { key } = assertConfigParams(params, false);
                    return this.unsetService(key);
                },
            },
            {
                name: "workspace.config.list",
                scope: "workspace",
                residency: "none",
                inputSchema: listInput,
                outputSchema: listOutput,
                handler: (params, context) => {
                    if (context.scope !== "workspace") throw new Error("workspace.config.list requires a workspace context.");
                    return this.listWorkspace(context.workspaceId, params);
                },
            },
            {
                name: "workspace.config.set",
                scope: "workspace",
                residency: "none",
                inputSchema: setInput,
                outputSchema: mutationOutput,
                handler: (params, context) => {
                    if (context.scope !== "workspace") throw new Error("workspace.config.set requires a workspace context.");
                    const { key, value } = assertConfigParams(params, true);
                    return this.setWorkspace(context.workspaceId, key, value);
                },
            },
            {
                name: "workspace.config.unset",
                scope: "workspace",
                residency: "none",
                inputSchema: unsetInput,
                outputSchema: mutationOutput,
                handler: (params, context) => {
                    if (context.scope !== "workspace") throw new Error("workspace.config.unset requires a workspace context.");
                    const { key } = assertConfigParams(params, false);
                    return this.unsetWorkspace(context.workspaceId, key);
                },
            },
        ];
    }
}
