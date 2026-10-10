const https = require("https");
const M = require("./_lib/metrics.js");
const G = require("./_lib/charts.js");
const P = require("./_lib/plan.js");

/* ============================================================
   RAPPORT QUOTIDIEN — LV Coach (remplace le bilan du dimanche
   et le mail « séance du jour » de 4h)

   Cron 21h (Paris), 7 j/7. Pour chaque sortie du jour sur Strava :
   - streams détaillés → VAP, efficacité aérobie, découplage, VAM
     en montée, cadence, zones FC (vélo : cadence vs cible, dérive)
   - comparaison aux 8 dernières séances comparables
   - graphiques PNG générés ici (Gmail ne lit ni SVG ni JS),
     joints en inline (cid:)
   - analyse rédigée par Haiku, bridée aux seuls chiffres calculés
   Aucune sortie dans la journée → aucun mail.

   Modes HTTP :
   - ?action=preview&key=RECAP_KEY[&date=AAAA-MM-JJ] → HTML (images en data:), aucun envoi
   - ?action=run&key=RECAP_KEY[&date=AAAA-MM-JJ]     → envoi immédiat
   - ?action=preview&key=…&nollm=1                    → sans appel Haiku (rapide)
   Sans action → cron : n'agit qu'à 21h heure de Paris.

   Env : STRAVA_CLIENT_ID/SECRET, STRAVA_REFRESH_LAURENT,
         ANTHROPIC_API_KEY_NUTRITION, RESEND_API_KEY, RECAP_EMAIL,
         RECAP_FROM, RECAP_KEY
   ============================================================ */

const HOUR = 21, HIST_N = 8, HIST_DAYS = 70;
const APP = { host: "raw.githubusercontent.com", path: "/skeunou/trail-v2/main/trail-v2.html" };
const INK = "#0d0d0f", ACC = "#e8ff47", ORANGE = "#ff6b35", MUT = "#6b6b78", BG = "#f4f4f5", LINE = "#e7e7ea";
const VAM_TARGET = 1250; // cible fév. 2027 (cahier des charges T2)

/* ---------- HTTP (https natif) ---------- */
function rq(opts, body, timeoutMs) {
  return new Promise((resolve) => {
    const r = https.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    r.on("error", (e) => resolve({ status: 500, json: { error: e.message }, raw: "" }));
    r.setTimeout(timeoutMs || 15000, () => { r.destroy(new Error("timeout")); });
    if (body) r.write(body); r.end();
  });
}
const get = (host, path, token) => rq({ hostname: host, path, method: "GET", headers: Object.assign({ "User-Agent": "lv-report" }, token ? { Authorization: "Bearer " + token } : {}) });
function post(host, path, obj, extra, timeoutMs) {
  const body = JSON.stringify(obj);
  return rq({ hostname: host, path, method: "POST", headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "lv-report" }, extra || {}) }, body, timeoutMs);
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}

/* ---------- Dates (Europe/Paris) ---------- */
function parisNow() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = {}; f.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
  return { ymd: p.year + "-" + p.month + "-" + p.day, hour: parseInt(p.hour, 10) % 24 };
}
function addDays(ymd, n) { const [y, m, d] = ymd.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d, 12)); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function isoDow(ymd) { const [y, m, d] = ymd.split("-").map(Number); const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return w === 0 ? 7 : w; }
const MOIS = ["janv.", "févr.", "mars", "avril", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
function frDate(ymd) { const [, m, d] = ymd.split("-").map(Number); return d + " " + MOIS[m - 1]; }
function frLong(ymd) { return JOURS[isoDow(ymd) - 1] + " " + frDate(ymd); }
const short = (ymd) => { const [, m, d] = ymd.split("-").map(Number); return d + "/" + m; };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/* ---------- Strava ---------- */
async function stravaToken() {
  const r = await post("www.strava.com", "/api/v3/oauth/token", {
    client_id: process.env.STRAVA_CLIENT_ID || "260864", client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_LAURENT, grant_type: "refresh_token",
  });
  return (r.json && r.json.access_token) || null;
}
async function listActs(token, ymd) {
  const after = Math.floor(Date.parse(addDays(ymd, -HIST_DAYS) + "T00:00:00Z") / 1000);
  const before = Math.floor(Date.parse(addDays(ymd, 1) + "T23:59:59Z") / 1000);
  let all = [];
  for (let page = 1; page <= 3; page++) {
    const r = await get("www.strava.com", `/api/v3/athlete/activities?after=${after}&before=${before}&per_page=100&page=${page}`, token);
    if (!Array.isArray(r.json)) break;
    all = all.concat(r.json); if (r.json.length < 100) break;
  }
  return all.sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)));
}
const KEYS = "time,distance,altitude,heartrate,cadence,velocity_smooth,grade_smooth,moving";
async function streams(token, id) {
  const r = await get("www.strava.com", `/api/v3/activities/${id}/streams?keys=${KEYS}&key_by_type=true`, token);
  return r.json && r.json.time ? r.json : null;
}
const dayOf = (a) => String(a.start_date_local || a.start_date || "").slice(0, 10);

/* ---------- Analyse d'une activité ---------- */
function analyse(a, st, extraText) {
  const cls = M.classify(a);
  if (!st) return { cls, m: null };
  if (cls.fam === "ride") return { cls, m: M.rideMetrics(st, M.cadenceTarget(a.description, extraText)) };
  if (cls.fam === "run" || cls.fam === "hike") return { cls, m: M.runMetrics(st) };
  return { cls, m: null };
}
const median = (arr) => { const v = arr.filter((x) => x != null && isFinite(x)).sort((p, q) => p - q); if (!v.length) return null; const k = Math.floor(v.length / 2); return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2; };

/* ---------- Faits chiffrés pour le coach (seule source autorisée) ---------- */
const SUBLBL = { route: "course route", trail: "trail", rando: "rando / marche en montagne", ht: "home-trainer", ht_: "", };
function factsFor(x, hist) {
  const { a, cls, m, note } = x, L = [];
  const head = `« ${a.name} » — ${cls.fam === "ride" ? (cls.sub === "ht" ? "vélo home-trainer" : "vélo route") : SUBLBL[cls.sub] || cls.sub}`;
  L.push("### " + head);
  if (note) L.push(`Note écrite par Laurent sur Strava : "${note}"`);
  if (!m) { L.push(`Durée ${Math.round((a.moving_time || 0) / 60)} min. Pas de données détaillées exploitables.`); return L.join("\n"); }
  const H = hist.map((h) => h.m).filter(Boolean);
  const med = (k) => median(H.map((h) => k(h)));
  const cmp = (label, v, mv, unit, dec) => v == null ? null : `${label} : ${v}${unit}` + (mv != null ? ` (médiane des ${H.length} dernières comparables : ${dec != null ? (+mv).toFixed(dec) : Math.round(mv)}${unit})` : "");
  const push = (s) => { if (s) L.push(s); };
  if (m.kind === "run") {
    L.push(`${m.km} km en ${m.movingMin} min de mouvement, ${m.dPlus} m D+. Allure réelle ${m.pace}/km, allure ajustée à la pente (VAP) ${m.gapPace}/km.`);
    push(cmp("FC moyenne", m.hr, med((h) => h.hr), " bpm"));
    if (m.zones) L.push(`Temps en zones FC (FCmax 179 ; Z1<125, Z2 125-143, Z3 143-152, Z4 152-162, Z5>162) : ` + m.zones.map((z, i) => "Z" + (i + 1) + " " + z + "%").join(", ") + ".");
    push(cmp("Efficacité aérobie EF (VAP m/min ÷ FC, plus haut = mieux)", m.ef, med((h) => h.ef), "", 2));
    if (m.decoupling != null) L.push(m.decouplingValid
      ? cmp("Découplage cardiaque (baisse d'EF 2e moitié vs 1re ; <5 % bon, 5-10 % à surveiller, >10 % dérive marquée)", m.decoupling, med((h) => h.decouplingValid ? h.decoupling : null), " %", 1) + (m.halves ? ` — FC 1re/2e moitié ${m.halves.hr1}/${m.halves.hr2} bpm, allure ${m.halves.pace1}/${m.halves.pace2}.` : "")
      : `Découplage NON interprétable : allure trop variable (fractionné, terrain ou arrêts — coefficient de variation ${m.variability}). Ne pas commenter le découplage.`);
    push(cmp("Cadence moyenne", m.cadence, med((h) => h.cadence), " pas/min"));
    push(cmp("Cadence sur le plat", m.cadenceFlat, med((h) => h.cadenceFlat), " pas/min"));
    if (m.climb) {
      L.push(`Montées (pente ≥ 4 %) : ${m.climb.n} segment(s), ${m.climb.gain} m gravis en ${m.climb.min} min → VAM ${m.climb.vam} m/h` +
        (med((h) => h.climb && h.climb.gain >= 80 ? h.climb.vam : null) != null ? ` (médiane dernières sorties avec ≥80 m de montée : ${Math.round(med((h) => h.climb && h.climb.gain >= 80 ? h.climb.vam : null))} m/h)` : "") +
        `. Cadence en montée ${m.climb.cadence || "—"} pas/min, FC en montée ${m.climb.hr || "—"} bpm.` +
        (m.climb.best ? ` Plus grosse montée : ${m.climb.best.gain} m en ${m.climb.best.min} min (VAM ${m.climb.best.vam} m/h, cadence ${m.climb.best.cadence || "—"}).` : ""));
      if (m.climb.gain < 80) L.push("Montées courtes : VAM peu représentative, à commenter avec prudence.");
    }
    if (m.descentKmh) L.push(`Descentes raides (≤ -8 %) : ${m.descentMin} min à ${m.descentKmh} km/h.`);
  } else {
    L.push(`${m.movingMin} min de mouvement, ${m.km} km${m.dPlus ? ", " + m.dPlus + " m D+" : ""}, ${m.kmh} km/h${cls.sub === "ht" ? " (vitesse virtuelle home-trainer)" : ""}.`);
    push(cmp("Cadence moyenne (hors roue libre)", m.cadence, med((h) => h.cadence), " tr/min"));
    L.push(`Écart-type de cadence ${m.cadenceSd} tr/min ; roue libre ${m.coastPct} % du temps. Répartition : <60 ${m.cadenceHist[0]}%, 60-70 ${m.cadenceHist[1]}%, 70-80 ${m.cadenceHist[2]}%, 80-90 ${m.cadenceHist[3]}%, 90-100 ${m.cadenceHist[4]}%, >100 ${m.cadenceHist[5]}%.`);
    L.push(m.target ? `Cible de cadence de la séance : ${m.target[0]}-${m.target[1]} tr/min → ${m.inTarget} % du temps pédalé dans la cible.` : "Aucune cible de cadence indiquée pour cette séance : ne pas en inventer une.");
    push(cmp("FC moyenne", m.hr, med((h) => h.hr), " bpm"));
    if (m.zones) L.push(`Temps en zones FC : ` + m.zones.map((z, i) => "Z" + (i + 1) + " " + z + "%").join(", ") + ".");
    if (m.hrDrift != null) L.push(cmp("Dérive FC 2e moitié vs 1re", m.hrDrift, med((h) => h.hrDrift), " %", 1) + (m.halves ? ` — FC ${m.halves.hr1}→${m.halves.hr2} bpm, cadence ${m.halves.cad1}→${m.halves.cad2}, vitesse ${m.halves.kmh1}→${m.halves.kmh2} km/h.` : ""));
  }
  return L.join("\n");
}

/* ---------- Haiku ---------- */
const SYS = [
  "Tu es le coach trail et préparateur physique de Laurent : infirmier libéral, athlète « diesel » d'ultra-endurance, VO2max 56. Objectif : UT4M 180 Challenge (juillet 2027, 4 × 44 km, 11 700 m D+). Limiteurs identifiés : économie de grimpe (VAM), durabilité en descente.",
  "Tu rédiges son rapport du soir sur la ou les séances du jour. Il veut un vrai coach : précis, technique, HONNÊTE. Tu n'es pas là pour le flatter : si c'est trop vite, trop haut en FC, une cadence trop basse, ou si la séance ne correspond pas au plan, tu le dis clairement et tu expliques pourquoi ça compte. Si c'est bien, tu le dis aussi, sans en rajouter.",
  "RÈGLES ABSOLUES :",
  "1. Tu n'utilises QUE les chiffres fournis. Aucun chiffre, aucune séance, aucun fait inventé. Si une donnée manque, tu n'en parles pas.",
  "2. Tu compares aux médianes fournies pour situer la séance (progrès, stagnation, régression).",
  "3. Repères : course — cadence cible 170-180 pas/min, en côte sous 165 = surrégime (foulée trop longue) ; footing facile = Z2 (FC 125-143) ; découplage <5 % bon. Vélo — respecter la cible de cadence si elle est donnée ; SFR = 50-55 tr/min ; une cadence très dispersée = pédalage irrégulier.",
  "4. Si la séance réalisée diffère de la séance prévue au plan, tu le relèves sans détour et tu en tires la conséquence.",
  "5. Tutoiement, français, ton de coach à athlète. Pas de formules creuses, pas d'emojis, pas de motivation vide.",
  "Réponds UNIQUEMENT en JSON valide, sans markdown : {\"titre\": \"verdict en 8 mots max\", \"analyse\": \"5 à 8 phrases de prose continue\", \"conseils\": [\"2 ou 3 actions concrètes et chiffrées pour les prochaines séances\"]}",
].join("\n");

async function coach(facts, skipLLM, deadline) {
  const budget = deadline ? deadline - Date.now() - 400 : 20000;
  if (budget < 2500) return null; // plus le temps (aperçu HTTP limité à 10 s)
  if (!skipLLM && process.env.ANTHROPIC_API_KEY_NUTRITION) {
    try {
      const r = await post("api.anthropic.com", "/v1/messages", {
        model: "claude-haiku-4-5", max_tokens: 1100, system: SYS,
        messages: [{ role: "user", content: "DONNÉES MESURÉES (n'utilise rien d'autre) :\n\n" + facts + "\n\nRédige le rapport." }],
      }, { "x-api-key": process.env.ANTHROPIC_API_KEY_NUTRITION, "anthropic-version": "2023-06-01" }, Math.min(20000, budget));
      let t = r.json && r.json.content ? r.json.content.map((c) => c.text || "").join("").trim() : "";
      const mm = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (mm) t = mm[1];
      const s = t.indexOf("{"), e = t.lastIndexOf("}");
      if (s >= 0 && e > s) {
        const j = JSON.parse(t.slice(s, e + 1));
        if (j.analyse) return { titre: String(j.titre || ""), analyse: String(j.analyse), conseils: Array.isArray(j.conseils) ? j.conseils.map(String).slice(0, 3) : [], src: "ia" };
      }
    } catch (e) {}
  }
  return null;
}
/* Repli 100 % calculé si Haiku indisponible : constats factuels, zéro invention */
function fallback(items, outOfTime) {
  const bits = [], tips = [];
  items.forEach(({ m, cls }) => {
    if (!m) return;
    if (m.kind === "run") {
      if (m.cadence) { bits.push(`Cadence moyenne ${m.cadence} pas/min.`); if (m.cadence < 170) tips.push(`Remonte ta cadence vers 170-175 pas/min : raccourcis la foulée plutôt que d'allonger.`); }
      if (m.decouplingValid) bits.push(`Découplage ${m.decoupling} % ${m.decoupling < 5 ? ": base aérobie solide sur cette durée." : ": la FC a dérivé, l'allure était trop ambitieuse pour la durée."}`);
      if (m.zones && cls.sub !== "trail" && m.zones[0] + m.zones[1] < 70) bits.push(`Seulement ${m.zones[0] + m.zones[1]} % du temps sous 143 bpm : ce n'était pas un footing facile.`);
      if (m.climb && m.climb.gain >= 80) bits.push(`VAM en montée ${m.climb.vam} m/h (cible ${VAM_TARGET}).`);
    } else {
      bits.push(`Cadence ${m.cadence} tr/min${m.target ? `, ${m.inTarget} % dans ta cible ${m.target[0]}-${m.target[1]}` : ""}, FC moyenne ${m.hr || "—"} bpm.`);
      if (m.target && m.inTarget < 70) tips.push(`Vise plus de 80 % du temps dans ta cible ${m.target[0]}-${m.target[1]} tr/min.`);
    }
  });
  return { titre: "Les chiffres du jour", analyse: (bits.join(" ") || "Séance enregistrée.") + (outOfTime ? " (Aperçu : coach IA sauté faute de temps — le mail de 21h a 30 s et l'inclura.)" : " (Analyse automatique : le coach IA n'a pas répondu ce soir.)"), conseils: tips.slice(0, 3), src: "calc" };
}

/* ---------- Graphiques ---------- */
function chartsFor(x, hist, imgs) {
  const { m, cls } = x; if (!m) return [];
  const out = [];
  const add = (svg, alt) => { if (!svg) return; try { const id = "c" + (imgs.length + 1) + "-" + Date.now() % 100000; imgs.push({ id, png: G.toPNG(svg), alt }); out.push(id); } catch (e) { x.chartErr = e.message; } };
  const series = (get, filt) => hist.filter((h) => h.m && (!filt || filt(h))).slice(-(HIST_N - 1)).map((h) => ({ label: short(h.day), v: get(h.m), tag: h.cls.sub === "trail" ? "trail" : (h.cls.sub === "rando" ? "rando" : "") }))
    .concat([{ label: short(x.day), v: get(m), today: true }]);
  if (m.kind === "run") {
    add(G.sessionRun(m), "Ta séance : FC et allure VAP");
    if (cls.fam === "run") {
      add(G.bars("Efficacité aérobie", "VAP ÷ FC · plus haut = mieux", series((q) => q.ef), { fmt: (v) => v.toFixed(2) }), "Efficacité aérobie");
      if (m.decouplingValid) add(G.bars("Découplage cardiaque", "séances continues · plus bas = mieux", series((q) => q.decouplingValid ? q.decoupling : null, (h) => h.m.decouplingValid), { zero: true, fmt: (v) => v.toFixed(1) + "%", refs: [{ v: 5, label: "seuil 5 %" }] }), "Découplage cardiaque");
      add(G.bars("Cadence", "pas/min · repère 170", series((q) => q.cadence), { fmt: (v) => Math.round(v), refs: [{ v: 170, label: "170", color: "#4ade80" }] }), "Cadence");
    }
    if (m.climb && m.climb.gain >= 50) add(G.bars("VAM en montée", "m/h · pentes ≥ 4 %", series((q) => q.climb && q.climb.gain >= 50 ? q.climb.vam : null, (h) => h.m.climb && h.m.climb.gain >= 50), { fmt: (v) => Math.round(v), refs: [{ v: VAM_TARGET, label: "cible " + VAM_TARGET }] }), "VAM en montée");
  } else {
    add(G.sessionRide(m), "Ta séance : cadence et FC");
    add(G.cadenceHist(m), "Répartition de la cadence");
    add(G.bars("Cadence moyenne", "tr/min · dernières séances vélo", series((q) => q.cadence), { fmt: (v) => Math.round(v), refs: m.target ? [{ v: m.target[0], label: "cible " + m.target[0] + "-" + m.target[1], color: "#4ade80" }] : [] }), "Cadence moyenne");
    add(G.bars("Dérive cardiaque", "FC 2e moitié vs 1re · plus bas = mieux", series((q) => q.hrDrift), { zero: true, fmt: (v) => v.toFixed(1) + "%" }), "Dérive cardiaque");
  }
  return out;
}

/* ---------- Mail ---------- */
function kpis(x) {
  const { m, a } = x;
  if (!m) return [["Durée", Math.round((a.moving_time || 0) / 60) + " min"]];
  if (m.kind === "run") return [["Distance", m.km + " km"], ["D+", m.dPlus + " m"], ["Allure VAP", m.gapPace], ["FC moy", (m.hr || "—") + ""], ["Cadence", (m.cadence || "—") + ""], m.climb && m.climb.gain >= 50 ? ["VAM", m.climb.vam + ""] : ["Découpl.", m.decouplingValid ? m.decoupling + "%" : "—"]];
  return [["Durée", m.movingMin + " min"], ["Cadence", m.cadence + ""], [m.target ? "Dans cible" : "Écart-type", m.target ? m.inTarget + "%" : "±" + m.cadenceSd], ["FC moy", (m.hr || "—") + ""], ["Dérive FC", m.hrDrift != null ? m.hrDrift + "%" : "—"]];
}
function emailHTML(ctx, imgSrc) {
  const { ymd, items, rep, plan, week } = ctx;
  const cell = ([k, v]) => `<td style="padding:6px 10px 6px 0;vertical-align:top"><div style="font-size:10px;color:${MUT};text-transform:uppercase;letter-spacing:.6px">${esc(k)}</div><div style="font-size:17px;font-weight:800;color:${INK};white-space:nowrap">${esc(v)}</div></td>`;
  const blocks = items.map((x) => {
    const k = kpis(x);
    return `<tr><td style="padding:18px 18px 4px;border-top:1px solid ${LINE}">
      <div style="font-size:11px;color:${ORANGE};text-transform:uppercase;letter-spacing:1px;font-weight:700">${esc(x.typeLbl)}</div>
      <div style="font-size:18px;font-weight:800;color:${INK};margin:2px 0 6px">${esc(x.a.name)}</div>
      <table cellpadding="0" cellspacing="0"><tr>${k.slice(0, 3).map(cell).join("")}</tr><tr>${k.slice(3).map(cell).join("")}</tr></table>
      ${x.note ? `<div style="font-size:12.5px;color:${MUT};font-style:italic;margin:4px 0 2px">Ta note : « ${esc(x.note)} »</div>` : ""}
    </td></tr>` + x.charts.map((id) => `<tr><td style="padding:8px 12px 2px"><img src="${imgSrc(id)}" width="560" alt="${esc((ctx.imgs.find((i) => i.id === id) || {}).alt || "graphique")}" style="display:block;width:100%;max-width:560px;height:auto;border-radius:12px;border:0"></td></tr>`).join("") +
      (x.chartErr && !x.charts.length ? `<tr><td style="padding:6px 18px;font-size:11px;color:${MUT}">Graphiques indisponibles ce soir (${esc(x.chartErr)}).</td></tr>` : "");
  }).join("");
  const conseils = rep.conseils.length ? `<div style="margin-top:12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:${ORANGE}">Pour la suite</div><ul style="margin:6px 0 0;padding-left:18px">${rep.conseils.map((c) => `<li style="margin:0 0 6px;font-size:14px;line-height:1.5;color:#26262b">${esc(c)}</li>`).join("")}</ul>` : "";
  const planLine = plan && plan.label ? `<div style="font-size:12.5px;color:${MUT};margin-top:6px">Prévu au plan : <b style="color:${INK}">${esc(strip(plan.label))}</b>${plan.sub ? " — " + esc(strip(plan.sub)) : ""}${plan.block ? ` <span style="color:${MUT}">(${esc(plan.block)})</span>` : ""}</div>` : "";
  const weekLine = week ? `<tr><td style="padding:14px 18px;border-top:1px solid ${LINE};font-size:13px;color:${INK}"><span style="font-size:10px;color:${MUT};text-transform:uppercase;letter-spacing:.6px;font-weight:700">Semaine en cours</span><br><b>${week.km} km · ${week.dp} m D+</b> course/trail${week.ride ? ` · ${week.ride} min de vélo` : ""}${week.tg && week.tg.km ? ` <span style="color:${MUT}">— cible plan ${week.tg.km} km / ${week.tg.dp} m</span>` : ""}</td></tr>` : "";
  return `<!doctype html><html><body style="margin:0;background:${BG};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG}"><tr><td align="center" style="padding:16px 8px">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:588px;background:#fff;border:1px solid ${LINE};border-radius:16px;overflow:hidden">
  <tr><td style="background:${INK};padding:18px 18px 16px;border-bottom:2px solid ${ACC}">
    <div style="color:${ACC};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700">LV Coach · Rapport du soir</div>
    <div style="color:#fff;font-size:22px;font-weight:800;margin-top:4px">${esc(cap(frLong(ymd)))}</div>
  </td></tr>
  <tr><td style="padding:16px 18px 14px">
    <div style="font-size:20px;font-weight:800;color:${INK};line-height:1.25">${esc(rep.titre)}</div>
    ${planLine}
    <div style="background:#fafaf7;border-left:3px solid ${ACC};border-radius:8px;padding:13px 15px;margin-top:12px;font-size:14.5px;line-height:1.6;color:#26262b">${esc(rep.analyse)}</div>
    ${conseils}
  </td></tr>
  ${blocks}
  ${weekLine}
  <tr><td style="padding:12px 18px 16px;border-top:1px solid ${LINE};font-size:10.5px;color:${MUT};line-height:1.5">
    Chiffres calculés depuis Strava (seconde par seconde). VAP = allure ajustée à la pente · EF = VAP ÷ FC · comparaison avec tes ${HIST_N} dernières séances comparables.${rep.src === "ia" ? " Analyse rédigée par le coach IA sur ces seuls chiffres." : ""}
    <br><a href="https://skeunou.github.io/trail-v2/trail-v2.html" style="color:${INK};font-weight:700">Ouvrir le P.P.L →</a>
  </td></tr>
</table></td></tr></table></body></html>`;
}

async function sendEmail(subject, html, imgs) {
  const key = process.env.RESEND_API_KEY, to = process.env.RECAP_EMAIL;
  if (!key || !to) return { ok: false, why: "RESEND_API_KEY ou RECAP_EMAIL manquant" };
  const r = await post("api.resend.com", "/emails", {
    from: process.env.RECAP_FROM || "LV Coach <onboarding@resend.dev>", to: [to], subject, html,
    attachments: imgs.map((i) => ({ filename: i.id + ".png", content: i.png.toString("base64"), content_id: i.id, content_type: "image/png" })),
  }, { Authorization: "Bearer " + key }, 20000);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, detail: r.json };
}

/* ============================== HANDLER ============================== */
exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const action = q.action || "", KEY = process.env.RECAP_KEY || "";
  const isPreview = action === "preview", isRun = action === "run";
  const J = (code, o) => ({ statusCode: code, headers: { "Content-Type": "application/json" }, body: JSON.stringify(o) });
  if (isPreview || isRun) { if (!KEY || q.key !== KEY) return J(401, { error: "clé invalide (RECAP_KEY)" }); }
  else if (action) return J(400, { error: "action inconnue" });
  const pn = parisNow();
  if (!isPreview && !isRun && pn.hour !== HOUR) return { statusCode: 200, body: `skip (Paris ${pn.hour}h, attendu ${HOUR}h)` };
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(q.date || "") ? q.date : pn.ymd;

  const token = await stravaToken();
  if (!token) {
    if (!isPreview) await sendEmail("⚠️ Rapport du soir indisponible — reconnecte Strava", "<p>Connexion Strava à renouveler : mets à jour <b>STRAVA_REFRESH_LAURENT</b> dans Netlify.</p>", []);
    return J(200, { error: "strava_auth" });
  }
  const acts = await listActs(token, ymd);
  const todays = acts.filter((a) => dayOf(a) === ymd);
  if (!todays.length) return isPreview ? { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: `<p>Aucune activité Strava le ${frDate(ymd)} → pas de mail ce soir-là.</p>` } : J(200, { sent: false, reason: "aucune activité", day: ymd });

  // Plan du jour (moteur extrait de l'app — non bloquant)
  let plan = null, engine = null;
  try { const app = await get(APP.host, APP.path); if (app.status === 200) { engine = P.buildEngine(app.raw); plan = P.plannedFor(engine, ymd); } } catch (e) { plan = null; }
  const planTxt = plan ? [plan.label, plan.sub].concat(plan.detail || []).map(strip).join(" · ") : "";

  // Détail (description) des activités du jour + streams
  const items = await pool(todays, 3, async (a) => {
    const d = await get("www.strava.com", `/api/v3/activities/${a.id}?include_all_efforts=false`, token);
    const full = Object.assign({}, a, d.json && d.json.id ? { description: d.json.description } : {});
    const st = await streams(token, a.id);
    const r = analyse(full, st, planTxt);
    const fam = r.cls.fam;
    const typeLbl = fam === "ride" ? (r.cls.sub === "ht" ? "Vélo · home-trainer" : "Vélo · route") : fam === "run" ? (r.cls.sub === "trail" ? "Trail" : "Course") : fam === "hike" ? "Rando montagne" : (a.sport_type || "Activité");
    return { a: full, day: ymd, cls: r.cls, m: r.m, note: M.userNote(full.description), typeLbl, charts: [] };
  });

  // Historique comparable : 8 dernières séances de la même famille (rando ↔ trail pour la VAM)
  const fams = [...new Set(items.filter((x) => x.m).map((x) => x.cls.fam))];
  const prior = acts.filter((a) => dayOf(a) < ymd);
  const histBy = {};
  const want = [];
  fams.forEach((f) => {
    const sel = prior.filter((a) => { const c = M.classify(a).fam; return f === "hike" ? (c === "hike" || c === "run") : c === f; }).slice(-HIST_N);
    histBy[f] = sel; sel.forEach((a) => { if (!want.includes(a)) want.push(a); });
  });
  const computed = new Map();
  await pool(want, 8, async (a) => { const st = await streams(token, a.id); computed.set(a.id, Object.assign({ day: dayOf(a) }, analyse(a, st, ""))); });
  const histFor = (f) => (histBy[f] || []).map((a) => computed.get(a.id)).filter((h) => h && h.m);

  // Graphiques
  const imgs = [];
  items.forEach((x) => { x.charts = chartsFor(x, histFor(x.cls.fam), imgs); });

  // Charge de la semaine (lundi → jour J)
  const mon = addDays(ymd, -(isoDow(ymd) - 1));
  const wk = acts.filter((a) => dayOf(a) >= mon && dayOf(a) <= ymd);
  const week = {
    km: Math.round(wk.filter((a) => ["run", "hike"].includes(M.classify(a).fam)).reduce((s, a) => s + (a.distance || 0), 0) / 1000),
    dp: Math.round(wk.filter((a) => ["run", "hike"].includes(M.classify(a).fam)).reduce((s, a) => s + (a.total_elevation_gain || 0), 0)),
    ride: Math.round(wk.filter((a) => M.classify(a).fam === "ride").reduce((s, a) => s + (a.moving_time || 0), 0) / 60),
    tg: plan && plan.week,
  };

  // Analyse coach
  const facts = [
    `Date : ${frLong(ymd)}`,
    plan ? `Séance prévue au plan aujourd'hui : ${strip(plan.label)}${plan.sub ? " — " + strip(plan.sub) : ""}${plan.block ? " (bloc : " + plan.block + ")" : ""}.` + (plan.detail && plan.detail.length ? " Détail : " + plan.detail.map(strip).join(" | ") : "") : "Plan du jour : indisponible.",
    `Semaine en cours (lundi → aujourd'hui) : ${week.km} km course/trail, ${week.dp} m D+, ${week.ride} min de vélo` + (week.tg && week.tg.km ? ` ; cible du plan ${week.tg.km} km / ${week.tg.dp} m D+.` : "."),
    "",
  ].concat(items.map((x) => factsFor(x, histFor(x.cls.fam)))).join("\n");
  const deadline = event && event.lvDeadline;
  const rep = (await coach(facts, q.nollm === "1", deadline)) || fallback(items, deadline && Date.now() > deadline - 2900);

  const ctx = { ymd, items, rep, plan, week, imgs };
  const subject = "🏔️ " + frDate(ymd) + " — " + items.map((x) => x.m ? (x.m.kind === "run" ? `${x.typeLbl} ${x.m.km} km` : `${x.typeLbl.split(" · ")[1] === "home-trainer" ? "HT" : "Vélo"} ${x.m.movingMin}′`) : x.typeLbl).join(" · ") + (rep.titre ? " — " + rep.titre : "");

  if (isPreview) {
    const html = emailHTML(ctx, (id) => "data:image/png;base64," + imgs.find((i) => i.id === id).png.toString("base64"));
    const dbg = q.debug === "1" ? `<pre style="white-space:pre-wrap;font-size:11px;padding:12px">${esc(facts)}\n\nrendu: ${esc(G.rendererError() || "ok")}</pre>` : "";
    return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: html.replace("</body>", dbg + "</body>") };
  }
  const html = emailHTML(ctx, (id) => "cid:" + id);
  const sent = await sendEmail(subject, html, imgs);
  return J(200, { sent: sent.ok, day: ymd, activities: items.length, charts: imgs.length, coach: rep.src, renderer: G.rendererError() || "ok", detail: sent.detail || sent.why || sent.status });
};

// Exposé pour les tests hors ligne
exports._test = { factsFor, emailHTML, chartsFor, fallback, kpis, SYS };
