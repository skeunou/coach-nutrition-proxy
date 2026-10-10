/* ============================================================
   COACH — lecture de la note, intention, diagnostic, prompt
   Principe : le CODE pose le diagnostic (constats interprétés et
   priorisés) ; l'IA ne fait que le rédiger comme un coach, avec
   le contexte (note, plan du jour, 3 derniers jours, demain).
   ============================================================ */

const VAM_TARGET = 1250;
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const median = (arr) => { const v = arr.filter((x) => x != null && isFinite(x)).sort((p, q) => p - q); if (!v.length) return null; const k = Math.floor(v.length / 2); return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2; };
const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/* ---------- Intention ---------- */
const INTENTS = [
  ["sfr", /\bsfr\b|basse cadence|gros braquet|force (a )?(velo|basse)/],
  ["race", /\b(course|compet\w*|dossard)\b|🏁/],
  ["test", /\btest\b/],
  ["long", /sortie longue|\bsl\b|\blongue\b/],
  ["threshold", /seuil|tempo|allure (marathon|semi)/],
  ["intervals", /fractionn|\bvma\b|interval|\bcotes?\b|\d+\s*[x×*]\s*\d|30\s*\/\s*30|pyramide/],
  ["recovery", /recup|decrass|souple|regener|tres facile|tourner les jambes|deverrouill|activation|veille (de|d)/],
  ["easy", /footing|facile|\bef\b|endurance|\bz2\b|blabla|tranquille|cool/],
  ["strength", /renfo|trepied|gainage|muscu/],
  ["rest", /\brepos\b/],
];
const INTENT_LBL = { sfr: "SFR (force à basse cadence)", race: "course / compétition", test: "test", long: "sortie longue", intervals: "fractionné / côtes", threshold: "seuil", recovery: "récupération", easy: "footing facile", strength: "renforcement", rest: "repos" };
function intentOf(text) { const t = norm(text); for (const [k, re] of INTENTS) if (re.test(t)) return k; return null; }

/* ---------- Note Strava : « intention, RPE x, pubis … » (tout est optionnel) ---------- */
function parseNote(note) {
  const raw = strip(note), t = norm(raw);
  const out = { raw, intent: null, rpe: null, pubis: null, legs: null };
  if (!raw) return out;
  // intention = le premier morceau avant « RPE » / « pubis », sinon toute la note
  const head = raw.split(/[,;.\n]|\brpe\b|\bpubis\b/i)[0];
  out.intent = intentOf(head) || intentOf(raw);
  // « Jambe(s) : 6/10 » = sensation des jambes (échelle de Laurent), jamais confondue avec le RPE
  let lg = /\bjambes?\s*:?\s*(\d+(?:[.,]\d)?)\s*\/\s*10/.exec(t);
  if (lg) out.legs = parseFloat(lg[1].replace(",", "."));
  // RPE : « RPE 6 », sinon un « x/10 » qui n'est ni pubis/ZP ni jambes
  const tR = t.replace(/(pubis|\bzp\b|jambes?)[^,;\n]*/g, "");
  let m = /\brpe\s*[:=]?\s*(\d+(?:[.,]\d)?)/.exec(t) || /\b(\d+(?:[.,]\d)?)\s*\/\s*10\b/.exec(tR);
  if (m) { const v = parseFloat(m[1].replace(",", ".")); if (v >= 0 && v <= 10) out.rpe = v; }
  // « ZP pré : 3/10 », « ZP post : 3/10 » (zone pubienne) → on garde le niveau le plus haut
  const zps = [...t.matchAll(/\bzp\s*(pre|post|avant|apres)?\s*:?\s*(\d+(?:[.,]\d)?)\s*\/\s*10/g)];
  if (zps.length) {
    const lv = Math.max(...zps.map((z) => parseFloat(z[2].replace(",", "."))));
    out.pubis = { level: lv, txt: zps.map((z) => "ZP " + (z[1] ? z[1].replace("pre", "pré").replace("apres", "après") + " " : "") + z[2] + "/10").join(", "), where: zps.length > 1 ? "avant → après la séance" : null };
    return out;
  }
  m = /pubis\s*:?\s*([^,;.\n]*)/.exec(t);
  if (m) {
    const s = m[1].trim();
    const lv = /(\d+(?:[.,]\d)?)\s*\/\s*10/.exec(s) || /^(\d+(?:[.,]\d)?)\b/.exec(s);
    const where = /(vers|a partir|des|au|apres)[^,;]*/.exec(s);
    if (/\b(ras|ok|rien|0)\b|nickel|aucune?/.test(s) && !lv) out.pubis = { level: 0, txt: "RAS" };
    else if (lv) out.pubis = { level: parseFloat(lv[1].replace(",", ".")), txt: s, where: where ? where[0] : null };
    else if (s) out.pubis = { level: null, txt: s };
  } else if (/pubalgi|adducteur/.test(t)) out.pubis = { level: null, txt: "mentionné dans la note" };
  return out;
}

/* ---------- Diagnostic (constats interprétés, priorisés) ---------- */
function diagnose(x, hist, intent, note) {
  const { m, cls } = x, C = [];
  const add = (p, t, tone) => C.push({ p, t, tone: tone || "neutre" });
  if (note && note.pubis) {
    const pl = note.pubis.level;
    if (pl == null) add(50, note.pubis.txt === "mentionné dans la note" ? "La note évoque la pubalgie sans niveau de douleur : impossible de juger l'évolution (écris « pubis x/10 »)." : `Pubis : « ${note.pubis.txt} », sans niveau /10.`, "vigilance");
    else if (pl >= 4) add(100, `Pubis à ${pl}/10${note.pubis.where ? " (" + note.pubis.where + ")" : ""} : signal d'alerte en pleine reprise, il conditionne la suite plus que les chiffres.`, "alerte");
    else if (pl > 0) add(85, `Pubis à ${pl}/10${note.pubis.where ? " (" + note.pubis.where + ")" : ""} : gêne légère, tolérable si elle ne monte pas le lendemain matin.`, "vigilance");
    else add(30, "Pubis RAS pendant la séance.", "positif");
  }
  if (!m) {
    const pi = x.planIntent;
    if (pi === "strength" && /weight|workout|crossfit|training|renfo|muscu/i.test((x.a.sport_type || "") + " " + (x.a.name || ""))) add(40, "Séance de renforcement conforme au plan du jour.", "positif");
    else if (pi === "rest") add(70, `Le plan prévoyait du repos : ${Math.round((x.a.moving_time || 0) / 60)} min d'activité à la place.`, "vigilance");
    else if (pi && intent && pi !== intent) add(50, `Plan du jour (${INTENT_LBL[pi] || pi}) différent de ce que tu as fait (${INTENT_LBL[intent] || intent}).`, "neutre");
    if (note && note.rpe != null) add(note.rpe >= 8 ? 60 : 30, `Ressenti ${note.rpe}/10${note.rpe >= 8 ? " : séance coûteuse, à prendre en compte pour demain" : ""}.`, note.rpe >= 8 ? "vigilance" : "neutre");
    if (x.a.average_heartrate) add(20, `FC moyenne ${Math.round(x.a.average_heartrate)} bpm sur ${Math.round((x.a.moving_time || 0) / 60)} min.`, "neutre");
    if (!C.length) add(10, "Pas de données exploitables au-delà de la durée : la note (intention, RPE) est ce qui permet de juger ce type de séance.", "neutre");
    return C.sort((a, b) => b.p - a.p);
  }
  const H = hist.map((h) => h.m).filter(Boolean);
  if (m.hrSuspect) add(95, "FC probablement faussée : sur une bonne partie de la sortie elle colle à ta cadence (artefact classique du capteur au poignet). Zones, découplage et efficacité ne sont pas fiables aujourd'hui.", "alerte");
  const z = m.hrSuspect ? null : (m.zones || null);
  const z12 = z ? z[0] + z[1] : null, z3p = z ? z[2] + z[3] + z[4] : null, z45 = z ? z[3] + z[4] : null;
  const easyLike = ["easy", "recovery", "long"].includes(intent);
  const hardLike = ["intervals", "threshold", "race", "test"].includes(intent);

  if (z) {
    if (easyLike && z3p >= 25) add(90, `Séance voulue ${INTENT_LBL[intent]} mais ${z3p} % du temps au-dessus de 143 bpm (Z3+) : trop intense. Tu accumules de la fatigue sans le bénéfice d'une vraie séance de qualité.`, "alerte");
    else if (easyLike) add(40, `${z12} % du temps en Z1-Z2 : intensité respectée pour une séance ${INTENT_LBL[intent]}.`, "positif");
    else if (hardLike && intent !== "test" && z45 < 8 && m.kind === "run") add(70, `Seulement ${z45} % du temps en Z4-Z5 sur une séance ${INTENT_LBL[intent]} : l'intensité visée n'a pas été atteinte.`, "vigilance");
    else if (hardLike) add(40, `${z45} % du temps en Z4-Z5 (${INTENT_LBL[intent]}).`, "neutre");
    else if (!intent && z[2] >= 35) add(60, `${z[2]} % du temps en Z3 (143-152 bpm) : zone « grise », trop dure pour récupérer, trop facile pour progresser.`, "vigilance");
  }
  if (note && note.rpe != null && z) {
    if (note.rpe >= 7 && easyLike) add(85, `Ressenti ${note.rpe}/10 sur une séance censée être facile : décalage qui signale de la fatigue accumulée.`, "alerte");
    else if (note.rpe <= 4 && z3p >= 40) add(55, `FC haute (${z3p} % en Z3+) mais ressenti bas (${note.rpe}/10) : chaleur, déshydratation, fatigue nerveuse ou mesure au poignet à vérifier.`, "vigilance");
  }

  if (m.kind === "run") {
    if (m.cadenceFlat && m.cadenceFlat < 168) add(60, `Cadence sur le plat ${m.cadenceFlat} pas/min (repère 170-180) : foulée trop longue, plus de freinage à chaque appui et plus de charge excentrique.`, "vigilance");
    if (m.climb && m.climb.gain >= 50 && m.climb.cadence) {
      if (m.climb.cadence < 165) add(65, `Cadence en montée ${m.climb.cadence} pas/min (< 165) : tu montes en surrégime, foulée trop ample. Raccourcis et garde le rythme des pieds.`, "vigilance");
      else if (m.cadenceFlat && m.cadenceFlat - m.climb.cadence >= 8) add(50, `La cadence chute de ${m.cadenceFlat - m.climb.cadence} pas/min en montée (${m.cadenceFlat} → ${m.climb.cadence}) : tu allonges au lieu de raccourcir.`, "vigilance");
    }
    if (m.cadence && m.cadence >= 170 && !C.some((c) => /Cadence/.test(c.t))) add(25, `Cadence ${m.cadence} pas/min : dans la cible.`, "positif");
    if (m.decouplingValid && m.movingMin >= 35) {
      if (m.decoupling >= 10) add(75, `Découplage ${m.decoupling} % : la FC a nettement dérivé en 2e moitié, l'allure était trop ambitieuse pour la durée (ou chaleur/hydratation).`, "alerte");
      else if (m.decoupling >= 5) add(60, `Découplage ${m.decoupling} % : dérive modérée en 2e moitié, ta base aérobie n'encaisse pas encore cette allure sur cette durée.`, "vigilance");
      else add(35, `Découplage ${m.decoupling} % sur une allure régulière : base aérobie solide sur ${m.movingMin} min.`, "positif");
    }
    if (m.splitPct != null && ["race", "long", "threshold", "test", "easy"].includes(intent)) {
      if (m.splitPct >= 8) add(intent === "race" || intent === "long" ? 80 : 55, `2e moitié ${m.splitPct} % plus lente que la 1re à pente égale (VAP) : ${intent === "race" ? "départ trop rapide, tu as payé la fin" : "l'allure n'a pas tenu sur la durée"}.`, "vigilance");
      else if (m.splitPct <= -2 && (intent === "race" || intent === "long")) add(45, `2e moitié plus rapide que la 1re à pente égale (VAP, ${m.splitPct} %) : course bien gérée, tu as gardé de la réserve.`, "positif");
      else if (intent === "race" || intent === "long") add(40, `Allure régulière entre les deux moitiés à pente égale (écart ${m.splitPct} %) : effort bien réparti.`, "positif");
    }
    const efMed = median(H.map((h) => h.ef));
    if (m.ef && efMed && H.length >= 3 && !m.hrSuspect) {
      const d = Math.round((m.ef / efMed - 1) * 100);
      if (Math.abs(d) >= 4) add(50, `Efficacité aérobie ${m.ef} vs ${efMed.toFixed(2)} habituellement (${d > 0 ? "+" : ""}${d} %) : ${d > 0 ? "plus de vitesse pour le même cœur" : "moins de vitesse pour le même cœur"}${H.length < 5 ? " (peu de recul)" : ""}.`, d > 0 ? "positif" : "vigilance");
    }
    if (m.climb && m.climb.gain >= 80) {
      const vMed = median(H.map((h) => h.climb && h.climb.gain >= 80 ? h.climb.vam : null));
      add(55, `VAM en montée ${m.climb.vam} m/h${vMed ? " (habituellement " + Math.round(vMed) + ")" : ""}, cible ${VAM_TARGET} pour février : ${m.climb.vam >= VAM_TARGET ? "objectif déjà atteint sur cette sortie" : "écart de " + (VAM_TARGET - m.climb.vam) + " m/h"}.`, m.climb.vam >= (vMed || 1e9) ? "positif" : "neutre");
    }
    const dMed = median(H.map((h) => h.descentMin >= 5 ? h.descentKmh : null));
    if (m.descentKmh && m.descentMin >= 5 && dMed) {
      const d = Math.round((m.descentKmh / dMed - 1) * 100);
      if (Math.abs(d) >= 10) add(45, `Descentes raides à ${m.descentKmh} km/h vs ${dMed.toFixed(1)} habituellement (${d > 0 ? "+" : ""}${d} %).`, d > 0 ? "positif" : "neutre");
    }
  } else {
    if (intent === "sfr" && m.target) add(35, `Séance SFR : une cadence basse est ici l'objectif (cible ${m.target[0]}-${m.target[1]} tr/min), pas une faute.`, "neutre");
    if (m.target) {
      if (m.inTarget < 70) add(70, `Seulement ${m.inTarget} % du temps dans ta cible ${m.target[0]}-${m.target[1]} tr/min : la consigne de cadence n'est pas tenue.`, "vigilance");
      else if (m.inTarget >= 85) add(40, `${m.inTarget} % du temps dans ta cible ${m.target[0]}-${m.target[1]} tr/min : consigne tenue.`, "positif");
      else add(45, `${m.inTarget} % du temps dans ta cible ${m.target[0]}-${m.target[1]} tr/min : correct, mais des passages hors cible.`, "neutre");
    }
    if (m.pTarget && m.inPower != null) {
      if (m.inPower < 70) {
        const why = m.pBelow >= 20 && m.pAbove >= 20 ? `puissance irrégulière : ${m.pBelow} % du temps sous la cible et ${m.pAbove} % au-dessus, tu oscilles au lieu de tenir un effort stable`
          : m.pBelow > m.pAbove ? `${m.pBelow} % du temps sous la cible : trop léger, la séance n'a pas produit le travail prévu`
          : `${m.pAbove} % du temps au-dessus de la cible : trop appuyé pour la consigne`;
        add(70, `Seulement ${m.inPower} % du temps dans ta cible de puissance ${m.pTarget[0]}-${m.pTarget[1]} W (moyenne ${m.watts} W) : ${why}.`, "vigilance");
      }
      else add(40, `${m.inPower} % du temps dans ta cible ${m.pTarget[0]}-${m.pTarget[1]} W : consigne de puissance tenue.`, "positif");
    }
    const wpbMed = median(H.map((h) => h.wPerBeat));
    if (m.wPerBeat && wpbMed && H.filter((h) => h.wPerBeat).length >= 3) {
      const d = Math.round((m.wPerBeat / wpbMed - 1) * 100);
      if (Math.abs(d) >= 5) add(50, `${m.wPerBeat} W par battement vs ${wpbMed.toFixed(2)} habituellement (${d > 0 ? "+" : ""}${d} %) : ${d > 0 ? "plus de puissance pour le même cœur, la forme aérobie progresse" : "le cœur travaille plus pour la même puissance (fatigue, chaleur, sommeil ?)"}.`, d > 0 ? "positif" : "vigilance");
    }
    if (m.cadenceSd > 8) add(50, `Cadence très dispersée (±${m.cadenceSd} tr/min) : pédalage irrégulier, travaille la régularité avant l'intensité.`, "vigilance");
    if (z && (easyLike || intent === null) && z3p >= 20) add(65, `${z3p} % du temps au-dessus de 143 bpm sur du vélo : ce n'était plus de la récupération active.`, "vigilance");
    else if (z && z12 >= 90) add(30, `${z12} % du temps en Z1-Z2 : vrai travail facile, sans impact.`, "positif");
    if (m.hrDrift != null && m.cadenceSd <= 6 && m.hrDrift >= 8) add(45, `FC +${m.hrDrift} % en 2e moitié à cadence stable : fatigue ou hydratation (si la résistance n'a pas changé).`, "vigilance");
  }
  return C.sort((a, b) => b.p - a.p);
}

/* ---------- Prompt ---------- */
const SYS = [
  "Tu es le coach trail de Laurent : infirmier libéral, athlète « diesel » d'ultra-endurance, VO2max 56. Objectif : UT4M 180 Challenge (juillet 2027, 4 étapes de ~44 km, 11 700 m D+). Limiteurs : économie de grimpe (VAM) et durabilité en descente. Pubalgie réveillée fin septembre : reprise progressive, le pubis passe avant la performance.",
  "",
  "TON TRAVAIL : transformer un diagnostic chiffré en décisions. Un bon compte-rendu fait gagner quelque chose à Laurent : comprendre une erreur, confirmer un bon choix, savoir exactement quoi faire demain. Il n'a jamais eu de coach : explique le « pourquoi » (physiologie, risque de blessure, performance) en une phrase simple.",
  "",
  "LIRE LES DONNÉES :",
  "- DIAGNOSTIC : constats calculés et fiables, classés par priorité. C'est ta matière première ; le constat n°1 ouvre ton analyse. Un constat [alerte] se dit sans détour.",
  "- INTENTION de la séance = l'étalon. Juge l'écart entre l'intention et le réalisé, jamais les chiffres dans l'absolu.",
  "- 3 DERNIERS JOURS : l'intensité indiquée est celle mesurée. N'en déduis aucune fatigue ni charge qui n'y figure pas.",
  "- Échelles de Laurent : ZP = douleur pubienne /10 (0 = rien). « Jambe x/10 » = sa sensation des jambes, échelle personnelle : cite-la telle quelle, sans dire si c'est bon ou mauvais. RPE = effort perçu /10.",
  "- Une donnée marquée « non interprétable », « suspecte » ou « faussée » : tu n'en tires rien.",
  "",
  "CE QUI REND L'ANALYSE UTILE :",
  "- Chaque phrase de « sens » s'appuie sur un constat ou un chiffre précis des données ET dit pourquoi ça compte.",
  "- Une erreur se nomme clairement avec sa conséquence. Une réussite se dit en une phrase, sans en rajouter.",
  "- L'UT4M seulement si le lien est concret et propre à ce constat (ex. cadence en montée → 11 700 m D+ ; descente → durabilité sur 4 jours). Sinon n'en parle pas.",
  "- Journée calme sans constat marquant : dis-le en une phrase. Ne remplis jamais.",
  "- « demain » = UNE consigne exécutable : quoi faire, à quelle intensité (zones, FC, cadence fournies), et la règle d'arrêt si le pubis est concerné.",
  "  · VEILLE DE COURSE : brief de course — départ retenu, plafond de FC ou de zone pour la 1re montée, gestion des descentes vu le pubis, règle d'arrêt (ex. ZP qui monte), et ce qu'il devra noter après la course.",
  "  · LENDEMAIN DE COURSE : récupération et ce qu'il doit surveiller (ZP au réveil, jambes).",
  "  · Plan de demain = repos : la consigne porte sur la récupération ou sur ce qu'il doit noter.",
  "",
  "INTERDITS :",
  "- Tout chiffre, fait, séance, douleur ou sensation absent des données. Toute déduction présentée comme un fait.",
  "- Formules creuses : « ton organisme encaisse bien », « tu as posé les bases », « c'est bon signe », « continue comme ça », « bravo », « belle séance », « à l'écoute de ton corps », « bonne gestion » sans dire laquelle.",
  "- Réciter les chiffres affichés sans les interpréter.",
  "- Toute phrase qui pourrait s'appliquer à n'importe quel athlète n'importe quel jour.",
  "Style : tutoiement, français, phrases courtes, ton direct de coach, pas d'emoji.",
  "",
  "Réponds UNIQUEMENT en JSON valide, sans markdown :",
  "{\"titre\": \"verdict précis en 8 mots max, propre à cette journée\", \"passe\": \"1 à 2 phrases : ce qui s'est passé, jugé par rapport à l'intention\", \"sens\": \"1 à 4 phrases selon ce qu'il y a vraiment à dire\", \"demain\": \"1 à 2 phrases : la consigne exécutable\"}",
].join("\n");

function userPrompt(ctx) {
  const L = [];
  L.push(`Date : ${ctx.dateLbl}`);
  L.push(ctx.plan ? `PLAN DU JOUR : ${strip(ctx.plan.label)}${ctx.plan.sub ? " — " + strip(ctx.plan.sub) : ""}${ctx.plan.block ? " (bloc : " + ctx.plan.block + ")" : ""}.` : "PLAN DU JOUR : indisponible.");
  L.push(ctx.tomorrow ? `PLAN DE DEMAIN : ${strip(ctx.tomorrow.label)}${ctx.tomorrow.sub ? " — " + strip(ctx.tomorrow.sub) : ""}.` + (ctx.tomorrow.detail && ctx.tomorrow.detail.length ? " Détail : " + ctx.tomorrow.detail.slice(0, 4).map(strip).join(" | ") : "") : "PLAN DE DEMAIN : indisponible.");
  if (ctx.special && ctx.special.length) L.push("CONTEXTE SPÉCIAL : " + ctx.special.join(" "));
  L.push("3 DERNIERS JOURS (intensité mesurée par la FC moyenne) :" + (ctx.last3.length ? "\n- " + ctx.last3.join("\n- ") : " aucune activité enregistrée."));
  L.push(`SEMAINE EN COURS : ${ctx.week.km} km course/trail, ${ctx.week.dp} m D+, ${ctx.week.ride} min de vélo` + (ctx.week.tg && ctx.week.tg.km ? ` (cible plan ${ctx.week.tg.km} km / ${ctx.week.tg.dp} m D+).` : "."));
  ctx.items.forEach((x) => {
    L.push("");
    L.push(`=== SÉANCE : « ${x.a.name} » (${x.typeLbl}) ===`);
    L.push(`Intention retenue : ${x.intent ? INTENT_LBL[x.intent] : "inconnue"} (source : ${x.intentSrc}).`);
    L.push(x.note && x.note.raw ? `Note de Laurent : "${x.note.raw}"` + (x.note.rpe != null ? ` → RPE ${x.note.rpe}/10.` : " → pas de RPE.") + (x.note.legs != null ? ` Sensation jambes ${x.note.legs}/10 (son échelle personnelle : ne l'interprète pas comme un RPE).` : "") + (x.note.pubis && x.note.pubis.level != null ? ` Pubis (ZP) : ${x.note.pubis.txt}.` : "") : "Note de Laurent : aucune.");
    L.push("DIAGNOSTIC (priorité décroissante) :");
    (x.diag.length ? x.diag.slice(0, 5) : [{ tone: "neutre", t: "Aucun constat marquant." }]).forEach((c, i) => L.push(`${i + 1}. [${c.tone}] ${c.t}`));
    L.push("Faits complémentaires :");
    L.push(x.facts);
  });
  L.push("\nRédige le compte-rendu.");
  return L.join("\n");
}

/* ---------- Repli 100 % calculé (si l'IA ne répond pas) ---------- */
function fallbackReport(ctx, why) {
  const main = ctx.items.filter((x) => x.m);
  const d = [].concat(...main.map((x) => x.diag)).sort((a, b) => b.p - a.p);
  const passe = main.map((x) => `${x.a.name} : ${x.m.kind === "run" ? x.m.km + " km, " + x.m.dPlus + " m D+, FC moyenne " + (x.m.hr || "—") : x.m.movingMin + " min de vélo, cadence " + x.m.cadence + ", FC moyenne " + (x.m.hr || "—")}${x.intent ? " (" + INTENT_LBL[x.intent] + ")" : ""}.`).join(" ");
  const sens = d.slice(0, 3).map((c) => c.t).join(" ") || "Pas de constat marquant aujourd'hui.";
  let demain = ctx.tomorrow && ctx.tomorrow.label ? `${strip(ctx.tomorrow.label)}${ctx.tomorrow.sub ? " — " + strip(ctx.tomorrow.sub) : ""}.` : "Pas de séance lue dans le plan.";
  if (d.some((c) => /^Pubis à ([4-9]|10)/.test(c.t))) demain = "Pubis en alerte : ni course ni côtes demain. " + demain + " Seulement si le pubis est ≤ 2/10 au réveil.";
  else if (d.some((c) => /trop intense|zone « grise »/.test(c.t))) demain += " Garde la FC sous 143 bpm sur tout ce qui est facile.";
  return { titre: d[0] && d[0].tone === "alerte" ? "Point de vigilance du jour" : "Les constats du jour", passe, sens, demain, src: "calc", note: why };
}

/* ---------- Contrôle de la réponse IA ----------
   Erreurs anticipées : chiffre inventé, formule creuse, champ vide, JSON tronqué.
   Retourne null si OK, sinon la raison (servira de consigne de correction). */
const CREUX = [/organisme encaisse/i, /pos[ée] les bases/i, /c'est (un )?bon signe/i, /continue comme [çc]a/i, /\bbravo\b/i, /belle s[ée]ance/i, /[àa] l'[ée]coute de ton corps/i, /ton corps te remerciera/i];
function numbersIn(t) { return (String(t).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => String(parseFloat(x.replace(",", ".")))); }
function checkReply(j, sourceText) {
  if (!j || typeof j !== "object") return "réponse non JSON";
  for (const k of ["titre", "passe", "sens", "demain"]) if (!j[k] || String(j[k]).trim().length < 8) return `champ « ${k} » vide`;
  const all = [j.titre, j.passe, j.sens, j.demain].join(" ");
  const allowed = new Set(numbersIn(sourceText));
  const bad = numbersIn(all).filter((n) => !allowed.has(n) && !(Number.isInteger(+n) && +n <= 5));
  if (bad.length) return `chiffres absents des données : ${[...new Set(bad)].slice(0, 5).join(", ")}`;
  const cr = CREUX.find((re) => re.test(all));
  if (cr) return `formule creuse interdite : « ${(all.match(cr) || [""])[0]} »`;
  return null;
}

module.exports = { parseNote, intentOf, diagnose, SYS, userPrompt, fallbackReport, checkReply, INTENT_LBL, VAM_TARGET };
