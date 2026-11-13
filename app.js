/* Atlas Tree planner — main page logic. Data comes from data/league.json (built by
   tools/build_data.py), or from window.ATLAS_DATA in the single-file build. */
(() => {
'use strict';

// ---------- constants ----------
const SC = 2; // sprites are from the 0.5 zoom sheet: world size = px / 0.5
const IMG_FILES = { on: 'atlas-skills', off: 'atlas-skills-disabled', mas: 'atlas-mastery', fr: 'atlas-frame', gb: 'atlas-group-background', bg: 'atlas-background' };
// GGG's atlas background art, centred on the start node and scaled so its outer ring frames the tree like in game.
const BG_SIZE = 14800;
const BG_BRIGHT = 0.85; // a touch darker than the art, so nodes and paths stay the brightest thing
const BG_FILL = `rgb(${[10, 11, 20].map(c => Math.round(c * BG_BRIGHT)).join(',')})`; // colour at the art's edge
// Points available this league. GGG's export still says 138; set to 0 to use the export's value.
const LEAGUE_POINTS = 150;
const GENERIC_WHEELS = ['Maps', 'Magic Monsters', 'Rare Monsters', 'Unique Monsters', 'Divination Cards', 'Gold', 'Threads', 'Atlas Anomalies'];
// Focus list order: Shrines pinned first, then mechanics roughly by how many players farm them.
const MECH_RANK = ['Shrines', 'Essence', 'Strongboxes', 'Breach', 'Ritual', 'The Searing Exarch', 'The Eater of Worlds', 'Expedition',
  'Abyss', 'Delirium', 'Legion', 'Blight', 'Ultimatum', 'Betrayal', 'Settlers of Kalguur', 'Rogue Exiles', 'Mercenaries', 'Incursion',
  'Bestiary', 'Torment', 'Sacred Flora', 'Viridian Wildwood', 'Beyond', 'Atlas Memories', 'Sentinels', 'Mirage', 'Labyrinth',
  'Synthesis', 'The Shaper and Elder', 'Conquerors'];
const GENERIC_SMALLS = ['Map Drop Chance', 'Thread Drop Chance', 'Map Pack Size', 'Item Rarity', 'Map Magic Monsters', 'Map Rare Monsters', 'Map Modifier Effect', 'Magic Monsters', 'Higher Map Tier Chance'];
const DEFAULT_PREFS = ['Map Drop Chance', 'Higher Map Tier Chance', 'Map Pack Size', 'Map Modifier Effect', 'Map Rare Monsters', 'Map Magic Monsters', 'Item Rarity'];
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const enc3 = n => B62[Math.floor(n / 3844) % 62] + B62[Math.floor(n / 62) % 62] + B62[n % 62];
const dec3 = s => B62.indexOf(s[0]) * 3844 + B62.indexOf(s[1]) * 62 + B62.indexOf(s[2]);
const $ = id => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- data / mode ----------
let D = null, N = {}, ADJ = {}, ids = [], START = new Set(), WH = [], SPR = {}, MAXP = 138;
const imgs = {};
const cache = {};
async function loadData() {
  if (cache.d) return cache.d;
  cache.d = window.ATLAS_DATA ? window.ATLAS_DATA.league : await (await fetch('data/league.json')).json();
  return cache.d;
}
function loadImages() {
  for (const k in IMG_FILES) {
    const i = new Image(); i.onload = draw;
    i.src = window.ATLAS_IMGS ? window.ATLAS_IMGS[k] : `assets/${IMG_FILES[k]}.webp`;
    imgs[k] = i;
  }
}

// ---------- state ----------
let targets = [], blocked = new Set(), choice = {}, prefs = new Set(DEFAULT_PREFS);
let alloc = new Set(), unreachable = new Set(), order = [], stepOf = new Map(), groups = [];
let viewAt = Infinity; // show the tree as it is at this many points
let blockMode = false, showNums = false, focusSel = new Set();
let smart = true; // smart pathing on: targets are re-optimized; off: targets is the literal allocation order
const tset = () => new Set(targets);
const used = (set = alloc) => { let c = 0; for (const id of set) if (!START.has(id)) c++; return c; };
const effAlloc = () => viewAt === Infinity ? alloc : new Set([...alloc].filter(id => START.has(id) || (stepOf.get(id) || Infinity) <= viewAt));

// undo / redo
let undoStack = [], redoStack = [];
const snap = () => JSON.stringify({ t: targets, b: [...blocked], c: choice, s: smart });
function restore(s) { const o = JSON.parse(s); targets = o.t; blocked = new Set(o.b); choice = o.c; if (o.s !== undefined && o.s !== smart) setSmartUI(o.s); }
function commit(fn) { undoStack.push(snap()); if (undoStack.length > 200) undoStack.shift(); redoStack = []; fn(); rebuild(); }
function undo() { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); rebuild(); say('Undone'); }
function redo() { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); rebuild(); say('Redone'); }

// ---------- optimizer (worker with page fallback) ----------
let worker = null, reqId = 0, latestTree = 0;
const pending = new Map();
function initWorker() {
  try {
    const el = $('optimizer-js');
    const url = el && !el.src ? URL.createObjectURL(new Blob([el.textContent], { type: 'text/javascript' })) : (el ? el.src : 'optimizer.js');
    worker = new Worker(url);
    worker.onmessage = e => { const cb = pending.get(e.data.id); pending.delete(e.data.id); if (cb) cb(e.data); };
    worker.onerror = () => { worker = null; };
  } catch (e) { worker = null; }
}
function setupOptimizer() {
  const val = {};
  for (const id of ids) if (N[id].t === 'p' && prefs.has(N[id].nm)) val[id] = 1;
  const data = { adj: ADJ, start: [...START], pass: ids.filter(id => N[id].t !== 'm'), val };
  if (worker) worker.postMessage({ type: 'setup', data });
  window.AtlasOptimizer.setup(data);
}
function runOpt(terms, ban, budget) {
  return new Promise(res => {
    const id = ++reqId;
    if (worker) { pending.set(id, res); worker.postMessage({ type: 'opt', id, terms, ban, budget }); }
    else { const r = window.AtlasOptimizer.optimize(terms, ban, Math.min(budget, 80)); res({ id, ...r }); }
  });
}

// ---------- rebuild ----------
async function rebuild() {
  const my = ++latestTree;
  viewAt = Infinity; // the tree changed: show all of it again instead of staying on an old step
  previewCache.clear(); preview = null;
  if (smart) {
    $('busy').hidden = false;
    const r = await runOpt(targets, [...blocked], 180);
    if (my !== latestTree) return;
    $('busy').hidden = true;
    alloc = new Set(r.tree); unreachable = new Set(r.miss);
    computeOrder();
  } else {
    // manual: keep the clicked order, drop anything no longer connected to the start
    const keep = connectedFrom(new Set(targets.filter(t => !blocked.has(t))));
    targets = targets.filter(t => keep.has(t));
    alloc = new Set([...START, ...targets]); unreachable = new Set();
    computeManualOrder();
  }
  save(); syncScrub(); renderSide(); renderBudget(); updateUndo(); renderCompare(); renderTreeName(); draw();
  if (hover) setHover(hover, lastPt, true);
}
function computeOrder() {
  const have = new Set(START); order = []; groups = []; stepOf = new Map();
  for (const t of targets) {
    if (!alloc.has(t) || have.has(t)) { groups.push({ t, from: order.length, n: 0 }); continue; }
    const prev = new Map(), q = [...have]; have.forEach(h => prev.set(h, null));
    for (let i = 0; i < q.length; i++) { const c = q[i]; if (c === t) break; for (const b of ADJ[c] || []) if (alloc.has(b) && !prev.has(b)) { prev.set(b, c); q.push(b); } }
    const path = []; for (let c = t; c != null && !have.has(c); c = prev.get(c)) path.push(c);
    path.reverse();
    groups.push({ t, from: order.length, n: path.length });
    for (const p of path) { have.add(p); order.push(p); }
  }
  for (const id of alloc) if (!have.has(id)) order.push(id); // safety
  order.forEach((id, i) => stepOf.set(id, i + 1));
}
function connectedFrom(set) {
  const seen = new Set(START), q = [...START];
  while (q.length) { const c = q.shift(); for (const b of ADJ[c] || []) if (set.has(b) && !seen.has(b)) { seen.add(b); q.push(b); } }
  return seen;
}
function computeManualOrder() {
  order = targets.slice(); stepOf = new Map(); groups = [];
  order.forEach((id, i) => stepOf.set(id, i + 1));
  let from = 0;
  order.forEach((id, i) => { const t = N[id].t; if (t === 'n' || t === 'k') { groups.push({ t: id, from, n: i + 1 - from }); from = i + 1; } });
  if (from < order.length) groups.push({ t: null, from, n: order.length - from });
}
// shortest path from the current allocation (manual mode)
function manualPath(target, from = alloc) {
  const prev = new Map(), q = [];
  for (const id of from) { prev.set(id, null); q.push(id); }
  for (let i = 0; i < q.length; i++) {
    const c = q[i]; if (c === target) break;
    for (const b of ADJ[c] || []) if (!prev.has(b) && !blocked.has(b) && N[b].t !== 'm') { prev.set(b, c); q.push(b); }
  }
  if (!prev.has(target)) return null;
  const p = []; for (let c = target; c != null && !from.has(c); c = prev.get(c)) p.push(c);
  return p.reverse();
}
// ---------- whole wheels (click a wheel's centre) ----------
const wheelOf = id => N[id] && N[id].t === 'm' ? N[id].wh : null;
const wheelMembers = w => ids.filter(id => N[id].wh === w && N[id].t !== 'm' && !blocked.has(id));
// The wheel's nodes not yet allocated, nearest to the current tree first, so the steps read naturally.
function wheelMissing(w) {
  const dist = new Map(), q = [...alloc]; alloc.forEach(a => dist.set(a, 0));
  for (let i = 0; i < q.length; i++) for (const b of ADJ[q[i]] || []) if (!dist.has(b) && !blocked.has(b) && N[b].t !== 'm') { dist.set(b, dist.get(q[i]) + 1); q.push(b); }
  return wheelMembers(w).filter(id => !alloc.has(id)).sort((a, b) => (dist.get(a) ?? 1e9) - (dist.get(b) ?? 1e9));
}
// Manual mode: path to each node in turn, like clicking them one by one.
function manualWheelPath(w) {
  const have = new Set(alloc), add = [];
  for (const id of wheelMissing(w)) {
    if (have.has(id)) continue;
    const p = manualPath(id, have); if (!p) continue;
    p.forEach(x => { have.add(x); add.push(x); });
  }
  return add;
}
function toggleWheel(w) {
  const missing = wheelMissing(w), nm = WH[w][0];
  if (!missing.length) { // whole wheel taken: drop its targets
    const mem = new Set(wheelMembers(w));
    if (!smart) { const gone = new Set(); for (const id of mem) if (alloc.has(id)) refundSet(id).forEach(x => gone.add(x)); commit(() => { targets = targets.filter(t => !gone.has(t)); }); }
    else commit(() => { targets = targets.filter(t => !mem.has(t)); });
    say(`Removed the ${nm} wheel · Ctrl+Z to undo`); return;
  }
  if (!smart) {
    const add = manualWheelPath(w); if (!add.length) { say('That wheel cannot be reached with the current blocks'); return; }
    commit(() => { targets.push(...add); });
  } else commit(() => { targets.push(...missing.filter(id => !targets.includes(id))); });
  say(`Took the whole ${nm} wheel · Ctrl+Z to undo`);
}
function refundSet(id) {
  const rest = new Set(targets.filter(t => t !== id)), keep = connectedFrom(rest);
  return targets.filter(t => !keep.has(t));
}
const previewCache = new Map(); let preview = null;
function requestPreview(id) {
  if (previewCache.has(id)) { preview = previewCache.get(id); return; }
  const w = wheelOf(id);
  if (w != null) { // a wheel centre: preview taking every node in the wheel
    const missing = wheelMissing(w);
    if (!missing.length) { preview = { add: [], drop: [], size: alloc.size, ok: true, wheelDone: true }; previewCache.set(id, preview); return; }
    if (!smart) {
      const add = manualWheelPath(w);
      preview = { add, drop: [], size: alloc.size + add.length, ok: add.length > 0 }; previewCache.set(id, preview); return;
    }
    preview = { pending: true, add: [], drop: [] };
    const gen = latestTree;
    runOpt([...targets, ...missing], [...blocked], 80).then(r => {
      if (gen !== latestTree) return;
      const tree = new Set(r.tree);
      const res = { add: [...tree].filter(x => !alloc.has(x)), drop: [...alloc].filter(x => !tree.has(x)), size: tree.size, ok: !missing.some(m => r.miss.includes(m)) };
      previewCache.set(id, res);
      if (hover === id) { preview = res; draw(); showTip(id, lastPt); }
    });
    return;
  }
  if (!smart) {
    const p = manualPath(id);
    preview = p ? { add: p, drop: [], size: alloc.size + p.length, ok: true } : { add: [], drop: [], size: alloc.size, ok: false };
    previewCache.set(id, preview); return;
  }
  preview = { pending: true, add: [], drop: [] };
  const gen = latestTree;
  runOpt([...targets, id], [...blocked], 50).then(r => {
    if (gen !== latestTree) return;
    const tree = new Set(r.tree);
    const res = { add: [...tree].filter(x => !alloc.has(x)), drop: [...alloc].filter(x => !tree.has(x)), size: tree.size, ok: !r.miss.includes(id) };
    previewCache.set(id, res);
    if (hover === id) { preview = res; draw(); showTip(id, lastPt); }
  });
}

// ---------- actions ----------
function clickNode(id, pt) {
  const n = N[id]; if (!n || START.has(id)) return;
  if (n.t === 'm') { if (!blockMode) toggleWheel(n.wh); return; }
  // "choose one" notables: pick the effect on the spot, like in game
  if (n.va && !blockMode && !(smart && alloc.has(id) && !targets.includes(id))) { openPicker(id, pt || lastPt); return; }
  allocToggle(id);
}
function allocToggle(id, pickIdx) {
  const n = N[id];
  if (!smart && !blockMode) {
    if (alloc.has(id)) { const gone = new Set(refundSet(id)); commit(() => { targets = targets.filter(t => !gone.has(t)); }); }
    else { const p = manualPath(id); if (!p) { say('That node cannot be reached with the current blocks'); return; } commit(() => { targets.push(...p); blocked.delete(id); if (pickIdx != null) choice[id] = pickIdx; }); }
    return;
  }
  commit(() => {
    if (blockMode) {
      if (blocked.has(id)) blocked.delete(id); else { blocked.add(id); targets = targets.filter(t => t !== id); }
    } else if (targets.includes(id)) targets = targets.filter(t => t !== id);
    else { targets.push(id); blocked.delete(id); if (pickIdx != null) choice[id] = pickIdx; }
  });
}
// ---------- choice picker ----------
const picker = $('picker');
function openPicker(id, pt) {
  const n = N[id], has = alloc.has(id), cur = choice[id] ?? 0;
  picker.innerHTML = `<div class="pk-hd"><b>${esc(n.nm)}</b><span>${has ? 'Change effect' : 'Choose one'}</span></div>` +
    (n.st.length ? `<div class="pk-base">${esc(n.st.join(' '))}</div>` : '') +
    n.va.map((v, i) => `<button type="button" class="pk-opt${has && i === cur ? ' on' : ''}" data-i="${i}">${esc(v.join('\n'))}</button>`).join('') +
    `<div class="pk-ft">${has ? '<button type="button" data-act="remove" class="pk-rm">Remove</button>' : ''}<button type="button" data-act="cancel">Cancel</button></div>`;
  picker.dataset.id = id; picker.hidden = false; tip.hidden = true;
  const mr = cv.getBoundingClientRect(), w = picker.offsetWidth, h = picker.offsetHeight;
  let x = pt.x + 24, y = pt.y - h / 2;
  if (x + w > mr.width - 8) x = pt.x - w - 24;
  y = Math.min(Math.max(8, y), mr.height - h - 8);
  picker.style.left = Math.max(8, x) + 'px'; picker.style.top = y + 'px';
  picker.querySelector('.pk-opt').focus();
}
function closePicker() { picker.hidden = true; }
picker.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const id = picker.dataset.id; closePicker();
  if (b.dataset.act === 'cancel') return;
  if (b.dataset.act === 'remove') { allocToggle(id); return; }
  const i = +b.dataset.i;
  if (alloc.has(id)) { if ((choice[id] ?? 0) !== i) commit(() => { choice[id] = i; }); }
  else allocToggle(id, i);
});
picker.addEventListener('pointerdown', e => e.stopPropagation());
function toggleBlock(id) { const was = blockMode; blockMode = true; allocToggle(id); blockMode = was; }

// ---------- persistence & links ----------
function serialize() {
  let s = (smart ? 'l' : 'm') + '1-' + targets.map(t => enc3(+t)).join('');
  if (blocked.size) s += '-b' + [...blocked].map(t => enc3(+t)).join('');
  const cs = Object.entries(choice).filter(([k, v]) => v && alloc.has(k));
  if (cs.length) s += '-c' + cs.map(([k, v]) => enc3(+k) + v).join('');
  return s;
}
function parse(raw) {
  const st = { t: [], b: [], c: {}, s: !/^m1-/.test(raw) };
  if (/^[lrm]1-/.test(raw)) {
    const parts = raw.slice(3).split('-');
    const chunk = (s, n) => s.match(new RegExp(`.{${n}}`, 'g')) || [];
    chunk(parts[0], 3).forEach(x => st.t.push(String(dec3(x))));
    for (const p of parts.slice(1)) {
      if (p[0] === 'b') chunk(p.slice(1), 3).forEach(x => st.b.push(String(dec3(x))));
      if (p[0] === 'c') chunk(p.slice(1), 4).forEach(x => st.c[String(dec3(x.slice(0, 3)))] = +x[3]);
    }
  } else { // older "p-" links: ids separated by hyphens
    for (const tok of raw.replace(/^[pt]-/, '').split('-').filter(Boolean)) {
      if (tok[0] === 'b') st.b.push(tok.slice(1));
      else if (tok[0] === 'c') { const [i, v] = tok.slice(1).split('x'); st.c[i] = +v; }
      else st.t.push(tok);
    }
  }
  st.t = [...new Set(st.t)].filter(i => N[i] && N[i].t !== 'm' && !START.has(i));
  if (!/^[lrm]1-/.test(raw)) st.s = true;
  st.b = st.b.filter(i => N[i]);
  for (const k in st.c) if (!N[k] || !N[k].va) delete st.c[k];
  return st;
}
function save() {
  store.set('atlas-league', serialize());
  store.set('atlas-prefs', [...prefs].join('|'));
}
function linkUrl() {
  const base = location.href.split('#')[0];
  return base + '#' + serialize();
}

// ---------- saved trees, import, compare ----------
const CMP_THERE = '#6fa8ff', CMP_HERE = '#ff9f5a';
// Focus uses violet so it never reads as the gold of the allocated tree.
const FOCUS_RGB = '190,150,255', FOCUS_HOVER_RGB = '222,200,255';
let compare = null; // { name, set: Set of allocated ids in the other tree }
const loadSaved = () => { try { return JSON.parse(store.get('atlas-saved') || '[]'); } catch (e) { return []; } };
const writeSaved = list => store.set('atlas-saved', JSON.stringify(list));

// Accepts a planner link, or just the code after the #.
function readLink(text) {
  const raw = text.trim(); if (!raw) return { err: 'Paste a link first.' };
  let code = raw.includes('#') ? raw.slice(raw.indexOf('#') + 1) : raw;
  try { code = decodeURIComponent(code); } catch (e) {}
  if (!/^([lrm]1|[pt])-/.test(code)) return { err: 'That is not a link from this planner.' };
  const st = parse(code);
  if (!st.t.length && !st.b.length) return { err: 'That link has no nodes in it.' };
  return { st };
}
function applyState(st) {
  commit(() => { targets = st.t; blocked = new Set(st.b); choice = st.c; if (st.s !== smart) setSmartUI(st.s); });
}
// Allocation a saved state produces: re-optimized for smart trees, as clicked for manual ones.
async function allocationOf(st) {
  if (!st.s) return connectedFrom(new Set(st.t.filter(t => !st.b.includes(t))));
  const r = await runOpt(st.t, st.b, 300);
  return new Set(r.tree);
}
async function startCompare(st, name) {
  const set = await allocationOf(st);
  compare = { name, set }; renderCompare(); draw();
}
function stopCompare() { compare = null; renderCompare(); draw(); }
function renderCompare() {
  const bar = $('cmpbar');
  if (!compare) { bar.hidden = true; return; }
  let here = 0, there = 0, both = 0;
  for (const id of alloc) if (!START.has(id)) compare.set.has(id) ? both++ : here++;
  for (const id of compare.set) if (!START.has(id) && !alloc.has(id)) there++;
  bar.innerHTML = `<span>Comparing with <b>${esc(compare.name)}</b></span>` +
    `<span class="c-here">${here} only here</span><span class="c-there">${there} only there</span><span>${both} shared</span>` +
    `<button type="button" id="cmpstop">Stop</button>`;
  bar.hidden = false;
}
$('cmpbar').addEventListener('click', e => { if (e.target.id === 'cmpstop') stopCompare(); });

// ---------- your trees (header) ----------
// The open tree is either a saved one (curName) or unsaved; "shared" marks one opened from a link.
let curName = store.get('atlas-current') || null, curShared = false;
const savedEntry = name => name && loadSaved().find(x => x.name === name);
function setCurrent(name, shared = false) {
  curName = name; curShared = shared && !name;
  store.set('atlas-current', name || '');
  renderTreeName();
}
const isDirty = () => { const e = savedEntry(curName); return e ? e.code !== serialize() : targets.length > 0 || blocked.size > 0; };
function renderTreeName() {
  if (curName && !savedEntry(curName)) curName = null; // deleted elsewhere
  $('treename').textContent = curName || (curShared ? 'Shared tree' : 'Unsaved tree');
  $('treename').classList.toggle('unsaved', !curName);
  $('treedirty').hidden = !(curName && isDirty());
  $('savebtn').disabled = !!curName && !isDirty();
}
const ago = t => {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
let renaming = -1;
function renderSaved() {
  const list = loadSaved(), el = $('savedlist');
  el.innerHTML = list.length ? list.map((x, i) => {
    const open = x.name === curName;
    const nm = i === renaming
      ? `<input type="text" class="rename" value="${esc(x.name)}" maxlength="60" aria-label="New name">`
      : `<b>${esc(x.name)}</b>`;
    return `<li data-i="${i}" class="${open ? 'open' : ''}"><span class="nm">${nm}<small>${x.pts} points · ${x.code[0] === 'm' ? 'manual' : 'smart'}${x.at ? ' · ' + ago(x.at) : ''}${open ? ' · <em>open</em>' : ''}</small></span>` +
      `<span class="ctl">${open ? '' : '<button type="button" data-act="load">Open</button>'}<button type="button" data-act="share" title="Copy a link to this tree">Share</button><button type="button" data-act="cmp" title="Show the differences on the map">Compare</button>` +
      `<button type="button" data-act="ren" aria-label="Rename ${esc(x.name)}" title="Rename">✎</button><button type="button" data-act="del" aria-label="Delete ${esc(x.name)}" title="Delete">✕</button></span></li>`;
  }).join('')
    : '<li class="empty">No saved trees yet. Name the tree you have open and press Save to keep it here.</li>';
  const r = el.querySelector('input.rename'); if (r) { r.focus(); r.select(); }
}
function saveTree(name) {
  name = (name || '').trim();
  if (!targets.length && !blocked.size) { say('Nothing to save yet: add some nodes first'); return false; }
  if (!name) { openTrees(true); return false; }
  const list = loadSaved(), i = list.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
  const entry = { name: i >= 0 ? list[i].name : name, code: serialize(), pts: used(), at: Date.now() };
  if (i >= 0) list.splice(i, 1);
  list.unshift(entry); writeSaved(list);
  setCurrent(entry.name); renderSaved();
  say(i >= 0 ? `Saved "${entry.name}"` : `Saved "${entry.name}" · find it under the tree name`);
  return true;
}
function shareLink(code) {
  const url = location.href.split('#')[0] + '#' + code;
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => say('Link copied · anyone with it can open this tree'), () => say('Could not copy: the link is in the address bar'));
  else say('The link is in the address bar');
  return url;
}
const tpop = $('tpop'), tbtn = $('treebtn');
function openTrees(v, focusName) {
  tpop.hidden = !v; tbtn.setAttribute('aria-expanded', v);
  if (!v) { renaming = -1; return; }
  fpop.hidden = true; fbtn.setAttribute('aria-expanded', false); menu.hidden = true;
  renderSaved(); $('importmsg').textContent = '';
  $('savename').value = curName || '';
  if (focusName || !matchMedia('(pointer: coarse)').matches) { $('savename').focus(); $('savename').select(); }
}
tbtn.onclick = e => { e.stopPropagation(); openTrees(tpop.hidden); };
tpop.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', e => { if (!tpop.hidden && !tpop.contains(e.target) && e.target !== $('savebtn')) openTrees(false); });
$('savebtn').onclick = e => { e.stopPropagation(); if (curName) saveTree(curName); else openTrees(true, true); };
$('saveform').addEventListener('submit', e => { e.preventDefault(); if (saveTree($('savename').value)) openTrees(false); });
$('newtree').onclick = () => {
  if (targets.length || blocked.size) commit(() => { targets = []; blocked = new Set(); choice = {}; });
  setCurrent(null); openTrees(false); say('New tree · Ctrl+Z brings the last one back');
};
function finishRename(inp) {
  const list = loadSaved(), i = renaming, x = list[i]; renaming = -1;
  const name = inp.value.trim();
  if (x && name && name !== x.name) {
    if (list.some((y, j) => j !== i && y.name.toLowerCase() === name.toLowerCase())) { say(`There is already a tree called "${name}"`); renderSaved(); return; }
    const wasOpen = x.name === curName; x.name = name; writeSaved(list); if (wasOpen) setCurrent(name);
  }
  renderSaved();
}
$('savedlist').addEventListener('keydown', e => {
  if (!e.target.classList.contains('rename')) return;
  if (e.key === 'Enter') { e.preventDefault(); finishRename(e.target); }
  if (e.key === 'Escape') { e.stopPropagation(); renaming = -1; renderSaved(); }
});
$('savedlist').addEventListener('focusout', e => { if (e.target.classList.contains('rename') && renaming >= 0) finishRename(e.target); });
$('savedlist').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const list = loadSaved(), i = +b.closest('li').dataset.i, x = list[i]; if (!x) return;
  const act = b.dataset.act;
  if (act === 'ren') { renaming = i; renderSaved(); return; }
  if (act === 'share') { shareLink(x.code); return; }
  if (act === 'del') {
    if (!b.dataset.armed) { b.dataset.armed = 1; b.textContent = 'Delete?'; b.classList.add('danger'); setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = '✕'; b.classList.remove('danger'); } }, 3000); return; }
    list.splice(i, 1); writeSaved(list); if (x.name === curName) setCurrent(null); renderSaved(); say(`Deleted "${x.name}"`); return;
  }
  openTrees(false);
  if (act === 'load') { applyState(parse(x.code)); setCurrent(x.name); say(`Opened "${x.name}" · Ctrl+Z to undo`); }
  if (act === 'cmp') startCompare(parse(x.code), x.name);
});
function importAction(cmp) {
  const r = readLink($('importtxt').value), msg = $('importmsg');
  if (r.err) { msg.textContent = r.err; msg.className = 'msg bad'; return; }
  openTrees(false); $('importtxt').value = '';
  if (cmp) startCompare(r.st, 'shared link');
  else { applyState(r.st); setCurrent(null, true); say('Opened shared tree · Save it to keep it'); }
}
$('importload').onclick = () => importAction(false);
$('importcmp').onclick = () => importAction(true);
$('importtxt').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); importAction(false); } });

// ---------- modifiers ----------
const CATS = [
  ['Threads', /thread/i], ['Essence', /essence|imprisoned/i], ['Strongboxes', /strongbox|vaal vessel|apparatus/i], ['Shrines', /shrine/i],
  ['Breach', /breach|hive|wombgift|grasping coffer/i], ['Ritual', /ritual|tribute|favour/i], ['Abyss', /abyss/i], ['Blight', /blight/i],
  ['Legion', /legion|timeless|karui/i], ['Expedition & Settlers', /expedition|logbook|artifact|remnant|explosive|kalguur|ore deposit|\bore\b|\brog\b|gwennen|tujen|dannig/i],
  ['Delirium', /delirium/i], ['Viridian Wildwood', /wildwood|sacred f|wisp/i], ['Betrayal', /syndicate|veiled|betrayal/i], ['Ultimatum', /ultimatum|catalyst/i],
  ['Incursion', /incursion|architect|stone of passage/i], ['Torment', /torment/i], ['Rogue Exiles', /rogue exile|exile/i], ['Mercenaries', /mercenar/i],
  ['Eldritch altars', /exarch|eater of worlds|eldritch/i], ['Bestiary', /beast/i], ['Divination', /divination/i], ['Gold', /gold/i], ['Anomalies', /anomal/i],
  ['Other encounters', /sentinel|mirage|evocator|beyond|memory|labyrinth|synthesis|conqueror|shaper|elder/i], ['Maps & monsters', /map|boss|maven|monster|pack|rarity|portal/i]
];
const catOf = line => { for (const [c, re] of CATS) if (re.test(line)) return c; return 'Other'; };
const NUM = /(Tier\s+)?(\d+(?:\.\d+)?)(\+)?(-\d+)?/gi;
function templ(line) {
  const vals = []; let k = 0;
  const t = line.replace(NUM, (m, tier, num, plus, range, off, s) => {
    if (tier || range || s[off - 1] === '-' || /^\s*tiers?\b/i.test(s.slice(off + m.length))) return m;
    vals.push(parseFloat(num)); return '\u0000' + (k++) + '\u0000';
  });
  return { t, vals };
}
const fmt = v => Number.isInteger(v) ? String(v) : String(+v.toFixed(2));
// GGG's stat text uses line breaks both to wrap one long sentence and to separate two stats.
// A line that starts lowercase, or follows a line ending mid-phrase ("…chance to"), continues the sentence.
const CONT_END = /\b(to|the|of|in|have|has|a|an|and|or|their|when|for|from|with|by|on|at|is|are|be|against|more|per|as|into|than|upon|within)$/i;
function splitStat(s) {
  const out = [];
  for (const part of s.split('\n').map(x => x.trim()).filter(Boolean)) {
    const prev = out[out.length - 1];
    if (prev && (/^[a-z]/.test(part) || (CONT_END.test(prev) && !/^Your\b/.test(part)))) out[out.length - 1] = prev + ' ' + part;
    else out.push(part);
  }
  return out;
}
function statLines(id) {
  const n = N[id]; if (['m', 's', 'w'].includes(n.t)) return [];
  let st = n.st.flatMap(splitStat);
  if (n.va) {
    const v = (n.va[choice[id] ?? 0] || []).flatMap(splitStat);
    if (st.length && v.every(x => x.length < 40 && !/\d/.test(x))) {
      // a short choice ("The Deep") completes every line left hanging ("…from"), or else the last line
      const label = v.join(' / ');
      st = st.some(l => CONT_END.test(l)) ? st.map(l => CONT_END.test(l) ? l + ' ' + label : l) : [...st.slice(0, -1), st[st.length - 1] + ' ' + label];
    }
    else st = st.concat(v);
  }
  return st;
}

// ---------- side panel ----------
function renderBudget() {
  const u = used(), el = $('budget'), over = u - MAXP;
  // only shown as a warning: the panel already shows points used
  el.textContent = over > 0 ? `${over} point${over > 1 ? 's' : ''} over budget` : '';
  el.hidden = over <= 0; el.classList.toggle('over', over > 0);
  if (over > 0 && !renderBudget.warned) { say(`Over budget by ${over}: drop a target or block a node`); renderBudget.warned = true; }
  if (over <= 0) renderBudget.warned = false;
}
function renderSide() {
  const u = used(), vu = viewAt === Infinity ? u : Math.min(viewAt, u);
  const ptsEl = $('pts');
  ptsEl.innerHTML = `${vu} <span>/ ${MAXP}</span>`; ptsEl.classList.toggle('over', u > MAXP);
  $('barfill').style.width = Math.min(100, vu / MAXP * 100) + '%';
  $('barfill').parentElement.classList.toggle('over', u > MAXP);
  $('meta').innerHTML = `<span><b>${targets.length}</b> targets</span>` + (blocked.size ? `<span><b>${blocked.size}</b> blocked</span>` : '') + (viewAt !== Infinity ? `<span>of <b>${u}</b></span>` : '');
  renderNotes(); renderMods();
}
// Notes above the modifiers: unreachable targets, or how to start.
function renderNotes() {
  let h = '';
  if (unreachable.size) h += `<h3>Unreachable</h3><div class="warn">${[...unreachable].map(i => esc(N[i].nm)).join(', ')} cannot be reached with the current blocks.</div>`;
  if (!targets.length) h += smart ? `<div class="empty">Click nodes on the atlas to add targets. The cheapest tree that reaches all of them is rebuilt each time. Step through the order with ‹ › above.</div>`
    : `<div class="empty">Manual pathing: click a node to take the shortest path to it from what you have, like in game. Click an allocated node to refund it.</div>`;
  $('notes').innerHTML = h;
}
function renderPrefs() {
  const smalls = {};
  for (const id of ids) if (N[id].t === 'p') smalls[N[id].nm] = (smalls[N[id].nm] || 0) + 1;
  const names = Object.keys(smalls).sort((a, b) => (GENERIC_SMALLS.includes(b) - GENERIC_SMALLS.includes(a)) || smalls[b] - smalls[a]);
  $('prefchips').innerHTML = names.map((nm, i) => `<label><input type="checkbox" id="pf${i}" data-nm="${esc(nm)}" ${prefs.has(nm) ? 'checked' : ''}>${esc(nm)} <em>${smalls[nm]}</em></label>`).join('');
}
function renderMods() {
  const ea = effAlloc();
  const ks = [], agg = new Map();
  for (const id of order.filter(x => ea.has(x))) {
    const n = N[id];
    if (n.t === 'k') { ks.push(id); continue; }
    for (const line of statLines(id)) {
      const { t, vals } = templ(line), a = agg.get(t);
      if (a) { a.n++; a.vals = a.vals.map((v, i) => v + (vals[i] || 0)); }
      else agg.set(t, { n: 1, vals: [...vals], cat: catOf(line) });
    }
  }
  let h = '';
  if (!used(ea) && targets.length) h += `<div class="empty">No points allocated${viewAt !== Infinity ? ' at this point count' : ''}.</div>`;
  if (ks.length) {
    h += `<h3>Keystones <span>${ks.length}</span></h3>`;
    for (const id of ks) h += `<div class="ks"><b>${esc(N[id].nm)}</b>${statLines(id).map(s => `<div>${esc(s)}</div>`).join('')}</div>`;
  }
  const byCat = new Map();
  for (const [t, a] of agg) { if (!byCat.has(a.cat)) byCat.set(a.cat, []); byCat.get(a.cat).push([t, a]); }
  const tot = c => byCat.get(c).reduce((s, x) => s + x[1].n, 0);
  for (const c of [...byCat.keys()].sort((a, b) => tot(b) - tot(a))) {
    const rows = byCat.get(c).sort((a, b) => b[1].n - a[1].n);
    h += `<h3>${c} <span>${tot(c)} node${tot(c) > 1 ? 's' : ''}</span></h3>`;
    for (const [t, a] of rows) h += `<div class="mod"><span>${esc(t.replace(/\u0000(\d+)\u0000/g, (_, i) => fmt(a.vals[+i])))}</span>${a.n > 1 ? `<em>×${a.n}</em>` : ''}</div>`;
  }
  $('pane-mods').innerHTML = h;
}
function syncScrub() {
  const s = $('at'), u = used(), st = steps();
  s.max = u; s.value = viewAt === Infinity ? u : viewAt;
  $('stprev').disabled = $('stnext').disabled = !st.length;
  const info = $('stepinfo'), i = curStep();
  info.hidden = !st.length;
  if (info.hidden) return;
  if (viewAt === Infinity) { info.innerHTML = `<span>All ${st.length} step${st.length > 1 ? 's' : ''}</span> <small>‹ › to step through</small>`; return; }
  const g = st[i], n = g.t ? N[g.t] : null, a = g.from + 1, b = g.from + g.n, mid = viewAt < b;
  info.innerHTML = `<span>Step ${i + 1} of ${st.length}</span> <b class="n-${n ? n.t : 'p'}">${n ? esc(n.nm) : 'Small passives'}</b> <small>${a === b ? `point ${a}` : `points ${a}–${b}`}${mid ? ` · at ${viewAt}` : ''}</small>`;
}
// ---------- step through the allocation order ----------
// A step is one target (or one run of small passives in manual mode) with the points it costs.
const steps = () => groups.filter(g => g.n > 0);
// The step whose points end at or after the current view (the last one when viewing everything).
function curStep() {
  const st = steps(); if (!st.length) return -1;
  if (viewAt === Infinity) return st.length - 1;
  const i = st.findIndex(g => g.from + g.n >= viewAt);
  return i < 0 ? st.length - 1 : i;
}
// exact: keep v even at the last point, so the final step still shows as a step
function setViewAt(v, exact) {
  viewAt = v > used() || (v === used() && !exact) ? Infinity : Math.max(0, v);
  syncScrub(); renderSide(); draw();
}
function step(dir) {
  const st = steps(); if (!st.length) return;
  const cur = viewAt === Infinity ? used() : viewAt, ends = st.map(g => g.from + g.n);
  let i;
  if (dir > 0) { i = viewAt === Infinity ? 0 : ends.findIndex(e => e > cur); if (i < 0) i = 0; }
  else { i = -1; for (let j = ends.length - 1; j >= 0; j--) if (ends[j] < cur) { i = j; break; } if (i < 0) i = ends.length - 1; }
  setViewAt(ends[i], true);
  const t = st[i].t || order[ends[i] - 1];
  if (t) panTo(t);
}

// side panel events
$('at').addEventListener('input', e => setViewAt(+e.target.value));
$('stprev').onclick = () => step(-1);
$('stnext').onclick = () => step(1);
$('pane-mods').addEventListener('change', e => {
  const t = e.target; if (!t.dataset.id) return;
  commit(() => { choice[t.dataset.id] = +t.dataset.i; });
});
$('prefchips').addEventListener('change', e => {
  const t = e.target; if (!t.dataset.nm) return;
  if (t.checked) prefs.add(t.dataset.nm); else prefs.delete(t.dataset.nm);
  setupOptimizer(); rebuild();
});
$('prefsbtn').onclick = () => { menu.hidden = true; renderPrefs(); $('prefsdlg').showModal(); };
const side = $('side');
side.querySelector('.shd').addEventListener('click', e => { if (window.matchMedia('(max-width: 900px)').matches && !e.target.closest('input, button')) side.classList.toggle('open'); });

// ---------- canvas ----------
const cv = $('c'), ctx = cv.getContext('2d'), tip = $('tip');
let W = 0, H = 0, dpr = 1, view = { x: 0, y: 0, s: 0.05 };
let hover = null, hoverMech = null, hits = new Set(), hitList = [], hitIdx = -1;
let focusSet = null; // Set of node ids in focus, or null
function resize() { const r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1; W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); draw(); }
function fit() {
  if (!D) return;
  const [x0, y0, x1, y1] = D.bounds, pad = 400;
  const s = Math.min(W / (x1 - x0 + pad * 2), H / (y1 - y0 + pad * 2));
  view.s = s; view.x = (x0 + x1) / 2 - W / 2 / s; view.y = (y0 + y1) / 2 - H / 2 / s; draw();
}
// Pan so the node is on screen, keeping the zoom level.
function panTo(id) {
  // on phones the plan sheet covers the bottom of the map: only use the part above it
  let vh = H;
  const sr = side.getBoundingClientRect(), cr = cv.getBoundingClientRect();
  if (getComputedStyle(side).position === 'fixed' && sr.top < cr.bottom) vh = Math.max(120, sr.top - cr.top);
  const n = N[id], m = 80 / view.s, x0 = view.x + m, y0 = view.y + m, x1 = view.x + W / view.s - m, y1 = view.y + vh / view.s - m;
  if (n.x > x0 && n.x < x1 && n.y > y0 && n.y < y1) { draw(); return; }
  view.x = n.x - W / 2 / view.s; view.y = n.y - vh / 2 / view.s; draw();
}
function centerOn(id) { const n = N[id]; view.s = Math.max(view.s, 0.16); view.x = n.x - W / 2 / view.s; view.y = n.y - H / 2 / view.s; draw(); }
const radius = t => ({ p: 42, n: 60, k: 80, w: 90, m: 80, s: 110 })[t];
function sprite(img, c, x, y, scale = 1) {
  if (!c || !img || !img.complete || !img.naturalWidth) return false;
  const w = c.w * SC * scale, h = c.h * SC * scale;
  ctx.drawImage(img, c.x, c.y, c.w, c.h, x - w / 2, y - h / 2, w, h); return true;
}
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(render); }
function render() {
  raf = 0; if (!D) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = BG_FILL; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, -view.x * view.s * dpr, -view.y * view.s * dpr);
  const bg = imgs.bg, sn = N[[...START][0]];
  if (bg && bg.complete && bg.naturalWidth && sn) {
    ctx.filter = `brightness(${BG_BRIGHT})`;
    ctx.drawImage(bg, sn.x - BG_SIZE / 2, sn.y - BG_SIZE / 2, BG_SIZE, BG_SIZE);
    ctx.filter = 'none';
  }
  const pad = 800, vx0 = view.x - pad, vy0 = view.y - pad, vx1 = view.x + W / view.s + pad, vy1 = view.y + H / view.s + pad;
  const vis = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;
  const px = 1 / view.s;
  const ea = effAlloc();
  const dim = id => focusSet && !focusSet.has(id) && !ea.has(id);
  const T = smart ? tset() : new Set(groups.map(g => g.t).filter(Boolean));
  const ci = viewAt === Infinity ? -1 : curStep(), stepT = ci >= 0 ? steps()[ci].t : null;

  // Focus: darken the whole map except the focused wheels, which stay lit.
  const inLit = (x, y) => { for (const w of lit) { const [, wx, wy, r] = WH[w]; if ((x - wx) ** 2 + (y - wy) ** 2 < r * r) return true; } return false; };
  const lit = new Set([...focusWheels, ...(focusPreview ? focusPreview.wheels : [])]);
  if (focusSet || focusPreview) {
    ctx.fillStyle = 'rgba(3,3,7,0.66)'; ctx.beginPath(); ctx.rect(vx0, vy0, vx1 - vx0, vy1 - vy0);
    for (const w of lit) { const [, x, y, r] = WH[w]; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, Math.PI * 2); }
    ctx.fill('evenodd');
    ctx.strokeStyle = `rgba(${FOCUS_RGB},0.85)`; ctx.lineWidth = Math.max(8, 1.6 * px);
    for (const w of focusWheels) { const [, x, y, r] = WH[w]; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke(); }
  }
  // Hover: a wheel on the tree, or an item in the Focus list.
  const pv = focusPreview ? focusPreview.wheels : hoverMech ? WH.map((w, i) => w[0] === hoverMech ? i : -1).filter(i => i >= 0) : [];
  for (const w of pv) {
    const [, x, y, r] = WH[w];
    const g = ctx.createRadialGradient(x, y, r * .3, x, y, r);
    g.addColorStop(0, `rgba(${FOCUS_RGB},0.14)`); g.addColorStop(1, `rgba(${FOCUS_RGB},0.02)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = `rgba(${FOCUS_HOVER_RGB},0.95)`; ctx.lineWidth = Math.max(10, 2.5 * px);
    ctx.setLineDash([60, 30]); ctx.stroke(); ctx.setLineDash([]);
  }
  // hovering a wheel's centre: a solid ring says "this whole wheel"
  const hw = hover ? wheelOf(hover) : null;
  if (hw != null && !blockMode) {
    const [, x, y, r] = WH[hw];
    const g = ctx.createRadialGradient(x, y, r * .2, x, y, r);
    g.addColorStop(0, 'rgba(127,214,160,0.16)'); g.addColorStop(1, 'rgba(127,214,160,0.03)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = preview && preview.wheelDone ? '#e0605a' : '#7fd6a0'; ctx.lineWidth = Math.max(12, 3 * px); ctx.stroke();
  }
  for (const [gx, gy, im, ox, oy] of D.gb) if (vis(gx, gy)) {
    ctx.globalAlpha = (focusSet || focusPreview) && !inLit(gx, gy) ? 0.12 : 0.5;
    sprite(imgs.gb, SPR.groupBackground[im], gx + ox * SC, gy + oy * SC);
  }
  ctx.globalAlpha = 1;

  const add = new Set(preview ? preview.add : []), drop = new Set(preview ? preview.drop : []);
  const willHave = id => (alloc.has(id) && !drop.has(id)) || add.has(id);
  const planned = id => alloc.has(id) && !ea.has(id);
  for (const e of D.edges) {
    const a = N[e[0]], b = N[e[1]];
    if (!vis(a.x, a.y) && !vis(b.x, b.y)) continue;
    const on = ea.has(e[0]) && ea.has(e[1]);
    const pl = !on && alloc.has(e[0]) && alloc.has(e[1]);
    const dr = (on || pl) && (drop.has(e[0]) || drop.has(e[1]));
    const ad = !on && !pl && willHave(e[0]) && willHave(e[1]);
    ctx.globalAlpha = (dim(e[0]) && dim(e[1])) ? 0.25 : 1;
    ctx.strokeStyle = dr ? '#e0605a' : ad ? '#7fd6a0' : on ? '#d9b257' : pl ? 'rgba(217,178,87,.38)' : '#4a4234';
    ctx.lineWidth = Math.max(on || ad || pl ? 14 : 9, (on || ad || pl ? 3 : 1.6) * px);
    if (pl) ctx.setLineDash([40, 30]);
    ctx.beginPath();
    if (e.length > 2) {
      const [, , cx, cy, r] = e;
      const a1 = Math.atan2(a.y - cy, a.x - cx), a2 = Math.atan2(b.y - cy, b.x - cx);
      let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      ctx.arc(cx, cy, r, a1, a1 + d, d < 0);
    } else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
  if (compare) {
    ctx.strokeStyle = CMP_THERE; ctx.lineWidth = Math.max(10, 2 * px); ctx.setLineDash([50, 35]);
    for (const e of D.edges) {
      if (!compare.set.has(e[0]) || !compare.set.has(e[1]) || (alloc.has(e[0]) && alloc.has(e[1]))) continue;
      const a = N[e[0]], b = N[e[1]];
      if (!vis(a.x, a.y) && !vis(b.x, b.y)) continue;
      ctx.beginPath();
      if (e.length > 2) {
        const [, , cx, cy, r] = e;
        const a1 = Math.atan2(a.y - cy, a.x - cx), a2 = Math.atan2(b.y - cy, b.x - cx);
        let d = a2 - a1; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        ctx.arc(cx, cy, r, a1, a1 + d, d < 0);
      } else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  const canAlloc = new Set();
  for (const id of ea) for (const b of ADJ[id] || []) if (!ea.has(b)) canAlloc.add(b);
  const nums = showNums && view.s > 0.09;
  for (const id of ids) {
    const n = N[id]; if (!vis(n.x, n.y)) continue;
    const on = ea.has(id), can = canAlloc.has(id) || add.has(id);
    ctx.globalAlpha = dim(id) ? 0.3 : 1;
    if (n.t === 's') { ctx.globalAlpha = 1; sprite(imgs.gb, SPR.startNode.AtlasPassiveSkillScreenStart, n.x, n.y, 0.55); continue; }
    if (n.t === 'm') { ctx.globalAlpha *= 0.85; sprite(imgs.mas, SPR.mastery[n.ic], n.x, n.y); ctx.globalAlpha = 1; continue; }
    // focused nodes outside a lit wheel (path nodes, keystones) get a soft glow behind them
    if ((focusSet && focusSet.has(id) && n.wh == null) || (focusPreview && focusPreview.path && focusPreview.ids.has(id))) {
      const r = Math.max(radius(n.t) * 2.3, 9 * px), g = ctx.createRadialGradient(n.x, n.y, r * .25, n.x, n.y, r); // at least ~9px on screen
      g.addColorStop(0, `rgba(${FOCUS_RGB},0.7)`); g.addColorStop(1, `rgba(${FOCUS_RGB},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fill();
    }
    const sheet = { p: 'normalActive', n: 'notableActive', k: 'keystoneActive', w: 'wormholeActive' }[n.t];
    const ok = sprite(on ? imgs.on : imgs.off, SPR[sheet][n.t === 'w' ? 'Wormhole' : n.ic], n.x, n.y);
    if (!ok) { ctx.fillStyle = on ? '#c8a24a' : '#3c372d'; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n.t) * .7, 0, 7); ctx.fill(); }
    const st = on ? 'Allocated' : can || planned(id) ? 'CanAllocate' : 'Unallocated';
    const fr = n.t === 'p' ? (on ? 'PSSkillFrameActive' : can || planned(id) ? 'PSSkillFrameHighlighted' : 'PSSkillFrame') : (n.t === 'n' ? 'Notable' : n.t === 'k' ? 'Keystone' : 'Wormhole') + 'Frame' + st;
    sprite(imgs.fr, SPR.frame[fr], n.x, n.y);
    ctx.globalAlpha = 1;
    const ring = (col, off, w) => { ctx.strokeStyle = col; ctx.lineWidth = Math.max(w, w / 4 * px); ctx.beginPath(); ctx.arc(n.x, n.y, radius(n.t) + off, 0, 7); ctx.stroke(); };
    const hl = stepT === id;
    if (T.has(id)) ring(unreachable.has(id) ? '#e0605a' : (hl ? '#ffffff' : '#f6e3a8'), 14, hl ? 22 : 12);
    if (compare) {
      const there = compare.set.has(id), here = alloc.has(id);
      if (there && !here) ring(CMP_THERE, 30, 14);
      else if (here && !there && !START.has(id)) ring(CMP_HERE, 30, 14);
    }
    if (add.has(id)) ring('#7fd6a0', 6, 10);
    if (drop.has(id)) ring('#e0605a', 6, 10);
    if (blocked.has(id)) {
      ctx.strokeStyle = '#e0605a'; ctx.lineWidth = Math.max(14, 3 * px); const r = radius(n.t) * .8;
      ctx.beginPath(); ctx.moveTo(n.x - r, n.y - r); ctx.lineTo(n.x + r, n.y + r); ctx.moveTo(n.x + r, n.y - r); ctx.lineTo(n.x - r, n.y + r); ctx.stroke();
    }
    if (hits.has(id)) ring('#6fe0ff', 24, 10);

    if (id === hover) ring('#fff3c9', 8, 6);
    if (nums && stepOf.has(id)) {
      const fs = Math.max(26, 11 * px), label = String(stepOf.get(id));
      ctx.font = `600 ${fs}px "Fira Sans", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const w = ctx.measureText(label).width + fs * .5, yy = n.y - radius(n.t) - fs * .5;
      ctx.fillStyle = planned(id) ? 'rgba(11,10,12,.75)' : 'rgba(200,162,74,.92)';
      ctx.beginPath(); ctx.roundRect ? ctx.roundRect(n.x - w / 2, yy - fs * .6, w, fs * 1.2, fs * .3) : ctx.rect(n.x - w / 2, yy - fs * .6, w, fs * 1.2); ctx.fill();
      ctx.fillStyle = planned(id) ? '#c8a24a' : '#16130f'; ctx.fillText(label, n.x, yy + fs * .04);
    }
  }
}

// ---------- tooltip ----------
const TYPE = { p: 'Passive', n: 'Notable', k: 'Keystone', w: 'Wormhole', m: 'Wheel' };
let lastPt = { x: 0, y: 0 };
function showTip(id, pt) {
  if (!id || !N[id] || N[id].t === 's') { tip.hidden = true; return; }
  const n = N[id], wh = n.wh != null ? WH[n.wh][0] : null;
  const count = wh ? WH.filter(w => w[0] === wh).length : 0;
  const ty = n.t === 'm' ? `${count} wheel${count > 1 ? 's' : ''}` : (wh ? `<i>${esc(wh)}</i>` : TYPE[n.t]);
  let h = `<div class="hd"><span class="nm">${esc(n.nm)}</span><span class="ty">${ty}</span></div><div class="bd">`;
  if (n.t !== 'm') {
    for (const s of n.st) h += `<div class="st">${esc(s)}</div>`;
    if (n.va) {
      if (alloc.has(id)) h += `<div class="va sel">${esc(n.va[choice[id] ?? 0].join('\n'))}</div>`;
      else n.va.forEach(v => h += `<div class="va">${esc(v.join('\n'))}</div>`);
    }
    if (n.rm && n.t === 'k') h += `<div class="rm">${n.rm.map(esc).join(' ')}</div>`;
  }
  if (n.t === 'm') { // what's in the wheel
    const mem = wheelMembers(n.wh), have = mem.filter(x => alloc.has(x)).length;
    const kinds = { p: 0, n: 0, k: 0 }; mem.forEach(x => kinds[N[x].t] = (kinds[N[x].t] || 0) + 1);
    const parts = [kinds.n && `${kinds.n} notable${kinds.n > 1 ? 's' : ''}`, kinds.k && `${kinds.k} keystone${kinds.k > 1 ? 's' : ''}`, kinds.p && `${kinds.p} small`].filter(Boolean);
    h += `<div class="st">${mem.length} nodes: ${parts.join(', ')}${have ? ` · ${have} taken` : ''}</div>`;
  }
  h += '</div>';
  if (n.t === 'm') {
    let f;
    if (blockMode) f = 'Turn off block mode to take the wheel';
    else if (!preview || preview.pending) f = '…';
    else if (preview.wheelDone) f = 'Whole wheel taken · <b>click to remove it</b>';
    else if (!preview.ok) f = '<s>Not all of it can be reached</s>';
    else f = `<b>Click to take the whole wheel · +${preview.size - alloc.size} pts</b>` + (preview.drop.length ? ` · reroutes <s>−${preview.drop.length}</s>` : '');
    h += `<div class="ft">${f}</div>`;
  } else {
    let f = '';
    const step = stepOf.get(id);
    if (blockMode) f = blocked.has(id) ? 'Blocked · click to unblock' : 'Click to block';
    else if (blocked.has(id)) f = 'Blocked';
    else if (!smart && alloc.has(id)) { const r = refundSet(id).length; f = `Point ${step} · click to refund ${r}`; }
    else if (targets.includes(id)) f = unreachable.has(id) ? '<s>Unreachable</s>' : `Target #${targets.indexOf(id) + 1} · point ${step}`;
    else if (alloc.has(id)) f = `On path · point ${step}`;
    else if (preview) f = preview.pending ? '…' : !preview.ok ? '<s>Unreachable</s>' : `<b>+${preview.size - alloc.size} pts</b>` + (preview.drop.length ? ` · reroutes <s>−${preview.drop.length}</s>` : '');
    if (f) h += `<div class="ft">${f}</div>`;
  }
  tip.innerHTML = h; tip.className = 't-' + n.t; tip.hidden = false;
  const mr = cv.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight, gap = 34;
  let x = pt.x + gap, y = pt.y - th - gap;
  if (x + tw > mr.width - 8) x = pt.x - tw - gap;
  if (y < 8) y = pt.y + gap;
  if (y + th > mr.height - 8) y = Math.max(8, mr.height - th - 8);
  tip.style.left = Math.max(8, x) + 'px'; tip.style.top = y + 'px';
}
function setHover(id, pt, force) {
  if (id !== hover || force) {
    hover = id;
    const n = id ? N[id] : null;
    hoverMech = n && n.wh != null ? WH[n.wh][0] : null;
    preview = null;
    if (n && n.t === 'm' && !blockMode) requestPreview(id);
    else if (n && n.t !== 's' && !alloc.has(id) && !blocked.has(id) && !blockMode) requestPreview(id);
    cv.classList.toggle('over', !!n && (n.t !== 'm' || !blockMode));
    draw();
  }
  showTip(id, pt);
}

// ---------- pointer input ----------
const toWorld = (px, py) => ({ x: view.x + px / view.s, y: view.y + py / view.s });
function pick(px, py) {
  const w = toWorld(px, py); let best = null, bd = Infinity;
  for (const id of ids) {
    const n = N[id]; if (n.t === 's') continue;
    const d = Math.hypot(n.x - w.x, n.y - w.y), r = Math.max(radius(n.t), 10 / view.s);
    if (d < r && d < bd) { bd = d; best = id; }
  }
  return best;
}
const ptrs = new Map(); let drag = null, moved = 0, pinch = null, touchSel = null;
const clampS = s => Math.min(0.6, Math.max(0.02, s));
cv.addEventListener('contextmenu', e => { e.preventDefault(); const id = pick(e.offsetX, e.offsetY); if (id && N[id].t !== 'm') toggleBlock(id); });
cv.addEventListener('pointerdown', e => {
  if (e.button === 2) return;
  if (!picker.hidden) closePicker();
  cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (ptrs.size === 1) { drag = { x: e.offsetX, y: e.offsetY, vx: view.x, vy: view.y }; moved = 0; }
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s, w: toWorld((a.x + b.x) / 2, (a.y + b.y) / 2) }; drag = null; }
});
cv.addEventListener('pointermove', e => {
  lastPt = { x: e.offsetX, y: e.offsetY };
  if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, lastPt);
  if (pinch && ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    view.s = clampS(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
    view.x = pinch.w.x - m.x / view.s; view.y = pinch.w.y - m.y / view.s; moved = 99; draw(); return;
  }
  if (drag) {
    const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y; moved = Math.max(moved, Math.hypot(dx, dy));
    if (moved > 4) { cv.classList.add('drag'); view.x = drag.vx - dx / view.s; view.y = drag.vy - dy / view.s; tip.hidden = true; draw(); return; }
  }
  if (e.pointerType === 'mouse') setHover(pick(e.offsetX, e.offsetY), lastPt);
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId); cv.classList.remove('drag');
  if (ptrs.size < 2) pinch = null;
  if (drag && moved <= 4 && ptrs.size === 0) {
    const id = pick(e.offsetX, e.offsetY);
    if (e.pointerType === 'mouse') { if (id) clickNode(id, { x: e.offsetX, y: e.offsetY }); }
    else if (id && id === touchSel) clickNode(id, { x: e.offsetX, y: e.offsetY });
    else { touchSel = id; setHover(id, { x: e.offsetX, y: e.offsetY }); }
  }
  if (ptrs.size === 0) drag = null;
}
cv.addEventListener('pointerup', endPtr);
cv.addEventListener('pointercancel', endPtr);
cv.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !drag) setHover(null); });
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const w = toWorld(e.offsetX, e.offsetY);
  view.s = clampS(view.s * Math.exp(-e.deltaY * 0.0015));
  view.x = w.x - e.offsetX / view.s; view.y = w.y - e.offsetY / view.s; draw();
  if (hover) showTip(hover, lastPt);
}, { passive: false });

// ---------- search & focus ----------
const q = $('q'), hitsEl = $('hits');
function runSearch() {
  const t = q.value.trim().toLowerCase(); hits = new Set(); hitIdx = -1;
  if (t.length >= 2) for (const id of ids) {
    const n = N[id]; if (n.t === 's') continue;
    if ((n.nm + ' ' + n.st.join(' ') + ' ' + (n.va || []).flat().join(' ')).toLowerCase().includes(t)) hits.add(id);
  }
  hitList = [...hits]; hitsEl.textContent = t.length >= 2 ? `${hits.size} match${hits.size === 1 ? '' : 'es'}` : ''; draw();
}
q.addEventListener('input', runSearch);
q.addEventListener('keydown', e => {
  if (e.key === 'Escape') { q.value = ''; runSearch(); q.blur(); return; }
  if (e.key !== 'Enter' || !hitList.length) return;
  hitIdx = (hitIdx + 1) % hitList.length; centerOn(hitList[hitIdx]);
  hitsEl.textContent = `${hitIdx + 1} of ${hitList.length}`; setHover(hitList[hitIdx], { x: W / 2, y: H / 2 }, true);
});
// Focus items: generic (map-wide) wheels, the common small path nodes by type, keystones,
// then every league mechanic wheel. Each item knows its nodes and its wheels.
let FOCUS = [], focusByKey = new Map(), focusWheels = new Set(), focusPreview = null;
function buildFocusItems() {
  const byWheel = new Map(), pathByName = new Map(), keystones = [];
  for (const id of ids) {
    const n = N[id];
    if (n.wh != null) { const w = WH[n.wh][0]; if (!byWheel.has(w)) byWheel.set(w, []); byWheel.get(w).push(id); }
    else if (n.t === 'p') { if (!pathByName.has(n.nm)) pathByName.set(n.nm, []); pathByName.get(n.nm).push(id); }
    if (n.t === 'k') keystones.push(id);
  }
  const wheelIdx = nm => WH.map((w, i) => w[0] === nm ? i : -1).filter(i => i >= 0);
  const item = (key, label, cat, list, wheels = []) => ({ key, label, cat, ids: new Set(list), wheels,
    text: (label + ' ' + list.map(id => N[id].nm + ' ' + N[id].st.join(' ') + ' ' + (N[id].va || []).flat().join(' ')).join(' ')).toLowerCase() });
  const items = [];
  for (const w of GENERIC_WHEELS) if (byWheel.has(w)) items.push(item(w, w, 'gen', byWheel.get(w), wheelIdx(w)));
  for (const [nm, list] of [...pathByName].filter(([, l]) => l.length > 1).sort((a, b) => b[1].length - a[1].length))
    items.push(Object.assign(item('p:' + nm, nm, 'gen', list), { path: true }));
  if (keystones.length) items.push(Object.assign(item('k', 'Keystones', 'gen', keystones), { path: true }));
  const league = [...byWheel.keys()].filter(w => !GENERIC_WHEELS.includes(w));
  const ranked = MECH_RANK.filter(n => league.includes(n)), rest = league.filter(n => !ranked.includes(n)).sort();
  for (const w of [...ranked, ...rest]) items.push(item(w, w, 'league', byWheel.get(w), wheelIdx(w)));
  FOCUS = items; focusByKey = new Map(items.map(x => [x.key, x]));
  focusSel = new Set([...focusSel].filter(k => focusByKey.has(k))); // drops old keys like "*generic"
}
function buildFocus() {
  buildFocusItems();
  const chip = (x, i) => `<label data-i="${i}"><input type="checkbox" data-f="${esc(x.key)}" ${focusSel.has(x.key) ? 'checked' : ''}>${esc(x.label)}<em>${x.ids.size}</em><i class="instat">in stats</i></label>`;
  const section = (cat, title, sub) => `<section class="fsec" data-cat="${cat}"><div class="fsub"><span>${title} <small>${sub}</small></span><button type="button" data-clear="${cat}" hidden>Clear</button></div>
    <div class="chips">${FOCUS.map((x, i) => x.cat === cat ? chip(x, i) : '').join('')}</div></section>`;
  fpop.innerHTML = `<div class="fhd"><span>Focus</span><button type="button" id="fclear">Clear all</button></div>
    <input type="search" id="fq" placeholder="Search mechanics or stats…" autocomplete="off" aria-label="Search mechanics">
    ${section('gen', 'Generic', 'map-wide, any strategy')}
    ${section('league', 'League mechanics', 'most farmed first')}
    <div class="fnone" hidden>Nothing matches.</div>`;
  applyFocus();
}
function filterFocus() {
  const t = $('fq').value.trim().toLowerCase();
  for (const lab of fpop.querySelectorAll('label[data-i]')) {
    const x = FOCUS[+lab.dataset.i], byName = !t || x.label.toLowerCase().includes(t), byText = !byName && t.length >= 3 && x.text.includes(t);
    lab.hidden = !(byName || byText); lab.classList.toggle('bytext', byText);
  }
  let any = false;
  for (const sec of fpop.querySelectorAll('.fsec')) { const v = !!sec.querySelector('label[data-i]:not([hidden])'); sec.hidden = !v; any = any || v; }
  fpop.querySelector('.fnone').hidden = any;
}
function applyFocus() {
  const n = focusSel.size;
  $('focusbtn').innerHTML = n ? `Focus <b>${n}</b>` : 'Focus';
  $('focusbtn').setAttribute('aria-pressed', n > 0);
  store.set('atlas-focus', [...focusSel].join('|'));
  for (const cat of ['gen', 'league']) { const b = fpop.querySelector(`[data-clear="${cat}"]`); if (b) b.hidden = ![...focusSel].some(k => focusByKey.get(k).cat === cat); }
  focusWheels = new Set();
  if (!n) { focusSet = null; draw(); return; }
  focusSet = new Set();
  for (const k of focusSel) { const x = focusByKey.get(k); x.ids.forEach(id => focusSet.add(id)); x.wheels.forEach(w => focusWheels.add(w)); }
  draw();
}
const fpop = $('fpop'), fbtn = $('focusbtn');
function openFocus(v) {
  fpop.hidden = !v; fbtn.setAttribute('aria-expanded', v);
  if (v && !matchMedia('(pointer: coarse)').matches) $('fq').focus();
  if (!v && focusPreview) { focusPreview = null; draw(); }
}
fbtn.onclick = e => { e.stopPropagation(); openFocus(fpop.hidden); };
fpop.addEventListener('click', e => {
  e.stopPropagation();
  const set = keep => { focusSel = new Set([...focusSel].filter(keep)); fpop.querySelectorAll('input[data-f]').forEach(i => i.checked = focusSel.has(i.dataset.f)); applyFocus(); };
  if (e.target.id === 'fclear') set(() => false);
  const c = e.target.dataset && e.target.dataset.clear; if (c) set(k => focusByKey.get(k).cat !== c);
});
fpop.addEventListener('change', e => { const f = e.target.dataset.f; if (!f) return; if (e.target.checked) focusSel.add(f); else focusSel.delete(f); applyFocus(); });
fpop.addEventListener('input', e => { if (e.target.id === 'fq') filterFocus(); });
fpop.addEventListener('keydown', e => {
  if (e.target.id !== 'fq') return;
  if (e.key === 'Escape') { e.stopPropagation(); if (e.target.value) { e.target.value = ''; filterFocus(); } else openFocus(false); return; }
  if (e.key === 'Enter') { const first = fpop.querySelector('label[data-i]:not([hidden]) input'); if (first) { first.checked = !first.checked; first.dispatchEvent(new Event('change', { bubbles: true })); } }
});
// hovering an item previews it on the tree
fpop.addEventListener('mouseover', e => { const lab = e.target.closest('label[data-i]'); const x = lab ? FOCUS[+lab.dataset.i] : null; if (x !== focusPreview) { focusPreview = x; draw(); } });
fpop.addEventListener('mouseleave', () => { if (focusPreview) { focusPreview = null; draw(); } });
document.addEventListener('click', e => { if (!fpop.hidden && !fpop.contains(e.target)) openFocus(false); });


// ---------- header buttons ----------
const toast = $('toast'); let tt;
function say(m) { toast.textContent = m; toast.hidden = false; clearTimeout(tt); tt = setTimeout(() => toast.hidden = true, 2000); }
function updateUndo() { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; }
$('undo').onclick = undo; $('redo').onclick = redo;
const blockBtn = $('block');
function setBlock(v) { blockMode = v; blockBtn.setAttribute('aria-pressed', v); say(v ? 'Block mode on: clicks block nodes' : 'Block mode off'); if (hover) setHover(hover, lastPt, true); }
blockBtn.onclick = () => setBlock(!blockMode);
$('copy').onclick = () => {
  try { history.replaceState(null, '', '#' + serialize()); } catch (e) { location.hash = serialize(); }
  shareLink(serialize());
};
const menu = $('menu'), more = $('more');
more.onclick = e => { e.stopPropagation(); menu.hidden = !menu.hidden; more.setAttribute('aria-expanded', !menu.hidden); };
document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) { menu.hidden = true; more.setAttribute('aria-expanded', false); } });
$('fit').onclick = () => { fit(); menu.hidden = true; };
$('help').onclick = () => { menu.hidden = true; $('helpdlg').showModal(); };
const resetBtn = $('reset');
resetBtn.onclick = e => {
  e.stopPropagation();
  if (!targets.length && !blocked.size) { menu.hidden = true; return; }
  if (resetBtn.dataset.armed) { commit(() => { targets = []; blocked = new Set(); choice = {}; }); resetBtn.textContent = 'Reset tree'; delete resetBtn.dataset.armed; menu.hidden = true; say('Tree reset · Ctrl+Z to undo'); }
  else { resetBtn.dataset.armed = 1; resetBtn.textContent = 'Click again to reset'; setTimeout(() => { resetBtn.textContent = 'Reset tree'; delete resetBtn.dataset.armed; }, 3000); }
};
// theme: system -> light -> dark
const THEMES = ['system', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  $('theme').textContent = 'Theme: ' + t[0].toUpperCase() + t.slice(1); store.set('atlas-theme', t);
}
$('theme').onclick = e => { e.stopPropagation(); const cur = store.get('atlas-theme') || 'system'; applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % 3]); };
// pathing toggle
function setSmartUI(v) {
  smart = v;
  $('pathbtn').setAttribute('aria-checked', v);
  document.body.classList.toggle('manual', !v);
}
function setSmart(v) {
  if (v === smart) return;
  commit(() => {
    if (v) { // manual -> smart: keep the notables and keystones as targets, re-optimize the rest
      targets = order.filter(id => N[id].t === 'n' || N[id].t === 'k');
      say('Smart pathing on: tree rebuilt around your notables');
    } else { // smart -> manual: freeze the current tree in level order
      targets = order.slice();
      say('Manual pathing: clicks take the shortest path, like in game');
    }
    setSmartUI(v);
  });
}
$('pathbtn').onclick = () => setSmart(!smart);
async function loadTree(fromHash) {
  D = await loadData();
  N = D.nodes; ADJ = D.adj; ids = Object.keys(N); START = new Set(D.start); WH = D.wheels; SPR = D.spr; MAXP = LEAGUE_POINTS || D.pts;
  $('ver').textContent = D.version || '';
  document.title = `Atlas Tree ${D.version || ''}`;
  alloc = new Set(START); hover = null; preview = null; undoStack = []; redoStack = []; viewAt = Infinity;
  const saved = store.get('atlas-league') || '';
  const st = parse(fromHash || saved); targets = st.t; blocked = new Set(st.b); choice = st.c; setSmartUI(st.s);
  if (fromHash) {
    const match = loadSaved().find(x => x.code === fromHash);
    curName = match ? match.name : null; curShared = !match; store.set('atlas-current', curName || '');
  }
  if (fromHash && saved && saved !== fromHash) {
    // opening a shared link: keep the viewer's own tree one undo away
    const mine = parse(saved);
    undoStack = [JSON.stringify({ t: mine.t, b: mine.b, c: mine.c, s: mine.s })];
    setTimeout(() => say('Loaded shared tree · Ctrl+Z brings back yours'), 400);
  }
  setupOptimizer(); buildFocus(); runSearch();
  if (W) fit();
  await rebuild();
}

// ---------- keyboard ----------
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'radio';
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (curName) saveTree(curName); else openTrees(true, true); return; }
  if (e.key === 'Escape' && !tpop.hidden) { openTrees(false); return; }
  if (typing || mod || e.altKey) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); q.focus(); q.select(); }
  else if (k === 'f' || k === 'F') fit();
  else if (k === 'b' || k === 'B') setBlock(!blockMode);
  else if (k === 'o' || k === 'O') { showNums = !showNums; say(showNums ? 'Point numbers on (zoom in to see them)' : 'Point numbers off'); draw(); }
  else if (k === 'p' || k === 'P') setSmart(!smart);
  else if (k === '?') $('helpdlg').showModal();
  else if (k === 'ArrowRight' || k === 'ArrowLeft') { if (document.querySelector('dialog[open]')) return; e.preventDefault(); step(k === 'ArrowRight' ? 1 : -1); }
  else if (k === 'Home') { e.preventDefault(); setViewAt(Infinity); }
  else if (k === 'Escape') { closePicker(); if (q.value) { q.value = ''; runSearch(); } if (blockMode) setBlock(false); menu.hidden = true; fpop.hidden = true; }
});

// ---------- boot ----------
async function boot() {
  applyTheme(store.get('atlas-theme') || 'system');
  const p = store.get('atlas-prefs'); if (p) prefs = new Set(p.split('|').filter(Boolean));
  const repo = document.querySelector('meta[name="repo"]');
  if (repo && repo.content) { $('repo').href = repo.content; $('repo').hidden = false; }
  if (window.ATLAS_DATA && $('offline')) $('offline').hidden = true;
  loadImages(); initWorker();
  new ResizeObserver(() => { const first = !W; resize(); if (first && D) fit(); }).observe(cv);
  const f = store.get('atlas-focus'); if (f) focusSel = new Set(f.split('|').filter(Boolean));
  const h = decodeURIComponent(location.hash.slice(1));
  await loadTree(h || null);
  if (h) { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {} }
}
window.addEventListener('hashchange', () => { const h = decodeURIComponent(location.hash.slice(1)); if (h) loadTree(h); });
boot();
})();
