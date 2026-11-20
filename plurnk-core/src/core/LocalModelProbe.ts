import { isRecord, type ApplicationLocalModelCandidate, type ApplicationLocalModelDiscoveryResult } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import Results, { OperationFailureError } from "./results.ts";

const OLLAMA_LOOPBACK_ORIGIN = "http://127.0.0.1:11434";
const LLAMA_SERVER_LOOPBACK_ORIGIN = "http://127.0.0.1:8080";

const isLoopbackHostname = (hostname: string): boolean =>
    hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost";

const normalizeLoopbackOrigin = (raw: string | undefined, fallback: string, field: string): string => {
    if (raw === undefined || raw.trim().length === 0) return fallback;
    let parsed: URL;
    try {
        parsed = new URL(raw.trim());
    } catch {
        throw new OperationFailureError(
            Results.failure(
                "daemon:models",
                "invalid-probe-origin",
                400,
                `${field} is not a valid URL: ${JSON.stringify(raw)}.`,
                {},
                { field, stage: "input-validation", recovery: "Provide an http://127.0.0.1:<port> loopback origin.", retryable: false },
            ),
        );
    }
    if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        !isLoopbackHostname(parsed.hostname.toLowerCase()) ||
        parsed.username.length > 0 ||
        parsed.password.length > 0 ||
        (parsed.pathname !== "/" && parsed.pathname !== "") ||
        parsed.search.length > 0 ||
        parsed.hash.length > 0
    ) {
        throw new OperationFailureError(
            Results.failure(
                "daemon:models",
                "non-loopback-origin",
                400,
                `${field} must be a bare loopback origin (127.0.0.1, [::1], or localhost); got ${JSON.stringify(raw)}.`,
                {},
                { field, stage: "input-validation", recovery: "Use a loopback origin without credentials, path, or query.", retryable: false },
            ),
        );
    }
    return parsed.origin;
};

export interface LocalModelProbeOptions {
    readonly ollamaOrigin?: string;
    readonly llamaServerOrigin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly fetch?: typeof globalThis.fetch;
}

// {§operator-config-precedence} Loopback-only discovery of local Ollama and OpenAI-compatible llama-server endpoints.
export default class LocalModelProbe {
    static validateConfiguration(env: NodeJS.ProcessEnv = process.env): number {
        return Knob.integer("PLURNK_SERVICE_LOCAL_PROBE_TIMEOUT_MS", 1, env);
    }

    static async discover(options: LocalModelProbeOptions = {}): Promise<ApplicationLocalModelDiscoveryResult> {
        const timeoutMs = LocalModelProbe.validateConfiguration(options.env ?? process.env);
        const ollamaOrigin = normalizeLoopbackOrigin(options.ollamaOrigin, OLLAMA_LOOPBACK_ORIGIN, "ollamaOrigin");
        const llamaServerOrigin = normalizeLoopbackOrigin(options.llamaServerOrigin, LLAMA_SERVER_LOOPBACK_ORIGIN, "llamaServerOrigin");
        const fetchImpl = options.fetch ?? globalThis.fetch;

        const [ollamaModels, llamaModels] = await Promise.all([
            fetchImpl(`${ollamaOrigin}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) })
                .then(async (res): Promise<ApplicationLocalModelCandidate[]> => {
                    if (!res.ok) return [];
                    const doc: unknown = await res.json();
                    if (!isRecord(doc) || !Array.isArray(doc.models)) return [];
                    const out: ApplicationLocalModelCandidate[] = [];
                    const seen = new Set<string>();
                    for (const item of doc.models) {
                        const name = isRecord(item) && typeof item.name === "string" ? item.name.trim() : "";
                        if (name.length === 0 || seen.has(name)) continue;
                        seen.add(name);
                        out.push({
                            runtime: "ollama",
                            label: `Local Ollama (${name} at ${ollamaOrigin})`,
                            alias: "local",
                            selector: `ollama/${name}`,
                            origin: ollamaOrigin,
                            ...(ollamaOrigin !== OLLAMA_LOOPBACK_ORIGIN ? { baseUrl: ollamaOrigin } : {}),
                        });
                    }
                    return out;
                })
                .catch((): ApplicationLocalModelCandidate[] => []),
            fetchImpl(`${llamaServerOrigin}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
                .then(async (res): Promise<ApplicationLocalModelCandidate[]> => {
                    if (!res.ok) return [];
                    const doc: unknown = await res.json();
                    if (!isRecord(doc) || !Array.isArray(doc.data)) return [];
                    const out: ApplicationLocalModelCandidate[] = [];
                    const seen = new Set<string>();
                    for (const item of doc.data) {
                        const id = isRecord(item) && typeof item.id === "string" ? item.id.trim() : "";
                        if (id.length === 0 || seen.has(id)) continue;
                        seen.add(id);
                        out.push({
                            runtime: "llama-server",
                            label: `Local llama-server (${id} at ${llamaServerOrigin})`,
                            alias: "local",
                            selector: `openai/${id}`,
                            origin: llamaServerOrigin,
                            baseUrl: `${llamaServerOrigin}/v1`,
                        });
                    }
                    return out;
                })
                .catch((): ApplicationLocalModelCandidate[] => []),
        ]);

        return {
            candidates: [...ollamaModels, ...llamaModels],
        };
    }
}
