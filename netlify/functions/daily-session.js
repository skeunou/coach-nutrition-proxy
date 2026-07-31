const https = require("https");

/* ============================================================
   SÉANCE DU JOUR — LV Coach
   Cron 4h00 (Paris), 7 j/7, y compris jours de repos.

   Principe : le moteur de plan N'EST PAS dupliqué ici. La fonction
   télécharge trail-v2.html, en extrait les déclarations pures
   (BLOCKS, BLOCKSESS, QUALI, gen, weekTarget…) et les évalue dans un
   bac à sable. Une seule source de vérité : l'app.

   Le mail ne contient PAS de suggestion d'adaptation : à 4h Laurent
   n'a pas encore saisi son état du matin (cf. décision « option A »).
   Il rappelle simplement d'ouvrir l'app.

   Modes HTTP :
   - ?action=preview&key=RECAP_KEY  → HTML, aucun envoi
   - ?action=run&key=RECAP_KEY      → envoi immédiat
   Sans action → cron : envoie seulement si l'heure de Paris = 4h.

   Env : RESEND_API_KEY, RECAP_EMAIL, RECAP_FROM, RECAP_KEY,
         STRAVA_CLIENT_ID/SECRET, STRAVA_REFRESH_LAURENT
   ============================================================ */

const APP_URL = { host: "raw.githubusercontent.com", path: "/skeunou/trail-v2/main/trail-v2.html" };
const ACC = "#e8ff47", INK = "#15171a", MUT = "#7a8088", ORANGE = "#ff6b35", LINE = "#dadfd6", PAPER = "#ffffff", BG = "#ebede9";

/* ---------- HTTP ---------- */
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
function getRaw(host, path) {
  return rq({ hostname: host, path, method: "GET", headers: { "User-Agent": "lv-daily" } });
}
function postJSON(host, path, obj, extra) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "User-Agent": "lv-daily" }, extra || {});
  return rq({ hostname: host, path, method: "POST", headers }, body);
}

/* ---------- Dates (Europe/Paris) ---------- */
function parisNow() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = {}; f.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const MOIS = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const JOURS = ["Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi","Dimanche"];
function frLong(ymd) { const [y,m,d] = ymd.split("-").map(Number); const wd = (new Date(Date.UTC(y,m-1,d)).getUTCDay()+6)%7; return `${JOURS[wd]} ${d} ${MOIS[m-1]}`; }

/* ---------- Extraction du moteur depuis l'app ---------- */
function extractDecl(src, kind, name) {
  const needle = kind === "fn" ? `function ${name}(` : `var ${name}=`;
  const i = src.indexOf(needle);
  if (i < 0) return null;
  if (kind === "fn") {
    let d = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") d++;
      else if (src[j] === "}") { d--; if (d === 0) return src.slice(i, j + 1); }
    }
    return null;
  }
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "[" || c === "{" || c === "(") { d++; started = true; }
    else if (c === "]" || c === "}" || c === ")") d--;
    else if (c === ";" && (!started || d === 0)) return src.slice(i, j + 1);
  }
  return null;
}
const VARS = ["UT4M_DATE","VMA","AUTO_LINK","EPOCH_START","BLOCKS","RACES","BLOCKSESS","QUALI","MOBI_FOCUS","TRAIL_FORCE","Z2PACE","FCZ2","FCZ2HI","FCZ4"];  // NB: certaines déclarations en portent plusieurs (var VMA=16.5, FCMAX=179;)  // NB: certaines déclarations en portent plusieurs (var VMA=16.5, FCMAX=179;)
const FNS = ["iso","parse","dowMon","mondayOf","round5","fmtDur","durStr","fmtMin","paceStr","blockFor","weekInfo","weekTarget","blockSess","raceOn","nextRace","curVMA","pStr","getByDow","sessionId","isRun","gen","renfoFmt","renfoFmtSide","blockRank","pick","metconAllowed","weekCounter"];

function buildEngine(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = scripts.sort((a, b) => b.length - a.length)[0];
  let code = "";
  const missing = [];
  // Les fonctions d'abord : certaines vars sont initialisées par appel (ex. Z2PACE = paceStr(...)).
  FNS.forEach((f) => { const t = extractDecl(src, "fn", f); if (t) code += t + "\n"; else missing.push("fn " + f); });
  VARS.forEach((v) => { const t = extractDecl(src, "var", v); if (t) code += t + "\n"; else missing.push("var " + v); });
  // Stubs : le moteur ne doit toucher ni au DOM ni au stockage
  const prelude = `
    var today = new Date();
    var localStorage = { getItem: function(){ return null; }, setItem: function(){} };
    function refGet(){ return { vma: (typeof VMA!=="undefined"? VMA : 16.5) }; }
    function cloudSave(){}
    var RENFO_WEEK=[], RENFO_CAT_A=[0], RENFO_CAT_B=[0];
  `;
  const runner = `
    ;(function(){ return { setDay:function(d){ today=d; }, gen:gen, weekTarget:weekTarget,
      blockFor:blockFor, blockSess:blockSess, weekInfo:weekInfo, raceOn:raceOn, nextRace:nextRace,
      renfoFmt:(typeof renfoFmt==="function"?renfoFmt:function(){return "";}) }; })()
  `;
  const eng = eval(prelude + code + runner);
  return { eng, missing };
}

/* ---------- Strava : charge des 7 derniers jours ---------- */
async function stravaToken() {
  const r = await postJSON("www.strava.com", "/api/v3/oauth/token", {
    client_id: process.env.STRAVA_CLIENT_ID || "260864",
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    refresh_token: process.env.STRAVA_REFRESH_LAURENT,
    grant_type: "refresh_token",
  });
  return (r.json && r.json.access_token) || null;
}
async function last7(token, ymd) {
  if (!token) return null;
  const after = Math.floor(new Date(ymd + "T00:00:00Z").getTime() / 1000) - 8 * 86400;
  const r = await rq({ hostname: "www.strava.com", path: `/api/v3/athlete/activities?after=${after}&per_page=60`, method: "GET", headers: { Authorization: "Bearer " + token, "User-Agent": "lv-daily" } });
  if (!Array.isArray(r.json)) return null;
  let km = 0, dp = 0, min = 0, n = 0;
  r.json.forEach((a) => {
    const nm = (a.name || "").trim();
    const isRide = /^(h\.?\s*t|vdr)\s*-/i.test(nm) || /ride/i.test(a.type || "");
    n++; min += (a.moving_time || 0) / 60;
    if (!isRide) { km += (a.distance || 0) / 1000; dp += a.total_elevation_gain || 0; }
  });
  return { km: Math.round(km), dp: Math.round(dp), min: Math.round(min), n };
}

/* ---------- Citations réelles et vérifiables ---------- */
const QUOTES = [
  ["Le succès, c'est se lever une fois de plus qu'on est tombé.", "Proverbe japonais"],
  ["Ce n'est pas la montagne que nous conquérons, mais nous-mêmes.", "Edmund Hillary"],
  ["Il faut toujours viser la lune, car même en cas d'échec, on atterrit dans les étoiles.", "Oscar Wilde"],
  ["La discipline est le pont entre les objectifs et les accomplissements.", "Jim Rohn"],
  ["On ne gagne pas une course le jour de la course, on la gagne à l'entraînement.", "Emil Zátopek"],
  ["Un champion est quelqu'un qui se relève quand il ne le peut pas.", "Jack Dempsey"],
  ["Le corps atteint ce que l'esprit croit.", "Proverbe sportif"],
];

/* ---------- Rendu HTML ---------- */
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function mailHTML(ctx) {
  const { ymd, s, blk, tg, wi, load, quote, race } = ctx;
  const detail = (s.detail || []).map((d) => `<li style="margin:0 0 7px;line-height:1.5">${esc(d)}</li>`).join("");
  const specs = (s.specs || []).map(([k, v]) => `<td style="padding:0 14px 0 0"><div style="font-size:10px;color:${MUT};text-transform:uppercase;letter-spacing:.6px">${esc(k)}</div><div style="font-family:Arial,sans-serif;font-size:17px;font-weight:700;color:${INK}">${esc(v)}</div></td>`).join("");
  const tgHTML = tg && tg.dp > 0 ? `
    <tr><td style="padding:14px 18px;border-top:1px solid ${LINE}">
      <div style="font-size:10px;color:${MUT};text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-bottom:6px">Charge de la semaine</div>
      <div style="font-size:14px;color:${INK}">
        <b>${load ? load.km : "—"} / ${tg.km} km</b> &nbsp;·&nbsp; <b>${load ? load.dp : "—"} / ${tg.dp} m D+</b>
        <span style="color:${MUT}"> — ${esc(blk.name)}, semaine ${tg.wb}/${tg.tot}</span>
      </div>
    </td></tr>` : "";
  const raceHTML = race ? `
    <tr><td style="padding:14px 18px;border-top:1px solid ${LINE};background:#fff5f2">
      <div style="font-size:10px;color:${MUT};text-transform:uppercase;letter-spacing:.6px;font-weight:700">Prochaine échéance</div>
      <div style="font-size:14px;color:${INK};margin-top:3px"><b>${esc(race.n)}</b> <span style="color:${MUT}">— ${esc(race.d)}${race.dp ? " · " + race.dp + " m D+" : ""}</span></div>
    </td></tr>` : "";
  return `<!doctype html><html><body style="margin:0;padding:0;background:${BG};font-family:-apple-system,Segoe UI,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:18px 12px">
<tr><td align="center">
  <table width="100%" style="max-width:560px;background:${PAPER};border:1px solid ${LINE};border-radius:18px;overflow:hidden">
    <tr><td style="padding:18px 18px 6px">
      <div style="font-size:11px;color:${MUT};text-transform:uppercase;letter-spacing:1.4px;font-weight:700">${esc(frLong(ymd))}</div>
      <div style="font-size:26px;font-weight:800;color:${INK};margin-top:2px;letter-spacing:-.3px">${esc(s.displayTitle || s.label)}</div>
      <div style="font-size:13px;color:${MUT};margin-top:3px">${esc(s.sub || "")}</div>
    </td></tr>
    ${specs ? `<tr><td style="padding:10px 18px 4px"><table cellpadding="0" cellspacing="0"><tr>${specs}</tr></table></td></tr>` : ""}
    <tr><td style="padding:6px 18px 14px">
      <div style="background:${BG};border-left:3px solid ${ACC};border-radius:10px;padding:11px 13px;font-size:13px;color:${INK};line-height:1.5">${esc(s.why || "")}</div>
    </td></tr>
    ${detail ? `<tr><td style="padding:0 18px 16px"><ul style="margin:0;padding-left:18px;font-size:13.5px;color:${INK}">${detail}</ul></td></tr>` : ""}
    ${tgHTML}
    ${raceHTML}
    <tr><td style="padding:14px 18px;border-top:1px solid ${LINE};background:${BG}">
      <div style="font-size:12.5px;color:${INK};line-height:1.5">
        <b>Ouvre l'app</b> pour saisir ton état du matin — la suggestion d'adaptation s'affichera là.
      </div>
      <a href="https://skeunou.github.io/trail-v2/trail-v2.html" style="display:inline-block;margin-top:10px;background:${ACC};color:#1a1d12;text-decoration:none;font-weight:800;font-size:13px;padding:10px 18px;border-radius:10px">OUVRIR LE P.P.L →</a>
    </td></tr>
    <tr><td style="padding:14px 18px;border-top:1px solid ${LINE}">
      <div style="font-size:12px;color:${MUT};font-style:italic;line-height:1.5">« ${esc(quote[0])} »</div>
      <div style="font-size:11px;color:${MUT};margin-top:3px">— ${esc(quote[1])}</div>
    </td></tr>
  </table>
  <div style="font-size:10.5px;color:${MUT};margin-top:12px">LV Coach · séance du jour · 4h00</div>
</td></tr></table></body></html>`;
}

/* ---------- Envoi ---------- */
async function sendEmail(subject, html) {
  const key = process.env.RESEND_API_KEY, to = process.env.RECAP_EMAIL;
  if (!key || !to) return { ok: false, why: "RESEND_API_KEY ou RECAP_EMAIL manquant" };
  const r = await postJSON("api.resend.com", "/emails", {
    from: process.env.RECAP_FROM || "LV Coach <onboarding@resend.dev>", to: [to], subject, html,
  }, { Authorization: "Bearer " + key });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, detail: r.json };
}

/* ============================== HANDLER ============================== */
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const action = qs.action || "";
  const isPreview = action === "preview", isRun = action === "run";
  const KEY = process.env.RECAP_KEY;
  if ((isPreview || isRun) && (!KEY || qs.key !== KEY)) return { statusCode: 403, body: "clé invalide" };

  const pn = parisNow();
  if (!isPreview && !isRun && pn.hour !== 4) return { statusCode: 200, body: "hors créneau (" + pn.hour + "h)" };

  // 1) moteur
  const app = await getRaw(APP_URL.host, APP_URL.path);
  if (app.status !== 200 || !app.raw) {
    if (isRun) await sendEmail("⚠️ Séance du jour indisponible", "<p>Impossible de télécharger l'app (HTTP " + app.status + ").</p>");
    return { statusCode: 500, body: "app injoignable: " + app.status };
  }
  let eng, missing;
  try { ({ eng, missing } = buildEngine(app.raw)); }
  catch (e) {
    if (isRun) await sendEmail("⚠️ Séance du jour indisponible", "<p>Moteur de plan illisible : " + esc(e.message) + "</p>");
    return { statusCode: 500, body: "moteur KO: " + e.message };
  }

  // 2) séance du jour
  const [Y, M, D] = pn.ymd.split("-").map(Number);
  const day = new Date(Y, M - 1, D);
  eng.setDay(day);
  const s = eng.gen(day);
  const blk = eng.blockFor(day);
  const tg = eng.weekTarget(day);
  const wi = eng.weekInfo(day);
  const nr = eng.nextRace ? eng.nextRace() : null;
  const race = nr ? { n: nr.n, d: nr.d, dp: nr.dp } : null;

  // 3) charge réelle
  let load = null;
  try { load = await last7(await stravaToken(), pn.ymd); } catch (e) {}

  const quote = QUOTES[(Y * 366 + M * 31 + D) % QUOTES.length];
  const html = mailHTML({ ymd: pn.ymd, s, blk, tg, wi, load, quote, race });
  const subject = `${s.displayTitle || s.label} — ${frLong(pn.ymd)}`;

  if (isPreview) return { statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: html + (missing.length ? `<pre style="color:#c00">Déclarations manquantes : ${missing.join(", ")}</pre>` : "") };

  const sent = await sendEmail(subject, html);
  return { statusCode: sent.ok ? 200 : 500, body: JSON.stringify({ sent, missing, day: pn.ymd, session: s.label }) };
};
