import { PlurnkParser, UNKNOWN_POSITION, type ReadStatement } from "@plurnk/plurnk-contracts";
import { scopeEnvToAlias, type Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";

export default class ReasoningView {
    static initialSource(loopSequence: number, turnSequence: number): string {
        const example = PlurnkParser.frame(`READ (reasoning:///${loopSequence}/${turnSequence + 1}) <1,-1>`, null);
        return "This harness-generated turn surveys the workspace and available capabilities.\n"
            + `In turn ${turnSequence + 1}, use ${example} to retain your reasoning in subsequent packets.`;
    }

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

    static initialRead(provider: Provider, loopSequence: number, turnSequence: number): ReadStatement | null {
        const limit = ReasoningView.lines(provider);
        if (limit === 0) return null;
        const pathname = `/${loopSequence}/${turnSequence}`;
        return {
            op: "READ", annotation: "inspect this turn's reasoning", metadata: null, body: null,
            target: {
                kind: "url", scheme: "reasoning", raw: `reasoning://${pathname}`, pathname,
                username: null, password: null, hostname: null, port: null, query: null, fragment: null,
            },
            lineMarker: { marks: [1, limit] }, position: UNKNOWN_POSITION,
        };
    }
}
