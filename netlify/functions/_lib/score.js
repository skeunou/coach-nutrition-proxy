/* ============================================================
   CODE COULEUR « FEU TRICOLORE » — score 0 (loin de la consigne)
   → 1 (consigne tenue). Rouge → orange → jaune → vert.
   La cible dépend de l'INTENTION de la séance (ex. 55 tr/min est
   vert en SFR, rouge en endurance).
   ============================================================ */
const clamp = (x) => Math.max(0, Math.min(1, x));
const lin = (v, bad, good) => clamp((v - bad) / (good - bad)); // marche dans les deux sens

// Rampe sur fond sombre (graphiques) et sur fond blanc (chiffres du mail)
const DARK = [[0, "#f05252"], [0.4, "#ff8a3d"], [0.7, "#f5d547"], [1, "#4ade80"]];
const LIGHT = [[0, "#d92d35"], [0.4, "#d8590e"], [0.7, "#a87d00"], [1, "#16884a"]];
function ramp(s, light) {
  if (s == null || !isFinite(s)) return null;
  const R = light ? LIGHT : DARK;
  for (let i = 1; i < R.length; i++) if (s <= R[i][0]) return s - R[i - 1][0] < R[i][0] - s ? R[i - 1][1] : R[i][1];
  return R[R.length - 1][1];
}

/* Scores par indicateur (null = pas de jugement possible → neutre) */
const S = {
  runCadence: (v) => v == null ? null : lin(v, 155, 170),               // < 155 rouge, ≥ 170 vert
  climbCadence: (v) => v == null ? null : lin(v, 150, 165),
  decoupling: (v) => v == null ? null : lin(v, 10, 3),                  // ≤ 3 % vert, ≥ 10 % rouge
  vam: (v, target) => v == null ? null : lin(v, target * 0.72, target),  // cible 1250
  drift: (v) => v == null ? null : lin(v, 10, 3),
  ef: (v, ref) => v == null || !ref ? null : lin(v / ref - 1, -0.06, 0.03), // vs médiane
  inTarget: (pct) => pct == null ? null : lin(pct, 50, 85),              // % du temps dans la cible
  // Cadence vélo vs cible [lo, hi] : dedans = vert, 10 tr/min d'écart = rouge
  rideCadence: (v, t) => v == null || !t ? null : (v >= t[0] && v <= t[1] ? 1 : clamp(1 - Math.min(Math.abs(v - t[0]), Math.abs(v - t[1])) / 10)),
  // Part du temps facile (Z1-Z2) sur une séance voulue facile
  easyShare: (z12) => z12 == null ? null : lin(z12, 60, 90),
};

module.exports = { ramp, S, clamp };
