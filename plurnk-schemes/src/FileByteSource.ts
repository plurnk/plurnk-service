import { open, stat } from "node:fs/promises";
import type { ByteSource } from "./ByteSource.ts";

// {§scheme-source-bytes} Location and original bytes share their resource owner.
export default class FileByteSource implements ByteSource {
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
            if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return null;
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
