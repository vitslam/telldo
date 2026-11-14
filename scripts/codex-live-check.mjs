// Deliberate live check: uses the user's Codex quota, never opens a database.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
const outfile = ".tools/codex-live-check.cjs";
try {
  await build({
    entryPoints: ["tests/codex-live.ts"],
    bundle: true,
    platform: "node",
    packages: "external",
    outfile,
  });
  const result = spawnSync(process.execPath, [outfile], {
    stdio: "inherit",
    env: process.env,
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(outfile, { force: true });
}
