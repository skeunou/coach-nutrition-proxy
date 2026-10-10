/* ============================================================
   PORTE D'ENTRÉE HTTP pour daily-report (rapport du soir).

   Netlify refuse l'appel HTTP direct d'une fonction planifiée
   (403). Celle-ci n'est pas planifiée : elle réutilise le handler.
   Limite Netlify d'une fonction HTTP = 10 s → on passe une
   échéance à 9 s : si le temps manque, l'aperçu saute l'IA
   plutôt que de planter (le cron de 21h, lui, a 30 s).

   Usage :
   - ?key=RECAP_KEY&date=AAAA-MM-JJ        → aperçu (aucun envoi)
   - ?action=run&key=RECAP_KEY&date=…      → envoi immédiat
   - &debug=1 (faits envoyés au coach) · &nollm=1 (sans IA)
   ============================================================ */
const core = require("./daily-report.js");

exports.handler = async (event) => {
  const t0 = Date.now();
  const qs = (event && event.queryStringParameters) || {};
  event = Object.assign({}, event, {
    lvDeadline: t0 + 9000,
    queryStringParameters: Object.assign({}, qs, { action: qs.action || "preview" }),
  });
  try {
    return await core.handler(event);
  } catch (e) {
    return { statusCode: 500, headers: { "Content-Type": "text/plain; charset=utf-8" },
             body: "Erreur daily-report : " + (e && e.stack ? e.stack : e) };
  }
};
