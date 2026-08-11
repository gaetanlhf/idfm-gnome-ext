#!/usr/bin/env python3
import sys, os, struct, ast


def parse_po(path):
    entries = {}
    msgid = msgstr = None
    target = None
    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('msgid '):
                if msgid is not None:
                    entries[msgid] = msgstr or ''
                msgid = ast.literal_eval(line[len('msgid '):])
                msgstr = None
                target = 'id'
            elif line.startswith('msgstr '):
                msgstr = ast.literal_eval(line[len('msgstr '):])
                target = 'str'
            elif line.startswith('"'):
                piece = ast.literal_eval(line)
                if target == 'id':
                    msgid += piece
                elif target == 'str':
                    msgstr += piece
    if msgid is not None:
        entries[msgid] = msgstr or ''
    return entries


def write_mo(entries, path):
    keys = sorted(entries.keys())
    ids = b''
    strs = b''
    id_table = []
    str_table = []
    for k in keys:
        kb = k.encode('utf-8')
        vb = entries[k].encode('utf-8')
        id_table.append((len(kb), len(ids)))
        ids += kb + b'\x00'
        str_table.append((len(vb), len(strs)))
        strs += vb + b'\x00'
    n = len(keys)
    keystart = 28 + n * 16
    valuestart = keystart + len(ids)
    out = struct.pack('<Iiiiiii', 0x950412de, 0, n, 28, 28 + n * 8, 0, 0)
    for length, offset in id_table:
        out += struct.pack('<ii', length, keystart + offset)
    for length, offset in str_table:
        out += struct.pack('<ii', length, valuestart + offset)
    out += ids + strs
    with open(path, 'wb') as f:
        f.write(out)


if __name__ == '__main__':
    src_dir = os.path.dirname(os.path.abspath(__file__))
    domain = 'idfm-gnome-ext'
    root = os.path.dirname(src_dir)
    for name in os.listdir(src_dir):
        if not name.endswith('.po'):
            continue
        lang = name[:-3]
        dest_dir = os.path.join(root, 'locale', lang, 'LC_MESSAGES')
        os.makedirs(dest_dir, exist_ok=True)
        write_mo(parse_po(os.path.join(src_dir, name)),
                 os.path.join(dest_dir, domain + '.mo'))
        print('compiled', lang)
