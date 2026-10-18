// Fetch stubs in tests read the request they were handed. A Request carries its URL and body as properties;
// a string or URL stringifies as itself. Fixture bodies are strings, and a stub that receives another kind says so.
export const requestUrl = (input: string | URL | Request): string => input instanceof Request ? input.url : String(input);

export const requestBody = (init: RequestInit | undefined): string => {
    const body = init?.body;
    if (body === undefined || body === null) return "";
    if (typeof body === "string") return body;
    throw new Error(`fixture request bodies are strings, got ${Object.prototype.toString.call(body)}`);
};
