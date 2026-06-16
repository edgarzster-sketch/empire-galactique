// ============================================================
//  GENERATION GALACTIQUE PARTAGEE — v0.4
//  Ce fichier est la "verite" de la galaxie. Le serveur l'utilise
//  pour verifier les demandes des joueurs ; le client l'utilisera
//  pour afficher. MEME graine => MEME galaxie partout.
//
//  Principe d'adressage :
//    - Un systeme a une adresse : "S" + son index   ex: "S1234"
//    - Une planete a une adresse : systeme + "-P" + index  ex: "S1234-P2"
//  Ces adresses sont stables et deterministes a vie.
// ============================================================

const GRAINE_UNIVERS = 20260614;
const NB_SYSTEMS = 5000;
const GALAXY_R = 140000;

// generateur pseudo-aleatoire deterministe (identique cote client)
function rng(seed){
  let s = seed >>> 0;
  return () => { s = (s*1664525 + 1013904223) >>> 0; return s/4294967296; };
}

const STAR_FREQ = [
  {cls:'M',freq:34},{cls:'K',freq:20},{cls:'G',freq:16},{cls:'F',freq:10},
  {cls:'A',freq:7},{cls:'B',freq:5},{cls:'DA',freq:5},{cls:'RG',freq:3}
];
const STAR_POOL = [];
STAR_FREQ.forEach((s,i)=>{ for(let k=0;k<s.freq;k++) STAR_POOL.push(i); });

const PTYPE_POOL = ['rocheuse','tellurique','tellurique','ocean','desert','desert',
  'volcanique','glace','naine','gazeuse','gazeuse','geante_glace'];

// --- Position et metadonnees d'un systeme a partir de son index ---
// On rejoue le RNG global jusqu'a l'index voulu pour rester deterministe.
// Pour l'efficacite cote serveur, on genere tout une fois et on met en cache.
let _systemsCache = null;
function genAllSystems(){
  if(_systemsCache) return _systemsCache;
  const r = rng(GRAINE_UNIVERS);
  const arms = 5;
  const systems = [];
  for(let i=0;i<NB_SYSTEMS;i++){
    const arm = i%arms;
    const tt = Math.pow(r(),0.5);
    const ang = tt*7 + arm*(6.28/arms) + (r()-0.5)*0.7;
    const dist = 300 + tt*GALAXY_R;
    const scatter = dist*0.16;
    const x = Math.cos(ang)*dist + (r()-0.5)*scatter;
    const y = Math.sin(ang)*dist*0.78 + (r()-0.5)*scatter;
    const starIdx = STAR_POOL[Math.floor(r()*STAR_POOL.length)];
    const starR = 0.7 + r()*0.5;
    const hasBelt = r()>0.5;
    systems.push({ idx:i, addr:'S'+i, x, y, starClass:STAR_FREQ[starIdx].cls, starR, hasBelt, seed:100000+i });
  }
  _systemsCache = systems;
  return systems;
}

// --- Tailles par type (necessaire pour consommer le RNG comme le client) ---
const PTYPE_SIZE = {
  rocheuse:[3,6], tellurique:[4,7], ocean:[4,7], desert:[3,6], volcanique:[3,6],
  glace:[3,6], naine:[2,3], gazeuse:[11,17], geante_glace:[9,13]
};
const PTYPE_GAS = { gazeuse:true, geante_glace:true };

// --- Planetes d'un systeme (generation paresseuse, deterministe) ---
//  CET ORDRE DE CONSOMMATION DU RNG DOIT ETRE IDENTIQUE AU CLIENT (index.html).
//  Sinon les adresses ne designent pas les memes planetes => triche/bugs.
const _planetCache = {};
function genPlanets(sysIdx){
  if(_planetCache[sysIdx]) return _planetCache[sysIdx];
  const sys = genAllSystems()[sysIdx];
  if(!sys) return [];
  const pr = rng(sys.seed);
  const pc = 3 + Math.floor(pr()*5);
  const planets = [];
  for(let j=0;j<pc;j++){
    const type = PTYPE_POOL[Math.floor(pr()*PTYPE_POOL.length)];   // type
    const useProper = pr() > 0.65;                                  // test nom
    if(useProper) pr();                                             // nom propre (conditionnel)
    pr();          // a
    pr();          // size
    pr();          // e
    pr();          // period
    pr();          // angle
    const gas = !!PTYPE_GAS[type];
    if(gas) pr();  // ring : le client n'appelle pr() QUE si gazeuse (court-circuit &&)
    pr();          // moons (1 tirage dans les deux cas)
    pr();          // spinSpeed
    planets.push({ idx:j, addr:sys.addr+'-P'+j, type, sysIdx });
  }
  _planetCache[sysIdx] = planets;
  return planets;
}

// --- Verifie qu'une adresse de planete existe vraiment ---
// "S1234-P2" -> { sysIdx:1234, pIdx:2 } ou null si invalide
function parseAddr(addr){
  const m = /^S(\d+)-P(\d+)$/.exec(addr || '');
  if(!m) return null;
  const sysIdx = parseInt(m[1],10), pIdx = parseInt(m[2],10);
  if(sysIdx<0 || sysIdx>=NB_SYSTEMS) return null;
  const planets = genPlanets(sysIdx);
  if(pIdx<0 || pIdx>=planets.length) return null;
  return { sysIdx, pIdx, planet:planets[pIdx], system:genAllSystems()[sysIdx] };
}

// --- Choisit une planete d'origine deterministe pour un joueur ---
// On derive une planete depuis le nom du joueur : meme pseudo => meme berceau,
// mais on cherche une planete habitable (tellurique/ocean) libre.
function homeworldFor(pseudo, estOccupee){
  // hash simple du pseudo en nombre
  let h = 2166136261;
  for(let i=0;i<pseudo.length;i++){ h ^= pseudo.charCodeAt(i); h = Math.imul(h,16777619); }
  h = h >>> 0;
  // on parcourt des systemes "au hasard mais deterministe" et on prend
  // la 1ere planete habitable libre
  const r = rng(h);
  for(let tries=0; tries<2000; tries++){
    const sysIdx = Math.floor(r()*NB_SYSTEMS);
    const planets = genPlanets(sysIdx);
    for(const p of planets){
      if((p.type==='tellurique'||p.type==='ocean') && !estOccupee(p.addr)){
        return p.addr;
      }
    }
  }
  // secours : n'importe quelle planete libre
  for(let tries=0; tries<2000; tries++){
    const sysIdx = Math.floor(r()*NB_SYSTEMS);
    const planets = genPlanets(sysIdx);
    for(const p of planets){ if(!estOccupee(p.addr)) return p.addr; }
  }
  return null;
}

module.exports = {
  GRAINE_UNIVERS, NB_SYSTEMS,
  genAllSystems, genPlanets, parseAddr, homeworldFor
};

// --- Nom scientifique deterministe d'une planete ---
// Format type catalogue stellaire : "HD-<sysIdx>-<lettre>" + suffixe de classe
// ex: S131-P2 (tellurique) -> "HD-131 c" / Kepler-style
function nomScientifique(addr){
  const info = parseAddr(addr);
  if(!info) return addr;
  const lettres = 'bcdefghij'; // l'etoile = a, planetes = b,c,d...
  const lettre = lettres[info.pIdx] || ('p'+info.pIdx);
  // prefixe de catalogue derive du systeme (deterministe)
  const prefixes = ['HD','GJ','HIP','TYC','Kepler','TOI','WASP','K'];
  const r = rng(info.system.seed + 99);
  const prefixe = prefixes[Math.floor(r()*prefixes.length)];
  const num = 1000 + (info.sysIdx % 9000);
  return prefixe + '-' + num + ' ' + lettre;
}

module.exports.nomScientifique = nomScientifique;

// ============================================================
//  ECONOMIE — taux de production par ressource (partage client/serveur)
//  Production horaire d'une ressource sur une planete =
//     densite (1..10) * tauxBase. Rythme 4X (lent, a l'heure).
// ============================================================
// taux de base PAR HEURE par point de densite, selon la rarete
const RES_TAUX = {
  // communs (tier 0) : production rapide
  fer:6, silicates:6, aluminium:5, carbone:5, eau:6, biomasse:5, hydrogene:6, solaire:6,
  // industriels (tier 1) : moyen
  cuivre:3, nickel:3, zinc:3, plomb:2.5, etain:2.5, soufre:3, methane:3,
  // strategiques (tier 2)
  titane:1.5, cobalt:1.2, lithium:1.5, cristaux:1.2, helium3:1.5,
  // precieux (tier 3) : lent
  argent:0.5, uranium:0.5, thorium:0.4, terres_rares:0.5, gaz_exo:0.5,
  // tres precieux (tier 4) : tres lent (valeur d'echange)
  or:0.2, platine:0.18, palladium:0.18, cristaux_exo:0.12,
  // exotiques (tier 5) : extremement lent (tresors)
  antimatiere:0.04, metamateriaux:0.04
};

// Reproduit la generation des ressources d'une planete (densites)
// IDENTIQUE au client. Necessaire pour calculer la production cote serveur.
const RES_TIER = {
  fer:0,silicates:0,aluminium:0,carbone:0,eau:0,biomasse:0,hydrogene:0,solaire:0,
  cuivre:1,nickel:1,zinc:1,plomb:1,etain:1,soufre:1,methane:1,
  titane:2,cobalt:2,lithium:2,cristaux:2,helium3:2,
  argent:3,uranium:3,thorium:3,terres_rares:3,gaz_exo:3,
  or:4,platine:4,palladium:4,cristaux_exo:4,
  antimatiere:5,metamateriaux:5
};
const PROFILS = {
  rocheuse:[['fer',8,1],['silicates',7,1],['aluminium',6,0.9],['cuivre',5,0.8],['nickel',5,0.7],['titane',4,0.45],['cobalt',3,0.3],['argent',3,0.12],['platine',5,0.04],['or',4,0.03]],
  tellurique:[['eau',8,1],['biomasse',8,0.95],['silicates',6,1],['fer',5,0.9],['carbone',6,0.8],['cuivre',4,0.5],['lithium',3,0.25],['argent',2,0.08],['or',3,0.02]],
  ocean:[['eau',9,1],['biomasse',9,1],['carbone',6,0.8],['silicates',4,0.7],['fer',3,0.6],['cristaux',3,0.3],['terres_rares',3,0.06]],
  desert:[['silicates',7,1],['solaire',9,1],['fer',6,0.9],['aluminium',6,0.8],['lithium',6,0.5],['terres_rares',5,0.3],['titane',4,0.3],['or',4,0.04],['platine',4,0.03]],
  volcanique:[['fer',7,1],['soufre',9,1],['nickel',6,0.9],['cuivre',6,0.8],['cobalt',6,0.6],['titane',5,0.5],['uranium',5,0.35],['thorium',4,0.25],['platine',7,0.10],['palladium',6,0.08],['or',7,0.08],['argent',5,0.2]],
  glace:[['eau',9,1],['methane',5,0.6],['cristaux',4,0.5],['silicates',3,0.5],['helium3',4,0.3],['terres_rares',3,0.05]],
  naine:[['silicates',6,0.9],['fer',5,0.8],['eau',3,0.5],['nickel',4,0.4],['uranium',3,0.15],['platine',4,0.03]],
  gazeuse:[['hydrogene',9,1],['helium3',6,0.9],['methane',5,0.6],['gaz_exo',4,0.35],['antimatiere',6,0.01]],
  geante_glace:[['helium3',8,1],['eau',6,0.9],['methane',7,0.85],['hydrogene',5,0.6],['cristaux_exo',5,0.03]]
};

// Calcule les ressources (densites) d'une planete a partir de son adresse.
// Doit consommer le RNG dans le MEME ordre que le client (rng(seed+7777)).
function resourcesOf(addr){
  const info = parseAddr(addr);
  if(!info) return null;
  const p = info.planet;
  const seedPlanet = info.system.seed*10 + info.pIdx;   // = p.seed cote client
  const prof = PROFILS[p.type] || [];
  const r = rng(seedPlanet + 7777);
  const out = [];
  for(const [key,base,prob] of prof){
    if(r() <= prob){
      let d = base + Math.round((r()+r()+r()-1.5)*2.4);
      d = Math.max(1, Math.min(10, d));
      out.push({ key, d, tier: RES_TIER[key] });
    }
  }
  return out;
}

// Production horaire d'une planete : { ressource: qte/heure }
function productionHoraire(addr){
  const res = resourcesOf(addr);
  if(!res) return {};
  const prod = {};
  for(const rr of res){
    const taux = RES_TAUX[rr.key] || 0;
    prod[rr.key] = +(rr.d * taux).toFixed(2);
  }
  return prod;
}

module.exports.RES_TAUX = RES_TAUX;
module.exports.resourcesOf = resourcesOf;
module.exports.productionHoraire = productionHoraire;

// ============================================================
//  BATIMENTS — definitions partagees client/serveur (v1.0)
//  Chaque batiment : cout de base, multiplicateur par niveau,
//  temps de construction, effets, prerequis, energie.
//  Cout au niveau N = coutBase * (mult ^ (N-1))
//  Temps au niveau N = tempsBase * (multTemps ^ (N-1))  [secondes]
// ============================================================
const BATIMENTS = {
  commandement: {
    nom: "Centre de commandement", branche: "central",
    coutBase: { fer: 100, silicates: 80 }, mult: 1.6,
    tempsBase: 60, multTemps: 1.8, energie: 0,
    prerequis: {}, max: 10,
    desc: "Cœur de la planète. Son niveau débloque les paliers supérieurs."
  },
  extracteur: {
    nom: "Extracteur", branche: "extraction",
    coutBase: { fer: 60, silicates: 40 }, mult: 1.5,
    tempsBase: 45, multTemps: 1.7, energie: 10,
    prerequis: {}, max: 15,
    effet: { type: "prod_brute", bonus: 0.15 }, // +15% prod communs par niveau
    desc: "Augmente la production des ressources de la planète."
  },
  raffinerie: {
    nom: "Raffinerie", branche: "extraction",
    coutBase: { fer: 200, cuivre: 100, silicates: 120 }, mult: 1.55,
    tempsBase: 180, multTemps: 1.75, energie: 25,
    prerequis: { extracteur: 3 }, max: 10,
    effet: { type: "prod_rare", bonus: 0.10 },
    desc: "Affine les ressources communes en métaux plus rares."
  },
  centrale: {
    nom: "Centrale énergétique", branche: "energie",
    coutBase: { fer: 80, cuivre: 40 }, mult: 1.5,
    tempsBase: 50, multTemps: 1.7, energie: 0,
    prerequis: {}, max: 15,
    effet: { type: "energie", bonus: 50 }, // +50 energie par niveau
    desc: "Produit l'énergie qui alimente les autres bâtiments."
  },
  collecteur: {
    nom: "Collecteur solaire", branche: "energie",
    coutBase: { silicates: 150, aluminium: 100, cuivre: 60 }, mult: 1.55,
    tempsBase: 150, multTemps: 1.75, energie: 0,
    prerequis: { centrale: 3 }, max: 12,
    effet: { type: "energie", bonus: 120 },
    desc: "Génère de grandes quantités d'énergie."
  },
  entrepot: {
    nom: "Entrepôt", branche: "stockage",
    coutBase: { fer: 50, silicates: 60 }, mult: 1.5,
    tempsBase: 40, multTemps: 1.65, energie: 5,
    prerequis: {}, max: 15,
    effet: { type: "capacite", bonus: 5000 }, // +5000 capacite par niveau
    desc: "Augmente la capacité de stockage des ressources."
  },
  caserne: {
    nom: "Caserne orbitale", branche: "militaire",
    coutBase: { fer: 300, titane: 80, cuivre: 100 }, mult: 1.6,
    tempsBase: 240, multTemps: 1.8, energie: 40,
    prerequis: { entrepot: 2 }, max: 10,
    effet: { type: "defense", bonus: 100 },
    desc: "Renforce la défense planétaire contre les attaques."
  },
  laboratoire: {
    nom: "Laboratoire", branche: "avance",
    coutBase: { silicates: 200, cuivre: 120, titane: 60 }, mult: 1.6,
    tempsBase: 300, multTemps: 1.8, energie: 50,
    prerequis: { extracteur: 5, centrale: 3 }, max: 10,
    effet: { type: "recherche", bonus: 1 },
    desc: "Débloque la recherche de technologies avancées."
  },
  chantier: {
    nom: "Chantier spatial", branche: "avance",
    coutBase: { fer: 400, titane: 150, aluminium: 100 }, mult: 1.65,
    tempsBase: 360, multTemps: 1.8, energie: 60,
    prerequis: { centrale: 3 }, max: 10,
    effet: { type: "vaisseaux", bonus: 1 },
    desc: "Permet de construire des vaisseaux (flottes à venir)."
  },
  arsenal: {
    nom: "Arsenal stellaire", branche: "avance",
    coutBase: { titane: 400, or: 50, cristaux: 100 }, mult: 1.7,
    tempsBase: 600, multTemps: 1.85, energie: 100,
    prerequis: { laboratoire: 1, chantier: 1, caserne: 1 }, max: 5,
    effet: { type: "flotte_guerre", bonus: 1 },
    desc: "Débloque les flottes de guerre les plus puissantes."
  }
};

// cout d'un batiment a un niveau donne (le niveau qu'on VEUT atteindre)
function coutBatiment(code, niveauVise) {
  const b = BATIMENTS[code];
  if (!b) return null;
  const f = Math.pow(b.mult, niveauVise - 1);
  const cout = {};
  for (const r in b.coutBase) cout[r] = Math.round(b.coutBase[r] * f);
  return cout;
}

// temps de construction en secondes pour atteindre un niveau
function tempsBatiment(code, niveauVise) {
  const b = BATIMENTS[code];
  if (!b) return null;
  return Math.round(b.tempsBase * Math.pow(b.multTemps, niveauVise - 1));
}

// verifie si les prerequis sont remplis (niveaux des autres batiments)
function prerequisOk(code, niveauxActuels) {
  const b = BATIMENTS[code];
  if (!b) return false;
  for (const req in b.prerequis) {
    if ((niveauxActuels[req] || 0) < b.prerequis[req]) return false;
  }
  return true;
}

module.exports.BATIMENTS = BATIMENTS;
module.exports.coutBatiment = coutBatiment;
module.exports.tempsBatiment = tempsBatiment;
module.exports.prerequisOk = prerequisOk;
