(() => {
  "use strict";

  document.documentElement.classList.remove("no-js");

  // ---------- Page chrome ----------
  document.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = new Date().getFullYear();
  });

  const header = document.querySelector(".site-header");
  const onScroll = () => header && header.classList.toggle("scrolled", window.scrollY > 20);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const reveals = document.querySelectorAll(".reveal, .reveal-rule");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );
    reveals.forEach((el, i) => {
      el.style.transitionDelay = `${(i % 6) * 60}ms`;
      io.observe(el);
    });
  } else {
    reveals.forEach((el) => el.classList.add("in"));
  }

  // ---------- FIG. 1 — Orrery ----------
  initOrrery();

  function initOrrery() {
    const canvas = document.getElementById("orrery");
    const frame = document.getElementById("fig1");
    if (!canvas || !frame || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const roCoords = document.getElementById("ro-coords");
    const roProbes = document.getElementById("ro-probes");

    // Colors come from the stylesheet so the drawing can't drift from the tokens
    const css = getComputedStyle(document.documentElement);
    const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const C = {
      ink: token("--ink", "#14120F"),
      soft: token("--ink-soft", "#5B554B"),
      accent: token("--accent", "#FF4F00"),
      paper: token("--paper", "#F3EEE3"),
    };
    const inkA = (a) => `rgba(20,18,15,${a})`;
    const MONO = '500 9px "IBM Plex Mono", ui-monospace, Menlo, monospace';

    const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
    const fineMQ = matchMedia("(hover: hover) and (pointer: fine)");
    const onMQ = (mq, fn) => (mq.addEventListener ? mq.addEventListener("change", fn) : mq.addListener(fn));

    const TAU = Math.PI * 2;
    const MAX_PROBES = 4;
    const T_OUTER = 80; // seconds per revolution of the outermost body

    const S = {
      w: 0, h: 0, dpr: 1, cx: 0, cy: 0, R: 1, hair: 1,
      t: 0, last: 0, raf: 0, running: false, visible: true,
      plate: null, probeCount: 0, lastReadout: 0,
    };
    const P = { x: 0, y: 0, sx: 0, sy: 0, s: 0, inside: false };

    // Orbits: semi-major axis as a fraction of R, eccentricity, rotation. Sun sits at a focus.
    const orbits = [
      { f: 0.18, e: 0.05, rot: 0.3 },
      { f: 0.30, e: 0.09, rot: 1.9 },
      { f: 0.43, e: 0.14, rot: -0.7 },
      { f: 0.57, e: 0.07, rot: 2.6 },
      { f: 0.74, e: 0.11, rot: 0.9 },
      { f: 0.92, e: 0.16, rot: -1.4 },
    ].map((o) => ({ ...o, a: 0, b: 0, c: 0, cos: Math.cos(o.rot), sin: Math.sin(o.rot) }));

    const bodies = [
      { r: 2.2, E0: 0.4 },
      { r: 3.4, E0: 2.9 },
      { r: 4.6, E0: 5.1, accent: true, ring: true },
      { r: 3.0, E0: 1.2 },
      { r: 5.2, E0: 3.8 },
      { r: 3.6, E0: 0.0 },
    ].map((b, i) => ({
      ...b,
      orbit: orbits[i],
      // Kepler-ish: period grows with a^1.5
      omega: TAU / (T_OUTER * Math.pow(orbits[i].f / orbits[5].f, 1.5)),
      x: 0, y: 0, vx: 0, vy: 0,
    }));
    const spacedust = bodies[2];
    const probes = [];
    const tmp = [0, 0];

    const pad2 = (n) => String(n).padStart(2, "0");

    // ----- Layout -----
    function layout() {
      S.cx = S.w * 0.5;
      // Tall frames sit the sun high; square frames need it centered to clear the readout
      S.cy = S.h > S.w * 1.1 ? S.h * 0.44 : S.h * 0.5;
      S.R = 0.42 * Math.min(S.w, S.h * 0.78);
      for (const o of orbits) {
        o.a = S.R * o.f;
        o.c = o.a * o.e;
        o.b = o.a * Math.sqrt(1 - o.e * o.e);
      }
    }

    function resize() {
      const rect = canvas.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      if (!w || !h) return;
      S.w = w;
      S.h = h;
      S.dpr = Math.min(window.devicePixelRatio || 1, 3);
      S.hair = S.dpr >= 2 ? 0.75 : 1;
      canvas.width = Math.round(w * S.dpr);
      canvas.height = Math.round(h * S.dpr);
      ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
      layout();
      buildPlate();
      if (reduceMQ.matches) {
        stop();
        drawStatic();
      } else {
        start();
        if (!S.running) drawStatic();
      }
    }

    let resizeRaf = 0;
    const queueResize = () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(resize);
    };
    if ("ResizeObserver" in window) {
      new ResizeObserver(queueResize).observe(frame);
    } else {
      window.addEventListener("resize", queueResize);
      queueResize();
    }
    // Browser zoom changes devicePixelRatio without a resize event
    (function watchDpr() {
      const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      const handler = () => {
        queueResize();
        watchDpr();
      };
      if (mq.addEventListener) mq.addEventListener("change", handler, { once: true });
      else mq.addListener(handler);
    })();

    // ----- Static plate: crosshair, instrument ring, halftone moon, registration marks -----
    function buildPlate() {
      const { w, h, dpr, cx, cy, R } = S;
      const plate = document.createElement("canvas");
      plate.width = canvas.width;
      plate.height = canvas.height;
      const p = plate.getContext("2d");
      p.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Crosshair
      p.strokeStyle = inkA(0.2);
      p.lineWidth = S.hair;
      p.beginPath();
      p.moveTo(0, cy);
      p.lineTo(w, cy);
      p.moveTo(cx, 0);
      p.lineTo(cx, h);
      p.stroke();

      // Halftone moon, cropped by the bottom-right corner
      const sx = w * 0.96;
      const sy = h * 0.98;
      const Rs = (w >= 600 ? 0.34 : 0.3) * Math.min(w, h);
      const pitch = w >= 420 ? 4.5 : 4;
      const L = norm3(-0.55, -0.6, 0.58); // light from upper-left, toward the viewer
      const inv = Math.SQRT1_2;
      p.fillStyle = C.ink;
      p.beginPath();
      for (let u = -Rs; u <= Rs; u += pitch) {
        for (let v = -Rs; v <= Rs; v += pitch) {
          // 45° screen angle
          const dx = (u - v) * inv;
          const dy = (u + v) * inv;
          const d2 = dx * dx + dy * dy;
          if (d2 > Rs * Rs) continue;
          const x = sx + dx;
          const y = sy + dy;
          if (x < -pitch || y < -pitch || x > w + pitch || y > h + pitch) continue;
          const nz = Math.sqrt(1 - d2 / (Rs * Rs));
          const lam = Math.max(0, (dx / Rs) * L[0] + (dy / Rs) * L[1] + nz * L[2]);
          const dark = Math.max(0.04, 1 - (0.06 + 0.94 * lam));
          const r = 0.5 * pitch * 1.08 * Math.sqrt(dark); // dot area tracks darkness, like print
          p.moveTo(x + r, y);
          p.arc(x, y, r, 0, TAU);
        }
      }
      p.fill();
      p.strokeStyle = inkA(0.6);
      p.lineWidth = S.hair;
      p.beginPath();
      p.arc(sx, sy, Rs, 0, TAU);
      p.stroke();

      // Instrument ring: 5° ticks, labels every 30°, 0° at top
      p.strokeStyle = inkA(0.35);
      p.lineWidth = S.hair;
      p.beginPath();
      p.arc(cx, cy, R, 0, TAU);
      p.stroke();
      p.strokeStyle = inkA(0.6);
      p.beginPath();
      for (let i = 0; i < 72; i++) {
        const ang = (i * 5 * Math.PI) / 180;
        const len = i % 6 === 0 ? 10 : i % 3 === 0 ? 7 : 4;
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        p.moveTo(cx + ca * R, cy + sa * R);
        p.lineTo(cx + ca * (R - len), cy + sa * (R - len));
      }
      p.stroke();
      p.font = MONO;
      p.textAlign = "center";
      p.textBaseline = "middle";
      if ("letterSpacing" in p) p.letterSpacing = "0.08em";
      for (let deg = 0; deg < 360; deg += 30) {
        const ang = ((deg - 90) * Math.PI) / 180;
        const x = cx + Math.cos(ang) * (R + 15);
        const y = cy + Math.sin(ang) * (R + 15);
        const label = `${String(deg).padStart(3, "0")}°`;
        const tw = p.measureText(label).width;
        p.fillStyle = C.paper;
        p.fillRect(x - tw / 2 - 2, y - 6, tw + 4, 12);
        p.fillStyle = C.soft;
        p.fillText(label, x, y);
      }

      // Registration marks
      p.strokeStyle = inkA(0.5);
      p.lineWidth = 1;
      p.beginPath();
      const m = 8;
      const l = 8;
      [[m, m, 1, 1], [w - m, m, -1, 1], [m, h - m, 1, -1], [w - m, h - m, -1, -1]].forEach(([x, y, dx, dy]) => {
        p.moveTo(x, y + dy * l);
        p.lineTo(x, y);
        p.lineTo(x + dx * l, y);
      });
      p.stroke();

      S.plate = plate;
    }

    // Rebuild the plate once the real mono font is in; never block the first paint on it
    if (document.fonts) {
      const refresh = () => {
        if (!S.w) return;
        buildPlate();
        if (!S.running) drawStatic();
      };
      document.fonts.load(MONO).then(refresh).catch(() => {});
      document.fonts.ready.then(refresh);
    }

    // ----- Geometry -----
    function bodyPos(b, t) {
      const o = b.orbit;
      const E = b.E0 + b.omega * t;
      const ox = o.a * Math.cos(E) - o.c;
      const oy = o.b * Math.sin(E);
      const vx0 = -o.a * Math.sin(E);
      const vy0 = o.b * Math.cos(E);
      b.x = S.cx + ox * o.cos - oy * o.sin;
      b.y = S.cy + ox * o.sin + oy * o.cos;
      b.vx = vx0 * o.cos - vy0 * o.sin;
      b.vy = vx0 * o.sin + vy0 * o.cos;
    }

    // Gaussian pull toward the smoothed pointer; vanishes at the pointer itself
    function lens(x, y, out) {
      if (P.s <= 0.001) {
        out[0] = x;
        out[1] = y;
        return out;
      }
      const dx = P.sx - x;
      const dy = P.sy - y;
      const sig = 0.32 * S.R;
      const g = Math.exp(-(dx * dx + dy * dy) / (2 * sig * sig));
      const k = 0.26 * P.s * g;
      out[0] = x + dx * k;
      out[1] = y + dy * k;
      return out;
    }

    function drawOrbit(o, n) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const E = (i / n) * TAU;
        const ox = o.a * Math.cos(E) - o.c;
        const oy = o.b * Math.sin(E);
        lens(S.cx + ox * o.cos - oy * o.sin, S.cy + ox * o.sin + oy * o.cos, tmp);
        if (i === 0) ctx.moveTo(tmp[0], tmp[1]);
        else ctx.lineTo(tmp[0], tmp[1]);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // ----- Frame -----
    function drawFrame(dt) {
      const { w, h, cx, cy } = S;
      ctx.clearRect(0, 0, w, h);
      if (S.plate) ctx.drawImage(S.plate, 0, 0, w, h);

      const want = P.inside && fineMQ.matches && !reduceMQ.matches ? 1 : 0;
      if (dt > 0) {
        const k1 = 1 - Math.exp(-6 * dt);
        const k2 = 1 - Math.exp(-4 * dt);
        P.sx += (P.x - P.sx) * k1;
        P.sy += (P.y - P.sy) * k1;
        P.s += (want - P.s) * k2;
      } else {
        P.sx = P.x;
        P.sy = P.y;
        P.s = want;
      }

      // Orbits
      ctx.save();
      ctx.setLineDash([2, 4]);
      ctx.lineWidth = S.hair;
      ctx.strokeStyle = inkA(0.55);
      const n = w < 420 ? 48 : 72;
      for (const o of orbits) drawOrbit(o, n);
      ctx.restore();

      // Bodies
      for (const b of bodies) {
        bodyPos(b, S.t);
        lens(b.x, b.y, tmp);
        const x = tmp[0];
        const y = tmp[1];
        if (b.accent) {
          // Ring back half, disc, ring front half
          ctx.strokeStyle = C.ink;
          ctx.lineWidth = S.hair;
          ctx.beginPath();
          ctx.ellipse(x, y, b.r * 2.2, b.r * 0.8, -0.4, Math.PI, TAU);
          ctx.stroke();
          ctx.fillStyle = C.accent;
          ctx.beginPath();
          ctx.arc(x, y, b.r, 0, TAU);
          ctx.fill();
          ctx.beginPath();
          ctx.ellipse(x, y, b.r * 2.2, b.r * 0.8, -0.4, 0, Math.PI);
          ctx.stroke();
          ctx.font = MONO;
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          if ("letterSpacing" in ctx) ctx.letterSpacing = "0.08em";
          ctx.fillStyle = C.soft;
          ctx.fillText("SPACEDUST", x + 11, y + 6);
        } else {
          ctx.fillStyle = C.ink;
          ctx.beginPath();
          ctx.arc(x, y, b.r, 0, TAU);
          ctx.fill();
        }
      }

      // Sun: paper knockout clears the crosshair, then the ink disc
      ctx.fillStyle = C.paper;
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, TAU);
      ctx.fill();
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, TAU);
      ctx.fill();

      // Probes
      const now = performance.now();
      for (let i = probes.length - 1; i >= 0; i--) {
        const pr = probes[i];
        const age = (now - pr.t0) / 1000;
        let u = 1;
        let alpha = 1;
        if (age < pr.dur) u = 1 - Math.pow(1 - age / pr.dur, 2.2);
        else if (age < pr.dur + 2.5) u = 1;
        else if (age < pr.dur + 4) alpha = 1 - (age - pr.dur - 2.5) / 1.5;
        else {
          probes.splice(i, 1);
          continue;
        }
        drawProbe(pr, u, alpha);
      }
    }

    function drawProbe(pr, u, alpha) {
      const pts = pr.pts;
      const n = pts.length - 1;
      const head = u * n;
      const hi = Math.min(n, Math.floor(head));
      const frac = head - hi;
      ctx.save();
      ctx.globalAlpha = alpha;

      ctx.strokeStyle = C.ink;
      ctx.lineWidth = S.hair;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i <= hi; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      let hx = pts[hi][0];
      let hy = pts[hi][1];
      if (hi < n) {
        hx += (pts[hi + 1][0] - hx) * frac;
        hy += (pts[hi + 1][1] - hy) * frac;
        ctx.lineTo(hx, hy);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.arc(hx, hy, 2, 0, TAU);
      ctx.fill();

      const [tx, ty] = pr.target;
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(tx, ty, 4, 0, TAU);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tx - 9, ty); ctx.lineTo(tx - 5, ty);
      ctx.moveTo(tx + 5, ty); ctx.lineTo(tx + 9, ty);
      ctx.moveTo(tx, ty - 9); ctx.lineTo(tx, ty - 5);
      ctx.moveTo(tx, ty + 5); ctx.lineTo(tx, ty + 9);
      ctx.stroke();

      if (u >= 1) {
        ctx.font = MONO;
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        if ("letterSpacing" in ctx) ctx.letterSpacing = "0.08em";
        const tw = ctx.measureText(pr.label).width;
        const flip = tx + 14 + tw > S.w - 12;
        const lx = flip ? tx - 14 - tw : tx + 14;
        ctx.fillStyle = C.paper;
        ctx.fillRect(lx - 3, ty - 7, tw + 6, 14);
        ctx.fillStyle = C.ink;
        ctx.fillText(pr.label, lx, ty);
      }
      ctx.restore();
    }

    function drawStatic() {
      drawFrame(0);
      S.lastReadout = 0;
      updateReadout(performance.now());
    }

    // ----- Probes -----
    function launch(tx, ty) {
      if (!S.w) return;
      tx = Math.min(Math.max(tx, 10), S.w - 10);
      ty = Math.min(Math.max(ty, 10), S.h - 10);
      bodyPos(spacedust, S.t);
      const x0 = spacedust.x;
      const y0 = spacedust.y;
      const dx = tx - x0;
      const dy = ty - y0;
      const L = Math.hypot(dx, dy) || 1;
      const ux = dx / L;
      const uy = dy / L;
      const nx = -uy;
      const ny = ux;
      const vl = Math.hypot(spacedust.vx, spacedust.vy) || 1;
      const vx = spacedust.vx / vl;
      const vy = spacedust.vy / vl;
      // Bow the arc toward the sun
      const side = Math.sign(dx * (S.cy - y0) - dy * (S.cx - x0)) || 1;
      const p1x = x0 + vx * 0.35 * L;
      const p1y = y0 + vy * 0.35 * L;
      const p2x = tx - ux * 0.25 * L + nx * side * 0.3 * L;
      const p2y = ty - uy * 0.25 * L + ny * side * 0.3 * L;
      const pts = [];
      for (let i = 0; i <= 48; i++) {
        const s = i / 48;
        const m = 1 - s;
        pts.push([
          m * m * m * x0 + 3 * m * m * s * p1x + 3 * m * s * s * p2x + s * s * s * tx,
          m * m * m * y0 + 3 * m * m * s * p1y + 3 * m * s * s * p2y + s * s * s * ty,
        ]);
      }
      S.probeCount++;
      const dv = (1.6 + (2.6 * L) / S.R).toFixed(1);
      probes.push({
        pts,
        target: [tx, ty],
        t0: performance.now(),
        dur: reduceMQ.matches ? 0 : Math.min(2.4, Math.max(1, 0.9 + L / 300)),
        label: `PROBE ${pad2(S.probeCount)} · Δv ${dv} km/s`,
      });
      if (probes.length > MAX_PROBES) probes.shift();
      if (roProbes) roProbes.textContent = `Probes ${pad2(S.probeCount)}`;
      start();
    }

    // ----- Readout -----
    function updateReadout(now) {
      if (!roCoords || now - S.lastReadout < 120) return;
      S.lastReadout = now;
      let px;
      let py;
      if (P.inside && P.s > 0.05) {
        px = P.sx;
        py = P.sy;
      } else {
        bodyPos(spacedust, S.t);
        px = spacedust.x;
        py = spacedust.y;
      }
      const dx = px - S.cx;
      const dy = py - S.cy;
      const raH = ((Math.atan2(dy, dx) + Math.PI) / TAU) * 24;
      const hh = Math.floor(raH) % 24;
      const mm = Math.floor((raH - Math.floor(raH)) * 60);
      const dec = Math.max(-89, Math.min(89, Math.round((0.5 - Math.hypot(dx, dy) / S.R) * 90)));
      roCoords.textContent = `RA ${pad2(hh)}h ${pad2(mm)}m · DEC ${dec < 0 ? "−" : "+"}${pad2(Math.abs(dec))}°`;
    }

    // ----- Loop -----
    function tick(now) {
      if (!S.running) return;
      const dt = Math.min(now - S.last, 50) / 1000;
      S.last = now;
      if (!reduceMQ.matches) S.t += dt;
      drawFrame(dt);
      updateReadout(now);
      // Under reduced motion the loop only lives while a probe is fading out
      if (reduceMQ.matches && probes.length === 0) {
        S.running = false;
        return;
      }
      S.raf = requestAnimationFrame(tick);
    }
    function start() {
      if (S.running || !S.visible || document.hidden) return;
      S.running = true;
      S.last = performance.now();
      S.raf = requestAnimationFrame(tick);
    }
    function stop() {
      S.running = false;
      cancelAnimationFrame(S.raf);
    }

    if ("IntersectionObserver" in window) {
      new IntersectionObserver(([entry]) => {
        S.visible = entry.isIntersecting;
        if (S.visible) start();
        else stop();
      }).observe(frame);
    }
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stop();
      else start();
    });
    onMQ(reduceMQ, () => {
      if (reduceMQ.matches) {
        stop();
        drawStatic();
      } else {
        start();
      }
    });

    // ----- Input -----
    const localXY = (e) => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    frame.addEventListener(
      "pointermove",
      (e) => {
        const [x, y] = localXY(e);
        P.x = x;
        P.y = y;
        P.inside = e.pointerType !== "touch";
      },
      { passive: true }
    );
    frame.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "touch") return;
      const [x, y] = localXY(e);
      P.x = P.sx = x;
      P.y = P.sy = y;
      P.inside = true;
    });
    frame.addEventListener("pointerleave", () => {
      P.inside = false;
    });
    // click (not pointerdown) so a touch scroll over the figure never launches
    frame.addEventListener("click", (e) => {
      const [x, y] = localXY(e);
      launch(x, y);
    });
    frame.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      launch(S.w * (0.2 + Math.random() * 0.6), S.h * (0.2 + Math.random() * 0.6));
    });

    function norm3(x, y, z) {
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    }
  }
})();
