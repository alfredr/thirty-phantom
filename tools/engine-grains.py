"""
Extract tagged engine cycles for src/audio/grains.ts from a CC0 recording.

Usage:
  python3 tools/engine-grains.py <name> <recording> <ref_from>-<ref_to>:<ref_hz> <from>-<to> [<from>-<to> ...]

Track pitch relative to a reference segment with a known firing rate. Compare
whitened log-frequency spectra against an adaptive template, then locate cycle
boundaries by matching adjacent waveforms. Align cycles with similar firing rates
and discard poor matches.

Normalize the requested recording segments and write public/audio/<name>.mp3.
Write cycle times, firing rates, load classes, and levels to <name>.json. Load
classes describe rising pitch (1), steady pitch (0.5), and falling pitch (0).

Requires NumPy and ffmpeg. Credit source recordings in public/audio/CREDITS.md.
"""

import json
import subprocess
import sys

import numpy as np

SR = 22050
HOP = 256
WIN = 2048
# Sample frequencies from 25 Hz in 1/96-octave steps. ENGINE_TOP limits analysis to lower harmonics in noisy recordings.
GRID = 25 * 2 ** (np.arange(0, int(np.log2(float(__import__('os').environ.get('ENGINE_TOP', 3200)) / 25) * 96)) / 96)
OUT = 'public/audio'


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def spectra(x):
    """Return one whitened log-frequency spectrum per HOP samples."""
    w = np.hanning(WIN)
    fr = np.fft.rfftfreq(WIN, 1 / SR)
    rows = []
    for i in range(0, len(x) - WIN, HOP):
        m = np.log(np.interp(GRID, fr, np.abs(np.fft.rfft(x[i:i + WIN] * w))) + 1e-9)
        m = m - np.convolve(m, np.ones(33) / 33, 'same')
        rows.append(np.maximum(m, 0))
    return np.array(rows)


def track(S, ref):
    """Track pitch in octaves relative to the reference frames, with a confidence score per frame."""
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
    # Suppress isolated pitch-tracking errors with a short median filter.
    sm = np.array([np.median(shifts[max(0, k - 3):k + 4]) for k in range(n)])
    return sm / 96, conf


def marks(x, hz_at, t0, t1):
    """
    Locate cycle boundaries between t0 and t1, returning times and match scores.
    Search within 20% of the predicted period for the waveform that best matches
    the previous cycle. Actual boundary spacing determines each cycle's rate.
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
    """Sample one cycle centered at t as L points, normalized to zero mean and unit norm."""
    per = SR / hz
    pos = t * SR - per / 2 + np.arange(L) * per / L
    if pos[0] < 0 or pos[-1] >= len(x) - 1:
        return None
    c = np.interp(pos, np.arange(len(x)), x)
    c = c - c.mean()
    return c / (np.linalg.norm(c) + 1e-12)


def shift(c, tpl):
    """Return the phase offset as a fraction of a cycle and the circular-correlation score."""
    cc = np.fft.ifft(np.fft.fft(c) * np.conj(np.fft.fft(tpl))).real
    s = int(np.argmax(cc))
    return (s - L if s > L // 2 else s) / L, float(cc.max())


def consensus(y, table):
    """
    Align cycles in firing-rate order against an adaptive waveform template.
    Update mark times to preserve phase when neighboring grains overlap, and
    discard cycles that do not match the template closely enough.
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
        # Preview the estimated firing rate and confidence at quarter-second intervals.
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
    # Classify engine load from the smoothed rate of pitch change in octaves per second.
    rate = np.gradient(np.convolve(octs, np.ones(9) / 9, 'same'), HOP / SR)
    load_at = lambda t: float(np.interp(t, ft, np.where(rate > 0.15, 1.0, np.where(rate < -0.15, 0.0, 0.5))))
    parts, table, at = [], [], 0.0
    for span in spans:
        t0, t1 = map(float, span.split('-'))
        seg = x[int(t0 * SR):int(t1 * SR)]
        gain = 10 ** (-16 / 20) / (np.sqrt(np.mean(seg ** 2)) + 1e-9)
        ms = marks(x, hz_at, t0, t1)
        # Derive firing rate from actual cycle spacing so metadata matches the extracted waveform.
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
