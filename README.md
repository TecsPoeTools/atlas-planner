# Atlas Tree Planner

I got tired of clicking around the atlas tree trying to figure out the cheapest
way to reach the notables I actually want, so I made this. You click the nodes
you care about, and it works out the shortest tree that gets all of them.

**Try it:** https://tecspoetools.github.io/atlas-planner/

Built for the 3.30 atlas (150 points this league).

## What it does

**Finds the cheapest path for you.** Click any notable, keystone or small node
and it becomes a target. Every time you add or drop one, the whole tree is
rebuilt from scratch with as few points as possible. When two routes cost the
same, it goes through the small nodes you find useful (map drop chance, pack
size and so on; you pick them under *⋯ → Path preferences*).
Click the centre of a wheel to take the whole wheel at once; hover it first to
see what it costs.

**Or path it yourself.** Turn off *Smart path* and it works like in game:
each click takes the shortest path from what you already have, and clicking an
allocated node refunds it along with anything that gets cut off.

**Shows you the order to take things in.** Step through your targets in the
order you added them with the ‹ › buttons (or the arrow keys): each step shows
the target and its exact points (points 1–11, 12–19…). Every step only takes
nodes from the final tree, so you never refund anything on the way. Drag the
*View at point* slider to any point count, and press `O` to put the numbers on
the tree.

**Choose-one notables work like in game.** Click one and pick the effect right
there. The summary only shows the one you chose.

**Adds your modifiers up.** The Modifiers tab merges identical stats, so five
"+25% chance to contain a Strongbox" nodes show up as one +125% line.

**Highlights mechanics.** Hover any wheel and every other wheel of the same
mechanic lights up. *Focus* dims the rest of the map so the things you care
about stand out. It has two lists, each item on its own: *Generic* (map-wide
wheels like Maps or Threads, the common small path nodes, keystones) and *League
mechanics* (Shrines first, then roughly by how popular they are). Search finds
mechanics by name or by what their nodes do, so "currency" finds the ones with
currency nodes.

**Saves, shares and manages your trees.** The tree name at the top is your list
of saved trees: open, rename, share, compare or delete them, or open a link
someone sent you. *Save* (`Ctrl+S`) keeps the tree in your browser, and a dot
next to the name means it has unsaved changes. *Share* copies a short link that
opens the tree anywhere. *Compare* overlays another tree on yours: orange for
nodes only in yours, blue for nodes only in the other one.

Also: right-click to block a node so paths avoid it, undo/redo, short share
links, light/dark theme, and a single-file offline copy.

## Shortcuts

| Key | | Key | |
|---|---|---|---|
| `/` | search | `F` | fit to screen |
| `Ctrl+Z` / `Ctrl+Y` | undo / redo | `B` | block mode |
| `P` | smart path on / off | `O` | point numbers |
| `←` / `→` | step through the order | `Home` | show the whole tree |
| `Ctrl+S` | save the tree | | |
| `Esc` | close / clear | `?` | help |

## Running it yourself

It's just static files. In the folder, run:

```
python -m http.server 8000
```

and open http://localhost:8000. (Double-clicking `index.html` won't work because
the browser blocks it from loading the data. `atlas-tree.html` does work
offline: it's everything bundled into one file.)

## When a new league comes out

GGG publishes the atlas data on GitHub at
[grindinggear/atlastree-export](https://github.com/grindinggear/atlastree-export).
Download the new version, then:

```
python tools/build_data.py path/to/atlastree-export --version 3.31.0
python tools/make_standalone.py atlas-tree.html
```

If the point total changed, update `LEAGUE_POINTS` at the top of `app.js`.
Then check the path finder still finds the cheapest trees on the new data:

```
node tools/test_optimizer.js
```

It compares the planner against an exact solver on random sets of 2–9 targets
and fails if any tree uses more points than it needs.
Commit, push, done.

If you'd rather not do that by hand, `tools/deploy-workflow.yml` is a GitHub
Action that checks for new data every Monday and redeploys. To use it, create
`.github/workflows/deploy.yml` on github.com (*Add file → Create new file*),
paste the workflow in, and switch *Settings → Pages → Source* to
*GitHub Actions*.

## Hosting

GitHub Pages serves it straight from the repo: *Settings → Pages → Deploy from
a branch → `main` / root*. Every push updates the site.

## Files

```
index.html, style.css, app.js   the page
optimizer.js                    the pathing (runs in a background worker)
data/league.json                tree data, generated from GGG's export
assets/                         node icons and frames from GGG's export
tools/build_data.py             turns GGG's export into data/ and assets/
tools/make_standalone.py        bundles everything into atlas-tree.html
```

## Credits

Not affiliated with Grinding Gear Games. Path of Exile, the atlas data and all
the art belong to them. The code here is MIT licensed; do what you like with it.
