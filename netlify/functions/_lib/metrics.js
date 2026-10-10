/* ============================================================
   MÉTRIQUES DE SÉANCE — calcul pur à partir des streams Strava
   (time, distance, altitude, heartrate, cadence, velocity_smooth,
   grade_smooth, moving). Aucun réseau ici : testable hors ligne.

   Course / trail :
   - VAP (vitesse ajustée à la pente) : Minetti 2002 en montée,
     courbe empirique bridée en descente (on ne « gagne » pas 50 %
     en descente raide, cf. ton Excel Saint-Jacques).
   - EF (efficacité aérobie) = VAP (m/min) ÷ FC moyenne.
   - Découplage (Pa:HR) = baisse d'EF entre 1re et 2e moitié,
     échauffement (5′) exclu. Non interprétable si allure trop variable.
   - VAM en montée : segments à pente ≥ 4 %, gain ≥ 25 m.
   Vélo :
   - cadence (hors roue libre), répartition, % dans la cible,
   - dérive FC et découplage vitesse/FC (pertinent sur HT).
   ============================================================ */

const FCMAX = 179;
const OPT = { maxDt: 30 }; // pauses > 30 s ignorées (streams pleine résolution = 1 s)
// Zones FC du cahier des charges (§2.2) — FCmax 179
const ZONES = [
  { k: "Z1", lo: 0, hi: 125 },
  { k: "Z2", lo: 125, hi: 143 },
  { k: "Z3", lo: 143, hi: 152 },
  { k: "Z4", lo: 152, hi: 162 },
  { k: "Z5", lo: 162, hi: 999 },
];

/* ---------- Classification ---------- */
function classify(a) {
  const t = String(a.sport_type || a.type || "");
  const n = String(a.name || "");
  const km = (a.distance || 0) / 1000;
  if (/ride|cycl|velo/i.test(t)) {
    const indoor = !!a.trainer || /\bh\.?\s?t\b|home.?trainer/i.test(n) || (t === "VirtualRide");
    return { fam: "ride", sub: indoor ? "ht" : "route" };
  }
  if (/run/i.test(t)) {
    // Rando loggée en TrailRun : cadence de marche (< 65 pas/min/jambe) ou titre explicite
    if (/rando|balade|hike|marche/i.test(n) || (a.average_cadence && a.average_cadence < 65)) return { fam: "hike", sub: "rando" };
    const dpkm = km > 0 ? (a.total_elevation_gain || 0) / km : 0;
    return { fam: "run", sub: (/trail/i.test(t) || dpkm >= 20) ? "trail" : "route" };
  }
  if (/hike|walk/i.test(t)) return { fam: "hike", sub: "rando" };
  return { fam: "other", sub: t.toLowerCase() };
}

/* ---------- Facteur VAP ---------- */
function minetti(i) { // J/kg/m, i = pente en fraction
  return 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
}
function gapFactor(gradePct) {
  let i = Math.max(-0.4, Math.min(0.4, (gradePct || 0) / 100));
  if (i >= 0) return minetti(i) / 3.6;
  // Descente : léger gain jusqu'à -6 % puis le freinage reprend le dessus
  if (i >= -0.06) return 1 + 2 * i;              // 0 → 1.00, -6 % → 0.88
  return Math.min(1.15, 0.88 + (-0.06 - i) * 0.7); // -15 % → 0.94, -25 % → 1.01
}

/* ---------- Utilitaires ---------- */
function S(streams, k) { const s = streams && streams[k]; return s ? (Array.isArray(s) ? s : s.data) : null; }
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null || !isFinite(x) ? null : Math.round(x));
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
function wmean(pairs) { let a = 0, w = 0; pairs.forEach(([v, d]) => { if (v != null && isFinite(v)) { a += v * d; w += d; } }); return w ? a / w : null; }
function zoneOf(h) { for (let z = 0; z < ZONES.length; z++) if (h < ZONES[z].hi) return z; return 4; }
function paceStr(mps) { if (!mps || mps <= 0) return "—"; const s = 1000 / mps; return Math.floor(s / 60) + "'" + String(Math.round(s % 60)).padStart(2, "0"); }

/* D+ avec hystérésis 2 m (le bruit GPS/baro gonfle la somme brute des deltas) */
function gainHyst(ss) {
  let g = 0, ref = null;
  ss.forEach((p) => { if (p.alt == null) return; if (ref == null) ref = p.alt; const d = p.alt - ref; if (d >= 2) { g += d; ref = p.alt; } else if (d <= -2) ref = p.alt; });
  return g;
}
/* Parcours des échantillons « en mouvement » avec dt borné (pauses ignorées). */
function samples(streams, minSpeed) {
  const T = S(streams, "time"); if (!T || T.length < 10) return [];
  const V = S(streams, "velocity_smooth"), G = S(streams, "grade_smooth"), A = S(streams, "altitude");
  const H = S(streams, "heartrate"), C = S(streams, "cadence"), M = S(streams, "moving"), D = S(streams, "distance");
  const out = []; let tm = 0;
  for (let i = 1; i < T.length; i++) {
    let dt = T[i] - T[i - 1];
    if (!(dt > 0)) continue;
    const v = V ? V[i] : null;
    const mv = M ? !!M[i] : (v == null || v > minSpeed);
    if (!mv || (v != null && v < minSpeed)) continue;
    if (dt > OPT.maxDt) continue;   // trou de signal / arrêt
    tm += dt;
    out.push({
      t: tm, dt, v: v || 0, g: G ? G[i] : 0,
      dAlt: A ? A[i] - A[i - 1] : 0, alt: A ? A[i] : null,
      dd: D ? Math.max(0, D[i] - D[i - 1]) : (v || 0) * dt, dist: D ? D[i] : null,
      hr: H && H[i] > 40 ? H[i] : null, cad: C && C[i] > 0 ? C[i] : null,
    });
  }
  return out;
}

function zonesPct(ss) {
  const z = [0, 0, 0, 0, 0]; let tot = 0;
  ss.forEach((p) => { if (p.hr) { z[zoneOf(p.hr)] += p.dt; tot += p.dt; } });
  return tot ? z.map((x) => r0((x / tot) * 100)) : null;
}

/* EF par moitié, échauffement exclu ; X = fonction « vitesse » du sample */
function halves(ss, X, warm) {
  const body = ss.filter((p) => p.t > warm && p.hr);
  if (body.length < 20) return null;
  const t0 = body[0].t, t1 = body[body.length - 1].t, mid = (t0 + t1) / 2;
  const h = [body.filter((p) => p.t <= mid), body.filter((p) => p.t > mid)];
  const res = h.map((arr) => {
    const v = wmean(arr.map((p) => [X(p), p.dt])), hr = wmean(arr.map((p) => [p.hr, p.dt]));
    const cad = wmean(arr.filter((p) => p.cad).map((p) => [p.cad, p.dt]));
    return { v, hr, cad, ef: v && hr ? (v * 60) / hr : null };
  });
  return { dur: t1 - t0, a: res[0], b: res[1] };
}

/* Variabilité de l'allure (CV des moyennes par minute) → séance continue ou fractionnée */
function variability(ss, X) {
  const bins = new Map();
  ss.forEach((p) => { const k = Math.floor(p.t / 60); const b = bins.get(k) || [0, 0]; b[0] += X(p) * p.dt; b[1] += p.dt; bins.set(k, b); });
  const m = [...bins.values()].filter((b) => b[1] > 30).map((b) => b[0] / b[1]);
  if (m.length < 6) return null;
  const mu = m.reduce((a, b) => a + b, 0) / m.length;
  const sd = Math.sqrt(m.reduce((a, b) => a + (b - mu) ** 2, 0) / m.length);
  return mu ? sd / mu : null;
}

/* Segments de montée : pente ≥ 4 %, tolérance 30 s de replat, gain ≥ 25 m */
function climbs(ss) {
  const segs = []; let cur = null, flat = 0;
  ss.forEach((p) => {
    if (p.g >= 4) {
      if (!cur) cur = { gain: 0, time: 0, dist: 0, cad: [], hr: [] };
      cur.gain += Math.max(0, p.dAlt); cur.time += p.dt + flat; cur.dist += p.dd; flat = 0;
      if (p.cad) cur.cad.push([p.cad * 2, p.dt]);
      if (p.hr) cur.hr.push([p.hr, p.dt]);
    } else if (cur) {
      flat += p.dt;
      if (flat > 30) { segs.push(cur); cur = null; flat = 0; }
    }
  });
  if (cur) segs.push(cur);
  return segs.filter((s) => s.gain >= 25 && s.time >= 60);
}

/* ---------- COURSE / TRAIL ---------- */
function runMetrics(streams) {
  const ss = samples(streams, 0.6);
  if (ss.length < 30) return null;
  const tMove = ss[ss.length - 1].t;
  const dist = ss.reduce((a, p) => a + p.dd, 0);
  const gapV = (p) => p.v * gapFactor(p.g);
  const vRaw = dist / tMove;
  // VAP = vitesse réelle × facteur de pente moyen pondéré par la vitesse (cohérent avec dist/temps)
  const sv = ss.reduce((a, p) => a + p.v * p.dt, 0), svf = ss.reduce((a, p) => a + gapV(p) * p.dt, 0);
  const vGap = sv > 0 ? vRaw * (svf / sv) : null;
  const hr = wmean(ss.filter((p) => p.hr).map((p) => [p.hr, p.dt]));
  const cad = wmean(ss.filter((p) => p.cad).map((p) => [p.cad * 2, p.dt]));
  const flatCad = wmean(ss.filter((p) => p.cad && Math.abs(p.g) < 3).map((p) => [p.cad * 2, p.dt]));
  const dPlus = gainHyst(ss);

  const cv = variability(ss, gapV);
  const steady = cv != null && cv < 0.12;
  const hv = tMove >= 35 * 60 ? halves(ss, gapV, 300) : null;
  const dec = hv && hv.a.ef && hv.b.ef ? ((hv.a.ef - hv.b.ef) / hv.a.ef) * 100 : null;

  const cl = climbs(ss);
  const clGain = cl.reduce((a, s) => a + s.gain, 0), clTime = cl.reduce((a, s) => a + s.time, 0);
  const best = cl.slice().sort((x, y) => y.gain - x.gain)[0] || null;
  const clCad = wmean([].concat(...cl.map((s) => s.cad)));
  const clHr = wmean([].concat(...cl.map((s) => s.hr)));

  const desc = ss.filter((p) => p.g <= -8);
  const descT = desc.reduce((a, p) => a + p.dt, 0);
  const descV = descT >= 120 ? desc.reduce((a, p) => a + p.dd, 0) / descT : null;

  // Série pour le graphe de séance : bins de 250 m (ou 60 s si pas de distance)
  const series = []; let acc = null;
  ss.forEach((p) => {
    if (!acc) acc = { d: 0, t: 0, vg: 0, hr: 0, hrT: 0, alt: p.alt, x: 0 };
    acc.d += p.dd; acc.t += p.dt; acc.vg += gapV(p) * p.dt; if (p.hr) { acc.hr += p.hr * p.dt; acc.hrT += p.dt; }
    if (acc.d >= 250 || acc.t >= 150) {
      series.push({ x: (p.dist != null ? p.dist : p.t * vRaw) / 1000, gap: acc.vg / acc.t, hr: acc.hrT ? acc.hr / acc.hrT : null, alt: p.alt });
      acc = null;
    }
  });

  return {
    kind: "run",
    movingMin: r0(tMove / 60), km: r2(dist / 1000), dPlus: r0(dPlus),
    pace: paceStr(vRaw), gapPace: paceStr(vGap), vGap,
    hr: r0(hr), hrPctMax: hr ? r0((hr / FCMAX) * 100) : null,
    ef: vGap && hr ? r2((vGap * 60) / hr) : null,
    cadence: r0(cad), cadenceFlat: r0(flatCad),
    zones: zonesPct(ss),
    variability: r2(cv), steady,
    decoupling: dec != null ? r1(dec) : null,
    decouplingValid: dec != null && steady,
    halves: hv ? { hr1: r0(hv.a.hr), hr2: r0(hv.b.hr), pace1: paceStr(hv.a.v), pace2: paceStr(hv.b.v) } : null,
    climb: clGain >= 25 ? {
      n: cl.length, gain: r0(clGain), min: r0(clTime / 60), vam: r0((clGain / clTime) * 3600),
      cadence: r0(clCad), hr: r0(clHr),
      best: best ? { gain: r0(best.gain), min: r1(best.time / 60), vam: r0((best.gain / best.time) * 3600), cadence: best.cad.length ? r0(wmean(best.cad)) : null } : null,
    } : null,
    descentKmh: descV ? r1(descV * 3.6) : null, descentMin: r0(descT / 60),
    series,
  };
}

/* ---------- VÉLO ---------- */
const CAD_BUCKETS = [[0, 60], [60, 70], [70, 80], [80, 90], [90, 100], [100, 999]];
function rideMetrics(streams, target) {
  const ss = samples(streams, 0.3);
  if (ss.length < 30) return null;
  const tMove = ss[ss.length - 1].t;
  const ped = ss.filter((p) => p.cad);
  const pedT = ped.reduce((a, p) => a + p.dt, 0);
  const cad = wmean(ped.map((p) => [p.cad, p.dt]));
  const sdCad = pedT ? Math.sqrt(wmean(ped.map((p) => [(p.cad - cad) ** 2, p.dt]))) : null;
  const hist = CAD_BUCKETS.map(([lo, hi]) => r0((ped.filter((p) => p.cad >= lo && p.cad < hi).reduce((a, p) => a + p.dt, 0) / (pedT || 1)) * 100));
  const inTarget = target ? r0((ped.filter((p) => p.cad >= target[0] && p.cad <= target[1]).reduce((a, p) => a + p.dt, 0) / (pedT || 1)) * 100) : null;
  const hr = wmean(ss.filter((p) => p.hr).map((p) => [p.hr, p.dt]));
  const dist = ss.reduce((a, p) => a + p.dd, 0);
  const hv = tMove >= 25 * 60 ? halves(ss, (p) => p.v, 300) : null;
  const drift = hv && hv.a.hr && hv.b.hr ? ((hv.b.hr - hv.a.hr) / hv.a.hr) * 100 : null;
  const dec = hv && hv.a.ef && hv.b.ef ? ((hv.a.ef - hv.b.ef) / hv.a.ef) * 100 : null;
  const dPlus = gainHyst(ss);

  const series = []; let acc = null;
  ss.forEach((p) => {
    if (!acc) acc = { t0: p.t, c: 0, cT: 0, h: 0, hT: 0 };
    if (p.cad) { acc.c += p.cad * p.dt; acc.cT += p.dt; }
    if (p.hr) { acc.h += p.hr * p.dt; acc.hT += p.dt; }
    if (p.t - acc.t0 >= 60) { series.push({ x: p.t / 60, cad: acc.cT ? acc.c / acc.cT : null, hr: acc.hT ? acc.h / acc.hT : null }); acc = null; }
  });

  return {
    kind: "ride",
    movingMin: r0(tMove / 60), km: r1(dist / 1000), dPlus: r0(dPlus),
    kmh: r1((dist / tMove) * 3.6),
    cadence: r0(cad), cadenceSd: r0(sdCad), coastPct: r0((1 - pedT / tMove) * 100),
    cadenceHist: hist, target, inTarget,
    hr: r0(hr), hrPctMax: hr ? r0((hr / FCMAX) * 100) : null,
    zones: zonesPct(ss),
    hrDrift: drift != null ? r1(drift) : null,
    decoupling: dec != null ? r1(dec) : null,
    halves: hv ? { hr1: r0(hv.a.hr), hr2: r0(hv.b.hr), cad1: r0(hv.a.cad), cad2: r0(hv.b.cad), kmh1: r1(hv.a.v * 3.6), kmh2: r1(hv.b.v * 3.6) } : null,
    series,
  };
}

/* Cible de cadence : « cadence 85-95 » dans la description, sinon plan (« 75-80 tr/min ») */
function cadenceTarget(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const s = String(t).replace(/<[^>]+>/g, " ");
    let m = /\bcad(?:ence)?\b[^0-9]{0,12}(\d{2,3})\s*[-–à]\s*(\d{2,3})/i.exec(s) || /(\d{2,3})\s*[-–à]\s*(\d{2,3})\s*(?:tr\/?\s?min|rpm)/i.exec(s);
    if (m) { const a = +m[1], b = +m[2]; if (a >= 40 && b <= 130 && b > a) return [a, b]; }
    // valeur unique : « 55 tr/min », « cadence 90 », « 55 tours » → ±5
    m = /(\d{2,3})\s*(?:tr\/?\s?min|rpm|tours?\b)/i.exec(s) || /\bcad(?:ence)?\b[^0-9]{0,12}(\d{2,3})\b/i.exec(s);
    if (m) { const v = +m[1]; if (v >= 40 && v <= 130) return [v - 5, v + 5]; }
  }
  return null;
}

/* Note libre de Laurent dans la description Strava, sans le bloc auto Enduraw */
function userNote(desc) {
  if (!desc) return "";
  let s = String(desc).split(/𝗠𝘆 𝗘𝗻𝗱𝘂𝗿𝗮𝘄|My Enduraw|https?:\/\//)[0];
  s = s.replace(/\s+/g, " ").replace(/[^\p{L}\p{N})\].!?%]+$/u, "").trim();
  return s.slice(0, 280);
}

module.exports = { OPT, classify, runMetrics, rideMetrics, cadenceTarget, userNote, gapFactor, paceStr, ZONES, FCMAX };
