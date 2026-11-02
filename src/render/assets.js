import * as THREE from 'three';
import { smooth } from '../core/util.js';

// Paths are relative to index.html. tools/build.py replaces them with data URIs for the standalone file.
const SKY_URL = 'assets/sky.jpg';
const OCEAN_URL = 'assets/ocean-noise.png';

/**
 * sky.jpg          CC0 photographed sky (upper hemisphere, equirectangular), tone-encoded so 8 bits carry HDR.
 * ocean-noise.png  tileable FFT ocean slopes in RG, soft tileable noise in B (mist, foam, cloud shadows).
 */
export function loadTextures(renderer, onSkyLoaded) {
  const loader = new THREE.TextureLoader();

  const sky = loader.load(SKY_URL, onSkyLoaded);
  sky.wrapS = THREE.RepeatWrapping;
  sky.wrapT = THREE.ClampToEdgeWrapping;
  sky.minFilter = THREE.LinearFilter;
  sky.generateMipmaps = false;

  const ocean = loader.load(OCEAN_URL);
  ocean.wrapS = ocean.wrapT = THREE.RepeatWrapping;
  ocean.minFilter = THREE.LinearMipmapLinearFilter;
  ocean.anisotropy = renderer.capabilities.getMaxAnisotropy();

  return { sky, ocean };
}

/**
 * CPU copy of the cloud-shadow pattern. It evaluates exactly the formula the water shader uses,
 * so the yacht's sunlight dims and brightens in sync with the shadows passing over the sea.
 * Returns 0 under cloud, 1 in sunlight.
 */
export function createCloudSampler(oceanTexture) {
  let data = null;
  const sampleB = (u, v) => {
    u -= Math.floor(u); v -= Math.floor(v);
    const px = Math.min(data.w - 1, Math.floor(u * data.w));
    const py = Math.min(data.h - 1, Math.floor((1 - v) * data.h));   // texture is flipped vertically on upload
    return data.d[(py * data.w + px) * 4 + 2] / 255;
  };
  return function cloudLitAt(x, z, t) {
    if (!data) {
      const img = oceanTexture.image;
      if (!img || !img.complete || !img.width) return 1;
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      data = { w: canvas.width, h: canvas.height, d: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
    }
    const cs = sampleB(x * 0.0011 + t * 0.0016, z * 0.0011 + t * 0.0009) * 0.6
             + sampleB(x * 0.0027 - t * 0.001, z * 0.0027 - t * 0.0021) * 0.4;
    return smooth(0.35, 0.65, cs);
  };
}
