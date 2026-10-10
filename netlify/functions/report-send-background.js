/* ============================================================
   ENVOI MANUEL DU RAPPORT — fonction d'arrière-plan (15 min max).
   Sert à recevoir le VRAI mail (coach Sonnet, 8 séances de
   comparaison) sans attendre 21h : le lien répond tout de suite
   (page vide, code 202) et le mail arrive ~30 s plus tard.

   Usage : /.netlify/functions/report-send-background?key=RECAP_KEY&date=AAAA-MM-JJ
   ============================================================ */
const core = require("./daily-report.js");

exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  event = Object.assign({}, event, {
    lvDeadline: Date.now() + 60000, lvFull: true,
    queryStringParameters: Object.assign({}, qs, { action: "run" }),
  });
  try { await core.handler(event); } catch (e) { console.error("report-send-background", e); }
  return { statusCode: 202, body: "" };
};
