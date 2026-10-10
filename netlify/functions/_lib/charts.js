/* ============================================================
   GRAPHIQUES DU RAPPORT — SVG construit à la main → PNG (resvg)
   Gmail n'affiche ni SVG ni JS : on envoie des PNG en pièces
   jointes inline (cid:). Rendu à 2× pour l'écran du téléphone.
   ============================================================ */
const fs = require("fs");
const SC = require("./score.js");
const path = require("path");

const C = {
  bg: "#141416", grid: "#2a2a30", txt: "#f0f0f0", mut: "#8a8a96",
  acc: "#e8ff47", acc2: "#ff6b35", grn: "#4ade80", red: "#f87171", bar: "#3a3a42",
};
let GID = Math.floor(Math.random() * 1e6);
const W = 400; // largeur logique : texte lisible sur téléphone (image affichée à 100 %)

/* ---------- Rendu PNG ---------- */
let RESVG = null, FONTFILES = null, RENDER_ERR = null;
function loadRenderer() {
  if (RESVG || RENDER_ERR) return RESVG;
  try {
    RESVG = require("@resvg/resvg-js").Resvg;
    const fonts = require("./fonts.js");
    const dir = path.join(require("os").tmpdir(), "lvfonts");
    fs.mkdirSync(dir, { recursive: true });
    FONTFILES = Object.keys(fonts).map((f) => {
      const p = path.join(dir, f);
      if (!fs.existsSync(p)) fs.writeFileSync(p, Buffer.from(fonts[f], "base64"));
      return p;
    });
  } catch (e) { RENDER_ERR = e.message; RESVG = null; }
  return RESVG;
}
function toPNG(svg) {
  const R = loadRenderer();
  if (!R) throw new Error("rendu PNG indisponible : " + RENDER_ERR);
  const r = new R(svg, {
    fitTo: { mode: "zoom", value: 3 },
    font: { loadSystemFonts: false, fontFiles: FONTFILES, defaultFontFamily: "DM Sans" },
  });
  return r.render().asPng();
}
function rendererError() { loadRenderer(); return RENDER_ERR; }

/* ---------- Helpers SVG ---------- */
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function txt(x, y, s, o = {}) {
  return `<text x="${x}" y="${y}" font-family="${o.f || "DM Sans"}, sans-serif" font-size="${o.s || 11}" font-weight="${o.w || 400}" fill="${o.c || C.mut}" text-anchor="${o.a || "start"}"${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${esc(s)}</text>`;
}
function frame(h, title, subtitle, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">` +
    `<rect width="${W}" height="${h}" rx="12" fill="${C.bg}"/>` +
    txt(16, 28, title, { f: "Bebas Neue", s: 21, c: C.txt, ls: 0.6 }) +
    (subtitle ? txt(16, 45, subtitle, { s: 10.5 }) : "") +
    body + `</svg>`;
}
function niceTicks(lo, hi, n) {
  const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => span / s <= n) || 10 * mag;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}
function linePath(pts) {
  let d = "", pen = false;
  pts.forEach(([x, y]) => {
    if (y == null || !isFinite(y)) { pen = false; return; }
    d += (pen ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1) + " "; pen = true;
  });
  return d;
}
function smooth(arr, k) {
  return arr.map((v, i) => {
    if (v == null) return null;
    let a = 0, n = 0;
    for (let j = Math.max(0, i - k); j <= Math.min(arr.length - 1, i + k); j++) if (arr[j] != null) { a += arr[j]; n++; }
    return n ? a / n : null;
  });
}
/* Graduations d'allure rondes (pas de 15″/30″/1′) exprimées en m/s */
function paceTicks(vLo, vHi) {
  const sLo = 1000 / vHi, sHi = 1000 / vLo, span = sHi - sLo;
  const step = span > 240 ? 60 : span > 100 ? 30 : 15;
  const out = []; for (let t = Math.ceil(sLo / step) * step; t <= sHi; t += step) out.push(1000 / t);
  return out;
}
const paceLbl = (mps) => { const s = 1000 / mps; return Math.floor(s / 60) + "'" + String(Math.round(s % 60)).padStart(2, "0"); };

/* Panneau générique : y-axis à gauche, ticks, bande optionnelle */
function panel({ x0, y0, w, h, xs, ys, yLo, yHi, invert, color, fmt, band, bandColor, area, areaLo, areaHi, label, xMax, ticks }) {
  const X = (x) => x0 + (x / xMax) * w;
  const Y = (v) => { const t = (v - yLo) / (yHi - yLo || 1); return invert ? y0 + t * h : y0 + h - t * h; };
  let s = "";
  if (area) { // silhouette (altitude) sur son propre axe
    const A = (v) => y0 + h - ((v - areaLo) / (areaHi - areaLo || 1)) * h * 0.85;
    const pts = xs.map((x, i) => [X(x), area[i] == null ? null : A(area[i])]).filter((p) => p[1] != null);
    if (pts.length > 1) s += `<path d="M${pts[0][0]} ${y0 + h} ${pts.map((p) => "L" + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ")} L${pts[pts.length - 1][0]} ${y0 + h} Z" fill="#26262c"/>`;
  }
  if (band && band[1] > yLo && band[0] < yHi) { // bande rognée à la plage du panneau
    const a = Y(Math.max(band[0], yLo)), b = Y(Math.min(band[1], yHi));
    s += `<rect x="${x0}" y="${Math.min(a, b)}" width="${w}" height="${Math.abs(b - a)}" fill="${bandColor}" opacity="0.13"/>`;
  }
  let lastY = -1e9;
  (ticks || niceTicks(yLo, yHi, 3)).forEach((v) => {
    const y = Y(v); if (y < y0 - 1 || y > y0 + h + 1 || Math.abs(y - lastY) < 16) return;
    lastY = y;
    s += `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="${C.grid}" stroke-width="1"/>` + txt(x0 - 5, y + 3.5, fmt(v), { s: 10, a: "end" });
  });
  const clampY = (v) => Y(Math.max(yLo, Math.min(yHi, v)));
  s += `<path d="${linePath(xs.map((x, i) => [X(x), ys[i] == null ? null : clampY(ys[i])]))}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  s += txt(x0, y0 - 7, label, { s: 10.5, w: 700, c: color });
  return s;
}
function xAxis(x0, y, w, xMax, unit) {
  let s = "";
  niceTicks(0, xMax, 4).forEach((v) => { const x = x0 + (v / xMax) * w; if (x > x0 + w - 18) return; s += txt(x, y, v, { s: 10, a: "middle" }); });
  return s + txt(x0 + w, y, unit, { s: 10, a: "end" });
}

/* ---------- 1. Séance course : FC + VAP + altitude ---------- */
function sessionRun(m) {
  const sr = m.series.filter((p) => p.gap > 0.8);
  if (sr.length < 4) return null;
  const xs = sr.map((p) => p.x), xMax = Math.max(...xs);
  const hr = smooth(sr.map((p) => p.hr), 1), gap = smooth(sr.map((p) => p.gap), 1), alt = sr.map((p) => p.alt);
  const H = 318, x0 = 38, w = W - x0 - 14;
  const hv = hr.filter((v) => v != null);
  let s = "";
  if (hv.length) {
    const lo = Math.min(110, Math.floor(Math.min(...hv) / 5) * 5), hi = Math.max(165, Math.ceil(Math.max(...hv) / 5) * 5);
    s += panel({ x0, y0: 76, w, h: 82, xs, ys: hr, yLo: lo, yHi: hi, color: C.acc2, fmt: (v) => v, band: [125, 143], bandColor: C.grn, label: "FC (bpm) · vert = Z2", xMax });
  }
  const gv = gap.filter((v) => v != null);
  const gs = gv.slice().sort((p, q) => p - q), pc = (k) => gs[Math.min(gs.length - 1, Math.max(0, Math.round(k * (gs.length - 1))))];
  const gLo = pc(0.05) * 0.96, gHi = pc(0.95) * 1.03; // arrêts et sprints isolés hors cadre
  const av = alt.filter((v) => v != null);
  s += panel({ x0, y0: 192, w, h: 88, xs, ys: gap, yLo: gLo, yHi: gHi, color: C.acc, fmt: paceLbl,
    ticks: paceTicks(gLo, gHi), label: "Allure VAP (min/km) · gris = profil", xMax,
    area: av.length ? alt : null, areaLo: av.length ? Math.min(...av) : 0, areaHi: av.length ? Math.max(...av) : 1 });
  s += xAxis(x0, 297, w, xMax, "km");
  return frame(H, "Ta séance", `${m.km} km · ${m.dPlus} m D+ · ${m.movingMin} min`, s);
}

/* ---------- 2. Séance vélo : cadence (cible) + FC ---------- */
function sessionRide(m) {
  const sr = m.series;
  if (sr.length < 4) return null;
  const xs = sr.map((p) => p.x), xMax = Math.max(...xs);
  const cad = sr.map((p) => p.cad), hr = sr.map((p) => p.hr);
  const H = 312, x0 = 38, w = W - x0 - 14;
  const cv = cad.filter((v) => v != null);
  const cvs = cv.slice().sort((p, q) => p - q);
  const cLo = Math.floor(Math.min(m.target ? m.target[0] : 1e9, cvs[Math.floor(cvs.length * 0.03)]) / 5) * 5 - 5;
  const cHi = Math.ceil(Math.max(m.target ? m.target[1] : 0, cvs[Math.floor(cvs.length * 0.97)]) / 5) * 5 + 5;
  let s = panel({ x0, y0: 76, w, h: 92, xs, ys: cad, yLo: cLo, yHi: cHi, color: C.acc, fmt: (v) => v,
    band: m.target, bandColor: C.acc, label: "Cadence (tr/min)" + (m.target ? ` · bande = cible ${m.target[0]}-${m.target[1]}` : ""), xMax });
  const hv = hr.filter((v) => v != null);
  if (hv.length) {
    const lo = Math.floor(Math.min(...hv) / 5) * 5 - 5, hi = Math.max(lo + 30, Math.ceil(Math.max(...hv) / 5) * 5 + 5);
    s += panel({ x0, y0: 202, w, h: 70, xs, ys: smooth(hr, 1), yLo: lo, yHi: hi, color: C.acc2, fmt: (v) => v, band: [125, 143], bandColor: C.grn, label: "FC (bpm)" + (hi > 125 ? " · vert = Z2" : ""), xMax });
  }
  s += xAxis(x0, 290, w, xMax, "min");
  return frame(H, "Ta séance", `${m.movingMin} min · cad. moy ${m.cadence} · FC moy ${m.hr || "—"}`, s);
}

/* ---------- 3. Comparaison des dernières séances (barres) ---------- */
/* items: [{label, v, today}] du plus ancien au plus récent ; refs: [{v, label, color}] */
function bars(title, subtitle, items, o = {}) {
  const pts = items.filter((it) => it.v != null && isFinite(it.v));
  if (pts.length < 2) return null;
  const H = 206, x0 = 38, y0 = 72, w = W - x0 - 14, h = 96;
  const vals = pts.map((p) => p.v).concat((o.refs || []).map((r) => r.v));
  let lo = o.zero ? Math.min(0, ...vals) : Math.min(...vals), hi = Math.max(...vals);
  if (!o.zero) { const pad = (hi - lo || Math.abs(hi) * 0.1 || 1) * 0.35; lo -= pad; hi += pad * 0.6; }
  else hi += (hi - lo) * 0.15;
  const Y = (v) => y0 + h - ((v - lo) / (hi - lo || 1)) * h;
  const n = items.length, slot = w / n, bw = Math.min(30, slot * 0.6);
  let s = "";
  niceTicks(lo, hi, 3).forEach((v) => { const y = Y(v); s += `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="${C.grid}"/>` + txt(x0 - 5, y + 3.5, o.fmt ? o.fmt(v) : v, { s: 10, a: "end" }); });
  const base = Y(o.zero ? 0 : lo);
  items.forEach((it, i) => {
    const cx = x0 + slot * i + slot / 2;
    if (it.v == null || !isFinite(it.v)) { s += txt(cx, base - 4, "—", { s: 10, a: "middle" }); }
    else {
      const y = Y(it.v), top = Math.min(y, base), hh = Math.max(2, Math.abs(base - y));
      // Couleur : score « feu tricolore » si jugeable, sinon jaune (jour) / gris (historique)
      const sc = SC.ramp(it.score);
      const col = sc || (it.today ? C.acc : (it.dim ? "#2c2c33" : C.bar));
      const op = sc && !it.today && !o.solid ? 0.5 : 1;
      if (it.today && !o.solid) s += `<rect x="${(cx - bw / 2 - 3).toFixed(1)}" y="${(top - 3).toFixed(1)}" width="${(bw + 6).toFixed(1)}" height="${(hh + 3).toFixed(1)}" rx="5" fill="none" stroke="${C.txt}" stroke-width="1.2" opacity="0.55"/>`;
      s += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" rx="3" fill="${col}" opacity="${op}"/>`;
      s += txt(cx, top - (it.today ? 8 : 5), o.fmt ? o.fmt(it.v) : it.v, { s: it.today ? 11.5 : 10, w: it.today ? 700 : 400, c: it.today ? (sc || C.acc) : C.txt, a: "middle" });
    }
    s += txt(cx, y0 + h + 16, it.label, { s: 10, a: "middle", c: it.today ? C.txt : C.mut, w: it.today ? 700 : 400 });
    if (it.tag) s += txt(cx, y0 + h + 29, it.tag, { s: 9, a: "middle" });
  });
  (o.refs || []).forEach((r) => {
    const y = Y(r.v);
    s += `<line x1="${x0}" y1="${y}" x2="${x0 + w}" y2="${y}" stroke="${r.color || C.acc2}" stroke-dasharray="4 4" stroke-width="1.2"/>` +
      txt(x0 + 4, y - 4, r.label, { s: 10, w: 700, c: r.color || C.acc2 });
  });
  if (o.note) s += txt(18, H - 10, o.note, { s: 9.5 });
  // Légende du dégradé (seulement si au moins une barre est jugée)
  if (items.some((it) => it.score != null)) {
    const lx = W - 16 - 84, ly = 20;
    const gid = "lvramp" + (++GID); // id unique : plusieurs SVG cohabitent dans la page du P.P.L
    s += `<defs><linearGradient id="${gid}" x1="0" x2="1" y1="0" y2="0">${SC.DARK.map(([p, c]) => `<stop offset="${p}" stop-color="${c}"/>`).join("")}</linearGradient></defs>` +
      `<rect x="${lx}" y="${ly}" width="84" height="6" rx="3" fill="url(#${gid})"/>` +
      txt(lx, ly + 17, "loin", { s: 9 }) + txt(lx + 84, ly + 17, "atteint", { s: 9, a: "end" });
  }
  return frame(H, title, subtitle, s);
}

/* ---------- 4. Histogramme cadence (vélo) ---------- */
function cadenceHist(m) {
  if (!m.cadenceHist) return null;
  const labels = ["<60", "60-70", "70-80", "80-90", "90-100", ">100"];
  const lohi = [[0, 60], [60, 70], [70, 80], [80, 90], [90, 100], [100, 999]];
  const items = m.cadenceHist.map((v, i) => {
    let score = null;
    if (m.target) { // écart entre la tranche et la cible : 0 = vert, ≤10 = jaune, ≤20 = orange, au-delà = rouge
      const [lo, hi] = lohi[i], d = hi > m.target[0] && lo < m.target[1] ? 0 : Math.min(Math.abs(m.target[0] - hi), Math.abs(lo - m.target[1]));
      score = d === 0 ? 1 : d <= 10 ? 0.7 : d <= 20 ? 0.4 : 0;
    }
    return { label: labels[i], v, score: v > 0 ? score : null, today: false };
  });
  return bars("Répartition de ta cadence", m.target ? `% du temps pédalé · vert = ta cible ${m.target[0]}-${m.target[1]}, rouge = loin` : "% du temps pédalé",
    items, { zero: true, solid: true, fmt: (v) => Math.round(v) + "%" });
}

module.exports = { toPNG, rendererError, sessionRun, sessionRide, bars, cadenceHist, C };
