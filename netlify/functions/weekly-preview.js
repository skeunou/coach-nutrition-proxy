/* Porte d'entrée HTTP pour weekly-recap (fonction planifiée -> 403 en direct). */
const core = require("./weekly-recap.js");
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  if (!qs.action) event = Object.assign({}, event, { queryStringParameters: Object.assign({}, qs, { action: "preview" }) });
  try { return await core.handler(event); }
  catch (e) { return { statusCode: 500, headers: { "Content-Type": "text/plain; charset=utf-8" }, body: "Erreur weekly-recap : " + (e && e.stack ? e.stack : e) }; }
};
