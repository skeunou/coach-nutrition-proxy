const https = require("https");

/* Stocke l'abonnement Web Push (endpoint + clés) dans skeunou/lv-data,
   fichier "push-sub-<user>.json" = { subscription: {...} | null, updated }.
   Token : variable d'env Netlify LV_GH_TOKEN (déjà utilisée par lvsync.js). */

const REPO = "skeunou/lv-data";

function gh(method, path, token, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "lv-push",
    };
    if (body) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(body); }
    const req = https.request({ hostname: "api.github.com", path, method, headers }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    req.on("error", (e) => resolve({ status: 500, json: { error: e.message } }));
    if (body) req.write(body);
    req.end();
  });
}

function subPath(user) { return "push-sub-" + user + ".json"; }

async function readSub(user, token) {
  const r = await gh("GET", "/repos/" + REPO + "/contents/" + subPath(user), token);
  if (r.status === 404) return { sha: "", data: { subscription: null } };
  if (r.status === 200 && r.json && r.json.content) {
    let data = { subscription: null };
    try { data = JSON.parse(Buffer.from(r.json.content, "base64").toString("utf8")); } catch (e) {}
    return { sha: r.json.sha || "", data };
  }
  return { sha: "", data: null, err: r.status };
}

async function writeSub(user, token, data, sha) {
  const payload = { message: "push-sub " + user, content: Buffer.from(JSON.stringify(data)).toString("base64") };
  if (sha) payload.sha = sha;
  return gh("PUT", "/repos/" + REPO + "/contents/" + subPath(user), token, payload);
}

exports.handler = async (event) => {
  const h = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: h, body: "" };

  const q = event.queryStringParameters || {};
  const action = q.action;
  const user = ((q.user || "laurent").replace(/[^a-z0-9_-]/gi, "").slice(0, 40)) || "laurent";
  const token = process.env.LV_GH_TOKEN;

  if (!token) return { statusCode: 200, headers: h, body: JSON.stringify({ error: "no_token", detail: "LV_GH_TOKEN manquante sur Netlify" }) };

  try {
    if (action === "get") {
      const r = await readSub(user, token);
      if (r.data === null) return { statusCode: 200, headers: h, body: JSON.stringify({ error: "read_failed", status: r.err }) };
      return { statusCode: 200, headers: h, body: JSON.stringify({ subscription: r.data.subscription || null }) };
    }

    if (action === "save" && event.httpMethod === "POST") {
      let inc;
      try { inc = JSON.parse(event.body || "{}"); }
      catch (e) { return { statusCode: 400, headers: h, body: JSON.stringify({ error: "bad_json" }) }; }

      const cur = await readSub(user, token);
      const data = { subscription: inc.subscription || null, updated: Date.now() };
      let w = await writeSub(user, token, data, cur.sha);
      if (w.status === 409) {
        const cur2 = await readSub(user, token);
        w = await writeSub(user, token, data, cur2.sha);
      }
      const ok = w.status === 200 || w.status === 201;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok, cleared: !data.subscription, status: w.status }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "invalid_action" }) };
  } catch (e) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ error: "exception", detail: String((e && e.message) || e) }) };
  }
};
