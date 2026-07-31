/* ============================================================
   PORTE D'ENTRÉE HTTP pour daily-session.

   Netlify interdit l'invocation HTTP des fonctions planifiées
   (celles qui ont un `schedule` dans netlify.toml) : elles
   répondent 403 Forbidden. Cette fonction-ci n'est PAS planifiée,
   elle se contente de réutiliser le handler de daily-session.

   Usage :
   - ?action=preview&key=RECAP_KEY → affiche le mail, aucun envoi
   - ?action=run&key=RECAP_KEY     → envoi immédiat
   ============================================================ */
const core = require("./daily-session.js");

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  // Par défaut on prévisualise : jamais d'envoi accidentel depuis le navigateur.
  if (!qs.action) {
    event = Object.assign({}, event, { queryStringParameters: Object.assign({}, qs, { action: "preview" }) });
  }
  try {
    return await core.handler(event);
  } catch (e) {
    return { statusCode: 500, headers: { "Content-Type": "text/plain; charset=utf-8" },
             body: "Erreur daily-session : " + (e && e.stack ? e.stack : e) };
  }
};
