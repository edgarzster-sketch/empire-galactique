// ============================================================
//  AUTHENTIFICATION — v1.0
//  Hachage securise des mots de passe avec scrypt (module natif Node).
//  Le mot de passe n'est JAMAIS stocke en clair.
//  Format stocke : "scrypt$<sel_hex>$<hash_hex>"
// ============================================================
const crypto = require("crypto");

// cree un hash securise a partir d'un mot de passe en clair
function hacherMotDePasse(motDePasse) {
  const sel = crypto.randomBytes(16);
  const hash = crypto.scryptSync(motDePasse, sel, 64);
  return "scrypt$" + sel.toString("hex") + "$" + hash.toString("hex");
}

// verifie un mot de passe contre un hash stocke
function verifierMotDePasse(motDePasse, stocke) {
  try {
    const [algo, selHex, hashHex] = stocke.split("$");
    if (algo !== "scrypt") return false;
    const sel = Buffer.from(selHex, "hex");
    const hashAttendu = Buffer.from(hashHex, "hex");
    const hashCalcule = crypto.scryptSync(motDePasse, sel, 64);
    // comparaison a temps constant (anti timing-attack)
    return hashAttendu.length === hashCalcule.length &&
           crypto.timingSafeEqual(hashAttendu, hashCalcule);
  } catch (e) {
    return false;
  }
}

// genere un jeton de session aleatoire
function genererJeton() {
  return crypto.randomBytes(32).toString("hex");
}

module.exports = { hacherMotDePasse, verifierMotDePasse, genererJeton };
