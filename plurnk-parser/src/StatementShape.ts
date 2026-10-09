import type { KillStatement, PlurnkOp } from "@plurnk/plurnk-contracts";

type BodyShape = "none" | "text" | "prose" | "mutation" | "distillation";
type Selection = Pick<KillStatement, "target" | "lineMarker" | "metadata">;

// {§op-shapes} {§kill-scope}: semantic shape after the grammar has bound the slots.
export default class StatementShape {
    static readonly #BODIES = {
        FIND: "none", READ: "none", EDIT: "mutation", COPY: "none", MOVE: "none",
        SEND: "prose", BARE: "prose", WORK: "prose", FORK: "prose",
        NOTE: "text", WAIT: "text", KILL: "text",
    } as const satisfies Record<PlurnkOp, BodyShape>;

    static body(op: string, selection?: Selection): BodyShape {
        if (op === "KILL" && selection !== undefined) {
            const { target } = selection;
            return target?.kind === "url" && target.scheme === "log" ? "distillation" : "none";
        }
        return StatementShape.#BODIES[op as PlurnkOp] ?? "text";
    }

    static requiresTarget(op: string): boolean {
        return ["FIND", "READ", "EDIT", "COPY", "MOVE", "KILL"].includes(op);
    }

    // {§parse-recovery} — the working form of an operation, for a diagnostic that refused its heading.
    static workingForm(op: string, exec: boolean): string | undefined {
        if (exec) return `\`${op} (program)? [{"cwd": "…"}]?\` on the opening fence line, the input on the lines below, then the closing fence.`;
        const forms: Readonly<Record<string, string>> = {
            FIND: "`FIND (path or glob) <first,last>? pattern? <!-- aside -->?` on the opening fence line; FIND takes no body.",
            READ: "`READ (path) <L,M>? pattern? <!-- aside -->?` on the opening fence line; READ takes no body.",
            EDIT: "`EDIT (path) <scope>` on the opening fence line, the replacement text on the lines below, then the closing fence.",
            COPY: "`COPY (from) <scope>? (to) <scope>?` on the opening fence line; COPY takes no body.",
            MOVE: "`MOVE (from) <scope>? (to) <scope>?` on the opening fence line; MOVE takes no body.",
            KILL: "`KILL (path) <L,M>?` on the opening fence line.",
            SEND: "`SEND (recipient)?` on the opening fence line, the message on the lines below, then the closing fence.",
            WORK: "`WORK (worker://name)?` on the opening fence line, the child's task on the lines below, then the closing fence.",
            FORK: "`FORK (worker://name)?` on the opening fence line, the child's task on the lines below, then the closing fence.",
            BARE: "`BARE (path)?` on the opening fence line, the prompt on the lines below, then the closing fence.",
            NOTE: "`NOTE` alone on the opening fence line, the note on the lines below, then the closing fence.",
            WAIT: "`WAIT (path)? [seconds]?` on the opening fence line, any body on the lines below, then the closing fence.",
            LOOK: "`LOOK (path) <scope>?` on the opening fence line, the matcher on the line below.",
        };
        return forms[op];
    }
}
