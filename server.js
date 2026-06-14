// ============================================================
//  SERVEUR DU JEU — VERSION 0.1
//  Pour l'instant il fait UNE seule chose : répondre "ça marche"
//  quand on ouvre l'adresse dans un navigateur.
//  On ajoutera la base de données et le multijoueur ensuite.
// ============================================================

// On utilise "express", un petit outil qui aide à construire un serveur.
const express = require("express");
const app = express();

// L'hébergeur (Render) nous dira sur quel "port" écouter.
// Si on teste sur notre PC, on utilise le port 3000 par défaut.
const PORT = process.env.PORT || 3000;

// Quand quelqu'un ouvre l'adresse principale ("/"), on répond ce message.
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><meta charset="utf-8"><title>Empire Galactique</title></head>
      <body style="background:#04050d;color:#fff;font-family:sans-serif;text-align:center;padding-top:80px">
        <h1>🚀 Le serveur du jeu est en ligne !</h1>
        <p>Version 0.1 — le moteur s'allume correctement.</p>
        <p style="color:#888">Prochaine étape : brancher la base de données.</p>
      </body>
    </html>
  `);
});

// Une deuxième adresse "/sante" qui sert à vérifier que tout va bien.
// (On s'en servira plus tard pour des tests automatiques.)
app.get("/sante", (req, res) => {
  res.json({ statut: "ok", version: "0.1" });
});

// On allume le serveur. À partir d'ici, il écoute et attend les visiteurs.
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
