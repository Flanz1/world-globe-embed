/**
 * The globe's tile layers above 8192 (see shared/tiles.ts). Each loaded tile is a small sphere patch
 * just above the globe, textured with one 2048 px tile and laid out with the same pole padding and
 * prime meridian shift as the map texture, so it lines up exactly with what's underneath.
 *
 * Only tiles under the current view load, lower levels first (16384, then 32768), at most TILE_BUDGET
 * kept at once; tiles off screen are dropped first.
 */
import {
  ClampToEdgeWrapping,
  Group,
  LinearFilter,
  Mesh,
  MeshPhongMaterial,
  SRGBColorSpace,
  SphereGeometry,
  Texture,
  Vector3,
  type PerspectiveCamera,
  type WebGLRenderer,
} from "three";
import { TILE_BUDGET, TileCache, levelFor, tileRect, tilesAt, tileUrl, type TileLevel } from "../shared/tiles.ts";

type Decoded = { src: ImageBitmap | HTMLImageElement; preFlipped: boolean };

interface Tile {
  mesh: Mesh;
  tex: Texture;
  level: number;
  c: number;
  r: number;
}

export interface GlobeTilesOptions {
  levels: TileLevel[];
  world: Group;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  gl: WebGL2RenderingContext;
  band: () => { t0: number; t1: number };
  shift: () => number;
  anisotropy: number;
  load: (url: string) => Promise<Decoded>;
  invalidate: () => void;
  /** Called with the finest level whose visible tiles are all on screen (0 when none). */
  onShown?: (w: number) => void;
}

/** Samples across the screen, centre first, in normalised device coordinates. */
const SAMPLES: [number, number][] = (() => {
  const out: [number, number][] = [[0, 0]];
  for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) out.push([-1 + i / 3, -1 + j / 3]);
  return out;
})();

export function createGlobeTiles(o: GlobeTilesOptions) {
  const group = new Group();
  o.world.add(group);
  const cache = new TileCache<Tile>(TILE_BUDGET, (t) => {
    group.remove(t.mesh);
    t.mesh.geometry.dispose();
    (t.mesh.material as MeshPhongMaterial).dispose();
    const img = t.tex.image as ImageBitmap | undefined;
    t.tex.dispose();
    if (img && typeof img.close === "function") img.close();
  });
  const key = (level: number, c: number, r: number) => `${level}:${c}:${r}`;
  let disabled = false;
  let busy = false;
  let pending: number | null = null;

  /** A sphere patch over tile (c, r), in the same UV frame as the globe's band (see globe.ts buildBand). */
  function patch(level: number, c: number, r: number): SphereGeometry {
    const l = o.levels[level];
    const [u0, v0, u1, v1] = tileRect(l, c, r);
    const { t0, t1 } = o.band();
    const phiStart = 2 * Math.PI * (u0 + o.shift() / 360);
    const phiLength = 2 * Math.PI * (u1 - u0);
    const thetaStart = t0 + v0 * (t1 - t0);
    const thetaLength = (v1 - v0) * (t1 - t0);
    // Denser than the globe (128 segments round) so the patch never dips under it; a little above
    // it too, finer levels higher, and well under the region overlay (1.005).
    const segs = (len: number) => Math.max(4, Math.ceil((len / (2 * Math.PI)) * 512));
    return new SphereGeometry(1 + 0.0004 * (level + 1), segs(phiLength), segs(thetaLength), phiStart, phiLength, thetaStart, thetaLength);
  }

  /** Image fractions (u, v) under each screen sample that hits the globe's map band. */
  const ray = new Vector3();
  const hit = new Vector3();
  function visiblePoints(): [number, number][] {
    const pts: [number, number][] = [];
    const cam = o.camera.position;
    const inv = o.world.quaternion.clone().invert();
    const { t0, t1 } = o.band();
    for (const [x, y] of SAMPLES) {
      ray.set(x, y, 0.5).unproject(o.camera).sub(cam).normalize();
      // |cam + s·ray| = 1
      const b = cam.dot(ray);
      const disc = b * b - (cam.lengthSq() - 1);
      if (disc < 0) continue;
      const s = -b - Math.sqrt(disc);
      hit.copy(cam).addScaledVector(ray, s).applyQuaternion(inv);
      const theta = Math.acos(Math.max(-1, Math.min(1, hit.y)));
      const phi = Math.atan2(hit.z, -hit.x);
      const v = (theta - t0) / (t1 - t0);
      if (v < 0 || v > 1) continue; // on a pole cap
      pts.push([phi / (2 * Math.PI) - o.shift() / 360, v]);
    }
    return pts;
  }

  async function add(level: number, c: number, r: number, keep: Set<string>): Promise<boolean> {
    const d = await o.load(tileUrl(o.levels[level], c, r));
    const tex = new Texture(d.src);
    tex.colorSpace = SRGBColorSpace;
    tex.flipY = !d.preFlipped;
    tex.generateMipmaps = false; // only shown close up, where it's drawn about 1:1; saves a third of the memory
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.wrapS = tex.wrapT = ClampToEdgeWrapping;
    tex.anisotropy = o.anisotropy;
    tex.needsUpdate = true;
    const mat = new MeshPhongMaterial({ map: tex, specular: 0x333333, shininess: 15 });
    const mesh = new Mesh(patch(level, c, r), mat);
    mesh.renderOrder = 0.5;
    for (let i = 0; i < 8 && o.gl.getError() !== o.gl.NO_ERROR; i++) continue;
    o.renderer.initTexture(tex);
    if (o.gl.getError() === o.gl.OUT_OF_MEMORY) {
      tex.dispose();
      mat.dispose();
      mesh.geometry.dispose();
      if (typeof (d.src as ImageBitmap).close === "function") (d.src as ImageBitmap).close();
      return false;
    }
    group.add(mesh);
    cache.set(key(level, c, r), { mesh, tex, level, c, r }, keep);
    return true;
  }

  /** Shows and loads what the view needs; `want` is the texture width the screen calls for. */
  async function update(want: number): Promise<void> {
    if (busy) {
      pending = want;
      return;
    }
    const top = levelFor(o.levels, want);
    const ti = top ? o.levels.indexOf(top) : -1;
    let changed = group.visible !== ti >= 0;
    for (const [, t] of cache.entries()) {
      if (t.mesh.visible !== t.level <= ti) changed = true;
      t.mesh.visible = t.level <= ti;
    }
    group.visible = ti >= 0;
    // Only redraw when something changed: a redraw asks for another update once the view settles.
    if (changed) o.invalidate();
    if (ti < 0 || disabled) {
      o.onShown?.(0);
      return;
    }
    busy = true;
    try {
      const pts = visiblePoints();
      // Lower levels first: the 16384 tiles show while the 32768 ones load.
      const need: [number, number, number][] = [];
      for (let li = 0; li <= ti; li++) for (const [c, r] of tilesAt(o.levels[li], pts)) need.push([li, c, r]);
      const keep = new Set(need.map(([li, c, r]) => key(li, c, r)));
      let shown = 0;
      for (const [li, c, r] of need) {
        if (pending !== null) break; // the view moved on; start over with the new one
        if (!cache.has(key(li, c, r))) {
          if (!(await add(li, c, r, keep).catch(() => false))) {
            disabled = true; // out of memory or a broken tile: keep what's there, load no more
            break;
          }
          o.invalidate();
        } else cache.get(key(li, c, r));
        if (need.filter(([l]) => l === li).every(([l, cc, rr]) => cache.has(key(l, cc, rr)))) shown = o.levels[li].w;
      }
      if (pending === null) o.onShown?.(shown);
    } finally {
      busy = false;
    }
    if (pending !== null) {
      const w = pending;
      pending = null;
      void update(w);
    }
  }

  /** Padding or shift changed (admin preview): rebuild every patch. */
  function relayout(): void {
    for (const [, t] of cache.entries()) {
      t.mesh.geometry.dispose();
      t.mesh.geometry = patch(t.level, t.c, t.r);
    }
  }

  return { update, relayout };
}
