#!/usr/bin/env python3
"""Render the Charge Watch app icons.

The icons are GENERATED, not drawn by hand, so they can be re-rendered at any
size whenever a surface is added or the palette moves — the house rule is that
an icon's master stays in the repo rather than living in someone's downloads.
This script IS the master.

Pure standard library (zlib + struct): the deploy environment has no image
libraries and no network, so nothing here may import one.

    python3 tools/make-icons.py          # writes public/icons/*

Three identities, one shape language — a bolt in a rounded square:
    icon-*   customer app   cyan plate, dark bolt
    tent-*   tent console   dark plate, cyan bolt (it lives on a handler's
                            phone beside the customer app, so it must not be
                            mistaken for it at a glance on a home screen)
    admin-*  admin console  amber plate, dark bolt (amber is the admin accent
                            throughout the app)
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"

CYAN = (0x35, 0xC9, 0xE8)
DEEP = (0x06, 0x22, 0x2B)
SLATE = (0x0E, 0x12, 0x16)
AMBER = (0xE8, 0xB4, 0x5C)
DARK_AMBER = (0x24, 0x1A, 0x06)

# A lightning bolt in a 0..1 box. Deliberately angular and upright: a dignified
# mark, not a cartoon spark.
BOLT = [
    (0.575, 0.055), (0.250, 0.560), (0.445, 0.560),
    (0.400, 0.945), (0.735, 0.430), (0.535, 0.430),
]

SS = 4  # supersampling factor for anti-aliasing


def point_in_polygon(x, y, poly):
    inside = False
    n = len(poly)
    for i in range(n):
        x0, y0 = poly[i]
        x1, y1 = poly[(i + 1) % n]
        if (y0 > y) != (y1 > y):
            xin = (x1 - x0) * (y - y0) / (y1 - y0) + x0
            if x < xin:
                inside = not inside
    return inside


def in_rounded_rect(x, y, size, radius, inset=0.0):
    """Distance test for a rounded square covering the icon, minus `inset`."""
    lo, hi = inset, size - inset
    if x < lo or y < lo or x > hi or y > hi:
        return False
    r = radius
    # Corner circles; the straight edges are everything else inside the box.
    for cx, cy in ((lo + r, lo + r), (hi - r, lo + r), (lo + r, hi - r), (hi - r, hi - r)):
        if (x < lo + r or x > hi - r) and (y < lo + r or y > hi - r):
            if (x - cx) ** 2 + (y - cy) ** 2 > r * r:
                # Only reject against the corner this point actually belongs to.
                near_x = lo + r if x < lo + r else hi - r
                near_y = lo + r if y < lo + r else hi - r
                if abs(cx - near_x) < 1e-9 and abs(cy - near_y) < 1e-9:
                    return False
    return True


def render(size, plate, bolt, maskable=False):
    """Return RGBA bytes for one icon."""
    # A maskable icon is full-bleed (the launcher crops it) with the mark pulled
    # into the middle 80% safe zone; a normal icon is a rounded plate.
    radius = 0 if maskable else size * 0.22
    scale = 0.62 if maskable else 0.80
    offset = (1 - scale) / 2

    poly = [((px * scale + offset) * size, (py * scale + offset) * size) for px, py in BOLT]

    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            plate_hits = 0
            bolt_hits = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if maskable or in_rounded_rect(x, y, size, radius):
                        plate_hits += 1
                        if point_in_polygon(x, y, poly):
                            bolt_hits += 1
            total = SS * SS
            if plate_hits == 0:
                row += bytes((0, 0, 0, 0))
                continue
            # Composite the bolt over the plate, then the plate over transparency.
            bolt_a = bolt_hits / total
            plate_a = plate_hits / total
            colour = tuple(
                round(bolt[i] * bolt_a + plate[i] * (plate_a - bolt_a)) if plate_a else 0
                for i in range(3)
            )
            # Un-premultiply against the plate's own coverage so the rounded edge
            # anti-aliases against whatever is behind the icon, not against black.
            colour = tuple(min(255, round(c / plate_a)) for c in colour)
            row += bytes((colour[0], colour[1], colour[2], round(plate_a * 255)))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    print(f"  {path.name}  {size}x{size}  {len(png):,} bytes")


def svg(plate, bolt, name):
    pts = " ".join(f"{x * 80 + 10:.1f},{y * 80 + 10:.1f}" for x, y in BOLT)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" '
        f'aria-label="{name}">'
        f'<rect width="100" height="100" rx="22" fill="rgb{plate}"/>'
        f'<polygon points="{pts}" fill="rgb{bolt}"/></svg>'
    )


VARIANTS = {
    "icon":  (CYAN, DEEP, "Charge Watch"),
    "tent":  (SLATE, CYAN, "Charge Watch Tent"),
    "admin": (AMBER, DARK_AMBER, "Charge Watch Admin"),
}

if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for prefix, (plate, bolt, label) in VARIANTS.items():
        print(f"{label}:")
        for size in (192, 512):
            write_png(OUT / f"{prefix}-{size}.png", render(size, plate, bolt), size)
        write_png(OUT / f"{prefix}-maskable-512.png", render(512, plate, bolt, maskable=True), 512)
        (OUT / f"{prefix}.svg").write_text(svg(plate, bolt, label))
        print(f"  {prefix}.svg")
    # iOS uses this one for the Home Screen; it has no transparency and no mask,
    # so it renders the customer plate at the size Apple asks for.
    write_png(OUT / "apple-touch-icon.png", render(180, CYAN, DEEP), 180)
