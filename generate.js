#!/usr/bin/env node
'use strict';

/*
 * generate.js — Domain-Experts contribution analyzer.
 *
 * Reads the git history of a checked-out repository and writes a
 * contributions.json describing, for every folder, who contributed and how
 * much — rolled up over each folder's entire subtree.
 *
 * Zero npm dependencies (Node built-in modules only).
 *
 * Usage:
 *   node generate.js [repoPath] [outFile] [--recent-days N] [--half-life N]
 *
 * Defaults: repoPath=".", outFile="contributions.json",
 *           --recent-days=365, --half-life=365
 */

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

// ---- CLI parsing ----------------------------------------------------------
function parseArgs(argv) {
  const opts = { repo: '.', out: 'contributions.json', recentDays: 365, halfLifeDays: 365 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--recent-days') opts.recentDays = parseFloat(argv[++i]);
    else if (a === '--half-life') opts.halfLifeDays = parseFloat(argv[++i]);
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0); }
    else positional.push(a);
  }
  if (positional[0]) opts.repo = positional[0];
  if (positional[1]) opts.out = positional[1];
  if (!(opts.recentDays > 0)) opts.recentDays = 365;
  if (!(opts.halfLifeDays > 0)) opts.halfLifeDays = 365;
  return opts;
}

function printHelp() {
  console.log(`Domain-Experts analyzer

Usage:
  node generate.js [repoPath] [outFile] [options]

Arguments:
  repoPath   Path to a checked-out git repo (default: ".")
  outFile    Output JSON path (default: "contributions.json")

Options:
  --recent-days N   Window (days) for "recent" metrics (default: 365)
  --half-life N     Half-life (days) for the recency-weighted score (default: 365)
  -h, --help        Show this help
`);
}

// ---- helpers --------------------------------------------------------------

// A file path → the list of folders it belongs to, including all ancestors
// and the repo root (represented as ""). e.g. "a/b/c.js" → ["", "a", "a/b"].
function ancestorDirs(filePath) {
  const parts = filePath.split('/');
  parts.pop(); // drop the file name itself
  const dirs = [''];
  let acc = '';
  for (const p of parts) {
    if (p === '') continue;
    acc = acc === '' ? p : acc + '/' + p;
    dirs.push(acc);
  }
  return dirs;
}

// git --numstat encodes renames inside the path field. Resolve to the NEW path.
//   "old/path => new/path"            → "new/path"
//   "src/{old => new}/file.js"        → "src/new/file.js"
function resolveRename(p) {
  if (p.indexOf(' => ') === -1) return p;
  p = p.replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2');
  const idx = p.indexOf(' => ');
  if (idx !== -1) p = p.slice(idx + 4);
  return p.replace(/\/{2,}/g, '/').replace(/^\//, '');
}

// ---- main -----------------------------------------------------------------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  const nowTs = Math.floor(Date.now() / 1000);
  const recentCutoff = nowTs - opts.recentDays * 86400;
  const cutoff30  = nowTs - 30  * 86400;
  const cutoff90  = nowTs - 90  * 86400;
  const cutoff180 = nowTs - 180 * 86400;

  // Control characters used as field/record markers so arbitrary author names
  // and paths can never collide with the delimiter.
  const SOH = '\x01';
  const US = '\x1f';
  const format = `--format=${SOH}%H${US}%aN${US}%aE${US}%at`;
  const gitArgs = ['-C', opts.repo, '-c', 'core.quotePath=false', 'log',
    '--no-merges', '--numstat', format];

  const child = spawn('git', gitArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (err) => {
    console.error('Failed to launch git:', err.message);
    process.exit(1);
  });

  // tree: Map<dirPath, Map<authorKey, stats>>
  const tree = new Map();
  let totalCommits = 0;
  let cur = null;       // current commit context { ts, name, email, key }
  let seenDirs = null;  // dirs already credited a commit for the current commit

  function getStats(dir, key, name, email) {
    let authors = tree.get(dir);
    if (!authors) { authors = new Map(); tree.set(dir, authors); }
    let st = authors.get(key);
    if (!st) {
      st = { name, email, commits: 0, commitsRecent: 0, lines: 0,
        linesAdded: 0, linesRemoved: 0, linesRecent: 0,
        linesAddedRecent: 0, linesRemovedRecent: 0,
        commits30: 0, commits90: 0, commits180: 0,
        lines30: 0, lines90: 0, lines180: 0,
        lastTs: 0, firstTs: 0, score: 0 };
      authors.set(key, st);
    }
    return st;
  }

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.length === 0) return;

    if (line.charCodeAt(0) === 1) {
      // commit header: \x01 hash US name US email US timestamp
      const f = line.slice(1).split(US);
      const ts = parseInt(f[3], 10) || 0;
      const name = f[1] || '';
      const email = (f[2] || '').toLowerCase();
      cur = { ts, name, email, key: email || ('name:' + name) };
      seenDirs = new Set();
      totalCommits++;
      return;
    }

    if (!cur) return;

    // numstat line: added \t removed \t path
    const tab1 = line.indexOf('\t');
    if (tab1 === -1) return;
    const tab2 = line.indexOf('\t', tab1 + 1);
    if (tab2 === -1) return;

    const addedStr = line.slice(0, tab1);
    const removedStr = line.slice(tab1 + 1, tab2);
    const filePath = resolveRename(line.slice(tab2 + 1));
    if (!filePath) return;

    const added = addedStr === '-' ? 0 : (parseInt(addedStr, 10) || 0); // '-' = binary
    const removed = removedStr === '-' ? 0 : (parseInt(removedStr, 10) || 0);
    const churn = added + removed;
    const inRecent = cur.ts >= recentCutoff;
    const weight = Math.pow(0.5, ((nowTs - cur.ts) / 86400) / opts.halfLifeDays);

    for (const dir of ancestorDirs(filePath)) {
      const st = getStats(dir, cur.key, cur.name, cur.email);
      st.lines += churn;
      st.linesAdded += added;
      st.linesRemoved += removed;
      if (inRecent) {
        st.linesRecent += churn;
        st.linesAddedRecent += added;
        st.linesRemovedRecent += removed;
      }
      if (cur.ts >= cutoff30)  st.lines30  += churn;
      if (cur.ts >= cutoff90)  st.lines90  += churn;
      if (cur.ts >= cutoff180) st.lines180 += churn;
      if (!seenDirs.has(dir)) {
        // count each commit at most once per folder
        seenDirs.add(dir);
        st.commits += 1;
        if (inRecent) st.commitsRecent += 1;
        if (cur.ts >= cutoff30)  st.commits30  += 1;
        if (cur.ts >= cutoff90)  st.commits90  += 1;
        if (cur.ts >= cutoff180) st.commits180 += 1;
        st.score += weight;
        if (!st.firstTs || cur.ts < st.firstTs) st.firstTs = cur.ts;
      }
      if (cur.ts > st.lastTs) st.lastTs = cur.ts;
    }
  });

  let parsed = false, closed = false, exitCode = 0;
  function finish() {
    if (!(parsed && closed)) return;
    if (exitCode !== 0) {
      console.error('git exited with code ' + exitCode);
      if (stderr.trim()) console.error(stderr.trim());
      process.exit(exitCode || 1);
    }
    writeOutput();
  }

  function writeOutput() {
    const nodes = [];
    for (const [dir, authors] of tree) {
      const contributors = [];
      for (const st of authors.values()) {
        contributors.push({
          name: st.name,
          email: st.email,
          commits: st.commits,
          commitsRecent: st.commitsRecent,
          lines: st.lines,
          linesAdded: st.linesAdded,
          linesRemoved: st.linesRemoved,
          linesRecent: st.linesRecent,
          linesAddedRecent: st.linesAddedRecent,
          linesRemovedRecent: st.linesRemovedRecent,
          commits30: st.commits30,
          commits90: st.commits90,
          commits180: st.commits180,
          lines30: st.lines30,
          lines90: st.lines90,
          lines180: st.lines180,
          lastTs: st.lastTs,
          firstTs: st.firstTs,
          score: Math.round(st.score * 10000) / 10000,
        });
      }
      nodes.push({ path: dir, contributors });
    }
    nodes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const output = {
      generatedAt: nowTs,
      nowTs,
      recentDays: opts.recentDays,
      halfLifeDays: opts.halfLifeDays,
      repoName: path.basename(path.resolve(opts.repo)),
      totalCommits,
      nodes,
    };
    fs.writeFileSync(opts.out, JSON.stringify(output));
    console.error(`Wrote ${opts.out}: ${nodes.length} folders, ` +
      `${totalCommits} commits, repo "${output.repoName}"`);
  }

  rl.on('close', () => { parsed = true; finish(); });
  child.on('close', (code) => { exitCode = code || 0; closed = true; finish(); });
}

main();
