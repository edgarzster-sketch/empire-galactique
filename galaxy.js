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
