import type { ChannelProducerResult } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";

const CONFIG_NAME = "PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES";
const STORAGE_MAXIMUM_BYTES = 104857600;

export interface FileMaterializationMetadata {
    readonly disposition: "materialized" | "input-limit";
    readonly maximumBytes: number;
    readonly observedBytes: number;
}

export interface FileMaterializationRejection {
    readonly code: "file-materialization-limit";
    readonly status: 413;
    readonly detail: string;
    readonly extensions: Readonly<Record<string, unknown>>;
}

export default class FileMaterialization {
    static maximumBytes(): number {
        const value = Number(process.env[CONFIG_NAME]);
        if (!Number.isSafeInteger(value) || value < 1 || value > STORAGE_MAXIMUM_BYTES) {
            throw new RangeError(`${CONFIG_NAME} must be a safe integer byte count between 1 and ${STORAGE_MAXIMUM_BYTES}, got ${JSON.stringify(process.env[CONFIG_NAME])}.`);
        }
        return value;
    }

    static classify(observedBytes: number): FileMaterializationMetadata {
        if (!Number.isSafeInteger(observedBytes) || observedBytes < 0) {
            throw new RangeError(`File materialization requires a non-negative safe integer byte size, got ${observedBytes}.`);
        }
        const maximumBytes = FileMaterialization.maximumBytes();
        return {
            disposition: observedBytes > maximumBytes ? "input-limit" : "materialized",
            maximumBytes,
            observedBytes,
        };
    }

    static attributes(metadata: FileMaterializationMetadata): Readonly<Record<string, unknown>> {
        return { sourceMaterialization: metadata };
    }

    static fromAttributes(encoded: string): FileMaterializationMetadata | null {
        const attributes = JSON.parse(encoded) as unknown;
        if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
            throw new TypeError("File materialization attributes must be a JSON object.");
        }
        const candidate = (attributes as { sourceMaterialization?: unknown }).sourceMaterialization;
        if (candidate === undefined) return null;
        if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
            throw new TypeError("sourceMaterialization must be a JSON object.");
        }
        const metadata = candidate as Partial<FileMaterializationMetadata>;
        const validDisposition = metadata.disposition === "materialized" || metadata.disposition === "input-limit";
        const validMaximum = Number.isSafeInteger(metadata.maximumBytes) && (metadata.maximumBytes ?? 0) > 0;
        const validObserved = Number.isSafeInteger(metadata.observedBytes) && (metadata.observedBytes ?? -1) >= 0;
        const limitConsistent = metadata.disposition === "input-limit"
            ? (metadata.observedBytes ?? 0) > (metadata.maximumBytes ?? 0)
            : (metadata.observedBytes ?? 0) <= (metadata.maximumBytes ?? 0);
        if (!validDisposition || !validMaximum || !validObserved || !limitConsistent) {
            throw new TypeError("sourceMaterialization metadata is malformed.");
        }
        return metadata as FileMaterializationMetadata;
    }

    static matchesCurrent(metadata: FileMaterializationMetadata, observedBytes: number): boolean {
        const current = FileMaterialization.classify(observedBytes);
        return metadata.disposition === current.disposition
            && metadata.maximumBytes === current.maximumBytes
            && metadata.observedBytes === current.observedBytes;
    }

    static rejection(pathname: string, metadata: FileMaterializationMetadata): FileMaterializationRejection {
        if (metadata.disposition !== "input-limit") {
            throw new TypeError("A file materialization failure requires an input-limit disposition.");
        }
        return {
            code: "file-materialization-limit",
            status: 413,
            detail: `File '${pathname}' is ${metadata.observedBytes} bytes and exceeds the ${metadata.maximumBytes}-byte materialization limit.`,
            extensions: {
                target: pathname,
                maximumBytes: metadata.maximumBytes,
                observedBytes: metadata.observedBytes,
                recovery: `Use EXEC for bounded access, hide the file, or raise ${CONFIG_NAME} up to ${STORAGE_MAXIMUM_BYTES}.`,
                retryable: false,
            },
        };
    }

    static failure(pathname: string, metadata: FileMaterializationMetadata): ChannelProducerResult {
        const rejection = FileMaterialization.rejection(pathname, metadata);
        return Results.assertChannelProducerResult(Results.failure(
            "scheme:file",
            rejection.code,
            rejection.status,
            rejection.detail,
            {},
            rejection.extensions,
        ));
    }
}
