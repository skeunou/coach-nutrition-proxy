/* ============================================================
   DONNÉES DU RAPPORT pour l'onglet « Coach » du P.P.L.
   Lit le rapport déjà calculé dans lv-data (rapide, < 1 s).
   GET ?key=RECAP_KEY&date=AAAA-MM-JJ
   → { status:"ok"|"empty", ... }  ou  { status:"missing" }
   La génération elle-même se fait en arrière-plan
   (report-build-background) : Sonnet + 8 séances de comparaison
   ne tiennent pas dans les 10 s d'une fonction HTTP.
   ============================================================ */
const ST = require("./_lib/store.js");
const H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" };

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  const q = event.queryStringParameters || {};
  if (!process.env.RECAP_KEY || q.key !== process.env.RECAP_KEY) return { statusCode: 401, headers: H, body: JSON.stringify({ status: "unauthorized" }) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(q.date || "")) return { statusCode: 400, headers: H, body: JSON.stringify({ status: "bad_date" }) };
  const r = await ST.readReport(q.date);
  if (r.missing) return { statusCode: 200, headers: H, body: JSON.stringify({ status: "missing", ymd: q.date }) };
  if (r.error) return { statusCode: 200, headers: H, body: JSON.stringify({ status: "error", error: r.error }) };
  return { statusCode: 200, headers: H, body: JSON.stringify(r.report) };
};
