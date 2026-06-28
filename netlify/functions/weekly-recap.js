const https = require("https");

/* ============================================================
   BILAN HEBDO — LV Coach
   Cron dimanche 19h (Paris). Récupère la semaine Strava + croise
   les ressentis/ZP validés (lvsync), calcule TOUS les chiffres en
   dur, fait écrire l'analyse par Haiku (bridé, zéro invention),
   et l'envoie par mail (Resend).

   Modes HTTP (test) :
   - ?action=demo                 → HTML d'exemple (aucune donnée réelle, aucun envoi)
   - ?action=preview&key=RECAP_KEY → vrai contenu, renvoyé en HTML, AUCUN envoi
   - ?action=run&key=RECAP_KEY     → vrai contenu, ENVOI immédiat
   Sans action  → invocation planifiée (cron) : envoie seulement si l'heure de Paris = 19h.

   Variables d'env :
   - STRAVA_CLIENT_ID (def 260864), STRAVA_CLIENT_SECRET   (déjà sur le site)
   - STRAVA_REFRESH_LAURENT   (NOUVEAU — ton refresh token)
   - ANTHROPIC_API_KEY_NUTRITION   (déjà — pour Haiku)
   - LV_GH_TOKEN   (déjà — pour lire lv-data)
   - RESEND_API_KEY   (NOUVEAU), RECAP_EMAIL (NOUVEAU), RECAP_FROM (option), RECAP_KEY (NOUVEAU)
   ============================================================ */

const FCMAX = 179, Z2HI = Math.round(FCMAX * 0.80), Z4LO = Math.round(FCMAX * 0.87); // 143 / 156
const ACC = "#e8ff47", INK = "#0d0d0f", MUT = "#6b6b78", ORANGE = "#ff6b35";

/* ---------- HTTP utils (node https, sans dépendance) ---------- */
function rq(opts, body) {
  return new Promise((resolve) => {
    const r = https.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    r.on("error", (e) => resolve({ status: 500, json: { error: e.message }, raw: "" }));
    if (body) r.write(body); r.end();
  });
}
function getJSON(host, path, token) {
  return rq({ hostname: host, path, method: "GET", headers: token ? { Authorization: "Bearer " + token, "User-Agent": "lv-recap" } : { "User-Agent": "lv-recap" } });
}
function postJSON(host, path, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "lv-recap" }, extraHeaders || {});
  return rq({ hostname: host, path, method: "POST", headers }, body);
}

/* ---------- Dates (Europe/Paris) ---------- */
function parisNow() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hour12: false });
  const p = {}; f.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
  return { ymd: p.year + "-" + p.month + "-" + p.day, hour: parseInt(p.hour, 10), wd: p.weekday }; // wd: "Mon".."Sun"
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function isoDow(ymd) { const [y, m, d] = ymd.split("-").map(Number); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return wd === 0 ? 7 : wd; } // 1=lun..7=dim
function frDate(ymd) {
  const MOIS = ["janv.", "févr.", "mars", "avril", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const [y, m, d] = ymd.split("-").map(Number); return d + " " + MOIS[m - 1];
}
function hhmm(min) { min = Math.round(min); return min >= 60 ? (Math.floor(min / 60) + "h" + String(min % 60).padStart(2, "0")) : (min + " min"); }

/* ---------- Strava ---------- */
async function stravaAccessToken() {
  const r = await postJSON("www.strava.com", "/api/v3/oauth/token", {
    client_id: process.env.STRAVA_CLIENT_ID || "260864",
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_LAURENT,
    grant_type: "refresh_token",
  });
  return (r.json && r.json.access_token) || null;
}

/* ---------- lvsync : ressentis validés ---------- */
async function fetchLog() {
  const r = await getJSON("coach-nutrition.netlify.app", "/.netlify/functions/lvsync?action=get&user=laurent");
  return (r.json && Array.isArray(r.json.log)) ? r.json.log : [];
}

/* ---------- Agrégation de la semaine ---------- */
function buildFacts(acts, log, monStr, sunStr) {
  function inWk(s) { s = (s || "").slice(0, 10); return s >= monStr && s <= sunStr; }
  const F = { mon: monStr, sun: sunStr, runKm: 0, runD: 0, runN: 0, rideKm: 0, rideD: 0, rideN: 0, totMin: 0, n: 0, efTot: 0, efZ2: 0, hi: 0, longKm: 0, dPlusTot: 0 };
  acts.forEach((a) => {
    const day = (a.start_date_local || a.start_date || "").slice(0, 10);
    if (!inWk(day)) return;
    const t = (a.sport_type || a.type || "").toLowerCase();
    const km = (a.distance || 0) / 1000, dp = a.total_elevation_gain || 0, mn = (a.moving_time || 0) / 60;
    const hr = a.average_heartrate ? Math.round(a.average_heartrate) : null;
    F.totMin += mn; F.n++; F.dPlusTot += dp;
    if (/run/.test(t)) {
      F.runKm += km; F.runD += dp; F.runN++;
      if (km > F.longKm) F.longKm = km;
      if (hr) { F.efTot++; if (hr <= Z2HI) F.efZ2++; if (hr >= Z4LO) F.hi++; }
    } else if (/ride/.test(t)) { F.rideKm += km; F.rideD += dp; F.rideN++; }
  });
  // ressentis (log validé) sur la semaine
  const wk = log.filter((e) => inWk(e.dateKey));
  const rpe = wk.map((e) => parseFloat(e.rpe)).filter((x) => !isNaN(x));
  const zp = wk.map((e) => parseFloat(e.zp)).filter((x) => !isNaN(x));
  F.valid = wk.length;
  F.rpeAvg = rpe.length ? (rpe.reduce((a, b) => a + b, 0) / rpe.length) : null;
  F.zpMax = zp.length ? Math.max.apply(null, zp) : null;
  F.notes = wk.map((e) => (e.note || "").trim()).filter(Boolean).slice(0, 3);
  // arrondis
  F.runKm = Math.round(F.runKm); F.rideKm = Math.round(F.rideKm); F.longKm = Math.round(F.longKm);
  F.runD = Math.round(F.runD); F.rideD = Math.round(F.rideD); F.dPlusTot = Math.round(F.dPlusTot);
  return F;
}

/* ---------- Bloc d'instruction de données pour Haiku (texte) ---------- */
function factsText(F) {
  const L = [];
  L.push("Semaine du " + frDate(F.mon) + " au " + frDate(F.sun) + ".");
  if (F.runN) L.push("Course/Trail : " + F.runKm + " km, " + F.runD + " m D+, " + F.runN + " sortie(s).");
  if (F.rideN) L.push("Vélo : " + F.rideKm + " km, " + F.rideD + " m D+, " + F.rideN + " sortie(s).");
  L.push("Temps d'effort total : " + hhmm(F.totMin) + " sur " + F.n + " activité(s). D+ cumulé : " + F.dPlusTot + " m.");
  if (F.efTot) L.push("Sorties course avec FC mesurée en Z2 (FC ≤ " + Z2HI + ") : " + F.efZ2 + "/" + F.efTot + ".");
  if (F.hi) L.push("Sortie(s) à intensité haute (FC ≥ " + Z4LO + ") : " + F.hi + ".");
  if (F.longKm) L.push("Sortie la plus longue : " + F.longKm + " km.");
  if (F.valid) L.push("Séances validées avec ressenti : " + F.valid + (F.rpeAvg != null ? (", RPE moyen " + F.rpeAvg.toFixed(1) + "/10") : "") + (F.zpMax != null ? (", ZP max " + F.zpMax + "/10 (zone pubienne — pubalgie)") : "") + ".");
  if (F.notes.length) L.push("Notes laissées : " + F.notes.map((n) => '"' + n + '"').join(" ; ") + ".");
  return L.join("\n");
}

/* ---------- Analyse : Haiku bridé, fallback templaté ---------- */
async function coachProse(F) {
  const data = factsText(F);
  const sys = "Tu es le coach trail personnel de Laurent : athlète diesel d'ultra-endurance, prépare l'UT4M 180 Challenge (2027), point de vigilance permanent = pubalgie (suivi via le score ZP). " +
    "Tu écris LE MOT DU COACH du bilan hebdo. RÈGLES ABSOLUES : " +
    "(1) Tu t'appuies UNIQUEMENT sur les données chiffrées fournies ci-dessous ; tu n'inventes AUCUN chiffre, AUCUNE séance, AUCUN fait absent de la liste. " +
    "(2) Si une donnée n'est pas fournie, tu ne la mentionnes pas et tu ne supposes rien. " +
    "(3) Ton direct, concret, de coach à athlète, tutoiement, en français. " +
    "(4) 4 à 6 phrases, en prose continue (pas de liste, pas de titres). Pas de motivation creuse. " +
    "(5) Relie les chiffres entre eux pour en tirer une lecture (volume vs D+, FC en zone, ZP/pubalgie, ressenti). Si ZP ≥ 4, tu le signales clairement.";
  try {
    const r = await postJSON("api.anthropic.com", "/v1/messages", {
      model: "claude-haiku-4-5", max_tokens: 600,
      system: sys,
      messages: [{ role: "user", content: "DONNÉES MESURÉES (n'utilise rien d'autre) :\n" + data + "\n\nRédige le mot du coach." }],
    }, { "x-api-key": process.env.ANTHROPIC_API_KEY_NUTRITION || "", "anthropic-version": "2023-06-01" });
    const txt = r.json && r.json.content ? r.json.content.map((c) => c.text || "").join("").trim() : "";
    if (txt) return txt;
  } catch (e) {}
  // Fallback 100% templaté (zéro invention) si Haiku indisponible
  const bits = [];
  bits.push("Semaine bouclée : " + hhmm(F.totMin) + " d'effort, " + F.dPlusTot + " m de D+ cumulé sur " + F.n + " activité" + (F.n > 1 ? "s" : "") + ".");
  if (F.efTot) bits.push(F.efZ2 === F.efTot ? ("Tes " + F.efTot + " sorties course à FC mesurée sont restées en Z2 — base aérobie propre, exactement ce qu'on veut.") : ("Sur " + F.efTot + " sorties course à FC mesurée, " + F.efZ2 + " seulement sont en Z2 : repolarise, tes faciles doivent rester vraiment faciles."));
  if (F.zpMax != null && F.zpMax >= 4) bits.push("ZP à " + F.zpMax + "/10 cette semaine : on surveille, allège l'adduction et le hinge lourd tant que ça ne redescend pas.");
  else if (F.zpMax != null) bits.push("ZP basse (" + F.zpMax + "/10) : la zone pubienne tient, rien à signaler de ce côté.");
  return bits.join(" ");
}

/* ---------- Email HTML ---------- */
function emailHTML(F, prose) {
  const row = (k, v) => '<tr><td style="padding:9px 12px;border-bottom:1px solid #eee;color:' + MUT + ';font-size:13px">' + k + '</td><td style="padding:9px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700;font-size:14px;color:' + INK + '">' + v + '</td></tr>';
  let rows = "";
  if (F.runN) rows += row("🏃 Course / Trail", F.runKm + " km · " + F.runD + " m D+ · " + F.runN + " sortie" + (F.runN > 1 ? "s" : ""));
  if (F.rideN) rows += row("🚴 Vélo", F.rideKm + " km · " + F.rideD + " m D+ · " + F.rideN + " sortie" + (F.rideN > 1 ? "s" : ""));
  rows += row("⏱️ Temps d'effort", hhmm(F.totMin) + " · " + F.n + " activité" + (F.n > 1 ? "s" : ""));
  rows += row("⛰️ D+ cumulé", F.dPlusTot + " m");
  if (F.efTot) rows += row("💚 EF en Z2 (FC ≤ " + Z2HI + ")", F.efZ2 + "/" + F.efTot);
  if (F.hi) rows += row("🔥 Intensité haute", F.hi + " sortie" + (F.hi > 1 ? "s" : ""));
  if (F.longKm) rows += row("📏 Plus longue", F.longKm + " km");
  if (F.valid) rows += row("📝 Ressentis validés", F.valid + (F.rpeAvg != null ? " · RPE ~" + F.rpeAvg.toFixed(1) : "") + (F.zpMax != null ? " · ZP max " + F.zpMax + "/10" : ""));

  return '<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:20px 14px">' +
    '<div style="background:' + INK + ';border-radius:14px 14px 0 0;padding:18px 20px">' +
    '<div style="color:' + ACC + ';font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:700">LV Coach · Bilan hebdo</div>' +
    '<div style="color:#fff;font-size:22px;font-weight:800;margin-top:4px">Semaine du ' + frDate(F.mon) + ' au ' + frDate(F.sun) + '</div></div>' +
    '<div style="background:#fff;border:1px solid #e7e7ea;border-top:none;border-radius:0 0 14px 14px;padding:6px 8px 18px">' +
    '<table style="width:100%;border-collapse:collapse;margin:6px 0 14px">' + rows + '</table>' +
    '<div style="background:#fafaf7;border-left:3px solid ' + ACC + ';border-radius:8px;padding:14px 16px;margin:0 8px">' +
    '<div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:' + ORANGE + ';margin-bottom:6px">Le mot du coach</div>' +
    '<div style="font-size:14.5px;line-height:1.6;color:#26262b;white-space:pre-wrap">' + prose.replace(/</g, "&lt;") + '</div></div>' +
    '<div style="text-align:center;color:' + MUT + ';font-size:11px;margin-top:16px">Chiffres mesurés (Strava + tes ressentis validés). Analyse rédigée sur ces seules données.</div>' +
    '</div></div></body></html>';
}

/* ---------- Envoi Resend ---------- */
async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY, to = process.env.RECAP_EMAIL;
  if (!key || !to) return { ok: false, why: "RESEND_API_KEY ou RECAP_EMAIL manquant" };
  const r = await postJSON("api.resend.com", "/emails", {
    from: process.env.RECAP_FROM || "LV Coach <onboarding@resend.dev>",
    to: [to], subject, html,
  }, { Authorization: "Bearer " + key });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, detail: r.json };
}

/* ---------- Données de démo (format seulement) ---------- */
function demoFacts() {
  const pn = parisNow();
  const dow = isoDow(pn.ymd), mon = addDays(pn.ymd, -(dow - 1)), sun = addDays(mon, 6);
  return { mon, sun, runKm: 38, runD: 1180, runN: 4, rideKm: 23, rideD: 240, rideN: 1, totMin: 457, n: 6, efTot: 3, efZ2: 2, hi: 1, longKm: 19, dPlusTot: 1420, valid: 3, rpeAvg: 6.3, zpMax: 3, notes: ["jambes lourdes mardi", "super sensation dimanche"] };
}

/* ============================== HANDLER ============================== */
exports.handler = async (event) => {
  const H = { "Content-Type": "text/html; charset=utf-8" };
  const q = (event && event.queryStringParameters) || {};
  const action = q.action || "";
  const KEY = process.env.RECAP_KEY || "";

  // 1) DEMO — format sans aucune donnée réelle ni envoi
  if (action === "demo") {
    const F = demoFacts();
    const prose = "Belle semaine de reprise : " + hhmm(F.totMin) + " d'effort pour " + F.dPlusTot + " m de D+, le volume est là sans te cramer. Sur tes 3 sorties à FC mesurée, 2 sont restées en Z2 — la 3e est montée trop haut, garde tes faciles vraiment faciles pour libérer de la fraîcheur. Ta plus longue à 19 km confirme que la durabilité revient bien. ZP à 3/10 : la zone pubienne tient, on continue comme ça. (Exemple de mise en forme — données fictives.)";
    return { statusCode: 200, headers: H, body: emailHTML(F, prose) };
  }

  // 2) Modes réels protégés par clé
  const isPreview = action === "preview", isRun = action === "run";
  if (isPreview || isRun) {
    if (!KEY || q.key !== KEY) return { statusCode: 401, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "clé invalide (RECAP_KEY)" }) };
  } else if (action) {
    return { statusCode: 400, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: "action inconnue" }) };
  } else {
    // 3) Invocation planifiée (cron) — n'envoyer qu'à 19h de Paris
    const pn = parisNow();
    if (pn.hour !== 19) return { statusCode: 200, body: "skip (heure Paris " + pn.hour + "h, attendu 19h)" };
  }

  // --- Récupération + calcul (commun preview / run / cron) ---
  const pn = parisNow();
  const dow = isoDow(pn.ymd), monStr = addDays(pn.ymd, -(dow - 1)), sunStr = addDays(monStr, 6);
  const token = await stravaAccessToken();
  if (!token) {
    const msg = { error: "strava_auth", detail: "Refresh token Strava invalide/absent (STRAVA_REFRESH_LAURENT)" };
    if (isRun) await sendEmail("⚠️ Bilan hebdo indisponible — reconnecte Strava", "<p>Le bilan n'a pas pu être généré : connexion Strava à renouveler. Rouvre l'app, reconnecte Strava, et mets à jour <b>STRAVA_REFRESH_LAURENT</b>.</p>");
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(msg) };
  }
  const ar = await getJSON("www.strava.com", "/api/v3/athlete/activities?per_page=30", token);
  const acts = Array.isArray(ar.json) ? ar.json : [];
  const log = await fetchLog();
  const F = buildFacts(acts, log, monStr, sunStr);

  if (F.n === 0) {
    const html = emailHTML(F, "Aucune activité enregistrée cette semaine. Repos total ou sorties non synchronisées ? Si tu as bougé, vérifie que c'est bien remonté sur Strava.");
    const subject = "🏔️ Bilan semaine — repos / rien à analyser";
    if (isPreview) return { statusCode: 200, headers: H, body: html };
    const sent = await sendEmail(subject, html);
    return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sent: sent.ok, empty: true, detail: sent }) };
  }

  const prose = await coachProse(F);
  const html = emailHTML(F, prose);
  const subject = "🏔️ Bilan semaine — " + F.runKm + " km · " + F.dPlusTot + " m D+ · " + hhmm(F.totMin);

  if (isPreview) return { statusCode: 200, headers: H, body: html };
  const sent = await sendEmail(subject, html);
  return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sent: sent.ok, week: monStr + "→" + sunStr, n: F.n, detail: sent.detail || sent.why || sent.status }) };
};
