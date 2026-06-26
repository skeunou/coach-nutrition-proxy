const { getStore } = require("@netlify/blobs");

// Sync multi-appareils du journal + liaisons Strava via Netlify Blobs.
// État stocké par utilisateur : clé "state:<user>" = { log:[], links:{}, rev, updated }.
// Le client garde localStorage comme source primaire ; ce cloud est une couche best-effort.

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

  let store;
  try {
    store = getStore({ name: "lvtrail", consistency: "strong" });
  } catch (e) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ error: "blobs_init", detail: String(e && e.message || e) }) };
  }

  try {
    // Vérif santé : écrit puis relit une valeur témoin
    if (action === "ping") {
      const probe = JSON.stringify({ t: Date.now() });
      await store.set("__ping__", probe);
      const back = await store.get("__ping__");
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, blobs: "up", echo: back }) };
    }

    // Lecture de l'état complet
    if (action === "get") {
      const raw = await store.get("state:" + user);
      if (!raw) return { statusCode: 200, headers: h, body: JSON.stringify({ log: [], links: {}, rev: 0 }) };
      return { statusCode: 200, headers: h, body: raw };
    }

    // Sauvegarde (remplacement complet — le client envoie son état local fusionné)
    if (action === "save" && event.httpMethod === "POST") {
      let inc;
      try { inc = JSON.parse(event.body || "{}"); }
      catch (e) { return { statusCode: 400, headers: h, body: JSON.stringify({ error: "bad_json" }) }; }

      let prevRev = 0;
      try { const raw = await store.get("state:" + user); if (raw) prevRev = (JSON.parse(raw).rev || 0); } catch (e) {}

      const state = {
        log: Array.isArray(inc.log) ? inc.log : [],
        links: (inc.links && typeof inc.links === "object") ? inc.links : {},
        rev: prevRev + 1,
        updated: Date.now(),
      };
      await store.set("state:" + user, JSON.stringify(state));
      return { statusCode: 200, headers: h, body: JSON.stringify({ ok: true, rev: state.rev, count: state.log.length, links: Object.keys(state.links).length }) };
    }

    return { statusCode: 400, headers: h, body: JSON.stringify({ error: "invalid_action" }) };
  } catch (e) {
    return { statusCode: 200, headers: h, body: JSON.stringify({ error: "exception", detail: String(e && e.message || e) }) };
  }
};
