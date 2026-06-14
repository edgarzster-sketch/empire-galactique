// ============================================================
//  SERVEUR DU JEU — VERSION 0.3
//  Nouveautes :
//   - Il SERT le jeu (la galaxie) quand on ouvre l'adresse.
//   - Les joueurs se connectent avec un pseudo (enregistre en base).
//   - Il fournit la GRAINE de la galaxie a tous les joueurs.
// ============================================================

const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

// On sert tous les fichiers du dossier "public" (dont index.html = le jeu).
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// La GRAINE de l'univers. Tous les joueurs recevront la meme,
// donc tout le monde voit exactement la meme galaxie.
const GRAINE_UNIVERS = 20260614;

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
  console.log("Base prete : table 'joueurs' OK");
}

// ============================================================
//  API DU JEU (les "adresses" que le jeu appelle en coulisses)
// ============================================================

// Connexion d'un joueur : il envoie son pseudo, on l'enregistre
// (ou on le retrouve s'il existe deja) et on lui renvoie la graine.
app.post("/api/connexion", async (req, res) => {
  const pseudo = (req.body.pseudo || "").trim().slice(0, 20);
  if (pseudo.length < 2) {
    return res.status(400).json({ erreur: "Pseudo trop court" });
  }
  try {
    // INSERT s'il est nouveau ; sinon on met juste a jour "vu_le".
    await pool.query(
      `INSERT INTO joueurs (nom, vu_le) VALUES ($1, NOW())
       ON CONFLICT (nom) DO UPDATE SET vu_le = NOW()`,
      [pseudo]
    );
    res.json({ pseudo, graine: GRAINE_UNIVERS });
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

// Liste des joueurs (les plus recemment vus en premier).
app.get("/api/joueurs", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT nom, vu_le FROM joueurs ORDER BY vu_le DESC LIMIT 50"
    );
    res.json({ nombre: r.rows.length, joueurs: r.rows });
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

app.get("/sante", (req, res) => res.json({ statut: "ok", version: "0.3" }));

// Note : on n'a plus besoin de definir "/" a la main.
// express.static envoie automatiquement public/index.html (le jeu).

preparerBase()
  .then(() => app.listen(PORT, () => console.log(`Serveur demarre sur ${PORT}`)))
  .catch((e) => {
    console.error("Erreur base :", e.message);
    app.listen(PORT, () => console.log(`Serveur demarre (base en erreur) sur ${PORT}`));
  });
