// app.js — État de l'application et rendu de l'interface.
// S'appuie sur bidding-rules.js (logique pure), deal-parser.js (lecture PBN/LIN)
// et peer-connection.js (connexion WebRTC) chargés avant ce fichier.
//
// PRINCIPE : plus de "modes" prédéfinis. L'hôte crée une partie, atterrit dans un salon
// où apparaissent au fil de l'eau les participants (chacun choisit son pseudo), et
// assigne librement chaque siège (Nord/Est/Sud/Ouest) à qui il veut — y compris la même
// personne sur 2 sièges. Un siège non assigné est joué par un robot qui passe
// systématiquement. Ce mécanisme unique permet de reproduire tous les cas de figure :
// binôme (2 sièges assignés, 2 en robot), diagonale, "maître du jeu" (une personne sur
// 2 sièges, deux autres sur les 2 restants), 4 joueurs (chacun un siège), etc.
//
// TOPOLOGIE : à partir de 2 invités, les invités ne sont jamais connectés entre eux —
// l'hôte relaie tout message reçu d'un invité vers les autres (voir relayIfHost).

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_CLASSES = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

// Caractères Unicode ♠♥♦♣, forcés en police Arial (voir règle .suit-icon dans
// styles.css) pour un rendu stable en glyphes texte plutôt qu'en émojis colorés selon
// la plateforme. La couleur (palette quatre couleurs) est appliquée en CSS via la classe
// de couleur (SUIT_CLASSES), pas cuite dans le caractère.
function suitIconHtml(suit, extraClass) {
    return `<span class="suit-icon ${SUIT_CLASSES[suit]}${extraClass ? ' ' + extraClass : ''}">${SUIT_SYMBOLS[suit]}</span>`;
}

// Libellé HTML d'une couleur d'enchère : "SA" en texte pour sans-atout, sinon l'icône de
// couleur (suitIconHtml). Centralise un motif répété à plusieurs endroits (boîte
// d'enchères, relevé, contrat final, table du double mort). Accepte les deux conventions
// utilisées dans ce fichier pour désigner le sans-atout : 'NT' (calls d'enchères, voir
// bidding-rules.js/STRAINS) et 'N' (clés de la table du double mort, voir STRAIN_ORDER —
// où N signifie sans-atout et non Nord). Aucune des deux ne désigne autre chose ailleurs,
// donc pas d'ambiguïté à les traiter ensemble ici.
function formatStrainLabel(strain) {
    return (strain === 'NT' || strain === 'N') ? 'SA' : suitIconHtml(strain);
}
const SEAT_FULL_NAME = { N: 'Nord', E: 'Est', S: 'Sud', W: 'Ouest' };
// Abréviation d'un seul caractère à afficher (convention française : O, pas W) — les
// clés internes restent N/E/S/W partout ailleurs (PBN, protocole réseau, etc.).
const SEAT_ABBR_FR = { N: 'N', E: 'E', S: 'S', W: 'O' };
const VULN_LABEL = { None: 'Non vulnérable', NS: 'NS vulnérable', EW: 'EO vulnérable', Both: 'Tous vulnérables' };

let peerConn = null;
let myRole = null;          // 'host' | 'guest'
let myParticipantId = null; // 'host', ou le jeton de reconnexion de l'invité (stable entre reconnexions)
let participants = [];      // [{ id, name, disconnected }, ...] — état du salon, maintenu par l'hôte
let seatAssignment = { N: null, E: null, S: null, W: null }; // id de participant, ou null (robot)
// Pas de statut "spectateur" séparé : quiconque n'occupe aucun siège est kibbitz (voir
// SEATS.every / mySeats.length === 0 un peu partout dans ce fichier) et voit donc les 4
// mains dès le début de la donne — inutile de l'assigner manuellement, ça découle
// directement de seatAssignment.

// Dernier instantané de seatAssignment vu au rendu précédent, pour détecter les
// affectations qui viennent tout juste d'arriver et leur appliquer un flash (voir
// renderSeatAssignmentGrid). `null` signifie "pas encore de repère" (première mesure
// après un (re)chargement du salon) : dans ce cas on se contente de capturer l'état sans
// rien flasher, pour ne pas allumer d'un coup toutes les places déjà occupées quand on
// rejoint un salon en cours de remplissage.
let prevSeatAssignmentSnapshot = null;

// Même principe, pour détecter côté invité les transitions déconnecté -> reconnecté d'un
// AUTRE participant (voir le cas 'lobby-state' dans handlePeerData) et déclencher un
// message de bienvenue transitoire. Côté hôte, cette détection se fait directement dans
// onGuestConnected (l'événement est déjà connu avec certitude, pas besoin de comparer),
// donc ce snapshot n'y est pas utilisé pour cette partie-là.
let prevParticipantsDisconnectedSnapshot = null;

// Nom affiché dans la bannière "de retour" (voir flashWelcomeBack/renderReconnectionBanner)
// pendant les quelques secondes où elle est visible ; null sinon.
let welcomeBackName = null;
let welcomeBackTimeoutId = null;

let currentRoomCode = null; // pour uiReconnect() : on doit se souvenir du code utilisé pour rejoindre

// (Hôte uniquement) jeton de reconnexion -> numéro de connexion PeerJS actif. Un invité
// garde le même jeton (localStorage) à travers ses reconnexions, mais son guestIndex
// change à chaque fois (nouvelle connexion PeerJS) : cette table fait le pont entre les
// deux, pour que seatAssignment (qui référence le jeton, stable) reste valide.
let guestIndexByToken = {};

// ===== Transfert d'hôte (salon uniquement, avant le lancement de la partie) =====
//
// Voir échange avec Guillaume : permet à l'hôte de céder son rôle à un autre participant
// connecté, dans le salon, avant de charger les donnes. Utile notamment quand la création
// de la partie échoue sur son propre appareil (réseau) : un ami crée la partie, puis
// Guillaume se la fait transférer une fois dans le salon.
//
// hostTransferInProgress : vrai entre l'envoi de 'prepare-become-host' et la réception de
// 'become-host-ready'/'become-host-failed' — évite de lancer un second transfert pendant
// qu'un premier est encore en cours.
let hostTransferInProgress = false;
// Jeton du participant visé par le transfert en cours (pour retrouver sa connexion au
// moment de la réponse) — uniquement pertinent côté ancien hôte, le temps du transfert.
let pendingHostTransferTarget = null;
// Jeton de reconnexion que l'hôte actuel s'apprête à utiliser une fois redevenu invité
// (généré au moment de lancer le transfert, voir uiTransferHost) — transmis au nouvel
// hôte dans 'prepare-become-host' pour qu'il puisse déjà lui réserver sa place/son siège
// sous ce jeton, avant même qu'il ne se reconnecte.
let pendingHostTransferOldToken = null;

// Jeton de reconnexion propre à ce navigateur, généré une fois puis conservé dans
// localStorage — survit à un rechargement ET à la fermeture/réouverture de l'onglet
// (contrairement à sessionStorage, qui est isolé par onglet et aurait généré un nouveau
// jeton à chaque réouverture, empêchant toute reconnexion réelle). Revers : deux onglets
// ouverts sur la même partie, dans le même navigateur, partageront le même jeton — sans
// conséquence pour un usage normal (un onglet par joueur), seulement pour un test solo
// avec plusieurs onglets qui simuleraient plusieurs joueurs différents.
function getReconnectToken() {
    try {
        let t = localStorage.getItem('bridgeBidReconnectToken');
        if (!t) {
            t = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem('bridgeBidReconnectToken', t);
        }
        return t;
    } catch (e) {
        // localStorage indisponible (navigation privée stricte, etc.) : le jeton ne
        // survivra pas à un rechargement, mais au moins l'app ne plante pas.
        if (!window._fallbackReconnectToken) {
            window._fallbackReconnectToken = 'p' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        }
        return window._fallbackReconnectToken;
    }
}

let mySeats = null;         // sièges contrôlés par ce joueur pendant la partie
let autoPassSeats = [];     // sièges non assignés (robot "passe") — décidé par l'hôte au lancement
// Mode d'enchère des robots (voir échange avec Guillaume) : 'smart' = système appris (le
// moteur habituel, decideRobotCall), 'passOnly' = passe en boucle sans réfléchir, quel que
// soit le jeu. Configurable UNIQUEMENT dans le salon, avant de lancer la session (voir
// index.html) — pas modifiable une fois la partie démarrée. Décision purement locale à
// l'hôte : seul lui déclenche les décisions des robots (voir maybeRobotBid, gardé par
// `myRole !== 'host'`), donc pas besoin de la diffuser aux invités, qui n'en ont jamais
// l'usage. Persisté (voir échange avec Guillaume) comme les autres préférences locales —
// voir loadBoolPref/saveBoolPref, la case du salon reprend cette valeur au chargement
// (voir enterLobbyScreen).
let robotBiddingMode = loadBoolPref('bridgeBidRobotPassOnly', false) ? 'passOnly' : 'smart';

// Plus de statut kibbitz suivi séparément (source de bug : oublié pour un joueur qui
// rejoint après le lancement de la partie, resté "spectateur" sans les mains) — un
// kibbitz, c'est simplement quiconque n'occupe aucun siège, dérivé à la demande plutôt
// que traqué en parallèle de mySeats.
function isKibbitz() {
    return !mySeats || mySeats.length === 0;
}

// ===== Préférences d'affichage des mains (locales, persistées, indépendantes du réseau) =====
//
// Purement cosmétique et propre à chaque appareil (comme le jeton de reconnexion) : pas
// besoin de les synchroniser entre joueurs, chacun choisit sa propre présentation.

function loadBoolPref(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : v === 'true';
    } catch (e) {
        return fallback;
    }
}

function saveBoolPref(key, value) {
    try { localStorage.setItem(key, value ? 'true' : 'false'); } catch (e) { /* navigation privée stricte, tant pis */ }
}

// Même principe que loadBoolPref/saveBoolPref, pour une valeur texte (le pseudo — voir
// savedNickname plus bas) plutôt qu'un booléen.
function loadStringPref(key, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v === null || v === '' ? fallback : v;
    } catch (e) {
        return fallback;
    }
}

function saveStringPref(key, value) {
    try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
    } catch (e) { /* navigation privée stricte, tant pis */ }
}

// Pseudo choisi par l'utilisateur, mémorisé sur cet appareil comme les autres préférences
// d'affichage — propre à l'appareil, pas au jeton de reconnexion (qui identifie la place
// dans UNE partie précise, alors que le pseudo doit survivre d'une partie à l'autre).
// null si jamais personnalisé : on retombe alors sur defaultParticipantName comme avant.
let savedNickname = loadStringPref('bridgeBidNickname', null);

let useFrenchRanks = loadBoolPref('bridgeBidFrenchRanks', false); // R/D/V/X au lieu de K/Q/J/T
let showHcp = loadBoolPref('bridgeBidShowHcp', false);            // affiche le compte de points d'honneur par main
let showKr = loadBoolPref('bridgeBidShowKr', false);              // affiche l'évaluation Kaplan-Rubens par main
let showLedgerNames = loadBoolPref('bridgeBidShowLedgerNames', false); // noms des joueurs au lieu de N/E/S/O dans le tableau d'enchères
// (Hôte uniquement) Voir les 4 mains à tout moment pendant la partie, même en pleine
// enchère — voir uiToggleHostSeeAllHands. Jamais envoyé aux autres joueurs.
let hostSeeAllHands = loadBoolPref('bridgeBidHostSeeAllHands', false);

const FRENCH_RANK_LETTER = { K: 'R', Q: 'D', J: 'V', T: 'X' };

// Convertit une chaîne de rangs (ex: "AKQT98") selon la préférence de notation en cours.
function formatRanksForDisplay(ranks) {
    if (!ranks) return '';
    if (!useFrenchRanks) return ranks;
    return ranks.split('').map(c => FRENCH_RANK_LETTER[c] || c).join('');
}

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

// ===== Évaluateur Kaplan-Rubens (CCCC — "Complex Computer Count") =====
//
// Port fidèle de la fonction cccc() du code de référence de Jeff Goldsmith
// (https://www.jeff-goldsmith.com/knrsource.c), qui implémente l'algorithme d'Edgar
// Kaplan et Jeff Rubens tel que publié dans Bridge World, octobre 1982, pp. 21-23.
// N'implémente QUE le calcul Kaplan-Rubens d'origine ("cccc"), pas la variante de Danny
// Kleinman ("dkcccc") qui figure dans les mêmes fichiers.
//
// Une seule divergence connue entre les sources de référence elles-mêmes (voir plus bas,
// couleurs de 7 cartes) : on suit alors knrsource.c, la source d'origine désignée.

const KR_SUITS = ['S', 'H', 'D', 'C'];

function krHas(hand, suit, rank) {
    return hand[suit].includes(rank);
}

function krCountHeld(hand, suit, ranks) {
    let n = 0;
    for (const r of ranks) if (krHas(hand, suit, r)) n++;
    return n;
}

function computeKaplanRubens(hand) {
    const len = {};
    KR_SUITS.forEach(s => { len[s] = hand[s].length; });

    // 321 count pour les As, Rois, Dames (honneurs "protégés" au sens large)
    let pakq = 0;
    KR_SUITS.forEach(s => {
        if (krHas(hand, s, 'A')) pakq += 3;
        if (krHas(hand, s, 'K')) pakq += 2;
        if (krHas(hand, s, 'Q')) pakq += 1;
    });

    // Points de longueur : 4321 count pondéré par la longueur de la couleur
    let p2 = 0;
    KR_SUITS.forEach(s => {
        if (krHas(hand, s, 'A')) p2 += len[s] * 4;
        if (krHas(hand, s, 'K')) p2 += len[s] * 3;
        if (krHas(hand, s, 'Q')) p2 += len[s] * 2;
        if (krHas(hand, s, 'J')) p2 += len[s] * 1;
    });

    // Bonus pour longues couleurs sans les honneurs bas (Dame/Valet) qui y seraient
    // de toute façon peu utiles.
    KR_SUITS.forEach(s => {
        const l = len[s];
        const hasQ = krHas(hand, s, 'Q');
        const hasJ = krHas(hand, s, 'J');
        if (l === 7) {
            // Le texte original ("1 point si Dame ou Valet manquant") est ambigu, et les
            // DEUX sources de référence de Jeff Goldsmith (C et Perl) le traitent
            // différemment l'une de l'autre pour ce cas précis : knrsource.c déclenche le
            // bonus dès qu'IL MANQUE AU MOINS L'UN des deux honneurs, alors que sa version
            // Perl exige qu'ils manquent TOUS LES DEUX (avec une note de l'auteur disant
            // lui-même ne pas être sûr de l'intention d'origine). On suit ici knrsource.c,
            // la source désignée comme référence.
            if (!hasQ || !hasJ) p2 += 7;
        }
        if (l === 8) {
            if (!hasQ) p2 += 16;
            else if (!hasJ) p2 += 8;
        }
        if (l > 8) {
            if (!hasQ) p2 += 2 * l;
            if (!hasJ) p2 += l;
        }
    });

    // Honneurs bas selon la longueur de la couleur (Dix, Neuf)
    KR_SUITS.forEach(s => {
        const l = len[s];
        if (krHas(hand, s, 'T')) {
            if (l > 6) {
                p2 += 0.5 * l;
            } else {
                const higher = krCountHeld(hand, s, ['A', 'K', 'Q']);
                if (higher >= 2 || krHas(hand, s, 'J')) p2 += l;
                else p2 += 0.5 * l;
            }
        }
        if (krHas(hand, s, '9') && l <= 6) {
            const higher = krCountHeld(hand, s, ['A', 'K', 'Q']);
            if (higher >= 2 || krHas(hand, s, 'T') || krHas(hand, s, '8')) p2 += 0.5 * l;
        }
    });

    // Points de brièveté (chicane/singleton/doubleton) — on ne compte pas le 1er doubleton
    let pdist = 0;
    KR_SUITS.forEach(s => {
        const l = len[s];
        if (l === 0) pdist += 3;
        else if (l === 1) pdist += 2;
        else if (l === 2) pdist += 1;
    });
    if (pdist !== 0) pdist -= 1;

    // Rois secs, Dames courtes ou longues sans As/Roi d'appui
    let p = pakq;
    KR_SUITS.forEach(s => {
        const l = len[s];
        if (krHas(hand, s, 'K') && l === 1) p -= 1.5;
        if (krHas(hand, s, 'Q') && l < 3) {
            p -= 1;
            if (krHas(hand, s, 'A') || krHas(hand, s, 'K')) p += 0.5;
            else if (l === 2) p += 0.25;
        }
        if (krHas(hand, s, 'Q') && l >= 3) {
            if (!krHas(hand, s, 'A') && !krHas(hand, s, 'K')) p -= 0.25;
        }
    });

    // Honneurs bas (Valet, Dix) soutenus par des honneurs supérieurs
    let p3 = 0;
    KR_SUITS.forEach(s => {
        if (krHas(hand, s, 'J')) {
            const higher = krCountHeld(hand, s, ['A', 'K', 'Q']);
            if (higher === 2) p3 += 0.5;
            if (higher === 1) p3 += 0.25;
        }
        if (krHas(hand, s, 'T')) {
            const higher = krCountHeld(hand, s, ['A', 'K', 'Q', 'J']);
            if (higher === 2) p3 += 0.25;
            if (higher === 1 && krHas(hand, s, '9')) p3 += 0.25;
        }
    });

    // Pénalité pour la répartition 4-3-3-3
    const sortedLens = KR_SUITS.map(s => len[s]).sort((a, b) => b - a);
    const d = sortedLens[3] === 3 ? 0.5 : 0;

    return p + p2 / 10 + p3 + pdist - d;
}

function uiToggleFrenchRanks() {
    useFrenchRanks = !useFrenchRanks;
    saveBoolPref('bridgeBidFrenchRanks', useFrenchRanks);
    renderHandDisplayOptionButtons();
    if (deals) {
        renderMyHands();
        // Voir échange avec Guillaume : le diagramme peut déjà être affiché avant la fin
        // de l'enchère (bascule manuelle de l'hôte, ou kibitz — voir checkAuctionEnd) —
        // sans ce même critère ici, ces boutons semblaient "sans effet" dans ce cas,
        // puisqu'ils ne rafraîchissaient que myHandsContainer, invisible à ce moment-là.
        renderAllHandsDiagram(); // toujours, même masqué (voir échange avec Guillaume) : garde la hauteur réservée synchronisée quoi qu'il arrive
    }
}

function uiToggleShowHcp() {
    showHcp = !showHcp;
    saveBoolPref('bridgeBidShowHcp', showHcp);
    renderHandDisplayOptionButtons();
    if (deals) {
        renderMyHands();
        renderAllHandsDiagram(); // toujours, même masqué (voir échange avec Guillaume) : garde la hauteur réservée synchronisée quoi qu'il arrive
    }
}

function uiToggleShowKr() {
    showKr = !showKr;
    saveBoolPref('bridgeBidShowKr', showKr);
    renderHandDisplayOptionButtons();
    if (deals) {
        renderMyHands();
        renderAllHandsDiagram(); // toujours, même masqué (voir échange avec Guillaume) : garde la hauteur réservée synchronisée quoi qu'il arrive
    }
}

function uiToggleLedgerNames() {
    showLedgerNames = !showLedgerNames;
    saveBoolPref('bridgeBidShowLedgerNames', showLedgerNames);
    const btn = document.getElementById('ledgerNamesToggleBtn');
    if (btn) btn.classList.toggle('is-active', showLedgerNames);
    if (deals) renderAuctionLedger();
}

// Réservé à l'hôte : révèle les 4 mains à tout moment pendant la partie, même en pleine
// enchère (utile pour vérifier une donne, aider un débutant en direct, etc.). Purement
// local — jamais envoyé aux autres joueurs, qui ne voient toujours que ce qu'ils sont
// censés voir. Voir checkAuctionEnd, qui force l'affichage du diagramme des 4 mains tant
// que ce réglage est actif, indépendamment de l'état de l'enchère.
function uiToggleHostSeeAllHands() {
    if (myRole !== 'host') return;
    hostSeeAllHands = !hostSeeAllHands;
    saveBoolPref('bridgeBidHostSeeAllHands', hostSeeAllHands);
    renderHandDisplayOptionButtons();
    if (deals) checkAuctionEnd();
}

function renderHandDisplayOptionButtons() {
    const frBtn = document.getElementById('frenchRanksToggleBtn');
    if (frBtn) frBtn.classList.toggle('is-active', useFrenchRanks);

    const hcpBtn = document.getElementById('hcpToggleBtn');
    if (hcpBtn) hcpBtn.classList.toggle('is-active', showHcp);

    const krBtn = document.getElementById('krToggleBtn');
    if (krBtn) krBtn.classList.toggle('is-active', showKr);

    const hostSeeAllBtn = document.getElementById('hostSeeAllHandsBtn');
    if (hostSeeAllBtn) {
        hostSeeAllBtn.style.display = myRole === 'host' ? '' : 'none';
        hostSeeAllBtn.classList.toggle('is-active', hostSeeAllHands);
    }
}
let deals = null;           // tableau de donnes parsées
let boardIndex = 0;
let auctionHistory = [];    // historique de la donne en cours : [{seat, call}, ...]

// (Hôte) Résultat du fichier de donnes déjà lu et parsé au moment où il a été choisi (voir
// uiHandleDealFileChosen), pour afficher tout de suite une éventuelle erreur ou
// l'avertissement "PARs non disponibles" — pendant que l'hôte compose encore la table,
// PAS au moment de cliquer sur "Commencer la partie", puisqu'à cet instant l'écran du
// salon (et donc le message) disparaît immédiatement avec le passage à l'écran de jeu.
let pendingParsedDeals = null;
// Identifie la source dont pendingParsedDeals est le résultat, pour savoir si le cache
// est encore valable sans avoir à relire/re-fetch : soit l'objet File choisi via l'input
// upload, soit une chaîne 'library:nomDeFichier' pour une donne piochée dans la
// bibliothèque du club (voir uiHandleDealLibraryChosen) — comparée uniquement par
// égalité (===), jamais utilisée comme un vrai File au-delà de ce contrôle.
let pendingParsedSource = null;

// Ordre effectivement utilisé pour la partie : soit pendingParsedDeals tel quel (ordre du
// fichier), soit une copie mélangée, selon la case "Ordre aléatoire des donnes" (voir
// uiToggleRandomizeDeals). Calculé une seule fois par chargement de fichier / bascule de
// la case, et réutilisé à la fois par l'aperçu et par le lancement de la partie, pour que
// l'un corresponde toujours exactement à l'autre. Les numéros de donne d'origine (deal.board)
// sont conservés tels quels dans le fichier — seul l'ordre de passage est mélangé.
let pendingOrderedDeals = null;

// Mélange de Fisher-Yates (Math.random() suffit ici : besoin d'aléatoire simple pour
// varier l'ordre d'entraînement, pas de garanties cryptographiques).
function shuffleDealsArray(arr) {
    const shuffled = arr.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// ===== Génération de donnes aléatoires (voir échange avec Guillaume) =====
//
// Même algorithme que le générateur autonome (gen/generator.js, dont les fichiers ont été
// fournis pour cette fonctionnalité) : mélange Fisher-Yates d'un jeu de 52 cartes, une
// carte sur quatre à chaque position dans l'ordre N/E/S/O, tri par rang au sein de chaque
// couleur. Cycle donneur/vulnérabilité standard sur 16 donnes, identique à BRIDGE_CYCLE
// dans le générateur.
const RANDOM_DEAL_CARD_VALUES = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const RANDOM_DEAL_BRIDGE_CYCLE = [
    { dealer: 'N', vulnerable: 'None' }, { dealer: 'E', vulnerable: 'NS' },
    { dealer: 'S', vulnerable: 'EW' }, { dealer: 'W', vulnerable: 'Both' },
    { dealer: 'N', vulnerable: 'NS' }, { dealer: 'E', vulnerable: 'EW' },
    { dealer: 'S', vulnerable: 'Both' }, { dealer: 'W', vulnerable: 'None' },
    { dealer: 'N', vulnerable: 'EW' }, { dealer: 'E', vulnerable: 'Both' },
    { dealer: 'S', vulnerable: 'None' }, { dealer: 'W', vulnerable: 'NS' },
    { dealer: 'N', vulnerable: 'Both' }, { dealer: 'E', vulnerable: 'None' },
    { dealer: 'S', vulnerable: 'NS' }, { dealer: 'W', vulnerable: 'EW' }
];
// Nombre de nouvelles tentatives de mélange max par donne avant d'abandonner la contrainte
// pour celle-ci (voir dealSatisfiesHumanLineConstraint) — un filet de sécurité purement
// théorique : avec la contrainte demandée (12H+ chez au moins un des deux, dans une ligne
// à 2 humains), la probabilité d'échouer autant de fois de suite est astronomiquement
// faible, mais on évite quand même une boucle infinie dans l'absolu.
const RANDOM_DEAL_MAX_RETRIES = 500;

function shuffledDeck() {
    const deck = [];
    for (const suit of ['S', 'H', 'D', 'C']) {
        for (const rank of RANDOM_DEAL_CARD_VALUES) deck.push(suit + rank);
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// Distribue un jeu mélangé en 4 mains (une carte sur 4 à chaque position, dans l'ordre
// N/E/S/O), triées par rang au sein de chaque couleur — même logique que le générateur.
function dealFromDeck(deck) {
    const hands = { N: emptyHandBySuit(), E: emptyHandBySuit(), S: emptyHandBySuit(), W: emptyHandBySuit() };
    const positions = ['N', 'E', 'S', 'W'];
    deck.forEach((card, i) => {
        const suit = card[0], rank = card[1];
        hands[positions[i % 4]][suit] += rank;
    });
    for (const pos of positions) {
        for (const suit of ['S', 'H', 'D', 'C']) {
            hands[pos][suit] = hands[pos][suit]
                .split('')
                .sort((a, b) => RANDOM_DEAL_CARD_VALUES.indexOf(a) - RANDOM_DEAL_CARD_VALUES.indexOf(b))
                .join('');
        }
    }
    return hands;
}

function emptyHandBySuit() {
    return { S: '', H: '', D: '', C: '' };
}

// Contrainte demandée par Guillaume : dans toute ligne (NS ou EO) occupée par 2 humains
// (pas de robot), au moins l'un des deux doit avoir 12H+. Une ligne avec un seul humain
// (partenaire robot) ou aucun n'a pas de contrainte — rien à vérifier pour elle.
function dealSatisfiesHumanLineConstraint(hands, seatAssignment) {
    const lines = [['N', 'S'], ['E', 'W']];
    for (const [seatA, seatB] of lines) {
        const bothHuman = !!seatAssignment[seatA] && !!seatAssignment[seatB];
        if (!bothHuman) continue;
        const hcpA = computeHandHcp(hands[seatA]);
        const hcpB = computeHandHcp(hands[seatB]);
        if (hcpA < 12 && hcpB < 12) return false;
    }
    return true;
}

// Contraintes optionnelles demandées par Guillaume pour la génération aléatoire :
// fourchette de points H par siège, fourchette de points H combinés par ligne (NS/EO), et
// longueur minimale dans une couleur par siège. `constraints` a la forme :
// { seats: { N: {hcpMin, hcpMax, suit, suitMinLength}, E: {...}, S: {...}, W: {...} },
//   lines: { NS: {hcpMin, hcpMax}, EW: {hcpMin, hcpMax} } }
// N'importe quel champ omis/null n'est simplement pas vérifié — un objet vide ou absent
// équivaut à "aucune contrainte". Toujours vérifiée EN PLUS de
// dealSatisfiesHumanLineConstraint (voir generateRandomDeal), jamais à sa place.
function dealSatisfiesCustomConstraints(hands, constraints) {
    if (!constraints) return true;

    if (constraints.seats) {
        for (const seat of ['N', 'E', 'S', 'W']) {
            const c = constraints.seats[seat];
            if (!c) continue;
            const hcp = computeHandHcp(hands[seat]);
            if (c.hcpMin != null && hcp < c.hcpMin) return false;
            if (c.hcpMax != null && hcp > c.hcpMax) return false;
            if (c.suit && c.suitMinLength != null && hands[seat][c.suit].length < c.suitMinLength) return false;
        }
    }

    if (constraints.lines) {
        const lineSeats = { NS: ['N', 'S'], EW: ['E', 'W'] };
        for (const line of ['NS', 'EW']) {
            const c = constraints.lines[line];
            if (!c) continue;
            const [seatA, seatB] = lineSeats[line];
            const combined = computeHandHcp(hands[seatA]) + computeHandHcp(hands[seatB]);
            if (c.hcpMin != null && combined < c.hcpMin) return false;
            if (c.hcpMax != null && combined > c.hcpMax) return false;
        }
    }

    return true;
}

// Génère une seule donne (numéro de board donné), en retentant tant que les contraintes
// ne sont pas respectées (la fixe + les optionnelles éventuelles). `seatAssignment` figé au
// moment de la génération (voir uiGenerateRandomDeals) : un changement de composition de
// table après coup ne redéclenche pas une nouvelle génération, comme pour n'importe quel
// autre outil de génération. Si RANDOM_DEAL_MAX_RETRIES est atteint sans satisfaire les
// contraintes optionnelles (des fourchettes trop serrées simultanément, par exemple), la
// dernière donne tentée est renvoyée telle quelle plutôt que de bloquer indéfiniment —
// signalé à l'appelant via `constraintsUnmet` pour qu'il prévienne l'utilisateur.
function generateRandomDeal(boardNumber, seatAssignment, constraints) {
    let hands;
    let attempts = 0;
    let satisfied = false;
    do {
        hands = dealFromDeck(shuffledDeck());
        attempts++;
        satisfied = dealSatisfiesHumanLineConstraint(hands, seatAssignment)
            && dealSatisfiesCustomConstraints(hands, constraints);
    } while (!satisfied && attempts < RANDOM_DEAL_MAX_RETRIES);

    const cycle = RANDOM_DEAL_BRIDGE_CYCLE[(boardNumber - 1) % 16];
    return {
        board: boardNumber,
        dealer: cycle.dealer,
        vulnerable: cycle.vulnerable,
        hands,
        par: null,   // pas de résumé PAR préformaté (spécifique à l'import PBN) ; le
                     // double mort complet (ddTable) suffit à afficher le PAR en fin de
                     // donne, voir kickOffBackgroundDD et renderDDTable existant.
        ddTable: null,
        constraintsUnmet: !satisfied
    };
}

function generateRandomDeals(count, seatAssignment, constraints) {
    const deals = [];
    for (let i = 1; i <= count; i++) {
        deals.push(generateRandomDeal(i, seatAssignment, constraints));
    }
    return deals;
}

// Bouton "🎲 Générer" du salon : génère `count` donnes aléatoires et les branche sur
// EXACTEMENT le même circuit que l'import d'un fichier ou de la bibliothèque
// (pendingParsedSource/pendingParsedDeals/pendingOrderedDeals, voir uiStartGameAsHost) —
// aucune des deux ne connaît de traitement spécial, "random" n'est qu'une source de plus.
// Miroir automatique entre les fourchettes de ligne (voir échange avec Guillaume) : NS et
// EO se partagent TOUJOURS les 40 points H du jeu entier, donc "NS a au moins 24" équivaut
// mathématiquement à "EO a au plus 16" — remplir l'un remplit donc automatiquement l'autre
// (min d'une ligne <-> max de l'autre). Ne se déclenche que sur une vraie saisie
// utilisateur (oninput) : modifier .value par JS ne redéclenche pas cet événement, donc
// aucun risque de boucle infinie entre les deux champs.
function uiMirrorLineHcpConstraint(sourceId) {
    const mirrorOf = {
        'rdc-NS-hcpMin': 'rdc-EW-hcpMax',
        'rdc-NS-hcpMax': 'rdc-EW-hcpMin',
        'rdc-EW-hcpMin': 'rdc-NS-hcpMax',
        'rdc-EW-hcpMax': 'rdc-NS-hcpMin'
    };
    const targetId = mirrorOf[sourceId];
    const sourceEl = document.getElementById(sourceId);
    const targetEl = document.getElementById(targetId);
    if (!sourceEl || !targetEl) return;
    if (sourceEl.value === '') {
        targetEl.value = '';
        return;
    }
    const n = parseInt(sourceEl.value, 10);
    if (Number.isFinite(n)) targetEl.value = String(40 - n);
}

// Prévient si les contraintes ont changé depuis la dernière génération réussie (voir
// échange avec Guillaume) : rien ne se régénère automatiquement (comme pour les deux
// autres sources, fichier/bibliothèque), donc sans ce rappel on pourrait croire à tort que
// les donnes déjà générées reflètent les derniers réglages. Ne s'affiche que si une
// génération a déjà eu lieu (lastGeneratedConstraintsJSON défini) ET que la lecture
// actuelle des champs diffère de l'empreinte prise à ce moment-là.
function uiCheckConstraintsStale() {
    if (lastGeneratedConstraintsJSON === undefined) return;
    const { constraints } = readRandomDealConstraintsFromUI();
    if (JSON.stringify(constraints) !== lastGeneratedConstraintsJSON) {
        setHostSetupMessage('Contraintes modifiées depuis la dernière génération — cliquez de nouveau sur "🎲 Générer" pour les appliquer.', true);
    }
}

function uiToggleRandomDealConstraints() {
    const panel = document.getElementById('randomDealConstraintsPanel');
    const btn = document.getElementById('randomDealConstraintsToggle');
    if (!panel) return;
    const isOpen = panel.style.display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    if (btn) btn.classList.toggle('is-active', !isOpen);
}

// Lit les champs du panneau de contraintes optionnelles (voir échange avec Guillaume) et
// construit l'objet attendu par dealSatisfiesCustomConstraints. Un champ vide est traité
// comme "pas de contrainte" (null), jamais comme 0 — un input number vide renvoie une
// chaîne vide, pas NaN, donc on teste explicitement sur '' plutôt que sur isNaN. Renvoie
// aussi une liste d'erreurs de validation (min > max) à afficher avant de lancer la
// génération, plutôt que de la découvrir seulement après 500 tentatives infructueuses.
function readRandomDealConstraintsFromUI() {
    const errors = [];
    const readNum = (id) => {
        const el = document.getElementById(id);
        if (!el || el.value === '') return null;
        const n = parseInt(el.value, 10);
        return Number.isFinite(n) ? n : null;
    };

    const seats = {};
    for (const [seat, label] of [['N', 'Nord'], ['E', 'Est'], ['S', 'Sud'], ['W', 'Ouest']]) {
        const hcpMin = readNum(`rdc-${seat}-hcpMin`);
        const hcpMax = readNum(`rdc-${seat}-hcpMax`);
        const suitEl = document.getElementById(`rdc-${seat}-suit`);
        const suit = suitEl && suitEl.value ? suitEl.value : null;
        const suitMinLength = readNum(`rdc-${seat}-suitLen`);
        if (hcpMin != null && hcpMax != null && hcpMin > hcpMax) {
            errors.push(`${label} : le H minimum dépasse le H maximum.`);
        }
        if (hcpMin != null || hcpMax != null || (suit && suitMinLength != null)) {
            seats[seat] = { hcpMin, hcpMax, suit, suitMinLength };
        }
    }

    const lines = {};
    for (const [line, label] of [['NS', 'Nord-Sud'], ['EW', 'Est-Ouest']]) {
        const hcpMin = readNum(`rdc-${line}-hcpMin`);
        const hcpMax = readNum(`rdc-${line}-hcpMax`);
        if (hcpMin != null && hcpMax != null && hcpMin > hcpMax) {
            errors.push(`${label} : le H minimum dépasse le H maximum.`);
        }
        if (hcpMin != null || hcpMax != null) lines[line] = { hcpMin, hcpMax };
    }

    const hasAny = Object.keys(seats).length > 0 || Object.keys(lines).length > 0;
    return { constraints: hasAny ? { seats, lines } : null, errors };
}

// Empreinte des contraintes utilisées à la DERNIÈRE génération réussie (voir échange avec
// Guillaume) — sert uniquement à détecter si les champs ont changé depuis, pour prévenir
// que les donnes déjà générées ne les reflètent plus. `undefined` tant qu'aucune génération
// n'a eu lieu (pas d'avertissement à afficher dans ce cas).
let lastGeneratedConstraintsJSON;

function uiGenerateRandomDeals() {
    const countInput = document.getElementById('randomDealCount');
    const count = countInput ? parseInt(countInput.value, 10) : NaN;
    if (!Number.isFinite(count) || count < 1 || count > 40) {
        setHostSetupMessage('Choisissez un nombre de donnes entre 1 et 40.', false);
        return;
    }

    const { constraints, errors } = readRandomDealConstraintsFromUI();
    if (errors.length > 0) {
        setHostSetupMessage(errors.join(' '), false);
        return;
    }
    lastGeneratedConstraintsJSON = JSON.stringify(constraints);

    // Désélectionne les deux autres sources, comme elles se désélectionnent déjà
    // mutuellement entre elles (voir uiHandleDealFileChosen/uiHandleDealLibraryChosen) :
    // une seule source active à la fois, pour éviter toute ambiguïté sur celle qui sera
    // effectivement utilisée.
    const fileInput = document.getElementById('dealFileInput');
    if (fileInput) fileInput.value = '';
    updateDealFileNameDisplay();
    const librarySelect = document.getElementById('dealLibrarySelect');
    if (librarySelect) librarySelect.value = '';
    document.getElementById('dealFileInfo').style.display = 'none'; // rien à prévisualiser pour du random

    const generated = generateRandomDeals(count, seatAssignment, constraints);
    pendingParsedSource = 'random';
    pendingParsedDeals = generated;
    refreshPendingOrderedDeals();

    // Voir échange avec Guillaume : avec des contraintes très serrées (plusieurs fourchettes
    // étroites simultanées), certaines donnes peuvent ne pas les satisfaire même après
    // RANDOM_DEAL_MAX_RETRIES tentatives (voir generateRandomDeal) — mieux vaut prévenir que
    // de laisser croire que toutes les donnes générées les respectent silencieusement.
    const unmetCount = generated.filter(d => d.constraintsUnmet).length;
    const unmetNote = unmetCount > 0
        ? ` ${unmetCount} donne(s) n'ont pas pu satisfaire toutes les contraintes malgré ${RANDOM_DEAL_MAX_RETRIES} tentatives — essayez des fourchettes moins serrées.`
        : '';
    setHostSetupMessage(
        `${count} donne(s) générée(s) — le calcul du double mort tourne en arrière-plan, le PAR s'affichera en fin de donne dès qu'il sera prêt.${unmetNote}`,
        unmetCount > 0 ? 'warning' : 'success'
    );

    kickOffBackgroundDD(generated);
}

// ===== Double mort en arrière-plan pour les donnes générées aléatoirement =====
//
// Réutilise TELLE QUELLE l'API serverless déjà utilisée par le générateur externe
// (gen/dds-controller.js, voir les fichiers fournis par Guillaume pour cette
// fonctionnalité) : même URL, même format de requête/réponse. Comme table-encheres est
// hébergé sur le même domaine (capgui13.github.io), le CORS déjà en place pour le
// générateur (Access-Control-Allow-Origin restreint à ce domaine, pas au sous-dossier)
// couvre aussi cette appli sans rien à reconfigurer côté serveur.
const RANDOM_DEAL_DD_SERVER_URL = 'https://api-gen-beta.vercel.app/api/dds';
const RANDOM_DEAL_DD_CHUNK_SIZE = 10; // donnes par requête HTTP, comme dds-controller.js

// Même format PBN que dealToPBNString dans generator.js (gen/), à ceci près que les mains
// sont déjà des chaînes ici (pas des tableaux de rangs) — pas de .join('') à faire.
function dealToPbnStringForDD(deal) {
    const hands = ['N', 'E', 'S', 'W']
        .map(pos => ['S', 'H', 'D', 'C'].map(suit => deal.hands[pos][suit]).join('.'))
        .join(' ');
    return 'N:' + hands;
}

// Incrémenté à chaque nouveau lancement de calcul (voir kickOffBackgroundDD) : si l'hôte
// change de source (nouveau fichier, nouvelle génération aléatoire) pendant qu'un calcul
// précédent est encore en vol, les résultats tardifs de l'ANCIEN lot doivent être ignorés
// plutôt que d'être appliqués à de nouvelles donnes qui partagent, par coïncidence, le
// même numéro de board (très courant : la plupart des fichiers/générations commencent à
// la donne 1). Même principe que ddCurrentGenerationId dans dds-controller.js (gen/).
let ddResultGenerationId = 0;

// Lance le calcul pour toutes les donnes fournies, par lots de RANDOM_DEAL_DD_CHUNK_SIZE
// envoyés en parallèle (pas de limite de concurrence ici contrairement à
// dds-controller.js : un lot de 40 donnes max, donc 4 requêtes au plus, largement sous ce
// qui justifierait de les échelonner). Un seul point d'appel, quelle que soit la source
// (donnes aléatoires ou fichier/bibliothèque sans PAR, voir validateAndUseDealText) :
// c'est ICI qu'un nouveau lot invalide implicitement tout lot précédent encore en vol.
function kickOffBackgroundDD(dealsList) {
    ddResultGenerationId++;
    const generationId = ddResultGenerationId;
    for (let i = 0; i < dealsList.length; i += RANDOM_DEAL_DD_CHUNK_SIZE) {
        sendDDChunk(dealsList.slice(i, i + RANDOM_DEAL_DD_CHUNK_SIZE), generationId);
    }
}

async function sendDDChunk(chunk, generationId) {
    const items = chunk.map(deal => ({ id: deal.board, pbn: dealToPbnStringForDD(deal) }));
    try {
        const response = await fetch(RANDOM_DEAL_DD_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        if (generationId !== ddResultGenerationId) return; // lot périmé, voir ddResultGenerationId
        for (const r of data.results) {
            if (r.table) applyDDResultToBoard(r.id, r.table);
        }
    } catch (err) {
        // Échec silencieux du point de vue du joueur : pas de PAR pour ce lot, mais la
        // partie elle-même n'est pas affectée (voir échange avec Guillaume — le calcul DD
        // est un bonus, jamais un prérequis pour jouer). Tracé dans le journal de
        // diagnostic pour comprendre après coup si ça arrive souvent.
        pushDebugLog('Double mort en arrière-plan : échec pour un lot (' + ((err && err.message) || err) + ')');
    }
}

// Point d'entrée UNIQUE pour appliquer un résultat de double mort à une donne, quelle que
// soit la provenance : calcul local (si on est l'hôte, voir sendDDChunk) ou message relayé
// par l'hôte (voir handlePeerData, cas 'dd-result', côté invité comme côté hôte
// nouvellement transféré). `boardNumber` (deal.board), pas un index de tableau : l'ordre
// dans `deals` peut différer de l'ordre de génération si "Ordre aléatoire des donnes" est
// coché (voir refreshPendingOrderedDeals).
function applyDDResultToBoard(boardNumber, table) {
    // Avant le lancement de la partie, les donnes générées vivent dans pendingParsedDeals
    // (pas encore dans `deals`, qui ne prend vie qu'au clic sur "Commencer la partie" —
    // voir uiStartGameAsHost) : écrire ici sur les mêmes objets suffit, puisque
    // pendingOrderedDeals (donc `deals` ensuite) référence CES MÊMES objets, jamais une
    // copie (voir shuffleDealsArray, qui ne fait que réordonner, jamais cloner).
    const pool = deals || pendingParsedDeals;
    if (!pool) return;
    const idx = pool.findIndex(d => d.board === boardNumber);
    if (idx === -1) return;
    pool[idx].ddTable = table;

    if (deals && pool === deals) {
        // La partie est déjà lancée. Si on regarde justement cette donne-là et que
        // l'enchère est terminée, on rafraîchit l'affichage pour faire apparaître le PAR
        // sans attendre un changement de donne.
        if (idx === boardIndex && isAuctionOver(auctionHistory)) checkAuctionEnd();

        // Relais aux invités : eux n'ont reçu qu'un instantané figé des donnes au moment
        // du 'start-game' (voir uiStartGameAsHost) — un résultat de double mort arrivé
        // après coup ne leur parviendrait jamais sans ce message dédié. Seul l'hôte
        // calcule le double mort (uiGenerateRandomDeals n'est accessible que depuis son
        // propre panneau), donc seul lui a besoin de le relayer.
        if (myRole === 'host') {
            participants.filter(p => p.id !== 'host' && !p.disconnected).forEach(p => {
                const guestIndex = guestIndexForParticipant(p.id);
                if (guestIndex != null) peerConn.send({ type: 'dd-result', boardNumber, table }, guestIndex);
            });
        }
    }
}

// Recalcule pendingOrderedDeals à partir de pendingParsedDeals et de l'état actuel de la
// case à cocher. Appelé au chargement du fichier et à chaque bascule de la case.
function refreshPendingOrderedDeals() {
    if (!pendingParsedDeals) {
        pendingOrderedDeals = null;
        return;
    }
    const checkbox = document.getElementById('randomizeDealsToggle');
    pendingOrderedDeals = (checkbox && checkbox.checked)
        ? shuffleDealsArray(pendingParsedDeals)
        : pendingParsedDeals;
}

// Appelé par la case "Ordre aléatoire des donnes" du salon d'attente.
function uiToggleRandomizeDeals() {
    refreshPendingOrderedDeals();
}

// ===== Bibliothèque de donnes du club =====
//
// donnes/catalogue.json est un simple tableau de noms de fichiers (voir donnes/README.md
// pour la marche à suivre pour en ajouter) : ["exemple.pbn", "autre-exemple.lin"]. Pas de
// backend — ajouter une donne à la bibliothèque, c'est déposer le fichier dans donnes/ et
// ajouter son nom à ce tableau, puis pousser sur GitHub comme le reste du site.
//
// Chargé une fois au démarrage de l'appli plutôt qu'à l'entrée dans le salon : peu de
// risque que le catalogue change en cours de session, et ça évite un aller-retour réseau
// à chaque fois que l'hôte revient sur cet écran.
function initDealLibrary() {
    fetch('donnes/catalogue.json')
        .then(resp => {
            if (!resp.ok) throw new Error('catalogue absent ou illisible');
            return resp.json();
        })
        .then(filenames => {
            if (!Array.isArray(filenames) || filenames.length === 0) return; // bibliothèque vide : on laisse le groupe masqué

            const select = document.getElementById('dealLibrarySelect');
            const group = document.getElementById('dealLibraryGroup');
            if (!select || !group) return;

            filenames.forEach(filename => {
                const option = document.createElement('option');
                option.value = filename;
                option.textContent = filename;
                select.appendChild(option);
            });
            group.style.display = 'block';
        })
        .catch(() => {
            // Pas de bibliothèque déployée (ou catalogue.json absent/vide) : ce n'est pas
            // une erreur pour l'utilisateur, juste une fonctionnalité qui ne s'active pas.
            // Le groupe reste masqué (voir style initial dans index.html), pas de message.
        });
}

// --- Demande d'annulation (undo) ---
let undoRequestPending = false; // je suis le demandeur, en attente d'une réponse
let pendingUndoAsk = null;      // on me demande d'accepter/refuser une annulation
let hostPendingUndo = null;     // (hôte uniquement) demande en cours d'arbitrage
let undoRequestTimeoutId = null;

function currentDeal() {
    return deals[boardIndex];
}

// Un kibbitz (non assigné à un siège) ne peut pas naviguer entre les donnes ; tout
// joueur actif (hôte ou invité) le peut.
function canControlBoard() {
    return myRole === 'host' || (mySeats && mySeats.length > 0);
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
}

// Avatar rond (couleur + initiale) affiché devant un participant, dans la liste et dans
// les cases de sièges assignées — juste un repère visuel rapide pour distinguer les
// joueurs d'un coup d'œil, pas une vraie identité. La couleur est dérivée de l'id du
// participant (stable même s'il se renomme, change du coup si un autre participant
// prend sa place au même id ne se produit jamais — les id sont uniques par connexion).
// Palette de couleurs d'avatar : les 15 couleurs par défaut officielles de Twitch (celles
// proposées gratuitement dans son sélecteur "Chat Identity", sans abonnement Turbo/Prime)
// — même liste, mêmes valeurs hexadécimales exactes.
const AVATAR_COLOR_PALETTE = [
    '#FF0000', // Red
    '#0000FF', // Blue
    '#00FF00', // Green
    '#8A2BE2', // BlueViolet
    '#FF7F50', // Coral
    '#5F9EA0', // CadetBlue
    '#D2691E', // Chocolate
    '#1E90FF', // DodgerBlue
    '#B22222', // Firebrick
    '#DAA520', // GoldenRod
    '#FF69B4', // HotPink
    '#FF4500', // OrangeRed
    '#2E8B57', // SeaGreen
    '#00FF7F', // SpringGreen
    '#9ACD32', // YellowGreen
];

function avatarColorForId(id) {
    // Surcharge manuelle (voir échange avec Guillaume, uiRandomizeAvatarColor) : si ce
    // participant a choisi une couleur au clic sur son avatar, elle prime sur le calcul
    // déterministe ci-dessous.
    const p = participants.find(x => x.id === id);
    if (p && p.avatarColor) return p.avatarColor;

    // Mélange le code de salon dans le hash (pas l'id seul) : une couleur différente à
    // chaque nouvelle partie plutôt qu'une "couleur de signature" fixe pour toujours sur
    // cet appareil — mais stable pendant toute la durée d'UNE partie, y compris après une
    // reconnexion (le code de salon ne change pas entre-temps, seul le jeton pourrait
    // changer de contexte). Sans code de salon connu (avant qu'une partie ait démarré),
    // repli sur l'id seul.
    let hash = 0;
    const str = (currentRoomCode || '') + '|' + String(id || '');
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return AVATAR_COLOR_PALETTE[hash % AVATAR_COLOR_PALETTE.length];
}

// Certaines des 15 couleurs Twitch (Green, SpringGreen, HotPink...) sont trop claires
// pour rester lisibles avec le texte blanc fixe de l'initiale dans le rond d'avatar —
// Twitch, lui, ne les utilise qu'en texte sur fond sombre, jamais en aplat avec du blanc
// dessus. Calcule donc noir ou blanc selon la luminosité perçue de la couleur de fond
// (formule standard de luminance relative), plutôt qu'un blanc fixe qui échouerait sur
// les teintes claires de la palette.
function avatarTextColorFor(hexColor) {
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.55 ? '#17231d' : '#ffffff';
}



function avatarInitial(name) {
    const trimmed = (name || '').trim();
    return trimmed ? trimmed[0].toUpperCase() : '?';
}

// HTML de l'avatar pour un participant donné (par son id) ; chaîne vide si personne.
function avatarHtml(participantId) {
    const p = participants.find(x => x.id === participantId);
    if (!p) return '';
    const bg = avatarColorForId(p.id);
    return `<span class="mini-avatar" style="background:${bg};color:${avatarTextColorFor(bg)}">${escapeHtml(avatarInitial(p.name))}</span>`;
}

function defaultParticipantName(pid) {
    if (pid === 'host') return 'Hôte';
    // Nom par défaut d'un nouvel invité, basé sur son rang d'arrivée (pas sur son id, qui
    // est maintenant un jeton opaque et non plus un simple numéro de connexion).
    const guestCount = participants.filter(p => p.id !== 'host').length;
    return 'Guest #' + (guestCount + 1);
}

// ===== Navigation entre écrans =====

function showScreen(id) {
    document.querySelectorAll('.screen').forEach(el => el.style.display = 'none');
    // '' (et non 'block' en dur) : un style inline a une priorité absolue sur n'importe
    // quelle règle de styles.css, y compris #screen-game { display: flex; ... } posé par
    // le layout plein écran mobile (voir @media max-width:768px) — le forcer à 'block'
    // ici l'écrasait silencieusement et faisait s'effondrer tout le système de répartition
    // des hauteurs (mains/enchères/boîte fixée en bas), avec un retour au scroll de page
    // classique. Laisser vide restaure le display défini par la feuille de style (block
    // par défaut pour un <section>, flex pour #screen-game sous 768px).
    document.getElementById(id).style.display = '';

    // Voir échange avec Guillaume : seul l'écran de jeu élargit .app-container (pour que
    // le panneau central garde sa taille, chat ouvert ou fermé) — les autres écrans
    // (accueil, salon) restent centrés et étroits comme avant.
    const appContainer = document.querySelector('.app-container');
    if (appContainer) appContainer.classList.toggle('wide-layout', id === 'screen-game');

    // Voir échange avec Guillaume (chat qui recouvrait la boîte d'enchères sur mobile,
    // mesuré : le panneau flottant, à 555-834px, chevauchait la boîte à 547-945px) : dans
    // le salon comme en pleine partie, le chat n'est plus un panneau flottant par-dessus
    // le reste (voir dockChatIntoScreen/undockChatFromScreen) — il rejoint le flux normal
    // de la page, tout en bas. Seul l'écran d'accueil garde le panneau flottant classique
    // (le chat n'y a de toute façon aucun sens, voir plus bas — masqué avant même de se
    // poser la question de son ancrage).
    if (id === 'screen-game' || id === 'screen-lobby') dockChatIntoScreen(id);
    else undockChatFromScreen();

    // Le chat n'a de sens qu'une fois dans un salon ou en partie (il faut des participants
    // à qui parler) : masqué sur l'écran d'accueil, affiché partout ailleurs. Point de
    // contrôle unique ici plutôt que dispersé à chaque appel de showScreen (voir échange
    // avec Guillaume — le bouton était visible dès le chargement, avant toute connexion,
    // alors que non fonctionnel).
    const chatBtn = document.getElementById('chatToggleBtn');
    if (chatBtn) {
        chatBtn.style.display = (id === 'screen-landing') ? 'none' : '';
        // Si on retombe sur l'écran d'accueil (ex. erreur de connexion) alors que le
        // panneau de chat était resté ouvert, on le referme avec : un panneau de chat
        // ouvert sur l'écran d'accueil serait tout aussi orphelin que le bouton qui
        // l'ouvre.
        if (id === 'screen-landing' && chatPanelOpen) uiToggleChat();
    }

    // Voir échange avec Guillaume : sur l'écran d'accueil, rien n'est encore connecté, le
    // trait de séparation sous la barre de statut n'a donc rien à séparer et fait juste
    // ligne parasite (voir la règle CSS body.on-landing-screen .connection-bar).
    document.body.classList.toggle('on-landing-screen', id === 'screen-landing');

    // Chaque changement d'écran est une occasion de retenter une mise à jour PWA restée en
    // attente (voir tryAutoApplyUpdate) — sans effet tant qu'une connexion de salle est
    // active, donc sans risque à appeler ici systématiquement, y compris pour screen-game.
    tryAutoApplyUpdate();
}

function setConnectionStatus(connected) {
    const bar = document.getElementById('connectionBar');
    const status = document.getElementById('connectionStatus');
    bar.style.display = 'flex';
    status.textContent = connected ? '🟢 Connecté' : '🔴 Déconnecté';
    status.className = 'connection-status ' + (connected ? 'connected' : 'disconnected');
}

function showLandingError(msg) {
    const el = document.getElementById('landingError');
    el.textContent = msg;
    el.style.display = 'block';
}

// ===== Panneau de diagnostic (visible à l'écran, utile sur mobile sans accès aux DevTools) =====

const debugLogLines = [];

function pushDebugLog(line) {
    const timestamp = new Date().toLocaleTimeString('fr-FR');
    debugLogLines.push(`[${timestamp}] ${line}`);
    const content = document.getElementById('debugLogContent');
    if (content) {
        content.textContent = debugLogLines.join('\n');
        content.scrollTop = content.scrollHeight;
    }
}

function uiToggleDebugPanel() {
    const panel = document.getElementById('debugPanel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

function uiCopyDebugLog() {
    const text = debugLogLines.join('\n');
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopyDebugLog(text));
    } else {
        fallbackCopyDebugLog(text);
    }
}

function fallbackCopyDebugLog(text) {
    const content = document.getElementById('debugLogContent');
    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
}

// ===== Écran d'accueil : créer / rejoindre =====

function tokenForGuestIndex(guestIndex) {
    return Object.keys(guestIndexByToken).find(t => guestIndexByToken[t] === guestIndex) || null;
}

// Voir échange avec Guillaume : bandeau plein écran affiché dès le clic sur "Créer" ou
// "Rejoindre", masqué une fois la connexion établie ou en cas d'erreur explicite. Un filet
// de sécurité (connectingOverlayTimeout) le masque de toute façon après 15s si aucun des
// deux ne s'est produit — pour ne pas laisser le joueur bloqué indéfiniment derrière un
// écran de chargement si la connexion traîne sans jamais aboutir ni échouer clairement.
let connectingOverlayTimeout = null;

function showConnectingOverlay(message) {
    const overlay = document.getElementById('connectingOverlay');
    if (!overlay) return;
    document.getElementById('connectingOverlayText').textContent = message;
    overlay.style.display = 'flex';
    clearTimeout(connectingOverlayTimeout);
    connectingOverlayTimeout = setTimeout(hideConnectingOverlay, 50000); // au-delà du timeout de connexion existant (45s, voir onTimeout), pur filet de sécurité
}

function hideConnectingOverlay() {
    clearTimeout(connectingOverlayTimeout);
    const overlay = document.getElementById('connectingOverlay');
    if (overlay) overlay.style.display = 'none';
}

function uiCreateRoom() {
    document.getElementById('landingError').style.display = 'none';
    showConnectingOverlay('Création de la partie…');
    if (peerConn) peerConn.destroy();

    myRole = 'host';
    myParticipantId = 'host';
    participants = [{ id: 'host', name: savedNickname || 'Hôte' }];
    seatAssignment = { N: null, E: null, S: null, W: null };
    guestIndexByToken = {};
    prevSeatAssignmentSnapshot = null;
    prevParticipantsDisconnectedSnapshot = null;
    chatMessages = [];
    chatUnreadCount = 0;
    updateChatUnreadBadge();
    lobbyChatAutoOpened = false;
    pendingParsedDeals = null;
    pendingParsedSource = null;
    pendingOrderedDeals = null;

    peerConn = new BridgePeerConnection(buildHostHandlers());
    peerConn.createRoom();
}

// Handlers PeerJS côté hôte — partagés entre uiCreateRoom (nouvelle partie) et la prise de
// rôle après un transfert d'hôte (voir uiTransferHost/'prepare-become-host'), qui doivent
// tous deux traiter les connexions entrantes exactement de la même façon. Seul le
// comportement à l'ouverture du Peer diffère (onOpenExtra) : une toute nouvelle partie
// atterrit dans le salon normalement, une prise de rôle a besoin de faire autre chose
// d'abord (prévenir l'ancien hôte) avant de basculer l'écran.
function buildHostHandlers(onOpenExtra) {
    return {
        onOpen: (role, roomCode) => {
            hideConnectingOverlay();
            currentRoomCode = roomCode;
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomCode);
            document.getElementById('shareLinkInput').value = url.toString();
            document.getElementById('lobbyRoomCodeInline').textContent = `(code ${roomCode})`;
            if (onOpenExtra) onOpenExtra(roomCode);
            else enterLobbyScreen();
        },
        onGuestConnected: (guestIndex, metadata) => {
            setConnectionStatus(true);
            // Jeton fourni par l'invité (persistant côté lui, via localStorage) : s'il est
            // déjà connu, c'est un retour (reconnexion), pas un nouvel arrivant. Repli sur un
            // id à l'ancienne pour un client qui n'enverrait pas de jeton (compat).
            const token = (metadata && metadata.reconnectToken) || ('guest' + guestIndex);

            // Voir échange avec Guillaume : si ce jeton avait déjà une connexion active à un
            // AUTRE index (retour après une coupure que le WebRTC n'a pas encore détectée
            // côté hôte — fréquent sur mobile, en arrière-plan ou en changeant de réseau),
            // on la ferme explicitement plutôt que de la laisser traîner en double à côté de
            // la nouvelle. Sans ça, l'ancienne connexion "fantôme" continuait d'exister
            // silencieusement, avec un risque de messages envoyés au mauvais endroit.
            const previousGuestIndex = guestIndexByToken[token];
            if (previousGuestIndex !== undefined && previousGuestIndex !== guestIndex) {
                const staleConn = peerConn.conns[previousGuestIndex];
                if (staleConn) {
                    pushDebugLog(`Jeton ${token.slice(0, 10)}… déjà connecté à l'ancien index #${previousGuestIndex} — fermeture de cette connexion fantôme.`);
                    try { staleConn.close(); } catch (e) { /* déjà fermée, sans importance */ }
                    peerConn.conns[previousGuestIndex] = null;
                }
            }
            guestIndexByToken[token] = guestIndex;

            let p = participants.find(x => x.id === token);
            const isReturning = !!p;
            const wasDisconnected = isReturning && p.disconnected;
            if (!p) {
                // Un pseudo sauvegardé côté invité (voir savedNickname) prime sur le nom
                // générique "Guest #N" — transmis via les métadonnées de connexion, comme
                // le jeton de reconnexion.
                const nickname = metadata && metadata.nickname;
                p = { id: token, name: nickname || defaultParticipantName(token), disconnected: false, disconnectedAt: null };
                participants.push(p);
            } else {
                p.disconnected = false;
                p.disconnectedAt = null;
            }
            pushDebugLog(`Connexion #${guestIndex} : jeton ${token.slice(0, 10)}… → ${isReturning ? 'reconnexion reconnue (' + p.name + ')' : 'nouveau participant'}`);
            if (wasDisconnected) flashWelcomeBack(p.name);

            peerConn.send({ type: 'welcome', yourId: token }, guestIndex);

            if (deals) {
                // La partie est déjà lancée : on renvoie l'état complet (donnes, enchère en
                // cours, sièges) à ce joueur, qu'il soit nouveau ou de retour après coupure.
                // Les sièges "robot" restent ceux décidés au lancement (voir uiStartGameAsHost) :
                // un joueur déconnecté n'est PAS remplacé automatiquement, son siège attend
                // simplement qu'il revienne (voir le tour-indicateur pendant la partie).
                const seatsForThisGuest = SEATS.filter(seat => seatAssignment[seat] === token);
                peerConn.send({
                    type: 'resync',
                    deals, boardIndex, auctionHistory,
                    yourSeats: seatsForThisGuest,
                    botSeats: autoPassSeats
                }, guestIndex);
            }

            broadcastLobbyState();
            renderLobby();
            if (deals) renderBoard();
        },
        onPeerDisconnected: (guestIndex) => {
            setConnectionStatus(peerConn ? peerConn.isConnected() : false);
            const token = tokenForGuestIndex(guestIndex);
            if (token) {
                delete guestIndexByToken[token];
                // On NE supprime pas le participant ni son siège : ils restent réservés, en
                // attente qu'il se reconnecte. Son siège n'est PAS remplacé par un robot —
                // l'enchère patiente simplement (le tour-indicateur et la bannière de
                // reconnexion le signalent tous les deux, cf. renderReconnectionBanner).
                const p = participants.find(x => x.id === token);
                if (p) { p.disconnected = true; p.disconnectedAt = Date.now(); }
            }
            hostPendingUndo = null; // un invité qui part au milieu d'un arbitrage : on ne reste pas bloqué
            // Voir audit : si le participant qui vient de partir était justement la cible
            // d'un transfert d'hôte en cours, plus aucune réponse ('become-host-ready' ou
            // '-failed') n'arrivera jamais — sans ce filet, hostTransferInProgress resterait
            // bloqué à true pour toujours, empêchant tout nouveau transfert.
            if (hostTransferInProgress && token === pendingHostTransferTarget) {
                hostTransferInProgress = false;
                pendingHostTransferTarget = null;
                pendingHostTransferOldToken = null;
                showHostTransferStatus('Le participant visé par le transfert vient de se déconnecter. Transfert annulé, vous restez hôte.', true);
            }
            broadcastLobbyState();
            renderLobby();
            if (deals) renderBoard();
        },
        onSlowConnection: () => {},
        onTimeout: () => {},
        onData: handlePeerData,
        // Voir onSignalingDisconnected côté invité (buildGuestHandlers) : même lacune côté
        // hôte, avec une conséquence différente — les invités déjà connectés continuent
        // parfois de fonctionner un moment via leur canal WebRTC direct, mais personne de
        // nouveau ne peut plus rejoindre la partie tant que ce n'est pas rétabli. Ça
        // correspond très probablement au souci "Aucune partie trouvée" déjà diagnostiqué
        // (host qui change d'appli sur iPhone juste après avoir créé la salle) : au moins,
        // maintenant, le statut reflète ce problème au lieu de rester "🟢 Connecté".
        onSignalingDisconnected: () => {
            setConnectionStatus(false);
        },
        onError: (err) => {
            hideConnectingOverlay();
            showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
        }
    };
}

// Construit les handlers PeerJS côté invité — partagés entre uiJoinRoom (première
// connexion) et uiReconnect (après une coupure), pour ne pas dupliquer la logique.
function buildGuestHandlers() {
    return {
        onOpen: (role, roomCode) => {
            document.getElementById('lobbyRoomCodeInline').textContent = `(code ${roomCode})`;
        },
        onGuestConnected: () => {
            hideConnectingOverlay();
            everConnectedAsGuest = true;
            setConnectionStatus(true);
            renderReconnectButton();
        },
        onPeerDisconnected: () => {
            setConnectionStatus(false);
            renderReconnectButton();
        },
        // Voir échange avec Guillaume ("le bouton Se reconnecter n'apparaît pas") : sans ce
        // handler, une coupure de la connexion au serveur de signalisation (WebSocket) qui
        // ne provoque pas de fermeture propre de la DataConnection passait complètement
        // inaperçue — ni le statut ni le bouton ne se mettaient à jour.
        onSignalingDisconnected: () => {
            setConnectionStatus(false);
            renderReconnectButton();
        },
        onSlowConnection: () => {
            // Masque l'overlay ici (voir échange avec Guillaume) : sinon le message
            // "ça prend plus de temps..." resterait caché derrière l'écran de chargement
            // plein écran, invisible pour le joueur.
            hideConnectingOverlay();
            showLandingError("⏳ Ça prend plus de temps que d'habitude... Vérifie que le code est correct.");
        },
        onTimeout: () => {
            hideConnectingOverlay();
            if (deals) {
                // On était déjà en jeu : pas de retour à l'écran d'accueil, on laisse le
                // bouton "Se reconnecter" de la barre de connexion (renderReconnectButton).
                return;
            }
            showScreen('screen-landing');
            showLandingError(
                "⚠️ La connexion n'a pas abouti après 45 secondes. Vérifie le code, que l'hôte est " +
                "toujours connecté, et ouvre la console (F12) pour plus de détails avant de réessayer."
            );
        },
        onData: handlePeerData,
        onError: (err) => {
            hideConnectingOverlay();
            // Voir échange avec Guillaume ("je suis ressorti du salon, puis 'Lost connection
            // to server' en retapant un code") : une erreur peut désormais survenir bien
            // après un premier join réussi — notamment quand la tentative de reconnexion
            // automatique en arrière-plan (voir peer.reconnect() dans peer-connection.js,
            // déclenché après une coupure de signalisation) échoue à son tour. Avant ce
            // correctif, TOUTE erreur ici renvoyait vers l'écran d'accueil avec un bandeau
            // "Erreur de connexion", même en plein milieu d'une session par ailleurs
            // fonctionnelle — perturbant pour rien et laissant l'appli dans un état confus
            // pour retaper un nouveau code ensuite. Désormais, seule une VRAIE première
            // tentative de connexion qui échoue (jamais connecté ne serait-ce qu'une fois)
            // déclenche ce comportement ; passé ce cap, on s'en remet simplement au statut
            // et au bouton "🔌 Se reconnecter" (déjà mis à jour par onSignalingDisconnected/
            // onPeerDisconnected), sans rien arracher à l'écran.
            if (!everConnectedAsGuest) {
                if (!deals) showScreen('screen-landing');
                if (err && err.type === 'peer-unavailable') {
                    showLandingError("Aucune partie trouvée avec ce code. Vérifiez le code ou demandez à l'hôte de le repartager.");
                } else {
                    showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
                }
            } else {
                pushDebugLog('Erreur (après connexion déjà établie), ignorée côté interface : ' + ((err && (err.message || err.type)) || err));
            }
        }
    };
}

// Voir échange avec Guillaume (double tap nécessaire sur "Rejoindre" au clavier mobile) :
// valider directement depuis le clavier virtuel (touche "Aller", voir enterkeyhint="go"
// dans index.html) contourne complètement le souci, plutôt que de devoir taper le bouton.
function uiJoinCodeInputKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    uiJoinRoom();
}

function uiJoinRoom() {
    document.getElementById('landingError').style.display = 'none';
    const code = document.getElementById('joinCodeInput').value.trim();
    if (!/^\d{4}$/.test(code)) {
        showLandingError('Entrez un code à 4 chiffres.');
        return;
    }
    chatMessages = [];
    chatUnreadCount = 0;
    updateChatUnreadBadge();
    showConnectingOverlay('Connexion en cours…');
    connectAsGuest(code, getReconnectToken(), savedNickname);
}

// Rejoint (ou re-rejoint) une salle en tant qu'invité, avec un jeton et un pseudo donnés.
// Partagé par uiJoinRoom (première connexion) et le transfert d'hôte (voir 'host-transferred'
// / 'become-host-ready' dans handlePeerData) : dans les deux cas, on repart d'un état de
// salon vierge, qui sera reconstitué dès réception du premier 'lobby-state' du nouvel hôte —
// exactement comme un rejoin normal.
function connectAsGuest(code, token, nickname) {
    if (peerConn) peerConn.destroy();
    // Statut honnête tout de suite : sans ça, la barre garde l'affichage précédent
    // ("Connecté") pendant tout le temps de la nouvelle connexion, ce qui pouvait laisser
    // penser à tort que quelque chose avait cassé pendant un transfert d'hôte alors que la
    // reconnexion était juste en cours (voir échange avec Guillaume).
    setConnectionStatus(false);

    myRole = 'guest';
    myParticipantId = null; // fixé à réception du message 'welcome'
    participants = [];
    seatAssignment = { N: null, E: null, S: null, W: null };
    currentRoomCode = code;
    everConnectedAsGuest = false;
    prevSeatAssignmentSnapshot = null;
    prevParticipantsDisconnectedSnapshot = null;
    lobbyChatAutoOpened = false;

    peerConn = new BridgePeerConnection(buildGuestHandlers());
    pushDebugLog(`Connexion au salon ${code} avec le jeton ${token.slice(0, 10)}…`);
    peerConn.joinRoom(code, { reconnectToken: token, nickname: nickname });
}

// Reconnexion après coupure : même code de salon, même jeton (localStorage) — l'hôte
// reconnaît le jeton et renvoie automatiquement les sièges et l'état de partie en cours.
function uiReconnect() {
    if (myRole !== 'guest' || !currentRoomCode) return;
    if (peerConn) peerConn.destroy();
    setConnectionStatus(false);
    peerConn = new BridgePeerConnection(buildGuestHandlers());
    const token = getReconnectToken();
    pushDebugLog(`Reconnexion au salon ${currentRoomCode} avec le jeton ${token.slice(0, 10)}…`);
    peerConn.joinRoom(currentRoomCode, { reconnectToken: token, nickname: savedNickname });
}

let everConnectedAsGuest = false;

function renderReconnectButton() {
    const btn = document.getElementById('reconnectBtn');
    if (!btn) return;
    const shouldShow = myRole === 'guest' && everConnectedAsGuest && peerConn && !peerConn.isConnected();
    btn.style.display = shouldShow ? '' : 'none';
}

let copyShareLinkTimeoutId = null;
function uiCopyShareLink() {
    const input = document.getElementById('shareLinkInput');
    input.select();
    input.setSelectionRange(0, 99999);
    if (!navigator.clipboard) return;

    navigator.clipboard.writeText(input.value).then(() => {
        // Confirmation temporaire directement sur le bouton (pas de toast à part à
        // gérer) : le libellé change le temps d'un instant, puis revient à la normale.
        const btn = document.getElementById('copyShareLinkBtn');
        if (!btn) return;
        clearTimeout(copyShareLinkTimeoutId);
        btn.textContent = '✅ Lien copié !';
        copyShareLinkTimeoutId = setTimeout(() => {
            btn.textContent = '🔗 Copier lien de connexion';
        }, 1800);
    }).catch(() => { /* échec silencieux (permission navigateur, etc.) : pas de fausse confirmation */ });
}

// ===== Salon d'attente =====

function enterLobbyScreen() {
    showScreen('screen-lobby');
    document.getElementById('lobbyRoomCodeBlock').style.display = myRole === 'host' ? 'block' : 'none';
    document.getElementById('hostSetupPanel').style.display = myRole === 'host' ? 'block' : 'none';
    document.getElementById('guestWaitingNote').style.display = myRole === 'host' ? 'none' : 'block';

    // Voir échange avec Guillaume : reprend la préférence persistée (voir
    // robotBiddingMode/loadBoolPref) — sans ça, la case reviendrait toujours décochée par
    // défaut au rechargement, même si l'hôte l'avait activée la dernière fois.
    if (myRole === 'host') {
        const robotModeCheckbox = document.getElementById('robotBiddingModeCheckbox');
        if (robotModeCheckbox) robotModeCheckbox.checked = robotBiddingMode === 'passOnly';
    }

    const nameInput = document.getElementById('myNameInput');
    // On ne touche jamais au champ pendant que l'utilisateur est en train d'y taper
    // (sinon un lobby-state reçu pile pendant l'effacement du nom réécrase ce qu'il
    // est en train de saisir).
    if (!nameInput.value && document.activeElement !== nameInput) {
        const me = participants.find(p => p.id === myParticipantId);
        nameInput.value = me ? me.name : '';
    }

    // Voir échange avec Guillaume : dans le salon, le chat s'ouvre automatiquement — pas
    // besoin d'aller cliquer sur 💬 pour voir qui est là et papoter en attendant que tout
    // le monde arrive. `lobbyChatAutoOpened` évite de le rouvrir de force à chaque nouveau
    // 'lobby-state' reçu (enterLobbyScreen est réappelée à chaque changement de
    // participant) : une seule fois par entrée fraîche dans le salon, sinon on écraserait
    // le choix de quelqu'un qui l'aurait refermé volontairement entre-temps.
    if (!deals && !lobbyChatAutoOpened) {
        lobbyChatAutoOpened = true;
        if (!chatPanelOpen) uiToggleChat();
    }

    renderLobby();
}

function renderLobby() {
    renderParticipantsList();
    renderSeatAssignmentGrid();
    renderHostTransferWidget();
}

// Vrai si ce participant occupe un siège à la table — utilisé pour la coloration de son
// nom dans la liste des participants (bleu si placé, rouge sinon). Il n'y a plus de
// "place de kibbitz" à assigner à part : quiconque n'a pas de siège devient
// automatiquement kibbitz une fois la partie lancée (voir isKibbitz), donc rien
// d'autre à cocher ici.
function participantHasAPlace(participantId) {
    return SEATS.some(seat => seatAssignment[seat] === participantId);
}

// Changement de couleur d'avatar au clic (voir échange avec Guillaume) : l'hôte peut le
// faire pour n'importe qui, les autres seulement pour eux-mêmes. Exclut la couleur
// actuelle du tirage pour garantir un changement visible à chaque clic (un tirage
// purement aléatoire pourrait sinon retomber sur la même par hasard, donnant l'impression
// que le clic n'a rien fait).
function uiRandomizeAvatarColor(event, participantId) {
    event.stopPropagation();
    const canChange = myRole === 'host' || participantId === myParticipantId;
    if (!canChange) return;
    const p = participants.find(x => x.id === participantId);
    if (!p) return;
    const current = avatarColorForId(participantId);
    const choices = AVATAR_COLOR_PALETTE.filter(c => c !== current);
    p.avatarColor = choices[Math.floor(Math.random() * choices.length)];
    broadcastLobbyState();
    renderLobby();
}

function renderParticipantsList() {
    const list = document.getElementById('participantsList');
    // Si l'hôte est en train de renommer quelqu'un, on ne reconstruit pas la liste
    // (un reflow ici lui ferait perdre le focus et le curseur en pleine frappe).
    if (document.activeElement && document.activeElement.classList.contains('participant-rename-input')) {
        return;
    }
    const isHost = myRole === 'host';
    // Cette liste EST la liste kibbitz (voir échange avec Guillaume) : quelqu'un qui
    // arrive est kibbitz par défaut, et le reste tant que l'hôte ne lui a pas assigné de
    // siège — il n'y a donc plus besoin de distinguer "assis"/"pas assis" ici comme
    // avant (voir l'ancien placementClass), puisque tout le monde affiché ici est de
    // toute façon sans siège par construction. Une fois assis, quelqu'un disparaît d'ici
    // et apparaît dans sa case de siège à la place (voir renderSeatAssignmentGrid) — d'où
    // la fusion avec l'ancien bloc kibbitz séparé sous la grille, devenu redondant.
    const kibitzers = participants.filter(p => !participantHasAPlace(p.id));
    list.innerHTML = kibitzers.map(p => {
        const canRename = isHost && p.id !== myParticipantId;
        // Nom en texte simple par défaut, converti en champ éditable seulement au CLIC
        // explicite (voir échange avec Guillaume et uiStartRenamingParticipant) : un
        // <input> toujours présent capte le focus au moindre appui, y compris un
        // appui-maintenu qui visait en fait à démarrer un glisser-déposer — ce qui
        // basculait à tort en mode "renommer" au lieu de laisser le glisser s'amorcer.
        const nameHtml = canRename
            ? `<span class="participant-name participant-name-editable" onclick="uiStartRenamingParticipant(event, '${p.id}')">${escapeHtml(p.name)}</span>`
            : `<span class="participant-name">${escapeHtml(p.name)}</span>`;
        // Glissable vers une case de siège (voir uiDropOnSeat) — seulement pour l'hôte,
        // seul à pouvoir réorganiser qui est où (voir uiDragStartParticipant).
        const dragAttrs = isHost ? ` draggable="true" ondragstart="uiDragStartParticipant(event, '${p.id}')"` : '';
        // Clic sur l'avatar pour changer de couleur au hasard (voir échange avec
        // Guillaume, uiRandomizeAvatarColor) : l'hôte peut le faire pour n'importe qui,
        // les autres seulement pour eux-mêmes.
        const canChangeColor = isHost || p.id === myParticipantId;
        const avatarHtmlBlock = canChangeColor
            ? `<span class="avatar-color-trigger" onclick="uiRandomizeAvatarColor(event, '${p.id}')" title="Changer de couleur">${avatarHtml(p.id)}</span>`
            : avatarHtml(p.id);
        return `
        <li class="participant-item ${p.id === myParticipantId ? 'is-me' : ''}"${dragAttrs}>
            ${avatarHtmlBlock}
            ${nameHtml}
            ${p.id === 'host' ? ' <span class="host-tag">(hôte)</span>' : ''}
            ${p.id === myParticipantId ? ' <span class="me-tag">(vous)</span>' : ''}
            ${p.disconnected ? ' <span class="disconnected-tag">🔌 déconnecté — place réservée</span>' : ''}
        </li>
    `;
    }).join('');
}

// Convertit le nom (affiché en texte simple, voir renderParticipantsList) en champ
// éditable au clic explicite — voir échange avec Guillaume : un <input> permanent aurait
// capté le focus dès un simple appui-maintenu voulant démarrer un glisser-déposer.
// stopPropagation évite que ce clic ne déclenche autre chose sur le <li> parent.
function uiStartRenamingParticipant(event, participantId) {
    event.stopPropagation();
    const span = event.currentTarget;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'participant-rename-input';
    input.maxLength = 20;
    input.value = span.textContent;
    input.oninput = () => uiRenameParticipant(participantId, input.value);
    input.onblur = () => uiRenameParticipantBlur(participantId, input);
    span.replaceWith(input);
    input.focus();
    input.select();
}

let participantRenameDebounceTimers = {};
// Renommage d'un participant par l'hôte. On met à jour et on diffuse, mais sans
// reconstruire la liste des participants pendant la frappe (voir garde ci-dessus) — la
// grille des sièges, elle, peut se rafraîchir sans risque puisqu'elle ne contient pas le
// champ en cours d'édition.
function uiRenameParticipant(participantId, value) {
    if (myRole !== 'host') return;
    clearTimeout(participantRenameDebounceTimers[participantId]);
    participantRenameDebounceTimers[participantId] = setTimeout(() => {
        const trimmed = value.trim();
        if (!trimmed) return; // idem que pour son propre nom : on attend le blur si le champ est vide
        const p = participants.find(x => x.id === participantId);
        if (!p) return;
        p.name = trimmed;
        broadcastLobbyState();
        renderSeatAssignmentGrid();
    }, 300);
}

// Si l'hôte quitte le champ en le laissant vide, on retombe sur le nom par défaut
// de ce participant plutôt que de laisser un pseudo vide.
function uiRenameParticipantBlur(participantId, inputEl) {
    if (myRole !== 'host') return;
    clearTimeout(participantRenameDebounceTimers[participantId]);
    const p = participants.find(x => x.id === participantId);
    if (!p) return;
    const trimmed = inputEl.value.trim();
    p.name = trimmed || defaultParticipantName(participantId);
    broadcastLobbyState();
    renderLobby();
}

function renderSeatAssignmentGrid() {
    const container = document.getElementById('seatAssignmentGrid');
    const isHost = myRole === 'host';

    // Un siège "vient d'être assigné" si son occupant est non vide ET différent de ce
    // qu'il était au rendu précédent (couvre à la fois une case vide qui se remplit et un
    // changement d'occupant) — voir prevSeatAssignmentSnapshot pour le cas particulier du
    // tout premier rendu.
    const justAssigned = seat => {
        if (prevSeatAssignmentSnapshot === null) return false;
        const assignedId = seatAssignment[seat];
        return !!assignedId && assignedId !== prevSeatAssignmentSnapshot[seat];
    };

    // Symétrique de justAssigned (voir échange avec Guillaume) : un siège "vient d'être
    // libéré" s'il était occupé au rendu précédent et ne l'est plus maintenant — même
    // effet visuel que l'arrivée, pour signaler tout autant le départ.
    const justVacated = seat => {
        if (prevSeatAssignmentSnapshot === null) return false;
        return !!prevSeatAssignmentSnapshot[seat] && !seatAssignment[seat];
    };

    const seatBoxes = SEATS.map(seat => {
        const assignedId = seatAssignment[seat];
        const flashClass = justAssigned(seat) ? ' just-assigned' : (justVacated(seat) ? ' just-vacated' : '');
        if (isHost) {
            // Menu déroulant personnalisé (voir échange avec Guillaume) plutôt qu'un
            // <select> natif : un <option> ne peut pas contenir d'avatar coloré, alors
            // Glissable depuis TOUTE la case, pas seulement le petit déclencheur (voir
            // échange avec Guillaume) — même surface que la zone de dépôt (déjà sur la
            // case entière, voir ondragover/ondrop plus bas), pour une prise en main
            // cohérente dans les deux sens.
            const occupantP = assignedId ? participants.find(x => x.id === assignedId) : null;
            const boxDragAttrs = occupantP ? ` draggable="true" ondragstart="uiDragStartParticipant(event, '${assignedId}', '${seat}')"` : '';
            const triggerContent = occupantP
                ? `${avatarHtml(assignedId)}<span class="kibitz-chip-name">${escapeHtml(occupantP.name)}</span>`
                : `<span class="mini-avatar mini-avatar-robot">🤖</span><span class="kibitz-chip-name">Robot</span>`;

            const robotOptionClass = assignedId ? '' : ' is-current';
            const optionsHtml = [`
                <div class="seat-dropdown-option${robotOptionClass}" onclick="uiAssignSeat('${seat}', ''); uiCloseSeatDropdowns();">
                    <span class="mini-avatar mini-avatar-robot">🤖</span><span>Robot</span>
                </div>
            `].concat(participants.map(p => {
                const currentClass = p.id === assignedId ? ' is-current' : '';
                return `
                    <div class="seat-dropdown-option${currentClass}" onclick="uiAssignSeat('${seat}', '${p.id}'); uiCloseSeatDropdowns();">
                        ${avatarHtml(p.id)}<span>${escapeHtml(p.name)}</span>
                    </div>
                `;
            }));

            return `
                <div class="seat-box seat-pos-${seat}${flashClass}"${boxDragAttrs} ondragover="uiAllowDrop(event)" ondragenter="uiDragEnterTarget(event)" ondragleave="uiDragLeaveTarget(event)" ondrop="uiDropOnSeat(event, '${seat}')">
                    <span class="seat-box-label">${SEAT_FULL_NAME[seat]}</span>
                    <div class="seat-occupant-dropdown">
                        <button type="button" class="kibitz-chip seat-occupant-chip${occupantP ? '' : ' seat-occupant-chip-robot'}" onclick="uiToggleSeatDropdown(event, '${seat}')">
                            ${triggerContent}
                            <span class="seat-dropdown-chevron">▾</span>
                        </button>
                        <div class="seat-dropdown-menu" id="seatDropdownMenu-${seat}" style="display:none;">${optionsHtml.join('')}</div>
                    </div>
                </div>
            `;
        }
        const p = participants.find(x => x.id === assignedId);
        const name = p ? escapeHtml(p.name) : 'Robot';
        return `
            <div class="seat-box seat-pos-${seat}${flashClass}">
                <span class="seat-box-label">${SEAT_FULL_NAME[seat]}</span>
                <span class="seat-box-name-row">
                    ${assignedId ? avatarHtml(assignedId) : '<span class="mini-avatar mini-avatar-robot">🤖</span>'}
                    <span class="seat-box-name">${name}</span>
                </span>
            </div>
        `;
    }).join('');

    container.innerHTML = seatBoxes;
    prevSeatAssignmentSnapshot = { ...seatAssignment };
}

let nameUpdateDebounceTimer = null;
function uiUpdateMyName() {
    clearTimeout(nameUpdateDebounceTimer);
    nameUpdateDebounceTimer = setTimeout(() => {
        const input = document.getElementById('myNameInput');
        const trimmed = input.value.trim();
        // Champ momentanément vide (l'utilisateur efface pour retaper autre chose) :
        // on n'impose pas le nom par défaut ici, seulement au blur (voir uiMyNameBlur).
        // Sinon on écrase ce que la personne est en train de saisir.
        if (!trimmed) return;

        const me = participants.find(p => p.id === myParticipantId);
        if (me) me.name = trimmed;
        saveStringPref('bridgeBidNickname', trimmed);
        savedNickname = trimmed;

        if (myRole === 'host') {
            broadcastLobbyState();
            renderLobby();
        } else if (peerConn) {
            peerConn.send({ type: 'set-name', name: trimmed });
            renderLobby();
        }
    }, 300);
}

// Si l'utilisateur quitte le champ en le laissant vide, on retombe sur le nom par
// défaut (au lieu de laisser un pseudo vide affiché aux autres) — et on efface le pseudo
// sauvegardé : revenir explicitement au nom générique doit aussi valoir pour la
// prochaine fois, pas seulement pour la session en cours.
function uiMyNameBlur() {
    const input = document.getElementById('myNameInput');
    if (input.value.trim()) return;
    clearTimeout(nameUpdateDebounceTimer);
    const name = defaultParticipantName(myParticipantId);
    input.value = name;
    const me = participants.find(p => p.id === myParticipantId);
    if (me) me.name = name;
    saveStringPref('bridgeBidNickname', null);
    savedNickname = null;

    if (myRole === 'host') {
        broadcastLobbyState();
        renderLobby();
    } else if (peerConn) {
        peerConn.send({ type: 'set-name', name });
        renderLobby();
    }
}

// Menu déroulant personnalisé des sièges (voir échange avec Guillaume) : un seul ouvert à
// la fois. stopPropagation empêche le clic d'atteindre le gestionnaire global qui ferme
// tout au clic ailleurs (voir plus bas) — sans ça, ouvrir un menu le refermerait aussitôt.
// Élève aussi le z-index de LA CASE ENTIÈRE (pas seulement le menu) tant qu'il est ouvert
// (voir échange avec Guillaume, menu de Nord/Est passant derrière une case voisine) : les
// cases de siège partagent toutes le même z-index de base, donc celle qui vient après dans
// le DOM peint par-dessus — augmenter le seul z-index du menu ne suffit pas, puisqu'il
// reste enfermé dans le contexte d'empilement (plus bas) de sa propre case.
function uiToggleSeatDropdown(event, seat) {
    event.stopPropagation();
    const menu = document.getElementById(`seatDropdownMenu-${seat}`);
    if (!menu) return;
    const wasOpen = menu.style.display !== 'none';
    uiCloseSeatDropdowns();
    if (!wasOpen) {
        menu.style.display = 'block';
        const seatBox = menu.closest('.seat-box');
        if (seatBox) seatBox.classList.add('dropdown-open');
    }
}

function uiCloseSeatDropdowns() {
    document.querySelectorAll('.seat-dropdown-menu').forEach(m => { m.style.display = 'none'; });
    document.querySelectorAll('.seat-box.dropdown-open').forEach(b => { b.classList.remove('dropdown-open'); });
}

// Ferme tout menu de siège ouvert dès qu'on clique n'importe où ailleurs sur la page (voir
// échange avec Guillaume) — posé une seule fois au chargement, pas à chaque rendu de la
// grille (sinon les écouteurs s'empileraient à chaque re-rendu du salon).
document.addEventListener('click', uiCloseSeatDropdowns);

function uiAssignSeat(seat, participantId) {
    if (myRole !== 'host') return;
    // PAS de retrait automatique de l'ancien siège de cette personne (voir échange avec
    // Guillaume) : contrôler plusieurs sièges à la fois est une fonctionnalité voulue
    // depuis le début (mySeats est un tableau, pas une valeur unique — voir
    // renderMyHands, showActiveState) — un ancien correctif avait traité ça à tort comme
    // un bug de duplication, alors que c'est exactement ce que cette assignation doit
    // pouvoir faire.
    seatAssignment[seat] = participantId || null;
    broadcastLobbyState();
    renderLobby();
}

// Cliquer-glisser pour réorganiser les sièges (voir échange avec Guillaume) : glisser un
// "bouton" (chip kibbitz ou occupant d'un siège) sur une case de siège l'y assigne ; sur
// la zone kibbitz, ça le libère. Si la cible était déjà occupée, on ÉCHANGE les deux
// places plutôt que d'écraser l'occupant précédent (qui redevient sinon kibbitz
// silencieusement) — sauf si la source vient déjà du kibbitz, auquel cas rien à échanger,
// l'ancien occupant de la case cible devient simplement kibbitz à son tour. Réservé à
// l'hôte (seul à pouvoir réorganiser les sièges) — voir les gardes `myRole !== 'host'`.
// Retour visuel sur la zone de dépôt survolée (voir échange avec Guillaume) : dragenter/
// dragleave plutôt que dragover pour basculer la classe — dragover se redéclenche en
// continu tant qu'on survole, alors qu'on ne veut ajouter/retirer la classe qu'une seule
// fois. `relatedTarget` (l'élément vers lequel le curseur va) sert à distinguer une
// VRAIE sortie de la zone d'un simple passage sur l'un de ses propres enfants (le bouton,
// le menu déroulant) — sans cette vérification, la surbrillance clignoterait en
// traversant ces enfants alors qu'on est toujours au-dessus de la même case (voir échange
// avec Guillaume : elle doit rester allumée tant qu'un dépôt y placerait effectivement la
// personne). Plus fiable qu'un simple compteur d'entrées/sorties, dont l'ordre de
// déclenchement entre navigateurs n'est pas garanti dans ce cas précis.
function uiDragEnterTarget(event) {
    if (myRole !== 'host') return;
    event.currentTarget.classList.add('drag-over-target');
}

function uiDragLeaveTarget(event) {
    const el = event.currentTarget;
    if (event.relatedTarget && el.contains(event.relatedTarget)) return; // reste dans la même zone, juste passé sur un enfant
    el.classList.remove('drag-over-target');
}

// Filet de sécurité : si le glisser se termine autrement que par un dépôt valide (touche
// Échap, relâché hors de toute zone reconnue...), retire toute surbrillance encore
// affichée plutôt que de la laisser collée jusqu'au prochain rendu.
document.addEventListener('dragend', () => {
    document.querySelectorAll('.drag-over-target').forEach(el => el.classList.remove('drag-over-target'));
    draggedParticipantId = null;
    draggedFromSeat = null;
});

let draggedParticipantId = null;
// Siège d'ORIGINE précis du glissé, mémorisé explicitement au démarrage (voir échange
// avec Guillaume) — plutôt que de le retrouver après coup via SEATS.find(seatAssignment
// === draggedParticipantId), qui tombe toujours sur le PREMIER siège occupé par cette
// personne, peu importe lequel a réellement été glissé. Ça cassait le retrait d'un siège
// précis quand la même personne en occupe deux à la fois (voir uiAssignSeat, qui autorise
// maintenant cette situation) : glisser sa case Sud vers le kibbitz libérait Nord à la
// place, puisque Nord était trouvé en premier dans SEATS. `null` si le glissé vient du
// kibbitz (pas de siège d'origine).
let draggedFromSeat = null;

function uiDragStartParticipant(event, participantId, fromSeat) {
    if (myRole !== 'host') { event.preventDefault(); return; }
    draggedParticipantId = participantId;
    draggedFromSeat = fromSeat || null;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', participantId);
}

function uiAllowDrop(event) {
    if (myRole !== 'host') return;
    event.preventDefault(); // requis par l'API HTML5 drag-and-drop pour autoriser un drop ici
}

function uiDropOnSeat(event, targetSeat) {
    event.preventDefault();
    if (myRole !== 'host' || !draggedParticipantId) return;
    const sourceSeat = draggedFromSeat;
    if (sourceSeat === targetSeat) {
        draggedParticipantId = null;
        draggedFromSeat = null;
        event.currentTarget.classList.remove('drag-over-target');
        return; // déposé sur sa propre case, rien à faire
    }

    const targetOccupant = seatAssignment[targetSeat];
    seatAssignment[targetSeat] = draggedParticipantId;
    if (sourceSeat) seatAssignment[sourceSeat] = targetOccupant || null; // échange ; sinon (venait du kibbitz) l'ancien occupant cible devient kibbitz de lui-même, rien à écrire

    draggedParticipantId = null;
    draggedFromSeat = null;
    broadcastLobbyState();
    renderLobby();
}

function uiDropOnKibitz(event) {
    event.preventDefault();
    if (myRole !== 'host' || !draggedParticipantId) return;
    if (draggedFromSeat) seatAssignment[draggedFromSeat] = null;
    draggedParticipantId = null;
    draggedFromSeat = null;
    broadcastLobbyState();
    renderLobby();
}

const SEAT_CLOCKWISE_NEXT = { N: 'E', E: 'S', S: 'W', W: 'N' };

// Fait tourner l'assignation des sièges de 90° dans le sens horaire (voir échange avec
// Guillaume) : qui était à N se retrouve à E, qui était à E se retrouve à S, etc. Les
// mains restent fixées par position (N/E/S/O) — donc ça change qui joue quelle main à cet
// instant précis, pas les cartes elles-mêmes ni l'historique déjà enchéri (qui reste
// attaché aux sièges, comme au bridge réel). Volontairement utilisable à tout moment, y
// compris en pleine enchère (voir échange avec Guillaume, qui l'a explicitement demandé
// malgré le côté déroutant que ça peut avoir mi-enchère) — d'où le petit bandeau
// d'avertissement envoyé à tout le monde (voir flashSeatsRotatedToast), pour que personne
// ne découvre le changement de main en silence en plein réflexion.
function rotatedSeatAssignment(current) {
    const next = {};
    for (const seat of SEATS) {
        next[SEAT_CLOCKWISE_NEXT[seat]] = current[seat];
    }
    return next;
}

// Réservé à l'hôte (voir updateBoardControlVisibility) : applique la rotation localement,
// recalcule mySeats/autoPassSeats en conséquence, diffuse le nouvel état à tout le monde,
// puis rafraîchit l'écran actuellement affiché (jeu ou salon selon le moment).
// Voir échange avec Guillaume : bascule le mode d'enchère des robots. Purement local à
// l'hôte (voir robotBiddingMode) — pas de diffusion réseau nécessaire.
function uiSetRobotBiddingMode(passOnly) {
    if (myRole !== 'host') return;
    robotBiddingMode = passOnly ? 'passOnly' : 'smart';
    saveBoolPref('bridgeBidRobotPassOnly', passOnly);
}

function uiRotateSeatsClockwise() {
    if (myRole !== 'host') return;
    seatAssignment = rotatedSeatAssignment(seatAssignment);
    autoPassSeats = SEATS.filter(seat => !seatAssignment[seat]);
    mySeats = SEATS.filter(seat => seatAssignment[seat] === 'host');

    peerConn.send({ type: 'seats-rotated', seatAssignment, autoPassSeats });
    flashSeatsRotatedToast();

    if (deals) { renderBoard(); } else { renderLobby(); }
}

// Même mécanique de bandeau que les autres (voir flashWizzToast, uiShowCallExplanation) —
// prévient TOUT LE MONDE (hôte y compris) qu'une rotation vient d'avoir lieu, pour ne pas
// découvrir en silence qu'on joue soudain une autre main en pleine réflexion.
function flashSeatsRotatedToast() {
    let toast = document.getElementById('seatsRotatedToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'seatsRotatedToast';
        toast.className = 'call-explanation-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = '🔄 Les sièges ont tourné !';
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

function broadcastLobbyState() {
    peerConn.send({ type: 'lobby-state', participants, seatAssignment });
}

// Affiche/masque le petit bandeau de statut du transfert d'hôte, dans le salon (distinct
// de #hostSetupError, réservé aux erreurs de chargement de fichier de donnes).
function showHostTransferStatus(message, isError) {
    const el = document.getElementById('hostTransferStatus');
    if (!el) return;
    if (!message) { el.style.display = 'none'; return; }
    el.textContent = message;
    el.className = 'error-banner' + (isError ? '' : ' is-warning');
    el.style.display = 'block';
}

// Bouton unique à côté du pseudo (voir échange avec Guillaume : un seul bouton, pas un par
// participant dans la liste), qui ouvre un menu déroulant listant qui peut recevoir le
// rôle d'hôte. Visible seulement pour l'hôte, dans le salon, tant qu'au moins un autre
// participant connecté existe — sinon rien à proposer.
function renderHostTransferWidget() {
    const widget = document.getElementById('hostTransferWidget');
    if (!widget) return;

    const isHost = myRole === 'host';
    const eligible = isHost && !deals
        ? participants.filter(p => p.id !== myParticipantId && !p.disconnected)
        : [];

    if (!isHost || deals) {
        widget.style.display = 'none';
        uiCloseTransferMenu();
        return;
    }
    widget.style.display = '';

    const menu = document.getElementById('transferMenu');
    if (!menu) return;
    menu.innerHTML = eligible.length > 0
        ? eligible.map(p => `<button type="button" class="transfer-menu-item" onclick="uiTransferHost('${p.id}')">${avatarHtml(p.id)}${escapeHtml(p.name)}</button>`).join('')
        : `<div class="transfer-menu-empty">Personne d'autre pour l'instant.</div>`;
}

function uiToggleTransferMenu() {
    const menu = document.getElementById('transferMenu');
    if (!menu) return;
    if (menu.style.display === 'block') {
        uiCloseTransferMenu();
    } else {
        menu.style.display = 'block';
        // Ferme au clic ailleurs sur la page — posé au tick suivant, sinon le clic sur le
        // bouton lui-même (qui vient de déclencher cette ouverture) le refermerait aussitôt.
        setTimeout(() => document.addEventListener('click', uiTransferMenuOutsideClick), 0);
    }
}

function uiCloseTransferMenu() {
    const menu = document.getElementById('transferMenu');
    if (menu) menu.style.display = 'none';
    document.removeEventListener('click', uiTransferMenuOutsideClick);
}

function uiTransferMenuOutsideClick(event) {
    const widget = document.getElementById('hostTransferWidget');
    if (widget && !widget.contains(event.target)) uiCloseTransferMenu();
}

// Lance le transfert du rôle d'hôte vers `targetId`, un participant actuellement connecté
// (voir le menu déroulant dans renderHostTransferWidget). Ne fait que la première moitié
// du travail : envoyer à ce participant tout ce qu'il faut pour qu'il devienne hôte à son
// tour (voir 'prepare-become-host' dans handlePeerData) ; la bascule effective de l'ancien
// hôte se fait plus tard, à la réception de 'become-host-ready'.
function uiTransferHost(targetId) {
    uiCloseTransferMenu();
    if (myRole !== 'host' || deals) return; // uniquement possible dans le salon, avant le lancement
    if (hostTransferInProgress) return;

    const guestIndex = guestIndexByToken[targetId];
    const target = participants.find(p => p.id === targetId);
    if (guestIndex === undefined || !target || target.disconnected) {
        showHostTransferStatus('Ce joueur doit être connecté pour devenir hôte.', true);
        return;
    }
    if (!confirm(`Transférer le rôle d'hôte à ${target.name} ? Vous redeviendrez un simple participant, sur une nouvelle salle.`)) {
        return;
    }

    hostTransferInProgress = true;
    pendingHostTransferTarget = targetId;
    // Généré maintenant (pas seulement au moment de rejoindre la nouvelle salle) : il faut
    // que le nouvel hôte connaisse déjà ce jeton pour préparer la liste des participants et
    // les sièges AVANT même que je ne m'y reconnecte.
    pendingHostTransferOldToken = getReconnectToken();
    showHostTransferStatus(`Transfert de l'hôte à ${target.name} en cours...`, false);

    // On recalcule dès maintenant participants/seatAssignment tels qu'ils doivent apparaître
    // une fois le transfert effectif : mon entrée 'host' devient mon jeton personnel, et
    // l'entrée du participant ciblé devient 'host'. Envoyer un état déjà cohérent évite au
    // nouvel hôte d'avoir à faire lui-même cette traduction (il ne connaît pas forcément mon
    // jeton avant que je ne le lui donne ici).
    const newParticipants = participants.map(p => {
        if (p.id === 'host') return { ...p, id: pendingHostTransferOldToken };
        if (p.id === targetId) return { ...p, id: 'host' };
        return p;
    });
    const newSeatAssignment = {};
    SEATS.forEach(seat => {
        const occupant = seatAssignment[seat];
        if (occupant === 'host') newSeatAssignment[seat] = pendingHostTransferOldToken;
        else if (occupant === targetId) newSeatAssignment[seat] = 'host';
        else newSeatAssignment[seat] = occupant;
    });

    peerConn.send({ type: 'prepare-become-host', participants: newParticipants, seatAssignment: newSeatAssignment }, guestIndex);

    // Filet de sécurité : au cas où ni 'become-host-ready' ni 'become-host-failed' ni même
    // onPeerDisconnected ne se déclenchent (silence radio complet — improbable mais pas
    // impossible), on ne reste jamais bloqué plus de 20s sur "transfert en cours".
    setTimeout(() => {
        if (hostTransferInProgress && pendingHostTransferTarget === targetId) {
            hostTransferInProgress = false;
            pendingHostTransferTarget = null;
            pendingHostTransferOldToken = null;
            showHostTransferStatus('Le transfert a expiré sans réponse. Vous restez hôte, réessayez si besoin.', true);
        }
    }, 20000);
}

// ===== Démarrage de la partie (hôte) =====

// Affiche un message dans la bannière du panneau de chargement des donnes.
// `isWarning` distingue visuellement (voir .error-banner.is-warning dans styles.css) un
// avertissement non bloquant — la partie peut démarrer quand même (PARs absents, format
// de fichier ambigu) — d'une vraie erreur qui empêche de continuer (fichier illisible,
// aucun fichier choisi).
// Accepte soit un booléen (ancien usage, rétro-compatible : true=warning, false=error),
// soit une chaîne 'error'/'warning'/'success' — voir échange avec Guillaume, qui voulait
// un état "succès" en vert distinct du jaune (contraintes à revoir) et du rouge (erreur
// bloquante), pour la confirmation de génération de donnes.
function setHostSetupMessage(text, type) {
    const errorEl = document.getElementById('hostSetupError');
    const kind = type === true ? 'warning' : type === false ? 'error' : (type || 'error');
    const prefix = kind === 'warning' ? '⚠️ ' : kind === 'success' ? '✅ ' : '';
    errorEl.textContent = prefix + text;
    errorEl.classList.remove('is-warning', 'is-success');
    if (kind === 'warning') errorEl.classList.add('is-warning');
    if (kind === 'success') errorEl.classList.add('is-success');
    errorEl.style.display = 'block';
}

function clearHostSetupMessage() {
    document.getElementById('hostSetupError').style.display = 'none';
}

// Parse et valide un texte de donnes déjà en main (peu importe sa provenance — fichier
// local lu via FileReader, ou donne de la bibliothèque récupérée via fetch, voir
// readAndValidateDealFile / readAndValidateDealFromLibrary), affichant tout de suite
// l'erreur ou l'avertissement "PARs non disponibles" s'il y a lieu. `onDone` reçoit le
// tableau de donnes parsées, ou `null` si le parsing a échoué (l'erreur est alors déjà
// affichée).
function validateAndUseDealText(text, filename, onDone) {
    clearHostSetupMessage();
    const infoEl = document.getElementById('dealFileInfo');
    infoEl.style.display = 'none';

    let parsedDeals;
    try {
        parsedDeals = parseDealFile(text, filename);
    } catch (err) {
        setHostSetupMessage(err.message, false);
        onDone(null);
        return;
    }

    const n = parsedDeals.length;
    document.getElementById('dealFileInfoText').textContent =
        `✅ ${n} donne${n > 1 ? 's' : ''} chargée${n > 1 ? 's' : ''}`;
    infoEl.style.display = 'flex';

    // Avertissements non bloquants (la partie peut démarrer quand même) : format de
    // fichier ambigu (voir parseDealFile) et/ou absence de toute info de contrat optimal.
    // Deux sources indépendantes dans le PBN peuvent la fournir (voir deal-parser.js) :
    // [OptimumScore]/[OptimumContract] (résumé rapide "Par : 4♠ S (NS +420)" affiché dans
    // LA PRÉVISUALISATION uniquement — voir dealPreviewParText) et [OptimumResultTable]
    // (la table complète du double mort, affichée PENDANT LA PARTIE avec mise en évidence
    // du meilleur contrat — voir renderDDTable). Un fichier peut avoir l'un sans l'autre :
    // n'avertir que si aucun des deux n'est disponible, sinon le message serait faux pour
    // un fichier qui a la table complète mais pas le résumé rapide.
    const warnings = [];
    if (parsedDeals._formatWarning) warnings.push(parsedDeals._formatWarning);
    if (!parsedDeals.some(d => d.par || d.ddTable)) {
        warnings.push('PARs non disponibles dans ce fichier — calcul du double mort en arrière-plan, les contrats optimaux s\'afficheront en fin de donne dès qu\'ils seront prêts.');
        // Voir échange avec Guillaume : même mécanisme que pour les donnes aléatoires
        // (uiGenerateRandomDeals) — un fichier importé sans aucune info de contrat
        // optimal profite du même calcul en arrière-plan plutôt que de rester sans PAR
        // pour toute la partie. Rien à faire si le fichier a DÉJÀ cette info (le .some()
        // ci-dessus l'aurait empêché d'entrer dans cette branche).
        kickOffBackgroundDD(parsedDeals);
    }
    if (warnings.length > 0) {
        setHostSetupMessage(warnings.join('\n⚠️ '), true);
    }

    onDone(parsedDeals);
}

// Lit un fichier local (upload) puis délègue à validateAndUseDealText.
function readAndValidateDealFile(file, onDone) {
    const reader = new FileReader();
    reader.onload = () => validateAndUseDealText(reader.result, file.name, onDone);
    reader.onerror = () => {
        clearHostSetupMessage();
        setHostSetupMessage('Impossible de lire ce fichier.', false);
        onDone(null);
    };
    reader.readAsText(file);
}

// Récupère une donne de la bibliothèque du club (voir donnes/catalogue.json) puis délègue
// à validateAndUseDealText — même circuit de validation que l'upload, seule la façon
// d'obtenir le texte change.
function readAndValidateDealFromLibrary(filename, onDone) {
    fetch(`donnes/${encodeURIComponent(filename)}`)
        .then(resp => {
            if (!resp.ok) throw new Error(`Fichier introuvable dans la bibliothèque (HTTP ${resp.status}).`);
            return resp.text();
        })
        .then(text => validateAndUseDealText(text, filename, onDone))
        .catch(err => {
            clearHostSetupMessage();
            setHostSetupMessage(err.message || 'Impossible de charger cette donne depuis la bibliothèque.', false);
            onDone(null);
        });
}

// Appelé dès que l'hôte choisit (ou change) le fichier de donnes, pour parser et valider
// tout de suite — voir readAndValidateDealFile. L'hôte voit ainsi l'éventuel message
// pendant qu'il compose encore la table, et uiStartGameAsHost n'a plus qu'à réutiliser ce
// résultat (pendingParsedDeals) sans relire le fichier une seconde fois.
// Tient à jour l'affichage du nom de fichier à côté du bouton "Choisir un fichier" (voir
// échange avec Guillaume : remplace le texte natif "Aucun fichier choisi" du navigateur,
// bien plus large que nécessaire, par un affichage compact qu'on contrôle nous-mêmes).
function updateDealFileNameDisplay() {
    const display = document.getElementById('dealFileNameDisplay');
    if (!display) return;
    const fileInput = document.getElementById('dealFileInput');
    const file = fileInput && fileInput.files && fileInput.files[0];
    display.textContent = file ? file.name : 'Aucun fichier choisi';
    display.classList.toggle('has-file', !!file);
}

function uiHandleDealFileChosen() {
    const fileInput = document.getElementById('dealFileInput');
    pendingParsedDeals = null;
    pendingParsedSource = null;
    pendingOrderedDeals = null;
    updateDealFileNameDisplay();

    if (!fileInput.files || fileInput.files.length === 0) {
        clearHostSetupMessage();
        document.getElementById('dealFileInfo').style.display = 'none';
        return;
    }

    // Un fichier local et une donne de bibliothèque sont mutuellement exclusifs (une
    // seule source à la fois, pour éviter toute ambiguïté sur celle qui sera utilisée) :
    // choisir l'un désélectionne l'autre.
    const librarySelect = document.getElementById('dealLibrarySelect');
    if (librarySelect) librarySelect.value = '';

    const file = fileInput.files[0];
    readAndValidateDealFile(file, (parsedDeals) => {
        pendingParsedSource = file;
        pendingParsedDeals = parsedDeals;
        refreshPendingOrderedDeals();
    });
}

// Symétrique de uiHandleDealFileChosen, pour une donne piochée dans la bibliothèque du
// club (voir donnes/catalogue.json et initDealLibrary) plutôt qu'un fichier local.
function uiHandleDealLibraryChosen() {
    const select = document.getElementById('dealLibrarySelect');
    const filename = select ? select.value : '';
    pendingParsedDeals = null;
    pendingParsedSource = null;
    pendingOrderedDeals = null;

    if (!filename) {
        clearHostSetupMessage();
        document.getElementById('dealFileInfo').style.display = 'none';
        return;
    }

    // Réciproquement, choisir dans la bibliothèque désélectionne le fichier local.
    const fileInput = document.getElementById('dealFileInput');
    if (fileInput) fileInput.value = '';
    updateDealFileNameDisplay();

    readAndValidateDealFromLibrary(filename, (parsedDeals) => {
        pendingParsedSource = `library:${filename}`;
        pendingParsedDeals = parsedDeals;
        refreshPendingOrderedDeals();
    });
}

// ===== Aperçu des donnes chargées (avant de lancer la partie) =====

function uiPreviewDeals() {
    if (!pendingOrderedDeals || pendingOrderedDeals.length === 0) return;
    renderDealPreview(pendingOrderedDeals);
    document.getElementById('dealPreviewModal').style.display = 'flex';
}

function uiCloseDealPreview() {
    document.getElementById('dealPreviewModal').style.display = 'none';
}

function uiCloseDealPreviewOnBackdrop(evt) {
    if (evt.target.id === 'dealPreviewModal') uiCloseDealPreview();
}

// Petite carte de main compacte pour l'aperçu (même principe que renderMyHands /
// renderAllHandsDiagram, mais toujours avec le HCP affiché, indépendamment de la
// préférence showHcp qui ne concerne que l'écran de jeu).
function dealPreviewHandCardHtml(seat, hand) {
    const lines = ['S', 'H', 'D', 'C'].map(suit => `
        <div class="card-line">
            <span class="suit-symbol">${suitIconHtml(suit)}</span>
            <span class="cards">${formatRanksForDisplay(hand[suit]) || '—'}</span>
        </div>
    `).join('');

    return `
        <div class="hand-card deal-preview-hand-card">
            <div class="hand-card-title">
                <span class="hand-card-title-name">${SEAT_FULL_NAME[seat]}</span>
                <span class="hand-card-badges"><span class="hand-hcp-badge">${computeHandHcp(hand)} HCP</span></span>
            </div>
            <div class="hand-cards">${lines}</div>
        </div>
    `;
}

function dealPreviewParText(par) {
    if (!par) return '';
    const contract = par.contract ? `${par.contract}${par.declarer ? ' ' + par.declarer : ''}` : '?';
    const scoreSign = par.score > 0 ? '+' : '';
    return ` · Par : ${contract} (${par.side} ${scoreSign}${par.score})`;
}

function renderDealPreview(dealsToPreview) {
    const n = dealsToPreview.length;
    document.getElementById('dealPreviewTitle').textContent = `Aperçu — ${n} donne${n > 1 ? 's' : ''}`;

    const content = document.getElementById('dealPreviewContent');
    content.innerHTML = dealsToPreview.map(deal => `
        <div class="deal-preview-board">
            <div class="deal-preview-board-header">
                <strong>Donne #${deal.board}</strong> — Donneur : ${SEAT_FULL_NAME[deal.dealer]} · ${VULN_LABEL[deal.vulnerable]}${dealPreviewParText(deal.par)}
            </div>
            <div class="deal-preview-hands">
                ${SEATS.map(seat => dealPreviewHandCardHtml(seat, deal.hands[seat])).join('')}
            </div>
        </div>
    `).join('');
}

function uiStartGameAsHost() {
    const fileInput = document.getElementById('dealFileInput');
    const librarySelect = document.getElementById('dealLibrarySelect');
    const file = (fileInput.files && fileInput.files[0]) || null;
    const libraryFilename = librarySelect ? librarySelect.value : '';
    // Voir uiGenerateRandomDeals : une troisième source, au même niveau que le fichier et
    // la bibliothèque — déjà entièrement parsée en mémoire (pas de lecture asynchrone à
    // refaire, contrairement aux deux autres), donc toujours "à jour" tant que
    // pendingParsedSource vaut 'random'.
    const hasRandomDeals = pendingParsedSource === 'random' && !!pendingParsedDeals;

    if (!file && !libraryFilename && !hasRandomDeals) {
        setHostSetupMessage('Choisissez un fichier .pbn ou .lin, une donne dans la bibliothèque, ou générez des donnes aléatoires.', false);
        return;
    }

    // Reçoit les donnes déjà dans l'ordre à utiliser pour jouer (mélangé ou non, voir
    // pendingOrderedDeals / refreshPendingOrderedDeals) — jamais l'ordre brut du fichier.
    const proceedWithDeals = (orderedDeals) => {
        if (!orderedDeals) return; // l'erreur est déjà affichée par readAndValidateDealFile/readAndValidateDealFromLibrary

        deals = orderedDeals;
        boardIndex = 0;
        if (!deals[0].auctionHistory) deals[0].auctionHistory = [];
        auctionHistory = deals[0].auctionHistory;
        hostPendingUndo = null;
        clearUndoUiState();

        const botSeats = SEATS.filter(seat => !seatAssignment[seat]);
        mySeats = SEATS.filter(seat => seatAssignment[seat] === 'host');
        autoPassSeats = botSeats;

        participants.filter(p => p.id !== 'host' && !p.disconnected).forEach(p => {
            const guestIndex = guestIndexForParticipant(p.id);
            if (guestIndex == null) return;
            const seatsForThisGuest = SEATS.filter(seat => seatAssignment[seat] === p.id);
            peerConn.send({ type: 'start-game', deals, yourSeats: seatsForThisGuest, botSeats }, guestIndex);
        });

        enterGameScreen();
    };

    // Source effectivement active : le fichier local prime sur la bibliothèque si les deux
    // sont, par un hasard quelconque, renseignés à la fois (ne devrait pas arriver, voir
    // uiHandleDealFileChosen/uiHandleDealLibraryChosen qui désélectionnent l'autre à
    // chaque choix, mais on tranche explicitement plutôt que de laisser un cas ambigu) ;
    // "random", lui, ne peut être actif que si aucun des deux ne l'est (voir
    // uiGenerateRandomDeals, qui les désélectionne tous les deux).
    const activeSource = hasRandomDeals ? 'random' : (file || `library:${libraryFilename}`);

    // Cas normal : la source a déjà été lue et parsée au moment où elle a été choisie
    // (voir uiHandleDealFileChosen / uiHandleDealLibraryChosen / uiGenerateRandomDeals) —
    // pas besoin de la relire, et le message éventuel (erreur ou avertissement PAR) est
    // déjà affiché depuis ce moment-là.
    if (pendingParsedSource === activeSource) {
        proceedWithDeals(pendingOrderedDeals);
        return;
    }

    // Filet de sécurité si, pour une raison quelconque, le cache ne correspond pas à la
    // source actuellement sélectionnée (ex. écouteur 'change' non déclenché) : on relit,
    // puis on applique l'ordre aléatoire éventuel avant de démarrer. Ne concerne jamais
    // "random" (déjà entièrement en mémoire dès sa génération, jamais besoin d'une
    // relecture asynchrone) : rien à faire ici dans ce cas, la branche ci-dessus l'aura
    // déjà traité.
    const onReloaded = (parsedDeals) => {
        pendingParsedSource = activeSource;
        pendingParsedDeals = parsedDeals;
        refreshPendingOrderedDeals();
        proceedWithDeals(pendingOrderedDeals);
    };
    if (file) {
        readAndValidateDealFile(file, onReloaded);
    } else {
        readAndValidateDealFromLibrary(libraryFilename, onReloaded);
    }
}

// ===== Réception des messages des autres joueurs =====

function handlePeerData(msg, guestIndex) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
        case 'welcome': {
            myParticipantId = msg.yourId;
            break;
        }

        // Reçu par le participant CIBLÉ par un transfert d'hôte (voir uiTransferHost) : il
        // doit créer sa propre salle (nouveau code, PeerJS ne permet pas de reprendre
        // fiablement l'ancien identifiant tout de suite) puis prévenir l'ancien hôte dès que
        // c'est prêt — c'est par CETTE connexion, celle qui reçoit ce message, qu'on le
        // préviendra, donc on ne la coupe qu'une fois le nouveau code obtenu et transmis.
        case 'prepare-become-host': {
            if (myRole !== 'guest') break;
            pushDebugLog('Transfert d\'hôte reçu, création de la nouvelle salle...');

            const inheritedParticipants = msg.participants;
            const inheritedSeatAssignment = msg.seatAssignment;
            // Gardée dans une variable locale plutôt que relue depuis la globale `peerConn`
            // plus bas : voir le commentaire juste après sur la bascule immédiate de l'état.
            const oldPeerConn = peerConn;

            const claimPeer = new BridgePeerConnection(buildHostHandlers((newRoomCode) => {
                // BASCULE IMMÉDIATE ET SYNCHRONE de tout l'état global, avant même de
                // prévenir l'ancien hôte. Sans ça (l'ancienne version attendait 300ms avant
                // de le faire) : `claimPeer` accepte déjà des connexions entrantes dès son
                // ouverture (le gestionnaire 'connection' de peer-connection.js est posé dès
                // la création), donc toute connexion arrivant pendant ces 300ms déclenchait
                // les handlers de buildHostHandlers alors qu'ils référençaient encore
                // l'ANCIEN état (peerConn pointant vers l'ancienne connexion, participants
                // pas encore hérités) — c'est très probablement ce qui causait les
                // déconnexions observées pendant un transfert (voir échange avec Guillaume).
                peerConn = claimPeer;
                myRole = 'host';
                myParticipantId = 'host';
                participants = inheritedParticipants;
                seatAssignment = inheritedSeatAssignment;
                guestIndexByToken = {};
                prevSeatAssignmentSnapshot = null;
                prevParticipantsDisconnectedSnapshot = null;
                lobbyChatAutoOpened = false;
                enterLobbyScreen();
                renderLobby();

                // Prévenir l'ancien hôte APRÈS la bascule locale (peu importe l'ordre réel
                // de réception chez lui, ça n'a plus d'incidence) puis fermer l'ancienne
                // connexion avec un court délai, pour laisser le message le temps de partir
                // sur le canal WebRTC avant de la couper.
                if (oldPeerConn) oldPeerConn.send({ type: 'become-host-ready', newRoomCode });
                setTimeout(() => { if (oldPeerConn) oldPeerConn.destroy(); }, 300);
            }));
            // Repli propre si la création de la nouvelle salle échoue (réseau, etc.) :
            // prévenir l'ancien hôte plutôt que de le laisser attendre indéfiniment, sans
            // toucher à quoi que ce soit côté local (on reste un invité normal, connecté
            // comme avant à l'ancien hôte).
            claimPeer.handlers.onError = (err) => {
                pushDebugLog('Échec de la prise de rôle hôte : ' + ((err && (err.message || err.type)) || err));
                if (oldPeerConn) oldPeerConn.send({ type: 'become-host-failed', reason: (err && err.type) || 'erreur inconnue' });
            };
            claimPeer.createRoom();
            break;
        }

        // Reçu par l'ANCIEN hôte : le participant ciblé a bien créé sa nouvelle salle. On
        // prévient tous les autres invités connectés (pas lui, il le sait déjà), puis on
        // rejoint nous-mêmes cette nouvelle salle comme simple participant.
        case 'become-host-ready': {
            if (myRole !== 'host' || !hostTransferInProgress) break;
            const newRoomCode = msg.newRoomCode;
            const targetIndex = guestIndexByToken[pendingHostTransferTarget];
            peerConn.sendExcept({ type: 'host-transferred', newRoomCode }, targetIndex);

            const myOldToken = pendingHostTransferOldToken;
            const myName = savedNickname;
            hostTransferInProgress = false;
            pendingHostTransferTarget = null;
            pendingHostTransferOldToken = null;
            showHostTransferStatus(null);

            connectAsGuest(newRoomCode, myOldToken, myName);
            break;
        }

        // Reçu par l'ANCIEN hôte : le transfert a échoué chez le participant ciblé (voir
        // 'prepare-become-host' ci-dessus) — on reste hôte, rien d'autre à faire.
        case 'become-host-failed': {
            if (myRole !== 'host' || !hostTransferInProgress) break;
            hostTransferInProgress = false;
            pendingHostTransferTarget = null;
            pendingHostTransferOldToken = null;
            showHostTransferStatus("Le transfert a échoué (" + (msg.reason || 'raison inconnue') + "). Vous restez hôte.", true);
            break;
        }

        // Reçu par tout invité qui n'était NI la cible du transfert (déjà géré dans
        // 'prepare-become-host') NI l'ancien hôte (déjà géré dans 'become-host-ready') :
        // on rejoint simplement la nouvelle salle avec son propre jeton, comme un join normal.
        case 'host-transferred': {
            if (myRole !== 'guest') break;
            pushDebugLog('Hôte transféré, on rejoint la nouvelle salle ' + msg.newRoomCode);
            connectAsGuest(msg.newRoomCode, getReconnectToken(), savedNickname);
            break;
        }

        case 'set-name': {
            if (myRole !== 'host') return;
            const pid = tokenForGuestIndex(guestIndex);
            const p = participants.find(x => x.id === pid);
            if (p) p.name = msg.name || p.name;
            broadcastLobbyState();
            renderLobby();
            break;
        }

        case 'lobby-state': {
            const newParticipants = msg.participants;
            // Détecte les reconnexions (disconnected true -> false) pour la bannière de
            // bienvenue transitoire (voir flashWelcomeBack). Un diff est nécessaire ici,
            // contrairement au côté hôte qui connaît déjà l'événement précis au moment où
            // il se produit (voir onGuestConnected) : ce message ne porte qu'un instantané,
            // pas la nature du changement.
            if (deals && prevParticipantsDisconnectedSnapshot) {
                newParticipants.forEach(p => {
                    if (prevParticipantsDisconnectedSnapshot[p.id] && !p.disconnected) {
                        flashWelcomeBack(p.name);
                    }
                });
            }
            prevParticipantsDisconnectedSnapshot = {};
            newParticipants.forEach(p => { prevParticipantsDisconnectedSnapshot[p.id] = !!p.disconnected; });

            participants = newParticipants;
            seatAssignment = msg.seatAssignment;
            // Ce message est aussi renvoyé quand la connectivité change en pleine partie
            // (quelqu'un se (re)connecte) : on ne bascule à l'écran du salon que si la
            // partie n'a pas encore commencé, sinon ça arracherait un invité de sa table.
            // Dans le cas contraire (partie en cours), on doit quand même rafraîchir
            // l'écran de jeu — sans ça, la bannière de reconnexion et le tour-indicateur
            // resteraient figés jusqu'à la prochaine annonce.
            if (myRole === 'guest' && !deals) enterLobbyScreen();
            else if (deals) renderBoard();
            break;
        }

        // Diffusé par l'hôte (voir uiRotateSeatsClockwise) : recalcule ma propre place à
        // la table à partir de la nouvelle assignation, puis rafraîchit l'écran actuel.
        case 'seats-rotated': {
            seatAssignment = msg.seatAssignment;
            autoPassSeats = msg.autoPassSeats || [];
            mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);
            flashSeatsRotatedToast();
            if (deals) renderBoard();
            else if (myRole === 'guest') enterLobbyScreen();
            break;
        }

        case 'start-game': {
            deals = msg.deals;
            mySeats = msg.yourSeats;
            autoPassSeats = msg.botSeats || [];
            boardIndex = 0;
            if (!deals[0].auctionHistory) deals[0].auctionHistory = [];
            auctionHistory = deals[0].auctionHistory;
            hostPendingUndo = null;
            clearUndoUiState();
            enterGameScreen();
            break;
        }

        // Reçu après une (re)connexion alors que la partie est déjà en cours : remet ce
        // joueur exactement là où en est la table (donne, enchère, sièges), qu'il soit
        // nouveau ou de retour après une coupure.
        case 'resync': {
            deals = msg.deals;
            mySeats = msg.yourSeats;
            autoPassSeats = msg.botSeats || [];
            boardIndex = msg.boardIndex;
            auctionHistory = msg.auctionHistory || [];
            deals[boardIndex].auctionHistory = auctionHistory; // voir gotoBoard : reste la référence partagée à partir de maintenant
            hostPendingUndo = null;
            clearUndoUiState();
            enterGameScreen();
            break;
        }

        case 'call': {
            if (!deals || msg.boardIndex !== boardIndex) return;
            const deal = currentDeal();
            const expectedSeat = currentTurnSeat(deal.dealer, auctionHistory);
            if (msg.seat !== expectedSeat || !isCallLegal(auctionHistory, msg.call, msg.seat)) {
                console.warn('Annonce reçue invalide, ignorée :', msg);
                return;
            }
            applyCall(msg.seat, msg.call, msg.explanation);
            relayIfHost(msg, guestIndex);
            break;
        }

        case 'chat': {
            addChatMessage(msg);
            relayIfHost(msg, guestIndex);
            break;
        }

        // Voir échange avec Guillaume : le "wizz" façon MSN Messenger. Contrairement au
        // chat (diffusé à tout le monde), un wizz est ciblé — relayIfHost ne convient pas
        // ici puisqu'il diffuserait à TOUS les autres invités, pas seulement au bon. Un
        // hôte qui reçoit un wizz qui n'est pas pour lui le retransmet spécifiquement au
        // bon invité (topologie en étoile : c'est le seul chemin possible entre deux
        // invités) ; un invité, lui, ne reçoit jamais un wizz qui ne lui est pas destiné
        // (l'hôte a déjà fait ce tri avant de relayer), donc l'applique directement.
        case 'wizz': {
            if (myRole === 'host' && msg.targetId !== 'host') {
                const targetGuestIndex = guestIndexByToken[msg.targetId];
                if (targetGuestIndex !== undefined) peerConn.send(msg, targetGuestIndex);
                break;
            }
            triggerWizzEffect();
            break;
        }

        // Résultat de double mort arrivé APRÈS le lancement de la partie (voir
        // applyDDResultToBoard côté hôte, qui envoie ce message) — un invité n'a reçu
        // qu'un instantané figé des donnes via 'start-game', donc ce relais est le seul
        // moyen pour lui de recevoir un PAR calculé après coup.
        case 'dd-result': {
            if (!deals) break;
            const idx = deals.findIndex(d => d.board === msg.boardNumber);
            if (idx === -1) break;
            deals[idx].ddTable = msg.table;
            if (idx === boardIndex && isAuctionOver(auctionHistory)) checkAuctionEnd();
            break;
        }

        case 'reset-auction': {
            if (!deals || msg.boardIndex !== boardIndex) return;
            auctionHistory = [];
            deals[boardIndex].auctionHistory = auctionHistory; // reste la référence partagée
            hostPendingUndo = null;
            clearUndoUiState();
            renderAuctionLedger();
            renderBiddingBox();
            renderMyHands();
            checkAuctionEnd();
            relayIfHost(msg, guestIndex);
            maybeRobotBid(); // sans effet si on n'est pas l'hôte ; couvre le cas où c'est
                              // un invité qui a demandé le reset (l'hôte doit prendre le relais)
            break;
        }

        case 'goto-board': {
            if (!deals) return;
            boardIndex = msg.boardIndex;
            // Voir gotoBoard (fonction miroir côté hôte) : restaure l'historique déjà
            // vécu sur cette donne plutôt que de toujours repartir de zéro.
            if (!deals[boardIndex].auctionHistory) deals[boardIndex].auctionHistory = [];
            auctionHistory = deals[boardIndex].auctionHistory;
            hostPendingUndo = null;
            clearUndoUiState();
            renderBoard();
            relayIfHost(msg, guestIndex);
            break;
        }

        // --- Demande d'annulation (undo) ---
        // Voir la section "Demande d'annulation (undo)" plus bas pour le détail du protocole.
        // L'hôte est toujours l'arbitre : 'undo-request' et 'undo-answer' ne sont traités
        // que par lui ; 'undo-ask', 'undo-apply' et 'undo-rejected' sont ce qu'il diffuse.
        case 'undo-request': {
            if (myRole !== 'host') return;
            hostHandleUndoRequest(msg);
            break;
        }

        case 'undo-ask': {
            pendingUndoAsk = msg;
            renderUndoAskBanner();
            renderUndoControls();
            break;
        }

        case 'undo-answer': {
            if (myRole !== 'host') return;
            hostReceiveUndoAnswer(msg);
            break;
        }

        case 'undo-apply': {
            if (!deals || msg.boardIndex !== boardIndex) return;
            if (typeof msg.newLength === 'number') {
                auctionHistory.length = Math.max(0, Math.min(msg.newLength, auctionHistory.length));
            } else if (auctionHistory.length > 0) {
                auctionHistory.pop(); // compat, ne devrait plus arriver
            }
            renderAuctionLedger();
            renderBiddingBox();
            renderMyHands();
            checkAuctionEnd();
            clearUndoUiState();
            break;
        }

        case 'undo-rejected': {
            if (msg.requesterId !== myParticipantId) return;
            clearUndoUiState();
            setUndoStatus(undoRejectReasonText(msg.reason));
            break;
        }
    }
}

// Quand l'hôte reçoit un message d'un invité, il le relaie aux AUTRES invités (les invités
// ne sont jamais connectés entre eux). Ne fait rien de plus en configuration à 2 joueurs.
function relayIfHost(msg, fromGuestIndex) {
    if (myRole === 'host') {
        peerConn.sendExcept(msg, fromGuestIndex);
    }
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
function computeHandHL(hand) {
    const lengths = suitLengths(hand);
    let lengthPoints = 0;
    for (const suit of ['S', 'H', 'D', 'C']) {
        if (lengths[suit] >= 5) lengthPoints += lengths[suit] - 4;
    }
    return computeHandHcp(hand) + lengthPoints;
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
// Seuils repris de la fiche "Ouvertures" du SEF (voir échange avec Guillaume), simplifiée
// pour l'essentiel — sans 2♣ fort indéterminé ni 2♦ forcing de manche (main exceptionnelle
// hors barème, laissée à une ouverture au palier 1 par défaut, faute d'implémenter tout un
// système de relais pour une main sur plusieurs centaines).
function decideRobotOpening(hand, hcp, hl, dealVulnerable, seat) {
    const lengths = suitLengths(hand);
    const balanced = isHandBalancedForNT(lengths);

    // 1SA : exception SEF explicite, on compte ici en H purs, pas en HL.
    if (hcp >= 15 && hcp <= 17 && balanced) return '1NT';
    // 2SA : 20-21HL, main régulière (ni 5 cartes à une majeure, sauf couleur "laide" —
    // nuance non reprise ici par simplicité).
    if (hl >= 20 && hl <= 21 && balanced) return '2NT';

    // 2♣ fort artificiel (forcing) : main régulière 22-23HL, au-delà de la fourchette du
    // 2SA direct (voir échange avec Guillaume, donne 4) — un "super 2SA" annoncé en deux
    // temps (2♣ puis 2SA au rebid, voir decideRobotOpenerRebid) plutôt qu'un 2SA direct
    // qui plafonnerait à tort la main à 20-21. Volontairement borné à CE seul cas (main
    // RÉGULIÈRE) : un 2♣ fort avec une main irrégulière nécessiterait tout un système de
    // relais/réponses par couleur, hors de portée ici (voir "Limites connues" du README).
    if (hl >= 22 && hl <= 23 && balanced) return '2C';

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

    // 11-12 HLD avec fit 4+ cartes : soutien au palier 3, non-forcing.
    if (supportPoints >= 11 && supportPoints <= 12 && fitLen >= 4) {
        const call = (bid.level + 2) + suit;
        if (isCallLegal(history, call, seat)) return call;
    }

    // 11-12 HLD avec fit EXACTEMENT 3 cartes : 2SA conventionnel (ne promet pas une main
    // régulière, juste ce fit précis et cette fourchette de points).
    if (supportPoints >= 11 && supportPoints <= 12 && fitLen === 3) {
        const call = '2NT';
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
function decideRobotResponse(hand, hcp, hl, partnerCall, seat, history, partnerPromises5Plus, partnerWasIntervening) {
    const lengths = suitLengths(hand);
    const bid = parseBid(partnerCall);

    // Réponse au 2♣ fort artificiel (voir échange avec Guillaume, donne 4) : "2C" comme
    // OUVERTURE ne peut venir que de ce cas dans notre moteur — un barrage à la mineure
    // ne descend jamais au palier 2 (voir decideRobotOpening, seule une majeure 6ème
    // ouvre de "2 faible"), donc pas d'ambiguïté possible ici. Relais d'attente
    // systématique en 2♦, quelle que soit la main — pas de "réponse positive" par
    // couleur, volontairement hors périmètre (voir la même limite sur l'ouverture
    // elle-même).
    if (partnerCall === '2C') {
        const call = '2D';
        if (isCallLegal(history, call, seat)) return call;
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
        const fiveCardMajor = ['S', 'H'].find(s => lengths[s] >= 5);
        if (fiveCardMajor) {
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
    const major4 = partnerOpenedMinor ? ['H', 'S'].find(s => lengths[s] >= 4) : null;
    const longerSuit = hcp >= 12 && major4
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
    // longue" mais bien NETTEMENT meilleure. Priorité de LONGUEUR, pas de points (qu'on
    // ait 8H ou 15H) — pas de seuil de points comme "longerSuit".
    const ownLongSuit = ['S', 'H', 'D', 'C'].find(s => s !== suit && lengths[s] >= 5 && lengths[s] >= lengths[suit] + 2);
    if (ownLongSuit) {
        for (let level = bid.level; level <= 7; level++) {
            const call = level + ownLongSuit;
            if (isCallLegal(history, call, seat)) return call;
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
    } else if ((suit === 'S' || suit === 'H') && bid.level >= 2 && lengths[suit] >= 3) {
        const call = (bid.level + 1) + suit;
        if (isCallLegal(history, call, seat)) return call;
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
    if (suit === 'H' && lengths['S'] >= 4 && hl >= 6) {
        const call = bid.level + 'S';
        if (isCallLegal(history, call, seat)) return call;
    }

    // Soutien à une MINEURE : un fit, c'est 8 cartes à eux deux (voir échange avec
    // Guillaume — 5+3, pas 5+2), donc 3+ cartes. Le seuil de points utilise les points de
    // "soutien" (voir computeSupportPoints — H + 9ème atout + distribution, pas juste HL)
    // puisque la longueur du partenaire est désormais connue (5+ via une intervention,
    // 3+ par défaut pour une ouverture à la mineure, qui peut ne pas en avoir plus).
    //
    // Exception "1SA poubelle" (voir échange avec Guillaume, donne 3) : avec une main
    // PLATE et un fit d'EXACTEMENT 3 cartes à une mineure qui n'a jamais promis 5+ (donc
    // jamais via une intervention, seulement une ouverture), s'engager dans ce fit
    // marginal vaut moins qu'un simple 1SA naturel — surtout au palier 1, où 1SA coûte la
    // même chose. Ne s'applique pas avec 4+ cartes (fit plus solide, vaut la peine d'être
    // montré) ni sur une main irrégulière (une distribution à exploiter ailleurs).
    const partnerGuaranteedLength = partnerPromises5Plus ? 5 : 3;
    const supportPoints = computeSupportPoints(hand, suit, partnerGuaranteedLength);
    const flatWithMarginalMinorFit = !partnerPromises5Plus && lengths[suit] === 3
        && isHandBalancedForNT(lengths) && bid.level === 1;
    if (lengths[suit] >= 3 && supportPoints >= 6 && !flatWithMarginalMinorFit) {
        const raiseLevel = bid.level + (supportPoints >= 10 ? 2 : 1);
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
    // n'a que le minimum de sa fourchette de barrage (13+12=25).
    const newSuitThreshold = (bid.level >= 2 || partnerWasIntervening) ? 13 : 11;
    if (hl >= newSuitThreshold) {
        const newSuit = longestSuitPreferHigh(lengths);
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
function decideRobotIntervention(hand, hcp, hl, seat, history, dealVulnerable) {
    const lengths = suitLengths(hand);
    const lastBid = getLastActualBid(history); // l'enchère adverse à laquelle on réagit

    // "Contre toute distribution" (voir échange avec Guillaume, donne 2) : à partir de
    // 19HL+, on contre d'abord, quelle que soit la distribution — même avec une belle
    // couleur personnelle qu'on aurait pu montrer directement — pour annoncer une force
    // que ni un contre d'appel normal ni une intervention naturelle directe ne
    // représenteraient correctement. La vraie couleur se montre ensuite, au tour suivant
    // (voir decideDoublerFollowUp), une fois cette force acquise pour le partenaire.
    // Priorité absolue, avant même le contre d'appel normal ci-dessous.
    if (lastBid) {
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
    if (lastBid) {
        const oppBid = parseBid(lastBid.call);
        const hasLongSuit = ['S', 'H', 'D', 'C'].some(s => lengths[s] >= 6);
        const hasFiveCardMajor = ['S', 'H'].some(s => lengths[s] >= 5);
        if (oppBid && oppBid.strain !== 'NT' && hl >= 12 && lengths[oppBid.strain] <= 2 && !hasLongSuit && !hasFiveCardMajor) {
            const otherSuits = ['S', 'H', 'D', 'C'].filter(s => s !== oppBid.strain);
            const has4Count = otherSuits.filter(s => lengths[s] >= 4).length;
            const allAtLeast3 = otherSuits.every(s => lengths[s] >= 3);
            if (allAtLeast3 || has4Count >= 2) {
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
    const hasOtherFourCardSuit = ['S', 'H', 'D', 'C'].some(s => s !== suit && lengths[s] >= 4);
    if ((suit === 'S' || suit === 'H') && hl <= 12 && lengths[suit] >= 6 && !hasOtherFourCardSuit) {
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

    // Voir échange avec Guillaume : une intervention forcée au palier 2 (ou plus, ex.
    // après plusieurs enchères adverses) exige davantage qu'au palier 1 — 12H en H purs
    // (pas HL) et une couleur plus longue (6+ cartes) — sinon on s'abstient plutôt que de
    // s'engager trop haut sur une main ou une couleur insuffisante.
    if (chosenLevel >= 2 && (hcp < 12 || lengths[suit] < 6)) return 'PASS';

    return chosenLevel + suit;
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
    // chelem générique plus bas (qui suppose une ouverture normale à 12H minimum) : ici
    // c'est une vraie question du partenaire, pas un simple compte de points de ma part.
    if (partnerRebidCall === '4NT') {
        if (hcp >= 9) {
            const call = '6NT';
            if (isCallLegal(history, call, seat)) return call;
        }
        return 'PASS';
    }

    // Chelem par simple compte de points (voir échange avec Guillaume, donne 6) : pas de
    // véritable enchère de contrôle (cue-bids, Blackwood — hors périmètre, voir le
    // README), mais un déclenchement borné et sûr — si MES points (HL) combinés au
    // MINIMUM garanti par l'ouverture du partenaire (12, quelle que soit la couleur
    // ouverte) atteignent 33+ (zone de petit chelem), on saute directement à 6SA plutôt
    // que de s'arrêter à la manche. Un excès de matériel aussi manifeste ne doit pas
    // rester ignoré juste parce qu'on ne fait pas de vraie enchère de contrôle.
    if (hl + 12 >= 33) {
        const call = '6NT';
        if (isCallLegal(history, call, seat)) return call;
    }

    if (rebid.strain !== 'NT') {
        const openingIsMajor = openingBid.strain === 'S' || openingBid.strain === 'H';
        const rebidIsMajor = rebid.strain === 'S' || rebid.strain === 'H';

        // Vise directement la MANCHE (palier 4) une fois le fit identifié — pas juste le
        // palier minimal légal au-dessus du rebid du partenaire (bug trouvé à l'audit,
        // donne 7 : atterrissait sur un simple "3H" alors que la zone de manche est déjà
        // connue par construction, voir le déclencheur dans decideRobotCall). Repli sur
        // le palier minimal légal seulement si le palier 4 lui-même n'est plus
        // disponible (enchère déjà montée plus haut, cas rare).
        if (openingIsMajor && lengths[openingBid.strain] + 5 >= 8) {
            for (let level = Math.max(4, rebid.level); level <= 7; level++) {
                const call = level + openingBid.strain;
                if (isCallLegal(history, call, seat)) return call;
            }
        }
        if (rebidIsMajor && rebid.strain !== myResponseBid.strain && lengths[rebid.strain] + 4 >= 8) {
            for (let level = Math.max(4, rebid.level); level <= 7; level++) {
                const call = level + rebid.strain;
                if (isCallLegal(history, call, seat)) return call;
            }
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
function decideDoublerFollowUp(hand, hcp, hl, partnerResponseCall, seat, history) {
    const lengths = suitLengths(hand);
    const responseBid = parseBid(partnerResponseCall);
    if (!responseBid) return 'PASS'; // partenaire qui a lui-même contré/passé à ce stade : hors périmètre, filet de sécurité

    // Suite du "contre toute distribution" (voir échange avec Guillaume, donne 2, et
    // decideRobotIntervention) : avec 19HL+, mon contre initial n'était pas un simple
    // contre d'appel classique mais une annonce de force — je montre maintenant ma vraie
    // couleur naturellement (au palier minimal légal, pas de saut — la force est déjà
    // annoncée par la séquence elle-même), plutôt que de pousser la couleur choisie par
    // le partenaire, qui ne connaît pas encore ma vraie main. Priorité sur la logique
    // normale ci-dessous, pensée pour un contre d'appel standard (12-18HL).
    if (hl >= 19) {
        const suit = longestSuitPreferHigh(lengths);
        for (let level = responseBid.level; level <= 7; level++) {
            const call = level + suit;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    if (hcp >= 15 && lengths[responseBid.strain] >= 3) {
        const isMajor = responseBid.strain === 'S' || responseBid.strain === 'H';
        const gameLevel = isMajor ? 4 : 5;
        for (let level = Math.max(gameLevel, responseBid.level); level <= 7; level++) {
            const call = level + responseBid.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
    }
    return 'PASS';
}

function decideRobotResponseToDouble(hand, hcp, hl, doubleIndex, seat, history) {
    const lengths = suitLengths(hand);
    let doubledSuit = null;
    for (let i = doubleIndex - 1; i >= 0; i--) {
        if (isBidCall(history[i].call)) { doubledSuit = parseBid(history[i].call).strain; break; }
    }
    if (!doubledSuit || doubledSuit === 'NT') return 'PASS'; // sécurité, ne devrait pas arriver

    const candidates = ['S', 'H', 'D', 'C'].filter(s => s !== doubledSuit);
    const bestSuit = candidates.reduce((best, s) => (lengths[s] > lengths[best] ? s : best), candidates[0]);

    // Voir échange avec Guillaume (donne 2, session du 23 juillet) : plus de "passe de
    // pénalité" ici. Les bots traitent tous les contres comme des contres d'appel — jamais
    // punitifs, trop subtil à modéliser correctement — donc on ne laisse jamais filer le
    // contre du partenaire, quel que soit le nombre de points : on répond toujours dans
    // l'une des couleurs non contrées (ancienne règle : 13H+ passait pour la défense,
    // supprimée par cohérence).

    // Points de soutien (voir échange avec Guillaume, donne 4 : main de 8H comptée à 10
    // avec la courte) plutôt que HL brut — le contre du partenaire ne garantit pas de
    // longueur précise dans la couleur choisie, on prend 3 cartes comme minimum par
    // défaut (cohérent avec le reste du moteur pour une ouverture à la mineure).
    const supportPoints = computeSupportPoints(hand, bestSuit, 3);
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
    if (lengths[partnerParsed.strain] >= 4) {
        const fitSuit = partnerParsed.strain;
        const isMajorFit = fitSuit === 'S' || fitSuit === 'H';
        let targetLevel = partnerParsed.level;
        if (hcp >= 18) targetLevel = isMajorFit ? 4 : 5;
        else if (hcp >= 15) targetLevel = 3;

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
    const candidates = ['S', 'H', 'D', 'C'].filter(s => s !== myBid.strain && s !== partnerParsed.strain && lengths[s] >= 4);
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

    if (lengths[partnerParsed.strain] >= 3 && hl >= 11) {
        const gameLevel = (partnerParsed.strain === 'S' || partnerParsed.strain === 'H') ? 4 : 5;
        for (let level = Math.max(gameLevel, partnerParsed.level); level <= 7; level++) {
            const call = level + partnerParsed.strain;
            if (isCallLegal(history, call, seat)) return call;
        }
    }

    for (let level = partnerParsed.level; level <= 7; level++) {
        const call = level + myBid.strain;
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

        return 'PASS'; // aucune demande reconnue : rien d'autre géré ici (1SA/2SA déjà bien décrits par ailleurs)
    }

    // Rebid après un 2♣ fort artificiel (voir échange avec Guillaume, donne 4) : "2SA"
    // pour préciser 22-23HL équilibrée, quelle que soit la réponse relais du partenaire
    // (toujours "2D", voir decideRobotResponse) — placé AVANT la branche barrage/2 faible
    // plus bas, qui l'intercepterait sinon à tort (même forme générique : palier 2+,
    // réponse en couleur différente).
    if (myOpeningCall === '2C') {
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

    // Loi des atouts (voir échange avec Guillaume, donne 4) : 6+ cartes dans SA propre
    // couleur, soutenue par le partenaire (3+ cartes garanties par son enchère, voir
    // decideRobotMajorSupport / le soutien mineur plus haut) → fit connu de 9+ cartes, qui
    // suffit à repousser d'un palier indépendamment des points d'honneur (la sécurité
    // distributionnelle prime sur le compte de points). Se déclenche AVANT tout seuil de
    // points, y compris pour une main d'ouverture minimale — et reste valable même si un
    // adversaire est intervenu depuis (la sécurité distributionnelle ne dépend pas de ça).
    // EXCLU si MA PROPRE ouverture était déjà un barrage (palier 2+, voir échange avec
    // Guillaume, donne 2) : l'ouvreur de barrage a déjà tout dit à son premier tour — même
    // avec un fit connu et un soutien du partenaire, il ne reparle plus jamais de son
    // propre chef, quelle que soit la suite de l'enchère (relance adverse comprise).
    if (isRaiseOfMySuit && lengths[myBid.strain] >= 6 && myBid.level === 1) {
        const call = (partnerParsed.level + 1) + myBid.strain;
        if (isCallLegal(history, call, seat)) return call;
    }

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

    if (hl < 18) return 'PASS'; // seule une main nettement au-dessus d'une ouverture minimale rejustifie de reparler

    // Le partenaire a-t-il confirmé un fit pour MA couleur d'ouverture par un soutien
    // NATUREL (pas conventionnel — les cas 2SA/3SA sont désormais traités plus haut,
    // avant ce seuil) ?
    if (isRaiseOfMySuit) {
        // Fit confirmé et main d'ouverture nettement excédentaire (18HL+) : la manche est
        // quasiment automatique. Simplification volontaire : toujours viser la manche
        // dans MA couleur, jamais le chelem (pas de contrôle/Blackwood, hors périmètre).
        // Si le partenaire a déjà annoncé la manche lui-même (barrage), isCallLegal
        // rejettera naturellement cette annonce (déjà atteinte) et on se rabat sur passe.
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
            call = decideRobotResponseToDouble(hand, hcp, hl, doubleIndex, seat, history);
            explanation = `Réponse au contre du partenaire (${points})`;
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
                call = decideRobotResponse(hand, hcp, hl, myPartnerBid.call, seat, history, partnerPromises5Plus, wasIntervention);
                const isCompetitive = myPartnerBid !== lastBid;
                explanation = isCompetitive
                    ? `Soutien compétitif de ${formatCallForDisplay(myPartnerBid.call)} du partenaire malgré ${formatCallForDisplay(lastBid.call)} adverse (${points})`
                    : `Réponse à ${formatCallForDisplay(lastBid.call)} du partenaire (${points}, fit ${suitLengths(hand)[partnerBidInfo.strain] || 0}${partnerBidInfo.strain !== 'NT' ? ' carte(s) à ' + STRAIN_SYMBOL[partnerBidInfo.strain] : ''})`;
                } // fin du if (call !== 'X') — voir le contre protecteur plus haut
            } else {
                call = decideRobotIntervention(hand, hcp, hl, seat, history, deal.vulnerable);
                explanation = `Intervention sur ${formatCallForDisplay(lastBid.call)} adverse (${points})`;
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
        const wasOpening = history.slice(0, myBidIndex).every(entry => isPass(entry.call));
        const myPartnerBid = history.slice().reverse()
            .find(e => partnershipOf(e.seat) === partnershipOf(seat) && isBidCall(e.call) && e !== myBids[0]);

        if (wasOpening && myPartnerBid) {
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
            call = decideDoublerFollowUp(hand, hcp, hl, myPartnerBid.call, seat, history);
            explanation = `Suite après contre, réponse ${formatCallForDisplay(myPartnerBid.call)} du partenaire (${points})`;
        } else if (!wasOpening && myPartnerBid) {
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
            const partnerOpeningEntry = history.slice(0, myBidIndex).find(e => isBidCall(e.call));
            const partnerOpeningBid = partnerOpeningEntry ? parseBid(partnerOpeningEntry.call) : null;
            const myResponseBid = parseBid(myBids[0].call);

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
                call = decideRobotResponse(hand, hcp, hl, '2NT', seat, history, false);
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
                const openerMinHcp = partnerOpeningBid.level === 1 ? 15 : 20;
                const partnerReplyBid = parseBid(myPartnerBid.call);
                const lengths = suitLengths(hand);
                const majorFit = (partnerReplyBid.strain === 'H' || partnerReplyBid.strain === 'S')
                    && lengths[partnerReplyBid.strain] >= 4;
                if (majorFit && hcp + openerMinHcp >= 25) {
                    call = '4' + partnerReplyBid.strain;
                    explanation = `Fit trouvé après Stayman, manche (${points})`;
                } else if (majorFit) {
                    explanation = `Fit trouvé après Stayman, pas assez pour la manche — passe (${points})`;
                } else if (hcp + openerMinHcp >= 25) {
                    call = '3NT';
                    explanation = `Pas de majeure trouvée après Stayman, manche à SA (${points})`;
                } else {
                    explanation = `Pas de majeure trouvée après Stayman, pas assez pour la manche — passe (${points})`;
                }
            } else if (wasJacobyTransferAsk) {
                const openerMinHcp = partnerOpeningBid.level === 1 ? 15 : 20;
                if (hcp + openerMinHcp >= 25) {
                    const major = myAskBid.strain === 'D' ? 'H' : 'S';
                    call = '4' + major;
                    explanation = `Assez de points après le transfert, manche (${points})`;
                } else {
                    explanation = `Transfert complété, pas assez pour la manche — passe (${points})`;
                }
            } else {
            const knowsGameZone = partnerOpeningBid && myResponseBid
                && partnerOpeningBid.level === 1 && myResponseBid.strain !== partnerOpeningBid.strain
                && myResponseBid.strain !== 'NT' && hcp >= 12;
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
            const responseLengths = myResponseBid ? suitLengths(hand) : null;
            const lowZoneFlatNoInsist = partnerOpeningBid && myResponseBid && !knowsGameZone
                && myResponseBid.strain !== partnerOpeningBid.strain && myResponseBid.strain !== 'NT'
                && hcp >= 6 && hcp <= 10
                && responseLengths[myResponseBid.strain] < 6
                && isHandBalancedForNT(responseLengths);

            if ((knowsGameZone || mustAnswerQuantitative) && partnerBidsCount === 2) {
                call = decideResponderContinuationAfterNewSuit(hand, hcp, hl, partnerOpeningBid, myResponseBid, myPartnerBid.call, seat, history);
                explanation = `Suite en zone de manche après ${formatCallForDisplay(myPartnerBid.call)} du partenaire (${points})`;
            } else if (lowZoneFlatNoInsist && partnerBidsCount === 2) {
                const ntCall = parseBid(myPartnerBid.call).level + 'NT';
                if (isCallLegal(history, ntCall, seat)) {
                    call = ntCall;
                    explanation = `Zone basse (6-10H), main plate, pas de 6ème pour imposer sa couleur — repli SA (${points})`;
                } else {
                    explanation = `A déjà annoncé — passe (règle du tour unique)`;
                }
            } else {
                explanation = `A déjà annoncé — passe (règle du tour unique)`;
            }
            }
        } else {
            explanation = `A déjà annoncé — passe (règle du tour unique)`;
        }
    } else {
        explanation = `A déjà annoncé ${myBids.length} fois — passe (règle du tour unique)`;
    }

    if (call !== 'PASS' && !isCallLegal(history, call, seat)) {
        explanation += ' — annonce calculée invalide, repli sur passe';
        call = 'PASS';
    }
    return { call, explanation };
}

// ===== Enchères automatiques des robots (sièges non assignés) =====
//
// Seul l'hôte calcule et injecte les annonces des robots (pour ne jamais les déclencher en
// double), puis les diffuse comme n'importe quelle annonce.
function maybeRobotBid() {
    if (myRole !== 'host') return;
    if (!autoPassSeats || autoPassSeats.length === 0) return;
    if (!deals || isAuctionOver(auctionHistory)) return;

    const deal = currentDeal();
    const turnSeat = currentTurnSeat(deal.dealer, auctionHistory);
    if (!autoPassSeats.includes(turnSeat)) return;

    const boardAtSchedule = boardIndex;
    const historyLengthAtSchedule = auctionHistory.length;

    setTimeout(() => {
        if (boardIndex !== boardAtSchedule) return;
        if (auctionHistory.length !== historyLengthAtSchedule) return;
        if (isAuctionOver(auctionHistory)) return;
        const stillTurnSeat = currentTurnSeat(currentDeal().dealer, auctionHistory);
        if (stillTurnSeat !== turnSeat) return;

        // Mode "passe en boucle" (voir échange avec Guillaume, robotBiddingMode) : saute
        // complètement decideRobotCall, aucune analyse de la main, toujours passe.
        let call, explanation;
        if (robotBiddingMode === 'passOnly') {
            call = 'PASS';
            explanation = 'Mode « passe en boucle » activé';
        } else {
            ({ call, explanation } = decideRobotCall(turnSeat, currentDeal(), auctionHistory));
        }
        applyCall(turnSeat, call, explanation);
        peerConn.send({ type: 'call', boardIndex, seat: turnSeat, call, explanation });
    }, 300);
}

// ===== Écran de jeu =====

function enterGameScreen() {
    showScreen('screen-game');
    renderBoard();
}

function seatFullName(seat) {
    return SEAT_FULL_NAME[seat];
}

// ===== Bannière de reconnexion =====
//
// Signale, pendant toute la partie (pas seulement quand c'est son tour — voir aussi
// #turnIndicator/.disconnected-turn dans renderGameHeader pour ce cas précis), tout
// joueur assis à la table actuellement déconnecté, avec un décompte du temps écoulé. Un
// joueur déconnecté n'est PAS remplacé par un robot (voir onPeerDisconnected) : son siège
// attend simplement qu'il revienne, cette bannière rend cette attente visible même quand
// ce n'est pas encore à lui de parler.

// Affiche brièvement "X est de retour" à la place de la bannière d'attente, puis revient
// automatiquement à l'affichage normal après quelques secondes.
function flashWelcomeBack(name) {
    welcomeBackName = name;
    renderReconnectionBanner();
    clearTimeout(welcomeBackTimeoutId);
    welcomeBackTimeoutId = setTimeout(() => {
        welcomeBackName = null;
        renderReconnectionBanner();
    }, 4000);
}

function renderReconnectionBanner() {
    const banner = document.getElementById('reconnectionBanner');
    if (!banner) return;

    if (!deals) {
        banner.style.display = 'none';
        return;
    }

    if (welcomeBackName) {
        banner.className = 'reconnection-banner is-back';
        banner.textContent = `✅ ${welcomeBackName} est de retour !`;
        banner.style.display = 'block';
        return;
    }

    // Seuls les joueurs assis à la table intéressent cette bannière : un kibbitz
    // déconnecté ne bloque rien pour personne.
    const waiting = participants.filter(p =>
        p.disconnected && Object.values(seatAssignment).includes(p.id)
    );
    if (waiting.length === 0) {
        banner.style.display = 'none';
        return;
    }

    banner.textContent = waiting.map(p => {
        const seat = SEATS.find(s => seatAssignment[s] === p.id);
        const seatLabel = seat ? ` (${seatFullName(seat)})` : '';
        const elapsedS = p.disconnectedAt ? Math.max(0, Math.floor((Date.now() - p.disconnectedAt) / 1000)) : 0;
        return `🔌 ${p.name}${seatLabel} déconnecté depuis ${elapsedS}s — sa place est réservée`;
    }).join('\n');
    banner.className = 'reconnection-banner is-waiting';
    banner.style.display = 'block';
}

function renderBoard() {
    renderGameHeader();
    renderHandDisplayOptionButtons();
    renderMyHands();
    renderAuctionLedger();
    renderBiddingBox();
    checkAuctionEnd();
    updateBoardControlVisibility();
    renderUndoControls();
    renderUndoAskBanner();
    renderBoardSkipControls();
    renderReconnectionBanner();
    // Seulement si le panneau de chat est actuellement ouvert (il contient le bandeau
    // "qui est présent", voir uiToggleChat) : pas besoin de reconstruire son contenu tant
    // que personne ne le regarde.
    if (chatPanelOpen) renderRoomBoard();
    maybeRobotBid();
}

function updateBoardControlVisibility() {
    const resetBtn = document.getElementById('resetAuctionBtn');
    if (resetBtn) resetBtn.style.display = canControlBoard() ? '' : 'none';
    // Réservé à l'hôte (voir échange avec Guillaume) : changer qui est assis où reste une
    // décision d'organisation de la table, pas quelque chose qu'un simple joueur assis
    // devrait pouvoir déclencher pour tout le monde.
    const rotateBtn = document.getElementById('rotateSeatsBtn');
    // visibility (pas display:none) pour que l'espace du bouton reste réservé même masqué
    // (voir échange avec Guillaume) : sinon .game-actions (flex-wrap) n'a pas le même
    // nombre de boutons visibles selon le rôle, et la ligne se coupe différemment pour
    // l'hôte que pour les autres.
    if (rotateBtn) {
        rotateBtn.style.visibility = myRole === 'host' ? '' : 'hidden';
        rotateBtn.style.pointerEvents = myRole === 'host' ? '' : 'none';
    }
    // Téléchargement local pur (voir uiExportSessionPBN) : contrairement à l'export PBN
    // d'une seule donne (qui écrit sur le repo GitHub, réservé à l'hôte), rien n'empêche
    // n'importe quel joueur actif de récupérer sa propre vue locale de la session.
    const exportBtn = document.getElementById('exportSessionBtn');
    if (exportBtn) exportBtn.style.display = canControlBoard() ? '' : 'none';
}

function renderGameHeader() {
    const deal = currentDeal();
    document.getElementById('boardNumberLabel').textContent = `Donne #${deal.board} (${boardIndex + 1}/${deals.length})`;
    const mySeatsLabel = mySeats && mySeats.length > 0 ? mySeats.map(seatFullName).join(' + ') : 'kibbitz';
    document.getElementById('dealerVulnLabel').textContent =
        `Donneur : ${seatFullName(deal.dealer)} · ${VULN_LABEL[deal.vulnerable]} · Vous jouez : ${mySeatsLabel}`;
    // Voir échange avec Guillaume : le code de salle n'était visible que dans le salon
    // d'attente, plus du tout une fois la partie lancée — utile pourtant en cours de
    // route (inviter quelqu'un en plein milieu, ou simplement s'en souvenir).
    const roomCodeEl = document.getElementById('gameRoomCodeLabel');
    if (roomCodeEl) roomCodeEl.textContent = currentRoomCode ? `Salle : ${currentRoomCode}` : '';
}

// ===== Chat =====
//
// Diffusion par le même mécanisme que les enchères (voir 'call' dans handlePeerData) :
// un invité envoie à l'hôte, qui relaie aux autres invités (relayIfHost) — les invités ne
// sont jamais connectés entre eux. L'hôte, lui, diffuse directement à tout le monde.
// Historique gardé en mémoire pour la session en cours seulement : pas inclus dans
// 'resync', un joueur qui se reconnecte ne revoit pas les messages d'avant sa coupure —
// acceptable pour une fonctionnalité de confort, pas une donnée de jeu à préserver à tout
// prix.
let chatMessages = [];
let chatPanelOpen = false;
// Voir enterLobbyScreen : vrai une fois le chat auto-ouvert pour l'entrée en cours dans le
// salon, remis à false à chaque nouvelle session (création, jointure, transfert d'hôte) —
// voir uiCreateRoom, connectAsGuest, et la prise de rôle dans 'prepare-become-host'.
let lobbyChatAutoOpened = false;
let chatUnreadCount = 0;

// Déplace physiquement #chatPanel dans le flux normal du document, à la toute fin de
// l'écran donné (après tout son contenu) — voir échange avec Guillaume : sur mobile, le
// panneau flottant (position:fixed) se superposait à la boîte d'enchères (écran de jeu)
// et, de la même façon, au reste du salon (écran lobby). Rejoindre le flux normal règle
// ça : ouvrir le chat pousse le contenu, il ne le recouvre plus jamais. Idempotent (rien
// ne se passe si déjà à sa place) : peut être appelé à chaque changement d'écran sans
// souci, y compris en boucle sur le même écran.
// Sur l'écran de jeu spécifiquement (voir échange avec Guillaume) : ancré DANS
// .game-content-row, comme 3ème colonne à côté de .game-body (voir styles.css), plutôt
// qu'à la toute fin de l'écran — sinon il s'empilerait sous nextBoardPanel, pas à droite
// du contenu de jeu. Le salon, lui, n'a pas cette structure en colonnes : comportement
// inchangé, ancré à la fin de l'écran.
function dockChatIntoScreen(screenId) {
    const panel = document.getElementById('chatPanel');
    const gameContentRow = screenId === 'screen-game' ? document.querySelector('.game-content-row') : null;
    const targetScreen = gameContentRow || document.getElementById(screenId);
    if (!panel || !targetScreen) return;
    if (panel.parentElement !== targetScreen) targetScreen.appendChild(panel);
    panel.classList.add('chat-panel-docked');
}

// Symétrique : replace le chat dans son emplacement d'origine (juste après la barre de
// connexion), en panneau flottant classique — utilisé uniquement sur l'écran d'accueil,
// où le chat n'a de toute façon aucun sens (personne à qui parler) et reste masqué.
function undockChatFromScreen() {
    const panel = document.getElementById('chatPanel');
    const connectionBar = document.getElementById('connectionBar');
    if (!panel || !connectionBar) return;
    panel.classList.remove('chat-panel-docked');
    if (panel.previousElementSibling !== connectionBar) {
        connectionBar.insertAdjacentElement('afterend', panel);
    }
}

function uiToggleChat() {
    chatPanelOpen = !chatPanelOpen;
    const panel = document.getElementById('chatPanel');
    // Voir échange avec Guillaume : fondu rapide plutôt qu'un affichage/masquage instantané
    // — display ne peut pas être transitionné directement en CSS, donc on joue sur
    // l'opacité (voir .chat-panel/.chat-panel-visible dans styles.css) et on ne retire
    // display:none qu'après la fin du fondu de sortie (sinon le panneau resterait cliquable
    // et visible-mais-transparent pendant la transition).
    if (panel) {
        if (chatPanelOpen) {
            panel.style.display = 'flex';
            void panel.offsetWidth; // force le navigateur à appliquer display:flex avant d'ajouter la classe, sinon pas de transition depuis opacity:0
            panel.classList.add('chat-panel-visible');
        } else {
            panel.classList.remove('chat-panel-visible');
            setTimeout(() => {
                if (!chatPanelOpen) panel.style.display = 'none';
            }, 180);
        }
    }
    if (chatPanelOpen) {
        chatUnreadCount = 0;
        updateChatUnreadBadge();
        renderChat();
        renderRoomBoard(); // "qui est présent" fusionné dans le même panneau, voir échange avec Guillaume
        const input = document.getElementById('chatInput');
        if (input) input.focus();
    }
}

function updateChatUnreadBadge() {
    const badge = document.getElementById('chatUnreadBadge');
    if (!badge) return;
    if (chatUnreadCount > 0) {
        badge.textContent = chatUnreadCount > 9 ? '9+' : String(chatUnreadCount);
        badge.style.display = 'inline-flex';
    } else {
        badge.style.display = 'none';
    }
}

// Vrai seulement si le panneau de chat est à la fois OUVERT et réellement visible à
// l'écran — pas juste "ouvert" en état (voir échange avec Guillaume) : sur mobile, le chat
// ancré en bas de l'écran de jeu peut être ouvert sans être dans le champ de vision si on
// a fait défiler la page vers le haut pour voir sa main ou la boîte d'enchères.
function isChatPanelVisibleOnScreen() {
    if (!chatPanelOpen) return false;
    const panel = document.getElementById('chatPanel');
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 0 && rect.top < viewportHeight;
}

// Bandeau en haut de l'écran pour un message de chat reçu pendant que le panneau n'est
// pas visible (voir échange avec Guillaume — même mécanique que le wizz) : même style que
// les autres bandeaux, réutilisé tel quel.
function flashChatMessageToast(senderName, text) {
    let toast = document.getElementById('chatMessageToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'chatMessageToast';
        toast.className = 'call-explanation-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = `💬 ${senderName} : ${text}`;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

// Point d'entrée UNIQUE pour tout message de chat, qu'il vienne de moi (voir
// uiSendChatMessage) ou d'un autre participant (voir handlePeerData) : ajoute au journal,
// met à jour l'affichage, et — seulement pour un message de quelqu'un d'AUTRE que moi, et
// seulement si le panneau n'est pas visible à l'écran (voir isChatPanelVisibleOnScreen) —
// incrémente le badge et affiche un bandeau (voir échange avec Guillaume : le badge doit
// apparaître même si le panneau est techniquement "ouvert" mais hors du champ de vision).
function addChatMessage(msg) {
    chatMessages.push(msg);
    renderChat();
    const isMine = msg.senderId === myParticipantId;
    if (!isMine && !isChatPanelVisibleOnScreen()) {
        chatUnreadCount++;
        updateChatUnreadBadge();
        flashChatMessageToast(msg.senderName, msg.text);
    }
}

function renderChat() {
    const el = document.getElementById('chatMessages');
    if (!el) return;
    el.innerHTML = chatMessages.map(m => {
        // Tous les messages partent de la gauche, y compris les siens (pas de bulle
        // alignée à droite façon messagerie) — le nom précède toujours le message, avec
        // sa couleur reprise de avatarColorForId (même couleur que la petite pastille
        // d'avatar de ce participant ailleurs dans l'appli, pour un repère cohérent).
        const senderColor = avatarColorForId(m.senderId);
        return `<div class="chat-message"><span class="chat-message-sender" style="color:${senderColor}">${escapeHtml(m.senderName)} :</span> <span class="chat-message-text">${escapeHtml(m.text)}</span></div>`;
    }).join('');
    el.scrollTop = el.scrollHeight; // toujours faire défiler vers le message le plus récent
}

function uiChatInputKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    uiSendChatMessage();
}

function uiSendChatMessage() {
    const input = document.getElementById('chatInput');
    if (!input || !peerConn) return;
    const text = input.value.trim().slice(0, 500);
    if (!text) return;
    input.value = '';
    // Voir échange avec Guillaume : cliquer sur "Envoyer" déplace le focus sur le bouton
    // lui-même — sans ce refocus explicite, il fallait recliquer dans le champ pour
    // continuer à écrire. Sans effet quand l'envoi vient d'Entrée (voir
    // uiChatInputKeydown) : le champ avait déjà le focus dans ce cas.
    input.focus();

    const me = participants.find(p => p.id === myParticipantId);
    const msg = { type: 'chat', senderId: myParticipantId, senderName: me ? me.name : '?', text };
    addChatMessage(msg);
    // Même appel pour l'hôte (diffuse directement à tous les invités) et pour un invité
    // (envoie à l'hôte, qui relaiera) : send() sans guestIndex explicite diffuse déjà à
    // toutes les connexions actives de ce peer, qui n'en a qu'une seule (l'hôte) côté
    // invité — voir peer-connection.js.
    peerConn.send(msg);
}

// ===== Panneau "Salle" (qui est présent pendant la partie) =====
//
// Le salon d'attente montre déjà qui est là et où (renderSeatAssignmentGrid), mais cet
// écran disparaît une fois la partie lancée — il n'y avait alors plus aucun moyen de voir
// qui est présent, seulement (voir renderReconnectionBanner) une alerte quand quelqu'un se
// déconnecte. Masqué par défaut (comme le panneau de diagnostic) pour ne pas prendre de
// place en continu ; l'utilisateur l'ouvre s'il en a besoin.
// Fusionné dans le panneau de chat (voir uiToggleChat) plutôt qu'un panneau séparé à
// part : un bandeau "qui est présent", toujours visible en haut du chat, complète
// naturellement les messages plutôt que de demander un clic de plus pour y accéder.
// ===== Wizz (voir échange avec Guillaume : le "nudge" de MSN Messenger — cliquer sur le
// nom de quelqu'un fait trembler son écran) =====
//
// Un seul message réseau ('wizz'), avec un routage à deux vitesses selon qui l'envoie :
// - l'hôte connaît directement la connexion de chaque invité (guestIndexByToken), donc
//   lui envoie le wizz en ciblé, sans détour ;
// - un invité, lui, n'a qu'une seule connexion possible (l'hôte) : il lui envoie le wizz
//   à charge pour l'hôte de le relayer vers le vrai destinataire si ce n'est pas lui-même
//   (voir le cas 'wizz' dans handlePeerData) — topologie en étoile oblige.
const WIZZ_COOLDOWN_MS = 4000; // évite le spam frénétique entre amis, sans l'interdire
const wizzCooldownUntil = {}; // targetId -> timestamp, purement local (pas besoin de sync réseau)

// Nom cliquable pour envoyer un wizz — y compris le sien (voir échange avec Guillaume :
// utile pour tester l'effet sans avoir besoin d'un second appareil/participant) et sauf
// celui de quelqu'un de déconnecté (personne pour le recevoir). Sur son propre nom,
// déclenche l'effet directement en local (voir uiSelfWizz) plutôt que de faire un
// aller-retour réseau inutile.
function wizzableNameHtml(p) {
    const name = `<span class="room-board-name">${escapeHtml(p.name)}</span>`;
    if (p.disconnected) return name;
    if (p.id === myParticipantId) {
        return `<span class="room-board-name wizzable" onclick="uiSelfWizz()" title="Tester l'effet wizz sur soi-même">${escapeHtml(p.name)} 🔔</span>`;
    }
    return `<span class="room-board-name wizzable" onclick="uiSendWizz('${p.id}')" title="Faire trembler l'écran de ${escapeHtml(p.name)}">${escapeHtml(p.name)} 🔔</span>`;
}

// Voir échange avec Guillaume : déclenche l'effet wizz directement en local, sans passer
// par le réseau — pour pouvoir tester le rendu (tremblement, son, bandeau) sans avoir
// besoin d'un second appareil ou d'un autre participant connecté. Pas de cooldown ici non
// plus (contrairement à uiSendWizz) : en test, pouvoir redéclencher immédiatement est plus
// utile qu'une protection anti-spam qui n'a pas de sens quand on se cible soi-même.
function uiSelfWizz() {
    triggerWizzEffect();
}

function uiSendWizz(targetId) {
    if (!peerConn || targetId === myParticipantId) return;
    const now = Date.now();
    if (wizzCooldownUntil[targetId] && now < wizzCooldownUntil[targetId]) return; // encore en sablier, on ignore silencieusement
    wizzCooldownUntil[targetId] = now + WIZZ_COOLDOWN_MS;

    const me = participants.find(p => p.id === myParticipantId);
    const senderName = me ? me.name : '?';
    const msg = { type: 'wizz', targetId, senderName };

    if (myRole === 'host') {
        // L'hôte connaît directement la connexion du destinataire : envoi ciblé, pas de
        // relais nécessaire.
        const guestIndex = guestIndexByToken[targetId];
        if (guestIndex === undefined) return; // plus connecté entre-temps, tant pis
        peerConn.send(msg, guestIndex);
    } else {
        // Invité : un seul destinataire réseau possible (l'hôte), qui relaiera si besoin
        // (voir handlePeerData, cas 'wizz' avec targetId !== 'host').
        peerConn.send(msg);
    }
}

// Effet visuel + sonore reçu quand on se fait wizzer : tremblement bref de l'écran (voir
// @keyframes wizzShake dans styles.css) et un petit bip généré à la volée (pas de fichier
// audio à charger). Respecte prefers-reduced-motion : le tremblement est alors sauté, seul
// le bandeau reste pour prévenir sans désagrément visuel.
// Effet visuel + sonore reçu quand on se fait wizzer : tremblement bref de l'écran et un
// petit bip généré à la volée (pas de fichier audio à charger). Respecte
// prefers-reduced-motion : le tremblement est alors sauté, seul le bandeau reste pour
// prévenir sans désagrément visuel.
//
// Web Animations API (element.animate()) plutôt qu'une classe CSS + @keyframes (voir
// échange avec Guillaume) : le bandeau et le son fonctionnaient déjà correctement sur son
// iPhone, mais le tremblement ne s'affichait jamais, quelle que soit la cible CSS essayée
// (body, .app-container) — signe que le souci n'était pas la cible mais le mécanisme
// d'animation CSS lui-même. .animate() ne dépend pas du cycle de vie des animations CSS
// (classes, reflow forcé) et a un historique de compatibilité plus fiable sur Safari.
function triggerWizzEffect() {
    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReducedMotion && document.body.animate) {
        // Voir échange avec Guillaume : masque temporairement le débordement pendant le
        // tremblement — animer document.body en transform peut faire apparaître des
        // barres de défilement (à droite/en bas) le temps de l'animation, selon le
        // navigateur, puisque body est déplacé au-delà de sa position normale. Restauré
        // dès l'animation terminée (overflow d'origine, pas juste '' — au cas où une autre
        // partie du code l'aurait déjà réglé à quelque chose de spécifique).
        const previousOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
        const animation = document.body.animate([
            { transform: 'translate(0, 0)' },
            { transform: 'translate(-6px, 2px)' },
            { transform: 'translate(5px, -3px)' },
            { transform: 'translate(-5px, -2px)' },
            { transform: 'translate(6px, 3px)' },
            { transform: 'translate(-4px, 2px)' },
            { transform: 'translate(4px, -2px)' },
            { transform: 'translate(-3px, 1px)' },
            { transform: 'translate(3px, -1px)' },
            { transform: 'translate(-2px, 1px)' },
            { transform: 'translate(0, 0)' }
        ], { duration: 1200, easing: 'ease-in-out' });
        animation.finished.then(() => {
            document.documentElement.style.overflow = previousOverflow;
        }).catch(() => {
            document.documentElement.style.overflow = previousOverflow;
        });
    }
    playWizzSound();
    flashWizzToast();
}

// Bip classique généré via Web Audio (deux notes brèves) plutôt qu'un fichier son à
// héberger — cohérent avec le reste de l'appli (aucun asset audio nulle part ailleurs).
// Échoue silencieusement si l'API n'est pas dispo ou si le navigateur bloque l'audio sans
// interaction préalable (peu grave : l'effet visuel + le bandeau suffisent à prévenir).
function playWizzSound() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        [880, 660].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.value = 0.15;
            osc.connect(gain).connect(ctx.destination);
            const start = ctx.currentTime + i * 0.12;
            osc.start(start);
            gain.gain.exponentialRampToValueAtTime(0.001, start + 0.15);
            osc.stop(start + 0.16);
        });
    } catch (e) { /* tant pis, l'effet visuel suffit */ }
}

// Petit bandeau temporaire en haut de l'écran, plutôt qu'une alert() bloquante — cohérent
// avec le ton léger de la fonctionnalité. Interpelle la personne wizzée par son propre
// pseudo (voir échange avec Guillaume), pas par celui de l'expéditeur.
function flashWizzToast() {
    let toast = document.getElementById('wizzToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'wizzToast';
        toast.className = 'wizz-toast';
        document.body.appendChild(toast);
    }
    const me = participants.find(p => p.id === myParticipantId);
    const myName = me ? me.name : '';
    toast.textContent = `🔔 Réveillez-vous ${myName}, on vous attend !`;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

// Outil de diagnostic (voir échange avec Guillaume) : affiche pourquoi un robot a fait
// telle annonce (H/HL calculés, branche de décision) — tap sur une case d'enchère jouée
// par un robot dans le relevé (voir formatCallCellHtml, qui pose l'attribut
// data-explanation). Même mécanique de bandeau que le wizz, en plus long (texte
// explicatif, pas juste une alerte) et réutilisable sur desktop comme sur mobile — pas de
// tooltip pur (title) seul, qui ne fonctionne pas au tap sur tactile.
function uiShowCallExplanation(el) {
    const text = el.getAttribute('data-explanation');
    if (!text) return;
    let toast = document.getElementById('callExplanationToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'callExplanationToast';
        toast.className = 'call-explanation-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = `🤖 ${text}`;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 3500);
}

function renderRoomBoard() {
    const el = document.getElementById('roomBoard');
    if (!el) return;

    // Seuls les sièges réellement occupés par un participant apparaissent ici : les
    // robots ne sont pas des "personnes dans la salle", ça n'a pas sa place dans ce
    // panneau (contrairement au relevé d'enchères, où "Bot" reste utile pour savoir qui
    // a annoncé quoi — voir ledgerSeatLabel).
    //
    // Regroupement par participant plutôt qu'une ligne par siège : en mode diagonale ou
    // "maître du jeu", une même personne peut occuper 2 sièges — elle ne doit apparaître
    // qu'une fois, avec ses sièges listés ensemble (ex. "Nord + Sud"), pas deux fois.
    const seatsByParticipant = new Map(); // id -> [seat, seat, ...], dans l'ordre N/E/S/O
    SEATS.forEach(seat => {
        const pid = seatAssignment[seat];
        if (!pid) return;
        if (!seatsByParticipant.has(pid)) seatsByParticipant.set(pid, []);
        seatsByParticipant.get(pid).push(seat);
    });

    const seatRows = [...seatsByParticipant.keys()].map(pid => {
        const p = participants.find(x => x.id === pid);
        if (!p) return '';
        const seatsLabel = seatsByParticipant.get(pid).map(seatFullName).join(' + ');
        const disconnectedTag = p.disconnected ? ' <span class="disconnected-tag">🔌</span>' : '';
        const occupant = `${avatarHtml(p.id)}${wizzableNameHtml(p)}${disconnectedTag}`;
        return `<div class="room-board-seat"><span class="room-board-seat-label">${seatsLabel}</span>${occupant}</div>`;
    }).filter(Boolean).join('');

    // Quiconque n'occupe aucun siège est kibbitz (voir isKibbitz) : plus de liste à part à
    // maintenir, on liste simplement tous les participants absents de seatAssignment. Mais
    // seulement une fois la partie lancée (voir échange avec Guillaume) : dans le salon,
    // ne pas avoir de siège ne veut encore rien dire — l'hôte est peut-être justement en
    // train de composer la table — donc l'étiquette "Kibbitz" n'y a pas sa place.
    const kibbitzNames = deals ? participants.filter(p => !seatsByParticipant.has(p.id)) : [];
    const kibbitzHtml = kibbitzNames.length > 0
        ? `<div class="room-board-kibbitz">
               <span class="room-board-section-label">👁 Kibbitz :</span>
               ${kibbitzNames.map(p => `${avatarHtml(p.id)}${wizzableNameHtml(p)}`).join('')}
           </div>`
        : '';

    if (!seatRows && !kibbitzHtml) {
        // Rien à afficher (personne d'autre pour l'instant) : on laisse vide plutôt que
        // d'occuper de la place avec un message (voir échange avec Guillaume — superflu).
        // .room-board:empty se masque déjà tout seul (voir styles.css).
        el.innerHTML = '';
        return;
    }

    el.innerHTML = `<div class="room-board-seats">${seatRows}</div>${kibbitzHtml}`;
}

// Bordure colorée selon la vulnérabilité (voir échange avec Guillaume) : même convention
// que .vuln-bar dans le relevé d'enchères (vert = non vulnérable, rouge = vulnérable),
// appliquée directement sur la carte de main plutôt que sur une simple barre, pour la
// repérer d'un coup d'œil aussi bien sur sa propre main que sur "Voir les 4 mains".
function handCardVulnClass(seat, dealVulnerable) {
    const isVuln = dealVulnerable === 'Both' || dealVulnerable === partnershipOf(seat);
    return isVuln ? 'hand-card-vuln' : 'hand-card-safe';
}

function renderMyHands() {
    const deal = currentDeal();
    const container = document.getElementById('myHandsContainer');

    if (!mySeats || mySeats.length === 0) {
        // Plus de statut "spectateur" séparé : quiconque n'a pas de siège est kibbitz et
        // voit les 4 mains dès le début (voir isKibbitz). Les mains elles-mêmes
        // s'affichent dans #allHandsDiagram (voir checkAuctionEnd/renderAllHandsDiagram) —
        // le même emplacement central, en grille N/E/S/O, que celui utilisé quand l'hôte
        // active "Voir les 4 mains". Les construire ici, dans le panneau latéral étroit
        // des mains, les aurait affichées à l'étroit et mal calibrées plutôt qu'au centre.
        container.classList.remove('my-hands-multi');
        container.innerHTML =
            '<div class="info-text kibbitz-note">👁 Vous suivez la partie en kibbitz : vous voyez les 4 mains ci-dessous.</div>';
        return;
    }

    // Voir échange avec Guillaume (session du 23 juillet) : classe posée quand plusieurs
    // sièges sont joués, pour permettre un affichage côte à côte sur mobile plutôt qu'empilé
    // (voir la règle #myHandsContainer.my-hands-multi dans styles.css) — avant, jouer 2
    // mains les empilait verticalement même sur mobile, où l'espace horizontal disponible
    // suffit largement pour les mettre côte à côte.
    container.classList.toggle('my-hands-multi', mySeats.length > 1);

    // Distinction main active / inactive : seulement utile quand on contrôle plusieurs
    // sièges, et seulement pendant l'enchère (une fois terminée, plus de "tour" à signaler).
    const showActiveState = mySeats.length > 1 && !isAuctionOver(auctionHistory);
    const turnSeat = showActiveState ? currentTurnSeat(deal.dealer, auctionHistory) : null;

    container.innerHTML = mySeats.map(seat => {
        const hand = deal.hands[seat];
        const lines = ['S', 'H', 'D', 'C'].map(suit => `
            <div class="card-line">
                <span class="suit-symbol">${suitIconHtml(suit)}</span>
                <span class="cards">${formatRanksForDisplay(hand[suit]) || '—'}</span>
            </div>
        `).join('');

        // Voir échange avec Guillaume : les deux badges sont TOUJOURS générés (visibility
        // plutôt que display/absence), pour que la structure du titre reste rigoureusement
        // identique qu'ils soient affichés ou non — sans ça, la carte changeait très
        // légèrement de hauteur en bascule (alignement "baseline" du titre, voir
        // .hand-card-title), ce qui décalait la main centrée verticalement dans son module.
        const hcpBadge = `<span class="hand-hcp-badge"${showHcp ? '' : ' style="visibility:hidden;"'}>${computeHandHcp(hand)} HCP</span>`;
        const krBadge = `<span class="hand-hcp-badge"${showKr ? '' : ' style="visibility:hidden;"'}>K&R ${computeKaplanRubens(hand).toFixed(2)}</span>`;
        const stateClass = showActiveState ? (seat === turnSeat ? 'hand-card-active' : 'hand-card-inactive') : '';
        const vulnClass = handCardVulnClass(seat, deal.vulnerable);

        return `
            <div class="hand-card ${vulnClass} ${stateClass}">
                <div class="hand-card-title">
                    <span class="hand-card-title-name">${seatFullName(seat)}</span>
                    <span class="hand-card-badges">${hcpBadge}${krBadge}</span>
                </div>
                <div class="hand-cards">${lines}</div>
            </div>
        `;
    }).join('');
}

// Rendu coloré d'une annonce en dehors de la boîte d'enchères (relevé, contrat final) :
// même logique de classe de couleur que les boutons (SUIT_CLASSES), avec l'icône de
// couleur à la place du caractère Unicode brut (voir formatStrainLabel/suitIconHtml).
// Accepte soit une chaîne d'annonce brute (Passe/X/1SA...), soit une entrée complète de
// l'historique ({seat, call, explanation?}). L'outil de diagnostic (voir échange avec
// Guillaume) reste en sommeil côté affichage — pas assez abouti pour l'instant — mais le
// CALCUL de l'explication continue de tourner et d'être stocké sur chaque entrée
// (utile ailleurs, ex. export de session), seul le petit point tapable est désactivé ici.
// Pour le réactiver : décommenter le bloc `if (!explanation) return inner;` ci-dessous.
function formatCallCellHtml(entry) {
    const call = (typeof entry === 'string') ? entry : entry.call;

    const b = parseBid(call);
    const inner = !b
        ? escapeHtml(formatCallForDisplay(call)) // Passe / X / XX : pas de couleur de suite
        : `<span class="call-suit ${SUIT_CLASSES[b.strain] || 'notrump'}">${b.level}${formatStrainLabel(b.strain)}</span>`;

    return inner;

    // Outil de diagnostic (désactivé, voir commentaire plus haut) :
    // const explanation = (typeof entry === 'string') ? null : entry.explanation;
    // if (!explanation) return inner;
    // return `<span class="call-with-explanation" tabindex="0" data-explanation="${escapeHtml(explanation)}" onclick="uiShowCallExplanation(this)">${inner}<span class="call-explain-dot" aria-hidden="true"></span></span>`;
}

// Libellé affiché dans l'en-tête du tableau d'enchères pour un siège donné : soit
// l'abréviation N/E/S/O, soit le nom du joueur qui l'occupe (préférence showLedgerNames).
// Un siège robot (non assigné) ou sans nom exploitable retombe sur l'abréviation.
function ledgerSeatLabel(seat) {
    if (!showLedgerNames) return SEAT_ABBR_FR[seat];
    const pid = typeof seatAssignment !== 'undefined' ? seatAssignment[seat] : null;
    if (!pid) return 'Bot'; // siège non assigné : joué par le robot (voir maybeRobotBid)
    const p = participants.find(x => x.id === pid);
    const name = p && p.name ? p.name.trim() : '';
    return name || SEAT_ABBR_FR[seat]; // quelqu'un est bien assigné ici, pas un bot : jamais "Bot" dans ce cas
}

function renderAuctionLedger() {
    const deal = currentDeal();
    const header = document.getElementById('auctionLedgerHeader');
    const toggleBtn = document.getElementById('ledgerNamesToggleBtn');
    if (toggleBtn) toggleBtn.classList.toggle('is-active', showLedgerNames);
    const turnSeat = isAuctionOver(auctionHistory) ? null : currentTurnSeat(deal.dealer, auctionHistory);
    header.innerHTML = SEATS.map(s => {
        const pair = partnershipOf(s);
        const isVulnerable = deal.vulnerable === 'Both' || deal.vulnerable === pair;
        const vulnClass = isVulnerable ? 'vuln-bar-danger' : 'vuln-bar-safe';
        const classes = [s === turnSeat ? 'turn-col' : ''].filter(Boolean).join(' ');
        return `<th class="${classes}">
            <span class="ledger-seat-label">${escapeHtml(ledgerSeatLabel(s))}</span>
            <span class="vuln-bar ${vulnClass}"></span>
        </th>`;
    }).join('');

    const dealerIdx = SEATS.indexOf(deal.dealer);
    const slots = new Array(dealerIdx).fill('');
    auctionHistory.forEach(entry => slots.push(formatCallCellHtml(entry)));
    // Index de la toute dernière enchère jouée (pas juste la dernière case du tableau,
    // qui peut être vide en fin de ligne) : sert à lui appliquer un bref flash visuel à
    // chaque nouvelle annonce, pour la repérer d'un coup d'œil sans avoir à la chercher
    // dans la grille (voir .is-latest-call plus bas / styles.css).
    const lastIndex = auctionHistory.length > 0 ? slots.length - 1 : -1;
    // Ne flashe QUE si cette annonce n'a encore jamais été flashée (voir échange avec
    // Guillaume) : sans ce marqueur posé directement sur l'entrée elle-même (qui survit
    // à la navigation entre donnes, voir gotoBoard), revenir sur une donne déjà terminée
    // rejouerait l'animation sur le dernier passe à chaque re-rendu, alors que ce n'est
    // pas une nouvelle annonce.
    const lastEntry = auctionHistory.length > 0 ? auctionHistory[auctionHistory.length - 1] : null;
    const shouldFlashLatest = !!(lastEntry && !lastEntry._flashed);
    if (shouldFlashLatest) lastEntry._flashed = true;

    const rows = [];
    for (let i = 0; i < slots.length || rows.length === 0; i += 4) {
        rows.push(slots.slice(i, i + 4));
        if (i + 4 >= slots.length) break;
    }

    const body = document.getElementById('auctionLedgerBody');
    let flatIndex = 0;
    body.innerHTML = rows.map(row => {
        const cells = [0, 1, 2, 3].map(i => {
            const isLatest = flatIndex === lastIndex && shouldFlashLatest;
            flatIndex++;
            const cls = isLatest ? ' class="is-latest-call"' : '';
            return `<td${cls}>${row[i] != null ? row[i] : ''}</td>`;
        });
        return `<tr>${cells.join('')}</tr>`;
    }).join('');
}

function renderBiddingBox() {
    const box = document.getElementById('biddingBox');
    const turnPanel = document.getElementById('turnIndicator');
    const deal = currentDeal();

    if (isAuctionOver(auctionHistory)) {
        box.innerHTML = '';
        turnPanel.textContent = '';
        return;
    }

    const turnSeat = currentTurnSeat(deal.dealer, auctionHistory);
    const myTurn = mySeats && mySeats.includes(turnSeat);

    const turnOwnerId = seatAssignment[turnSeat];
    const turnOwner = turnOwnerId ? participants.find(p => p.id === turnOwnerId) : null;
    const ownerDisconnected = !!(turnOwner && turnOwner.disconnected);

    if (myTurn) {
        turnPanel.textContent = `À vous d'enchérir (${seatFullName(turnSeat)})`;
    } else if (ownerDisconnected) {
        turnPanel.textContent = `🔌 En attente que ${turnOwner.name} se reconnecte (${seatFullName(turnSeat)})...`;
    } else {
        turnPanel.textContent = `En attente de ${seatFullName(turnSeat)}...`;
    }
    turnPanel.className = 'turn-indicator ' + (myTurn ? 'my-turn' : (ownerDisconnected ? 'disconnected-turn' : 'their-turn'));

    const specialLabels = { PASS: 'Passe', X: 'X', XX: 'XX' };
    // Voir échange avec Guillaume : ligne spéciale calée sur la même grille à 5 colonnes
    // que les rangées d'enchères — X sur la colonne 4 (1♦) et XX sur la colonne 5 (1♣),
    // pour un alignement précis avec la rangée du dessous. Passe en position absolue (voir
    // .call-btn-pass dans styles.css), largeur et décalage calculés en CSS — pas besoin de
    // grid-column ici, une fois en position absolue il sort du flux de la grille.
    const specialSpec = {
        PASS: { col: null, extraClass: 'call-btn-pass' },
        X: { col: 4, extraClass: 'call-btn-double' },
        XX: { col: 5, extraClass: 'call-btn-redouble' }
    };
    const specialRow = ['PASS', 'X', 'XX'].map(call => {
        const legal = myTurn && isCallLegal(auctionHistory, call, turnSeat);
        const { col, extraClass } = specialSpec[call];
        const colStyle = col ? ` style="grid-column: ${col};"` : '';
        return `<button class="call-btn call-btn-special ${extraClass}"${colStyle} ${legal ? '' : 'disabled'} onclick="uiMakeCall('${call}')">${specialLabels[call]}</button>`;
    }).join('');

    const bidRows = [];
    for (let level = 1; level <= 7; level++) {
        const cells = STRAINS.map(strain => {
            const call = `${level}${strain}`;
            const legal = myTurn && isCallLegal(auctionHistory, call, turnSeat);
            const label = formatStrainLabel(strain);
            const suitClass = SUIT_CLASSES[strain] || 'notrump';
            return `<button class="call-btn ${suitClass}" ${legal ? '' : 'disabled'} onclick="uiMakeCall('${call}')">${level}${label}</button>`;
        }).join('');
        bidRows.push(`<div class="bid-row">${cells}</div>`);
    }

    box.innerHTML = `
        <div class="special-calls-row">${specialRow}</div>
        <div class="bid-grid">${bidRows.join('')}</div>
    `;
}

function uiMakeCall(call) {
    const deal = currentDeal();
    const turnSeat = currentTurnSeat(deal.dealer, auctionHistory);
    if (!mySeats || !mySeats.includes(turnSeat)) return;
    if (!isCallLegal(auctionHistory, call, turnSeat)) return;

    applyCall(turnSeat, call);
    peerConn.send({ type: 'call', boardIndex, seat: turnSeat, call });
}

function applyCall(seat, call, explanation) {
    auctionHistory.push(explanation ? { seat, call, explanation } : { seat, call });
    renderAuctionLedger();
    renderBiddingBox();
    renderMyHands();
    checkAuctionEnd();
    renderUndoControls();
    maybeRobotBid();
}

// Construit le HTML des 4 mains, affiché dans #allHandsDiagram (voir
// renderAllHandsDiagram) — révélé à tout le monde une fois l'enchère terminée, à l'hôte
// seul s'il active "Voir les 4 mains" en cours d'enchère, et en continu à un kibbitz
// (voir checkAuctionEnd).
function buildAllHandsHtml(deal) {
    // Même halo doré que renderMyHands pour repérer le tour en cours (voir échange avec
    // Guillaume : absent jusqu'ici de cette vue-là) — plus de "seulement si on contrôle
    // plusieurs sièges" ici, puisque les 4 mains sont de toute façon toujours affichées
    // ensemble dans cette vue. Rien à distinguer une fois l'enchère terminée (plus de
    // "tour" à signaler).
    const showActiveState = !isAuctionOver(auctionHistory);
    const turnSeat = showActiveState ? currentTurnSeat(deal.dealer, auctionHistory) : null;

    return SEATS.map(seat => {
        const hand = deal.hands[seat];
        const lines = ['S', 'H', 'D', 'C'].map(suit => `
            <div class="card-line">
                <span class="suit-symbol">${suitIconHtml(suit)}</span>
                <span class="cards">${formatRanksForDisplay(hand[suit]) || '—'}</span>
            </div>
        `).join('');

        const hcpBadge = `<span class="hand-hcp-badge"${showHcp ? '' : ' style="visibility:hidden;"'}>${computeHandHcp(hand)} HCP</span>`;
        const krBadge = `<span class="hand-hcp-badge"${showKr ? '' : ' style="visibility:hidden;"'}>K&R ${computeKaplanRubens(hand).toFixed(2)}</span>`;
        const vulnClass = handCardVulnClass(seat, deal.vulnerable);
        const stateClass = showActiveState ? (seat === turnSeat ? 'hand-card-active' : 'hand-card-inactive') : '';

        return `
            <div class="hand-card hand-${seat} ${vulnClass} ${stateClass}">
                <div class="hand-card-title">
                    <span class="hand-card-title-name">${seatFullName(seat)}</span>
                    <span class="hand-card-badges">${hcpBadge}${krBadge}</span>
                </div>
                <div class="hand-cards">${lines}</div>
            </div>
        `;
    }).join('');
}

function renderAllHandsDiagram() {
    const container = document.getElementById('allHandsDiagram');
    container.innerHTML = buildAllHandsHtml(currentDeal());
    syncHandsPanelMinHeight();
}

// Voir échange avec Guillaume : mesure dynamiquement la hauteur réellement nécessaire au
// mode "4 mains" (qui varie selon les options actives — HCP et K&R affichés ensemble
// rendent chaque carte plus haute que dans un cas plus simple — et selon le contenu des
// mains) et la réserve en permanence sur .hands-panel, plutôt qu'une valeur fixe en dur
// qui ne correspondait qu'à un cas de test précis et pouvait être dépassée en vrai jeu.
// Fonctionne même quand le diagramme n'est pas actuellement affiché : le rend
// temporairement mesurable (hors flux, invisible) le temps de la mesure, sans jamais
// l'exposer visuellement ni perturber la mise en page pendant ce court instant.
function syncHandsPanelMinHeight() {
    const panel = document.querySelector('.hands-panel');
    const diagram = document.getElementById('allHandsDiagram');
    if (!panel || !diagram) return;

    // Voir échange avec Guillaume (session du 23 juillet) : cette réservation de hauteur
    // n'a de sens qu'en desktop, où .game-body affiche les mains et le panneau d'enchères
    // côte à côte (voir .game-body, breakpoint 760px) — aligner leurs hauteurs évite un
    // décalage visuel entre les deux colonnes. Sur mobile, game-body passe en une seule
    // colonne empilée : il n'y a plus rien à aligner, et cette hauteur réservée pour le
    // mode "4 mains" ne faisait que pousser la boîte d'enchères hors écran avec un grand
    // vide en dessous de la main affichée (constaté en test réel — avant, mains et
    // enchères tenaient sur le même écran).
    if (window.innerWidth <= 760) {
        panel.style.minHeight = '';
        return;
    }

    const panelStyles = getComputedStyle(panel);
    const paddingTop = parseFloat(panelStyles.paddingTop) || 0;
    const paddingBottom = parseFloat(panelStyles.paddingBottom) || 0;
    const paddingLeft = parseFloat(panelStyles.paddingLeft) || 0;
    const paddingRight = parseFloat(panelStyles.paddingRight) || 0;

    const wasHidden = getComputedStyle(diagram).display === 'none';
    let previousPosition, previousVisibility, previousDisplay, previousWidth;
    if (wasHidden) {
        previousPosition = diagram.style.position;
        previousVisibility = diagram.style.visibility;
        previousDisplay = diagram.style.display;
        previousWidth = diagram.style.width;
        diagram.style.position = 'absolute';
        diagram.style.visibility = 'hidden';
        diagram.style.display = 'grid';
        // Voir échange avec Guillaume : largeur explicitement contrainte à celle du
        // panneau (moins son padding) — position:absolute seul ne préserve pas la largeur
        // du flux normal (il se réduit à son contenu par défaut), ce qui pouvait changer
        // légèrement le retour à la ligne du texte, donc la hauteur mesurée, par rapport
        // à l'affichage réel en flux normal (petit résidu de 1-2px observé sans ça).
        diagram.style.width = (panel.getBoundingClientRect().width - paddingLeft - paddingRight) + 'px';
    }

    const diagramHeight = diagram.getBoundingClientRect().height;
    // Voir échange avec Guillaume : +4px de marge de sécurité — un écart résiduel de
    // 1-2px subsiste entre cette mesure (temporairement hors flux) et le rendu réel une
    // fois véritablement affiché et étiré par .game-content-row (arrondi sous-pixel),
    // mieux vaut réserver très légèrement plus que pas assez.
    panel.style.minHeight = Math.ceil(diagramHeight + paddingTop + paddingBottom + 4) + 'px';

    if (wasHidden) {
        diagram.style.position = previousPosition;
        diagram.style.visibility = previousVisibility;
        diagram.style.display = previousDisplay;
        diagram.style.width = previousWidth;
    }
}

const STRAIN_ORDER = ['N', 'S', 'H', 'D', 'C']; // N = sans-atout (SA), pas Nord
// Classe de couleur CSS par couleur d'enchère, pour la table du double mort — mêmes
// classes que SUIT_CLASSES, complétées de 'notrump' pour la ligne SA.
const STRAIN_CLASS = { N: 'notrump', S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

// Convertit un nombre de levées (sur 13) en palier de contrat réalisable : il faut
// 6 levées de base + le palier, donc palier = levées - 6. En dessous de 7 levées, aucun
// contrat n'est réalisable (le palier serait nul ou négatif) : on affiche "―".
function tricksToContractLevel(tricks) {
    if (tricks == null) return '—';
    const level = tricks - 6;
    return level >= 1 ? String(level) : '―';
}

// ===== Mise en évidence du meilleur contrat (table du double mort) =====
//
// Portée depuis le générateur de donnes (dds-controller.js) — même algorithme exact, pour
// que les deux applis restent cohérentes visuellement. Principe : pour chaque case
// (couleur x déclarant), on suppose que le camp du déclarant enchérit tout juste au
// palier permis par le double mort (ni plus, ni moins), et on calcule le score de
// duplicate correspondant (barème SEF/FFB standard, non contré, selon la vulnérabilité
// réelle de la donne). Calcul INDÉPENDANT par camp (NS et EW n'enchérissent pas le même
// contrat) : chelem prime sur manche, qui prime sur partielle ; seules les cases du
// palier le plus haut atteint par ce camp sont mises en évidence — la ou les meilleures
// en vert vif, les autres du même palier en vert plus doux (sauf en partielle, qui n'a
// pas de prime notable : seule la meilleure y est marquée, pas de dégradé secondaire).

function trickPoints(strain, level) {
    if (strain === 'N') return 40 + (level - 1) * 30;
    if (strain === 'H' || strain === 'S') return level * 30;
    return level * 20; // C ou D
}

function contractScoreFromTrickPoints(trickPts, level, vulnerable) {
    let total = trickPts;
    total += trickPts >= 100 ? (vulnerable ? 500 : 300) : 50; // prime de manche ou de partielle
    if (level === 6) total += vulnerable ? 750 : 500;         // petit chelem
    else if (level === 7) total += vulnerable ? 1500 : 1000;  // grand chelem
    return total;
}

// `dealVulnerable` : la valeur normalisée habituelle ('None'/'NS'/'EW'/'Both', voir
// deal-parser.js) — contrairement au générateur, pas besoin de la recalculer depuis le
// numéro de donne, currentDeal().vulnerable la donne déjà directement.
function computeDDScores(ddTable, dealVulnerable) {
    const nsVuln = (dealVulnerable === 'NS' || dealVulnerable === 'Both');
    const ewVuln = (dealVulnerable === 'EW' || dealVulnerable === 'Both');

    const info = {};
    const bySide = { NS: [], EW: [] };

    for (const strain of STRAIN_ORDER) {
        info[strain] = {};
        for (const pos of DD_TABLE_SEAT_ORDER) {
            const side = (pos === 'N' || pos === 'S') ? 'NS' : 'EW';
            const tricks = ddTable[strain][pos];
            const level = tricks - 6;

            let score = null;
            let tier = null;
            if (level >= 1) {
                const trickPts = trickPoints(strain, level);
                score = contractScoreFromTrickPoints(trickPts, level, side === 'NS' ? nsVuln : ewVuln);
                tier = level >= 6 ? 'slam' : (trickPts >= 100 ? 'game' : 'partial');
            }

            info[strain][pos] = { score, tier, side };
            if (tier) bySide[side].push({ score, tier });
        }
    }

    const sideSummary = {};
    for (const side of ['NS', 'EW']) {
        const cells = bySide[side];
        let activeTier = null;
        if (cells.some(c => c.tier === 'slam')) activeTier = 'slam';
        else if (cells.some(c => c.tier === 'game')) activeTier = 'game';
        else if (cells.some(c => c.tier === 'partial')) activeTier = 'partial';

        let bestScore = null;
        if (activeTier) {
            bestScore = Math.max(...cells.filter(c => c.tier === activeTier).map(c => c.score));
        }

        sideSummary[side] = { activeTier, bestScore };
    }

    return { info, sideSummary };
}

// Ordre d'affichage des colonnes de la table du double mort : N S E O (les deux camps
// groupés côte à côte), plus pratique à lire que l'ordre de rotation des enchères N E S O
// utilisé partout ailleurs (SEATS, dans bidding-rules.js) — surtout ne pas réutiliser
// SEATS ici, sous peine de casser la logique de tour de parole.
const DD_TABLE_SEAT_ORDER = ['N', 'S', 'E', 'W'];

// Construit le tableau HTML du double mort (5 lignes SA/♠/♥/♦/♣ x 4 colonnes N/S/E/O),
// tel qu'éventuellement fourni dans le fichier PBN chargé (tag [OptimumResultTable]).
// Affiche le palier de contrat réalisable (et non le nombre brut de levées), avec le
// meilleur contrat de chaque camp mis en évidence (voir computeDDScores ci-dessus).
function renderDDTable(ddTable, dealVulnerable) {
    if (!ddTable) return '';
    const { info, sideSummary } = computeDDScores(ddTable, dealVulnerable);
    const rows = STRAIN_ORDER.map(strain => {
        const labelHtml = formatStrainLabel(strain);
        const cells = DD_TABLE_SEAT_ORDER.map(pos => {
            const cellInfo = info[strain][pos];
            const summary = sideSummary[cellInfo.side];
            let cls = '';
            if (summary.activeTier && cellInfo.tier === summary.activeTier) {
                if (cellInfo.score === summary.bestScore) {
                    cls = ' class="dd-best-contract"';
                } else if (summary.activeTier !== 'partial') {
                    cls = ' class="dd-secondary-contract"';
                }
            }
            return `<td${cls}>${tricksToContractLevel(ddTable[strain][pos])}</td>`;
        }).join('');
        return `<tr><th class="${STRAIN_CLASS[strain]}">${labelHtml}</th>${cells}</tr>`;
    }).join('');
    return `
        <div class="dd-table-title">Table du double mort</div>
        <table class="dd-table">
            <thead><tr><th></th>${DD_TABLE_SEAT_ORDER.map(p => `<th>${SEAT_ABBR_FR[p]}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

// ===== Export PBN d'une donne jouée (voir échange avec Guillaume) =====
//
// Envoie la donne courante à une fonction serverless Vercel dédiée (à ajouter au même
// projet que l'API de double mort, voir api/export-deal.js — pas fourni ici en l'état,
// c'est un fichier à part que Guillaume doit déployer lui-même), qui l'écrit dans
// donnes_export/ sur GitHub. Le jeton d'écriture reste entièrement côté serveur — jamais
// transmis ni visible depuis le navigateur (voir le commentaire en tête de ce fichier-là).
const DEAL_EXPORT_SERVER_URL = 'https://api-gen-beta.vercel.app/api/export-deal';

// Construit le contenu PBN d'une donne JOUÉE : mêmes tags que buildPBNBlock dans
// generator.js (gen/) pour la donne elle-même et la table du double mort si disponible,
// complétés par le contrat obtenu et l'enchère réellement menée — propre à une donne
// jouée ici, pas à une donne fraîchement générée.
function buildPlayedDealPBN(deal, history) {
    const handsStr = ['N', 'E', 'S', 'W']
        .map(pos => ['S', 'H', 'D', 'C'].map(suit => deal.hands[pos][suit]).join('.'))
        .join(' ');

    let pbn = '';
    pbn += `[Event "Table d'enchères"]\n`;
    pbn += `[Site "capgui13.github.io/play"]\n`;
    pbn += `[Board "${deal.board}"]\n`;
    pbn += `[Dealer "${deal.dealer}"]\n`;
    pbn += `[Vulnerable "${deal.vulnerable}"]\n`;
    pbn += `[Deal "N:${handsStr}"]\n`;

    // Contrat obtenu (pas un résultat de levées : l'appli ne couvre que la phase
    // d'enchères, pas le jeu de la carte — voir README) et déclarant, si l'enchère n'a pas
    // été passée sans annonce.
    const contract = determineContract(history);
    if (contract) {
        pbn += `[Contract "${contract.level}${contract.strain}${contract.doubled}"]\n`;
        pbn += `[Declarer "${contract.declarer}"]\n`;
    }

    // Séquence d'enchères réellement menée (4 annonces par ligne, convention PBN
    // courante mais non obligatoire — juste plus lisible à l'œil).
    if (history.length > 0) {
        pbn += `[Auction "${deal.dealer}"]\n`;
        const tokens = history.map(entry => (isPass(entry.call) ? 'Pass' : entry.call));
        for (let i = 0; i < tokens.length; i += 4) {
            pbn += tokens.slice(i, i + 4).join(' ') + '\n';
        }
    }

    // Table complète du double mort, si elle a eu le temps d'être calculée (voir
    // kickOffBackgroundDD) — même format que buildPBNBlock dans generator.js, pour rester
    // relisible par les mêmes outils (dont cette appli elle-même).
    if (deal.ddTable) {
        pbn += `[OptimumResultTable "Declarer;Denomination\\2R;Result\\2R"]\n`;
        const denomForStrain = { N: 'NT', S: 'S', H: 'H', D: 'D', C: 'C' };
        ['N', 'E', 'S', 'W'].forEach(declarer => {
            ['N', 'S', 'H', 'D', 'C'].forEach(strain => {
                pbn += `${declarer} ${denomForStrain[strain]} ${deal.ddTable[strain][declarer]}\n`;
            });
        });
    }

    pbn += `\n`;
    return pbn;
}

function setDealExportStatus(text, isError) {
    const el = document.getElementById('dealExportStatus');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('is-error', !!isError);
}

// Bouton "📤 Export PBN" sous la table du double mort (voir checkAuctionEnd) : envoie la
// donne courante, telle qu'elle a été effectivement jouée, à la fonction serverless
// dédiée. Nom de fichier horodaté à la seconde près : collision quasiment impossible mais,
// le cas échéant, l'export échoue proprement (voir api/export-deal.js) plutôt que
// d'écraser silencieusement un export précédent.
function uiExportDealPBN() {
    if (myRole !== 'host') return;
    const deal = currentDeal();
    if (!deal) return;

    const btn = document.getElementById('dealExportBtn');
    if (btn) btn.disabled = true;
    setDealExportStatus('⏳ Export en cours...', false);

    const content = buildPlayedDealPBN(deal, auctionHistory);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const filename = `donne-${deal.board}-${stamp}.pbn`;

    fetch(DEAL_EXPORT_SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename, content })
    })
        .then(async (response) => {
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data.ok) throw new Error(data.error || ('HTTP ' + response.status));
            setDealExportStatus(`✅ Exportée : ${data.path}`, false);
        })
        .catch((err) => {
            setDealExportStatus('❌ Échec de l\'export : ' + ((err && err.message) || err), true);
        })
        .finally(() => {
            if (btn) btn.disabled = false;
        });
}

// Export de TOUTE la session (voir échange avec Guillaume) : combine les donnes
// effectivement jouées (enchère terminée, quel que soit le résultat) en un seul fichier
// PBN multi-donnes, en réutilisant tel quel buildPlayedDealPBN pour chacune — un fichier
// PBN standard accepte naturellement plusieurs donnes à la suite, chacune avec ses propres
// tags [Board]/[Deal]/[Auction]/etc. Contrairement à l'export d'une seule donne (qui écrit
// sur le repo GitHub via le proxy Vercel), ici pas de serveur impliqué : téléchargement
// direct dans le navigateur, à donner ensuite tel quel pour des retours précis
// ("donne 2, Sud a contré mais...").
function uiExportSessionPBN() {
    if (!deals) return;
    const playedDeals = deals.filter(d => d.auctionHistory && isAuctionOver(d.auctionHistory));
    if (playedDeals.length === 0) {
        flashSessionExportToast('Aucune donne terminée à exporter pour l\'instant.');
        return;
    }

    const content = playedDeals.map(d => buildPlayedDealPBN(d, d.auctionHistory)).join('');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

    const a = document.createElement('a');
    a.href = url;
    a.download = `session-${stamp}.pbn`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    flashSessionExportToast(`📦 ${playedDeals.length} donne(s) exportée(s).`);
}

// Même mécanique de bandeau que flashWizzToast/uiShowCallExplanation (voir ces
// fonctions) — un id dédié plutôt que de les réutiliser, pour ne pas se marcher dessus si
// deux notifications se déclenchent presque en même temps (ex. wizz reçu pile pendant un
// export).
function flashSessionExportToast(text) {
    let toast = document.getElementById('sessionExportToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'sessionExportToast';
        toast.className = 'call-explanation-toast'; // même style que le toast de diagnostic, réutilisé tel quel
        document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
}

function checkAuctionEnd() {
    const resultEl = document.getElementById('contractResult');
    const nextPanel = document.getElementById('nextBoardPanel');
    const diagramEl = document.getElementById('allHandsDiagram');

    const auctionOver = isAuctionOver(auctionHistory);
    // L'hôte peut choisir de voir les 4 mains à tout moment (voir uiToggleHostSeeAllHands),
    // même pendant l'enchère — un outil réservé à lui seul (vérifier une donne, aider un
    // débutant en direct...), jamais envoyé ni visible pour les autres joueurs. Un
    // kibbitz, lui, voit toujours les 4 mains dès le début (voir renderMyHands) — pas
    // besoin d'attendre la fin de l'enchère ni une action de l'hôte, puisqu'il n'est
    // assis à aucun siège et ne peut donc rien "tricher" en les voyant.
    const hostForcedReveal = myRole === 'host' && hostSeeAllHands;
    const showAllHandsEarly = hostForcedReveal || isKibbitz();

    if (!auctionOver) {
        resultEl.style.display = 'none';
        nextPanel.style.display = 'none';
        const myHandsEl = document.getElementById('myHandsContainer');
        if (showAllHandsEarly) {
            renderAllHandsDiagram();
            diagramEl.style.display = 'grid';
            // Voir échange avec Guillaume : les 4 mains REMPLACENT la main du joueur dans
            // ce même panneau de gauche, pas de cohabitation des deux à la fois.
            if (myHandsEl) myHandsEl.style.display = 'none';
        } else {
            diagramEl.style.display = 'none';
            if (myHandsEl) myHandsEl.style.display = '';
            // Voir échange avec Guillaume : rendu (masqué) et hauteur synchronisée même ici
            // — sans ça, la réservation de hauteur ne se mettait à jour qu'après la
            // toute première bascule sur "voir les 4 mains", pas dès le début d'une donne.
            renderAllHandsDiagram();
        }
        return;
    }

    const contract = determineContract(auctionHistory);
    // Ne joue l'animation de révélation (voir .contract-reveal dans styles.css) qu'au
    // moment précis où le contrat apparaît, pas à chaque re-rendu (renderBoard tourne
    // pour bien d'autres raisons — reconnexion d'un joueur, etc. — tant que la donne
    // reste sur cet écran) : on la déclenche seulement s'il était masqué juste avant.
    const wasHidden = resultEl.style.display === 'none' || resultEl.style.display === '';
    resultEl.style.display = 'block';
    if (!contract) {
        resultEl.innerHTML = "↩️ Donne passée — personne n'a annoncé.";
    } else {
        const strainCls = SUIT_CLASSES[contract.strain] || 'notrump';
        const strainLabel = formatStrainLabel(contract.strain);
        const contractHtml = `<span class="call-suit ${strainCls}">${contract.level}${strainLabel}${escapeHtml(contract.doubled)}</span>`;
        resultEl.innerHTML = `Contrat final : <strong>${contractHtml}</strong> par <strong>${seatFullName(contract.declarer)}</strong>`;
    }
    if (wasHidden) {
        // Retire puis relit offsetWidth avant de rajouter la classe : sans ce "force
        // reflow", le navigateur ne rejouerait pas l'animation si la classe était déjà
        // présente d'un affichage précédent (peu probable ici vu qu'on ne la retire
        // jamais ailleurs, mais le filet de sécurité ne coûte rien).
        resultEl.classList.remove('contract-reveal');
        void resultEl.offsetWidth;
        resultEl.classList.add('contract-reveal');
    }

    const ddTableHtml = renderDDTable(currentDeal().ddTable, currentDeal().vulnerable);
    if (ddTableHtml) {
        resultEl.innerHTML += ddTableHtml;
        // Voir échange avec Guillaume : bouton d'export PBN de cette donne, réservé à
        // l'hôte (c'est lui qui a la main sur le déroulement de la partie), affiché
        // seulement une fois le double mort disponible — cohérent avec le fait que ce
        // bouton vit "dans le module qui affiche le PAR".
        if (myRole === 'host') {
            resultEl.innerHTML += `
                <div class="dd-export-row">
                    <button type="button" class="btn btn-secondary btn-small" id="dealExportBtn" onclick="uiExportDealPBN()">📤 Export PBN</button>
                    <span id="dealExportStatus" class="dd-export-status"></span>
                </div>
            `;
        }
    }

    renderAllHandsDiagram();
    diagramEl.style.display = 'grid';
    {
        const myHandsEl = document.getElementById('myHandsContainer');
        if (myHandsEl) myHandsEl.style.display = 'none';
    }

    const isLastBoard = boardIndex >= deals.length - 1;
    const iCanNavigate = canControlBoard();
    nextPanel.style.display = (isLastBoard || !iCanNavigate) ? 'none' : 'block';

    if (isLastBoard) {
        resultEl.innerHTML += '<div class="info-text">Dernière donne du fichier chargé.</div>';
    } else if (!iCanNavigate) {
        resultEl.innerHTML += '<div class="info-text">En attente qu\'un joueur actif passe à la donne suivante.</div>';
    }
}

// ===== Demande d'annulation (undo) =====
//
// Un joueur actif peut demander l'annulation de la dernière annonce (utile en cas de
// mauvais clic). Cette annonce a pu déjà donner une information au camp adverse : on ne
// l'annule donc jamais tout seul dans son coin, il faut l'accord d'un adversaire humain.
// S'il n'y a personne à convaincre en face (siège robot, ou la même personne joue les
// deux camps), l'annulation s'applique immédiatement.
//
// Protocole (voir aussi peer-connection.js) :
//   'undo-request' (→ hôte)      le demandeur sollicite une annulation
//   'undo-ask'     (hôte →)      l'hôte demande l'accord à un adversaire humain
//   'undo-answer'  (→ hôte)      la réponse de cet adversaire (accepté/refusé)
//   'undo-apply'   (hôte →)      l'annulation est actée, tout le monde retire la dernière annonce
//   'undo-rejected'(hôte →)      informe le demandeur que ça ne s'est pas fait, et pourquoi
//
// L'hôte est toujours l'arbitre (hostPendingUndo) : c'est le seul point de passage
// obligé entre deux invités (topologie en étoile). Quand l'hôte est lui-même demandeur ou
// répondeur, ces messages sont traités directement en local (voir deliverToParticipant),
// sans aller-retour réseau inutile.

function clearUndoUiState() {
    undoRequestPending = false;
    pendingUndoAsk = null;
    clearTimeout(undoRequestTimeoutId);
    undoRequestTimeoutId = null;
    renderUndoControls();
    renderUndoAskBanner();
}

function setUndoStatus(text) {
    const el = document.getElementById('undoStatusText');
    if (el) el.textContent = text || '';
}

function renderUndoControls() {
    const btn = document.getElementById('requestUndoBtn');
    if (!btn) return;
    const visible = canControlBoard();
    btn.style.display = visible ? '' : 'none';
    btn.disabled = !visible || !deals || auctionHistory.length === 0 || undoRequestPending || !!pendingUndoAsk;
    // Deux <span> (voir index.html) plutôt qu'un textContent direct : .btn-label-full/
    // .btn-label-short sont affichés en alternance en CSS selon la largeur d'écran
    // (bouton complet sur desktop, abrégé sur mobile où la place manque).
    // Libellé différent pour l'hôte (voir échange avec Guillaume) : son undo s'applique
    // immédiatement, sans validation du camp d'en face (voir hostHandleUndoRequest) — "Faire
    // un undo" plutôt que "Demander", et jamais l'état intermédiaire "Demande envoyée..."
    // qui n'a pas de sens quand ça s'applique tout de suite.
    const isHost = myRole === 'host';
    const fullEl = btn.querySelector('.btn-label-full');
    const shortEl = btn.querySelector('.btn-label-short');
    if (isHost) {
        if (fullEl) fullEl.textContent = '↩️ Faire un undo';
        if (shortEl) shortEl.textContent = '↩️ Undo';
    } else {
        if (fullEl) fullEl.textContent = undoRequestPending ? '⏳ Demande envoyée...' : '↩️ Demander un undo';
        if (shortEl) shortEl.textContent = undoRequestPending ? '⏳ Envoyée...' : '↩️ Undo';
    }
}

function renderUndoAskBanner() {
    const banner = document.getElementById('undoAskBanner');
    if (!banner) return;
    if (!pendingUndoAsk) {
        banner.style.display = 'none';
        banner.innerHTML = '';
        return;
    }
    const name = escapeHtml(participantName(pendingUndoAsk.requesterId));
    banner.style.display = 'flex';
    banner.innerHTML = `
        <span>${name} demande à annuler la dernière annonce.</span>
        <button class="btn btn-success btn-small" onclick="uiAnswerUndo(true)">Accepter</button>
        <button class="btn btn-secondary btn-small" onclick="uiAnswerUndo(false)">Refuser</button>
    `;
}

function participantName(pid) {
    if (pid === 'host') return "L'hôte";
    const p = participants.find(x => x.id === pid);
    return p ? p.name : 'Un joueur';
}

function partnershipSeats(partnership) {
    return SEATS.filter(s => partnershipOf(s) === partnership);
}

function seatsOfParticipant(pid) {
    return SEATS.filter(seat => seatAssignment[seat] === pid);
}

// Détermine quelle entrée de l'historique une demande d'undo doit effectivement annuler :
// la dernière annonce parmi celles produites par UN des sièges que ce participant
// contrôle — pas forcément la toute dernière case du tableau, puisqu'un ou plusieurs
// robots ont pu passer automatiquement juste après (voir maybeRobotBid) si le joueur a
// mis un peu de temps à cliquer sur "undo". On renvoie alors l'index de SA dernière
// annonce ; applyUndoAsHost retirera cette annonce et tout ce qui a suivi (uniquement des
// passes robot, puisqu'aucun autre humain n'a pu jouer avant que ce ne soit à nouveau le
// tour de ce joueur).
// Renvoie -1 si ce participant n'a fait aucune annonce sur cette donne (rien à annuler).
//
// MÊME LOGIQUE pour l'hôte et les invités (voir échange avec Guillaume) : un ancien cas
// spécial pour 'host' renvoyait ici à tort la toute dernière case du tableau quel qu'en
// soit l'auteur — si un robot passait automatiquement juste après l'annonce de l'hôte
// (avant qu'il ait le temps de cliquer "undo"), l'hôte annulait alors CE PASSE ROBOT au
// lieu de sa propre annonce, ce qui faussait ensuite le calcul de qui doit valider
// (voir humanOpponentsFor) — l'inverse de ce qui devait se produire.
function findUndoTargetIndex(requesterId, history) {
    const seats = seatsOfParticipant(requesterId);
    for (let i = history.length - 1; i >= 0; i--) {
        if (seats.includes(history[i].seat)) return i;
    }
    return -1;
}

function guestIndexForParticipant(pid) {
    if (!pid || pid === 'host') return null;
    return Object.prototype.hasOwnProperty.call(guestIndexByToken, pid) ? guestIndexByToken[pid] : null;
}

// Participants humains "en face" du camp qui a fait l'annonce ciblée par l'undo, hors le
// demandeur — ce sont eux dont l'accord est requis pour annuler. `targetSeat` est le siège
// dont l'annonce va effectivement être retirée (voir findUndoTargetIndex), pas forcément
// le dernier siège de l'historique.
function humanOpponentsFor(requesterId, targetSeat) {
    const opposing = partnershipOf(targetSeat) === 'NS' ? partnershipSeats('EW') : partnershipSeats('NS');
    const ids = new Set();
    opposing.forEach(seat => {
        const pid = seatAssignment[seat];
        if (pid && pid !== requesterId) ids.add(pid);
    });
    return Array.from(ids);
}

function undoRejectReasonText(reason) {
    switch (reason) {
        case 'declined': return 'Annulation refusée.';
        case 'timeout': return "Personne n'a répondu à temps.";
        case 'busy': return 'Une autre demande est déjà en cours, réessayez.';
        case 'stale': return 'La situation a changé entre-temps, réessayez.';
        case 'nothing': return "Vous n'avez fait aucune annonce à annuler sur cette donne.";
        default: return "Impossible d'annuler pour le moment.";
    }
}

// Envoie `msg` à un participant donné — sans passer par le réseau si ce participant,
// c'est nous (l'hôte est toujours au centre de l'arbitrage, y compris pour lui-même).
function deliverToParticipant(pid, msg) {
    if (pid === myParticipantId) {
        if (msg.type === 'undo-ask') {
            pendingUndoAsk = msg;
            renderUndoAskBanner();
            renderUndoControls();
        } else if (msg.type === 'undo-rejected') {
            clearUndoUiState();
            setUndoStatus(undoRejectReasonText(msg.reason));
        }
        return;
    }
    const gi = guestIndexForParticipant(pid);
    if (gi != null) peerConn.send(msg, gi);
}

function uiRequestUndo() {
    if (!canControlBoard() || !deals || auctionHistory.length === 0) return;
    if (undoRequestPending || pendingUndoAsk) return;

    const msg = {
        type: 'undo-request',
        boardIndex,
        requesterId: myParticipantId,
        historyLengthAtRequest: auctionHistory.length
    };

    undoRequestPending = true;
    setUndoStatus('');
    renderUndoControls();

    clearTimeout(undoRequestTimeoutId);
    undoRequestTimeoutId = setTimeout(() => {
        if (undoRequestPending) {
            undoRequestPending = false;
            renderUndoControls();
            setUndoStatus("Personne n'a répondu à temps.");
        }
    }, 20000);

    if (myRole === 'host') {
        hostHandleUndoRequest(msg);
    } else {
        peerConn.send(msg);
    }
}

// (Hôte) Reçoit une demande d'annulation — la sienne, ou celle d'un invité relayée par
// handlePeerData — et décide si elle nécessite l'accord d'un adversaire humain.
function hostHandleUndoRequest(msg) {
    if (hostPendingUndo) {
        deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'busy' });
        return;
    }
    if (msg.boardIndex !== boardIndex || msg.historyLengthAtRequest !== auctionHistory.length) {
        deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'stale' });
        return;
    }

    const targetIndex = findUndoTargetIndex(msg.requesterId, auctionHistory);
    if (targetIndex < 0) {
        deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'nothing' });
        return;
    }
    const targetSeat = auctionHistory[targetIndex].seat;

    // L'hôte peut annuler unilatéralement, sans validation du camp d'en face (voir échange
    // avec Guillaume) — l'hôte arbitre déjà toute la table (undo d'un simple joueur assis
    // reste soumis à l'accord de l'adversaire humain, lui, via humanOpponentsFor plus bas).
    if (msg.requesterId === 'host') {
        applyUndoAsHost({ boardIndex: msg.boardIndex, requesterId: msg.requesterId, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex });
        return;
    }

    const opponents = humanOpponentsFor(msg.requesterId, targetSeat);
    if (opponents.length === 0) {
        applyUndoAsHost({ boardIndex: msg.boardIndex, requesterId: msg.requesterId, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex });
        return;
    }

    hostPendingUndo = { requesterId: msg.requesterId, boardIndex: msg.boardIndex, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex };

    const askMsg = {
        type: 'undo-ask',
        boardIndex: msg.boardIndex,
        requesterId: msg.requesterId,
        historyLengthAtRequest: msg.historyLengthAtRequest
    };
    opponents.forEach(pid => deliverToParticipant(pid, askMsg));

    setTimeout(() => {
        if (hostPendingUndo &&
            hostPendingUndo.requesterId === msg.requesterId &&
            hostPendingUndo.boardIndex === msg.boardIndex &&
            hostPendingUndo.historyLengthAtRequest === msg.historyLengthAtRequest) {
            hostPendingUndo = null;
            deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'timeout' });
        }
    }, 20000);
}

// (Hôte) Reçoit la réponse (accepté/refusé) d'un adversaire — la sienne, ou celle d'un
// invité relayée par handlePeerData. Seule la première réponse compte.
function hostReceiveUndoAnswer(msg) {
    if (!hostPendingUndo) return;
    if (msg.boardIndex !== hostPendingUndo.boardIndex || msg.historyLengthAtRequest !== hostPendingUndo.historyLengthAtRequest) return;

    const resolved = hostPendingUndo;
    hostPendingUndo = null;

    if (msg.approved) {
        applyUndoAsHost(resolved);
    } else {
        deliverToParticipant(resolved.requesterId, { type: 'undo-rejected', boardIndex: resolved.boardIndex, requesterId: resolved.requesterId, reason: 'declined' });
    }
}

// (Hôte) Applique effectivement l'annulation et la diffuse à tout le monde.
function applyUndoAsHost(pending) {
    if (pending.boardIndex !== boardIndex || pending.historyLengthAtRequest !== auctionHistory.length) {
        deliverToParticipant(pending.requesterId, { type: 'undo-rejected', boardIndex: pending.boardIndex, requesterId: pending.requesterId, reason: 'stale' });
        return;
    }
    // On retire l'annonce ciblée (la dernière de CE joueur — voir findUndoTargetIndex) et
    // tout ce qui l'a suivie (uniquement des passes robot dans ce cas, voir plus haut),
    // plutôt qu'un simple pop() de la toute dernière case du tableau.
    auctionHistory.length = pending.targetIndex;
    renderAuctionLedger();
    renderBiddingBox();
    renderMyHands();
    checkAuctionEnd();
    clearUndoUiState();
    peerConn.send({ type: 'undo-apply', boardIndex: pending.boardIndex, newLength: pending.targetIndex });
    maybeRobotBid(); // si l'annulation redonne la main à un siège robot, il doit rejouer
}

// Réponse de l'utilisateur au bandeau "on me demande d'annuler".
function uiAnswerUndo(approved) {
    const ask = pendingUndoAsk;
    if (!ask) return;
    pendingUndoAsk = null;
    renderUndoAskBanner();
    renderUndoControls();

    const answerMsg = {
        type: 'undo-answer',
        boardIndex: ask.boardIndex,
        requesterId: ask.requesterId,
        historyLengthAtRequest: ask.historyLengthAtRequest,
        approved
    };

    if (myRole === 'host') {
        hostReceiveUndoAnswer(answerMsg);
    } else {
        peerConn.send(answerMsg);
    }
}

function uiResetAuction() {
    if (!canControlBoard()) return;
    auctionHistory = [];
    deals[boardIndex].auctionHistory = auctionHistory; // reste la référence partagée
    hostPendingUndo = null;
    clearUndoUiState();
    renderAuctionLedger();
    renderBiddingBox();
    renderMyHands();
    checkAuctionEnd();
    peerConn.send({ type: 'reset-auction', boardIndex });
    maybeRobotBid(); // sans effet si on n'est pas l'hôte (voir maybeRobotBid) ; utile si le
                      // dealer (ou tout siège en tête d'enchère après reset) est un robot
}

// Change de donne : restaure l'enchère déjà jouée sur cette donne si on y était déjà
// passé (voir échange avec Guillaume — l'historique vit maintenant sur la donne
// elle-même, deals[i].auctionHistory, pas dans une simple variable de travail écrasée à
// chaque navigation), sinon en démarre une neuve. `auctionHistory` devient une RÉFÉRENCE
// vers ce tableau : tout push/pop ultérieur (voir applyCall, l'undo) se répercute
// automatiquement dessus, sans synchronisation supplémentaire à faire. Annule toute
// demande d'undo en cours, et diffuse le nouvel index à tout le monde. Partagé par le
// bouton "Donne suivante →" (accessible à tout joueur actif, uniquement une fois
// l'enchère terminée — voir checkAuctionEnd) et par les flèches ◀▶ de navigation libre,
// réservées à l'hôte.
function gotoBoard(newIndex) {
    boardIndex = newIndex;
    if (!deals[boardIndex].auctionHistory) deals[boardIndex].auctionHistory = [];
    auctionHistory = deals[boardIndex].auctionHistory;
    hostPendingUndo = null;
    clearUndoUiState();
    renderBoard();
    peerConn.send({ type: 'goto-board', boardIndex });
}

function uiNextBoard() {
    if (!canControlBoard()) return;
    if (boardIndex >= deals.length - 1) return;
    gotoBoard(boardIndex + 1);
}

// Navigation libre entre les donnes (avancer ou reculer, y compris en pleine enchère) :
// réservée à l'hôte, pour pouvoir sauter une donne sans attendre que l'enchère en cours
// se termine.
function uiHostSkipNextBoard() {
    if (myRole !== 'host' || !deals) return;
    if (boardIndex >= deals.length - 1) return;
    gotoBoard(boardIndex + 1);
}

function uiHostSkipPrevBoard() {
    if (myRole !== 'host' || !deals) return;
    if (boardIndex <= 0) return;
    gotoBoard(boardIndex - 1);
}

function renderBoardSkipControls() {
    const prevBtn = document.getElementById('prevBoardBtn');
    const nextBtn = document.getElementById('skipNextBoardBtn');
    if (!prevBtn || !nextBtn) return;
    const isHost = myRole === 'host';
    prevBtn.style.display = isHost ? '' : 'none';
    nextBtn.style.display = isHost ? '' : 'none';
    if (!isHost || !deals) return;
    prevBtn.disabled = boardIndex <= 0;
    nextBtn.disabled = boardIndex >= deals.length - 1;
}

// ===== PWA : service worker, installation iOS, hors-ligne =====
//
// Voir manifest.json + sw.js pour le reste. Le versioning des fichiers mis en cache
// (anciennement un paramètre `?v=NN` sur chaque <script>/<link> de index.html) est
// désormais géré par CACHE_NAME dans sw.js — à incrémenter là-bas à chaque déploiement
// qui touche un fichier mis en cache.

let pendingSwRegistration = null;

function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('sw.js').then((registration) => {
        // Un service worker déjà en attente (installé lors d'une visite précédente, jamais
        // activé faute de rechargement) : on tente de l'appliquer tout de suite, pas
        // seulement lors d'une future mise à jour détectée dans cette session.
        if (registration.waiting) {
            pendingSwRegistration = registration;
            tryAutoApplyUpdate();
        }

        registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                // 'installed' + un controller déjà actif = une mise à jour est prête et
                // attend ; sans controller actif, ce serait la toute première installation
                // du site, pas une mise à jour à appliquer.
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    pendingSwRegistration = registration;
                    tryAutoApplyUpdate();
                }
            });
        });

        // Revérifie explicitement toutes les 60s si une nouvelle version existe, plutôt que
        // de dépendre uniquement du cycle de vérification du navigateur (qui peut attendre
        // jusqu'à 24h avant de re-regarder sw.js) — sans ça, une page laissée ouverte
        // pouvait mettre très longtemps à seulement DÉTECTER un déploiement, avant même de
        // songer à l'appliquer.
        setInterval(() => registration.update(), 60000);
    }).catch((err) => {
        pushDebugLog('Service worker : échec d\'enregistrement — ' + (err && err.message));
    });

    // Une fois que le nouveau service worker prend effectivement le contrôle de la page
    // (après skipWaiting), recharger pour utiliser les nouveaux fichiers plutôt que ceux
    // encore en mémoire depuis avant la mise à jour. Protégé par un drapeau : cet
    // événement peut en théorie se déclencher plusieurs fois.
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadedForUpdate) return;
        reloadedForUpdate = true;
        window.location.reload();
    });

    // Filet de sécurité : si une mise à jour est détectée pendant qu'une connexion de salle
    // est active (voir tryAutoApplyUpdate ci-dessous), elle reste en attente sans jamais
    // relancer d'elle-même — ce sondage périodique retente régulièrement, pour l'appliquer
    // dès qu'on revient à un moment sûr (plus aucune salle active) sans dépendre uniquement
    // d'un changement d'écran pour s'en rendre compte.
    setInterval(tryAutoApplyUpdate, 30000);
}

// Voir échange avec Guillaume : plus de bannière "Nouvelle version disponible" à cliquer,
// la mise à jour s'applique automatiquement — SAUF s'il y a une connexion de salle active
// (peerConn non nul), qu'on soit hôte ou invité, dans le salon ou en pleine donne. Ne pas
// se limiter à "pas en pleine donne" (deals) : un rechargement forcé pendant que l'hôte est
// encore dans le salon le laisserait bloqué, sans façon de s'y reconnecter (voir la
// limitation déjà documentée dans le README — l'identifiant de connexion de l'hôte change à
// chaque nouvelle partie). Dans ce cas, retenté plus tard (voir les appels dans showScreen
// et le sondage périodique) : au pire, elle s'appliquera à la prochaine ouverture de la
// page, exactement comme avant, juste sans bouton à cliquer.
function tryAutoApplyUpdate() {
    if (!pendingSwRegistration || !pendingSwRegistration.waiting) return;
    if (peerConn) return;
    pendingSwRegistration.waiting.postMessage('skipWaiting');
}

// iPadOS se fait passer pour un Mac (navigator.platform "MacIntel") depuis la version 13 :
// le distinguer d'un vrai Mac se fait via le support tactile, qu'aucun Mac n'a.
function isIosDevice() {
    return (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandaloneDisplay() {
    return window.navigator.standalone === true
        || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}

const IOS_INSTALL_HINT_DISMISSED_KEY = 'bridgeBidIosInstallHintDismissed';

// Safari iOS ne propose aucune invite d'installation automatique (contrairement à Chrome
// Android) : sans ce message, un joueur sur iPhone n'a aucun moyen de découvrir que
// l'appli peut être ajoutée à l'écran d'accueil.
function initIosInstallHint() {
    if (!isIosDevice() || isStandaloneDisplay()) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(IOS_INSTALL_HINT_DISMISSED_KEY) === 'true'; } catch (e) { /* tant pis */ }
    if (dismissed) return;
    const banner = document.getElementById('iosInstallBanner');
    if (banner) banner.style.display = 'flex';
}

function uiDismissIosInstallHint() {
    document.getElementById('iosInstallBanner').style.display = 'none';
    try { localStorage.setItem(IOS_INSTALL_HINT_DISMISSED_KEY, 'true'); } catch (e) { /* tant pis */ }
}

const IOS_LOCK_WARNING_DISMISSED_KEY = 'bridgeBidIosLockWarningDismissed';

// iOS suspend les connexions WebRTC quand Safari passe en arrière-plan ou que l'écran se
// verrouille — une vraie limitation de la plateforme, pas un bug de l'appli. Affiché une
// fois sur l'écran d'accueil, mémorisé pour ne pas le réafficher à chaque visite.
function initIosLockScreenWarning() {
    if (!isIosDevice()) return;
    let dismissed = false;
    try { dismissed = localStorage.getItem(IOS_LOCK_WARNING_DISMISSED_KEY) === 'true'; } catch (e) { /* tant pis */ }
    if (dismissed) return;
    const note = document.getElementById('iosLockScreenWarning');
    if (note) note.style.display = 'block';
}

function uiDismissIosLockScreenWarning() {
    document.getElementById('iosLockScreenWarning').style.display = 'none';
    try { localStorage.setItem(IOS_LOCK_WARNING_DISMISSED_KEY, 'true'); } catch (e) { /* tant pis */ }
}

// Hors-ligne : la partie de l'appli qui a un sens sans réseau est proche de zéro (tout
// repose sur la connexion pair-à-pair), donc on se contente de désactiver clairement les
// deux points d'entrée plutôt que de laisser l'utilisateur découvrir l'échec au clic.
function updateOfflineUI() {
    const offline = !navigator.onLine;
    const banner = document.getElementById('offlineBanner');
    if (banner) banner.style.display = offline ? 'block' : 'none';
    const createBtn = document.getElementById('createRoomBtn');
    const joinBtn = document.getElementById('joinRoomBtn');
    if (createBtn) createBtn.disabled = offline;
    if (joinBtn) joinBtn.disabled = offline;
}

function initOfflineHandling() {
    updateOfflineUI();
    window.addEventListener('online', updateOfflineUI);
    window.addEventListener('offline', updateOfflineUI);
}

// ===== Initialisation =====

window.addEventListener('DOMContentLoaded', () => {
    initServiceWorker();
    initIosInstallHint();
    initIosLockScreenWarning();
    initOfflineHandling();
    initDealLibrary();

    // Rafraîchit uniquement le texte du décompte ("déconnecté depuis Xs") de la bannière
    // de reconnexion — pas besoin d'un message réseau pour ça, chaque client calcule son
    // propre écoulé à partir de disconnectedAt. Sans effet (sortie immédiate) hors partie
    // ou si la bannière n'est pas affichée, voir renderReconnectionBanner.
    setInterval(renderReconnectionBanner, 1000);

    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (room && navigator.onLine) {
        document.getElementById('joinCodeInput').value = room.toUpperCase();
        uiJoinRoom();
    } else if (room) {
        // Lien de partage ouvert hors-ligne : on préremplit le code, mais on ne tente pas
        // la connexion (updateOfflineUI, appelé juste au-dessus par initOfflineHandling,
        // a déjà désactivé le bouton "Rejoindre" — la personne devra réessayer une fois
        // reconnectée).
        document.getElementById('joinCodeInput').value = room.toUpperCase();
    }

    const dealFileInput = document.getElementById('dealFileInput');
    if (dealFileInput) {
        dealFileInput.addEventListener('change', uiHandleDealFileChosen);
    }
});
