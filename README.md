# Atlas Tree Planner

A Path of Exile atlas passive tree planner. Pick the notables you want and the
cheapest tree that reaches all of them is rebuilt every time you add or drop one.

**Live site:** `https://YOUR-USERNAME.github.io/atlas-planner/`

## Features

- **Automatic pathing.** Click nodes to target them; the planner finds the
  fewest-points tree that connects them all. When two routes cost the same, it
  takes the one through more of your preferred small passives (Map Drop Chance,
  Pack Size, and so on; set them under *Plan → Path preferences*).
- **Allocation order.** Targets are listed in the order you'd level them, with
  the exact point numbers each one takes. Drag to reorder. The *View at point*
  slider shows the tree and its modifiers at any point count, and `O` shows
  point numbers on the tree.
- **Mechanic highlight.** Hovering any wheel lights up every wheel of that
  mechanic. The *Focus* menu dims everything except one mechanic, or all the
  wheels that work in every map.
- **Modifier summary.** Identical modifiers are added together
  (two "+25% chance" nodes read as "+50%"), grouped by mechanic. Notables with
  a choice get radio buttons.
- **League and Ruthless** trees, **block** nodes (right-click) so paths avoid
  them, **undo/redo**, short **share links**, light and dark themes, and an
  offline single-file copy.

## Keyboard

| Key | Action | Key | Action |
|---|---|---|---|
| `/` | Search | `F` | Fit to screen |
| `Ctrl+Z` | Undo | `Ctrl+Y` | Redo |
| `B` | Block mode | `O` | Point numbers |
| `M` | League / Ruthless | `?` | Help |

## Running locally

It is a static site. From the repository folder:

```
python -m http.server 8000
```

then open http://localhost:8000. (Opening `index.html` directly from disk will
not load the data; use the server, or the single-file build below.)

## Publishing (GitHub Pages)

The site is plain static files, so GitHub Pages can serve the repository as-is:
**Settings → Pages → Build and deployment → Source: Deploy from a branch →
Branch: `main`, folder `/ (root)` → Save.** Every push to `main` redeploys.

## Updating the tree data

When GGG publishes a new export, download it from
[atlastree-export](https://github.com/grindinggear/atlastree-export) and run:

```
python tools/build_data.py path/to/atlastree-export --version 3.31.0
python tools/make_standalone.py atlas-tree.html
```

then commit and push.

### Optional: automatic weekly updates

`tools/deploy-workflow.yml` is a GitHub Action that checks GGG's export every
Monday, rebuilds `data/` and `assets/` when anything changed, and redeploys.
To turn it on:

1. On github.com, open the repository and choose **Add file → Create new file**.
2. Name it `.github/workflows/deploy.yml` and paste in the contents of
   `tools/deploy-workflow.yml`. Commit.
3. In **Settings → Pages**, switch **Source** to **GitHub Actions**.

GitHub pauses scheduled workflows on repositories with no activity for 60 days;
run it by hand from the **Actions** tab when that happens.

## Project layout

```
index.html, style.css, app.js   the page
optimizer.js                    path optimizer (runs in a Web Worker)
data/league.json, ruthless.json generated tree data
assets/*.webp                   sprite sheets from the GGG export
tools/build_data.py             export -> data/ + assets/
tools/make_standalone.py        bundle into one HTML file
tools/deploy-workflow.yml       optional auto-update GitHub Action
atlas-tree.html                 single-file offline copy (generated)
```

## Disclaimer

Fan-made tool, not affiliated with or endorsed by Grinding Gear Games. Path of
Exile, the atlas tree data and its artwork belong to Grinding Gear Games. The
code is MIT licensed (see `LICENSE`).
