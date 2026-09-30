import { Validator, type A2AAgentDefinition as A2aAgentDefinition } from "@plurnk/plurnk-contracts";

// {§a2a-functionality}: environment and live admission share the same connection contract.
export const readDefinition = (value: unknown): A2aAgentDefinition => {
    const definition = Validator.assertA2aAgentDefinition(structuredClone(value) as A2aAgentDefinition);
    let url: URL;
    try {
        url = new URL(definition.url);
    } catch (cause) {
        throw new Error("url must be an absolute HTTP(S) URL.", { cause });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("url must be an absolute HTTP(S) URL.");
    if (definition.authorization !== undefined && Object.keys(definition.headers ?? {}).some((key) => key.toLowerCase() === "authorization")) {
        throw new Error("authorization conflicts with an Authorization header.");
    }
    return definition;
};
