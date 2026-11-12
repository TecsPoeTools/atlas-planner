// Atlas path optimizer: cheapest tree (Steiner tree, 1 point per node) that connects
// the start to every target. Ties on point count go to the route with more
// "preferred" small passives. Runs as a Web Worker, or on the page as a fallback.
(function (root) {
  let ADJ = {}, START = new Set(), PASS = new Set(), VAL = {};

  function setup(d) { ADJ = d.adj; START = new Set(d.start); PASS = new Set(d.pass); VAL = d.val || {}; }
  const val = id => VAL[id] || 0;

  // Layered BFS from every node in `src`. Returns the shortest path to the first goal
  // reached, preferring the highest total value among equally short paths.
  function grow(src, isGoal, ban, maxDepth) {
    const best = new Map();
    let frontier = [];
    for (const s of src) { best.set(s, { p: null, v: 0 }); frontier.push(s); }
    let depth = 0;
    while (frontier.length && depth < (maxDepth || Infinity)) {
      depth++;
      const layer = new Map();
      for (const c of frontier) {
        const cv = best.get(c).v;
        for (const b of ADJ[c] || []) {
          if (best.has(b) || ban.has(b) || !PASS.has(b)) continue;
          const nv = cv + val(b), cur = layer.get(b);
          if (!cur || nv > cur.v) layer.set(b, { p: c, v: nv });
        }
      }
      let hit = null, hv = -1;
      for (const [b, info] of layer) { best.set(b, info); if (isGoal(b) && info.v > hv) { hit = b; hv = info.v; } }
      if (hit) {
        const path = [];
        for (let c = hit; c != null && !src.has(c); c = best.get(c).p) path.push(c);
        return path;
      }
      frontier = [...layer.keys()];
    }
    return null;
  }

  function prune(tree, terms) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of tree) {
        if (START.has(id) || terms.has(id)) continue;
        let deg = 0; for (const b of ADJ[id] || []) if (tree.has(b)) deg++;
        if (deg <= 1) { tree.delete(id); changed = true; }
      }
    }
  }

  function connectNearest(terms, ban) {
    const tree = new Set(START), left = new Set([...terms].filter(t => !tree.has(t))), miss = [];
    while (left.size) {
      const p = grow(tree, b => left.has(b), ban);
      if (!p) { miss.push(...left); break; }
      for (const c of p) { tree.add(c); left.delete(c); }
    }
    return { tree, miss };
  }

  function connectOrdered(order, ban) {
    const tree = new Set(START), miss = [];
    for (const t of order) {
      if (tree.has(t)) continue;
      const p = grow(tree, b => b === t, ban);
      if (!p) { miss.push(t); continue; }
      for (const c of p) tree.add(c);
    }
    return { tree, miss };
  }

  const treeVal = tree => { let v = 0; for (const id of tree) v += val(id); return v; };
  const deg = (tree, id) => { let d = 0; for (const b of ADJ[id] || []) if (tree.has(b)) d++; return d; };

  // Key-path exchange: cut each chain of plain path nodes and reconnect the two
  // halves by a shorter (or equally short but more valuable) route.
  function keyPathExchange(tree, terms, ban) {
    let improved = true, guard = 0;
    while (improved && guard++ < 80) {
      improved = false;
      const isKey = id => START.has(id) || terms.has(id) || deg(tree, id) >= 3;
      const done = new Set();
      for (const k of tree) {
        if (!isKey(k)) continue;
        for (const nb of ADJ[k] || []) {
          if (!tree.has(nb) || isKey(nb) || done.has(nb)) continue;
          const chain = []; let prev = k, cur = nb;
          while (cur && !isKey(cur)) {
            chain.push(cur); done.add(cur);
            let next = null; for (const b of ADJ[cur] || []) if (b !== prev && tree.has(b)) { next = b; break; }
            prev = cur; cur = next;
          }
          if (!chain.length) continue;
          const rest = new Set(tree); chain.forEach(c => rest.delete(c));
          const compA = new Set([k]), st = [k];
          while (st.length) { const c = st.pop(); for (const b of ADJ[c] || []) if (rest.has(b) && !compA.has(b)) { compA.add(b); st.push(b); } }
          const p = grow(compA, b => rest.has(b) && !compA.has(b), ban, chain.length + 1);
          if (!p) continue;
          const inner = p.slice(1); // p[0] is the node reached in the other half
          const cv = chain.reduce((s, c) => s + val(c), 0), nv = inner.reduce((s, c) => s + val(c), 0);
          if (inner.length < chain.length || (inner.length === chain.length && nv > cv)) {
            chain.forEach(c => tree.delete(c)); inner.forEach(c => tree.add(c));
            prune(tree, terms); improved = true; break;
          }
        }
        if (improved) break;
      }
    }
    return tree;
  }

  function optimize(termList, banList, budget) {
    const ban = new Set(banList);
    const terms = new Set(termList.filter(t => !ban.has(t)));
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const polish = r => { prune(r.tree, terms); keyPathExchange(r.tree, terms, ban); r.v = treeVal(r.tree); return r; };
    const better = (a, b) => a.miss.length !== b.miss.length ? a.miss.length < b.miss.length
      : a.tree.size !== b.tree.size ? a.tree.size < b.tree.size : a.v > b.v;
    let best = polish(connectNearest(terms, ban));
    const ord = polish(connectOrdered([...terms], ban)); if (better(ord, best)) best = ord;
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let tries = 0;
    while (now() - t0 < budget && tries++ < 500) {
      let r;
      const steiner = [...best.tree].filter(v => !START.has(v) && !terms.has(v));
      if (steiner.length && rnd() < 0.6) {
        const tb = new Set(ban), k = 1 + Math.floor(rnd() * 2);
        for (let i = 0; i < k; i++) tb.add(steiner[Math.floor(rnd() * steiner.length)]);
        r = connectNearest(terms, tb); prune(r.tree, terms); keyPathExchange(r.tree, terms, ban); r.v = treeVal(r.tree);
      } else {
        const o = [...terms];
        for (let i = o.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [o[i], o[j]] = [o[j], o[i]]; }
        r = polish(connectOrdered(o, ban));
      }
      if (better(r, best)) best = r;
    }
    return { tree: [...best.tree], miss: best.miss };
  }

  const api = { setup, optimize };
  root.AtlasOptimizer = api;

  // Worker mode
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = e => {
      const m = e.data;
      if (m.type === 'setup') { setup(m.data); return; }
      if (m.type === 'opt') {
        const r = optimize(m.terms, m.ban, m.budget);
        root.postMessage({ id: m.id, kind: m.kind, key: m.key, tree: r.tree, miss: r.miss });
      }
    };
  }
})(typeof self !== 'undefined' ? self : this);
