import { UNKNOWN_POSITION, type ReadStatement } from "@plurnk/plurnk-contracts";
import { scopeEnvToAlias, type Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

export default class ReasoningView {
    // {§reasoning-notes} — initialization uses the same extraction as a provider-produced turn.
    static initialSource(): string {
        return "This harness-generated turn surveys the workspace and available capabilities.\n\n"
            + PlurnkParser.frame("NOTE", "Only NOTE also works in reasoning. Notes retain conclusions, decisions, and working memory.");
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
        const target = {
            kind: "url" as const, scheme: "reasoning", raw: `reasoning://${pathname}`, pathname,
            username: null, password: null, hostname: null, port: null, query: null, fragment: null,
        };
        return {
            op: "READ", aside: "inspect this turn's reasoning", metadata: null, matcher: null, body: null,
            target, lineMarker: { marks: [1, limit] }, position: UNKNOWN_POSITION,
        };
    }
}
