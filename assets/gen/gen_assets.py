#!/usr/bin/env python3
"""数间 (Shikaku) 的美术资产工厂：一条命令重出整套位图，逐字节可复现。

为什么要自己产：这仓此前一张位图都没有——index.html 里那条 data:image/svg+xml 的 favicon
既装不上桌面也上不了商店截图（sellability 的「图标(favicon+真PNG≥180)」判据实测 0 张大图）。

视觉母题直接取自玩法：一张 5×5 的**矩形分区**，每块围住一个数字、面积等于它，所以图标
本身就是一个能读出来的数间局面，而不是随便一个抽象 logo。分区合法性由 check_partition()
现场断言（互不重叠、无缝铺满、面积==数字），母题被改错时脚本直接拒绝出图。

配色不凭空编：十六进制全部从 js/theme.js 的 Palette 正则抽取（tints / tintLift 同理），
改了主题色再跑一次，图标和画布不会分成两套颜色。

图形全部按目标尺寸**原生绘制**（不做 LANCZOS 缩放），数字走七段码（不绑字体文件）——
这两条是为了在别的机器/别的 Pillow 版本上重跑仍是同一批字节。只有 og 卡的中文标题需要
CJK 字体，找不到候选字体时退化为几何字标（仍出图，不出空白图）。

用法：
    python3 assets/gen/gen_assets.py --manifest   # 生成并刷新 assets/gen/manifest.json
    python3 assets/gen/gen_assets.py --check      # 重渲染到临时目录，逐文件比对 sha256
"""
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
THEME = os.path.join(REPO, 'js', 'theme.js')
SEED = 0x5CB1E2  # 固定种子：资产要逐字节可复现，所以不读时间、不读环境

CJK_CANDIDATES = [
    '/System/Library/Fonts/STHeiti Medium.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
]

ICONS = os.path.join(REPO, 'icons')
IMG = os.path.join(REPO, 'assets', 'img')


# ------------------------------------------------------------------ 取色
def palette_from_source():
    src = open(THEME, encoding='utf-8').read()
    block = src[src.index('export const Palette'):]
    hexes = dict(re.findall(r'(\w+):\s*[\'"]#([0-9A-Fa-f]{6})[\'"]', block))
    tints_block = block[block.index('tints:'):]
    tints = re.findall(r'#([0-9A-Fa-f]{6})', tints_block[:tints_block.index(']')])
    lift = float(re.search(r'tintLift:\s*([0-9.]+)', block).group(1))
    rgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    pal = {k: rgb(v) for k, v in hexes.items()}
    pal['tints'] = [rgb(t) for t in tints]
    pal['tintLift'] = lift
    return pal


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rgba(c, a):
    return (c[0], c[1], c[2], int(round(a * 255 if a <= 1 else a)))


# ------------------------------------------------------------------ 母题：一张合法分区
# (r0, c0, r1, c1, clueR, clueC, value) —— 8 块矩形铺满 5×5，每块一个数字且面积等于它。
PARTITION = [
    (0, 0, 1, 1, 0, 0, 4),
    (0, 2, 1, 3, 0, 3, 4),
    (0, 4, 0, 4, 0, 4, 1),
    (1, 4, 1, 4, 1, 4, 1),
    (2, 0, 4, 1, 2, 1, 6),
    (2, 2, 4, 3, 2, 3, 6),
    (2, 4, 2, 4, 2, 4, 1),
    (3, 4, 4, 4, 3, 4, 2),
]
GRID = 5


def check_partition():
    seen = set()
    for r0, c0, r1, c1, cr, cc, v in PARTITION:
        assert r0 <= r1 and c0 <= c1
        assert (r1 - r0 + 1) * (c1 - c0 + 1) == v, ('面积不等于数字', r0, c0, v)
        assert r0 <= cr <= r1 and c0 <= cc <= c1, ('数字不在自己块里', cr, cc)
        for r in range(r0, r1 + 1):
            for c in range(c0, c1 + 1):
                assert (r, c) not in seen, ('两块重叠', r, c)
                seen.add((r, c))
    assert len(seen) == GRID * GRID, ('没铺满', len(seen))


# ------------------------------------------------------------------ 七段码数字
SEG = {
    'a': (1, 0, 4, 1), 'b': (5, 1, 1, 4), 'c': (5, 5, 1, 4), 'd': (1, 9, 4, 1),
    'e': (0, 5, 1, 4), 'f': (0, 1, 1, 4), 'g': (1, 5, 4, 1),
}
DIGIT = {0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc',
         5: 'afgcd', 6: 'afgedc', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg'}


def draw_digit(dr, cx, cy, em, n, fill):
    w, h = em * 0.6, em
    ox, oy = cx - w / 2, cy - h / 2
    for s in DIGIT[n]:
        x, y, sw, sh = SEG[s]
        box = [ox + x * w / 6, oy + y * h / 10, ox + (x + sw) * w / 6, oy + (y + sh) * h / 10]
        dr.rounded_rectangle(box, radius=max(0.4, em * 0.035), fill=fill)


# ------------------------------------------------------------------ 底与纹理
def gradient(pal, w, h, c0=None, c1=None, gamma=1.15):
    img = Image.new('RGBA', (w, h))
    dr = ImageDraw.Draw(img)
    a = c0 or pal['bgTop']
    b = c1 or pal['bgBottom']
    for y in range(h):
        t = (y / max(1, h - 1)) ** gamma
        dr.line([(0, y), (w, y)], fill=mix(a, b, t) + (255,))
    return img


def glow_mask(size, strength=0.22):
    """左上暖光的 alpha 蒙版：给深色列表里的图标一个朝向。"""
    layer = Image.new('L', (size, size), 0)
    dr = ImageDraw.Draw(layer)
    dr.ellipse([-size * 0.45, -size * 0.5, size * 0.75, size * 0.7], fill=int(255 * strength))
    return layer.filter(ImageFilter.GaussianBlur(size * 0.16))


def value_noise(size, period, amp, seed, base=128):
    """整数周期格 + 平滑插值的 value noise：按构造无缝，所以能当平铺纹理。"""
    state = seed
    lat = []
    for _ in range(period):
        row = []
        for _ in range(period):
            state = (state * 1103515245 + 12345) & 0x7FFFFFFF
            row.append(state / 0x7FFFFFFF)
        lat.append(row)
    img = Image.new('L', (size, size))
    px = img.load()
    scale = size / period
    smooth = lambda t: t * t * (3 - 2 * t)
    for y in range(size):
        fy = y / scale
        iy, jy = int(fy) % period, (int(fy) + 1) % period
        ty = smooth(fy - int(fy))
        for x in range(size):
            fx = x / scale
            ix, jx = int(fx) % period, (int(fx) + 1) % period
            tx = smooth(fx - int(fx))
            a = lat[iy][ix] + (lat[iy][jx] - lat[iy][ix]) * tx
            b = lat[jy][ix] + (lat[jy][jx] - lat[jy][ix]) * tx
            px[x, y] = max(0, min(255, int(base + (a + (b - a) * ty - 0.5) * amp)))
    return img


# ------------------------------------------------------------------ 主图标
def icon(pal, size, maskable=False, opaque=False):
    check_partition()
    detail = size >= 96  # 32px 上画不下一列数字，退化为纯色块 quilt
    bg = gradient(pal, size, size)
    bg = Image.composite(Image.new('RGBA', (size, size), rgba(mix(pal['accent'], pal['ink'], 0.55), 0.13)), bg,
                         glow_mask(size, 0.09 if maskable else 0.14))

    inset = size * (0.20 if maskable else 0.12)  # maskable 要给圆形蒙版留安全边
    inner = size - inset * 2
    cell = inner / GRID
    dr = ImageDraw.Draw(bg)

    rects = []
    for i, (r0, c0, r1, c1, cr, cc, v) in enumerate(PARTITION):
        x0, y0 = inset + c0 * cell, inset + r0 * cell
        x1, y1 = inset + (c1 + 1) * cell, inset + (r1 + 1) * cell
        tint = mix(pal['tints'][i % len(pal['tints'])], pal['ink'], pal['tintLift'])
        dr.rectangle([x0, y0, x1, y1], fill=tint + (255,))
        rects.append((x0, y0, x1, y1, cr, cc, v))

    if detail:
        grid_c = rgba(mix(pal['ink'], pal['bgBottom'], 0.62), 0.16)
        lw = max(1, int(cell * 0.02))
        for k in range(1, GRID):
            dr.line([inset + k * cell, inset, inset + k * cell, inset + inner], fill=grid_c, width=lw)
            dr.line([inset, inset + k * cell, inset + inner, inset + k * cell], fill=grid_c, width=lw)

    bw = max(1, int(cell * 0.085))
    border = rgba(pal['ink'], 0.88)
    for (x0, y0, x1, y1, cr, cc, v) in rects:
        dr.rectangle([x0, y0, x1, y1], outline=border, width=bw)
    pad = max(1, int(cell * 0.05))
    dr.rounded_rectangle([inset - pad, inset - pad, inset + inner + pad, inset + inner + pad],
                         radius=cell * 0.16, outline=rgba(pal['ink'], 0.72), width=max(1, int(cell * 0.045)))

    if detail:
        for (x0, y0, x1, y1, cr, cc, v) in rects:
            cx, cy = inset + (cc + 0.5) * cell, inset + (cr + 0.5) * cell
            rad = cell * 0.33
            dr.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=(8, 11, 22, 184),
                       outline=rgba(pal['ink'], 0.38), width=max(1, int(cell * 0.02)))
            draw_digit(dr, cx, cy, cell * 0.42, v, rgba(pal['ink'], 0.98))

    if opaque:  # apple-touch-icon：iOS 不认透明，垫平底色后仍裁圆角，视觉才和主图标同族
        base = Image.new('RGBA', (size, size), pal['bgTop'] + (255,))
        base.paste(bg, (0, 0), bg)
        bg = base
    if not maskable:
        mask = Image.new('L', (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, size, size], radius=int(size * 0.223), fill=255)
        bg.putalpha(mask)
    return bg


def paper_tile(pal, size=256):
    """棋盘纸纹：无缝平铺。颗粒和图标同源（同一支 value noise），所以画布不会像另一个产品的界面。"""
    fine = value_noise(size, 32, 44, SEED ^ 0x1F).filter(ImageFilter.GaussianBlur(0.6))
    wide = value_noise(size, 6, 30, SEED ^ 0x9C)
    img = Image.new('RGBA', (size, size))
    ip, fp, wp = img.load(), fine.load(), wide.load()
    for y in range(size):
        for x in range(size):
            v = (fp[x, y] - 128) + (wp[x, y] - 128) * 0.8
            c = mix(pal['surface'], pal['ink'] if v > 0 else pal['bgBottom'], min(0.14, abs(v) / 255 * 0.5))
            ip[x, y] = c + (255,)
    dr = ImageDraw.Draw(img)
    dot = rgba(mix(pal['ink'], pal['bgBottom'], 0.5), 0.10)
    step = size // 8
    for gx in range(0, size + 1, step):
        for gy in range(0, size + 1, step):
            dr.rectangle([gx - 1, gy - 1, gx + 1, gy + 1], fill=dot)
    return img


def spark_sheet(pal, cell=64, count=4):
    """粒子贴图：4 帧一排（围块/提示/胜利/矛盾），每帧一枚径向光点叠一笔十字切线。"""
    tints = [pal['accent'], pal['info'], pal['success'], pal['error']]
    img = Image.new('RGBA', (cell * count, cell), (0, 0, 0, 0))
    for i in range(count):
        col = tints[i % len(tints)]
        frame = Image.new('L', (cell, cell), 0)
        fd = ImageDraw.Draw(frame)
        rad = cell * (0.40 - i * 0.04)
        c = cell / 2
        fd.ellipse([c - rad, c - rad, c + rad, c + rad], fill=255)
        frame = frame.filter(ImageFilter.GaussianBlur(cell * 0.10))
        layer = Image.new('RGBA', (cell, cell), (0, 0, 0, 0))
        layer.putalpha(frame)
        ld = ImageDraw.Draw(layer)
        ld.line([0, c, cell, c], fill=rgba(col, 0.28), width=1)
        ld.line([c, 0, c, cell], fill=rgba(col, 0.28), width=1)
        layer = Image.composite(Image.new('RGBA', (cell, cell), rgba(col, 0.95)), layer, frame)
        img.paste(layer, (i * cell, 0), layer)
    return img


def pick_cjk(size):
    for cand in CJK_CANDIDATES:
        try:
            return ImageFont.truetype(cand, size)
        except Exception:
            continue
    return None


def og_card(pal, w=1200, h=630):
    img = gradient(pal, w, h, gamma=0.9)
    side = glow_mask(min(w, h), 0.22).resize((w, h))
    img = Image.composite(Image.new('RGBA', (w, h), rgba(mix(pal['accent'], pal['ink'], 0.55), 0.10)), img, side)
    dr = ImageDraw.Draw(img)
    art = icon(pal, 470)
    img.paste(art, (56, (h - 470) // 2), art)
    dr = ImageDraw.Draw(img)

    title = pick_cjk(104)
    x, y = 572, 132
    if title:
        dr.text((x, y), '数间', font=title, fill=pal['ink'] + (255,))
        sub = pick_cjk(38)
        body = pick_cjk(25)
        dr.text((x, y + 132), 'SHIKAKU · 矩形分区推理', font=sub, fill=mix(pal['ink'], pal['bgBottom'], 0.30) + (255,))
        for line in ('把整块盘切成矩形，每块围住一个数字、面积等于它。',
                     '每局唯一解，每局都能用逻辑围到底。',
                     '提示只说推得出的那一步。'):
            dr.text((x, y + 208), line, font=body, fill=mix(pal['ink'], pal['bgBottom'], 0.50) + (255,))
            y += 40
    else:  # 没有 CJK 字体：几何字标顶上，仍然是一张能用的卡
        dr.rectangle([x, y, x + 210, y + 210], outline=pal['ink'] + (255,), width=8)
        dr.rectangle([x + 210, y, x + 350, y + 120], outline=pal['accent'] + (255,), width=8)
        draw_digit(dr, x + 105, y + 105, 120, 4, rgba(pal['ink'], 0.95))
        draw_digit(dr, x + 280, y + 60, 70, 2, rgba(pal['accent'], 0.95))
    line_c = rgba(mix(pal['ink'], pal['bgBottom'], 0.72), 0.35)
    dr.rounded_rectangle([24, 24, w - 24, h - 24], radius=26, outline=line_c, width=3)
    return img


def build(out_root=None):
    pal = palette_from_source()
    icons = os.path.join(out_root, 'icons') if out_root else ICONS
    imgdir = os.path.join(out_root, 'assets', 'img') if out_root else IMG
    os.makedirs(icons, exist_ok=True)
    os.makedirs(imgdir, exist_ok=True)

    jobs = {
        os.path.join(icons, 'icon-1024.png'): lambda: icon(pal, 1024),
        os.path.join(icons, 'icon-512.png'): lambda: icon(pal, 512),
        os.path.join(icons, 'icon-192.png'): lambda: icon(pal, 192),
        os.path.join(icons, 'favicon-192.png'): lambda: icon(pal, 192),
        os.path.join(icons, 'favicon-48.png'): lambda: icon(pal, 48),
        os.path.join(icons, 'favicon-32.png'): lambda: icon(pal, 32),
        os.path.join(icons, 'icon-maskable-512.png'): lambda: icon(pal, 512, maskable=True),
        os.path.join(icons, 'apple-touch-icon.png'): lambda: icon(pal, 180, opaque=True),
        os.path.join(icons, 'og.png'): lambda: og_card(pal),
        os.path.join(imgdir, 'paper-256.png'): lambda: paper_tile(pal),
        os.path.join(imgdir, 'spark-64.png'): lambda: spark_sheet(pal),
    }
    rec = {}
    for path, make in jobs.items():
        make().save(path, 'PNG', optimize=True)
        raw = open(path, 'rb').read()
        rec[os.path.relpath(path, out_root or REPO)] = {
            'bytes': len(raw),
            'w': int.from_bytes(raw[16:20], 'big'),
            'h': int.from_bytes(raw[20:24], 'big'),
            'sha256': hashlib.sha256(raw).hexdigest(),
        }
    doc = {
        'generator': 'assets/gen/gen_assets.py',
        'seed': hex(SEED),
        'motif': 'shikaku 5x5 partition, 8 regions, area == clue',
        'palette_source': 'js/theme.js Palette (regex-extracted)',
        'cjk_font_for_og': pick_cjk(10).path if pick_cjk(10) else None,
        'files': dict(sorted(rec.items())),
    }
    return doc


def main():
    argv = sys.argv[1:]
    if '--check' in argv:
        tmp = tempfile.mkdtemp(prefix='shikaku-assets-')
        try:
            got = build(out_root=tmp)
            want = json.load(open(os.path.join(HERE, 'manifest.json'), encoding='utf-8'))
            bad = [k for k in want['files']
                   if want['files'][k]['sha256'] != got['files'].get(k, {}).get('sha256')]
            print('CHECK %d files, %d mismatch' % (len(got['files']), len(bad)))
            for k in bad:
                print('  MISMATCH', k)
            return 0 if not bad else 1
        finally:
            shutil.rmtree(tmp)
    doc = build()
    if '--manifest' in argv:
        open(os.path.join(HERE, 'manifest.json'), 'w', encoding='utf-8').write(
            json.dumps(doc, ensure_ascii=False, indent=1) + '\n')
    for k, v in doc['files'].items():
        print('%-34s %5dx%-5d %8d B  %s' % (k, v['w'], v['h'], v['bytes'], v['sha256'][:12]))
    return 0


if __name__ == '__main__':
    sys.exit(main())
