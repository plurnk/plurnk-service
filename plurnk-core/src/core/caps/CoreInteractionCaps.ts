import type {
    ClientInteractionRequest,
    ClientInteractionResolution,
} from "@plurnk/plurnk-contracts";
import type { InteractionCaps } from "@plurnk/plurnk-schemes";
import type { PlurnkSchemeContext } from "../scheme-types.ts";

export default class CoreInteractionCaps implements InteractionCaps {
    readonly #ctx: PlurnkSchemeContext;

    constructor(ctx: PlurnkSchemeContext) {
        this.#ctx = ctx;
    }

    request(request: ClientInteractionRequest): Promise<ClientInteractionResolution> {
        const interact = this.#ctx.requestInteraction;
        if (interact === undefined) {
            throw new Error("Client interaction capability is unavailable for this operation.");
        }
        return interact(request);
    }
}
