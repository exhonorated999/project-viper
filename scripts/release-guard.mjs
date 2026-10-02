/**
 * Pre-flight checks that run BEFORE electron-builder publishes.
 *
 * These exist because of a real failure on the 0.1.2 release: the tag was
 * created locally but never pushed, and GitHub rejects a published release
 * whose tag does not exist remotely. electron-builder's recovery was worse
 * than the failure -- it created the tag itself against whatever the default
 * branch pointed at (the PREVIOUS release commit), uploaded the installers,
 * then died before writing latest.yml. The result was a release that looked
 * fine in the UI, pointed at the wrong source, and was invisible to
 * auto-update.
 *
 * So: refuse to build unless the tag exists on the remote AND points at the
 * commit being built.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const fail = [];
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m, fix) => {
  console.log(`  FAIL  ${m}`);
  fail.push(fix);
};

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
console.log(`Release pre-flight for ${tag}`);

// 1. Clean tree. Publishing from a dirty tree means the artifact does not
//    correspond to any commit, so it can never be reproduced or bisected.
const dirty = git("status", "--porcelain")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("??"));
if (dirty.length === 0) ok("working tree clean (tracked files)");
else bad(`${dirty.length} uncommitted change(s)`, "commit or stash your changes");

const head = git("rev-parse", "HEAD");

// 2. Local tag exists and points at HEAD.
let localTag = "";
try {
  localTag = git("rev-list", "-n", "1", tag);
} catch {
  /* tag absent */
}
if (!localTag) bad(`local tag ${tag} does not exist`, `git tag ${tag}`);
else if (localTag !== head)
  bad(
    `local tag ${tag} points at ${localTag.slice(0, 8)}, HEAD is ${head.slice(0, 8)}`,
    `git tag -f ${tag} && git push -f origin ${tag}`
  );
else ok(`local tag ${tag} -> HEAD`);

// 3. Remote tag exists and points at the same commit. Lightweight tags report
//    the commit directly; annotated tags report the tag object, with the
//    commit under the ^{} ref -- accept either.
let remote = "";
try {
  remote = git("ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`);
} catch {
  /* network/auth problem falls through to the empty check below */
}
const remoteShas = remote
  .split("\n")
  .map((l) => l.split("\t")[0])
  .filter(Boolean);
if (remoteShas.length === 0)
  bad(`tag ${tag} is not on the remote`, `git push origin ${tag}`);
else if (!remoteShas.includes(head))
  bad(
    `remote tag ${tag} points at ${remoteShas[0].slice(0, 8)}, not HEAD ${head.slice(0, 8)}`,
    `git push -f origin ${tag}   (or delete the remote tag and re-push)`
  );
else ok(`remote tag ${tag} -> HEAD`);

// 4. Branch is pushed, so the tagged commit is actually reachable on GitHub.
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
let behind = "";
try {
  behind = git("rev-list", "--count", `origin/${branch}..HEAD`);
} catch {
  behind = "?";
}
if (behind === "0") ok(`${branch} is pushed`);
else bad(`${branch} is ${behind} commit(s) ahead of origin`, `git push origin ${branch}`);

if (fail.length) {
  console.log("\nPre-flight FAILED. Fix and re-run:");
  fail.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}
console.log("\nPre-flight passed.\n");
