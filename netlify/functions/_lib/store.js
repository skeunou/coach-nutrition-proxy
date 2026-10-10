/* Stockage des rapports du coach dans le repo privé skeunou/lv-data
   (même infra que lvsync, token LV_GH_TOKEN). Un fichier par jour :
   coach/rapport-AAAA-MM-JJ.json (écrasé à chaque régénération). */
const https = require("https");
const REPO = "skeunou/lv-data";

function gh(method, path, bodyObj) {
  const token = process.env.LV_GH_TOKEN;
  return new Promise((resolve) => {
    if (!token) return resolve({ status: 0, json: { error: "LV_GH_TOKEN manquant" } });
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "lv-coach" };
    if (body) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(body); }
    const req = https.request({ hostname: "api.github.com", path, method, headers }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", (e) => resolve({ status: 500, json: { error: e.message } }));
    req.setTimeout(15000, () => req.destroy(new Error("timeout")));
    if (body) req.write(body); req.end();
  });
}
const pathOf = (ymd) => "coach/rapport-" + ymd + ".json";

async function readReport(ymd) {
  const r = await gh("GET", `/repos/${REPO}/contents/${pathOf(ymd)}`);
  if (r.status === 404) return { missing: true };
  if (r.status !== 200 || !r.json) return { error: "lecture lv-data HTTP " + r.status };
  // > 1 Mo : l'API contents ne renvoie pas le contenu → passer par le blob
  let b64 = r.json.content;
  if (!b64 && r.json.sha) { const b = await gh("GET", `/repos/${REPO}/git/blobs/${r.json.sha}`); b64 = b.json && b.json.content; }
  try { return { report: JSON.parse(Buffer.from(b64 || "", "base64").toString("utf8")) }; }
  catch (e) { return { error: "rapport illisible" }; }
}

async function writeReport(ymd, report) {
  const content = Buffer.from(JSON.stringify(report)).toString("base64");
  for (let i = 0; i < 2; i++) { // SHA frais juste avant le PUT ; 1 nouvel essai si conflit
    const cur = await gh("GET", `/repos/${REPO}/contents/${pathOf(ymd)}`);
    const payload = { message: "coach " + ymd, content };
    if (cur.status === 200 && cur.json && cur.json.sha) payload.sha = cur.json.sha;
    const r = await gh("PUT", `/repos/${REPO}/contents/${pathOf(ymd)}`, payload);
    if (r.status === 200 || r.status === 201) return { ok: true };
    if (r.status !== 409) return { ok: false, status: r.status, detail: r.json && r.json.message };
  }
  return { ok: false, status: 409 };
}

module.exports = { readReport, writeReport };
