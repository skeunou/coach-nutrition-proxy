/* ============================================================
   DISCUSSION AVEC LE COACH
   Fil unique et mémorisé dans lv-data (coach/chat.json). Le coach
   répond avec, sous les yeux : le rapport du jour concerné (même
   contexte chiffré que pour l'écrire), les récurrences, les titres
   des derniers rapports et la fin du fil. Haiku par défaut ;
   « réponse approfondie » = Sonnet (en arrière-plan).
   Plafond : 10 questions par jour (Paris).
   ============================================================ */
const https = require("https");
const ST = require("./store.js");
const K = require("./coach.js");

const LIMIT = 10, KEEP = 120;
const PATH = "coach/chat.json";

function post(path, obj, extra, timeoutMs) {
  const body = JSON.stringify(obj);
  return new Promise((resolve) => {
    const r = https.request({ hostname: "api.anthropic.com", path, method: "POST", headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, extra) }, (res) => {
      let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", (e) => resolve({ status: 500, json: { error: { message: e.message } } }));
    r.setTimeout(timeoutMs, () => r.destroy(new Error("timeout")));
    r.write(body); r.end();
  });
}
function parisDay() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(new Date());
}
const sd = (d) => { const p = d.split("-").map(Number); return p[2] + "/" + p[1]; };

const PROFILE = [
  "Profil : Laurent, infirmier libéral (horaires irréguliers, lever souvent à 4h), athlète diesel d'ultra-endurance, VO2max 56, VMA de travail 16,5, FCmax 179. Objectif UT4M 180 (juillet 2027). Limiteurs : économie de grimpe (VAM), durabilité en descente.",
  "Course à pied : JAMAIS avant le J0 de reprise indiqué dans le CALENDRIER (sauf course déjà listée avant). ",
  "Santé : pubalgie réveillée fin septembre 2026, infiltration mi-octobre, reprise très progressive (programme Fractionné de La Clinique du Coureur, trépied adducteurs/transverse/fessiers). Règle douleur : ≤ 2/10 pendant ET normale le lendemain matin. Exclus pendant la reprise : sauts, fentes, squat dynamique, hinge lourd, gros braquet/SFR, étirements forcés des adducteurs. Le kiné et le médecin priment.",
  "Zones FC course : Z1 < 125, Z2 125-143, Z3 143-152, Z4 152-162, Z5 > 162. Vélo : ~10 bpm plus bas.",
  "Matériel : barre + disques, haltères 5/10/15 kg, kettlebell 12-24 kg, TRX + barre de traction, banc, box 51/61/76 cm, élastiques, tapis de course (max 15 %), home-trainer avec puissance, vélo de route, bâtons.",
  "Créneaux habituels : lundi midi EF club, mardi soir côtes club, mercredi variable, jeudi 12h-14h qualité, vendredi renfo, dimanche sortie longue. Renfo 45 min max.",
].join("\n");

const SYS = [
  "Tu es le coach trail de Laurent. Il te pose une question après avoir lu ton rapport. Tu le connais et tu as la mémoire de vos échanges.",
  PROFILE,
  "",
  "COMMENT RÉPONDRE :",
  "- Réponds à SA question, directement, dès la première phrase. Pas de reformulation, pas de préambule.",
  "- Appuie-toi sur ses données (rapport, chiffres, récurrences, échanges passés) quand c'est pertinent, et dis-le (« sur ta sortie de mardi… »).",
  "- Conseils concrets et exécutables : exercice, dosage, repère chiffré, quand le placer dans sa semaine. Adapte TOUJOURS à sa reprise pubienne (rien d'interdit ci-dessus) et à son matériel.",
  "- Si tu lui as déjà dit la même chose (voir le fil ou les récurrences), dis-le franchement et propose autre chose ou insiste sur ce qui bloque.",
  "- Honnête, pas complaisant. Si sa question part d'une mauvaise idée, dis-le et explique pourquoi.",
  "- Tu peux prescrire des dosages (séries, durées, cadences) : c'est ton métier. Mais tu n'inventes JAMAIS une donnée mesurée sur ses séances : un chiffre de ses séances doit venir du contexte fourni.",
  "- Hors de ton champ (douleur qui augmente, symptôme inhabituel, médicament) : renvoie vers son kiné ou son médecin, sans détour.",
  "- Tutoiement, français, ton direct de coach. Court : 3 à 8 phrases, ou une petite liste à tirets si c'est un protocole. Pas d'emoji, pas de formules creuses.",
].join("\n");

async function load(ymd) {
  const [rep, chat, mem, cal, pro] = await Promise.all([ST.readReport(ymd), ST.readJson(PATH), ST.readJson("coach/memoire.json"), ST.readJson("coach/calendrier.json"), ST.readJson("coach/profil.json")]);
  return { report: rep.report || null, chat: (chat.data && chat.data.msgs) ? chat.data : { msgs: [], perDay: {} }, mem: mem.data || null, cal: cal.data || null, profil: pro.data && pro.data.text ? String(pro.data.text) : null };
}

function contextText(ymd, report, mem, cal, profil) {
  const L = [];
  if (profil) L.push("FICHE ATHLÈTE (validée par Laurent) :\n" + profil);
  if (cal && cal.text) L.push("CALENDRIER (issu de son plan, à jour au " + sd(cal.ymd) + ") :\n" + cal.text);
  if (report && report.status === "ok") {
    L.push(`RAPPORT DU ${sd(ymd)} (ce que tu lui as écrit) : ${report.coach.titre}. ${report.coach.passe} ${report.coach.sens} Demain : ${report.coach.demain}`);
    if (report.prompt) L.push("DONNÉES DE CE JOUR (calculées, fiables) :\n" + report.prompt.replace(/\nRédige le compte-rendu\.?$/, "").replace(/FICHE ATHLÈTE \(validée par Laurent\) :\n[\s\S]*?\n(?=PLAN DU JOUR)/, ""));
  } else if (report && report.status === "empty") L.push(`Le ${sd(ymd)} : aucune activité enregistrée.`);
  else L.push(`Pas de rapport disponible pour le ${sd(ymd)}.`);
  if (mem && mem.titles) {
    const t = Object.keys(mem.titles).sort().slice(-10).map((d) => `- ${sd(d)} : ${mem.titles[d]}`);
    if (t.length) L.push("TES DERNIERS RAPPORTS :\n" + t.join("\n"));
  }
  if (mem && mem.byDay) {
    const from = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10), cnt = {};
    Object.keys(mem.byDay).filter((d) => d >= from).forEach((d) => mem.byDay[d].forEach((k) => { (cnt[k] = cnt[k] || []).push(sd(d)); }));
    const r = Object.keys(cnt).filter((k) => cnt[k].length >= 2).map((k) => `- ${K.RECUR_LBL[k] || k} : ${cnt[k].length} fois (${cnt[k].join(", ")})`);
    if (r.length) L.push("DÉFAUTS RÉCURRENTS SUR 3 SEMAINES :\n" + r.join("\n"));
  }
  return L.join("\n\n");
}

const MODELS = { quick: [["claude-haiku-4-5", "Haiku"]], deep: [["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-sonnet-4-5", "Sonnet 4.5"], ["claude-haiku-4-5", "Haiku"]] };

/* Pose la question, enregistre l'échange. Retourne { ok, answer, model, remaining } ou { error } */
async function ask({ ymd, question, deep, deadline }) {
  question = String(question || "").trim().slice(0, 1200);
  if (!question) return { error: "question vide" };
  const today = parisDay();
  const st = await load(ymd);
  const used = (st.chat.perDay && st.chat.perDay[today]) || 0;
  if (used >= LIMIT) return { error: "limite", remaining: 0, message: `Tu as posé tes ${LIMIT} questions du jour. Reprends demain.` };
  const ctx = contextText(ymd, st.report, st.mem, st.cal, st.profil);
  const thread = st.chat.msgs.slice(-16).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: (m.role === "user" ? `[${sd(m.ymd || today)}] ` : "") + m.t }));
  // L'API exige l'alternance user/assistant et un 1er message user : on fusionne si besoin
  const msgs = [];
  thread.forEach((m) => { if (msgs.length && msgs[msgs.length - 1].role === m.role) msgs[msgs.length - 1].content += "\n" + m.content; else msgs.push(m); });
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  const q = `[${sd(ymd)}] ${question}`;
  if (msgs.length && msgs[msgs.length - 1].role === "user") msgs[msgs.length - 1].content += "\n" + q; else msgs.push({ role: "user", content: q });
  const H = { "x-api-key": process.env.ANTHROPIC_API_KEY_NUTRITION || "", "anthropic-version": "2023-06-01" };
  let answer = null, model = null; const tried = [];
  for (const [id, lbl] of MODELS[deep ? "deep" : "quick"]) {
    const budget = deadline - Date.now() - 1800; // garder ~2 s pour enregistrer le fil
    if (budget < 2500) { tried.push(lbl + " : temps insuffisant"); break; }
    const r = await post("/v1/messages", { model: id, max_tokens: deep ? 1100 : 700, system: SYS + "\n\nCONTEXTE :\n" + ctx, messages: msgs }, H, Math.min(deep ? 45000 : 8000, budget));
    const t = r.json && r.json.content ? r.json.content.map((c) => c.text || "").join("").trim() : "";
    if (r.status === 200 && t) { answer = t; model = lbl; break; }
    tried.push(lbl + " : HTTP " + r.status);
  }
  if (!answer) {
    const message = "Le coach n'a pas pu répondre (" + tried.join(" ; ") + "). Réessaie dans un moment — cette question n'est pas décomptée.";
    if (deep) { // en arrière-plan personne n'attend la réponse HTTP : on laisse une trace dans le fil
      const now = new Date().toISOString();
      st.chat.msgs.push({ role: "user", t: question, ymd, at: now }, { role: "coach", t: message, ymd, at: now, model: "erreur" });
      st.chat.msgs = st.chat.msgs.slice(-KEEP); await ST.writeJson(PATH, st.chat, "coach chat erreur");
    }
    return { error: "ia", message, remaining: LIMIT - used };
  }
  const now = new Date().toISOString();
  st.chat.msgs.push({ role: "user", t: question, ymd, at: now }, { role: "coach", t: answer, ymd, at: now, model });
  st.chat.msgs = st.chat.msgs.slice(-KEEP);
  st.chat.perDay = st.chat.perDay || {}; st.chat.perDay[today] = used + 1;
  Object.keys(st.chat.perDay).forEach((d) => { if (d < today) delete st.chat.perDay[d]; });
  const w = await ST.writeJson(PATH, st.chat, "coach chat " + today);
  return { ok: true, answer, model, remaining: LIMIT - used - 1, saved: w.ok };
}

async function thread() {
  const c = await ST.readJson(PATH);
  const data = c.data && c.data.msgs ? c.data : { msgs: [], perDay: {} };
  return { msgs: data.msgs.slice(-60), remaining: LIMIT - ((data.perDay || {})[parisDay()] || 0), limit: LIMIT };
}

module.exports = { ask, thread, contextText, SYS, LIMIT };
