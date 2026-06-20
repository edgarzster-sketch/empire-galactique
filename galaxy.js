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
    nom: "Command Center", branche: "central",
    coutBase: { fer: 100, silicates: 80 }, mult: 1.6,
    tempsBase: 60, multTemps: 1.8, energie: 0,
    prerequis: {}, max: 10,
    desc: "Heart of the planet. Its level unlocks higher tiers."
  },
  extracteur: {
    nom: "Extractor", branche: "extraction",
    coutBase: { fer: 60, silicates: 40 }, mult: 1.5,
    tempsBase: 45, multTemps: 1.7, energie: 10,
    prerequis: {}, max: 15,
    effet: { type: "prod_brute", bonus: 0.15 }, // +15% prod communs par niveau
    desc: "Increases the planet's resource production."
  },
  raffinerie: {
    nom: "Refinery", branche: "extraction",
    coutBase: { fer: 200, cuivre: 100, silicates: 120 }, mult: 1.55,
    tempsBase: 180, multTemps: 1.75, energie: 25,
    prerequis: { extracteur: 3 }, max: 10,
    effet: { type: "prod_rare", bonus: 0.10 },
    desc: "Refines common resources into rarer metals."
  },
  centrale: {
    nom: "Power Plant", branche: "energie",
    coutBase: { fer: 80, cuivre: 40 }, mult: 1.5,
    tempsBase: 50, multTemps: 1.7, energie: 0,
    prerequis: {}, max: 15,
    effet: { type: "energie", bonus: 50 }, // +50 energie par niveau
    desc: "Produces energy that powers other buildings."
  },
  collecteur: {
    nom: "Solar Collector", branche: "energie",
    coutBase: { silicates: 150, aluminium: 100, cuivre: 60 }, mult: 1.55,
    tempsBase: 150, multTemps: 1.75, energie: 0,
    prerequis: { centrale: 3 }, max: 12,
    effet: { type: "energie", bonus: 120 },
    desc: "Generates large amounts of energy."
  },
  entrepot: {
    nom: "Warehouse", branche: "stockage",
    coutBase: { fer: 50, silicates: 60 }, mult: 1.5,
    tempsBase: 40, multTemps: 1.65, energie: 5,
    prerequis: {}, max: 15,
    effet: { type: "capacite", bonus: 5000 }, // +5000 capacite par niveau
    desc: "Increases resource storage capacity."
  },
  caserne: {
    nom: "Orbital Barracks", branche: "militaire",
    coutBase: { fer: 300, titane: 80, cuivre: 100 }, mult: 1.6,
    tempsBase: 240, multTemps: 1.8, energie: 40,
    prerequis: { entrepot: 2 }, max: 10,
    effet: { type: "defense", bonus: 100 },
    desc: "Strengthens planetary defense against attacks."
  },
  laboratoire: {
    nom: "Laboratory", branche: "avance",
    coutBase: { silicates: 200, cuivre: 120, titane: 60 }, mult: 1.6,
    tempsBase: 300, multTemps: 1.8, energie: 50,
    prerequis: { extracteur: 5, centrale: 3 }, max: 10,
    effet: { type: "recherche", bonus: 1 },
    desc: "Unlocks advanced technology research."
  },
  chantier: {
    nom: "Shipyard", branche: "avance",
    coutBase: { fer: 400, titane: 150, aluminium: 100 }, mult: 1.65,
    tempsBase: 360, multTemps: 1.8, energie: 60,
    prerequis: { centrale: 3 }, max: 10,
    effet: { type: "vaisseaux", bonus: 1 },
    desc: "Allows building ships (fleets coming soon)."
  },
  arsenal: {
    nom: "Stellar Arsenal", branche: "avance",
    coutBase: { titane: 400, or: 50, cristaux: 100 }, mult: 1.7,
    tempsBase: 600, multTemps: 1.85, energie: 100,
    prerequis: { laboratoire: 1, chantier: 1, caserne: 1 }, max: 5,
    effet: { type: "flotte_guerre", bonus: 1 },
    desc: "Unlocks the most powerful war fleets."
  },
  radar: {
    nom: "Detection Array", branche: "militaire",
    coutBase: { silicates: 250, cuivre: 150, cristaux: 40 }, mult: 1.55,
    tempsBase: 200, multTemps: 1.7, energie: 30,
    prerequis: { centrale: 2 }, max: 8,
    effet: { type: "detection", bonus: 1 },
    desc: "Detects incoming enemy fleets before they strike. Higher levels watch farther."
  }
};

// portee de detection d'une planete selon le niveau de son radar (0 = aucune)
function porteeDetection(nivRadar) {
  if (!nivRadar || nivRadar <= 0) return 0;
  // niveau 1 : detecte les attaques arrivant dans <2min ; +90s par niveau
  return 120 + (nivRadar - 1) * 90;
}

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
module.exports.porteeDetection = porteeDetection;
module.exports.coutBatiment = coutBatiment;
module.exports.tempsBatiment = tempsBatiment;
module.exports.prerequisOk = prerequisOk;

// ============================================================
//  BILAN ENERGETIQUE (v1.0)
//  Calcule production, consommation et rendement d'une planete
//  a partir des niveaux de ses batiments.
//  - centrale : +50 energie/niv ; collecteur : +120 energie/niv
//  - chaque autre batiment consomme BATIMENTS[code].energie * niveau
//  Si conso > prod : rendement = prod/conso (les batiments tournent au ralenti)
// ============================================================
function bilanEnergie(niveaux, bonusEnergie) {
  let production = 30, consommation = 0;  // +30 energie de base gratuite par planete
  for (const code in niveaux) {
    const niv = niveaux[code] || 0;
    if (niv <= 0) continue;
    const b = BATIMENTS[code];
    if (!b) continue;
    if (b.effet && b.effet.type === "energie") {
      production += b.effet.bonus * niv;
    } else if (b.energie) {
      consommation += b.energie * niv;
    }
  }
  // bonus recherche : reduit la consommation (Energy Efficiency)
  if (bonusEnergie && bonusEnergie < 1) consommation = consommation * bonusEnergie;
  // rendement : 1 si on a assez d'energie, sinon ratio (jamais < 0.1 pour eviter le blocage total)
  let rendement = 1;
  if (consommation > production && consommation > 0) {
    rendement = Math.max(0.1, production / consommation);
  }
  return { production, consommation, rendement };
}

module.exports.bilanEnergie = bilanEnergie;

// ============================================================
//  VAISSEAUX & FLOTTES (v1.0)
//  4 types : chasseur, croiseur, transport, colonisateur.
//  Stats : attaque, blindage (PV), vitesse (u/s pour le trajet),
//          capacite (transport de ressources), cout, temps, energie.
//  Construits au chantier spatial.
// ============================================================
const VAISSEAUX = {
  chasseur: {
    nom: "Fighter", attaque: 12, blindage: 40, vitesse: 1400, capacite: 0,
    cout: { fer: 80, aluminium: 40 }, temps: 30, energie: 2,
    desc: "Fast and cheap. Deadly in numbers."
  },
  croiseur: {
    nom: "Cruiser", attaque: 60, blindage: 280, vitesse: 800, capacite: 50,
    cout: { fer: 400, titane: 120, cuivre: 80 }, temps: 180, energie: 12,
    desc: "Heavy ship. Powerful and tough."
  },
  transport: {
    nom: "Transport", attaque: 2, blindage: 100, vitesse: 1000, capacite: 2000,
    cout: { fer: 200, aluminium: 150 }, temps: 90, energie: 5,
    desc: "Carries resources. Weak in combat."
  },
  colonisateur: {
    nom: "Colony Ship", attaque: 0, blindage: 150, vitesse: 700, capacite: 500,
    cout: { fer: 500, silicates: 300, titane: 100 }, temps: 300, energie: 15,
    desc: "Founds a colony on a free planet remotely."
  }
};

// cout total d'un lot de vaisseaux : {type: nombre}
function coutFlotte(composition) {
  const total = {};
  for (const type in composition) {
    const n = composition[type]; const v = VAISSEAUX[type];
    if (!v || n <= 0) continue;
    for (const r in v.cout) total[r] = (total[r] || 0) + v.cout[r] * n;
  }
  return total;
}

// temps de construction total (les vaisseaux se construisent en file)
function tempsFlotte(composition) {
  let t = 0;
  for (const type in composition) {
    const n = composition[type]; const v = VAISSEAUX[type];
    if (!v || n <= 0) continue;
    t += v.temps * n;
  }
  return t;
}

// puissance d'attaque et blindage total d'une flotte
function puissanceFlotte(composition) {
  let attaque = 0, blindage = 0;
  for (const type in composition) {
    const n = composition[type] || 0; const v = VAISSEAUX[type];
    if (!v) continue;
    attaque += v.attaque * n; blindage += v.blindage * n;
  }
  return { attaque, blindage };
}

// vitesse d'une flotte = celle du vaisseau le plus lent
function vitesseFlotte(composition) {
  let vmin = Infinity;
  for (const type in composition) {
    if ((composition[type] || 0) <= 0) continue;
    const v = VAISSEAUX[type]; if (v) vmin = Math.min(vmin, v.vitesse);
  }
  return vmin === Infinity ? 1000 : vmin;
}

module.exports.VAISSEAUX = VAISSEAUX;
module.exports.coutFlotte = coutFlotte;
module.exports.tempsFlotte = tempsFlotte;
module.exports.puissanceFlotte = puissanceFlotte;
module.exports.vitesseFlotte = vitesseFlotte;

// ============================================================
//  RESOLUTION DE COMBAT (v1.0)
//  Combat automatique avec pertes des deux cotes.
//  Principe : plusieurs rounds. A chaque round, chaque camp
//  inflige son attaque totale au blindage adverse. Les pertes
//  sont reparties sur les vaisseaux (les plus fragiles tombent
//  en premier). Le combat s'arrete quand un camp est aneanti
//  ou apres 8 rounds (le camp le plus fort l'emporte).
//  defenseBonus : points d'attaque/blindage ajoutes au defenseur
//  (vient de la caserne orbitale).
// ============================================================
function resoudreCombat(attaquant, defenseur, defenseBonus, bonus) {
  // copies de travail {type: nombre}
  const A = Object.assign({}, attaquant);
  const D = Object.assign({}, defenseur);
  defenseBonus = defenseBonus || 0;
  // bonus techno : { attA, armA, attD, armD } multiplicateurs (1 = neutre)
  bonus = bonus || {};
  const attA = bonus.attA || 1, armA = bonus.armA || 1;
  const attD = bonus.attD || 1, armD = bonus.armD || 1;

  // PV "courants" stockes globalement par camp, repartis a la fin en pertes entieres
  function totalBlindage(camp, bonusPlat, multArm) {
    let b = bonusPlat || 0;
    for (const t in camp) b += (VAISSEAUX[t] ? VAISSEAUX[t].blindage : 0) * (camp[t] || 0) * (multArm || 1);
    return b;
  }
  function totalAttaque(camp, bonusPlat, multAtt) {
    let a = bonusPlat || 0;
    for (const t in camp) a += (VAISSEAUX[t] ? VAISSEAUX[t].attaque : 0) * (camp[t] || 0) * (multAtt || 1);
    return a;
  }
  // applique des degats a un camp : detruit des vaisseaux (plus fragiles d'abord)
  function appliquerPertes(camp, degats) {
    const ordre = Object.keys(camp).sort((x, y) =>
      (VAISSEAUX[x] ? VAISSEAUX[x].blindage : 0) - (VAISSEAUX[y] ? VAISSEAUX[y].blindage : 0));
    for (const t of ordre) {
      if (degats <= 0) break;
      const pv = VAISSEAUX[t] ? VAISSEAUX[t].blindage : 1;
      while (camp[t] > 0 && degats >= pv) { camp[t]--; degats -= pv; }
    }
    return degats;
  }

  let rounds = 0;
  while (rounds < 8) {
    const aAtt = totalAttaque(A, 0, attA);
    const dAtt = totalAttaque(D, defenseBonus, attD);
    const aBli = totalBlindage(A, 0, armA);
    const dBli = totalBlindage(D, defenseBonus, armD);
    if (aBli <= 0 || dBli <= 0) break;
    if (aAtt <= 0 && dAtt <= 0) break;
    // les deux frappent simultanement
    appliquerPertes(A, dAtt);
    appliquerPertes(D, aAtt);
    rounds++;
    // arret si un camp est vide
    const aReste = Object.values(A).reduce((s, n) => s + n, 0);
    const dReste = Object.values(D).reduce((s, n) => s + n, 0);
    if (aReste <= 0 || dReste <= 0) break;
  }

  const aReste = Object.values(A).reduce((s, n) => s + n, 0);
  const dReste = Object.values(D).reduce((s, n) => s + n, 0);
  let vainqueur;
  if (aReste > 0 && dReste <= 0) vainqueur = "attaquant";
  else if (dReste > 0 && aReste <= 0) vainqueur = "defenseur";
  else {
    // les deux survivent (8 rounds) : le plus de blindage restant gagne
    vainqueur = totalBlindage(A, 0, armA) >= totalBlindage(D, defenseBonus, armD) ? "attaquant" : "defenseur";
  }
  return { vainqueur, attaquantRestant: A, defenseurRestant: D, rounds };
}

module.exports.resoudreCombat = resoudreCombat;

// ============================================================
//  TRAJETS DE FLOTTES (v1.0)
//  Calcule la distance entre deux systemes et la duree du voyage.
//  Vitesse intermediaire : trajets de quelques minutes a ~12 min.
// ============================================================
// coordonnees x,y d'un systeme par son index
function coordSysteme(sysIdx) {
  const sys = genAllSystems()[sysIdx];
  return sys ? { x: sys.x, y: sys.y } : null;
}

// distance euclidienne entre deux systemes (par index)
function distanceSystemes(idxA, idxB) {
  const a = coordSysteme(idxA), b = coordSysteme(idxB);
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// duree d'un trajet en secondes, selon distance et vitesse de la flotte.
// vitesseFlotte est en "unites/heure-jeu" ; on calibre pour un rythme
// intermediaire : ~2 min pour des systemes proches, ~12 min pour tres loin.
function dureeTrajet(idxA, idxB, vitesseFlotte) {
  const d = distanceSystemes(idxA, idxB);
  if (d === null) return null;
  // base : 90s incompressibles (preparation/decollage) + distance/vitesse
  // facteur calibre : GALAXY_R=140000, vitesse typique 800-1400
  const v = vitesseFlotte || 1000;
  const secondes = 90 + (d / v) * 4.5;
  return Math.round(Math.min(secondes, 1500)); // plafond 25 min
}

module.exports.coordSysteme = coordSysteme;
module.exports.distanceSystemes = distanceSystemes;
module.exports.dureeTrajet = dureeTrajet;

// ============================================================
//  ARBRE DE RECHERCHE (v1.0)
//  Le Laboratoire produit des "points de recherche" (PR) par heure.
//  On depense ces PR pour debloquer des technologies a effets
//  permanents sur tout l'empire. Chaque techno a plusieurs niveaux,
//  un cout croissant, et parfois des prerequis (autres technos).
//  3 familles : economie, militaire, expansion.
// ============================================================

// production de points de recherche par heure selon le niveau du labo
function pointsRechercheHoraire(nivLabo) {
  if (!nivLabo || nivLabo <= 0) return 0;
  // labo niv 1 : 20 PR/h ; croissance pour recompenser les hauts niveaux
  return Math.round(20 * Math.pow(1.6, nivLabo - 1));
}

// definitions des technologies
// cle : { nom, famille, max, coutBase, mult, effet{type,parNiveau}, prerequis{tech:niv}, desc }
const TECHNOLOGIES = {
  // === ECONOMIE ===
  production: {
    nom: "Resource Extraction", famille: "economie", max: 20,
    coutBase: 100, mult: 1.5,
    effet: { type: "production", parNiveau: 0.05 }, // +5% production / niveau
    prerequis: {}, desc: "+5% resource production per level, empire-wide."
  },
  stockage: {
    nom: "Storage Logistics", famille: "economie", max: 15,
    coutBase: 80, mult: 1.45,
    effet: { type: "stockage", parNiveau: 0.10 }, // +10% capacite / niveau
    prerequis: {}, desc: "+10% storage capacity per level."
  },
  energie: {
    nom: "Energy Efficiency", famille: "economie", max: 12,
    coutBase: 150, mult: 1.5,
    effet: { type: "energie", parNiveau: 0.04 }, // -4% conso energie / niveau
    prerequis: { production: 3 }, desc: "-4% energy consumption per level."
  },
  raffinage: {
    nom: "Advanced Refining", famille: "economie", max: 10,
    coutBase: 300, mult: 1.55,
    effet: { type: "raffinage", parNiveau: 0.06 }, // +6% metaux rares / niveau
    prerequis: { production: 5 }, desc: "+6% rare-metal output per level."
  },
  // === MILITAIRE ===
  armement: {
    nom: "Weapon Systems", famille: "militaire", max: 20,
    coutBase: 120, mult: 1.5,
    effet: { type: "attaque", parNiveau: 0.05 }, // +5% attaque vaisseaux / niveau
    prerequis: {}, desc: "+5% ship attack per level."
  },
  blindage: {
    nom: "Hull Plating", famille: "militaire", max: 20,
    coutBase: 120, mult: 1.5,
    effet: { type: "blindage", parNiveau: 0.05 }, // +5% blindage vaisseaux / niveau
    prerequis: {}, desc: "+5% ship armor per level."
  },
  propulsion: {
    nom: "Propulsion", famille: "militaire", max: 15,
    coutBase: 100, mult: 1.5,
    effet: { type: "vitesse", parNiveau: 0.06 }, // +6% vitesse flotte / niveau
    prerequis: {}, desc: "+6% fleet speed per level."
  },
  detection: {
    nom: "Sensor Arrays", famille: "militaire", max: 10,
    coutBase: 200, mult: 1.5,
    effet: { type: "detection", parNiveau: 0.15 }, // +15% portee radar / niveau
    prerequis: { armement: 3 }, desc: "+15% radar detection range per level."
  },
  // === EXPANSION ===
  colonisation: {
    nom: "Colonization Tech", famille: "expansion", max: 10,
    coutBase: 150, mult: 1.5,
    effet: { type: "cout_colon", parNiveau: 0.05 }, // -5% cout colonisateur / niveau
    prerequis: {}, desc: "-5% colony ship cost per level."
  },
  navigation: {
    nom: "Hyperspace Navigation", famille: "expansion", max: 12,
    coutBase: 180, mult: 1.5,
    effet: { type: "trajet", parNiveau: 0.04 }, // -4% duree trajet / niveau
    prerequis: { propulsion: 2 }, desc: "-4% travel time per level."
  },
  construction: {
    nom: "Construction Methods", famille: "expansion", max: 12,
    coutBase: 160, mult: 1.5,
    effet: { type: "temps_construction", parNiveau: 0.04 }, // -4% temps construction / niveau
    prerequis: {}, desc: "-4% building construction time per level."
  }
};

// cout en PR d'une techno pour atteindre un niveau donne
function coutTechno(code, niveauVise) {
  const t = TECHNOLOGIES[code];
  if (!t) return null;
  return Math.round(t.coutBase * Math.pow(t.mult, niveauVise - 1));
}

// les prerequis d'une techno sont-ils remplis ? (techsActuelles = {code: niveau})
function prerequisTechnoOk(code, techsActuelles) {
  const t = TECHNOLOGIES[code];
  if (!t || !t.prerequis) return true;
  for (const req in t.prerequis) {
    if ((techsActuelles[req] || 0) < t.prerequis[req]) return false;
  }
  return true;
}

// calcule les bonus cumules d'un ensemble de technos -> multiplicateurs
// retourne un objet avec tous les bonus applicables
function bonusTechnos(techs) {
  const b = {
    production: 1, stockage: 1, energie: 1, raffinage: 1,
    attaque: 1, blindage: 1, vitesse: 1, detection: 1,
    cout_colon: 1, trajet: 1, temps_construction: 1
  };
  for (const code in techs) {
    const niv = techs[code]; const t = TECHNOLOGIES[code];
    if (!t || niv <= 0) continue;
    const e = t.effet; const total = e.parNiveau * niv;
    // bonus positifs (augmentent) vs reductions (diminuent)
    if (["production","stockage","raffinage","attaque","blindage","vitesse","detection"].includes(e.type)) {
      b[e.type] += total;
    } else {
      // energie, cout_colon, trajet, temps_construction : reductions
      b[e.type] -= total;
      if (b[e.type] < 0.2) b[e.type] = 0.2; // plancher : jamais en dessous de 20%
    }
  }
  return b;
}

module.exports.pointsRechercheHoraire = pointsRechercheHoraire;
module.exports.TECHNOLOGIES = TECHNOLOGIES;
module.exports.coutTechno = coutTechno;
module.exports.prerequisTechnoOk = prerequisTechnoOk;
module.exports.bonusTechnos = bonusTechnos;
