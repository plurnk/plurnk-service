// The turn's terminal signals, engine problem kinds, and the implicit-continue status the turn paths share.

export const ENGINE_PROBLEMS = Object.freeze({
    max_commands_exceeded: {
        status: 429,
        code: "max-commands-exceeded",
        detail: "Later operations were not executed because the turn exceeded its operation limit.",
    },
    // {§empty-turn} — the strike is silent; the error row is how the model hears it.
    no_operation: {
        status: 422,
        code: "no-operation",
        detail: "The turn performed no operation.",
    },
} as const);

// Runtime normalization for a disposition the engine refuses or resolves as a
// continue after dispatch ({§send}). Every admitted emission itself ends in an
// explicit disposition ({§emission-admission}).
export const TURN_STATUS_IMPLICIT_CONTINUE = 102;
