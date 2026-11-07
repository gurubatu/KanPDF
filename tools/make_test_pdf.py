# -*- coding: utf-8 -*-
"""生成 8 页测试 PDF，每页居中一个大页码，用于双页模式验收。"""
import zlib

PAGES = 8
W, H = 595, 842  # A4 pt

objs = {}  # num -> bytes

kids = " ".join(f"{3 + i * 2} 0 R" for i in range(PAGES))
objs[1] = f"<< /Type /Catalog /Pages 2 0 R >>".encode()
objs[2] = f"<< /Type /Pages /Kids [{kids}] /Count {PAGES} >>".encode()

font_num = 3 + PAGES * 2
for i in range(PAGES):
    pnum = 3 + i * 2
    cnum = pnum + 1
    content = (
        f"BT /F1 200 Tf 1 0 0 1 {W/2-110} {H/2-70} Tm ({i+1}) Tj ET\n"
        f"BT /F1 24 Tf 1 0 0 1 40 {H-60} Tm (Page {i+1} of {PAGES}) Tj ET\n"
        "q 4 w 0.55 0.44 0.27 RG 20 20 555 802 re S Q\n"
    ).encode()
    comp = zlib.compress(content)
    objs[pnum] = (
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] "
        f"/Resources << /Font << /F1 {font_num} 0 R >> >> "
        f"/Contents {cnum} 0 R >>"
    ).encode()
    objs[cnum] = (
        f"<< /Length {len(comp)} /Filter /FlateDecode >>\nstream\n".encode()
        + comp + b"\nendstream"
    )

objs[font_num] = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"

out = bytearray(b"%PDF-1.4\n")
offsets = {}
for n in sorted(objs):
    offsets[n] = len(out)
    out += f"{n} 0 obj\n".encode() + objs[n] + b"\nendobj\n"

xref_pos = len(out)
count = max(objs) + 1
out += f"xref\n0 {count}\n".encode()
out += b"0000000000 65535 f \n"
for n in range(1, count):
    out += f"{offsets[n]:010d} 00000 n \n".encode()
out += (
    f"trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n"
).encode()

with open(r"D:\DEV2026\KanPDF\tools\test8.pdf", "wb") as f:
    f.write(bytes(out))
print("ok", len(out), "bytes")
