/* Porte HTTP : séances de course du P.P.L → intervals.icu → Garmin.
   GET ?key=RECAP_KEY&dry=1 → aperçu sans rien envoyer · GET ?key=RECAP_KEY → envoi. */
const G = require("./_lib/garminplan.js");
const H = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json", "Cache-Control": "no-store" };
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (!process.env.RECAP_KEY || q.key !== process.env.RECAP_KEY) return { statusCode: 401, headers: H, body: JSON.stringify({ status: "unauthorized" }) };
  try { return { statusCode: 200, headers: H, body: JSON.stringify(await G.sync(q.dry === "1"), null, 1) }; }
  catch (e) { return { statusCode: 200, headers: H, body: JSON.stringify({ status: "error", error: String(e.message || e) }) }; }
};
