"""Draw PocketCodes's icons (stdlib only): the Pocket device face, its LCD reading "42" (a code), one orange key and two
graphite ones. Writes icons/icon-{16,32,48,96,128}.png. Run: python tools/gen_icons.py"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
SS = 4  # supersamples per axis


def hexc(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


RIM = hexc("#2a2722")
BODY = hexc("#f2eee5")
LCD = hexc("#b1bd93")
INK = hexc("#1f2a17")
KEY = hexc("#ff5b1f")
LIP = hexc("#c2410c")
GRAPHITE = hexc("#3a3631")

# 3x5 pixel letters
D4 = ["#.#", "#.#", "###", "..#", "..#"]
D2 = ["###", "..#", "###", "#..", "###"]


def rr(x0, y0, x1, y1, r):
    """Inside test for a rounded rectangle in unit space."""
    def inside(x, y):
        if x < x0 or x > x1 or y < y0 or y > y1:
            return False
        cx = min(max(x, x0 + r), x1 - r)
        cy = min(max(y, y0 + r), y1 - r)
        return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return inside


def rect(x0, y0, x1, y1):
    return lambda x, y: x0 <= x < x1 and y0 <= y < y1


def layers(n):
    small = n <= 20
    out = [
        (rr(0.02, 0.02, 0.98, 0.98, 0.2), RIM),
        (rr(0.07, 0.07, 0.93, 0.93, 0.16), BODY),
    ]
    lcd = (0.13, 0.13, 0.87, 0.70) if not small else (0.10, 0.10, 0.90, 0.90)
    out.append((rr(*lcd, 0.07), INK))
    inner = (lcd[0] + 0.035, lcd[1] + 0.035, lcd[2] - 0.035, lcd[3] - 0.035)
    out.append((rr(*inner, 0.05), LCD))
    # "42" in 3x5 cells with a one-cell gap: 7 cells wide, 5 tall, centred in the LCD
    w, h = inner[2] - inner[0], inner[3] - inner[1]
    cell = min(w * 0.82 / 7, h * 0.78 / 5)
    ox, oy = inner[0] + (w - 7 * cell) / 2, inner[1] + (h - 5 * cell) / 2
    for li, glyph in enumerate((D4, D2)):
        for gy, row in enumerate(glyph):
            for gx, ch in enumerate(row):
                if ch == "#":
                    x = ox + (gx + li * 4) * cell
                    y = oy + gy * cell
                    out.append((rect(x, y, x + cell, y + cell), INK))
    if not small:
        out += [
            (rr(0.13, 0.76, 0.31, 0.89, 0.05), GRAPHITE),
            (rr(0.36, 0.76, 0.54, 0.89, 0.05), GRAPHITE),
            (rr(0.60, 0.77, 0.87, 0.91, 0.05), LIP),
            (rr(0.60, 0.75, 0.87, 0.88, 0.05), KEY),
        ]
    return out


def render(n):
    ls = layers(n)
    rows = []
    for py in range(n):
        row = bytearray()
        for px in range(n):
            acc = [0.0, 0.0, 0.0]
            cover = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / n
                    y = (py + (sy + 0.5) / SS) / n
                    col = None
                    for test, c in ls:
                        if test(x, y):
                            col = c
                    if col is not None:
                        cover += 1
                        for i in range(3):
                            acc[i] += col[i]
            a = cover / (SS * SS)
            if cover:
                row += bytes(int(round(acc[i] / cover)) for i in range(3)) + bytes([int(round(a * 255))])
            else:
                row += b"\0\0\0\0"
        rows.append(bytes(row))
    return rows


def png(rows):
    n = len(rows)
    raw = b"".join(b"\0" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    os.makedirs(OUT, exist_ok=True)
    for n in (16, 32, 48, 96, 128):
        with open(os.path.join(OUT, f"icon-{n}.png"), "wb") as f:
            f.write(png(render(n)))
        print(f"icons/icon-{n}.png")


if __name__ == "__main__":
    main()
