/* ============================================================
   DISCUSSION AVEC LE COACH — onglet Coach du P.P.L
   GET  ?key=…&action=thread                 → fil mémorisé + questions restantes
   POST ?key=…  { date, question }           → réponse rapide (Haiku)
   POST ?key=…  { date, question, deep:1 }   → réponse approfondie (Sonnet) lancée
        en arrière-plan : la réponse arrive dans le fil (?action=thread).
   ============================================================ */
const https = require("https");
const C = require("./_lib/chat.js");
const H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" };
const J = (code, o) => ({ statusCode: code, headers: H, body: JSON.stringify(o) });

exports.handler = async (event) => {
  const t0 = Date.now();
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  const q = event.queryStringParameters || {};
  if (!process.env.RECAP_KEY || q.key !== process.env.RECAP_KEY) return J(401, { status: "unauthorized" });
  if (event.httpMethod === "GET") return J(200, await C.thread());
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return J(400, { error: "bad_json" }); }
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(b.date || "") ? b.date : null;
  if (!ymd) return J(400, { error: "bad_date" });
  if (b.deep) {
    // Sonnet ne tient pas dans les 10 s d'une fonction HTTP → arrière-plan
    const host = (event.headers && (event.headers.host || event.headers.Host)) || "coach-nutrition.netlify.app";
    const body = JSON.stringify({ date: ymd, question: b.question });
    await new Promise((resolve) => {
      const r = https.request({ hostname: host, path: "/.netlify/functions/coach-chat-background?key=" + encodeURIComponent(q.key), method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, (res) => { res.resume(); res.on("end", resolve); });
      r.on("error", resolve); r.setTimeout(4000, () => { r.destroy(); resolve(); }); r.write(body); r.end();
    });
    return J(202, { pending: true });
  }
  const r = await C.ask({ ymd, question: b.question, deep: false, deadline: t0 + 9300 });
  return J(200, r);
};
