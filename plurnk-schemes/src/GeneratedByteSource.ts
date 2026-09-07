import type { ByteSource } from "./ByteSource.ts";

// {§scheme-source-bytes} One demand-loaded snapshot, with no native file identity.
export default class GeneratedByteSource implements ByteSource {
    readonly #generate: () => Promise<Uint8Array | null>;
    #bytes: Promise<Uint8Array | null> | undefined;

    constructor(generate: () => Promise<Uint8Array | null>) {
        this.#generate = generate;
    }

    #load(): Promise<Uint8Array | null> {
        return this.#bytes ??= this.#generate();
    }

    async size(): Promise<number | null> {
        return (await this.#load())?.length ?? null;
    }

    async read(start: number, end: number): Promise<Uint8Array> {
        const bytes = await this.#load();
        if (bytes === null) throw new Error("The byte source no longer exists.");
        return bytes.slice(start - 1, end);
    }
}
