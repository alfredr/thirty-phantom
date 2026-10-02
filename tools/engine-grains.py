"""
Engine grain tables: cut a CC0 engine recording into tagged engine cycles for src/audio/grains.ts.

  python3 tools/engine-grains.py <name> <recording> <ref_from>-<ref_to>:<ref_hz> <from>-<to> [<from>-<to> ...]

The pitch is tracked relative to a reference stretch (ref, whose firing rate in Hz is given):
each frame's whitened log-frequency spectrum is matched against a slowly adapting template in
pitch-normalized form, so the track is continuous and never jumps an octave, and every tag is in
the same units as the reference. Pitch marks follow the waveform a cycle at a time (each where
the next cycle best matches the last, near where the track says); then, in order of rate, each is
lined up with the others of about the same rate (circular cross-correlation against a running
template), so grains cut anywhere add up in step. Each mark is tagged with its rate (from its spacing), whether the engine was
pulling (rising, 1), steady (0.5) or falling (0), and its level. Only the stretches given are
kept: they're levelled, joined with short gaps and written to public/audio/<name>.mp3, the marks
(in that file's time) to public/audio/<name>.json.

Needs numpy and ffmpeg. The recordings are Freesound previews; credit them in public/audio/CREDITS.md.
"""

import json
import subprocess
import sys

import numpy as np

SR = 22050
HOP = 256
WIN = 2048
# 25 Hz up, 1/96 octave; ENGINE_TOP (Hz) narrows it to the low firing harmonics when wind or road noise swamps the rest
GRID = 25 * 2 ** (np.arange(0, int(np.log2(float(__import__('os').environ.get('ENGINE_TOP', 3200)) / 25) * 96)) / 96)
OUT = 'public/audio'


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def spectra(x):
    """Whitened log-frequency spectra, one a hop."""
    w = np.hanning(WIN)
    fr = np.fft.rfftfreq(WIN, 1 / SR)
    rows = []
    for i in range(0, len(x) - WIN, HOP):
        m = np.log(np.interp(GRID, fr, np.abs(np.fft.rfft(x[i:i + WIN] * w))) + 1e-9)
        m = m - np.convolve(m, np.ones(33) / 33, 'same')
        rows.append(np.maximum(m, 0))
    return np.array(rows)


def track(S, ref):
    """Pitch in octaves relative to the reference frames, and how sure each frame is."""
    n = len(S)
    tpl = S[ref[0]:ref[1]].mean(axis=0)
    shifts = np.zeros(n)
    conf = np.zeros(n)

    def best(k, around, reach):
        sc = []
        for s in range(around - reach, around + reach + 1):
            sh = np.roll(S[k], -s)
            if s > 0:
                sh[-s:] = 0
            elif s < 0:
                sh[:-s] = 0
            sc.append(np.dot(tpl, sh))
        sc = np.array(sc)
        j = int(np.argmax(sc))
        return around - reach + j, sc[j] / (np.linalg.norm(tpl) * np.linalg.norm(S[k]) + 1e-9)

    def run(order):
        nonlocal tpl
        prev = 0
        for k in order:
            s, c = best(k, prev, 12)
            shifts[k], conf[k] = s, c
            prev = s
            sh = np.roll(S[k], -s)
            tpl = 0.97 * tpl + 0.03 * sh

    mid = (ref[0] + ref[1]) // 2
    run(range(mid, n))
    tpl = S[ref[0]:ref[1]].mean(axis=0)
    run(range(mid, -1, -1))
    # the track is smooth: a short median takes out single-frame slips
    sm = np.array([np.median(shifts[max(0, k - 3):k + 4]) for k in range(n)])
    return sm / 96, conf


def marks(x, hz_at, t0, t1):
    """
    Pitch marks between t0 and t1, one engine cycle apart: each next mark is where the waveform
    best matches the cycle round the last one, searched within a fifth of a period either side of
    where the track puts it. So the marks keep one phase of the cycle all along, and their spacing
    is the waveform's own period. Each comes with how well it matched.
    """
    out = []
    per = 1 / hz_at(t0)
    i = int(t0 * SR)
    n = int(per * SR)
    i += int(np.argmax(np.abs(x[i:i + n])))
    while i / SR < t1:
        per = 1 / hz_at(i / SR)
        n = int(per * SR)
        w = n // 2
        a = x[i - w:i + w]
        if i - w < 0 or i + n + n // 5 + w >= len(x):
            break
        best, bi = -2.0, i + n
        for j in range(i + n - n // 5, i + n + n // 5 + 1):
            bseg = x[j - w:j + w]
            c = np.dot(a, bseg) / (np.linalg.norm(a) * np.linalg.norm(bseg) + 1e-12)
            if c > best:
                best, bi = c, j
        out.append((i / SR, best))
        i = bi
    return out


L = 64


def cycle(x, t, hz):
    """One cycle of x round t (from half a period before), resampled to L points, zero mean, unit length."""
    per = SR / hz
    pos = t * SR - per / 2 + np.arange(L) * per / L
    if pos[0] < 0 or pos[-1] >= len(x) - 1:
        return None
    c = np.interp(pos, np.arange(len(x)), x)
    c = c - c.mean()
    return c / (np.linalg.norm(c) + 1e-12)


def shift(c, tpl):
    """How far (a share of a cycle) c's shape sits after tpl's, by circular cross-correlation, and how well they match."""
    cc = np.fft.ifft(np.fft.fft(c) * np.conj(np.fft.fft(tpl))).real
    s = int(np.argmax(cc))
    return (s - L if s > L // 2 else s) / L, float(cc.max())


def consensus(y, table):
    """
    Line up every cycle with the others of about the same rate, from wherever they were cut: walk
    the marks in order of rate, moving each onto a template that's the running average of the last
    ones aligned (a cycle's shape changes with the revs, so the template follows it). Grains only
    ever overlap with others of about the same rate, so that's all that has to agree. Marks whose
    cycle fits the template poorly are dropped.
    """
    order = sorted(range(len(table)), key=lambda i: table[i][1])
    tpl = None
    keep = []
    for i in order:
        t, hz = table[i][0], table[i][1]
        c = cycle(y, t, hz)
        if c is None:
            continue
        if tpl is None:
            tpl = c
            keep.append(i)
            continue
        d, fit = shift(c, tpl)
        if fit < 0.3:
            continue
        table[i][0] = round(t + d / hz, 4)
        tpl = 0.85 * tpl + 0.15 * np.roll(c, -int(round(d * L)))
        tpl = tpl / (np.linalg.norm(tpl) + 1e-12)
        keep.append(i)
    return [table[i] for i in sorted(keep)]


def main():
    if sys.argv[1] == '--track':
        # look before cutting: the pitch track every quarter second, and how sure it is
        path, refspec = sys.argv[2:4]
        x = load(path)
        S = spectra(x)
        (rf, rt), rhz = tuple(map(float, refspec.split(':')[0].split('-'))), float(refspec.split(':')[1])
        octs, conf = track(S, (int(rf * SR / HOP), int(rt * SR / HOP)))
        step = int(0.25 * SR / HOP)
        print(' '.join(f'{k * HOP / SR:5.2f}:{rhz * 2 ** octs[k]:5.1f}{"*" if conf[k] > 0.5 else ("." if conf[k] > 0.35 else " ")}' for k in range(0, len(S), step)))
        return
    name, path, refspec, *spans = sys.argv[1:]
    x = load(path)
    S = spectra(x)
    ft = (np.arange(len(S)) * HOP + WIN / 2) / SR
    (rf, rt), rhz = [tuple(map(float, refspec.split(':')[0].split('-'))), float(refspec.split(':')[1])]
    ref = (int(rf * SR / HOP), int(rt * SR / HOP))
    octs, conf = track(S, ref)
    hz = rhz * 2 ** octs
    hz_at = lambda t: float(np.interp(t, ft, hz))
    conf_at = lambda t: float(np.interp(t, ft, conf))
    # pulling, steady or falling, from how fast the pitch moves (octaves a second, over ~0.1 s)
    rate = np.gradient(np.convolve(octs, np.ones(9) / 9, 'same'), HOP / SR)
    load_at = lambda t: float(np.interp(t, ft, np.where(rate > 0.15, 1.0, np.where(rate < -0.15, 0.0, 0.5))))
    parts, table, at = [], [], 0.0
    for span in spans:
        t0, t1 = map(float, span.split('-'))
        seg = x[int(t0 * SR):int(t1 * SR)]
        gain = 10 ** (-16 / 20) / (np.sqrt(np.mean(seg ** 2)) + 1e-9)
        ms = marks(x, hz_at, t0, t1)
        # its rate: the spacing of the cycles round it as followed (so tags and grains' cycles agree)
        ts = np.array([m[0] for m in ms])
        for k, (tk, match) in enumerate(ms):
            gaps = np.diff(ts[max(0, k - 2):k + 3])
            if len(gaps) == 0 or match < 0.5 or conf_at(tk) < 0.35:
                continue
            i = int(tk * SR)
            rms = float(np.sqrt(np.mean(x[max(0, i - 400):i + 400] ** 2)) * gain)
            table.append([round(at + tk - t0, 4), round(1 / float(np.median(gaps)), 2), load_at(tk), round(rms, 4)])
        parts += [np.clip(seg * gain, -0.98, 0.98), np.zeros(int(0.1 * SR))]
        at += (t1 - t0) + 0.1
    y = np.concatenate(parts).astype(np.float32)
    table = consensus(y.astype(np.float64), table)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(SR), '-ac', '1', '-i', '-', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '64k', f'{OUT}/{name}.mp3'], input=y.tobytes(), check=True)
    with open(f'{OUT}/{name}.json', 'w') as f:
        json.dump({'source': path.split('/')[-1], 'marks': table}, f, separators=(',', ':'))
    hzs = np.array([m[1] for m in table])
    print(f'{name}: {len(table)} marks, {hzs.min():.1f} to {hzs.max():.1f} Hz (median {np.median(hzs):.1f}); '
          f'pulling {sum(m[2] == 1 for m in table)}, falling {sum(m[2] == 0 for m in table)}; {len(y) / SR:.1f} s kept')


if __name__ == '__main__':
    main()
