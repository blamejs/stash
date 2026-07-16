// SPDX-License-Identifier: Apache-2.0
// Copyright (c) blamejs contributors
//
// release.js -- orchestrate the release flow as a sequence of idempotent
// subcommands. Each subcommand performs ONE phase, prints what it did,
// and exits with a code that is safe to script against. There are no
// confirmation prompts: the gates are the confirmation.
//
// Local subcommands (no remote required):
//   node scripts/release.js status    # version, git cleanliness, gate freshness
//   node scripts/release.js regen     # regen CHANGELOG.md + api-snapshot.json
//   node scripts/release.js smoke     # the full smoke pipeline
//   node scripts/release.js commit    # gates, then git add -A + signed commit
//   node scripts/release.js tag       # annotated signed tag v<version>
//   node scripts/release.js help      # this banner
//
// Remote-dependent phases (prepare, push, push-fix, watch, merge,
// publish) refuse with a one-line message until a GitHub origin remote is
// configured; with one, they drive the PR flow end to end, gated on the
// required checks and GitHub's authoritative review-thread resolution
// state for the PR's head commit.
//
// Pre-conditions:
//   - `commit` requires release-notes/v<package.json version>.json; the
//     headline / summary / sections need human judgment and do not
//     auto-generate from a diff. It refuses with a stub template printed
//     to stderr otherwise.
//   - Git SSH signing (commit.gpgsign, tag.gpgsign, allowed_signers) must
//     be configured before the first signed commit or tag.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REMOTE_ONLY = ["prepare", "push", "push-fix", "watch", "merge", "publish"]; // shown in status when no remote exists

function run(cmd, args, opts) {
  const input = opts && opts.input;
  const rv = spawnSync(cmd, args, {
    cwd: ROOT,
    // spawnSync delivers input only through a piped stdin; an inherited
    // stdin silently drops it and the child reads EOF.
    stdio: (opts && opts.stdio) || (input != null ? ["pipe", "inherit", "inherit"] : "inherit"),
    input,
    encoding: "utf8",
  });
  if (rv.status !== 0 && !(opts && opts.allowFail)) {
    throw new Error(cmd + " " + args.join(" ") + " failed with status " + rv.status);
  }
  return rv;
}

function capture(cmd, args) {
  const rv = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  return {
    status: rv.status,
    stdout: (rv.stdout || "").trim(),
    stderr: (rv.stderr || "").trim(),
  };
}

// captureNpm(command) -- run an npm invocation and capture stdout. Windows
// resolves `npm` as an `npm.cmd` shim that Node refuses to spawn directly, so a
// bare spawnSync("npm", [...]) returns ENOENT on Windows and the caller misreads
// the empty stdout as a failed query (this is what falsely failed the 0.1.4
// publish verification). Use the shell form -- a single command string, since
// shell:true with an args array is deprecated (DEP0190) -- matching
// check-pack-against-gitignore.js. `command` is built from package.json (a
// semver spec), never external input.
function captureNpm(command) {
  const rv = spawnSync(command, [], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: true,
  });
  return {
    status: rv.status,
    stdout: (rv.stdout || "").trim(),
    stderr: (rv.stderr || "").trim(),
  };
}

function readVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

// A failing git invocation must never read as a clean tree -- an empty
// stdout from a git that could not run is not "nothing to report".
function gitClean() {
  const rv = capture("git", ["status", "--porcelain"]);
  if (rv.status !== 0) {
    throw new Error("git status --porcelain failed (status " + rv.status + ")" +
      (rv.stderr ? ": " + rv.stderr : ""));
  }
  return rv.stdout === "";
}

// The ONE definition of "the checked-out branch": empty on a detached
// HEAD, throwing when git itself fails rather than reading as detached.
function currentBranch() {
  const rv = capture("git", ["branch", "--show-current"]);
  if (rv.status !== 0) {
    throw new Error("git branch --show-current failed (status " + rv.status + ")" +
      (rv.stderr ? ": " + rv.stderr : ""));
  }
  return rv.stdout;
}

function releaseNotesPath(version) {
  return join(ROOT, "release-notes", "v" + version + ".json");
}

function readReleaseNotes(version) {
  let raw;
  try {
    raw = readFileSync(releaseNotesPath(version), "utf8");
  } catch {
    const stub = {
      version,
      date: new Date().toISOString().slice(0, 10),
      headline: "<one-line operator-facing summary>",
      summary: "<one-paragraph why-it-matters>",
      sections: { Added: ["<one operator-facing sentence per shipped surface>"] },
    };
    console.error("");
    console.error("release: missing " + releaseNotesPath(version));
    console.error("");
    console.error("Create that file before re-running. Stub template:");
    console.error("");
    console.error(JSON.stringify(stub, null, 2));
    console.error("");
    process.exit(2);
  }
  return JSON.parse(raw);
}

function section(title) {
  console.log("\n=== " + title + " ===");
}

function ok(msg) {
  console.log("ok: " + msg);
}

// Verify HEAD's commit signature: `git verify-commit HEAD` exits 0 on a
// Good signature -- the same truth signal a signed-commit ruleset checks.
function verifyCommitSignature() {
  const rv = capture("git", ["verify-commit", "HEAD"]);
  if (rv.status !== 0) {
    throw new Error("HEAD commit signature is not Good -- check SSH signing setup " +
      "(commit.gpgsign=true + gpg.format=ssh + allowed_signers populated)." +
      (rv.stderr ? "\n" + rv.stderr : ""));
  }
  const sig = capture("git", ["log", "-1", "--pretty=%h %G? %GS"]);
  console.log("signature: " + sig.stdout);
  ok("commit signature verified");
}

// ---- Subcommands ----------------------------------------------------------

function cmdStatus() {
  section("status");
  console.log("package version:  " + readVersion());
  console.log("branch:           " + (currentBranch() || "(detached HEAD)"));
  console.log("clean:            " + gitClean());
  console.log("release-notes:    " +
    (readNotesPresent(readVersion()) ? "present" : "missing (release-notes/v" + readVersion() + ".json)"));
  let smokeLine = "(no run recorded -- npm run smoke)";
  try {
    const st = statSync(join(ROOT, ".test-output", "smoke.log"));
    smokeLine = st.mtime.toISOString() + " (.test-output/smoke.log)";
  } catch { /* never run */ }
  console.log("last smoke:       " + smokeLine);
  const remote = capture("git", ["remote"]).stdout;
  console.log("remote:           " + (remote || "(none -- " + REMOTE_ONLY.join("/") + " inactive)"));
  const tag = capture("git", ["tag", "-l", "v" + readVersion()]).stdout;
  console.log("tag v" + readVersion() + ":       " + (tag ? "exists" : "(not yet tagged)"));
}

function readNotesPresent(version) {
  try {
    readFileSync(releaseNotesPath(version), "utf8");
    return true;
  } catch {
    return false;
  }
}

function cmdRegen() {
  section("regen");
  run("node", ["scripts/regen-changelog.js"]);
  run("node", ["scripts/refresh-api-snapshot.js"]);
  ok("CHANGELOG.md + api-snapshot.json regenerated");
}

function cmdSmoke() {
  section("smoke");
  run("node", ["scripts/smoke.js"]);
  ok("smoke pipeline green");
}

function cmdCommit() {
  section("commit");
  const version = readVersion();
  const notes = readReleaseNotes(version);
  if (gitClean()) {
    throw new Error("nothing to commit -- the working tree is clean");
  }

  // The gates are the confirmation: a failing pipeline refuses the commit.
  run("node", ["scripts/smoke.js"]);
  ok("gates green");

  const lines = [version + " \u2014 " + notes.headline, "", notes.summary];
  const sections = notes.sections && typeof notes.sections === "object" ? notes.sections : {};
  for (const heading of Object.keys(sections)) {
    if (!Array.isArray(sections[heading]) || sections[heading].length === 0) continue;
    lines.push("", heading + ":");
    for (const item of sections[heading]) lines.push("  - " + item);
  }

  run("git", ["add", "-A"]);
  run("git", ["commit", "-F", "-"], { input: lines.join("\n") + "\n" });
  ok("signed commit created");
  verifyCommitSignature();
}

// The release-state file bridges `watch` and `tag` across their separate
// invocations: watch records the exact commit its reviewed PR merged into
// so tag can pin the signed tag to THAT commit. Dot-prefixed, so the
// deny-all-dotfiles gitignore keeps it out of the repo and the tarball.
function releaseStatePath() {
  return join(ROOT, ".release-state.json");
}

function readReleaseState() {
  try {
    return JSON.parse(readFileSync(releaseStatePath(), "utf8"));
  } catch {
    return null;
  }
}

// patchReleaseState(patch) -- merge `patch` into the current state and write it
// back, preserving the other bridged fields (the tag's version/mergeSha and the
// review trigger live in the same file across separate invocations).
function patchReleaseState(patch) {
  const cur = readReleaseState() || {};
  writeFileSync(releaseStatePath(), JSON.stringify(Object.assign({}, cur, patch)) + "\n");
}

// reviewTriggerForHead(state, headSha) -- pure: the id of the `@codex review`
// comment a prior `push`/`push-fix`/nudge recorded for THIS head, or null. The
// head match is the safety property: the id is reused only when it was recorded
// for the exact current head, so a prior head's trigger is never revived to
// clear a head the reviewer has not seen (a direct push changes the head, the
// recorded head no longer matches, and the wait posts a fresh trigger). null
// whenever the record is absent, malformed, or for a different head.
export function reviewTriggerForHead(state, headSha) {
  const rt = state && typeof state === "object" && state.reviewTrigger;
  if (rt && typeof rt === "object" && rt.head === headSha && rt.id != null) {
    return rt.id;
  }
  return null;
}

// recordReviewTrigger / recoverReviewTrigger -- persist and recall the trigger
// id for a head across the push -> watch -> merge invocations, so an
// already-present reaction clears the first poll instead of the wait posting a
// duplicate trigger and stalling for the nudge delay (twice, since merge
// repeats the wait).
function recordReviewTrigger(headSha, triggerId) {
  if (triggerId != null) patchReleaseState({ reviewTrigger: { head: headSha, id: triggerId } });
}

function recoverReviewTrigger(headSha) {
  return reviewTriggerForHead(readReleaseState(), headSha);
}

// tagFromState(state) -- the { version, target } a signed tag must use when a
// prior `watch` recorded them. Pins BOTH the version and the merge commit to
// the release PR: a concurrent PR that bumps package.json or advances main
// after our merge can therefore neither mis-version the tag (the version is
// the one the release branch carried, captured before any sync) nor mis-target
// it (the commit is the reviewed PR's merge). null when no valid record exists
// -- a standalone `tag` run then reads the working-tree version and tags HEAD.
export function tagFromState(state) {
  if (state && typeof state === "object" &&
      typeof state.version === "string" && /^\d+\.\d+\.\d+$/.test(state.version) &&
      typeof state.mergeSha === "string" && /^[0-9a-f]{7,40}$/.test(state.mergeSha)) {
    return { version: state.version, target: state.mergeSha };
  }
  return null;
}

function cmdTag() {
  section("tag");
  if (!gitClean()) {
    throw new Error("tag requires a clean working tree");
  }
  // Prefer the version + commit `watch` recorded for this release, so neither
  // a concurrent version bump nor a concurrent merge on main can mis-version
  // or mis-target the tag. Absent a record, tag the working tree at HEAD.
  const planned = tagFromState(readReleaseState());
  const version = planned ? planned.version : readVersion();
  const target = planned ? planned.target : null;
  const tag = "v" + version;
  if (capture("git", ["tag", "-l", tag]).stdout === tag) {
    throw new Error("tag " + tag + " already exists -- this version is already tagged");
  }
  const tagArgs = ["tag", "-s", tag, "-m", tag];
  if (target) {
    tagArgs.push(target);
    console.log("tagging " + tag + " on the recorded merge commit " + target.slice(0, 12) + " (version + commit pinned from the release PR)");
  }
  run("git", tagArgs);

  // Verify the signature immediately; a bad signature deletes the tag so a
  // re-run after fixing the signing setup starts clean.
  const verify = capture("git", ["tag", "-v", tag]);
  if (verify.stderr.indexOf("Good") === -1 && verify.stdout.indexOf("Good") === -1) {
    run("git", ["tag", "-d", tag], { allowFail: true });
    throw new Error("`git tag -v " + tag + "` did not report a Good signature -- " +
      "check SSH signing setup (tag.gpgsign=true + gpg.format=ssh + " +
      "allowed_signers populated). The local tag was removed.\n" +
      (verify.stderr || verify.stdout));
  }
  // The tag is signed and verified; the recorded merge commit has served its
  // purpose, so retire the state file (a stale one must never mis-pin the next
  // release's tag).
  if (target) {
    try { unlinkSync(releaseStatePath()); } catch { /* already gone */ }
  }
  ok("annotated signed tag " + tag + " created (signature: Good)" +
    (target ? " on merge commit " + target.slice(0, 12) : ""));
}

function requireRemote() {
  const remote = capture("git", ["remote", "get-url", "origin"]).stdout;
  if (!remote) {
    throw new Error("no origin remote configured (git remote add origin <url>)");
  }
  return remote;
}

// Synchronous sleep for the poll loops; the script is spawnSync-style
// throughout and a wait here blocks nothing else.
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Parse a gh JSON payload, failing closed: a non-zero exit or empty stdout
// throws rather than degrading to a gate-passing empty value. An unreadable
// review/thread/run state is not an empty one -- a transient gh failure must
// never merge or publish past a live finding.
function ghJson(args) {
  const rv = capture("gh", args);
  if (rv.status !== 0) {
    throw new Error("gh " + args.join(" ") + " failed (exit " + rv.status + ")" +
      (rv.stderr ? ": " + rv.stderr : "") + " -- an unreadable result is not an empty one");
  }
  if (!rv.stdout) throw new Error("gh " + args.join(" ") + " returned nothing");
  return JSON.parse(rv.stdout);
}

// ---- The review gate --------------------------------------------------------
// Merging is gated on BOTH the required checks and GitHub's authoritative
// review-thread resolution state for the PR's head -- the exact signal the
// main-protection ruleset's required_review_thread_resolution enforces.
//
// Why the thread state, not an inline P1/P2 severity badge: GitHub
// RE-ANCHORS an inline review comment's commit_id to the branch's CURRENT
// head every time the head moves, so a finding that has ALREADY been fixed
// and pushed still reports commit_id === head. A gate keyed on that mutable
// id reads a fixed finding as "still on the head" and blocks the merge
// forever. A review thread's isResolved flag, by contrast, flips only when
// the thread is resolved through the API: an open thread blocks, a resolved
// one clears, regardless of how the head has moved since the finding was
// raised. The thread state is therefore the stable truth the gate reads.
//
// The gate trusts EXACTLY these reviewer logins -- the GitHub App's two
// author forms (reviews post as the app, inline comments as its [bot]
// user). A substring match is spoofable on a public repo: any account whose
// login merely contains the reviewer's name could post a review on the head
// and race the real reviewer. The identity check gates only the "has the
// reviewer looked at this head yet" wait; the thread-resolution state (which
// GitHub itself attributes and enforces) is the authoritative merge gate.
const REVIEW_BOT_LOGINS = Object.freeze([
  // allow:ai-attribution -- the reviewer service's exact account logins;
  // an identity whitelist for the review-wait, not authorship attribution.
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]", // allow:ai-attribution -- reviewer account login
]);

// isReviewBot(login) -- exact-match membership in the frozen whitelist,
// tolerating the bare and the [bot]-suffixed author forms GitHub renders
// across GraphQL and REST. Exact, never substring: "codexfan" is not the
// reviewer.
function isReviewBot(login) {
  return REVIEW_BOT_LOGINS.indexOf(String(login || "")) !== -1;
}

// repoSlug() -- { owner, name } parsed from package.json repository.url. The
// GraphQL calls need literal owner/name in the query body; gh substitutes
// the {owner}/{repo} placeholders only on the REST endpoint, not inside a
// graphql query string.
function repoSlug() {
  let owner = "blamejs";
  let name = "stash";
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const url = (pkg.repository && pkg.repository.url) || "";
    const m = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (m) { owner = m[1]; name = m[2]; }
  } catch { /* fall back to defaults */ }
  return { owner, name };
}

// mergeArgs(branch, headSha) -- the gh argv for a merge BOUND to the head
// commit the verdict was computed for. `--match-head-commit` makes GitHub
// refuse the merge if the branch head moved after this iteration read it,
// so a push that lands between verdict and merge is re-polled instead of
// merged unreviewed.
export function mergeArgs(branch, headSha) {
  if (typeof headSha !== "string" || headSha.length < 7) {
    throw new TypeError("mergeArgs requires the reviewed head commit sha");
  }
  return ["pr", "merge", branch, "--squash", "--match-head-commit", headSha];
}

// unresolvedThreads(nodes) -- pure, fail-closed. `nodes` is the raw
// reviewThreads.nodes array from the PR's GraphQL payload. Returns the
// UNRESOLVED threads (isResolved === false), each mapped to a descriptor
// naming its file:line, reviewer, first finding line, and thread id (for the
// resolve mutation). Non-empty BLOCKS the merge, empty CLEARS it.
//
// Fail-closed on a non-array input: [] is this gate's PASS value, so a failed
// or absent query (which yields null/undefined, never a real empty thread
// list) MUST throw rather than read as "no threads block". A PR that
// genuinely has zero threads returns a real [] and clears -- only a broken
// query is the non-array that throws.
export function unresolvedThreads(nodes) {
  if (!Array.isArray(nodes)) {
    throw new TypeError("unresolvedThreads requires the reviewThreads node array -- " +
      "an unreadable result is not an empty one");
  }
  return nodes
    .filter((t) => t && t.isResolved === false)
    .map((t) => {
      const c = t.comments && t.comments.nodes && t.comments.nodes[0];
      return {
        id: t.id,
        path: t.path || "(pr-level)",
        line: t.line,
        author: (c && c.author && c.author.login) || "(unknown)",
        body: (c && c.body) || "",
      };
    });
}

// collectAllPages(fetchPage) -- pure: accumulate the nodes of a paginated
// GraphQL connection across EVERY page. fetchPage(cursor) returns
// { nodes, hasNextPage, endCursor } for the page after `cursor` (null for the
// first). A single page read is NOT the whole connection: a gate that trusts
// the first page treats a later page's open finding as absent. Fail closed --
// a page with unreadable nodes, or another page promised with no cursor,
// THROWS rather than returning a partial set. The guard bound is a runaway
// backstop far above any real thread count, never the precision mechanism.
export function collectAllPages(fetchPage) {
  const all = [];
  let cursor = null;
  for (let guard = 0; guard < 10000; guard++) {
    const page = fetchPage(cursor);
    if (!page || !Array.isArray(page.nodes)) {
      throw new Error("a paginated page returned no readable nodes -- refusing to " +
        "treat a partial result as the complete set");
    }
    for (const n of page.nodes) all.push(n);
    if (!page.hasNextPage) return all;
    if (!page.endCursor) {
      throw new Error("a paginated page reported a next page with no cursor -- " +
        "cannot continue safely, so refusing to clear on a partial set");
    }
    cursor = page.endCursor;
  }
  throw new Error("pagination exceeded the page guard -- aborting rather than looping");
}

// fetchUnresolvedThreads(prNum) -- the GraphQL wrapper around
// unresolvedThreads: page through ALL of the PR's review threads, then apply
// the pure verdict. A PR can carry more than one page of threads; reading only
// the first would let an open finding on a later page clear the merge gate.
// ghJson fails closed on a gh error, collectAllPages fails closed on a partial
// page, and unresolvedThreads fails closed on a null payload -- together, an
// unreadable or partial thread state never clears the gate.
function fetchUnresolvedThreads(prNum) {
  const slug = repoSlug();
  const nodes = collectAllPages((cursor) => {
    const after = cursor ? ", after:\"" + cursor + "\"" : "";
    const conn = ghJson(["api", "graphql", "-f",
      "query=query { repository(owner:\"" + slug.owner + "\",name:\"" + slug.name +
      "\") { pullRequest(number:" + prNum + ") { reviewThreads(first:100" + after + ") { " +
      "pageInfo { hasNextPage endCursor } nodes { " +
      "id isResolved path line comments(first:1) { nodes { author{login} body } } } } } } }",
      "--jq", ".data.repository.pullRequest.reviewThreads"]);
    return {
      nodes: conn && conn.nodes,
      hasNextPage: !!(conn && conn.pageInfo && conn.pageInfo.hasNextPage),
      endCursor: conn && conn.pageInfo && conn.pageInfo.endCursor,
    };
  });
  return unresolvedThreads(nodes);
}

// reviewerSignalsReview(surfaces, headSha, triggerId) -- pure: has the reviewer
// bot signalled a review of the head? The bot has THREE signal forms and all
// must count, or the wait times out on the common (clean) case:
//   (1) a formal review node whose reviewed commit is the head -- the form it
//       posts WITH findings;
//   (2) a clean-verdict issue comment citing the head's commit sha, posted
//       with no review node when it finds nothing; and
//   (3) a bare THUMBS_UP reaction by the bot on the `@codex review` trigger
//       comment, with NO review node and NO clean-verdict comment at all --
//       the bot's documented "no suggestions" signal.
// Forms (1) and (2) carry the head sha, so they self-bind to the head. A
// reaction carries NO sha, and GitHub exposes no push time to bind it by
// (pushedDate is null; a commit's committer date is mutable metadata a
// rebased/cherry-picked head can carry from before the reaction). So form (3)
// binds to the head by the IDENTITY of the trigger comment: the driver posts
// `@codex review` for THIS head only after it is the remote head (post-push),
// and passes that comment's id as triggerId. A bot thumbs-up on THAT comment is
// therefore a review of this head; a thumbs-up on any earlier trigger (a prior
// head's) is a different comment id and does not match. Absent a triggerId the
// reaction is unbindable and does NOT count (fail closed) -- the wait holds for
// a head-bound signal instead. surfaces: { reviews:[{author,commit}], comments:
// [{author,body,databaseId,reactions:[{content,login}]}] }.
export function reviewerSignalsReview(surfaces, headSha, triggerId) {
  if (typeof headSha !== "string" || headSha.length < 7) {
    throw new TypeError("reviewerSignalsReview requires the head commit sha");
  }
  const s = surfaces || {};
  const reviews = s.reviews || [];
  const comments = s.comments || [];
  const headPrefix = headSha.slice(0, 10);
  if (reviews.some((r) => r && isReviewBot(r.author) && r.commit === headSha)) return true;
  if (comments.some((c) => isReviewBot(c && c.author) &&
    typeof (c && c.body) === "string" && c.body.indexOf(headPrefix) !== -1)) return true;
  // (3) A bot thumbs-up on THE trigger comment the driver created for this head.
  if (triggerId == null) return false;
  return comments.some((c) =>
    c && c.databaseId != null && String(c.databaseId) === String(triggerId) &&
    Array.isArray(c.reactions) && c.reactions.some((rx) =>
      rx && rx.content === "THUMBS_UP" && isReviewBot(rx.login)));
}

// reviewerReviewedHead(prNum, headSha, triggerId) -- gather the review surfaces
// (reviews, and issue comments WITH their databaseId and reactions) and apply
// reviewerSignalsReview. triggerId is the id of the `@codex review` comment the
// driver posted for THIS head; it head-binds the thumbs-up form (form 3). The
// reviews and comments reads are recent-biased (last:) -- the head review and
// the driver's just-posted trigger are the newest items, so a busy PR cannot
// push them past the window -- while the thread gate itself pages in full
// (fetchUnresolvedThreads). ghJson fails closed to null on a gh error.
function reviewerReviewedHead(prNum, headSha, triggerId) {
  const slug = repoSlug();
  const reviews = (ghJson(["api", "graphql", "-f",
    "query=query { repository(owner:\"" + slug.owner + "\",name:\"" + slug.name +
    "\") { pullRequest(number:" + prNum + ") { reviews(last:100) { nodes { " +
    "author{login} commit{oid} } } } } }",
    "--jq", ".data.repository.pullRequest.reviews.nodes"]) || [])
    .map((r) => ({ author: r && r.author && r.author.login, commit: r && r.commit && r.commit.oid }));
  const comments = (ghJson(["api", "graphql", "-f",
    "query=query { repository(owner:\"" + slug.owner + "\",name:\"" + slug.name +
    "\") { pullRequest(number:" + prNum + ") { comments(last:60) { nodes { " +
    "databaseId body author{login} reactions(first:30){ nodes { content user{login} } } } } } } }",
    "--jq", ".data.repository.pullRequest.comments.nodes"]) || [])
    .map((c) => ({
      databaseId: c && c.databaseId,
      author: c && c.author && c.author.login,
      body: c && c.body,
      reactions: ((c && c.reactions && c.reactions.nodes) || [])
        .map((rx) => ({ content: rx && rx.content, login: rx && rx.user && rx.user.login })),
    }));
  return reviewerSignalsReview({ reviews, comments }, headSha, triggerId);
}

// waitForReviewOnHead(branch, prNum, headSha) -- block until the reviewer has
// reviewed the current head, fail-closed on timeout. The bot reviews a PR
// once on open and does NOT auto-review a pushed fix, so the head review can
// arrive a minute or two AFTER CI goes green; reading the thread gate before
// it posts would outrun an async finding. The bot is nudged once (it reviews
// only when asked to re-review), then the wait keeps polling. A timeout is a
// LOUD failure, never a silent pass.
function waitForReviewOnHead(branch, prNum, headSha) {
  const stepMs = 20000;
  const budgetMs = 10 * 60 * 1000;
  let waited = 0;
  let nudged = false;
  // Recover the trigger id `push`/`push-fix` (or a prior watch) recorded for
  // THIS head, so an already-present reaction clears the first poll instead of
  // stalling for a duplicate nudge. Head-matched, so a prior head's trigger is
  // never revived (reviewTriggerForHead).
  let triggerId = recoverReviewTrigger(headSha);
  console.log("waiting for the reviewer to review PR #" + prNum + " head " +
    headSha.slice(0, 12) + " before the thread gate (up to 10m; it reviews a bit after CI)...");
  while (waited <= budgetMs) {
    if (reviewerReviewedHead(prNum, headSha, triggerId)) {
      ok("reviewer has reviewed the current head -- the thread gate now sees its findings");
      return;
    }
    // Nudge ONCE, and remember the id of the trigger comment we post: a bot
    // thumbs-up on THAT comment (form 3) is a review of this head. Posted only
    // now -- after this head is confirmed the remote head -- so it can never be
    // a prior head's trigger. Recorded so the merge wait after watch reuses it.
    if (!nudged && waited >= 3 * stepMs) {
      triggerId = requestReviewForHead(prNum, headSha);
      nudged = true;
    }
    sleep(stepMs);
    waited += stepMs;
  }
  throw new Error("the reviewer has not reviewed PR #" + prNum + " head after 10m -- it reviews " +
    "asynchronously; a late finding must not be outrun by the merge. Re-run release.js watch once " +
    "it posts, or rerun with --no-review ONLY if the reviewer is confirmed disabled.");
}

// printUnresolvedThreads(unresolved) -- surface each blocking thread with the
// file:line, reviewer, first finding line, and the exact resolve mutation, so
// a blocked merge names its cause instead of an opaque state.
function printUnresolvedThreads(unresolved) {
  console.log("\n" + unresolved.length + " unresolved review thread(s) block the merge " +
    "(main-protection requires every thread resolved):\n");
  unresolved.forEach((t, i) => {
    const lines = (t.body || "").split("\n");
    let firstLine = "(no text)";
    for (const l of lines) { if (l.trim().length > 0) { firstLine = l; break; } }
    firstLine = firstLine.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/[*_`#>]/g, "").trim();
    console.log("  " + (i + 1) + ". [" + t.author + "] " + t.path +
      (t.line != null ? ":" + t.line : ""));
    console.log("     " + firstLine.slice(0, 160));
    console.log("     resolve: gh api graphql -f query='mutation { resolveReviewThread(" +
      "input:{threadId:\"" + t.id + "\"}){ thread { isResolved } } }'");
  });
  console.log("\nFix each finding at the root in a NEW commit via release.js push-fix (never dismiss),");
  console.log("then run the resolve command above for its thread. Re-run: release.js watch");
}

// requestReview(prNum) -- post the `@codex review` trigger for the current head
// and return the created comment's id, so a bot thumbs-up on THIS comment
// head-binds the review (reviewerSignalsReview form 3). `gh pr comment --body`
// takes the literal `@codex review` (no gh @file ambiguity) and prints the new
// comment's URL, whose trailing `#issuecomment-<id>` IS the databaseId the
// reactions query reports. A failed post or an unparseable URL returns null:
// the thumbs-up form then stays disabled (fail closed) until the review-node or
// clean-comment forms fire, or the wait times out loudly -- never a silent pass.
function requestReview(prNum) {
  const rv = capture("gh", ["pr", "comment", String(prNum), "--body", "@codex review"]);
  if (rv.status !== 0) return null;
  const m = /#issuecomment-(\d+)/.exec((rv.stdout || "") + "\n" + (rv.stderr || ""));
  return m ? m[1] : null;
}

// requestReviewForHead(prNum, headSha) -- post the trigger AND record its id for
// this head, so the next wait (and the merge wait after watch) recovers it
// instead of posting a duplicate. Returns the id for the current wait to use.
function requestReviewForHead(prNum, headSha) {
  const id = requestReview(prNum);
  recordReviewTrigger(headSha, id);
  return id;
}

// syncLockfileVersion(lock, version) -- return the parsed package-lock.json
// object with BOTH its top-level `version` and its root package
// (packages[""]) `version` set to `version`. The CI lockfile-sync gate
// compares BOTH fields to package.json; prepare bumps package.json, so the
// committed lockfile must move in lockstep or every cut fails that gate
// (0.1.4 shipped a package.json at 0.1.4 with a 0.1.3 lockfile and the gate
// blocked it). Zero dependencies means these two version fields are the
// ENTIRE delta -- there is no dependency graph to resolve -- so the rewrite
// is exact and needs no npm spawn. The object spreads preserve npm's key
// order (`version` already exists in each object, so it stays in place).
export function syncLockfileVersion(lock, version) {
  if (!lock || typeof lock !== "object") {
    throw new TypeError("syncLockfileVersion requires the parsed lockfile object");
  }
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new TypeError("syncLockfileVersion requires an x.y.z version, got '" + version + "'");
  }
  const packages = lock.packages && typeof lock.packages === "object" ? lock.packages : {};
  const root = packages[""] && typeof packages[""] === "object" ? packages[""] : {};
  return {
    ...lock,
    version,
    packages: { ...packages, "": { ...root, version } },
  };
}

// prepare [version] -- start a bump-only cut on a clean, synced main:
// bump package.json + package-lock.json (default: next patch) on a fresh
// release branch.
function cmdPrepare() {
  section("prepare");
  requireRemote();
  if (currentBranch() !== "main") throw new Error("prepare starts from main");
  if (!gitClean()) throw new Error("prepare requires a clean working tree");
  run("git", ["pull", "--ff-only"]);
  const current = readVersion();
  let next = process.argv[3];
  if (!next) {
    const parts = current.split(".").map(Number);
    parts[2] += 1;
    next = parts.join(".");
  }
  if (!/^\d+\.\d+\.\d+$/.test(next)) throw new Error("bad version '" + next + "'");
  // Branch FIRST, then mutate: if the release branch already exists the
  // checkout throws here, while main is still clean -- a version write
  // before the checkout would leave a dirty main behind every failed
  // prepare and force manual cleanup before a retry.
  run("git", ["checkout", "-b", "release-v" + next]);
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  pkg.version = next;
  writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
  // Bump the committed lockfile in the SAME step, so the lockfile-sync CI
  // gate (package-lock.json version + root version === package.json version)
  // passes on the very first push instead of failing every cut.
  const lockPath = join(ROOT, "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  writeFileSync(lockPath, JSON.stringify(syncLockfileVersion(lock, next), null, 2) + "\n");
  ok("version " + current + " -> " + next + " on branch release-v" + next +
    " (package.json + package-lock.json)");
  if (!readNotesPresent(next)) {
    console.log("next: write " + releaseNotesPath(next) + ", then regen -> commit -> push -> watch -> merge -> tag -> publish");
  }
}

// push -- publish the current branch, open its PR, and request review.
// No auto-merge: the merge belongs to `merge`, AFTER `watch` clears the
// checks + review-thread gate.
function cmdPush() {
  section("push");
  requireRemote();
  const branch = currentBranch();
  if (!branch || branch === "main") throw new Error("push runs from a release/fix branch, not main");
  if (!gitClean()) throw new Error("push requires a committed tree (run: release.js commit)");
  const version = readVersion();
  run("git", ["push", "-u", "origin", branch]);
  const existing = capture("gh", ["pr", "view", branch, "--json", "state", "--jq", ".state"]).stdout;
  if (existing !== "OPEN") {
    // The notes title a RELEASE branch; any other branch titles from its commit.
    const isReleaseBranch = branch === "release-v" + version;
    const notes = isReleaseBranch && readNotesPresent(version) ? readReleaseNotes(version) : null;
    const title = notes ? version + " \u2014 " + notes.headline : capture("git", ["log", "-1", "--format=%s"]).stdout;
    const body = notes ? notes.summary : "See the commit message.";
    run("gh", ["pr", "create", "--title", title, "--body", body]);
  }
  const prNum = ghJson(["pr", "view", branch, "--json", "number"]).number;
  const headSha = capture("git", ["rev-parse", "HEAD"]).stdout;
  requestReviewForHead(prNum, headSha);
  ok("PR open, review requested -- next: release.js watch");
}

// push-fix -m "..." -- land a root fix for review findings as a NEW
// signed commit (never amend), push it, and re-request review.
function cmdPushFix() {
  section("push-fix");
  requireRemote();
  const branch = currentBranch();
  if (!branch || branch === "main") throw new Error("push-fix runs from the branch under review");
  const mFlag = process.argv.indexOf("-m");
  const message = mFlag !== -1 ? process.argv[mFlag + 1] : null;
  if (!message) throw new Error('push-fix requires -m "<root-cause fix message>"');
  if (gitClean()) throw new Error("nothing to commit -- push-fix expects the fix in the working tree");
  run("node", ["scripts/smoke.js"]);
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", message]);
  verifyCommitSignature();
  run("git", ["push"]);
  const prNum = ghJson(["pr", "view", branch, "--json", "number"]).number;
  const headSha = capture("git", ["rev-parse", "HEAD"]).stdout;
  requestReviewForHead(prNum, headSha);
  ok("fix pushed as a new signed commit; review re-requested -- next: release.js watch");
}

// checksVerdict(rollup) -- fail-closed verdict over a PR's
// statusCheckRollup. The rollup mixes two entry shapes: a CheckRun
// (GitHub Actions et al.) reports status/conclusion; a StatusContext
// (commit statuses) reports state. Passing is a WHITELIST:
//
//   CheckRun       not COMPLETED -> waiting. Completed: SUCCESS passes;
//                  SKIPPED and NEUTRAL pass too -- both are deliberate
//                  no-op verdicts emitted by the check itself (a
//                  path-filtered workflow reports SKIPPED), and GitHub's
//                  own required-check semantics treat them as passing.
//                  Every other conclusion (FAILURE, CANCELLED, TIMED_OUT,
//                  ACTION_REQUIRED, STARTUP_FAILURE, STALE, absent, or
//                  anything unrecognized) is a terminal non-pass: block.
//   StatusContext  SUCCESS passes; PENDING / EXPECTED wait; everything
//                  else (ERROR, FAILURE, unrecognized) blocks.
//   neither shape  an entry this gate cannot read is never a pass: block.
//
// green requires at least one entry: an empty rollup means the checks
// have not attached yet, not that they passed.
export function checksVerdict(rollup) {
  const list = Array.isArray(rollup) ? rollup : [];
  const blocking = [];
  let pending = 0;
  for (const c of list) {
    const name = (c && (c.name || c.context)) || "(unnamed check)";
    if (c && c.state != null) {
      const state = String(c.state).toUpperCase();
      if (state === "SUCCESS") continue;
      if (state === "PENDING" || state === "EXPECTED") { pending += 1; continue; }
      blocking.push(name + " (" + state + ")");
    } else if (c && (c.status != null || c.conclusion != null)) {
      if (String(c.status || "").toUpperCase() !== "COMPLETED") { pending += 1; continue; }
      const conclusion = String(c.conclusion || "").toUpperCase();
      if (conclusion === "SUCCESS" || conclusion === "SKIPPED" || conclusion === "NEUTRAL") continue;
      blocking.push(name + " (" + (conclusion || "completed without a conclusion") + ")");
    } else {
      blocking.push(name + " (unreadable rollup entry)");
    }
  }
  return { blocking, pending, green: blocking.length === 0 && pending === 0 && list.length > 0 };
}

// watch -- gate the current branch's PR without merging: poll the required
// checks until every one is a whitelist pass, wait for the reviewer to review
// THIS head, then read GitHub's authoritative review-thread state. Any
// unresolved thread prints its finding + resolve command and exits non-zero;
// a clean gate proceeds to `merge`. --no-review skips the review gate,
// loudly, for repos without the reviewer installed. watch never mutates the
// repo -- the merge + sync + tag-target record live in `merge`.
function cmdWatch() {
  section("watch");
  requireRemote();
  const branch = currentBranch();
  if (!branch || branch === "main") throw new Error("watch runs from the branch whose PR is in flight");
  const skipReview = process.argv.indexOf("--no-review") !== -1;
  if (skipReview) console.log("!! review gate SKIPPED by explicit --no-review");
  // Poll the required checks until every one passes the whitelist. Fail
  // closed: a terminal check failure throws, an empty/unreadable rollup never
  // reads as green, and an exhausted poll throws rather than proceeding.
  let prNum = 0;
  let headSha = "";
  let checksGreen = false;
  for (let i = 0; i < 90; i++) {
    const pr = ghJson(["pr", "view", branch, "--json", "number,state,headRefOid,statusCheckRollup"]);
    prNum = pr.number;
    if (pr.state === "MERGED") {
      ok("PR already merged -- next: release.js merge (records the tag target)");
      return;
    }
    if (pr.state !== "OPEN") throw new Error("PR is " + pr.state);
    headSha = pr.headRefOid;
    const checks = checksVerdict(pr.statusCheckRollup);
    if (checks.blocking.length > 0) {
      throw new Error("checks failed: " + checks.blocking.join(", ") +
        " -- fix at the root, then release.js push-fix");
    }
    if (checks.green) { checksGreen = true; break; }
    console.log("  checks running (" + (i + 1) + ")...");
    sleep(20000);
  }
  if (!checksGreen) {
    throw new Error("watch timed out waiting for the required checks to pass");
  }
  ok("required checks green");
  if (skipReview) {
    ok("review gate skipped (--no-review) -- next: release.js merge");
    return;
  }
  // Wait for the reviewer to review THIS head, so an asynchronously-posted
  // finding lands in the thread set before the gate reads it, then read the
  // authoritative thread-resolution state.
  waitForReviewOnHead(branch, prNum, headSha);
  const unresolved = fetchUnresolvedThreads(prNum);
  if (unresolved.length > 0) {
    printUnresolvedThreads(unresolved);
    process.exit(3);
  }
  ok("reviewer has reviewed the head and zero unresolved threads remain -- next: release.js merge (re-checks)");
}

// merge -- the mutating half of the gated flow watch does not touch: re-check
// that the reviewer reviewed the head and zero threads are unresolved, that
// the PR is CLEAN + MERGEABLE, then squash-merge BOUND to the reviewed head
// (--match-head-commit refuses a merge if the head moved), sync main, drop the
// branch, and record the merge commit + pre-sync version so `tag` pins the
// signed tag to exactly that commit. --no-review skips the review gate loudly.
function cmdMerge() {
  section("merge");
  requireRemote();
  const branch = currentBranch();
  if (!branch || branch === "main") throw new Error("merge runs from the branch whose PR is in flight");
  const skipReview = process.argv.indexOf("--no-review") !== -1;
  if (skipReview) console.log("!! review gate SKIPPED by explicit --no-review");
  // The version this release branch carries, read BEFORE any sync of main: a
  // concurrent PR that bumps package.json on main after our merge must not
  // change the version this PR's tag records.
  const releaseVersion = readVersion();
  const pr = ghJson(["pr", "view", branch,
    "--json", "number,state,headRefOid,mergeStateStatus,mergeable,mergeCommit"]);
  const prNum = pr.number;
  let merged = pr.state === "MERGED";
  let mergeSha = merged ? ((pr.mergeCommit && pr.mergeCommit.oid) || "") : "";
  if (!merged) {
    if (pr.state !== "OPEN") throw new Error("PR is " + pr.state);
    const headSha = pr.headRefOid;
    if (!skipReview) {
      // Authoritative gate: do not read the merge state until the reviewer has
      // reviewed the current head, so its async findings are in the thread set.
      waitForReviewOnHead(branch, prNum, headSha);
      const unresolved = fetchUnresolvedThreads(prNum);
      if (unresolved.length > 0) {
        printUnresolvedThreads(unresolved);
        throw new Error("refusing to merge PR #" + prNum + " -- " +
          unresolved.length + " unresolved review thread(s)");
      }
    }
    // Re-read the merge state; CLEAN + MERGEABLE is the whitelist. A thread
    // can open in the window between the read above and here, so this is
    // belt-and-suspenders on top of the thread read (mergeStateStatus CLEAN
    // itself requires required_review_thread_resolution satisfied).
    const state = ghJson(["pr", "view", branch, "--json", "mergeStateStatus,mergeable"]);
    if (state.mergeStateStatus !== "CLEAN" || state.mergeable !== "MERGEABLE") {
      throw new Error("PR #" + prNum + " not mergeable (state=" + state.mergeStateStatus +
        " mergeable=" + state.mergeable + ") -- resolve the blocker, then re-run release.js merge");
    }
    // `gh pr merge` does NOT guarantee an immediate merge: on a base branch
    // with a merge queue it ADDS the PR to the queue and returns success,
    // leaving state OPEN until the queue lands it. Treating that as merged
    // would sync a stale main and tag a pre-merge commit. Fire the merge bound
    // to the reviewed head, then poll -- only an observed state === "MERGED"
    // sets merged=true and reads the merge commit.
    run("gh", mergeArgs(branch, headSha));
    console.log("  merge requested; waiting for state MERGED (a queued merge lands asynchronously)...");
    for (let i = 0; i < 90; i++) {
      const p = ghJson(["pr", "view", branch, "--json", "state,mergeCommit"]);
      if (p.state === "MERGED") {
        merged = true;
        mergeSha = (p.mergeCommit && p.mergeCommit.oid) || "";
        break;
      }
      if (p.state !== "OPEN") throw new Error("PR is " + p.state);
      sleep(20000);
    }
    if (!merged) throw new Error("merge timed out waiting for state MERGED");
  }
  run("git", ["checkout", "main"]);
  run("git", ["pull", "--ff-only"]);
  run("git", ["branch", "-D", branch], { allowFail: true });
  // Record the merge commit + pre-sync version so `tag` pins the signed tag to
  // THIS commit even if a concurrent PR has since advanced main past it.
  if (mergeSha) {
    writeFileSync(releaseStatePath(), JSON.stringify({ version: releaseVersion, mergeSha }) + "\n");
    console.log("recorded merge commit " + mergeSha.slice(0, 12) + " and version " + releaseVersion + " for tag");
  } else {
    console.log("!! could not read the PR merge commit -- tag will fall back to HEAD; verify it before publish");
  }
  ok("merged; main synced; branch " + branch + " removed -- next: release.js tag");
}

// publish -- push the version's signed tag (idempotent) and follow the
// tag-triggered publish run to completion, then confirm the registry
// serves the version.
function cmdPublish() {
  section("publish");
  requireRemote();
  const version = readVersion();
  const tag = "v" + version;
  if (capture("git", ["tag", "-l", tag]).stdout !== tag) {
    throw new Error("no local tag " + tag + " -- run: release.js tag");
  }
  const onRemote = capture("git", ["ls-remote", "origin", "refs/tags/" + tag]).stdout;
  if (!onRemote) run("git", ["push", "origin", tag]);
  const tagSha = capture("git", ["rev-parse", tag + "^{commit}"]).stdout;
  let runId = null;
  // The registry verification below is reachable ONLY through a run that
  // concluded success: an exhausted poll loop throws instead of falling
  // through.
  let concluded = false;
  for (let i = 0; i < 60; i++) {
    if (runId === null) {
      const runs = ghJson(["run", "list", "--workflow", "npm-publish.yml", "--limit", "5",
        "--json", "databaseId,headSha,status,conclusion,event"]);
      const match = runs.find(function (r) { return r.headSha === tagSha && r.event === "push"; });
      if (match) runId = match.databaseId;
    }
    if (runId !== null) {
      const st = ghJson(["run", "view", String(runId), "--json", "status,conclusion"]);
      if (st.status === "completed") {
        if (st.conclusion !== "success") {
          throw new Error("publish run " + runId + " concluded " + st.conclusion + " -- read its log, fix at the root, cut the next patch");
        }
        concluded = true;
        break;
      }
    }
    console.log("  publish run " + (runId === null ? "not visible yet" : runId + " in progress") + " (" + (i + 1) + ")...");
    sleep(20000);
  }
  if (!concluded) throw new Error("publish watch timed out");
  // The npm-publish workflow run concluded SUCCESS, so the package IS
  // published; the registry may still be propagating. Poll `npm view` over a
  // generous window and take the FIRST matching version as confirmation. A
  // single early empty read (propagation lag, or a transient registry hiccup)
  // is NOT a failure -- 0.1.4 published cleanly yet was declared a false FAIL
  // because a one-shot `npm view` ran before the registry served it. Only a
  // window that fully elapses with no matching version is a genuine failure,
  // and the workflow-run conclusion above remains the primary success signal.
  let served = "";
  for (let i = 0; i < 30; i++) {
    served = captureNpm("npm view @blamejs/stash@" + version + " version").stdout;
    if (served === version) break;
    console.log("  registry not yet serving " + version + " (got " +
      (served || "no answer") + "); re-checking (" + (i + 1) + ")...");
    sleep(10000);
  }
  if (served !== version) {
    throw new Error("npm-publish run " + runId + " concluded success but the registry has not " +
      "served " + version + " after the propagation window (last answer: " + (served || "none") +
      ") -- re-run release.js publish to re-verify once propagation settles");
  }
  ok("published: @blamejs/stash@" + version + " live on the registry, GitHub release created");
}

function cmdHelp() {
  console.log("release.js -- orchestrated release flow (no confirmation prompts; the gates are the confirmation)");
  console.log("");
  console.log("Usage:");
  console.log("  node scripts/release.js status    # version, branch, cleanliness, gate freshness");
  console.log("  node scripts/release.js regen     # regen CHANGELOG.md + api-snapshot.json");
  console.log("  node scripts/release.js smoke     # full smoke pipeline (scripts/smoke.js)");
  console.log("  node scripts/release.js commit    # gates -> git add -A -> signed commit from release-notes JSON");
  console.log("  node scripts/release.js tag       # annotated signed tag v<version> (clean tree, untagged version)");
  console.log("  node scripts/release.js help      # this banner");
  console.log("");
  console.log("  prepare [ver]  # clean main -> bump package.json + lockfile -> release branch");
  console.log("  push           # push branch, open PR from the notes, request review");
  console.log("  push-fix -m .. # root fix for review findings: new signed commit, push, re-request");
  console.log("  watch          # gate on checks AND the reviewer's review threads for the head (no merge)");
  console.log("  merge          # re-check mergeable + zero unresolved threads, then squash-merge + sync");
  console.log("  publish        # push the signed tag, follow the publish run, verify the registry");
  console.log("");
  console.log("`commit` requires release-notes/v<version>.json (headline + summary +");
  console.log("sections); it prints a stub template and refuses when the file is missing.");
}

// ---- Dispatch ---------------------------------------------------------------

function main() {
  const sub = process.argv[2] || "help";
  try {
    switch (sub) {
      case "prepare": cmdPrepare(); break;
      case "push": cmdPush(); break;
      case "push-fix": cmdPushFix(); break;
      case "watch": cmdWatch(); break;
      case "merge": cmdMerge(); break;
      case "publish": cmdPublish(); break;
      case "status": cmdStatus(); break;
      case "regen": cmdRegen(); break;
      case "smoke": cmdSmoke(); break;
      case "commit": cmdCommit(); break;
      case "tag": cmdTag(); break;
      case "help":
      case "--help":
      case "-h": cmdHelp(); break;
      default:
        console.error("release: unknown subcommand '" + sub + "'");
        cmdHelp();
        process.exit(1);
    }
  } catch (e) {
    console.error("\nrelease: FAIL -- " + ((e && e.message) || e));
    process.exit(1);
  }
}

// Dispatch only when executed directly (`node scripts/release.js ...`); an
// import (the unit tests drive the exported verdict functions) must load
// the module without running a subcommand.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
