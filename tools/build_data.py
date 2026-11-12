#!/usr/bin/env python3
"""Build the planner's data files from a GGG atlas tree export.

Usage: python tools/build_data.py <export_dir> [--version 3.30.0]

Reads <export_dir>/data.json, writes data/league.json and copies the sprite
sheets into assets/.
Export source: https://github.com/grindinggear/atlastree-export
"""
import json, math, os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZOOM = '0.5'
A16 = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330]
A40 = [0, 10, 20, 30, 40, 45, 50, 60, 70, 80, 90, 100, 110, 120, 130, 135, 140, 150, 160, 170, 180,
       190, 200, 210, 220, 225, 230, 240, 250, 260, 270, 280, 290, 300, 310, 315, 320, 330, 340, 350]
# small passives that are pathing filler rather than part of a mechanic wheel
GENERIC_SMALLS = {'Map Drop Chance', 'Thread Drop Chance', 'Map Pack Size', 'Item Rarity', 'Map Magic Monsters',
                  'Map Rare Monsters', 'Map Modifier Effect', 'Magic Monsters', ''}
SHEETS = {'on': 'atlas-skills', 'off': 'atlas-skills-disabled', 'mas': 'atlas-mastery', 'fr': 'atlas-frame', 'gb': 'atlas-group-background'}


def clean(t):
    """'[SurpassChance|Surpassing Chance]' -> 'Surpassing Chance'"""
    return re.sub(r'\[(?:[^\]|]*\|)?([^\]]*)\]', r'\1', t)


def build(src):
    d = json.load(open(src, encoding='utf-8'))
    C = d['constants']; R = C['orbitRadii']; SPO = C['skillsPerOrbit']
    G = d['groups']; N = d['nodes']

    def ang(o, i):
        n = SPO[o]
        if n == 16: return math.radians(A16[i])
        if n == 40: return math.radians(A40[i])
        return 2 * math.pi * i / n

    out = {}
    for k, n in N.items():
        if k == 'root': continue
        g = G[str(n['group'])]; a = ang(n['orbit'], n['orbitIndex']); r = R[n['orbit']]
        t = ('k' if n.get('isKeystone') else 'w' if n.get('isWormhole') else 'm' if n.get('isMastery')
             else 'n' if n.get('isNotable') else ('s' if n['name'] == '' else 'p'))
        e = {'x': round(g['x'] + r * math.sin(a), 1), 'y': round(g['y'] - r * math.cos(a), 1), 't': t,
             'nm': n['name'], 'ic': n['icon'], 'st': [clean(x) for x in n['stats']], 'g': n['group']}
        if n.get('reminderText'): e['rm'] = [clean(x) for x in n['reminderText']]
        if n.get('variantEffects'): e['va'] = [[clean(x) for x in v['stats']] for v in n['variantEffects']]
        out[k] = e

    edges, seen = [], set()
    for k, n in N.items():
        if k not in out: continue
        conn = {c['to']: c for c in n.get('connections', [])}
        for b in n['out'] + n['in']:
            if b not in out: continue
            key = tuple(sorted((k, b)))
            if key in seen: continue
            seen.add(key)
            A_, B_ = out[k], out[b]
            if 'm' in (A_['t'], B_['t']) or (A_['t'] == 'w' and B_['t'] == 'w'): continue
            nb = N[b]; e = [k, b]
            if n['group'] == nb['group'] and n['orbit'] == nb['orbit'] and n['orbit'] > 0:
                g = G[str(n['group'])]; e += [g['x'], g['y'], R[n['orbit']]]
            else:
                c = conn.get(b) or {c2['to']: c2 for c2 in nb.get('connections', [])}.get(k)
                if c and c.get('orbit') and 'orbitX' in c:
                    e += [c['orbitX'], c['orbitY'], round(math.hypot(A_['x'] - c['orbitX'], A_['y'] - c['orbitY']), 1)]
            edges.append(e)

    adj = {}
    for k, n in N.items():
        if k not in out or out[k]['t'] == 'm': continue
        for b in n['out'] + n['in']:
            if b in out and out[b]['t'] != 'm':
                adj.setdefault(k, set()).add(b); adj.setdefault(b, set()).add(k)
    adj = {k: sorted(v) for k, v in adj.items()}

    # wheels: each mastery's group, plus attached notable/keystone groups
    wheels, nodeWheel = [], {}
    for k, n in N.items():
        if n.get('isMastery'):
            wheels.append({'nm': n['name'], 'm': k, 'g': n['group'], 'mem': [x for x in G[str(n['group'])]['nodes'] if x in out]})
    gw = {w['g']: i for i, w in enumerate(wheels)}
    for i, w in enumerate(wheels):
        for x in w['mem']: nodeWheel[x] = i
    for gid, g in G.items():
        if int(gid) in gw: continue
        ns = [x for x in g['nodes'] if x in out and out[x]['t'] not in ('w', 's', 'm')]
        if not ns or all(out[x]['nm'] in GENERIC_SMALLS for x in ns): continue
        cand = None
        for x in ns:
            for b in adj.get(x, []):
                if b in nodeWheel and N[b]['group'] in gw: cand = nodeWheel[b]; break
            if cand is not None: break
        if cand is None:
            best, bd = None, 1e9
            for i, w in enumerate(wheels):
                m = out[w['m']]; dd = math.hypot(m['x'] - g['x'], m['y'] - g['y'])
                if dd < bd: bd, best = dd, i
            if bd < 450: cand = best
        if cand is not None:
            for x in ns: wheels[cand]['mem'].append(x); nodeWheel[x] = cand
    W2 = []
    for w in wheels:
        m = out[w['m']]
        r = max(math.hypot(out[x]['x'] - m['x'], out[x]['y'] - m['y']) for x in w['mem']) + 90
        W2.append([w['nm'], m['x'], m['y'], round(r)])
    for k, i in nodeWheel.items(): out[k]['wh'] = i

    S = d['sprites']
    spr = {k: S[k][ZOOM]['coords'] for k in ['normalActive', 'notableActive', 'keystoneActive', 'wormholeActive',
                                             'mastery', 'frame', 'groupBackground', 'startNode']}
    gb = [[g['x'], g['y'], g['background']['image'], g['background'].get('offsetX', 0), g['background'].get('offsetY', 0)]
          for g in G.values() if 'background' in g]
    return {'nodes': out, 'edges': edges, 'adj': adj, 'wheels': W2, 'spr': spr, 'gb': gb,
            'start': [k for k, e in out.items() if e['t'] == 's'], 'pts': d['points']['totalPoints'],
            'bounds': [d['min_x'], d['min_y'], d['max_x'], d['max_y']]}


def main():
    args = sys.argv[1:]
    if not args: sys.exit(__doc__)
    src = args[0]
    version = args[args.index('--version') + 1] if '--version' in args else re.sub(r'.*?(\d+\.\d+\.\d+).*', r'\1', os.path.basename(os.path.normpath(src)))
    os.makedirs(os.path.join(ROOT, 'data'), exist_ok=True); os.makedirs(os.path.join(ROOT, 'assets'), exist_ok=True)
    for mode, fn in [('league', 'data.json')]:
        p = os.path.join(src, fn)
        if not os.path.exists(p): print('skip', mode, '(missing', fn + ')'); continue
        data = build(p); data['version'] = version; data['mode'] = mode
        with open(os.path.join(ROOT, 'data', mode + '.json'), 'w', encoding='utf-8') as f:
            json.dump(data, f, separators=(',', ':'), ensure_ascii=False)
        print(mode, len(data['nodes']), 'nodes,', len(data['edges']), 'edges')
    for key, base in SHEETS.items():
        shutil.copy(os.path.join(src, 'assets', base + '-4.webp'), os.path.join(ROOT, 'assets', base + '.webp'))
    # The map background art: the mid zoom level is plenty for a blurry backdrop and keeps the offline file small.
    bg = os.path.join(src, 'assets', 'atlas-background-2.webp')
    if os.path.exists(bg): shutil.copy(bg, os.path.join(ROOT, 'assets', 'atlas-background.webp'))
    with open(os.path.join(ROOT, 'data', 'version.json'), 'w') as f:
        json.dump({'version': version}, f)
    print('version', version)


if __name__ == '__main__':
    main()
