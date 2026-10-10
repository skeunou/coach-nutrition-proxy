/* ============================================================
   GÉNÉRATION DU RAPPORT en arrière-plan (15 min max) → lv-data.
   Appelé par le bouton « Régénérer l'analyse » de l'onglet Coach.
   Répond tout de suite 202 (page vide) ; le rapport apparaît
   dans report-data ~20-40 s plus tard.
   GET ?key=RECAP_KEY&date=AAAA-MM-JJ [&nollm=1]
   ============================================================ */
const core = require("./daily-report.js");

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  event = Object.assign({}, event, {
    lvDeadline: Date.now() + 60000, lvFull: true,
    queryStringParameters: Object.assign({}, qs, { action: "json", store: "1" }),
  });
  try { await core.handler(event); } catch (e) { console.error("report-build-background", e); }
  return { statusCode: 202, body: "" };
};
