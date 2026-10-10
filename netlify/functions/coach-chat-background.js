/* Réponse approfondie du coach (Sonnet) en arrière-plan : écrit la réponse dans le fil (lv-data). */
const C = require("./_lib/chat.js");
exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  if (!process.env.RECAP_KEY || q.key !== process.env.RECAP_KEY) return { statusCode: 401, body: "" };
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) {}
  try { await C.ask({ ymd: b.date, question: b.question, deep: true, deadline: Date.now() + 90000 }); } catch (e) { console.error("coach-chat-background", e); }
  return { statusCode: 202, body: "" };
};
