// Prints the bottom-up publish command list for the owner's OTP session.
// Order is the root workspaces array, which is maintained dependency-first.
import fs from "node:fs/promises";
import path from "node:path";

const root = JSON.parse(await fs.readFile("package.json", "utf8"));
for (const dir of root.workspaces) {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    console.log(`npm publish -w ${pkg.name} --otp=<OTP>   # ${pkg.version}`);
}
