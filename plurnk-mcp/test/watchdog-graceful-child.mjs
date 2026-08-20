#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const marker = process.argv[2];
if (marker === undefined) process.exit(64);

process.stdin.resume();
process.stdin.once("end", () => {
    writeFileSync(marker, "closed\n");
    process.exit(0);
});
process.stdout.write("READY\n");
