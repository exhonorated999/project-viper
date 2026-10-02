/**
 * Post-publish verification.
 *
 * electron-builder can upload the installers and still fail before writing
 * latest.yml -- which is exactly what happened on the first 0.1.2 attempt.
 * A release missing latest.yml looks complete on the GitHub page but is
 * invisible to electron-updater, so every existing install silently stays on
 * the old version. That failure mode is quiet enough to deserve a check.
 *
 * Reads GH_TOKEN from the environment (set by publish.bat from the keyring).
 */
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;

// owner/repo come from the same place electron-builder reads them, so this
// cannot drift from what was actually published.
const yml = readFileSync("electron-builder.yml", "utf8");
const owner = (yml.match(/^\s*owner:\s*(\S+)/m) || [])[1];
const repo = (yml.match(/^\s*repo:\s*(\S+)/m) || [])[1];
if (!owner || !repo) {
  console.log("FAIL: could not read publish owner/repo from electron-builder.yml");
  process.exit(1);
}

const token = process.env.GH_TOKEN;
if (!token) {
  console.log("FAIL: GH_TOKEN not in environment");
  process.exit(1);
}

const r = await fetch(
  `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`,
  {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "viper-release-verify",
    },
  }
);

if (!r.ok) {
  console.log(`FAIL: release ${tag} not found on ${owner}/${repo} (HTTP ${r.status})`);
  process.exit(1);
}

const rel = await r.json();
const names = (rel.assets || []).map((a) => a.name);
const problems = [];

console.log(`Release ${tag} on ${owner}/${repo}`);
names.forEach((n) => console.log(`  asset  ${n}`));

if (rel.draft) problems.push("release is still a DRAFT -- auto-update cannot see it");
if (!names.includes("latest.yml"))
  problems.push("latest.yml is MISSING -- auto-update will not offer this version");
if (!names.some((n) => /Setup.*\.exe$/i.test(n)))
  problems.push("no Setup .exe asset");

// Not fatal: without the blockmap electron-updater still updates, it just
// downloads the whole installer instead of only the changed blocks.
if (!names.some((n) => /\.blockmap$/i.test(n)))
  console.log("\n  note: no .blockmap asset -- updates will be full downloads, not differential");

if (problems.length) {
  console.log("\nRelease verification FAILED:");
  problems.forEach((p) => console.log(`  ${p}`));
  process.exit(1);
}

console.log(`\nRelease ${tag} is published and complete.`);
