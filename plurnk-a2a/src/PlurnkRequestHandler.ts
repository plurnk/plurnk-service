// The SDK infers these through an internal bundle path it does not name publicly, so the
// overrides state their own return types from the package's exported surface (@a2a-js/sdk 1.2.0).
import type { AgentCard, Message, SendMessageRequest, StreamResponse, Task } from "@a2a-js/sdk";
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

    override async sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Message | Task> {
        await this.#executor.validateMessage(params.message);
        return super.sendMessage(params, context);
    }

    override async *sendMessageStream(params: SendMessageRequest, context: ServerCallContext): AsyncGenerator<StreamResponse> {
        await this.#executor.validateMessage(params.message);
        yield* super.sendMessageStream(params, context);
    }
}
