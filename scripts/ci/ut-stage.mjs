// scripts/ci/ut-stage.mjs
// Stage the canonical deploy unit, verifying every path exists first.
// `git add` of a missing path exits nonzero mid-step (and a typo'd path can
// silently stage a partial unit); verify-then-add keeps the commit truthful.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEPLOY_PATHS = [
  "data/picks.json",
  "data/candidates.json",
  "data/calc.json",
  "dist/index.html",
  "dist/llms.txt",
  "dist/data-calc.json",
  "dist/og-image.png",
  "dist/favicon.ico",
  "dist/favicon-32.png",
  "dist/favicon-64.png",
  "dist/favicon.svg",
  "dist/apple-touch-icon.png",
];

export function missingPaths(paths = DEPLOY_PATHS) {
  return paths.filter((p) => !existsSync(p));
}

export function stageAll(paths = DEPLOY_PATHS) {
  const missing = missingPaths(paths);
  if (missing.length) {
    throw new Error("refusing to stage, missing paths:\n" + missing.map((p) => "  " + p).join("\n"));
  }
  execFileSync("git", ["add", "--", ...paths], { stdio: "inherit" });
}

const invokedDirectly =
  process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    stageAll();
    console.log(`staged canonical deploy unit (${DEPLOY_PATHS.length} paths)`);
  } catch (e) {
    console.error("STAGE STEP FAILED:", e.message);
    process.exit(1);
  }
}
