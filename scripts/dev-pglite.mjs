#!/usr/bin/env node
/**
 * `npm run dev:pglite` — cross-platform local demo bootstrap.
 *
 * Why this exists instead of "VAR=x command && next dev": POSIX-style
 * environment assignments and `&&` are shell syntax, so the previous script
 * failed outright in Windows PowerShell/CMD. This runner does everything with
 * `process.execPath` and argument arrays (no shell, no platform-specific
 * quoting or chaining), so `npm run dev:pglite` works identically on
 * Windows 11, macOS and Linux.
 *
 * What it does:
 *   1. Seeds the embedded PGlite database (idempotent).
 *   2. Starts `next dev` ONLY after the seed succeeded.
 *
 * Both children receive the SAME environment, with KHANTHMAN_DB defaulting to
 * "pglite" and NODE_ENV forced to "development" exactly like `next dev` does,
 * so they resolve the same database. Both processes also load the same
 * `.env*` files (the CLI via src/db/env-file.ts, Next.js natively), which
 * keeps `KHANTHMAN_PGLITE_DIR` (and the legacy `MINGALA_PGLITE_DIR`)
 * consistent between seed and server.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE = process.execPath;

function childEnv() {
  const env = { ...process.env };
  // Blank counts as unset (matches src/db/config.ts); default to embedded PGlite.
  if (!env.KHANTHMAN_DB || env.KHANTHMAN_DB.trim() === "") {
    env.KHANTHMAN_DB = "pglite";
  }
  // `next dev` forces NODE_ENV=development; do the same for the seed so both
  // processes consider the same .env.development* files.
  env.NODE_ENV = "development";
  return env;
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(NODE, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", (error) => {
      console.error(`[dev:pglite] failed to start ${args.join(" ")}:`, error.message);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (code !== null) return resolve(code);
      resolve(signal ? 1 : 0);
    });
  });
}

function runServer(args, env) {
  const child = spawn(NODE, args, { cwd: root, env, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
  child.on("error", (error) => {
    console.error(`[dev:pglite] failed to start Next.js dev server:`, error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

const env = childEnv();

// 1) Seed (idempotent). 2) Start the dev server only when the seed succeeded.
const seedCode = await run(["--import", "tsx", "src/db/cli.ts", "seed"], env);
if (seedCode !== 0) {
  console.error(`[dev:pglite] seed failed with exit code ${seedCode}; dev server not started.`);
  process.exit(seedCode);
}

const nextBin = join(root, "node_modules", "next", "dist", "bin", "next");
runServer([nextBin, "dev"], env);
