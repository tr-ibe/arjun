#!/usr/bin/env node
// Adds a Claude account for Arjun to use, or logs an existing one in again:
//   add-account <name>
// Sets up the account's own Claude folder, then opens Claude in it so you can run /login.
// The server finds the folder within a minute and adds it at the end of the order.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prepareAccountDir, readLogin } from "../server/account_dir.js";

const accountsDir = process.env.ACCOUNTS_DIR ?? join(homedir(), "accounts");
const mainDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const name = process.argv[2];

if (!name || !/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name) || name === "main") {
  console.error("Usage: add-account <name>   e.g. add-account second");
  console.error("The name is letters, numbers, - and _. The main account is the usual `claude` login.");
  const existing = existsSync(accountsDir) ? readdirSync(accountsDir) : [];
  if (existing.length) console.error(`Accounts so far: ${existing.join(", ")}`);
  process.exit(2);
}

const dir = join(accountsDir, name);
const again = existsSync(dir);
prepareAccountDir(dir, mainDir);

console.log(`
${again ? "Logging in again" : "Setting up"} account "${name}" in ${dir}.

Claude opens next, using this account's folder. In it:
  1. Run /login and sign in with the Claude account for "${name}".
  2. Run /exit.

The account only provides usage. Plugins, Slack and the rest come from Arjun (Settings → From Arjun).
`);

const res = spawnSync(process.env.CLAUDE_BIN ?? "claude", [], {
  stdio: "inherit",
  env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
});
if (res.error) {
  console.error(`Could not start Claude: ${res.error.message}`);
  process.exit(1);
}

if (readLogin(dir)) {
  console.log(`
Account "${name}" is logged in. Arjun picks it up within a minute, after the accounts already there.
Change the order, or turn it off, on the Settings page.`);
} else {
  console.log(`
No login was saved for "${name}". Run add-account ${name} again and use /login.`);
  process.exit(1);
}
