#!/usr/bin/env node

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
    aggregateProviderAccounting,
    instantiateProvider,
    parseAliasesFromEnv,
    ProviderError,
} from "../src/index.ts";
import {
    lookupProvider,
    providerCatalogSnapshot,
    resolveModel,
} from "@plurnk/plurnk-models";

const PING_INPUT_WEIGHT = 16;
const PING_MAX_TOKENS = 16;
const PING_TIMEOUT_MS = 120_000;
const CREDENTIAL_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|ACCESS_KEY|PASSWORD|CREDENTIAL)(?:_|$)/;
const SENSITIVE_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|ACCESS_KEY|PASSWORD|CREDENTIAL|ACCOUNT|PROJECT_ID|TENANT|ORGANIZATION|BASE_URL)(?:_|$)/;

const envPrefix = (provider) => provider.replaceAll(/[^a-zA-Z0-9]/g, "_").toUpperCase();

const configuredCredentialNames = (provider, env, catalog) => {
    if (provider === "plurnk") return ["PLURNK_API_KEY"];
    const configured = env[`PLURNK_PROVIDERS_PROVIDER_${envPrefix(provider)}_API_KEY_ENV`];
    const names = configured === undefined || configured.length === 0
        ? catalog?.env ?? []
        : configured.split(",").map((name) => name.trim()).filter(Boolean);
    return names.filter((name) => CREDENTIAL_NAME.test(name));
};

const providerDescriptor = (provider, env) => {
    const catalog = lookupProvider(provider);
    return {
        id: catalog?.id ?? provider,
        credentialNames: configuredCredentialNames(provider, env, catalog),
    };
};

const hasCredential = (names, env) => names.some((name) => {
    const value = env[name];
    return value !== undefined && value.length > 0;
});

const routeScore = ({ provider, model }) => {
    const cost = resolveModel(provider, model)?.info.cost;
    return cost === undefined
        ? null
        : (PING_INPUT_WEIGHT * cost.inputPer1M + PING_MAX_TOKENS * cost.outputPer1M) / 1_000_000;
};

const selectRoute = (id, aliases) => {
    const priced = aliases
        .map((alias) => ({ alias, score: routeScore(alias) }))
        .filter(({ score }) => score !== null)
        .toSorted((a, b) => a.score - b.score || a.alias.alias.localeCompare(b.alias.alias));
    if (priced.length > 0) {
        return { ...priced[0].alias, selection: "Models.dev rates" };
    }

    const named = aliases.filter(({ alias, provider }) => alias === provider || alias === id);
    if (named.length === 1) return { ...named[0], selection: "provider-named alias" };
    if (aliases.length === 1) return { ...aliases[0], selection: "only declared route" };
    return null;
};

export const planProviderPings = (env = process.env) => {
    const aliases = parseAliasesFromEnv(env);
    const byProvider = new Map();
    for (const alias of aliases) {
        const descriptor = providerDescriptor(alias.provider, env);
        const group = byProvider.get(descriptor.id) ?? {
            id: descriptor.id,
            display: alias.provider,
            credentialNames: new Set(),
            aliases: [],
        };
        for (const name of descriptor.credentialNames) group.credentialNames.add(name);
        group.aliases.push(alias);
        byProvider.set(descriptor.id, group);
    }

    const keyed = new Set();
    for (const [id, catalog] of Object.entries(providerCatalogSnapshot())) {
        const names = catalog.env.filter((name) => CREDENTIAL_NAME.test(name));
        if (hasCredential(names, env)) keyed.add(id);
    }
    if (env.PLURNK_API_KEY !== undefined && env.PLURNK_API_KEY.length > 0) keyed.add("plurnk");
    for (const group of byProvider.values()) {
        if (hasCredential([...group.credentialNames], env)) keyed.add(group.id);
    }

    const routes = [];
    const unkeyed = [];
    const unrouted = [];
    for (const group of byProvider.values()) {
        if (!keyed.has(group.id)) {
            unkeyed.push(group.display);
            continue;
        }
        keyed.delete(group.id);
        const selected = selectRoute(group.id, group.aliases);
        if (selected === null) {
            unrouted.push(group.display);
            continue;
        }
        routes.push(selected);
    }
    unrouted.push(...keyed);

    return {
        routes: routes.toSorted((a, b) => a.provider.localeCompare(b.provider)),
        unkeyed: [...new Set(unkeyed)].toSorted(),
        unrouted: [...new Set(unrouted)].toSorted(),
    };
};

export const responseShape = (value, seen = new WeakSet()) => {
    if (value === null) return "null";
    if (Array.isArray(value)) {
        const shapes = value.map((item) => responseShape(item, seen));
        return [...new Map(shapes.map((shape) => [JSON.stringify(shape), shape])).values()];
    }
    if (typeof value !== "object") return typeof value;
    if (seen.has(value)) return "circular";
    seen.add(value);
    return Object.fromEntries(Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, responseShape(item, seen)]));
};

export const redactText = (value, sensitiveValues) => {
    let redacted = String(value);
    for (const sensitive of [...new Set(sensitiveValues)]
        .filter((item) => item.length >= 4)
        .toSorted((a, b) => b.length - a.length)) {
        redacted = redacted.replaceAll(sensitive, "__redacted__");
    }
    return redacted
        .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi, "$1__redacted__@")
        .replaceAll(/([?&][^=\s&#]+)=([^&#\s]*)/g, "$1=__redacted__");
};

export const sensitiveValuesFromEnv = (env) => {
    const names = new Set(Object.keys(env).filter((name) => SENSITIVE_NAME.test(name)));
    for (const provider of Object.values(providerCatalogSnapshot())) {
        for (const name of provider.env) names.add(name);
    }
    for (const [name, value] of Object.entries(env)) {
        if (!name.startsWith("PLURNK_PROVIDERS_PROVIDER_") || !name.endsWith("_API_KEY_ENV")) continue;
        for (const declared of value?.split(",") ?? []) names.add(declared.trim());
    }
    return [...names].flatMap((name) => {
        const value = env[name];
        return value === undefined || value.length < 4 ? [] : [value];
    });
};

const safeSegment = (value) => value.replaceAll(/[^a-zA-Z0-9._-]+/g, "-") || "provider";

export const writePingRecord = async (directory, record, sensitiveValues) => {
    const json = `${JSON.stringify(record, null, 2)}\n`;
    if (sensitiveValues.some((value) => value.length >= 4 && json.includes(value))) {
        throw new Error("refusing to persist sensitive provider-ping evidence");
    }
    const path = join(directory, `${safeSegment(record.provider)}.json`);
    await writeFile(path, json, { flag: "wx" });
    return path;
};

export const executePingRoutes = async (routes, execute) => Promise.all(routes.map(execute));

export const pingRunIsRed = (plan, records) =>
    plan.unrouted.length > 0
    || (plan.routes !== undefined && records.length !== plan.routes.length)
    || records.some(({ status, retained = true }) => status !== "response" || !retained);

const pingEnvironment = (env, alias) => ({
    ...env,
    [`PLURNK_PROVIDERS_RAWBODY_${alias}`]: "1",
    [`PLURNK_PROVIDERS_REASONING_${alias}`]: "off",
    [`PLURNK_PROVIDERS_RETRY_ATTEMPTS_${alias}`]: "0",
    [`PLURNK_PROVIDERS_TOP_LOGPROBS_${alias}`]: "off",
});

export const pingRequest = (route) => {
    const workerId = `providers-ping-${route.provider}`;
    return {
        messages: [{ role: "user", content: "Reply with OK." }],
        workerId,
        primaryWorkerId: workerId,
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
        maxTokens: PING_MAX_TOKENS,
    };
};

const accountingEvidence = (requests) => {
    return { accounting: aggregateProviderAccounting(requests) };
};

const responseEvidence = (response) => {
    const raw = response.rawBody ?? response.assistantRaw;
    return {
        returnedModel: response.assistant.model,
        finishReason: response.assistant.finishReason,
        ...accountingEvidence(response.accounting),
        responseShape: responseShape(raw),
        responseShapeSource: response.rawBody === undefined ? "assistantRaw" : "rawBody",
    };
};

const errorEvidence = (cause, sensitiveValues) => ({
    name: cause instanceof Error ? cause.name : typeof cause,
    ...(cause instanceof ProviderError ? { kind: cause.kind, status: cause.status } : {}),
    message: redactText(cause instanceof Error ? cause.message : String(cause), sensitiveValues),
});

const invokeRoute = async (route, env, sensitiveValues) => {
    const startedAt = new Date().toISOString();
    let provider;
    try {
        provider = await instantiateProvider(
            route.provider,
            pingEnvironment(env, route.alias),
            route.model,
            undefined,
            undefined,
            route.baseUrl,
            route.alias,
        );
        const response = await provider.generate(pingRequest(route));
        return {
            provider: route.provider,
            alias: route.alias,
            model: route.model,
            selection: route.selection,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "response",
            ...responseEvidence(response),
        };
    } catch (cause) {
        const attempt = cause instanceof ProviderError ? cause.attempt : undefined;
        return {
            provider: route.provider,
            alias: route.alias,
            model: route.model,
            selection: route.selection,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "error",
            ...(cause instanceof ProviderError
                ? {
                    ...accountingEvidence(cause.accounting),
                    ...(attempt === undefined ? {} : responseEvidence(attempt)),
                }
                : accountingEvidence([])),
            error: errorEvidence(cause, sensitiveValues),
        };
    }
};

const artifactRoot = (env) => {
    const configured = env.PLURNK_BENCHMARKS?.trim();
    return configured === undefined || configured.length === 0
        ? resolve(import.meta.dirname, "../../../..", "benchmarks")
        : resolve(process.cwd(), configured);
};

const formatCost = (costUsd) => costUsd === null ? "unknown" : `${costUsd} USD`;

const main = async () => {
    const plan = planProviderPings(process.env);
    const root = artifactRoot(process.env);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "providers-ping-"));
    const sensitiveValues = sensitiveValuesFromEnv(process.env);

    process.stdout.write(`provider pings: evidence ${directory}\n`);
    for (const route of plan.routes) {
        process.stdout.write(`CALL ${route.provider}/${route.model} (alias ${route.alias}; ${route.selection})\n`);
    }
    for (const provider of plan.unkeyed) process.stdout.write(`SKIP ${provider}: no credential configured\n`);
    for (const provider of plan.unrouted) process.stdout.write(`RED ${provider}: credential configured but no unambiguous declared route\n`);

    const records = await executePingRoutes(plan.routes, async (route) => {
        const record = await invokeRoute(route, process.env, sensitiveValues);
        try {
            const path = await writePingRecord(directory, record, sensitiveValues);
            process.stdout.write(
                `${record.status === "response" ? "PASS" : "RED"} ${route.provider}/${route.model}: `
                + `${formatCost(record.accounting.costUsd)}; evidence ${path}\n`,
            );
            return { ...record, retained: true };
        } catch (cause) {
            process.stderr.write(`RED ${route.provider}/${route.model}: evidence retention failed (${redactText(cause, sensitiveValues)})\n`);
            return { ...record, retained: false };
        }
    });

    const red = plan.routes.length === 0 || pingRunIsRed(plan, records);
    process.stdout.write(
        `provider pings: ${records.filter(({ status }) => status === "response").length} response, `
        + `${records.filter(({ status }) => status !== "response").length} error, `
        + `${plan.unkeyed.length} skipped, ${plan.unrouted.length} unrouted; ${red ? "RED" : "PASS"}\n`,
    );
    process.exitCode = red ? 1 : 0;
};

if (import.meta.main) await main();
