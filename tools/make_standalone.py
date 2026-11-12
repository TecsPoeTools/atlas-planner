#!/usr/bin/env python3
"""Bundle the site into one self-contained HTML file (data + images inlined).

Usage: python tools/make_standalone.py [out.html] [--fragment]
--fragment drops the <html>/<head>/<body> wrapper (for hosts that add their own).
"""
import base64, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = {'on': 'atlas-skills', 'off': 'atlas-skills-disabled', 'mas': 'atlas-mastery', 'fr': 'atlas-frame', 'gb': 'atlas-group-background'}
rd = lambda p: open(os.path.join(ROOT, p), encoding='utf-8').read()

def main():
    args = sys.argv[1:]
    out = next((a for a in args if not a.startswith('--')), os.path.join(ROOT, 'dist', 'atlas-tree.html'))
    frag = '--fragment' in args
    html = rd('index.html')
    data = {m: json.loads(rd(f'data/{m}.json')) for m in ('league', 'ruthless') if os.path.exists(os.path.join(ROOT, 'data', m + '.json'))}
    imgs = {k: 'data:image/webp;base64,' + base64.b64encode(open(os.path.join(ROOT, 'assets', v + '.webp'), 'rb').read()).decode() for k, v in IMG.items()}
    html = re.sub(r'\s*<a id="offline"[^>]*>.*?</a>', '', html)  # the bundle is already the offline copy
    html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + rd('style.css') + '\n</style>')
    payload = '<script>window.ATLAS_DATA=' + json.dumps(data, separators=(',', ':'), ensure_ascii=False) + ';window.ATLAS_IMGS=' + json.dumps(imgs) + ';</script>'
    html = html.replace('<script id="optimizer-js" src="optimizer.js"></script>', payload + '\n<script id="optimizer-js">\n' + rd('optimizer.js') + '\n</script>')
    html = html.replace('<script src="app.js"></script>', '<script>\n' + rd('app.js') + '\n</script>')
    if frag:
        html = re.sub(r'<!doctype html>\s*|</?html[^>]*>|</?body>|<head>|</head>|<meta charset="utf-8">\s*|<meta name="viewport"[^>]*>\s*', '', html, flags=re.I)
        html = html.replace('<!--STANDALONE_HEAD-->', '<meta name="claude:viewport-fit-sides" content="cover">')
        html = re.sub(r'^\s*(<title>.*?</title>)', r'\1', html.strip(), flags=re.S)
        if not html.startswith('<title>'):
            t = re.search(r'<title>.*?</title>', html).group(0); html = t + '\n' + html.replace(t, '', 1)
    else:
        html = html.replace('<!--STANDALONE_HEAD-->', '')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    open(out, 'w', encoding='utf-8').write(html)
    print(out, len(html) // 1024, 'KB')

if __name__ == '__main__':
    main()
