import { resolve } from "node:path";

export const candidateDaemonArgs = (root) => [
    `--env-file=${resolve(root, "plurnk-core", ".env.test")}`,
    resolve(root, "plurnk-core", "dist", "service.js"),
    "start",
];
