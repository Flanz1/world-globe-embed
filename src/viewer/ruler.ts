/**
 * The embed's ruler: a reader tool (corner button) that measures distance along the globe's surface and the
 * area of a shape, in km or miles, using the world radius an admin set for the slot. Shared by the globe and
 * the flat viewer: each hands over how to turn a screen point into a globe position and back.
 * Positions are [lon, lat] on the globe (after pole padding and prime meridian shift).
 */
import type { Position } from "../shared/geo.ts";
import { formatArea, formatLength, formatPercent, geodesic, perimeterKm, pathKm, ringAreaKm2, ringSphereFraction, validRadius, distanceKm, type DistUnit } from "../shared/measure.ts";

export interface RulerHost {
  /** The viewer's canvas: clicks on it place points (drags still move the view). */
  canvas: HTMLCanvasElement;
  stage: HTMLElement;
  /** Globe position under a stage-local point, or null when it isn't on the map (sky, polar cap). */
  pick(x: number, y: number): Position | null;
  /** Stage-local position of a globe position. `nearX` (previous point) lets the flat map choose the repeat of the map. */
  project(p: Position, nearX?: number): { x: number; y: number; ok: boolean };
}

export interface Ruler {
  redraw(): void;
  /** The host's pick, for other tools that read a position off the map (the region card). */
  pick: RulerHost["pick"];
  /** Likewise the host's project. */
  project: RulerHost["project"];
}

const CSS = `
#globe[data-ruler=on]{cursor:crosshair}
.rl-cv{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.rl{position:absolute;right:8px;top:8px;display:grid;gap:6px;padding:6px;max-width:min(260px,calc(100% - 16px));border-radius:6px;background:rgba(20,18,14,.72);color:#f3ead8;font:12px/1.3 system-ui,sans-serif}
.rl[hidden]{display:none}
.rl-row{display:flex;gap:4px;flex-wrap:wrap}
.rl button{all:unset;box-sizing:border-box;padding:3px 8px;border-radius:5px;cursor:pointer;background:rgba(255,255,255,.1)}
.rl button:focus-visible{outline:2px solid #c9a94e}
.rl button[aria-pressed=true]{background:#c9a94e;color:#1a1710}
.rl button:disabled{opacity:.4;cursor:default}
.rl output{display:block;min-height:1.3em}
`;

export function setupRuler(cfg: { radius: number; controls: boolean }, host: RulerHost): Ruler {
  const btn = document.getElementById("btn-ruler") as HTMLButtonElement | null;
  let radius = validRadius(cfg.radius) ? cfg.radius : 0;
  let on = false;
  let mode: "dist" | "area" = "dist";
  let unit: DistUnit = "km";
  let pts: Position[] = [];

  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.append(style);
  const cv = document.createElement("canvas");
  cv.className = "rl-cv";
  cv.setAttribute("aria-hidden", "true");
  const panel = document.createElement("div");
  panel.className = "rl";
  panel.hidden = true;
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", "Ruler");
  const mk = (text: string, title: string, fn: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.title = title;
    b.addEventListener("click", fn);
    return b;
  };
  const bDist = mk("Distance", "Measure a distance along the surface", () => setMode("dist"));
  const bArea = mk("Area", "Measure the area of a shape", () => setMode("area"));
  const bUnit = mk("km", "Switch between kilometres and miles", () => {
    unit = unit === "km" ? "mi" : "km";
    update();
  });
  const out = document.createElement("output");
  out.setAttribute("aria-live", "polite");
  const bUndo = mk("Undo", "Remove the last point", () => {
    pts.pop();
    update();
  });
  const bClear = mk("Clear", "Remove all points", () => {
    pts = [];
    update();
  });
  const row1 = document.createElement("div");
  row1.className = "rl-row";
  row1.append(bDist, bArea, bUnit);
  const row2 = document.createElement("div");
  row2.className = "rl-row";
  row2.append(bUndo, bClear);
  panel.append(row1, out, row2);
  // Clicks and drags on the panel shouldn't reach the viewer under it.
  for (const t of ["pointerdown", "wheel"] as const) panel.addEventListener(t, (e) => e.stopPropagation());
  host.stage.append(cv, panel);

  function setMode(m: "dist" | "area"): void {
    mode = m;
    update();
  }

  function update(): void {
    bDist.setAttribute("aria-pressed", String(mode === "dist"));
    bArea.setAttribute("aria-pressed", String(mode === "area"));
    bUnit.textContent = unit;
    bUndo.disabled = bClear.disabled = !pts.length;
    if (!radius) out.textContent = "";
    else if (mode === "dist") {
      if (pts.length < 2) out.textContent = "Click the map to place points.";
      else {
        const total = pathKm(pts, radius);
        out.textContent = `Distance: ${formatLength(total, unit)}` + (pts.length > 2 ? ` (last leg ${formatLength(distanceKm(pts[pts.length - 2], pts[pts.length - 1], radius), unit)})` : "");
      }
    } else if (pts.length < 3) out.textContent = "Click the map to outline a shape (3 points or more).";
    else
      out.textContent = `Area: ${formatArea(ringAreaKm2(pts, radius), unit)} (${formatPercent(ringSphereFraction(pts))} of the world). Perimeter: ${formatLength(perimeterKm(pts, radius), unit)}`;
    draw();
  }

  let painted = false;
  function draw(): void {
    // Nothing to show and nothing left over from before: leave the canvas (and the layout) alone.
    if (!painted && (!on || !pts.length)) return;
    const w = Math.max(1, host.stage.clientWidth);
    const h = Math.max(1, host.stage.clientHeight);
    const d = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) {
      cv.width = Math.round(w * d);
      cv.height = Math.round(h * d);
    }
    const g = cv.getContext("2d")!;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, h);
    painted = on && pts.length > 0;
    if (!painted) return;
    const closed = mode === "area" && pts.length >= 3;
    // The outline: every leg as a great circle, so it bends the way a real route does.
    const trace: { x: number; y: number; ok: boolean }[][] = [];
    let allOk = true;
    let prevX: number | undefined;
    const legs = pts.length > 1 ? pts.length - (closed ? 0 : 1) : 0;
    for (let i = 0; i < legs; i++) {
      const line = geodesic(pts[i], pts[(i + 1) % pts.length]).map((p) => {
        const s = host.project(p, prevX);
        prevX = s.x;
        if (!s.ok) allOk = false;
        return s;
      });
      trace.push(line);
    }
    const stroke = (width: number, color: string) => {
      g.lineWidth = width;
      g.strokeStyle = color;
      g.lineJoin = g.lineCap = "round";
      for (const line of trace) {
        g.beginPath();
        let pen = false;
        for (const s of line) {
          if (!s.ok) pen = false;
          else if (pen) g.lineTo(s.x, s.y);
          else {
            g.moveTo(s.x, s.y);
            pen = true;
          }
        }
        g.stroke();
      }
    };
    if (closed && allOk) {
      g.beginPath();
      trace.forEach((line, i) => line.forEach((s, j) => (i === 0 && j === 0 ? g.moveTo(s.x, s.y) : g.lineTo(s.x, s.y))));
      g.closePath();
      g.fillStyle = "rgba(255,211,106,.22)";
      g.fill();
    }
    stroke(4.5, "rgba(20,18,14,.7)");
    stroke(2, "#ffd36a");
    prevX = undefined;
    for (const p of pts) {
      const s = host.project(p, prevX);
      prevX = s.x;
      if (!s.ok) continue;
      g.beginPath();
      g.arc(s.x, s.y, 4, 0, Math.PI * 2);
      g.fillStyle = "#ffd36a";
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = "rgba(20,18,14,.85)";
      g.stroke();
    }
  }

  function setOn(v: boolean): void {
    on = v && !!radius;
    panel.hidden = !on;
    btn?.setAttribute("aria-pressed", String(on));
    host.canvas.dataset.ruler = on ? "on" : "off";
    if (!on) pts = [];
    update();
  }

  /** Show or hide the button for the current radius (the admin preview changes it live). */
  function applyRadius(): void {
    if (btn) btn.hidden = !cfg.controls || !radius;
    if (!radius && on) setOn(false);
    else update();
  }

  btn?.addEventListener("click", () => setOn(!on));
  window.addEventListener("keydown", (e) => {
    if (on && e.key === "Escape") setOn(false);
  });

  // A click is a press and release in nearly the same place, so drags (and pinches) still move the view.
  const down = new Map<number, { x: number; y: number; t: number }>();
  let multi = false;
  host.canvas.addEventListener("pointerdown", (e) => {
    if (down.size) multi = true;
    down.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  });
  const release = (e: PointerEvent, click: boolean) => {
    const s = down.get(e.pointerId);
    down.delete(e.pointerId);
    if (down.size) return;
    const wasMulti = multi;
    multi = false;
    if (!click || !s || wasMulti || !on || e.button > 0) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 6 || performance.now() - s.t > 700) return;
    const r = host.canvas.getBoundingClientRect();
    const p = host.pick(e.clientX - r.left, e.clientY - r.top);
    if (!p) return;
    pts.push(p);
    update();
  };
  host.canvas.addEventListener("pointerup", (e) => release(e, true));
  host.canvas.addEventListener("pointercancel", (e) => release(e, false));

  // Admin preview: the radius field above the iframe updates the ruler live.
  window.addEventListener("message", (e: MessageEvent) => {
    if (e.origin !== location.origin || e.source !== window.parent || e.data?.type !== "wge-preview" || !("radius" in e.data)) return;
    const v = e.data.radius;
    radius = validRadius(v) ? v : 0;
    applyRadius();
  });

  applyRadius();
  return { redraw: draw, pick: host.pick, project: host.project };
}
