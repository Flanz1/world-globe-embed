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
 */
import {
  AmbientLight,
  BufferGeometry,
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
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
} from "three";
import { BASE_DISTANCE, FOV_DEG, MAX_DISTANCE, MIN_DISTANCE, clamp, distanceForZoom } from "../shared/params.ts";
import type { StartContext } from "./contract.ts";

const DEG = Math.PI / 180;
/** Auto-spin speed in radians per second (about 2 minutes per turn, like the desktop app). */
const SPIN_RAD_PER_S = 0.055;
const FADE_MS = 450;

/* ── Device capability, adapted from IS_MOBILE in the visualizer ──
 * The original also treated innerWidth < 768 as mobile. Inside an iframe that is
 * the iframe's width, so desktop embeds would be downgraded; viewport size is
 * handled separately below instead. */
function detectDevice() {
  const ua = navigator.userAgent;
  const mobileUA = /Android|iPhone|iPad|iPod|webOS/i.test(ua);
  const touchOnly = matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches;
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const lowMem = mem !== undefined && mem <= 4;
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
  const root = document.documentElement;
  const stage = document.getElementById("stage")!;
  const device = detectDevice();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  const renderer = new WebGLRenderer({ canvas, context: gl, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const dpr = () => Math.min(window.devicePixelRatio || 1, device.mobile ? 1.5 : 2);
  renderer.setPixelRatio(dpr());
  const maxTex = renderer.capabilities.maxTextureSize;
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
  const geo = new SphereGeometry(1, lowGeo ? 64 : 128, lowGeo ? 48 : 96);

  const makeTexture = (d: { src: ImageBitmap | HTMLImageElement; preFlipped: boolean }) => {
    const t = new Texture(d.src);
    t.colorSpace = SRGBColorSpace;
    t.flipY = !d.preFlipped;
    t.anisotropy = Math.min(8, maxAniso);
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
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
  world.add(globe, atmosphere, grid);
  scene.add(world);

  /* ── View state ── */
  const view = { yaw: 0, pitch: 0, distance: BASE_DISTANCE };
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

  function resetView(): void {
    // Face (lat, lon) towards the camera. See buildGrid for the axis convention.
    view.yaw = -Math.PI / 2 - cfg.lon * DEG;
    view.pitch = cfg.lat * DEG;
    view.distance = distanceForZoom(cfg.zoom);
    spinning = cfg.rotate && !reducedMotion.matches;
    gridOn = cfg.grid;
    applyGrid();
  }
  resetView();

  /* ── Render on demand ── */
  let raf = 0;
  let dirty = true;
  let lastT = 0;
  let onScreen = true;
  let fade: { mesh: Mesh; mat: MeshPhongMaterial; t0: number; done: () => void } | null = null;
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
      dirty = false;
    }
    if (spinning || fade) schedule();
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
  };
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener("pointerdown", (e) => {
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
      e.preventDefault();
      takeOver();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      view.distance = clamp(view.distance * Math.exp(dy * 0.0015), MIN_DISTANCE, MAX_DISTANCE);
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

  // Back/forward cache: a restored page starts fresh, like a new visit.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      resetView();
      invalidate();
    }
  });

  /* ── Textures: 1024 first, then upgrade with a crossfade ── */
  const first = makeTexture(await decode(await ctx.firstTexture));
  globeMat.map = first;
  globeMat.needsUpdate = true;
  resize();
  renderer.initTexture(first);
  dirty = true;
  frame(performance.now());
  // Show the canvas on the frame after the first real render, so the poster crossfade has pixels to reveal.
  requestAnimationFrame(() => {
    root.classList.add("ready");
    root.dataset.state = "interactive";
    performance.mark("wge-interactive");
  });

  const stageMin = Math.min(stage.clientWidth, stage.clientHeight);
  // Visible half of the map spans the globe's diameter, so texture width ≈ π × diameter in device pixels.
  const wantPx = Math.PI * stageMin * dpr();
  // 4096 only on desktop with a large, dense viewport; otherwise 2048.
  const wantW = !device.mobile && wantPx >= 3000 ? 4096 : 2048;
  const usable = cfg.textures.filter((t) => t.w > cfg.textures[0].w && t.w <= Math.min(wantW, maxTex));
  const pick = usable[usable.length - 1];
  if (!pick) {
    root.dataset.state = "hires";
    return;
  }

  try {
    const next = makeTexture(await decode(await fetchBlob(pick.url)));
    renderer.initTexture(next);
    const mat = new MeshPhongMaterial({
      map: next,
      specular: 0x333333,
      shininess: 15,
      transparent: true,
      opacity: 0,
      depthFunc: LessEqualDepth,
      depthWrite: false,
    });
    const overlay = new Mesh(geo, mat);
    overlay.renderOrder = 1;
    world.add(overlay);
    fade = {
      mesh: overlay,
      mat,
      t0: performance.now(),
      done: () => {
        const old = globeMat.map;
        globeMat.map = next;
        globeMat.needsUpdate = true;
        world.remove(overlay);
        mat.dispose();
        releaseTexture(old);
        fade = null;
        root.dataset.state = "hires";
      },
    };
    invalidate();
  } catch {
    root.dataset.state = "hires"; // keep the 1024 texture
  }
}
