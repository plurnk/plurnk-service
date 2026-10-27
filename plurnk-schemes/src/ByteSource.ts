import { errnoCode } from "@plurnk/plurnk-contracts";
import { open, stat } from "node:fs/promises";

// {§scheme-operation-dispatch} The source of a resource's original bytes. Coordinates
// are one-based and inclusive, like the public byte projection.
export interface ByteSource {
    size(): Promise<number | null>;
    read(start: number, end: number): Promise<Uint8Array>;
    nativePath?(): Promise<string | null>;
}

// {§scheme-operation-dispatch} Location and original bytes share their resource owner.
export class FileByteSource implements ByteSource {
    readonly #locate: () => Promise<string | null>;

    constructor(locate: () => Promise<string | null>) {
        this.#locate = locate;
    }

    async nativePath(): Promise<string | null> {
        try {
            const file = await this.#locate();
            if (file === null) return null;
            if (!(await stat(file)).isFile()) throw new TypeError("The byte source is not a regular file.");
            return file;
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") return null;
            throw cause;
        }
    }

    async size(): Promise<number | null> {
        const file = await this.nativePath();
        return file === null ? null : (await stat(file)).size;
    }

    async read(start: number, end: number): Promise<Uint8Array> {
        const file = await this.nativePath();
        if (file === null) throw new Error("The byte source no longer exists.");
        const handle = await open(file, "r");
        try {
            const buffer = Buffer.alloc(end - start + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, start - 1);
            return buffer.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    }
}

// {§scheme-operation-dispatch} One demand-loaded snapshot, with no native file identity.
export class GeneratedByteSource implements ByteSource {
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
