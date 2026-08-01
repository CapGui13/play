// bidding-engine.js — Moteur de décision des robots (Table d'enchères), extrait d'app.js
// pour être testable en dehors du navigateur (voir échange avec Guillaume — outil de
// simulation à grande échelle). Aucune dépendance au DOM, comme bidding-rules.js — mêmes
// règles de style (aucun accès à document/window/localStorage/peerConn/etc. ici, jamais).
//
// Chargé par index.html AVANT app.js (comme bidding-rules.js), donc utilisable tel quel
// par app.js sans le moindre changement à ses points d'appel — les fonctions restent de
// simples fonctions globales, exactement comme avant leur déplacement ici.

const HCP_VALUE = { A: 4, K: 3, Q: 2, J: 1 };

// Compte de points d'honneur (High Card Points) d'une main : As=4, Roi=3, Dame=2, Valet=1.
function computeHandHcp(hand) {
    let total = 0;
    ['S', 'H', 'D', 'C'].forEach(suit => {
        const ranks = hand[suit] || '';
        for (const c of ranks) total += HCP_VALUE[c] || 0;
    });
    return total;
}

// ===== Moteur d'enchères basique des robots (voir échange avec Guillaume) =====
//
// Volontairement limité, pour rester robuste et lisible plutôt que de viser un vrai
// moteur d'enchères (hors de portée raisonnable ici — même les logiciels commerciaux s'y
// cassent régulièrement les dents). Seuils repris de la fiche "Ouvertures" du SEF
// (Système d'Enchères Français, la référence utilisée en club — voir
// bridge-chailley.fr/dictionnaire-des-encheres/), pas d'une généralisation approximative :
//   - Comptage en points H+L (honneurs + longueur, voir computeHandHL) pour la plupart des
//     décisions, à l'exception explicite d'1SA (compté en H purs, comme le veut le SEF).
//   - Ouvertures : 1SA (15-17H équilibrée), 2SA (20-21HL équilibrée), barrages faibles
//     (8-12HL : 2 à une majeure 6ème, 3 à 7 cartes, 4 à 8 cartes), sinon la couleur la
//     plus longue à partir de 12HL (système "majeure 5ème, meilleure mineure").
//   - Réponse à l'ouverture du PARTENAIRE : majeure 4+ montrée avant de soutenir une
//     mineure, sinon soutien si fit (palier 2 ou 3 selon les points), sinon nouvelle
//     couleur à partir de 11HL, sinon repli à SA — avec repérage simple d'un fit majeur
//     après 1SA/2SA (manche directe à la majeure plutôt qu'à SA si 5+ cartes franches).
//   - Intervention sur l'ouverture d'un ADVERSAIRE : contre d'appel (takeout) si la main
//     s'y prête (12HL+, courte dans leur couleur, support ailleurs), sinon une couleur
//     naturelle (5+ cartes, HL ajusté par vulnérabilité) au palier minimal légal — et
//     réponse quasi obligatoire au contre du PARTENAIRE, dans la meilleure des 3 couleurs
//     restantes.
//   - Un seul tour de dialogue : dès qu'un robot a parlé une fois dans une donne, il passe
//     systématiquement ensuite (pas de rebid, pas de contre-annonce après une nouvelle
//     enchère adverse) — y compris pour une main exceptionnellement forte : une fois
//     "passée" (3 passes consécutifs), l'enchère est terminée dans n'importe quelle partie
//     de bridge, ce n'est pas une limitation propre à ce moteur (voir decideRobotCall).
//   - Contre d'appel (takeout) seulement — jamais de surcontre, jamais de contre de
//     pénalité, jamais de convention (Stayman, Blackwood,
//     Roudi, Texas...), pas de 2♣ fort indéterminé ni de 2♦ forcing de manche.
// Le tout est un COMPLÉMENT au tirage au sort des donnes, pas un simulateur d'enchère
// réaliste : l'objectif est que les robots ne soient plus totalement muets, pas de
// remplacer un vrai partenaire de bridge.

// Vrai s'il n'y a ni singleton ni chicane, et au plus un doubleton (4333, 4432, 5332) —
// définition standard d'une main "équilibrée" pour une ouverture à SA.
function isHandBalancedForNT(lengths) {
    const values = ['S', 'H', 'D', 'C'].map(s => lengths[s]);
    if (values.some(l => l <= 1)) return false;
    return values.filter(l => l === 2).length <= 1;
}

// Couleur la plus longue, en départageant les égalités par le rang (Pique > Cœur >
// Carreau > Trèfle) — simplification assumée plutôt qu'une vraie règle de choix entre
// mineures 4-4 par exemple.
function longestSuitPreferHigh(lengths) {
    const order = ['S', 'H', 'D', 'C'];
    let best = order[0];
    for (const suit of order.slice(1)) {
        if (lengths[suit] > lengths[best]) best = suit;
    }
    return best;
}

function suitLengths(hand) {
    return { S: hand.S.length, H: hand.H.length, D: hand.D.length, C: hand.C.length };
}

// Vrai si `seat` est vulnérable sur cette donne — utilisé pour ajuster l'agressivité des
// barrages et interventions (voir échange avec Guillaume) : le SEF réel les resserre
// vulnérable (le risque d'un gros nombre de plis de chute contré coûte plus cher) et les
// desserre non-vulnérable.
function isSeatVulnerable(seat, dealVulnerable) {
    if (dealVulnerable === 'Both') return true;
    if (dealVulnerable === 'None') return false;
    return partnershipOf(seat) === dealVulnerable; // 'NS' ou 'EW'
}

// Points d'honneur (H) + points de longueur (L) : +1 par carte au-delà de la 4e dans
// chaque couleur de 5+ cartes (5 cartes = +1, 6 cartes = +2, etc.) — barème SEF utilisé
// pour la plupart des décisions (à l'exception notable d'1SA, qui se compte en H purs :
// voir decideRobotOpening). Source : fiche "Ouvertures" du SEF, bridge-chailley.fr (voir
// échange avec Guillaume).
// ===== Zones de manche et de chelem (voir échange avec Guillaume, session du 24
// juillet) =====
//
// Avant cette session, chaque fonction qui devait juger "sommes-nous en zone de manche/
// chelem ?" refaisait son propre petit calcul ad hoc (hl+12>=33 ici, hl>=22 là, une
// troisième variante ailleurs) — ni les mêmes seuils partout, ni la même logique
// HL/HLD. Centralisé ici : toute nouvelle décision de zone doit passer par ces
// constantes plutôt que d'en inventer une nouvelle.
//
// RÈGLE HL vs HLD (voir aussi le commentaire de computeSupportPoints juste en dessous) :
// une main s'évalue TOUJOURS en HL (computeHandHL — H + points de longueur dans SA
// PROPRE main) tant qu'aucun fit n'est trouvé avec le partenaire. Dès qu'un fit est
// CONFIRMÉ (soutien direct, ou couleur du partenaire connue avec une longueur garantie —
// majeure 5ème, intervention 5+, etc.), on bascule sur HLD (computeSupportPoints — H +
// DISTRIBUTION selon ce fit précis : bonus du 9ème atout + valeur des courtes ailleurs)
// à la place des points de longueur — jamais les deux à la fois sur la même main, "HLD"
// au sens SEF ne les additionne pas.
//
// Zones, à l'échelle du CAMP (ma main + le minimum garanti par le partenaire, voir
// OPENING_MINIMUM plus bas) :
const GAME_ZONE_NT = 25;      // manche à SA (3SA)
const GAME_ZONE_MAJOR = 27;   // manche à la majeure (4C/4P), en HLD une fois le fit connu
const GAME_ZONE_MINOR = 30;   // manche à la mineure (5T/5K), en HLD une fois le fit connu
const SLAM_ZONE_SMALL = 33;   // petit chelem
const SLAM_ZONE_GRAND = 37;   // grand chelem

// Minimum garanti par une ouverture normale au palier 1 (voir decideRobotOpening) —
// utilisé partout où il faut estimer le minimum du partenaire sans le connaître
// précisément (avant qu'il n'ait eu l'occasion de préciser sa main davantage).
const OPENING_MINIMUM = 12;

// Voir échange avec Guillaume (session du 24 juillet — régression trouvée à l'audit) :
// minimum promis par un simple SOUTIEN (pas une ouverture) — bien plus bas. Utilisé
// spécifiquement quand le "partenaire" dont on estime le plancher est un RÉPONDANT qui a
// juste soutenu, pas un OUVREUR (OPENING_MINIMUM ne s'applique qu'à ce dernier cas —
// les confondre faisait sauter au chelem à tort avec une simple main d'ouverture forte
// face à un soutien qui ne promet presque rien).
const SIMPLE_RAISE_MINIMUM = 6;

function computeHandHL(hand) {
    const lengths = suitLengths(hand);
    let lengthPoints = 0;
    for (const suit of ['S', 'H', 'D', 'C']) {
        if (lengths[suit] >= 5) lengthPoints += lengths[suit] - 4;
    }
    return computeHandHcp(hand) + lengthPoints;
}

// Compte de PERDANTES (méthode standard "Losing Trick Count") — voir échange avec
// Guillaume (session du 30 juillet, ouvertures fortes) : jamais implémenté jusqu'ici. Ne
// regarde que les 3 premières cartes de chaque couleur (une 4ème+ carte ne compte jamais,
// même faible) : chacune qui n'est ni As, ni Roi, ni Dame est une perdante. Une chicane
// (0 carte) donne 0 perdante dans cette couleur ; un singleton As ou un doubleton AR en
// donnent 0 aussi. Version volontairement simple (pas de demi-perdantes façon NLTC) —
// suffisante pour juger une ouverture forte, pas pour un jeu de la carte fin.
function computeLoserCount(hand) {
    let losers = 0;
    ['S', 'H', 'D', 'C'].forEach(suit => {
        const ranks = hand[suit] || '';
        const relevantLen = Math.min(ranks.length, 3);
        for (let i = 0; i < relevantLen; i++) {
            if (!'AKQ'.includes(ranks[i])) losers++;
        }
    });
    return losers;
}

// Points de "soutien" (voir échange avec Guillaume, donne 2 — la terminologie "HLD" du
// SEF signifie H + Longueur OU Distribution selon le contexte, pas les deux à la fois sur
// la même main) : quand on soutient une couleur du partenaire dont la longueur est
// GARANTIE (5+ pour une majeure ou une intervention, 3+ par défaut pour une ouverture à
// la mineure), on ne compte plus les points de longueur de SA propre main (comme HL) mais
// les points de DISTRIBUTION — la valeur des courtes ailleurs, maintenant qu'on joue avec
// l'atout du partenaire, plus les siennes propres. Deux composantes :
//   - +2 si la longueur connue au total (la mienne dans cette couleur + le minimum promis
//     par le partenaire) atteint 9 — le "9ème atout" du camp, une sécurité
//     supplémentaire qui vaut la peine d'être comptée ;
//   - la valeur habituelle des courtes dans les AUTRES couleurs (chicane +5, singleton
//     +3, doubleton +1 — même barème que les points de longueur, mais appliqué à la
//     distribution plutôt qu'à la longueur).
function computeSupportPoints(hand, fitSuit, partnerGuaranteedLength) {
    const lengths = suitLengths(hand);
    let points = computeHandHcp(hand);

    if (lengths[fitSuit] + partnerGuaranteedLength >= 9) points += 2;

    for (const suit of ['S', 'H', 'D', 'C']) {
        if (suit === fitSuit) continue;
        const len = lengths[suit];
        if (len === 0) points += 5;
        else if (len === 1) points += 3;
        else if (len === 2) points += 1;
    }

    return points;
}

// Choix de la couleur d'ouverture à la couleur (donc hors 1SA/2SA/barrages, déjà écartés
// par decideRobotOpening avant d'en arriver là) : toujours la majeure 5+ la plus longue si
// elle est au moins aussi longue que la meilleure mineure (le système "majeure 5ème"
// n'autorise jamais l'ouverture d'une majeure à 4 cartes, quoi qu'il arrive) ; sinon la
// mineure la plus longue — sauf l'exception SEF explicite du 3-3 aux mineures (sans
// majeure 5e), qui ouvre systématiquement du ♣ plutôt que du ♦ malgré l'égalité.
function decideOpeningSuit(lengths) {
    const majorLen = Math.max(lengths.S >= 5 ? lengths.S : 0, lengths.H >= 5 ? lengths.H : 0);
    const minorLen = Math.max(lengths.D, lengths.C);
    if (majorLen > 0 && majorLen >= minorLen) {
        return (lengths.S >= 5 && lengths.S >= lengths.H) ? 'S' : 'H';
    }
    if (lengths.D === 3 && lengths.C === 3) return 'C'; // exception SEF
    return lengths.D >= lengths.C ? 'D' : 'C';
}

// Décision d'OUVERTURE (personne n'a encore annoncé quoi que ce soit dans cette donne).
// Seuils repris de la fiche "Ouvertures" du SEF (voir échange avec Guillaume).
function decideRobotOpening(hand, hcp, hl, dealVulnerable, seat) {
    const lengths = suitLengths(hand);
    const balanced = isHandBalancedForNT(lengths);
    const losers = computeLoserCount(hand);

    // 1SA : exception SEF explicite, on compte ici en H purs, pas en HL.
    if (hcp >= 15 && hcp <= 17 && balanced) return '1NT';
    // 2SA : 20-21HL, main régulière (ni 5 cartes à une majeure, sauf couleur "laide" —
    // nuance non reprise ici par simplicité).
    if (hl >= 20 && hl <= 21 && balanced) return '2NT';

    // 2♦ FORCING DE MANCHE (voir échange avec Guillaume, session du 30 juillet — CRM
    // moderne, précisé après une session de test catastrophique) : main régulière
    // 24HL+, OU main de 4 perdantes avec un VRAI unicolore (6+ cartes). Le compte de
    // perdantes n'a de sens QUE sur un vrai unicolore — sur une main semi-régulière (ex.
    // 5422), il peut donner un chiffre trompeusement bas sans que la main soit
    // réellement assez forte (donne 3 : 17H/18HL comptait à tort 5 perdantes, "pas de
    // vrai unicolore"). Même avec un vrai unicolore, le compte seul peut encore
    // sous-estimer une main trop faible (donne 5 : 10H avec un bon 6ème à Cœur comptait
    // aussi 5 perdantes) — un plancher de points reste nécessaire, le compte de
    // perdantes n'affinant qu'à la marge, jamais à la place des points.
    const hasGenuineSuit = ['S', 'H', 'D', 'C'].some(s => lengths[s] >= 6);
    if ((hl >= 24 && balanced) || (hasGenuineSuit && losers <= 4 && hcp >= 18)) return '2D';

    // 2♣ fort artificiel (forcing) : main régulière 22-23HL (voir échange avec Guillaume,
    // donne 4), OU main de 5 perdantes avec un vrai unicolore ET un plancher de points
    // (même garde-fou que ci-dessus) — un "super 2SA" annoncé en deux temps (2♣ puis 2SA
    // au rebid si régulière, ou sa couleur si un unicolore, voir decideRobotOpenerRebid)
    // plutôt qu'un 2SA direct qui plafonnerait à tort la main à 20-21.
    if ((hl >= 22 && hl <= 23 && balanced) || (hasGenuineSuit && losers === 5 && hcp >= 15)) return '2C';

    // Barrages faibles (système "majeure 5ème") : 6 cartes à une majeure au palier 2
    // ("2 faible"), 7 cartes au palier 3, 8 cartes au palier 4 — toujours la couleur la
    // plus longue. Plage resserrée vulnérable (10-12HL, un barrage foireux coûte plus
    // cher contré) que non-vulnérable (8-12HL, plus agressif — voir échange avec
    // Guillaume).
    const barrageFloor = isSeatVulnerable(seat, dealVulnerable) ? 10 : 8;
    if (hl >= barrageFloor && hl <= 12) {
        const longest = longestSuitPreferHigh(lengths);
        const len = lengths[longest];
        const isMajor = (longest === 'S' || longest === 'H');
        if (isMajor && len === 6) return '2' + longest;
        if (len === 7) return '3' + longest;
        if (len === 8) return '4' + longest;
    }

    if (hl < 12) return 'PASS';

    const suit = decideOpeningSuit(lengths);
    return '1' + suit;
}

// Échelle des SOUTIENS DIRECTS à une majeure (voir échange avec Guillaume, document
// "L'expression des soutiens majeurs" — Christian Maury, FFB) : bien plus précise que le
// simple soutien à 2 paliers qu'on avait — distingue la longueur EXACTE du fit et la
// distribution (courte repérable) plutôt que juste les points. Ne s'applique QUE si
// `suit` est une majeure (S ou H) — pour une mineure, la logique plus simple plus bas
// s'applique (voir decideRobotResponse). Renvoie null si aucun palier ne correspond
// (main sans fit, ou fit mais hors de toutes les fourchettes ci-dessous), laissant la
// suite de decideRobotResponse gérer (nouvelle couleur, repli SA...).
//
// N'implémente PAS les "vrais" soutiens différés du document (fit montré à un DEUXIÈME
// tour d'enchères) : ceux-là supposent un rebid de l'ouvreur puis un second tour du
// répondant, hors de portée de ce filet — voir decideRobotOpenerRebid pour le rebid de
// l'ouvreur, qui lui existe, mais seulement pour les mains très fortes (18HL+).
function decideRobotMajorSupport(hand, hcp, hl, bid, seat, history) {
    const lengths = suitLengths(hand);
    const suit = bid.strain;
    const fitLen = lengths[suit];
    if (fitLen < 3) return null; // pas de fit du tout, rien à faire ici

    const otherSuits = ['S', 'H', 'D', 'C'].filter(s => s !== suit);
    const shortSuit = otherSuits.find(s => lengths[s] <= 1); // singleton ou chicane
    const hasNoSingleton = otherSuits.every(s => lengths[s] >= 2);

    // Points de "soutien" (voir échange avec Guillaume, donne 2 et computeSupportPoints) :
    // le "HLD" du document source ("L'expression des soutiens majeurs") signifie H +
    // longueur OU distribution selon le contexte — ici on soutient une couleur du
    // partenaire toujours connue 5+ (majeure, système "majeure 5ème") — donc on compte
    // les points de DISTRIBUTION (courtes ailleurs + 9ème atout), pas la longueur de sa
    // propre main.
    const supportPoints = computeSupportPoints(hand, suit, 5);

    // Barrage (5+ atouts, une courte ailleurs, main faible en H — la distribution prime
    // sur les points, "loi des levées totales") : indépendant du seuil habituel de 6H/6HL
    // pour répondre, un vrai barrage peut se faire avec très peu de points d'honneurs.
    if (fitLen >= 5 && shortSuit && hcp < 10) {
        const call = (bid.level + 3) + suit; // saut direct à la manche (ex. 1H -> 4H)
        if (isCallLegal(history, call, seat)) return call;
    }

    // 13-15 HLD avec une courte et 4+ atouts : splinter — saut double (2 paliers au-delà
    // du minimum naturel) dans la couleur courte, jamais celle d'atout ni SA.
    if (supportPoints >= 13 && supportPoints <= 15 && fitLen >= 4 && shortSuit) {
        let naturalLevel = null;
        for (let level = 1; level <= 7; level++) {
            if (isCallLegal(history, level + shortSuit, seat)) { naturalLevel = level; break; }
        }
        if (naturalLevel !== null) {
            const splinterLevel = naturalLevel + 2;
            const call = splinterLevel + shortSuit;
            if (splinterLevel <= 7 && isCallLegal(history, call, seat)) return call;
        }
    }

    // 13-15 HLD sans aucun singleton : 3SA fitté (conventionnel — annonce le fit et cette
    // fourchette de points, pas une vraie proposition de jouer à SA).
    if (supportPoints >= 13 && supportPoints <= 15 && hasNoSingleton) {
        const call = '3NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    // 16+ HLD (soutien) : voir échange avec Guillaume, donne 7 — main TROP forte pour un
    // soutien direct (qui promet au plus 15HLD ci-dessus). Erreur corrigée : sauter
    // directement à la manche ne montre PAS une main forte, mais l'inverse (barrage, voir
    // plus haut — main faible et distribuée avec 5+ atouts). Il faut donc DIFFÉRER : une
    // nouvelle couleur (la plus longue des 3 autres, 4+ cartes si possible, sinon la plus
    // courte comme relais faute de mieux) force l'ouvreur à reparler (voir
    // decideOpenerRebidAfterNewSuit), et le fit sera montré au tour suivant, une fois la
    // vraie force connue (voir decideResponderContinuationAfterNewSuit, déclenché depuis
    // decideRobotCall dès que hcp>=12 y compris dans ce cas).
    if (supportPoints >= 16 && fitLen >= 3) {
        const otherSuits = ['S', 'H', 'D', 'C'].filter(s => s !== suit);
        let delaySuit = null;
        for (const s of otherSuits) {
            if (lengths[s] >= 4 && (!delaySuit || lengths[s] > lengths[delaySuit])) delaySuit = s;
        }
        if (!delaySuit) {
            delaySuit = otherSuits.reduce((shortest, s) => (lengths[s] < lengths[shortest] ? s : shortest), otherSuits[0]);
        }
        for (let level = bid.level; level <= 7; level++) {
            const call = level + delaySuit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // 10-12 HLD avec fit 4+ cartes : soutien au palier 3, non-forcing (proposition de
    // manche — voir échange avec Guillaume, donne 11, session du 31 juillet : "1M-P-3M...
    // 4 atouts et 10-12HLD, propose de jouer 4M si l'ouvreur n'est pas minimal" — borne
    // basse corrigée de 11 à 10).
    if (supportPoints >= 10 && supportPoints <= 12 && fitLen >= 4) {
        const call = (bid.level + 2) + suit;
        if (isCallLegal(history, call, seat)) return call;
    }

    // 10-11 HLD avec fit EXACTEMENT 3 cartes : 2SA conventionnel (ne promet pas une main
    // régulière, juste ce fit précis et cette fourchette de points — voir échange avec
    // Guillaume, donne 12, session du 31 juillet : "2SA fitté = 10.5-11HLD" — borne haute
    // abaissée de 12 à 11. À 12 (= OPENING_MINIMUM), le répondant a une main d'ouverture
    // à lui seul ; "ouverture sur ouverture = manche" étant constant, s'engager dans une
    // convention qui décrit une main LIMITÉE avec seulement 3 cartes de fit est illogique
    // — mieux vaut alors une nouvelle couleur naturelle (2/1), qui garde l'enchère
    // forcing de manche sans committer trop tôt sur ce fit marginal. Le splinter et le
    // 3SA fitté (fit 4+ cartes) restent, eux, zonés 13-15 sans changement — ils décrivent
    // déjà une main forte/distribuée, pas une main limitée comme celle-ci.
    if (supportPoints >= 10 && supportPoints <= 11 && fitLen === 3) {
        const call = '2NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    // Voir échange avec Guillaume (session du 25 juillet, donne 5) : avec PILE 6 points
    // de soutien (le strict minimum du soutien simple, 6-10) sur une ouverture au palier
    // 1, "1SA" d'abord plutôt qu'un soutien direct — pour ne pas laisser l'ouvreur
    // s'emballer sur une main forte face à ce qui ressemblerait à un soutien "normal"
    // alors que c'est le minimum absolu. Le fit se montrera plus tard si la séquence
    // continue. Seulement à EXACTEMENT 6 (pas 6-10) : au-delà, le soutien simple direct
    // reste la meilleure description.
    if (supportPoints === 6 && bid.level === 1 && fitLen >= 3) {
        const call = '1NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    // 6-10 HLD, fit de 3 ou 4 cartes : soutien simple au palier 2.
    if (supportPoints >= 6 && supportPoints <= 10 && fitLen >= 3) {
        const call = (bid.level + 1) + suit;
        if (isCallLegal(history, call, seat)) return call;
    }

    return null;
}

// Décision de RÉPONSE à une annonce du PARTENAIRE (sa dernière annonce chiffrée est aussi
// la dernière de toute l'enchère, sans intervention adverse entre les deux). `hcp` et
// `partnerPromises5Plus` sont utilisés uniquement pour le soutien (voir plus bas) — voir
// échange avec Guillaume.
// Voir échange avec Guillaume (session du 30 juillet, donne 5) : réponse du répondant à un
// vrai BARRAGE (2/3/4 faible). Principe central, aux antipodes de ce qu'on pensait
// d'abord : SANS fit (mésentente avec l'atout du partenaire — même une chicane dans SA
// propre couleur, voir la donne 5 elle-même), seul le HCP BRUT compte, car le barreur
// plafonne à 10H (2 palier), 11H (3), 12H (4) — jamais de HLD ici, la distribution ne sert
// à rien si on ne va pas jouer dans cette couleur. AVEC un fit, on bascule en points de
// SOUTIEN (HLD, chicane dans une AUTRE couleur devient un vrai atout) : un fit se compte
// sur 8 CARTES À EUX DEUX, jamais un seuil de longueur fixe chez moi seul — dépend de ce
// que CE barrage promet réellement selon son palier (6 à 2, 7 à 3, 8 à 4).
function decideResponseToWeakTwo(hand, hcp, hl, bid, seat, history) {
    const lengths = suitLengths(hand);
    const barragePromisedLength = bid.level + 4;
    const totalTrumps = lengths[bid.strain] + barragePromisedLength;
    const hasFit = totalTrumps >= 8;
    const isMajor = bid.strain === 'S' || bid.strain === 'H';
    const gameLevel = isMajor ? 4 : 5;

    if (hasFit) {
        const supportPoints = computeSupportPoints(hand, bid.strain, barragePromisedLength);
        if (supportPoints >= 19) {
            for (let level = gameLevel; level <= 7; level++) {
                const call = level + bid.strain;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
        if (supportPoints >= 15) {
            const call = '2NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        // En dessous de 15 points de soutien : pas d'espoir de manche. Loi des atouts —
        // fit 9ème+ (3+ cartes réelles au-delà du plancher promis) ET 8H+ : relance d'un
        // palier (sécurité distributionnelle). Sinon, déjà au bon palier, rien à ajouter.
        if (hcp >= 8 && totalTrumps >= 9) {
            const call = (bid.level + 1) + bid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
        return 'PASS';
    }

    // Pas de fit : HCP brut, le barreur plafonne (10H à 2, 11H à 3, 12H à 4 — voir
    // decideRobotOpening pour ces mêmes plafonds côté ouverture).
    if (hcp >= 19) {
        const call = '3NT';
        if (isCallLegal(history, call, seat)) return call;
    }
    if (hcp >= 15) {
        const call = '2NT';
        if (isCallLegal(history, call, seat)) return call;
    }
    return 'PASS';
}

// Voir échange avec Guillaume (session du 30 juillet — CRM moderne) : réponse à
// l'ouverture de 2♦ forcing de manche. Priorité ABSOLUE à l'annonce des As (jamais les
// points d'abord) :
//   2♣ = pas d'As ; 2♠ = 1 As majeur (♥ ou ♠, sans préciser lequel) ; 2SA = du jeu sans
//   As (2 Rois ou 8H+) ; 3♣ = As de ♣ ; 3♦ = As de ♦ ; 3♥ = 2 As même couleur (rouges
//   ♥/♦ ou noirs ♠/♣) ; 3♠ = 2 As même rang (majeurs ♥/♠ ou mineurs ♦/♣) ; 3SA = 2 As
//   mélangés (ni même rang ni même couleur). 3+ As : cas non couvert explicitement par
//   l'échelle (qui s'arrête à 2) — choix pragmatique, "4SA" direct plutôt que de forcer
//   une catégorie à 2 As qui ne correspondrait pas.
function decideResponseToStrongDiamond(hand, seat, history) {
    const hcp = computeHandHcp(hand);
    const aceSuits = ['S', 'H', 'D', 'C'].filter(s => (hand[s] || '').includes('A'));
    const kingCount = ['S', 'H', 'D', 'C'].filter(s => (hand[s] || '').includes('K')).length;

    if (aceSuits.length === 0) {
        const call = (kingCount >= 2 || hcp >= 8) ? '2NT' : '2H';
        if (isCallLegal(history, call, seat)) return call;
        return 'PASS';
    }
    if (aceSuits.length === 1) {
        const suit = aceSuits[0];
        let call;
        if (suit === 'S' || suit === 'H') call = '2S';
        else if (suit === 'C') call = '3C';
        else call = '3D';
        if (isCallLegal(history, call, seat)) return call;
        return 'PASS';
    }
    if (aceSuits.length === 2) {
        const [a, b] = aceSuits;
        const isRed = s => s === 'H' || s === 'D';
        const isMajor = s => s === 'S' || s === 'H';
        let call;
        if (isRed(a) === isRed(b)) call = '3H';
        else if (isMajor(a) === isMajor(b)) call = '3S';
        else call = '3NT';
        if (isCallLegal(history, call, seat)) return call;
        return 'PASS';
    }
    const call = '4NT';
    if (isCallLegal(history, call, seat)) return call;
    return 'PASS';
}

// Voir échange avec Guillaume (session du 30 juillet, précisé après test) : l'ouvreur ne
// cherche PAS le chelem lui-même après la réponse CRM — il a déjà tout dit en ouvrant de
// 2♦ (peu de levées, le partenaire peut avoir 0H), donc il redemande simplement sa main
// NATURELLEMENT ("2SA" si régulière — montre juste 24HL+, forcing — ou sa plus longue
// sinon), quelle que soit la réponse CRM entendue. C'est au PARTENAIRE de prendre les
// devants ensuite s'il a des réserves à exploiter (Stayman/Texas sur ce "2SA", voir
// decideRobotCall — la rectification d'un Texas ici EST fittée, contrairement à un
// Texas sur 1SA, car 24HL+ régulière garantit quasiment un support quelque part).
function decideOpenerRebidAfterStrongDiamond(hand, seat, history, responseCall) {
    const lengths = suitLengths(hand);
    const balanced = isHandBalancedForNT(lengths);
    const responseParsed = parseBid(responseCall);
    const minLevel = responseParsed ? responseParsed.level : 2;

    if (balanced) {
        for (let level = minLevel; level <= 7; level++) {
            const call = level + 'NT';
            if (isCallLegal(history, call, seat)) return call;
        }
    }
    const suit = longestSuitPreferHigh(lengths);
    for (let level = minLevel; level <= 7; level++) {
        const call = level + suit;
        if (isCallLegal(history, call, seat)) return call;
    }
    return 'PASS';
}

function decideRobotResponse(hand, hcp, hl, partnerCall, seat, history, partnerPromises5Plus, partnerWasIntervening, partnerBidWasOpening, partnerBidWasReopening) {
    const lengths = suitLengths(hand);
    const bid = parseBid(partnerCall);

    // Réponse à l'APPEL AUX MINEURES en réveil (voir échange avec Guillaume, session du
    // 25 juillet, donne 1 — decideRobotIntervention, "2SA" bicolore 5-4+ mineures) :
    // AVANT le système Stayman/transferts ci-dessous, qui n'a rien à voir et
    // s'appliquerait à tort à la même chaîne "2NT" sinon (les deux se ressemblent mais
    // n'ont aucun rapport). Choisit simplement la mineure la plus longue chez soi (à
    // égalité, la moins chère/moins risquée : ♣) — le partenaire ne précise pas laquelle
    // de ses deux couleurs est la 5ème, impossible de faire mieux qu'une préférence sur
    // sa propre main.
    if (bid.strain === 'NT' && bid.level === 2 && partnerBidWasReopening) {
        const preferred = lengths['D'] > lengths['C'] ? 'D' : 'C';
        const call = 3 + preferred;
        if (isCallLegal(history, call, seat)) return call;
        return 'PASS';
    }

    // Réponse au 2♣ fort artificiel (voir échange avec Guillaume, donne 4) : "2C" comme
    // OUVERTURE ne peut venir que de ce cas dans notre moteur — un barrage à la mineure
    // ne descend jamais au palier 2 (voir decideRobotOpening, seule une majeure 6ème
    // ouvre de "2 faible"), donc pas d'ambiguïté possible ici... SAUF depuis l'ajout du
    // réveil (voir échange avec Guillaume, session du 25 juillet, donne 3) : un réveil
    // NATUREL peut lui aussi tomber sur "2C" (une vraie 6ème à trèfle, voir
    // decideRobotIntervention), sans rapport avec la convention. "partnerBidWasOpening"
    // (calculé par l'appelant : aucune annonce avant celle du partenaire dans toute
    // l'enchère) tranche : sans lui, un réveil à 2♣ se faisait forcer à répondre 2♦
    // automatiquement, ignorant complètement la vraie main. Relais d'attente
    // systématique en 2♦ pour la vraie ouverture, quelle que soit la main — pas de
    // "réponse positive" par couleur, volontairement hors périmètre (voir la même limite
    // sur l'ouverture elle-même).
    if (partnerCall === '2C' && partnerBidWasOpening) {
        const call = '2D';
        if (isCallLegal(history, call, seat)) return call;
    }

    // Voir échange avec Guillaume (session du 30 juillet — CRM moderne) : réponse au 2♦
    // FORCING DE MANCHE — AVANT le dispatch barrage juste en dessous (même forme
    // générique : palier 2+, ouverture) qui l'intercepterait sinon à tort. Échelle
    // dédiée, voir decideResponseToStrongDiamond : priorité absolue à l'annonce des As.
    if (partnerCall === '2D' && partnerBidWasOpening) {
        return decideResponseToStrongDiamond(hand, seat, history);
    }

    // Voir échange avec Guillaume (session du 30 juillet, précisant la donne 5) : réponse
    // à un vrai BARRAGE (2/3/4 faible, jamais 2♣ qui est déjà traité ci-dessus comme le
    // 2♣ fort artificiel) — échelle dédiée, voir decideResponseToWeakTwo. Remplace
    // entièrement l'ancien traitement dispersé (soutien majeur générique, seuils "3+
    // cartes = fitté" faux) par le principe qu'il a précisé : SANS fit, seul le HCP brut
    // compte (le barreur plafonne, 15H=essai, 19H=manche) ; AVEC un fit (8 cartes à eux
    // deux, jamais un seuil fixe de longueur — dépend de ce que CE barrage promet selon
    // son palier), on bascule en HLD (mêmes seuils 15/19), et en dessous de 15 mais avec
    // un fit 9ème+ et 8H+, la loi des atouts prime (relance d'un palier, pas d'espoir de
    // manche mais bon palier de sécurité).
    if (bid.level >= 2 && bid.strain !== 'NT' && partnerBidWasOpening) {
        return decideResponseToWeakTwo(hand, hcp, hl, bid, seat, history);
    }

    if (bid.strain === 'NT') {
        // Voir échange avec Guillaume : système unifié — Stayman et transferts vers
        // TOUTES les couleurs (pas seulement les majeures) au palier ouverture+1,
        // toujours. Pas de saut direct au palier 4 pour une majeure 6ème ("ça n'existe
        // pas") — la longueur ne change jamais le palier du transfert, seule la suite du
        // répondant en tient compte pour viser la manche ou non. Cycle des annonces :
        // ♣=Stayman, ♦→♥, ♥→♠, ♠→♣ (mineure, 6+ cartes), SA=naturel, puis ♣ au palier
        // suivant→♦ (l'autre mineure, 6+ cartes elle aussi, décalée d'un cran de plus
        // faute de place au palier précédent).
        const neededHL = (bid.level === 1) ? 10 : 4;
        const lv1 = bid.level + 1;

        // Transfert MAJEUR (5+ cartes) : ♦→♥, ♥→♠. Toujours au palier ouverture+1, quelle
        // que soit la longueur exacte (5 ou 6+, voir échange avec Guillaume : "ça
        // n'existe pas" de sauter plus haut) — c'est la suite du répondant après la
        // complétion (déclenchée depuis decideRobotCall) qui juge ensuite s'il y a assez
        // pour la manche.
        //
        // Voir échange avec Guillaume (session du 30 juillet, précisé après test) :
        // distinction cruciale entre 1SA et 2SA/"super 2SA" (2♣/2♦ puis 2SA, voir
        // decideOpenerRebidAfterStrongDiamond) — sur 1SA, le Texas est purement
        // mécanique, faisable avec 0H (aucune condition ici, voir plus bas). Sur 2SA (ou
        // super 2SA), la rectification EST fittée : il faut déjà les points de manche
        // pour faire le Texas (le plancher de l'ouvreur, 20HL au minimum même pour un
        // simple 2SA direct, garantit la manche dès qu'on y ajoute un minimum chez soi).
        const fiveCardMajor = ['S', 'H'].find(s => lengths[s] >= 5);
        // Voir échange avec Guillaume (session du 30 juillet) : hl>=5 suffit déjà pour
        // TOUT 2SA (direct comme "super 2SA") — même le plancher le plus bas possible
        // (20, pour un vrai 2SA direct) combiné à 5HL atteint la zone de manche (25).
        // Pas besoin d'un seuil différent pour le "super 2SA" : celui-ci a un plancher
        // encore plus haut, donc a fortiori toujours couvert par ce même seuil.
        if (fiveCardMajor && (bid.level === 1 || hl >= 5)) {
            const transferAsk = fiveCardMajor === 'H' ? 'D' : 'H';
            const call = lv1 + transferAsk;
            if (isCallLegal(history, call, seat)) return call;
        }

        // Transfert MINEUR (6+ cartes, voir échange avec Guillaume, donne 8) : ♠→♣ (au
        // palier ouverture+1), ♣→♦ (palier ouverture+2, faute de place plus tôt — ♠ est
        // déjà utilisé pour le transfert trèfle). Avec une vraie courte (0-1 carte)
        // ailleurs, toujours utilisé pour indiquer où elle est, même "juste" pour la
        // manche. SANS courte (main régulière, donc forcément 6322), seulement en zone de
        // chelem — sinon on va direct à 3SA/manche naturelle (voir plus bas), inutile de
        // complexifier l'enchère pour une main qui n'a que la manche à proposer.
        const sixCardMinor = ['C', 'D'].find(s => lengths[s] >= 6);
        if (sixCardMinor) {
            const hasShortness = ['S', 'H', 'D', 'C'].some(s => s !== sixCardMinor && lengths[s] <= 1);
            const slamZone = hl + (bid.level === 1 ? 15 : 20) >= 33; // même heuristique bornée que decideResponderContinuationAfterNewSuit
            if (hasShortness || slamZone) {
                const transferAsk = sixCardMinor === 'C' ? 'S' : 'C';
                const transferLevel = sixCardMinor === 'C' ? lv1 : lv1 + 1;
                const call = transferLevel + transferAsk;
                if (isCallLegal(history, call, seat)) return call;
            }
        }

        // Stayman (une majeure exactement 4 cartes, pas 5+ sinon un transfert
        // s'appliquerait déjà) : demande si l'ouvreur a 4+ cartes dans une majeure, avant
        // de se rabattre sur SA — seulement avec assez de points pour vouloir explorer
        // (même seuil que pour parler du tout, voir neededHL).
        const fourCardMajor = ['S', 'H'].some(s => lengths[s] === 4);
        if (fourCardMajor && hl >= neededHL) {
            const call = lv1 + 'C';
            if (isCallLegal(history, call, seat)) return call;
        }

        if (hl >= neededHL) {
            const call = '3NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        return 'PASS';
    }

    const suit = bid.strain;
    const partnerOpenedMinor = (suit === 'C' || suit === 'D');

    // Voir échange avec Guillaume (session du 24 juillet, donnes 3 et 4) : calculé ici,
    // dès le début, pour être réutilisé aussi par ownLongSuit ci-dessous (pas seulement
    // par la section "nouvelle couleur" plus bas, qui l'utilisait déjà) — 13HL en
    // concurrence (palier 2+ imposé, ou le partenaire est intervenu plutôt qu'ouvert),
    // 11HL sinon. Voir sa définition complète plus bas pour le détail du raisonnement.
    const newSuitThreshold = (bid.level >= 2 || partnerWasIntervening) ? 13 : 11;

    // Voir échange avec Guillaume (donne 1, session du 30 juillet) : jamais choisir comme
    // "ma nouvelle couleur" une couleur DÉJÀ annoncée par un ADVERSAIRE (ouverture,
    // intervention, ou une redemande) — même si c'est ma plus longue chez moi, la nommer
    // (souvent forcée à un palier plus haut, faute de place au palier de l'adversaire)
    // ressemblerait à tort à un cue-bid (annonce conventionnelle dans LEUR couleur), pas à
    // une vraie couleur personnelle — et masquerait une meilleure option ailleurs
    // (typiquement un contre négatif, voir decideRobotCall).
    const opponentSuits = new Set();
    history.forEach(e => {
        if (isBidCall(e.call) && partnershipOf(e.seat) !== partnershipOf(seat)) {
            const p = parseBid(e.call);
            if (p && p.strain !== 'NT') opponentSuits.add(p.strain);
        }
    });

    // Voir échange avec Guillaume (donne 8, session du 31 juillet — "je t'ai dit qu'il
    // fallait faire un cue-bid") : je réponds DIRECTEMENT à l'ouverture du partenaire,
    // mais un adversaire est intervenu entre les deux (voir decideDoublerFollowUp pour le
    // même principe côté contreur, factorisé dans decideGameForcingFallbackAfterOvercall)
    // — mon camp a-t-il de quoi jouer la manche, sans couleur annonçable (5+) ni arrêt
    // dans SA couleur ? Alors cue-bid par défaut, MÊME avec un fit pour la sienne, avant
    // toute logique de soutien plus bas (aucune enchère de soutien de ce moteur ne montre
    // précisément cette fourchette 13-14H). Restreint à une seule couleur adverse claire
    // (pas une enchère adverse ambiguë/multiple) et à une vraie ouverture (pas moi-même
    // en train de répondre à une intervention du partenaire).
    if (partnerBidWasOpening && bid.strain !== 'NT' && opponentSuits.size === 1) {
        const [singleOpponentSuit] = opponentSuits;
        const earlyFallback = decideGameForcingFallbackAfterOvercall(hand, hcp, seat, history, singleOpponentSuit, bid.strain);
        if (earlyFallback) return earlyFallback;
    }

    // Voir échange avec Guillaume (donne 2, session du 23 juillet) : les bots traitent
    // TOUS les contres comme des contres d'appel, jamais de contre punitif — trop subtil
    // à modéliser correctement. Donc pas de "passe de pénalité" en avance après un contre
    // adverse de l'ouverture du partenaire non plus (l'ancienne règle ici, 13H+ et misfit
    // 0-1 carte, laissait filer le contre pour la défense — supprimée, cohérence oblige) :
    // on répond toujours, exactement comme decideRobotResponseToDouble répond toujours au
    // PROPRE contre du joueur.

    // Priorité de base : après une ouverture à la MINEURE, montrer une majeure 4+ cartes
    // franche au palier 1 passe AVANT de soutenir la mineure du partenaire — le principe
    // qu'on cherche d'abord un fit à la majeure, plus rentable, avant de se rabattre sur
    // la mineure (voir échange avec Guillaume : bug trouvé en jouant, l'inverse était fait).
    // Avec les DEUX majeures à 4 cartes, on annonce "économiquement" — Cœur (le moins
    // cher) d'abord, pas Pique — pour garder la main de montrer Pique ensuite si besoin
    // sans se fermer d'options (bug trouvé à l'audit, donne 6 : l'ordre était inversé).
    //
    // Exception "points de manche" (voir échange avec Guillaume, donne 1) : cette priorité
    // à la majeure ne vaut que pour une main limitée qui cherche un fit rapide en un seul
    // tour. Avec 12+ (zone de manche connue, plusieurs tours possibles pour tout montrer)
    // ET une couleur de 5+ cartes plus longue que la majeure trouvée, on montre la longue
    // d'abord — plus informatif qu'une majeure 4ème qui ne dit rien sur la vraie forme.
    const major4 = partnerOpenedMinor ? ['H', 'S'].find(s => lengths[s] >= 4 && !opponentSuits.has(s)) : null;
    const longerSuit = hl >= 12 && major4
        ? ['S', 'H', 'D', 'C'].find(s => s !== suit && lengths[s] >= 5 && lengths[s] > lengths[major4])
        : null;
    if (hl >= 6 && partnerOpenedMinor && major4 && !longerSuit) {
        const call = '1' + major4;
        if (isCallLegal(history, call, seat)) return call;
    }
    if (longerSuit) {
        for (let level = bid.level; level <= 7; level++) {
            const call = level + longerSuit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume, donne 4 (session du 21 juillet), généralisé donne 6
    // (session du 22 juillet) : bug trouvé — sans majeure 4ème (donc "longerSuit" ci-dessus
    // ne se déclenchait jamais, il en dépend entièrement) ET sans 12H+, une main pouvait
    // quand même se retrouver à "soutenir" la couleur du partenaire (majeure OU mineure,
    // ouverte OU montrée par intervention) avec un simple fit de 3 cartes alors qu'elle a
    // une bien meilleure couleur à elle. Plus restreint aux mineures (donne 6 : même bug
    // avec une majeure — 3 cartes de "soutien" à un cœur adverse-intervenu de 7 cartes
    // plutôt que montrer 5 trèfles à soi). Seuil à 5+ (pas 6+, revu à la baisse après la
    // donne 6 où la couleur en question ne fait que 5 cartes) avec un écart d'au moins 2
    // cartes par rapport au fit — pour ne pas préférer une couleur juste "un peu plus
    // longue" mais bien NETTEMENT meilleure.
    //
    // Voir échange avec Guillaume (session du 24 juillet, donnes 3 et 4) : "priorité de
    // longueur, pas de points" ne vaut que pour une réponse encore BON MARCHÉ (palier 1,
    // ou le palier minimal légal s'il est déjà à 2 sans que ce soit MON choix) — sans
    // ça, une longue superbe pouvait forcer un engagement au palier 3 (ou un palier 2
    // imposé par la concurrence) sans la moindre valeur, ce qui n'a plus rien d'anodin.
    // Au-delà du palier minimal légal disponible, même seuil que pour une vraie nouvelle
    // couleur (newSuitThreshold), par cohérence.
    const ownLongSuit = ['S', 'H', 'D', 'C'].find(s => s !== suit && !opponentSuits.has(s) && lengths[s] >= 5 && lengths[s] >= lengths[suit] + 2);
    if (ownLongSuit) {
        for (let level = bid.level; level <= 7; level++) {
            const call = level + ownLongSuit;
            if (isCallLegal(history, call, seat)) {
                // Voir échange avec Guillaume (donne 4, session du 30 juillet) : bug trouvé
                // en testant — "priorité de longueur, pas de points" pour une réponse bon
                // marché (palier 1) ignorait TOUT plancher, y compris une main à 0H/0HL.
                // Même plancher minimal que les autres réponses bon marché de cette
                // fonction (voir hl>=6 quelques lignes plus bas) : la longueur seule ne
                // suffit jamais à justifier de parler avec une main qui n'a strictement
                // rien à montrer nulle part.
                //
                // Voir échange avec Guillaume (donne 3, 2e jeu, session du 31 juillet —
                // "dans une main trop faible pour passer par un changement de couleur")
                // : le plancher "bon marché" (hl>=6 au palier 1) suppose une réponse à
                // une OUVERTURE, où une nouvelle couleur au palier 1 reste d'engagement
                // limité pour le partenaire. En réponse à une INTERVENTION, on a établi
                // ailleurs (voir decideForcingResponseToInterventionAnswer) qu'une
                // nouvelle couleur est FORCING quel que soit le palier — le plancher
                // "bon marché" n'a alors plus de sens : avec un fit ET une main trop
                // faible pour imposer une suite au partenaire, il faut soutenir
                // directement plutôt que de forcer avec une couleur personnelle plus
                // longue mais non fittée. Seul newSuitThreshold (déjà relevé à 13 pour
                // une intervention) doit compter ici.
                if ((level <= 1 && hl >= 6 && !partnerWasIntervening) || hl >= newSuitThreshold) return call;
                break; // palier minimal légal déjà 2+ ET pas assez de points : pas la peine d'essayer plus haut, ce serait pire
            }
        }
    }

    // Soutien à une MAJEURE : échelle complète des soutiens directs (voir
    // decideRobotMajorSupport) — mais seulement pour une ouverture NORMALE au palier 1,
    // dont toute l'échelle de paliers est solidaire (voir échange avec Guillaume, donne
    // 8) : appliquée telle quelle à un BARRAGE (palier 2+), elle produirait par exemple
    // "3SA fitté" pour 13-15 points de soutien sans singleton — un non-sens, puisqu'un
    // barrage plafonne déjà le partenaire à 8-12HL, rien à voir avec une main d'ouverture
    // normale. Sur un barrage, la LOI DES ATOUTS prime : avec un fit (3+ cartes, déjà
    // 9+ cartes à eux deux vu que le barrage promet 6+), on prolonge d'un palier — sans
    // fit, on laisse la suite de cette fonction (nouvelle couleur / repli SA, avec son
    // propre seuil relevé pour un barrage, voir plus bas) décider.
    if ((suit === 'S' || suit === 'H') && bid.level === 1) {
        const majorSupport = decideRobotMajorSupport(hand, hcp, hl, bid, seat, history);
        if (majorSupport) return majorSupport;
    } else if ((suit === 'S' || suit === 'H') && bid.level >= 2) {
        // Voir échange avec Guillaume ("fitté = 8 cartes dans la ligne, pas 3 cartes
        // fixe", session du 30 juillet) : un barrage promet une longueur qui croît avec
        // le palier (6 à 2, 7 à 3, 8 à 4 — même convention que le reste du moteur, voir
        // OPENING_MINIMUM/SIMPLE_RAISE_MINIMUM pour l'esprit similaire côté points). Le
        // fit se compte sur le VRAI total (ma longueur + celle promise), jamais sur un
        // seuil fixe qui ignorerait combien le partenaire a réellement annoncé.
        const barragePromisedLength = bid.level + 4;
        if (lengths[suit] + barragePromisedLength >= 8) {
            const call = (bid.level + 1) + suit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume, donne 3 (session du 22 juillet) : la même idée
    // "montrer sa couleur avant de se rabattre sur autre chose" vaut aussi quand le
    // partenaire a ouvert une MAJEURE et que j'ai 4+ cartes dans l'AUTRE majeure, plus
    // chère — seul ♠ peut être "plus cher" que ♥ (aucune couleur n'est plus chère que ♠).
    // Placé APRÈS le soutien majeur ci-dessus : un vrai fit pour la couleur du partenaire
    // prime toujours sur l'idée de montrer une autre couleur. Seuil bas (même hl>=6 que
    // pour une mineure) : réponse bon marché, sans saut, qui mérite le seuil minimal de
    // n'importe quelle réponse simple — pas le seuil plus exigeant d'un changement de
    // couleur, qui engage davantage (voir newSuitThreshold plus bas).
    // Voir échange avec Guillaume (session du 24 juillet, donne 2 — nouveau bug) :
    // "bid.level === 1" ajouté — sans ça, cette règle (pensée pour une réponse encore bon
    // marché comme 1♥-1♠) se déclenchait aussi à tort sur un réveil à 2♥ du partenaire
    // (palier 2, pas du tout la même mise en jeu), produisant un "2♠" hasardeux avec
    // seulement 4 cartes sans le moindre fit établi.
    if (suit === 'H' && bid.level === 1 && lengths['S'] >= 4 && hl >= 6) {
        const call = bid.level + 'S';
        if (isCallLegal(history, call, seat)) return call;
    }

    // Soutien à une MINEURE : un fit, c'est 8 cartes à eux deux (voir échange avec
    // Guillaume — 5+3, pas 5+2), donc 3+ cartes. Le seuil de points utilise les points de
    // "soutien" (voir computeSupportPoints — H + 9ème atout + distribution, pas juste HL)
    // puisque la longueur du partenaire est désormais connue (5+ via une intervention,
    // 3+ par défaut pour une ouverture à la mineure, qui peut ne pas en avoir plus).
    //
    // Voir échange avec Guillaume (donne 11, session du 31 juillet) : règle précise pour
    // le soutien à SAUT (1m-P-3m), qui remplace l'ancien seuil générique
    // "supportPoints>=10" — montre une main LIMITE (9-11H BRUTS, pas les points de
    // soutien), SANS majeure 4ème (déjà prioritaire plus haut dans cette fonction — si on
    // arrive jusqu'ici en ayant dépassé les blocs "major4"/"longerSuit" ci-dessus, aucune
    // majeure 4ème valable n'a été trouvée), avec 5+ cartes dans la mineure ET une courte
    // (singleton ou chicane) ailleurs — une main IRRÉGULIÈRE. Propose la manche (3SA ou
    // 5m), à l'ouvreur de juger selon sa propre main s'il n'est pas minimal.
    const shortSuitForMinorJump = ['S', 'H', 'D', 'C'].filter(s => s !== suit).find(s => lengths[s] <= 1);
    const has4CardMajorSomewhere = ['S', 'H'].some(s => lengths[s] >= 4);
    const isMinorJumpRaiseShape = lengths[suit] >= 5 && shortSuitForMinorJump && !has4CardMajorSomewhere
        && hcp >= 9 && hcp <= 11 && bid.level === 1;

    // Exception "1SA poubelle", généralisée (voir échange avec Guillaume, donne 3 puis
    // donne 11) : à l'origine limitée à un fit d'EXACTEMENT 3 cartes ; sa précision sur la
    // donne 11 l'étend explicitement à N'IMPORTE QUELLE longueur de fit — "avec le fit
    // mineur dans un jeu de 10HL maximum et une main RÉGULIÈRE, on passe plutôt par 1SA"
    // — puisqu'une main régulière plafonnant à 10HL n'a de toute façon pas la forme
    // irrégulière qu'exige le soutien à saut ci-dessus, ni assez pour un soutien simple
    // vraiment convaincant : 1SA la décrit mieux, quelle que soit la longueur exacte du
    // fit (3, 4 ou 5+ cartes).
    const preferNTOverMinorFit = lengths[suit] >= 3 && isHandBalancedForNT(lengths) && hl <= 10 && bid.level === 1;
    const partnerGuaranteedLength = partnerPromises5Plus ? 5 : 3;
    const supportPoints = computeSupportPoints(hand, suit, partnerGuaranteedLength);
    if (preferNTOverMinorFit) {
        const call = '1NT';
        if (isCallLegal(history, call, seat)) return call;
    }
    // Voir échange avec Guillaume (donne 12, session du 31 juillet) : ce bloc, malgré son
    // nom ("soutien à une MINEURE"), n'est en réalité PAS filtré aux mineures — il sert
    // aussi de filet pour une MAJEURE quand decideRobotMajorSupport n'a rien trouvé. Bug
    // trouvé en testant le fix donne 12 : une main d'ouverture (12+ points de soutien)
    // avec seulement 3 cartes de fit à une majeure retombait ICI avec un seuil plus bas
    // (6-10), produisant quand même un simple soutien — exactement ce que le fix de
    // decideRobotMajorSupport voulait éviter. decideRobotMajorSupport a déjà eu sa pleine
    // chance de juger cette main (majeure, palier 1) ; s'il a décliné alors que les
    // points de soutien atteignent déjà OPENING_MINIMUM, c'est délibéré — laisser la
    // suite de la fonction (nouvelle couleur naturelle, plus bas) prendre le relais,
    // jamais ce filet générique.
    const majorAlreadyDeclinedByDesign = (suit === 'S' || suit === 'H') && bid.level === 1 && supportPoints >= OPENING_MINIMUM;
    if (lengths[suit] >= 3 && supportPoints >= 6 && !majorAlreadyDeclinedByDesign) {
        // Voir échange avec Guillaume (session du 24 juillet) : chelem par simple compte
        // de points, même principe que partout ailleurs dans le moteur — fit mineur
        // rarement assez fourni pour ça en pratique, mais autant rester cohérent plutôt
        // que de laisser un trou dans cette seule branche.
        const partnerMinimum = bid.level === 1 ? OPENING_MINIMUM : SIMPLE_RAISE_MINIMUM;
        if (supportPoints + partnerMinimum >= SLAM_ZONE_GRAND) {
            const call = '7' + suit;
            if (isCallLegal(history, call, seat)) return call;
        }
        if (supportPoints + partnerMinimum >= SLAM_ZONE_SMALL) {
            const call = '6' + suit;
            if (isCallLegal(history, call, seat)) return call;
        }
        // Voir échange avec Guillaume (donne 6, session du 30 juillet) : un réveil
        // NATUREL sans saut (celui-ci, comme tous les réveils naturels de ce moteur —
        // voir decideRobotIntervention) dénie en général 14H+ chez le partenaire — jamais
        // question de sauter en réponse, quels que soient MES propres points de soutien.
        // Distinct d'une vraie ouverture (qui n'a pas ce plafond) : seul un réveil (ou une
        // intervention, moins définie mais tout aussi non illimitée dans ce moteur) porte
        // cette restriction. Voir aussi donne 11 : le saut sur une VRAIE ouverture
        // n'est plus un seuil générique de points de soutien mais la forme précise
        // isMinorJumpRaiseShape calculée plus haut.
        const raiseLevel = (partnerBidWasReopening || partnerWasIntervening)
            ? bid.level + 1
            : bid.level + (isMinorJumpRaiseShape ? 2 : 1);
        // Voir échange avec Guillaume, donne 8 (session du 22 juillet) : cherche le
        // palier légal le plus proche à PARTIR de raiseLevel, plutôt qu'un seul essai
        // précis — une intervention adverse (ex. un barrage) peut avoir rendu ce palier
        // exact illégal, et ce soutien pourtant justifié ne se faisait alors pas du tout
        // (tombait en silence dans les vérifications suivantes, new suit / repli SA).
        for (let level = raiseLevel; level <= 7; level++) {
            const call = level + suit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Pas de fit : nouvelle couleur (4+ cartes), au palier minimal légal — y compris sur
    // un barrage faible du partenaire (2 faible, voir decideRobotOpening), où cette
    // annonce reste forcing un tour (voir échange avec Guillaume, donne 8), c'est à
    // l'OUVREUR de juger ensuite s'il pousse à la manche (voir
    // decideOpenerRebidAfterWeakTwoForcing).
    //
    // Seuil de points DIFFÉRENT selon ce que l'ouverture du partenaire promet (voir
    // échange avec Guillaume, donne 3) : 11HL (seuil SEF classique) pour une ouverture
    // normale au palier 1, qui promet déjà 12+ — mais un barrage plafonne le partenaire
    // à 8-12HL (voir decideRobotOpening), donc forcer une nouvelle couleur avec
    // seulement 11HL n'a "aucun espoir de manche" même dans le meilleur des cas (11+12 =
    // 23, sous la zone de manche) : ça force le partenaire à reparler pour rien. Seuil
    // relevé à 13HL dans ce cas — pile de quoi espérer la manche même si le partenaire
    // n'a que le minimum de sa fourchette de barrage (13+12=25). Voir sa définition tout
    // en haut de la fonction (réutilisée par ownLongSuit).
    if (hl >= newSuitThreshold) {
        const newSuitCandidates = ['S', 'H', 'D', 'C'].filter(s => s !== suit && !opponentSuits.has(s) && lengths[s] >= 4);
        const newSuit = newSuitCandidates.length > 0
            ? newSuitCandidates.reduce((best, s) => (lengths[s] > lengths[best] ? s : best), newSuitCandidates[0])
            : longestSuitPreferHigh(lengths); // filet : plus aucune couleur "propre" 4+ (rarissime)
        if (newSuit !== suit && lengths[newSuit] >= 4) {
            for (let level = bid.level; level <= 7; level++) {
                const call = level + newSuit;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
    }

    // Repli : SA au palier minimal légal si un peu de points mais rien de mieux à dire.
    // Même relèvement du seuil sur un barrage du partenaire (voir échange avec Guillaume,
    // donne 3, et newSuitThreshold plus haut) : sans assez pour espérer la manche, mieux
    // vaut passer que de parler pour parler — un repli SA ici décrirait mal une main sans
    // grand rapport avec un jeu régulier de toute façon.
    // DÉSACTIVÉ ENTIÈREMENT en avance d'une INTERVENTION du partenaire (voir échange avec
    // Guillaume, donne 4 de la session suivante) : la force de l'intervenant est bien
    // plus incertaine/basse qu'une vraie ouverture (voir decideRobotIntervention), donc
    // sans fit ni jeu réel, il n'y a "aucune raison" de fabriquer un repli SA — passer
    // reste la seule enchère honnête.
    // Voir échange avec Guillaume, donnes 2 et 8 (session du 22 juillet) : quand un
    // ADVERSAIRE (pas le partenaire) est intervenu, un repli SA exige en plus un vrai
    // arrêt (2+ honneurs) dans SA couleur — sans ça, "2SA" pouvait s'annoncer avec un seul
    // valet en main dans la couleur adverse, ce qui ne protège rien à l'entame. La
    // fourchette de points précise (10-11H, sans HL) pour 2SA vient directement de
    // Guillaume ; gardé au seuil HL existant pour les autres paliers, non précisés.
    const saFallbackThreshold = bid.level >= 2 ? 13 : 6;
    if (!partnerWasIntervening) {
        for (let level = bid.level; level <= 7; level++) {
            const call = level + 'NT';
            if (!isCallLegal(history, call, seat)) continue;
            const lastBidForStopper = getLastActualBid(history);
            const opponentSuit = (lastBidForStopper && isBidCall(lastBidForStopper.call)
                && partnershipOf(lastBidForStopper.seat) !== partnershipOf(seat))
                ? parseBid(lastBidForStopper.call).strain : null;
            const hasStopper = !opponentSuit || opponentSuit === 'NT'
                || ['A', 'K', 'Q', 'J', 'T'].filter(r => (hand[opponentSuit] || '').includes(r)).length >= 2;
            const pointsOk = level === 2 ? (hcp >= 10 && hcp <= 11) : hl >= saFallbackThreshold;
            if (pointsOk && hasStopper) return call;
            break; // le palier légal le plus bas ne convient pas (points ou arrêt) : les paliers suivants seraient encore plus exigeants, inutile de continuer
        }
    }

    return 'PASS';
}

// Décision d'INTERVENTION sur l'ouverture (ou l'enchère la plus récente) d'un ADVERSAIRE :
// contre d'appel si la main s'y prête (voir échange avec Guillaume), sinon une couleur
// solide (5+ cartes) et assez de points (HL, ajustés par vulnérabilité) pour un
// contre-appel naturel, au palier minimal légal.
// Voir échange avec Guillaume (donnes 3/8, session du 30 juillet) : "l'ouvreur/répondant
// se donnent leur zone de points via leurs propres enchères" — estimation PARTIELLE et
// prudente (un MINIMUM garanti, jamais une vraie fourchette) du camp `side` ('NS' ou
// 'EW'), à partir des seuls motifs que ce moteur reconnaît explicitement : ouverture
// normale au palier 1 (12+), première annonce du répondant (6+), et sa redemande à 2SA
// dans CE système précis (10-11H EXACTEMENT, voir decideRobotResponse). Renvoie null si
// la séquence ne correspond à aucun motif reconnu — mieux vaut ne rien affirmer que de se
// tromper. Sert uniquement à juger si un réveil vaut la peine (voir decideRobotIntervention
// juste en dessous) — pas un système de calcul de points général.
function estimateAuctionSideMinPoints(history, side) {
    const sideBids = history.filter(e => partnershipOf(e.seat) === side && isBidCall(e.call));
    if (sideBids.length === 0) return null;

    const opening = sideBids[0];
    const openingIdx = history.indexOf(opening);
    const wasRealOpening = history.slice(0, openingIdx).every(e => isPass(e.call));
    if (!wasRealOpening) return null; // pas une vraie ouverture (barrage, réveil...) : hors périmètre de cette estimation

    let minPoints = 12; // plancher d'ouverture normale au palier 1

    if (sideBids.length >= 2 && sideBids[1].seat !== opening.seat) {
        // Première annonce du RÉPONDANT (une redemande de l'OUVREUR ne montre rien de
        // plus que le plancher d'ouverture par défaut, on ne recalcule rien pour elle).
        const secondParsed = parseBid(sideBids[1].call);
        if (secondParsed && secondParsed.strain === 'NT' && secondParsed.level === 2) {
            minPoints += 10; // 2SA du répondant : EXACTEMENT 10-11H dans ce système
        } else {
            minPoints += 6; // plancher standard pour toute première annonce du répondant
        }
    }

    return minPoints;
}

function decideRobotIntervention(hand, hcp, hl, seat, history, dealVulnerable, isReopening) {
    const lengths = suitLengths(hand);
    const lastBid = getLastActualBid(history); // l'enchère adverse à laquelle on réagit

    // Voir échange avec Guillaume (session du 24 juillet) : RÉVEIL — moins exigeant
    // qu'une intervention directe, puisque le silence du partenaire (qui n'a pas pu
    // agir seul) ne dit rien sur SES points ; les siens peuvent très bien être là. Trois
    // cas, dans cet ordre : main plate sans couleur 5ème annonçable (8-12H, avec ou sans
    // arrêt — pas d'exigence d'arrêt en réveil, contrairement à un 1SA direct) → 1SA ;
    // couleur 5ème annonçable et 13H+ → contre d'abord (même principe que "toute
    // distribution" plus bas, mais réveil = moins de jeu suffit), puis la nommer
    // naturellement au tour suivant (voir decideDoublerFollowUp, déjà étendu pour ce cas
    // avec hcp>=13) ; couleur 5ème annonçable et 7-12H → la nommer directement,
    // naturellement, palier minimal légal. En dessous de 7H sans couleur ni main de SA :
    // rien à faire ici, la suite de la fonction (seuils d'intervention normaux, plus
    // exigeants) ne devrait de toute façon rien trouver — laissé tomber jusqu'au passe
    // final par défaut.
    // Voir échange avec Guillaume (session du 25 juillet, donne 4 — nouveau bug) : le
    // réveil ne vaut QUE si le contrat adverse est encore à BAS PALIER (1 ou 2) — dans ce
    // cas, le silence général suggère que les points sont partagés, donc que le
    // partenaire a probablement quelque chose malgré son silence forcé. À un palier plus
    // élevé (l'adversaire a déjà atteint ou dépassé la zone de manche), c'est l'inverse :
    // s'ils ont pu monter aussi haut sans opposition, c'est qu'ils ont le jeu pour ça, et
    // le partenaire n'a probablement RIEN — même avec une valeur d'ouverture soi-même, on
    // passe, un réveil ici n'aurait aucun sens (rien à récupérer chez le partenaire).
    if (isReopening && lastBid && parseBid(lastBid.call) && parseBid(lastBid.call).level > 2) {
        return 'PASS';
    }

    if (isReopening) {
        // Voir échange avec Guillaume (donnes 3/8) : le camp adverse s'est-il déjà donné
        // une zone de points assez haute (via ses propres enchères) pour que le réveil
        // n'ait manifestement aucun intérêt — les points sont alors clairement PAS
        // partagés, contrairement à l'hypothèse de base du réveil (silence général =
        // points probablement équilibrés). Seuil repris directement sur l'exemple de
        // Guillaume (12 + 10 = 22H).
        const opposingSide = partnershipOf(seat) === 'NS' ? 'EW' : 'NS';
        const opposingMin = estimateAuctionSideMinPoints(history, opposingSide);
        if (opposingMin !== null && opposingMin >= 22) return 'PASS';

        // Voir échange avec Guillaume (donnes 3/8) : jamais la couleur de l'ADVERSAIRE
        // lui-même comme couleur de réveil, même si c'est ma plus longue chez moi —
        // m'y réveiller (directement, ou via un contre suivi de cette couleur) n'a
        // aucun sens : c'est justement celle qu'il vient de montrer/répéter, donc très
        // probablement longue CHEZ LUI. Et si je n'ai pas de fit ailleurs, statistiquement
        // mon partenaire non plus (ses mots).
        const opponentSuits = new Set();
        history.forEach(e => {
            if (isBidCall(e.call) && partnershipOf(e.seat) !== partnershipOf(seat)) {
                const p = parseBid(e.call);
                if (p && p.strain !== 'NT') opponentSuits.add(p.strain);
            }
        });
        const reopenCandidates = ['S', 'H', 'D', 'C'].filter(s => !opponentSuits.has(s));
        const reopenSuit = reopenCandidates.length > 0
            ? reopenCandidates.reduce((best, s) => (lengths[s] > lengths[best] ? s : best), reopenCandidates[0])
            : longestSuitPreferHigh(lengths); // filet : plus aucune couleur "propre" (rarissime, adversaires ont annoncé les 4)
        const hasReopenSuit = lengths[reopenSuit] >= 5;

        if (!hasReopenSuit && hcp >= 8 && hcp <= 12 && isHandBalancedForNT(lengths)) {
            const call = '1NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        // Voir échange avec Guillaume (session du 24 juillet, donne 3 — nouveau bug) :
        // main plate mais TROP FORTE pour le réveil à 1SA (8-12) et sans assez pour un
        // hypothétique réveil à 2SA (17-19, jamais implémenté) — la zone 13-16 n'a pas de
        // main de SA directe à sa taille. Solution SEF : contrer d'abord (même si la
        // main est plate, sans besoin d'une vraie distribution de contre d'appel — le
        // réveil est plus tolérant), puis préciser à SA au tour suivant une fois le
        // palier ouvert par la réponse du partenaire (voir decideDoublerFollowUp, à
        // étendre pour ce cas précis).
        if (!hasReopenSuit && hcp >= 13 && hcp <= 16 && isHandBalancedForNT(lengths) && isCallLegal(history, 'X', seat)) {
            return 'X';
        }
        if (hasReopenSuit && hcp >= 13 && isCallLegal(history, 'X', seat)) {
            return 'X';
        }
        // Voir échange avec Guillaume (session du 25 juillet, donne 1) : bicolore 5-4+
        // dans les MINEURES spécifiquement — plutôt que nommer une seule des deux
        // (perdant l'info sur l'autre), "2SA" appelle aux mineures : le partenaire
        // répond dans celle qu'il préfère/a le plus, sans savoir laquelle des deux est
        // la 5ème chez moi. Prioritaire sur la nomination directe juste en dessous.
        const isReopenMinorTwoSuiter = lengths['C'] >= 4 && lengths['D'] >= 4 && (lengths['C'] >= 5 || lengths['D'] >= 5);
        if (isReopenMinorTwoSuiter && hcp >= 7 && hcp <= 12) {
            const call = '2NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        // Voir échange avec Guillaume (donne 6, session du 30 juillet) : seuils précisés
        // par palier — "on réveille toujours au palier 1 dès qu'on a un peu de jeu (8+),
        // et on ne le fait au palier 2 qu'avec une dizaine de points". JAMAIS au palier 3+
        // (donne 7, règle générale et explicite) — boucle bornée à 2, contrairement au
        // reste du moteur qui va jusqu'à 7.
        //
        // Voir échange avec Guillaume (donne 6, session du 30 juillet, précisé après
        // test) : HL (longueur comprise), pas HCP brut — son exemple ("9H+1L") ne passait
        // le seuil du palier 2 qu'une fois la longueur comptée (9+1=10), pas en HCP pur
        // (9 < 10). Erreur de ma part au premier passage, corrigée ici.
        if (hasReopenSuit) {
            for (let level = 1; level <= 2; level++) {
                const call = level + reopenSuit;
                if (isCallLegal(history, call, seat)) {
                    const minHl = level === 1 ? 8 : 10;
                    if (hl >= minHl) return call;
                    break; // le palier suivant serait encore plus exigeant, inutile de continuer
                }
            }
        }
    }

    // "Contre toute distribution" (voir échange avec Guillaume, donne 2) : à partir de
    // 19HL+, on contre d'abord, quelle que soit la distribution — même avec une belle
    // couleur personnelle qu'on aurait pu montrer directement — pour annoncer une force
    // que ni un contre d'appel normal ni une intervention naturelle directe ne
    // représenteraient correctement. La vraie couleur se montre ensuite, au tour suivant
    // (voir decideDoublerFollowUp), une fois cette force acquise pour le partenaire.
    // Priorité absolue, avant même le contre d'appel normal ci-dessous.
    //
    // Voir échange avec Guillaume (session du 24 juillet, donne 4 — nouveau bug) :
    // "history.indexOf(lastBid) === 0" ajouté aux DEUX contres ci-dessous — un contre
    // d'appel classique n'a de sens que sur l'OUVERTURE adverse elle-même (le tout
    // premier appel de l'enchère), pas sur une redemande plus tardive en pleine
    // séquence compétitive (ex. l'ouvreur adverse qui rebiddde une 2e couleur après que
    // son partenaire a répondu) : à ce stade, la couleur "adverse" à contrer n'est plus
    // clairement définie de la même façon, et un simple contre d'appel standard n'est
    // plus la bonne réponse (séquences compétitives détaillées après contre, hors
    // périmètre — voir le README).
    if (lastBid && history.indexOf(lastBid) === 0) {
        const strongDoubleOppBid = parseBid(lastBid.call);
        if (strongDoubleOppBid && strongDoubleOppBid.strain !== 'NT' && hl >= 19) {
            const call = 'X';
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Contre d'appel ("takeout") : main d'ouverture (12HL+), courte dans la couleur
    // adverse (0-2 cartes), un support raisonnable dans les 3 autres — simplifié à "3
    // cartes partout ailleurs, ou au moins 2 des 3 autres couleurs à 4+ cartes" plutôt que
    // d'exiger un support parfait dans les 3. Ne s'applique qu'après une ouverture à la
    // couleur (jamais après du SA adverse, un tout autre type de contre hors périmètre).
    // Exclusion importante (voir échange avec Guillaume, donne 2) : avec une couleur
    // longue de 6+ cartes, cette couleur se montre directement plutôt que de se cacher
    // derrière un contre — le contre ne promet de longueur nulle part, il gâcherait une
    // belle couleur qui vaut mieux annoncée en clair.
    // Étendu (voir échange avec Guillaume, donne 7) : une MAJEURE de 5+ cartes suffit
    // déjà à préférer l'intervention naturelle — une majeure 5ème est assez descriptive
    // en elle-même pour ne pas se cacher derrière un contre, même si le seuil "longue
    // couleur" ci-dessus (6+, toutes couleurs confondues) n'est pas atteint.
    if (lastBid && history.indexOf(lastBid) === 0) {
        const oppBid = parseBid(lastBid.call);
        const hasLongSuit = ['S', 'H', 'D', 'C'].some(s => lengths[s] >= 6);
        const hasFiveCardMajor = ['S', 'H'].some(s => lengths[s] >= 5);
        // Voir échange avec Guillaume (session du 23 juillet, donne 2) : HCP réel exigé
        // ici (pas HL) — "12H+", distinct de la règle "toute distribution" ci-dessus qui,
        // elle, se base sur HL (19HL+). Les deux seuils ne sont pas interchangeables.
        if (oppBid && oppBid.strain !== 'NT' && hcp >= 12 && lengths[oppBid.strain] <= 2 && !hasLongSuit && !hasFiveCardMajor) {
            const otherSuits = ['S', 'H', 'D', 'C'].filter(s => s !== oppBid.strain);
            // Voir échange avec Guillaume (session du 23 juillet, donne 2) : sur une
            // MINEURE adverse, le contre d'appel promet spécifiquement les DEUX
            // majeures (au moins 3 cartes chacune, idéalement 4-3) — l'ancienne règle
            // ("2 couleurs quelconques parmi les 3 restantes à 4+") pouvait laisser une
            // majeure complètement dénudée (2 cartes) tant que les 2 AUTRES étaient
            // longues, ce qui n'est plus assez précis pour orienter le partenaire.
            //
            // Voir échange avec Guillaume (session du 24 juillet, donne 8 — même faille,
            // trouvée cette fois sur une majeure adverse) : la branche générale ("2 des 3
            // autres à 4+") avait EXACTEMENT le même défaut — un contre de 2♠ avec
            // seulement 2 cœurs (et ♦/♣ à 4+ en compensation) laissait une majeure
            // dénudée si le partenaire répond justement là. Repli strict sur "les 3
            // autres à 3+ cartes chacune", sans plus aucune exception par compensation de
            // longueur.
            const oppBidIsMinor = oppBid.strain === 'C' || oppBid.strain === 'D';
            const shapeOk = oppBidIsMinor
                ? (lengths['S'] >= 3 && lengths['H'] >= 3)
                : otherSuits.every(s => lengths[s] >= 3);
            if (shapeOk) {
                const call = 'X';
                if (isCallLegal(history, call, seat)) return call;
            }
        }
    }

    // Intervention naturelle : seuil resserré vulnérable (10HL) que non-vulnérable (8HL),
    // même logique que pour les barrages (voir decideRobotOpening).
    const threshold = isSeatVulnerable(seat, dealVulnerable) ? 10 : 8;
    if (hl < threshold) return 'PASS';
    const suit = longestSuitPreferHigh(lengths);
    if (lengths[suit] < 5) return 'PASS';

    // Barrage en INTERVENTION (voir échange avec Guillaume, donne 2 — précision
    // sémantique : c'est bien une intervention sur l'adversaire, pas une réponse au
    // partenaire) : même forme qu'un barrage d'ouverture (8-12HL, 6+ cartes dans une
    // seule couleur, rien d'autre de significatif à montrer) — les points sont
    // concentrés dans une seule longue sans valeur défensive ailleurs, mieux vaut sauter
    // au palier 2 pour gêner l'adversaire plutôt qu'intervenir naturellement au palier
    // minimal (souvent 1, qui ne gêne pas grand-chose et sous-décrit la main).
    // RÉSERVÉ AUX MAJEURES (voir échange avec Guillaume, donne 1) : "les barrages
    // n'existent qu'à partir de 2♥" — un "2♣" ou "2♦" n'est JAMAIS un vrai barrage
    // volontaire (le palier 1 y est presque toujours disponible ; s'il ne l'est pas,
    // c'est subi, pas choisi pour gêner l'adversaire). Une intervention à la mineure
    // forcée au palier 2+ passe systématiquement par le seuil normal plus bas (12H+,
    // 6 cartes) — plus exigeant que la fourchette de barrage (8-12HL).
    //
    // Voir échange avec Guillaume (donne 14, session du 31 juillet) : le MÊME défaut
    // existe aussi pour une MAJEURE — "les critères d'intervention au palier de 2 SANS
    // SAUT sont toujours les mêmes" (ses mots). Si l'adversaire a ouvert d'une couleur
    // de rang supérieur à la mienne (ex. 1♠, moi hearts), le palier 1 dans ma couleur
    // n'est tout simplement PAS DISPONIBLE — le palier 2 est alors SUBI, pas choisi,
    // exactement comme pour une mineure, et ne doit jamais bénéficier du seuil permissif
    // du barrage (8-12HL) : il doit passer par le seuil normal, plus exigeant, plus bas.
    // Calcule donc le palier NATUREL (le plus bas légalement possible) avant de décider
    // si sauter à 2 est un vrai choix (palier naturel = 1) ou une couleur simplement
    // forcée au palier 2 (palier naturel déjà 2, rien à sauter par-dessus).
    let naturalLevelForBarrage = null;
    for (let level = 1; level <= 7; level++) {
        if (isCallLegal(history, level + suit, seat)) { naturalLevelForBarrage = level; break; }
    }
    // Voir échange avec Guillaume (session du 31 juillet, 23h — régression trouvée sur la
    // donne 2 : "pourquoi Est n'intervient plus à 2♠ ? avant il le faisait") : EXCEPTION
    // pour une intervention sur SA — NT est classé au-dessus de TOUTE couleur dans
    // STRAIN_RANK, donc le palier naturel d'une couleur quelconque après 1SA est TOUJOURS
    // 2 (jamais 1, pour aucune couleur) : le garde-fou "isGenuineJumpToTwo" ci-dessus
    // exclurait alors systématiquement TOUTE intervention à la couleur sur SA du barrage,
    // ce qui n'était pas le sens de la règle de la donne 14 (pensée pour une couleur
    // classée sous une AUTRE couleur d'ouverture, pas sous SA) — un 2♠ sur 1SA reste la
    // forme normale et attendue d'une intervention faible à une longue majeure, pas un
    // palier "subi" au sens péjoratif de la donne 14.
    const wasInterveningOverNT = lastBid && parseBid(lastBid.call) && parseBid(lastBid.call).strain === 'NT';
    const isGenuineJumpToTwo = naturalLevelForBarrage === 1 || wasInterveningOverNT;
    const hasOtherFourCardSuit = ['S', 'H', 'D', 'C'].some(s => s !== suit && lengths[s] >= 4);
    if ((suit === 'S' || suit === 'H') && hl <= 12 && lengths[suit] >= 6 && !hasOtherFourCardSuit && isGenuineJumpToTwo) {
        for (let level = 2; level <= 7; level++) {
            const call = level + suit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Cherche le palier minimal légal dans cette couleur, sans encore décider si on s'y
    // engage (voir le contrôle du palier 2+ juste après).
    let chosenLevel = null;
    for (let level = 1; level <= 7; level++) {
        const call = level + suit;
        if (isCallLegal(history, call, seat)) { chosenLevel = level; break; }
    }
    if (chosenLevel === null) return 'PASS';

    // Voir échange avec Guillaume (précisé donne 5, session du 31 juillet — "il a 11H et
    // une couleur 6ème donc 13HL, c'est largement suffisant") : une intervention forcée
    // au palier 2 (ou plus) exige davantage qu'au palier 1 — mais en HL (longueur
    // comprise), pas en HCP brut comme avant : une longue couleur (6+, déjà exigée par
    // ailleurs) compense une partie du déficit en points secs, exactement comme partout
    // ailleurs dans ce moteur où HL est la mesure de référence pour juger si une main a
    // "assez" pour un palier donné.
    if (chosenLevel >= 2 && (hl < 12 || lengths[suit] < 6)) return 'PASS';

    return chosenLevel + suit;
}

// Réponse à un RENVERSE forcing de l'ouvreur (voir échange avec Guillaume, session du 23
// juillet, donne 8 — "un renverse du partenaire est 100% forcing") : jamais de passe
// possible ici, quelle que soit la main. Priorité simple, dans l'ordre : répéter sa propre
// couleur si 5+ cartes (montre la longueur, choix le plus naturel et le plus fréquent —
// voir donne 8) ; sinon revenir à la 1ère couleur de l'ouvreur si 2+ cartes de soutien ;
// en tout dernier recours (main sans fit nulle part), SA au palier le moins cher possible.
function decideReverseForcingResponse(hand, myResponseBid, partnerOpeningBid, partnerRebidBid, seat, history) {
    const lengths = suitLengths(hand);

    if (myResponseBid.strain !== 'NT' && lengths[myResponseBid.strain] >= 5) {
        const ownSuitCall = partnerRebidBid.level + myResponseBid.strain;
        if (isCallLegal(history, ownSuitCall, seat)) return ownSuitCall;
    }

    if (lengths[partnerOpeningBid.strain] >= 2) {
        const preferenceCall = (partnerRebidBid.level + 1) + partnerOpeningBid.strain;
        if (isCallLegal(history, preferenceCall, seat)) return preferenceCall;
    }

    for (let level = partnerRebidBid.level; level <= 7; level++) {
        const ntCall = level + 'NT';
        if (isCallLegal(history, ntCall, seat)) return ntCall;
    }
    return 'PASS'; // filet de sécurité improbable : rien de légal trouvé
}

// Suite du RÉPONDANT une fois que le partenaire a rebiddé, quand le répondant sait être en
// zone de manche (voir échange avec Guillaume) : une ouverture à la couleur promet 12+,
// donc un répondant ayant lui-même 12+ sait que son camp a 24+ à eux deux — la séquence
// doit continuer jusqu'à la manche, jamais de passe en dessous (voir le déclencheur dans
// decideRobotCall, qui ne sollicite cette fonction que si hcp>=12). Priorité systématique
// à un fit MAJEUR de 8+ cartes CONNU : la couleur d'ouverture promet 5+ si c'est une
// majeure ("majeure 5ème"), un rebid en nouvelle couleur promet 4+ (voir
// decideOpenerRebidAfterNewSuit, qui n'y montre jamais moins). Sans un tel fit, manche à
// SA directement — pas d'exploration d'un fit mineur (voir échange avec Guillaume : on
// préfère SA à une mineure).
function decideResponderContinuationAfterNewSuit(hand, hcp, hl, openingBid, myResponseBid, partnerRebidCall, seat, history) {
    const lengths = suitLengths(hand);
    const rebid = parseBid(partnerRebidCall);
    if (!rebid) return 'PASS'; // contre/passe du partenaire à ce stade : hors périmètre, filet de sécurité

    // Réponse au 4SA quantitatif (voir échange avec Guillaume, donne 2, session du 21
    // juillet) : le partenaire a une main énorme (22HL+, voir
    // decideOpenerRebidAfterNewSuit) et demande si j'ai un peu plus que le minimum promis
    // par ma réponse — avec 9H+ (le haut de la fourchette habituelle d'une réponse simple,
    // 6-11H), je dis 6SA ; sinon je reste sur 4SA. Traité à part de l'heuristique de
    // zone générique plus bas (qui suppose une ouverture normale à 12H minimum) : ici
    // c'est une vraie question du partenaire, pas un simple compte de points de ma part.
    if (partnerRebidCall === '4NT') {
        if (hcp >= 9) {
            const call = '6NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        return 'PASS';
    }

    // Voir échange avec Guillaume (session du 24 juillet) : bascule sur HLD
    // (computeSupportPoints) dès qu'un fit est identifié — via l'ouverture (5+ garanti
    // si majeure, majeure 5ème système) ou via la redemande du partenaire (4+ garanti,
    // voir decideOpenerRebidAfterNewSuit) — plutôt que HL (mes propres points de
    // longueur, qui ne veulent plus rien dire une fois qu'on joue avec l'atout du
    // partenaire). Sans fit (on va vers SA), HL reste la bonne mesure : pas de couleur
    // d'atout connue, donc pas de distribution à valoriser par rapport à elle.
    // Étendu aux MINEURES (donne 4, session du 24 juillet) : la même logique que pour
    // une majeure, mais avec la manche au palier 5 (pas 4) une fois le fit identifié —
    // voir plus bas.
    let zonePoints = hl;
    let fitSuit = null;
    if (rebid.strain !== 'NT' && rebid.strain === myResponseBid.strain) {
        // Voir échange avec Guillaume (session du 25 juillet, donne 4 — nouveau bug) : le
        // cas le plus évident de tous — le partenaire RELANCE DIRECTEMENT ma propre
        // couleur (même famille que myResponseBid.strain), un vrai fit garanti — mais
        // aucune des branches ci-dessous ne le détectait, toutes cherchant un fit dans
        // une couleur DIFFÉRENTE de la mienne (l'ouverture du partenaire, ou une
        // nouvelle couleur qu'il montre). Sans ce cas, une relance directe de ma
        // majeure (même en zone de manche connue) atterrissait à tort sur un SA
        // générique, ignorant le fit le plus évident possible.
        fitSuit = myResponseBid.strain;
        zonePoints = computeSupportPoints(hand, fitSuit, 3);
    } else if (rebid.strain !== 'NT') {
        const openingIsMajor = openingBid.strain === 'S' || openingBid.strain === 'H';
        const rebidIsMajor = rebid.strain === 'S' || rebid.strain === 'H';
        if (openingIsMajor && lengths[openingBid.strain] + 5 >= 8) fitSuit = openingBid.strain;
        else if (rebidIsMajor && rebid.strain !== myResponseBid.strain && lengths[rebid.strain] + 4 >= 8) fitSuit = rebid.strain;
        else {
            const openingIsMinor = openingBid.strain === 'C' || openingBid.strain === 'D';
            const rebidIsMinor = rebid.strain === 'C' || rebid.strain === 'D';
            if (openingIsMinor && lengths[openingBid.strain] + 5 >= 8) fitSuit = openingBid.strain;
            else if (rebidIsMinor && rebid.strain !== myResponseBid.strain && lengths[rebid.strain] + 4 >= 8) fitSuit = rebid.strain;
        }
        if (fitSuit) {
            const partnerGuaranteedLength = fitSuit === openingBid.strain ? 5 : 4;
            zonePoints = computeSupportPoints(hand, fitSuit, partnerGuaranteedLength);
        }
    } else if (myResponseBid.strain === 'S' || myResponseBid.strain === 'H') {
        // Voir échange avec Guillaume (session du 25 juillet, donne 8 — nouveau bug) : le
        // partenaire a redemandé SA (dénie 3+ cartes dans MA couleur, voir
        // decideOpenerRebidAfterNewSuit — mais avec 6+ cartes chez moi, il en a forcément
        // au moins 2 par élimination) — MA PROPRE majeure déjà montrée est alors le seul
        // fit possible, pas une couleur du partenaire (cette fonction ne cherchait
        // jusqu'ici QUE dans les couleurs annoncées par le partenaire, jamais dans la
        // mienne). Sans ce cas, une main de zone de manche (12H+) avec une belle
        // majeure 6ème atterrissait toujours sur un SA générique, ignorant complètement
        // le fit connu (voir aussi hasOwnMajorToRepeat, la version "pas assez pour
        // forcer" de la même idée). 6+ cartes exigées (pas 5) : avec seulement 2 cartes
        // de soutien présumées chez le partenaire, un fit de 5+2=7 serait trop juste
        // pour viser la manche les yeux fermés.
        if (lengths[myResponseBid.strain] >= 6) {
            fitSuit = myResponseBid.strain;
            zonePoints = computeSupportPoints(hand, fitSuit, 2);
        }
    }

    // Voir échange avec Guillaume (donne 8, session du 30 juillet) : toujours pas de fit
    // trouvé nulle part (ni dans l'ouverture, ni dans la redemande du partenaire, ni via
    // un déni explicite à SA ci-dessus) — MA PROPRE couleur, si assez longue et de bonne
    // qualité, mérite d'être jouée unilatéralement plutôt que de finir sur un SA
    // générique. Sans savoir combien de cartes le partenaire y a réellement (aucun déni
    // ni confirmation ici, contrairement au cas SA ci-dessus), on reste en HL BRUT — pas
    // de points de soutien, qui supposeraient à tort une longueur connue chez lui : 7+
    // cartes suffit seule ; 6 cartes exige EN PLUS un singleton ailleurs (valeur de ruff)
    // et une belle couleur (2+ gros honneurs A/R/D) pour compenser la longueur manquante.
    if (!fitSuit && (myResponseBid.strain === 'S' || myResponseBid.strain === 'H')) {
        const ownSuit = myResponseBid.strain;
        const ownLen = lengths[ownSuit];
        const hasOutsideSingleton = ['S', 'H', 'D', 'C'].some(s => s !== ownSuit && lengths[s] === 1);
        const ownSuitCards = hand[ownSuit] || '';
        const topHonors = ['A', 'K', 'Q'].filter(r => ownSuitCards.includes(r)).length;
        const goodEnoughAt6 = ownLen === 6 && hasOutsideSingleton && topHonors >= 2;
        if ((ownLen >= 7 || goodEnoughAt6) && hl + OPENING_MINIMUM >= GAME_ZONE_NT) {
            fitSuit = ownSuit;
            zonePoints = hl;
        } else if (ownLen >= 6) {
            // Voir échange avec Guillaume (donne 8, précisé, session du 30 juillet) : la
            // manche n'est pas certaine ici (zone limite — on n'est arrivé jusque-là que
            // parce que knowsGameZone a déjà validé 12HL+ ailleurs), mais ma couleur 6+
            // mérite mieux qu'un repli SA générique — saut d'un cran par rapport au
            // palier minimal légal pour proposer la manche, le partenaire tranchera avec
            // sa propre réserve. Le palier minimal lui-même (sans saut) porterait à tort
            // le sens "zone basse, 6-9H" (voir le repli correspondant dans
            // decideRobotCall, hors de cette fonction).
            let minLevel = null;
            for (let level = 1; level <= 7; level++) {
                if (isCallLegal(history, level + ownSuit, seat)) { minLevel = level; break; }
            }
            if (minLevel !== null) {
                for (let level = minLevel + 1; level <= 7; level++) {
                    const call = level + ownSuit;
                    if (isCallLegal(history, call, seat)) return call;
                }
            }
        }
    }

    // Chelem par simple compte de points (voir échange avec Guillaume, donne 6) : pas de
    // véritable enchère de contrôle (cue-bids, Blackwood — hors périmètre, voir le
    // README), mais un déclenchement borné et sûr — si MES points (HL, ou HLD si un fit
    // majeur vient d'être identifié ci-dessus) combinés au MINIMUM garanti par
    // l'ouverture du partenaire (OPENING_MINIMUM) atteignent la zone de petit chelem,
    // voire de grand chelem, on saute directement plutôt que de s'arrêter à la manche.
    // Un excès de matériel aussi manifeste ne doit pas rester ignoré juste parce qu'on ne
    // fait pas de vraie enchère de contrôle.
    if (zonePoints + OPENING_MINIMUM >= SLAM_ZONE_GRAND) {
        const call = fitSuit ? '7' + fitSuit : '7NT';
        if (isCallLegal(history, call, seat)) return call;
    }
    if (zonePoints + OPENING_MINIMUM >= SLAM_ZONE_SMALL) {
        const call = fitSuit ? '6' + fitSuit : '6NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    if (fitSuit) {
        // Vise directement la MANCHE une fois le fit identifié — palier 4 pour une
        // majeure, 5 pour une mineure (voir échange avec Guillaume, donne 4 — bug trouvé
        // en étendant cette fonction aux mineures : restait au palier 4 par erreur, qui
        // n'est pas la manche dans une mineure). Pas juste le palier minimal légal
        // au-dessus du rebid du partenaire (bug trouvé à l'audit, donne 7 : atterrissait
        // sur un simple "3H" alors que la zone de manche est déjà connue par
        // construction, voir le déclencheur dans decideRobotCall). Repli sur le palier
        // minimal légal seulement si le palier de manche lui-même n'est plus disponible
        // (enchère déjà montée plus haut, cas rare).
        const fitIsMajor = fitSuit === 'S' || fitSuit === 'H';
        const gameLevel = fitIsMajor ? 4 : 5;
        for (let level = Math.max(gameLevel, rebid.level); level <= 7; level++) {
            const call = level + fitSuit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    for (let level = 3; level <= 7; level++) {
        const call = level + 'NT';
        if (isCallLegal(history, call, seat)) return call;
    }
    return 'PASS';
}


// Décision de RÉPONSE au contre d'appel du PARTENAIRE : quasiment obligatoire (main
// faible ou non), dans l'une des 3 couleurs non contrées — la plus longue chez soi.
// Simplifié à un seul palier selon les points, sans vrai barème de saut ni main
// "punitive" (laisser le contre en place avec une longue couleur adverse), hors périmètre.
// Reçoit l'INDEX du contre dans l'historique plutôt que de le redériver via
// getLastNonPassCall (voir échange avec Guillaume, donne 4) : si un adversaire a reparlé
// depuis (ex. une surenchère après le contre), ce n'est plus la dernière annonce non-passe
// de toute l'enchère — c'est l'appelant (decideRobotCall) qui a déjà fait cette recherche
// correctement en remontant l'historique depuis mon propre camp.
// Suite du CONTREUR d'appel après la réponse du partenaire (voir échange avec Guillaume,
// donne 4) : avec de la réserve au-delà du minimum du contre (voir échange avec
// Guillaume : 15H+, le contre lui-même promettait déjà 12H+) ET un fit pour la couleur
// choisie par le partenaire (3+ cartes), on pousse directement à la manche plutôt que de
// laisser filer un partiel — le partenaire a déjà répondu, rien d'autre à attendre de lui.
// Voir échange avec Guillaume (donne 1, session du 30 juillet) : mon partenaire répond à
// MA PROPRE OUVERTURE par un CONTRE (pas une vraie enchère chiffrée) après l'intervention
// d'un adversaire — contre d'appel/négatif façon Sputnik. Ce contre promet 4+ cartes dans
// une couleur pas encore montrée par quiconque, et 8H+ SANS LIMITE HAUTE — je suis donc
// QUASIMENT OBLIGÉ de reparler (donner le fit), et je dois pousser au-delà du minimum si
// ma propre main dépasse elle-même le plancher d'ouverture, sous peine de rater une
// manche que ce contre illimité peut très bien annoncer. Distinct de
// decideRobotResponseToDouble (qui traite le cas symétrique où c'est MOI qui réponds au
// contre du partenaire, jamais celui où j'ai déjà ouvert moi-même).
function decideOpenerResponseToPartnerDouble(hand, hcp, hl, doubleIndex, seat, history) {
    const lengths = suitLengths(hand);

    // Voir échange avec Guillaume (session du 31 juillet, suite aux simulations à grande
    // échelle — "sur une ouverture de barrage, après intervention, le X du partenaire de
    // l'ouvreur est strictement punitif, on ne recherche pas un fit") : si MA propre
    // annonce d'ouverture était un barrage (couleur, palier 2+, hors 2♣/2♦ fort
    // artificiel), le contre de mon partenaire sur l'intervention adverse qui a suivi
    // n'a RIEN à voir avec la recherche de fit ci-dessous — il est punitif, point final.
    // Jamais de recherche de couleur ici : je passe, j'accepte le contre punitif de mon
    // partenaire. Cas trouvé par simulation (voir run-bidding-simulations.js) : un 4♣
    // barrage (9 cartes solides) suivi d'un contre du partenaire faisait sauter à 6♥ avec
    // seulement 2 cartes à Cœur — la recherche de fit ci-dessous n'a de sens qu'après une
    // vraie ouverture (1-niveau, ou 2♣/2♦ fort), jamais après un barrage.
    const myFirstBidEntry = history.find(e => e.seat === seat && isBidCall(e.call));
    const myFirstBidParsed = myFirstBidEntry ? parseBid(myFirstBidEntry.call) : null;
    const wasBarrageOpening = myFirstBidParsed && myFirstBidParsed.strain !== 'NT'
        && myFirstBidParsed.level >= 2
        && !(myFirstBidParsed.level === 2 && (myFirstBidParsed.strain === 'C' || myFirstBidParsed.strain === 'D'));
    if (wasBarrageOpening) return 'PASS';

    // Couleurs pas encore annoncées par QUICONQUE avant ce contre — celles que le contre
    // du partenaire promet (voir échange avec Guillaume). Filet de sécurité : si (cas
    // limite) ça n'en laisse aucune, retombe sur les 4 couleurs plutôt que de planter.
    const bidSuitsBefore = new Set();
    for (let i = 0; i < doubleIndex; i++) {
        if (isBidCall(history[i].call)) {
            const p = parseBid(history[i].call);
            if (p && p.strain !== 'NT') bidSuitsBefore.add(p.strain);
        }
    }
    let candidates = ['S', 'H', 'D', 'C'].filter(s => !bidSuitsBefore.has(s));
    if (candidates.length === 0) candidates = ['S', 'H', 'D', 'C'];
    const fitSuit = candidates.reduce((best, s) => (lengths[s] > lengths[best] ? s : best), candidates[0]);

    // Voir échange avec Guillaume (donne 3, session du 30 juillet) : si AUCUNE des
    // couleurs candidates n'atteint 4 cartes chez moi, il n'y a pas de vrai fit à offrir
    // (2 cartes ne suffisent pas) — forcer quand même l'une des deux au palier 3 n'a pas
    // de sens. Critère de "régularité" volontairement plus large qu'isHandBalancedForNT
    // ici (qui exige au plus UN doubleton, pensé pour une vraie ouverture/rebid à SA) :
    // ce qui compte pour justifier SA à la place d'un fit inexistant, c'est l'absence de
    // chicane/singleton, pas la stricte régularité — une main 2-2-4-5 (deux doubletons)
    // reste parfaitement jouable à SA une fois qu'on sait qu'aucun fit de 4+ n'existe.
    const hasRealFit = candidates.some(s => lengths[s] >= 4);
    const noShortness = ['S', 'H', 'D', 'C'].every(s => lengths[s] >= 2);
    if (!hasRealFit && noShortness) {
        if (hl + 8 >= GAME_ZONE_NT) {
            const call = '3NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        if (hl >= 15) {
            const call = '2NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        const call = '1NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    // Voir échange avec Guillaume (donne 1, session du 30 juillet, précisé après test) :
    // le contre du partenaire promet 8H+ SANS LIMITE HAUTE — un simple palier fixe selon
    // mon HCP brut (l'ancienne version) ignorait complètement ma propre distribution une
    // fois le fit connu (chicane, longueurs 6ème/5ème...) et le fait que la concurrence
    // adverse peut déjà avoir consommé la place des paliers bas, faussant "palier minimum
    // = main minimale". Bascule sur les points de SOUTIEN (HLD, chicane/longueur
    // comprises maintenant que le fit est identifié — voir computeSupportPoints),
    // combinés au plancher du contre (8), comparés aux vraies zones de manche/chelem du
    // moteur (mêmes constantes qu'ailleurs) — pas un palier arbitraire.
    const partnerFloor = 8;
    const supportPoints = computeSupportPoints(hand, fitSuit, 4);
    const isMajor = fitSuit === 'S' || fitSuit === 'H';
    const gameZone = isMajor ? GAME_ZONE_MAJOR : GAME_ZONE_MINOR;
    const gameLevel = isMajor ? 4 : 5;

    let minLegalLevel = null;
    for (let level = 1; level <= 7; level++) {
        if (isCallLegal(history, level + fitSuit, seat)) { minLegalLevel = level; break; }
    }
    if (minLegalLevel === null) return 'PASS';

    if (supportPoints + partnerFloor >= SLAM_ZONE_GRAND) {
        const call = '7' + fitSuit;
        if (isCallLegal(history, call, seat)) return call;
    }
    if (supportPoints + partnerFloor >= SLAM_ZONE_SMALL) {
        const call = '6' + fitSuit;
        if (isCallLegal(history, call, seat)) return call;
    }

    let targetLevel;
    // Voir échange avec Guillaume (donne 3, session du 31 juillet) : la manche en
    // majeure se juge normalement à 27HLD (points de soutien, distribution comprise),
    // mais un repli plus simple existe aussi — à 25H BRUTS (sans distribution), la
    // manche fonctionne également. Utile précisément quand les points de soutien
    // n'ajoutent aucun bonus (main sans chicane ni longueur excédentaire, comme ici :
    // 18H + plancher du contre à 8 = 26, sous les 27HLD requis, mais au-dessus des 25H
    // bruts). Réservé aux majeures — pas de repli équivalent mentionné pour les mineures.
    const altHcpGameZoneForMajor = 25;
    if (supportPoints + partnerFloor >= gameZone || (isMajor && hcp + partnerFloor >= altHcpGameZoneForMajor)) targetLevel = gameLevel; // manche acquise avec le plancher du contre
    else if (supportPoints >= 15) targetLevel = 3; // invite : nettement au-dessus d'une ouverture minimale
    else targetLevel = 1; // minimum

    for (let level = Math.max(targetLevel, minLegalLevel); level <= 7; level++) {
        const call = fitSuit === 'NT' ? level + 'NT' : level + fitSuit;
        if (isCallLegal(history, call, seat)) return call;
    }
    return 'PASS';
}

function decideDoublerFollowUp(hand, hcp, hl, partnerResponseCall, seat, history, wasReopeningDouble) {
    const lengths = suitLengths(hand);
    const responseBid = parseBid(partnerResponseCall);
    if (!responseBid) return 'PASS'; // partenaire qui a lui-même contré/passé à ce stade : hors périmètre, filet de sécurité

    // Suite du "contre toute distribution" (voir échange avec Guillaume, donne 2, et
    // decideRobotIntervention) : avec 19HL+, mon contre initial n'était pas un simple
    // contre d'appel classique mais une annonce de force — je montre maintenant ma vraie
    // couleur naturellement (au palier minimal légal, pas de saut — la force est déjà
    // annoncée par la séquence elle-même), plutôt que de pousser la couleur choisie par
    // le partenaire, qui ne connaît pas encore ma vraie main. Priorité sur la logique
    // normale ci-dessous, pensée pour un contre d'appel standard (12-18HL). Valable que
    // le contre ait été fait en direct ou en réveil — "toute distribution" n'est pas une
    // convention propre au réveil.
    // Généralisé (session du 24 juillet, voir échange avec Guillaume — contre de RÉVEIL
    // sur une couleur 5ème, 13H+) : même geste, mais avec 13H+ (H purs, pas HL) dès lors
    // qu'il y a une vraie couleur 5ème à montrer. Restreint au RÉVEIL (session du 25
    // juillet, donne 6 — nouveau bug) : cette version allégée du seuil (13H au lieu de
    // 19HL) n'est justifiée QUE par la tolérance propre au réveil — un contre d'appel
    // DIRECT classique n'a pas cette même excuse, 19HL+ reste le seul seuil valable pour
    // lui.
    const myLongSuit = longestSuitPreferHigh(lengths);
    if (hl >= 19 || (wasReopeningDouble && hcp >= 13 && lengths[myLongSuit] >= 5)) {
        const suit = myLongSuit;
        for (let level = responseBid.level; level <= 7; level++) {
            const call = level + suit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume (session du 24 juillet, donne 3) : suite du contre de
    // réveil "main plate 13-16H sans couleur 5ème" (voir decideRobotIntervention) — pas
    // de vraie couleur à montrer (lengths[myLongSuit]<5, sinon la branche au-dessus
    // aurait déjà déclenché), donc SA plutôt qu'une couleur ou un soutien hasardeux.
    // Placé APRÈS la branche "vraie couleur" ci-dessus (qui a priorité si elle
    // s'applique) mais AVANT le soutien de la couleur du partenaire plus bas, qui
    // masquerait sinon cette main plate derrière un simple relais dans sa couleur.
    // Restreint au RÉVEIL (session du 25 juillet, donne 6 — nouveau bug) : c'est une
    // convention propre au réveil (voir decideRobotIntervention) — un contre d'appel
    // DIRECT classique a déjà tout dit en une seule annonce (12-18HL), rien ne justifie
    // de reparler juste parce que la main tombe dans cette fourchette précise.
    if (wasReopeningDouble && hcp >= 13 && hcp <= 16 && isHandBalancedForNT(lengths)) {
        for (let level = Math.max(responseBid.level, 1); level <= 7; level++) {
            const call = level + 'NT';
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume (session du 24 juillet) : bascule sur HLD
    // (computeSupportPoints) — la couleur du partenaire est un fit confirmé (au moins 3
    // cartes chez moi), donc mes propres points de longueur (HCP brut utilisé jusqu'ici)
    // ne reflètent plus la vraie valeur de ma main par rapport à CET atout précis.
    // Longueur garantie du partenaire non fiable ici (une réponse à un contre peut être
    // un simple relais dans la couleur la moins pire, pas une vraie annonce de longueur)
    // — traitée prudemment à 0, seule la valeur des courtes ailleurs est comptée, pas de
    // bonus de 9ème atout hasardeux.
    if (lengths[responseBid.strain] >= 3) {
        const supportPoints = computeSupportPoints(hand, responseBid.strain, 0);
        // Minimum présumé du partenaire à 0 (pas SIMPLE_RAISE_MINIMUM) : une réponse au
        // contre est quasi obligatoire même sans le moindre point (voir
        // decideRobotResponseToDouble, "jamais de main punitive"), contrairement à un
        // simple soutien qui promet toujours un peu — barre volontairement conservatrice
        // pour le chelem ici.
        if (supportPoints + 0 >= SLAM_ZONE_GRAND) {
            const call = '7' + responseBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
        if (supportPoints + 0 >= SLAM_ZONE_SMALL) {
            const call = '6' + responseBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
        if (supportPoints >= 15) {
            const isMajor = responseBid.strain === 'S' || responseBid.strain === 'H';
            const gameLevel = isMajor ? 4 : 5;
            // Voir échange avec Guillaume (outil de simulation, session du 30 juillet —
            // bug trouvé, même famille que le "6D" déjà corrigé ailleurs) : si le
            // partenaire a DÉJÀ atteint (ou dépassé) ce palier de manche de lui-même,
            // chercher "la prochaine case légale" à partir de là sauterait au chelem par
            // accident (mes 15+ points de soutien ne suffisent pas au chelem tout seuls,
            // voir les deux vérifications juste au-dessus qui auraient déjà répondu sinon).
            if (responseBid.level < gameLevel) {
                for (let level = gameLevel; level <= 7; level++) {
                    const call = level + responseBid.strain;
                    if (isCallLegal(history, call, seat)) return call;
                }
            }
        }
    }

    // Voir échange avec Guillaume (donne 2, 2e jeu, puis généralisé donne 8, session du 31
    // juillet — "je t'ai dit qu'il fallait faire un cue-bid") : au-delà de tout ce qui
    // précède, filet partagé (voir decideGameForcingFallbackAfterOvercall juste en
    // dessous) — mon camp doit-il de toute façon jouer la manche ? Si oui, je ne peux
    // JAMAIS me contenter d'un simple passe (ni d'un soutien approximatif qui sous-décrit
    // la main) : couleur naturelle 5+ > SA si arrêt > cue-bid par défaut.
    const myDoubleEntry = history.find(e => e.seat === seat && isDouble(e.call));
    const myDoubleIndex = myDoubleEntry ? history.indexOf(myDoubleEntry) : -1;
    const doubledBid = myDoubleIndex > 0 ? parseBid(history[myDoubleIndex - 1].call) : null;
    const opponentSuit = doubledBid ? doubledBid.strain : null;
    const gameForcingFallback = decideGameForcingFallbackAfterOvercall(hand, hcp, seat, history, opponentSuit, responseBid.strain);
    if (gameForcingFallback) return gameForcingFallback;
    return 'PASS';
}

// Voir échange avec Guillaume (donne 2, 2e jeu, puis généralisé donne 8, session du 31
// juillet — "je t'ai dit qu'il fallait faire un cue-bid ...") : factorisé en fonction
// partagée — le même principe s'applique aussi bien à la suite du CONTREUR
// (decideDoublerFollowUp, où le contexte donne directement la couleur adverse via le
// contre lui-même) qu'à une réponse DIRECTE à l'ouverture du partenaire quand un
// adversaire est intervenu entre les deux (decideRobotResponse) — un seul et même
// principe : mon camp a-t-il de quoi jouer la manche (HCP propre + plancher d'ouverture
// du partenaire ≥ GAME_ZONE_NT) sans couleur annonçable (5+ cartes) ni arrêt dans la
// couleur adverse ? Alors, par défaut, cue-bid dans cette couleur adverse — jamais un
// passe, jamais un soutien approximatif qui sous-décrit une main de cette force.
// `alreadyShownSuit` exclut en plus la couleur que MOI j'ai déjà montrée/vais montrer
// (celle du partenaire) de la recherche de couleur naturelle.
function decideGameForcingFallbackAfterOvercall(hand, hcp, seat, history, opponentSuit, alreadyShownSuit) {
    if (!opponentSuit) return null;
    if (hcp + OPENING_MINIMUM < GAME_ZONE_NT) return null;
    const lengths = suitLengths(hand);

    const alreadyShownSuits = new Set([opponentSuit, alreadyShownSuit].filter(Boolean));
    const naturalSuit = ['S', 'H', 'D', 'C'].find(s => !alreadyShownSuits.has(s) && lengths[s] >= 5);
    if (naturalSuit) {
        for (let level = 2; level <= 7; level++) {
            const call = level + naturalSuit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    const cardsInOpponentSuit = hand[opponentSuit] || '';
    const hasStopperInOpponentSuit = cardsInOpponentSuit.includes('A')
        || (cardsInOpponentSuit.includes('K') && cardsInOpponentSuit.length >= 2)
        || (cardsInOpponentSuit.includes('Q') && cardsInOpponentSuit.length >= 3);
    if (hasStopperInOpponentSuit) {
        for (let level = 2; level <= 7; level++) {
            const call = level + 'NT';
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    for (let level = 2; level <= 7; level++) {
        const call = level + opponentSuit;
        if (isCallLegal(history, call, seat)) return call;
    }
    return null;
}

function decideRobotResponseToDouble(hand, hcp, hl, doubleIndex, seat, history, wasReopeningDouble) {
    const lengths = suitLengths(hand);
    let doubledSuit = null;
    for (let i = doubleIndex - 1; i >= 0; i--) {
        if (isBidCall(history[i].call)) { doubledSuit = parseBid(history[i].call).strain; break; }
    }
    if (!doubledSuit || doubledSuit === 'NT') return 'PASS'; // sécurité, ne devrait pas arriver

    // Voir échange avec Guillaume (donne 4, session du 30 juillet) : réponse "1SA" au
    // contre de RÉVEIL — montre 10-12H, avec un arrêt dans la couleur contrée et pas de
    // majeure 4ème franche à préférer (le X de réveil démarre à 8H, voir
    // decideRobotIntervention ; cette réponse-ci en précise la moitié haute). Priorité
    // sur la recherche d'une couleur plus bas : mieux vaut ça qu'une majeure courte (3
    // cartes) choisie seulement parce que c'est "la plus longue chez soi" parmi des choix
    // tous médiocres. Ne s'applique QUE sur un contre de réveil — un contre d'appel
    // DIRECT classique n'a pas cette convention précise.
    if (wasReopeningDouble) {
        const hasStopper = ['A', 'K', 'Q', 'J', 'T'].filter(r => (hand[doubledSuit] || '').includes(r)).length >= 2;
        const hasFourCardMajor = ['S', 'H'].some(s => lengths[s] >= 4);
        if (hcp >= 10 && hcp <= 12 && hasStopper && !hasFourCardMajor) {
            const call = '1NT';
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume (session du 25 juillet, donne 6 — nouveau bug) : exclut
    // aussi toute couleur déjà annoncée par un ADVERSAIRE depuis le contre (ex. leur
    // réponse naturelle) — sans ça, le choix "la plus longue chez moi" pouvait tomber sur
    // une couleur à égalité de longueur avec une autre, mais que l'adversaire vient
    // justement de montrer lui-même : un non-sens, cette couleur n'a clairement rien
    // d'un bon refuge si l'adversaire y a de la force. Filet de sécurité : si ça ne
    // laisse plus AUCUNE couleur (cas extrême), revient à la liste complète plutôt que
    // de planter.
    const opponentSuitsAfterDouble = new Set();
    for (let i = doubleIndex + 1; i < history.length; i++) {
        const e = history[i];
        if (isBidCall(e.call) && partnershipOf(e.seat) !== partnershipOf(seat)) {
            const p = parseBid(e.call);
            if (p && p.strain !== 'NT') opponentSuitsAfterDouble.add(p.strain);
        }
    }
    let candidates = ['S', 'H', 'D', 'C'].filter(s => s !== doubledSuit && !opponentSuitsAfterDouble.has(s));
    if (candidates.length === 0) candidates = ['S', 'H', 'D', 'C'].filter(s => s !== doubledSuit);
    const bestSuit = candidates.reduce((best, s) => (lengths[s] > lengths[best] ? s : best), candidates[0]);

    // Voir échange avec Guillaume (donne 2, session du 23 juillet) : plus de "passe de
    // pénalité" ici pour un contre encore BON MARCHÉ (palier 1 toujours disponible) — les
    // bots traitent tous les contres comme des contres d'appel, jamais punitifs, donc on
    // ne laisse jamais filer le contre du partenaire quand ça ne coûte rien de répondre,
    // même dans 3 cartes seulement, faute de meilleure enchère.
    //
    // Voir échange avec Guillaume (session du 25 juillet, donne 6, précisé encore) :
    // NUANCE IMPORTANTE quand un ADVERSAIRE est intervenu depuis le contre, poussant la
    // réponse la moins chère au palier 2 (comme ici) — le calcul change du tout au tout.
    // Le contre ne garantit que 12H+ et pas forcément 4 cartes dans la couleur choisie
    // (un contre "4♠3♥" par exemple) : monter au palier 2 dans une couleur de seulement
    // 3 cartes n'a alors plus aucune justification, misfit évident. Seuils exacts (ses
    // mots) : 4+ cartes → on répond toujours (le fit est réel, quel que soit le palier) ;
    // avec seulement 3 cartes ET repoussé au palier 2, il faut au moins 8H pour un repli
    // à SA (1SA montre 8-10H en réponse au contre) ; en dessous, le passe est la
    // meilleure enchère — pas de raison de fabriquer une couleur dans seulement 3 cartes.
    const bestLen = lengths[bestSuit];
    let minLevelForBestSuit = null;
    for (let level = 1; level <= 7; level++) {
        if (isCallLegal(history, level + bestSuit, seat)) { minLevelForBestSuit = level; break; }
    }
    const pushedToLevel2Plus = bestLen < 4 && minLevelForBestSuit !== null && minLevelForBestSuit >= 2;
    if (pushedToLevel2Plus) {
        if (hcp >= 8) {
            const ntCall = '1NT';
            if (isCallLegal(history, ntCall, seat)) return ntCall;
        }
        return 'PASS';
    }

    // Points de soutien (voir échange avec Guillaume, donne 4 : main de 8H comptée à 10
    // avec la courte) plutôt que HL brut — le contre du partenaire ne garantit pas de
    // longueur précise dans la couleur choisie, on prend 3 cartes comme minimum par
    // défaut (cohérent avec le reste du moteur pour une ouverture à la mineure).
    const supportPoints = computeSupportPoints(hand, bestSuit, 3);

    // Voir échange avec Guillaume (donne 3, session du 31 juillet — "bah oui fais-le") :
    // main nettement excédentaire (18H+, exactement son exemple : "Ouest qui a 18H et 4
    // cartes à Cœur conclut logiquement" à la manche directement) — cette fonction n'avait
    // jusqu'ici AUCUN palier "conclure à la manche", seulement un choix de palier 1 ou 2
    // selon les points de soutien (startLevel plus bas). Même méthodologie que
    // isRaiseOfMySuit dans decideRobotOpenerRebid (chelem par points d'abord, puis
    // manche) plutôt que d'inventer un mécanisme distinct pour ce contexte.
    if (supportPoints + SIMPLE_RAISE_MINIMUM >= SLAM_ZONE_GRAND) {
        const call = '7' + bestSuit;
        if (isCallLegal(history, call, seat)) return call;
    }
    if (supportPoints + SIMPLE_RAISE_MINIMUM >= SLAM_ZONE_SMALL) {
        const call = '6' + bestSuit;
        if (isCallLegal(history, call, seat)) return call;
    }
    if (supportPoints >= 18) {
        const isMajor = bestSuit === 'S' || bestSuit === 'H';
        const gameLevel = isMajor ? 4 : 5;
        for (let level = gameLevel; level <= 7; level++) {
            const call = level + bestSuit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    const startLevel = supportPoints >= 10 ? 2 : 1;
    for (let level = startLevel; level <= 7; level++) {
        const call = level + bestSuit;
        if (isCallLegal(history, call, seat)) return call;
    }
    // Filet : si la couleur préférée n'est jouable à aucun palier (ne devrait
    // essentiellement jamais arriver), tente les deux autres avant d'abandonner.
    for (const s of candidates) {
        for (let level = 1; level <= 7; level++) {
            const call = level + s;
            if (isCallLegal(history, call, seat)) return call;
        }
    }
    return 'PASS';
}

// Vrai si la répartition est EXACTEMENT 5-3-3-2 (pas 4-3-3-3 ni 4-4-3-2, contrairement à
// isHandBalancedForNT plus général) — voir échange avec Guillaume, donne 1 : c'est cette
// répartition précise qui déclenche 2SA dans son rebid après un 2/1 forcing de manche.
function isExactly5332(lengths) {
    const values = ['S', 'H', 'D', 'C'].map(s => lengths[s]).sort((a, b) => b - a);
    return values[0] === 5 && values[1] === 3 && values[2] === 3 && values[3] === 2;
}

// Main "régulière" au sens large (voir échange avec Guillaume, donnes 3/5/7/8) : les 3
// répartitions classiques 4333/4432/5332 précisément — pas juste "pas de chicane ni de
// 6+" (bug trouvé en testant : ça laissait passer un 5422, qui n'est PAS une main
// régulière et mérite un vrai bicolore, pas un repli SA). Sert de garde-fou pour la
// redemande de l'ouvreur : une main régulière ne doit jamais prétendre avoir un vrai
// bicolore (voir la recherche de 2ème couleur plus bas), et doit plutôt se décrire via
// 1SA/2SA selon sa force.
function isBalanced(lengths) {
    const values = ['S', 'H', 'D', 'C'].map(s => lengths[s]).sort((a, b) => b - a);
    const pattern = values.join('');
    return pattern === '4333' || pattern === '4432' || pattern === '5332';
}

// Rebid de l'ouvreur après une réponse en changement de couleur (voir échange avec
// Guillaume, donnes 1 et 5 : forcing quel que soit le palier, 1 ou 2 — pas seulement le
// 2/1 sur majeure) : 15H+ avec une répartition EXACTEMENT 5332 -> 2SA ; sinon (12-14H, ou
// 15H+ mais irrégulière) -> bicolore économique (2e couleur de 4+ cartes, autre que celle
// déjà ouverte et celle du partenaire, au palier le moins cher possible) ; à défaut,
// répète sa couleur d'ouverture. Pas de main "monstre" séparée ici : le filet 18HL+ plus
// haut (isRaiseOfMySuit) ne s'applique de toute façon pas dans ce cas précis, où le
// partenaire n'a pas soutenu ma couleur mais changé de couleur.
function decideOpenerRebidAfterNewSuit(hand, hcp, hl, myBid, partnerParsed, seat, history, opponentIntervened) {
    const lengths = suitLengths(hand);

    // Fit pour la couleur du partenaire (voir échange avec Guillaume, donnes 5 et 7) :
    // priorité ABSOLUE sur toute idée de montrer une 2e couleur perso, mais seulement à
    // partir de 4 cartes chez moi — une réponse en changement de couleur ne garantit que
    // 4+ chez le partenaire (jamais 5+, contrairement à une ouverture à la majeure), donc
    // il faut mes 4+ pour atteindre un vrai fit de 8 cartes ; avec seulement 3, ce n'est
    // pas un fit exploitable (voir donne 5 : bug trouvé en corrigeant donne 7 — Nord n'a
    // que 3 cœurs là-bas, la main mérite de montrer sa propre 2e couleur à la place).
    // Mêmes zones que pour les ouvertures : 12-14H = soutien simple (palier minimal
    // légal) ; 15-17H = invite (palier 3) ; 18H+ = manche directe (palier 4 pour une
    // majeure, 5 pour une mineure).
    // Voir échange avec Guillaume ("HL avant un fit, HLD après — jamais de retour au HCP
    // brut", session du 30 juillet) : même bug que celui déjà corrigé dans
    // decideOpenerResponseToPartnerDouble — un fit de 4+ cartes vient d'être confirmé
    // (lengths[partnerParsed.strain]>=4 ci-dessus), donc c'est en points de SOUTIEN
    // (HLD, chicane/distribution comprises pour CETTE couleur d'atout précise) qu'il faut
    // évaluer la suite, plus en HCP brut.
    if (lengths[partnerParsed.strain] >= 4) {
        const fitSuit = partnerParsed.strain;
        const isMajorFit = fitSuit === 'S' || fitSuit === 'H';
        const supportPointsForFit = computeSupportPoints(hand, fitSuit, 4);
        let targetLevel = partnerParsed.level;
        if (supportPointsForFit >= 18) targetLevel = isMajorFit ? 4 : 5;
        else if (supportPointsForFit >= 15) targetLevel = 3;

        for (let level = Math.max(targetLevel, partnerParsed.level); level <= 7; level++) {
            const call = level + fitSuit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // 4SA quantitatif (voir échange avec Guillaume, donne 2, session du 21 juillet) : pas
    // de fit trouvé ci-dessus, mais une main tellement excédentaire (22HL+) qu'elle
    // dépasse toutes les autres enchères de cette fonction (1SA/2SA de repli, bicolore,
    // répétition) — même dans le pire des cas (partenaire minimal, 6H pour sa réponse),
    // 22+6=28 justifie déjà la manche ; dans le meilleur des cas (partenaire avec un peu
    // plus, ex. 11H), 22+11=33 est en zone de petit chelem. "4SA" pose la question sans
    // s'engager : le partenaire dit 6SA avec un maximum, reste à 4SA avec un minimum
    // (voir la suite du répondant, décidée ailleurs). Pas une vraie enchère de contrôle
    // (Blackwood) — juste un compte de points, comme le chelem direct de la donne 6.
    if (hl >= 22) {
        const call = '4NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    if (hcp >= 15 && isExactly5332(lengths)) {
        const call = '2NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    // Main régulière (voir échange avec Guillaume, donnes 3/5/7/8) : au-delà du cas
    // précis ci-dessus (15H+ exactement 5332), toute main régulière (4333/4432/5332,
    // voir isBalanced) doit se décrire par 1SA ou 2SA plutôt que de chercher un bicolore
    // qu'elle n'a pas vraiment (donne 7 : une main 4432 n'a que 4 cartes dans sa 2e
    // couleur, ce n'est pas un vrai bicolore) — priorité sur la recherche de 2e couleur
    // plus bas. En pratique, dans ce contexte précis (une couleur déjà ouverte, donc pas
    // 1SA/2SA directs), seules deux fourchettes de points sont possibles : sous 15H
    // (n'aurait pas ouvert 1SA/2SA directement) ou 18H+ (trop fort pour 1SA 15-17, pas
    // encore 20-21 pour 2SA direct) — 15-17H régulière aurait déjà ouvert 1SA.
    if (isBalanced(lengths)) {
        if (hcp >= 18) {
            const call = '2NT';
            if (isCallLegal(history, call, seat)) return call;
        } else {
            const call = '1NT';
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Bicolore : cherche le palier minimal légal pour chaque couleur candidate (4+
    // cartes, autre que l'ouverture et celle du partenaire), puis écarte celles qui
    // exigeraient un "reverse" — rang SUPÉRIEUR à l'ouverture ET palier 2+ pour l'annoncer
    // (donc le partenaire devrait monter d'un cran pour revenir à ma 1ère couleur) — tant
    // que la main n'a pas 17HL+ ET au moins 5 cartes dans SA PROPRE couleur d'ouverture
    // (voir échange avec Guillaume, donne 8 : un "bicolore cher" sans vraie 5ème dans la
    // 1ère couleur — ex. une mineure ouverte à 3 cartes par défaut — ne doit jamais
    // renverser, la main est en réalité régulière et déjà traitée ci-dessus). Un bicolore
    // économique au palier 1, comme 1♣ puis 1♠, n'est JAMAIS un reverse, quel que soit le
    // rang des couleurs (voir échange avec Guillaume, donnes 5 et 6).
    // Voir échange avec Guillaume (donne 3, session du 30 juillet — même famille que le
    // bug déjà corrigé dans decideRobotResponse) : jamais une couleur déjà annoncée par
    // un ADVERSAIRE parmi les candidates — même avec 4+ cartes chez moi, la nommer
    // ressemblerait à tort à un cue-bid (demande d'arrêt dans SA couleur) plutôt qu'à un
    // vrai bicolore personnel.
    const opponentSuitsForBicolore = new Set();
    history.forEach(e => {
        if (isBidCall(e.call) && partnershipOf(e.seat) !== partnershipOf(seat)) {
            const p = parseBid(e.call);
            if (p && p.strain !== 'NT') opponentSuitsForBicolore.add(p.strain);
        }
    });
    const candidates = ['S', 'H', 'D', 'C'].filter(s => s !== myBid.strain && s !== partnerParsed.strain && !opponentSuitsForBicolore.has(s) && lengths[s] >= 4);
    let secondSuit = null;
    let secondSuitLevel = null;
    for (const s of candidates) {
        let naturalLevel = null;
        for (let level = 1; level <= 7; level++) {
            if (isCallLegal(history, level + s, seat)) { naturalLevel = level; break; }
        }
        if (naturalLevel === null) continue;
        const isReverse = STRAIN_RANK[s] > STRAIN_RANK[myBid.strain] && naturalLevel >= 2;
        if (isReverse && (hl < 17 || lengths[myBid.strain] < 5)) continue; // pas les moyens de le montrer, ou pas une vraie 5ème dans la 1ère couleur
        if (!secondSuit || lengths[s] > lengths[secondSuit]) {
            secondSuit = s;
            secondSuitLevel = naturalLevel;
        }
    }
    if (secondSuit) {
        const call = secondSuitLevel + secondSuit;
        if (isCallLegal(history, call, seat)) return call;
    }

    // Voir échange avec Guillaume (donne 3, session du 30 juillet, précisé) : aucun
    // bicolore trouvé (les couleurs candidates étaient soit trop courtes, soit exclues
    // car déjà annoncées par l'adversaire, voir opponentSuitsForBicolore ci-dessus) —
    // dans le silence adverse, cette main aurait montré son bicolore cher directement ;
    // ici elle ne peut plus, il faut une enchère de substitution. Si ma main n'a AUCUNE
    // chicane/singleton ET un arrêt dans au moins une des couleurs adverses exclues,
    // "2SA" (18-19HL, main semi-régulière) est ce substitut — une vraie fourchette
    // bornée, pas juste un plancher.
    if (!secondSuit) {
        const noShortnessForNT = ['S', 'H', 'D', 'C'].every(s => lengths[s] >= 2);
        const hasStopperInExcludedSuit = Array.from(opponentSuitsForBicolore).some(s => {
            const cards = hand[s] || '';
            return lengths[s] >= 2 && ['A', 'K', 'Q'].some(r => cards.includes(r));
        });
        if (noShortnessForNT && hasStopperInExcludedSuit && hl >= 18 && hl <= 19) {
            const call = '2NT';
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — bug
    // trouvé : une main de 18H/20HL avec 6 cartes à sa couleur d'ouverture, sans fit, sans
    // bicolore ni forme régulière à montrer, redemandait au palier minimal comme
    // n'importe quelle main faible — empêchant ensuite le partenaire d'évaluer
    // correctement une invite ultérieure, faute d'avoir jamais appris cette réserve).
    // Avec une vraie 6ème+ carte ET assez de réserve (16HL+), un SAUT dans ma propre
    // couleur montre cette force — le partenaire pourra alors correctement soutenir ou
    // relancer une invite plus tard. En dessous, la redemande reste au palier minimal
    // (main vraiment limitée, rien à ajouter) — voir le filet juste en dessous.
    if (lengths[myBid.strain] >= 6 && hl >= 16) {
        let naturalLevelForRepeat = null;
        for (let level = 1; level <= 7; level++) {
            if (isCallLegal(history, level + myBid.strain, seat)) { naturalLevelForRepeat = level; break; }
        }
        if (naturalLevelForRepeat !== null) {
            for (let level = naturalLevelForRepeat + 1; level <= 7; level++) {
                const call = level + myBid.strain;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
    }

    // "Moins mauvaise enchère" (voir échange avec Guillaume) : tant que personne d'autre
    // n'est intervenu, une réponse en changement de couleur est forcing — on ne doit
    // JAMAIS passer ici, même sans option pleinement satisfaisante. Répéter sa couleur
    // (même sans remplir le garde-fou "honnête" habituel — 6+ cartes, ou 5 avec une
    // chicane, voir échange avec Guillaume, donne 7 de la session précédente) reste la
    // moins mauvaise option s'il ne reste vraiment rien d'autre : mieux vaut sur-décrire
    // légèrement une main que laisser passer une enchère forcing, ce qui serait une
    // erreur bien plus grave.
    // Ce filet-ci (contrairement à la vérification de fit et au reste de la fonction,
    // toujours actifs) ne s'applique QUE si aucun adversaire n'est intervenu depuis
    // (voir échange avec Guillaume, donne 5) : une fois la concurrence entrée en jeu, ce
    // n'est plus vraiment forcing — passer redevient une sortie légitime si rien de mieux
    // n'a été trouvé plus haut dans cette fonction.
    if (!opponentIntervened) {
        for (let level = partnerParsed.level; level <= 7; level++) {
            const call = level + myBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
    }
    return 'PASS'; // filet de sécurité ultime, ne devrait normalement jamais être atteint
}


// Rebid de l'OUVREUR (voir échange avec Guillaume) : sans lui, un ouvreur avec une main
// bien plus forte qu'une ouverture minimale (18HL+) reste bloqué dès que le partenaire a
// répondu quelque chose, même s'il est évident qu'il faut reparler (ex. 22H qui passent
// sur une réponse minimale). Volontairement TRÈS borné pour rester sûr : une seule
// occasion de rebid par donne (voir decideRobotCall, qui ne l'autorise que si l'ouvreur
// n'a encore parlé qu'une fois ET que la dernière annonce réelle est celle du partenaire).
// Deux déclencheurs INDÉPENDANTS du seuil de 18HL+ (voir échange avec Guillaume) :
//   - loi des atouts (6+ cartes à sa couleur, fit connu grâce au soutien du partenaire) ;
//   - 2/1 forcing de manche (réponse en changement de couleur au palier 2 sur une
//     ouverture d'1 majeure), qui OBLIGE l'ouvreur à reparler quels que soient ses points.
// Ne couvre pas les enchères d'essai, de contrôle, ni les séquences différées à 2 tours du
// document SEF fourni par Guillaume — juste de quoi éviter les partiels absurdes.
// Rebid de l'ouvreur d'un barrage (2 faible, 3, 4 — voir decideRobotOpening) après une
// réponse forcing du partenaire en nouvelle couleur (voir échange avec Guillaume, donne 8)
// : avec un fit pour SA couleur (3+ cartes) ET une main en haut de la fourchette du
// barrage (8-12HL, "zone haute" = 11HL+), pousse directement à la manche — le partenaire
// a déjà dit tout ce qu'il avait à dire avec son enchère forcing, inutile d'attendre.
// Sinon, répète sa propre couleur au palier minimal légal : rien de plus à ajouter.
function decideOpenerRebidAfterWeakTwoForcing(hand, hcp, hl, myBid, partnerParsed, seat, history) {
    const lengths = suitLengths(hand);

    // Voir échange avec Guillaume ("HL avant un fit, HLD après", session du 30 juillet) :
    // fit de 3+ cartes confirmé dans la couleur du partenaire (sa réponse forcing) —
    // points de SOUTIEN (HLD), pas HL brut. 4+ cartes garanties chez le partenaire, comme
    // toute réponse en changement de couleur dans ce moteur (jamais 5+ promis).
    if (lengths[partnerParsed.strain] >= 3) {
        const supportPointsForWeakTwo = computeSupportPoints(hand, partnerParsed.strain, 4);
        if (supportPointsForWeakTwo >= 11) {
            const gameLevel = (partnerParsed.strain === 'S' || partnerParsed.strain === 'H') ? 4 : 5;
            for (let level = Math.max(gameLevel, partnerParsed.level); level <= 7; level++) {
                const call = level + partnerParsed.strain;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
    }

    for (let level = partnerParsed.level; level <= 7; level++) {
        const call = level + myBid.strain;
        if (isCallLegal(history, call, seat)) return call;
    }
    return 'PASS';
}

// Voir échange avec Guillaume (outil de simulation, session du 30 juillet) : réponse de
// l'OUVREUR au splinter du répondant (voir decideRobotMajorSupport) — jamais un simple
// passe : le splinter promet déjà 13-15 points de soutien + un fit de 4+ connu, largement
// la manche à lui seul (12 de mon propre plancher d'ouverture + 13 minimum chez lui = 25,
// déjà au-dessus de la zone de manche même à la mineure). Ajustement simplifié : les
// honneurs (hors As, toujours utile comme contrôle) que je tiens dans LA COULEUR COURTE
// annoncée par le partenaire sont probablement peu utiles (chicane/singleton chez lui —
// pas de levée à y perdre qu'un ruff n'empêcherait de toute façon).
function decideOpenerResponseToSplinter(hand, hcp, hl, myBid, partnerParsed, seat, history) {
    const shortSuit = partnerParsed.strain;
    let supportPoints = computeSupportPoints(hand, myBid.strain, 4);

    const shortSuitCards = hand[shortSuit] || '';
    const hasAceThere = shortSuitCards.includes('A');
    const hasWastedHonor = !hasAceThere && (shortSuitCards.includes('K') || shortSuitCards.includes('Q'));
    if (hasWastedHonor) supportPoints -= 3;

    const isMajor = myBid.strain === 'S' || myBid.strain === 'H';
    const gameLevel = isMajor ? 4 : 5;

    // Plancher du partenaire (13, le bas de sa fourchette 13-15) utilisé pour le chelem :
    // en dessous, pas la peine de risquer le chelem sur un espoir seulement — la manche,
    // elle, est de toute façon déjà acquise quel que soit où il se situe dans sa fourchette.
    let targetLevel = gameLevel;
    if (supportPoints + 13 >= SLAM_ZONE_GRAND) targetLevel = 7;
    else if (supportPoints + 13 >= SLAM_ZONE_SMALL) targetLevel = 6;

    for (let level = targetLevel; level <= 7; level++) {
        const call = level + myBid.strain;
        if (isCallLegal(history, call, seat)) return call;
    }
    return 'PASS';
}

// Voir échange avec Guillaume (donne 5, session du 31 juillet — "il n'y a aucune raison de
// passer sur une enchère de cue-bid, le bot le fait beaucoup trop") : réponse de l'OUVREUR
// à la suite du répondant après avoir complété MÉCANIQUEMENT un Texas MINEUR (voir
// wasMinorTransferAsk dans decideRobotResponse, et le rebid mécanique correspondant dans
// decideRobotOpenerRebid) — cette complétion ne disait RIEN sur ma main. Sa suite ici (une
// couleur = sa courte, ou "SA" = main régulière, voir wasMinorTransferAsk) EST la première
// fois qu'il montre une vraie valeur au-delà du transfert (6+ cartes déjà garanties dans la
// mineure) : jamais un simple contrat à passer, la manche dans cette mineure est acquise au
// minimum. Même mécanique que decideOpenerResponseToSplinter juste au-dessus (honneurs
// dévalués dans sa courte, chelem jugé sur un plancher partenaire prudent de 13).
function decideOpenerResponseAfterMinorTransferContinuation(hand, shownMinor, partnerShortSuit, seat, history) {
    let supportPoints = computeSupportPoints(hand, shownMinor, 6);

    if (partnerShortSuit) {
        const shortSuitCards = hand[partnerShortSuit] || '';
        const hasAceThere = shortSuitCards.includes('A');
        const hasWastedHonor = !hasAceThere && (shortSuitCards.includes('K') || shortSuitCards.includes('Q'));
        if (hasWastedHonor) supportPoints -= 3;
    }

    let targetLevel = 5;
    if (supportPoints + 13 >= SLAM_ZONE_GRAND) targetLevel = 7;
    else if (supportPoints + 13 >= SLAM_ZONE_SMALL) targetLevel = 6;

    for (let level = targetLevel; level <= 7; level++) {
        const call = level + shownMinor;
        if (isCallLegal(history, call, seat)) return call;
    }
    return 'PASS';
}

function decideRobotOpenerRebid(hand, hcp, hl, myOpeningCall, partnerCall, seat, history, opponentIntervened) {
    const myBid = parseBid(myOpeningCall);
    if (!myBid) return 'PASS';

    // Réponse à Stayman/transfert (voir échange avec Guillaume, donne 4 et donne 8) :
    // purement mécanique pour un transfert (majeur OU mineur, pas de sur-acceptation,
    // hors périmètre) — seul Stayman regarde ma main, pour savoir laquelle des majeures
    // montrer (ou les dénier en carreau). Système unifié : ♦→♥, ♥→♠, ♠→♣ (mineure), et ♣
    // au palier suivant→♦ (l'autre mineure) — jamais de saut, toujours le palier
    // immédiatement supérieur à la demande.
    if (myBid.strain === 'NT') {
        const partnerBid = parseBid(partnerCall);
        if (!partnerBid) return 'PASS'; // partenaire a conclu directement (3SA, etc.) : rien à ajouter
        const lv1 = myBid.level + 1;

        // Stayman (palier ouverture+1, en trèfle) : nomme une majeure si 4+ cartes —
        // priorité aux cœurs si les deux majeures sont 4+ (convention standard, laisse
        // le répondant "corriger" à pique au même palier s'il n'a que 4 piques), sinon
        // dénie en carreau (pas de majeure 4+).
        if (partnerBid.strain === 'C' && partnerBid.level === lv1) {
            const lengths = suitLengths(hand);
            let call;
            if (lengths['H'] >= 4) call = lv1 + 'H';
            else if (lengths['S'] >= 4) call = lv1 + 'S';
            else call = lv1 + 'D';
            if (isCallLegal(history, call, seat)) return call;
        }

        // Transferts (palier ouverture+1, sauf ♣→♦ qui doit aller au palier suivant faute
        // de place — ♣ au palier +1 est déjà pris par Stayman) : complète vers la couleur
        // suivante sans condition.
        if (partnerBid.strain === 'D' && partnerBid.level === lv1) {
            const call = lv1 + 'H';
            if (isCallLegal(history, call, seat)) return call;
        }
        if (partnerBid.strain === 'H' && partnerBid.level === lv1) {
            const call = lv1 + 'S';
            if (isCallLegal(history, call, seat)) return call;
        }
        if (partnerBid.strain === 'S' && partnerBid.level === lv1) {
            const call = (lv1 + 1) + 'C'; // transfert mineur trèfle : palier supérieur, faute de place
            if (isCallLegal(history, call, seat)) return call;
        }
        if (partnerBid.strain === 'C' && partnerBid.level === lv1 + 1) {
            const call = (lv1 + 1) + 'D'; // transfert mineur carreau (l'autre mineure)
            if (isCallLegal(history, call, seat)) return call;
        }

        // Voir échange avec Guillaume (session du 31 juillet, 23h26 — "déjà dit
        // précédemment") : un adversaire est intervenu ENTRE le transfert du partenaire
        // et ma complétion, rendant la case mécanique ci-dessus illégale (déjà dépassée)
        // — les 4 branches précédentes échouaient alors silencieusement, retombant sur
        // "return PASS" plus bas sans même considérer la loi des atouts. Le partenaire a
        // pourtant promis une longueur PRÉCISE et connue (5+ pour une majeure, 6+ pour
        // une mineure) : combinée à ma propre longueur, je CONNAIS le nombre d'atouts à
        // nous deux avec certitude — la loi des atouts s'applique alors indépendamment de
        // la force (ses mots : "on ne prend pas en compte la zone de force mais
        // uniquement le nombre d'atouts — 9 atouts = sécurité distributionnelle au palier
        // de 3"). Formule : palier sûr = (total d'atouts − 6), plafond à ne jamais
        // dépasser — jamais en dessous du palier mécanique normal (déjà tenté ci-dessus).
        let transferredSuitForLawOfTricks = null;
        let promisedLengthForLawOfTricks = null;
        if (partnerBid.strain === 'D' && partnerBid.level === lv1) { transferredSuitForLawOfTricks = 'H'; promisedLengthForLawOfTricks = 5; }
        else if (partnerBid.strain === 'H' && partnerBid.level === lv1) { transferredSuitForLawOfTricks = 'S'; promisedLengthForLawOfTricks = 5; }
        else if (partnerBid.strain === 'S' && partnerBid.level === lv1) { transferredSuitForLawOfTricks = 'C'; promisedLengthForLawOfTricks = 6; }
        else if (partnerBid.strain === 'C' && partnerBid.level === lv1 + 1) { transferredSuitForLawOfTricks = 'D'; promisedLengthForLawOfTricks = 6; }
        if (transferredSuitForLawOfTricks) {
            const lengthsForLawOfTricks = suitLengths(hand);
            const totalTrumps = lengthsForLawOfTricks[transferredSuitForLawOfTricks] + promisedLengthForLawOfTricks;
            const safeLevel = totalTrumps - 6;
            for (let level = 2; level <= safeLevel; level++) {
                const call = level + transferredSuitForLawOfTricks;
                if (isCallLegal(history, call, seat)) return call;
            }
        }

        return 'PASS'; // aucune demande reconnue : rien d'autre géré ici (1SA/2SA déjà bien décrits par ailleurs)
    }

    // Suite de l'ouvreur après 2♦ forcing de manche (voir échange avec Guillaume, session
    // du 30 juillet — CRM moderne) : conclut directement à partir de la réponse CRM du
    // partenaire, voir decideOpenerRebidAfterStrongDiamond. Placé AVANT le 2♣ et le
    // barrage plus bas (même forme générique : palier 2+, réponse en couleur différente).
    if (myOpeningCall === '2D') {
        return decideOpenerRebidAfterStrongDiamond(hand, seat, history, partnerCall);
    }

    // Rebid après un 2♣ fort artificiel (voir échange avec Guillaume, donne 4, précisé
    // session du 30 juillet) : "2SA" pour préciser 22-23HL équilibrée, OU sa propre
    // couleur (la plus longue) si la main a en fait été ouverte via le compte de
    // perdantes (main irrégulière, typiquement un unicolore) — quelle que soit la réponse
    // relais du partenaire (toujours "2D", voir decideRobotResponse). Placé AVANT la
    // branche barrage/2 faible plus bas, qui l'intercepterait sinon à tort (même forme
    // générique : palier 2+, réponse en couleur différente).
    if (myOpeningCall === '2C') {
        const lengthsForStrongRebid = suitLengths(hand);
        if (!isHandBalancedForNT(lengthsForStrongRebid)) {
            const suit = longestSuitPreferHigh(lengthsForStrongRebid);
            for (let level = 2; level <= 7; level++) {
                const call = level + suit;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
        const call = '2NT';
        if (isCallLegal(history, call, seat)) return call;
        return 'PASS'; // filet de sécurité, ne devrait pas arriver (2SA est toujours légal ici)
    }

    const lengths = suitLengths(hand);
    // Reçoit la réponse du partenaire en paramètre plutôt que de la redériver ici via
    // getLastActualBid (voir échange avec Guillaume, donne 2) : si un adversaire est
    // reparlé depuis (séquence compétitive), la dernière annonce de toute l'enchère n'est
    // plus forcément celle du partenaire — c'est l'appelant (decideRobotCall) qui a déjà
    // fait cette recherche correctement.
    const partnerParsed = parseBid(partnerCall);
    const isRaiseOfMySuit = partnerParsed && partnerParsed.strain === myBid.strain;

    // Voir échange avec Guillaume (session du 24 juillet, donne 7) : le partenaire a
    // directement sauté à un contrat de MANCHE OU DE CHELEM dans une AUTRE couleur que la
    // mienne (donc pas un simple soutien, voir isRaiseOfMySuit juste au-dessus) — sans
    // mécanique de cue-bidding/contrôle pour juger d'un éventuel surplus à montrer (hors
    // périmètre), le seul réflexe sûr est de PASSER : "un contrat nommé est un arrêt,
    // sauf surplus qui justifie d'aller plus haut" (ses mots). Sans ce garde-fou, la
    // suite du code traitait ce genre de saut comme une simple nouvelle couleur à bas
    // niveau (voir isNewSuitResponse plus bas), qui cherchait alors à montrer MA propre
    // plus longue au palier immédiatement supérieur — un non-sens à ce niveau, qui a fait
    // déraper une main vers un 7♣ hasardeux sur le 6♦ du partenaire. NT exclu (4NT peut
    // être Blackwood, question du partenaire — pas un simple contrat nommé à accepter).
    // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — trouvé via
    // simulation, un vrai contrat 4♣ jouable en résultait, contre 6♠ une fois corrigé) : le
    // garde-fou juste en dessous ("le partenaire a sauté à un contrat de manche/chelem, je
    // passe") avalait à tort un SPLINTER du répondant (voir decideRobotMajorSupport) — un
    // saut de 2 paliers dans une couleur COURTE, qui n'est PAS un contrat à jouer mais une
    // annonce artificielle (chicane/singleton + 4+ atouts + 13-15 points de soutien). Le
    // distingue AVANT ce garde-fou : le palier naturel pour cette couleur (juste après mon
    // ouverture, avant son saut) doit être exactement 2 de moins que ce qu'il a annoncé.
    if (myBid.level === 1 && (myBid.strain === 'S' || myBid.strain === 'H')
        && partnerParsed && partnerParsed.strain !== myBid.strain && partnerParsed.strain !== 'NT') {
        let naturalLevelForSplinter = null;
        for (let level = 1; level <= 7; level++) {
            if (bidRank(level + partnerParsed.strain) > bidRank(myOpeningCall)) { naturalLevelForSplinter = level; break; }
        }
        if (naturalLevelForSplinter !== null && partnerParsed.level === naturalLevelForSplinter + 2) {
            return decideOpenerResponseToSplinter(hand, hcp, hl, myBid, partnerParsed, seat, history);
        }
    }

    if (partnerParsed && partnerParsed.level >= 4 && partnerParsed.strain !== myBid.strain && partnerParsed.strain !== 'NT') {
        return 'PASS';
    }

    // Voir échange avec Guillaume ("la loi des atouts n'est pas une question de points",
    // session du 30 juillet) : ce garde-fou est maintenant traité plus bas, comme un
    // repli purement basé sur le nombre d'atouts connus (voir juste avant le passe final
    // de la branche isRaiseOfMySuit) — plus de seuil HL ici, qui n'aurait jamais dû
    // exister pour une règle qui ne parle pas de points du tout.

    // Barrage/ouverture faible du partenaire (palier 2+, voir decideRobotOpening) : une
    // réponse en NOUVELLE couleur y est déjà forcing un tour sans qu'un saut ne soit
    // nécessaire pour montrer une main forte (voir échange avec Guillaume, donne 8 — un
    // saut y aurait un tout autre sens, splinter). C'est ici, dans le rebid de l'ouvreur,
    // que la force du barrage (zone haute ou basse) et un éventuel fit décident de
    // pousser à la manche ou non — logique dédiée, différente d'une ouverture naturelle
    // au palier 1 (voir plus bas).
    if (myBid.level >= 2 && partnerParsed && partnerParsed.strain !== myBid.strain && partnerParsed.strain !== 'NT') {
        return decideOpenerRebidAfterWeakTwoForcing(hand, hcp, hl, myBid, partnerParsed, seat, history);
    }

    // Voir échange avec Guillaume (session du 30 juillet, donne 5) : le partenaire
    // vient de répondre à MON PROPRE barrage par "2SA" (l'essai généralisé, voir
    // decideResponseToWeakTwo) — ni fit ni espoir de manche certains de son côté, il me
    // demande où je me situe dans ma propre fourchette de barrage (8-12HL, quel que soit
    // le palier). Haut de fourchette (11-12HL) : j'accepte, manche. Bas (8-10HL) : je
    // décline, retour dans ma couleur au palier minimal.
    if (myBid.level >= 2 && partnerParsed && partnerParsed.strain === 'NT' && partnerParsed.level === 2) {
        const isMajorBarrage = myBid.strain === 'S' || myBid.strain === 'H';
        const gameLevelBarrage = isMajorBarrage ? 4 : 5;
        if (hl >= 11) {
            for (let level = gameLevelBarrage; level <= 7; level++) {
                const call = level + myBid.strain;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
        for (let level = partnerParsed.level; level <= 7; level++) {
            const call = level + myBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
        return 'PASS';
    }

    // Réponse en changement de couleur forcing (voir échange avec Guillaume, donnes 1 et
    // 5) : une réponse en NOUVELLE couleur — palier 1 ou 2, peu importe — n'est jamais
    // limitée par nature (contrairement à un soutien ou une réponse à SA, qui bornent la
    // main) : l'ouvreur DOIT reparler quels que soient ses points, jusqu'à ce que l'un des
    // deux camps sache que la manche n'est pas jouable — contrairement au filet général
    // plus bas, qui ne se déclenche qu'à 18HL+.
    // Voir échange avec Guillaume, donne 5 (session du 22 juillet) : bug trouvé — la
    // vérification de FIT (4+ cartes pour la couleur du partenaire, y compris quand cette
    // couleur vient d'une réponse au contre plutôt qu'une réponse directe) vit à
    // l'intérieur de decideOpenerRebidAfterNewSuit, mais routait seulement si "personne
    // d'autre n'est reparlé depuis" — un contre adverse suivi d'une relance bloquait donc
    // TOTALEMENT cette vérification, alors qu'un vrai fit se soutient "comme dans le
    // silence adverse" (ses mots), que ce soit forcing ou non par ailleurs. Route
    // maintenant TOUJOURS vers cette fonction (le fit se vérifie toujours), et lui passe
    // opponentIntervened pour que SEUL son filet final ("ne jamais passer") en tienne
    // compte, pas la vérification de fit elle-même.
    const isNewSuitResponse = partnerParsed && partnerParsed.strain !== myBid.strain && partnerParsed.strain !== 'NT';
    if (isNewSuitResponse) {
        return decideOpenerRebidAfterNewSuit(hand, hcp, hl, myBid, partnerParsed, seat, history, opponentIntervened);
    }

    // Réponse conventionnelle au soutien direct (voir decideRobotMajorSupport) : "2SA"
    // montre 11-12HLD avec un fit d'EXACTEMENT 3 cartes, "3SA" montre 13-15HLD sans
    // singleton — dans les deux cas l'ouvreur DOIT reparler (voir échange avec Guillaume,
    // donnes 1 et 2), ce n'est pas une main limitée qu'on peut laisser filer comme un
    // simple soutien naturel (isRaiseOfMySuit, resté gardé par le seuil 18HL+ plus bas —
    // un soutien naturel n'a pas la même valeur de fit garantie).
    if (myBid.strain === 'S' || myBid.strain === 'H') {
        if (partnerCall === '2NT') {
            // 12-13H (mini) : accepte le fit au palier minimal (3) sans viser plus haut ;
            // 14H+ : la manche est acquise (12+ garanti côté partenaire, 14+12=26+).
            const call = (hcp >= 14 ? '4' : '3') + myBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
        if (partnerCall === '3NT') {
            // Toujours la manche ici, quelle que soit la force de l'ouvreur : même une
            // ouverture minimale (12H) + 13H du partenaire totalisent déjà 25+, la manche
            // est acquise dans tous les cas.
            const call = '4' + myBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume (session du 25 juillet, donne 5, précisé ensuite) :
    // BICOLORE ÉCONOMIQUE — sur une redemande NATURELLE à 1SA du partenaire (dénie le
    // fit), avec ma couleur d'ouverture 5+ et une DEUXIÈME couleur 4+ MOINS CHÈRE (rang
    // inférieur — ex. 1♦ ouvert, redemande possible seulement en ♣ ; 1♥ ouvert, ♣ ou ♦ ;
    // 1♠ ouvert, ♣, ♦ ou ♥), je la montre au palier 2 (pas de saut) — jusqu'à 18HL.
    // À 19HL+, le même bicolore devient un BICOLORE À SAUT (palier 3, pas 2) — une main
    // trop forte pour la version bon marché, qui insisterait sinon à tort sur un
    // minimum. S'applique à N'IMPORTE QUELLE couleur d'ouverture (pas seulement les
    // majeures) — une ouverture à trèfle (déjà la moins chère de toutes) n'a simplement
    // aucune couleur plus chère à showrait economiquement, la recherche ne trouve donc
    // jamais candidat pour elle, ce qui est le comportement voulu.
    if (partnerCall === '1NT' && lengths[myBid.strain] >= 5) {
        const cheaperSuits = ['S', 'H', 'D', 'C'].filter(s => s !== myBid.strain
            && STRAIN_RANK[s] < STRAIN_RANK[myBid.strain] && lengths[s] >= 4);
        if (cheaperSuits.length > 0) {
            const secondSuit = cheaperSuits.reduce((best, s) => (lengths[s] > lengths[best] ? s : best), cheaperSuits[0]);
            const call = (hl >= 19 ? '3' : '2') + secondSuit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    // Voir échange avec Guillaume (session du 24 juillet) : bascule sur HLD
    // (computeSupportPoints) dès que le partenaire soutient MA couleur directement — le
    // fit est alors connu avec certitude (au moins 3 cartes de soutien, voir
    // decideRobotMajorSupport), donc mes propres points de longueur (HL) ne veulent plus
    // rien dire par rapport à la distribution de mon jeu vis-à-vis de CET atout précis.
    const supportPoints = isRaiseOfMySuit ? computeSupportPoints(hand, myBid.strain, 3) : hl;

    // Voir échange avec Guillaume (session du 24 juillet, donne 3) : ENCHÈRE D'ESSAI (2SA
    // générique, pas un essai de couleur courte — pas encore implémenté) quand un fit
    // majeur vient d'être trouvé par un soutien SIMPLE (palier 2) et que ma main est dans
    // la zone D'ESPOIR de manche (15-17HLD) — ni un minimum tout juste suffisant pour
    // compéter (<15, filet PASS juste en dessous), ni déjà sûr d'être en zone de manche
    // (18HLD+, viser la manche directement, voir plus bas). Le partenaire répond ensuite
    // mini (revient dans le fit au palier minimal) ou maxi (manche) selon ses propres
    // points de soutien — voir la moitié symétrique de cette règle côté RÉPONDANT
    // (wasTrialBidAsk, dans le traitement du 2e tour du répondant).
    if (isRaiseOfMySuit && (myBid.strain === 'S' || myBid.strain === 'H') && myBid.level === 1
        && partnerParsed.level === 2 && supportPoints >= 15 && supportPoints < 18) {
        const call = '2NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    if (supportPoints < 18 && !isRaiseOfMySuit) return 'PASS'; // seule une main nettement au-dessus d'une ouverture minimale rejustifie de reparler (voir plus bas pour isRaiseOfMySuit, qui a son propre filet une fois le chelem écarté)

    // Le partenaire a-t-il confirmé un fit pour MA couleur d'ouverture par un soutien
    // NATUREL (pas conventionnel — les cas 2SA/3SA sont désormais traités plus haut,
    // avant ce seuil) ?
    if (isRaiseOfMySuit) {
        // Voir échange avec Guillaume (session du 24 juillet) : chelem par simple compte
        // de points (même principe que decideResponderContinuationAfterNewSuit, mis de
        // côté ici à tort jusqu'ici) — mes points de soutien (HLD, fit déjà connu)
        // combinés au minimum garanti par le soutien du partenaire (3 cartes, voir
        // computeSupportPoints ci-dessus) donnent une estimation basse mais sûre du
        // camp ; testé AVANT le filet "sous 18 → passe", pour ne pas manquer une main
        // suffisamment forte alors que supportPoints est déjà dans la zone de manche.
        if (supportPoints + SIMPLE_RAISE_MINIMUM >= SLAM_ZONE_GRAND) {
            const call = '7' + myBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
        if (supportPoints + SIMPLE_RAISE_MINIMUM >= SLAM_ZONE_SMALL) {
            const call = '6' + myBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
        if (supportPoints < 18) {
            // Voir échange avec Guillaume ("la loi des atouts n'est pas une question de
            // points, mais juste d'appliquer la loi des atouts", session du 30 juillet) :
            // ni espoir de manche (l'essai plus haut ne s'est pas déclenché) ni assez pour
            // viser la manche directement (supportPoints<18) — le seul repli restant est
            // purement le nombre total d'atouts CONNUS entre les deux mains, indépendamment
            // des points : 9 -> palier 3, 10 -> palier 4, 11 -> palier 5. Aucun seuil de
            // points n'est nécessaire : les deux joueurs du camp ont forcément déjà un
            // minimum de jeu chacun, puisqu'il a fallu qu'ils parlent tous les deux pour
            // connaître ce fit. EXCLU pour une ouverture de barrage (palier 2+, voir
            // échange avec Guillaume, donne 2) : son ouvreur a déjà tout dit à son premier
            // tour, il ne reparle plus jamais de son propre chef.
            if (myBid.level === 1) {
                const partnerGuaranteedLength = 3; // soutien simple : 3+ garanties, jamais plus précis ici
                const totalTrumps = lengths[myBid.strain] + partnerGuaranteedLength;
                let safetyLevel = null;
                if (totalTrumps >= 11) safetyLevel = 5;
                else if (totalTrumps >= 10) safetyLevel = 4;
                else if (totalTrumps >= 9) safetyLevel = 3;
                if (safetyLevel !== null) {
                    const call = Math.max(safetyLevel, partnerParsed.level) + myBid.strain;
                    if (isCallLegal(history, call, seat)) return call;
                }
            }
            return 'PASS'; // main modeste (soutien simple), pas assez d'atouts connus non plus pour un repli de sécurité
        }

        // Fit confirmé et main d'ouverture nettement excédentaire (18HLD+) : la manche est
        // quasiment automatique. Simplification volontaire : pas de vraie enchère de
        // contrôle (cue-bids, Blackwood, hors périmètre) au-delà du chelem par points
        // ci-dessus. Si le partenaire a déjà annoncé la manche lui-même (barrage),
        // isCallLegal rejettera naturellement cette annonce (déjà atteinte) et on se
        // rabat sur passe.
        const call = (myBid.strain === 'S' || myBid.strain === 'H') ? ('4' + myBid.strain) : ('5' + myBid.strain);
        if (isCallLegal(history, call, seat)) return call;
        return 'PASS';
    }

    // Le partenaire a montré une NOUVELLE couleur (pas de fit direct pour la mienne) :
    // si j'ai un fit pour SA couleur (3+ cartes), je monte pour montrer mon excédent
    // plutôt que de rester muet. Sinon, avec une main régulière, un SA franc au palier
    // minimal légal. Sinon encore, ma PROPRE 2e couleur (4+ cartes, voir échange avec
    // Guillaume, donne 2 : ne pas savoir la montrer laissait un ouvreur bicolore fort
    // totalement muet) ; faute de mieux, passe (filet de sécurité, pas une vraie
    // description de rebid).
    if (partnerParsed && partnerParsed.strain !== 'NT' && partnerParsed.strain !== myBid.strain) {
        const partnerSuit = partnerParsed.strain;
        if (lengths[partnerSuit] >= 3) {
            const call = (partnerParsed.level + 2) + partnerSuit; // saut, montre l'excédent
            if (isCallLegal(history, call, seat)) return call;
        }
    }
    if (isHandBalancedForNT(lengths)) {
        for (let level = 1; level <= 7; level++) {
            const call = level + 'NT';
            if (isCallLegal(history, call, seat)) return call;
        }
    }
    if (partnerParsed) {
        const order = ['S', 'H', 'D', 'C'].filter(s => s !== myBid.strain && s !== partnerParsed.strain);
        let secondSuit = null;
        for (const s of order) {
            if (lengths[s] >= 4 && (!secondSuit || lengths[s] > lengths[secondSuit])) secondSuit = s;
        }
        if (secondSuit) {
            for (let level = partnerParsed.level; level <= 7; level++) {
                const call = level + secondSuit;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
    }

    return 'PASS';
}

// Point d'entrée unique : détermine l'annonce d'un robot pour son tour actuel, ET une
// courte explication lisible de pourquoi (voir échange avec Guillaume — outil de
// diagnostic, affiché dans le relevé d'enchères au tap/survol sur les annonces jouées par
// un robot). Toujours validée par isCallLegal juste avant d'être renvoyée (filet de
// sécurité ultime) — un robot ne doit JAMAIS produire une annonce illégale, quitte à se
// rabattre sur passe si le calcul ci-dessus a un trou quelque part ; un blocage de la
// partie serait bien pire qu'un robot un peu trop passif.
//
// L'explication reste volontairement globale (quelle branche a été prise, H/HL calculés,
// contexte) plutôt que de tracer précisément quel palier exact de chaque échelle interne
// a été choisi (aurait demandé de faire remonter une raison depuis chacune des fonctions
// internes — un chantier bien plus lourd pour un gain marginal, les chiffres H/HL affichés
// suffisant déjà à comprendre l'essentiel d'une décision qui paraît bizarre).
//
// Note sur le rebid (voir échange avec Guillaume) : un ouvreur peut désormais reparler
// UNE FOIS s'il a une main très forte (18HL+) et que le partenaire vient de répondre —
// voir decideRobotOpenerRebid. En dehors de ce cas précis et borné, la règle reste "un
// seul tour de dialogue" : une fois 3 passes consécutifs après une annonce, l'enchère est
// terminée — dans n'importe quelle partie de bridge, personne ne reparle plus à ce
// stade, quelle que soit la force de sa main. maybeRobotBid (plus bas) vérifie déjà
// isAuctionOver avant même de solliciter cette fonction.
// Voir échange avec Guillaume (session du 31 juillet — correction complète de cap après un
// premier essai hors-sujet) : LA vraie définition retenue pour ce chantier, celle qui
// compte pour le moteur — "on se fout des cue-bids de contrôle en vue d'un chelem, les
// bots sont censés aller au chelem au poids" (ses mots) : un cue-bid dans une couleur
// annoncée par le camp ADVERSE est SYSTÉMATIQUEMENT un cue-bid — jamais une couleur à
// jouer, jamais ambigu à reconnaître (contrairement à mon 1er essai, qui devinait une
// enchère de contrôle sur un critère structurel fragile). Fait avant 3SA, il demande
// l'arrêt dans cette couleur en vue d'y jouer la manche à SA (voir donne 2, 2e jeu : "il
// devrait maintenant demander l'arrêt via un cue-bid à 2C [2♥ dans sa notation P/C/K/T,
// pas 2♣]").
//
// Cette fonction ne couvre que le côté RÉPONSE (ne jamais passer dessus) — décider quand
// le bot doit lui-même ÉMETTRE un tel cue-bid plutôt que de passer (le vrai bug de la
// donne 2) est un chantier à part, plus large (juger qu'aucune autre enchère naturelle ne
// convient mieux), pas traité ici.
function decideResponseToOpponentSuitCuebid(hand, seat, history) {
    const partnerBids = history.filter(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));
    if (partnerBids.length === 0) return null;

    const lastEntry = partnerBids[partnerBids.length - 1];
    // Vérifie qu'AUCUN adversaire n'a repris la parole depuis (même prudence qu'ailleurs
    // dans ce fichier pour un contre du partenaire, voir "opponentInterveningAfterDouble")
    // — sans quoi la pression forcing initiale peut être retombée.
    const partnerBidIndex = history.indexOf(lastEntry);
    const opponentSpokeAfter = history.slice(partnerBidIndex + 1).some(e => isBidCall(e.call) || isDouble(e.call));
    if (opponentSpokeAfter) return null;

    const lastParsed = parseBid(lastEntry.call);
    if (!lastParsed || lastParsed.strain === 'NT') return null;

    const opponentSuits = new Set(history.filter(e => partnershipOf(e.seat) !== partnershipOf(seat) && isBidCall(e.call))
        .map(b => parseBid(b.call).strain).filter(s => s && s !== 'NT'));
    if (!opponentSuits.has(lastParsed.strain)) return null; // pas la couleur adverse : pas ce motif-ci

    // "Fait avant 3SA" (ses mots) : au-delà, on ne demande plus un arrêt pour aller vers
    // SA, la manche à SA elle-même serait déjà dépassée — hors périmètre de ce motif précis.
    if (bidRank(lastEntry.call) >= bidRank('3NT')) return null;

    // Arrêt réel dans la couleur demandée : As, Roi accompagné (Rx+), ou Dame doublement
    // accompagnée (Dxx+) — même exigence que pour la 4ème couleur forcing plus haut dans
    // ce fichier (un 3ème rond nu du genre Vxx n'en est pas un).
    const cards = hand[lastParsed.strain] || '';
    const hasStopper = cards.includes('A')
        || (cards.includes('K') && cards.length >= 2)
        || (cards.includes('Q') && cards.length >= 3);

    if (hasStopper) {
        for (let level = lastParsed.level; level <= 7; level++) {
            const c = level + 'NT';
            if (isCallLegal(history, c, seat)) {
                return { call: c, explanation: `Arrêt à ${STRAIN_SYMBOL[lastParsed.strain]} — répond au cue-bid du partenaire (demande d'arrêt) par SA` };
            }
        }
    }

    // Pas d'arrêt : "enchère poubelle" pour économiser de l'espace (voir échange avec
    // Guillaume, donne 2) — jamais un passe (le cue-bid reste forcing), mais jamais non
    // plus une couleur nouvelle qui engagerait plus loin : on répète, au palier légal le
    // plus bas, une couleur DÉJÀ montrée par notre camp (moi ou le partenaire), en
    // préférant la mienne (je connais mieux ma propre main) puis celle du partenaire.
    const myOwnBids = history.filter(e => e.seat === seat && isBidCall(e.call));
    const myOwnSuits = [...new Set(myOwnBids.map(b => parseBid(b.call).strain).filter(s => s && s !== 'NT'))];
    const partnerSuits = [...new Set(partnerBids.slice(0, -1).map(b => parseBid(b.call).strain).filter(s => s && s !== 'NT'))];
    const candidateSuits = [...myOwnSuits, ...partnerSuits];
    for (let level = 1; level <= 7; level++) {
        for (const suit of candidateSuits) {
            const c = level + suit;
            if (isCallLegal(history, c, seat)) {
                return { call: c, explanation: `Pas d'arrêt à ${STRAIN_SYMBOL[lastParsed.strain]} — enchère poubelle pour économiser de l'espace, jamais de passe sur un cue-bid` };
            }
        }
    }
    return null; // aucune couleur à nous déjà montrée : filet de sécurité, laisse l'appelant décider (hors périmètre volontaire)
}

// Voir échange avec Guillaume (session du 31 juillet — "je veux un mécanisme unifié") :
// suite forcing du partenaire après que j'ai mécaniquement complété son Texas MINEUR
// (voir wasMinorTransferAsk dans decideRobotResponse, et le rebid mécanique
// correspondant dans decideRobotOpenerRebid — toujours au palier "ouverture+2", en ♣ ou
// ♦). Reconstruit ici la détection depuis zéro (autonome, comme les autres entrées du
// registre) plutôt que de dépendre de variables déjà calculées dans decideRobotCall.
function decideForcingResponseTexasMineurContinuation(hand, seat, history) {
    const myBids = history.filter(e => e.seat === seat && isBidCall(e.call));
    if (myBids.length !== 2) return null;
    const myFirstBid = parseBid(myBids[0].call);
    const mySecondBid = parseBid(myBids[1].call);
    const wasMinorTransferCompletion = myFirstBid && myFirstBid.strain === 'NT'
        && mySecondBid && (mySecondBid.strain === 'C' || mySecondBid.strain === 'D')
        && mySecondBid.level === myFirstBid.level + 2;
    if (!wasMinorTransferCompletion) return null;

    const myPartnerLastBid = history.slice().reverse()
        .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call) && e !== myBids[0] && e !== myBids[1]);
    if (!myPartnerLastBid) return null;
    const continuation = parseBid(myPartnerLastBid.call);
    if (!continuation || continuation.strain === mySecondBid.strain) return null;

    const partnerShortSuit = continuation.strain !== 'NT' ? continuation.strain : null;
    const call = decideOpenerResponseAfterMinorTransferContinuation(hand, mySecondBid.strain, partnerShortSuit, seat, history);
    if (call === 'PASS') return null;
    return { call, explanation: `Suite forcing après Texas mineur complété — manche minimum à ${STRAIN_SYMBOL[mySecondBid.strain]}` };
}

// Voir échange avec Guillaume (donne 3, session du 31 juillet, généralisé ensuite — "il
// faut vraiment travailler les enchères forcing/non-forcing") : ma toute première
// annonce était une VRAIE intervention directe (précédée immédiatement d'une annonce
// adverse, sans passe intercalé — exclut ouverture ET réouverture), et le partenaire y
// répond en NOUVELLE couleur. Règle retenue (ses mots) : une telle réponse est forcing —
// 8H+ chez lui, sans limite supérieure — TANT QU'IL N'A PAS DÉJÀ PASSÉ depuis mon
// intervention (un réveil après un premier passe n'a pas cette même force).
function decideForcingResponseToInterventionAnswer(hand, seat, history) {
    const myBids = history.filter(e => e.seat === seat && isBidCall(e.call));
    if (myBids.length !== 1) return null;
    const myFirstBidParsed = parseBid(myBids[0].call);
    if (!myFirstBidParsed || myFirstBidParsed.strain === 'NT') return null;

    const myBidIndex = history.indexOf(myBids[0]);
    const precededByOpponentBidDirectly = myBidIndex > 0
        && isBidCall(history[myBidIndex - 1].call)
        && partnershipOf(history[myBidIndex - 1].seat) !== partnershipOf(seat);
    if (!precededByOpponentBidDirectly) return null; // ouverture ou réouverture, pas une intervention directe

    const myPartnerBid = history.slice().reverse()
        .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call) && e !== myBids[0]);
    if (!myPartnerBid) return null;

    const partnerBidIdx = history.indexOf(myPartnerBid);
    const partnerAlreadyPassedBefore = history.slice(myBidIndex + 1, partnerBidIdx)
        .some(e => e.seat === myPartnerBid.seat && isPass(e.call));
    if (partnerAlreadyPassedBefore) return null;

    const partnerRespParsed = parseBid(myPartnerBid.call);
    const isNewSuitResponse = partnerRespParsed
        && partnerRespParsed.strain !== myFirstBidParsed.strain && partnerRespParsed.strain !== 'NT';
    if (!isNewSuitResponse) return null;

    const lengths = suitLengths(hand);
    const partnerSuit = partnerRespParsed.strain;
    const mySuit = myFirstBidParsed.strain;

    if (lengths[partnerSuit] >= 3) {
        // Soutien connu (3+, plancher garanti pour une intervention) : points de
        // soutien, zone de manche adaptée — mais sans plancher connu chez le partenaire
        // au-delà du minimum d'intervention (8HL) puisque sa réponse ne dit rien de
        // bornée ("8H+, sans limite supérieure") — repli sur le soutien minimal si la
        // zone n'est pas acquise avec ce seul plancher bas.
        const supportPts = computeSupportPoints(hand, partnerSuit, 4);
        const isMajor = partnerSuit === 'S' || partnerSuit === 'H';
        const zone = isMajor ? GAME_ZONE_MAJOR : GAME_ZONE_MINOR;
        const gameLevel = isMajor ? 4 : 5;
        if (supportPts + 8 >= zone) {
            for (let level = gameLevel; level <= 7; level++) {
                const c = level + partnerSuit;
                if (isCallLegal(history, c, seat)) {
                    return { call: c, explanation: `Réponse forcing du partenaire à mon intervention, assez de points de soutien (${supportPts}) — manche` };
                }
            }
        }
        for (let level = 1; level <= 7; level++) {
            const c = level + partnerSuit;
            if (isCallLegal(history, c, seat)) {
                return { call: c, explanation: `Réponse forcing du partenaire à mon intervention — soutien minimal, jamais de passe sur une enchère forcing` };
            }
        }
    } else if (lengths[mySuit] >= 6) {
        // Pas de fit chez lui, mais ma propre couleur d'intervention est longue (6+) :
        // la répéter montre l'extra-longueur sans s'engager plus loin.
        for (let level = 1; level <= 7; level++) {
            const c = level + mySuit;
            if (isCallLegal(history, c, seat)) {
                return { call: c, explanation: `Réponse forcing du partenaire à mon intervention, pas de fit chez lui — répète ma couleur (${lengths[mySuit]} cartes)` };
            }
        }
    } else {
        // Ni fit ni extra-longueur : repli le plus prudent — simple préférence au
        // palier minimal dans sa couleur, faute de mieux.
        for (let level = 1; level <= 7; level++) {
            const c = level + partnerSuit;
            if (isCallLegal(history, c, seat)) {
                return { call: c, explanation: `Réponse forcing du partenaire à mon intervention, ni fit ni extra-longueur — préférence minimale` };
            }
        }
    }
    return null;
}

// ===== Mécanisme UNIFIÉ de détection du caractère forcing =====
//
// Voir échange avec Guillaume (session du 31 juillet — "je veux un mécanisme unifié") :
// centralise ici, sous forme de registre, TOUTES les situations où ce moteur reconnaît
// une enchère du partenaire comme forcing — jusqu'ici recréées ad hoc à plusieurs
// endroits différents du fichier (Texas mineur, cue-bid adverse, réponse à
// intervention), avec le risque de refaire la même erreur (retomber sur "passe" par
// défaut) à chaque nouveau cas non prévu. Chaque motif est une entrée indépendante et
// testable, sous la forme d'une simple fonction (hand, seat, history) => {call,
// explanation} | null — decideForcingFallback les essaie dans l'ordre et s'arrête à la
// première qui reconnaît la situation ET produit une réponse légale.
//
// Ce mécanisme n'est qu'un FILET DE SECOURS, appelé une seule fois en tout dernier
// recours dans decideRobotCall (voir plus bas) : il ne s'active que si la logique
// spécifique à la séquence (le gros du fichier, au-dessus) n'a déjà rien produit (call
// encore à 'PASS'). Il ne remplace jamais un calcul déjà plus précis fait ailleurs — et
// ne couvre, pour l'instant, que les motifs listés ci-dessus : ce n'est pas un
// classificateur exhaustif de TOUTE enchère forcing possible (un renverse, un 2/1, un
// splinter, etc. sont déjà correctement gérés par leurs propres branches dédiées et
// n'ont pas besoin de repasser par ici) — plutôt l'endroit où ajouter le PROCHAIN motif
// forcing découvert manquant, à un seul endroit, au lieu de le disperser.
const FORCING_PATTERNS = [
    { name: 'texas_mineur_complete', respond: decideForcingResponseTexasMineurContinuation },
    { name: 'cuebid_couleur_adverse', respond: decideResponseToOpponentSuitCuebid },
    { name: 'reponse_a_intervention', respond: decideForcingResponseToInterventionAnswer }
];

function decideForcingFallback(hand, seat, history) {
    for (const pattern of FORCING_PATTERNS) {
        const result = pattern.respond(hand, seat, history);
        if (result) return result;
    }
    return null;
}

function decideRobotCall(seat, deal, history) {
    const hand = deal.hands[seat];
    const hcp = computeHandHcp(hand);
    const hl = computeHandHL(hand);
    const myBids = history.filter(entry => entry.seat === seat && !isPass(entry.call));
    const points = `${hcp}H / ${hl}HL`;

    let call = 'PASS';
    let explanation = '';

    if (myBids.length === 0) {
        // Cherche la dernière action RÉELLE (annonce ou contre) de MON PROPRE camp, en
        // remontant l'historique — pas seulement la toute dernière de l'enchère (voir
        // échange avec Guillaume, donne 4) : un adversaire qui reparle après le contre du
        // partenaire "libère" formellement de l'obligation de répondre, mais n'empêche pas
        // de le faire si la main le justifie (ici, Sud a un fit et doit répondre quand
        // même). Cette même recherche gère aussi bids ET contre uniformément.
        const myPartnerLastAction = history.slice().reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && !isPass(e.call));
        const partnerJustDoubled = myPartnerLastAction && isDouble(myPartnerLastAction.call);

        if (partnerJustDoubled) {
            const doubleIndex = history.indexOf(myPartnerLastAction);
            // Voir échange avec Guillaume (session du 25 juillet, donne 7 — nouveau bug) :
            // le commentaire juste au-dessus décrivait déjà cette idée ("libère
            // formellement de l'obligation de répondre"), mais rien ne l'appliquait
            // réellement — le contre déclenchait TOUJOURS une réponse automatique,
            // quelle que soit la main, même quand un adversaire avait repris la parole
            // depuis (ici Nord, réduisant à néant toute pression de pénalité). Sans
            // cette pression, il faut au moins un peu de jeu (6H+) pour répondre POUR DE
            // VRAI plutôt que de fabriquer une couleur avec 0 point.
            const opponentInterveningAfterDouble = history.slice(doubleIndex + 1)
                .some(e => (isBidCall(e.call) || isDouble(e.call)) && partnershipOf(e.seat) !== partnershipOf(seat));
            if (opponentInterveningAfterDouble && hcp < 6) {
                explanation = `Libéré de l'obligation de répondre (un adversaire a repris la parole depuis le contre) — pas assez de jeu pour répondre librement (${points})`;
            } else {
                // Voir échange avec Guillaume (donne 4, session du 30 juillet) : le contre
                // du partenaire était-il fait en RÉVEIL (2 passes juste avant, précédées
                // d'une vraie annonce adverse) ? Même détection que pour
                // decideDoublerFollowUp (wasReopeningDouble) — nécessaire pour la réponse
                // "1SA" à ce contre précis, qui n'a de sens QUE dans ce cas (voir
                // decideRobotResponseToDouble).
                const doubleLast2ForReopen = history.slice(Math.max(0, doubleIndex - 2), doubleIndex);
                const wasReopeningDoubleResponse = doubleLast2ForReopen.length === 2 && doubleLast2ForReopen.every(e => isPass(e.call));
                call = decideRobotResponseToDouble(hand, hcp, hl, doubleIndex, seat, history, wasReopeningDoubleResponse);
                explanation = `Réponse au contre du partenaire (${points})`;
            }
        } else {
            const lastBid = getLastActualBid(history);
            // Mon propre camp a-t-il déjà annoncé quelque chose (ouverture OU
            // intervention du partenaire) à quoi je dois répondre — même si la toute
            // dernière annonce de l'enchère vient de l'adversaire depuis (voir échange
            // avec Guillaume, donne 2 : Nord doit pouvoir soutenir l'intervention de Sud
            // malgré l'intervention intercalée d'Ouest) ? Cette recherche remplace
            // l'ancienne comparaison qui ne regardait QUE la toute dernière annonce —
            // elle la généralise (si lastBid est déjà celle du partenaire, cette
            // recherche la retrouve immédiatement, donc rien ne change dans ce cas).
            const myPartnerBid = history.slice().reverse()
                .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call));

            if (!lastBid) {
                call = decideRobotOpening(hand, hcp, hl, deal.vulnerable, seat);
                explanation = `Ouverture (${points})`;
            } else if (myPartnerBid) {
                const partnerBidInfo = parseBid(myPartnerBid.call);
                const partnerBidIndexForProtect = history.indexOf(myPartnerBid);
                const wasInterventionForProtect = history.slice(0, partnerBidIndexForProtect)
                    .some(e => isBidCall(e.call) && partnershipOf(e.seat) !== partnershipOf(seat));

                // Contre protecteur / de "quatrième main" (voir échange avec Guillaume,
                // donne 1, session du 21 juillet) : maintenant que le partenaire a montré
                // de la valeur (son intervention) et qu'un adversaire a renchéri sur SA
                // propre couleur, avec 8H+ et 4+ cartes dans CHACUNE des deux couleurs pas
                // encore montrées par quiconque, un contre vaut mieux qu'un passe qui
                // laisserait filer — normes assouplies par rapport à un contre d'appel
                // direct (8H suffit, pas besoin de brièveté dans la couleur adverse).
                if (wasInterventionForProtect && hl >= 8 && isCallLegal(history, 'X', seat)) {
                    const lastBidForProtect = getLastActualBid(history);
                    const lengths = suitLengths(hand);
                    const shownSuits = new Set([
                        partnerBidInfo.strain,
                        lastBidForProtect ? parseBid(lastBidForProtect.call).strain : null
                    ]);
                    const unshownSuits = ['S', 'H', 'D', 'C'].filter(s => !shownSuits.has(s));
                    if (unshownSuits.length === 2 && unshownSuits.every(s => lengths[s] >= 4)) {
                        call = 'X';
                        explanation = `Contre protecteur (4ème main) : 8H+ et 4+ cartes dans les 2 couleurs restantes (${points})`;
                    }
                }

                // Voir échange avec Guillaume (donne 1, session du 30 juillet, précisé
                // donne 3) : CONTRE NÉGATIF / Sputnik — cas complémentaire du contre
                // protecteur ci-dessus (celui-ci exige un adversaire AVANT le partenaire,
                // celui-là un adversaire JUSTE APRÈS, la situation la plus courante — RHO
                // intervient directement sur l'ouverture du partenaire). "On ne joue pas
                // la collante" (voir échange avec Guillaume) : le contre ne montre JAMAIS
                // les deux majeures à la fois, et ne sert QUE quand aucune couleur
                // candidate n'est annonçable nature au palier 1 — dès qu'au moins une
                // l'est, on l'annonce directement (la moins chère si plusieurs le sont),
                // jamais de contre. C'est ce qui rend le contre Sputnik possible (après une
                // intervention à 1♠ précisément : plus rien d'annonçable en dessous) mais
                // l'exclut par exemple après 1♦-(1♣), où "1♠" reste disponible et doit être
                // dit directement.
                if (call !== 'X' && myPartnerBid !== lastBid && isCallLegal(history, 'X', seat)) {
                    const lengthsForNegDouble = suitLengths(hand);
                    const opponentOvercallSuitForNegDouble = parseBid(lastBid.call).strain;
                    const shownSuitsForNegDouble = new Set([partnerBidInfo.strain, opponentOvercallSuitForNegDouble]);
                    const unshownSuitsForNegDouble = ['S', 'H', 'D', 'C'].filter(s => !shownSuitsForNegDouble.has(s));
                    const negDoubleSuits = unshownSuitsForNegDouble.filter(s => lengthsForNegDouble[s] >= 4);
                    const canShowAnySuitNaturally = negDoubleSuits.some(s => isCallLegal(history, '1' + s, seat));
                    // Voir échange avec Guillaume (donne 2, 1er jeu, session du 31 juillet
                    // — "Ouest n'a aucune raison de contrer, puisqu'il a les Coeurs [la
                    // couleur même de l'adversaire] / il doit passer en attendant un
                    // contre de réveil du partenaire") : le contre négatif ne dit RIEN sur
                    // une éventuelle longueur dans la couleur de l'ADVERSAIRE lui-même —
                    // ce garde-fou manquait entièrement. Avec une vraie longueur là-dedans
                    // (4+ cartes), le contre ne décrit plus correctement la main (on
                    // préfère laisser faire, quitte à compter sur un contre de réveil du
                    // partenaire s'il a la distribution pour ça) — jamais un contre
                    // négatif dans ce cas, quelles que soient les autres couleurs.
                    const tooLongInOpponentSuit = lengthsForNegDouble[opponentOvercallSuitForNegDouble] >= 4;
                    // Voir échange avec Guillaume (donne 16, session du 31 juillet — "ça
                    // promet formellement 4 cartes à Coeur") : quand une des couleurs
                    // encore muettes est une MAJEURE, le contre négatif la promet
                    // SPÉCIFIQUEMENT (4+ cartes) — il ne suffit pas qu'une mineure muette
                    // quelconque atteigne 4+ cartes pendant que la majeure reste courte.
                    // Sans majeure muette (les deux restantes sont des mineures), la
                    // règle d'origine (n'importe laquelle des deux suffit) reste valable.
                    const unbidMajorsForNegDouble = unshownSuitsForNegDouble.filter(s => s === 'S' || s === 'H');
                    const majorsPromiseSatisfied = unbidMajorsForNegDouble.length === 0
                        || unbidMajorsForNegDouble.every(s => lengthsForNegDouble[s] >= 4);
                    // Voir échange avec Guillaume (donne 3, session du 31 juillet — "on
                    // avait dit 8H pour le X mais on va dire que c'est 8H+ OU 9HL+, ce
                    // n'est pas une convention séparée") : une main courte en HCP mais
                    // longue dans une couleur muette (ici 6H mais 7 cartes à Cœur, la
                    // majeure muette = 9HL) doit pouvoir contrer tout autant qu'une main
                    // de 8H régulière — le seuil HCP seul excluait à tort ce genre de main,
                    // qui a pourtant clairement quelque chose à montrer (sa longue), juste
                    // pas assez pour l'annoncer directement en changement de couleur
                    // (newSuitThreshold, généralement 11+).
                    if (negDoubleSuits.length > 0 && (hcp >= 8 || hl >= 9) && !canShowAnySuitNaturally && !tooLongInOpponentSuit && majorsPromiseSatisfied) {
                        call = 'X';
                        explanation = `Contre négatif : aucune couleur annonçable au palier 1 (${negDoubleSuits.map(s => STRAIN_SYMBOL[s]).join('/')} bloquée(s)) (${points})`;
                    }
                }


                if (call !== 'X') {
                // Voir échange avec Guillaume (règle du fit) : le partenaire a-t-il
                // PROMIS 5+ cartes dans sa couleur ? Toujours vrai pour une ouverture à
                // la majeure (système "majeure 5ème") ; toujours vrai aussi pour une
                // intervention (voir decideRobotIntervention, qui exige 5+ cartes) —
                // jamais garanti pour une ouverture à la mineure, qui peut n'avoir que 3
                // cartes ("meilleure mineure"). Une intervention se reconnaît au fait
                // qu'un adversaire avait déjà annoncé quelque chose avant CETTE annonce
                // précise du partenaire (pas forcément avant la toute dernière de
                // l'enchère, si un adversaire a reparlé depuis).
                const isMajorSuit = partnerBidInfo && (partnerBidInfo.strain === 'S' || partnerBidInfo.strain === 'H');
                const partnerBidIndex = history.indexOf(myPartnerBid);
                const wasIntervention = history.slice(0, partnerBidIndex)
                    .some(e => isBidCall(e.call) && partnershipOf(e.seat) !== partnershipOf(seat));
                const partnerPromises5Plus = isMajorSuit || wasIntervention;
                // Voir échange avec Guillaume (session du 25 juillet, donne 3 — nouveau
                // bug) : le 2♣ fort artificiel n'existe QUE comme toute première annonce
                // de l'enchère (voir decideRobotOpening) — sans cette vérification, un
                // réveil NATUREL qui tombe sur "2C" (une vraie 6ème à trèfle, voir
                // decideRobotIntervention) se faisait à tort reconnaître comme le 2♣
                // fort, forçant la réponse d'attente automatique en 2♦ au lieu d'une
                // vraie réponse naturelle.
                const partnerBidWasOpening = history.slice(0, partnerBidIndex).every(e => isPass(e.call));
                // Voir échange avec Guillaume (session du 25 juillet, donne 1) : le
                // partenaire a-t-il annoncé en RÉVEIL (2 passes juste avant sa propre
                // annonce, précédées d'une vraie annonce adverse) ? Nécessaire pour
                // distinguer un "2SA" réveil (appel aux mineures, voir
                // decideRobotIntervention) d'un 2SA/1SA ordinaire (Stayman/transferts) —
                // les deux utilisent la même chaîne mais n'ont RIEN à voir.
                const partnerLast2 = history.slice(Math.max(0, partnerBidIndex - 2), partnerBidIndex);
                const partnerBidWasReopening = partnerLast2.length === 2 && partnerLast2.every(e => isPass(e.call));
                call = decideRobotResponse(hand, hcp, hl, myPartnerBid.call, seat, history, partnerPromises5Plus, wasIntervention, partnerBidWasOpening, partnerBidWasReopening);
                const isCompetitive = myPartnerBid !== lastBid;
                explanation = isCompetitive
                    ? `Soutien compétitif de ${formatCallForDisplay(myPartnerBid.call)} du partenaire malgré ${formatCallForDisplay(lastBid.call)} adverse (${points})`
                    : `Réponse à ${formatCallForDisplay(lastBid.call)} du partenaire (${points}, fit ${suitLengths(hand)[partnerBidInfo.strain] || 0}${partnerBidInfo.strain !== 'NT' ? ' carte(s) à ' + STRAIN_SYMBOL[partnerBidInfo.strain] : ''})`;
                } // fin du if (call !== 'X') — voir le contre protecteur plus haut
            } else {
                // Voir échange avec Guillaume (session du 24 juillet) : RÉVEIL — si je
                // passe, l'enchère se termine sur la dernière annonce adverse (les 2
                // derniers appels sont des passes, précédés d'une vraie annonce
                // adverse). Moins exigeant qu'une intervention directe (voir
                // decideRobotIntervention) : le silence du partenaire ne veut pas dire
                // qu'il n'a rien, juste qu'il n'avait pas de quoi agir seul.
                const last2 = history.slice(-2);
                const isReopening = last2.length === 2 && last2.every(e => isPass(e.call))
                    && lastBid && partnershipOf(lastBid.seat) !== partnershipOf(seat);
                call = decideRobotIntervention(hand, hcp, hl, seat, history, deal.vulnerable, isReopening);
                explanation = isReopening
                    ? `Réveil sur ${formatCallForDisplay(lastBid.call)} adverse (${points})`
                    : `Intervention sur ${formatCallForDisplay(lastBid.call)} adverse (${points})`;
            }
        }
    } else if (myBids.length === 1) {
        // Un seul rebid possible, et seulement pour l'OUVREUR (son unique annonce était
        // la toute première de l'enchère — pas une réponse ni une intervention) réagissant
        // à la réponse de son PARTENAIRE — recherchée en remontant l'historique (voir
        // échange avec Guillaume, donne 2 : si un adversaire est reparlé depuis la
        // réponse du partenaire, ce n'est plus forcément la toute dernière annonce de
        // l'enchère, mais elle reste valable à traiter).
        const myBidIndex = history.indexOf(myBids[0]);
        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — bug
        // trouvé : Sud passait sur le Stayman de son propre partenaire après avoir
        // réouvert à 1SA) : "wasOpening" vérifiait à tort que TOUTE l'enchère avant ma
        // première annonce était passe — ce qui exclut à tort une réouverture (Ouest a
        // ouvert, deux passes, MOI je réouvre à 1SA : ma première annonce EST une vraie
        // ouverture pour mon propre camp, même si un adversaire a parlé avant). Ce qui
        // compte vraiment : aucune annonce de MON PROPRE CAMP (moi ou mon partenaire)
        // avant la mienne — peu importe ce que l'adversaire a fait.
        //
        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — bug
        // trouvé DANS ce même correctif : une simple INTERVENTION directe, ex. "1P" sur
        // l'ouverture adverse de "1K" sans le moindre passe entre les deux, se faisait
        // AUSSI compter à tort comme "mon ouverture" par ce même calcul — provoquant un
        // contre-sens total plus tard (traité comme un ouvreur répondant au contre du
        // partenaire, au lieu d'un intervenant). Précision ajoutée : en plus de "aucune
        // annonce de mon camp avant", il faut aussi qu'AUCUN adversaire n'ait parlé JUSTE
        // AVANT ma première annonce sans un passe entre les deux — une réouverture est
        // TOUJOURS précédée d'un passe (le mien ou celui d'un adversaire) juste avant
        // elle ; une intervention directe, elle, suit immédiatement l'enchère adverse,
        // sans aucun passe intercalé.
        const historyBeforeMyFirstBid = history.slice(0, myBidIndex);
        const noPartnershipBidBefore = !historyBeforeMyFirstBid.some(entry => partnershipOf(entry.seat) === partnershipOf(seat) && isBidCall(entry.call));
        const immediatelyPrecededByPass = historyBeforeMyFirstBid.length === 0 || isPass(historyBeforeMyFirstBid[historyBeforeMyFirstBid.length - 1].call);
        const wasOpening = noPartnershipBidBefore && immediatelyPrecededByPass;
        const myPartnerBid = history.slice().reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call) && e !== myBids[0]);

        // Voir échange avec Guillaume (session du 30 juillet — CRM moderne) : ma seule
        // annonce précédente était-elle une réponse CRM à l'ouverture forte du partenaire
        // (2♣/2♦), et vient-il de redemander "2SA" naturellement (montrant sa vraie
        // force, voir decideOpenerRebidAfterStrongDiamond) ? Ce "2SA" fonctionne alors
        // EXACTEMENT comme une ouverture à SA pour la suite — Stayman/Texas déjà en
        // place, réutilisés tels quels plutôt que de mal interpréter la séquence via la
        // logique générique de suite du répondant plus bas.
        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — bug
        // trouvé : des chelems complètement absurdes après une ouverture normale de 1P,
        // réponse naturelle en 2K du partenaire) : chercher le premier bid du partenaire
        // et vérifier juste sa CHAÎNE ("2C"/"2D") ne suffit pas — un simple "2♦" en
        // réponse naturelle à MON ouverture matche la même chaîne sans être du tout une
        // ouverture forte. Vérification ajoutée : ce premier bid doit être le TOUT
        // PREMIER appel de l'enchère entière (rien que des passes avant), sinon ce n'est
        // clairement pas une ouverture.
        const partnerFirstBidForCRM = history.find(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));
        const partnerFirstBidForCRMWasRealOpening = partnerFirstBidForCRM
            && history.slice(0, history.indexOf(partnerFirstBidForCRM)).every(e => isPass(e.call));
        const wasStrongOpeningCRMThenNT = partnerFirstBidForCRM
            && partnerFirstBidForCRMWasRealOpening && (partnerFirstBidForCRM.call === '2C' || partnerFirstBidForCRM.call === '2D')
            && myPartnerBid && myPartnerBid.call === '2NT';
        if (wasStrongOpeningCRMThenNT) {
            let callAfterStrongNT = decideRobotResponse(hand, hcp, hl, '2NT', seat, history, false, false, false, false);
            // Voir échange avec Guillaume (session du 30 juillet — bug critique trouvé,
            // donne 6) : ce "2SA" est TOUJOURS forcing de manche (l'ouverture de 2♣/2♦
            // l'était déjà) — jamais question de passer, quelle que soit la main,
            // contrairement à un vrai 2SA direct (20-21) où passer reste une sortie
            // légitime avec une main assez faible. La logique générique de réponse à
            // 2SA (pensée pour un vrai 2SA, pas un "super" 2SA) ne le sait pas — si elle
            // en arrive au passe, on le remplace par le minimum garanti de la manche
            // (3SA, faute de fit connu par ailleurs).
            if (callAfterStrongNT === 'PASS') {
                for (let level = 3; level <= 7; level++) {
                    const c = level + 'NT';
                    if (isCallLegal(history, c, seat)) { callAfterStrongNT = c; break; }
                }
            }
            return { call: callAfterStrongNT, explanation: `Stayman/Texas sur le "2SA" naturel de l'ouvreur après l'ouverture forte — jamais de passe, forcing de manche (${points})` };
        }

        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — "il
        // faut vraiment résoudre ça") : PENDANT du cas ci-dessus, mais quand l'ouvreur du
        // 2♣/2♦ a montré sa PROPRE couleur (main irrégulière, voir
        // decideOpenerRebidAfterStrongDiamond) plutôt que "2SA" — toujours forcing de
        // manche, jamais de repli en dessous. Priorité : fit connu (3+ cartes) dans SA
        // couleur → manche directe dedans (points de soutien pour juger un chelem
        // éventuel) ; sinon MA PROPRE couleur si assez longue/belle (même règle que
        // partout ailleurs ce soir, 7+ ou 6+ avec chicane+belle couleur) → manche
        // directe dedans ; sinon 3SA en tout dernier recours — jamais un simple repli
        // sous la manche comme "3P, zone basse" (qui n'a aucun sens ici, la zone basse
        // n'existe pas sur une ouverture forcing de manche).
        const wasStrongOpeningCRMThenSuit = partnerFirstBidForCRM
            && partnerFirstBidForCRMWasRealOpening && (partnerFirstBidForCRM.call === '2C' || partnerFirstBidForCRM.call === '2D')
            && myPartnerBid && myPartnerBid.call !== '2NT' && isBidCall(myPartnerBid.call);
        if (wasStrongOpeningCRMThenSuit) {
            const lengthsForCRMSuit = suitLengths(hand);
            const partnerSuitBid = parseBid(myPartnerBid.call);
            let callAfterCRMSuit = null;

            if (partnerSuitBid.strain !== 'NT' && lengthsForCRMSuit[partnerSuitBid.strain] >= 3) {
                const supportPointsForCRMSuit = computeSupportPoints(hand, partnerSuitBid.strain, 4);
                const openerFloor = partnerFirstBidForCRM.call === '2D' ? 24 : 22;
                const isMajorForCRMSuit = partnerSuitBid.strain === 'S' || partnerSuitBid.strain === 'H';
                let targetLevelForCRMSuit = isMajorForCRMSuit ? 4 : 5;
                if (supportPointsForCRMSuit + openerFloor >= SLAM_ZONE_SMALL) targetLevelForCRMSuit = 6;
                for (let level = Math.max(targetLevelForCRMSuit, partnerSuitBid.level); level <= 7; level++) {
                    const c = level + partnerSuitBid.strain;
                    if (isCallLegal(history, c, seat)) { callAfterCRMSuit = c; break; }
                }
            } else {
                const ownSuitForCRM = ['S', 'H'].find(s => {
                    const len = lengthsForCRMSuit[s];
                    if (len >= 7) return true;
                    if (len === 6) {
                        const hasOutsideSingleton = ['S', 'H', 'D', 'C'].some(s2 => s2 !== s && lengthsForCRMSuit[s2] === 1);
                        const cardsHere = hand[s] || '';
                        const topHonors = ['A', 'K', 'Q'].filter(r => cardsHere.includes(r)).length;
                        return hasOutsideSingleton && topHonors >= 2;
                    }
                    return false;
                });
                if (ownSuitForCRM) {
                    for (let level = 4; level <= 7; level++) {
                        const c = level + ownSuitForCRM;
                        if (isCallLegal(history, c, seat)) { callAfterCRMSuit = c; break; }
                    }
                }
            }
            if (!callAfterCRMSuit) {
                for (let level = 3; level <= 7; level++) {
                    const c = level + 'NT';
                    if (isCallLegal(history, c, seat)) { callAfterCRMSuit = c; break; }
                }
            }
            return { call: callAfterCRMSuit || 'PASS', explanation: `Suite après que l'ouvreur du 2♣/2♦ ait montré sa propre couleur — toujours forcing de manche, jamais de repli en dessous (${points})` };
        }

        // Voir échange avec Guillaume (donne 1, session du 30 juillet) : mon partenaire
        // a-t-il répondu à MON OUVERTURE par un CONTRE plutôt qu'une vraie enchère
        // chiffrée (négatif façon Sputnik, après l'intervention d'un adversaire) ?
        // Recherché séparément de myPartnerBid ci-dessus (qui ne trouve que de vraies
        // enchères) — sans cette recherche, ce cas ne correspondait à AUCUNE branche de
        // ce bloc, et tombait en silence sur le passe par défaut (bug trouvé en testant).
        const myPartnerDouble = history.slice().reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isDouble(e.call) && e !== myBids[0]);

        // Voir échange avec Guillaume (donne 4, session du 30 juillet) : mon UNIQUE
        // annonce précédente (myBids[0]) était-elle elle-même une réponse au contre du
        // partenaire (ex. "1SA" en réponse à son contre de réveil, voir
        // decideRobotResponseToDouble) plutôt qu'une vraie réponse à une ouverture ? Sans
        // cette détection, ce cas tombait dans la branche générique "!wasOpening &&
        // myPartnerBid" plus bas, qui suppose à tort que le tout premier bid de l'enchère
        // est l'ouverture DU PARTENAIRE — ici c'est celle de l'ADVERSAIRE (West), menant à
        // un non-sens (cue-bid dans sa couleur alors que mon 1SA avait déjà promis l'arrêt).
        const priorPartnerActionForDoubleResp = history.slice(0, myBidIndex).reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && (isBidCall(e.call) || isDouble(e.call)));
        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — bug
        // trouvé : Ouest sautait au chelem sur la propre manche de son partenaire) : cette
        // suite n'a de sens QUE pour le "1SA réponse au contre de réveil" précis (10-12H,
        // arrêt déjà promis, voir decideRobotResponseToDouble) — pas pour n'importe quelle
        // réponse naturelle au contre (une couleur, ex. "2D"), qui suit déjà sa propre
        // logique correcte par ailleurs (voir decideDoublerFollowUp) et n'a pas besoin
        // qu'on la refasse ici.
        const myBidWasResponseToPartnerDouble = priorPartnerActionForDoubleResp && isDouble(priorPartnerActionForDoubleResp.call)
            && myBids[0].call === '1NT';

        if (myBidWasResponseToPartnerDouble && myPartnerBid) {
            // Le contre de réveil du partenaire s'engage dès 8H SANS LIMITE HAUTE — mes
            // 10-12H déjà montrés (via 1SA) suffisent pour viser la manche dès qu'il a
            // assez insisté pour montrer une vraie couleur ici (voir decideDoublerFollowUp).
            const partnerSuitAfterDouble = parseBid(myPartnerBid.call);
            const lengthsForDoubleFollow = suitLengths(hand);
            if (partnerSuitAfterDouble && partnerSuitAfterDouble.strain !== 'NT' && lengthsForDoubleFollow[partnerSuitAfterDouble.strain] >= 3) {
                const isMajorFollow = partnerSuitAfterDouble.strain === 'S' || partnerSuitAfterDouble.strain === 'H';
                const gameLevelFollow = isMajorFollow ? 4 : 5;
                const targetLevelFollow = Math.max(gameLevelFollow, partnerSuitAfterDouble.level);
                // Voir échange avec Guillaume (bug trouvé via simulation) : si le
                // partenaire a DÉJÀ atteint (ou dépassé) ce palier de lui-même, il n'y a
                // rien à ajouter — chercher "la prochaine case légale" à partir de là
                // sauterait au chelem par accident (la case de la manche est déjà prise
                // par SA propre enchère, pas une vraie main de chelem chez moi).
                if (targetLevelFollow > partnerSuitAfterDouble.level) {
                    for (let level = targetLevelFollow; level <= 7; level++) {
                        const c = level + partnerSuitAfterDouble.strain;
                        if (isCallLegal(history, c, seat)) { call = c; break; }
                    }
                    if (call !== 'PASS') explanation = `Fit trouvé avec la couleur du partenaire après son contre de réveil — manche (${points})`;
                } else {
                    explanation = `Le partenaire a déjà atteint la manche de son côté — passe (${points})`;
                }
            } else {
                for (let level = 3; level <= 7; level++) {
                    const c = level + 'NT';
                    if (isCallLegal(history, c, seat)) { call = c; break; }
                }
                if (call !== 'PASS') explanation = `Pas de fit franc avec la couleur du partenaire — manche à SA, l'arrêt est déjà promis par mon 1SA (${points})`;
            }
        } else if (wasOpening && !myPartnerBid && myPartnerDouble && !isDouble(myBids[0].call)) {
            call = decideOpenerResponseToPartnerDouble(hand, hcp, hl, history.indexOf(myPartnerDouble), seat, history);
            // Voir échange avec Guillaume (session du 31 juillet, suite aux simulations) :
            // le texte générique "obligation de donner le fit" était trompeur après une
            // ouverture de barrage (voir wasBarrageOpening dans
            // decideOpenerResponseToPartnerDouble) — le contre y est punitif, pas une
            // demande de fit, donc le passe qui en résulte n'est pas "un défaut par
            // manque de couleur" mais bien la seule réponse correcte.
            explanation = call === 'PASS'
                ? `Contre punitif du partenaire sur mon ouverture de barrage — j'accepte, passe (${points})`
                : `Réponse au contre du partenaire après intervention adverse — obligation de donner le fit (${points})`;
        } else if (wasOpening && myPartnerBid && myBids[0].call === '2NT'
            && (() => {
                // Voir échange avec Guillaume (session du 31 juillet, 23h56 — régression
                // trouvée sur la donne 1 : "pourquoi Sud ne rectifie pas le Texas ???") :
                // "wasOpening" à lui seul ne suffit PAS à distinguer un vrai RÉVEIL (après
                // une vraie enchère adverse suivie de 2 passes) d'une simple OUVERTURE
                // fraîche de 2SA (après une rotation de passes SANS aucune enchère
                // adverse — dealer passe, 2e joueur passe, 3e joueur ouvre 2SA). Les deux
                // satisfont "immediatelyPrecededByPass" ! Seul un vrai réveil peut être
                // l'appel aux mineures — un vrai 2SA d'ouverture doit continuer à passer
                // par la complétion Stayman/transfert normale (decideRobotOpenerRebid),
                // exactement comme n'importe quelle autre ouverture à SA. Même critère
                // précis que celui déjà utilisé ailleurs dans ce fichier pour
                // decideRobotIntervention : les 2 derniers appels avant ma 2SA sont des
                // passes, ET une vraie enchère adverse existe encore avant ces 2 passes.
                const my2NTIndex = history.indexOf(myBids[0]);
                const last2BeforeMy2NT = history.slice(Math.max(0, my2NTIndex - 2), my2NTIndex);
                const lastRealBidBeforeMy2NT = history.slice(0, my2NTIndex).slice().reverse().find(e => isBidCall(e.call));
                return last2BeforeMy2NT.length === 2 && last2BeforeMy2NT.every(e => isPass(e.call))
                    && lastRealBidBeforeMy2NT && partnershipOf(lastRealBidBeforeMy2NT.seat) !== partnershipOf(seat);
            })()) {
            // Voir échange avec Guillaume (donne 4, session du 31 juillet, 23h) : mon
            // "2SA" en réveil n'est JAMAIS une vraie ouverture à SA dans ce moteur — c'est
            // TOUJOURS l'appel aux mineures (voir isReopenMinorTwoSuiter dans
            // decideRobotIntervention, seule origine possible de ce "2SA" en réveil) : "je
            // tiens les deux mineures, choisis". Sans cette branche dédiée, la branche
            // générique juste en dessous (wasOpening && myPartnerBid) traitait à tort ce
            // "2SA" comme un vrai 2SA d'ouverture et appelait decideRobotOpenerRebid, qui
            // interprète la couleur choisie par le partenaire (ici 3♣) comme du Stayman/
            // Texas — non-sens total, puisque le partenaire vient juste de PRENDRE
            // POSITION entre mes deux mineures, il n'a rien demandé.
            //
            // Une fois le partenaire fixé sur l'une des deux, rien à ajouter — JAMAIS de
            // correction vers l'autre mineure (voir sa donne 4 : "il n'y a aucune raison
            // de reparler pour mettre 3♦, ça n'a pas de sens"). Sa propre explication :
            // en réveil, les DEUX adversaires ont généralement déjà montré des valeurs
            // réelles (contrairement à une ouverture-passe-passe-réveil classique, où seul
            // l'ouvreur a parlé) — la manche n'est quasiment jamais jouable de notre côté,
            // l'objectif du réveil est seulement de récupérer le meilleur contrat au
            // palier le plus bas, jamais de chercher plus loin une fois le partenaire fixé.
            explanation = `Réveil "appel aux mineures" : le partenaire a choisi, rien à ajouter — passe (${points})`;
        } else if (wasOpening && myPartnerBid && !isDouble(myBids[0].call)) {
            // Voir échange avec Guillaume (outil de simulation, session du 30 juillet —
            // régression trouvée juste après le correctif de wasOpening plus haut) : le
            // nouveau calcul de wasOpening (qui reconnaît maintenant une réouverture
            // comme une vraie "ouverture" pour la suite) reconnaissait par erreur AUSSI
            // un simple CONTRE comme "mon ouverture" dès lors qu'aucune annonce de mon
            // camp ne le précédait — cette branche appelait alors decideRobotOpenerRebid
            // avec un contre en guise d'"ouverture", qui échoue silencieusement
            // (parseBid('X') renvoie null) et retombe sur un passe. Exclusion ajoutée :
            // cette branche ne concerne que de VRAIES enchères chiffrées comme première
            // annonce — un contre a sa propre branche dédiée plus bas (isDouble(myBids[0])).
            //
            // Un adversaire est-il reparlé depuis la réponse du partenaire (voir échange
            // avec Guillaume, donne 6) ? Si oui, la règle "reparle toujours après une
            // nouvelle couleur" ne s'applique plus — une fois la concurrence entrée en
            // jeu, ce n'est plus vraiment forcing, l'ouvreur peut légitimement passer
            // s'il n'a rien de plus à ajouter. La loi des atouts et le filet 18HL+
            // restent inchangés, eux (voir decideRobotOpenerRebid).
            // Compte aussi un CONTRE adverse, pas seulement une vraie annonce (voir
            // échange avec Guillaume, donne 7) : un contre de la couleur du partenaire
            // rend la situation tout aussi compétitive qu'une nouvelle annonce — l'ouvreur
            // ne doit pas se sentir obligé de reparler pour autant.
            const myPartnerBidIndex = history.indexOf(myPartnerBid);
            const opponentInterveningAfterPartner = history.slice(myPartnerBidIndex + 1)
                .some(e => (isBidCall(e.call) || isDouble(e.call)) && partnershipOf(e.seat) !== partnershipOf(seat));
            call = decideRobotOpenerRebid(hand, hcp, hl, myBids[0].call, myPartnerBid.call, seat, history, opponentInterveningAfterPartner);
            explanation = `Rebid de l'ouvreur après ${formatCallForDisplay(myPartnerBid.call)} du partenaire (${points})`;
        } else if (isDouble(myBids[0].call) && myPartnerBid) {
            // Ma seule annonce précédente était un CONTRE (d'appel) — voir échange avec
            // Guillaume, donne 4 : ce n'est ni une ouverture ni une réponse, la logique de
            // suite du répondant plus bas ne s'y applique pas du tout (elle tenterait de
            // parser mon contre comme une annonce chiffrée, échouerait silencieusement et
            // me ferait passer à tort). Voir decideDoublerFollowUp : avec de la réserve
            // au-delà du minimum du contre et un fit pour la couleur choisie par le
            // partenaire, on pousse à la manche.
            // Voir échange avec Guillaume (session du 25 juillet, donne 6 — nouveau bug) :
            // le contre lui-même était-il fait en RÉVEIL (2 passes juste avant, précédées
            // d'une vraie annonce adverse) ? La redemande "main plate 13-16H → SA" (voir
            // decideDoublerFollowUp) n'a de sens QUE dans ce cas précis (convention SEF du
            // réveil, voir decideRobotIntervention) — un contre d'appel DIRECT classique
            // décrit déjà tout ce qu'il y a à dire (12-18HL), rien ne justifie de reparler
            // ensuite juste parce que la main est plate et dans cette fourchette.
            const myDoubleIndex = history.indexOf(myBids[0]);
            const doubleLast2 = history.slice(Math.max(0, myDoubleIndex - 2), myDoubleIndex);
            const wasReopeningDouble = doubleLast2.length === 2 && doubleLast2.every(e => isPass(e.call));
            call = decideDoublerFollowUp(hand, hcp, hl, myPartnerBid.call, seat, history, wasReopeningDouble);
            explanation = `Suite après contre, réponse ${formatCallForDisplay(myPartnerBid.call)} du partenaire (${points})`;
        } else if (isDouble(myBids[0].call) && !myPartnerBid) {
            // Voir échange avec Guillaume (session du 25 juillet, donne 7 — nouveau bug) :
            // mon partenaire n'a fait que passer (aucune vraie annonce), MAIS les
            // ADVERSAIRES ont continué d'enchérir depuis mon contre — mon contre "toute
            // distribution" (19HL+, voir decideRobotIntervention) prévoyait justement de
            // montrer ma vraie couleur au tour suivant, INDÉPENDAMMENT du silence du
            // partenaire (qui n'a peut-être simplement rien eu à ajouter). Sans ce cas,
            // ce plan restait lettre morte : plus aucune branche ne savait quoi faire
            // quand ni le partenaire n'avait parlé, ni la situation n'était une réouverture
            // sur ma propre ouverture (déjà couvert par wasOpening plus haut).
            const lengths = suitLengths(hand);
            const myLongSuitAfterDouble = longestSuitPreferHigh(lengths);
            if (hl >= 19) {
                for (let level = 1; level <= 7; level++) {
                    const c = level + myLongSuitAfterDouble;
                    if (isCallLegal(history, c, seat)) { call = c; break; }
                }
                explanation = call !== 'PASS'
                    ? `Contre "toute distribution", partenaire silencieux mais adversaires reparlés — montre ma vraie couleur (${points})`
                    : `A déjà annoncé — passe (règle du tour unique)`;
            } else {
                explanation = `A déjà annoncé — passe (règle du tour unique)`;
            }
        } else if ((() => {
            const partnerFirstAction = history.find(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && (isBidCall(e.call) || isDouble(e.call)));
            const partnerRebidNT = myPartnerBid && parseBid(myPartnerBid.call) && parseBid(myPartnerBid.call).strain === 'NT' && parseBid(myPartnerBid.call).level <= 2;
            return partnerFirstAction && isDouble(partnerFirstAction.call) && partnerFirstAction !== myPartnerBid && partnerRebidNT;
        })()) {
            // Voir échange avec Guillaume (session du 25 juillet, donne 3) : le
            // partenaire a d'abord CONTRÉ (réveil ou "toute distribution", 13-16H ou
            // 19HL+ selon le cas, voir decideRobotIntervention) PUIS redemandé SA à bas
            // palier — séquence bien distincte d'une ouverture normale, que la logique
            // de suite du répondant plus bas (basée sur partnerOpeningBid, une VRAIE
            // ouverture) ne reconnaît pas du tout et laissait tomber en silence sur un
            // passe. Cette redemande à SA promet précisément 13-16H (voir
            // decideDoublerFollowUp) — j'ai maintenant cette info EXACTE, contrairement
            // à ma propre réponse au contre qui ne promettait rien de précis. Estimation
            // simple sur le MILIEU de cette fourchette (14-15) plutôt qu'une vraie
            // enchère d'invite (hors périmètre) : assez pour la manche si HCP + ce
            // milieu atteint 25H, sinon je m'arrête là où le partenaire a atterri.
            const ntRebid = parseBid(myPartnerBid.call);
            const partnerMidRange = 14.5;
            if (hcp + partnerMidRange >= GAME_ZONE_NT) {
                const gameCall = '3NT';
                if (isCallLegal(history, gameCall, seat)) {
                    call = gameCall;
                    explanation = `Le partenaire a contré puis redemandé SA (13-16H) — assez pour viser la manche (${points})`;
                } else {
                    explanation = `A déjà annoncé — passe (règle du tour unique)`;
                }
            } else {
                explanation = `Le partenaire a contré puis redemandé SA (13-16H) — pas assez pour viser plus haut, on reste là (${points})`;
            }
        } else if (!wasOpening && myPartnerBid) {
            // Voir échange avec Guillaume (session du 31 juillet — "je veux un mécanisme
            // unifié") : le cas "ma 1ère annonce était une intervention, le partenaire y
            // répond en nouvelle couleur (forcing)" vit maintenant dans le registre
            // FORCING_PATTERNS (voir decideForcingFallback, filet universel appelé en
            // toute fin de decideRobotCall) plutôt qu'ici en ligne — ça évite d'avoir
            // cette logique dupliquée/scindée entre deux endroits différents du fichier.

            // Voir échange avec Guillaume (donne 6, session du 31 juillet — "on va
            // considérer que le soutien à saut est toujours plus fort que le soutien
            // simple, donc s'applique pareil en face d'une ouverture et d'une
            // intervention") : le partenaire vient-il de RELANCER MA PROPRE couleur
            // d'intervention (pas une nouvelle couleur, déjà couverte ailleurs) ? Ce cas
            // n'était couvert par AUCUNE branche jusqu'ici — Ouest passait, même avec
            // 20HLD et un fit de 10 cartes connu. Puisque la règle est IDENTIQUE à celle
            // d'une vraie ouverture, pas besoin de dupliquer la logique d'accepter/
            // décliner (points de soutien, loi des atouts, chelem) : elle vit déjà
            // entièrement dans decideRobotOpenerRebid (vérifié : 15H+3(9e/10e atout)+2
            // (chicane)=20 points de soutien via computeSupportPoints, exactement son
            // calcul manuel — decideRobotOpenerRebid('1S','3S',...) renvoie bien 4♠).
            const myInterventionParsed = parseBid(myBids[0].call);
            const partnerRaiseParsed = parseBid(myPartnerBid.call);
            const wasRealInterventionForRaise = myInterventionParsed
                && history.slice(0, myBidIndex).some(e => isBidCall(e.call) && partnershipOf(e.seat) !== partnershipOf(seat));
            const isRaiseOfMyOwnSuit = partnerRaiseParsed && myInterventionParsed
                && partnerRaiseParsed.strain === myInterventionParsed.strain;
            if (wasRealInterventionForRaise && isRaiseOfMyOwnSuit && !isDouble(myBids[0].call)) {
                const rebidCall = decideRobotOpenerRebid(hand, hcp, hl, myBids[0].call, myPartnerBid.call, seat, history, false);
                call = rebidCall;
                explanation = call !== 'PASS'
                    ? `Soutien du partenaire à mon intervention — décision identique à une vraie ouverture (points de soutien) (${points})`
                    : `Soutien du partenaire à mon intervention — pas assez de réserve pour aller plus loin (${points})`;
            }

            // Suis-je dans une séquence où je sais être en zone de manche (voir échange
            // avec Guillaume) ? Il faut que MA première annonce ait été une réponse en
            // CHANGEMENT DE COULEUR (peu importe le palier, 1 ou 2 — pas un soutien, pas
            // SA) sur une ouverture à la couleur du partenaire, que j'aie moi-même 12+
            // (l'ouverture promet déjà 12+, donc 12+12=24+ à eux deux : la manche est
            // acquise), et que le partenaire n'ait fait qu'UN SEUL rebid depuis (son 2e
            // tour, qu'on vient d'entendre) — pas plus, sinon on sort du cas borné qu'on
            // sait gérer. Hors de ce cas précis, pas de suite pour le répondant (voir
            // échange avec Guillaume — 4ème couleur forcing mis de côté, chantier plus
            // large ; ici on reste sur la version simple : fit majeur connu ou SA direct).
            // Voir échange avec Guillaume (outil de simulation, session du 30 juillet —
            // bug trouvé : Ouest sautait au chelem après une réponse au contre de son
            // propre partenaire) : cette recherche ne filtrait pas par camp — elle
            // remontait jusqu'à la toute première enchère de TOUTE la table, y compris
            // celle de l'ADVERSAIRE (l'ouverture qu'Est vient de contrer, par exemple).
            // Filtre ajouté : seule une vraie ouverture de MON PROPRE camp compte ici — si
            // aucune (ex. mon camp n'a fait qu'un contre, jamais une vraie ouverture), tout
            // ce bloc (pensé pour "le partenaire a ouvert, j'ai répondu") doit rester
            // inerte plutôt que de mal interpréter la séquence.
            const partnerOpeningEntry = history.slice(0, myBidIndex).find(e => isBidCall(e.call) && partnershipOf(e.seat) === partnershipOf(seat));
            const partnerOpeningBid = partnerOpeningEntry ? parseBid(partnerOpeningEntry.call) : null;
            const myResponseBid = parseBid(myBids[0].call);
            if (partnerOpeningBid) {



            // Suite après un 2♣ fort artificiel (voir échange avec Guillaume, donne 4) :
            // ma seule annonce précédente était un simple relais d'attente (2♦, ne dit
            // rien de ma main) — une fois le rebid du partenaire entendu (2SA, 22-23HL),
            // c'est la PREMIÈRE fois que j'évalue vraiment ma main. Traité comme une
            // réponse à une ouverture de 2SA normale (même logique de seuil, voir plus
            // haut dans decideRobotResponse) plutôt que de tomber dans le cas général
            // ci-dessous, qui suppose à tort que ma première annonce disait quelque
            // chose sur ma main.
            const wasStrongTwoClubsRelay = partnerOpeningBid && partnerOpeningEntry.call === '2C' && myBids[0].call === '2D';
            // Suite après Stayman/transfert Jacoby (voir échange avec Guillaume, donne 4) :
            // ma 1ère annonce demandait quelque chose au partenaire (majeure ou relais),
            // sa réponse ne dit rien de MA main — c'est le moment d'évaluer mes propres
            // points pour la première fois. Le Texas (palier 4) n'a pas besoin de suite
            // ici : la manche est déjà atteinte à la complétion, le filet par défaut plus
            // bas (passe) est déjà la bonne réponse.
            const wasNTOpening = partnerOpeningEntry && (partnerOpeningEntry.call === '1NT' || partnerOpeningEntry.call === '2NT');
            const myAskBid = wasNTOpening ? parseBid(myBids[0].call) : null;
            const wasStaymanAsk = wasNTOpening && myAskBid.strain === 'C' && myAskBid.level === partnerOpeningBid.level + 1;
            const wasJacobyTransferAsk = wasNTOpening && (myAskBid.strain === 'D' || myAskBid.strain === 'H')
                && myAskBid.level === partnerOpeningBid.level + 1;
            // Suite après transfert MINEUR (voir échange avec Guillaume, donne 8) :
            // ma 1ère annonce transférait vers ♣ (via ♠ au palier +1) ou vers ♦ (via ♣ au
            // palier +2, faute de place plus tôt). Ma 3ème annonce indique où est ma
            // courte : directement si elle est de rang SUPÉRIEUR à la mineure montrée,
            // sinon (seulement possible pour ♣ quand ♦ est la mineure montrée, qui rang
            // en dessous et n'est donc plus nommable) via SA.
            const wasMinorTransferAsk = wasNTOpening && (
                (myAskBid.strain === 'S' && myAskBid.level === partnerOpeningBid.level + 1) ||
                (myAskBid.strain === 'C' && myAskBid.level === partnerOpeningBid.level + 2)
            );

            if (wasStrongTwoClubsRelay && myPartnerBid.call === '2NT') {
                call = decideRobotResponse(hand, hcp, hl, '2NT', seat, history, false, false, false, false);
                explanation = `Réponse au 2SA (22-23HL) après relais 2♦ sur 2♣ fort (${points})`;
            } else if (wasMinorTransferAsk) {
                const lengths = suitLengths(hand);
                const shownMinor = myAskBid.strain === 'S' ? 'C' : 'D';
                const otherSuits = ['S', 'H', 'D', 'C'].filter(s => s !== shownMinor);
                const shortSuit = otherSuits.find(s => lengths[s] <= 1);
                const replyLevel = parseBid(myPartnerBid.call).level;
                let targetCall;
                if (shortSuit && STRAIN_RANK[shortSuit] > STRAIN_RANK[shownMinor]) {
                    targetCall = replyLevel + shortSuit;
                } else {
                    targetCall = replyLevel + 'NT';
                }
                if (isCallLegal(history, targetCall, seat)) {
                    call = targetCall;
                    explanation = shortSuit
                        ? `Texas mineur complété, courte à ${STRAIN_SYMBOL[shortSuit]} (${points})`
                        : `Texas mineur complété, main régulière en zone de chelem (${points})`;
                }
            } else if (wasStaymanAsk) {
                const openerMinHl = partnerOpeningBid.level === 1 ? 15 : 20;
                const openerMaxHl = partnerOpeningBid.level === 1 ? 17 : 21;
                const partnerReplyBid = parseBid(myPartnerBid.call);
                const lengths = suitLengths(hand);
                const majorFit = (partnerReplyBid.strain === 'H' || partnerReplyBid.strain === 'S')
                    && lengths[partnerReplyBid.strain] >= 4;
                // Voir échange avec Guillaume ("zone de manche possible/certaine", session
                // du 30 juillet) : un fit de 4+ cartes trouvé via Stayman est un vrai fit
                // connu — points de SOUTIEN (HLD), pas HCP brut. Sans fit (on file vers SA
                // à la place), on reste en HL (aucun fit à réévaluer). Zone de manche du
                // SEF adaptée : GAME_ZONE_MAJOR (27, fit connu) ou GAME_ZONE_NT (25, sans
                // fit) — jamais un seuil fixe unique pour les deux cas.
                const myPoints = majorFit ? computeSupportPoints(hand, partnerReplyBid.strain, 4) : hl;
                const zone = majorFit ? GAME_ZONE_MAJOR : GAME_ZONE_NT;
                if (majorFit) {
                    if (myPoints + openerMinHl >= zone) {
                        call = '4' + partnerReplyBid.strain;
                        explanation = `Fit trouvé après Stayman, assez de points de soutien (${myPoints}) — manche certaine (${points})`;
                    } else if (myPoints + openerMaxHl >= zone) {
                        // Voir échange avec Guillaume ("la séquence doit continuer jusqu'à
                        // ce qu'on se rende compte de ce qu'il en est") : manche pas
                        // certaine (dépend d'où le partenaire se situe dans sa fourchette)
                        // mais possible — on continue (invite) plutôt que de passer à
                        // l'aveugle.
                        //
                        // Voir échange avec Guillaume (outil de simulation, session du 30
                        // juillet — bug trouvé) : "palier 3" en dur ne marche que pour un
                        // Stayman sur 1SA (relais au palier 2, complétion au palier 2,
                        // invite au palier 3 — cohérent) — sur un 2SA direct (relais au
                        // palier 3, complétion au palier 3 déjà), la même case est déjà
                        // prise par la complétion du partenaire, rendant l'invite illégale
                        // et faisant planter silencieusement sur un passe. Un cran
                        // au-dessus de SA complétion, toujours, quel que soit le palier de
                        // départ.
                        for (let level = partnerReplyBid.level + 1; level <= 7; level++) {
                            const c = level + partnerReplyBid.strain;
                            if (isCallLegal(history, c, seat)) { call = c; break; }
                        }
                        explanation = `Fit trouvé après Stayman, zone de manche possible (pas certaine) — continue pour savoir (${points})`;
                    } else {
                        explanation = `Fit trouvé après Stayman, pas assez pour la manche même dans le meilleur des cas — passe (${points})`;
                    }
                } else {
                    if (myPoints + openerMinHl >= zone) {
                        call = '3NT';
                        explanation = `Pas de majeure trouvée après Stayman, assez de points (${myPoints}) — manche certaine à SA (${points})`;
                    } else if (myPoints + openerMaxHl >= zone) {
                        // Voir échange avec Guillaume (outil de simulation, session du 30
                        // juillet — même bug que juste au-dessus) : "2SA" en dur ne marche
                        // que sur un Stayman de 1SA (dénégation à 2♦, "2SA" légal juste
                        // au-dessus) — sur un Stayman de 2SA direct (dénégation déjà à
                        // 3♦), "2SA" est illégal (palier déjà dépassé) ; le palier légal
                        // le plus proche y est alors directement "3SA" (aucun palier
                        // intermédiaire n'existe entre les deux dans ce cas précis — la
                        // main d'ouverture est déjà si haute que l'invite et la manche se
                        // confondent structurellement).
                        for (let level = partnerReplyBid.level; level <= 7; level++) {
                            const c = level + 'NT';
                            if (isCallLegal(history, c, seat)) { call = c; break; }
                        }
                        explanation = `Pas de majeure trouvée après Stayman, zone de manche possible (pas certaine) — invite à SA (${points})`;
                    } else {
                        explanation = `Pas de majeure trouvée après Stayman, pas assez pour la manche même dans le meilleur des cas — passe (${points})`;
                    }
                }
            } else if (wasJacobyTransferAsk) {
                // Voir échange avec Guillaume ("zone de manche possible/certaine", session
                // du 30 juillet — exemple concret : chicane ignorée après un Texas) : le
                // transfert confirme DÉJÀ un fit (5+ cartes chez le partenaire dans cette
                // majeure) — points de SOUTIEN (HLD, chicane/singleton compris), jamais
                // HCP brut comme avant (qui ignorait par exemple une chicane entière).
                // GAME_ZONE_MAJOR (27, fit connu), pas un seuil fixe à 25 emprunté à SA.
                const major = myAskBid.strain === 'D' ? 'H' : 'S';
                // Voir échange avec Guillaume ("la rectification d'un Texas ne promet pas
                // du tout un fit", session du 30 juillet) : la rectification est un geste
                // MÉCANIQUE et forcé (l'ouvreur DOIT compléter, quelle que soit sa main
                // dans cette couleur) — contrairement à un soutien ou une réponse Stayman,
                // qui sont un vrai choix du partenaire montrant sa longueur réelle. Les 5+
                // cartes du transfert sont les MIENNES, jamais celles du partenaire — donc
                // pas de vraie garantie de longueur chez lui à utiliser pour le bonus du
                // 9ème atout. Seul plancher connu : un SA équilibré n'a normalement pas de
                // chicane/singleton, donc au moins 2 cartes partout — plancher prudent,
                // pas une vraie promesse de fit.
                const supportPointsForTransfer = computeSupportPoints(hand, major, 2);
                const openerMinHl = partnerOpeningBid.level === 1 ? 15 : 20;
                const openerMaxHl = partnerOpeningBid.level === 1 ? 17 : 21;

                if (supportPointsForTransfer + openerMinHl >= GAME_ZONE_MAJOR) {
                    call = '4' + major;
                    explanation = `Assez de points de soutien après le transfert (${supportPointsForTransfer}) — manche certaine (${points})`;
                } else if (supportPointsForTransfer + openerMaxHl >= GAME_ZONE_MAJOR) {
                    // Voir échange avec Guillaume : manche pas certaine (dépend d'où le
                    // partenaire se situe dans sa fourchette 15-17/20-21) mais possible —
                    // on continue au lieu de passer : relance au palier 3 dans la majeure,
                    // le partenaire tranchera (minimum -> s'arrête, maximum -> manche).
                    for (let level = 3; level <= 7; level++) {
                        const c = level + major;
                        if (isCallLegal(history, c, seat)) { call = c; break; }
                    }
                    explanation = call !== 'PASS'
                        ? `Zone de manche possible (pas certaine) après le transfert — continue pour savoir (${points})`
                        : `A déjà annoncé — passe (règle du tour unique)`;
                } else {
                    explanation = `Transfert complété, pas assez pour la manche même dans le meilleur des cas — passe (${points})`;
                }
            } else {
            const responseLengths = myResponseBid ? suitLengths(hand) : null;
            const partnerRebidBid = parseBid(myPartnerBid.call);

            const knowsGameZone = partnerOpeningBid && myResponseBid
                && partnerOpeningBid.level === 1 && myResponseBid.strain !== partnerOpeningBid.strain
                && myResponseBid.strain !== 'NT' && hl >= 12;

            // Voir échange avec Guillaume (donne 5, session du 30 juillet) : incohérence
            // trouvée en creusant — un vrai "2/1" (changement de couleur du répondant au
            // palier 2+, sur une ouverture au palier 1) exige DÉJÀ 13HL rien que pour être
            // fait (voir newSuitThreshold dans decideRobotResponse) ; knowsGameZone
            // ci-dessus, lui, ne regarde que le HCP BRUT (12+), ignorant les points de
            // longueur qui ont pourtant justifié l'enchère de départ — une main comme
            // 10H/13HL (7ème carte à une couleur) pouvait ainsi enchérir 2/1 puis passer
            // au tour suivant, alors que "le 2/1 est forcing et auto forcing" (ses mots) :
            // l'ouvreur doit reparler, et le répondant devra lui-même faire au moins une
            // autre enchère. Reconnu ici indépendamment du HCP brut — dès lors que la
            // séquence EST un vrai 2/1, elle est forcing de manche, point final.
            const was2over1GameForcing = partnerOpeningBid && myResponseBid
                && partnerOpeningBid.level === 1 && myResponseBid.level >= 2
                && myResponseBid.strain !== partnerOpeningBid.strain && myResponseBid.strain !== 'NT';

            // Voir échange avec Guillaume (session du 24 juillet, donne 4 — nouveau bug) :
            // variante HLD de knowsGameZone — le partenaire a redemandé une VRAIE couleur
            // (pas SA) dans laquelle j'ai un fit (4+ cartes) ; recalculée en points de
            // soutien (fit connu = distribution, pas simple longueur), ça peut suffire à
            // atteindre la zone de manche même quand le HCP brut ne le suggérait pas du
            // tout (Sud, donne 4 : 9H seulement, mais 16HLD une fois le fit à 6 cartes +
            // 2 singletons comptés). Sans ce recalcul, une main énorme par la
            // distribution mais quelconque en HCP ne déclenchait jamais la suite en zone
            // de manche.
            const partnerRebidSuitFit = partnerRebidBid && partnerRebidBid.strain !== 'NT'
                && partnerRebidBid.strain !== (myResponseBid && myResponseBid.strain)
                && responseLengths && responseLengths[partnerRebidBid.strain] >= 4;
            const knowsGameZoneViaFit = !knowsGameZone && partnerOpeningBid && partnerRebidSuitFit
                && computeSupportPoints(hand, partnerRebidBid.strain, 4) + OPENING_MINIMUM >= (
                    ((partnerRebidBid.strain === 'S' || partnerRebidBid.strain === 'H') ? GAME_ZONE_MAJOR : GAME_ZONE_MINOR) - 2
                    // Voir échange avec Guillaume (session du 24 juillet, donne 4) : tolérance
                    // de 2 points — "il doit A MINIMA PROPOSER la manche" (ses mots), une
                    // invite raisonnable plutôt qu'une certitude absolue à 100% ; l'estimation
                    // du minimum du partenaire (OPENING_MINIMUM) est déjà approximative,
                    // pas la peine d'exiger le seuil strict au point près.
                );

            const partnerBidsCount = history.filter(e => e.seat === myPartnerBid.seat && !isPass(e.call)).length;
            // Voir échange avec Guillaume, donne 2 : le 4SA quantitatif (voir
            // decideOpenerRebidAfterNewSuit) doit toujours obtenir une réponse, même avec
            // peu de points — c'est le partenaire qui a déjà signalé une force écrasante et
            // pose une vraie question, pas un simple "j'ai assez pour continuer" du côté
            // du répondant comme le sous-entend knowsGameZone.
            const mustAnswerQuantitative = myPartnerBid.call === '4NT';

            // Voir échange avec Guillaume, donne 1 (session du 22 juillet) : en zone basse
            // du répondant (6-10H, sous le seuil de knowsGameZone), avec une main plate et
            // sans 6+ cartes dans sa propre couleur pour l'imposer (le partenaire n'a rien
            // promis dans cette couleur en redemandant autre chose que SA), "1SA" reste la
            // meilleure description — mieux qu'un passe qui n'exprime rien sur la main.
            // Voir échange avec Guillaume (session du 23 juillet, donne 2) : exclu si le
            // partenaire a en fait SOUTENU ma propre couleur (même famille que
            // myResponseBid.strain) plutôt que redemandé autre chose — dans ce cas, son
            // enchère est une INVITE (accepter/décliner), pas une description de main
            // équilibrée à améliorer. Convertir en SA reviendrait à ACCEPTER l'invite à
            // tort avec une main minimale (6-10H) qui doit au contraire décliner
            // (=passer, le filet par défaut plus bas s'en charge déjà correctement).
            const lowZoneFlatNoInsist = partnerOpeningBid && myResponseBid && !knowsGameZone
                && myResponseBid.strain !== partnerOpeningBid.strain && myResponseBid.strain !== 'NT'
                && partnerRebidBid && partnerRebidBid.strain !== myResponseBid.strain
                && hcp >= 6 && hcp <= 10
                && responseLengths[myResponseBid.strain] < 6
                && isHandBalancedForNT(responseLengths);

            // Voir échange avec Guillaume (session du 23 juillet — "ne pas passer sur une
            // situation forcing") : un RENVERSE de l'ouvreur (2e couleur annoncée de rang
            // supérieur à la 1ère, au palier immédiatement au-dessus de ce qu'il faudrait
            // pour revenir à sa 1ère couleur) est forcing — le répondant NE DOIT PAS
            // passer, quelle que soit sa main, même minimale (voir donne 8).
            // Voir échange avec Guillaume (session du 24 juillet, donne 2 — RÉGRESSION
            // trouvée) : "partnerRebidBid.strain !== myResponseBid.strain" en plus, sinon
            // un simple SOUTIEN du partenaire à MA PROPRE couleur (ex. 1♦-1♥-2♥, où le
            // partenaire relance juste ma couleur, jamais une 3ème) se faisait à tort
            // passer pour un renverse — un renverse exige une VRAIE 3ème couleur, jamais
            // une simple relance de celle du répondant.
            const partnerRebidIsReverse = partnerOpeningBid && partnerRebidBid && partnerRebidBid.strain !== 'NT'
                && partnerRebidBid.strain !== partnerOpeningBid.strain
                && partnerRebidBid.strain !== myResponseBid.strain
                && STRAIN_RANK[partnerRebidBid.strain] > STRAIN_RANK[partnerOpeningBid.strain]
                && partnerRebidBid.level === partnerOpeningBid.level + 1;

            // Voir échange avec Guillaume (session du 23 juillet, donnes 1 et 6) : le
            // partenaire a redemandé SA (main équilibrée) — s'il existe un fit connu dans
            // SA PROPRE couleur d'ouverture (5+ cartes si mineure, 3+ si majeure) et que
            // la main est trop faible pour forcer (knowsGameZone déjà géré ailleurs, en
            // priorité), mieux vaut corriger vers ce fit que de laisser jouer SA.
            const partnerRebidWasLowNT = partnerRebidBid && partnerRebidBid.strain === 'NT' && partnerRebidBid.level <= 2;
            const openingSuitIsMajor = partnerOpeningBid && (partnerOpeningBid.strain === 'H' || partnerOpeningBid.strain === 'S');
            const fitThresholdInOpeningSuit = openingSuitIsMajor ? 3 : 5;
            const hasKnownFitInOpeningSuit = partnerRebidWasLowNT && partnerOpeningBid && myResponseBid
                && myResponseBid.strain !== partnerOpeningBid.strain
                && responseLengths && responseLengths[partnerOpeningBid.strain] >= fitThresholdInOpeningSuit;

            // Voir échange avec Guillaume (session du 24 juillet, donne 2 — nouveau bug) :
            // règle JUMELLE de celle ci-dessus, mais pour MA PROPRE couleur (celle que
            // J'AI annoncée en réponse), pas celle d'ouverture du partenaire — "quand
            // l'ouvreur redemande à SA, le répondant avec une majeure 5ème sans espoir de
            // manche, répète sa couleur" (ses mots). Distincte de hasKnownFitInOpeningSuit
            // (qui concerne la couleur DU PARTENAIRE) : ici c'est ma propre couleur, déjà
            // montrée, qu'il s'agit de répéter faute de mieux.
            const hasOwnMajorToRepeat = partnerRebidWasLowNT && myResponseBid
                && (myResponseBid.strain === 'H' || myResponseBid.strain === 'S')
                && responseLengths && responseLengths[myResponseBid.strain] >= 5;

            // Voir échange avec Guillaume (session du 24 juillet, donne 3) : réponse
            // MINI/MAXI à l'enchère d'ESSAI (2SA générique) du partenaire, après que j'ai
            // moi-même simplement soutenu sa majeure au palier 2 — voir la moitié
            // symétrique de cette règle dans decideRobotOpenerRebid (la main d'essai,
            // 15-17HL). Mini (revient dans le fit au palier minimal, pas d'insistance) en
            // dessous de 9 points de soutien (voir computeSupportPoints — HCP + 9ème
            // atout + distribution, la même mesure que pour décider du soutien initial) ;
            // maxi (manche) à partir de 9. Le cas 8 pile est ambigu (voir ses notes — "on
            // implémentera le calcul avec les points KR plus tard") : traité en mini par
            // simplification, pas encore de réévaluation plus fine.
            const wasTrialBidAsk = myPartnerBid.call === '2NT' && openingSuitIsMajor
                && myResponseBid && myResponseBid.strain === partnerOpeningBid.strain && myResponseBid.level === 2;

            // Voir échange avec Guillaume (session du 24 juillet, donne 4) : PRÉFÉRENCE
            // SIMPLE entre les deux couleurs (de vraies COULEURS, pas SA) montrées par le
            // partenaire — son ouverture ET sa redemande — prioritaire sur
            // lowZoneFlatNoInsist plus bas : avec une main minimale (jusqu'à 9H) et
            // réellement plus de cartes dans l'ouverture que dans la redemande, y
            // revenir (même un "semi-fit" 5/2) vaut mieux qu'inventer un SA sans arrêt
            // confirmé dans la couleur adverse. Si au contraire la redemande est déjà la
            // meilleure des deux, rien à faire ici — le passe par défaut plus bas
            // l'accepte telle quelle, exactement ce qu'on veut.
            const partnerRebidIsSuit = partnerRebidBid && partnerRebidBid.strain !== 'NT' && partnerRebidBid.strain !== partnerOpeningBid.strain;
            // Voir échange avec Guillaume (donne 7, session du 30 juillet) : le partenaire
            // a directement SOUTENU ma propre couleur nommée en réponse (ex. 1D-1S-2S) —
            // situation symétrique de celle déjà gérée côté OUVREUR (isRaiseOfMySuit dans
            // decideRobotOpenerRebid), mais ici c'est MOI qui ai nommé la couleur en
            // réponse, pas ouvert la donne. Avant cette correction, AUCUNE branche de ce
            // bloc ne reconnaissait ce cas précis (toutes supposaient soit un CHANGEMENT
            // de couleur du partenaire, soit sa propre ouverture répétée) — il tombait en
            // silence sur le passe par défaut, quel que soit le nombre de points.
            const isPartnerRaiseOfMyResponse = myResponseBid && partnerRebidBid
                && partnerRebidBid.strain === myResponseBid.strain
                && partnerRebidBid.level === myResponseBid.level + 1;
            let preferenceCall = null;
            if (partnerRebidIsSuit && hcp <= 9 && responseLengths) {
                const openingLen = responseLengths[partnerOpeningBid.strain];
                const rebidLen = responseLengths[partnerRebidBid.strain];
                if (openingLen >= 2 && rebidLen < openingLen + 2) {
                    for (let level = partnerRebidBid.level; level <= 7; level++) {
                        const c = level + partnerOpeningBid.strain;
                        if (isCallLegal(history, c, seat)) { preferenceCall = c; break; }
                    }
                }
            }

            // Voir échange avec Guillaume (donne 8, session du 30 juillet) : avant de me
            // rabattre sur une simple préférence entre les 2 couleurs du partenaire (ci-
            // dessous), ma PROPRE couleur déjà montrée (6+ cartes) mérite d'être répétée
            // au palier minimal — plus descriptif qu'une préférence qui ignore ma vraie
            // main. Uniquement la zone basse (6-9H) ici : dès 10H+ avec un fit 6ème+,
            // hl atteint déjà 12+ (bonus de longueur inclus) et knowsGameZone intercepte
            // AVANT ce bloc — voir decideResponderContinuationAfterNewSuit pour la suite
            // (conclusion à la manche, ou saut d'invite si la manche n'est pas certaine).
            let ownSuitRepeatCall = null;
            if ((myResponseBid.strain === 'S' || myResponseBid.strain === 'H') && responseLengths && responseLengths[myResponseBid.strain] >= 6) {
                for (let level = partnerRebidBid.level; level <= 7; level++) {
                    const c = level + myResponseBid.strain;
                    if (isCallLegal(history, c, seat)) { ownSuitRepeatCall = c; break; }
                }
            }

            if ((knowsGameZone || mustAnswerQuantitative || knowsGameZoneViaFit || was2over1GameForcing) && partnerBidsCount === 2) {
                call = decideResponderContinuationAfterNewSuit(hand, hcp, hl, partnerOpeningBid, myResponseBid, myPartnerBid.call, seat, history);
                explanation = `Suite en zone de manche après ${formatCallForDisplay(myPartnerBid.call)} du partenaire (${points})`;
            } else if (partnerRebidIsReverse && partnerBidsCount === 2) {
                call = decideReverseForcingResponse(hand, myResponseBid, partnerOpeningBid, partnerRebidBid, seat, history);
                explanation = `Renverse du partenaire (${formatCallForDisplay(myPartnerBid.call)}), forcing — obligation de reparler (${points})`;
            } else if (hasKnownFitInOpeningSuit && partnerBidsCount === 2) {
                const correctionCall = (partnerRebidBid.level + 1) + partnerOpeningBid.strain;
                if (isCallLegal(history, correctionCall, seat)) {
                    call = correctionCall;
                    explanation = `Fit connu à ${STRAIN_SYMBOL[partnerOpeningBid.strain]} (${responseLengths[partnerOpeningBid.strain]} cartes) avec l'ouverture du partenaire — corrige plutôt que de laisser jouer SA (${points})`;
                } else {
                    explanation = `A déjà annoncé — passe (règle du tour unique)`;
                }
            } else if (hasOwnMajorToRepeat && partnerBidsCount === 2) {
                const repeatCall = (partnerRebidBid.level + 1) + myResponseBid.strain;
                if (isCallLegal(history, repeatCall, seat)) {
                    call = repeatCall;
                    explanation = `Majeure 5ème (${responseLengths[myResponseBid.strain]} cartes) sans espoir de manche — répète sa couleur plutôt que de laisser jouer SA (${points})`;
                } else {
                    explanation = `A déjà annoncé — passe (règle du tour unique)`;
                }
            } else if (wasTrialBidAsk && partnerBidsCount === 2) {
                const supportPts = computeSupportPoints(hand, partnerOpeningBid.strain, 5);
                if (supportPts >= 9) {
                    call = '4' + partnerOpeningBid.strain;
                    explanation = `Maxi de mon soutien (${supportPts} points de soutien) — accepte l'essai, manche (${points})`;
                } else {
                    call = '3' + partnerOpeningBid.strain;
                    explanation = `Mini de mon soutien (${supportPts} points de soutien) — décline l'essai, revient au palier minimal (${points})`;
                }
            } else if (isPartnerRaiseOfMyResponse && partnerBidsCount === 2) {
                // Voir échange avec Guillaume ("HL avant un fit, HLD après", session du 30
                // juillet) : le partenaire vient de SOUTENIR directement ma couleur — un
                // fit est confirmé, donc points de SOUTIEN (HLD), pas HCP brut comme dans
                // ma première version de cette branche (bug trouvé au même audit que celui
                // qui a corrigé decideOpenerRebidAfterNewSuit). Mêmes seuils qu'ailleurs
                // pour un soutien direct sans saut (12-14H de sa part) : sous 15 points de
                // soutien, ma main est déjà décrite, rien de plus à ajouter ; 15-17,
                // enchère d'essai (2SA générique) ; 18+, manche directe.
                const supportPointsForRaise = computeSupportPoints(hand, myResponseBid.strain, 4);
                if (supportPointsForRaise >= 18) {
                    const isMajor = myResponseBid.strain === 'S' || myResponseBid.strain === 'H';
                    const gameLevel = isMajor ? 4 : 5;
                    for (let level = Math.max(gameLevel, partnerRebidBid.level); level <= 7; level++) {
                        const c = level + myResponseBid.strain;
                        if (isCallLegal(history, c, seat)) { call = c; break; }
                    }
                    explanation = call !== 'PASS'
                        ? `Soutien direct du partenaire (12-14H) — assez de points de soutien pour viser la manche (${points})`
                        : `A déjà annoncé — passe (règle du tour unique)`;
                } else if (supportPointsForRaise >= 15 && partnerRebidBid.level === 2 && isCallLegal(history, '2NT', seat)) {
                    call = '2NT';
                    explanation = `Soutien direct du partenaire (12-14H) — enchère d'essai, juste sous la manche connue (${points})`;
                } else {
                    explanation = `Soutien direct du partenaire (12-14H) — pas assez pour insister, on reste là (${points})`;
                }
            } else if (ownSuitRepeatCall && partnerBidsCount === 2) {
                call = ownSuitRepeatCall;
                explanation = `Zone basse (6-9H) avec ma couleur déjà montrée (${responseLengths[myResponseBid.strain]} cartes) — je la répète au palier minimal (${points})`;
            } else if (preferenceCall && partnerBidsCount === 2) {
                call = preferenceCall;
                explanation = `Préférence simple vers l'ouverture du partenaire (${responseLengths[partnerOpeningBid.strain]} cartes, contre ${responseLengths[partnerRebidBid.strain]} dans sa redemande) plutôt qu'un SA sans arrêt confirmé (${points})`;
            } else if (partnerBidsCount === 1 && hcp >= 18) {
                // Voir échange avec Guillaume (session du 23 juillet, donne 7) : le
                // partenaire n'a fait qu'ouvrir puis passer (typiquement après une
                // intervention adverse, laissant la décision au répondant) — mais avec
                // une main aussi forte que celle-ci (18H+), le camp est de toute façon en
                // zone de chelem quoi qu'ait dit le partenaire depuis (12+ de l'ouverture
                // + 18+ de ma main = 30+). Pas question de laisser filer par un simple
                // passe. S'il y a une belle longue (6+), on l'impose directement au
                // palier de petit chelem — sinon, repli sur la manche à SA plutôt qu'un
                // passe qui n'exprime rien sur une main pareille.
                const lengths = suitLengths(hand);
                const longestSuit = ['S', 'H', 'D', 'C'].reduce((best, s) => lengths[s] > lengths[best] ? s : best, 'S');
                const slamCall = '6' + longestSuit;
                if (lengths[longestSuit] >= 6 && isCallLegal(history, slamCall, seat)) {
                    call = slamCall;
                    explanation = `Main énorme (${hcp}H) avec une longue à ${STRAIN_SYMBOL[longestSuit]} (${lengths[longestSuit]} cartes) — impose sa couleur en zone de chelem plutôt que de laisser filer (${points})`;
                } else if (isCallLegal(history, '3NT', seat)) {
                    call = '3NT';
                    explanation = `Main énorme (${hcp}H) mais pas de longue franche à imposer — repli sur la manche à SA plutôt qu'un passe (${points})`;
                }
            } else if (lowZoneFlatNoInsist && partnerBidsCount === 2) {
                const ntCall = parseBid(myPartnerBid.call).level + 'NT';
                if (isCallLegal(history, ntCall, seat)) {
                    call = ntCall;
                    explanation = `Zone basse (6-10H), main plate, pas de 6ème pour imposer sa couleur — repli SA (${points})`;
                } else {
                    explanation = `A déjà annoncé — passe (règle du tour unique)`;
                }
            } else if (partnerBidsCount === 2 && !preferenceCall
                    && responseLengths[partnerOpeningBid.strain] < 3
                    && (partnerRebidBid.strain === 'NT' || responseLengths[partnerRebidBid.strain] < 3)
                    && hl >= 10) {
                // Voir échange avec Guillaume (session du 25 juillet, donne 3) : mésentente
                // TOTALE avec les deux couleurs du partenaire (ni son ouverture, ni sa
                // redemande — sinon preferenceCall aurait déjà tranché) — évalué en HL,
                // pas HCP brut, la distribution comptant pleinement en misfit (un 5-5
                // vaut nettement plus que son HCP tout seul). La vraie enchère serait la
                // 4ème couleur forcing pour préciser encore (hors périmètre, trop
                // complexe pour une main sur plusieurs centaines) — on va directement au
                // poids : 25H+ (avec le minimum d'ouverture) → 3SA, la manche est acquise
                // malgré le misfit ; sinon, zone "limite" (10-11HL environ), 2SA montre
                // cette force précise sans forcer.
                if (hl + OPENING_MINIMUM >= GAME_ZONE_NT) {
                    const call3NT = '3NT';
                    if (isCallLegal(history, call3NT, seat)) {
                        call = call3NT;
                        explanation = `Mésentente avec les deux couleurs du partenaire, mais assez pour la manche au poids (${points})`;
                    } else {
                        explanation = `A déjà annoncé — passe (règle du tour unique)`;
                    }
                } else {
                    const call2NT = '2NT';
                    if (isCallLegal(history, call2NT, seat)) {
                        call = call2NT;
                        explanation = `Mésentente avec les deux couleurs du partenaire — montre une main limite sans forcer (${points})`;
                    } else {
                        explanation = `A déjà annoncé — passe (règle du tour unique)`;
                    }
                }
            } else {
                explanation = `A déjà annoncé — passe (règle du tour unique)`;
            }
            }
            } else if (call === 'PASS') {
                explanation = `Pas de vraie ouverture de mon propre camp dans cette séquence (ex. réponse au contre du partenaire plutôt qu'à une ouverture, voir échange avec Guillaume) — passe (${points})`;
            }
        } else if (wasOpening && !myPartnerBid) {
            // Voir échange avec Guillaume (session du 24 juillet, donne 5) : mon
            // partenaire n'a fait que passer (aucune vraie annonce) — mais si le DERNIER
            // appel est un contre ADVERSE (typiquement un contre de réveil sur ma propre
            // ouverture, voir decideRobotIntervention/isReopening), je dois réagir plutôt
            // que rester silencieux : avec une main NON minimale (13H+) et une belle
            // couleur (6+ cartes — voir échange avec Guillaume, session du 25 juillet,
            // donne 3 : 5 cartes ne suffisent PAS, "il lui faudrait 6 cartes"), je la
            // répète — le contre adverse cherche justement à profiter du silence
            // général, une main un peu au-dessus du minimum ne doit pas le laisser
            // filer. Rien d'autre géré ici (main minimale, couleur trop courte, ou
            // dernier appel différent d'un contre) : passe par défaut.
            const lastCall = history[history.length - 1];
            const opponentJustDoubled = lastCall && isDouble(lastCall.call) && partnershipOf(lastCall.seat) !== partnershipOf(seat);
            if (opponentJustDoubled) {
                const lengths = suitLengths(hand);
                const myOpeningBid = parseBid(myBids[0].call);
                const repeatCall = myOpeningBid ? (myOpeningBid.level + 1) + myOpeningBid.strain : null;
                if (myOpeningBid && lengths[myOpeningBid.strain] >= 6 && hl >= 13 && repeatCall && isCallLegal(history, repeatCall, seat)) {
                    call = repeatCall;
                    explanation = `Contre adverse de réveil sur ma propre ouverture, main non minimale (${points}) avec une belle couleur — répète plutôt que de laisser filer`;
                } else {
                    explanation = `A déjà annoncé — passe (règle du tour unique)`;
                }
            } else {
                explanation = `A déjà annoncé — passe (règle du tour unique)`;
            }
        } else {
            explanation = `A déjà annoncé — passe (règle du tour unique)`;
        }
    } else if (myBids.length === 2) {
        // Voir échange avec Guillaume (session du 30 juillet — "Ouest passe sur le
        // Texas, ça n'a aucun sens") : mon ouverture était-elle 2♣/2♦ (fort), ma 2e
        // annonce un "2SA" naturel (voir decideOpenerRebidAfterStrongDiamond), et le
        // partenaire vient-il de faire un appel Stayman/transfert dessus ? Ce "2SA"
        // fonctionne alors EXACTEMENT comme une ouverture à SA pour la complétion —
        // réutilise directement decideRobotOpenerRebid (le mécanisme de complétion y
        // est purement mécanique, ne regarde jamais quelle était ma vraie ouverture
        // d'origine) plutôt que de laisser tomber ça dans une des branches génériques
        // ci-dessous, qui ne reconnaissent pas du tout ce cas et retombaient sur un
        // passe — sur une enchère forcing du partenaire (un transfert l'est toujours,
        // le temps d'un tour), passer est formellement interdit tant qu'aucun adversaire
        // n'a repris la parole entre-temps.
        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet) :
        // même garde-fou que pour partnerFirstBidForCRMWasRealOpening plus bas — myBids[0]
        // doit être le TOUT PREMIER appel de l'enchère entière, sinon "2C"/"2D" pourrait
        // être une réponse naturelle coïncidant avec cette chaîne, pas une vraie ouverture.
        const myBid0IndexForCRM = history.indexOf(myBids[0]);
        const myBids0WasRealOpening = history.slice(0, myBid0IndexForCRM).every(e => isPass(e.call));
        if (myBids0WasRealOpening && (myBids[0].call === '2C' || myBids[0].call === '2D') && myBids[1].call === '2NT') {
            const myPartnerBidForTransfer = history.slice().reverse()
                .find(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));
            if (myPartnerBidForTransfer) {
                // Voir échange avec Guillaume (donne 4, 2e jeu, session du 31 juillet —
                // "pourquoi est-ce que Ouest rectifie le Texas ?") : contrairement à un
                // Texas sur un VRAI 1SA (où la complétion est toujours purement
                // mécanique, quelle que soit la main — la manche n'est pas encore
                // acquise, aucune raison de dévier), ici l'ouverture forte (22+/24+) a
                // DÉJÀ garanti la manche à elle seule. La rectification n'a donc plus
                // besoin d'être aveugle : si j'ai le fit (3+ cartes, le partenaire en
                // promet 5), je complète normalement ; SINON, je dis 3SA directement —
                // jamais une couleur sans le moindre support, puisque la manche est de
                // toute façon acquise par ailleurs. Concerne uniquement un vrai
                // TRANSFERT MAJEUR (3♦→♥, 3♥→♠) ; Stayman et transfert mineur restent
                // purement mécaniques comme avant (aucune ambiguïté de fit à trancher).
                const partnerAskParsedForTexasFit = parseBid(myPartnerBidForTransfer.call);
                const isMajorTransferAskForFit = partnerAskParsedForTexasFit
                    && (partnerAskParsedForTexasFit.strain === 'D' || partnerAskParsedForTexasFit.strain === 'H')
                    && partnerAskParsedForTexasFit.level === 3;
                if (isMajorTransferAskForFit) {
                    const transferredSuitForFit = partnerAskParsedForTexasFit.strain === 'D' ? 'H' : 'S';
                    const lengthsForTexasFit = suitLengths(hand);
                    if (lengthsForTexasFit[transferredSuitForFit] >= 3) {
                        const mechanicalCall = partnerAskParsedForTexasFit.level + transferredSuitForFit;
                        if (isCallLegal(history, mechanicalCall, seat)) {
                            return { call: mechanicalCall, explanation: `Texas fitté (${lengthsForTexasFit[transferredSuitForFit]} cartes à ${STRAIN_SYMBOL[transferredSuitForFit]}) après l'ouverture forte — complète normalement (${points})` };
                        }
                    } else {
                        for (let level = 3; level <= 7; level++) {
                            const c = level + 'NT';
                            if (isCallLegal(history, c, seat)) {
                                return { call: c, explanation: `Texas SANS fit (${lengthsForTexasFit[transferredSuitForFit]} carte(s) à ${STRAIN_SYMBOL[transferredSuitForFit]}) après l'ouverture forte — 3SA plutôt qu'une couleur sans support, la manche est de toute façon déjà acquise (${points})` };
                            }
                        }
                    }
                }
                const callAfterTransferAsk = decideRobotOpenerRebid(hand, hcp, hl, '2NT', myPartnerBidForTransfer.call, seat, history, false);
                return { call: callAfterTransferAsk, explanation: `Complétion mécanique de Stayman/Texas sur mon propre "2SA" après l'ouverture forte — jamais de passe sur une enchère forcing (${points})` };
            }
        }

        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet —
        // pendant côté RÉPONDANT du cas juste au-dessus) : mon 1er bid était le relais
        // forcing (2♦ sur 2♣, ou ma réponse CRM sur 2♦), mon 2e bid était MON PROPRE
        // Texas/Stayman sur le "2SA" naturel du partenaire, et il vient de le compléter.
        // Sans ce cas, ça retombait sur "règle du tour unique" — passe — ignorant que le
        // plancher de l'ouvreur est énorme ici (22 minimum pour 2♣, 24 pour 2♦), donc
        // quasiment toujours la manche au minimum une fois le fit confirmé par la
        // complétion.
        const partnerBidsForCRM = history.filter(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));
        const partnerBid0WasRealOpeningForCRM = partnerBidsForCRM.length > 0
            && history.slice(0, history.indexOf(partnerBidsForCRM[0])).every(e => isPass(e.call));
        if (partnerBidsForCRM.length >= 3 && partnerBid0WasRealOpeningForCRM
            && (partnerBidsForCRM[0].call === '2C' || partnerBidsForCRM[0].call === '2D')
            && partnerBidsForCRM[1].call === '2NT') {
            const myTransferAskBid = parseBid(myBids[1].call);
            const partnerCompletionBid = parseBid(partnerBidsForCRM[2].call);
            if (myTransferAskBid && partnerCompletionBid && partnerCompletionBid.strain !== 'NT') {
                const fitSuit = partnerCompletionBid.strain;
                const supportPointsForFit = computeSupportPoints(hand, fitSuit, 2);
                const openerMinHl = partnerBidsForCRM[0].call === '2D' ? 24 : 22;
                const isMajorFit = fitSuit === 'S' || fitSuit === 'H';
                const gameLevel = isMajorFit ? 4 : 5;
                if (supportPointsForFit + openerMinHl >= (isMajorFit ? GAME_ZONE_MAJOR : GAME_ZONE_MINOR)) {
                    for (let level = gameLevel; level <= 7; level++) {
                        const c = level + fitSuit;
                        if (isCallLegal(history, c, seat)) { call = c; break; }
                    }
                    explanation = call !== 'PASS'
                        ? `Suite de mon propre Texas après ouverture forte du partenaire — manche acquise (${points})`
                        : `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
                } else {
                    explanation = `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
                }
                return { call, explanation };
            }
        }

        // Voir échange avec Guillaume (session du 25 juillet, donne 1) : réponse à
        // l'APPEL AUX MINEURES en réveil du partenaire (voir la même règle dans
        // decideRobotResponse pour un 1er tour) — ici pour un 3ème tour, quand j'ai déjà
        // ouvert/rebiddé avant que le partenaire ne réveille. Priorité absolue : pas de
        // sens de traiter ça comme une suite de renverse ou autre chose.
        const myLastBidCheck = history.slice().reverse().find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call));
        const myPartnerLastBidCheck = history.slice().reverse().find(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));

        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet) : le
        // partenaire a-t-il SAUTÉ en répétant SA PROPRE couleur déjà montrée (pas la
        // mienne, pas un soutien) — invite classique montrant une réserve, jamais une
        // simple redemande minimale. Sans cette reconnaissance, ça retombait sur "règle
        // du tour unique" — passe — même avec une main d'ouverture largement au-dessus
        // du minimum qui devrait accepter. Seuil (16HL) : jugement propre, pas une
        // fourchette précise donnée par Guillaume — main "nettement" au-dessus du
        // minimum d'ouverture, à ajuster si trop généreux ou trop strict en pratique.
        const partnerFirstBidForJumpCheck = history.find(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));
        if (myPartnerLastBidCheck && partnerFirstBidForJumpCheck && myPartnerLastBidCheck !== partnerFirstBidForJumpCheck) {
            const partnerFirstParsed = parseBid(partnerFirstBidForJumpCheck.call);
            const partnerLastParsed = parseBid(myPartnerLastBidCheck.call);
            if (partnerFirstParsed && partnerLastParsed && partnerFirstParsed.strain === partnerLastParsed.strain) {
                const historyBeforePartnerLast = history.slice(0, history.indexOf(myPartnerLastBidCheck));
                let naturalLevelForJumpCheck = null;
                for (let level = 1; level <= 7; level++) {
                    if (isCallLegal(historyBeforePartnerLast, level + partnerLastParsed.strain, myPartnerLastBidCheck.seat)) { naturalLevelForJumpCheck = level; break; }
                }
                const wasJumpRepeat = naturalLevelForJumpCheck !== null && partnerLastParsed.level > naturalLevelForJumpCheck;
                // Voir échange avec Guillaume (donnes 1 et 4, 1er jeu, session du 31
                // juillet — "expliquer/que veut dire 5♠ en Ouest ?") : bug trouvé en
                // expliquant ces deux donnes — ce bloc ne vérifiait jamais que le saut du
                // partenaire restait EN DESSOUS du palier de manche. Un saut qui atteint
                // déjà la manche (ex. 4♠ direct dans une couleur 7-8ème) n'est plus une
                // invite à "accepter" avec de la réserve — le partenaire vient de
                // CONCLURE, pas de proposer. Résultat sans ce garde-fou : Ouest relançait
                // à 5♠ avec seulement 2 cartes (donne 1) voire un singleton (donne 4) à
                // Pique, sur la seule foi de ses propres 16HL+, sans le moindre rapport
                // avec un vrai fit. Seule une VRAIE invite (le saut s'arrête avant la
                // manche, comme 1♠-3♠ qui attend 4♠) doit déclencher cette acceptation.
                const isMajorForJump = partnerLastParsed.strain === 'S' || partnerLastParsed.strain === 'H';
                const gameLevelForJump = isMajorForJump ? 4 : 5;
                if (wasJumpRepeat && hl >= 16 && partnerLastParsed.level < gameLevelForJump) {
                    for (let level = Math.max(gameLevelForJump, partnerLastParsed.level); level <= 7; level++) {
                        const c = level + partnerLastParsed.strain;
                        if (isCallLegal(history, c, seat)) { call = c; break; }
                    }
                    if (call !== 'PASS') {
                        return { call, explanation: `Saut du partenaire dans sa propre couleur — invite acceptée avec ma réserve (${points})` };
                    }
                }
            }
        }

        if (myPartnerLastBidCheck && myPartnerLastBidCheck.call === '2NT') {
            const partnerIdx = history.indexOf(myPartnerLastBidCheck);
            const last2 = history.slice(Math.max(0, partnerIdx - 2), partnerIdx);
            const wasReopening = last2.length === 2 && last2.every(e => isPass(e.call));
            if (wasReopening) {
                const lengths2 = suitLengths(hand);
                const preferred = lengths2['D'] > lengths2['C'] ? 'D' : 'C';
                const c = 3 + preferred;
                if (isCallLegal(history, c, seat)) {
                    call = c;
                    explanation = `Réponse à l'appel aux mineures du partenaire, en réveil (${points})`;
                } else {
                    explanation = `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
                }
                return { call, explanation };
            }
        }
        // Voir échange avec Guillaume (session du 24 juillet, donne 8 — "toujours pas
        // résolu") : jusqu'ici, AUCUNE branche ne gérait un 3e tour d'enchère pour soi —
        // ça retombait systématiquement sur le passe par défaut, quoi qu'il arrive. Gère
        // ici UNIQUEMENT la suite d'un RENVERSE qu'on vient de faire SOI-MÊME (même
        // définition que partnerRebidIsReverse plus haut, appliquée à ses 2 propres
        // enchères cette fois) : un renverse est "auto-forcing" — celui qui l'a fait
        // s'engage par avance à reparler encore une fois, même sur la réponse la plus
        // économique du partenaire. Tout le reste d'un 3e tour (hors renverse) n'est pas
        // encore couvert et retombe sur le passe par défaut, comme avant.
        const myFirstBid = parseBid(myBids[0].call);
        const mySecondBid = parseBid(myBids[1].call);

        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet) : mon
        // ouverture était-elle "1SA", ma 2e annonce une réponse Stayman montrant une
        // majeure (2C demandé par le partenaire), et il vient de SOUTENIR cette majeure
        // en invite (sans sauter directement à la manche) ? Avant cette correction,
        // AUCUNE branche ne répondait à cette invite précise — ça tombait sur le passe
        // par défaut, quel que soit mon HCP dans ma fourchette de 1SA déjà connue.
        const myPartnerLastBidForStaymanInvite = history.slice().reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call) && e !== myBids[0] && e !== myBids[1]);
        const partnerInviteParsed = myPartnerLastBidForStaymanInvite ? parseBid(myPartnerLastBidForStaymanInvite.call) : null;
        const wasStaymanMajorThenInvite = myFirstBid && myFirstBid.strain === 'NT' && myFirstBid.level === 1
            && mySecondBid && (mySecondBid.strain === 'H' || mySecondBid.strain === 'S') && mySecondBid.level === 2
            && partnerInviteParsed && partnerInviteParsed.strain === mySecondBid.strain
            && partnerInviteParsed.level === mySecondBid.level + 1;

        if (wasStaymanMajorThenInvite) {
            // Fourchette de 1SA déjà connue (15-17) — pas besoin de recalculer en
            // points de soutien ici, MA main est déjà entièrement connue de moi-même :
            // haut de fourchette (16+), j'accepte l'invite ; bas (15), je décline.
            if (hcp >= 16) {
                for (let level = 4; level <= 7; level++) {
                    const c = level + mySecondBid.strain;
                    if (isCallLegal(history, c, seat)) { call = c; break; }
                }
                explanation = call !== 'PASS'
                    ? `Invite du partenaire après Stayman, haut de ma fourchette de 1SA (${points}) — accepte, manche`
                    : `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
            } else {
                explanation = `Invite du partenaire après Stayman, bas de ma fourchette de 1SA (${points}) — décline, reste au palier d'invite`;
            }
            return { call, explanation };
        }

        // Voir échange avec Guillaume (donne 7, session du 30 juillet) : ma 2ème annonce
        // a-t-elle directement SOUTENU la couleur nommée par le partenaire en réponse
        // (ex. 1D-1S-2S, moi=l'ouvreur) ? Si oui et qu'il vient de renvoyer "2SA" (son
        // enchère d'essai symétrique, voir isPartnerRaiseOfMyResponse dans decideRobotCall),
        // je réponds mini/maxi selon ma PROPRE réserve au-delà du minimum déjà montré par
        // mon soutien (12-14H) — même principe que wasTrialBidAsk plus haut dans ce
        // fichier, pour l'essai symétrique côté OUVREUR celui-là.
        const myPartnerFirstBidForTry = history.find(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));
        const myPartnerFirstBidParsed = myPartnerFirstBidForTry ? parseBid(myPartnerFirstBidForTry.call) : null;
        const iRaisedPartnerSuit = myFirstBid && mySecondBid && myPartnerFirstBidParsed
            && myFirstBid.strain !== myPartnerFirstBidParsed.strain
            && mySecondBid.strain === myPartnerFirstBidParsed.strain
            && mySecondBid.level === myPartnerFirstBidParsed.level + 1;
        const myPartnerLastBidForTry = history.slice().reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call) && e !== myBids[0] && e !== myBids[1]);

        if (iRaisedPartnerSuit && myPartnerLastBidForTry && myPartnerLastBidForTry.call === '2NT') {
            const supportPts = computeSupportPoints(hand, myPartnerFirstBidParsed.strain, 4);
            const fitSuit = myPartnerFirstBidParsed.strain;
            if (supportPts >= 9) {
                for (let level = 4; level <= 7; level++) {
                    const c = level + fitSuit;
                    if (isCallLegal(history, c, seat)) { call = c; break; }
                }
                explanation = call !== 'PASS'
                    ? `Maxi de mon soutien (${supportPts} points de soutien) — accepte l'essai du partenaire, manche (${points})`
                    : `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
            } else {
                for (let level = mySecondBid.level; level <= 7; level++) {
                    const c = level + fitSuit;
                    if (isCallLegal(history, c, seat)) { call = c; break; }
                }
                explanation = call !== 'PASS'
                    ? `Mini de mon soutien (${supportPts} points de soutien) — décline l'essai du partenaire, revient au palier minimal (${points})`
                    : `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
            }
            return { call, explanation };
        }
        // Voir échange avec Guillaume (outil de simulation, session du 30 juillet — bug
        // trouvé, même famille que les précédents ce soir) : iReversed se contente de
        // comparer les rangs/paliers de mes deux annonces, sans vérifier que la 2e était
        // bien une VRAIE redemande naturelle — si elle était en réalité ma réponse au
        // contre du partenaire (voir decideOpenerResponseToPartnerDouble), la même
        // signature de rang/palier peut se produire sans être un renverse du tout.
        const mySecondBidWasResponseToPartnerDouble = history
            .slice(history.indexOf(myBids[0]) + 1, history.indexOf(myBids[1]))
            .some(e => isDouble(e.call) && partnershipOf(e.seat) === partnershipOf(seat));
        const iReversed = !mySecondBidWasResponseToPartnerDouble && myFirstBid && mySecondBid && mySecondBid.strain !== 'NT'
            && mySecondBid.strain !== myFirstBid.strain
            && STRAIN_RANK[mySecondBid.strain] > STRAIN_RANK[myFirstBid.strain]
            && mySecondBid.level === myFirstBid.level + 1;
        const myPartnerLastBid = history.slice().reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call) && e !== myBids[0] && e !== myBids[1]);

        if (iReversed && myPartnerLastBid) {
            const lengths = suitLengths(hand);
            // Voir échange avec Guillaume : 18HL était déjà le minimum requis pour FAIRE
            // le renverse (voir ailleurs dans le moteur, la logique d'ouverture/rebid) —
            // au-delà (main nettement plus forte, 20HL+ ici), la séquence est forcing de
            // manche (12 mini du partenaire + 20 = 32, largement en zone) : on ne peut
            // plus se contenter de répéter sa propre couleur (non forcing), il faut une
            // enchère qui RESTE forcing.
            const isExtraStrong = hl >= 20;
            if (!isExtraStrong && lengths[myFirstBid.strain] >= 5) {
                // Minimum du renverse : répète sa 1ère couleur (la plus longue), non
                // forcing — le partenaire peut passer s'il n'a rien de plus.
                //
                // Voir échange avec Guillaume (outil de simulation, session du 30
                // juillet — bug trouvé, même famille que le "6D" corrigé plus tôt) : le
                // partenaire a-t-il DÉJÀ répondu par un contrat de manche ou mieux (ex.
                // 3SA) ? Si oui, ce n'est plus une "préférence non forcing" — s'échapper
                // vers ma propre couleur remplacerait un contrat déjà bon par un pire,
                // uniquement parce que c'était "la prochaine case légale" (peu importe
                // que cette case soit elle-même en dessous du palier de manche DANS MA
                // couleur — ce qui compte, c'est que le partenaire a DÉJÀ conclu).
                const partnerBidAlready = parseBid(myPartnerLastBid.call);
                const partnerAlreadyAtGame = partnerBidAlready && (
                    (partnerBidAlready.strain === 'NT' && partnerBidAlready.level >= 3)
                    || ((partnerBidAlready.strain === 'S' || partnerBidAlready.strain === 'H') && partnerBidAlready.level >= 4)
                    || (partnerBidAlready.strain !== 'NT' && partnerBidAlready.strain !== 'S' && partnerBidAlready.strain !== 'H' && partnerBidAlready.level >= 5)
                );
                if (!partnerAlreadyAtGame) {
                    for (let level = mySecondBid.level; level <= 7; level++) {
                        const c = level + myFirstBid.strain;
                        if (isCallLegal(history, c, seat)) { call = c; break; }
                    }
                    if (call !== 'PASS') explanation = `Minimum du renverse — répète sa couleur la plus longue plutôt que de laisser filer (${points})`;
                } else {
                    explanation = `Le partenaire a déjà répondu par un contrat de manche ou mieux — passe (${points})`;
                }
            } else if (isExtraStrong) {
                // 4ème couleur forcing : la seule couleur pas encore annoncée par
                // personne — signale des points de manche sans fit ni arrêt évident,
                // sans s'engager sur une vraie couleur à soi. Un cran AU-DESSUS du
                // palier minimal légal (pas le moins cher possible) : avec une main
                // aussi extra-forte, mieux vaut lever toute ambiguïté sur le fait que la
                // manche est acquise plutôt que de risquer un 4ème-couleur trop discret.
                const allSuits = ['S', 'H', 'D', 'C'];
                const partnerLastParsed = parseBid(myPartnerLastBid.call);
                const usedSuits = new Set([myFirstBid.strain, mySecondBid.strain, partnerLastParsed && partnerLastParsed.strain]);
                const fourthSuit = allSuits.find(s => !usedSuits.has(s));
                if (fourthSuit) {
                    for (let level = mySecondBid.level + 1; level <= 7; level++) {
                        const c = level + fourthSuit;
                        if (isCallLegal(history, c, seat)) { call = c; break; }
                    }
                    if (call !== 'PASS') explanation = `Main forcing de manche après son propre renverse, sans fit ni arrêt — 4ème couleur forcing (${points})`;
                }
            }
        }

        // Voir échange avec Guillaume (session du 24 juillet, donne 8, 2e partie) :
        // réponse à la 4ème COULEUR FORCING du PARTENAIRE (lui a déjà montré 2 couleurs,
        // j'en ai montré 1 — la 4ème, jamais annoncée par personne des deux côtés, est
        // artificielle : une question sur l'arrêt dans cette couleur, pas une vraie
        // couleur de sa part). Inconcevable de passer dessus. Avec l'arrêt (A, Rx+, Dxx+
        // — un 3ème rond comme VXx n'en est PAS un, voir ses mots), SA. Sans arrêt mais
        // avec 4+ cartes dans une couleur DÉJÀ montrée par le partenaire (fit connu),
        // manche directe dans ce fit plutôt que d'insister sur SA sans arrêt.
        if (call === 'PASS') {
            const myPartnerLastBid2 = history.slice().reverse()
                .find(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call));
            const myPartnerEarlierBids = history.filter(e => partnershipOf(e.seat) === partnershipOf(seat) && e.seat !== seat && isBidCall(e.call) && e !== myPartnerLastBid2);
            if (myPartnerLastBid2 && myPartnerEarlierBids.length >= 2) {
                const lastParsed = parseBid(myPartnerLastBid2.call);
                // Voir échange avec Guillaume (outil de simulation, session du 30 juillet
                // — plantage trouvé sur donne aléatoire) : myBids/myPartnerEarlierBids
                // filtrent seulement les PASSES (voir leur propre définition), jamais les
                // contres — un contre du même camp fait planter parseBid('X').strain
                // (parseBid renvoie null pour un contre, pas un objet {level,strain}).
                // Filtre ajouté ici pour ne garder que de vraies enchères chiffrées.
                const myOwnSuits = new Set(myBids.filter(b => isBidCall(b.call)).map(b => parseBid(b.call).strain).filter(s => s !== 'NT'));
                const partnerSuits = new Set(myPartnerEarlierBids.filter(b => isBidCall(b.call)).map(b => parseBid(b.call).strain).filter(s => s !== 'NT'));
                const isFourthSuitForcing = lastParsed && lastParsed.strain !== 'NT'
                    && !myOwnSuits.has(lastParsed.strain) && !partnerSuits.has(lastParsed.strain);
                if (isFourthSuitForcing) {
                    const askedSuit = lastParsed.strain;
                    const lengths = suitLengths(hand);
                    const cards = hand[askedSuit] || '';
                    const hasStopper = cards.includes('A')
                        || (cards.includes('K') && cards.length >= 2)
                        || (cards.includes('Q') && cards.length >= 3);
                    if (hasStopper) {
                        const ntCall = lastParsed.level + 'NT';
                        if (isCallLegal(history, ntCall, seat)) {
                            call = ntCall;
                            explanation = `Arrêt à ${STRAIN_SYMBOL[askedSuit]} — répond à la 4ème couleur forcing par SA (${points})`;
                        }
                    } else {
                        const partnerKnownSuit = [...partnerSuits].find(s => lengths[s] >= 4);
                        if (partnerKnownSuit) {
                            const gameCall = '4' + partnerKnownSuit;
                            if (isCallLegal(history, gameCall, seat)) {
                                call = gameCall;
                                explanation = `Pas d'arrêt à ${STRAIN_SYMBOL[askedSuit]}, mais fit connu à ${STRAIN_SYMBOL[partnerKnownSuit]} (${lengths[partnerKnownSuit]} cartes) — manche dans le fit plutôt que SA sans arrêt (${points})`;
                            }
                        }
                    }
                }
            }
        }

        if (call === 'PASS') explanation = `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
    } else {
        explanation = `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
    }

    // Voir échange avec Guillaume (session du 31 juillet — "je veux un mécanisme
    // unifié") : FILET UNIVERSEL unique, appelé en tout dernier recours quel que soit le
    // tour (1er, 2e, 3e ou plus) — voir FORCING_PATTERNS et decideForcingFallback,
    // juste au-dessus de decideRobotCall, qui rassemblent en un seul registre TOUTES les
    // situations de ce fichier où le partenaire vient de faire une enchère forcing sans
    // que la logique spécifique à la séquence (plus haut) n'ait déjà produit de réponse.
    // Ne s'active QUE si call est encore à 'PASS' à ce stade — jamais de priorité sur un
    // calcul déjà plus précis fait ailleurs dans la fonction.
    if (call === 'PASS') {
        const forcingFallback = decideForcingFallback(hand, seat, history);
        if (forcingFallback) {
            call = forcingFallback.call;
            explanation = `${forcingFallback.explanation} (${points})`;
        }
    }

    if (call !== 'PASS' && !isCallLegal(history, call, seat)) {
        explanation += ' — annonce calculée invalide, repli sur passe';
        call = 'PASS';
    }
    return { call, explanation };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        GAME_ZONE_NT, GAME_ZONE_MAJOR, GAME_ZONE_MINOR, SLAM_ZONE_SMALL, SLAM_ZONE_GRAND,
        OPENING_MINIMUM, SIMPLE_RAISE_MINIMUM,
        computeHandHcp, computeHandHL, computeSupportPoints, computeLoserCount,
        suitLengths, isHandBalancedForNT, longestSuitPreferHigh, isSeatVulnerable,
        estimateAuctionSideMinPoints,
        decideRobotCall
    };
}
