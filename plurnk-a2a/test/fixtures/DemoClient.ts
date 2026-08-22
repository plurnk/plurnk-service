import type { SendMessageRequest } from "@a2a-js/sdk";
import { A2aMessage, connectHttpJsonAgent } from "../../src/index.ts";

export { connectHttpJsonAgent };

export const textRequest = (
    text: string,
    identity: { readonly taskId?: string; readonly contextId?: string } = {},
): SendMessageRequest => A2aMessage.request(text, identity);
