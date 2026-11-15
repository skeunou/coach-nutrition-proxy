/* ============================================================
   BIEN-ÊTRE DU MATIN (sommeil, VFC, FC repos) — via intervals.icu
   intervals.icu est partenaire officiel Garmin : il reçoit sommeil, VFC
   (lastNightAvg) et FC de repos, et les expose par son API personnelle.
   GET ?key=RECAP_KEY&days=14
   → { status:"ok", days:[ {d, sleepH, sleepScore, hrv, rhr, readiness} ] }
   Variables Netlify : INTERVALS_API_KEY (secret), INTERVALS_ATHLETE_ID (défaut i800343).
   Lecture seule. Ajouté le 15 nov. 2026.
   ============================================================ */
const https = require("https");
const H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" };
const J = (code, obj) => ({ statusCode: code, headers: H, body: JSON.stringify(obj) });

function ymd(d) { return d.toISOString().slice(0, 10); }
function get(path, apiKey) {
  return new Promise((resolve) => {
    const auth = Buffer.from("API_KEY:" + apiKey).toString("base64");
    const req = https.request({ hostname: "intervals.icu", path, method: "GET", headers: { Authorization: "Basic " + auth, Accept: "application/json", "User-Agent": "lv-wellness" } }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", (e) => resolve({ status: 500, json: { error: e.message } }));
    req.setTimeout(8000, () => req.destroy(new Error("timeout")));
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  const q = event.queryStringParameters || {};
  if (!process.env.RECAP_KEY || q.key !== process.env.RECAP_KEY) return J(401, { status: "unauthorized" });
  const apiKey = process.env.INTERVALS_API_KEY;
  if (!apiKey) return J(200, { status: "no_api_key" });
  const id = (process.env.INTERVALS_ATHLETE_ID || "i800343").replace(/[^a-z0-9]/gi, "");
  const days = Math.max(1, Math.min(60, parseInt(q.days || "14", 10) || 14));
  const now = new Date(Date.now() + 3600 * 1000); // ~heure de Paris pour la date du jour
  const old = new Date(now.getTime() - (days - 1) * 86400000);
  const r = await get(`/api/v1/athlete/${id}/wellness?oldest=${ymd(old)}&newest=${ymd(now)}`, apiKey);
  if (r.status === 401 || r.status === 403) return J(200, { status: "intervals_denied", http: r.status });
  if (r.status !== 200 || !Array.isArray(r.json)) return J(200, { status: "intervals_error", http: r.status });
  // Diagnostic : ?raw=1 → champs bruts renvoyés par intervals.icu (clés non nulles seulement)
  if (q.raw === "1") return J(200, { status: "raw", days: r.json.map((w) => { const o = {}; Object.keys(w).forEach((k) => { if (w[k] != null && w[k] !== "" && !(Array.isArray(w[k]) && !w[k].length)) o[k] = w[k]; }); return o; }) });
  const out = r.json.map((w) => ({
    d: w.id,
    sleepH: typeof w.sleepSecs === "number" ? Math.round(w.sleepSecs / 360) / 10 : null,
    sleepScore: typeof w.sleepScore === "number" ? w.sleepScore : null,
    hrv: typeof w.hrv === "number" ? Math.round(w.hrv) : null,
    rhr: typeof w.restingHR === "number" ? w.restingHR : null,
    readiness: typeof w.readiness === "number" ? w.readiness : null,
  })).filter((x) => x.sleepH != null || x.hrv != null || x.rhr != null);
  return J(200, { status: "ok", days: out });
};
