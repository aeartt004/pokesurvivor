#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nombres oficiales en chino tradicional (zh-Hant) de los Pokémon del juego,
para el idioma 繁體中文 (js/core/i18n.js). Genera js/data/lang-zh-TW-dex.js:

    python tools/fetch_zh_names.py

Clave = el nombre tal como está en js/data/pokedex.js (en español), valor = el
nombre oficial de PokeAPI (pokemon_species_names.csv, idioma zh-hant). Hay que
volver a lanzarlo si cambia la lista de Pokémon.
"""
import csv
import io
import json
import os
import re
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEX = os.path.join(ROOT, 'js', 'data', 'pokedex.js')
OUT = os.path.join(ROOT, 'js', 'data', 'lang-zh-TW-dex.js')
CACHE = os.path.join(ROOT, 'tools', 'cache')
BASE = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/'


def fetch(name):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        os.makedirs(CACHE, exist_ok=True)
        req = urllib.request.Request(BASE + name, headers={'User-Agent': 'pokesurvivor/1.0'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
    with open(path, encoding='utf-8') as f:
        return list(csv.DictReader(f))


def main():
    langs = {r['identifier']: r['id'] for r in fetch('languages.csv')}
    zh = langs['zh-hant']
    names = {int(r['pokemon_species_id']): r['name'] for r in fetch('pokemon_species_names.csv') if r['local_language_id'] == zh}

    with open(DEX, encoding='utf-8') as f:
        src = f.read()
    dex = [json.loads(m) for m in re.findall(r'^\s*(\{"dex".*\})\s*,?\s*$', src, re.M)]
    out, missing = {}, []
    for p in dex:
        n = names.get(p['dex'])
        if n:
            out[p['name']] = n
        else:
            missing.append(f"{p['dex']} {p['name']}")

    lines = [
        '/* ============ lang-zh-TW-dex.js — GENERADO, no editar a mano ============',
        ' * Nombres oficiales de los Pokémon en chino tradicional (PokeAPI, zh-hant).',
        ' * Lo produce tools/fetch_zh_names.py a partir de js/data/pokedex.js.',
        ' */',
        'G.I18n.add({',
    ]
    items = list(out.items())
    for i in range(0, len(items), 6):
        chunk = items[i:i + 6]
        lines.append('  ' + ', '.join(f'{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)}' for k, v in chunk) + ',')
    lines[-1] = lines[-1].rstrip(',')
    lines.append("}, 'zh-TW');")
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'ok: {len(out)} nombres -> {os.path.relpath(OUT, ROOT)}')
    if missing:
        print('sin nombre zh-hant:', ', '.join(missing))


if __name__ == '__main__':
    main()
