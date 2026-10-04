import { UNKNOWN_POSITION, type ReadStatement } from "@plurnk/plurnk-contracts";

export default class ReasoningView {
    // {§reasoning-operations} — initialization uses the same extraction as a provider-produced turn.
    static initialSource(program: string): string {
        const rationale = "This harness-generated turn surveys the workspace and available capabilities.";
        return `${rationale}\n\n${program}`;
    }

    // {§reasoning-initial-read} — the initialization turn's last operation reads its own rationale,
    // without a scope: whole when it fits, otherwise its size ({§context-fit}).
    static initialRead(workerName: string, loopSequence: number, turnSequence: number): ReadStatement {
        const pathname = `/${loopSequence}/${turnSequence}`;
        const target = {
            kind: "url" as const, scheme: "reasoning", raw: `reasoning://${workerName}${pathname}`, pathname,
            username: null, password: null, hostname: workerName, port: null, query: null, fragment: null,
        };
        return {
            op: "READ", aside: "inspect this turn's reasoning", metadata: null, matcher: null, body: null,
            target, lineMarker: null, position: UNKNOWN_POSITION,
        };
    }
}
