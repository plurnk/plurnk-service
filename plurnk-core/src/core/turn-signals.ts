// The turn's terminal signals, engine problem kinds, and the implicit-continue status the turn paths share.

export const TERMINAL_SEND_SIGNALS = new Set([102, 200, 202, 499]);

export const ENGINE_PROBLEMS = Object.freeze({
    max_commands_exceeded: {
        status: 429,
        code: "max-commands-exceeded",
        detail: "Later operations were not executed because the turn exceeded its operation limit.",
    },
    idle_turn: {
        status: 409,
        code: "idle-turn",
        detail: "`## SEND0 (NEXT)` was emitted without an operation to continue from.",
    },
} as const);

// Runtime normalization for a disposition the engine refuses or resolves as a
// continue after dispatch ({§send}). Every admitted emission itself ends in an
// explicit disposition SEND ({§emission-admission}).
export const TURN_STATUS_IMPLICIT_CONTINUE = 102;
