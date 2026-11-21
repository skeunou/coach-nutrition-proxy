/* ============================================================
   CONSEIL DU JOUR — pop-up du matin du P.P.L (bêta, 20 nov. 2026)
   POST ?key=RECAP_KEY  { date, dow, night, base, nights, session, renfo }
   → { ok, v:"vert|orange|rouge", titre, nuit, conseils:[…], model }
   L'app envoie la nuit (montre Garmin), ta moyenne 30 j et la séance du jour
   (échanges compris). Haiku rédige un conseil court, sans saisie.
   ============================================================ */
const C = require("./_lib/chat.js");
const H = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST,OPTIONS", "Content-Type": "application/json", "Cache-Control": "no-store" };
const J = (code, o) => ({ statusCode: code, headers: H, body: JSON.stringify(o) });
const num = (x) => (typeof x === "number" && isFinite(x) ? x : null);
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

const SYS = [
  "Tu es le coach trail de Laurent. Chaque matin, dès que sa montre a envoyé sa nuit, tu lui donnes LE conseil du jour pour sa séance, en le reliant à sa nuit.",
  C.PROFILE,
  "",
  "RÈGLES :",
  "- Compare la nuit à SA moyenne 30 j (fournie), pas à une norme générale. Une VFC n'est basse que par rapport à sa moyenne.",
  "- Verdict : vert = séance telle que prévue ; orange = séance faite mais allégée ou bridée (allure, volume, intensité) ; rouge = repos ou séance très douce à la place.",
  "- Séance de reprise (fractionné marche/course) : l'enjeu est la charge sur le pubis, pas le cardio. Une nuit courte ne justifie pas d'annuler une séance de reprise facile ; elle justifie de rester strictement dans les consignes (allure, FC, cadence) et de ne pas accélérer en fin de séance.",
  "- Conseils concrets et chiffrés, tirés des consignes de la séance fournie. Jamais de donnée inventée : un chiffre mesuré vient du contexte.",
  "- Jour sans séance de course : conseil sur le renfo du jour s'il y en a un, ou sur la récupération.",
  "- Ne commente pas une cause absente des données (stress, alcool, travail…).",
  "- Tutoiement, français, ton direct de coach. Pas d'emoji.",
  "",
  "RÉPONDS UNIQUEMENT avec un objet JSON, sans texte autour :",
  '{"v":"vert|orange|rouge","titre":"6 mots max","nuit":"1 phrase : la nuit vs sa moyenne","conseils":["2 à 3 consignes courtes (15 mots max chacune)"]}',
].join("\n");

exports.handler = async (event) => {
  const t0 = Date.now();
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: H, body: "" };
  const q = event.queryStringParameters || {};
  if (!process.env.RECAP_KEY || q.key !== process.env.RECAP_KEY) return J(401, { status: "unauthorized" });
  let b = {}; try { b = JSON.parse(event.body || "{}"); } catch (e) { return J(400, { error: "bad_json" }); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "")) return J(400, { error: "bad_date" });
  const n = b.night || {}, bs = b.base || {}, s = b.session || {};
  const L = [];
  L.push("Date : " + clip(b.dow, 12) + " " + b.date);
  L.push("NUIT : sommeil " + (num(n.sleep) ?? "?") + " h" + (num(n.score) != null ? " (score " + n.score + ")" : "") +
    " · VFC " + (num(n.vfc) ?? "?") + " ms · FC repos " + (num(n.rhr) ?? "?"));
  L.push("SA MOYENNE 30 j (" + (num(bs.n) ?? "?") + " nuits) : sommeil " + (num(bs.sleep) ?? "?") + " h · VFC " + (num(bs.vfc) ?? "?") +
    (num(bs.vfcSd) != null ? " (écart-type " + bs.vfcSd + ")" : "") + " · FC repos " + (num(bs.rhr) ?? "?"));
  if (Array.isArray(b.nights) && b.nights.length)
    L.push("NUITS PRÉCÉDENTES : " + b.nights.slice(0, 4).map((x) => clip(x.d, 10) + " " + (num(x.sleep) ?? "?") + " h / VFC " + (num(x.vfc) ?? "?")).join(" ; "));
  L.push("SÉANCE DU JOUR : " + clip(s.title, 80) + (s.short ? " — " + clip(s.short, 120) : "") + (s.swappedFrom ? " (échangée avec le " + clip(s.swappedFrom, 10) + ")" : "") + (s.done ? " [déjà validée]" : ""));
  if (Array.isArray(s.specs) && s.specs.length) L.push("Consignes chiffrées : " + s.specs.slice(0, 8).map((x) => clip(x, 60)).join(" · "));
  if (s.why) L.push("Objectif de la séance : " + clip(s.why, 300));
  if (Array.isArray(s.detail) && s.detail.length) L.push("Déroulé : " + s.detail.slice(0, 8).map((x) => clip(x, 160)).join(" | "));
  if (b.renfo) L.push("RENFO DU JOUR (programme de son kiné Pascal, fait dans l'appli de Pascal ; facultatif selon sa journée — ne pas détailler d'exercices) : " + clip(b.renfo, 120));
  if (b.yesterday) L.push("HIER : " + clip(b.yesterday, 200));

  const hdr = { "x-api-key": process.env.ANTHROPIC_API_KEY_NUTRITION || "", "anthropic-version": "2023-06-01" };
  const r = await C.post("/v1/messages", { model: "claude-haiku-4-5", max_tokens: 400, system: SYS, messages: [{ role: "user", content: L.join("\n") }] }, hdr, Math.max(2500, 9000 - (Date.now() - t0)));
  const t = r.json && r.json.content ? r.json.content.map((c) => c.text || "").join("").trim() : "";
  if (r.status !== 200 || !t) return J(502, { error: "llm", status: r.status, detail: r.json && r.json.error && r.json.error.message });
  let o = null; try { o = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch (e) {}
  if (!o || !Array.isArray(o.conseils)) return J(502, { error: "parse", raw: t.slice(0, 400) });
  const v = ["vert", "orange", "rouge"].includes(o.v) ? o.v : "orange";
  return J(200, { ok: true, v, titre: clip(o.titre, 60), nuit: clip(o.nuit, 220), conseils: o.conseils.slice(0, 3).map((x) => clip(x, 160)), model: "Haiku" });
};
