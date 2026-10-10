/* Moteur de plan extrait de trail-v2.html (source de vérité unique).
   Auto-résolution des dépendances : si gen() appelle une fonction non
   extraite (ex. raceWin — cause de la panne du mail 4h), on l'ajoute et
   on réessaie. Aucune duplication du plan ici. */
function extractDecl(src, name) {
  let i = src.indexOf("function " + name + "(");
  if (i >= 0) {
    let d = 0;
    for (let j = src.indexOf("{", i); j < src.length; j++) {
      if (src[j] === "{") d++;
      else if (src[j] === "}") { d--; if (d === 0) return src.slice(i, j + 1); }
    }
    return null;
  }
  const re = new RegExp("(^|[;\\n\\s])(var|let|const)\\s+" + name + "\\s*=");
  const m = re.exec(src);
  if (!m) return null;
  i = m.index + m[1].length;
  let d = 0, q = null;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (q) { if (c === "\\") { j++; continue; } if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "[" || c === "{" || c === "(") d++;
    else if (c === "]" || c === "}" || c === ")") d--;
    else if ((c === ";" || c === "\n") && d === 0) return src.slice(i, j + 1).replace(/^(let|const)/, "var");
  }
  return null;
}

const SEED = ["gen", "blockFor", "weekTarget", "weekInfo", "nextRace"];
const PRELUDE = `
  var today = new Date();
  var localStorage = { getItem: function(){ return null; }, setItem: function(){}, removeItem: function(){} };
  var document = { getElementById: function(){ return null; }, querySelector: function(){ return null; }, querySelectorAll: function(){ return []; } };
  var window = {};
  function refGet(){ return {}; }
  function cloudSave(){}
`;

function buildEngine(html) {
  const scripts = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const src = scripts.sort((a, b) => b.length - a.length)[0] || "";
  const have = new Map();
  SEED.forEach((n) => { const t = extractDecl(src, n); if (t) have.set(n, t); });
  let eng = null;
  function compile() {
    const code = PRELUDE + [...have.values()].join("\n") +
      `;(function(){return{setDay:function(d){today=d;},gen:gen,blockFor:blockFor,` +
      `weekTarget:(typeof weekTarget==="function"?weekTarget:null)};})()`;
    eng = (0, eval)(code);
  }
  // Exécute fn(eng) ; sur « X is not defined », extrait X du HTML et recommence.
  function call(fn) {
    for (let k = 0; k < 80; k++) {
      try { if (!eng) compile(); return fn(eng); }
      catch (e) {
        const m = /([A-Za-z_$][\w$]*) is not defined/.exec(e.message || "");
        if (!m || have.has(m[1])) throw e;
        const t = extractDecl(src, m[1]);
        if (!t) throw new Error("déclaration introuvable : " + m[1]);
        have.set(m[1], t); eng = null;
      }
    }
    throw new Error("moteur : trop de dépendances");
  }
  return { call };
}

/* Séance prévue pour un jour (texte court, pour le coach). */
function plannedFor(engine, ymd) {
  const [Y, M, D] = ymd.split("-").map(Number);
  const day = new Date(Y, M - 1, D);
  return engine.call((eng) => {
    eng.setDay(day);
    const s = eng.gen(day) || {};
    const b = eng.blockFor(day) || {};
    let tg = null; try { tg = eng.weekTarget ? eng.weekTarget(day) : null; } catch (e) { if (/is not defined/.test(e.message)) throw e; }
    return {
      label: s.displayTitle || s.label || "",
      sub: s.sub || "",
      detail: (s.detail || []).slice(0, 6).map(String),
      block: b.name || "",
      week: tg ? { km: tg.km, dp: tg.dp, wb: tg.wb, tot: tg.tot } : null,
    };
  });
}

module.exports = { buildEngine, plannedFor };
