/* Planifié (netlify.toml) : chaque matin ~5h Paris, recale les séances de course des 7 prochains jours. */
const G = require("./_lib/garminplan.js");
exports.handler = async () => {
  try { const r = await G.sync(false); console.log("garmin-plan", JSON.stringify(r).slice(0, 500)); }
  catch (e) { console.log("garmin-plan erreur", e.message); }
  return { statusCode: 200 };
};
