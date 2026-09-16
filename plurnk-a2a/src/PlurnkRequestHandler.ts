import type { AgentCard, SendMessageRequest } from "@a2a-js/sdk";
import { DefaultRequestHandler, type ServerCallContext } from "@a2a-js/sdk/server";
import type PlurnkAgentExecutor from "./PlurnkAgentExecutor.ts";
import type PlurnkTaskStore from "./PlurnkTaskStore.ts";

// Admission errors belong to the request, before the SDK starts Task execution.
// Execution errors belong to the Task. {§a2a-inbound-exposure}
export default class PlurnkRequestHandler extends DefaultRequestHandler {
    readonly #executor: PlurnkAgentExecutor;

    constructor(card: AgentCard, store: PlurnkTaskStore, executor: PlurnkAgentExecutor) {
        super(card, store, executor);
        this.#executor = executor;
    }

    override async sendMessage(params: SendMessageRequest, context: ServerCallContext) {
        await this.#executor.validateMessage(params.message);
        return super.sendMessage(params, context);
    }

    override async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext) {
        await this.#executor.validateMessage(params.message);
        yield* super.sendMessageStream(params, context);
    }
}
