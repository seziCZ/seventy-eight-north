#!/usr/bin/env python3
"""
Builds a single self-contained HTML file: dist/seventy-eight-north.html

  * ES modules under src/ are bundled into one inline script (each module wrapped in a function,
    imports turned into lookups of the exporting module's result), in dependency order.
  * three.js is loaded from its classic UMD build instead of the ES module build (same version).
  * assets/ files are inlined as data URIs.

The result opens straight from disk (no server needed). It still loads three.js and the font from CDNs.

Conventions the bundler relies on (keep them when editing src/):
  * one import per line:   import { a, b } from './file.js';   or   import * as THREE from 'three';
  * exports are declared inline:   export function name / export const NAME = ... (one name per statement)
"""
import base64
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
ENTRY = SRC / 'main.js'
THREE_UMD = 'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js'
ASSETS = {'assets/sky.jpg': 'image/jpeg', 'assets/ocean-noise.png': 'image/png'}

IMPORT_RE = re.compile(r"^import\s+(.+?)\s+from\s+'([^']+)';\s*$", re.M)
EXPORT_RE = re.compile(r'^export\s+(function|const|let|class)\s+([A-Za-z_$][\w$]*)', re.M)


def module_id(path):
    return path.relative_to(SRC).as_posix()


def collect(path, order, seen):
    """Depth-first: dependencies before dependents."""
    if path in seen:
        return
    seen.add(path)
    for _, spec in IMPORT_RE.findall(path.read_text(encoding='utf-8')):
        if spec.startswith('.'):
            collect((path.parent / spec).resolve(), order, seen)
    order.append(path)


def transform(path):
    code = path.read_text(encoding='utf-8')

    def replace_import(m):
        what, spec = m.group(1), m.group(2)
        if spec == 'three':
            return ''   # THREE is a global from the UMD build
        dep = module_id((path.parent / spec).resolve())
        if not what.startswith('{'):
            sys.exit(f'{path}: only named imports are supported for local modules')
        return f"const {what} = __modules['{dep}'];"

    code = IMPORT_RE.sub(replace_import, code)
    exports = [name for _, name in EXPORT_RE.findall(code)]
    code = EXPORT_RE.sub(lambda m: f'{m.group(1)} {m.group(2)}', code)
    body = code.rstrip() + f"\nreturn {{ {', '.join(exports)} }};"
    indented = '\n'.join(('  ' + line) if line else '' for line in body.split('\n'))
    return f"__modules['{module_id(path)}'] = (() => {{\n{indented}\n}})();"


def main():
    order = []
    collect(ENTRY.resolve(), order, set())
    bundle = '(() => {\nconst __modules = {};\n\n' + '\n\n'.join(transform(p) for p in order) + '\n})();'

    for rel, mime in ASSETS.items():
        data = base64.b64encode((ROOT / rel).read_bytes()).decode()
        if f"'{rel}'" not in bundle:
            sys.exit(f'asset path {rel} not found in the sources')
        bundle = bundle.replace(f"'{rel}'", f"'data:{mime};base64,{data}'")

    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    scripts = re.compile(r'<script type="importmap">.*?</script>\s*<script type="module" src="src/main.js"></script>', re.S)
    if not scripts.search(html):
        sys.exit('index.html: import map / module script block not found')
    html = scripts.sub(lambda m: f'<script src="{THREE_UMD}"></script>\n<script>\n{bundle}\n</script>', html)

    out = ROOT / 'dist' / 'seventy-eight-north.html'
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding='utf-8', newline='\n')
    print(f'wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1e6:.1f} MB, {len(order)} modules)')


if __name__ == '__main__':
    main()
