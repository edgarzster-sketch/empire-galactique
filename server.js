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
  // table de possession : une planete (adresse) appartient a un joueur
  await pool.query(`
    CREATE TABLE IF NOT EXISTS possessions (
      addr TEXT PRIMARY KEY,
      joueur TEXT NOT NULL,
      origine BOOLEAN DEFAULT FALSE,
      acquis_le TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Base prete : tables 'joueurs' et 'possessions' OK");
}

// helper : une adresse est-elle deja occupee ?
async function estOccupee(addr){
  const r = await pool.query("SELECT 1 FROM possessions WHERE addr=$1", [addr]);
  return r.rows.length > 0;
}

// ============================================================
//  CONNEXION : enregistre le joueur ET lui attribue une planete
//  d'origine s'il n'en a pas encore.
// ============================================================
app.post("/api/connexion", async (req, res) => {
  const pseudo = (req.body.pseudo || "").trim().slice(0, 20);
  if (pseudo.length < 2) return res.status(400).json({ erreur: "Pseudo trop court" });
  try {
    await pool.query(
      `INSERT INTO joueurs (nom, vu_le) VALUES ($1, NOW())
       ON CONFLICT (nom) DO UPDATE SET vu_le = NOW()`,
      [pseudo]
    );
    // a-t-il deja une planete d'origine ?
    let home = await pool.query(
      "SELECT addr FROM possessions WHERE joueur=$1 AND origine=TRUE LIMIT 1",
      [pseudo]
    );
    let homeAddr;
    if (home.rows.length === 0) {
      // on lui en attribue une (deterministe, habitable, libre)
      // estOccupee version synchrone-ish : on charge la liste des adresses prises
      const prises = new Set(
        (await pool.query("SELECT addr FROM possessions")).rows.map(r => r.addr)
      );
      homeAddr = galaxy.homeworldFor(pseudo, (a) => prises.has(a));
      if (homeAddr) {
        await pool.query(
          "INSERT INTO possessions (addr, joueur, origine) VALUES ($1,$2,TRUE) ON CONFLICT (addr) DO NOTHING",
          [homeAddr, pseudo]
        );
      }
    } else {
      homeAddr = home.rows[0].addr;
    }
    res.json({ pseudo, graine: galaxy.GRAINE_UNIVERS, home: homeAddr });
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
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
    const r = await pool.query("SELECT addr, joueur, origine FROM possessions");
    res.json({ nombre: r.rows.length, possessions: r.rows });
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

app.get("/sante", (req, res) => res.json({ statut: "ok", version: "0.4" }));

preparerBase()
  .then(() => app.listen(PORT, () => console.log(`Serveur demarre sur ${PORT}`)))
  .catch((e) => {
    console.error("Erreur base :", e.message);
    app.listen(PORT, () => console.log(`Serveur demarre (base en erreur) sur ${PORT}`));
  });
