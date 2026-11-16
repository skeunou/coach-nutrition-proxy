/* ============================================================
   SÉANCES DE COURSE → MONTRE GARMIN (via intervals.icu)
   P.P.L (plan) → intervals.icu (événements WORKOUT, upsert par external_id "ppl-AAAA-MM-JJ")
   → intervals.icu les téléverse dans Garmin Connect (« Upload planned workouts »)
   → la montre les reçoit à la synchro.
   Uniquement la COURSE à pied (demande de Laurent, 15 nov. 2026) : ni H.T, ni marche, ni renfo.
   Fenêtre : aujourd'hui → J+7. Une séance retirée du plan est supprimée d'intervals.icu.
   ============================================================ */
const https = require("https");
const ST = require("./store.js");
const P = require("./plan.js");

const ATHLETE = () => (process.env.INTERVALS_ATHLETE_ID || "i800343").replace(/[^a-z0-9]/gi, "");
const APP = { host: "raw.githubusercontent.com", path: "/skeunou/trail-v2/main/trail-v2.html" };
const PREFIX = "ppl-";

function rq(opts, body) {
  return new Promise((resolve) => {
    const req = https.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.on("error", (e) => resolve({ status: 500, json: { error: e.message } }));
    req.setTimeout(9000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}
function iv(method, path, obj) {
  const key = process.env.INTERVALS_API_KEY;
  const body = obj ? JSON.stringify(obj) : null;
  const headers = { Authorization: "Basic " + Buffer.from("API_KEY:" + key).toString("base64"), Accept: "application/json", "User-Agent": "lv-garminplan" };
  if (body) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(body); }
  return rq({ hostname: "intervals.icu", path, method, headers }, body);
}
const ymdOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
function parisToday() { const n = new Date(Date.now() + 3600 * 1000); return new Date(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()); }

/* Course à pied ? (le plan mélange H.T, vélo, marche, renfo sous des typeKey proches) */
function isRun(s) {
  const t = s.typeKey || "", lab = (s.label || "") + " " + (s.sub || "") + " " + (s.short || "");
  if (!/^(fond|cotes|longue|course)$/.test(t)) return false;
  if (/home-?trainer|H\.T|v[ée]lo|SFR|natation|repos|pas de c[ôo]tes/i.test(lab)) return false;
  return true;
}

/* Couleurs Garmin : les titres de blocs DOIVENT être « Warmup / Main Set / Cooldown » (mots-clés intervals.icu → type d'étape
   échauffement rouge / effort bleu / retour vert) ; marche de récup = intensity=rest (gris). Les noms d'étapes restent en français.
   Allures du plan → cibles d'allure Garmin (15 nov. 2026, demande de Laurent : « les consignes d'allure, c'est important »).
   Format intervals.icu : « - Course 1m 7:34-6:04/km Pace » (lente-rapide). Aucun chiffre dans le nom des étapes :
   intervals lirait « 6:04/km » comme une cible. Les consignes FC / cadence vont dans l'en-tête de la séance.
   ⚠️ Les cibles d'allure n'arrivent sur la montre que si l'allure seuil est réglée dans intervals.icu (Run). */
function sec(x) { const m = /(\d+)[′':](\d{2})/.exec(x); return m ? +m[1] * 60 + +m[2] : null; }
function mmss(t) { return Math.floor(t / 60) + ":" + String(Math.round(t % 60)).padStart(2, "0"); }
function planText(s) {
  return [].concat(s.detail || [], (s._specs || s.specs || []).map((x) => x.join(" "))).map(String).join(" ").replace(/<[^>]+>/g, "");
}
/* → { slow, fast } en secondes/km, ou null */
function paceOf(s) {
  const txt = planText(s);
  const m = /allure\s*(≥|>=)?\s*(\d+[′':]\d{2})\s*(?:[–-]\s*(\d+[′':]\d{2}))?\s*\/?\s*km/i.exec(txt)
         || /()(\d+[′':]\d{2})\s*[–-]\s*(\d+[′':]\d{2})\s*\/\s*km/i.exec(txt);
  if (!m) return null;
  const a = sec(m[2]), b = m[3] ? sec(m[3]) : null;
  if (b) return { slow: Math.max(a, b), fast: Math.min(a, b) };
  if (m[1]) return { slow: a + 30, fast: a };          // « allure ≥ 6′04 » → 6:04-6:34 (fourchette de 30″ demandée par Laurent, 15 nov. 2026)
  return { slow: a + 10, fast: Math.max(0, a - 10) };
}
const paceTgt = (p) => mmss(p.slow) + "-" + mmss(p.fast) + "/km Pace";
function fcOf(s) { const sp = (s._specs || s.specs || []).find((x) => /^FC/i.test(x[0])); if (!sp) return ""; const v = String(sp[1]).replace(/\s+/g, " "); return /max/i.test(sp[0]) && !/[<>≤≥]/.test(v) ? "max " + v : v; }
function cadOf(s) { const sp = (s._specs || s.specs || []).find((x) => /^Cadence/i.test(x[0])); return sp ? String(sp[1]) : ""; }
function header(s, p, noFc) {
  const bits = [];
  if (p) bits.push("Allure " + mmss(p.fast) + " a " + mmss(p.slow) + " par km");
  const fc = noFc ? "" : fcOf(s); if (fc) bits.push("FC " + fc);
  const cad = cadOf(s); if (cad) bits.push("cadence " + cad);
  return bits.length ? "Consignes : " + bits.join(" · ") + "\n\n" : "";
}

/* Côtes de réintroduction (déc. 2026) : « Côtes 6×1′30 · RPE 7 », redescente marche ou trot très lent.
   Le plan ne chiffre pas la redescente → 2× la durée de la côte (repère). Type non reconnu → null (pas d'envoi). */
function specialText(s) {
  const lab = s.label || "", txt = planText(s);
  const m = /C[ôo]tes\s*(\d+)\s*×\s*(\d+)\s*[′'](\d{1,2})?/i.exec(s.short || s.sub || "");
  if (/r[ée]introduction/i.test(lab) && m) {
    const eff = +m[2] * 60 + (+m[3] || 0), rec = eff * 2;
    const dstr = (x) => (x >= 60 ? Math.floor(x / 60) + "m" : "") + (x % 60 ? (x % 60) + "s" : "");
    const down = /trot/i.test(txt.replace(/trot plat/gi, "")) ? "Redescente trot très lent" : "Redescente marche";
    return header(s, null) + ["Warmup", "- Marche 10m", "- Trot plat 5m Z1 HR", "", "Main Set " + m[1] + "x", "- Côte " + dstr(eff) + " Z3 HR", "- " + down + " " + dstr(rec) + " intensity=rest", "", "Cooldown", "- Marche 5m"].join("\n");
  }
  if (/qualit|c[ôo]tes|tapis|mont[ée]e/i.test(lab)) return null;
  return undefined;
}
function workoutText(s) {
  const lab = s.label || "", short = s.short || "", p = paceOf(s);
  const run = (min, hr) => "- Course " + min + "m " + (p ? paceTgt(p) : hr);
  let m = /(\d+)\s*×\s*\(\s*(\d+)′C\s*\/\s*(\d+)′M\s*\)/.exec(short);
  if (/fractionn/i.test(lab) && m) {          // Reprise : N × (X′ course / Y′ marche)
    return header(s, p) + ["Warmup", "- Marche 5m", "", "Main Set " + m[1] + "x", run(m[2], "60-78% HR"), "- Marche " + m[3] + "m intensity=rest", "", "Cooldown", "- Marche 5m"].join("\n");
  }
  m = /(\d+)′\s*continu/.exec(short);
  if (/fractionn/i.test(lab) && m) {
    return header(s, p) + ["Warmup", "- Marche 5m", "", "Main Set", run(m[1], "60-78% HR"), "", "Cooldown", "- Marche 5m"].join("\n");
  }
  const dur = (s.plan && s.plan.durMin) || 0;
  if (/EF continu/i.test(lab) && dur) {       // Réintroduction : EF plat
    return header(s, p) + ["Warmup", "- Course 5m Z1 HR", "", "Main Set", run(Math.max(5, dur - 10), "Z2 HR"), "", "Cooldown", "- Course 5m Z1 HR"].join("\n");
  }
  const txt = planText(s);
  const dstr = (sec2) => (sec2 >= 60 ? Math.floor(sec2 / 60) + "m" : "") + (sec2 % 60 ? (sec2 % 60) + "s" : "");
  const accel = /acc[ée]l[ée]rations?/i.test(txt) ? ["", "Accélérations 3x", "- Accélération 20s Z4 HR", "- Trot 40s intensity=rest"] : [];
  // Qualité route/piste : « Corps : N × M′ à A–B/km, récup R »
  let q = /(\d+)\s*×\s*(\d+)′(\d{2})?\s*à\s*(\d+['′:]\d{2})\s*[–-]\s*(\d+['′:]\d{2})\s*\/km\s*,?\s*r[ée]cup\s*(\d+)\s*(″|′)\s*(\d{2})?/i.exec(txt);
  if (q) {
    const eff = +q[2] * 60 + (+q[3] || 0), rec = q[7] === "″" ? +q[6] : +q[6] * 60 + (+q[8] || 0);
    const pa = sec(q[4]), pb = sec(q[5]);
    const nm = /VMA/i.test(lab) ? "VMA" : (/sous-seuil/i.test(lab) ? "Sous-seuil" : "Seuil");
    return header(s, { fast: Math.min(pa, pb), slow: Math.max(pa, pb) }, true) + ["Warmup", "- Échauffement EF 15m Z2 HR"].concat(accel, ["", "Main Set " + q[1] + "x",
      "- " + nm + " " + dstr(eff) + " " + mmss(Math.max(pa, pb)) + "-" + mmss(Math.min(pa, pb)) + "/km Pace",
      "- Récup trot " + dstr(rec) + " intensity=rest", "", "Cooldown", "- Retour EF 10m Z1 HR"]).join("\n");
  }
  // Côtes club : « N × 1′30 à 2′ en montée … ratio 1:1,5 »
  q = /(\d+)\s*×\s*(\d+)′(\d{2})?\s*(?:à\s*(\d+)′(\d{2})?)?\s*en mont[ée]e/i.exec(txt);
  if (q && /c[ôo]tes/i.test(lab)) {
    const eff = q[4] ? +q[4] * 60 + (+q[5] || 0) : +q[2] * 60 + (+q[3] || 0);
    const r = /ratio\s*1\s*:\s*(\d+(?:[.,]\d+)?)/i.exec(txt), rec = Math.round(eff * (r ? parseFloat(r[1].replace(",", ".")) : 1.5));
    return header(s, null) + ["Warmup", "- Échauffement EF 15m Z2 HR"].concat(accel, ["", "Main Set " + q[1] + "x",
      "- Côte " + dstr(eff) + " Z4 HR", "- Descente trottinée " + dstr(rec) + " intensity=rest", "", "Cooldown", "- Retour EF 10m Z1 HR"]).join("\n");
  }
  // Tapis incliné : « Tapis marche 4×5′ », « Tapis 4×8′ · 6 kg », récup à plat
  q = /tapis[^0-9]*(\d+)\s*×\s*(\d+)′/i.exec(short || "") || /(\d+)\s*×\s*(\d+)′[^.]*tapis|tapis[^.]*?(\d+)\s*×\s*(\d+)′/i.exec(txt);
  if (q && /tapis/i.test(short + " " + lab + " " + txt)) {
    const n = q[1] || q[3], m2 = q[2] || q[4];
    const rr = /r[ée]cup\s*:?\s*(\d+)′/i.exec(txt), rec = rr ? +rr[1] : 2;
    const lest = /(\d+)\s*kg/i.exec(short || ""), walk = /marche/i.test(short + " " + txt);
    const eff = walk ? "Marche active en pente" : ("Tapis en pente" + (lest ? " lesté" : ""));
    const wu = /trot/i.test(txt) ? ["Warmup", "- Marche 10m", "- Trot plat 5m Z1 HR"] : ["Warmup", "- Marche 10m"];
    return header(s, null) + wu.concat(["", "Main Set " + n + "x", "- " + eff + " " + m2 + "m", "- Récup à plat " + rec + "m intensity=rest", "", "Cooldown", "- Marche 5m"]).join("\n");
  }
  // Sortie de réintroduction : « 50′ plat » en Z2 à la FC (terrain varié → la FC, pas l'allure)
  q = /(\d+)′\s*plat/i.exec(short || "");
  if (q && /sortie/i.test(lab)) {
    return header(s, null) + ["Warmup", "- Course 10m Z1 HR", "", "Main Set", "- Course " + Math.max(5, +q[1] - 15) + "m 70-80% HR", "", "Cooldown", "- Course 5m Z1 HR"].join("\n");
  }
  const special = specialText(s); if (special !== undefined) return special;
  // Endurance (EF, sortie longue, réintroduction plate…) ; tout autre type inconnu → non envoyé plutôt que faux.
  if (!/\bEF\b|endurance|footing|sortie|r[ée]cup/i.test(lab)) return null;
  const d = dur || 45;                          // Endurance générique : échauffement + corps + retour
  return header(s, p) + ["Warmup", "- Course 10m Z1 HR", "", "Main Set", run(Math.max(5, d - 15), "Z2 HR"), "", "Cooldown", "- Course 5m Z1 HR"].join("\n");
}

async function buildEvents() {
  let appState = null; try { appState = (await ST.readJson("state-laurent.json")).data; } catch (e) {}
  const storage = {};
  if (appState && appState.rep) storage["reprise:v1"] = JSON.stringify(appState.rep);
  if (appState && appState.refs) storage["refs:v1"] = JSON.stringify(appState.refs);
  const app = await rq({ hostname: APP.host, path: APP.path, method: "GET", headers: { "User-Agent": "lv-garminplan" } });
  if (app.status !== 200) throw new Error("trail-v2.html HTTP " + app.status);
  const engine = P.buildEngine(app.raw, storage);
  const t0 = parisToday(), out = [];
  for (let i = 0; i <= 7; i++) {
    const day = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + i), k = ymdOf(day);
    const s = engine.call((eng) => { eng.setDay(t0); return eng.gen(day) || {}; });
    if (!isRun(s)) continue;
    const desc = workoutText(s); if (!desc) continue;
    // Nom demandé par Laurent : « PTC Reprise N : format » pour le protocole de reprise
    const fm = /fractionn\S*\s+\S+\s*·\s*(\d+)\s*\//i.exec(s.label || "");
    const title = fm ? "PTC Reprise " + fm[1] + " : " + (s.short || "")
      : (s.displayTitle || s.label || "Course") + (s.short ? " · " + s.short : "");
    out.push({ category: "WORKOUT", type: "Run", start_date_local: k + "T00:00:00", name: title.slice(0, 80), description: desc, external_id: PREFIX + k });
  }
  return { from: ymdOf(t0), to: ymdOf(new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + 7)), events: out };
}

/* dry=true : n'écrit rien, renvoie ce qui serait envoyé */
async function sync(dry) {
  const plan = await buildEvents();
  if (dry) return { status: "dry", ...plan };
  if (!process.env.INTERVALS_API_KEY) return { status: "no_api_key" };
  const id = ATHLETE();
  // 1. Supprimer les séances ppl- futures qui ne sont plus dans le plan
  const ex = await iv("GET", `/api/v1/athlete/${id}/events?oldest=${plan.from}&newest=${plan.to}&category=WORKOUT`);
  if (ex.status === 401 || ex.status === 403) return { status: "intervals_denied", http: ex.status };
  const keep = new Set(plan.events.map((e) => e.external_id)), removed = [];
  for (const e of Array.isArray(ex.json) ? ex.json : []) {
    if (e.external_id && String(e.external_id).startsWith(PREFIX) && !keep.has(e.external_id)) {
      const d = await iv("DELETE", `/api/v1/athlete/${id}/events/${e.id}`);
      removed.push({ d: e.start_date_local, http: d.status });
    }
  }
  // 1 bis. Nettoyage du 1er du mois (demande de Laurent, 16 nov. 2026) : on retire de la bibliothèque les séances
  // ppl- passées, SAUF la semaine qui précède le 1er (pour pouvoir rattraper une séance manquée).
  const cleaned = [];
  const today = parisToday();
  if (today.getDate() === 1) {
    const lim = new Date(today); lim.setDate(lim.getDate() - 8);          // dernier jour supprimé = 1er − 8 j
    const ymd = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    const old = await iv("GET", `/api/v1/athlete/${id}/events?oldest=2026-01-01&newest=${ymd(lim)}&category=WORKOUT`);
    for (const e of Array.isArray(old.json) ? old.json : []) {
      if (e.external_id && String(e.external_id).startsWith(PREFIX) && String(e.start_date_local).slice(0, 10) <= ymd(lim)) {
        const d = await iv("DELETE", `/api/v1/athlete/${id}/events/${e.id}`);
        cleaned.push({ d: String(e.start_date_local).slice(0, 10), http: d.status });
      }
    }
  }
  // 2. Créer / mettre à jour
  let pushed = [];
  if (plan.events.length) {
    const r = await iv("POST", `/api/v1/athlete/${id}/events/bulk?upsert=true`, plan.events);
    if (r.status !== 200) return { status: "intervals_error", http: r.status, detail: (r.raw || "").slice(0, 300) };
    pushed = (r.json || []).map((e) => ({ d: (e.start_date_local || "").slice(0, 10), name: e.name, steps: e.workout_doc && e.workout_doc.steps ? e.workout_doc.steps.length : null, min: e.moving_time ? Math.round(e.moving_time / 60) : null }));
  }
  return { status: "ok", from: plan.from, to: plan.to, pushed, removed, cleaned };
}

/* Séance BIDON pour tester la chaîne P.P.L → intervals.icu → Garmin (15 nov. 2026).
   mode "push" : crée « PTC TEST » aujourd'hui · mode "del" : la supprime.
   Elle disparaît aussi d'elle-même : la synchro du matin retire tout « ppl-… » absent du plan. */
async function testEvent(mode) {
  if (!process.env.INTERVALS_API_KEY) return { status: "no_api_key" };
  const id = ATHLETE(), k = ymdOf(parisToday()), ext = PREFIX + "test-" + k;
  if (mode === "del") {
    const ex = await iv("GET", `/api/v1/athlete/${id}/events?oldest=${k}&newest=${k}`);
    const hits = (Array.isArray(ex.json) ? ex.json : []).filter((e) => e.external_id === ext);
    for (const e of hits) await iv("DELETE", `/api/v1/athlete/${id}/events/${e.id}`);
    return { status: "deleted", count: hits.length };
  }
  const fake = { label: "Fractionné I · 1/40", short: "3×(1′C/1′M)", typeKey: "fond",
    detail: ["Intensité course : FC < 140 bpm (Z1-Z2), allure ≥ 6′04/km."], _specs: [["FC", "< 140"], ["Cadence", "≥ 170"]] };
  // mode "hr" : même séance, cibles FC seulement (diagnostic : séance vide sur Garmin si l'allure seuil manque ?)
  const descr = mode === "hr"
    ? ["Warmup", "- Marche 5m 50-65% HR", "", "Main Set 3x", "- Course 1m 60-78% HR", "- Marche 1m 50-65% HR intensity=rest", "", "Cooldown", "- Marche 5m 50-65% HR"].join("\n")
    : workoutText(fake);
  const ev = { category: "WORKOUT", type: "Run", start_date_local: k + "T00:00:00", name: "PTC TEST" + (mode === "hr" ? " FC" : "") + " : 3×(1′C/1′M)", description: descr, external_id: ext };
  const r = await iv("POST", `/api/v1/athlete/${id}/events/bulk?upsert=true`, [ev]);
  if (r.status === 401 || r.status === 403) return { status: "intervals_denied", http: r.status };
  if (r.status !== 200) return { status: "intervals_error", http: r.status, detail: (r.raw || "").slice(0, 300) };
  const e = (r.json || [])[0] || {};
  const steps = [];
  (function walk(list, rep) { (list || []).forEach((st) => {
    if (st.steps) return walk(st.steps, st.reps || 1);
    const tgt = st.pace ? ("allure " + JSON.stringify(st.pace)) : st.hr ? ("FC " + JSON.stringify(st.hr)) : "aucune cible";
    steps.push((rep > 1 ? rep + "× " : "") + (st.text || "?") + " · " + (st.duration ? Math.round(st.duration / 60) + "′" : "?") + " · " + tgt);
  }); })(e.workout_doc && e.workout_doc.steps, 1);
  return { status: "ok", date: k, name: e.name, steps, sent: ev.description };
}

module.exports = { testEvent,  sync, buildEvents, isRun, workoutText, paceOf };
