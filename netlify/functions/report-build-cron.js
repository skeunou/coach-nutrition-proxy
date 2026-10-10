/* ============================================================
   GÉNÉRATION AUTOMATIQUE DU SOIR (remplace le mail de 21h).
   Planifiée dans netlify.toml ; n'agit qu'à 21h heure de Paris.
   Calcule le rapport du jour (Sonnet, 8 séances de comparaison)
   et le range dans lv-data : l'onglet Coach l'affiche aussitôt.
   ============================================================ */
const core = require("./daily-report.js");

function parisHour() {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }).format(new Date());
  return parseInt(h, 10) % 24;
}

exports.handler = async (event) => {
  if (parisHour() !== 21) return { statusCode: 200, body: "skip (Paris " + parisHour() + "h)" };
  const ev = Object.assign({}, event, {
    lvDeadline: Date.now() + 27000, lvFull: true, // fonction planifiée : 30 s max
    queryStringParameters: { action: "json", store: "1", key: process.env.RECAP_KEY || "" },
  });
  const r = await core.handler(ev);
  return { statusCode: 200, body: (r && r.body ? String(r.body).slice(0, 300) : "") };
};
