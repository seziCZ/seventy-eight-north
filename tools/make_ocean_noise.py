#!/usr/bin/env python3
"""
Generates assets/ocean-noise.png, a 512x512 tileable texture:
  R, G  ocean surface slopes (x, z) from a Phillips wave spectrum, encoded as 0.5 + 0.5 * slope / S
        (S = 99.7th percentile, so values stay in range). The water shader decodes them as normals.
  B     soft tileable noise with a 1/k^1.6 spectrum, used for mist, foam breakup, wind patches and cloud shadows.

Both channels tile seamlessly because they are built in the frequency domain (inverse FFT is periodic).

    pip install -r tools/requirements.txt
    python3 tools/make_ocean_noise.py
"""
import pathlib
import cv2
import numpy as np

OUT = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'ocean-noise.png'
N = 512          # texture size (pixels)
PATCH = 24.0     # physical size of the slope patch (m)
WIND = np.array([0.8, 0.6])
WIND_SPEED = 7.0


def ocean_slopes(rng):
    k1 = np.fft.fftfreq(N, d=PATCH / N) * 2 * np.pi
    kx, kz = np.meshgrid(k1, k1, indexing='xy')
    k = np.hypot(kx, kz)
    k[0, 0] = 1e-6
    largest_wave = WIND_SPEED ** 2 / 9.81
    cos_wind = (kx * WIND[0] + kz * WIND[1]) / k
    phillips = np.exp(-1 / (k * largest_wave) ** 2) / k ** 4 * cos_wind ** 2 * np.exp(-(k * 0.06) ** 2)
    phillips[0, 0] = 0
    h0 = (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))) * np.sqrt(phillips / 2)
    sx = np.real(np.fft.ifft2(1j * kx * h0))
    sz = np.real(np.fft.ifft2(1j * kz * h0))
    scale = np.percentile(np.abs(np.concatenate([sx.ravel(), sz.ravel()])), 99.7)
    return sx / scale, sz / scale


def soft_noise(rng):
    phase = rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))
    f = np.fft.fftfreq(N) * N
    kk = np.hypot(*np.meshgrid(f, f))
    kk[0, 0] = 1
    n = np.real(np.fft.ifft2(phase / kk ** 1.6 * np.exp(-(kk / 90) ** 2)))
    lo, hi = np.percentile(n, [1, 99])
    return np.clip((n - lo) / (hi - lo), 0, 1)


def main():
    rng = np.random.default_rng(7)
    sx, sz = ocean_slopes(rng)
    noise = soft_noise(rng)
    rgb = np.stack([np.clip(0.5 + 0.5 * sx, 0, 1), np.clip(0.5 + 0.5 * sz, 0, 1), noise], axis=-1)
    u8 = (rgb * 255 + 0.5).astype(np.uint8)
    cv2.imwrite(str(OUT), cv2.cvtColor(u8, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    print(f'wrote {OUT}')


if __name__ == '__main__':
    main()
