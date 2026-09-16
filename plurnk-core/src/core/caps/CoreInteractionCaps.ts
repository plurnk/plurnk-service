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

    request(request: ClientInteractionRequest, signal?: AbortSignal): Promise<ClientInteractionResolution> {
        const interact = this.#ctx.requestInteraction;
        if (interact === undefined) {
            throw new Error("Client interaction capability is unavailable for this operation.");
        }
        const owner = this.#ctx.signal;
        return interact(request, signal === undefined ? owner
            : owner === undefined ? signal : AbortSignal.any([owner, signal]));
    }
}
