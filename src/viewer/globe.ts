/**
 * The 3D globe, ported from GlobePanel in Fantasy-World-Visualizer (src/App.jsx)
 * as plain TypeScript with no React. Loaded with a dynamic import() by boot.ts
 * after first paint.
 *
 * Motion model:
 *  - starts in the slot's default view, auto-spinning (unless rotate=0 or reduced motion);
 *  - the first pan/zoom stops the spin for the rest of the visit;
 *  - after that the globe moves only under direct input: no inertia, no damping, no idle restart;
 *  - nothing persists; a bfcache restore (pageshow.persisted) resets to the default spinning state.
 *
 * Region embeds (?region=<id>) add an overlay sphere with the region drawn on it, a label, auto-framing,
 * and a view lock: they start locked on the region's position, where drag, wheel and pinch do nothing
 * (and pass through to the page around the iframe) until the reader presses the padlock.
 */
import {
  AmbientLight,
  BufferGeometry,
  CanvasTexture,
  DirectionalLight,
  Euler,
  Float32BufferAttribute,
  Group,
  LessEqualDepth,
  Line,
  LineBasicMaterial,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshPhongMaterial,
  PerspectiveCamera,
  RepeatWrapping,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { BASE_DISTANCE, FOV_DEG, MAX_DISTANCE, MIN_DISTANCE, clamp, clampPadding, distanceForZoom, parseHex } from "../shared/params.ts";
import { globeToImage, imageToGlobe, polygonsOf, type Position } from "../shared/geo.ts";
import { regionFit, regionLabelPoints, type LabelPoint, type RegionData } from "../shared/region.ts";
import { paintLayerStack, type PaintLayer } from "../shared/raster.ts";
import { hasContestedLayers, regionPaintLayers } from "../shared/region-paint.ts";
import { deviceLimit, deviceMemory, nextTier } from "../shared/tiers.ts";
import { createGlobeTiles } from "./globe-tiles.ts";
import type { PreviewMessage, StartContext } from "./contract.ts";
import { setupRegionCard } from "./region-card.ts";
import { setupRuler } from "./ruler.ts";
import { RELOCK_MS, labelOnScreen, makeLabels, makeLegend, makeVisibility, regionNote, setupLayers, setupLock, mainLegendRows, type Lock } from "./region-ui.ts";
import { setupPins, watchPreviewPins, type PinLayer } from "./pins.ts";

const DEG = Math.PI / 180;
/** Auto-spin speed in radians per second (about 2 minutes per turn, like the desktop app). */
const SPIN_RAD_PER_S = 0.055;
const FADE_MS = 450;
/** Region overlay sphere: just above the globe, under the atmosphere (1.03) and grid (1.04). */
const OVERLAY_R = 1.005;

/* ── Device capability, adapted from IS_MOBILE in the visualizer ──
 * The original also treated innerWidth < 768 as mobile. Inside an iframe that is
 * the iframe's width, so desktop embeds would be downgraded; viewport size is
 * handled separately below instead. */
function detectDevice() {
  const ua = navigator.userAgent;
  const mobileUA = /Android|iPhone|iPad|iPod|webOS/i.test(ua);
  const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  const mem = deviceMemory();
  const lowMem = mem !== undefined && mem < 4; // see deviceLimit: many 8 GB laptops report 4
  return { mobile: mobileUA || touchOnly || lowMem };
}

function canFlipBitmap(): boolean {
  return typeof createImageBitmap === "function";
}

/** Decodes an image off the main thread where possible. */
async function decode(blob: Blob): Promise<{ src: ImageBitmap | HTMLImageElement; preFlipped: boolean }> {
  if (canFlipBitmap()) {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: "flipY", premultiplyAlpha: "none" });
      return { src: bmp, preFlipped: true };
    } catch {
      /* fall through to <img> */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { src: img, preFlipped: false };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`texture ${r.status}`);
  return r.blob();
}

/* ── Grid overlay: 15° lines, gold equator, red prime meridian ── */
function buildGrid(segs: number): Group {
  const group = new Group();
  const mk = (color: number, opacity: number) =>
    new LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false });
  const minor = mk(0xc9a94e, 0.18);
  const major = mk(0xc9a94e, 0.35);
  const equator = mk(0xe8c44a, 0.7);
  const prime = mk(0xe85050, 0.6);
  // Slightly above the atmosphere shell (1.03) so lines never z-fight with it,
  // while depthTest stays on so the opaque globe hides the far side.
  const r = 1.04;
  // Direction of (lat, lon) in the sphere's local frame, matching Three's SphereGeometry UVs
  // (lon 0 = texture centre on +X, east towards -Z).
  const p = (lat: number, lon: number, out: number[]) => {
    const c = Math.cos(lat);
    out.push(r * c * Math.cos(lon), r * Math.sin(lat), -r * c * Math.sin(lon));
  };
  const line = (pts: number[], mat: LineBasicMaterial) => {
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pts, 3));
    group.add(new Line(g, mat));
  };
  for (let lat = -75; lat <= 75; lat += 15) {
    const pts: number[] = [];
    for (let i = 0; i <= segs; i++) p(lat * DEG, (i / segs) * Math.PI * 2, pts);
    line(pts, lat === 0 ? equator : lat % 30 === 0 ? major : minor);
  }
  for (let lon = 0; lon < 360; lon += 15) {
    const pts: number[] = [];
    for (let i = 0; i <= segs; i++) p(-Math.PI / 2 + (i / segs) * Math.PI, lon * DEG, pts);
    line(pts, lon === 0 ? prime : lon % 30 === 0 ? major : minor);
  }
  group.renderOrder = 3;
  group.traverse((o) => (o.renderOrder = 3));
  return group;
}

export async function start(ctx: StartContext): Promise<void> {
  const { cfg, canvas, gl } = ctx;
  const R = ctx.region;
  const root = document.documentElement;
  const stage = document.getElementById("stage")!;
  const device = detectDevice();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const renderer = new WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const dpr = () => Math.min(window.devicePixelRatio || 1, device.mobile ? 1.5 : 2);
  renderer.setPixelRatio(dpr());
  const maxTex = renderer.capabilities.maxTextureSize;
  /** Largest map texture this device loads: 8192 on desktops whose GPU takes it, otherwise 4096. */
  const texLimit = deviceLimit(device.mobile, maxTex);
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV_DEG, 1, 0.1, 100);

  scene.add(new AmbientLight(0xffffff, 0.5 * Math.PI));
  const sun = new DirectionalLight(0xfff4e0, 1.0 * Math.PI);
  sun.position.set(5, 3, 5);
  scene.add(sun);
  const fill = new DirectionalLight(0x8ab4f8, 0.25 * Math.PI);
  fill.position.set(-3, -1, -2);
  scene.add(fill);

  const small = Math.min(stage.clientWidth, stage.clientHeight) * dpr() < 600;
  const lowGeo = device.mobile || small;
  const wSegs = lowGeo ? 64 : 128;
  const hSegs = lowGeo ? 48 : 96;

  /* ── Pole padding, as in the desktop app: the map covers only the band between the
   * padded areas, and the caps are filled with a solid pole colour. Instead of redrawing the
   * texture on a canvas (slow at 4096px), the textured sphere is built as a band and the caps
   * are separate meshes, so changing padding never touches the texture. */
  let geo = new SphereGeometry(1, wSegs, hSegs);
  const poleMat = new MeshPhongMaterial({ color: cfg.pole, specular: 0x333333, shininess: 15 });
  const caps = new Group();
  /** Current padding (percent), so region overlays follow the same band as the texture. */
  const pad = { north: 0, south: 0 };
  let band = { t0: 0, t1: Math.PI };
  const rows = (frac: number) => Math.max(2, Math.round(hSegs * frac));
  function buildBand(north: number, south: number): void {
    const { north: n, south: s } = clampPadding(north, south);
    pad.north = n;
    pad.south = s;
    const t0 = (n / 100) * Math.PI;
    const t1 = (1 - s / 100) * Math.PI;
    band = { t0, t1 };
    const next = new SphereGeometry(1, wSegs, rows((t1 - t0) / Math.PI), 0, Math.PI * 2, t0, t1 - t0);
    for (const m of [globe, fade?.mesh]) if (m) m.geometry = next;
    tiles?.relayout();
    geo.dispose();
    geo = next;
    for (const c of [...caps.children] as Mesh[]) {
      c.geometry.dispose();
      caps.remove(c);
    }
    if (t0 > 0) caps.add(new Mesh(new SphereGeometry(1, wSegs, rows(t0 / Math.PI), 0, Math.PI * 2, 0, t0), poleMat));
    if (t1 < Math.PI) caps.add(new Mesh(new SphereGeometry(1, wSegs, rows(1 - t1 / Math.PI), 0, Math.PI * 2, t1, Math.PI - t1), poleMat));
    if (overlay) buildOverlayGeometry();
  }

  let shift = clamp(cfg.shift, -180, 180);
  /** Tile levels above 8192, once the 8192 is on screen (created below). */
  let tiles: ReturnType<typeof createGlobeTiles> | null = null;
  const makeTexture = (d: { src: ImageBitmap | HTMLImageElement; preFlipped: boolean }) => {
    const t = new Texture(d.src);
    t.colorSpace = SRGBColorSpace;
    t.flipY = !d.preFlipped;
    t.anisotropy = Math.min(8, maxAniso);
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    // Horizontal shift: wrap around in longitude and offset the lookup (positive = east).
    t.wrapS = RepeatWrapping;
    t.offset.x = -shift / 360;
    t.needsUpdate = true;
    return t;
  };
  const releaseTexture = (t: Texture | null) => {
    if (!t) return;
    const img = t.image as ImageBitmap | undefined;
    t.dispose();
    if (img && typeof (img as ImageBitmap).close === "function") (img as ImageBitmap).close();
  };

  const globeMat = new MeshPhongMaterial({ specular: 0x333333, shininess: 15 });
  const globe = new Mesh(geo, globeMat);
  const atmosphere = new Mesh(
    new SphereGeometry(1.03, 64, 48),
    new MeshBasicMaterial({ color: 0x6699cc, transparent: true, opacity: 0.08, depthWrite: false }),
  );
  atmosphere.renderOrder = 2;
  const grid = buildGrid(lowGeo ? 64 : 128);

  const world = new Group();
  world.add(globe, caps, atmosphere, grid);
  scene.add(world);

  /* ── Region overlay: the region rasterised into the same equirectangular UV space as the map,
   * on a band with the same padding and the same shift offset, so the two line up exactly. ── */
  let reg: RegionData | null = null;
  let labelAt: LabelPoint[] = [];
  let overlay: { mesh: Mesh; canvas: HTMLCanvasElement; tex: CanvasTexture; mat: MeshPhongMaterial; dimCaps: Group; w: number; worker: Worker | null } | null = null;
  const dimMat = new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false });
  const dimOn = () => !!R?.dim;
  function buildOverlayGeometry(): void {
    if (!overlay) return;
    const { t0, t1 } = band;
    overlay.mesh.geometry.dispose();
    overlay.mesh.geometry = new SphereGeometry(OVERLAY_R, wSegs, rows((t1 - t0) / Math.PI), 0, Math.PI * 2, t0, t1 - t0);
    for (const c of [...overlay.dimCaps.children] as Mesh[]) {
      c.geometry.dispose();
      overlay.dimCaps.remove(c);
    }
    if (dimOn()) {
      if (t0 > 0) overlay.dimCaps.add(new Mesh(new SphereGeometry(OVERLAY_R, wSegs, rows(t0 / Math.PI), 0, Math.PI * 2, 0, t0), dimMat));
      if (t1 < Math.PI)
        overlay.dimCaps.add(new Mesh(new SphereGeometry(OVERLAY_R, wSegs, rows(1 - t1 / Math.PI), 0, Math.PI * 2, t1, Math.PI - t1), dimMat));
      overlay.dimCaps.traverse((o) => (o.renderOrder = 1.5));
    }
  }
  /**
   * Texture width that matches the screen: 2π × the pixels per radian at the point under the camera,
   * so a region embed zoomed in close asks for the 4096 map, and closer still for the 8192 one.
   * Phones get 4096 only when zoomed in, and never 8192 (see deviceLimit).
   */
  function textureWant(): number {
    const f = (stage.clientHeight * dpr()) / 2 / Math.tan((camera.fov * DEG) / 2);
    const want = (2 * Math.PI * f) / Math.max(0.05, view.distance - 1);
    if (want >= 6000 && !device.mobile) return Math.round(want); // 8192, or a tile level (see globe-tiles.ts)
    return want >= 3000 && (!device.mobile || want >= 4500) ? 4096 : 2048;
  }
  /**
   * Overlay canvas width. Desktop starts at 4096 (borders were visibly soft at 2048 on a normal screen) and
   * goes to 8192 once zoomed in close, matching the 8192 map tier. Phones stay at 2048, 4096 when zoomed in.
   */
  function overlayWidth(): number {
    const want = textureWant();
    if (device.mobile) return want >= 4096 && maxTex >= 4096 ? 4096 : 2048;
    if (want >= 6000 && texLimit >= 8192) return 8192;
    return maxTex >= 4096 ? 4096 : 2048;
  }
  let onZoom = (): void => {};
  function ensureOverlay(): NonNullable<typeof overlay> {
    if (overlay) return overlay;
    const c = document.createElement("canvas");
    c.width = overlayWidth();
    c.height = c.width / 2;
    const tex = new CanvasTexture(c);
    tex.colorSpace = SRGBColorSpace;
    tex.wrapS = RepeatWrapping;
    tex.offset.x = -shift / 360;
    tex.anisotropy = Math.min(8, maxAniso);
    tex.premultiplyAlpha = true;
    const mat = new MeshPhongMaterial({ map: tex, transparent: true, depthWrite: false, premultipliedAlpha: true, specular: 0x333333, shininess: 15 });
    const mesh = new Mesh(new SphereGeometry(OVERLAY_R, 8, 4), mat);
    mesh.renderOrder = 1.5;
    const dimCaps = new Group();
    overlay = { mesh, canvas: c, tex, mat, dimCaps, w: c.width, worker: startOverlayWorker(c) };
    buildOverlayGeometry();
    world.add(mesh, dimCaps);
    return overlay;
  }
  /** Border width in texture pixels that shows as FLAT_LINE_PX CSS pixels on screen at the current zoom (same as the flat map). */
  const FLAT_LINE_PX = 1.2;
  let drawnLineW = 0;
  function overlayLineWidth(W: number): number {
    const fCss = stage.clientHeight / 2 / Math.tan((camera.fov * DEG) / 2);
    const screenPxPerRad = fCss / Math.max(0.05, view.distance - 1);
    // Never below one texel: a thinner stroke fades out instead of getting thinner once the texture is magnified.
    return Math.max(1, (FLAT_LINE_PX * (W / (2 * Math.PI))) / screenPxPerRad);
  }
  /*
   * The overlay is painted by a worker (see overlay-worker.ts), so a repaint (new zoom detail, a layer switch,
   * a live edit) never freezes the page. Without OffscreenCanvas or workers it is painted right here instead.
   */
  function startOverlayWorker(c: HTMLCanvasElement): Worker | null {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined" || !("transferControlToOffscreen" in c)) return null;
    try {
      const wk = new Worker(new URL("./overlay-worker.ts", import.meta.url), { type: "module" });
      const off = c.transferControlToOffscreen();
      wk.postMessage({ init: off }, [off]);
      wk.onmessage = (e: MessageEvent<{ id: number }>) => {
        if (!overlay || e.data.id !== paintSeq) return;
        paintBusy = false;
        if (resized) {
          resized = false;
          overlay.tex.dispose();
        }
        overlay.tex.needsUpdate = true;
        uploadQueued = true;
        invalidate();
        if (paintWanted) requestPaint();
      };
      wk.onerror = () => {
        // The worker failed to start: swap in a fresh canvas and paint on this thread.
        if (!overlay || overlay.worker !== wk) return;
        wk.terminate();
        const c2 = document.createElement("canvas");
        c2.width = overlay.w;
        c2.height = overlay.w / 2;
        overlay.canvas = c2;
        overlay.worker = null;
        overlay.tex.image = c2;
        paintBusy = false;
        requestPaint();
      };
      return wk;
    } catch {
      return null;
    }
  }
  let resized = false;
  let paintSeq = 0;
  let paintBusy = false;
  let paintWanted = false;
  let sentLayers: PaintLayer[] | null = null;
  function requestPaint(): void {
    const o = overlay;
    if (!o || !reg || !spec) return;
    const W = o.w;
    const H = W / 2;
    drawnLineW = overlayLineWidth(W);
    if (!o.worker) {
      if (o.canvas.width !== W) {
        o.canvas.width = W;
        o.canvas.height = H;
        o.tex.dispose();
        resized = false;
      }
      const g = o.canvas.getContext("2d")!;
      g.clearRect(0, 0, W, H);
      // Map-image frame → texture pixels, exactly like the map texture's own UVs.
      paintLayerStack(g, spec, (lon) => ((lon + 180) / 360) * W, (lat) => ((90 - lat) / 180) * H, [-360, 0, 360], { lineWidth: drawnLineW, dim: dimOn() }, { w: W, h: H });
      o.tex.needsUpdate = true;
      uploadQueued = true;
      return;
    }
    // One paint at a time: while one runs, the latest request waits and the ones before it are dropped.
    if (paintBusy) {
      paintWanted = true;
      return;
    }
    paintBusy = true;
    paintWanted = false;
    const layers = sentLayers !== spec ? spec : undefined;
    sentLayers = spec;
    o.worker.postMessage({ id: ++paintSeq, w: W, h: H, layers, lineWidth: drawnLineW, dim: dimOn() });
  }
  function drawRegion(): void {
    if (!reg) return;
    ensureOverlay();
    // Clashes are worked out once per region (or live update), not per redraw.
    const vis = visible.of(reg);
    if (specFor !== vis) {
      spec = regionPaintLayers(vis);
      specFor = vis;
    }
    requestPaint();
    const pts = (R?.label ?? vis.label) ? regionLabelPoints(vis, R?.label === true) : [];
    labelAt = pts;
    labels?.set(pts.map((p) => p.text));
    regionKey?.set(R?.key ? mainLegendRows(vis, visible) : [], vis.legendTitle, !!R?.key && hasContestedLayers(spec!));
  }
  /*
   * Live repaints (the admin editor streams every edit, undo and redo here) wait until the GPU has finished the
   * previous overlay upload. The overlay is up to 8192×4096, so each repaint uploads 128 MB; with software GL a
   * burst of edits queued uploads faster than they were consumed and the GPU process grew to many GB, stalling
   * the page (screenshots and clicks waited minutes). A real GPU finishes within a frame, so this rarely waits.
   */
  let uploadQueued = false;
  let uploadFence: WebGLSync | null = null;
  let repaintWanted = false;
  let repaintTimer = 0;
  const gpuBusy = (): boolean => {
    if (!uploadFence || !(gl instanceof WebGL2RenderingContext)) return false;
    if (gl.isContextLost() || gl.getSyncParameter(uploadFence, gl.SYNC_STATUS) === gl.SIGNALED) {
      gl.deleteSync(uploadFence);
      uploadFence = null;
      return false;
    }
    return true;
  };
  /** After a render that uploaded the overlay: a fence the next live repaint waits for. */
  function fenceUpload(): void {
    if (!uploadQueued) return;
    uploadQueued = false;
    if (!(gl instanceof WebGL2RenderingContext) || uploadFence) return;
    uploadFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }
  /** Repaints the overlay with the latest region as soon as the GPU is done with the last upload. */
  function repaintSoon(): void {
    repaintWanted = true;
    if (repaintTimer) return;
    if (gpuBusy()) {
      repaintTimer = window.setTimeout(() => {
        repaintTimer = 0;
        if (repaintWanted) repaintSoon();
      }, 50);
      return;
    }
    repaintWanted = false;
    drawRegion();
    invalidate();
  }
  const visible = makeVisibility();
  let spec: PaintLayer[] | null = null;
  let specFor: RegionData | null = null;
  const labels = R ? makeLabels(stage) : null;
  const regionKey = R ? makeLegend(stage) : null;
  // The legend opening, collapsing or resizing changes what labels must stay clear of: lay them out again.
  const keyBox = stage.querySelector(".rstack");
  if (keyBox) new ResizeObserver(() => invalidate()).observe(keyBox);
  const tmpV = new Vector3();
  function placeLabel(): void {
    if (!labels) return;
    const toScreen = (at: Position): { x: number; y: number; facing: boolean } => {
      const [lon, lat] = imageToGlobe(at, { north: pad.north, south: pad.south, shift });
      // Same lat/lon → xyz convention as buildGrid.
      const c = Math.cos(lat * DEG);
      tmpV.set(OVERLAY_R * c * Math.cos(lon * DEG), OVERLAY_R * Math.sin(lat * DEG), -OVERLAY_R * c * Math.sin(lon * DEG));
      tmpV.applyQuaternion(world.quaternion);
      // Visible when it's on the camera's side of the horizon (cos θ > 1/d for a unit sphere).
      const facing = tmpV.z / OVERLAY_R > 1 / view.distance + 0.04;
      tmpV.project(camera);
      return { x: ((tmpV.x + 1) / 2) * stage.clientWidth, y: ((1 - tmpV.y) / 2) * stage.clientHeight, facing };
    };
    labelAt.forEach((pt, i) => {
      const { x, y, facing } = toScreen(pt.at);
      const { fit } = labelOnScreen(pt, (p) => toScreen(p));
      labels.place(i, x, y, facing, fit);
    });
  }

  /* ── Ruler: picks and projects globe positions with the same lat/lon → xyz convention as buildGrid ── */
  const rulerV = new Vector3();
  const rulerQ = world.quaternion.clone();
  const ruler = setupRuler(cfg, {
    canvas,
    stage,
    pick(x, y) {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      const t = Math.tan((camera.fov * DEG) / 2);
      // Ray from the camera (0, 0, distance) through the pixel, against the unit sphere.
      const dx = ((2 * x) / w - 1) * t * camera.aspect;
      const dy = (1 - (2 * y) / h) * t;
      const len = Math.hypot(dx, dy, 1);
      const d = view.distance;
      const b = (-d) / len; // origin · direction (direction = (dx, dy, -1) / len)
      const disc = b * b - (d * d - 1);
      if (disc < 0) return null;
      const k = -b - Math.sqrt(disc);
      rulerV.set((k * dx) / len, (k * dy) / len, d - k / len);
      rulerV.applyQuaternion(rulerQ.copy(world.quaternion).invert());
      return [Math.atan2(-rulerV.z, rulerV.x) / DEG, Math.asin(clamp(rulerV.y, -1, 1)) / DEG];
    },
    project([lon, lat]) {
      const c = Math.cos(lat * DEG);
      rulerV.set(OVERLAY_R * c * Math.cos(lon * DEG), OVERLAY_R * Math.sin(lat * DEG), -OVERLAY_R * c * Math.sin(lon * DEG));
      rulerV.applyQuaternion(world.quaternion);
      const ok = rulerV.z / OVERLAY_R > 1 / view.distance + 0.01;
      rulerV.project(camera);
      return { x: ((rulerV.x + 1) / 2) * stage.clientWidth, y: ((1 - rulerV.y) / 2) * stage.clientHeight, ok };
    },
  });

  // Region embeds: clicking a part opens a card with its facts (not in the admin preview, whose region isn't built yet).
  const card =
    R && cfg.slug !== "preview"
      ? setupRegionCard(cfg, {
      project: (p) => ruler.project(imageToGlobe(p, { north: pad.north, south: pad.south, shift })),
      canvas,
      stage,
      region: () => (reg ? visible.of(reg) : null),
      pick(x, y) {
        const g = ruler.pick(x, y);
        return g && globeToImage(g, { north: pad.north, south: pad.south, shift });
      },
    })
      : null;

  /** Map pins (?pins=…): markers placed like the labels, on the far side of the globe hidden. */
  let pinLayer: PinLayer | null = null;
  function placePins(): void {
    pinLayer?.place((at) => {
      const [lon, lat] = imageToGlobe(at, { north: pad.north, south: pad.south, shift });
      const c = Math.cos(lat * DEG);
      tmpV.set(OVERLAY_R * c * Math.cos(lon * DEG), OVERLAY_R * Math.sin(lat * DEG), -OVERLAY_R * c * Math.sin(lon * DEG));
      tmpV.applyQuaternion(world.quaternion);
      const facing = tmpV.z / OVERLAY_R > 1 / view.distance + 0.04;
      tmpV.project(camera);
      return { x: ((tmpV.x + 1) / 2) * stage.clientWidth, y: ((1 - tmpV.y) / 2) * stage.clientHeight, visible: facing };
    });
  }
  /** A cluster of pins was clicked: turn to them and move closer (false when the view can't zoom in any further). */
  const zoomToPins = (pts: [number, number][]): boolean => {
    if (view.distance <= MIN_DISTANCE * 1.05) return false;
    const gs = pts.map((at) => imageToGlobe(at, { north: pad.north, south: pad.south, shift }));
    // Mean of the pins' longitudes (taken round the first so a cluster over the date line stays together) and latitudes.
    const lon0 = gs[0][0];
    const lon = lon0 + gs.reduce((a, [l]) => a + ((((l - lon0 + 180) % 360) + 360) % 360) - 180, 0) / gs.length;
    const lat = gs.reduce((a, [, l]) => a + l, 0) / gs.length;
    const to = { yaw: -Math.PI / 2 - lon * DEG, pitch: lat * DEG, distance: Math.max(MIN_DISTANCE, 1 + (view.distance - 1) * 0.45) };
    to.yaw = view.yaw + Math.atan2(Math.sin(to.yaw - view.yaw), Math.cos(to.yaw - view.yaw));
    spinning = false;
    if (reducedMotion.matches) Object.assign(view, to);
    else ease = { from: { ...view }, to, t0: performance.now() };
    invalidate();
    return true;
  };
  void setupPins(stage, canvas, cfg.slug, location.search, cfg.pins, zoomToPins, cfg.pinLegends, cfg.pinGroups).then((l) => {
    pinLayer = l;
    invalidate();
  });
  // The admin preview gets its pins from the admin page.
  watchPreviewPins(stage, canvas, (l) => {
    pinLayer = l;
    invalidate();
  }, zoomToPins);

  /* ── View state ── */
  const view = { yaw: 0, pitch: 0, distance: BASE_DISTANCE };
  /** Short ease back to the selected position when the view is re-locked. */
  let ease: { from: typeof view; to: typeof view; t0: number } | null = null;
  let lock: Lock | null = null;
  let touched = false;
  let fade: { mesh: Mesh; mat: MeshPhongMaterial; t0: number; done: () => void } | null = null;
  buildBand(cfg.north, cfg.south);
  let spinning = false;
  let gridOn = cfg.grid;

  const btnGrid = document.getElementById("btn-grid") as HTMLButtonElement | null;
  const btnFs = document.getElementById("btn-fs") as HTMLButtonElement | null;
  const legend = document.getElementById("legend");

  function applyGrid(): void {
    grid.visible = gridOn;
    btnGrid?.setAttribute("aria-pressed", String(gridOn));
    if (legend) legend.hidden = !(gridOn && cfg.legend);
  }

  /** The selected position: the slot's view, or the region's auto-fit (explicit lat/lon/zoom win). */
  const home = () => ({ yaw: -Math.PI / 2 - cfg.lon * DEG, pitch: cfg.lat * DEG, distance: distanceForZoom(cfg.zoom) });
  function resetView(): void {
    // Face (lat, lon) towards the camera. See buildGrid for the axis convention.
    Object.assign(view, home());
    ease = null;
    spinning = cfg.rotate && !reducedMotion.matches && !lock?.locked;
    gridOn = cfg.grid;
    applyGrid();
  }
  /** Back to the selected position: instantly, or with a short ease (never under reduced motion). */
  function goHome(animate: boolean): void {
    const to = home();
    // Turn the short way round.
    to.yaw = view.yaw + Math.atan2(Math.sin(to.yaw - view.yaw), Math.cos(to.yaw - view.yaw));
    if (!animate || reducedMotion.matches) {
      Object.assign(view, to);
      ease = null;
    } else ease = { from: { ...view }, to, t0: performance.now() };
    invalidate();
  }
  resetView();

  /* ── Render on demand ── */
  let raf = 0;
  let dirty = true;
  let lastT = 0;
  let onScreen = true;
  const active = () => onScreen && document.visibilityState === "visible";
  const euler = new Euler(0, 0, 0, "XYZ");

  function resize(): void {
    const w = Math.max(1, stage.clientWidth);
    const h = Math.max(1, stage.clientHeight);
    renderer.setPixelRatio(dpr());
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Keep the 50° field of view across the shorter side, so the globe fits portrait iframes too
    // (and matches the poster, which is sized from min(width, height)).
    const half = Math.tan((FOV_DEG / 2) * DEG);
    camera.fov = w >= h ? FOV_DEG : (2 * Math.atan(half / camera.aspect)) / DEG;
    camera.updateProjectionMatrix();
    dirty = true;
  }

  function frame(t: number): void {
    raf = 0;
    if (!active()) {
      lastT = 0;
      return;
    }
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
    lastT = t;
    if (spinning) {
      view.yaw += SPIN_RAD_PER_S * dt;
      dirty = true;
    }
    if (ease) {
      const k = Math.min(1, Math.max(0, (t - ease.t0) / RELOCK_MS));
      const e = k * k * (3 - 2 * k);
      view.yaw = ease.from.yaw + (ease.to.yaw - ease.from.yaw) * e;
      view.pitch = ease.from.pitch + (ease.to.pitch - ease.from.pitch) * e;
      view.distance = ease.from.distance + (ease.to.distance - ease.from.distance) * e;
      dirty = true;
      if (k >= 1) {
        // Land exactly on the selected position.
        Object.assign(view, ease.to);
        ease = null;
      }
    }
    if (fade) {
      const k = reducedMotion.matches ? 1 : Math.min(1, (t - fade.t0) / FADE_MS);
      fade.mat.opacity = k;
      dirty = true;
      if (k >= 1) fade.done();
    }
    if (dirty) {
      euler.set(view.pitch, view.yaw, 0);
      world.quaternion.setFromEuler(euler);
      camera.position.set(0, 0, view.distance);
      renderer.render(scene, camera);
      fenceUpload();
      placeLabel();
      ruler.redraw();
      card?.redraw();
      placePins();
      labels?.settle(stage);
      dirty = false;
      // The view moved: once it settles, see whether it needs a sharper texture or other tiles.
      if (!spinning && !fade) onZoom();
    }
    if (spinning || fade || ease) schedule();
    else lastT = 0;
  }
  function schedule(): void {
    if (!raf && active()) raf = requestAnimationFrame(frame);
  }
  function invalidate(): void {
    dirty = true;
    schedule();
  }

  new ResizeObserver(() => {
    resize();
    invalidate();
  }).observe(stage);
  new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    if (onScreen) invalidate();
  }).observe(canvas);
  document.addEventListener("visibilitychange", () => {
    if (active()) invalidate();
  });
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches) spinning = false;
  });

  /* ── Input: direct manipulation only, no inertia ── */
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const takeOver = () => {
    spinning = false; // permanent for this visit
    touched = true;
    ease = null;
  };
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener("pointerdown", (e) => {
    // Locked: leave the gesture to the page (no capture, no preventDefault).
    if (lock?.locked) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinchDist = pinchDistance();
    canvas.style.cursor = "grabbing";
    takeOver();
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      const k = 0.005 * (view.distance / BASE_DISTANCE);
      view.yaw += (e.clientX - p.x) * k;
      view.pitch = clamp(view.pitch + (e.clientY - p.y) * k, -Math.PI / 2, Math.PI / 2);
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const d = pinchDistance();
      if (pinchDist > 0 && d > 0) view.distance = clamp((view.distance * pinchDist) / d, MIN_DISTANCE, MAX_DISTANCE);
      onZoom();
      pinchDist = d;
    }
    invalidate();
  });
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    pinchDist = pointers.size === 2 ? pinchDistance() : 0;
    if (!pointers.size) canvas.style.cursor = "";
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener(
    "wheel",
    (e) => {
      // Locked: don't preventDefault, so the wheel scrolls the page around the embed.
      if (lock?.locked) return;
      e.preventDefault();
      takeOver();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      view.distance = clamp(view.distance * Math.exp(dy * 0.0015), MIN_DISTANCE, MAX_DISTANCE);
      onZoom();
      invalidate();
    },
    { passive: false },
  );

  /* ── Controls ── */
  btnGrid?.addEventListener("click", () => {
    gridOn = !gridOn;
    applyGrid();
    invalidate();
  });
  if (btnFs) {
    if (!document.fullscreenEnabled) btnFs.hidden = true;
    btnFs.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void root.requestFullscreen().catch(() => {});
    });
  }

  // Live padding updates from the admin page's preview (same origin only, so an embedding site can't drive it).
  window.addEventListener("message", (e: MessageEvent<PreviewMessage>) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== "wge-preview") return;
    const d = e.data;
    buildBand(Number(d.north) || 0, Number(d.south) || 0);
    if (typeof d.shift === "number" && Number.isFinite(d.shift)) {
      shift = clamp(d.shift, -180, 180);
      for (const t of [globeMat.map, fade?.mat.map, overlay?.tex]) if (t) t.offset.x = -shift / 360;
      tiles?.relayout();
    }
    const pole = parseHex(d.pole);
    if (pole) poleMat.color.set(pole);
    if (typeof d.grid === "boolean") {
      gridOn = d.grid;
      applyGrid();
    }
    invalidate();
  });

  // Back/forward cache: a restored page starts fresh, like a new visit.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      lock?.set(R!.lock);
      pointers.clear();
      resetView();
      invalidate();
    }
  });

  /* ── Region: overlay, label, framing and the view lock ── */
  if (R) {
    lock = setupLock(canvas, R.lock, (locked) => {
      if (!locked) return invalidate();
      pointers.clear();
      spinning = false;
      goHome(true);
    });
    if (lock.locked) spinning = false;
    const fit = (focus = -1) => {
      if (!reg) return;
      const part = focus >= 0 ? polygonsOf(reg.geometry)[focus] : undefined;
      const f = regionFit(part ? { type: "Polygon", coordinates: part } : reg.geometry, { north: pad.north, south: pad.south, shift });
      if (!R.explicit.lon) cfg.lon = f.lon;
      if (!R.explicit.lat) cfg.lat = f.lat;
      if (!R.explicit.zoom) cfg.zoom = f.zoom;
    };
    void R.data.then((r) => {
      if (!r) {
        regionNote("Region not found");
        lock?.remove();
        return invalidate();
      }
      reg = r;
      if (R.toggle && regionKey) setupLayers(regionKey, r, visible, () => (drawRegion(), invalidate()), R.layers);
      drawRegion();
      // No inline index (the admin preview): frame it now, unless the reader already moved the view.
      if (!R.fitted) {
        fit();
        if (!touched) goHome(false);
      }
      invalidate();
    });
    let layerKey = "";
    let layerRev = -1;
    R.subscribe?.((r, centre, focus) => {
      reg = r;
      // The preview's underlays changed: new toggles.
      const k = r.members?.map((m) => m.id).join(",") ?? "";
      if (R.toggle && regionKey && (k !== layerKey || R.layers?.rev !== layerRev)) {
        layerRev = R.layers?.rev ?? -1;
        layerKey = k;
        setupLayers(regionKey, r, visible, () => (drawRegion(), invalidate()), R.layers);
      }
      repaintSoon();
      if (centre) {
        fit(focus);
        goHome(true);
        onZoom();
      }
      invalidate();
    });
  }

  /* ── Textures: 1024 first, then upgrade with a crossfade ── */
  const first = makeTexture(await decode(await ctx.firstTexture));
  globeMat.map = first;
  globeMat.needsUpdate = true;
  resize();
  renderer.initTexture(first);
  root.dataset.tex = String(cfg.textures[0].w);
  dirty = true;
  frame(performance.now());
  // Show the canvas on the frame after the first real render, so the poster crossfade has pixels to reveal.
  requestAnimationFrame(() => {
    root.classList.add("ready");
    if (root.dataset.state !== "hires") root.dataset.state = "interactive"; // a texture upgrade may already have finished
    performance.mark("wge-interactive");
  });

  /* Then a sharper texture to match what's on screen: 2048, or 4096 when zoomed in or on a large, dense
   * screen, and when zoomed in further 8192, always after the 4096 has shown (see nextTier). */
  let texW = cfg.textures[0].w;
  let upgrading = false;
  const failedTiers = new Set<number>();
  async function upgradeTexture(): Promise<void> {
    if (upgrading || fade) return;
    const pick = nextTier(cfg.textures, texW, textureWant(), texLimit);
    if (!pick) {
      root.dataset.state = "hires";
      // Past 8192: the tiles under the view (16384, then 32768), desktop only like the 8192.
      if (texW >= 8192 && cfg.tiles?.length && texLimit >= 8192) {
        tiles ??= createGlobeTiles({
          levels: cfg.tiles,
          world,
          camera,
          renderer,
          gl,
          band: () => band,
          shift: () => shift,
          anisotropy: Math.min(8, maxAniso),
          load: async (url) => decode(await fetchBlob(url)),
          invalidate,
          onShown: (w) => (root.dataset.tiles = String(w)),
        });
        void tiles.update(textureWant());
      }
      return;
    }
    upgrading = true;
    try {
      const next = makeTexture(await decode(await fetchBlob(pick.url)));
      // Clear stale errors so the check below is about this upload.
      for (let i = 0; i < 8 && gl.getError() !== gl.NO_ERROR; i++) continue;
      renderer.initTexture(next);
      // An 8192 texture can be too big for the GPU's free memory even when its size limit allows it.
      if (gl.getError() === gl.OUT_OF_MEMORY) {
        releaseTexture(next);
        throw new Error("out of GPU memory");
      }
      const mat = new MeshPhongMaterial({
        map: next,
        specular: 0x333333,
        shininess: 15,
        transparent: true,
        opacity: 0,
        depthFunc: LessEqualDepth,
        depthWrite: false,
      });
      const layer = new Mesh(geo, mat);
      layer.renderOrder = 1;
      world.add(layer);
      fade = {
        mesh: layer,
        mat,
        t0: performance.now(),
        done: () => {
          const old = globeMat.map;
          globeMat.map = next;
          globeMat.needsUpdate = true;
          world.remove(layer);
          mat.dispose();
          releaseTexture(old);
          fade = null;
          texW = pick.w;
          upgrading = false;
          root.dataset.state = "hires";
          root.dataset.tex = String(pick.w);
          void upgradeTexture(); // the next stage (8192 after 4096), or zoomed in further meanwhile?
        },
      };
      invalidate();
    } catch (e) {
      console.warn("[wge] texture upgrade failed", pick.w, e);
      root.dataset.texError = String(pick.w);
      upgrading = false;
      if (failedTiers.has(pick.w)) {
        texW = pick.w; // failed twice: don't retry this size; keep the current texture
        root.dataset.state = "hires";
      } else {
        failedTiers.add(pick.w); // a transient failure (network, memory under load) gets one retry
        setTimeout(() => void upgradeTexture(), 1500);
      }
    }
  }
  void upgradeTexture();
  // Zooming in can call for a sharper texture: look again once a zoom settles.
  let zoomTimer = 0;
  onZoom = () => {
    clearTimeout(zoomTimer);
    zoomTimer = window.setTimeout(() => {
      void upgradeTexture();
      // A region overlay re-rasterised to match the zoom (never smaller than it already is, to avoid flapping).
      if (overlay && reg && overlayWidth() > overlay.w) {
        overlay.w = overlayWidth();
        resized = true; // the old texture is dropped once the new, larger paint is in
        drawRegion();
      } else if (overlay && reg && Math.abs(overlayLineWidth(overlay.w) / drawnLineW - 1) > 0.3) {
        // Keep the borders about the same on-screen thickness as the flat map. (A repaint of a big overlay is
        // expensive, so it waits for a clear change rather than following every zoom step.)
        drawRegion();
        invalidate();
      }
    }, 250);
  };
}
