import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await run("git", args, { cwd });
  return stdout.trim();
}

export async function main(): Promise<void> {
  const out = "site";
  await stat(join(out, "index.html"));
  const remote = await git(["remote", "get-url", "origin"]);
  await rm(join(out, ".git"), { recursive: true, force: true });
  await git(["init", "--quiet", "--initial-branch", "gh-pages"], out);
  await git(["add", "--all"], out);
  await git(["commit", "--quiet", "--message", "Publish studies"], out);
  await git(["push", "--force", remote, "gh-pages"], out);
  console.log(`published ${out} to ${remote} gh-pages`);
}
