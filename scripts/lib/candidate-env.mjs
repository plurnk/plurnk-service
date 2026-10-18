export const parseCandidateClientEnv = (raw) => {
    if (raw === undefined || raw === "") return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (cause) {
        throw new Error("PLURNK_CANDIDATE_CLIENT_ENV must be a JSON object with string values.", {
            cause,
        });
    }
    if (
        typeof parsed !== "object"
        || parsed === null
        || Array.isArray(parsed)
        || !Object.values(parsed).every((value) => typeof value === "string")
    ) {
        throw new Error("PLURNK_CANDIDATE_CLIENT_ENV must be a JSON object with string values.");
    }
    if ("PLURNK_HOST" in parsed || "PLURNK_PORT" in parsed) {
        throw new Error("PLURNK_CANDIDATE_CLIENT_ENV may not override candidate-owned daemon routing.");
    }
    return parsed;
};
