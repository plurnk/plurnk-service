import { isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";
import { FileByteSource, type ByteSource, type ChannelProducerResult } from "@plurnk/plurnk-schemes";
import Results from "./results.ts";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import MimetypeBinary from "../content/mimetype-binary.ts";

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
    static async detectMimetype(file: string, mimetypes: Mimetypes | undefined): Promise<string> {
        return FileMaterialization.detectSourceMimetype(file, new FileByteSource(async () => file), mimetypes);
    }

    static async detectSourceMimetype(path: string, source: ByteSource, mimetypes: Mimetypes | undefined): Promise<string> {
        if (mimetypes === undefined) throw new Error("File materialization requires the configured mimetype registry.");
        const detected = MimetypeBinary.normalizeAutoTextMimetype(await mimetypes.detect({ path }));
        if (await MimetypeBinary.isBinaryMimetype(detected, mimetypes)) return detected;
        // {§membership-binary-sniff} The extension map cannot turn NUL-bearing bytes into prose.
        return (await source.read(1, 8192)).includes(0) ? "application/octet-stream" : detected;
    }

    static maximumBytes(): number {
        const value = Knob.integer(CONFIG_NAME, 1);
        if (value > STORAGE_MAXIMUM_BYTES) {
            throw new RangeError(`${CONFIG_NAME} must be a safe integer byte count between 1 and ${STORAGE_MAXIMUM_BYTES}, got ${value}.`);
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
        const attributes: unknown = JSON.parse(encoded);
        if (!isRecord(attributes)) {
            throw new TypeError("File materialization attributes must be a JSON object.");
        }
        const candidate = attributes.sourceMaterialization;
        if (candidate === undefined) return null;
        if (!isRecord(candidate)) {
            throw new TypeError("sourceMaterialization must be a JSON object.");
        }
        const { disposition, maximumBytes, observedBytes } = candidate;
        if ((disposition !== "materialized" && disposition !== "input-limit")
            || !isSafeInteger(maximumBytes) || maximumBytes <= 0
            || !isSafeInteger(observedBytes) || observedBytes < 0
            || (disposition === "input-limit" ? observedBytes <= maximumBytes : observedBytes > maximumBytes)) {
            throw new TypeError("sourceMaterialization metadata is malformed.");
        }
        return { disposition, maximumBytes, observedBytes };
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
                recovery: `Use an executor fence for bounded access, hide the file, or raise ${CONFIG_NAME} up to ${STORAGE_MAXIMUM_BYTES}.`,
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
