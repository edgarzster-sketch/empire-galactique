// ============================================================
//  SERVEUR DU JEU — VERSION 0.4
//  Nouveautes :
//   - Systeme d'adressage des planetes (via galaxy.js partage)
//   - Table "possessions" : qui possede quelle planete
//   - Chaque joueur recoit une planete d'origine a l'inscription
//   - Routes : connexion (avec home), possessions, coloniser
// ============================================================

const express = require("express");
const path = require("path");
const { Pool } = require("pg");
const galaxy = require("./galaxy");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function preparerBase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS joueurs (
      id SERIAL PRIMARY KEY,
      nom TEXT UNIQUE NOT NULL,
      cree_le TIMESTAMP DEFAULT NOW(),
      vu_le TIMESTAMP DEFAULT NOW()
    )
  `);
  // --- AUTHENTIFICATION & PROFIL : colonnes ajoutees en douceur ---
  await pool.query(`ALTER TABLE joueurs ADD COLUMN IF NOT EXISTS mdp_hash TEXT`);
  await pool.query(`ALTER TABLE joueurs ADD COLUMN IF NOT EXISTS nom_empire TEXT`);
  await pool.query(`ALTER TABLE joueurs ADD COLUMN IF NOT EXISTS couleur TEXT`);
  await pool.query(`ALTER TABLE joueurs ADD COLUMN IF NOT EXISTS bio TEXT`);
  await pool.query(`ALTER TABLE joueurs ADD COLUMN IF NOT EXISTS embleme TEXT`); // JSON : {forme,symbole,c1,c2}
  // sessions : jeton -> joueur
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      jeton TEXT PRIMARY KEY,
      joueur TEXT NOT NULL,
      cree_le TIMESTAMP DEFAULT NOW()
    )
  `);
  // titres debloques : joueur + code du titre
  await pool.query(`
    CREATE TABLE IF NOT EXISTS titres (
      joueur TEXT NOT NULL,
      code TEXT NOT NULL,
      obtenu_le TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY (joueur, code)
    )
  `);
  // table de possession : une planete (adresse) appartient a un joueur
  await pool.query(`
    CREATE TABLE IF NOT EXISTS possessions (
      addr TEXT PRIMARY KEY,
      joueur TEXT NOT NULL,
      origine BOOLEAN DEFAULT FALSE,
      nom_perso TEXT,
      acquis_le TIMESTAMP DEFAULT NOW()
    )
  `);
  // migration douce : ajoute la colonne si la table existait deja sans elle
  await pool.query(`ALTER TABLE possessions ADD COLUMN IF NOT EXISTS nom_perso TEXT`);
  // recolte_le : derniere fois que la production de cette planete a ete encaissee
  await pool.query(`ALTER TABLE possessions ADD COLUMN IF NOT EXISTS recolte_le TIMESTAMP DEFAULT NOW()`);
  // stocks : ressources accumulees par joueur (une ligne par joueur+ressource)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stocks (
      joueur TEXT NOT NULL,
      ressource TEXT NOT NULL,
      quantite DOUBLE PRECISION DEFAULT 0,
      PRIMARY KEY (joueur, ressource)
    )
  `);
  console.log("Base prete : joueurs, sessions, titres, possessions, stocks OK");
}

// helper : une adresse est-elle deja occupee ?
async function estOccupee(addr){
  const r = await pool.query("SELECT 1 FROM possessions WHERE addr=$1", [addr]);
  return r.rows.length > 0;
}

// ============================================================
//  AUTHENTIFICATION
// ============================================================
const auth = require("./auth");

// attribue une planete d'origine si le joueur n'en a pas
async function assurerHome(pseudo) {
  let home = await pool.query(
    "SELECT addr FROM possessions WHERE joueur=$1 AND origine=TRUE LIMIT 1", [pseudo]
  );
  if (home.rows.length > 0) return home.rows[0].addr;
  const prises = new Set((await pool.query("SELECT addr FROM possessions")).rows.map(r => r.addr));
  const homeAddr = galaxy.homeworldFor(pseudo, (a) => prises.has(a));
  if (homeAddr) {
    await pool.query(
      "INSERT INTO possessions (addr, joueur, origine) VALUES ($1,$2,TRUE) ON CONFLICT (addr) DO NOTHING",
      [homeAddr, pseudo]
    );
  }
  return homeAddr;
}

// debloque un titre (silencieux si deja obtenu)
async function debloquerTitre(pseudo, code) {
  await pool.query(
    "INSERT INTO titres (joueur, code) VALUES ($1,$2) ON CONFLICT DO NOTHING", [pseudo, code]
  );
}

// cree une session et renvoie le jeton
async function creerSession(pseudo) {
  const jeton = auth.genererJeton();
  await pool.query("INSERT INTO sessions (jeton, joueur) VALUES ($1,$2)", [jeton, pseudo]);
  return jeton;
}

// resout un jeton -> pseudo (ou null)
async function joueurDeSession(jeton) {
  if (!jeton) return null;
  const r = await pool.query("SELECT joueur FROM sessions WHERE jeton=$1", [jeton]);
  return r.rows.length ? r.rows[0].joueur : null;
}

// INSCRIPTION : cree un compte avec mot de passe
app.post("/api/inscription", async (req, res) => {
  const pseudo = (req.body.pseudo || "").trim().slice(0, 20);
  const mdp = (req.body.motdepasse || "");
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Pseudo trop court (2 caractères min)" });
  if (!/^[a-zA-Z0-9_\- ]+$/.test(pseudo)) return res.status(400).json({ erreur: "Pseudo : lettres, chiffres, - et _ seulement" });
  if (mdp.length < 4) return res.status(400).json({ erreur: "Mot de passe trop court (4 caractères min)" });
  try {
    const existe = await pool.query("SELECT nom, mdp_hash FROM joueurs WHERE LOWER(nom)=LOWER($1)", [pseudo]);
    if (existe.rows.length > 0 && existe.rows[0].mdp_hash) {
      return res.json({ succes: false, message: "Ce pseudo est déjà pris." });
    }
    const hash = auth.hacherMotDePasse(mdp);
    if (existe.rows.length > 0) {
      await pool.query("UPDATE joueurs SET mdp_hash=$1, vu_le=NOW() WHERE LOWER(nom)=LOWER($2)", [hash, pseudo]);
    } else {
      await pool.query("INSERT INTO joueurs (nom, mdp_hash) VALUES ($1,$2)", [pseudo, hash]);
    }
    const homeAddr = await assurerHome(pseudo);
    await debloquerTitre(pseudo, "fondateur");
    const jeton = await creerSession(pseudo);
    res.json({ succes: true, pseudo, jeton, graine: galaxy.GRAINE_UNIVERS, home: homeAddr });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// CONNEXION : verifie pseudo + mot de passe
app.post("/api/connexion", async (req, res) => {
  const pseudo = (req.body.pseudo || "").trim().slice(0, 20);
  const mdp = (req.body.motdepasse || "");
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Pseudo invalide" });
  try {
    const r = await pool.query("SELECT nom, mdp_hash FROM joueurs WHERE LOWER(nom)=LOWER($1)", [pseudo]);
    if (r.rows.length === 0) return res.json({ succes: false, message: "Compte introuvable.", inconnu: true });
    const j = r.rows[0];
    if (!j.mdp_hash) return res.json({ succes: false, message: "Ce compte n'a pas de mot de passe. Définis-en un.", besoinMdp: true });
    if (!auth.verifierMotDePasse(mdp, j.mdp_hash)) {
      return res.json({ succes: false, message: "Mot de passe incorrect." });
    }
    await pool.query("UPDATE joueurs SET vu_le=NOW() WHERE nom=$1", [j.nom]);
    const homeAddr = await assurerHome(j.nom);
    const jeton = await creerSession(j.nom);
    res.json({ succes: true, pseudo: j.nom, jeton, graine: galaxy.GRAINE_UNIVERS, home: homeAddr });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// SESSION : reconnexion automatique via jeton
app.post("/api/session", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.json({ succes: false });
    await pool.query("UPDATE joueurs SET vu_le=NOW() WHERE nom=$1", [pseudo]);
    const homeAddr = await assurerHome(pseudo);
    res.json({ succes: true, pseudo, jeton, graine: galaxy.GRAINE_UNIVERS, home: homeAddr });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// DECONNEXION : supprime la session
app.post("/api/deconnexion", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  try { await pool.query("DELETE FROM sessions WHERE jeton=$1", [jeton]); res.json({ succes: true }); }
  catch (e) { res.status(500).json({ erreur: e.message }); }
});

// liste de tous les joueurs (recemment vus)
app.get("/api/joueurs", async (req, res) => {
  try {
    const r = await pool.query("SELECT nom, vu_le FROM joueurs ORDER BY vu_le DESC LIMIT 50");
    res.json({ nombre: r.rows.length, joueurs: r.rows });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ============================================================
//  POSSESSIONS : la galaxie demande "qui possede quoi"
//  Le client colorera les planetes selon ca.
// ============================================================
app.get("/api/possessions", async (req, res) => {
  try {
    const r = await pool.query("SELECT addr, joueur, origine, nom_perso FROM possessions");
    res.json({ nombre: r.rows.length, possessions: r.rows });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ============================================================
//  RENOMMER : un joueur donne un nom personnalise a SA planete
// ============================================================
app.post("/api/renommer", async (req, res) => {
  const pseudo = (req.body.pseudo || "").trim().slice(0,20);
  const addr = (req.body.addr || "").trim();
  let nom = (req.body.nom || "").trim().slice(0, 40);
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Joueur invalide" });
  if (!galaxy.parseAddr(addr)) return res.status(400).json({ erreur: "Adresse invalide" });
  try {
    // on ne renomme QUE si la planete appartient bien au joueur
    const r = await pool.query(
      "UPDATE possessions SET nom_perso=$1 WHERE addr=$2 AND joueur=$3 RETURNING addr",
      [nom || null, addr, pseudo]
    );
    if (r.rows.length === 0) {
      return res.json({ succes:false, message:"Cette planète ne vous appartient pas." });
    }
    res.json({ succes:true, addr, nom });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ============================================================
//  COLONISER : un joueur reclame une planete par son adresse.
//  Le serveur VERIFIE que l'adresse existe (via galaxy.js) et
//  qu'elle est libre, avant d'accorder.
// ============================================================
app.post("/api/coloniser", async (req, res) => {
  const pseudo = (req.body.pseudo || "").trim().slice(0,20);
  const addr = (req.body.addr || "").trim();
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Joueur invalide" });

  // 1) l'adresse correspond-elle a une vraie planete ?
  const info = galaxy.parseAddr(addr);
  if (!info) return res.status(400).json({ erreur: "Adresse de planète invalide" });

  const client = await pool.connect();
  try {
    // 2) verification + insertion dans une TRANSACTION pour eviter
    //    qu'un autre joueur s'intercale entre le test et l'ecriture.
    await client.query("BEGIN");
    const dejaPrise = await client.query(
      "SELECT joueur FROM possessions WHERE addr=$1 FOR UPDATE", [addr]
    );
    if (dejaPrise.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.json({ succes:false, message:"Cette planète est déjà colonisée." });
    }
    await client.query(
      "INSERT INTO possessions (addr, joueur) VALUES ($1,$2)", [addr, pseudo]
    );
    await client.query("COMMIT");
    res.json({ succes:true, addr, type: info.planet.type });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    res.status(500).json({ erreur: e.message });
  } finally {
    client.release();
  }
});

// ============================================================
//  ECONOMIE : encaisse la production de toutes les planetes d'un
//  joueur depuis leur derniere recolte, puis renvoie son stock.
//  Calcul "a la demande" : aucune boucle permanente cote serveur.
// ============================================================
async function encaisserEtLireStock(pseudo) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 1) recupere les planetes du joueur avec leur derniere recolte
    const planetes = await client.query(
      "SELECT addr, recolte_le FROM possessions WHERE joueur=$1 FOR UPDATE",
      [pseudo]
    );
    const now = Date.now();
    const gains = {};   // ressource -> quantite gagnee
    for (const row of planetes.rows) {
      const prod = galaxy.productionHoraire(row.addr);   // {res: qte/heure}
      const dernier = new Date(row.recolte_le).getTime();
      const heures = Math.max(0, (now - dernier) / 3600000);
      if (heures <= 0) continue;
      for (const res in prod) {
        gains[res] = (gains[res] || 0) + prod[res] * heures;
      }
    }
    // 2) met a jour la date de recolte de toutes les planetes
    if (planetes.rows.length > 0) {
      await client.query(
        "UPDATE possessions SET recolte_le=NOW() WHERE joueur=$1", [pseudo]
      );
    }
    // 3) credite le stock
    for (const res in gains) {
      if (gains[res] <= 0) continue;
      await client.query(
        `INSERT INTO stocks (joueur, ressource, quantite) VALUES ($1,$2,$3)
         ON CONFLICT (joueur, ressource) DO UPDATE SET quantite = stocks.quantite + $3`,
        [pseudo, res, gains[res]]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    throw e;
  } finally {
    client.release();
  }
  // 4) relit le stock complet + production horaire totale
  const stock = await pool.query(
    "SELECT ressource, quantite FROM stocks WHERE joueur=$1", [pseudo]
  );
  const planetes = await pool.query(
    "SELECT addr FROM possessions WHERE joueur=$1", [pseudo]
  );
  const prodTotale = {};
  for (const row of planetes.rows) {
    const prod = galaxy.productionHoraire(row.addr);
    for (const res in prod) prodTotale[res] = (prodTotale[res]||0) + prod[res];
  }
  const stockObj = {};
  for (const row of stock.rows) stockObj[row.ressource] = row.quantite;
  return { stock: stockObj, productionHoraire: prodTotale };
}

app.get("/api/stock", async (req, res) => {
  const pseudo = (req.query.pseudo || "").trim().slice(0,20);
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Joueur invalide" });
  try {
    const data = await encaisserEtLireStock(pseudo);
    res.json(data);
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ============================================================
//  PROFIL & STATISTIQUES & TITRES
// ============================================================
// catalogue des titres et leurs conditions
const TITRES_DEF = {
  fondateur:   { nom: "Fondateur", desc: "A fondé son empire", icone: "flag" },
  explorateur: { nom: "Explorateur", desc: "Possède 3 planètes ou plus", icone: "compass" },
  batisseur:   { nom: "Bâtisseur", desc: "Possède 5 planètes ou plus", icone: "building" },
  magnat:      { nom: "Magnat", desc: "Possède 10 planètes ou plus", icone: "crown" },
  prospecteur: { nom: "Prospecteur", desc: "Détient une ressource exotique", icone: "diamond" },
  veteran:     { nom: "Vétéran", desc: "Empire fondé il y a plus de 7 jours", icone: "clock" }
};

// recalcule les titres automatiques d'un joueur
async function recalcTitres(pseudo) {
  const poss = await pool.query("SELECT addr FROM possessions WHERE joueur=$1", [pseudo]);
  const nb = poss.rows.length;
  if (nb >= 3) await debloquerTitre(pseudo, "explorateur");
  if (nb >= 5) await debloquerTitre(pseudo, "batisseur");
  if (nb >= 10) await debloquerTitre(pseudo, "magnat");
  // ressource exotique ?
  for (const row of poss.rows) {
    const prod = galaxy.productionHoraire(row.addr);
    if (prod.antimatiere || prod.metamateriaux) { await debloquerTitre(pseudo, "prospecteur"); break; }
  }
  // anciennete
  const j = await pool.query("SELECT cree_le FROM joueurs WHERE nom=$1", [pseudo]);
  if (j.rows.length && (Date.now() - new Date(j.rows[0].cree_le).getTime()) > 7*86400000) {
    await debloquerTitre(pseudo, "veteran");
  }
}

// GET profil d'un joueur (le sien ou un autre)
app.get("/api/profil", async (req, res) => {
  const pseudo = (req.query.pseudo || "").trim().slice(0,20);
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Pseudo invalide" });
  try {
    const r = await pool.query(
      "SELECT nom, nom_empire, couleur, bio, embleme, cree_le FROM joueurs WHERE LOWER(nom)=LOWER($1)", [pseudo]
    );
    if (r.rows.length === 0) return res.status(404).json({ erreur: "Joueur introuvable" });
    const j = r.rows[0];
    await recalcTitres(j.nom);
    const titres = await pool.query("SELECT code, obtenu_le FROM titres WHERE joueur=$1", [j.nom]);
    const poss = await pool.query("SELECT addr, acquis_le FROM possessions WHERE joueur=$1", [j.nom]);
    // production totale
    let prodTotale = 0;
    for (const row of poss.rows) { const p = galaxy.productionHoraire(row.addr); for (const k in p) prodTotale += p[k]; }
    res.json({
      pseudo: j.nom,
      nom_empire: j.nom_empire || null,
      couleur: j.couleur || null,
      bio: j.bio || null,
      embleme: j.embleme ? JSON.parse(j.embleme) : null,
      cree_le: j.cree_le,
      stats: { planetes: poss.rows.length, productionTotale: Math.round(prodTotale) },
      titres: titres.rows.map(t => ({ code: t.code, ...TITRES_DEF[t.code], obtenu_le: t.obtenu_le })).filter(t => t.nom)
    });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// POST mise a jour du profil (authentifie par jeton)
app.post("/api/profil", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.status(401).json({ erreur: "Non authentifié" });
    const nomEmpire = (req.body.nom_empire || "").trim().slice(0, 30) || null;
    const couleur = (req.body.couleur || "").trim().slice(0, 7) || null;
    const bio = (req.body.bio || "").trim().slice(0, 200) || null;
    let embleme = null;
    if (req.body.embleme) {
      const e = req.body.embleme;
      embleme = JSON.stringify({
        forme: String(e.forme || "ecu").slice(0,20),
        symbole: String(e.symbole || "etoile").slice(0,20),
        c1: String(e.c1 || "#5b9bd5").slice(0,7),
        c2: String(e.c2 || "#1c3a5a").slice(0,7)
      });
    }
    // validation couleur hex
    const couleurOk = couleur && /^#[0-9a-fA-F]{6}$/.test(couleur) ? couleur : null;
    await pool.query(
      "UPDATE joueurs SET nom_empire=$1, couleur=$2, bio=$3, embleme=COALESCE($4, embleme) WHERE nom=$5",
      [nomEmpire, couleurOk, bio, embleme, pseudo]
    );
    res.json({ succes: true });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

app.get("/sante", (req, res) => res.json({ statut: "ok", version: "0.7" }));

preparerBase()
  .then(() => app.listen(PORT, () => console.log(`Serveur demarre sur ${PORT}`)))
  .catch((e) => {
    console.error("Erreur base :", e.message);
    app.listen(PORT, () => console.log(`Serveur demarre (base en erreur) sur ${PORT}`));
  });
