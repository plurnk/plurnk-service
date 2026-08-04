// Architecture-independent embedding wire codec ({§mimetype-embedding-wire}).

const FLOAT32_BYTES = 4;

export default class EmbeddingVector {
    static readonly encoding = "float32-le";

    static encode(
        values: ArrayLike<number>,
        expectedDimension?: number,
        source: string = "embedding vector",
    ): Uint8Array {
        if (
            values === null
            || values === undefined
            || !Number.isSafeInteger(values.length)
            || values.length < 0
        ) {
            throw new TypeError(`${source}: values must have a non-negative safe-integer length`);
        }
        const dimension = EmbeddingVector.#dimension(expectedDimension ?? values.length, source);
        if (values.length !== dimension) {
            throw new RangeError(
                `${source}: dimension ${dimension} requires ${dimension} values, got ${values.length} ${values.length === 1 ? "value" : "values"}`,
            );
        }
        const bytes = new Uint8Array(dimension * FLOAT32_BYTES);
        const view = new DataView(bytes.buffer);
        for (let index = 0; index < dimension; index++) {
            const value = values[index];
            if (typeof value !== "number" || !Number.isFinite(value)) {
                throw new TypeError(`${source}: value ${index} must be finite, got ${String(value)}`);
            }
            const float32 = Math.fround(value);
            if (!Number.isFinite(float32)) {
                throw new RangeError(`${source}: value ${index} must be representable as finite binary32, got ${String(value)}`);
            }
            view.setFloat32(index * FLOAT32_BYTES, float32, true);
        }
        return bytes;
    }

    static decode(
        bytes: Uint8Array,
        expectedDimension?: number,
        source: string = "embedding vector",
    ): Float32Array {
        if (!(bytes instanceof Uint8Array)) {
            throw new TypeError(`${source}: expected Uint8Array bytes`);
        }
        if (bytes.byteLength % FLOAT32_BYTES !== 0) {
            throw new RangeError(`${source}: byte length ${bytes.byteLength} must be a multiple of ${FLOAT32_BYTES}`);
        }
        const dimension = EmbeddingVector.#dimension(bytes.byteLength / FLOAT32_BYTES, source);
        if (expectedDimension !== undefined) {
            const expected = EmbeddingVector.#dimension(expectedDimension, source);
            if (dimension !== expected) {
                throw new RangeError(
                    `${source}: dimension ${expected} requires ${expected * FLOAT32_BYTES} bytes, got ${bytes.byteLength} bytes`,
                );
            }
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const values = new Float32Array(dimension);
        for (let index = 0; index < dimension; index++) {
            const value = view.getFloat32(index * FLOAT32_BYTES, true);
            if (!Number.isFinite(value)) {
                throw new TypeError(`${source}: value ${index} must be finite, got ${String(value)}`);
            }
            values[index] = value;
        }
        return values;
    }

    static assert(
        bytes: unknown,
        expectedDimension: number,
        source: string = "embedding vector",
    ): asserts bytes is Uint8Array {
        EmbeddingVector.decode(bytes as Uint8Array, expectedDimension, source);
    }

    static #dimension(value: number, source: string): number {
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new TypeError(`${source}: expected a positive safe-integer dimension, got ${String(value)}`);
        }
        return value;
    }
}
