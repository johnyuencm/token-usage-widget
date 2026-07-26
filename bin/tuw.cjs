#!/usr/bin/env node
"use strict";

/**
 * Global CLI entry for token-usage-widget (`tuw`).
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function printHelp() {
  console.log(`Usage: tuw [command]

Commands:
  (default), widget     Start the corner widget
  setup [flags]         Configure providers (--defaults, --all)
  enable <provider>     Enable one provider (prompt secret if needed)
  disable <provider>    Disable one provider
  providers             List provider on/off flags
  start                 Start the browser dashboard server
  startup <cmd>         Login startup: install | remove | status
  -h, --help            Show this help
`);
}

function resolveDist(rel) {
  const p = path.join(root, "dist", rel);
  if (!fs.existsSync(p)) {
    console.error(`Missing ${p}. Run: npm run build`);
    process.exit(1);
  }
  return p;
}

function runNode(script, scriptArgs) {
  const result = spawnSync(process.execPath, [script, ...scriptArgs], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status == null ? 1 : result.status);
}

async function main() {
  const args = process.argv.slice(2);
  const head = args[0];

  if (head === "-h" || head === "--help" || head === "help") {
    printHelp();
    return;
  }

  if (!head || head === "widget") {
    const { main: launchMain } = require(path.join(root, "scripts", "start-widget.cjs"));
    await launchMain();
    return;
  }

  if (head === "setup") {
    runNode(resolveDist(path.join("cli", "setup.js")), args.slice(1));
    return;
  }

  if (head === "enable" || head === "disable" || head === "providers") {
    runNode(resolveDist(path.join("cli", "providers.js")), args);
    return;
  }

  if (head === "start") {
    runNode(resolveDist("server.js"), []);
    return;
  }

  if (head === "startup") {
    runNode(resolveDist(path.join("cli", "startup.js")), args.slice(1));
    return;
  }

  console.error(`Unknown command: ${head}\n`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
