// ============================================================
//  SERVEUR DU JEU — VERSION 0.2
//  Nouveauté : il parle maintenant à la base de données (le "cahier").
//  Il peut enregistrer un joueur et retrouver la liste des joueurs,
//  même après un redémarrage. C'est ça, la persistance.
// ============================================================

const express = require("express");
const { Pool } = require("pg"); // "pg" = l'outil pour parler à PostgreSQL

const app = express();
app.use(express.json()); // permet au serveur de comprendre les données reçues

const PORT = process.env.PORT || 3000;

// --- Connexion à la base de données ---
// L'adresse secrète n'est PAS écrite ici. Render nous la fournira
// via une "variable d'environnement" nommée DATABASE_URL (étape suivante).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // requis par Render
});

// --- Préparation du cahier au démarrage ---
// On crée la "table" des joueurs si elle n'existe pas encore.
// Une table = une page du cahier avec des colonnes (ici : id, nom, date).
async function preparerBase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS joueurs (
      id SERIAL PRIMARY KEY,
      nom TEXT UNIQUE NOT NULL,
      cree_le TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log("Base de données prete : table 'joueurs' OK");
}

// ============================================================
//  LES ADRESSES (ce a quoi le serveur sait repondre)
// ============================================================

// Page d'accueil : montre que le serveur tourne ET teste la base.
app.get("/", async (req, res) => {
  let etatBase = "non connectee";
  let nbJoueurs = 0;
  try {
    const r = await pool.query("SELECT COUNT(*) FROM joueurs");
    nbJoueurs = r.rows[0].count;
    etatBase = "connectee OK";
  } catch (e) {
    etatBase = "ERREUR : " + e.message;
  }
  res.send(`
    <html><head><meta charset="utf-8"><title>Empire Galactique</title></head>
    <body style="background:#04050d;color:#fff;font-family:sans-serif;text-align:center;padding-top:60px">
      <h1>Serveur en ligne - version 0.2</h1>
      <p>Base de donnees : <strong>${etatBase}</strong></p>
      <p>Joueurs enregistres : <strong>${nbJoueurs}</strong></p>
      <hr style="width:300px;border-color:#333;margin:30px auto">
      <p style="color:#888">Pour enregistrer un joueur de test, ouvre :<br>
      <code style="color:#9bd5d0">/inscription?nom=TonPseudo</code></p>
      <p style="color:#888">Pour voir tous les joueurs :<br>
      <code style="color:#9bd5d0">/joueurs</code></p>
    </body></html>
  `);
});

// Enregistrer un joueur : on ouvre /inscription?nom=Edgar
app.get("/inscription", async (req, res) => {
  const nom = req.query.nom;
  if (!nom) {
    return res.json({ erreur: "Ajoute ?nom=TonPseudo dans l'adresse" });
  }
  try {
    await pool.query("INSERT INTO joueurs (nom) VALUES ($1)", [nom]);
    res.json({ succes: true, message: `Joueur "${nom}" enregistre !` });
  } catch (e) {
    // Si le nom existe deja (colonne UNIQUE), on tombe ici.
    res.json({ succes: false, message: `Impossible : "${nom}" existe peut-etre deja.` });
  }
});

// Voir tous les joueurs enregistres
app.get("/joueurs", async (req, res) => {
  try {
    const r = await pool.query("SELECT nom, cree_le FROM joueurs ORDER BY cree_le");
    res.json({ nombre: r.rows.length, joueurs: r.rows });
  } catch (e) {
    res.json({ erreur: e.message });
  }
});

// Verification de sante (pour tests automatiques plus tard)
app.get("/sante", (req, res) => res.json({ statut: "ok", version: "0.2" }));

// --- Demarrage : on prepare la base PUIS on allume le serveur ---
preparerBase()
  .then(() => {
    app.listen(PORT, () => console.log(`Serveur demarre sur le port ${PORT}`));
  })
  .catch((e) => {
    console.error("Erreur au demarrage de la base :", e.message);
    app.listen(PORT, () => console.log(`Serveur demarre (base en erreur) sur ${PORT}`));
  });
