const https = require("https");

// Sync multi-appareils via un repo GitHub privé (skeunou/lv-data).
// État par utilisateur : fichier "state-<user>.json" = { log:[], links:{}, rev, updated }.
// Le client garde localStorage comme source primaire ; ce cloud est best-effort.
// Token fourni par la variable d'env Netlify LV_GH_TOKEN.

const REPO = "skeunou/lv-data";

function gh(method, path, token, bodyObj) {
  return new Promise((resolve) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "lv-sync",
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

function statePath(user) { return "state-" + user + ".json"; }

async function readState(user, token) {
  const r = await gh("GET", "/repos/" + REPO + "/contents/" + statePath(user), token);
  if (r.status === 404) return { sha: "", state: { log: [], links: {}, extras: [], rev: 0 } };
  if (r.status === 200 && r.json && r.json.content) {
    let state = { log: [], links: {}, extras: [], rev: 0 };
    try { state = JSON.parse(Buffer.from(r.json.content, "base64").toString("utf8")); } catch (e) {}
    return { sha: r.json.sha || "", state };
  }
  return { sha: "", state: null, err: r.status };
}

async function writeState(user, token, state, sha) {
  const payload = { message: "sync " + user + " rev" + (state.rev || 0), content: Buffer.from(JSON.stringify(state)).toString("base64") };
  if (sha) payload.sha = sha;
  return gh("PUT", "/repos/" + REPO + "/contents/" + statePath(user), token, payload);
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

  if (!token) return { statusCode: 200, headers: h, body: JSON.stringify({ error: "no_token", detail: "Variable d'env LV_GH_TOKEN manquante sur Netlify" }) };

  try {
    if (action === "ping") {
      const r = await gh("GET", "/repos/" + REPO, token);
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: r.status === 200, store: "github", repo: REPO, status: r.status }) };
    }

    if (action === "get") {
      const res = await readState(user, token);
      if (res.state === null) return { statusCode: 200, headers: h, body: JSON.stringify({ error: "read_failed", status: res.err }) };
      return { statusCode: 200, headers: h, body: JSON.stringify(res.state) };
    }

    if (action === "save" && event.httpMethod === "POST") {
      let inc;
      try { inc = JSON.parse(event.body || "{}"); }
      catch (e) { return { statusCode: 400, headers: h, body: JSON.stringify({ error: "bad_json" }) }; }

      let cur = await readState(user, token);
      const state = {
        log: Array.isArray(inc.log) ? inc.log : [],
        links: (inc.links && typeof inc.links === "object") ? inc.links : {},
        extras: Array.isArray(inc.extras) ? inc.extras : ((cur.state && cur.state.extras) || []),
        rev: ((cur.state && cur.state.rev) || 0) + 1,
        updated: Date.now(),
      };
      let w = await writeState(user, token, state, cur.sha);
      if (w.status === 409) {
        cur = await readState(user, token);
        state.rev = ((cur.state && cur.state.rev) || 0) + 1;
        w = await writeState(user, token, state, cur.sha);
      }
      const ok = w.status === 200 || w.status === 201;
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: ok, rev: state.rev, count: state.log.length, links: Object.keys(state.links).length, extras: state.extras.length, status: w.status }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "invalid_action" }) };
  } catch (e) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ error: "exception", detail: String((e && e.message) || e) }) };
  }
};
