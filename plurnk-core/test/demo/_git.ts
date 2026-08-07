import { execFileSync } from "node:child_process";
import { hermeticGitEnv } from "../../src/core/git-env.ts";

export const initializeDemoRepository = (
    workspace: string,
    message: string,
    trackAll = true,
): void => {
    const env = hermeticGitEnv();
    const git = (...args: string[]): void => {
        execFileSync("git", args, { cwd: workspace, env, stdio: "ignore" });
    };

    git("init", "-q");
    git("config", "user.email", "demo@plurnk.invalid");
    git("config", "user.name", "demo");
    if (trackAll) git("add", ".");
    git(
        "-c", "commit.gpgsign=false",
        "-c", "core.hooksPath=/dev/null",
        "commit", "--allow-empty", "-q", "--no-verify", "-m", message,
    );
};
