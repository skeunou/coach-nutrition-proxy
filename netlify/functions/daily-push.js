const https = require("https");
const webpush = require("web-push");

/* ============================================================
   RAPPEL DU MATIN — P.P.L (Trail V2)
   Cron quotidien 6h (Paris). Compose la notif :
     - séance du jour (calculée depuis le plan)
     - rappel Sortie Longue non validée
     - rappel renfo(s) restant(s) cette semaine
     - un VRAI mantra tiré d'une banque de citations attribuées
   puis l'envoie en Web Push.

   Modes HTTP (test) :
   - ?action=preview&key=PUSH_KEY → JSON de ce qui serait envoyé, AUCUN envoi
   - ?action=run&key=PUSH_KEY     → compose ET envoie immédiatement
   Sans action → invocation planifiée (cron) : n'envoie qu'à 6h de Paris.

   Variables d'env Netlify :
   - PUSH_VAPID_PUBLIC  (clé publique VAPID — non secrète)
   - PUSH_VAPID_PRIVATE (clé privée VAPID — SECRÈTE, à ajouter)
   - PUSH_SUBJECT       (optionnel, def "mailto:coach@lv-tools.app")
   - LV_GH_TOKEN        (déjà présent — lit l'abonnement + le log dans lv-data)
   - PUSH_KEY           (optionnel — protège preview/run)
   ============================================================ */

const REPO = "skeunou/lv-data";
const VAPID_PUBLIC = process.env.PUSH_VAPID_PUBLIC || "BKBxgw0aADf-oHS5xJfvx-USZV807jIXz7hEXjvkcOvY031wwaS2_lN2b2eh3v2-npuM52PtOFu-toMNgjv5FEw";
const VAPID_PRIVATE = process.env.PUSH_VAPID_PRIVATE || "";
const VAPID_SUBJECT = process.env.PUSH_SUBJECT || "mailto:coach@lv-tools.app";

/* ---------- HTTP utils ---------- */
function rq(opts, body) {
  return new Promise((resolve) => {
    const r = https.request(opts, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, json: j, raw: d }); });
    });
    r.on("error", (e) => resolve({ status: 500, json: { error: e.message }, raw: "" }));
    if (body) r.write(body); r.end();
  });
}
function ghGet(path, token) {
  return rq({ hostname: "api.github.com", path, method: "GET", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "lv-push" } });
}
function ghPut(path, token, obj) {
  const body = JSON.stringify(obj);
  return rq({ hostname: "api.github.com", path, method: "PUT", headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github.v3+json", "User-Agent": "lv-push", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, body);
}

/* ---------- Dates (Europe/Paris) ---------- */
function parisNow() {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", hour12: false });
  const p = {}; f.formatToParts(new Date()).forEach((x) => (p[x.type] = x.value));
  return { ymd: p.year + "-" + p.month + "-" + p.day, hour: parseInt(p.hour, 10) };
}
function isoDow(ymd) { const [y, m, d] = ymd.split("-").map(Number); const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return wd === 0 ? 7 : wd; } // 1=lun..7=dim
function addDays(ymd, n) { const [y, m, d] = ymd.split("-").map(Number); const dt = new Date(Date.UTC(y, m - 1, d, 12)); dt.setUTCDate(dt.getUTCDate() + n); return dt.toISOString().slice(0, 10); }
function daysSinceEpoch(ymd) { const [y, m, d] = ymd.split("-").map(Number); return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
const JOURS = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/* ---------- Plan : blocs + phase (miroir de trail-v2) ---------- */
const BLOCKS = [
  { start: "2026-06-14", end: "2026-07-13", phase: "recup" },
  { start: "2026-07-14", end: "2026-08-31", phase: "base" },
  { start: "2026-09-01", end: "2026-10-31", phase: "force" },
  { start: "2026-11-01", end: "2026-12-31", phase: "base" },
  { start: "2027-01-01", end: "2027-02-28", phase: "build" },
  { start: "2027-03-01", end: "2027-03-21", phase: "affutage" },
  { start: "2027-03-22", end: "2027-04-25", phase: "build" },
  { start: "2027-04-26", end: "2027-05-23", phase: "build" },
  { start: "2027-05-24", end: "2027-06-27", phase: "build" },
  { start: "2027-06-28", end: "2027-07-16", phase: "affutage" },
];
function phaseFor(ymd) {
  for (const b of BLOCKS) if (ymd >= b.start && ymd <= b.end) return b.phase;
  return ymd < BLOCKS[0].start ? BLOCKS[0].phase : BLOCKS[BLOCKS.length - 1].phase;
}
// Séance du jour (miroir de gen() — libellé court)
function sessionLabel(phase, dow) {
  if (phase === "affutage") {
    if (dow === 1) return "EF souple club (~50′)";
    if (dow === 2) return "Côtes légères au club (4×2′)";
    if (dow >= 3 && dow <= 5) return "EF léger (30–45′)";
    return "Repos";
  }
  // recup / base / force / build
  if (dow === 1) return "EF Club facile (~50′ · Z2)";
  if (dow === 2) return "Côtes / VAM au club — ton pilier";
  if (dow === 3) return "EF moyen (Z2)";
  if (dow === 4) return "EF relance (optionnel)";
  if (dow === 5) return "Repos / fraîcheur (ou un renfo)";
  return "Repos + ta sortie longue à caler ce week-end";
}

/* ---------- État semaine : SL validée + renfos faits (via lvsync) ---------- */
async function fetchLog(token) {
  const r = await ghGet("/repos/" + REPO + "/contents/state-laurent.json", token);
  if (r.status === 200 && r.json && r.json.content) {
    try { const s = JSON.parse(Buffer.from(r.json.content, "base64").toString("utf8")); return Array.isArray(s.log) ? s.log : []; } catch (e) {}
  }
  return [];
}
function weekStatus(log, mondayStr) {
  const slDone = log.some((e) => e && e.typeKey === "sl-week" && e.wk === mondayStr);
  const slots = {};
  log.forEach((e) => { if (e && e.typeKey === "renfo-supp" && e.wk === mondayStr && e.wslot) slots[e.wslot] = 1; });
  const renfoDone = Object.keys(slots).length;
  return { slDone, renfoDone, renfoTarget: 2 };
}

/* ---------- Abonnement Web Push ---------- */
async function readSub(token) {
  const r = await ghGet("/repos/" + REPO + "/contents/push-sub-laurent.json", token);
  if (r.status === 200 && r.json && r.json.content) {
    try { const d = JSON.parse(Buffer.from(r.json.content, "base64").toString("utf8")); return { sha: r.json.sha || "", sub: d.subscription || null }; } catch (e) {}
  }
  return { sha: "", sub: null };
}
async function clearSub(token, sha) {
  const data = { subscription: null, updated: Date.now() };
  const payload = { message: "push-sub laurent (expiré, purgé)", content: Buffer.from(JSON.stringify(data)).toString("base64") };
  if (sha) payload.sha = sha;
  return ghPut("/repos/" + REPO + "/contents/push-sub-laurent.json", token, payload);
}

/* ---------- Banque de VRAIS mantras (citations attribuées) ---------- */
const MANTRAS = [
  { t: "Aucun humain n'est limité.", a: "Eliud Kipchoge" },
  { t: "Seuls les disciplinés sont libres.", a: "Eliud Kipchoge" },
  { t: "Donner moins que son meilleur, c'est sacrifier le don.", a: "Steve Prefontaine" },
  { t: "La douleur est inévitable. La souffrance est un choix.", a: "Haruki Murakami" },
  { t: "Cours quand tu peux, marche s'il le faut, rampe si tu dois — n'abandonne jamais.", a: "Dean Karnazes" },
  { t: "Un oiseau vole, un poisson nage, un homme court.", a: "Emil Zátopek" },
  { t: "Si tu veux vivre une expérience, cours un marathon.", a: "Emil Zátopek" },
  { t: "Ce n'est pas la montagne que nous vainquons, mais nous-mêmes.", a: "Edmund Hillary" },
  { t: "Ce n'est pas parce que les choses sont difficiles que nous n'osons pas ; c'est parce que nous n'osons pas qu'elles sont difficiles.", a: "Sénèque" },
  { t: "La chance ne sourit qu'aux esprits préparés.", a: "Louis Pasteur" },
  { t: "Tu as pouvoir sur ton esprit, pas sur les événements. Comprends-le, et tu trouveras la force.", a: "Marc Aurèle" },
  { t: "L'obstacle sur le chemin devient le chemin.", a: "Marc Aurèle" },
  { t: "Ce ne sont pas les événements qui troublent les hommes, mais l'idée qu'ils s'en font.", a: "Épictète" },
  { t: "Aucun grand accomplissement n'est soudain.", a: "Épictète" },
  { t: "Ce qui ne te tue pas te rend plus fort.", a: "Friedrich Nietzsche" },
  { t: "Un voyage de mille lieues commence par un seul pas.", a: "Lao Tseu" },
  { t: "Peu importe ta lenteur, tant que tu ne t'arrêtes pas.", a: "Confucius" },
  { t: "Nous sommes ce que nous faisons de façon répétée. L'excellence n'est donc pas un acte, mais une habitude.", a: "Will Durant (d'après Aristote)" },
  { t: "La volonté de se préparer à gagner compte plus que la volonté de gagner.", a: "Vince Lombardi" },
  { t: "Souffre maintenant, et vis le reste de ta vie en champion.", a: "Muhammad Ali" },
  { t: "J'ai échoué encore et encore dans ma vie. C'est pourquoi je réussis.", a: "Michael Jordan" },
  { t: "Les limites, comme les peurs, ne sont souvent qu'une illusion.", a: "Michael Jordan" },
  { t: "Ne prie pas pour une vie facile ; prie pour la force d'endurer une vie difficile.", a: "Bruce Lee" },
  { t: "Je ne crains pas celui qui a pratiqué 10 000 coups une fois, mais celui qui a pratiqué un coup 10 000 fois.", a: "Bruce Lee" },
  { t: "Cela paraît toujours impossible, jusqu'à ce qu'on le fasse.", a: "Nelson Mandela" },
  { t: "La force ne vient pas de la victoire. Ce sont tes luttes qui développent tes forces.", a: "Arnold Schwarzenegger" },
  { t: "Le succès n'est pas un accident : c'est du travail, de la persévérance et l'amour de ce que tu fais.", a: "Pelé" },
  { t: "Le succès, c'est aller d'échec en échec sans perdre son enthousiasme.", a: "Winston Churchill" },
  { t: "Si tu traverses l'enfer, continue d'avancer.", a: "Winston Churchill" },
  { t: "La discipline, c'est choisir entre ce que tu veux maintenant et ce que tu veux le plus.", a: "Abraham Lincoln" },
  { t: "L'homme qui déplace une montagne commence par déplacer de petites pierres.", a: "Confucius" },
  { t: "Tombe sept fois, relève-toi huit.", a: "Proverbe japonais" },
  { t: "La qualité n'est pas un acte, c'est une habitude.", a: "Aristote" },
  { t: "Le corps réalise ce que l'esprit croit.", a: "Napoleon Hill" },
  { t: "On ne subit pas l'avenir, on le fait.", a: "Georges Bernanos" },
  { t: "Fais de ta vie un rêve, et d'un rêve une réalité.", a: "Antoine de Saint-Exupéry" },
];
function mantraOfDay(ymd) { return MANTRAS[((daysSinceEpoch(ymd) % MANTRAS.length) + MANTRAS.length) % MANTRAS.length]; }

/* ---------- Composition de la notif ---------- */
function compose(ymd, phase, status) {
  const dow = isoDow(ymd);
  const label = sessionLabel(phase, dow);
  const lines = ["Aujourd'hui : " + label + "."];

  const training = phase === "base" || phase === "force" || phase === "build";
  // Rappels (uniquement en phase d'entraînement, pas en affûtage)
  const reminders = [];
  if (phase !== "affutage") {
    if (!status.slDone) reminders.push("⚠️ Sortie longue pas encore validée cette semaine.");
    if (training) {
      const left = Math.max(0, status.renfoTarget - status.renfoDone);
      if (left === 1) reminders.push("💪 Il te reste 1 renfo à caler cette semaine.");
      else if (left >= 2) reminders.push("💪 Tes 2 renfos de la semaine sont encore à faire.");
    }
  }
  if (reminders.length) lines.push(reminders.join(" "));
  else if (phase !== "affutage") lines.push("✅ Semaine à jour, beau boulot.");

  const m = mantraOfDay(ymd);
  lines.push("« " + m.t + " » — " + m.a);

  const title = "🏔️ P.P.L · " + JOURS[dow].charAt(0).toUpperCase() + JOURS[dow].slice(1);
  return { title, body: lines.join("\n"), url: "https://skeunou.github.io/trail-v2/trail-v2.html", tag: "ppl-daily-" + ymd };
}

/* ============================== HANDLER ============================== */
exports.handler = async (event) => {
  const J = { "Content-Type": "application/json" };
  const q = (event && event.queryStringParameters) || {};
  const action = q.action || "";
  const KEY = process.env.PUSH_KEY || "";
  const token = process.env.LV_GH_TOKEN;

  // Modes protégés
  const isPreview = action === "preview", isRun = action === "run";
  if (isPreview || isRun) {
    if (!KEY || q.key !== KEY) return { statusCode: 401, headers: J, body: JSON.stringify({ error: "clé invalide (PUSH_KEY)" }) };
  } else if (action) {
    return { statusCode: 400, headers: J, body: JSON.stringify({ error: "action inconnue" }) };
  } else {
    // Cron : n'agir qu'à 6h de Paris
    const pn0 = parisNow();
    if (pn0.hour !== 6) return { statusCode: 200, body: "skip (heure Paris " + pn0.hour + "h, attendu 6h)" };
  }

  if (!token) return { statusCode: 200, headers: J, body: JSON.stringify({ error: "no_token", detail: "LV_GH_TOKEN manquante" }) };

  const pn = parisNow();
  const ymd = pn.ymd, dow = isoDow(ymd), mondayStr = addDays(ymd, -(dow - 1));
  const phase = phaseFor(ymd);
  const log = await fetchLog(token);
  const status = weekStatus(log, mondayStr);
  const payload = compose(ymd, phase, status);

  if (isPreview) return { statusCode: 200, headers: J, body: JSON.stringify({ willSend: true, payload, phase, status }) };

  // Envoi
  if (!VAPID_PRIVATE) return { statusCode: 200, headers: J, body: JSON.stringify({ error: "no_vapid", detail: "PUSH_VAPID_PRIVATE manquante sur Netlify" }) };
  const { sha, sub } = await readSub(token);
  if (!sub) return { statusCode: 200, headers: J, body: JSON.stringify({ error: "no_subscription", detail: "Aucun appareil abonné (active la cloche dans l'app)" }) };

  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    await webpush.sendNotification(sub, JSON.stringify(payload));
    return { statusCode: 200, headers: J, body: JSON.stringify({ sent: true, ymd, payload }) };
  } catch (e) {
    const code = e && e.statusCode;
    if (code === 404 || code === 410) { await clearSub(token, sha); return { statusCode: 200, headers: J, body: JSON.stringify({ sent: false, expired: true, detail: "Abonnement expiré, purgé. Réactive la cloche dans l'app." }) }; }
    return { statusCode: 200, headers: J, body: JSON.stringify({ sent: false, error: "push_failed", code: code || null, detail: String((e && e.message) || e) }) };
  }
};
