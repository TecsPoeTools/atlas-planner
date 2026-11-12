#!/usr/bin/env node
// Checks optimizer.js against an exact solver on random target sets.
//
//   node tools/test_optimizer.js [cases=150] [budgetMs=180] [seed=1]
//
// The exact solver is Dreyfus-Wagner on the node-weighted atlas graph. Each node
// costs BIG - value, so the cheapest tree has the fewest points first and the most
// preferred small nodes second: the same order the planner uses. Exit code 1 if
// the optimizer ever returns an invalid tree or uses more points than needed.
'use strict';
const fs = require('fs');
const path = require('path');

const [cases = 150, budget = 180, seed0 = 1] = process.argv.slice(2).map(Number);
const ROOT = path.join(__dirname, '..');
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/league.json'), 'utf8'));
const { AtlasOptimizer: OPT } = require(path.join(ROOT, 'optimizer.js'));

// Same setup as setupOptimizer() in app.js, with the default path preferences.
const DEFAULT_PREFS = ['Map Drop Chance', 'Higher Map Tier Chance', 'Map Pack Size', 'Map Modifier Effect', 'Map Rare Monsters', 'Map Magic Monsters', 'Item Rarity'];
const N = D.nodes, ADJ = D.adj, START = new Set(D.start), ids = Object.keys(N);
const VAL = {};
for (const id of ids) if (N[id].t === 'p' && DEFAULT_PREFS.includes(N[id].nm)) VAL[id] = 1;
const PASS = ids.filter(id => N[id].t !== 'm');
OPT.setup({ adj: ADJ, start: [...START], pass: PASS, val: VAL });

const BIG = 1000;
const w = id => BIG - (VAL[id] || 0);

// Min-heap keyed on cost.
class Heap {
  constructor() { this.a = []; }
  push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}

// Exact cheapest tree: returns { cost, points } or null if some target is unreachable.
function exact(terms, ban) {
  const nodes = PASS.filter(id => !ban.has(id) && !START.has(id));
  const R = 0, idx = new Map(); nodes.forEach((id, i) => idx.set(id, i + 1)); // 0 = all start nodes merged
  const n = nodes.length + 1, nb = Array.from({ length: n }, () => []), wt = new Float64Array(n);
  const ix = id => START.has(id) ? R : idx.get(id);
  for (const id of nodes) wt[idx.get(id)] = w(id);
  for (const id of [...START, ...nodes]) for (const b of ADJ[id] || []) {
    const u = ix(id), v = ix(b);
    if (u === undefined || v === undefined || u === v) continue;
    if (!nb[u].includes(v)) nb[u].push(v);
  }
  const T = terms.filter(t => !START.has(t)).map(ix);
  if (T.some(t => t === undefined)) return null;
  const k = T.length, full = (1 << k) - 1;
  if (!k) return { cost: 0, points: 0 };
  // dp[S][v]: cheapest tree holding the targets in S plus v, not counting v itself.
  const dp = Array.from({ length: full + 1 }, () => new Float64Array(n).fill(Infinity));
  for (let i = 0; i < k; i++) dp[1 << i][T[i]] = 0;
  for (let S = 1; S <= full; S++) {
    const d = dp[S];
    if (S & (S - 1)) for (let A = (S - 1) & S; A; A = (A - 1) & S) {
      if (A < (S ^ A)) continue; // each split once
      const a = dp[A], b = dp[S ^ A];
      for (let v = 0; v < n; v++) { const c = a[v] + b[v]; if (c < d[v]) d[v] = c; }
    }
    // Grow: the tree hanging off v can be reached from a neighbour u by paying for v.
    const h = new Heap();
    for (let v = 0; v < n; v++) if (d[v] < Infinity) h.push(d[v], v);
    while (h.size) {
      const [c, v] = h.pop(); if (c > d[v]) continue;
      const nc = c + wt[v];
      for (const u of nb[v]) if (nc < d[u]) { d[u] = nc; h.push(nc, u); }
    }
  }
  const cost = dp[full][R];
  if (cost === Infinity) return null;
  return { cost, points: Math.round(cost / BIG) };
}

function check(tree, terms, ban) {
  const t = new Set(tree), errs = [];
  for (const s of START) if (!t.has(s)) errs.push('missing start');
  for (const x of terms) if (!t.has(x)) errs.push(`missing target ${x}`);
  for (const x of t) {
    if (ban.has(x)) errs.push(`uses blocked ${x}`);
    if (N[x].t === 'm') errs.push(`uses mastery ${x}`);
  }
  const seen = new Set(START), q = [...START];
  while (q.length) { const c = q.pop(); for (const b of ADJ[c] || []) if (t.has(b) && !seen.has(b)) { seen.add(b); q.push(b); } }
  if (seen.size !== t.size) errs.push(`${t.size - seen.size} nodes not connected to the start`);
  return errs;
}

let seed = seed0;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pickFrom = arr => arr[Math.floor(rnd() * arr.length)];
const notables = ids.filter(id => N[id].t === 'n' || N[id].t === 'k');
const smalls = ids.filter(id => N[id].t === 'p');

let ok = 0, worse = 0, tieWorse = 0, invalid = 0, skipped = 0, extra = 0;
const t0 = Date.now();
for (let c = 0; c < cases; c++) {
  const k = 2 + Math.floor(rnd() * 8); // 2..9 targets
  const terms = new Set();
  while (terms.size < k) terms.add(rnd() < 0.85 ? pickFrom(notables) : pickFrom(smalls));
  const ban = new Set();
  if (rnd() < 0.3) for (let i = 0, m = 1 + Math.floor(rnd() * 4); i < m; i++) { const b = pickFrom(smalls); if (!terms.has(b)) ban.add(b); }
  const tl = [...terms], bl = [...ban];

  const ex = exact(tl, ban);
  if (!ex) { skipped++; continue; }
  const r = OPT.optimize(tl, bl, budget);
  const label = `case ${c}: targets=[${tl}] blocked=[${bl}]`;
  const errs = r.miss.length ? [`reported unreachable: ${r.miss}`] : check(r.tree, tl, ban);
  if (errs.length) { invalid++; console.log(`INVALID ${label}\n  ${errs.join('\n  ')}`); continue; }
  const pts = r.tree.filter(id => !START.has(id)).length;
  const cost = r.tree.reduce((s, id) => s + (START.has(id) ? 0 : w(id)), 0);
  if (pts > ex.points) { worse++; extra += pts - ex.points; console.log(`WORSE   ${label}\n  optimizer ${pts} points, best ${ex.points}`); }
  else if (cost > ex.cost) { tieWorse++; console.log(`TIE     ${label}\n  ${pts} points, but ${Math.round(cost - ex.cost)} fewer preferred nodes than possible`); }
  else ok++;
}
const run = cases - skipped;
console.log(`\n${run} cases (${skipped} skipped as unreachable) in ${((Date.now() - t0) / 1000).toFixed(1)}s, budget ${budget}ms`);
console.log(`  optimal:            ${ok}`);
console.log(`  optimal points, weaker tie-break: ${tieWorse}`);
console.log(`  too many points:    ${worse}${worse ? ` (${extra} extra in total)` : ''}`);
console.log(`  invalid trees:      ${invalid}`);
process.exit(worse || invalid ? 1 : 0);
