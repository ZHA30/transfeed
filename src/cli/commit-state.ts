import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeConfigJsonSchema } from "../state/config-schema.js";
import { getStateDir } from "../state/paths.js";

const exec = promisify(execFile);
const ALLOWED_PATHS = new Set(["README.md", "config/feeds.yaml", "config/feeds.schema.json", "cache/manifest.json", "cache/units.json", "reports/latest.json"]);

async function main(): Promise<void> {
  const stateDir = getStateDir();
  await writeConfigJsonSchema();
  await exec("git", ["add", "-A", "."], { cwd: stateDir });
  const staged = await stagedFiles();
  if (staged.length === 0) {
    console.log("No feed state changes to commit.");
    return;
  }
  const invalid = staged.filter((file) => !ALLOWED_PATHS.has(file));
  if (invalid.length > 0) {
    throw new Error(`refusing to commit non-state files: ${invalid.join(", ")}`);
  }

  await exec("git", ["config", "user.name", "github-actions[bot]"], { cwd: stateDir });
  await exec("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { cwd: stateDir });
  await exec("git", ["commit", "-m", "chore(feed): update state [skip ci]", "-m", "Update generated feed outputs and feed feature cache state."], { cwd: stateDir });
  await exec("git", ["push", "origin", "HEAD:state"], { cwd: stateDir });
}

async function stagedFiles(): Promise<string[]> {
  const { stdout } = await exec("git", ["diff", "--cached", "--name-only"], { cwd: getStateDir() });
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

await main();
