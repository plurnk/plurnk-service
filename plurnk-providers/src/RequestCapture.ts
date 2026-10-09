import type { ProviderRequestCapture } from "./types.ts";

// {§provider-dispatched-request}: one fetch closure per physical request,
// without global interception or a second request identity.
export default class RequestCapture {
    #request: ProviderRequestCapture | undefined;

    get request(): ProviderRequestCapture | undefined { return this.#request; }

    fetch(next: typeof globalThis.fetch): typeof globalThis.fetch {
        return async (input, init) => {
            if (this.#request !== undefined) {
                throw new TypeError("A physical provider request dispatched more than once");
            }
            const body = typeof init?.body === "string"
                ? init.body
                : init?.body == null && input instanceof Request
                    ? await input.clone().text()
                    : undefined;
            if (body === undefined) throw new TypeError("Provider request capture requires a serialized text body");
            this.#request = {
                method: init?.method ?? (input instanceof Request ? input.method : "GET"),
                origin: new URL(input instanceof Request ? input.url : String(input)).origin,
                body,
            };
            return next(input, init);
        };
    }
}
