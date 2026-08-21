#!/usr/bin/env node

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

import {
    aggregateProviderAccounting,
    instantiateProvider,
    parseAliasesFromEnv,
    ProviderError,
} from "../src/index.ts";
import { REASONING_POLICIES } from "@plurnk/plurnk-contracts";
import { resolveModel } from "@plurnk/plurnk-models";
import {
    redactText,
    sensitiveValuesFromEnv,
} from "./providers-ping.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;

const positiveInteger = (raw, name, { allowZero = false } = {}) => {
    const value = Number(raw);
    const floor = allowZero ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < floor) {
        throw new TypeError(`${name} must be a safe integer >= ${floor}; got ${JSON.stringify(raw)}`);
    }
    return value;
};

export const selectProbeAliases = (env, names) => {
    const aliases = new Map(parseAliasesFromEnv(env).map((alias) => [alias.alias, alias]));
    return names.map((name) => {
        const alias = aliases.get(name.toLowerCase());
        if (alias === undefined) throw new Error(`unknown provider alias ${JSON.stringify(name)}`);
        return alias;
    });
};

export const resolveProbeMaxOutputTokens = (mode, provider) => {
    if (mode === "configured") {
        const output = provider.outputBudget ?? null;
        if (output === null) throw new Error("configured mode requires a resolved output budget");
        return output;
    }
    if (mode === "model") {
        const output = provider.maxOutputTokens ?? null;
        if (output === null) throw new Error("model mode requires a known model output limit");
        return output;
    }
    return positiveInteger(mode, "--max-output-tokens");
};

export const buildProbePrompt = (chars, fill = "x") => {
    const count = positiveInteger(chars, "--prompt-chars", { allowZero: true });
    if (fill.length === 0) throw new TypeError("--fill must not be empty");
    const instruction = "Reply with exactly OK.";
    if (count === 0) return instruction;
    const repeated = fill.repeat(Math.ceil(count / fill.length)).slice(0, count);
    return `${instruction}\n\nPayload:\n${repeated}`;
};

const probeEnvironment = (env, alias, reasoning) => ({
    ...env,
    [`PLURNK_PROVIDERS_RAWBODY_${alias}`]: "0",
    [`PLURNK_PROVIDERS_RETRY_ATTEMPTS_${alias}`]: "0",
    [`PLURNK_PROVIDERS_TOP_LOGPROBS_${alias}`]: "off",
    ...(reasoning === undefined ? {} : { [`PLURNK_PROVIDERS_REASONING_${alias}`]: reasoning }),
});

const failureEvidence = (cause, sensitiveValues) => ({
    name: cause instanceof Error ? cause.name : typeof cause,
    message: redactText(cause instanceof Error ? cause.message : String(cause), sensitiveValues),
    ...(cause instanceof ProviderError
        ? {
            kind: cause.kind,
            status: cause.status,
            problem: {
                ...cause.problem,
                detail: redactText(cause.problem.detail, sensitiveValues),
            },
        }
        : {}),
});

export const probeRoute = async ({
    route,
    env,
    maxOutputTokensMode,
    prompt,
    reasoning,
    timeoutMs,
    dryRun,
    measureOnly,
    sensitiveValues,
}) => {
    const provider = await instantiateProvider(
        route.provider,
        probeEnvironment(env, route.alias, reasoning),
        route.model,
        undefined,
        undefined,
        route.baseUrl,
        route.alias,
    );
    const maxOutputTokens = resolveProbeMaxOutputTokens(maxOutputTokensMode, provider);
    const catalog = resolveModel(route.provider, route.model)?.info ?? null;
    const base = {
        alias: route.alias,
        provider: route.provider,
        model: route.model,
        contextWindow: provider.contextWindow,
        modelsDevMaxInputTokens: catalog?.maxInputTokens ?? null,
        modelsDevMaxOutputTokens: catalog?.maxOutputTokens ?? null,
        outputBudget: provider.outputBudget ?? null,
        reasoningBudget: provider.reasoningBudget ?? null,
        requestedMaxOutputTokens: maxOutputTokens,
        promptCharacters: prompt.length,
        reasoningMode: reasoning ?? "configured",
    };
    if (dryRun) return { ...base, status: "dry-run", accounting: aggregateProviderAccounting([]) };

    const startedAt = new Date().toISOString();
    let promptMeasurement;
    try {
        promptMeasurement = await provider.countPromptTokens(
            [{ role: "user", content: prompt }],
            AbortSignal.timeout(timeoutMs),
        );
        if (measureOnly) {
            return {
                ...base,
                startedAt,
                finishedAt: new Date().toISOString(),
                status: "measured",
                promptMeasurement,
                accounting: aggregateProviderAccounting([]),
            };
        }
        const response = await provider.generate({
            messages: [{ role: "user", content: prompt }],
            workerId: `token-envelope-probe-${crypto.randomUUID()}`,
            signal: AbortSignal.timeout(timeoutMs),
            maxOutputTokens,
            callKind: "bare",
        });
        return {
            ...base,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "response",
            promptMeasurement,
            returnedModel: response.assistant.model,
            finishReason: response.assistant.finishReason,
            responseCharacters: response.assistant.content.length,
            reasoningCharacters: response.assistant.reasoning?.length ?? 0,
            accounting: aggregateProviderAccounting(response.accounting),
        };
    } catch (cause) {
        const accounting = cause instanceof ProviderError
            ? aggregateProviderAccounting(cause.accounting)
            : aggregateProviderAccounting([]);
        return {
            ...base,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "error",
            ...(promptMeasurement === undefined ? {} : { promptMeasurement }),
            accounting,
            error: failureEvidence(cause, sensitiveValues),
        };
    }
};

const artifactRoot = (env) => {
    const configured = env.PLURNK_BENCHMARKS?.trim();
    return configured === undefined || configured.length === 0
        ? resolve(import.meta.dirname, "../../../..", "benchmarks")
        : resolve(process.cwd(), configured);
};

const main = async () => {
    const { values } = parseArgs({
        options: {
            alias: { type: "string", multiple: true },
            "max-output-tokens": { type: "string", default: "configured" },
            "prompt-chars": { type: "string", default: "0" },
            fill: { type: "string", default: "x" },
            reasoning: { type: "string" },
            "timeout-ms": { type: "string", default: String(DEFAULT_TIMEOUT_MS) },
            "dry-run": { type: "boolean", default: false },
            "measure-only": { type: "boolean", default: false },
            label: { type: "string", default: "token-envelope" },
        },
        strict: true,
    });
    const names = values.alias ?? [];
    if (names.length === 0) throw new Error("at least one --alias is required");
    if (values["dry-run"] && values["measure-only"]) {
        throw new Error("--dry-run and --measure-only are mutually exclusive");
    }
    if (values.reasoning !== undefined && !REASONING_POLICIES.includes(values.reasoning)) {
        throw new Error(`--reasoning must be one of ${REASONING_POLICIES.join(", ")}`);
    }
    const timeoutMs = positiveInteger(values["timeout-ms"], "--timeout-ms");
    const prompt = buildProbePrompt(values["prompt-chars"], values.fill);
    const routes = selectProbeAliases(process.env, names);
    const sensitiveValues = sensitiveValuesFromEnv(process.env);
    const root = artifactRoot(process.env);
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, `${values.label.replaceAll(/[^a-zA-Z0-9._-]+/g, "-")}-`));
    const records = [];

    for (const route of routes) {
        process.stdout.write(`${values["dry-run"] ? "INSPECT" : "CALL"} ${route.provider}/${route.model} (alias ${route.alias}; max ${values["max-output-tokens"]})\n`);
        const record = await probeRoute({
            route,
            env: process.env,
            maxOutputTokensMode: values["max-output-tokens"],
            prompt,
            reasoning: values.reasoning,
            timeoutMs,
            dryRun: values["dry-run"],
            measureOnly: values["measure-only"],
            sensitiveValues,
        });
        records.push(record);
        process.stdout.write(`${record.status.toUpperCase()} ${route.alias}: ${record.accounting.costUsd ?? "unknown"} USD; ${record.accounting.usage?.inputTokens ?? "unknown"} input, ${record.accounting.usage?.outputTokens ?? "unknown"} output\n`);
    }

    const encoded = `${JSON.stringify({
        createdAt: new Date().toISOString(),
        maxOutputTokensMode: values["max-output-tokens"],
        promptCharacters: prompt.length,
        records,
    }, null, 2)}\n`;
    if (sensitiveValues.some((value) => encoded.includes(value))) {
        throw new Error("refusing to persist sensitive token-envelope evidence");
    }
    const path = join(directory, "probe.json");
    await writeFile(path, encoded, { flag: "wx" });
    process.stdout.write(`token-envelope evidence ${path}\n`);
    process.exitCode = records.some(({ status }) => status === "error") ? 1 : 0;
};

if (import.meta.main) await main();
