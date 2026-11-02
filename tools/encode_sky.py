#!/usr/bin/env python3
"""
Encodes a sky HDRI into assets/sky.jpg.

Source used for the project: "HdrSkyOvercast001" from ambientCG (CC0), 8K EXR:
https://ambientcg.com/view?id=HdrSkyOvercast001

Steps:
  1. Keep the upper hemisphere of the equirectangular image (the sea covers the rest).
  2. Fill the few black rows just above the horizon with the last valid sky rows.
  3. Blur the band from the horizon to ~13 degrees horizontally only: removes vertical sunbeams that
     would otherwise hang in mid-air above the open sea, while keeping the brightness under the cloud gap.
  4. Tone-encode so 8 bits can carry HDR:  enc = (x / (1 + x)) ^ (1 / 2.2).  The shader inverts it.
  5. Sharpen (fine detail plus mid-scale "clarity") everywhere above the smoothed band.

    pip install -r tools/requirements.txt
    python3 tools/encode_sky.py path/to/HdrSkyOvercast001_HDR_8K.exr
"""
import os
import pathlib
import sys

os.environ.setdefault('OPENCV_IO_ENABLE_OPENEXR', '1')
import cv2  # noqa: E402  (must come after the environment variable)
import numpy as np  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent.parent / 'assets' / 'sky.jpg'


def main(src):
    hdr = cv2.imread(src, cv2.IMREAD_UNCHANGED)
    if hdr is None:
        sys.exit(f'could not read {src} (OpenCV needs OpenEXR support)')
    hdr = hdr[:, :, :3].astype(np.float32)
    h = hdr.shape[0]

    # 1-2. Upper hemisphere, horizon gap filled
    top = hdr[:h // 2].copy()
    row_median = np.median(top.mean(axis=2), axis=1)
    last_valid = int(np.where(row_median > 1e-4)[0].max())
    top[last_valid - 2:] = top[last_valid - 6:last_valid - 2].mean(axis=0)
    rows = top.shape[0]

    # 3. Horizontal-only blur (with wraparound) blended in toward the horizon
    pad = 800
    padded = np.pad(top, ((0, 0), (pad, pad), (0, 0)), mode='wrap')
    blurred = cv2.GaussianBlur(padded, (0, 0), sigmaX=140, sigmaY=0.1)[:, pad:-pad]
    elevation = (rows - (np.arange(rows) + 0.5)) / rows * 90
    t = np.clip((elevation - 3) / 10, 0, 1)
    band = (1 - t * t * (3 - 2 * t))[:, None, None]
    sky = top * (1 - band) + blurred * band

    # 4. Tone encode
    enc = ((sky / (1 + sky)) ** (1 / 2.2)).astype(np.float32)

    # 5. Sharpen outside the smoothed band
    keep = 1 - band
    fine = cv2.GaussianBlur(enc, (0, 0), 2.2)
    mid = cv2.GaussianBlur(enc, (0, 0), 16)
    enc = np.clip(enc + keep * (1.1 * (enc - fine) + 0.55 * (enc - mid)), 0, 1)

    cv2.imwrite(str(OUT), (enc * 255 + 0.5).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f'wrote {OUT} ({enc.shape[1]}x{enc.shape[0]})')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
