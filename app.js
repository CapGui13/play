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

// Voir échange avec Guillaume (session asynchrone à deux) : troisième état possible pour
// seatAssignment[seat], en plus de null (robot, auto-passe) et de l'id d'un participant
// déjà connecté. 'PENDING' désigne un siège réservé à un futur partenaire qui n'est pas
// encore venu — contrairement à un robot, ce siège N'auto-passe JAMAIS (voir
// `!seatAssignment[seat]` un peu partout dans ce fichier pour calculer autoPassSeats :
// une chaîne non vide comme 'PENDING' y est déjà exclue naturellement, aucun changement
// nécessaire à ces endroits-là). Une fois que ce partenaire ouvre le lien de la salle et
// revendique ce siège (voir claimPendingSeat), la valeur est remplacée par son propre
// jeton de reconnexion, comme pour n'importe quel invité classique.
const SEAT_PENDING = 'PENDING';
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

let currentRoomCode = null; // pour uiReconnect() : on doit se souvenir du code utilisé pour rejoindre
// Voir échange avec Guillaume (session asynchrone à deux — "connexion en cours en
// boucle") : incrémenté à chaque connectAsGuest(), permet à un minuteur programmé par un
// essai précédent de se reconnaître périmé si un nouvel essai a pris le relais entre-temps.
let guestJoinAttemptToken = 0;
// Délai avant de tenter la reprise cloud EN PARALLÈLE de la tentative de connexion directe
// (voir connectAsGuest) — bien plus court que le délai d'abandon de 45s.
// Voir échange avec Guillaume ("je rejoins depuis mon PC et je me retrouve avec des
// privilèges d'hôte") : ancienne valeur (4000) beaucoup trop courte — une vraie connexion
// P2P live entre deux réseaux différents (ex. mobile en 4G qui héberge, PC en WiFi qui
// rejoint) peut légitimement prendre plusieurs secondes, surtout si un relais TURN est
// nécessaire (négociation ICE). Le minuteur se déclenchait alors AVANT que la connexion
// live n'aboutisse, et la reprise cloud prenait le relais à tort — passant l'invité en
// myRole='host' LOCALEMENT (voir uiResumeFromCloud : c'est voulu pour le jeu asynchrone,
// où n'importe qui doit pouvoir naviguer les donnes, mais ça donne exactement les mêmes
// privilèges d'affichage que le vrai hôte, dont la réorganisation des sièges — puisque
// toute l'interface se base uniquement sur myRole==='host'). 12s laisse une large marge à
// une connexion live normale, y compris avec relais TURN, tout en restant nettement plus
// rapide que 45s pour le cas légitime visé à l'origine (salle vraiment vide/expirée).
const EARLY_CLOUD_CHECK_DELAY_MS = 12000;
// Voir uiCreateRoom : nom du créateur d'origine, figé une fois pour toutes (jamais
// réécrit par une reprise ou un transfert d'hôte) — voir renderGameHeader pour l'affichage.
let roomCreatorName = null;
// Idem pour son jeton de reconnexion — sert UNIQUEMENT à reconnaître le créateur d'origine
// quand il revient via uiResumeFromCloud (voir échange avec Guillaume — "on n'est plus
// obligé de passer par le P2P") : ses sièges peuvent encore être étiquetés littéralement
// 'host' (reliquat de sa session live d'origine), et c'est ce jeton qui permet de les
// migrer vers son vrai jeton dès son premier retour asynchrone.
let roomCreatorToken = null;

// Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4 — nettoyage) : la reprise automatique
// d'hôte par un sous-hôte (élection d'un nouvel hôte P2P en cas de coupure prolongée,
// session du 23 juillet) a été retirée — superflue maintenant que chaque siège route
// individuellement vers le relais serveur en cas de coupure (voir étape 3), sans jamais
// changer qui est l'hôte. C'était aussi la source de la quasi-totalité des bugs de
// reconnexion rencontrés cette session (transfert d'hôte incohérent, double hôte,
// retour de l'hôte original non reconnu...).
//
// currentHostReconnectToken reste : le jeton de reconnexion de l'hôte ACTUEL (qui ne
// change plus jamais en cours de partie) — utile pour qu'un invité sache identifier
// correctement l'hôte dans ses propres échanges avec le serveur (voir
// buildCloudStatePayload), reçu via 'lobby-state'/'start-game'/'resync' comme avant.
let currentHostReconnectToken = null;
// Voir échange avec Guillaume (session du 23 juillet — "un compteur qui défile") :
// horodatage de NOTRE PROPRE déconnexion détectée — sert à afficher un compteur qui
// défile dans la bannière de reconnexion (voir renderReconnectionBanner), pour rendre
// visible ce qui se passe pendant l'attente plutôt que de laisser un message statique
// sans aucune indication de progression.
let selfDisconnectedAt = null;

// Voir échange avec Guillaume ("je rouvre la fenêtre de l'hôte bien avant 20s, mais
// l'invité bascule en 'prise de relais' comme si rien n'avait changé") : la reconnexion
// d'un INVITÉ n'a jamais été qu'un clic manuel sur "Se reconnecter" (uiReconnect) — rouvrir
// la fenêtre de l'hôte, même immédiatement, ne change donc RIEN tout seul côté invité sans
// ce minuteur. Retente silencieusement une reconnexion en tâche de fond pendant qu'un
// invité reste déconnecté — annulé dès qu'onGuestConnected réussit (voir
// buildGuestHandlers), donc sans effet une fois reconnecté.
let guestAutoReconnectTimer = null;
const GUEST_AUTO_RECONNECT_INTERVAL_MS = 4000;

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

// Voir échange avec Guillaume ("je ne peux pas désactiver voir les 4 mains") : le VRAI
// créateur de la salle (celui qui a lancé la séance), peu importe live ('host', jamais
// réécrit) ou différé (roomCreatorToken, le jeton figé à la création) — PAS simplement
// "myRole === 'host'", qui en mode différé peut aussi désigner n'importe quel joueur
// ayant repris une salle abandonnée (voir uiResumeFromCloud, où myRole='host' sert
// uniquement à accorder le contrôle local, pas une identité). Même critère déjà utilisé
// pour l'arbitrage d'undo (voir hostHandleUndoRequest) — factorisé ici pour être
// réutilisé partout où ce privilège du VRAI hôte (pas d'un simple contrôleur technique)
// doit être vérifié, comme "voir les 4 mains".
function isTrueOriginalHost() {
    return myParticipantId === 'host' || myParticipantId === roomCreatorToken;
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

// Voir échange avec Guillaume (session du 8 août — "je voudrais que sa couleur d'avatar
// [soit persistante]... qu'il récupère automatiquement la dernière couleur utilisée à
// chaque nouvelle connexion") : même principe exact que savedNickname ci-dessus — propre
// à l'appareil, survit d'une partie à l'autre. null si jamais choisie : on retombe alors
// sur la couleur dérivée par hachage (avatarColorForId) comme avant.
let savedAvatarColor = loadStringPref('bridgeBidAvatarColor', null);

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
    if (deals) {
        renderAuctionLedger();
        // Voir échange avec Guillaume : le diagramme des 4 mains (buildAllHandsHtml)
        // utilise désormais la même préférence (ledgerSeatLabel) que l'en-tête du tableau
        // d'enchères — sans ce re-rendu, il fallait attendre un tour d'enchère ou un autre
        // changement d'option pour que la bascule s'y reflète.
        renderAllHandsDiagram();
    }
}

// Réservé à l'hôte QUI N'OCCUPE AUCUN SIÈGE (mode "maître du jeu" à 3, voir isKibbitz) :
// révèle les 4 mains à tout moment pendant la partie, même en pleine enchère (utile pour
// vérifier une donne, aider un débutant en direct, etc.). Purement local — jamais envoyé
// aux autres joueurs, qui ne voient toujours que ce qu'ils sont censés voir.
//
// Voir échange avec Guillaume : PRIVILÈGE DU VRAI HÔTE (voir isTrueOriginalHost), pas
// seulement d'un hôte spectateur — un hôte qui joue lui-même une main (ex. donner un
// cours) doit pouvoir l'activer pour tout voir. Mais "myRole==='host'" seul ne suffit
// pas non plus (voir isTrueOriginalHost) : depuis la reprise cloud (uiResumeFromCloud),
// celui qui reprend une salle différée abandonnée devient 'host' techniquement tout en
// étant un joueur ordinaire assis à un vrai siège — lui laisser ce privilège reviendrait
// à le laisser tricher sur sa propre main.
function uiToggleHostSeeAllHands() {
    if (!isTrueOriginalHost()) return;
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
        // Voir échange avec Guillaume : ce bouton est un PRIVILÈGE DU VRAI HÔTE (voir
        // isTrueOriginalHost), pas seulement d'un hôte spectateur — un kibbitz voit déjà
        // les 4 mains en permanence par défaut, il n'a jamais besoin de ce bouton. Un
        // hôte qui joue lui-même une main doit pouvoir l'activer (donner un cours) — mais
        // "myRole==='host'" seul est TROP LARGE en mode différé (voir
        // isTrueOriginalHost) : n'importe quel joueur reprenant une salle abandonnée
        // devient 'host' techniquement, sans être le vrai créateur/organisateur.
        hostSeeAllBtn.style.display = isTrueOriginalHost() ? '' : 'none';
        hostSeeAllBtn.classList.toggle('is-active', hostSeeAllHands);
    }
}
let deals = null;           // tableau de donnes parsées
let boardIndex = 0;
let auctionHistory = [];    // historique de la donne en cours : [{seat, call}, ...]

// (Hôte) Résultat du fichier de donnes déjà lu et parsé au moment où il a été choisi (voir
// uiHandleDealFileChosen), pour afficher tout de suite une éventuelle erreur — pendant que
// l'hôte compose encore la table, PAS au moment de cliquer sur "Commencer la partie",
// puisqu'à cet instant l'écran du salon (et donc le message) disparaît immédiatement avec
// le passage à l'écran de jeu.
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

    const generated = generateRandomDeals(count, seatAssignment, constraints);
    pendingParsedSource = 'random';
    pendingParsedDeals = generated;
    refreshPendingOrderedDeals();

    // rien à prévisualiser pour du random (voir uiPreviewDeals) : bandeau vert sans son
    // bouton Prévisualiser.
    setDealStatusReady(`✅ ${count} donne${count > 1 ? 's' : ''} générée${count > 1 ? 's' : ''}`, false);

    // Voir échange avec Guillaume : avec des contraintes très serrées (plusieurs fourchettes
    // étroites simultanées), certaines donnes peuvent ne pas les satisfaire même après
    // RANDOM_DEAL_MAX_RETRIES tentatives (voir generateRandomDeal) — mieux vaut prévenir que
    // de laisser croire que toutes les donnes générées les respectent silencieusement. Voir
    // échange avec Guillaume (session du 23 juillet) : plus de mention du PAR ici — le
    // calcul du double mort en arrière-plan (voir kickOffBackgroundDD) tourne
    // systématiquement, plus la peine de le signaler.
    const unmetCount = generated.filter(d => d.constraintsUnmet).length;
    if (unmetCount > 0) {
        setHostSetupMessage(
            `${unmetCount} donne(s) n'ont pas pu satisfaire toutes les contraintes malgré ${RANDOM_DEAL_MAX_RETRIES} tentatives — essayez des fourchettes moins serrées.`,
            true
        );
    } else {
        clearHostSetupMessage();
    }

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
    scheduleDDWatchdog(dealsList, generationId);
}

// Voir échange avec Guillaume (session du 8 août — "des fois il ne se lance juste pas,
// il faudrait un garde-fou pour check au bout d'un moment et relancer si ça a merdé") :
// filet de sécurité GÉNÉRAL, indépendant des points de reprise existants (host-reconnect,
// reprise cloud — qui ne retentent QUE lors d'un événement précis, jamais pendant qu'on
// reste sur place à attendre). Après un délai généreux (largement au-dessus du temps
// normal de calcul, tentatives internes de sendDDChunk comprises), si des donnes de CE
// lot précis manquent encore ET qu'aucun lot plus récent n'a pris le relais entre-temps
// (voir ddResultGenerationId), on retente automatiquement — une seule fois par lot
// initial (pas de rappel récursif à ce garde-fou lui-même), pour ne jamais boucler à
// l'infini si le problème est persistant plutôt qu'un aléa ponctuel.
const DD_WATCHDOG_DELAY_MS = 20000;

function scheduleDDWatchdog(dealsList, generationId) {
    setTimeout(() => {
        if (generationId !== ddResultGenerationId) return; // un lot plus récent a déjà pris le relais
        const pool = deals || pendingParsedDeals;
        if (!pool) return;
        const stillMissing = dealsList.filter(d => {
            const current = pool.find(p => p.board === d.board);
            return current && !current.par && !current.ddTable;
        });
        if (stillMissing.length === 0) return;
        pushDebugLog(`Double mort : ${stillMissing.length} donne(s) toujours sans résultat après le délai de sécurité (${DD_WATCHDOG_DELAY_MS / 1000}s) — nouvelle tentative automatique.`);
        for (let i = 0; i < stillMissing.length; i += RANDOM_DEAL_DD_CHUNK_SIZE) {
            sendDDChunk(stillMissing.slice(i, i + RANDOM_DEAL_DD_CHUNK_SIZE), generationId);
        }
    }, DD_WATCHDOG_DELAY_MS);
}

// Voir échange avec Guillaume (session du 23 juillet — "une donne au milieu sans PAR
// calculé") : borne le nombre de fois où une même donne peut être retentée, pour éviter
// une boucle infinie si son calcul échoue systématiquement (distribution pathologique
// pour le solveur, pas un simple aléa ponctuel) — 2 tentatives suffisent largement pour
// absorber un timeout isolé côté serveur, sans s'acharner indéfiniment sur un cas
// réellement bloqué.
const DD_MAX_RETRIES_PER_DEAL = 2;
const DD_RETRY_DELAY_MS = 1500;

async function sendDDChunk(chunk, generationId, retryCount = 0) {
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

        // Voir échange avec Guillaume : un résultat sans `table` (voir applyDDResultToBoard,
        // qui ignore silencieusement ce cas) signifie très probablement un timeout ponctuel
        // du solveur côté serveur sur CETTE distribution précise — les autres donnes du même
        // lot, elles, ont bien abouti. On les identifie ici pour les retenter isolément,
        // plutôt que de les laisser filer sans PAR pour le reste de la partie.
        const succeededIds = new Set();
        for (const r of data.results) {
            if (r.table) {
                applyDDResultToBoard(r.id, r.table);
                succeededIds.add(r.id);
            }
        }
        const missingDeals = chunk.filter(d => !succeededIds.has(d.board));
        if (missingDeals.length > 0 && retryCount < DD_MAX_RETRIES_PER_DEAL) {
            pushDebugLog(`Double mort : ${missingDeals.length} donne(s) sans résultat dans ce lot — nouvelle tentative (${retryCount + 1}/${DD_MAX_RETRIES_PER_DEAL})…`);
            setTimeout(() => sendDDChunk(missingDeals, generationId, retryCount + 1), DD_RETRY_DELAY_MS);
        } else if (missingDeals.length > 0) {
            pushDebugLog(`Double mort : ${missingDeals.length} donne(s) toujours sans résultat après ${DD_MAX_RETRIES_PER_DEAL} tentatives — abandon pour elles (le reste de la partie n'est pas affecté).`);
        }
    } catch (err) {
        // Échec COMPLET du lot (réseau, erreur HTTP...) — même logique de retry borné que
        // pour un résultat partiel ci-dessus, plutôt que d'abandonner tout de suite sur un
        // aléa réseau transitoire.
        if (retryCount < DD_MAX_RETRIES_PER_DEAL) {
            pushDebugLog(`Double mort en arrière-plan : échec pour un lot (${(err && err.message) || err}) — nouvelle tentative (${retryCount + 1}/${DD_MAX_RETRIES_PER_DEAL})…`);
            setTimeout(() => sendDDChunk(chunk, generationId, retryCount + 1), DD_RETRY_DELAY_MS);
        } else {
            // Échec silencieux du point de vue du joueur : pas de PAR pour ce lot, mais la
            // partie elle-même n'est pas affectée (voir échange avec Guillaume — le calcul
            // DD est un bonus, jamais un prérequis pour jouer). Tracé dans le journal de
            // diagnostic pour comprendre après coup si ça arrive souvent.
            pushDebugLog(`Double mort en arrière-plan : échec définitif pour un lot après ${DD_MAX_RETRIES_PER_DEAL} tentatives (${(err && err.message) || err})`);
        }
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
    // participant a choisi une couleur (au clic, ou reprise automatiquement depuis
    // savedAvatarColor à la connexion — voir échange du 8 août, "qu'il récupère
    // automatiquement la dernière couleur utilisée"), elle prime sur le calcul
    // déterministe ci-dessous.
    const p = participants.find(x => x.id === id);
    if (p && p.avatarColor) return p.avatarColor;

    // Repli pour un participant SANS préférence sauvegardée (jamais choisi de couleur
    // sur cet appareil) : mélange le code de salon dans le hash (pas l'id seul) — une
    // couleur différente à chaque nouvelle partie plutôt qu'une "couleur de signature"
    // fixe, mais stable pendant toute la durée d'UNE partie, y compris après une
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
    // Voir échange avec Guillaume (session du 23 juillet — "ça m'ouvre la page à mi
    // hauteur") : sans ça, le nouvel écran hérite de la position de défilement de
    // l'ancien — s'ils n'ont pas la même hauteur de contenu à cet endroit précis, on
    // atterrit au milieu de nulle part plutôt qu'en haut.
    window.scrollTo(0, 0);
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

// Voir échange avec Guillaume ("Report a bug" — récupérer le journal à la main sur
// téléphone est galère, même avec le panneau de diagnostic visible : sélectionner du texte
// dans une popup, changer d'appli, coller... trop d'étapes en pleine partie) : ce bouton
// récupère tout SANS jamais avoir besoin d'ouvrir ce panneau, avec le contexte utile
// (salle, rôle, sièges, navigateur) déjà inclus — plus la peine de demander "et t'étais
// hôte ou invité ?" en plus du journal lui-même.

function buildBugReportText(maxLogChars) {
    const lines = [
        `Salle : ${currentRoomCode || '(aucune)'}`,
        `Rôle : ${myRole || '(aucun)'}`,
        `Sièges : ${(mySeats && mySeats.length) ? mySeats.join(', ') : '(aucun)'}`,
        `Heure : ${new Date().toLocaleString('fr-FR')}`,
        `Navigateur : ${navigator.userAgent}`,
        '',
        '--- Journal ---'
    ];

    let log = debugLogLines.join('\n');
    // Voir plus bas (uiReportBug) : maxLogChars diffère selon le canal — généreux pour le
    // partage natif (pas de limite de longueur d'URL), plus serré pour mailto:, qui reste
    // fiable seulement en dessous de quelques milliers de caractères sur pas mal de clients
    // mail mobiles. On garde la FIN du journal (slice négatif) : c'est l'événement le plus
    // récent — donc le plus probablement en cause — qui compte le plus en cas de troncature.
    if (log.length > maxLogChars) {
        log = `[…tronqué, ${debugLogLines.length} lignes au total, voir la fin…]\n` + log.slice(-maxLogChars);
    }
    lines.push(log || '(journal vide — le panneau de diagnostic n\'a peut-être pas été ouvert pendant la session)');

    return lines.join('\n');
}

function uiReportBug() {
    const subject = `Bug — Table d'enchères (salle ${currentRoomCode || '?'})`;

    // Voir échange avec Guillaume ("le bouton bug ouvre le partage natif de Windows sur
    // PC") : isMobileOrTabletDevice() en plus de navigator.share — la seule présence de
    // l'API ne suffit pas à distinguer mobile de desktop (voir son commentaire plus haut).
    if (isMobileOrTabletDevice() && navigator.share) {
        const text = buildBugReportText(20000);
        navigator.share({ title: subject, text }).catch(() => {
            // Annulé par l'utilisateur (ou échec silencieux) : la feuille de partage s'est
            // quand même affichée, rien à faire de plus ici — pas de repli automatique sur
            // la copie presse-papiers qui rouvrirait une seconde interface sans que ça ait
            // été demandé.
        });
        return;
    }

    // Voir échange avec Guillaume ("sur desktop, je voudrais que ça copie juste les logs,
    // comme ça j'ai qu'à cliquer et te le copier/coller") : plus de mailto: ici — sur PC,
    // le rapport part directement dans le presse-papiers, prêt à coller où il veut (chat
    // Claude, Slack, peu importe), sans ouvrir un client mail. Pas de limite de longueur à
    // respecter ici non plus (aucune URL impliquée), même généreux que le partage natif.
    const text = buildBugReportText(20000);
    const toastEl = () => {
        let toast = document.getElementById('bugReportToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'bugReportToast';
            toast.className = 'call-explanation-toast'; // même style que les autres toasts, réutilisé tel quel
            document.body.appendChild(toast);
        }
        return toast;
    };
    const flash = (msg) => {
        const toast = toastEl();
        toast.textContent = msg;
        toast.classList.remove('visible');
        void toast.offsetWidth;
        toast.classList.add('visible');
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 2800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => flash('📋 Rapport copié — colle-le où tu veux.'))
            .catch(() => fallbackCopyBugReport(text, flash));
    } else {
        fallbackCopyBugReport(text, flash);
    }
}

// Repli pour les navigateurs sans l'API Clipboard moderne (ou qui la refusent, ex. contexte
// non sécurisé) : même mécanique que fallbackCopyDebugLog (sélection + execCommand), mais
// via un <textarea> temporaire plutôt que le panneau de diagnostic — ce dernier n'est pas
// forcément ouvert (ni même présent dans le DOM avec du contenu à jour) au moment du clic
// sur 🐞.
function fallbackCopyBugReport(text, onDone) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        onDone('📋 Rapport copié — colle-le où tu veux.');
    } catch (e) {
        onDone('❌ Échec de la copie — réessaie.');
    }
    document.body.removeChild(ta);
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
    // Voir échange avec Guillaume (session du 8 août — "multi room") : on ne touche plus
    // aux sauvegardes existantes ici — créer une nouvelle partie n'a plus de raison
    // d'effacer les AUTRES salles encore reprenables (ancien comportement mono-salle).
    // On masque juste la bannière pour la durée de la création, purement visuel.
    const resumeBanner = document.getElementById('resumeSessionBanner');
    if (resumeBanner) resumeBanner.style.display = 'none';

    myRole = 'host';
    myParticipantId = 'host';
    participants = [{ id: 'host', name: savedNickname || 'Hôte', ...(savedAvatarColor ? { avatarColor: savedAvatarColor } : {}) }];
    // Voir échange avec Guillaume (session asynchrone à deux — "je ne veux pas de bascule
    // d'hôte") : figé une seule fois, ici, à la création — jamais réécrit ensuite, y
    // compris par une reprise cloud ou un transfert d'hôte manuel (voir uiResumeFromCloud). L'affichage "Hôte : X" (voir renderGameHeader) utilise TOUJOURS
    // cette valeur plutôt que le participant technique 'host' du moment — qui, lui,
    // continue de basculer en coulisses (nécessaire pour que d'autres puissent encore se
    // connecter au même code), mais ne doit plus jamais se voir.
    roomCreatorName = savedNickname || 'Hôte';
    roomCreatorToken = getReconnectToken();
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
    clearHostSetupMessage();
    setDealStatusEmpty();

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
            // Voir échange avec Guillaume (session du 23 juillet) : reflète le code dans
            // la barre d'adresse elle-même, pas seulement dans le champ "lien de
            // connexion" caché — replaceState (pas pushState) pour ne pas empiler une
            // entrée d'historique de navigateur à chaque partie créée, sans recharger la
            // page (juste l'URL affichée qui change).
            // Voir échange avec Guillaume (session du 23 juillet) : sans ça, le statut
            // restait sur son dernier état affiché (ex. "🔴 Déconnecté" après une coupure)
            // jusqu'à ce qu'un premier invité se connecte (seul endroit qui l'appelait
            // jusqu'ici) — ne se voyait pas à la création initiale (rien à rafraîchir),
            // mais devenait trompeur après une reconnexion (manuelle ou automatique via
            // peer.reconnect()) tant que personne ne rejoignait entre-temps.
            setConnectionStatus(true);
            renderReconnectButton();
            // Voir échange avec Guillaume (session du 23 juillet) : succès (par n'importe
            // quelle voie — reconnexion légère ou réinitialisation complète, voir
            // uiHostReconnect) — plus besoin du watchdog qui basculerait sinon vers une
            // réinitialisation complète pour rien.
            clearTimeout(hostReconnectWatchdogTimer);
            window.history.replaceState(null, '', url.toString());
            if (onOpenExtra) {
                onOpenExtra(roomCode);
            } else if (deals) {
                // Voir échange avec Guillaume (session du 23 juillet — "ça me renvoie
                // dans le salon" après une mise en arrière-plan sur iPhone) : ce handler
                // se redéclenche à CHAQUE réouverture du Peer, pas seulement à la toute
                // première création — y compris une reconnexion AUTOMATIQUE
                // (peer.reconnect(), voir peer-connection.js) après une simple coupure
                // réseau en pleine partie. Sans ce garde-fou, enterLobbyScreen() était
                // appelée à chaque fois, arrachant l'hôte de sa partie en cours pour le
                // renvoyer au salon, alors que rien n'avait été perdu (deals intact).
                renderBoard();
            } else {
                enterLobbyScreen();
            }
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
                // le jeton de reconnexion. Même principe pour la couleur d'avatar (voir
                // échange avec Guillaume, session du 8 août — "qu'il récupère
                // automatiquement la dernière couleur utilisée").
                const nickname = metadata && metadata.nickname;
                const avatarColorFromMeta = metadata && metadata.avatarColor;
                p = { id: token, name: nickname || defaultParticipantName(token), disconnected: false, disconnectedAt: null };
                if (avatarColorFromMeta) p.avatarColor = avatarColorFromMeta;
                participants.push(p);
                // Voir échange avec Guillaume (session asynchrone à deux — "il faut lui
                // attribuer un siège") : un nouvel arrivant qui trouve un siège encore
                // SEAT_PENDING le revendique automatiquement, ici même, à la connexion —
                // sans ça, il fallait que l'hôte soit PRÉSENT au moment précis où son
                // partenaire se connecte pour l'y placer à la main, ce qui annulait tout
                // l'intérêt de pouvoir jouer en différé. Couvre à la fois le cas où l'hôte
                // est encore en ligne à ce moment-là ET la reprise cloud (uiResumeFromCloud
                // fait la même chose pour SA propre connexion, mais un autre participant qui
                // arriverait ensuite passe forcément par ici).
                const pendingSeat = SEATS.find(seat => seatAssignment[seat] === SEAT_PENDING);
                if (pendingSeat) {
                    seatAssignment[pendingSeat] = token;
                    autoPassSeats = SEATS.filter(seat => !seatAssignment[seat]);
                    pushDebugLog(`Siège ${pendingSeat} en attente → attribué automatiquement à ${p.name} (${token.slice(0, 10)}…).`);
                }
            } else {
                p.disconnected = false;
                p.disconnectedAt = null;
            }
            pushDebugLog(`Connexion #${guestIndex} : jeton ${token.slice(0, 10)}… → ${isReturning ? 'reconnexion reconnue (' + p.name + ')' : 'nouveau participant'}`);
            // Voir échange avec Guillaume (session du 23 juillet — "un bandeau similaire
            // à celui du wizz") : remplace flashWelcomeBack, même mécanique de toast que
            // le wizz (voir styles.css), texte simplifié avec le siège si assis.
            if (wasDisconnected) flashPresenceToast(`✅ ${presenceLabelFor(p)} s'est reconnecté`, true);

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
                    botSeats: autoPassSeats,
                    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : jeton de l'hôte
                    // actuel, toujours utile pour qu'un invité identifie correctement
                    // l'hôte dans ses propres échanges avec le serveur (voir
                    // buildCloudStatePayload) — subHostId, lui, a disparu (plus
                    // d'élection de sous-hôte).
                    hostReconnectToken: getReconnectToken(),
                    roomCreatorName,
                    // Voir échange avec Guillaume (session du 23 juillet) : permet au client
                    // de distinguer un tout nouveau participant d'un simple retour de coupure
                    // (isReturning), pour n'ouvrir le chat automatiquement que dans le premier
                    // cas — voir le handler 'resync' côté invité.
                    isNewJoiner: !isReturning
                }, guestIndex);
            }

            broadcastLobbyState();
            renderLobby();
            if (deals) {
                renderBoard();
                saveHostGameStateToStorage();
            }
        },
        onPeerDisconnected: (guestIndex) => {
            // Voir échange avec Guillaume (session du 23 juillet — même souci que
            // renderReconnectButton juste au-dessus) : signalingOpen (notre propre
            // connexion), pas isConnected() — sinon le statut passait à tort à "🔴
            // Déconnecté" dès que le DERNIER invité encore connecté se déconnectait, même
            // si notre propre lien au serveur de signalisation reste parfaitement sain.
            setConnectionStatus(peerConn ? peerConn.signalingOpen : false);
            renderReconnectButton();
            const token = tokenForGuestIndex(guestIndex);
            if (token) {
                delete guestIndexByToken[token];
                // On NE supprime pas le participant ni son siège : ils restent réservés, en
                // attente qu'il se reconnecte. Son siège n'est PAS remplacé par un robot —
                // l'enchère patiente simplement (le tour-indicateur et la bannière de
                // reconnexion le signalent tous les deux, cf. renderReconnectionBanner).
                const p = participants.find(x => x.id === token);
                if (p) {
                    p.disconnected = true;
                    p.disconnectedAt = Date.now();
                    // Voir échange avec Guillaume (session du 23 juillet) : n'intéresse
                    // que les joueurs ASSIS (un kibitz déconnecté ne bloque rien pour
                    // personne — même restriction que l'ancienne bannière "waiting").
                    if (SEATS.some(s => seatAssignment[s] === p.id)) {
                        flashPresenceToast(`🔌 ${presenceLabelFor(p)} s'est déconnecté`, false);
                    }
                }
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
            renderReconnectButton();
        },
        onError: (err) => {
            // Voir échange avec Guillaume (session du 23 juillet — "ça m'a fait
            // redevenir invité à tort") : PAS de bascule automatique en invité ici.
            // 'unavailable-id' peut arriver sur un simple peer.reconnect() automatique
            // (voir peer-connection.js) SANS qu'aucun sous-hôte n'ait réellement pris le
            // relais — ambiguïté entre "quelqu'un d'autre a vraiment ce code" et "notre
            // propre ancienne session traîne encore, non nettoyée côté serveur PeerJS".
            // Cette bascule ne se déclenche maintenant QUE dans le filet de sécurité de
            // uiHostReconnect, après une réinitialisation complète (destroy + nouvelle
            // tentative) qui lève cette ambiguïté — voir son commentaire détaillé.
            // Pendant ce temps, le statut/bouton (déjà mis à jour par
            // onSignalingDisconnected) restent la seule indication ; rien d'autre à
            // afficher ici tant qu'on est en pleine partie (l'écran d'accueil, où
            // atterrirait ce message, n'est de toute façon pas visible).
            if (deals) return;
            hideConnectingOverlay();
            showLandingError('Erreur de connexion : ' + ((err && (err.message || err.type)) || err));
        }
    };
}

// Construit les handlers PeerJS côté invité — partagés entre uiJoinRoom (première
// connexion) et uiReconnect (après une coupure), pour ne pas dupliquer la logique.
function buildGuestHandlers() {
    // Voir connectAsGuest : capture la valeur au moment de la création de CES handlers,
    // pour que onError/onTimeout puissent reconnaître un essai devenu périmé (un nouveau
    // connectAsGuest() ayant démarré entre-temps) et ne pas dupliquer une bascule cloud
    // déjà déclenchée par ailleurs (voir le setTimeout de vérification en parallèle).
    const myAttemptToken = guestJoinAttemptToken;
    return {
        onOpen: (role, roomCode) => {
            document.getElementById('lobbyRoomCodeInline').textContent = `(code ${roomCode})`;
            // Voir échange avec Guillaume (session du 23 juillet) : même correctif que
            // côté hôte — la barre d'adresse ne reflétait jusqu'ici jamais le code de
            // salle, y compris en rejoignant via un code tapé à la main (pas via un lien
            // de partage qui l'aurait déjà dans l'URL).
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomCode);
            window.history.replaceState(null, '', url.toString());
            // Voir échange avec Guillaume (session du 8 août — "le lien à copier devrait
            // apparaître même pour un non hôte") : shareLinkInput n'était rempli QUE côté
            // hôte (buildHostHandlers) — le bouton copier-lien était donc désormais
            // visible pour tous, mais copiait une chaîne vide côté invité. Même URL déjà
            // construite juste au-dessus, réutilisée ici.
            document.getElementById('shareLinkInput').value = url.toString();
        },
        onGuestConnected: () => {
            hideConnectingOverlay();
            everConnectedAsGuest = true;
            setConnectionStatus(true);
            renderReconnectButton();
            // Voir échange avec Guillaume ("si un joueur avait déjà été dans une
            // session, on ne doit pas lui redemander [son pseudo]") : marqué à CHAQUE
            // connexion réussie (premier join comme reconnexion), pas seulement une
            // fois — pour que le TTL (voir GUEST_ACTIVE_ROOM_TTL_MS) reste glissant
            // tant que la session est vraiment active, plutôt que de figer une seule
            // estampille au tout premier join.
            markGuestActiveRoom(currentRoomCode);
            // Voir échange avec Guillaume ("l'invité ne se reconnecte jamais tout seul") :
            // annule le cycle de reconnexion automatique en arrière-plan (voir
            // scheduleGuestAutoReconnect) — plus la peine une fois vraiment reconnecté.
            cancelGuestAutoReconnectTimer();
            // Voir échange avec Guillaume (session du 23 juillet — "on fait idem pour
            // l'host") : toast vert AVANT de réinitialiser selfDisconnectedAt — il faut
            // encore savoir qu'on ÉTAIT déconnecté pour décider d'afficher ce toast (pas
            // au tout premier succès de connexion, où il n'y a rien à "reconnecter").
            if (deals && selfDisconnectedAt) flashPresenceToast('✅ Reconnecté à la partie', true);
            selfDisconnectedAt = null;
            // Dégèle la boîte d'enchères tout de suite (voir renderBiddingBox) — sans
            // ça, il faudrait attendre le prochain événement de jeu pour que ça se voie.
            if (deals) renderBoard();
        },
        onPeerDisconnected: () => {
            setConnectionStatus(false);
            // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : scheduleSubHostTakeoverIfNeeded
            // a disparu d'ici (plus d'élection de sous-hôte) — seule reste la reconnexion
            // automatique en arrière-plan (voir scheduleGuestAutoReconnect), qui
            // concernait déjà TOUT invité déconnecté, pas seulement un sous-hôte désigné.
            scheduleGuestAutoReconnect();
            renderReconnectButton();
            // Voir échange avec Guillaume (session du 23 juillet — compteur qui défile) :
            // posé seulement s'il ne l'était pas déjà — sinon un second événement de
            // coupure pendant qu'on est déjà déconnecté repousserait le départ du
            // compteur à chaque fois. Le toast ne part qu'à ce moment précis (première
            // détection), jamais répété pour les tentatives suivantes tant qu'on reste
            // déconnecté.
            if (!selfDisconnectedAt) {
                selfDisconnectedAt = Date.now();
                if (deals) flashPresenceToast("🔌 Connexion à l'hôte perdue", false);
            }
            // Gèle la boîte d'enchères tout de suite (voir renderBiddingBox), pas
            // seulement au prochain événement de jeu.
            if (deals) renderBoard();
        },
        // Voir échange avec Guillaume ("le bouton Se reconnecter n'apparaît pas") : sans ce
        // handler, une coupure de la connexion au serveur de signalisation (WebSocket) qui
        // ne provoque pas de fermeture propre de la DataConnection passait complètement
        // inaperçue — ni le statut ni le bouton ne se mettaient à jour.
        onSignalingDisconnected: () => {
            setConnectionStatus(false);
            scheduleGuestAutoReconnect();
            renderReconnectButton();
            if (!selfDisconnectedAt) {
                selfDisconnectedAt = Date.now();
                if (deals) flashPresenceToast("🔌 Connexion à l'hôte perdue", false);
            }
            if (deals) renderBoard();
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
            if (myAttemptToken !== guestJoinAttemptToken) return; // un nouvel essai a pris le relais entre-temps
            if (deals) {
                // On était déjà en jeu : pas de retour à l'écran d'accueil, on laisse le
                // bouton "Se reconnecter" de la barre de connexion (renderReconnectButton).
                return;
            }
            // Voir même logique que dans onError (cas 'peer-unavailable') : un timeout pur
            // (parfois le seul signal reçu, selon l'aléa réseau) mérite la même proposition
            // de reprise cloud avant de conclure à un échec.
            const roomCodeAttempted = currentRoomCode;
            offerCloudResume(roomCodeAttempted).then(offered => {
                if (offered) return;
                showScreen('screen-landing');
                showLandingError(
                    "⚠️ La connexion n'a pas abouti après 45 secondes. Vérifie le code, que l'hôte est " +
                    "toujours connecté, et ouvre la console (F12) pour plus de détails avant de réessayer."
                );
            });
        },
        onData: handlePeerData,
        onError: (err) => {
            hideConnectingOverlay();
            if (myAttemptToken !== guestJoinAttemptToken) return; // un nouvel essai a pris le relais entre-temps
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
                    // Voir échange avec Guillaume (session asynchrone à deux) : ce cas
                    // précis — personne ne répond sous ce code — est exactement celui d'un
                    // partenaire qui revient des heures après le départ de l'hôte. Avant de
                    // conclure "aucune partie", on regarde s'il existe un état sauvegardé
                    // dans le cloud pour ce code (voir offerCloudResume) ; si oui, on
                    // propose de reprendre plutôt que d'afficher une simple erreur.
                    //
                    // Voir aussi le setTimeout de vérification en parallèle dans
                    // connectAsGuest : si CETTE erreur arrive après coup (identifiant pas
                    // encore expiré côté serveur au moment de la tentative, voir
                    // EARLY_CLOUD_CHECK_DELAY_MS) et que la bascule cloud a déjà abouti
                    // entre-temps (`deals` déjà rempli), inutile de la refaire.
                    if (deals) return;
                    const roomCodeAttempted = currentRoomCode;
                    offerCloudResume(roomCodeAttempted).then(offered => {
                        if (!offered && !deals) {
                            showLandingError("Aucune partie trouvée avec ce code. Vérifiez le code ou demandez à l'hôte de le repartager.");
                        }
                    });
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

// Voir échange avec Guillaume ("si un joueur avait déjà été dans une session, on ne doit
// pas lui redemander [son pseudo]") : distingue "rejoindre une salle où j'étais déjà
// activement présent" (silencieux, pas de modale) de "rejoindre une salle pour la première
// fois" (modale toujours affichée, voir ensureNicknameThenProceed). Marqué à chaque
// connexion invité réussie (voir onGuestConnected), purgé des entrées trop vieilles à
// chaque écriture — TTL généreux (une session de club peut s'étaler sur plusieurs heures
// avec pauses), même esprit que HOST_GAME_STATE_EXPIRY_MS côté hôte.
const GUEST_ACTIVE_ROOMS_KEY = 'bridgeBidGuestActiveRooms';
const GUEST_ACTIVE_ROOM_TTL_MS = 6 * 60 * 60 * 1000;

function markGuestActiveRoom(roomCode) {
    if (!roomCode) return;
    let map = {};
    try { map = JSON.parse(localStorage.getItem(GUEST_ACTIVE_ROOMS_KEY) || '{}'); } catch (e) { map = {}; }
    const now = Date.now();
    Object.keys(map).forEach(code => { if (now - map[code] > GUEST_ACTIVE_ROOM_TTL_MS) delete map[code]; });
    map[roomCode.toUpperCase()] = now;
    try { localStorage.setItem(GUEST_ACTIVE_ROOMS_KEY, JSON.stringify(map)); } catch (e) { /* tant pis, pas bloquant */ }
}

function isGuestActiveRoom(roomCode) {
    if (!roomCode) return false;
    let map = {};
    try { map = JSON.parse(localStorage.getItem(GUEST_ACTIVE_ROOMS_KEY) || '{}'); } catch (e) { return false; }
    const savedAt = map[roomCode.toUpperCase()];
    return !!savedAt && (Date.now() - savedAt <= GUEST_ACTIVE_ROOM_TTL_MS);
}

function uiJoinRoom() {
    document.getElementById('landingError').style.display = 'none';
    const code = document.getElementById('joinCodeInput').value.trim();
    if (!/^\d{4}$/.test(code)) {
        showLandingError('Entrez un code à 4 chiffres.');
        return;
    }
    // Voir échange avec Guillaume (session asynchrone à deux — "il faudrait un truc qui lui
    // demande de mettre son pseudo") : couvre à la fois un code tapé à la main ici ET un
    // lien direct ?room=XXXX (voir DOMContentLoaded plus bas, qui appelle aussi uiJoinRoom)
    // — un seul point de passage pour les deux façons d'arriver dans une salle.
    //
    // Voir juste au-dessus (isGuestActiveRoom) : si cet appareil était déjà activement
    // dans CETTE salle précise (ex. fenêtre fermée puis rouverte en pleine partie), on
    // saute la modale — inutile de redemander un pseudo qu'on connaît déjà pour une
    // session à laquelle on participe déjà, contrairement à une toute nouvelle salle.
    if (isGuestActiveRoom(code)) {
        chatMessages = [];
        chatUnreadCount = 0;
        updateChatUnreadBadge();
        showConnectingOverlay('Connexion en cours…');
        connectAsGuest(code, getReconnectToken(), savedNickname);
        return;
    }
    ensureNicknameThenProceed(() => {
        chatMessages = [];
        chatUnreadCount = 0;
        updateChatUnreadBadge();
        showConnectingOverlay('Connexion en cours…');
        connectAsGuest(code, getReconnectToken(), savedNickname);
    });
}

// Demande le pseudo avant de rejoindre une salle — voir échange avec Guillaume ("le
// formulaire pourrait apparaître avec le précédent pseudo pré-rempli") : affiché à CHAQUE
// fois désormais, plutôt que sauté entièrement quand un pseudo est déjà enregistré sur cet
// appareil (voir savedNickname) — pré-rempli avec ce pseudo le cas échéant (voir
// onfocus="this.select()" sur le champ, dans index.html : le premier caractère tapé
// remplace tout plutôt que de s'ajouter à la suite). `action` reste toujours différée
// jusqu'à validation de la modale (voir uiConfirmNicknamePrompt).
let pendingJoinAfterNickname = null;
function ensureNicknameThenProceed(action) {
    pendingJoinAfterNickname = action;
    const input = document.getElementById('nicknamePromptInput');
    if (input) input.value = savedNickname || '';
    const overlay = document.getElementById('nicknamePromptOverlay');
    if (overlay) overlay.style.display = 'flex';
    setTimeout(() => { if (input) input.focus(); }, 50);
}

function uiConfirmNicknamePrompt() {
    const input = document.getElementById('nicknamePromptInput');
    const trimmed = (input && input.value || '').trim();
    if (!trimmed) {
        if (input) input.focus();
        return;
    }
    savedNickname = trimmed;
    saveStringPref('bridgeBidNickname', trimmed);
    const overlay = document.getElementById('nicknamePromptOverlay');
    if (overlay) overlay.style.display = 'none';
    const action = pendingJoinAfterNickname;
    pendingJoinAfterNickname = null;
    if (action) action();
}

// Même contournement que uiJoinCodeInputKeydown (double tap nécessaire sur clavier mobile) :
// valider directement depuis la touche "Aller" du clavier virtuel.
function uiNicknamePromptKeydown(event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    uiConfirmNicknamePrompt();
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

    // Voir plus bas (setTimeout de vérification cloud en parallèle) : incrémenté ICI,
    // avant la construction des handlers, pour qu'ils capturent la bonne valeur et
    // puissent reconnaître un essai devenu périmé si un nouveau connectAsGuest() démarre
    // entre-temps.
    const attemptToken = ++guestJoinAttemptToken;
    peerConn = new BridgePeerConnection(buildGuestHandlers());
    pushDebugLog(`Connexion au salon ${code} avec le jeton ${token.slice(0, 10)}…`);
    peerConn.joinRoom(code, { reconnectToken: token, nickname: nickname, avatarColor: savedAvatarColor });

    // Voir échange avec Guillaume ("connexion en cours en boucle" quand A vient tout juste
    // de lancer en mode différé) : dans ce mode, il n'y a jamais personne à trouver en
    // direct (voir NullPeerConnection) — mais l'identifiant de salle peut mettre quelques
    // secondes à expirer officiellement côté serveur de signalisation après sa destruction,
    // retardant l'erreur "peer-unavailable" habituelle (normalement quasi instantanée)
    // jusqu'au délai d'abandon complet de 45s (voir CONNECTION_TIMEOUT_MS). Plutôt que
    // d'attendre cet échec, on tente la bascule cloud EN PARALLÈLE, après un court délai —
    // le garde ci-dessous (attemptToken, et !everConnectedAsGuest/!deals) évite tout
    // conflit si la connexion directe aboutit entre-temps (mode live) ou si un nouvel
    // essai a déjà pris le relais.
    setTimeout(() => {
        if (attemptToken !== guestJoinAttemptToken) return; // un nouvel essai a pris le relais
        if (everConnectedAsGuest || deals) return; // déjà résolu (en direct, ou déjà en jeu) : rien à faire
        offerCloudResume(code);
    }, EARLY_CLOUD_CHECK_DELAY_MS);
}

// Reconnexion après coupure : même code de salon, même jeton (localStorage) — l'hôte
// reconnaît le jeton et renvoie automatiquement les sièges et l'état de partie en cours.
function uiReconnect() {
    // Voir échange avec Guillaume (session du 23 juillet — "l'hôte n'a aucun bouton
    // Se reconnecter") : ce bouton (voir reconnectBtn dans index.html) sert maintenant
    // aux deux rôles — la logique diffère donc selon qui clique.
    if (myRole === 'host') {
        uiHostReconnect();
        return;
    }
    if (myRole !== 'guest' || !currentRoomCode) return;
    // Voir échange avec Guillaume ("l'invité ne se reconnecte jamais tout seul") : annule
    // le cycle automatique en arrière-plan avant de repartir sur cette tentative manuelle
    // — sinon un tick programmé plus tôt pourrait se déclencher en plein milieu et
    // redémarrer une seconde tentative concurrente inutilement. Se reprogrammera tout
    // seul si CETTE tentative échoue à son tour (voir onPeerDisconnected/
    // onSignalingDisconnected).
    cancelGuestAutoReconnectTimer();
    if (peerConn) peerConn.destroy();
    setConnectionStatus(false);
    peerConn = new BridgePeerConnection(buildGuestHandlers());
    const token = getReconnectToken();
    pushDebugLog(`Reconnexion au salon ${currentRoomCode} avec le jeton ${token.slice(0, 10)}…`);
    peerConn.joinRoom(currentRoomCode, { reconnectToken: token, nickname: savedNickname, avatarColor: savedAvatarColor });
}

// Voir échange avec Guillaume (session du 23 juillet) : la reconnexion AUTOMATIQUE de
// l'hôte (peer.reconnect(), voir peer-connection.js) est bornée à 5 tentatives rapprochées
// — si le réseau reste indisponible plus longtemps que ça (ex. écran de téléphone
// verrouillé un moment), l'hôte restait bloqué sans AUCUN moyen de relancer une tentative,
// même une fois le réseau revenu, contrairement à l'invité qui a toujours eu ce bouton.
// Contrairement à une reprise par le sous-hôte, ici l'onglet n'a jamais fermé : tout l'état
// (donnes, enchère, sièges) est déjà intact en mémoire, rien à reconstruire — on retente
// juste de récupérer le même identifiant réseau sous le même code.
// Voir échange avec Guillaume (session du 23 juillet — "ça affichait connexion perdue
// sans jamais réussir") : surveille la tentative légère (manualReconnect) — peer.reconnect()
// sur une connexion restée hors ligne un moment n'est pas toujours fiable (limite connue
// de PeerJS, sans erreur explicite en cas d'échec silencieux). Si notre propre connexion
// n'est toujours pas rétablie après ce délai, on bascule sur la réinitialisation complète
// plutôt que de laisser le joueur bloqué indéfiniment sur "reconnexion en cours".
let hostReconnectWatchdogTimer = null;
const HOST_RECONNECT_WATCHDOG_MS = 4000;

function uiHostReconnect() {
    if (myRole !== 'host' || !currentRoomCode) return;
    const codeToReclaim = currentRoomCode;

    // Tentative légère d'abord : réutilise la connexion existante (voir manualReconnect
    // dans peer-connection.js), sans rien détruire — l'onOpen déjà câblé sur
    // buildHostHandlers gère tout seul le succès (statut, bouton, écran).
    if (peerConn && peerConn.manualReconnect()) {
        pushDebugLog(`Reconnexion manuelle en tant qu'hôte (peer.reconnect), salle ${codeToReclaim}…`);
        clearTimeout(hostReconnectWatchdogTimer);
        hostReconnectWatchdogTimer = setTimeout(() => {
            if (myRole === 'host' && (!peerConn || !peerConn.signalingOpen)) {
                pushDebugLog("La reconnexion légère n'a pas abouti — réinitialisation complète.");
                hardResetHostConnection(codeToReclaim);
            }
        }, HOST_RECONNECT_WATCHDOG_MS);
        return;
    }

    hardResetHostConnection(codeToReclaim);
}

// Réinitialisation complète : détruit la connexion actuelle, attend un court instant (le
// temps que le serveur de signalisation PeerJS enregistre cette destruction, pour éviter
// une collision avec notre PROPRE ancienne session), puis retente sous le même code forcé.
function hardResetHostConnection(codeToReclaim) {
    if (peerConn) peerConn.destroy();
    setConnectionStatus(false);
    renderReconnectButton();
    pushDebugLog(`Reconnexion manuelle en tant qu'hôte (nouveau Peer), salle ${codeToReclaim}…`);

    setTimeout(() => {
        if (myRole !== 'host') return; // entre-temps basculé autrement (ex. déjà résolu)
        const newPeerConn = new BridgePeerConnection(buildHostHandlers(() => {
            // État déjà intact (voir plus haut) : juste rafraîchir l'affichage, rien à
            // reconstruire côté salon/partie.
            renderReconnectButton();
            if (deals) renderBoard(); else renderLobby();
        }));
        peerConn = newPeerConn;
        // Voir échange avec Guillaume : ICI seulement (après une réinitialisation
        // complète, pas sur une simple reconnexion automatique — voir le onError partagé
        // de buildHostHandlers, qui ne bascule plus jamais en invité tout seul) un
        // 'unavailable-id' signifie sans ambiguïté que quelqu'un d'autre (le sous-hôte) a
        // vraiment ce code — pas notre propre session zombie, qu'on vient de détruire
        // proprement juste avant.
        newPeerConn.handlers.onError = (err) => {
            if (err && err.type === 'unavailable-id' && deals) {
                pushDebugLog("Impossible de reprendre notre rôle d'hôte (déjà repris) — on rejoint la partie comme simple invité.");
                connectAsGuest(codeToReclaim, getReconnectToken(), savedNickname);
                return;
            }
            pushDebugLog("Échec de la reconnexion manuelle en tant qu'hôte : " + ((err && (err.message || err.type)) || err));
        };
        newPeerConn.createRoom(6, codeToReclaim);
    }, 500);
}

let everConnectedAsGuest = false;

function renderReconnectButton() {
    const btn = document.getElementById('reconnectBtn');
    if (!btn) return;
    // Voir échange avec Guillaume (session du 23 juillet) : visible pour l'hôte aussi
    // désormais. Attention — PAS le même critère que pour l'invité : isConnected() vaut
    // signalingOpen ET au moins une connexion active, ce qui est le bon critère pour un
    // invité (une seule connexion, vers l'hôte) mais donnerait un faux positif pour
    // l'hôte dès qu'il est seul dans son propre salon (aucun invité connecté n'importe
    // vraiment) — sa PROPRE connexion (signalingOpen) est le seul critère qui compte pour
    // lui, indépendamment du nombre d'invités présents.
    //
    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : plus de cas particulier "sous-hôte
    // désigné" à masquer ici — la reconnexion automatique en arrière-plan (voir
    // scheduleGuestAutoReconnect) concerne maintenant TOUT invité déconnecté, pas
    // seulement un sous-hôte. Le bouton reste utile malgré tout : un clic déclenche une
    // tentative immédiate plutôt que d'attendre le prochain passage du minuteur
    // automatique (jusqu'à GUEST_AUTO_RECONNECT_INTERVAL_MS de retard sinon).
    const shouldShow = peerConn && (
        (myRole === 'guest' && everConnectedAsGuest && !peerConn.isConnected())
        || (myRole === 'host' && !peerConn.signalingOpen)
    );
    btn.style.display = shouldShow ? '' : 'none';
}

let copyShareLinkTimeoutId = null;
// `triggerBtn` : l'élément bouton qui vient de déclencher la copie, pour y afficher la
// confirmation temporaire au bon endroit — repli sur le bouton du salon (copyShareLinkBtn)
// si appelé sans argument, pour ne rien casser des appels existants.
function uiCopyShareLink(triggerBtn) {
    const input = document.getElementById('shareLinkInput');
    input.select();
    input.setSelectionRange(0, 99999);
    if (!navigator.clipboard) return;

    navigator.clipboard.writeText(input.value).then(() => {
        // Confirmation temporaire directement sur le bouton (pas de toast à part à
        // gérer) : le libellé change le temps d'un instant, puis revient à la normale.
        const btn = triggerBtn || document.getElementById('copyShareLinkBtn');
        if (!btn) return;
        const originalLabel = btn.textContent;
        clearTimeout(copyShareLinkTimeoutId);
        btn.textContent = '✅ Lien copié !';
        copyShareLinkTimeoutId = setTimeout(() => {
            btn.textContent = originalLabel;
        }, 1800);
    }).catch(() => { /* échec silencieux (permission navigateur, etc.) : pas de fausse confirmation */ });
}

// ===== Salon d'attente =====

function enterLobbyScreen() {
    showScreen('screen-lobby');
    // Voir échange avec Guillaume (session du 23 juillet) : voir HOSTING_PREGAME_KEY tout
    // en bas du fichier — reposé à chaque appel (enterLobbyScreen est réappelée à chaque
    // changement de participant), inoffensif de le refaire à chaque fois.
    if (myRole === 'host') markHostingPregame(currentRoomCode);
    document.getElementById('lobbyRoomCodeBlock').style.display = myRole === 'host' ? 'block' : 'none';
    document.getElementById('hostSetupPanel').style.display = myRole === 'host' ? 'block' : 'none';
    // Voir échange avec Guillaume (session du 23 juillet) : déplacé hors de hostSetupPanel
    // (voir index.html), donc sa visibilité host-only doit être pilotée séparément ici,
    // avec la même condition.
    document.getElementById('hostRobotModeGroup').style.display = myRole === 'host' ? 'flex' : 'none';
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
        if (!chatPanelOpen) uiToggleChat(false);
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
    // Voir échange avec Guillaume (session du 8 août — "qu'il récupère automatiquement
    // la dernière couleur utilisée à chaque nouvelle connexion") : persisté uniquement
    // quand c'est MA PROPRE couleur qui change — l'hôte peut aussi changer celle d'un
    // AUTRE participant (voir canChange ci-dessus), ça ne doit alors rien sauvegarder
    // dans son propre localStorage.
    if (participantId === myParticipantId) saveStringPref('bridgeBidAvatarColor', p.avatarColor);
    broadcastLobbyState();
    renderLobby();
    // Voir échange avec Guillaume (session du 23 juillet) : le changement de couleur est
    // maintenant possible EN COURS DE PARTIE aussi (voir interactiveAvatarHtml dans
    // renderRoomBoard), pas seulement dans le salon — il faut alors aussi rafraîchir le
    // room board et le chat (la couleur du nom de l'expéditeur y reprend
    // avatarColorForId), sinon le changement resterait invisible jusqu'au prochain
    // rafraîchissement fortuit de l'écran de jeu. Ces deux fonctions se protègent déjà si
    // leurs éléments respectifs n'existent pas, donc rien à garder ici.
    renderRoomBoard();
    renderChat();
}

// Voir échange avec Guillaume (session du 23 juillet) : même mécanisme de changement de
// couleur au clic que dans le salon (voir avatar-color-trigger ci-dessous, dans
// renderParticipantsList), mais réutilisable ici pour le room board — permet à l'hôte de
// changer la couleur de N'IMPORTE QUI, et à chacun la sienne, y compris EN COURS DE
// PARTIE (avant, ce n'était possible que dans le salon, avant le lancement).
function interactiveAvatarHtml(participantId) {
    const canChangeColor = myRole === 'host' || participantId === myParticipantId;
    const html = avatarHtml(participantId);
    return canChangeColor
        ? `<span class="avatar-color-trigger" onclick="uiRandomizeAvatarColor(event, '${participantId}')" title="Changer de couleur">${html}</span>`
        : html;
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

// Remplace un span de nom par un champ éditable (voir échange avec Guillaume) — factorisé
// pour être appelable soit avec le span cliqué directement (voir uiStartRenamingParticipant
// ci-dessous), soit avec un span retrouvé autrement (voir uiHandleWizzableNameClick, où
// l'élément cliqué n'est pas exactement celui à remplacer — voir plus bas).
function startRenameOnSpan(span, participantId) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'participant-rename-input';
    input.maxLength = 20;
    // Repart du nom COMPLET stocké côté participant plutôt que de span.textContent : ce
    // dernier peut contenir des décorations qui ne font pas partie du nom lui-même (ex.
    // la cloche 🔔 dans le room board, voir wizzableNameHtml).
    const p = participants.find(x => x.id === participantId);
    input.value = p ? p.name : span.textContent;
    input.oninput = () => uiRenameParticipant(participantId, input.value);
    input.onblur = () => uiRenameParticipantBlur(participantId, input);
    span.replaceWith(input);
    input.focus();
    input.select();
}

// Convertit le nom (affiché en texte simple, voir renderParticipantsList) en champ
// éditable au clic explicite — voir échange avec Guillaume : un <input> permanent aurait
// capté le focus dès un simple appui-maintenu voulant démarrer un glisser-déposer.
// stopPropagation évite que ce clic ne déclenche autre chose sur le <li> parent.
function uiStartRenamingParticipant(event, participantId) {
    event.stopPropagation();
    startRenameOnSpan(event.currentTarget, participantId);
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
        // Voir échange avec Guillaume (session du 23 juillet) : le renommage est
        // maintenant aussi possible depuis le chat en cours de partie (voir renderChat) —
        // ces deux affichages reflètent aussi les noms, donc à tenir à jour ici comme
        // renderSeatAssignmentGrid. renderChat() se protège elle-même si SON PROPRE input
        // de renommage est actif (pas de risque de l'écraser en pleine frappe).
        renderRoomBoard();
        renderChat();
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
    // Voir échange avec Guillaume (session du 23 juillet) : l'hôte peut désormais se
    // renommer lui-même via ce même mécanisme (voir wizzableNameHtml) — le champ pseudo
    // du salon (myNameInput) n'est mis à jour qu'à l'entrée dans le salon, donc à
    // resynchroniser explicitement ici pour ne pas y laisser l'ancien nom.
    if (participantId === myParticipantId) {
        const nameInput = document.getElementById('myNameInput');
        if (nameInput) nameInput.value = p.name;
    }
    broadcastLobbyState();
    renderLobby();
    // Voir échange avec Guillaume (session du 23 juillet) : idem qu'au-dessus — le champ
    // vient de perdre le focus (voir onblur), donc la garde de renderChat() ne bloque
    // plus rien : le nom se met à jour immédiatement dans les messages déjà affichés.
    renderRoomBoard();
    renderChat();
}

// Voir échange avec Guillaume (session du 23 juillet — passage à un brouillon pour la
// modale de réorganisation) : construction des 4 cases factorisée ici, partagée entre la
// grille LIVE du salon (renderSeatAssignmentGrid, applique immédiatement) et la grille
// PROVISOIRE de la modale de réorganisation en cours de partie (renderSeatReorgModalGrid,
// n'applique qu'à la validation) — `assignmentObj` est l'assignation à afficher (peut être
// `seatAssignment` la vraie, ou `seatReorgDraft` un brouillon), `onSelect` le nom de la
// fonction appelée au clic sur une option (diffère : immédiat pour le salon, brouillon
// seulement pour la modale). `enableDrag`/`withFlash` n'ont de sens que pour la grille live
// (le glisser-déposer et l'animation d'arrivée/départ ne concernent que l'état réel).
function buildSeatBoxesHtml(assignmentObj, onSelect, { enableDrag = false, withFlash = false } = {}) {
    const isHost = myRole === 'host';

    // Un siège "vient d'être assigné" si son occupant est non vide ET différent de ce
    // qu'il était au rendu précédent (couvre à la fois une case vide qui se remplit et un
    // changement d'occupant) — voir prevSeatAssignmentSnapshot pour le cas particulier du
    // tout premier rendu.
    const justAssigned = seat => {
        if (!withFlash || prevSeatAssignmentSnapshot === null) return false;
        const assignedId = assignmentObj[seat];
        return !!assignedId && assignedId !== prevSeatAssignmentSnapshot[seat];
    };

    // Symétrique de justAssigned (voir échange avec Guillaume) : un siège "vient d'être
    // libéré" s'il était occupé au rendu précédent et ne l'est plus maintenant — même
    // effet visuel que l'arrivée, pour signaler tout autant le départ.
    const justVacated = seat => {
        if (!withFlash || prevSeatAssignmentSnapshot === null) return false;
        return !!prevSeatAssignmentSnapshot[seat] && !assignmentObj[seat];
    };

    return SEATS.map(seat => {
        const assignedId = assignmentObj[seat];
        const flashClass = justAssigned(seat) ? ' just-assigned' : (justVacated(seat) ? ' just-vacated' : '');
        if (isHost) {
            // Menu déroulant personnalisé (voir échange avec Guillaume) plutôt qu'un
            // <select> natif : un <option> ne peut pas contenir d'avatar coloré, alors
            // Glissable depuis TOUTE la case, pas seulement le petit déclencheur (voir
            // échange avec Guillaume) — même surface que la zone de dépôt (déjà sur la
            // case entière, voir ondragover/ondrop plus bas), pour une prise en main
            // cohérente dans les deux sens. Uniquement sur la grille live (enableDrag) :
            // la modale de réorganisation n'a pas de glisser-déposer, seulement les menus.
            const isPending = assignedId === SEAT_PENDING;
            const occupantP = (assignedId && !isPending) ? participants.find(x => x.id === assignedId) : null;
            const boxDragAttrs = (enableDrag && occupantP) ? ` draggable="true" ondragstart="uiDragStartParticipant(event, '${assignedId}', '${seat}')"` : '';
            const dropAttrs = enableDrag ? ` ondragover="uiAllowDrop(event)" ondragenter="uiDragEnterTarget(event)" ondragleave="uiDragLeaveTarget(event)" ondrop="uiDropOnSeat(event, '${seat}')"` : '';
            const triggerContent = occupantP
                ? `${avatarHtml(assignedId)}<span class="kibitz-chip-name">${escapeHtml(occupantP.name)}</span>`
                : isPending
                    ? `<span class="mini-avatar mini-avatar-pending">⏳</span><span class="kibitz-chip-name">En attente…</span>`
                    : `<span class="mini-avatar mini-avatar-robot">🤖</span><span class="kibitz-chip-name">Robot</span>`;

            const robotOptionClass = assignedId ? '' : ' is-current';
            const pendingOptionClass = isPending ? ' is-current' : '';
            const optionsHtml = [`
                <div class="seat-dropdown-option${robotOptionClass}" onclick="${onSelect}('${seat}', ''); uiCloseSeatDropdowns();">
                    <span class="mini-avatar mini-avatar-robot">🤖</span><span>Robot</span>
                </div>
                <div class="seat-dropdown-option${pendingOptionClass}" onclick="${onSelect}('${seat}', '${SEAT_PENDING}'); uiCloseSeatDropdowns();">
                    <span class="mini-avatar mini-avatar-pending">⏳</span><span>En attente d'un partenaire</span>
                </div>
            `].concat(participants.map(p => {
                const currentClass = p.id === assignedId ? ' is-current' : '';
                return `
                    <div class="seat-dropdown-option${currentClass}" onclick="${onSelect}('${seat}', '${p.id}'); uiCloseSeatDropdowns();">
                        ${avatarHtml(p.id)}<span>${escapeHtml(p.name)}</span>
                    </div>
                `;
            }));

            return `
                <div class="seat-box seat-pos-${seat}${flashClass}"${boxDragAttrs}${dropAttrs}>
                    <span class="seat-box-label">${SEAT_FULL_NAME[seat]}</span>
                    <div class="seat-occupant-dropdown">
                        <button type="button" class="kibitz-chip seat-occupant-chip${occupantP ? '' : ' seat-occupant-chip-robot'}" onclick="uiToggleSeatDropdown(event, '${seat}')">
                            ${triggerContent}
                            <span class="seat-dropdown-chevron">▾</span>
                        </button>
                        <div class="seat-dropdown-menu" style="display:none;">${optionsHtml.join('')}</div>
                    </div>
                </div>
            `;
        }
        const isPendingReadOnly = assignedId === SEAT_PENDING;
        const p = (assignedId && !isPendingReadOnly) ? participants.find(x => x.id === assignedId) : null;
        const name = p ? escapeHtml(p.name) : (isPendingReadOnly ? 'En attente…' : 'Robot');
        const avatarMarkup = p
            ? avatarHtml(assignedId)
            : isPendingReadOnly
                ? '<span class="mini-avatar mini-avatar-pending">⏳</span>'
                : '<span class="mini-avatar mini-avatar-robot">🤖</span>';
        return `
            <div class="seat-box seat-pos-${seat}${flashClass}">
                <span class="seat-box-label">${SEAT_FULL_NAME[seat]}</span>
                <span class="seat-box-name-row">
                    ${avatarMarkup}
                    <span class="seat-box-name">${name}</span>
                </span>
            </div>
        `;
    }).join('');
}

function renderSeatAssignmentGrid() {
    const container = document.getElementById('seatAssignmentGrid');
    if (!container) return;
    container.innerHTML = buildSeatBoxesHtml(seatAssignment, 'uiAssignSeat', { enableDrag: true, withFlash: true });
    prevSeatAssignmentSnapshot = { ...seatAssignment };
}

// Voir échange avec Guillaume (session du 23 juillet) : grille de la modale de
// réorganisation en cours de partie — affiche seatReorgDraft (le brouillon), pas
// seatAssignment (l'état réel), et route les sélections vers uiStageSeatAssignment (qui ne
// fait que modifier le brouillon) plutôt que uiAssignSeat (qui appliquerait immédiatement).
function renderSeatReorgModalGrid() {
    const container = document.getElementById('seatReorgModalGrid');
    if (!container || !seatReorgDraft) return;
    container.innerHTML = buildSeatBoxesHtml(seatReorgDraft, 'uiStageSeatAssignment', { enableDrag: false, withFlash: false });
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
    // Voir échange avec Guillaume (session du 23 juillet) : recherche scopée au bouton
    // cliqué (voir la structure HTML dans renderSeatAssignmentGrid — le menu est le
    // sibling suivant du bouton, tous deux enfants directs de .seat-occupant-dropdown),
    // plutôt qu'un id global "seatDropdownMenu-${seat}" — maintenant que la grille peut
    // exister en double (salon + modale de réorganisation en cours de partie), un id
    // global ne trouverait toujours que la PREMIÈRE des deux copies.
    const menu = event.currentTarget.parentElement.querySelector('.seat-dropdown-menu');
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
    // Voir échange avec Guillaume (session du 23 juillet — "le bot n'enchérit pas") :
    // autoPassSeats (qui détermine quels sièges sont pilotés par un robot) n'était calculé
    // qu'une fois, au lancement de la partie — jamais mis à jour quand un siège change de
    // main ensuite. Recalculé ici avant la diffusion, sinon un siège tout juste rendu à
    // "Robot" restait un simple trou muet, personne (ni humain ni robot) pour y jouer.
    if (deals) autoPassSeats = SEATS.filter(s => !seatAssignment[s]);
    broadcastLobbyState();
    renderLobby();
    // Voir échange avec Guillaume ("ce qui n'est pas encore couvert" — changement de
    // sièges via le relais serveur) : sans ça, un participant en repli serveur (voir
    // ARCHITECTURE-P2P-SERVEUR.md, étape 3) ne voyait JAMAIS un changement de siège
    // avant de se reconnecter en P2P — rien ne le poussait jusqu'ici vers le cloud. Sans
    // effet avant le lancement de la partie (voir la garde `!deals` à l'intérieur de la
    // fonction elle-même).
    saveHostGameStateToStorage();
    // Voir échange avec Guillaume (session du 23 juillet — "le bot n'enchérit pas") :
    // cette grille est maintenant aussi accessible EN COURS DE PARTIE (voir
    // uiOpenSeatReorgModal) — même rafraîchissement de l'écran de jeu que pour le
    // glisser-déposer (uiDropOnSeat).
    if (deals) {
        mySeats = SEATS.filter(s => seatAssignment[s] === myParticipantId);
        renderBoard();
    }
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

// Voir échange avec Guillaume (session du 23 juillet) : brouillon d'assignation utilisé
// par la modale de réorganisation des sièges (voir uiOpenSeatReorgModal/
// uiStageSeatAssignment/uiValidateSeatReorg) — copie de seatAssignment modifiée localement
// pendant que la modale est ouverte, appliquée à la vraie assignation UNIQUEMENT au clic
// sur "Valider". `null` tant que la modale n'est pas ouverte.
let seatReorgDraft = null;

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
    // Voir échange avec Guillaume (session du 23 juillet — voir uiAssignSeat) : même
    // recalcul, pour le glisser-déposer.
    if (deals) autoPassSeats = SEATS.filter(s => !seatAssignment[s]);
    broadcastLobbyState();
    renderLobby();
    // Voir échange avec Guillaume ("changement de sièges via le relais serveur") : même
    // ajout que uiAssignSeat — sans effet avant le lancement de la partie.
    saveHostGameStateToStorage();
    // Voir échange avec Guillaume (session du 23 juillet) : réassignation de siège
    // maintenant possible EN COURS DE PARTIE (voir renderRoomBoard/renderAuctionLedger) —
    // renderLobby() seul ne touche pas l'écran de jeu, donc à rafraîchir explicitement ici
    // (mySeats recalculé au passage, au cas où l'hôte lui-même vient d'être déplacé).
    if (deals) {
        mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);
        renderBoard();
    }
}

function uiDropOnKibitz(event) {
    event.preventDefault();
    if (myRole !== 'host' || !draggedParticipantId) return;
    if (draggedFromSeat) seatAssignment[draggedFromSeat] = null;
    draggedParticipantId = null;
    draggedFromSeat = null;
    // Voir échange avec Guillaume (session du 23 juillet — voir uiAssignSeat) : même
    // recalcul — un siège libéré vers le kibbitz redevient robot lui aussi.
    if (deals) autoPassSeats = SEATS.filter(s => !seatAssignment[s]);
    broadcastLobbyState();
    renderLobby();
    // Voir échange avec Guillaume ("changement de sièges via le relais serveur") : même
    // ajout que uiAssignSeat/uiDropOnSeat.
    saveHostGameStateToStorage();
    // Voir uiDropOnSeat ci-dessus : même rafraîchissement du côté écran de jeu.
    if (deals) {
        mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);
        renderBoard();
    }
}

const SEAT_CLOCKWISE_NEXT = { N: 'E', E: 'S', S: 'W', W: 'N' };

// Voir échange avec Guillaume ("l'invité ne se reconnecte jamais tout seul") : posé chez
// TOUT invité déconnecté (voir ARCHITECTURE-P2P-SERVEUR.md, étape 4 — l'ancienne
// distinction "sous-hôte désigné seulement" a disparu) — retente une reconnexion complète
// toutes les GUEST_AUTO_RECONNECT_INTERVAL_MS, en tâche de fond, sans qu'aucun clic ne
// soit nécessaire. Se reprogramme lui-même à chaque tentative tant que la déconnexion
// dure — onGuestConnected (voir buildGuestHandlers) l'annule dès qu'une reconnexion
// réussit, qu'elle vienne de ce minuteur ou d'un clic manuel entre-temps.
function scheduleGuestAutoReconnect() {
    if (myRole !== 'guest') return;
    if (guestAutoReconnectTimer) return; // déjà programmé, pas la peine d'en reposer un
    guestAutoReconnectTimer = setTimeout(() => {
        guestAutoReconnectTimer = null;
        attemptGuestAutoReconnect();
    }, GUEST_AUTO_RECONNECT_INTERVAL_MS);
}

function cancelGuestAutoReconnectTimer() {
    if (guestAutoReconnectTimer) {
        clearTimeout(guestAutoReconnectTimer);
        guestAutoReconnectTimer = null;
    }
}

// Revérifie tout avant d'agir (le contexte a pu changer entre-temps, ex. déjà reconnecté
// par un clic manuel juste avant que ce minuteur ne se déclenche) puis retente une
// reconnexion complète, exactement comme uiReconnect — et se reprogramme pour la
// prochaine tentative si celle-ci ne suffit pas à elle seule à rétablir la connexion
// (onGuestConnected annulera ce cycle dès que ça aboutit réellement).
function attemptGuestAutoReconnect() {
    if (myRole !== 'guest' || !currentRoomCode) return;
    if (peerConn && peerConn.isConnected()) return; // déjà reconnecté entre-temps (onGuestConnected a dû annuler ce cycle)
    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : tant que la reconnexion P2P n'a pas
    // encore réussi, relit aussi l'état serveur en tâche de fond — sans ça, mon propre
    // écran resterait figé au moment exact de la coupure jusqu'à ce que je me
    // reconnecte vraiment, même si mon tour revient entre-temps via le relais serveur
    // (le partenaire/l'adversaire d'en face a annoncé, puis l'hôte ou un autre siège a
    // relayé cette annonce ailleurs). applyCloudUpdate est sûr à appeler ici même côté
    // invité : sa partie "relais P2P" ne se déclenche que pour myRole==='host', le
    // reste (recopie de l'état local) est neutre pour ce rôle.
    if (deals && typeof pullSessionState === 'function') {
        pullSessionState(currentRoomCode).then(result => {
            if (result && result.version > lastKnownCloudVersion) applyCloudUpdate(result);
        }).catch(() => { /* panne réseau passagère, on retentera au prochain tick */ });
    }
    if (peerConn) peerConn.destroy();
    peerConn = new BridgePeerConnection(buildGuestHandlers());
    const token = getReconnectToken();
    pushDebugLog(`Reconnexion automatique en arrière-plan au salon ${currentRoomCode} avec le jeton ${token.slice(0, 10)}…`);
    peerConn.joinRoom(currentRoomCode, { reconnectToken: token, nickname: savedNickname, avatarColor: savedAvatarColor });
    scheduleGuestAutoReconnect();
}

// Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : attemptSubHostTakeover,
// promoteSelfToHostAfterTakeover et flashSubHostTookOverToast ont été retirés d'ici —
// plus d'élection d'un nouvel hôte P2P en cas de coupure prolongée, superflue depuis le
// routage par siège (étape 3). L'hôte ne change plus jamais en cours de partie.

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

// Réservé au VRAI créateur (voir updateBoardControlVisibility et échange avec Guillaume,
// "en mode différé, l'invité ne devrait pas avoir... la rotation") : applique la rotation
// localement, recalcule mySeats/autoPassSeats en conséquence, diffuse le nouvel état à
// tout le monde, puis rafraîchit l'écran actuellement affiché (jeu ou salon selon le
// moment).
// Voir échange avec Guillaume : bascule le mode d'enchère des robots. Purement local à
// l'hôte (voir robotBiddingMode) — pas de diffusion réseau nécessaire.
function uiSetRobotBiddingMode(passOnly) {
    if (myRole !== 'host') return;
    robotBiddingMode = passOnly ? 'passOnly' : 'smart';
    saveBoolPref('bridgeBidRobotPassOnly', passOnly);
}

function uiRotateSeatsClockwise() {
    if (!isTrueOriginalHost()) return;
    seatAssignment = rotatedSeatAssignment(seatAssignment);
    autoPassSeats = SEATS.filter(seat => !seatAssignment[seat]);
    // myParticipantId plutôt que la chaîne littérale 'host' (voir échange avec Guillaume,
    // "2 modes : live / différé") : en mode différé, même le vrai créateur n'utilise plus
    // jamais 'host' (voir isDeferredMode au lancement) — seul myParticipantId identifie
    // correctement ses propres sièges dans les deux modes.
    mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);

    peerConn.send({ type: 'seats-rotated', seatAssignment, autoPassSeats });
    flashSeatsRotatedToast();
    // Voir échange avec Guillaume ("changement de sièges via le relais serveur") : même
    // ajout que uiAssignSeat.
    saveHostGameStateToStorage();

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
    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : subHostId a disparu d'ici (plus
    // d'élection de sous-hôte) — hostReconnectToken reste, toujours utile pour qu'un
    // invité identifie correctement l'hôte dans ses propres échanges avec le serveur.
    //
    // autoPassSeats inclus aussi (voir échange avec Guillaume — "le bot n'enchérit pas") :
    // peut changer en cours de partie (voir uiAssignSeat/uiDropOnSeat/uiDropOnKibitz), les
    // invités doivent rester informés de quels sièges sont robot, pas seulement au
    // lancement de la partie.
    peerConn.send({
        type: 'lobby-state',
        participants,
        seatAssignment,
        hostReconnectToken: getReconnectToken(),
        autoPassSeats,
        // Voir échange avec Guillaume ("je ne veux pas de bascule d'hôte") : sans ça, un
        // simple invité ne connaît roomCreatorName que localement à l'hôte — jamais reçu,
        // il retomberait sur le participant technique 'host' du moment pour l'affichage
        // (voir renderGameHeader), ce qui recrée exactement le problème qu'on corrige.
        roomCreatorName
    });
    // Voir échange avec Guillaume (session du 23 juillet — reprise via localStorage) :
    // couvre les sièges/participants/renommages, qui passent tous par cette fonction.
    saveHostGameStateToStorage();
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
    // Voir échange avec Guillaume ("pas de raison de transférer l'hôte en différé") :
    // un siège encore SEAT_PENDING dans le salon indique qu'un participant est encore
    // attendu. Restriction laissée inchangée pour l'instant (voir
    // ARCHITECTURE-P2P-SERVEUR.md — hors périmètre de l'étape 2, qui ne touche que
    // uiStartGameAsHost) : à revisiter une fois le reste de la réorganisation en place,
    // puisque sa justification d'origine référençait la branche "mode différé"
    // maintenant retirée de uiStartGameAsHost.
    const hasPendingSeat = SEATS.some(seat => seatAssignment[seat] === SEAT_PENDING);
    const eligible = isHost && !deals && !hasPendingSeat
        ? participants.filter(p => p.id !== myParticipantId && !p.disconnected)
        : [];

    if (!isHost || deals || hasPendingSeat) {
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

// Voir échange avec Guillaume (session du 23 juillet) : bandeau de statut des donnes
// (#dealFileInfo), désormais TOUJOURS visible au même endroit plutôt qu'affiché seulement
// une fois des donnes prêtes. Ces deux fonctions pilotent son contenu (texte + couleur
// rouge/verte via la classe is-empty) ET l'état activé/grisé de "Commencer la partie" —
// les deux vont toujours de pair, pas la peine de les répéter à chaque appelant.
function setDealStatusEmpty() {
    const infoEl = document.getElementById('dealFileInfo');
    const textEl = document.getElementById('dealFileInfoText');
    const previewBtn = document.getElementById('dealPreviewBtn');
    const startBtn = document.getElementById('startGameBtn');
    infoEl.classList.add('is-empty');
    textEl.textContent = 'Veuillez charger ou générer des donnes';
    if (previewBtn) previewBtn.style.display = 'none';
    if (startBtn) startBtn.disabled = true;
}

function setDealStatusReady(text, showPreview = true) {
    const infoEl = document.getElementById('dealFileInfo');
    const textEl = document.getElementById('dealFileInfoText');
    const previewBtn = document.getElementById('dealPreviewBtn');
    const startBtn = document.getElementById('startGameBtn');
    infoEl.classList.remove('is-empty');
    textEl.textContent = text;
    if (previewBtn) previewBtn.style.display = showPreview ? '' : 'none';
    if (startBtn) startBtn.disabled = false;
}

// Parse et valide un texte de donnes déjà en main (peu importe sa provenance — fichier
// local lu via FileReader, ou donne de la bibliothèque récupérée via fetch, voir
// readAndValidateDealFile / readAndValidateDealFromLibrary), affichant tout de suite
// l'éventuelle erreur. `onDone` reçoit le tableau de donnes parsées, ou `null` si le
// parsing a échoué (l'erreur est alors déjà affichée).
function validateAndUseDealText(text, filename, onDone) {
    clearHostSetupMessage();
    setDealStatusEmpty();

    let parsedDeals;
    try {
        parsedDeals = parseDealFile(text, filename);
    } catch (err) {
        setHostSetupMessage(err.message, false);
        onDone(null);
        return;
    }

    const n = parsedDeals.length;
    setDealStatusReady(`✅ ${n} donne${n > 1 ? 's' : ''} chargée${n > 1 ? 's' : ''}`);

    // Avertissement non bloquant restant : format de fichier ambigu (voir parseDealFile).
    // Voir échange avec Guillaume (session du 23 juillet) : l'avertissement "PARs non
    // disponibles" a été retiré — le calcul du double mort en arrière-plan (voir
    // kickOffBackgroundDD ci-dessous) tourne désormais systématiquement et silencieusement
    // pour tout fichier sans PAR/table déjà fournie, plus la peine de le signaler.
    if (parsedDeals._formatWarning) {
        setHostSetupMessage(parsedDeals._formatWarning, true);
    }
    if (!parsedDeals.some(d => d.par || d.ddTable)) {
        kickOffBackgroundDD(parsedDeals);
    }

    onDone(parsedDeals);
}

// Lit un fichier local (upload) puis délègue à validateAndUseDealText.
function readAndValidateDealFile(file, onDone) {
    const reader = new FileReader();
    reader.onload = () => validateAndUseDealText(reader.result, file.name, onDone);
    reader.onerror = () => {
        clearHostSetupMessage();
        setDealStatusEmpty();
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
            setDealStatusEmpty();
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
        setDealStatusEmpty();
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
        setDealStatusEmpty();
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

// Voir échange avec Guillaume (session du 23 juillet — "ça ne doit être effectif qu'à la
// fermeture") : ouvre la grille de réorganisation des sièges en cours de partie, en mode
// BROUILLON — les changements faits dans la modale (voir uiStageSeatAssignment) ne
// s'appliquent qu'au clic sur "Valider" (voir uiValidateSeatReorg), jamais en direct.
// Réservé au VRAI créateur (le bouton lui-même est déjà masqué pour tout autre rôle, voir
// updateBoardControlVisibility, mais on se protège quand même ici en cas d'appel direct) —
// isTrueOriginalHost(), pas myRole==='host' (voir échange avec Guillaume, "en mode
// différé, l'invité ne devrait pas avoir... la réorganisation des sièges").
function uiOpenSeatReorgModal() {
    if (!isTrueOriginalHost()) return;
    seatReorgDraft = { ...seatAssignment };
    renderSeatReorgModalGrid();
    document.getElementById('seatReorgModal').style.display = 'flex';
}

// Modifie UNIQUEMENT le brouillon (voir seatReorgDraft), jamais l'assignation réelle —
// aucune diffusion réseau, aucun rafraîchissement de l'écran de jeu tant que "Valider"
// n'a pas été cliqué (voir uiValidateSeatReorg).
function uiStageSeatAssignment(seat, participantId) {
    if (!isTrueOriginalHost() || !seatReorgDraft) return;
    seatReorgDraft[seat] = participantId || null;
    renderSeatReorgModalGrid();
}

// Applique enfin le brouillon à l'assignation réelle (même logique que uiAssignSeat, mais
// en un seul coup pour tous les sièges modifiés), diffuse, rafraîchit, puis ferme.
function uiValidateSeatReorg() {
    if (!isTrueOriginalHost() || !seatReorgDraft) return;
    seatAssignment = { ...seatReorgDraft };
    // Voir échange avec Guillaume (session du 23 juillet — voir uiAssignSeat) : même
    // recalcul du statut robot des sièges.
    if (deals) autoPassSeats = SEATS.filter(s => !seatAssignment[s]);
    broadcastLobbyState();
    renderLobby();
    // Voir échange avec Guillaume ("changement de sièges via le relais serveur") : même
    // ajout que uiAssignSeat.
    saveHostGameStateToStorage();
    if (deals) {
        mySeats = SEATS.filter(s => seatAssignment[s] === myParticipantId);
        renderBoard();
    }
    seatReorgDraft = null;
    document.getElementById('seatReorgModal').style.display = 'none';
    uiCloseSeatDropdowns();
}

// Ferme SANS appliquer le brouillon (voir échange avec Guillaume) : abandonne les
// changements en cours — utilisé par un clic hors de la modale (voir
// uiCloseSeatReorgModalOnBackdrop). Pas de bouton dédié pour ça dans la modale elle-même
// ("Fermer" a été remplacé par "Valider", voir index.html), mais cliquer à l'extérieur
// reste un moyen d'abandonner sans valider.
function uiCancelSeatReorg() {
    seatReorgDraft = null;
    document.getElementById('seatReorgModal').style.display = 'none';
    uiCloseSeatDropdowns();
}

function uiCloseSeatReorgModalOnBackdrop(evt) {
    if (evt.target.id === 'seatReorgModal') uiCancelSeatReorg();
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

        // Voir échange avec Guillaume ("nom de l'hôte doit être le nom quand l'hôte a
        // lancé la séance, pas le nom par défaut à l'ouverture de la room") :
        // roomCreatorName était figé à la CRÉATION de la room (uiCreateRoom, avec le
        // savedNickname de la session PRÉCÉDENTE) et jamais remis à jour ensuite — même si
        // l'hôte corrige son pseudo dans le salon d'attente juste avant de lancer (voir
        // uiUpdateMyName, qui met bien à jour participants[...].name en temps réel, mais
        // ignorait roomCreatorName). Remis à jour ici, au moment exact du lancement, avec
        // le nom courant de l'hôte — la seule chose qui change ensuite, c'est qu'on ne le
        // réécrit plus JAMAIS après ça (voir le commentaire original sur roomCreatorName).
        const hostParticipantAtLaunch = participants.find(p => p.id === myParticipantId);
        if (hostParticipantAtLaunch) roomCreatorName = hostParticipantAtLaunch.name;

        deals = orderedDeals;
        boardIndex = 0;
        if (!deals[0].auctionHistory) deals[0].auctionHistory = [];
        auctionHistory = deals[0].auctionHistory;
        // Voir échange avec Guillaume (session du 23 juillet) : la partie démarre
        // effectivement — retire le marqueur "encore dans le salon" (voir
        // HOSTING_PREGAME_KEY tout en bas du fichier) : un rechargement à partir de
        // maintenant a du sens de garder le code dans l'URL (reprise possible).
        clearHostingPregameMark();
        hostPendingUndo = null;
        clearUndoUiState();

        const botSeats = SEATS.filter(seat => !seatAssignment[seat]);
        autoPassSeats = botSeats;
        advanceRobotBidsOnAllBoards(boardIndex); // voir échange avec Guillaume — prérequis d'"avance rapide"/"vue d'ensemble"

        // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 2) : plus de branche "mode différé"
        // séparée ici — la salle garde TOUJOURS une vraie connexion P2P hôte, même avec
        // un siège encore SEAT_PENDING. Ce dernier reste simplement inoccupé (déjà exclu
        // de botSeats ci-dessus, puisque SEAT_PENDING est une sentinelle non-vide, pas
        // une valeur absente) jusqu'à ce que quelqu'un le revendique en rejoignant — voir
        // le "revendication automatique d'un siège en attente" dans onGuestConnected,
        // qui fonctionne déjà que la partie soit lancée ou non. La sauvegarde cloud
        // (saveHostGameStateToStorage → pushCloudGameState, tout en bas de cette
        // fonction) tourne de toute façon à chaque changement d'état, qu'il y ait ou non
        // un siège en attente — la reprise asynchrone de ce siège n'a donc besoin
        // d'aucune tuyauterie séparée, elle continue de fonctionner exactement comme
        // avant ce changement.
        mySeats = SEATS.filter(seat => seatAssignment[seat] === 'host');
        participants.filter(p => p.id !== 'host' && !p.disconnected).forEach(p => {
            const guestIndex = guestIndexForParticipant(p.id);
            if (guestIndex == null) return;
            const seatsForThisGuest = SEATS.filter(seat => seatAssignment[seat] === p.id);
            // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : hostReconnectToken inclus
            // ICI aussi, pas seulement dans broadcastLobbyState ('lobby-state') — sans
            // ça, un invité qui ne recevait plus jamais de lobby-state entre le
            // lancement et une éventuelle coupure de l'hôte ne connaissait jamais son
            // identité pour ses propres échanges avec le serveur (voir
            // buildCloudStatePayload). subHostId, lui, a disparu (plus d'élection de
            // sous-hôte).
            peerConn.send({
                type: 'start-game',
                deals, yourSeats: seatsForThisGuest, botSeats,
                hostReconnectToken: getReconnectToken(),
                roomCreatorName
            }, guestIndex);
        });

        saveHostGameStateToStorage(); // première sauvegarde, voir échange avec Guillaume (session du 23 juillet)
        // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : lancé désormais à CHAQUE partie,
        // pas seulement en mode différé — pollCloudForUpdates lui-même ne fait rien tant
        // que tout le monde reste en P2P (voir son propre garde-fou), donc rien ne
        // change en pratique pour une partie où personne ne se déconnecte jamais. Prêt à
        // réagir dès qu'un siège occupé passe en repli serveur, sans latence
        // supplémentaire pour s'abonner à ce moment précis.
        startDeferredPolling();
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
    // pas besoin de la relire, le bandeau de statut est déjà à jour depuis ce moment-là.
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
            // Voir échange avec Guillaume (session du 23 juillet — reprise via
            // localStorage) : on vient de transférer l'hôte volontairement à quelqu'un
            // d'autre — la sauvegarde locale de CETTE partie n'a plus lieu d'être
            // proposée à la reprise, on n'en est plus le responsable légitime. Les
            // AUTRES salles reprenables (session du 8 août — "multi room") ne sont pas
            // affectées.
            clearHostGameStateStorage(currentRoomCode);

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
            const newSeatAssignment = msg.seatAssignment;
            // Voir échange avec Guillaume (session du 23 juillet — "un bandeau similaire
            // à celui du wizz") : détecte maintenant les DEUX transitions (pas seulement
            // le retour) pour les AUTRES participants — la déconnexion utilise le même
            // toast que côté hôte (voir onPeerDisconnected), restreinte aux joueurs
            // ASSIS. Un diff est nécessaire ici, contrairement au côté hôte qui connaît
            // déjà l'événement précis au moment où il se produit (voir onGuestConnected) :
            // ce message ne porte qu'un instantané, pas la nature du changement.
            // seatAssignment appliqué AVANT ce diff (pas après, comme c'était le cas) :
            // presenceLabelFor a besoin du siège À JOUR pour construire son libellé.
            seatAssignment = newSeatAssignment;
            if (deals && prevParticipantsDisconnectedSnapshot) {
                newParticipants.forEach(p => {
                    if (p.id === myParticipantId) return; // notre propre transition est gérée à part (voir onGuestConnected/onPeerDisconnected)
                    const wasDisconnected = prevParticipantsDisconnectedSnapshot[p.id];
                    if (wasDisconnected === undefined) return; // tout nouveau participant, rien à comparer
                    if (wasDisconnected && !p.disconnected) {
                        flashPresenceToast(`✅ ${presenceLabelFor(p)} s'est reconnecté`, true);
                    } else if (!wasDisconnected && p.disconnected && SEATS.some(s => seatAssignment[s] === p.id)) {
                        flashPresenceToast(`🔌 ${presenceLabelFor(p)} s'est déconnecté`, false);
                    }
                });
            }
            prevParticipantsDisconnectedSnapshot = {};
            newParticipants.forEach(p => { prevParticipantsDisconnectedSnapshot[p.id] = !!p.disconnected; });

            participants = newParticipants;
            // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : currentSubHostId a disparu
            // (plus d'élection de sous-hôte) — hostReconnectToken reste, reçu à chaque
            // diffusion (voir broadcastLobbyState), toujours utile pour identifier
            // correctement l'hôte dans mes propres échanges avec le serveur.
            currentHostReconnectToken = msg.hostReconnectToken || null;
            if (msg.roomCreatorName) roomCreatorName = msg.roomCreatorName;
            // Ce message est aussi renvoyé quand la connectivité change en pleine partie
            // (quelqu'un se (re)connecte) : on ne bascule à l'écran du salon que si la
            // partie n'a pas encore commencé, sinon ça arracherait un invité de sa table.
            // Dans le cas contraire (partie en cours), on doit quand même rafraîchir
            // l'écran de jeu — sans ça, la bannière de reconnexion et le tour-indicateur
            // resteraient figés jusqu'à la prochaine annonce.
            if (myRole === 'guest' && !deals) enterLobbyScreen();
            else if (deals) {
                // Voir échange avec Guillaume (session du 23 juillet) : seatAssignment peut
                // maintenant changer EN COURS DE PARTIE (réassignation de siège par glisser-
                // déposer, voir uiDropOnSeat) — recalculer mySeats ici, comme le fait déjà
                // 'seats-rotated' pour la rotation, sinon ce joueur resterait affiché avec
                // son ancienne main/son ancien rôle jusqu'à sa prochaine reconnexion.
                mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);
                // Voir échange avec Guillaume (session du 23 juillet — "le bot n'enchérit
                // pas") : autoPassSeats peut changer lui aussi en cours de partie (un
                // siège réassigné à "Robot") — à tenir à jour ici comme mySeats.
                autoPassSeats = msg.autoPassSeats || autoPassSeats;
                renderBoard();
                // Voir échange avec Guillaume (session du 23 juillet) : l'hôte peut
                // maintenant changer la couleur d'avatar ou renommer n'importe qui EN
                // COURS DE PARTIE (voir uiRandomizeAvatarColor/uiRenameParticipant) — ce
                // changement arrive ici via ce même message ; renderBoard() ne rafraîchit
                // pas le chat, donc on l'appelle en plus (il se protège tout seul si SON
                // PROPRE input de renommage est actif, aucun risque de l'écraser).
                renderChat();
            }
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
            // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : currentSubHostId a disparu
            // d'ici (plus d'élection de sous-hôte) — hostReconnectToken reste, connu dès
            // le lancement (voir uiStartGameAsHost, qui l'inclut dans ce message).
            currentHostReconnectToken = msg.hostReconnectToken || null;
            if (msg.roomCreatorName) roomCreatorName = msg.roomCreatorName;
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
            // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : voir le commentaire
            // équivalent dans 'start-game' — currentSubHostId a disparu.
            currentHostReconnectToken = msg.hostReconnectToken || null;
            if (msg.roomCreatorName) roomCreatorName = msg.roomCreatorName;
            hostPendingUndo = null;
            clearUndoUiState();
            enterGameScreen();
            // Voir échange avec Guillaume (session du 23 juillet) : élargi à TOUT
            // 'resync' — au départ réservé à un tout nouveau kibitz sans siège
            // (isNewJoiner), mais un joueur qui REVIENT après une vraie coupure a tout
            // autant besoin de voir le chat pour se resituer (qui est là, qu'est-ce qui
            // s'est passé...), qu'il ait un siège ou non.
            if (!chatPanelOpen) {
                uiToggleChat(false);
            }
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

function advanceRobotBidsOnBoard(idx) {
    if (!deals || !deals[idx]) return;
    const deal = deals[idx];
    if (!deal.auctionHistory) deal.auctionHistory = [];
    const hist = deal.auctionHistory;
    let safety = 0; // garde-fou, largement au-delà de toute enchère réelle possible
    while (!isAuctionOver(hist) && safety < 60) {
        const turnSeat = currentTurnSeat(deal.dealer, hist);
        if (!autoPassSeats.includes(turnSeat)) break;
        let call, explanation;
        if (robotBiddingMode === 'passOnly') {
            call = 'PASS';
            explanation = 'Mode « passe en boucle » activé';
        } else {
            ({ call, explanation } = decideRobotCall(turnSeat, deal, hist));
        }
        hist.push(explanation ? { seat: turnSeat, call, explanation } : { seat: turnSeat, call });
        safety++;
    }
}

// Applique advanceRobotBidsOnBoard à toutes les donnes — sauf, si précisé, celle
// actuellement affichée (`excludeIdx`), pour lui laisser son animation habituelle via
// maybeRobotBid() une fois entré sur l'écran de jeu (voir uiStartGameAsHost,
// uiResumeHostSession, uiResumeFromCloud). Idempotent : sans effet sur une donne déjà
// entièrement avancée, donc sûr à rappeler après n'importe quelle restauration d'état.
function advanceRobotBidsOnAllBoards(excludeIdx) {
    if (!deals) return;
    deals.forEach((_, idx) => {
        if (idx === excludeIdx) return;
        advanceRobotBidsOnBoard(idx);
    });
}

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
    // Voir échange avec Guillaume (session du 8 août — "le lien à copier devrait
    // apparaître même pour un non hôte") : point d'entrée UNIQUE et universel — les
    // chemins live (buildHostHandlers/buildGuestHandlers) le remplissaient déjà chacun
    // de leur côté, mais la reprise cloud et le mode différé (NullPeerConnection) ne
    // passent par AUCUN des deux, et n'auraient donc jamais rempli ce champ sans ça.
    if (currentRoomCode) {
        const url = new URL(window.location.href);
        url.searchParams.set('room', currentRoomCode);
        const input = document.getElementById('shareLinkInput');
        if (input) input.value = url.toString();
    }
    renderBoard();
}

function seatFullName(seat) {
    return SEAT_FULL_NAME[seat];
}

// Voir échange avec Guillaume (session du 23 juillet) : "Nom (Siège)" pour un joueur
// assis, juste "Nom" pour un kibitz — utilisé par les toasts de (dé)connexion
// (flashPresenceToast) pour un texte cohérent, avec ou sans siège selon le cas.
function presenceLabelFor(p) {
    const seat = SEATS.find(s => seatAssignment[s] === p.id);
    return seat ? `${p.name} (${seatFullName(seat)})` : p.name;
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
// Voir échange avec Guillaume (session du 23 juillet — "un bandeau similaire à celui du
// wizz") : même mécanique d'apparition que flashWizzToast, deux teintes (voir
// .presence-toast dans styles.css) — remplace l'ancienne bannière persistante pour les
// annonces ponctuelles de (dé)connexion d'un participant (pas notre propre déconnexion en
// cours, qui reste gérée par renderReconnectionBanner avec son compteur, toujours utile
// pour le sous-hôte).
function flashPresenceToast(text, isConnect) {
    let toast = document.getElementById('presenceToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'presenceToast';
        document.body.appendChild(toast);
    }
    toast.className = 'presence-toast ' + (isConnect ? 'is-connect' : 'is-disconnect');
    toast.textContent = text;
    toast.classList.remove('visible');
    void toast.offsetWidth;
    toast.classList.add('visible');
    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
}

// Voir échange avec Guillaume (session du 23 juillet) : ne gère plus QUE notre propre
// déconnexion en cours — les annonces ponctuelles concernant les AUTRES participants (ou
// l'hôte, de notre point de vue) sont passées à flashPresenceToast, un simple toast plutôt
// qu'une bannière persistante.
function renderReconnectionBanner() {
    const banner = document.getElementById('reconnectionBanner');
    if (!banner) return;

    if (!deals) {
        banner.style.display = 'none';
        return;
    }

    if (myRole === 'guest' && (!peerConn || !peerConn.isConnected())) {
        const elapsedS = selfDisconnectedAt ? Math.max(0, Math.floor((Date.now() - selfDisconnectedAt) / 1000)) : 0;
        // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 4) : plus de "/20" pour personne — ce
        // délai n'existe plus (plus d'élection de sous-hôte, voir
        // scheduleGuestAutoReconnect qui retente désormais indéfiniment pour tout le
        // monde) — un simple compteur de secondes écoulées, identique pour tous.
        banner.className = 'reconnection-banner is-waiting';
        banner.textContent = `🔌 Connexion perdue — reconnexion en cours... ${elapsedS}s`;
        banner.style.display = 'block';
        return;
    }

    banner.style.display = 'none';
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
    // Voir échange avec Guillaume (session du 23 juillet — "ça n'affiche plus à la 2e
    // déconnexion") : renderChat() manquait ici, contrairement à renderRoomBoard()
    // juste en dessous — la couleur rouge des noms déconnectés dans le chat (voir
    // renderChat) ne se mettait donc à jour que par coïncidence, si un AUTRE événement
    // (nouveau message...) déclenchait un rendu au même moment. Même garde que
    // renderRoomBoard : seulement si le panneau est effectivement ouvert.
    if (chatPanelOpen) {
        renderRoomBoard();
        renderChat();
    }
    maybeRobotBid();
}

function updateBoardControlVisibility() {
    const resetBtn = document.getElementById('resetAuctionBtn');
    // Voir échange avec Guillaume (session du 8 août — "recommencer l'enchère ne devrait
    // pas apparaître pour un non hôte") : réservé à l'hôte seul, pas canControlBoard()
    // (qui autorise aussi tout joueur assis) — recommencer une enchère pour toute la
    // table reste une décision d'organisation, comme la rotation des sièges juste en
    // dessous.
    // Voir échange avec Guillaume ("en mode différé, l'invité ne devrait pas avoir
    // recommencer l'enchère, ni la rotation, ni la réorganisation des sièges") :
    // isTrueOriginalHost() plutôt que myRole==='host' — en mode différé, TOUT participant
    // qui reprend la salle obtient myRole='host' localement (voir uiResumeFromCloud, pur
    // contrôle technique, pas une identité), donc ce critère seul montrait ces boutons à
    // n'importe quel invité différé, pas seulement au vrai créateur.
    if (resetBtn) resetBtn.style.display = isTrueOriginalHost() ? '' : 'none';
    // Réservé à l'hôte (voir échange avec Guillaume) : changer qui est assis où reste une
    // décision d'organisation de la table, pas quelque chose qu'un simple joueur assis
    // devrait pouvoir déclencher pour tout le monde.
    const rotateBtn = document.getElementById('rotateSeatsBtn');
    // visibility (pas display:none) pour que l'espace du bouton reste réservé même masqué
    // (voir échange avec Guillaume) : sinon .game-actions (flex-wrap) n'a pas le même
    // nombre de boutons visibles selon le rôle, et la ligne se coupe différemment pour
    // l'hôte que pour les autres.
    if (rotateBtn) {
        rotateBtn.style.visibility = isTrueOriginalHost() ? '' : 'hidden';
        rotateBtn.style.pointerEvents = isTrueOriginalHost() ? '' : 'none';
    }
    // Voir échange avec Guillaume (session du 23 juillet) : même traitement que
    // "Rotation" juste au-dessus — réservé à l'hôte, seul à pouvoir réorganiser qui joue
    // où (voir uiOpenSeatReorgModal).
    const seatReorgBtn = document.getElementById('seatReorgBtn');
    if (seatReorgBtn) {
        seatReorgBtn.style.visibility = isTrueOriginalHost() ? '' : 'hidden';
        seatReorgBtn.style.pointerEvents = isTrueOriginalHost() ? '' : 'none';
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
    if (roomCodeEl) {
        // Voir échange avec Guillaume (session du 24 juillet) : nom de l'hôte affiché à
        // côté du code — utile pour un joueur (ou un kibitz) qui rejoint en cours de
        // route et se demande qui héberge la partie.
        // Voir échange avec Guillaume ("je ne veux pas de bascule d'hôte") : roomCreatorName
        // est figé une fois pour toutes à la création (voir uiCreateRoom) et ne bouge plus
        // jamais, contrairement au participant technique 'host', qui lui peut changer de
        // main (reprise cloud, sous-hôte) sans que ça doive se voir ici. Repli sur le
        // participant 'host' actuel uniquement si roomCreatorName n'est pas encore défini
        // (session en mémoire créée avant l'ajout de ce champ).
        const hostParticipant = participants.find(p => p.id === 'host');
        const displayedHostName = roomCreatorName || (hostParticipant ? hostParticipant.name : null);
        const hostSuffix = displayedHostName ? ` · Hôte : ${displayedHostName}` : '';
        roomCodeEl.textContent = currentRoomCode ? `Salle : ${currentRoomCode}${hostSuffix}` : '';
    }
    // Voir échange avec Guillaume (session du 8 août — "le lien à copier devrait
    // apparaître même pour un non hôte") : visible pour tout le monde désormais — copier
    // le lien de la salle pour inviter quelqu'un d'autre n'a aucune raison d'être
    // réservé à l'hôte.
    const headerCopyLinkBtn = document.getElementById('gameHeaderCopyLinkBtn');
    if (headerCopyLinkBtn) headerCopyLinkBtn.style.display = '';
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
// qu'à la toute fin de l'écran — sinon il s'empilerait sous le reste du contenu de jeu
// (tableau d'enchères, case du contrat), pas à droite. Le salon, lui, n'a pas cette
// structure en colonnes : comportement inchangé, ancré à la fin de l'écran.
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

// Voir échange avec Guillaume (session du 23 juillet — "ça m'ouvre la page à mi hauteur") :
// `focusInput` par défaut à true (clic manuel sur le bouton chat — on veut alors amener le
// champ à l'écran). Mis à false pour l'ouverture AUTOMATIQUE et silencieuse à l'entrée dans
// le salon (voir enterLobbyScreen) : focus() y déclenchait un défilement de page vers le
// bas (le chat étant ancré en bas de page), atterrissant en plein milieu du salon au lieu
// du haut, sans qu'on ait rien demandé.
function uiToggleChat(focusInput = true) {
    // Voir échange avec Guillaume (session du 24 juillet) : le chat ne doit plus pouvoir
    // être fermé sur desktop (seuil identique à celui du CSS, voir @media min-width:600px
    // dans styles.css) — s'il est déjà ouvert et qu'on est sur desktop, cet appel n'a
    // aucun effet (reste ouvert). Reste fermable sur mobile, où l'espace écran compte.
    if (chatPanelOpen && window.innerWidth >= 600) return;
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
        if (input && focusInput) input.focus();
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
    // Voir échange avec Guillaume (session du 23 juillet — reprise via localStorage) :
    // sans effet si on n'est pas hôte ou si la partie n'est pas lancée (voir la garde à
    // l'intérieur de la fonction elle-même).
    saveHostGameStateToStorage();
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
        // Voir échange avec Guillaume (session du 23 juillet) : SAUF si ce participant
        // est actuellement déconnecté — rouge (--suit-red, même couleur que
        // .disconnected-tag ailleurs dans l'appli) prend alors le pas sur sa couleur
        // d'avatar habituelle, pour repérer d'un coup d'œil qui a décroché même en
        // relisant d'anciens messages.
        const senderP = participants.find(p => p.id === m.senderId);
        const senderColor = (senderP && senderP.disconnected) ? 'var(--suit-red)' : avatarColorForId(m.senderId);
        // Voir échange avec Guillaume (session du 23 juillet — "pas en cliquant sur le nom
        // des gens dans le chat") : renommage réservé au "qui est là" (voir
        // wizzableNameHtml/renderRoomBoard), plus proposé ici — un simple nom, pas de
        // double-clic ni de titre associé.
        const senderSpan = `<span class="chat-message-sender" style="color:${senderColor}">${escapeHtml(m.senderName)}</span>`;
        return `<div class="chat-message">${senderSpan} : <span class="chat-message-text">${escapeHtml(m.text)}</span></div>`;
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
    // Voir échange avec Guillaume (session du 24 juillet — "je ne suis plus dedans si je
    // clique 2x") : remis AVANT la vérification du texte, pas après — sinon un clic sur
    // "Envoyer" avec un champ déjà vide (ex. un second clic accidentel juste après le
    // premier envoi) sortait du champ sans y revenir, contrairement à un clic avec du
    // texte à envoyer.
    input.focus();
    const text = input.value.trim().slice(0, 500);
    if (!text) return;
    input.value = '';

    const me = participants.find(p => p.id === myParticipantId);
    const msg = { type: 'chat', senderId: myParticipantId, senderName: me ? me.name : '?', text };
    addChatMessage(msg);
    // Voir échange avec Guillaume ("chat via le relais serveur") : un invité déconnecté
    // de l'hôte ne peut de toute façon pas passer par peerConn.send (qui échoue en
    // silence contre une connexion fermée, voir BridgePeerConnection.send) — bascule sur
    // le même principe que pushCallViaServerFallback : pousse directement au serveur au
    // lieu d'attendre un relais qui n'arrivera jamais dans ce cas.
    if (myRole === 'guest' && (!peerConn || !peerConn.isConnected())) {
        pushChatViaServerFallback(msg);
        return;
    }
    // Même appel pour l'hôte (diffuse directement à tous les invités) et pour un invité
    // (envoie à l'hôte, qui relaiera) : send() sans guestIndex explicite diffuse déjà à
    // toutes les connexions actives de ce peer, qui n'en a qu'une seule (l'hôte) côté
    // invité — voir peer-connection.js.
    peerConn.send(msg);
}

// Voir échange avec Guillaume ("chat via le relais serveur") : même principe que
// pushCallViaServerFallback — relit l'état serveur, ajoute CE message à sa liste de chat,
// puis repousse avec le verrou de version. Pas de "légalité" à revalider ici
// (contrairement à une annonce) : un message de chat n'a pas de tour, il s'ajoute
// simplement à la suite.
async function pushChatViaServerFallback(msg) {
    if (!currentRoomCode || typeof pullSessionState !== 'function' || typeof pushSessionState !== 'function') return;

    let pulled;
    try {
        pulled = await pullSessionState(currentRoomCode);
    } catch (e) {
        pushDebugLog('Remontée serveur du message de chat impossible (lecture) : ' + ((e && e.message) || e));
        return;
    }

    const baseState = pulled ? pulled.state : buildCloudStatePayload();
    const expectedVersion = pulled ? pulled.version : 0;
    if (!baseState.chatMessages) baseState.chatMessages = [];
    baseState.chatMessages.push(msg);

    try {
        const result = await pushSessionState(currentRoomCode, { ...baseState, savedAt: Date.now() }, expectedVersion, {
            onConflict: (current) => {
                // Même raisonnement que pushCallViaServerFallback : pas de retentative
                // en boucle ici, le prochain sondage/abonnement rattrapera le coup.
                if (current) lastKnownCloudVersion = current.version;
                pushDebugLog('Message de chat : conflit de version au moment de pousser, abandon (une resynchronisation suivra).');
            }
        });
        if (result) {
            lastKnownCloudVersion = result.version;
            pushDebugLog(`Message de chat remonté au serveur avec succès (version ${result.version}).`);
        }
    } catch (e) {
        pushDebugLog('Remontée serveur du message de chat impossible (écriture) : ' + ((e && e.message) || e));
    }
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
// Voir échange avec Guillaume (session du 23 juillet) : nom et cloche de wizz séparés en
// deux éléments (au lieu d'un seul span cliquable pour tout) — un double-clic sur le nom
// déclenche maintenant le renommage (host, pour n'importe qui, y compris lui-même — voir
// uiStartRenamingParticipant) pendant qu'un simple clic sur 🔔 déclenche le wizz. Les
// fusionner posait deux problèmes : le texte de la cloche (" 🔔") se serait retrouvé dans
// le champ d'édition du renommage, et un double-clic aurait de toute façon déclenché 2
// wizz au passage (2 clics avant le dblclick) avant d'ouvrir le renommage.
function wizzableNameHtml(p) {
    const canRename = myRole === 'host';
    // Voir échange avec Guillaume (session du 23 juillet — voir aussi renderChat) : même
    // rouge que dans les messages du chat pour un participant déconnecté, cohérent d'un
    // bout à l'autre du même panneau.
    const colorStyle = p.disconnected ? ' style="color:var(--suit-red)"' : '';
    const nameAttrs = canRename
        ? ` class="room-board-name room-board-name-editable" ondblclick="uiStartRenamingParticipant(event, '${p.id}')" title="Double-cliquer pour renommer"${colorStyle}`
        : ` class="room-board-name"${colorStyle}`;
    const nameSpan = `<span${nameAttrs}>${escapeHtml(p.name)}</span>`;

    if (p.disconnected) return nameSpan;
    if (p.id === myParticipantId) {
        return `${nameSpan}<span class="room-board-wizz-btn" onclick="uiSelfWizz()" title="Tester l'effet wizz sur soi-même">🔔</span>`;
    }
    // Voir échange avec Guillaume ("j'essaye de wizz l'autre mais ça ne marche pas, en
    // mode différé") : pas de canal live en mode différé (NullPeerConnection, voir
    // isWizzTargetReachable) — la cloche échouait donc en silence à chaque clic, sans
    // rien indiquer d'autre qu'une ligne dans un journal masqué. Masquée ici plutôt que de
    // laisser un geste qui ne peut structurellement jamais aboutir dans ce mode.
    if (peerConn instanceof NullPeerConnection) return nameSpan;
    return `${nameSpan}<span class="room-board-wizz-btn" onclick="uiSendWizz('${p.id}')" title="Faire trembler l'écran de ${escapeHtml(p.name)}">🔔</span>`;
}

// Voir échange avec Guillaume : déclenche l'effet wizz directement en local, sans passer
// par le réseau — pour pouvoir tester le rendu (tremblement, son, bandeau) sans avoir
// besoin d'un second appareil ou d'un autre participant connecté. Pas de cooldown ici non
// plus (contrairement à uiSendWizz) : en test, pouvoir redéclencher immédiatement est plus
// utile qu'une protection anti-spam qui n'a pas de sens quand on se cible soi-même.
function uiSelfWizz() {
    triggerWizzEffect();
}

// Vérifie que la connexion réseau nécessaire pour atteindre CE destinataire précis est
// vraiment ouverte — pas seulement que peerConn existe (voir échange avec Guillaume,
// session du 8 août, "le wizz ne marchait plus"). Côté hôte : la connexion spécifique
// vers ce jeton doit être ouverte. Côté invité : sa seule connexion (vers l'hôte) doit
// l'être — peerConn.isConnected() convient déjà pour ce cas (une seule connexion
// possible), inutile de dupliquer sa logique.
function isWizzTargetReachable(targetId) {
    if (!peerConn) return false;
    if (myRole === 'host') {
        const guestIndex = guestIndexByToken[targetId];
        if (guestIndex === undefined) return false;
        const conn = peerConn.conns && peerConn.conns[guestIndex];
        return !!(conn && conn.open);
    }
    return peerConn.isConnected();
}

function uiSendWizz(targetId) {
    if (!peerConn || targetId === myParticipantId) return;
    const now = Date.now();
    if (wizzCooldownUntil[targetId] && now < wizzCooldownUntil[targetId]) return; // encore en sablier, on ignore silencieusement

    // Voir échange avec Guillaume (session du 8 août — "le wizz ne marchait plus, je
    // pouvais juste pas le faire") : bug trouvé — le cooldown était posé AVANT même de
    // savoir si l'envoi allait réussir. peerConn.send() abandonne silencieusement un
    // message si la connexion cible n'est pas encore pleinement ouverte (voir conn.open
    // dans peer-connection.js) — un cas plausible juste après une reconnexion, où le
    // statut semble déjà "connecté" mais la DataConnection elle-même termine encore son
    // établissement. Sans ce contrôle, un envoi raté posait quand même le cooldown,
    // empêchant toute nouvelle tentative pendant 4s de plus, alors que rien n'était
    // jamais parti.
    if (!isWizzTargetReachable(targetId)) {
        pushDebugLog(`Wizz vers ${targetId.slice(0, 10)}… abandonné : connexion pas encore prête.`);
        return;
    }
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
    // Voir échange avec Guillaume (session du 23 juillet) : même garde que
    // renderParticipantsList — si l'hôte est en train de renommer quelqu'un ici (voir
    // wizzableNameHtml/uiStartRenamingParticipant), on ne reconstruit pas, ça
    // détruirait l'input actif en pleine frappe.
    if (document.activeElement && document.activeElement.classList.contains('participant-rename-input')) {
        return;
    }

    // Seuls les sièges réellement occupés par un participant apparaissent ici : les
    // robots ne sont pas des "personnes dans la salle", ça n'a pas sa place dans ce
    // panneau (contrairement au relevé d'enchères, où "Bot" reste utile pour savoir qui
    // a annoncé quoi — voir ledgerSeatLabel).
    //
    // Regroupement par participant plutôt qu'une ligne par siège : en mode diagonale ou
    // "maître du jeu", une même personne peut occuper 2 sièges — elle ne doit apparaître
    // qu'une fois, avec ses sièges listés ensemble (ex. "Nord + Sud"), pas deux fois.
    //
    // Voir échange avec Guillaume (session du 23 juillet) : ordre d'affichage N, S, E, O
    // (par paires de partenaires — Nord/Sud d'abord, puis Est/Ouest) plutôt que l'ordre de
    // rotation habituel N, E, S, O (voir SEATS) — un ordre propre à ce panneau, sans
    // rapport avec l'ordre de jeu.
    const ROOM_BOARD_SEAT_ORDER = ['N', 'S', 'E', 'W'];
    const seatsByParticipant = new Map(); // id -> [seat, seat, ...], dans l'ordre N/S/E/O
    ROOM_BOARD_SEAT_ORDER.forEach(seat => {
        const pid = seatAssignment[seat];
        if (!pid) return;
        if (!seatsByParticipant.has(pid)) seatsByParticipant.set(pid, []);
        seatsByParticipant.get(pid).push(seat);
    });

    const seatRows = [...seatsByParticipant.keys()].map(pid => {
        const seatsLabel = seatsByParticipant.get(pid).map(seatFullName).join(' + ');
        // Voir échange avec Guillaume (session asynchrone à deux) : un siège 'PENDING'
        // n'a pas de participant réel derrière (personne n'a encore ouvert le lien) — on
        // l'affiche quand même ici, avec un badge dédié, plutôt que de le faire disparaître
        // silencieusement comme un robot (ce n'en est pas un : l'enchère l'attend vraiment).
        if (pid === SEAT_PENDING) {
            return `<div class="room-board-seat"><span class="room-board-seat-label">${seatsLabel}</span><span class="mini-avatar mini-avatar-pending">⏳</span><span class="room-board-pending-label">En attente d'un partenaire</span></div>`;
        }
        const p = participants.find(x => x.id === pid);
        if (!p) return '';
        const disconnectedTag = p.disconnected ? ' <span class="disconnected-tag">🔌</span>' : '';
        const occupant = `${interactiveAvatarHtml(p.id)}${wizzableNameHtml(p)}${disconnectedTag}`;
        return `<div class="room-board-seat"><span class="room-board-seat-label">${seatsLabel}</span>${occupant}</div>`;
    }).filter(Boolean).join('');

    // Quiconque n'occupe aucun siège est kibbitz (voir isKibbitz) : plus de liste à part à
    // maintenir, on liste simplement tous les participants absents de seatAssignment. Mais
    // seulement une fois la partie lancée (voir échange avec Guillaume) : dans le salon,
    // ne pas avoir de siège ne veut encore rien dire — l'hôte est peut-être justement en
    // train de composer la table — donc l'étiquette "Kibbitz" n'y a pas sa place.
    const kibbitzNames = deals ? participants.filter(p => !seatsByParticipant.has(p.id)) : [];
    // Voir échange avec Guillaume (session du 23 juillet) : chaque kibitz dans sa PROPRE
    // ligne (room-board-kibitz-person), comme les sièges ci-dessus — avant, ils étaient
    // tous des enfants directs de .room-board-kibitz (flex-wrap), donc affichés plusieurs
    // par ligne au lieu d'un par ligne.
    //
    // Glissable vers un siège (voir échange avec Guillaume — réassignation de siège en
    // pleine partie) : réutilise exactement le même mécanisme que la zone kibbitz du salon
    // (uiDragStartParticipant, fromSeat=null puisque justement kibitz), déposable sur
    // l'en-tête d'une colonne du relevé d'enchères (voir renderAuctionLedger, uiDropOnSeat
    // rafraîchit maintenant aussi l'écran de jeu). Réservé à l'hôte, seul à pouvoir
    // réorganiser qui joue où — voir la garde dans uiDragStartParticipant lui-même.
    // PORTÉE ACTUELLE : seulement les kibitz (pas encore les joueurs déjà assis, dont le
    // siège d'origine serait ambigu s'ils en occupent 2 à la fois — voir ROOM_BOARD_SEAT_ORDER
    // ci-dessus qui les regroupe) — à étendre plus tard si besoin.
    const isHost = myRole === 'host';
    const kibbitzHtml = kibbitzNames.length > 0
        ? `<div class="room-board-kibbitz">
               <span class="room-board-section-label">👁 Kibbitz :</span>
               ${kibbitzNames.map(p => {
                   const dragAttrs = isHost ? ` draggable="true" ondragstart="uiDragStartParticipant(event, '${p.id}')"` : '';
                   return `<div class="room-board-kibitz-person"${dragAttrs}>${interactiveAvatarHtml(p.id)}${wizzableNameHtml(p)}</div>`;
               }).join('')}
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

// Libellé affiché pour un siège donné : soit le nom du joueur qui l'occupe (préférence
// showLedgerNames), soit le nom complet du siège (Nord/Est/Sud/Ouest — voir échange avec
// Guillaume, session du 8 août, "je voudrais que ce soit Nord/Est/Sud/Ouest au lieu de
// N/E/S/O" — plus l'abréviation SEAT_ABBR_FR utilisée avant ici). Un siège robot (non
// assigné) ou sans nom exploitable retombe sur le nom complet du siège.
// Utilisé à la fois dans l'en-tête du tableau d'enchères (renderAuctionLedger) et dans le
// diagramme des 4 mains (buildAllHandsHtml — voir échange avec Guillaume : "je voudrais
// que quand on active l'option noms, on ait également les noms sur l'affichage des 4
// mains plutôt que les noms des positions") — même préférence, même logique de repli,
// partagées entre les deux affichages plutôt que dupliquées.
function ledgerSeatLabel(seat) {
    if (!showLedgerNames) return SEAT_FULL_NAME[seat];
    const pid = typeof seatAssignment !== 'undefined' ? seatAssignment[seat] : null;
    if (!pid) return 'Bot'; // siège non assigné : joué par le robot (voir maybeRobotBid)
    const p = participants.find(x => x.id === pid);
    const name = p && p.name ? p.name.trim() : '';
    return name || SEAT_FULL_NAME[seat]; // quelqu'un est bien assigné ici, pas un bot : jamais "Bot" dans ce cas
}

// Voir échange avec Guillaume ("chaque joueur voit son nom en vert, son partenaire en
// bleu, les 2 adversaires en rouge") : relation ENTRE ce siège et le point de vue de la
// personne qui regarde (mySeats), pas une propriété du siège en lui-même — deux personnes
// à la même table voient donc des couleurs différentes sur les mêmes 4 sièges. Un kibitz
// (mySeats vide) n'a pas de camp : jamais de classe, couleur neutre par défaut.
function seatRelationClass(seat) {
    if (!mySeats || mySeats.length === 0) return '';
    if (mySeats.includes(seat)) return 'seat-relation-mine';
    if (mySeats.some(s => partnershipOf(s) === partnershipOf(seat))) return 'seat-relation-partner';
    return 'seat-relation-opponent';
}

function renderAuctionLedger() {
    const deal = currentDeal();
    const header = document.getElementById('auctionLedgerHeader');
    const toggleBtn = document.getElementById('ledgerNamesToggleBtn');
    if (toggleBtn) toggleBtn.classList.toggle('is-active', showLedgerNames);
    const turnSeat = isAuctionOver(auctionHistory) ? null : currentTurnSeat(deal.dealer, auctionHistory);
    // Voir échange avec Guillaume (session du 23 juillet) : cible de dépôt pour
    // réassigner un siège en pleine partie (glisser un kibitz depuis le chat, voir
    // renderRoomBoard) — mêmes gestionnaires que dans le salon (uiAllowDrop,
    // uiDragEnterTarget/uiDragLeaveTarget pour la surbrillance), réservés à l'hôte
    // (chacune de ces fonctions se protège déjà individuellement).
    const isHost = myRole === 'host';
    const dropAttrs = isHost
        ? (s) => ` ondragover="uiAllowDrop(event)" ondragenter="uiDragEnterTarget(event)" ondragleave="uiDragLeaveTarget(event)" ondrop="uiDropOnSeat(event, '${s}')"`
        : () => '';
    header.innerHTML = SEATS.map(s => {
        const pair = partnershipOf(s);
        const isVulnerable = deal.vulnerable === 'Both' || deal.vulnerable === pair;
        const vulnClass = isVulnerable ? 'vuln-bar-danger' : 'vuln-bar-safe';
        // Voir échange avec Guillaume ("le nom de celui dont c'est le tour ne devrait pas
        // être en rouge, le fond blanc suffit déjà à l'indiquer") : turn-col garde son
        // inversion de fond (voir styles.css), mais ne colore plus le texte lui-même —
        // remplacé par seat-relation-* ci-dessus, une couleur PERMANENTE (pas liée au tour)
        // reflétant la relation de ce siège avec le point de vue de qui regarde.
        const classes = [s === turnSeat ? 'turn-col' : '', seatRelationClass(s)].filter(Boolean).join(' ');
        return `<th class="${classes}"${dropAttrs(s)}>
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
        box.classList.remove('my-turn');
        // Voir échange avec Guillaume (session du 8 août — "il y a parfois une
        // persistence de la barre... il n'y a plus les lettres mais on voit l'effet
        // visuel mouvant") : le texte était bien vidé, mais la CLASSE (turn-indicator
        // my-turn/their-turn/disconnected-turn) restait — le halo pulsant continuait de
        // tourner sur un élément désormais vide.
        turnPanel.className = 'turn-indicator';
        turnPanel.textContent = '';
        return;
    }

    const turnSeat = currentTurnSeat(deal.dealer, auctionHistory);
    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : ne gèle plus la boîte d'enchères
    // pour un invité déconnecté de l'hôte — auparavant nécessaire (topologie en étoile,
    // aucun autre chemin possible), ça ne l'est plus : uiMakeCall bascule désormais sur
    // le relais serveur quand la connexion P2P à l'hôte manque (voir
    // pushCallViaServerFallback), donc mon propre tour reste jouable même déconnecté.
    const myTurn = mySeats && mySeats.includes(turnSeat);

    const turnOwnerId = seatAssignment[turnSeat];
    const turnOwner = turnOwnerId ? participants.find(p => p.id === turnOwnerId) : null;
    const ownerDisconnected = !!(turnOwner && turnOwner.disconnected);

    // Voir échange avec Guillaume (session du 23 juillet) : PAS de message dédié ici pour
    // disconnectedFromHost — ce serait un doublon avec la bannière de reconnexion en haut
    // de l'écran (voir renderReconnectionBanner, qui couvre maintenant aussi le cas où
    // c'est NOUS qui sommes déconnectés), affichée à un autre endroit de la page. Seul le
    // gel des boutons compte ici (voir `legal` plus bas) ; le texte se contente de rester
    // sur son état normal (À vous d'enchérir / En attente de X...), qui redevient
    // simplement inerte pendant la coupure plutôt que de raconter deux fois la même chose.
    if (myTurn) {
        turnPanel.textContent = `À vous d'enchérir (${seatFullName(turnSeat)})`;
    } else if (ownerDisconnected) {
        turnPanel.textContent = `🔌 En attente que ${turnOwner.name} se reconnecte (${seatFullName(turnSeat)})...`;
    } else {
        turnPanel.textContent = `En attente de ${seatFullName(turnSeat)}...`;
    }
    turnPanel.className = 'turn-indicator ' + (ownerDisconnected ? 'disconnected-turn' : (myTurn ? 'my-turn' : 'their-turn'));
    // Voir échange avec Guillaume (session du 8 août — "j'aimerais cet effet tout autour
    // de ses touches d'enchères") : même halo pulsant que turnPanel (voir .my-turn dans
    // styles.css), appliqué cette fois directement sur la boîte des boutons — plus
    // visible pour le joueur concerné que le seul texte au-dessus, qui peut passer
    // inaperçu.
    box.classList.toggle('my-turn', myTurn);

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

    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : jusqu'ici, un invité déconnecté de
    // l'hôte ne pouvait tout simplement pas annoncer (voir renderBiddingBox, même règle
    // — les boutons étaient déjà grisés dans ce cas). Bascule désormais sur le relais
    // serveur au lieu d'abandonner — voir pushCallViaServerFallback, qui relit l'état
    // serveur, rejoue cette annonce dessus et revalide avant de pousser (jamais un envoi
    // à l'aveugle sur la seule foi de ma copie locale, potentiellement périmée).
    if (myRole === 'guest' && (!peerConn || !peerConn.isConnected())) {
        pushCallViaServerFallback(turnSeat, call);
        return;
    }
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
    // Voir échange avec Guillaume (session du 23 juillet — reprise via localStorage) :
    // sans effet si on n'est pas hôte ou si la partie n'est pas lancée (voir la garde à
    // l'intérieur de la fonction elle-même).
    saveHostGameStateToStorage();
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
                    <span class="hand-card-title-name">${ledgerSeatLabel(seat)}</span>
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

// Voir échange avec Guillaume (session du 8 août — "si un camp a une manche, ne pas
// afficher en vert le meilleur contrat de l'autre camp, sauf si ils ont sacrifice") :
// score d'une chute CONTRÉE (barème standard SEF/FFB), nécessaire pour évaluer si
// sacrifier au-dessus de la manche/chelem adverse est rentable. Non-vulnérable :
// -100/-200/-200/-300/-300... ; vulnérable : -200/-300/-300... (chaque levée
// supplémentaire au-delà de la 1ère coûte 300, sauf les 2ème et 3ème non-vulnérables
// à 200 chacune).
function doubledUndertrickScore(undertricks, vulnerable) {
    if (undertricks <= 0) return 0;
    if (vulnerable) return -(200 + (undertricks - 1) * 300);
    if (undertricks <= 3) return -(100 + (undertricks - 1) * 200);
    return -(100 + 2 * 200 + (undertricks - 3) * 300);
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
// Voir échange avec Guillaume (session du 23 juillet — "décalage EO") : aligné sur
// l'ordre du relevé d'enchères (N, E, S, O — voir SEATS dans bidding-rules.js), pas
// l'ordre par paires de partenaires (N, S, E, O) utilisé ailleurs (room board) — ce
// tableau est affiché juste en dessous du relevé d'enchères, dont l'ordre de colonnes
// doit rester cohérent pour que les deux s'alignent visuellement.
// Voir échange avec Guillaume ("dans le tableau du PAR, NS devraient être collés et EO
// ensuite au lieu d'alterner") : N,S,E,W plutôt que N,E,S,W — les deux camps groupés
// plutôt qu'alternés, plus lisible pour comparer visuellement NS vs EO d'un coup d'œil.
const DD_TABLE_SEAT_ORDER = ['N', 'S', 'E', 'W'];

// Construit le tableau HTML du double mort (5 lignes SA/♠/♥/♦/♣ x 4 colonnes N/S/E/O),
// tel qu'éventuellement fourni dans le fichier PBN chargé (tag [OptimumResultTable]).
// Affiche le palier de contrat réalisable (et non le nombre brut de levées), avec le
// meilleur contrat de chaque camp mis en évidence (voir computeDDScores ci-dessus).
// Voir échange avec Guillaume ("si un camp a une manche, ne pas afficher en vert le
// meilleur contrat de l'autre camp, sauf si ils ont sacrifice. Ex : NS gagne 4♥ en étant
// rouge contre vert... EO a un bon sacrifice si ils ont 5x-3 à jouer") : pour chaque
// camp qui a une VRAIE manche ou chelem, vérifie si l'AUTRE camp (dont le meilleur
// contrat n'est qu'une partielle) aurait un sacrifice rentable en enchérissant un cran
// au-dessus (contré) — sinon, son contrat n'est plus mis en évidence du tout (il n'y a
// rien à viser). Si l'autre camp a AUSSI sa propre manche/chelem, ou si aucun camp n'a
// de manche, rien ne change (mise en évidence normale des 2 côtés).
function computeSacrificeAwareVisibility(ddTable, dealVulnerable, info, sideSummary) {
    const nsVuln = (dealVulnerable === 'NS' || dealVulnerable === 'Both');
    const ewVuln = (dealVulnerable === 'EW' || dealVulnerable === 'Both');
    const visible = { NS: true, EW: true };

    const bestLevelForSide = (side, tier, score) => {
        for (const strain of STRAIN_ORDER) {
            for (const pos of (side === 'NS' ? ['N', 'S'] : ['E', 'W'])) {
                const cell = info[strain][pos];
                if (cell.tier === tier && cell.score === score) return ddTable[strain][pos] - 6;
            }
        }
        return null;
    };

    for (const gameSide of ['NS', 'EW']) {
        const otherSide = gameSide === 'NS' ? 'EW' : 'NS';
        const gameSummary = sideSummary[gameSide];
        const otherSummary = sideSummary[otherSide];
        if (gameSummary.activeTier !== 'game' && gameSummary.activeTier !== 'slam') continue; // rien à protéger ici
        if (otherSummary.activeTier === 'game' || otherSummary.activeTier === 'slam') continue; // l'autre a AUSSI son propre gros contrat
        if (!otherSummary.activeTier) { visible[otherSide] = false; continue; } // l'autre camp ne fait rien du tout : pas de sacrifice possible

        const gameLevel = bestLevelForSide(gameSide, gameSummary.activeTier, gameSummary.bestScore);
        const otherLevel = bestLevelForSide(otherSide, otherSummary.activeTier, otherSummary.bestScore);
        if (gameLevel === null || otherLevel === null) continue;

        const sacrificeLevel = gameLevel + 1;
        const undertricks = sacrificeLevel - otherLevel;
        const otherVuln = otherSide === 'NS' ? nsVuln : ewVuln;
        const penalty = doubledUndertrickScore(undertricks, otherVuln);
        if (Math.abs(penalty) >= gameSummary.bestScore) visible[otherSide] = false; // sacrifice pas rentable
    }
    return visible;
}

// Voir échange avec Guillaume (session du 8 août — "dans les PAR, ça serait bien de
// fondre les colonnes d'une ligne si c'est le même PAR... conserver la taille des 2
// colonnes additionnées mais faire en sorte que ça n'en fasse plus qu'une seule") :
// fusionne 2 cellules partenaires (N/S ou E/O) sur UNE ligne en une seule <td colspan=2>
// quand elles ont exactement la même valeur affichée ET la même mise en évidence —
// sinon garde 2 cellules séparées. Appliqué ligne par ligne (pas table entière) : une
// donne peut avoir SA différent entre les 2 partenaires mais toutes les autres couleurs
// identiques (voir l'exemple de Guillaume), auquel cas seule la ligne SA reste à 2
// cellules.
function renderDDCellPairHtml(strain, posA, posB, ddTable, info, sideSummary, sideVisibility) {
    const buildCell = (pos) => {
        const cellInfo = info[strain][pos];
        const summary = sideSummary[cellInfo.side];
        let cls = '';
        if (sideVisibility[cellInfo.side] && summary.activeTier && cellInfo.tier === summary.activeTier) {
            if (cellInfo.score === summary.bestScore) cls = 'dd-best-contract';
            else if (summary.activeTier !== 'partial') cls = 'dd-secondary-contract';
        }
        return { cls, text: tricksToContractLevel(ddTable[strain][pos]) };
    };
    const a = buildCell(posA);
    const b = buildCell(posB);
    const merged = a.text === b.text && a.cls === b.cls;
    if (merged) {
        return { html: `<td colspan="2"${a.cls ? ` class="${a.cls}"` : ''}>${a.text}</td>`, merged };
    }
    return { html: `<td${a.cls ? ` class="${a.cls}"` : ''}>${a.text}</td><td${b.cls ? ` class="${b.cls}"` : ''}>${b.text}</td>`, merged };
}

function renderDDTable(ddTable, dealVulnerable) {
    if (!ddTable) return '';
    const { info, sideSummary } = computeDDScores(ddTable, dealVulnerable);
    const sideVisibility = computeSacrificeAwareVisibility(ddTable, dealVulnerable, info, sideSummary);
    let allNSMerged = true;
    let allEWMerged = true;
    const rows = STRAIN_ORDER.map(strain => {
        const labelHtml = formatStrainLabel(strain);
        const ns = renderDDCellPairHtml(strain, 'N', 'S', ddTable, info, sideSummary, sideVisibility);
        const ew = renderDDCellPairHtml(strain, 'E', 'W', ddTable, info, sideSummary, sideVisibility);
        if (!ns.merged) allNSMerged = false;
        if (!ew.merged) allEWMerged = false;
        return `<tr><th class="${STRAIN_CLASS[strain]}">${labelHtml}</th>${ns.html}${ew.html}</tr>`;
    }).join('');
    // Voir échange avec Guillaume (session du 8 août — "je parle des cases tout en haut,
    // celle où il y a écrit 'N' et celle où il y a écrit 'S'") : l'en-tête lui-même
    // fusionne en une seule case "NS"/"EO" quand TOUTES les lignes ont fusionné pour
    // cette paire (pas juste certaines, voir allNSMerged/allEWMerged ci-dessus) — sinon
    // les 2 en-têtes séparés restent nécessaires pour rester alignés avec des cellules
    // qui, elles, ne fusionnent pas partout.
    const headerHtml = allNSMerged
        ? `<th colspan="2">NS</th>`
        : `<th>${SEAT_ABBR_FR.N}</th><th>${SEAT_ABBR_FR.S}</th>`;
    const headerHtmlEW = allEWMerged
        ? `<th colspan="2">EO</th>`
        : `<th>${SEAT_ABBR_FR.E}</th><th>${SEAT_ABBR_FR.W}</th>`;
    return `
        <div class="dd-table-title">Table du double mort</div>
        <table class="dd-table">
            <thead><tr><th></th>${headerHtml}${headerHtmlEW}</tr></thead>
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
// Voir échange avec Guillaume ("le bouton export PBN doit être disponible également pour
// les invités") : canControlBoard() plutôt que myRole==='host' — n'importe quel joueur
// assis (hôte ou invité), pas seulement l'hôte ; un simple kibitz reste exclu (aucun siège
// à lui, rien de personnel à exporter). Aucune restriction technique ne l'empêchait déjà
// côté serveur (le jeton d'écriture GitHub vit côté fonction Vercel, jamais dans le
// navigateur) — seule la condition d'affichage ci-dessous, et ce garde, la limitaient.
function uiExportDealPBN() {
    if (!canControlBoard()) return;
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
    const diagramEl = document.getElementById('allHandsDiagram');

    const auctionOver = isAuctionOver(auctionHistory);
    // L'hôte peut choisir de voir les 4 mains à tout moment (voir uiToggleHostSeeAllHands),
    // même pendant l'enchère — un outil réservé à lui seul (vérifier une donne, aider un
    // débutant en direct...), jamais envoyé ni visible pour les autres joueurs. Un
    // kibbitz, lui, voit toujours les 4 mains dès le début (voir renderMyHands) — pas
    // besoin d'attendre la fin de l'enchère ni une action de l'hôte, puisqu'il n'est
    // assis à aucun siège et ne peut donc rien "tricher" en les voyant.
    //
    // Voir échange avec Guillaume : PRIVILÈGE DU VRAI HÔTE (voir isTrueOriginalHost) —
    // un hôte qui joue lui-même une main (ex. donner un cours) doit pouvoir l'activer
    // pour tout voir, mais "myRole==='host'" seul est trop large en mode différé
    // (n'importe quel joueur reprenant une salle abandonnée devient 'host' techniquement
    // sans être le vrai créateur — lui laisser ce privilège reviendrait à le laisser
    // tricher sur sa propre main, voir isTrueOriginalHost pour le détail).
    const hostForcedReveal = isTrueOriginalHost() && hostSeeAllHands;
    const showAllHandsEarly = hostForcedReveal || isKibbitz();

    if (!auctionOver) {
        resultEl.style.display = 'none';
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
    // Voir échange avec Guillaume (session du 8 août — ""Export PBN" devrait être en
    // haut à droite dans le carré du PAR, à droite de la ligne contrat final") : calculé
    // ICI (avant de construire la ligne d'en-tête), pour savoir dès le départ si le
    // bouton doit y apparaître — auparavant calculé après coup, forçant le bouton dans
    // une rangée séparée sous le tableau entier.
    const ddTableHtml = renderDDTable(currentDeal().ddTable, currentDeal().vulnerable);
    // Ne joue l'animation de révélation (voir .contract-reveal dans styles.css) qu'au
    // moment précis où le contrat apparaît, pas à chaque re-rendu (renderBoard tourne
    // pour bien d'autres raisons — reconnexion d'un joueur, etc. — tant que la donne
    // reste sur cet écran) : on la déclenche seulement s'il était masqué juste avant.
    const wasHidden = resultEl.style.display === 'none' || resultEl.style.display === '';
    resultEl.style.display = 'block';
    // Voir échange avec Guillaume ("le bouton export PBN doit être disponible également
    // pour les invités") : canControlBoard() plutôt que myRole==='host' — voir le même
    // commentaire détaillé sur uiExportDealPBN plus haut. Affiché seulement une fois le
    // double mort disponible.
    const exportBtnHtml = (canControlBoard() && ddTableHtml) ? `
        <span class="dd-export-row">
            <button type="button" class="btn btn-secondary btn-small" id="dealExportBtn" onclick="uiExportDealPBN()">📤 Export PBN</button>
            <span id="dealExportStatus" class="dd-export-status"></span>
        </span>
    ` : '';
    if (!contract) {
        resultEl.innerHTML = `<div class="contract-final-header"><span class="contract-final-text">↩️ Donne passée — personne n'a annoncé.</span>${exportBtnHtml}</div>`;
    } else {
        const strainCls = SUIT_CLASSES[contract.strain] || 'notrump';
        const strainLabel = formatStrainLabel(contract.strain);
        const contractHtml = `<span class="call-suit ${strainCls}">${contract.level}${strainLabel}${escapeHtml(contract.doubled)}</span>`;
        resultEl.innerHTML = `<div class="contract-final-header"><span class="contract-final-text">Contrat final : <strong>${contractHtml}</strong> par <strong>${seatFullName(contract.declarer)}</strong></span>${exportBtnHtml}</div>`;
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

    if (ddTableHtml) {
        resultEl.innerHTML += ddTableHtml;
    }

    // Voir échange avec Guillaume ("une fois la donne finie, les 4 mains doivent
    // apparaître pour l'hôte, que l'option soit ON ou OFF") : inconditionnel pour tout le
    // monde une fois l'enchère terminée, y compris l'hôte — la bascule
    // hostSeeAllHands/isTrueOriginalHost ne joue un rôle QUE pendant l'enchère (voir plus
    // haut, if (!auctionOver)), jamais après. Un essai précédent avait rendu ceci
    // conditionnel pour l'hôte, ce qui n'était pas ce qui était demandé — revenu à
    // l'affichage inconditionnel d'origine.
    renderAllHandsDiagram();
    diagramEl.style.display = 'grid';
    {
        const myHandsEl = document.getElementById('myHandsContainer');
        if (myHandsEl) myHandsEl.style.display = 'none';
    }

    const isLastBoard = boardIndex >= deals.length - 1;
    // Voir échange avec Guillaume (session du 23 juillet) : réservé à l'HÔTE désormais,
    // pas à n'importe quel joueur actif (canControlBoard()) — un simple joueur, ou un
    // kibitz, ne doit pas pouvoir faire avancer la table pour tout le monde.
    const iCanNavigate = myRole === 'host';

    if (isLastBoard) {
        resultEl.innerHTML += '<div class="info-text">Dernière donne du fichier chargé.</div>';
    } else if (!iCanNavigate) {
        resultEl.innerHTML += '<div class="info-text">En attente que l\'hôte passe à la donne suivante.</div>';
    } else {
        // Voir échange avec Guillaume ("je t'avais pas demandé à ce que ce bouton soit
        // dans la zone des PARs ?") : DANS resultEl (la case du PAR elle-même), comme
        // demandé à l'origine — pas un nœud DOM séparé positionné par-dessus (l'ancienne
        // approche en position:absolute ne s'ancrait en réalité jamais correctement, voir
        // git blame). Une simple chaîne HTML ajoutée ici survit sans problème à la
        // reconstruction complète de resultEl.innerHTML à chaque rendu, puisqu'elle en
        // fait justement partie.
        resultEl.innerHTML += '<div class="next-board-panel"><button type="button" class="btn btn-secondary btn-small" onclick="uiNextBoard()">Donne suivante →</button></div>';
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
    // Voir échange avec Guillaume ("undo en mode différé") : même règle que côté
    // hostHandleUndoRequest — un simple joueur (pas le vrai créateur) en mode différé ne
    // peut annuler SA PROPRE dernière annonce que tant que son partenaire n'a rien annoncé
    // depuis. Le vrai créateur n'est jamais concerné (son undo cible la dernière annonce
    // humaine de toute la table, pas seulement la sienne — voir findHostUndoTargetIndex),
    // ni le mode live (qui garde son propre mécanisme d'accord d'adversaire).
    const isDeferredNonCreator = deals && (peerConn instanceof NullPeerConnection) && !isTrueOriginalHost();
    const blockedByPartnerSince = isDeferredNonCreator
        && findUndoTargetIndex(myParticipantId, auctionHistory) <= findPartnerLastCallIndex(myParticipantId, auctionHistory);
    btn.disabled = !visible || !deals || auctionHistory.length === 0 || undoRequestPending || !!pendingUndoAsk || blockedByPartnerSince;
    // Deux <span> (voir index.html) plutôt qu'un textContent direct : .btn-label-full/
    // .btn-label-short sont affichés en alternance en CSS selon la largeur d'écran
    // (bouton complet sur desktop, abrégé sur mobile où la place manque).
    // Libellé différent pour l'hôte (voir échange avec Guillaume) : son undo s'applique
    // immédiatement, sans validation du camp d'en face (voir hostHandleUndoRequest) — "Faire
    // un undo" plutôt que "Demander", et jamais l'état intermédiaire "Demande envoyée..."
    // qui n'a pas de sens quand ça s'applique tout de suite. Vrai aussi pour tout
    // participant en mode différé (myRole==='host' localement pour tout le monde là-bas,
    // voir uiResumeFromCloud) : son undo s'applique désormais directement lui aussi (voir
    // hostHandleUndoRequest), jamais de "Demande envoyée..." qui n'aurait de toute façon
    // personne en ligne pour y répondre.
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
    if (pid === SEAT_PENDING) return 'En attente…';
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
// lieu de sa propre annonce.
// Voir échange avec Guillaume (session du 8 août — "faire un undo par l'hôte devrait
// annuler la dernière enchère produite (si elle a été faite par un humain ; si c'est un
// bot, annuler la dernière enchère produite par un humain)") : distincte de
// findUndoTargetIndex ci-dessus (qui cible SA PROPRE dernière annonce pour une demande
// d'un participant précis) — ici, l'hôte cliquant sur SON bouton d'undo direct vise la
// toute dernière annonce de l'historique, MAIS en sautant les annonces de robots (sièges
// non occupés par un humain au sens de seatAssignment) pour retomber sur la dernière
// vraiment humaine. Renvoie -1 si l'historique entier n'a que des annonces de robots
// (rien d'humain à annuler).
function findHostUndoTargetIndex(history) {
    for (let i = history.length - 1; i >= 0; i--) {
        const occupant = seatAssignment[history[i].seat];
        if (occupant && occupant !== SEAT_PENDING) return i;
    }
    return -1;
}

function findUndoTargetIndex(requesterId, history) {
    const seats = seatsOfParticipant(requesterId);
    for (let i = history.length - 1; i >= 0; i--) {
        if (seats.includes(history[i].seat)) return i;
    }
    return -1;
}

// Voir échange avec Guillaume ("undo en mode différé") : index de la dernière annonce du
// PARTENAIRE de ce participant (même camp, sièges qu'il ne contrôle PAS lui-même) — sert
// uniquement à la règle d'undo du mode différé (voir hostHandleUndoRequest/
// renderUndoControls), pas au mode live qui garde son propre mécanisme d'accord
// d'adversaire. -1 si le partenaire (au sens : le reste de son camp) n'a encore rien
// annoncé, ou si ce participant contrôle déjà tout son camp lui-même (aucun partenaire
// distinct — voir échange avec Guillaume, "je jouais E/O" — dans ce cas l'undo n'est
// jamais bloqué par cette règle, seul un adversaire a pu enchérir depuis, ce qui ne compte
// pas).
function findPartnerLastCallIndex(requesterId, history) {
    const mySeats = seatsOfParticipant(requesterId);
    if (mySeats.length === 0) return -1;
    const myPartnerships = new Set(mySeats.map(partnershipOf));
    const partnerSeats = SEATS.filter(seat => myPartnerships.has(partnershipOf(seat)) && !mySeats.includes(seat));
    for (let i = history.length - 1; i >= 0; i--) {
        if (partnerSeats.includes(history[i].seat)) return i;
    }
    return -1;
}

function guestIndexForParticipant(pid) {
    if (!pid || pid === 'host') return null;
    return Object.prototype.hasOwnProperty.call(guestIndexByToken, pid) ? guestIndexByToken[pid] : null;
}

function undoRejectReasonText(reason) {
    switch (reason) {
        case 'declined': return 'Annulation refusée.';
        case 'timeout': return "Personne n'a répondu à temps.";
        case 'busy': return 'Une autre demande est déjà en cours, réessayez.';
        case 'stale': return 'La situation a changé entre-temps, réessayez.';
        case 'nothing': return "Vous n'avez fait aucune annonce à annuler sur cette donne.";
        case 'partner-since': return 'Votre partenaire a annoncé depuis — impossible d\'annuler cette annonce.';
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

    // Voir échange avec Guillaume (session du 8 août — "faire un undo par l'hôte devrait
    // annuler la dernière enchère produite (si elle a été faite par un humain ; si c'est
    // un bot, annuler la dernière enchère produite par un humain)") : l'undo DIRECT de
    // l'hôte (requesterId==='host' ou roomCreatorToken, voir plus bas) cible la dernière
    // annonce HUMAINE de tout l'historique (findHostUndoTargetIndex), pas SA PROPRE
    // dernière annonce (findUndoTargetIndex, qui reste utilisée pour un simple joueur
    // assis demandant l'accord de l'hôte — celui-là ne peut annuler que la sienne).
    const isHostDirectUndo = msg.requesterId === 'host' || msg.requesterId === roomCreatorToken;
    const targetIndex = isHostDirectUndo
        ? findHostUndoTargetIndex(auctionHistory)
        : findUndoTargetIndex(msg.requesterId, auctionHistory);
    if (targetIndex < 0) {
        deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'nothing' });
        return;
    }

    // L'hôte peut annuler unilatéralement, sans validation de personne (voir échange avec
    // Guillaume) — l'hôte arbitre déjà toute la table ; un simple joueur assis, lui,
    // reste soumis à l'accord de l'hôte (voir plus bas, ex-humanOpponentsFor).
    //
    // Voir échange avec Guillaume ("2 modes : live / différé") : en mode différé,
    // myParticipantId (et donc requesterId ici) n'est JAMAIS la chaîne littérale 'host' —
    // c'est le vrai jeton du créateur (voir roomCreatorToken, figé à la création/au
    // lancement, jamais réécrit). Sans ce second cas, un créateur en mode différé perdait
    // son droit d'arbitrage unilatéral.
    if (isHostDirectUndo) {
        applyUndoAsHost({ boardIndex: msg.boardIndex, requesterId: msg.requesterId, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex });
        return;
    }

    // Voir échange avec Guillaume ("undo en mode différé") : pas d'adversaire humain EN
    // LIGNE à qui demander l'accord en mode différé (NullPeerConnection) — la bannière
    // accepter/refuser ci-dessous ne serait jamais vue par personne d'autre que le
    // demandeur lui-même (qui jouerait alors sa propre demande à sa place), et le délai de
    // 20s ci-dessous finirait toujours par rejeter pour rien. Remplacé par une règle
    // locale, sans validation d'autrui : ce simple joueur peut annuler SA PROPRE dernière
    // annonce (targetIndex, déjà calculé ci-dessus via findUndoTargetIndex) tant que son
    // PARTENAIRE n'a rien annoncé depuis (sinon la correction toucherait une décision déjà
    // prise par le partenaire sur la base de cette annonce) — même règle appliquée à
    // l'activation/désactivation du bouton, voir renderUndoControls.
    if (peerConn instanceof NullPeerConnection) {
        const partnerIdx = findPartnerLastCallIndex(msg.requesterId, auctionHistory);
        if (targetIndex <= partnerIdx) {
            deliverToParticipant(msg.requesterId, { type: 'undo-rejected', boardIndex: msg.boardIndex, requesterId: msg.requesterId, reason: 'partner-since' });
            return;
        }
        applyUndoAsHost({ boardIndex: msg.boardIndex, requesterId: msg.requesterId, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex });
        return;
    }

    // Voir échange avec Guillaume ("si demande d'undo, il faut validation de l'host, pas
    // que ça marche automatiquement") : ce n'est plus l'ADVERSAIRE humain qui est
    // sollicité pour approuver la demande d'un simple joueur assis — c'est l'HÔTE
    // lui-même, seul arbitre de la table. humanOpponentsFor n'est donc plus utilisé ici
    // (son ancien rôle, demander l'accord du camp d'en face, est abandonné).
    //
    // Puisque cette fonction tourne déjà côté hôte, pas besoin d'aller-retour réseau : on
    // réutilise directement le mécanisme générique pendingUndoAsk/renderUndoAskBanner/
    // uiAnswerUndo (déjà prévu pour fonctionner en local quand myRole==='host', voir
    // hostReceiveUndoAnswer plus bas) — la même bannière "accepter/refuser" s'affiche
    // simplement sur l'écran de l'hôte au lieu d'être envoyée à un adversaire distant.
    pendingUndoAsk = { requesterId: msg.requesterId, boardIndex: msg.boardIndex, historyLengthAtRequest: msg.historyLengthAtRequest };
    hostPendingUndo = { requesterId: msg.requesterId, boardIndex: msg.boardIndex, historyLengthAtRequest: msg.historyLengthAtRequest, targetIndex };
    renderUndoAskBanner();

    setTimeout(() => {
        if (hostPendingUndo &&
            hostPendingUndo.requesterId === msg.requesterId &&
            hostPendingUndo.boardIndex === msg.boardIndex &&
            hostPendingUndo.historyLengthAtRequest === msg.historyLengthAtRequest) {
            hostPendingUndo = null;
            pendingUndoAsk = null;
            renderUndoAskBanner();
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

// Réservé au VRAI créateur (le bouton lui-même est déjà masqué pour tout autre rôle, voir
// updateBoardControlVisibility, mais on se protège quand même ici en cas d'appel direct —
// voir échange avec Guillaume, "en mode différé, l'invité ne devrait pas avoir
// recommencer l'enchère").
function uiResetAuction() {
    if (!isTrueOriginalHost() || !canControlBoard()) return;
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
// bouton "Donne suivante →" (réservé à l'hôte, voir échange avec Guillaume — session du 23
// juillet, uniquement une fois l'enchère terminée, voir checkAuctionEnd) et par les
// flèches ◀▶ de navigation libre, également réservées à l'hôte.
function gotoBoard(newIndex) {
    boardIndex = newIndex;
    if (!deals[boardIndex].auctionHistory) deals[boardIndex].auctionHistory = [];
    auctionHistory = deals[boardIndex].auctionHistory;
    hostPendingUndo = null;
    clearUndoUiState();
    renderBoard();
    peerConn.send({ type: 'goto-board', boardIndex });
    saveHostGameStateToStorage();
}

function uiNextBoard() {
    if (myRole !== 'host') return;
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

// Voir échange avec Guillaume (session asynchrone à deux — "écran récapitulatif de toutes
// les donnes") : statut de chaque donne en un coup d'œil, sans avoir à les parcourir une
// par une. Accessible à tout le monde (lecture), mais seul l'hôte peut s'en servir pour
// sauter directement à une donne (voir uiJumpToBoardFromOverview) — même règle que les
// flèches ◀▶ existantes, réservées à l'hôte.
// Voir échange avec Guillaume (session du 8 août — nouvelle vue d'ensemble) : quel siège
// afficher pour un joueur qui n'occupe qu'UNE place normalement — mais qui peut en
// occuper deux (ex. un robot remplacé temporairement). Dans ce cas, celui qui doit
// effectivement enchérir sur CETTE donne précise prime ; hors de son tour (ou enchère
// terminée), repli sur le premier de ses sièges.
function myEffectiveSeatForDeal(deal) {
    if (!mySeats || mySeats.length === 0) return null;
    if (mySeats.length === 1) return mySeats[0];
    const hist = deal.auctionHistory || [];
    if (!isAuctionOver(hist)) {
        const turnSeat = currentTurnSeat(deal.dealer, hist);
        if (mySeats.includes(turnSeat)) return turnSeat;
    }
    return mySeats[0];
}

// Voir échange avec Guillaume ("l'app calcule le PAR même si le PBN ne le contient
// pas") : dérive le contrat PAR (approximatif — le meilleur contrat réalisable du camp
// qui peut scorer le plus, pas un vrai calcul de PAR tournoi avec sacrifices) à partir
// de la table du double mort déjà calculée pour cette donne (voir kickOffBackgroundDD),
// en réutilisant computeDDScores tel quel plutôt que dupliquer sa logique. Renvoie null
// tant que la table n'est pas encore prête (calcul en tâche de fond, voir missingDD).
function getParContractCell(ddTable, dealVulnerable, preferredStrain) {
    if (!ddTable) return null;
    const { info, sideSummary } = computeDDScores(ddTable, dealVulnerable);
    const nsScore = sideSummary.NS.bestScore;
    const ewScore = sideSummary.EW.bestScore;
    if (nsScore === null && ewScore === null) return null; // aucun camp ne fait le moindre pli au-dessus de 6, rarissime
    const winningSide = (nsScore ?? -Infinity) >= (ewScore ?? -Infinity) ? 'NS' : 'EW';
    const summary = sideSummary[winningSide];
    const sidePositions = winningSide === 'NS' ? ['N', 'S'] : ['E', 'W'];
    // Voir échange avec Guillaume ("il y a 5♠ et 5♥, comme on est arrivé au contrat de
    // 4♥, le PAR affiché devrait être 5♥ plutôt que 5♠") : quand plusieurs couleurs sont
    // À ÉGALITÉ pour le meilleur palier, celle réellement jouée en séquence prime sur
    // l'ordre arbitraire de STRAIN_ORDER — plus parlant pour le joueur qui compare son
    // résultat au PAR. On collecte donc TOUTES les couleurs à égalité avant de choisir,
    // au lieu de s'arrêter à la première trouvée.
    const tiedStrains = [];
    for (const strain of STRAIN_ORDER) {
        const matchingPositions = sidePositions.filter(pos => {
            const cell = info[strain][pos];
            return cell.tier === summary.activeTier && cell.score === summary.bestScore;
        });
        if (matchingPositions.length > 0) tiedStrains.push({ strain, matchingPositions });
    }
    if (tiedStrains.length === 0) return null;
    const chosen = (preferredStrain && tiedStrains.find(t => t.strain === preferredStrain)) || tiedStrains[0];
    const level = ddTable[chosen.strain][chosen.matchingPositions[0]] - 6;
    const declarer = chosen.matchingPositions.length === sidePositions.length ? winningSide : chosen.matchingPositions[0];
    return { strain: chosen.strain, level, declarer };
}

// Petit badge de contrat réutilisable (même classe .call-suit que partout ailleurs dans
// l'appli — relevé d'enchères, contrat final, table du double mort — pour rester
// visuellement cohérent) : palier + couleur colorée, plus le déclarant en toutes
// lettres à côté si fourni.
function contractBadgeHtml(strain, level, declarerSeat, doubled) {
    const strainCls = SUIT_CLASSES[strain] || 'notrump';
    const strainLabel = formatStrainLabel(strain);
    const declarerHtml = declarerSeat ? ` <span class="board-overview-declarer">${declarerSeat}</span>` : '';
    return `<span class="call-suit ${strainCls}">${level}${strainLabel}${doubled || ''}</span>${declarerHtml}`;
}

// Main compacte sur une seule ligne (♠JT6 ♥T6 ♦KT932 ♣K32), pour tenir dans une ligne de
// liste — contrairement à dealPreviewHandCardHtml (carte empilée, trop haute ici).
// Voir échange avec Guillaume ("le nombre de points, légèrement à droite des cartes") :
// badge HCP ajouté après les 4 couleurs, "XXH" en italique — même info que le badge HCP
// des autres vues (renderMyHands/buildAllHandsHtml), format condensé pour tenir sur une
// seule ligne ici plutôt que "XX HCP" comme ailleurs.
function compactHandHtml(hand) {
    if (!hand) return '<span class="board-overview-hand-empty">—</span>';
    const suitsHtml = ['S', 'H', 'D', 'C'].map(suit =>
        `<span class="board-overview-hand-suit">${suitIconHtml(suit)}${formatRanksForDisplay(hand[suit]) || '—'}</span>`
    ).join('');
    return `${suitsHtml}<span class="board-overview-hand-hcp">${computeHandHcp(hand)}H</span>`;
}

function renderBoardOverview() {
    const listEl = document.getElementById('boardOverviewList');
    if (!listEl || !deals) return;
    listEl.innerHTML = deals.map((deal, idx) => {
        const hist = deal.auctionHistory || [];
        const mySeat = myEffectiveSeatForDeal(deal);
        const handHtml = compactHandHtml(mySeat ? deal.hands[mySeat] : null);
        const auctionOver = isAuctionOver(hist);

        let reachedHtml;
        let titleAttr = '';
        let reachedContract = null;
        if (auctionOver) {
            if (isPassedOut(hist)) {
                reachedHtml = '<span class="board-overview-status is-done">Passé</span>';
            } else {
                reachedContract = determineContract(hist);
                reachedHtml = contractBadgeHtml(reachedContract.strain, reachedContract.level, reachedContract.declarer, reachedContract.doubled);
            }
        } else {
            // Voir échange avec Guillaume ("le point d'interrogation... doit être en
            // rouge si le joueur concerné est celui dont on attend l'enchère pour
            // continuer") : même logique que la donne n'ait pas encore commencé (le
            // donneur doit ouvrir) ou soit déjà en cours — dans les 2 cas, quelqu'un
            // doit agir, et le "?" devient rouge précisément si c'est MOI (un de mes
            // sièges) qu'on attend.
            const turnSeat = currentTurnSeat(deal.dealer, hist);
            const isMyTurnHere = mySeats && mySeats.includes(turnSeat);
            const occupantId = seatAssignment[turnSeat];
            const occupantLabel = !occupantId
                ? 'un robot'
                : (occupantId === SEAT_PENDING ? 'un partenaire pas encore arrivé' : participantName(occupantId));
            reachedHtml = `<span class="board-overview-status ${isMyTurnHere ? 'needs-me' : 'is-waiting'}">?</span>`;
            titleAttr = hist.length === 0
                ? (isMyTurnHere ? 'À vous d\'ouvrir' : `En attente de ${seatFullName(turnSeat)} (${occupantLabel})`)
                : (isMyTurnHere ? 'À vous d\'enchérir' : `En attente de ${seatFullName(turnSeat)} (${occupantLabel})`);
        }

        // Voir échange avec Guillaume ("le PAR ne doit apparaître que si la séquence
        // d'enchère est finie") : masqué tant que l'enchère n'est pas terminée, plutôt
        // que de révéler par avance ce qui serait un bon résultat.
        let parHtml = '<span class="board-overview-status is-pending">—</span>';
        if (auctionOver) {
            const reachedStrainForPar = reachedContract ? (reachedContract.strain === 'NT' ? 'N' : reachedContract.strain) : null;
            const parCell = getParContractCell(deal.ddTable, deal.vulnerable, reachedStrainForPar);
            if (parCell) {
                parHtml = contractBadgeHtml(parCell.strain, parCell.level, parCell.declarer);
            } else if (deal.par && deal.par.contract) {
                // Repli sur le résumé PBN préformaté (voir dealPreviewParText) si la
                // table complète n'est pas dispo mais qu'un PAR direct l'était à l'import.
                parHtml = `<span class="board-overview-status">${escapeHtml(deal.par.contract)}${deal.par.declarer ? ' ' + escapeHtml(deal.par.declarer) : ''}</span>`;
            }
        }

        const activeClass = idx === boardIndex ? ' is-current' : '';
        return `
            <button type="button" class="board-overview-row${activeClass}" onclick="uiJumpToBoardFromOverview(${idx})"${titleAttr ? ` title="${escapeHtml(titleAttr)}"` : ''}>
                <span class="board-overview-number">${deal.board != null ? deal.board : idx + 1}</span>
                <span class="board-overview-hand">${handHtml}</span>
                <span class="board-overview-contract">${reachedHtml}</span>
                <span class="board-overview-par">${parHtml}</span>
            </button>
        `;
    }).join('');
}

function uiOpenBoardOverview() {
    if (!deals) return;
    renderBoardOverview();
    const modal = document.getElementById('boardOverviewModal');
    if (modal) modal.style.display = 'flex';
}

function uiCloseBoardOverview() {
    const modal = document.getElementById('boardOverviewModal');
    if (modal) modal.style.display = 'none';
}

function uiCloseBoardOverviewOnBackdrop(evt) {
    if (evt.target.id === 'boardOverviewModal') uiCloseBoardOverview();
}

function uiJumpToBoardFromOverview(idx) {
    uiCloseBoardOverview();
    // Même règle que les flèches ◀▶ existantes : seul l'hôte pilote la navigation entre
    // donnes (voir renderBoardSkipControls) — un invité peut consulter la vue d'ensemble,
    // pas s'en servir pour déplacer tout le monde.
    if (myRole !== 'host') return;
    if (idx === boardIndex) return;
    gotoBoard(idx);
}

// Voir échange avec Guillaume (session asynchrone à deux — bouton "avance rapide") :
// saute à la prochaine donne où c'est le tour d'un de MES sièges, en CONTINUANT dans
// l'ordre numérique à partir de la donne actuelle plutôt que de repartir de la donne 1 —
// une donne plus loin dans l'ordre (ex. la 7 après avoir fini la 6) est prioritaire sur
// une donne plus tôt (ex. la 2), qu'on ne retrouve qu'en bouclant si rien de plus proche
// n'attend. Avance les robots au passage (voir advanceRobotBidsOnBoard), au cas où une
// donne n'aurait pas encore été touchée depuis un chargement antérieur à ce correctif.
// Réservé à l'hôte, même règle que ◀▶ et la vue d'ensemble.
function uiFastForwardToMyTurn() {
    if (myRole !== 'host' || !deals) return;
    const n = deals.length;
    for (let offset = 1; offset <= n; offset++) {
        const idx = (boardIndex + offset) % n;
        advanceRobotBidsOnBoard(idx);
        const hist = deals[idx].auctionHistory || [];
        if (isAuctionOver(hist)) continue;
        const turnSeat = currentTurnSeat(deals[idx].dealer, hist);
        if (mySeats.includes(turnSeat)) {
            if (idx !== boardIndex) gotoBoard(idx);
            return;
        }
    }
    // Aucune donne ne m'attend nulle part (tout est déjà fait de mon côté, ou terminé
    // partout) : plutôt qu'un message qui disparaît sans donner de vue d'ensemble, on
    // ouvre directement la vue d'ensemble — elle montre précisément pourquoi (tout
    // terminé, ou en attente d'un partenaire/robot ailleurs).
    pushDebugLog("Avance rapide : aucune donne n'attend une de mes annonces pour l'instant.");
    uiOpenBoardOverview();
}

function renderBoardSkipControls() {
    const prevBtn = document.getElementById('prevBoardBtn');
    const nextBtn = document.getElementById('skipNextBoardBtn');
    const fastForwardBtn = document.getElementById('fastForwardBoardBtn');
    if (!prevBtn || !nextBtn) return;
    const isHost = myRole === 'host';
    // Voir échange avec Guillaume ("Donne #... devrait être à la même place pour l'invité
    // que pour l'hôte, l'invité ne doit juste pas voir les 2 flèches") : visibility (pas
    // display:none) — sans ça, les flèches masquées disparaissaient du flux flex
    // (.board-nav-row), et #boardNumberLabel, leur voisin direct, se retrouvait décalé
    // vers la gauche pour un invité par rapport à l'hôte (même principe déjà utilisé pour
    // rotateBtn/seatReorgBtn, voir updateBoardControlVisibility).
    prevBtn.style.visibility = isHost ? '' : 'hidden';
    prevBtn.style.pointerEvents = isHost ? '' : 'none';
    nextBtn.style.visibility = isHost ? '' : 'hidden';
    nextBtn.style.pointerEvents = isHost ? '' : 'none';
    // Voir échange avec Guillaume ("la flèche avance rapide ne doit pas apparaître en cas
    // de jeu non différé") : "avance rapide" saute à la prochaine donne où c'est mon tour
    // AILLEURS — utile seulement en mode différé, où les donnes avancent indépendamment
    // les unes des autres au fil des connexions successives. En live, tout le monde est
    // connecté en même temps sur la même donne : il n'y a jamais rien à "rattraper"
    // ailleurs, le bouton n'a donc pas de sens et ne doit pas apparaître, même pour
    // l'hôte. Même repère que pollCloudForUpdates pour détecter le mode différé
    // (`peerConn instanceof NullPeerConnection`), fixé au lancement de la salle.
    const isDeferredRoom = peerConn instanceof NullPeerConnection;
    const showFastForward = isHost && isDeferredRoom;
    if (fastForwardBtn) {
        fastForwardBtn.style.visibility = showFastForward ? '' : 'hidden';
        fastForwardBtn.style.pointerEvents = showFastForward ? '' : 'none';
    }
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
    //
    // Voir échange avec Guillaume ("ça glitch comme si j'avais pressé F5" pendant la
    // saisie du pseudo, reproduit sur PC/Chrome sans émulateur) : CE listener-ci n'était
    // pas protégé par le même garde-fou que tryAutoApplyUpdate() plus bas. Il peut se
    // déclencher tout seul, à l'initiative du NAVIGATEUR (pas de notre fait), dès le tout
    // premier chargement d'un onglet flambant neuf si une version plus récente était déjà
    // "en attente" suite à un déploiement précédent (fréquent ce soir, vu le nombre de
    // déploiements coup sur coup) — rechargeant la page inconditionnellement, pile pendant
    // que quelqu'un tape son pseudo. Même principe de report ici : si ce n'est pas sûr de
    // recharger maintenant, on le note et on réessaie via le même sondage périodique.
    let reloadedForUpdate = false;
    let controllerChangeReloadPending = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadedForUpdate) return;
        if (peerConn || pendingJoinAfterNickname) {
            controllerChangeReloadPending = true;
            return;
        }
        reloadedForUpdate = true;
        window.location.reload();
    });

    // Filet de sécurité : si une mise à jour est détectée pendant qu'une connexion de salle
    // est active (voir tryAutoApplyUpdate ci-dessous), elle reste en attente sans jamais
    // relancer d'elle-même — ce sondage périodique retente régulièrement, pour l'appliquer
    // dès qu'on revient à un moment sûr (plus aucune salle active) sans dépendre uniquement
    // d'un changement d'écran pour s'en rendre compte. Couvre aussi le rattrapage du
    // controllerchange différé juste au-dessus.
    setInterval(() => {
        if (controllerChangeReloadPending && !reloadedForUpdate && !peerConn && !pendingJoinAfterNickname) {
            reloadedForUpdate = true;
            window.location.reload();
            return;
        }
        tryAutoApplyUpdate();
    }, 30000);
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
    // Voir échange avec Guillaume (session asynchrone à deux — "ça saute comme si j'avais
    // refresh" pendant la saisie du pseudo) : entre l'ouverture du lien et la validation du
    // pseudo, peerConn n'existe pas ENCORE (voir ensureNicknameThenProceed) — sans ce
    // garde-fou, une mise à jour détectée pile à ce moment-là rechargeait la page sous les
    // doigts de la personne en train de taper, avant même la moindre tentative de connexion.
    if (pendingJoinAfterNickname) return;
    pendingSwRegistration.waiting.postMessage('skipWaiting');
}

// iPadOS se fait passer pour un Mac (navigator.platform "MacIntel") depuis la version 13 :
// le distinguer d'un vrai Mac se fait via le support tactile, qu'aucun Mac n'a.
function isIosDevice() {
    return (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

// Voir échange avec Guillaume ("le bouton bug ouvre le partage natif de Windows sur PC,
// c'est pas normal") : navigator.share (utilisé dans uiReportBug pour décider entre
// feuille de partage et copie presse-papiers) existe AUSSI sur desktop — Chrome/Windows le
// relaie vers le panneau "Partager" natif de Windows, comme on vient de le constater en
// pratique. Sa seule présence ne permet donc pas de distinguer mobile de desktop ; détection
// par user-agent à la place, même repli tactile que isIosDevice ci-dessus pour le cas iPad.
function isMobileOrTabletDevice() {
    return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(navigator.userAgent)
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

// Voir échange avec Guillaume (session du 23 juillet — "si l'hôte refresh dans le salon,
// ça devrait clôturer la room") : PREMIER essai avec beforeunload (retirer le code de
// l'URL juste avant le rechargement) — ne fonctionnait pas, le navigateur a déjà figé
// quelle URL il va recharger avant que ce code n'ait la moindre chance de s'exécuter,
// donc la modifier à ce moment-là n'a aucun effet sur le rechargement en cours. Reprise
// avec sessionStorage à la place (survit à un rechargement de CET onglet, contrairement
// aux variables JS) : posé tant que l'hôte est dans le salon (avant le lancement, voir
// enterLobbyScreen), retiré dès que la partie démarre (voir uiStartGameAsHost). Au
// chargement de la page, AVANT de tenter quoi que ce soit avec un ?room= dans l'URL, on
// vérifie s'il correspond à une salle qu'on hébergeait nous-même, encore dans le salon,
// juste avant ce rechargement — auquel cas elle est morte de toute façon (rien n'est
// persistant), pas la peine de tenter (et échouer) à la rejoindre.
const HOSTING_PREGAME_KEY = 'bridgeBidHostingPregameRoom';

function markHostingPregame(roomCode) {
    try { sessionStorage.setItem(HOSTING_PREGAME_KEY, roomCode); } catch (e) { /* tant pis */ }
}

function clearHostingPregameMark() {
    try { sessionStorage.removeItem(HOSTING_PREGAME_KEY); } catch (e) { /* tant pis */ }
}

// ===== Reprise de partie après fermeture complète de l'onglet (voir échange avec
// Guillaume, session du 23 juillet) =====
//
// Contrairement à HOSTING_PREGAME_KEY ci-dessus (qui ne fait que nettoyer une URL avant un
// rechargement), ceci sauvegarde l'état COMPLET de la partie EN COURS (donnes, enchère,
// sièges, participants) dans localStorage — qui, contrairement à sessionStorage et aux
// variables JS, survit à la fermeture complète du navigateur, voire à un redémarrage de
// l'appareil. Limite assumée : ne fonctionne que sur le MÊME appareil et le MÊME
// navigateur (localStorage est propre à cette combinaison), pas depuis un autre — pour
// couvrir ce cas-là, voir plutôt le relais serveur par siège (voir
// ARCHITECTURE-P2P-SERVEUR.md), pensé précisément pour "continuer depuis un autre appareil
// sans l'hôte d'origine".
const HOST_GAME_STATE_KEY = 'bridgeBidHostGameStates'; // carte {roomCode: payload}, voir échange avec Guillaume (session du 8 août — "multi room")
// Passé ce délai, une session sauvegardée n'est plus proposée à la reprise — un chiffre
// volontairement généreux (une session de club peut s'étaler sur plusieurs heures avec
// pauses), sans non plus laisser une bannière "reprendre" resurgir des jours après une
// partie oubliée.
const HOST_GAME_STATE_EXPIRY_MS = 6 * 60 * 60 * 1000; // 6h
// Voir échange avec Guillaume (session du 8 août — "multi room") : plafond du nombre de
// salles mémorisées simultanément, pour ne pas laisser localStorage grossir sans limite
// au fil des semaines — au-delà, la plus ancienne (par savedAt) est évincée en priorité,
// avant même de regarder l'expiration.
const MAX_SAVED_HOST_SESSIONS = 8;

// Lit la carte complète {roomCode: payload} depuis localStorage, purgée des entrées
// expirées au passage (jamais écrites telles quelles ailleurs — voir writeAllHostGame
// States, seul point d'écriture). Repli sur un objet vide si absent/corrompu.
function readAllHostGameStates() {
    let map;
    try {
        const raw = localStorage.getItem(HOST_GAME_STATE_KEY);
        map = raw ? JSON.parse(raw) : {};
    } catch (e) {
        map = {};
    }
    if (!map || typeof map !== 'object') map = {};
    let changed = false;
    for (const code of Object.keys(map)) {
        const entry = map[code];
        if (!entry || !entry.roomCode || !entry.deals || !entry.savedAt
                || Date.now() - entry.savedAt > HOST_GAME_STATE_EXPIRY_MS) {
            delete map[code];
            changed = true;
        }
    }
    if (changed) writeAllHostGameStates(map);
    return map;
}

function writeAllHostGameStates(map) {
    try {
        localStorage.setItem(HOST_GAME_STATE_KEY, JSON.stringify(map));
    } catch (e) {
        // Quota localStorage dépassé, ou navigation privée stricte qui bloque l'écriture :
        // tant pis, la reprise ne sera simplement pas possible — rien d'autre n'est cassé.
    }
}

// Sauvegarde l'état complet — appelée à chaque changement significatif (voir applyCall,
// gotoBoard, broadcastLobbyState) tant qu'on est hôte et que la partie est lancée. Pas de
// débounce/throttle : ces événements sont d'ores et déjà peu fréquents à l'échelle
// humaine (une enchère toutes les quelques secondes au plus), et écrire dans localStorage
// est une opération synchrone rapide.
//
// Voir échange avec Guillaume (session asynchrone à deux) : pousse AUSSI vers le cloud
// (voir pushCloudGameState) à chaque appel — un seul point d'accroche à tenir à jour pour
// les deux formes de sauvegarde (même appareil via localStorage, n'importe quel appareil
// via le cloud), plutôt que de dupliquer l'appel à chacun des call sites existants.
function saveHostGameStateToStorage() {
    if (myRole !== 'host' || !deals || !currentRoomCode) return;
    const payload = {
        roomCode: currentRoomCode,
        deals, boardIndex, seatAssignment, participants, autoPassSeats,
        roomCreatorName, roomCreatorToken,
        // Voir échange avec Guillaume (session du 23 juillet — "sauve aussi le chat") :
        // sans ça, la conversation repartait de zéro à chaque reprise, même s'il y
        // avait des messages échangés juste avant la fermeture de l'onglet.
        chatMessages,
        savedAt: Date.now()
    };
    const map = readAllHostGameStates();
    map[currentRoomCode] = payload;
    // Voir échange avec Guillaume (session du 8 août — "multi room") : plafond appliqué
    // ICI, pas seulement à la lecture — sans ça, une salle active depuis longtemps (donc
    // re-sauvegardée sans cesse, jamais expirée) pourrait à elle seule empêcher toute
    // purge naturelle des autres.
    const codes = Object.keys(map);
    if (codes.length > MAX_SAVED_HOST_SESSIONS) {
        codes.sort((a, b) => (map[a].savedAt || 0) - (map[b].savedAt || 0));
        for (let i = 0; i < codes.length - MAX_SAVED_HOST_SESSIONS; i++) delete map[codes[i]];
    }
    writeAllHostGameStates(map);
    pushCloudGameState();
}

// Efface UNE salle précise de la carte des sessions reprenables (celle en cours par
// défaut) — jamais les autres, contrairement à l'ancien comportement mono-salle qui
// effaçait tout indistinctement.
function clearHostGameStateStorage(roomCode) {
    const code = roomCode || currentRoomCode;
    if (!code) return;
    const map = readAllHostGameStates();
    if (map[code]) {
        delete map[code];
        writeAllHostGameStates(map);
    }
}

// Lit UNE session sauvegardée par son code de salle, sans effet de bord au-delà de la
// purge déjà faite par readAllHostGameStates — utilisée à la fois pour l'afficher
// (checkForResumableHostSession) et pour la reprendre (uiResumeHostSession), afin de ne
// jamais dupliquer la logique de validité/expiration entre les deux.
function readResumableHostState(roomCode) {
    const map = readAllHostGameStates();
    return map[roomCode] || null;
}

// Renvoie toutes les sessions reprenables, triées de la plus récente à la plus ancienne.
function readAllResumableHostStates() {
    const map = readAllHostGameStates();
    return Object.values(map).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

// Affiche (ou masque) la bannière de reprise à l'accueil — une entrée par salle
// reprenable (voir échange avec Guillaume, session du 8 août — "multi room" : auparavant
// une seule salle possible, la plus récemment sauvegardée écrasait systématiquement les
// précédentes). Appelée une fois au chargement de la page (voir DOMContentLoaded plus
// bas), et à chaque fermeture/reprise pour rester à jour.
function checkForResumableHostSession() {
    const banner = document.getElementById('resumeSessionBanner');
    if (!banner) return [];
    const sessions = readAllResumableHostStates();
    if (sessions.length === 0) {
        banner.style.display = 'none';
        return [];
    }
    const list = document.getElementById('resumeSessionList');
    if (list) {
        list.innerHTML = sessions.map(saved => {
            const minutesAgo = Math.max(0, Math.round((Date.now() - saved.savedAt) / 60000));
            const timeLabel = minutesAgo === 0 ? "à l'instant" : `il y a ${minutesAgo} min`;
            const code = escapeHtml(saved.roomCode);
            return `<div class="resume-session-row">
                <div class="resume-session-text">🔄 Salle ${code} <span class="resume-session-details">(${saved.deals.length} donnes, ${timeLabel})</span></div>
                <div class="resume-session-actions">
                    <button type="button" class="btn btn-primary btn-small" onclick="uiResumeHostSession('${code}')">Reprendre</button>
                    <button type="button" class="btn btn-secondary btn-small" onclick="uiDismissResumeSession('${code}')">Non merci</button>
                </div>
            </div>`;
        }).join('');
    }
    banner.style.display = 'block';
    return sessions;
}

function uiDismissResumeSession(roomCode) {
    // Voir échange avec Guillaume (session du 24 juillet) : clôture définitivement la
    // partie — supprime la sauvegarde elle-même, pas seulement la bannière pour cette
    // visite. Un rechargement ultérieur ne la reproposera plus. Paramétré par salle
    // (session du 8 août — "multi room") : n'affecte que celle-ci, les autres salles
    // reprenables restent proposées normalement.
    clearHostGameStateStorage(roomCode);
    checkForResumableHostSession(); // ré-affiche la liste sans cette entrée (ou masque si c'était la dernière)
}

// Reprend une partie sauvegardée : restaure tout l'état en mémoire à l'identique, puis
// réclame le même code de salle (voir createRoom(cap, forcedRoomCode), déjà construit
// pour la reprise automatique par le sous-hôte — même mécanisme, ici déclenché
// volontairement par l'hôte lui-même plutôt qu'automatiquement par quelqu'un d'autre).
//
// Voir échange avec Guillaume ("les enchères de B n'apparaissent toujours pas") : cette
// sauvegarde LOCALE ne reflète que ce que CET appareil savait au moment de sa fermeture —
// elle ignore tout ce qu'un partenaire a pu enchérir depuis, sur un autre appareil, via le
// cloud (voir pushCloudGameState, qui écrit à chaque action, sur TOUS les appareils qui
// jouent).
//
// Voir échange avec Guillaume ("l'enchère de B n'apparaît toujours pas", répété plusieurs
// fois malgré des correctifs par ailleurs réels) : la VRAIE cause de fond était ici — une
// comparaison d'horodatage entre le cloud et cette sauvegarde locale. Le défaut : cette
// sauvegarde locale se remet à jour TOUTE SEULE à chaque reprise sur cet appareil, y
// compris via ce chemin local lui-même (voir saveHostGameStateToStorage en fin de
// fonction) — dès la première fois où ce chemin se déclenche, pour n'importe quelle
// raison, son horodatage devient "maintenant" et reste alors indéfiniment plus récent que
// n'importe quelle écriture antérieure de B, même authentiquement plus à jour en contenu.
// Un cercle qui se referme sur lui-même, sans jamais pouvoir se rouvrir tout seul.
//
// Plus de comparaison d'horodatage du tout : pour une salle où la persistance cloud
// existe, le cloud est TOUJOURS au moins aussi à jour que cette sauvegarde locale
// (chaque sauvegarde locale part de toute façon aussi vers le cloud en même temps, voir
// pushCloudGameState) — il l'emporte systématiquement dès qu'il est joignable. La
// sauvegarde locale ne sert plus que de filet si le cloud est injoignable (hors-ligne,
// panne passagère) ou n'a jamais rien reçu pour ce code.
async function uiResumeHostSession(roomCode) {
    const saved = readResumableHostState(roomCode);
    if (!saved) {
        checkForResumableHostSession(); // périmée entre-temps : remet la bannière à jour
        return;
    }

    if (typeof pullSessionState === 'function') {
        try {
            const cloudResult = await pullSessionState(saved.roomCode);
            if (cloudResult) {
                cloudResumeCandidate = cloudResult;
                uiResumeFromCloud();
                return;
            }
        } catch (e) {
            // Cloud injoignable (hors-ligne, panne passagère...) : tant pis, on continue
            // avec la sauvegarde locale ci-dessous plutôt que de bloquer la reprise.
        }
    }

    deals = saved.deals;
    boardIndex = saved.boardIndex || 0;
    if (!deals[boardIndex].auctionHistory) deals[boardIndex].auctionHistory = [];
    auctionHistory = deals[boardIndex].auctionHistory;
    seatAssignment = saved.seatAssignment || { N: null, E: null, S: null, W: null };
    participants = saved.participants || [{ id: 'host', name: savedNickname || 'Hôte' }];
    // Repli sur le participant 'host' actuel pour une sauvegarde antérieure à l'ajout de
    // ce champ (voir échange avec Guillaume) — sans quoi une session déjà en cours au
    // moment de la mise à jour du code perdrait ce nom au premier rechargement.
    roomCreatorName = saved.roomCreatorName || (participants.find(p => p.id === 'host') || {}).name || 'Hôte';
    // Repli sur getReconnectToken() : une reprise via uiResumeHostSession se fait
    // forcément depuis le MÊME appareil que la création (localStorage), donc le créateur
    // d'origine est nécessairement celui qui recharge ici.
    roomCreatorToken = saved.roomCreatorToken || getReconnectToken();
    // Voir échange avec Guillaume (session du 23 juillet — "il apparaît toujours en
    // blanc alors qu'il est déconnecté") : le statut restauré reflète la DERNIÈRE
    // sauvegarde (où tout le monde pouvait très bien être connecté) — mais personne
    // n'est réellement connecté au tout nouveau Peer qu'on vient de recréer, tant qu'ils
    // ne se sont pas reconnectés eux-mêmes (voir onGuestConnected, qui les remettra
    // correctement à disconnected:false à ce moment-là).
    const resumedAt = Date.now();
    participants.forEach(p => {
        if (p.id !== 'host') {
            p.disconnected = true;
            p.disconnectedAt = resumedAt;
        }
    });
    autoPassSeats = saved.autoPassSeats || [];
    advanceRobotBidsOnAllBoards(boardIndex); // voir échange avec Guillaume — idempotent, couvre une sauvegarde antérieure à ce correctif
    // Voir échange avec Guillaume (session du 23 juillet — "sauve aussi le chat") :
    // restaure la conversation telle qu'elle était juste avant la fermeture de l'onglet.
    chatMessages = saved.chatMessages || [];
    myRole = 'host';
    // Voir échange avec Guillaume ("je réouvre en A, kibbitz") : depuis la séparation
    // live/différé, une salle DIFFÉRÉE n'utilise plus jamais la chaîne littérale 'host'
    // dans seatAssignment (remplacée par mon vrai jeton dès le lancement, voir
    // uiStartGameAsHost) — seule une salle LIVE l'utilise encore. Sans cette
    // distinction, chercher seatAssignment[seat] === 'host' sur une salle différée ne
    // trouvait plus jamais mon siège, me faisant apparaître comme kibbitz.
    const myToken = getReconnectToken();
    const isLegacyHostRoom = SEATS.some(seat => seatAssignment[seat] === 'host') || participants.some(p => p.id === 'host');
    myParticipantId = isLegacyHostRoom ? 'host' : myToken;
    mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);
    currentRoomCode = saved.roomCode;
    guestIndexByToken = {};
    hostPendingUndo = null;
    hostTransferInProgress = false;
    // Voir échange avec Guillaume (session du 23 juillet — même genre de bug que les
    // participants marqués à tort "connectés") : ces deux "photos" de l'état précédent
    // servent à détecter des CHANGEMENTS (animation d'arrivée/départ de siège, toast "de
    // retour") — sans reset, elles restent celles d'avant la fermeture de l'onglet, et
    // pourraient déclencher une animation ou un toast à tort dès le premier
    // rafraîchissement après la reprise.
    prevSeatAssignmentSnapshot = null;
    prevParticipantsDisconnectedSnapshot = null;

    // Voir ARCHITECTURE-P2P-SERVEUR.md : recrée maintenant une vraie salle P2P (voir
    // juste en dessous) plutôt que d'éviter le réseau — la raison d'origine de cet évitement
    // (risque d'"unavailable-id" si un sous-hôte avait pris le même code entre-temps) a
    // disparu avec l'élection de sous-hôte elle-même.
    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 2, révisée après le test de Guillaume —
    // "quand l'hôte revient, l'invité reste marqué déconnecté, et la donne suivante ne le
    // fait pas bouger") : recrée maintenant une vraie salle P2P, comme au tout premier
    // lancement — au lieu de NullPeerConnection. L'ancien choix (voir git blame) était
    // motivé par le risque d'"unavailable-id" si un sous-hôte avait entre-temps pris ce
    // même code ; ce risque n'existe plus (plus d'élection de sous-hôte, voir étape 4).
    // Sans un vrai P2P ici, un invité qui tentait de se reconnecter (voir
    // attemptGuestAutoReconnect) ne trouvait plus jamais personne à qui parler — coincé
    // sur le seul relais serveur pour toujours, y compris pour ce qui n'y passe
    // volontairement jamais (changement de donne, voir "Ne touche jamais boardIndex ici"
    // dans applyCloudUpdate).
    if (peerConn) peerConn.destroy();
    const resumeOnOpenExtra = () => {
        renderReconnectButton();
        if (deals) renderBoard(); else renderLobby();
    };
    peerConn = new BridgePeerConnection(buildHostHandlers(resumeOnOpenExtra));
    peerConn.handlers.onError = (err) => {
        // Filet de sécurité seulement — très improbable désormais (plus personne d'autre
        // ne peut légitimement détenir ce code), mais un délai de libération côté serveur
        // de signalisation reste théoriquement possible juste après la fermeture de
        // l'ancien Peer. Une seule retentative après un court délai plutôt que d'abandonner
        // platement ; au-delà, juste journalisé (le bouton "Se reconnecter" reste
        // disponible pour réessayer manuellement).
        if (err && err.type === 'unavailable-id') {
            pushDebugLog('Impossible de recréer la salle hôte (code pas encore libéré côté serveur) — nouvel essai dans un instant.');
            setTimeout(() => {
                if (myRole !== 'host' || (peerConn && peerConn.signalingOpen)) return;
                if (peerConn) peerConn.destroy();
                peerConn = new BridgePeerConnection(buildHostHandlers(resumeOnOpenExtra));
                peerConn.createRoom(6, saved.roomCode);
            }, 1500);
            return;
        }
        pushDebugLog("Échec de la recréation de la salle hôte : " + ((err && (err.message || err.type)) || err));
    };
    peerConn.createRoom(6, saved.roomCode);
    startDeferredPolling();

    hideConnectingOverlay();
    enterGameScreen();
    // Voir échange avec Guillaume (session du 23 juillet — "le DD n'est plus calculé") :
    // le calcul du double mort tourne en arrière-plan via un appel réseau (voir
    // kickOffBackgroundDD) — s'il n'était pas encore terminé au moment de la fermeture de
    // l'onglet, cet appel a été abandonné avec lui, et rien ne le relance tout seul. On
    // relance ici pour toute donne encore sans résultat.
    const missingDD = deals.filter(d => !d.par && !d.ddTable);
    if (missingDD.length > 0) kickOffBackgroundDD(missingDD);
    // Voir échange avec Guillaume (session du 23 juillet — "le chat qui était ouvert...
    // est fermé") : rouvert par défaut à la reprise, comme pour un joueur qui rejoint en
    // cours de partie (voir le handler 'resync').
    if (!chatPanelOpen) uiToggleChat(false);
    saveHostGameStateToStorage(); // remet savedAt à jour tout de suite
}

// ===== Reprise "à froid" depuis le cloud (session asynchrone à deux, voir échange avec
// Guillaume) =====
//
// Distinct du relais serveur par siège en cours de partie (voir
// ARCHITECTURE-P2P-SERVEUR.md) : celui-ci suppose une connexion P2P déjà établie qui
// vient de se couper, avec quelqu'un d'autre encore en ligne pour relayer. Ici, personne
// n'était forcément connecté depuis des heures — on repart de l'état sauvegardé dans le
// cloud (voir session-storage.js), jamais de la mémoire locale, et N'IMPORTE QUEL
// participant muni du lien peut reprendre (voir échange avec Guillaume : "n'importe qui
// peut claim") — soit en retrouvant son propre siège (son jeton de reconnexion y figure
// déjà), soit en
// revendiquant le premier siège encore SEAT_PENDING.

let lastKnownCloudVersion = 0; // dernier numéro de version cloud connu, pour le verrou optimiste (voir session-storage.js)
let cloudResumeCandidate = null; // { version, updatedAt, state }, en attente de confirmation (voir offerCloudResume/uiResumeFromCloud)

// Voir échange avec Guillaume (test du 27 juillet — "409 (Conflict)" en rafale) : plusieurs
// enchères rapprochées déclenchaient plusieurs pushCloudGameState() EN PARALLÈLE, chacun
// parti avec le même lastKnownCloudVersion lu avant que le précédent n'ait eu le temps de
// se terminer et de le mettre à jour — d'où des conflits de version en cascade, y compris
// après le tout premier envoi réussi. Un seul envoi à la fois : les appels reçus pendant
// qu'un envoi est déjà en cours ne repartent pas immédiatement (ça ne ferait que déplacer
// le même problème), ils marquent juste "il faudra renvoyer une fois celui-ci terminé" —
// et un seul renvoi suffit, avec l'état ACTUEL relu à ce moment-là (pas la peine d'empiler
// un envoi par clic intermédiaire, seul le dernier état compte).
let cloudPushInFlight = false;
let cloudPushQueued = false;

// Pousse l'état courant vers le cloud — voir l'unique point d'accroche dans
// saveHostGameStateToStorage(), qui appelle ceci à chaque sauvegarde locale. En tâche de
// fond (fire-and-forget) : un échec réseau ici ne doit jamais empêcher de continuer à
// jouer localement (voir pushSessionState, qui gère déjà ses propres tentatives).
function buildCloudStatePayload() {
    return {
        roomCode: currentRoomCode,
        deals, boardIndex, seatAssignment, participants, autoPassSeats, chatMessages,
        roomCreatorName,
        // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : roomCreatorToken n'est jamais
        // renseigné localement côté invité (variable réservée à l'hôte) — l'utiliser
        // tel quel écraserait la bonne valeur en cloud avec null si un invité pousse
        // (voir le nouveau site d'appel dans uiMakeCall). currentHostReconnectToken,
        // lui, EST tenu à jour côté invité aussi (voir 'start-game'/'resync'), donc
        // fiable dans les deux cas — repli dessus si roomCreatorToken est vide ici.
        roomCreatorToken: roomCreatorToken || currentHostReconnectToken,
        // Même raisonnement : getReconnectToken() renvoie MON PROPRE jeton, pas
        // forcément celui de l'hôte — correct seulement si je suis moi-même l'hôte.
        hostReconnectToken: myRole === 'host' ? getReconnectToken() : (currentHostReconnectToken || getReconnectToken()),
        savedAt: Date.now()
    };
}

// Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : n'était utilisable QUE par l'hôte
// jusqu'ici — élargi à n'importe quel rôle, puisque cette fonction ne fait que pousser
// l'état LOCAL de qui l'appelle, quel qu'il soit (voir buildCloudStatePayload, qui ne
// lit que des variables déjà tenues à jour côté client, pas une info réservée à l'hôte).
// Nouveau site d'appel : un invité déconnecté de l'hôte en P2P, qui pousse directement
// sa propre annonce (voir uiMakeCall) — même filet de sécurité par verrou optimiste
// (expectedVersion/409) que pour tout le monde, aucun traitement de faveur ici.
function pushCloudGameState() {
    if (!deals || !currentRoomCode) return;
    if (typeof pushSessionState !== 'function') return; // session-storage.js pas chargé (ex. pas encore branché dans index.html) : no-op silencieux

    if (cloudPushInFlight) {
        cloudPushQueued = true;
        return;
    }
    cloudPushInFlight = true;

    pushSessionState(currentRoomCode, buildCloudStatePayload(), lastKnownCloudVersion, {
        onConflict: (current) => {
            // Voir échange avec Guillaume ("aucune diff" entre avant/après B — écriture
            // perdue) : adopter le nouveau numéro de version ne sert à rien tout seul —
            // sans renvoyer nos propres changements AVEC ce numéro corrigé, ils étaient
            // purement perdus. cloudPushQueued force ce renvoi via le .finally() juste
            // en dessous, dès que ce cycle-ci se termine.
            if (current) lastKnownCloudVersion = current.version;
            cloudPushQueued = true;
        }
    }).then(result => {
        if (result) lastKnownCloudVersion = result.version;
    }).finally(() => {
        cloudPushInFlight = false;
        if (cloudPushQueued) {
            cloudPushQueued = false;
            pushCloudGameState(); // renvoie avec l'état le plus frais et/ou le numéro corrigé
        }
    });
}

// Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : chemin de repli pour un invité dont la
// connexion P2P à l'hôte est coupée au moment de vouloir annoncer (voir uiMakeCall). Ne
// réutilise PAS buildCloudStatePayload/pushCloudGameState directement sur l'état local :
// celui-ci peut être en avance (mon propre affichage optimiste) ou en retard (si je n'ai
// pas suivi les derniers changements pendant ma coupure) par rapport à ce que le serveur
// connaît vraiment — on relit donc le serveur d'abord, on rejoue CETTE annonce sur SA
// version de l'historique, et on revalide avant de pousser. Si elle n'est plus légale
// (quelqu'un/quelque chose a changé la situation ailleurs entre-temps), on abandonne et on
// resynchronise sur le vrai état serveur plutôt que de laisser mon affichage optimiste
// erroné en place (voir applyCloudUpdate, réutilisé tel quel pour ce cas).
async function pushCallViaServerFallback(seat, call, explanation) {
    if (!currentRoomCode || typeof pullSessionState !== 'function' || typeof pushSessionState !== 'function') return;

    let pulled;
    try {
        pulled = await pullSessionState(currentRoomCode);
    } catch (e) {
        pushDebugLog('Remontée serveur de l\'annonce impossible (lecture) : ' + ((e && e.message) || e));
        return;
    }

    const baseState = pulled ? pulled.state : buildCloudStatePayload();
    const expectedVersion = pulled ? pulled.version : 0;
    const idx = baseState.boardIndex;
    const boardDeals = baseState.deals;
    if (!boardDeals[idx]) return; // filet de sécurité, ne devrait pas arriver
    if (!boardDeals[idx].auctionHistory) boardDeals[idx].auctionHistory = [];
    const hist = boardDeals[idx].auctionHistory;

    const expectedSeat = currentTurnSeat(boardDeals[idx].dealer, hist);
    if (seat !== expectedSeat || !isCallLegal(hist, call, seat)) {
        pushDebugLog(`Annonce ${call} (${seat}) abandonnée : plus valide par rapport à l'état serveur relu — resynchronisation.`);
        if (pulled) applyCloudUpdate(pulled);
        return;
    }

    hist.push(explanation ? { seat, call, explanation } : { seat, call });

    try {
        const result = await pushSessionState(currentRoomCode, { ...baseState, savedAt: Date.now() }, expectedVersion, {
            onConflict: (current) => {
                // Quelqu'un d'autre a écrit entre ma lecture et ma tentative d'écrite —
                // pas la peine de retenter en boucle ici (contrairement à
                // pushCloudGameState) : la prochaine chose que je ferai (mon propre
                // sondage/abonnement, voir startDeferredPolling) relira et
                // resynchronisera de toute façon.
                if (current) lastKnownCloudVersion = current.version;
                pushDebugLog(`Annonce ${call} (${seat}) : conflit de version au moment de pousser, abandon (une resynchronisation suivra).`);
            }
        });
        if (result) {
            lastKnownCloudVersion = result.version;
            // Voir échange avec Guillaume ("je ne sais pas si ça a vraiment pris ce
            // chemin") : seuls les cas d'échec/conflit journalisaient quelque chose
            // jusqu'ici — le cas de succès, le plus courant, ne laissait aucune trace
            // dans le journal, rendant un test après coup ambigu.
            pushDebugLog(`Annonce ${call} (${seat}) remontée au serveur avec succès (version ${result.version}).`);
        }
    } catch (e) {
        pushDebugLog('Remontée serveur de l\'annonce impossible (écriture) : ' + ((e && e.message) || e));
    }
}

// ===== Synchronisation cloud (voir ARCHITECTURE-P2P-SERVEUR.md, étape 3) =====
//
// Anciennement "sondage périodique du cloud (mode différé uniquement)" — élargi : ne
// sert plus seulement au mode différé pur, mais aussi de filet de secours en mode live
// dès qu'AU MOINS UN siège occupé n'est plus joignable en P2P (voir pollCloudForUpdates,
// dont le garde-fou a changé en conséquence). Tant que tout le monde reste en P2P, ce
// mécanisme ne fait strictement rien (aucun coût réseau ajouté) — voir le principe "le
// serveur est un chemin normal pour un siège donné, jamais un repli permanent" dans le
// document de conception.
//
// Voir échange avec Guillaume ("B est dans la partie, mais n'apparaît pas chez A tant
// qu'on ne rafraîchit pas") : conséquence directe et attendue de l'absence de P2P en mode
// différé — rien ne prévient A en direct quand B agit, puisqu'il n'y a plus de canal live
// du tout. Si A garde son onglet ouvert PENDANT que B agit ailleurs (les deux en même
// temps, comme en plein test), il fallait recharger la page pour s'en apercevoir. Ce
// sondage périodique relit le cloud toutes les quelques secondes et applique s'il y a du
// nouveau, sans jamais avoir besoin d'un F5.
// Voir échange avec Guillaume ("j'aimerais que ce soit quasi instantané") : le vrai temps
// réel vient maintenant de Pusher (voir subscribeToSessionUpdates dans
// realtime-updates.js), déclenché par le serveur à chaque écriture réussie. Ce sondage
// redevient un simple FILET DE SECOURS (au cas où un événement Pusher se perdrait —
// coupure passagère, etc.), d'où un intervalle bien plus large que quand il portait toute
// la réactivité à lui seul.
const DEFERRED_POLL_INTERVAL_MS = 20000;
let deferredPollIntervalId = null;

// Démarre le sondage — sans effet s'il tourne déjà (évite d'empiler plusieurs minuteurs
// si appelé plusieurs fois, ex. depuis uiStartGameAsHost ET uiResumeFromCloud dans la
// même session). Voir stopDeferredPolling pour l'arrêt (mode live, ou changement de rôle).
function startDeferredPolling() {
    if (typeof subscribeToSessionUpdates === 'function' && currentRoomCode) {
        subscribeToSessionUpdates(currentRoomCode, onCloudPusherEvent);
    }
    if (deferredPollIntervalId) return;
    deferredPollIntervalId = setInterval(pollCloudForUpdates, DEFERRED_POLL_INTERVAL_MS);
    // Sondage immédiat dès que l'onglet redevient actif — pas la peine d'attendre le
    // prochain sondage si on vient de revenir dessus après être allé voir ailleurs (autre
    // onglet, autre appli). Toujours utile même avec Pusher : un onglet en arrière-plan
    // peut voir sa connexion WebSocket suspendue par le navigateur.
    document.addEventListener('visibilitychange', onVisibilityChangeForDeferredPolling);
}

// Voir ARCHITECTURE-P2P-SERVEUR.md (étape 5) : appelé avec le contenu de l'événement
// Pusher lui-même, plutôt que de systématiquement relire via GET (voir l'ancien
// comportement, où subscribeToSessionUpdates appelait directement pollCloudForUpdates
// sans rien lui passer). Deux formes possibles, décidées côté serveur selon la taille
// (voir api/session.js, PUSHER_EVENT_MAX_BYTES) :
//   - {version, updatedAt, state} : état déjà là, appliqué directement (aucun aller-
//     retour supplémentaire — c'est le vrai gain de latence).
//   - {version, updatedAt} seul : repli, on relit via GET comme avant (pollCloudForUpdates).
// Même garde-fou que pollCloudForUpdates : ne fait rien tant qu'on est pleinement en P2P.
function onCloudPusherEvent(data) {
    if (myRole !== 'host' || !currentRoomCode) return;
    if (!(peerConn instanceof NullPeerConnection) && !hasDisconnectedOccupiedSeat()) return;
    if (!data || typeof data.version !== 'number' || data.version <= lastKnownCloudVersion) return;
    if (cloudPushInFlight || cloudPushQueued) return; // pas la peine de relire ce qu'on vient tout juste d'envoyer

    if (data.state) {
        applyCloudUpdate(data);
    } else {
        pollCloudForUpdates(); // état pas embarqué (payload trop gros) : repli sur l'ancien chemin
    }
}

function onVisibilityChangeForDeferredPolling() {
    if (document.visibilityState === 'visible') pollCloudForUpdates();
}

// Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : condition de déclenchement du relais
// serveur en mode live — vrai dès qu'un siège RÉELLEMENT OCCUPÉ (pas un robot, pas
// SEAT_PENDING) appartient à un participant actuellement marqué déconnecté. `p.disconnected`
// est déjà tenu à jour côté hôte à chaque connexion/déconnexion P2P (voir
// onGuestConnected et onPeerDisconnected/onSignalingDisconnected côté... hôte, pour les
// invités qui SE déconnectent de lui) — rien de neuf à faire tourner ici, juste une
// lecture de ce qui existe déjà.
function hasDisconnectedOccupiedSeat() {
    return SEATS.some(seat => {
        const occupant = seatAssignment[seat];
        if (!occupant || occupant === SEAT_PENDING) return false;
        const p = participants.find(x => x.id === occupant);
        return !!(p && p.disconnected);
    });
}

function stopDeferredPolling() {
    if (typeof unsubscribeFromSessionUpdates === 'function') unsubscribeFromSessionUpdates();
    if (deferredPollIntervalId) {
        clearInterval(deferredPollIntervalId);
        deferredPollIntervalId = null;
    }
    document.removeEventListener('visibilitychange', onVisibilityChangeForDeferredPolling);
}

async function pollCloudForUpdates() {
    if (myRole !== 'host' || !currentRoomCode) return;
    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : sonde toujours en mode différé pur
    // (NullPeerConnection, inchangé), et DÉSORMAIS AUSSI en mode live dès qu'au moins un
    // siège occupé n'est plus joignable en P2P (voir hasDisconnectedOccupiedSeat) — c'est
    // par ce chemin qu'une annonce poussée en repli serveur par un invité déconnecté
    // (voir pushCallViaServerFallback) est récupérée puis relayée en P2P à qui reste
    // connecté (voir applyCloudUpdate). Tant que tout le monde est en P2P, cette
    // condition est fausse et rien ne se passe ici — aucun coût réseau ajouté au cas
    // normal.
    if (!(peerConn instanceof NullPeerConnection) && !hasDisconnectedOccupiedSeat()) return;
    // Ne sonde pas pendant qu'on est nous-mêmes en train d'écrire (voir pushCloudGameState)
    // — pas la peine de relire ce qu'on vient tout juste d'envoyer.
    if (cloudPushInFlight || cloudPushQueued) return;
    if (typeof pullSessionState !== 'function') return;

    try {
        const result = await pullSessionState(currentRoomCode);
        if (!result || result.version <= lastKnownCloudVersion) return; // rien de neuf
        applyCloudUpdate(result);
    } catch (e) {
        // Panne réseau passagère : tant pis, on retentera au prochain sondage.
    }
}

// Applique un état plus récent trouvé par le sondage, SANS repartir de zéro comme le fait
// uiResumeFromCloud (on est déjà en jeu, pas besoin de revendiquer un siège ni de
// recalculer l'identité — seulement d'absorber ce qui a changé ailleurs).
function applyCloudUpdate(result) {
    const st = result.state;
    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : capturé AVANT tout remplacement, pour
    // pouvoir relayer en P2P (plus bas) uniquement ce qui est réellement NOUVEAU apporté
    // par cette mise à jour cloud — jamais question de rejouer tout depuis le début à
    // chaque fois, seulement ce qui manquait.
    const oldBoardIndexForRelay = boardIndex;
    const oldAuctionForRelay = (deals && deals[oldBoardIndexForRelay] && deals[oldBoardIndexForRelay].auctionHistory)
        ? deals[oldBoardIndexForRelay].auctionHistory
        : [];
    const oldAuctionLengthForRelay = oldAuctionForRelay.length;
    // Voir échange avec Guillaume ("chat/sièges via le relais serveur") : même principe,
    // étendu au-delà des seules annonces.
    const oldChatLengthForRelay = chatMessages ? chatMessages.length : 0;
    const oldSeatAssignmentJsonForRelay = JSON.stringify(seatAssignment);

    deals = st.deals;
    seatAssignment = st.seatAssignment || seatAssignment;
    participants = st.participants || participants;
    autoPassSeats = SEATS.filter(seat => !seatAssignment[seat]);
    chatMessages = st.chatMessages || [];
    // Voir échange avec Guillaume : la sauvegarde qu'on vient de lire reflète le point de
    // vue de la dernière personne à avoir écrit — elle nous marque, NOUS, comme
    // déconnectés de son point de vue. On corrige immédiatement pour ne pas s'afficher
    // soi-même comme "déconnecté".
    const myEntry = participants.find(p => p.id === myParticipantId);
    if (myEntry) myEntry.disconnected = false;
    mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);
    lastKnownCloudVersion = result.version;

    // Ne touche jamais boardIndex ici : on ne fait pas sauter A d'une donne à l'autre
    // sous ses pieds pendant qu'il regarde — seul un geste explicite de sa part (flèches,
    // vue d'ensemble, avance rapide) doit déplacer la donne affichée.
    if (!deals[boardIndex]) boardIndex = 0;
    if (!deals[boardIndex].auctionHistory) deals[boardIndex].auctionHistory = [];
    auctionHistory = deals[boardIndex].auctionHistory;

    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 3) : relais P2P de ce qui vient d'être
    // appris via le cloud — sans ça, un invité resté connecté en P2P ne verrait JAMAIS
    // l'annonce/le message/le changement de siège d'un participant passé par le relais
    // serveur avant que ce dernier ne se reconnecte lui-même (ce qui peut arriver bien
    // après, voire jamais si la partie se termine avant). Seulement si on est encore
    // hôte, avec une vraie connexion P2P (pas NullPeerConnection — rien à relayer en pur
    // mode différé).
    const canRelay = myRole === 'host' && peerConn && !(peerConn instanceof NullPeerConnection);

    // Annonces : seulement si on est resté sur la MÊME donne (jamais question de relayer
    // un changement de donne par ce canal, seulement des annonces).
    if (canRelay && boardIndex === oldBoardIndexForRelay && auctionHistory.length > oldAuctionLengthForRelay) {
        for (let i = oldAuctionLengthForRelay; i < auctionHistory.length; i++) {
            const entry = auctionHistory[i];
            peerConn.send({ type: 'call', boardIndex, seat: entry.seat, call: entry.call, explanation: entry.explanation });
        }
        pushDebugLog(`${auctionHistory.length - oldAuctionLengthForRelay} annonce(s) apprise(s) via le cloud, relayée(s) en P2P.`);
    }

    // Messages de chat (voir échange avec Guillaume) : même logique, chaque nouveau
    // message relayé individuellement — addChatMessage (côté récepteur) l'ajoute et
    // rafraîchit l'affichage, exactement comme un message reçu en direct.
    if (canRelay && chatMessages.length > oldChatLengthForRelay) {
        for (let i = oldChatLengthForRelay; i < chatMessages.length; i++) {
            peerConn.send(chatMessages[i]);
        }
        pushDebugLog(`${chatMessages.length - oldChatLengthForRelay} message(s) de chat appris via le cloud, relayé(s) en P2P.`);
    }

    // Changement de sièges (voir échange avec Guillaume) : diffuse l'état complet des
    // sièges plutôt qu'un delta (contrairement aux deux ci-dessus) — broadcastLobbyState
    // envoie déjà tout ce qu'il faut (participants, seatAssignment, autoPassSeats), pas
    // la peine de reconstruire un message dédié pour ça.
    if (canRelay && JSON.stringify(seatAssignment) !== oldSeatAssignmentJsonForRelay) {
        broadcastLobbyState();
        pushDebugLog('Changement de sièges appris via le cloud, relayé en P2P.');
    }

    renderBoard();
    if (chatPanelOpen) {
        renderRoomBoard();
        renderChat();
    }
}

// Voir échange avec Guillaume ("les enchères de B n'apparaissent toujours pas") : le
// `keepalive` ajouté précédemment protège une requête déjà EN COURS, mais pas une requête
// qui n'a encore jamais été émise — or c'est exactement ce qui peut arriver avec la file
// d'attente ci-dessus (cloudPushQueued) : si l'onglet se ferme pendant qu'un envoi attend
// simplement son tour, ce tour peut ne jamais venir, la page étant coupée avant même que
// ce code n'ait la moindre chance de s'exécuter. Ce filet de sécurité est indépendant de
// cette file : déclenché explicitement à la fermeture/mise en arrière-plan de l'onglet
// (voir 'pagehide' plus bas), il relit l'état à cet instant précis et l'envoie une
// dernière fois, sans jamais attendre son tour derrière un envoi en cours.
window.addEventListener('pagehide', () => {
    if (myRole !== 'host' || !deals || !currentRoomCode) return;
    if (typeof pushSessionState !== 'function') return;
    pushSessionState(currentRoomCode, buildCloudStatePayload(), lastKnownCloudVersion);
});

// Interroge le cloud pour ce code de salon et, si un état y est trouvé, reprend
// directement la partie (voir échange avec Guillaume : "reprendre automatiquement, sans
// demander" — plus de bannière de confirmation intermédiaire). Renvoie true si une reprise
// a effectivement été lancée (pour que l'appelant sache s'il doit encore afficher son
// propre message d'erreur "Aucune partie trouvée" ou non).
async function offerCloudResume(code) {
    if (typeof pullSessionState !== 'function') return false;
    let result;
    try {
        result = await pullSessionState(code);
    } catch (e) {
        pushDebugLog('Reprise cloud : le serveur de session n\'a pas répondu (' + ((e && e.message) || e) + ').');
        return false;
    }
    if (!result) return false; // rien en cloud pour ce code : comportement inchangé, laisse l'appelant afficher son erreur habituelle

    cloudResumeCandidate = result;
    showConnectingOverlay('Reprise de la partie…');
    uiResumeFromCloud();
    return true;
}

// Reprend effectivement la partie depuis l'état cloud trouvé par offerCloudResume — voir
// le long commentaire en tête de section pour la logique de revendication de siège.
function uiResumeFromCloud() {
    if (!cloudResumeCandidate) return;
    const st = cloudResumeCandidate.state;
    const codeToReclaim = st.roomCode || currentRoomCode;
    const myToken = getReconnectToken();

    // Cas 0 : je suis le créateur d'origine de la salle qui revient — ses sièges peuvent
    // encore être étiquetés littéralement 'host', reliquat de sa session live d'origine
    // (voir uiCreateRoom). Migration une fois pour toutes vers mon vrai jeton : après ça,
    // plus jamais besoin de cette étiquette spéciale pour retrouver ma place. Repli sur
    // hostReconnectToken pour une salle créée avant l'ajout de roomCreatorToken.
    const creatorToken = st.roomCreatorToken || st.hostReconnectToken || null;
    if (creatorToken && myToken === creatorToken) {
        SEATS.filter(seat => st.seatAssignment[seat] === 'host')
            .forEach(seat => { st.seatAssignment[seat] = myToken; });
        const legacyHostParticipant = st.participants.find(p => p.id === 'host');
        if (legacyHostParticipant) legacyHostParticipant.id = myToken;
    }

    // Cas 1 : je retrouve mon propre siège (déjà joué ici auparavant, ou migré ci-dessus).
    let claimedSeat = SEATS.find(seat => st.seatAssignment[seat] === myToken);

    // Cas 2 : première fois — je revendique le premier siège encore en attente d'un
    // partenaire (voir SEAT_PENDING). "N'importe qui peut claim" (voir échange avec
    // Guillaume) : aucune vérification d'identité au-delà de "ce siège est encore libre".
    if (!claimedSeat) {
        claimedSeat = SEATS.find(seat => st.seatAssignment[seat] === SEAT_PENDING);
        if (claimedSeat) {
            st.seatAssignment[claimedSeat] = myToken;
            if (!st.participants.some(p => p.id === myToken)) {
                st.participants.push({ id: myToken, name: savedNickname || 'Joueur', ...(savedAvatarColor ? { avatarColor: savedAvatarColor } : {}) });
            }
        }
    }

    // Voir échange avec Guillaume (session du 8 août — "j'essaye de m'incruster plus
    // tard [...] il me dit un truc du genre 'tous les sièges sont occupés' mais on doit
    // toujours pouvoir join en tant que kibbitz") : bug trouvé — sans siège à revendiquer
    // (ni le mien déjà assigné, ni un SEAT_PENDING libre), cette fonction REJETAIT
    // entièrement la connexion, alors qu'un kibbitz (personne sans siège) doit TOUJOURS
    // pouvoir rejoindre, quel que soit l'état des 4 sièges (tous en bots, ou tous déjà
    // occupés par d'autres humains). Corrigé : sans siège à revendiquer, on rejoint quand
    // même, simplement sans siège (comme n'importe quel kibbitz) — seul un participant
    // pas encore connu de cette salle a besoin d'être ajouté à `participants`.
    if (!claimedSeat && !st.participants.some(p => p.id === myToken)) {
        st.participants.push({ id: myToken, name: savedNickname || 'Joueur', ...(savedAvatarColor ? { avatarColor: savedAvatarColor } : {}) });
    }

    // Voir plus bas (après restauration complète de l'état) : la connexion — réelle ou
    // NullPeerConnection — dépend de si je suis le vrai créateur ou non, donc posée après
    // avoir déterminé myToken === creatorToken avec certitude et restauré tout l'état
    // nécessaire (buildHostHandlers y fait référence).

    // Restaure tout l'état en mémoire — même forme de payload que uiResumeHostSession(),
    // juste une source différente (le cloud plutôt que le localStorage de CET appareil).
    deals = st.deals;
    // Voir échange avec Guillaume : toujours la donne 1, jamais st.boardIndex — celui-ci
    // reflète juste la DERNIÈRE donne où le joueur précédent s'est arrêté (souvent en
    // pleine avancée, voir les flèches ◀▶ utilisables même en pleine enchère), pas un point
    // de départ pertinent pour quelqu'un qui arrive et doit parcourir toutes les donnes
    // depuis le début pour y jouer ses propres tours.
    boardIndex = 0;
    if (!deals[boardIndex].auctionHistory) deals[boardIndex].auctionHistory = [];
    auctionHistory = deals[boardIndex].auctionHistory;
    seatAssignment = st.seatAssignment;
    participants = st.participants || [];
    // Recalculé plutôt que de faire confiance à st.autoPassSeats (qui peut dater d'avant
    // ma propre revendication de siège, cas 2 ci-dessus).
    autoPassSeats = SEATS.filter(seat => !seatAssignment[seat]);
    advanceRobotBidsOnAllBoards(boardIndex); // voir échange avec Guillaume — prérequis d'"avance rapide"/"vue d'ensemble"
    chatMessages = st.chatMessages || [];
    roomCreatorName = st.roomCreatorName || (participants.find(p => p.id === 'host') || {}).name || 'Hôte';
    roomCreatorToken = creatorToken || myToken;

    const disconnectedAt = Date.now();
    participants.forEach(p => {
        if (p.id !== myToken) { p.disconnected = true; p.disconnectedAt = disconnectedAt; }
    });

    // Voir échange avec Guillaume ("je ne veux pas de bascule d'hôte") : myParticipantId
    // reste MON PROPRE jeton — jamais renommé en la chaîne littérale 'host'. myRole='host'
    // ici sert uniquement à m'accorder le contrôle local complet (navigation de donne,
    // arbitrage d'undo — voir canControlBoard et consorts), pas une identité à endosser.
    myRole = 'host';
    myParticipantId = myToken;
    mySeats = SEATS.filter(seat => seatAssignment[seat] === myParticipantId);
    currentRoomCode = codeToReclaim;

    // Voir ARCHITECTURE-P2P-SERVEUR.md (étape 2, révisée après le test de Guillaume —
    // "quand l'hôte revient, l'invité reste marqué déconnecté, et la donne suivante ne le
    // fait pas bouger") : SEUL le vrai créateur original recrée une vraie salle P2P ici —
    // n'importe quel AUTRE participant qui reprend une session différée garde
    // NullPeerConnection, exactement comme avant (voir "n'importe qui peut claim" plus
    // haut : plusieurs personnes pourraient reprendre au même moment depuis des appareils
    // différents, une seule d'entre elles peut réellement détenir l'identifiant PeerJS de
    // la salle). Pour le créateur, en revanche, aucune ambiguïté possible — c'est
    // structurellement la seule et unique personne légitime à ce rôle, donc recréer un
    // vrai P2P ici est sans risque, et indispensable : sans ça, un invité qui tentait de
    // se reconnecter (voir attemptGuestAutoReconnect) ne trouvait plus jamais personne à
    // qui parler après le retour du créateur — coincé sur le seul relais serveur pour
    // toujours, y compris pour ce qui n'y passe volontairement jamais (changement de
    // donne, voir "Ne touche jamais boardIndex ici" dans applyCloudUpdate).
    if (peerConn) peerConn.destroy();
    if (creatorToken && myToken === creatorToken) {
        const resumeOnOpenExtra = () => {
            renderReconnectButton();
            if (deals) renderBoard(); else renderLobby();
        };
        peerConn = new BridgePeerConnection(buildHostHandlers(resumeOnOpenExtra));
        peerConn.handlers.onError = (err) => {
            // Filet de sécurité seulement — très improbable (plus d'élection de
            // sous-hôte, donc plus personne d'autre ne peut légitimement détenir ce
            // code), mais un délai de libération côté serveur de signalisation reste
            // théoriquement possible juste après la fermeture de l'ancien Peer.
            if (err && err.type === 'unavailable-id') {
                pushDebugLog('Impossible de recréer la salle hôte (code pas encore libéré côté serveur) — nouvel essai dans un instant.');
                setTimeout(() => {
                    if (myRole !== 'host' || (peerConn && peerConn.signalingOpen)) return;
                    if (peerConn) peerConn.destroy();
                    peerConn = new BridgePeerConnection(buildHostHandlers(resumeOnOpenExtra));
                    peerConn.createRoom(6, codeToReclaim);
                }, 1500);
                return;
            }
            pushDebugLog("Échec de la recréation de la salle hôte : " + ((err && (err.message || err.type)) || err));
        };
        peerConn.createRoom(6, codeToReclaim);
    } else {
        // Voir échange avec Guillaume ("on n'est plus obligé de passer par le P2P") :
        // inchangé pour tout participant qui n'est pas le créateur — aucune connexion
        // PeerJS n'est ouverte. Tous les appels peerConn.send(...)/etc. disséminés dans
        // le reste du fichier (mode live, inchangé) continuent de s'exécuter tels quels ;
        // ils ne font simplement plus rien, faute d'invité à qui parler.
        peerConn = new NullPeerConnection();
    }
    startDeferredPolling();
    guestIndexByToken = {};
    hostPendingUndo = null;
    hostTransferInProgress = false;
    prevSeatAssignmentSnapshot = null;
    prevParticipantsDisconnectedSnapshot = null;
    lastKnownCloudVersion = cloudResumeCandidate.version;
    cloudResumeCandidate = null;

    hideConnectingOverlay();
    enterGameScreen();
    // Voir échange avec Guillaume ("si on ouvre une room et que toutes les enchères sont
    // finies, il faut afficher la vue d'ensemble par défaut") : arriver sur la donne 1
    // n'a aucun intérêt si elle (et toutes les autres) sont déjà terminées — rien à y
    // jouer. La vue d'ensemble montre directement où chaque donne en est, plus utile
    // qu'un premier tableau qui ne servira à rien.
    if (deals.every(d => isAuctionOver(d.auctionHistory || []))) uiOpenBoardOverview();
    const missingDD = deals.filter(d => !d.par && !d.ddTable);
    if (missingDD.length > 0) kickOffBackgroundDD(missingDD);
    if (!chatPanelOpen) uiToggleChat(false);
    saveHostGameStateToStorage();
}

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
    // Voir échange avec Guillaume (session du 23 juillet — "le bouton reste affiché à
    // tort") : réévalué en continu, comme la bannière — plutôt que de compter sur CHAQUE
    // scénario de rétablissement pour explicitement appeler renderReconnectButton() au
    // bon moment (fragile : un cas oublié, ou une reconnexion ICE qui se rétablit sans
    // passer par nos propres gestionnaires, voir attachPCDiagnostics dans
    // peer-connection.js, laissait le bouton figé sur son dernier état affiché).
    setInterval(renderReconnectionBanner, 1000);
    setInterval(renderReconnectButton, 1000);

    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    // Voir échange avec Guillaume (session du 23 juillet — reprise via localStorage) :
    // vérifiée AVANT le traitement du paramètre ?room= ci-dessous — si ce paramètre
    // correspond justement à la salle qu'on peut reprendre, la bannière de reprise prend
    // le pas : tenter de la rejoindre comme invité échouerait ou n'importe pas puisqu'on
    // est en réalité toujours son hôte légitime. Si le code diffère (lien d'un tiers), le
    // traitement normal du paramètre reste inchangé — la bannière de reprise s'affiche
    // simplement EN PLUS, comme une option indépendante.
    const resumableSessions = checkForResumableHostSession();
    const matchingResumable = room && resumableSessions.find(s => s.roomCode === room.toUpperCase());

    // Voir échange avec Guillaume (session du 23 juillet) — voir HOSTING_PREGAME_KEY plus
    // haut : si ce code correspond à une salle qu'on hébergeait nous-même, encore dans le
    // salon, juste avant ce rechargement, elle est morte de toute façon (rien n'est
    // persistant côté hôte avant le lancement) — pas la peine de tenter (et échouer) à la
    // rejoindre comme invité. On nettoie l'URL et le marqueur, puis on atterrit sur un
    // accueil propre, sans code préempli ni tentative de connexion.
    let wasHostingThisPregame = false;
    try { wasHostingThisPregame = room && sessionStorage.getItem(HOSTING_PREGAME_KEY) === room; } catch (e) { /* tant pis */ }
    if (wasHostingThisPregame) {
        clearHostingPregameMark();
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState(null, '', url.toString());
    } else if (matchingResumable) {
        // Voir échange avec Guillaume ("je devrais être versé directement dedans") : le
        // lien pointe explicitement vers CETTE salle, sur l'appareil qui en est bien
        // l'hôte légitime — aucune ambiguïté à lever, contrairement à un code tapé à la
        // main sans certitude d'être le bon. On masque la bannière (elle ferait
        // doublon) et on reprend directement, via uiResumeHostSession(roomCode) —
        // désormais consciente du cloud (voir plus bas), donc jamais périmée même si un
        // partenaire a enchéri depuis un autre appareil entre-temps.
        const banner = document.getElementById('resumeSessionBanner');
        if (banner) banner.style.display = 'none';
        uiResumeHostSession(matchingResumable.roomCode);
    } else if (room && navigator.onLine) {
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
