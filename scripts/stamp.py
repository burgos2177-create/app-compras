#!/usr/bin/env python3
"""Cache-busting para ESM nativo (sin bundler).

Estampa ?v=<version> en TODOS los imports relativos de js/**.js y en el <link>
de CSS de index.html. Idempotente: reemplaza cualquier ?v= previo.

Uso:  python scripts/stamp.py <version>   (ej. la fecha: 20260605)

No toca imports https:// (CDN, ya versionados) ni el import dinámico de
main.js en index.html (que ya lleva ?v=Date.now() para recargarse siempre).
"""
import re, sys, pathlib

ver = sys.argv[1] if len(sys.argv) > 1 else None
if not ver:
    print("Falta <version>. Ej: python scripts/stamp.py 20260605"); sys.exit(1)

root = pathlib.Path(__file__).resolve().parent.parent
# from '...js'  o  import('...js')  con especificador relativo (./ o ../)
js_pat = re.compile(r"""((?:from\s+|import\(\s*)['"])((?:\./|\.\./)[^'"]+?\.js)(?:\?v=[^'"]*)?(['"])""")
n = 0
for f in sorted(root.glob('js/**/*.js')):
    s = f.read_text(encoding='utf-8')
    ns = js_pat.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={ver}{m.group(3)}", s)
    if ns != s:
        f.write_text(ns, encoding='utf-8'); n += 1
# index.html: solo el CSS (main.js ya usa ?v=Date.now())
idx = root / 'index.html'
h = idx.read_text(encoding='utf-8')
h2 = re.sub(r'(href=")(css/main\.css)(?:\?v=[^"]*)?(")', rf'\1\2?v={ver}\3', h)
if h2 != h:
    idx.write_text(h2, encoding='utf-8'); print('stamped index.html')
print(f'stamped {n} archivos js con ?v={ver}')
