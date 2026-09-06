import { UNKNOWN_POSITION, type ReadStatement } from "@plurnk/plurnk-contracts";
import { scopeEnvToAlias, type Provider } from "@plurnk/plurnk-providers";
import type { Db } from "./Db.ts";
import ProviderInstantiate from "./ProviderInstantiate.ts";

export default class ReasoningView {
    static lines(provider: Provider): number {
        const key = "PLURNK_REASONING_VIEW_LINES";
        const env = scopeEnvToAlias(process.env, ProviderInstantiate.configurationAliasOf(provider) ?? "", [key]);
        const raw = env[key];
        const value = Number(raw);
        if (raw === undefined || !/^(?:-1|\d+)$/.test(raw) || !Number.isSafeInteger(value)) {
            throw new TypeError(`${key} must be -1, 0, or a positive integer.`);
        }
        return value;
    }

    static async initialReads(db: Db, workerId: number, provider: Provider): Promise<ReadStatement[]> {
        const limit = ReasoningView.lines(provider);
        if (limit === 0) return [];
        const resources = await db.reasoning_initial_reads.all<{ pathname: string }>({ worker_id: workerId });
        return resources.map(({ pathname }) => ({
            op: "READ", delimiter: "0", annotation: "prior turn reasoning", metadata: null, body: null,
            target: {
                kind: "url", scheme: "reasoning", raw: `reasoning://${pathname}`, pathname,
                username: null, password: null, hostname: null, port: null, query: null, fragment: null,
            },
            lineMarker: { marks: [1, limit] }, position: UNKNOWN_POSITION,
        }));
    }

    static bounded(statement: ReadStatement): ReadStatement {
        const end = statement.lineMarker?.marks[1];
        if (typeof end !== "number") throw new Error("An initial reasoning READ requires a numeric range.");
        return { ...statement, lineMarker: { marks: [1, end === -1 ? 16 : Math.min(16, end)] } };
    }
}
