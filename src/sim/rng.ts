/** シード固定の擬似乱数（mulberry32）。テストの再現性のために使う。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2次元の値ノイズ（シード固定・多重オクターブ） */
export function valueNoise2D(seed: number) {
  const perm = new Uint16Array(512);
  const rng = makeRng(seed);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  const grad = new Float32Array(256);
  for (let i = 0; i < 256; i++) grad[i] = rng() * 2 - 1;

  const at = (xi: number, yi: number): number => {
    const h = perm[(perm[xi & 255] + (yi & 255)) & 255];
    return grad[h];
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);

  return function noise(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = smooth(x - xi);
    const yf = smooth(y - yi);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
  };
}

/** フラクタルノイズ（-1..1 程度） */
export function fbm(seed: number, octaves = 4, persistence = 0.5) {
  const noise = valueNoise2D(seed);
  return function (x: number, y: number): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= persistence;
      freq *= 2;
    }
    return norm > 0 ? sum / norm : 0;
  };
}
