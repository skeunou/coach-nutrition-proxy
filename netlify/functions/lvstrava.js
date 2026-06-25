const https = require("https");

const APP_URL = "https://skeunou.github.io/coach-renfo/trail-v2.html";
const CALLBACK_URL = "https://coach-nutrition.netlify.app/.netlify/functions/lvstrava?action=callback";

function postJSON(hostname, path, bodyObj) {
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj);
    const req = https.request(
      { hostname, path, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, json: { error: "parse", raw: d.slice(0, 200) } }); } }); }
    );
    req.on("error", (e) => resolve({ status: 500, json: { error: e.message } }));
    req.write(body); req.end();
  });
}
function getJSON(hostname, path, token) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path, method: "GET", headers: { Authorization: `Bearer ${token}` } },
      (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, json: { error: "parse", raw: d.slice(0, 200) } }); } }); }
    );
    req.on("error", (e) => resolve({ status: 500, json: { error: e.message } }));
    req.end();
  });
}

exports.handler = async (event) => {
  const h = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Content-Type": "application/json" };
  const q = event.queryStringParameters || {};
  const action = q.action;
  const CLIENT_ID = process.env.STRAVA_CLIENT_ID || "260864";
  const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

  // 1) Démarrer l'auth — force le ré-affichage des cases pour tout cocher
  if (action === "connect") {
    const url = `https://www.strava.com/oauth/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(CALLBACK_URL)}&scope=read,activity:read_all&approval_prompt=force`;
    return { statusCode: 302, headers: { Location: url, ...h }, body: "" };
  }

  // 2) Callback — échange code -> tokens, renvoie access + refresh + expiry à l'appli
  if (action === "callback" && q.code) {
    const r = await postJSON("www.strava.com", "/api/v3/oauth/token", {
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: q.code, grant_type: "authorization_code",
    });
    if (r.json && r.json.access_token) {
      const loc = `${APP_URL}?strava_token=${r.json.access_token}&strava_refresh=${r.json.refresh_token}&strava_exp=${r.json.expires_at}`;
      return { statusCode: 302, headers: { Location: loc, ...h }, body: "" };
    }
    return { statusCode: 302, headers: { Location: `${APP_URL}?strava_error=${encodeURIComponent((r.json && r.json.message) || "oauth")}`, ...h }, body: "" };
  }

  // 3) Refresh — renvoie un nouveau access token
  if (action === "refresh" && q.refresh) {
    const r = await postJSON("www.strava.com", "/api/v3/oauth/token", {
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: q.refresh, grant_type: "refresh_token",
    });
    return { statusCode: 200, headers: h, body: JSON.stringify(r.json) };
  }

  // 4) Data — activités récentes
  if (action === "data" && q.token) {
    const r = await getJSON("www.strava.com", "/api/v3/athlete/activities?per_page=10", q.token);
    const acts = r.json;
    if (!Array.isArray(acts)) {
      return { statusCode: 200, headers: h, body: JSON.stringify({ error: (acts && acts.message) || "no_data", detail: acts }) };
    }
    let km = 0, d = 0;
    acts.forEach((a) => { if (a.distance) km += a.distance / 1000; if (a.total_elevation_gain) d += a.total_elevation_gain; });
    return {
      statusCode: 200, headers: h,
      body: JSON.stringify({
        kmRecent: km.toFixed(1), dRecent: Math.round(d),
        last: acts[0] ? { name: acts[0].name, km: (acts[0].distance / 1000).toFixed(1), date: (acts[0].start_date || "").split("T")[0] } : null,
        activities: acts.slice(0, 4).map((a) => ({ name: a.name, type: a.sport_type || a.type, km: (a.distance / 1000).toFixed(1), dplus: Math.round(a.total_elevation_gain || 0), date: (a.start_date || "").split("T")[0] })),
      }),
    };
  }

  return { statusCode: 400, headers: h, body: JSON.stringify({ error: "Invalid action" }) };
};
