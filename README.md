# Domain Experts — Folder Contribution Explorer

Identify who the domain experts are in a code repository by analyzing git history per folder.

Navigate a folder tree and see each contributor's percentage share of commits, code churn, and recency-weighted activity at any level of the hierarchy.

---

## How it works

1. **`generate.js`** — reads a checked-out repo's git history and writes a `contributions.json` file.  
   Each folder in the repo gets its own entry with rolled-up contributor stats covering that folder's entire subtree. Stats are computed for both all-time history and a configurable recent window, so no data is thrown away at generation time.

2. **`index.html`** — a static single-page viewer. Upload the JSON, click through the folder tree, and see ranked contributor percentage bars on the right. No server required; open it directly in a browser.

---

## Quick start

```bash
# 1 — generate data from a checked-out repo
node generate.js /path/to/your/repo contributions.json

# 2 — open the viewer in your browser
open index.html   # macOS
# then click "Load contributions.json" and pick the file you just created
```

To try the viewer without running git first, load the included `sample-contributions.json`.

---

## Generator

```
node generate.js [repoPath] [outFile] [options]
```

| Argument / option | Default | Description |
|---|---|---|
| `repoPath` | `.` | Path to the checked-out git repository |
| `outFile` | `contributions.json` | Path to write the output JSON |
| `--recent-days N` | `365` | Window (in days) used for the "Recent" scope in the viewer |
| `--half-life N` | `365` | Half-life (in days) for the recency-weighted score |

**Examples**

```bash
# analyze the current directory, defaults
node generate.js

# analyze a specific repo, custom output path
node generate.js ~/code/myproject ~/Desktop/myproject-experts.json

# shorten the recent window to 6 months
node generate.js ~/code/myproject out.json --recent-days 180
```

**Notes**

- Zero npm dependencies — only Node.js built-in modules (`child_process`, `readline`, `fs`, `path`).
- Merge commits are excluded (`--no-merges`).
- Author identities are resolved via `.mailmap` automatically (`%aN` / `%aE`).
- Binary files count toward commit totals but add 0 lines changed.
- File renames are resolved to the new path.
- The root folder is represented as an empty string `""` in the JSON.

---

## Viewer

Open `index.html` in any modern browser (Chrome, Firefox, Safari, Edge).

### Navigation

- The **left panel** shows a collapsible folder tree. Click any folder to select it.
- The **right panel** shows the contributors for the selected folder, sorted by their share of the chosen metric.
- The **breadcrumb** at the top of the right panel lets you jump back up the path.

### Metrics

| Metric | What it measures |
|---|---|
| **Commits** | Distinct commits that touched anything in this folder's subtree |
| **Commits + Lines** | 70% commit share + 30% line-churn share (combined weighted rank) |
| **Recency-weighted** | Each commit contributes `0.5^(age / half-life)` — recent work counts more |

### Scope toggle

**All time** / **Recent** — applies to Commits and Commits + Lines. Switching to Recent can reveal that a historically dominant contributor has become inactive. Recency-weighted always covers all history by design (the decay handles it).

### Last-active column

Shows how long ago each contributor last committed to the selected folder. Dates older than one year are highlighted in amber as a signal of potentially stale expertise.

---

## Output JSON schema

```jsonc
{
  "generatedAt": 1782345600,   // epoch seconds when the script ran
  "nowTs": 1782345600,         // same value, used by the viewer for age calculations
  "recentDays": 365,           // --recent-days setting used
  "halfLifeDays": 365,         // --half-life setting used
  "repoName": "my-repo",
  "totalCommits": 1024,
  "nodes": [
    {
      "path": "",              // "" = repo root; otherwise e.g. "src/api"
      "contributors": [
        {
          "name": "Alice Andersson",
          "email": "alice@example.com",
          "commits": 50,
          "commitsRecent": 18,
          "lines": 8000,
          "linesRecent": 2600,
          "lastTs": 1778889600,   // epoch seconds of most recent commit
          "score": 33.0           // recency-weighted score
        }
      ]
    }
  ]
}
```

---

## Tuning

**Commits + Lines weighting** — edit the two constants at the top of the `<script>` block in `index.html`:

```js
const W_COMMITS = 0.7;   // weight of commit share
const W_LINES   = 0.3;   // weight of line-churn share
```

**Recency half-life and recent window** — pass `--half-life` and `--recent-days` to `generate.js` at generation time.

---

## Requirements

- Node.js ≥ 16 (for the generator)
- Git installed and available on `$PATH`
- Any modern browser (for the viewer)
