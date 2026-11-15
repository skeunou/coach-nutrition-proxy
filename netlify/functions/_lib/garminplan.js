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
  if (/home-?trainer|H\.T|v[ée]lo|SFR|marche|tapis marche|rando|natation|repos/i.test(lab) && !/fractionn/i.test(lab)) return false;
  return true;
}

/* Texte de séance au format intervals.icu (étapes nommées, cibles en % de la FC max) */
/* Allures du plan → cibles d'allure Garmin (15 nov. 2026, demande de Laurent : « les consignes d'allure, c'est important »).
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
  const m = /allure\s*(≥|>=)?\s*(\d+[′':]\d{2})\s*(?:[–-]\s*(\d+[′':]\d{2}))?\s*\/?\s*km/i.exec(planText(s));
  if (!m) return null;
  const a = sec(m[2]), b = m[3] ? sec(m[3]) : null;
  if (b) return { slow: Math.max(a, b), fast: Math.min(a, b) };
  if (m[1]) return { slow: a + 90, fast: a };          // « allure ≥ 6′04 » : pas plus vite que 6′04 (marge lente 1′30)
  return { slow: a + 10, fast: Math.max(0, a - 10) };
}
const paceTgt = (p) => mmss(p.slow) + "-" + mmss(p.fast) + "/km Pace";
function fcOf(s) { const sp = (s._specs || s.specs || []).find((x) => /^FC/i.test(x[0])); return sp ? String(sp[1]).replace(/\s+/g, " ") : ""; }
function cadOf(s) { const sp = (s._specs || s.specs || []).find((x) => /^Cadence/i.test(x[0])); return sp ? String(sp[1]) : ""; }
function header(s, p) {
  const bits = [];
  if (p) bits.push("Allure " + mmss(p.fast) + " a " + mmss(p.slow) + " par km");
  const fc = fcOf(s); if (fc) bits.push("FC " + fc);
  const cad = cadOf(s); if (cad) bits.push("cadence " + cad);
  return bits.length ? "Consignes : " + bits.join(" · ") + "\n\n" : "";
}
function workoutText(s) {
  const lab = s.label || "", short = s.short || "", p = paceOf(s);
  const run = (min, hr) => "- Course " + min + "m " + (p ? paceTgt(p) : hr);
  let m = /(\d+)\s*×\s*\(\s*(\d+)′C\s*\/\s*(\d+)′M\s*\)/.exec(short);
  if (/fractionn/i.test(lab) && m) {          // Reprise : N × (X′ course / Y′ marche)
    return header(s, p) + ["Échauffement", "- Marche 5m", "", "Fractionné " + m[1] + "x", run(m[2], "60-78% HR"), "- Marche " + m[3] + "m", "", "Retour au calme", "- Marche 5m"].join("\n");
  }
  m = /(\d+)′\s*continu/.exec(short);
  if (/fractionn/i.test(lab) && m) {
    return header(s, p) + ["Échauffement", "- Marche 5m", "", "Corps", run(m[1], "60-78% HR"), "", "Retour au calme", "- Marche 5m"].join("\n");
  }
  const dur = (s.plan && s.plan.durMin) || 0;
  if (/EF continu/i.test(lab) && dur) {       // Réintroduction : EF plat
    return header(s, p) + ["Échauffement", "- Course 5m Z1 HR", "", "Corps", run(Math.max(5, dur - 10), "Z2 HR"), "", "Retour au calme", "- Course 5m Z1 HR"].join("\n");
  }
  // Qualité, côtes, etc. : pas encore convertis (structure propre à chaque séance) → non envoyés, plutôt que faux.
  if (!/\bEF\b|endurance|footing|sortie longue|r[ée]cup/i.test(lab)) return null;
  const d = dur || 45;                          // Endurance générique : échauffement + corps + retour
  return header(s, p) + ["Échauffement", "- Course 10m Z1 HR", "", "Corps", run(Math.max(5, d - 15), "Z2 HR"), "", "Retour au calme", "- Course 5m Z1 HR"].join("\n");
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
  // 2. Créer / mettre à jour
  let pushed = [];
  if (plan.events.length) {
    const r = await iv("POST", `/api/v1/athlete/${id}/events/bulk?upsert=true`, plan.events);
    if (r.status !== 200) return { status: "intervals_error", http: r.status, detail: (r.raw || "").slice(0, 300) };
    pushed = (r.json || []).map((e) => ({ d: (e.start_date_local || "").slice(0, 10), name: e.name, steps: e.workout_doc && e.workout_doc.steps ? e.workout_doc.steps.length : null, min: e.moving_time ? Math.round(e.moving_time / 60) : null }));
  }
  return { status: "ok", from: plan.from, to: plan.to, pushed, removed };
}

module.exports = { sync, buildEvents, isRun, workoutText, paceOf };
