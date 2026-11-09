/**
 * The flat (2D) viewer for view=flat. No Three.js: a canvas that draws the map image in its own
 * frame, cropped to the region with a margin, with the region filled and outlined on top. It wraps
 * horizontally, so regions across the antimeridian are drawn whole.
 *
 * Motion model, same as the globe: no inertia or drift, nothing persists, pageshow.persisted resets.
 * Region embeds start locked on the region; unlocked, drag pans and wheel/pinch zoom.
 */
import { clamp, clampPadding } from "../shared/params.ts";
import { geometryBounds, globeToImage, sphericalCentroid, type Position } from "../shared/geo.ts";
import { FLAT_K_MAX, flatFit, flatMinK, type FlatView, type RegionData } from "../shared/region.ts";
import { paintRegion } from "../shared/raster.ts";
import type { FlatStartContext } from "./contract.ts";
import { RELOCK_MS, makeLabel, regionNote, setupLock, type Lock } from "./region-ui.ts";

type Img = ImageBitmap | HTMLImageElement;

async function decode(blob: Blob): Promise<Img> {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob);
    } catch {
      /* fall through */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function start(ctx: FlatStartContext): Promise<void> {
  const { cfg, canvas } = ctx;
  const R = ctx.region;
  const root = document.documentElement;
  const stage = document.getElementById("stage")!;
  const g = canvas.getContext("2d", { alpha: true })!;
  const aspect = cfg.aspect ?? 2;
  const ky = 2 / aspect;
  const mobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent) || (matchMedia("(pointer: coarse)").matches && !matchMedia("(any-pointer: fine)").matches);
  const dpr = () => Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const size = () => ({ w: Math.max(1, stage.clientWidth), h: Math.max(1, stage.clientHeight) });

  let img: Img | null = null;
  let imgW = 0;
  let reg: RegionData | null = null;
  let regCentre: Position | null = null;
  let gridOn = cfg.grid;
  let lock: Lock | null = null;
  /** The reader moved the view this visit (so live updates and resizes don't yank it back). */
  let touched = false;

  /* ── Framing: same flatFit as the boot script's poster, so the crossfade lines up ── */
  let bounds: [number, number, number, number] = R?.bounds ?? [-180, -90, 180, 90];
  const home = (): FlatView => {
    const { w, h } = size();
    const v = flatFit(bounds, aspect, w, h);
    if (R?.explicit.lon) v.cx = cfg.lon;
    if (R?.explicit.lat) v.cy = cfg.lat;
    if (R?.explicit.zoom) v.k = clamp(v.k * cfg.zoom, flatMinK(aspect, w, h), FLAT_K_MAX);
    return v;
  };
  const view: FlatView = home();
  let ease: { from: FlatView; to: FlatView; t0: number } | null = null;

  const sx = (lon: number, w: number) => (lon - view.cx) * view.k + w / 2;
  const sy = (lat: number, h: number) => (view.cy - lat) * view.k * ky + h / 2;
  const limit = () => {
    const { w, h } = size();
    view.k = clamp(view.k, flatMinK(aspect, w, h), FLAT_K_MAX);
    // Keep some of the map on screen vertically; horizontally it repeats forever.
    view.cy = clamp(view.cy, -90, 90);
    if (view.cx > 540 || view.cx < -540) view.cx = ((((view.cx + 180) % 360) + 360) % 360) - 180;
  };

  /* ── Render on demand ── */
  let raf = 0;
  function render(): void {
    raf = 0;
    if (ease) {
      const k = Math.min(1, (performance.now() - ease.t0) / RELOCK_MS);
      const e = k * k * (3 - 2 * k);
      view.cx = ease.from.cx + (ease.to.cx - ease.from.cx) * e;
      view.cy = ease.from.cy + (ease.to.cy - ease.from.cy) * e;
      view.k = ease.from.k * Math.pow(ease.to.k / ease.from.k, e);
      if (k >= 1) {
        // Land exactly on the selected position.
        Object.assign(view, ease.to);
        ease = null;
      } else schedule();
    }
    const { w, h } = size();
    const d = dpr();
    if (canvas.width !== Math.round(w * d) || canvas.height !== Math.round(h * d)) {
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(h * d);
    }
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    const span = 360 * view.k;
    const top = sy(90, h);
    const height = 180 * view.k * ky;
    // Copies of the map (and the region) left and right of the main one, as many as the view needs.
    const offsets: number[] = [];
    const first = Math.floor((0 - sx(-180, w)) / span);
    const last = Math.floor((w - sx(-180, w)) / span);
    for (let n = first; n <= last; n++) offsets.push(n * 360);
    if (img) {
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      for (const off of offsets) g.drawImage(img, sx(-180 + off, w), top, span, height);
    }
    if (gridOn) drawGrid(w, h, offsets);
    if (reg) {
      // A region may unwrap up to 180° either side of its first vertex, so draw one copy more each way.
      const all = [offsets[0] - 360, ...offsets, offsets[offsets.length - 1] + 360];
      paintRegion(g, reg.geometry, (lon) => sx(lon, w), (lat) => sy(lat, h), all, {
        color: reg.color,
        fillOpacity: reg.fillOpacity,
        lineWidth: 2,
        dim: !!R?.dim,
      }, { w, h });
    }
    if (label && regCentre) {
      // The copy of the centroid nearest the middle of the view.
      const lon = regCentre[0] + 360 * Math.round((view.cx - regCentre[0]) / 360);
      const x = sx(lon, w);
      const y = sy(regCentre[1], h);
      label.place(x, y, x >= 0 && x <= w && y >= 0 && y <= h);
    }
    maybeUpgrade();
  }
  function schedule(): void {
    if (!raf) raf = requestAnimationFrame(render);
  }

  /** The globe's grid (15°, after padding and shift), drawn where it falls on the map image. */
  function drawGrid(w: number, h: number, offsets: number[]): void {
    const { north, south } = clampPadding(cfg.north, cfg.south);
    const f = { north, south, shift: cfg.shift };
    g.save();
    g.lineWidth = 1;
    for (let lat = -75; lat <= 75; lat += 15) {
      const il = globeToImage([0, lat], f)[1];
      if (il < -90 || il > 90) continue;
      g.strokeStyle = lat === 0 ? "rgba(232,196,74,.7)" : lat % 30 === 0 ? "rgba(201,169,78,.35)" : "rgba(201,169,78,.18)";
      g.beginPath();
      g.moveTo(0, sy(il, h));
      g.lineTo(w, sy(il, h));
      g.stroke();
    }
    for (let lon = -180; lon < 180; lon += 15) {
      const x0 = globeToImage([lon, 0], f)[0];
      g.strokeStyle = lon === 0 ? "rgba(232,80,80,.6)" : lon % 30 === 0 ? "rgba(201,169,78,.35)" : "rgba(201,169,78,.18)";
      for (const off of [...offsets, offsets[offsets.length - 1] + 360]) {
        const x = sx(x0 + off, w);
        g.beginPath();
        g.moveTo(x, sy(90, h));
        g.lineTo(x, sy(-90, h));
        g.stroke();
      }
    }
    g.restore();
  }

  /* ── Textures: the 1024 the boot script already fetched, then 2048, or 4096 when the crop is small on a big screen ── */
  let loading = false;
  function maybeUpgrade(): void {
    if (loading || !img) return;
    const needPx = 360 * view.k * dpr();
    const want = needPx > 2600 && !mobile ? 4096 : 2048;
    const pick = cfg.textures.filter((t) => t.w > imgW && t.w <= want).pop();
    if (!pick) return;
    loading = true;
    void fetch(pick.url)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.blob();
      })
      .then(decode)
      .then((next) => {
        const old = img;
        img = next;
        imgW = pick.w;
        if (old && "close" in old) old.close();
        loading = false;
        root.dataset.state = "hires";
        schedule();
      })
      .catch(() => {
        imgW = pick.w; // don't retry this size
        loading = false;
        root.dataset.state = "hires";
      });
  }

  /* ── Input: direct manipulation only, while unlocked ── */
  const pointers = new Map<number, { x: number; y: number }>();
  let pinchDist = 0;
  const pinchDistance = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const zoomAt = (factor: number, x: number, y: number) => {
    const { w, h } = size();
    const lon = view.cx + (x - w / 2) / view.k;
    const lat = view.cy - (y - h / 2) / (view.k * ky);
    view.k *= factor;
    limit();
    view.cx = lon - (x - w / 2) / view.k;
    view.cy = lat + (y - h / 2) / (view.k * ky);
    limit();
  };
  const local = (e: { clientX: number; clientY: number }) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (lock?.locked) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) pinchDist = pinchDistance();
    canvas.style.cursor = "grabbing";
    ease = null;
    touched = true;
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
      view.cx -= (e.clientX - p.x) / view.k;
      view.cy += (e.clientY - p.y) / (view.k * ky);
      limit();
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (pointers.size === 2) {
      const d = pinchDistance();
      if (pinchDist > 0 && d > 0) {
        const [a, b] = [...pointers.values()];
        const m = local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
        zoomAt(d / pinchDist, m.x, m.y);
      }
      pinchDist = d;
    }
    schedule();
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
      // Locked: no preventDefault, so the page around the embed scrolls.
      if (lock?.locked) return;
      e.preventDefault();
      ease = null;
      touched = true;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const m = local(e);
      zoomAt(Math.exp(-dy * 0.0015), m.x, m.y);
      schedule();
    },
    { passive: false },
  );

  /* ── Controls ── */
  const btnGrid = document.getElementById("btn-grid");
  const btnFs = document.getElementById("btn-fs") as HTMLButtonElement | null;
  const applyGrid = () => btnGrid?.setAttribute("aria-pressed", String(gridOn));
  applyGrid();
  btnGrid?.addEventListener("click", () => {
    gridOn = !gridOn;
    applyGrid();
    schedule();
  });
  if (btnFs) {
    if (!document.fullscreenEnabled) btnFs.hidden = true;
    btnFs.addEventListener("click", () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void root.requestFullscreen().catch(() => {});
    });
  }

  const goHome = (animate: boolean) => {
    const to = home();
    // Pan the short way round.
    to.cx = view.cx + ((((to.cx - view.cx + 180) % 360) + 360) % 360) - 180;
    if (!animate || reduced.matches) {
      Object.assign(view, to);
      ease = null;
    } else ease = { from: { ...view }, to, t0: performance.now() };
    schedule();
  };

  const label = R ? makeLabel(stage) : null;
  if (R) {
    lock = setupLock(canvas, R.lock, (locked) => {
      if (!locked) return;
      pointers.clear();
      goHome(true);
    });
    const setRegion = (r: RegionData) => {
      reg = r;
      regCentre = sphericalCentroid(r.geometry);
      label?.setText((R.label ?? r.label) ? r.name : "");
    };
    const fitTo = (r: RegionData, animate: boolean) => {
      // Same bounds the page generator inlines, recomputed (the admin preview has no index).
      bounds = geometryBounds(r.geometry);
      goHome(animate);
    };
    void R.data.then((r) => {
      if (!r) {
        regionNote("Region not found");
        lock?.remove();
        return schedule();
      }
      setRegion(r);
      if (!R.fitted && !touched) fitTo(r, false);
      schedule();
    });
    R.subscribe?.((r, centre) => {
      setRegion(r);
      if (centre) fitTo(r, true);
      schedule();
    });
  }

  new ResizeObserver(() => {
    if (lock?.locked || !touched) Object.assign(view, home());
    limit();
    schedule();
  }).observe(stage);

  // Back/forward cache: a restored page starts fresh, like a new visit.
  window.addEventListener("pageshow", (e) => {
    if (!e.persisted) return;
    lock?.set(R!.lock);
    pointers.clear();
    touched = false;
    gridOn = cfg.grid;
    applyGrid();
    goHome(false);
  });

  img = await decode(await ctx.firstTexture);
  imgW = cfg.textures[0].w;
  render();
  requestAnimationFrame(() => {
    root.classList.add("ready");
    root.dataset.state = "interactive";
    performance.mark("wge-interactive");
  });
}
