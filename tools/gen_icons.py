#!/usr/bin/env python3
"""Draws AuthSkip's toolbar icons with the standard library only: icons/icon-{16,32,48,96,128}.png.

An ink rounded square with three digit slots, the last one holding an accent caret (a code being filled).
Each size is drawn at 8x and averaged down, so edges are smooth without any imaging library.

    python tools/gen_icons.py
"""

import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZES = (16, 32, 48, 96, 128)
SS = 8
INK = (0x1f, 0x24, 0x30)
SLOT = (0xf4, 0xf6, 0xfa)
ACCENT = (0x2a, 0x4f, 0xa8)


def rounded(x, y, x0, y0, x1, y1, r):
    """Is (x, y) inside the rectangle [x0, x1) x [y0, y1) with corner radius r?"""
    if x < x0 or x >= x1 or y < y0 or y >= y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def shapes(size):
    """[(color, x0, y0, x1, y1, radius)] in units of the icon's width, painted in order. Small sizes get
    slightly chunkier slots so they survive at 16 px."""
    small = size <= 32
    pad = 0.03 if small else 0.06
    sw, gap = (0.22, 0.06) if small else (0.2, 0.06)
    sh = 0.42 if small else 0.36
    left = (1 - (3 * sw + 2 * gap)) / 2
    top = (1 - sh) / 2
    out = [(INK, pad, pad, 1 - pad, 1 - pad, 0.2)]
    for i in range(3):
        x = left + i * (sw + gap)
        out.append((SLOT, x, top, x + sw, top + sh, 0.05))
    x = left + 2 * (sw + gap)
    cw = 0.07 if small else 0.045
    out.append((ACCENT, x + (sw - cw) / 2, top + sh * 0.2, x + (sw + cw) / 2, top + sh * 0.8, 0.0))
    return out


def render(size):
    n = size * SS
    parts = [(c, x0 * n, y0 * n, x1 * n, y1 * n, r * n) for c, x0, y0, x1, y1, r in shapes(size)]
    acc = [[0, 0, 0, 0] for _ in range(size * size)]
    for sy in range(n):
        y = sy + 0.5
        for sx in range(n):
            x = sx + 0.5
            color = None
            for c, x0, y0, x1, y1, r in parts:
                if rounded(x, y, x0, y0, x1, y1, r):
                    color = c
            if color is None:
                continue
            a = acc[(sy // SS) * size + sx // SS]
            a[0] += color[0]
            a[1] += color[1]
            a[2] += color[2]
            a[3] += 1
    rows = []
    full = SS * SS
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            r, g, b, k = acc[py * size + px]
            row += bytes((r // k, g // k, b // k, 255 * k // full)) if k else bytes(4)
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    head = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", head) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    out = os.path.join(ROOT, "icons")
    os.makedirs(out, exist_ok=True)
    for s in SIZES:
        path = os.path.join(out, "icon-%d.png" % s)
        with open(path, "wb") as f:
            f.write(render(s))
        print(os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
