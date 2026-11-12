/* Atlas Tree planner — main page logic. Data comes from data/league.json (built by
   tools/build_data.py), or from window.ATLAS_DATA in the single-file build. */
(() => {
'use strict';

// ---------- constants ----------
const SC = 2; // sprites are from the 0.5 zoom sheet: world size = px / 0.5
const IMG_FILES = { on: 'atlas-skills', off: 'atlas-skills-disabled', mas: 'atlas-mastery', fr: 'atlas-frame', gb: 'atlas-group-background' };
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
  const max = used();
  if (viewAt !== Infinity && viewAt > max) viewAt = Infinity;
  save(); syncScrub(); renderSide(); renderBudget(); updateUndo(); renderCompare(); draw();
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
function manualPath(target) {
  const prev = new Map(), q = [];
  for (const id of alloc) { prev.set(id, null); q.push(id); }
  for (let i = 0; i < q.length; i++) {
    const c = q[i]; if (c === target) break;
    for (const b of ADJ[c] || []) if (!prev.has(b) && !blocked.has(b) && N[b].t !== 'm') { prev.set(b, c); q.push(b); }
  }
  if (!prev.has(target)) return null;
  const p = []; for (let c = target; c != null && !alloc.has(c); c = prev.get(c)) p.push(c);
  return p.reverse();
}
function refundSet(id) {
  const rest = new Set(targets.filter(t => t !== id)), keep = connectedFrom(rest);
  return targets.filter(t => !keep.has(t));
}
const previewCache = new Map(); let preview = null;
function requestPreview(id) {
  if (previewCache.has(id)) { preview = previewCache.get(id); return; }
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
  const n = N[id]; if (!n || START.has(id) || n.t === 'm') return;
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
function moveTarget(from, to) {
  if (to < 0 || to >= targets.length || from === to) return;
  commit(() => { const [x] = targets.splice(from, 1); targets.splice(to, 0, x); });
}

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

function renderSaved() {
  const list = loadSaved(), el = $('savedlist');
  el.innerHTML = list.length ? list.map((x, i) => `<li data-i="${i}"><span class="nm"><b>${esc(x.name)}</b><small>${x.pts} points · ${x.code[0] === 'm' ? 'manual' : 'smart'}</small></span>` +
    `<span class="ctl"><button type="button" data-act="load">Load</button><button type="button" data-act="cmp">Compare</button><button type="button" data-act="del" aria-label="Delete ${esc(x.name)}">✕</button></span></li>`).join('')
    : '<li class="empty">Nothing saved yet. Name the tree you have open and save it to come back to it later.</li>';
}
$('trees').onclick = () => { menu.hidden = true; renderSaved(); $('importmsg').textContent = ''; $('treesdlg').showModal(); };
$('saveform').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('savename').value.trim(); if (!name) { $('savename').focus(); return; }
  if (!targets.length) { say('Nothing to save yet'); return; }
  const list = loadSaved(), i = list.findIndex(x => x.name.toLowerCase() === name.toLowerCase());
  const entry = { name, code: serialize(), pts: used() };
  if (i >= 0) list[i] = entry; else list.unshift(entry);
  writeSaved(list); renderSaved(); $('savename').value = '';
  say(i >= 0 ? `Updated "${name}"` : `Saved "${name}"`);
});
$('savedlist').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const list = loadSaved(), i = +b.closest('li').dataset.i, x = list[i]; if (!x) return;
  if (b.dataset.act === 'del') { list.splice(i, 1); writeSaved(list); renderSaved(); say(`Deleted "${x.name}"`); return; }
  $('treesdlg').close();
  if (b.dataset.act === 'load') { applyState(parse(x.code)); say(`Loaded "${x.name}" · Ctrl+Z to undo`); }
  if (b.dataset.act === 'cmp') startCompare(parse(x.code), x.name);
});
function importAction(cmp) {
  const r = readLink($('importtxt').value), msg = $('importmsg');
  if (r.err) { msg.textContent = r.err; msg.className = 'msg bad'; return; }
  $('treesdlg').close(); $('importtxt').value = '';
  if (cmp) startCompare(r.st, 'pasted link');
  else { applyState(r.st); say('Loaded · Ctrl+Z to undo'); }
}
$('importload').onclick = () => importAction(false);
$('importcmp').onclick = () => importAction(true);

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
function statLines(id) {
  const n = N[id]; if (['m', 's', 'w'].includes(n.t)) return [];
  let st = n.st.flatMap(s => s.split('\n')).map(s => s.trim()).filter(Boolean);
  if (n.va) {
    const v = (n.va[choice[id] ?? 0] || []).flatMap(s => s.split('\n')).map(s => s.trim()).filter(Boolean);
    if (st.length && v.every(x => x.length < 40 && !/\d/.test(x))) st = [...st.slice(0, -1), st[st.length - 1] + ' ' + v.join(' / ')];
    else st = st.concat(v);
  }
  return st;
}

// ---------- side panel ----------
let tab = 'plan';
function renderBudget() {
  const u = used(), el = $('budget'), over = u - MAXP;
  el.textContent = over > 0 ? `${over} point${over > 1 ? 's' : ''} over budget` : `${MAXP - u} points left`;
  el.classList.toggle('over', over > 0);
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
  renderPlan(); renderMods();
}
function renderPlan() {
  let h = '';
  if (unreachable.size) h += `<h3>Unreachable</h3><div class="warn">${[...unreachable].map(i => esc(N[i].nm)).join(', ')} cannot be reached with the current blocks.</div>`;
  if (!targets.length) h += smart ? `<div class="empty">Click nodes on the atlas to add targets. They are listed here in the order you would level them, with the points each one costs.</div>`
    : `<div class="empty">Manual pathing: click a node to take the shortest path to it from what you have, like in game. Click an allocated node to refund it.</div>`;
  else if (!smart) {
    h += `<h3>Allocation order <span>as clicked</span></h3><ol class="plan" id="planlist">`;
    let k = 0;
    for (const g of groups) {
      const a = g.from + 1, b = g.from + g.n, n = g.t ? N[g.t] : null;
      const range = g.n === 1 ? `point ${a}` : `points ${a}–${b} · +${g.n}`;
      const later = viewAt !== Infinity && a > viewAt, cur = viewAt !== Infinity && a <= viewAt && b >= viewAt;
      h += `<li data-id="${g.t || ''}" class="manual${later ? ' later' : ''}${cur ? ' cur' : ''}">
        <span class="n">${n ? ++k : '·'}</span>
        <span class="nm"><b class="n-${n ? n.t : 'p'}">${n ? esc(n.nm) : 'Small passives'}</b><small>${range}</small></span>
        <span class="ctl">${n ? `<button data-act="go" aria-label="Show ${esc(n.nm)} on the tree">◎</button><button data-act="refund" aria-label="Refund ${esc(n.nm)}">✕</button>` : ''}</span>
      </li>`;
    }
    h += '</ol>';
  } else {
    h += `<h3>Allocation order <span>drag to reorder</span></h3><ol class="plan" id="planlist">`;
    targets.forEach((t, i) => {
      const g = groups[i] || { from: 0, n: 0 }, n = N[t];
      const a = g.from + 1, b = g.from + g.n;
      const range = unreachable.has(t) ? 'unreachable' : g.n === 0 ? 'already on path' : g.n === 1 ? `point ${a}` : `points ${a}–${b} · +${g.n}`;
      const later = viewAt !== Infinity && a > viewAt, cur = viewAt !== Infinity && a <= viewAt && b >= viewAt && g.n;
      h += `<li draggable="true" data-i="${i}" class="${later ? 'later' : ''}${cur ? ' cur' : ''}${unreachable.has(t) ? ' bad' : ''}">
        <span class="n">${i + 1}</span>
        <span class="nm"><b class="n-${n.t}">${esc(n.nm)}</b><small>${range}</small></span>
        <span class="ctl"><button data-act="up" aria-label="Move ${esc(n.nm)} up">▲</button><button data-act="down" aria-label="Move ${esc(n.nm)} down">▼</button><button data-act="go" aria-label="Show ${esc(n.nm)} on the tree">◎</button><button data-act="del" aria-label="Remove ${esc(n.nm)}">✕</button></span>
      </li>`;
    });
    h += '</ol>';
  }
  // path preferences
  if (!smart) { $('pane-plan').innerHTML = h; return; }
  const smalls = {};
  for (const id of ids) if (N[id].t === 'p') smalls[N[id].nm] = (smalls[N[id].nm] || 0) + 1;
  const names = Object.keys(smalls).sort((a, b) => (GENERIC_SMALLS.includes(b) - GENERIC_SMALLS.includes(a)) || smalls[b] - smalls[a]);
  h += `<details class="prefs" id="prefsbox"${store.get('atlas-prefs-open') === '1' ? ' open' : ''}><summary>Path preferences</summary>
    <p>When two routes cost the same number of points, the planner takes the one that passes through more of these small passives.</p>
    <div class="chips">${names.map((nm, i) => `<label><input type="checkbox" id="pf${i}" data-nm="${esc(nm)}" ${prefs.has(nm) ? 'checked' : ''}>${esc(nm)} <em>${smalls[nm]}</em></label>`).join('')}</div></details>`;
  $('pane-plan').innerHTML = h;
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
  if (!used(ea)) h += `<div class="empty">No points allocated${viewAt !== Infinity ? ' at this point count' : ''}.</div>`;
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
function setTab(t) {
  tab = t;
  for (const x of ['plan', 'mods']) { $('tab-' + x).setAttribute('aria-selected', x === t); $('pane-' + x).hidden = x !== t; }
}
function syncScrub() {
  const s = $('at'), u = used(), st = steps();
  s.max = u; s.value = viewAt === Infinity ? u : viewAt;
  $('atv').textContent = viewAt === Infinity ? 'all' : viewAt;
  $('stprev').disabled = $('stnext').disabled = !st.length;
  const info = $('stepinfo'), i = curStep();
  info.hidden = viewAt === Infinity || i < 0;
  if (!info.hidden) {
    const g = st[i], n = g.t ? N[g.t] : null, a = g.from + 1, b = g.from + g.n;
    info.innerHTML = `<span>Step ${i + 1} of ${st.length}</span> <b class="n-${n ? n.t : 'p'}">${n ? esc(n.nm) : 'Small passives'}</b> <small>${a === b ? `point ${a}` : `points ${a}–${b}`}</small>`;
  }
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
$('tab-plan').onclick = () => setTab('plan');
$('tab-mods').onclick = () => setTab('mods');
$('at').addEventListener('input', e => setViewAt(+e.target.value));
$('stprev').onclick = () => step(-1);
$('stnext').onclick = () => step(1);
$('pane-mods').addEventListener('change', e => {
  const t = e.target; if (!t.dataset.id) return;
  commit(() => { choice[t.dataset.id] = +t.dataset.i; });
});
$('pane-plan').addEventListener('change', e => {
  const t = e.target; if (!t.dataset.nm) return;
  if (t.checked) prefs.add(t.dataset.nm); else prefs.delete(t.dataset.nm);
  setupOptimizer(); rebuild();
});
$('pane-plan').addEventListener('toggle', e => { if (e.target.id === 'prefsbox') store.set('atlas-prefs-open', e.target.open ? '1' : '0'); }, true);
$('pane-plan').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const li = b.closest('li');
  if (li.classList.contains('manual')) {
    const id = li.dataset.id;
    if (b.dataset.act === 'go') { centerOn(id); setHover(id, { x: W / 2, y: H / 2 }, true); }
    if (b.dataset.act === 'refund') { const gone = new Set(refundSet(id)); commit(() => { targets = targets.filter(t => !gone.has(t)); }); }
    return;
  }
  const i = +li.dataset.i, t = targets[i];
  if (b.dataset.act === 'up') moveTarget(i, i - 1);
  if (b.dataset.act === 'down') moveTarget(i, i + 1);
  if (b.dataset.act === 'del') commit(() => { targets.splice(i, 1); });
  if (b.dataset.act === 'go') { centerOn(t); setHover(t, { x: W / 2, y: H / 2 }, true); }
});
let dragFrom = null;
$('pane-plan').addEventListener('dragstart', e => { const li = e.target.closest('li'); if (!li) return; dragFrom = +li.dataset.i; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
$('pane-plan').addEventListener('dragover', e => { const li = e.target.closest('li'); if (!li || dragFrom == null) return; e.preventDefault(); document.querySelectorAll('.plan li.over').forEach(x => x.classList.remove('over')); li.classList.add('over'); });
$('pane-plan').addEventListener('drop', e => { const li = e.target.closest('li'); if (!li || dragFrom == null) return; e.preventDefault(); const to = +li.dataset.i, f = dragFrom; dragFrom = null; moveTarget(f, to); });
$('pane-plan').addEventListener('dragend', () => { dragFrom = null; document.querySelectorAll('.plan li').forEach(x => x.classList.remove('over', 'dragging')); });
$('pane-plan').addEventListener('mouseover', e => { const li = e.target.closest('li[data-i], li[data-id]'); hoverPlan = li ? (li.dataset.id || targets[+li.dataset.i]) : null; draw(); });
$('pane-plan').addEventListener('mouseleave', () => { hoverPlan = null; draw(); });
let hoverPlan = null;
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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#0b0a0c'; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(dpr * view.s, 0, 0, dpr * view.s, -view.x * view.s * dpr, -view.y * view.s * dpr);
  const pad = 800, vx0 = view.x - pad, vy0 = view.y - pad, vx1 = view.x + W / view.s + pad, vy1 = view.y + H / view.s + pad;
  const vis = (x, y) => x > vx0 && x < vx1 && y > vy0 && y < vy1;
  const px = 1 / view.s;
  const ea = effAlloc();
  const dim = id => focusSet && !focusSet.has(id) && !ea.has(id);
  const T = smart ? tset() : new Set(groups.map(g => g.t).filter(Boolean));
  const ci = viewAt === Infinity ? -1 : curStep(), stepT = ci >= 0 ? steps()[ci].t : null;

  if (focusSet) {
    const on = new Set([...focusSel].filter(f => f !== '*generic')); if (focusSel.has('*generic')) GENERIC_WHEELS.forEach(w => on.add(w));
    for (const [nm, x, y, r] of WH) if (on.has(nm) && nm !== hoverMech) {
      const g = ctx.createRadialGradient(x, y, r * .2, x, y, r);
      g.addColorStop(0, 'rgba(242,212,138,0.16)'); g.addColorStop(1, 'rgba(242,212,138,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(242,212,138,0.45)'; ctx.lineWidth = Math.max(8, 1.5 * px); ctx.stroke();
    }
  }
  if (hoverMech) for (const [nm, x, y, r] of WH) if (nm === hoverMech) {
    const g = ctx.createRadialGradient(x, y, r * .3, x, y, r);
    g.addColorStop(0, 'rgba(242,212,138,0.20)'); g.addColorStop(1, 'rgba(242,212,138,0.04)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(242,212,138,0.85)'; ctx.lineWidth = Math.max(10, 2.5 * px);
    ctx.setLineDash([60, 30]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.globalAlpha = focusSet ? 0.2 : 0.5;
  for (const [gx, gy, im, ox, oy] of D.gb) if (vis(gx, gy)) sprite(imgs.gb, SPR.groupBackground[im], gx + ox * SC, gy + oy * SC);
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
    ctx.globalAlpha = dim(id) ? 0.22 : 1;
    if (n.t === 's') { ctx.globalAlpha = 1; sprite(imgs.gb, SPR.startNode.AtlasPassiveSkillScreenStart, n.x, n.y, 0.55); continue; }
    if (n.t === 'm') { ctx.globalAlpha *= 0.85; sprite(imgs.mas, SPR.mastery[n.ic], n.x, n.y); ctx.globalAlpha = 1; continue; }
    const sheet = { p: 'normalActive', n: 'notableActive', k: 'keystoneActive', w: 'wormholeActive' }[n.t];
    const ok = sprite(on ? imgs.on : imgs.off, SPR[sheet][n.t === 'w' ? 'Wormhole' : n.ic], n.x, n.y);
    if (!ok) { ctx.fillStyle = on ? '#c8a24a' : '#3c372d'; ctx.beginPath(); ctx.arc(n.x, n.y, radius(n.t) * .7, 0, 7); ctx.fill(); }
    const st = on ? 'Allocated' : can || planned(id) ? 'CanAllocate' : 'Unallocated';
    const fr = n.t === 'p' ? (on ? 'PSSkillFrameActive' : can || planned(id) ? 'PSSkillFrameHighlighted' : 'PSSkillFrame') : (n.t === 'n' ? 'Notable' : n.t === 'k' ? 'Keystone' : 'Wormhole') + 'Frame' + st;
    sprite(imgs.fr, SPR.frame[fr], n.x, n.y);
    ctx.globalAlpha = 1;
    const ring = (col, off, w) => { ctx.strokeStyle = col; ctx.lineWidth = Math.max(w, w / 4 * px); ctx.beginPath(); ctx.arc(n.x, n.y, radius(n.t) + off, 0, 7); ctx.stroke(); };
    const hl = hoverPlan === id || stepT === id;
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
  h += '</div>';
  if (n.t !== 'm') {
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
    if (n && n.t !== 'm' && n.t !== 's' && !alloc.has(id) && !blocked.has(id) && !blockMode) requestPreview(id);
    cv.classList.toggle('over', !!n && n.t !== 'm');
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
function buildFocus() {
  const present = new Set(WH.map(w => w[0]));
  const ranked = MECH_RANK.filter(n => present.has(n));
  const rest = [...present].filter(n => !GENERIC_WHEELS.includes(n) && !ranked.includes(n)).sort();
  const chip = (v, label, cls = '') => `<label class="${cls}"><input type="checkbox" data-f="${esc(v)}" ${focusSel.has(v) ? 'checked' : ''}>${esc(label)}</label>`;
  $('fpop').innerHTML = `<div class="fhd"><span>Highlight on the tree</span><button type="button" id="fclear">Clear</button></div>
    <div class="chips">${chip('*generic', 'All-map (generic)', 'gen')}</div>
    <div class="fsub">Mechanics, most farmed first</div>
    <div class="chips">${[...ranked, ...rest].map(n => chip(n, n)).join('')}</div>`;
  applyFocus();
}
function applyFocus() {
  const n = focusSel.size;
  $('focusbtn').innerHTML = n ? `Focus <b>${n}</b>` : 'Focus';
  $('focusbtn').setAttribute('aria-pressed', n > 0);
  store.set('atlas-focus', [...focusSel].join('|'));
  if (!n) { focusSet = null; draw(); return; }
  const wheelOk = new Set([...focusSel].filter(f => f !== '*generic'));
  const gen = focusSel.has('*generic');
  if (gen) GENERIC_WHEELS.forEach(w => wheelOk.add(w));
  focusSet = new Set(ids.filter(id => {
    const nd = N[id];
    if (nd.wh != null) return wheelOk.has(WH[nd.wh][0]);
    return gen && GENERIC_SMALLS.includes(nd.nm);
  }));
  draw();
}
const fpop = $('fpop'), fbtn = $('focusbtn');
fbtn.onclick = e => { e.stopPropagation(); fpop.hidden = !fpop.hidden; fbtn.setAttribute('aria-expanded', !fpop.hidden); };
fpop.addEventListener('click', e => { e.stopPropagation(); if (e.target.id === 'fclear') { focusSel.clear(); fpop.querySelectorAll('input').forEach(i => i.checked = false); applyFocus(); } });
fpop.addEventListener('change', e => { const f = e.target.dataset.f; if (!f) return; if (e.target.checked) focusSel.add(f); else focusSel.delete(f); applyFocus(); });
document.addEventListener('click', e => { if (!fpop.hidden && !fpop.contains(e.target)) { fpop.hidden = true; fbtn.setAttribute('aria-expanded', false); } });


// ---------- header buttons ----------
const toast = $('toast'); let tt;
function say(m) { toast.textContent = m; toast.hidden = false; clearTimeout(tt); tt = setTimeout(() => toast.hidden = true, 2000); }
function updateUndo() { $('undo').disabled = !undoStack.length; $('redo').disabled = !redoStack.length; }
$('undo').onclick = undo; $('redo').onclick = redo;
const blockBtn = $('block');
function setBlock(v) { blockMode = v; blockBtn.setAttribute('aria-pressed', v); say(v ? 'Block mode on: clicks block nodes' : 'Block mode off'); if (hover) setHover(hover, lastPt, true); }
blockBtn.onclick = () => setBlock(!blockMode);
$('copy').onclick = () => {
  const url = linkUrl();
  try { history.replaceState(null, '', '#' + serialize()); } catch (e) { location.hash = serialize(); }
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(() => say('Link copied'), () => say('Link is in the address bar'));
  else say('Link is in the address bar');
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
  $('p-smart').setAttribute('aria-pressed', v); $('p-manual').setAttribute('aria-pressed', !v);
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
$('p-smart').onclick = () => setSmart(true);
$('p-manual').onclick = () => setSmart(false);
async function loadTree(fromHash) {
  D = await loadData();
  N = D.nodes; ADJ = D.adj; ids = Object.keys(N); START = new Set(D.start); WH = D.wheels; SPR = D.spr; MAXP = LEAGUE_POINTS || D.pts;
  $('ver').textContent = D.version || '';
  document.title = `Atlas Tree ${D.version || ''}`;
  alloc = new Set(START); hover = null; preview = null; undoStack = []; redoStack = []; viewAt = Infinity;
  const saved = store.get('atlas-league') || '';
  const st = parse(fromHash || saved); targets = st.t; blocked = new Set(st.b); choice = st.c; setSmartUI(st.s);
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
