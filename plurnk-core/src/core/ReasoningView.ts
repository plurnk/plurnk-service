import { UNKNOWN_POSITION, type ReadStatement } from "@plurnk/plurnk-contracts";
import { scopeEnvToAlias, type Provider } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";

export default class ReasoningView {
    // {§reasoning-initial-read} — the rationale's one Note: line is what the pattern READ below
    // plucks into the first packet, so the maneuver it teaches is shown working, not described
    // (Matt's line, 2026-09-13; the coordinate is inferable from the Worker block below the log).
    static initialSource(): string {
        return "This harness-generated turn surveys the workspace and available capabilities.\n"
            + "Note: Prior reasoning can be searched with the pattern filters.";
    }

    static readonly NOTE_PATTERN = "^Note:.*";

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

    // `pluck` says whether the runtime can apply a regex to text/plain; without that projection
    // (a standalone Engine with no mimetype handlers) the READ is the plain scoped observation.
    static initialRead(provider: Provider, loopSequence: number, turnSequence: number, pluck: boolean): ReadStatement | null {
        const limit = ReasoningView.lines(provider);
        if (limit === 0) return null;
        const pathname = `/${loopSequence}/${turnSequence}`;
        const target = {
            kind: "url" as const, scheme: "reasoning", raw: `reasoning://${pathname}`, pathname,
            username: null, password: null, hostname: null, port: null, query: null, fragment: null,
        };
        if (!pluck) {
            return {
                op: "READ", aside: "inspect this turn's reasoning", metadata: null, matcher: null, body: null,
                target, lineMarker: { marks: [1, limit] }, position: UNKNOWN_POSITION,
            };
        }
        return {
            op: "READ", aside: "pluck notes from this turn's reasoning", metadata: null, body: null,
            matcher: { dialect: "regex", raw: ReasoningView.NOTE_PATTERN, pattern: ReasoningView.NOTE_PATTERN, flags: "" },
            target, lineMarker: limit === -1 ? null : { marks: [1, limit] }, position: UNKNOWN_POSITION,
        };
    }
}
