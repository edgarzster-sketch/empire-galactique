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
  await pool.query(`ALTER TABLE joueurs ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE joueurs ADD COLUMN IF NOT EXISTS banni BOOLEAN DEFAULT FALSE`);
  // jetons de reinitialisation de mot de passe (expirent apres 1h)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS resets (
      jeton TEXT PRIMARY KEY,
      joueur TEXT NOT NULL,
      expire TIMESTAMPTZ NOT NULL,
      utilise BOOLEAN DEFAULT FALSE
    )
  `);
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
  // batiments : niveau de chaque batiment sur chaque planete
  await pool.query(`
    CREATE TABLE IF NOT EXISTS batiments (
      addr TEXT NOT NULL,
      code TEXT NOT NULL,
      niveau INTEGER DEFAULT 0,
      PRIMARY KEY (addr, code)
    )
  `);
  // construction : une seule construction en cours par planete (la file)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS constructions (
      addr TEXT PRIMARY KEY,
      joueur TEXT NOT NULL,
      code TEXT NOT NULL,
      niveau_vise INTEGER NOT NULL,
      debut TIMESTAMPTZ DEFAULT NOW(),
      fin TIMESTAMPTZ NOT NULL
    )
  `);
  // vaisseaux stationnes sur une planete : une ligne par planete+type
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vaisseaux (
      addr TEXT NOT NULL,
      type TEXT NOT NULL,
      nombre INTEGER DEFAULT 0,
      PRIMARY KEY (addr, type)
    )
  `);
  // file de construction de vaisseaux au chantier (une par planete)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chantiers (
      addr TEXT PRIMARY KEY,
      joueur TEXT NOT NULL,
      type TEXT NOT NULL,
      nombre INTEGER NOT NULL,
      debut TIMESTAMPTZ DEFAULT NOW(),
      fin TIMESTAMPTZ NOT NULL
    )
  `);
  // flottes en mouvement entre deux systemes
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flottes (
      id SERIAL PRIMARY KEY,
      joueur TEXT NOT NULL,
      origine TEXT NOT NULL,
      destination TEXT NOT NULL,
      composition TEXT NOT NULL,
      mission TEXT DEFAULT 'transit',
      depart TIMESTAMPTZ DEFAULT NOW(),
      arrivee TIMESTAMPTZ NOT NULL,
      traitee BOOLEAN DEFAULT FALSE
    )
  `);
  // rapports de bataille : un par combat, lu puis archive
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rapports (
      id SERIAL PRIMARY KEY,
      joueur TEXT NOT NULL,
      adversaire TEXT,
      lieu TEXT NOT NULL,
      vainqueur TEXT NOT NULL,
      resultat TEXT NOT NULL,
      details TEXT,
      cree_le TIMESTAMPTZ DEFAULT NOW(),
      lu BOOLEAN DEFAULT FALSE
    )
  `);
  console.log("Base prete : joueurs, sessions, titres, possessions, stocks, batiments, constructions, vaisseaux, chantiers, flottes, rapports OK");
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

// ============================================================
//  ADMIN : comptes de test avec super-pouvoirs.
//  - stock geant auto-credite
//  - constructions / productions instantanees
//  Pour ajouter un admin : mettre son pseudo (en minuscules) ici.
// ============================================================
const ADMINS = new Set(["admin"]);
function estAdmin(pseudo) { return pseudo && ADMINS.has(pseudo.toLowerCase()); }
// credite un stock geant a un admin sur toutes les ressources connues
async function crediterStockAdmin(pseudo) {
  const ressources = Object.keys(galaxy.RES_TAUX || {});
  // fallback : liste de base si RES_TAUX absent
  const liste = ressources.length ? ressources : ["fer","silicates","aluminium","carbone","cuivre","titane","cristaux","or","platine","uranium"];
  for (const r of liste) {
    await pool.query(
      `INSERT INTO stocks (joueur, ressource, quantite) VALUES ($1,$2,$3)
       ON CONFLICT (joueur, ressource) DO UPDATE SET quantite = GREATEST(stocks.quantite, $3)`,
      [pseudo, r, 1e9]
    );
  }
}

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
  const email = (req.body.email || "").trim().slice(0, 100).toLowerCase() || null;
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Username too short (min 2 characters)" });
  if (!/^[a-zA-Z0-9_\- ]+$/.test(pseudo)) return res.status(400).json({ erreur: "Username: letters, numbers, - and _ only" });
  if (mdp.length < 4) return res.status(400).json({ erreur: "Password too short (min 4 characters)" });
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erreur: "Invalid email address" });
  try {
    const existe = await pool.query("SELECT nom, mdp_hash FROM joueurs WHERE LOWER(nom)=LOWER($1)", [pseudo]);
    if (existe.rows.length > 0 && existe.rows[0].mdp_hash) {
      return res.json({ succes: false, message: "This username is already taken." });
    }
    const hash = auth.hacherMotDePasse(mdp);
    if (existe.rows.length > 0) {
      await pool.query("UPDATE joueurs SET mdp_hash=$1, email=COALESCE($2,email), vu_le=NOW() WHERE LOWER(nom)=LOWER($3)", [hash, email, pseudo]);
    } else {
      await pool.query("INSERT INTO joueurs (nom, mdp_hash, email) VALUES ($1,$2,$3)", [pseudo, hash, email]);
    }
    const homeAddr = await assurerHome(pseudo);
    await debloquerTitre(pseudo, "fondateur");
    const jeton = await creerSession(pseudo);
    res.json({ succes: true, pseudo, jeton, graine: galaxy.GRAINE_UNIVERS, home: homeAddr, admin: estAdmin(pseudo) });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// CONNEXION : verifie pseudo + mot de passe
app.post("/api/connexion", async (req, res) => {
  const pseudo = (req.body.pseudo || "").trim().slice(0, 20);
  const mdp = (req.body.motdepasse || "");
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Invalid username" });
  try {
    const r = await pool.query("SELECT nom, mdp_hash, banni FROM joueurs WHERE LOWER(nom)=LOWER($1)", [pseudo]);
    if (r.rows.length === 0) return res.json({ succes: false, message: "Account not found.", inconnu: true });
    const j = r.rows[0];
    if (j.banni) return res.json({ succes: false, message: "This account has been banned." });
    if (!j.mdp_hash) return res.json({ succes: false, message: "This account has no password. Please set one.", besoinMdp: true });
    if (!auth.verifierMotDePasse(mdp, j.mdp_hash)) {
      return res.json({ succes: false, message: "Incorrect password." });
    }
    await pool.query("UPDATE joueurs SET vu_le=NOW() WHERE nom=$1", [j.nom]);
    const homeAddr = await assurerHome(j.nom);
    const jeton = await creerSession(j.nom);
    res.json({ succes: true, pseudo: j.nom, jeton, graine: galaxy.GRAINE_UNIVERS, home: homeAddr, admin: estAdmin(j.nom) });
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
    res.json({ succes: true, pseudo, jeton, graine: galaxy.GRAINE_UNIVERS, home: homeAddr, admin: estAdmin(pseudo) });
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
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Invalid player" });
  if (!galaxy.parseAddr(addr)) return res.status(400).json({ erreur: "Invalid address" });
  try {
    // on ne renomme QUE si la planete appartient bien au joueur
    const r = await pool.query(
      "UPDATE possessions SET nom_perso=$1 WHERE addr=$2 AND joueur=$3 RETURNING addr",
      [nom || null, addr, pseudo]
    );
    if (r.rows.length === 0) {
      return res.json({ succes:false, message:"This planet does not belong to you." });
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
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Invalid player" });

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
// production effective d'une planete = production de base * bonus batiments.
// L'extracteur ajoute +15% par niveau sur TOUTES les ressources.
async function productionEffective(addr) {
  const base = galaxy.productionHoraire(addr);
  const niv = await niveauxBatiments(addr);
  const nivExtracteur = niv.extracteur || 0;
  const facteur = 1 + nivExtracteur * 0.15;
  // bilan energetique : si deficit, la production tourne au ralenti
  const energie = galaxy.bilanEnergie(niv);
  const out = {};
  for (const r in base) out[r] = base[r] * facteur * energie.rendement;
  return out;
}

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
      const prod = await productionEffective(row.addr);   // {res: qte/heure} avec bonus
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
    const prod = await productionEffective(row.addr);
    for (const res in prod) prodTotale[res] = (prodTotale[res]||0) + prod[res];
  }
  const stockObj = {};
  for (const row of stock.rows) stockObj[row.ressource] = row.quantite;
  return { stock: stockObj, productionHoraire: prodTotale };
}

app.get("/api/stock", async (req, res) => {
  const pseudo = (req.query.pseudo || "").trim().slice(0,20);
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Invalid player" });
  try {
    if (estAdmin(pseudo)) await crediterStockAdmin(pseudo);
    const data = await encaisserEtLireStock(pseudo);
    res.json(data);
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ============================================================
//  PROFIL & STATISTIQUES & TITRES
// ============================================================
// catalogue des titres et leurs conditions
const TITRES_DEF = {
  fondateur:   { nom: "Founder", desc: "Founded their empire", icone: "flag" },
  explorateur: { nom: "Explorer", desc: "Owns 3 or more planets", icone: "compass" },
  batisseur:   { nom: "Builder", desc: "Owns 5 or more planets", icone: "building" },
  magnat:      { nom: "Magnate", desc: "Owns 10 or more planets", icone: "crown" },
  prospecteur: { nom: "Prospector", desc: "Holds an exotic resource", icone: "diamond" },
  veteran:     { nom: "Veteran", desc: "Empire founded over 7 days ago", icone: "clock" }
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
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Invalid username" });
  try {
    const r = await pool.query(
      "SELECT nom, nom_empire, couleur, bio, embleme, cree_le FROM joueurs WHERE LOWER(nom)=LOWER($1)", [pseudo]
    );
    if (r.rows.length === 0) return res.status(404).json({ erreur: "Player not found" });
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
    if (!pseudo) return res.status(401).json({ erreur: "Not authenticated" });
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

// ============================================================
//  CONSTRUCTION DE BATIMENTS
// ============================================================
// finalise les constructions terminees d'une planete (applique le niveau)
async function finaliserConstructions(addr) {
  const c = await pool.query("SELECT * FROM constructions WHERE addr=$1 AND fin <= NOW()", [addr]);
  for (const ct of c.rows) {
    await pool.query(
      `INSERT INTO batiments (addr, code, niveau) VALUES ($1,$2,$3)
       ON CONFLICT (addr, code) DO UPDATE SET niveau=$3`,
      [addr, ct.code, ct.niveau_vise]
    );
    await pool.query("DELETE FROM constructions WHERE addr=$1", [addr]);
  }
}

// niveaux actuels des batiments d'une planete -> {code: niveau}
async function niveauxBatiments(addr) {
  const r = await pool.query("SELECT code, niveau FROM batiments WHERE addr=$1", [addr]);
  const out = {};
  for (const row of r.rows) out[row.code] = row.niveau;
  return out;
}

// GET etat des batiments d'une planete (+ construction en cours)
app.get("/api/batiments", async (req, res) => {
  const addr = (req.query.addr || "").trim();
  if (!galaxy.parseAddr(addr)) return res.status(400).json({ erreur: "Invalid address" });
  try {
    await finaliserConstructions(addr);
    const niveaux = await niveauxBatiments(addr);
    const enCours = await pool.query("SELECT code, niveau_vise, fin FROM constructions WHERE addr=$1", [addr]);
    // calcule le prochain cout/temps pour chaque batiment
    const dispo = {};
    for (const code in galaxy.BATIMENTS) {
      const niv = niveaux[code] || 0;
      const b = galaxy.BATIMENTS[code];
      dispo[code] = {
        niveau: niv,
        coutProchain: niv < b.max ? galaxy.coutBatiment(code, niv + 1) : null,
        tempsProchain: niv < b.max ? galaxy.tempsBatiment(code, niv + 1) : null,
        prerequisOk: galaxy.prerequisOk(code, niveaux),
        max: b.max
      };
    }
    res.json({
      addr, niveaux, dispo,
      energie: galaxy.bilanEnergie(niveaux),
      construction: enCours.rows.length ? enCours.rows[0] : null
    });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// POST lance une construction (authentifie, debite les ressources)
app.post("/api/construire", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  const addr = (req.body.addr || "").trim();
  const code = (req.body.code || "").trim();
  if (!galaxy.BATIMENTS[code]) return res.status(400).json({ erreur: "Unknown building" });
  if (!galaxy.parseAddr(addr)) return res.status(400).json({ erreur: "Invalid address" });
  const client = await pool.connect();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.status(401).json({ erreur: "Not authenticated" });
    await client.query("BEGIN");
    // la planete appartient-elle au joueur ?
    const poss = await client.query("SELECT joueur FROM possessions WHERE addr=$1 FOR UPDATE", [addr]);
    if (!poss.rows.length || poss.rows[0].joueur !== pseudo) {
      await client.query("ROLLBACK"); return res.json({ succes: false, message: "This planet does not belong to you." });
    }
    // deja une construction en cours ?
    const enCours = await client.query("SELECT 1 FROM constructions WHERE addr=$1", [addr]);
    if (enCours.rows.length) {
      await client.query("ROLLBACK"); return res.json({ succes: false, message: "A construction is already in progress on this planet." });
    }
    // niveau actuel + prerequis
    const niveauxR = await client.query("SELECT code, niveau FROM batiments WHERE addr=$1", [addr]);
    const niveaux = {}; for (const row of niveauxR.rows) niveaux[row.code] = row.niveau;
    const nivActuel = niveaux[code] || 0;
    const b = galaxy.BATIMENTS[code];
    const admin = estAdmin(pseudo);
    if (!admin && nivActuel >= b.max) { await client.query("ROLLBACK"); return res.json({ succes: false, message: "Maximum level reached." }); }
    if (!admin && !galaxy.prerequisOk(code, niveaux)) { await client.query("ROLLBACK"); return res.json({ succes: false, message: "Prerequisites not met." }); }
    const niveauVise = nivActuel + 1;
    const cout = galaxy.coutBatiment(code, niveauVise);
    // d'abord on encaisse la production pour avoir le stock a jour
    // (encaissement inline, comme /api/stock mais dans la transaction)
    // verifie le stock
    for (const r in cout) {
      const s = await client.query("SELECT quantite FROM stocks WHERE joueur=$1 AND ressource=$2", [pseudo, r]);
      const q = s.rows.length ? s.rows[0].quantite : 0;
      if (q < cout[r]) { await client.query("ROLLBACK"); return res.json({ succes: false, message: "Insufficient resources (" + r + ")." }); }
    }
    // debite
    for (const r in cout) {
      await client.query("UPDATE stocks SET quantite = quantite - $1 WHERE joueur=$2 AND ressource=$3", [cout[r], pseudo, r]);
    }
    // cree la construction (instantanee pour un admin)
    const tempsSec = estAdmin(pseudo) ? 0 : galaxy.tempsBatiment(code, niveauVise);
    await client.query(
      "INSERT INTO constructions (addr, joueur, code, niveau_vise, fin) VALUES ($1,$2,$3,$4, NOW() + ($5 || ' seconds')::interval)",
      [addr, pseudo, code, niveauVise, tempsSec]
    );
    await client.query("COMMIT");
    res.json({ succes: true, code, niveauVise, tempsSec });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    res.status(500).json({ erreur: e.message });
  } finally { client.release(); }
});

// ============================================================
//  VAISSEAUX : production au chantier spatial
// ============================================================
// finalise la construction de vaisseaux terminee d'une planete
async function finaliserChantier(addr) {
  const c = await pool.query("SELECT * FROM chantiers WHERE addr=$1 AND fin <= NOW()", [addr]);
  for (const ch of c.rows) {
    await pool.query(
      `INSERT INTO vaisseaux (addr, type, nombre) VALUES ($1,$2,$3)
       ON CONFLICT (addr, type) DO UPDATE SET nombre = vaisseaux.nombre + $3`,
      [addr, ch.type, ch.nombre]
    );
    await pool.query("DELETE FROM chantiers WHERE addr=$1", [addr]);
  }
}

// vaisseaux stationnes sur une planete -> {type: nombre}
async function vaisseauxDe(addr) {
  const r = await pool.query("SELECT type, nombre FROM vaisseaux WHERE addr=$1 AND nombre > 0", [addr]);
  const out = {};
  for (const row of r.rows) out[row.type] = row.nombre;
  return out;
}

// GET vaisseaux + chantier en cours d'une planete
app.get("/api/vaisseaux", async (req, res) => {
  const addr = (req.query.addr || "").trim();
  if (!galaxy.parseAddr(addr)) return res.status(400).json({ erreur: "Invalid address" });
  try {
    await finaliserChantier(addr);
    const flotte = await vaisseauxDe(addr);
    const enCours = await pool.query("SELECT type, nombre, fin FROM chantiers WHERE addr=$1", [addr]);
    // le chantier spatial est-il construit ?
    const niveaux = await niveauxBatiments(addr);
    const aChantier = (niveaux.chantier || 0) > 0;
    res.json({ addr, flotte, aChantier, types: galaxy.VAISSEAUX, chantier: enCours.rows.length ? enCours.rows[0] : null });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// POST produire des vaisseaux (necessite un chantier spatial)
app.post("/api/produire", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  const addr = (req.body.addr || "").trim();
  const type = (req.body.type || "").trim();
  const nombre = Math.max(1, Math.min(500, parseInt(req.body.nombre, 10) || 0));
  if (!galaxy.VAISSEAUX[type]) return res.status(400).json({ erreur: "Unknown type" });
  if (!galaxy.parseAddr(addr)) return res.status(400).json({ erreur: "Invalid address" });
  const client = await pool.connect();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.status(401).json({ erreur: "Not authenticated" });
    await client.query("BEGIN");
    const poss = await client.query("SELECT joueur FROM possessions WHERE addr=$1 FOR UPDATE", [addr]);
    if (!poss.rows.length || poss.rows[0].joueur !== pseudo) {
      await client.query("ROLLBACK"); return res.json({ succes: false, message: "This planet does not belong to you." });
    }
    // chantier spatial requis
    const nivR = await client.query("SELECT code, niveau FROM batiments WHERE addr=$1", [addr]);
    const niv = {}; for (const row of nivR.rows) niv[row.code] = row.niveau;
    if ((niv.chantier || 0) <= 0) {
      await client.query("ROLLBACK"); return res.json({ succes: false, message: "A shipyard is required on this planet." });
    }
    // une seule production de vaisseaux a la fois
    const enCours = await client.query("SELECT 1 FROM chantiers WHERE addr=$1", [addr]);
    if (enCours.rows.length) {
      await client.query("ROLLBACK"); return res.json({ succes: false, message: "The shipyard is already busy." });
    }
    // cout
    const composition = {}; composition[type] = nombre;
    const cout = galaxy.coutFlotte(composition);
    for (const r in cout) {
      const s = await client.query("SELECT quantite FROM stocks WHERE joueur=$1 AND ressource=$2", [pseudo, r]);
      const q = s.rows.length ? s.rows[0].quantite : 0;
      if (q < cout[r]) { await client.query("ROLLBACK"); return res.json({ succes: false, message: "Insufficient resources (" + r + ")." }); }
    }
    for (const r in cout) {
      await client.query("UPDATE stocks SET quantite = quantite - $1 WHERE joueur=$2 AND ressource=$3", [cout[r], pseudo, r]);
    }
    const tempsSec = estAdmin(pseudo) ? 0 : galaxy.tempsFlotte(composition);
    await client.query(
      "INSERT INTO chantiers (addr, joueur, type, nombre, fin) VALUES ($1,$2,$3,$4, NOW() + ($5 || ' seconds')::interval)",
      [addr, pseudo, type, nombre, tempsSec]
    );
    await client.query("COMMIT");
    res.json({ succes: true, type, nombre, tempsSec });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    res.status(500).json({ erreur: e.message });
  } finally { client.release(); }
});

// ============================================================
//  FLOTTES EN MOUVEMENT (etape 3 : deplacement)
// ============================================================
// traite les flottes arrivees : pour l'instant, depot des vaisseaux a destination
// si la planete appartient au joueur (ou est libre et qu'il a un colonisateur).
// Le combat/conquete viendra a l'etape 4.
async function traiterArrivees(joueur) {
  const arrivees = await pool.query(
    "SELECT * FROM flottes WHERE joueur=$1 AND traitee=FALSE AND arrivee <= NOW()", [joueur]
  );
  for (const f of arrivees.rows) {
    const compo = JSON.parse(f.composition);
    const destSys = galaxy.parseAddr(f.destination);
    // a qui appartient la planete destination ?
    const poss = await pool.query("SELECT joueur FROM possessions WHERE addr=$1", [f.destination]);
    const proprio = poss.rows.length ? poss.rows[0].joueur : null;

    if (proprio === f.joueur) {
      // planete amie : la flotte se pose, on depose les vaisseaux
      for (const type in compo) {
        await pool.query(
          `INSERT INTO vaisseaux (addr, type, nombre) VALUES ($1,$2,$3)
           ON CONFLICT (addr, type) DO UPDATE SET nombre = vaisseaux.nombre + $3`,
          [f.destination, type, compo[type]]
        );
      }
      await pool.query("UPDATE flottes SET traitee=TRUE WHERE id=$1", [f.id]);
    } else if (!proprio && compo.colonisateur > 0) {
      // planete libre + colonisateur : on colonise
      await pool.query(
        "INSERT INTO possessions (addr, joueur, origine) VALUES ($1,$2,FALSE) ON CONFLICT (addr) DO NOTHING",
        [f.destination, f.joueur]
      );
      // depose les vaisseaux restants (le colonisateur est consomme)
      const restants = Object.assign({}, compo); restants.colonisateur--;
      for (const type in restants) {
        if (restants[type] <= 0) continue;
        await pool.query(
          `INSERT INTO vaisseaux (addr, type, nombre) VALUES ($1,$2,$3)
           ON CONFLICT (addr, type) DO UPDATE SET nombre = vaisseaux.nombre + $3`,
          [f.destination, type, restants[type]]
        );
      }
      await pool.query("UPDATE flottes SET traitee=TRUE, mission='colonisation' WHERE id=$1", [f.id]);
    } else {
      // === COMBAT === planete ennemie (ou libre sans colonisateur)
      // 1) defense locale : garnison stationnee + bonus caserne
      const garnisonR = await pool.query("SELECT type, nombre FROM vaisseaux WHERE addr=$1 AND nombre > 0", [f.destination]);
      const garnison = {}; for (const row of garnisonR.rows) garnison[row.type] = row.nombre;
      const niveaux = await niveauxBatiments(f.destination);
      const defenseBonus = (niveaux.caserne || 0) * 100;  // caserne : +100 def/niv

      // 2) resolution
      const combat = galaxy.resoudreCombat(compo, garnison, defenseBonus);
      const attRest = combat.attaquantRestant, defRest = combat.defenseurRestant;
      const attTotal = Object.values(attRest).reduce((s,n)=>s+n,0);
      const defTotal = Object.values(defRest).reduce((s,n)=>s+n,0);

      // pertes (pour le rapport)
      function pertes(avant, apres){ const p={}; for(const t in avant){ const d=(avant[t]||0)-(apres[t]||0); if(d>0) p[t]=d; } return p; }
      const pertesAtt = pertes(compo, attRest);
      const pertesDef = pertes(garnison, defRest);

      // 3) met a jour la garnison defensive (survivants)
      for (const type in garnison) {
        await pool.query("UPDATE vaisseaux SET nombre=$1 WHERE addr=$2 AND type=$3", [defRest[type] || 0, f.destination, type]);
      }

      const details = JSON.stringify({ attaquant: compo, defenseur: garnison, pertesAtt, pertesDef, defenseBonus });

      if (combat.vainqueur === "attaquant") {
        // CONQUETE : la planete change de proprietaire, les survivants s'y posent
        if (proprio) {
          await pool.query("UPDATE possessions SET joueur=$1, origine=FALSE WHERE addr=$2", [f.joueur, f.destination]);
        } else {
          await pool.query("INSERT INTO possessions (addr, joueur, origine) VALUES ($1,$2,FALSE) ON CONFLICT (addr) DO UPDATE SET joueur=$2", [f.destination, f.joueur]);
        }
        // on vide l'ancienne garnison et on pose les survivants de l'attaquant
        await pool.query("DELETE FROM vaisseaux WHERE addr=$1", [f.destination]);
        for (const type in attRest) {
          if (attRest[type] <= 0) continue;
          await pool.query(
            `INSERT INTO vaisseaux (addr, type, nombre) VALUES ($1,$2,$3)
             ON CONFLICT (addr, type) DO UPDATE SET nombre = vaisseaux.nombre + $3`,
            [f.destination, type, attRest[type]]
          );
        }
        await pool.query("UPDATE flottes SET traitee=TRUE, mission='conquete' WHERE id=$1", [f.id]);
        // rapports
        await pool.query("INSERT INTO rapports (joueur, adversaire, lieu, vainqueur, resultat, details) VALUES ($1,$2,$3,'attaquant','victoire',$4)", [f.joueur, proprio, f.destination, details]);
        if (proprio) await pool.query("INSERT INTO rapports (joueur, adversaire, lieu, vainqueur, resultat, details) VALUES ($1,$2,$3,'attaquant','defaite',$4)", [proprio, f.joueur, f.destination, details]);
      } else {
        // DEFENSE TIENT : les survivants de l'attaquant rentrent a l'origine
        const survivants = {}; for (const t in attRest) if (attRest[t] > 0) survivants[t] = attRest[t];
        const total = Object.values(survivants).reduce((s,n)=>s+n,0);
        if (total > 0) {
          const vit = galaxy.vitesseFlotte(survivants);
          const oa = galaxy.parseAddr(f.origine), od = galaxy.parseAddr(f.destination);
          const duree = galaxy.dureeTrajet(od.sysIdx, oa.sysIdx, vit) || 120;
          await pool.query(
            "UPDATE flottes SET origine=$1, destination=$2, composition=$3, depart=NOW(), arrivee=NOW() + ($4 || ' seconds')::interval, mission='retour' WHERE id=$5",
            [f.destination, f.origine, JSON.stringify(survivants), duree, f.id]
          );
        } else {
          // flotte aneantie
          await pool.query("UPDATE flottes SET traitee=TRUE, mission='detruite' WHERE id=$1", [f.id]);
        }
        await pool.query("INSERT INTO rapports (joueur, adversaire, lieu, vainqueur, resultat, details) VALUES ($1,$2,$3,'defenseur','defaite',$4)", [f.joueur, proprio, f.destination, details]);
        if (proprio) await pool.query("INSERT INTO rapports (joueur, adversaire, lieu, vainqueur, resultat, details) VALUES ($1,$2,$3,'defenseur','victoire',$4)", [proprio, f.joueur, f.destination, details]);
      }
    }
  }
}

// GET rapports de bataille du joueur (non lus en priorite)
app.get("/api/rapports", async (req, res) => {
  const jeton = (req.query.jeton || "").trim();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.status(401).json({ erreur: "Not authenticated" });
    const r = await pool.query(
      "SELECT id, adversaire, lieu, vainqueur, resultat, details, cree_le, lu FROM rapports WHERE joueur=$1 ORDER BY cree_le DESC LIMIT 30", [pseudo]
    );
    const rapports = r.rows.map(x => ({
      id: x.id, adversaire: x.adversaire, lieu: x.lieu, vainqueur: x.vainqueur,
      resultat: x.resultat, details: x.details ? JSON.parse(x.details) : null, cree_le: x.cree_le, lu: x.lu
    }));
    const nonLus = rapports.filter(x => !x.lu).length;
    res.json({ rapports, nonLus });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// POST marquer les rapports comme lus
app.post("/api/rapports-lus", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.status(401).json({ erreur: "Not authenticated" });
    await pool.query("UPDATE rapports SET lu=TRUE WHERE joueur=$1", [pseudo]);
    res.json({ succes: true });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// GET flottes en mouvement du joueur (pour affichage sur la carte)
app.get("/api/flottes", async (req, res) => {
  const jeton = (req.query.jeton || "").trim();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.status(401).json({ erreur: "Not authenticated" });
    await traiterArrivees(pseudo);
    const r = await pool.query(
      "SELECT id, origine, destination, composition, mission, depart, arrivee FROM flottes WHERE joueur=$1 AND traitee=FALSE ORDER BY arrivee", [pseudo]
    );
    const flottes = r.rows.map(f => ({
      id: f.id, origine: f.origine, destination: f.destination,
      composition: JSON.parse(f.composition), mission: f.mission,
      depart: f.depart, arrivee: f.arrivee
    }));
    res.json({ flottes });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// POST envoyer une flotte d'une planete vers un systeme/planete
app.post("/api/envoyer", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  const origine = (req.body.origine || "").trim();
  const destination = (req.body.destination || "").trim();
  const composition = req.body.composition || {};
  if (!galaxy.parseAddr(origine) || !galaxy.parseAddr(destination)) return res.status(400).json({ erreur: "Invalid address" });
  if (origine === destination) return res.json({ succes: false, message: "Origin and destination are identical." });
  const client = await pool.connect();
  try {
    const pseudo = await joueurDeSession(jeton);
    if (!pseudo) return res.status(401).json({ erreur: "Not authenticated" });
    await client.query("BEGIN");
    // la planete d'origine appartient-elle au joueur ?
    const poss = await client.query("SELECT joueur FROM possessions WHERE addr=$1 FOR UPDATE", [origine]);
    if (!poss.rows.length || poss.rows[0].joueur !== pseudo) {
      await client.query("ROLLBACK"); return res.json({ succes: false, message: "The origin planet does not belong to you." });
    }
    // verifie et debite les vaisseaux disponibles
    let totalEnvoye = 0;
    for (const type in composition) {
      const n = Math.max(0, parseInt(composition[type], 10) || 0);
      if (n <= 0) { delete composition[type]; continue; }
      if (!galaxy.VAISSEAUX[type]) { await client.query("ROLLBACK"); return res.json({ succes: false, message: "Unknown ship type." }); }
      const dispo = await client.query("SELECT nombre FROM vaisseaux WHERE addr=$1 AND type=$2", [origine, type]);
      const q = dispo.rows.length ? dispo.rows[0].nombre : 0;
      if (q < n) { await client.query("ROLLBACK"); return res.json({ succes: false, message: "Not enough " + type + "s available." }); }
      composition[type] = n; totalEnvoye += n;
    }
    if (totalEnvoye <= 0) { await client.query("ROLLBACK"); return res.json({ succes: false, message: "No ships selected." }); }
    // debite les vaisseaux de la planete (lecture+ecriture pour compat maximale)
    for (const type in composition) {
      const cur = await client.query("SELECT nombre FROM vaisseaux WHERE addr=$1 AND type=$2", [origine, type]);
      const q = cur.rows.length ? cur.rows[0].nombre : 0;
      await client.query("UPDATE vaisseaux SET nombre=$1 WHERE addr=$2 AND type=$3", [Math.max(0, q - composition[type]), origine, type]);
    }
    // calcule la duree du trajet
    const oa = galaxy.parseAddr(origine), od = galaxy.parseAddr(destination);
    const vit = galaxy.vitesseFlotte(composition);
    const duree = galaxy.dureeTrajet(oa.sysIdx, od.sysIdx, vit) || 120;
    const r = await client.query(
      "INSERT INTO flottes (joueur, origine, destination, composition, mission, arrivee) VALUES ($1,$2,$3,$4,'transit', NOW() + ($5 || ' seconds')::interval) RETURNING id",
      [pseudo, origine, destination, JSON.stringify(composition), duree]
    );
    await client.query("COMMIT");
    res.json({ succes: true, id: r.rows[0].id, duree });
  } catch (e) {
    await client.query("ROLLBACK").catch(()=>{});
    res.status(500).json({ erreur: e.message });
  } finally { client.release(); }
});

// ============================================================
//  RESET MOT DE PASSE (admin) — protege par cle secrete.
//  Definis ADMIN_RESET_KEY dans les variables d'environnement Render.
//  Usage : POST /api/admin-reset { cle, pseudo, nouveauMotDePasse }
// ============================================================
app.post("/api/admin-reset", async (req, res) => {
  const cle = (req.body.cle || "").trim();
  const pseudo = (req.body.pseudo || "").trim().slice(0, 20);
  const nouveau = (req.body.nouveauMotDePasse || "");
  const cleAttendue = process.env.ADMIN_RESET_KEY || "";
  if (!cleAttendue) return res.status(403).json({ erreur: "Reset disabled (no ADMIN_RESET_KEY set on server)." });
  if (cle !== cleAttendue) return res.status(403).json({ erreur: "Invalid reset key." });
  if (pseudo.length < 2 || nouveau.length < 4) return res.status(400).json({ erreur: "Invalid username or password (min 4 chars)." });
  try {
    const existe = await pool.query("SELECT nom FROM joueurs WHERE LOWER(nom)=LOWER($1)", [pseudo]);
    const hash = auth.hacherMotDePasse(nouveau);
    if (existe.rows.length === 0) {
      // le compte n'existe pas : on le cree
      await pool.query("INSERT INTO joueurs (nom, mdp_hash) VALUES ($1,$2)", [pseudo, hash]);
      const home = await assurerHome(pseudo);
      return res.json({ succes: true, message: "Account created with new password.", home });
    }
    await pool.query("UPDATE joueurs SET mdp_hash=$1 WHERE LOWER(nom)=LOWER($2)", [hash, pseudo]);
    res.json({ succes: true, message: "Password reset for " + existe.rows[0].nom + "." });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ============================================================
//  RECUPERATION DE COMPTE (par email -> jeton de reset)
// ============================================================
const crypto = require("crypto");

// le joueur demande une recuperation : on genere un jeton (valable 1h)
// (l'envoi d'email reel sera branche plus tard ; pour l'instant le lien
//  est recuperable par l'admin via le panneau de moderation)
app.post("/api/recuperation", async (req, res) => {
  const identifiant = (req.body.identifiant || "").trim().slice(0, 100);
  if (identifiant.length < 2) return res.status(400).json({ erreur: "Enter your username or email" });
  try {
    // recherche par pseudo OU email
    const r = await pool.query(
      "SELECT nom, email FROM joueurs WHERE LOWER(nom)=LOWER($1) OR LOWER(email)=LOWER($1)", [identifiant]
    );
    // reponse identique que le compte existe ou non (anti-enumeration)
    if (r.rows.length === 0) return res.json({ succes: true, message: "If this account exists, a reset link has been generated." });
    const joueur = r.rows[0].nom;
    const jeton = crypto.randomBytes(24).toString("hex");
    await pool.query(
      "INSERT INTO resets (jeton, joueur, expire) VALUES ($1,$2, NOW() + INTERVAL '1 hour')", [jeton, joueur]
    );
    // TODO : envoyer un email avec le lien /reset?token=jeton quand un service email sera configure
    res.json({ succes: true, message: "If this account exists, a reset link has been generated.", lienDev: "/reset?token=" + jeton });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// le joueur applique le reset avec son jeton
app.post("/api/recuperation-appliquer", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  const nouveau = (req.body.nouveauMotDePasse || "");
  if (nouveau.length < 4) return res.status(400).json({ erreur: "Password too short (min 4 characters)" });
  try {
    const r = await pool.query("SELECT joueur, expire, utilise FROM resets WHERE jeton=$1", [jeton]);
    if (r.rows.length === 0) return res.json({ succes: false, message: "Invalid reset link." });
    const reset = r.rows[0];
    if (reset.utilise) return res.json({ succes: false, message: "This reset link has already been used." });
    if (new Date(reset.expire).getTime() < Date.now()) return res.json({ succes: false, message: "This reset link has expired." });
    const hash = auth.hacherMotDePasse(nouveau);
    await pool.query("UPDATE joueurs SET mdp_hash=$1 WHERE nom=$2", [hash, reset.joueur]);
    await pool.query("UPDATE resets SET utilise=TRUE WHERE jeton=$1", [jeton]);
    res.json({ succes: true, message: "Password updated. You can now log in.", pseudo: reset.joueur });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// ============================================================
//  MODERATION ADMIN (protege : l'appelant doit etre admin)
// ============================================================
// verifie que le jeton appartient a un admin
async function exigerAdmin(jeton) {
  const pseudo = await joueurDeSession(jeton);
  if (!pseudo || !estAdmin(pseudo)) return null;
  return pseudo;
}

// GET liste detaillee des joueurs (admin)
app.get("/api/admin/joueurs", async (req, res) => {
  const jeton = (req.query.jeton || "").trim();
  try {
    const admin = await exigerAdmin(jeton);
    if (!admin) return res.status(403).json({ erreur: "Admin access required" });
    const r = await pool.query(`
      SELECT j.nom, j.email, j.banni, j.cree_le, j.vu_le, COUNT(p.addr) AS planetes
      FROM joueurs j
      LEFT JOIN possessions p ON p.joueur = j.nom
      GROUP BY j.nom, j.email, j.banni, j.cree_le, j.vu_le
      ORDER BY j.vu_le DESC
    `);
    res.json({ joueurs: r.rows });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

// POST action de moderation (admin) : ban / unban / delete / reset-password
app.post("/api/admin/action", async (req, res) => {
  const jeton = (req.body.jeton || "").trim();
  const action = (req.body.action || "").trim();
  const cible = (req.body.cible || "").trim();
  try {
    const admin = await exigerAdmin(jeton);
    if (!admin) return res.status(403).json({ erreur: "Admin access required" });
    if (!cible) return res.json({ succes: false, message: "No target specified." });
    if (estAdmin(cible)) return res.json({ succes: false, message: "Cannot moderate an admin account." });
    const existe = await pool.query("SELECT nom FROM joueurs WHERE LOWER(nom)=LOWER($1)", [cible]);
    if (existe.rows.length === 0) return res.json({ succes: false, message: "Player not found." });
    const nom = existe.rows[0].nom;

    if (action === "ban") {
      await pool.query("UPDATE joueurs SET banni=TRUE WHERE nom=$1", [nom]);
      await pool.query("DELETE FROM sessions WHERE joueur=$1", [nom]); // deconnecte
      return res.json({ succes: true, message: nom + " has been banned." });
    }
    if (action === "unban") {
      await pool.query("UPDATE joueurs SET banni=FALSE WHERE nom=$1", [nom]);
      return res.json({ succes: true, message: nom + " has been unbanned." });
    }
    if (action === "reset-password") {
      const nouveau = (req.body.nouveauMotDePasse || "");
      if (nouveau.length < 4) return res.json({ succes: false, message: "Password too short." });
      await pool.query("UPDATE joueurs SET mdp_hash=$1 WHERE nom=$2", [auth.hacherMotDePasse(nouveau), nom]);
      return res.json({ succes: true, message: "Password reset for " + nom + "." });
    }
    if (action === "delete") {
      // supprime le compte et toutes ses donnees
      for (const t of ["possessions","stocks","batiments","constructions","vaisseaux","chantiers","flottes","rapports","titres","sessions","resets"]) {
        await pool.query("DELETE FROM " + t + " WHERE joueur=$1", [nom]).catch(()=>{});
      }
      await pool.query("DELETE FROM joueurs WHERE nom=$1", [nom]);
      return res.json({ succes: true, message: nom + " has been deleted." });
    }
    res.json({ succes: false, message: "Unknown action." });
  } catch (e) { res.status(500).json({ erreur: e.message }); }
});

app.get("/sante", (req, res) => res.json({ statut: "ok", version: "1.0" }));

preparerBase()
  .then(() => app.listen(PORT, () => console.log(`Serveur demarre sur ${PORT}`)))
  .catch((e) => {
    console.error("Erreur base :", e.message);
    app.listen(PORT, () => console.log(`Serveur demarre (base en erreur) sur ${PORT}`));
  });
