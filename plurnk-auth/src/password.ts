// {§auth-oauth-clients} {§auth-configuration} — operator browser password hashing and verification.
// Encodes self-contained `$`-free `scrypt:<N>:<r>:<p>:<base64url-salt>:<base64url-digest>` verifiers
// so `.env` files and POSIX shells never interpolate `$` variables.
import { randomBytes, scrypt as nodeScrypt, scryptSync, timingSafeEqual } from "node:crypto";

const HASH_PATTERN = /^scrypt:([1-9]\d*):([1-9]\d*):([1-9]\d*):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/u;
const scryptCost = 16_384;
const scryptBlock = 8;
const scryptParallelism = 1;
const saltOctets = 16;
const digestOctets = 32;

export interface ParsedPasswordHash {
    readonly cost: number;
    readonly blockSize: number;
    readonly parallelism: number;
    readonly salt: Buffer;
    readonly digest: Buffer;
}

const invalidHashError = (): Error =>
    new Error(
        "PLURNK_AUTH_PASSWORD_HASH must be empty or 'scrypt:<N>:<r>:<p>:<salt>:<digest>' from 'plurnk-service hash-password'.",
    );

const maxMemFor = (cost: number, blockSize: number): number =>
    128 * cost * blockSize + 2 * 1024 * 1024;

export const parsePasswordHash = (encoded: string): ParsedPasswordHash => {
    const match = HASH_PATTERN.exec(encoded);
    if (match === null) throw invalidHashError();
    const cost = Number(match[1]);
    const blockSize = Number(match[2]);
    const parallelism = Number(match[3]);
    const [, , , , saltText, digestText] = match;
    if (
        !Number.isSafeInteger(cost) ||
        cost < 1_024 ||
        cost > 1_048_576 ||
        (cost & (cost - 1)) !== 0 ||
        !Number.isSafeInteger(blockSize) ||
        blockSize < 1 ||
        blockSize > 32 ||
        !Number.isSafeInteger(parallelism) ||
        parallelism < 1 ||
        parallelism > 16 ||
        128 * cost * blockSize > 256 * 1024 * 1024
    ) {
        throw invalidHashError();
    }
    const salt = Buffer.from(saltText, "base64url");
    const digest = Buffer.from(digestText, "base64url");
    if (
        salt.toString("base64url") !== saltText ||
        salt.byteLength < 16 ||
        salt.byteLength > 64 ||
        digest.toString("base64url") !== digestText ||
        digest.byteLength < 32 ||
        digest.byteLength > 64
    ) {
        throw invalidHashError();
    }
    return { cost, blockSize, parallelism, salt, digest };
};

const deriveAsync = (
    password: string,
    salt: Buffer,
    keylen: number,
    options: { readonly N: number; readonly r: number; readonly p: number; readonly maxmem: number },
): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        nodeScrypt(Buffer.from(password, "utf8"), salt, keylen, options, (err, derivedKey) => {
            if (err !== null) reject(err);
            else resolve(derivedKey);
        });
    });

export const hashPassword = async (
    password: string,
    options: { readonly cost?: number; readonly blockSize?: number; readonly parallelism?: number } = {},
): Promise<string> => {
    if (typeof password !== "string" || password.length === 0) {
        throw new Error("Password must not be empty.");
    }
    const cost = options.cost ?? scryptCost;
    const blockSize = options.blockSize ?? scryptBlock;
    const parallelism = options.parallelism ?? scryptParallelism;
    const salt = randomBytes(saltOctets);
    const digest = await deriveAsync(password, salt, digestOctets, {
        N: cost,
        r: blockSize,
        p: parallelism,
        maxmem: maxMemFor(cost, blockSize),
    });
    const encoded = `scrypt:${cost}:${blockSize}:${parallelism}:${salt.toString("base64url")}:${digest.toString("base64url")}`;
    parsePasswordHash(encoded);
    return encoded;
};

export const hashPasswordSync = (
    password: string,
    options: { readonly cost?: number; readonly blockSize?: number; readonly parallelism?: number } = {},
): string => {
    if (typeof password !== "string" || password.length === 0) {
        throw new Error("Password must not be empty.");
    }
    const cost = options.cost ?? scryptCost;
    const blockSize = options.blockSize ?? scryptBlock;
    const parallelism = options.parallelism ?? scryptParallelism;
    const salt = randomBytes(saltOctets);
    const digest = scryptSync(Buffer.from(password, "utf8"), salt, digestOctets, {
        N: cost,
        r: blockSize,
        p: parallelism,
        maxmem: maxMemFor(cost, blockSize),
    });
    const encoded = `scrypt:${cost}:${blockSize}:${parallelism}:${salt.toString("base64url")}:${digest.toString("base64url")}`;
    parsePasswordHash(encoded);
    return encoded;
};

export const verifyPassword = async (
    password: string,
    encodedOrParsed: string | ParsedPasswordHash,
): Promise<boolean> => {
    if (typeof password !== "string" || password.length === 0) return false;
    const parsed = typeof encodedOrParsed === "string" ? parsePasswordHash(encodedOrParsed) : encodedOrParsed;
    const derived = await deriveAsync(password, parsed.salt, parsed.digest.byteLength, {
        N: parsed.cost,
        r: parsed.blockSize,
        p: parsed.parallelism,
        maxmem: maxMemFor(parsed.cost, parsed.blockSize),
    });
    return timingSafeEqual(derived, parsed.digest);
};
