// deal-parser.js — Lecture des fichiers .pbn et .lin exportés par le générateur de donnes.
// Produit un tableau de donnes au format commun :
//   { board, dealer, vulnerable, hands: { N:{S,H,D,C}, E:{...}, S:{...}, W:{...} } }
// où chaque hands[pos][suit] est une chaîne de rangs triée haut->bas (ex: "AKQ432").

const SUIT_ORDER = ['S', 'H', 'D', 'C'];
const SEAT_ORDER = ['N', 'E', 'S', 'W'];
const VALID_RANKS_RE = /^[AKQJT98765432]*$/;

// Validation sémantique commune PBN/LIN. Le parseur ne doit pas seulement réussir à
// découper le texte : une donne jouable doit aussi décrire un vrai paquet de bridge.
// On valide ici uniquement les invariants de cartes nécessaires au runtime : donneur,
// 4 mains de 13 cartes, rangs connus et 52 cartes uniques.
function normalizeAndValidateRanks(raw, context) {
    let ranks = String(raw == null ? '' : raw).trim().toUpperCase();
    // Certains PBN utilisent '-' pour une chicane ; le runtime représente une couleur
    // vide par une chaîne vide, donc on normalise ce cas standard avant validation.
    if (ranks === '-') ranks = '';
    if (!VALID_RANKS_RE.test(ranks)) {
        throw new Error(`${context} : rang de carte invalide dans "${raw}".`);
    }
    return ranks;
}

function validateDealSemantics(deal, label) {
    const where = label || `donne ${deal && deal.board != null ? deal.board : '?'}`;
    const dealer = String(deal && deal.dealer || '').trim().toUpperCase();
    if (!SEAT_ORDER.includes(dealer)) {
        throw new Error(`${where} : donneur invalide "${deal && deal.dealer != null ? deal.dealer : ''}" (attendu N, E, S ou W).`);
    }
    deal.dealer = dealer;

    if (!deal.hands || typeof deal.hands !== 'object') {
        throw new Error(`${where} : les quatre mains sont absentes.`);
    }

    const seenCards = new Set();
    for (const seat of SEAT_ORDER) {
        const hand = deal.hands[seat];
        if (!hand || typeof hand !== 'object') {
            throw new Error(`${where} : main ${seat} absente.`);
        }

        let cardCount = 0;
        for (const suit of SUIT_ORDER) {
            const ranks = normalizeAndValidateRanks(hand[suit], `${where}, main ${seat}, couleur ${suit}`);
            hand[suit] = ranks;
            cardCount += ranks.length;
            for (const rank of ranks) {
                const card = suit + rank;
                if (seenCards.has(card)) {
                    throw new Error(`${where} : carte dupliquée ${card}.`);
                }
                seenCards.add(card);
            }
        }

        if (cardCount !== 13) {
            throw new Error(`${where} : main ${seat} contient ${cardCount} cartes au lieu de 13.`);
        }
    }

    if (seenCards.size !== 52) {
        throw new Error(`${where} : la donne contient ${seenCards.size} cartes uniques au lieu de 52.`);
    }
    return deal;
}

function emptyHands() {
    return {
        N: { S: '', H: '', D: '', C: '' },
        E: { S: '', H: '', D: '', C: '' },
        S: { S: '', H: '', D: '', C: '' },
        W: { S: '', H: '', D: '', C: '' }
    };
}

// Normalise les libellés de vulnérabilité rencontrés dans la nature (PBN standard dit
// "All", ce générateur exporte "Both" ; on accepte les deux).
function normalizeVulnerable(v, { strict = false } = {}) {
    const s = (v || '').trim();
    if (/^all$/i.test(s) || /^both$/i.test(s)) return 'Both';
    if (/^none$/i.test(s) || s === '-' || s === '0') return 'None';
    if (/^ns$/i.test(s)) return 'NS';
    if (/^ew$/i.test(s)) return 'EW';
    if (!strict && s === '') return 'None';
    if (strict) throw new Error(`Vulnérabilité invalide "${v == null ? '' : v}" (attendu None, NS, EW, Both/All).`);
    return 'None';
}

// --- PBN ---
//
// [Event "..."]
// [Board "1"]
// [Dealer "N"]
// [Vulnerable "None"]
// [Deal "N:AKQ.T98.765.432 ... "]
//
// Le champ [Deal] donne la main du joueur cité en premier (ici N), puis les 3 suivants
// dans l'ordre horaire (N -> E -> S -> W), séparés par des espaces, chaque main étant
// 4 groupes de rangs séparés par des points dans l'ordre Pique.Coeur.Carreau.Trèfle.
function parsePBN(text) {
    const deals = [];
    const boardBlocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

    let boardCounter = 0;
    for (const block of boardBlocks) {
        const dealMatch = block.match(/\[Deal\s+"([^"]+)"\]/i);
        if (!dealMatch) continue; // bloc sans donne exploitable, on l'ignore

        boardCounter++;
        const boardMatch = block.match(/\[Board\s+"([^"]+)"\]/i);
        const dealerMatch = block.match(/\[Dealer\s+"([^"]+)"\]/i);
        const vulnMatch = block.match(/\[Vulnerable\s+"([^"]+)"\]/i);

        const dealStr = dealMatch[1].trim();
        const firstSeat = dealStr[0].toUpperCase();
        const handsStr = dealStr.slice(2).trim().split(/\s+/); // 4 mains

        if (handsStr.length !== 4 || !'NESW'.includes(firstSeat)) {
            throw new Error(`Donne PBN illisible (board ${boardCounter}) : "${dealStr}"`);
        }

        const seatOrder = [];
        let seat = firstSeat;
        for (let i = 0; i < 4; i++) {
            seatOrder.push(seat);
            seat = 'NESW'[('NESW'.indexOf(seat) + 1) % 4];
        }

        const hands = emptyHands();
        seatOrder.forEach((seatLabel, i) => {
            const suitGroups = handsStr[i].split('.');
            if (suitGroups.length !== 4) {
                throw new Error(`Main PBN illisible (board ${boardCounter}, ${seatLabel}) : "${handsStr[i]}"`);
            }
            hands[seatLabel] = {
                S: normalizeAndValidateRanks(suitGroups[0] || '', `Donne PBN ${boardCounter}, main ${seatLabel}, couleur S`),
                H: normalizeAndValidateRanks(suitGroups[1] || '', `Donne PBN ${boardCounter}, main ${seatLabel}, couleur H`),
                D: normalizeAndValidateRanks(suitGroups[2] || '', `Donne PBN ${boardCounter}, main ${seatLabel}, couleur D`),
                C: normalizeAndValidateRanks(suitGroups[3] || '', `Donne PBN ${boardCounter}, main ${seatLabel}, couleur C`)
            };
        });

        const parMatch = block.match(/\[OptimumScore\s+"([NSEW]+)\s+(-?\d+)"\]/i);
        const parContractMatch = block.match(/\[OptimumContract\s+"([1-7](?:NT|[CDHS]))"\]/i);
        const parDeclarerMatch = block.match(/\[OptimumDeclarer\s+"([NESW])"\]/i);
        let par = null;
        if (parMatch) {
            par = {
                side: parMatch[1].toUpperCase() === 'EW' ? 'EW' : 'NS',
                score: parseInt(parMatch[2], 10),
                contract: parContractMatch ? parContractMatch[1].toUpperCase() : null,
                declarer: parDeclarerMatch ? parDeclarerMatch[1].toUpperCase() : null
            };
        }

        // Table complète du double mort, si présente (tag PBN standard [OptimumResultTable],
        // suivi de 20 lignes "Déclarant Dénomination Levées"). Contrairement à [OptimumScore]
        // (un simple score), cette table donne le détail complet, couleur par couleur et
        // déclarant par déclarant — l'ordre des lignes n'a pas d'importance pour le parsing.
        let ddTable = null;
        const ortMatch = block.match(/\[OptimumResultTable\s+"[^"]*"\]\s*\n((?:[NESW]\s+(?:NT|[SHDC])\s+\d+\s*\n?)+)/i);
        if (ortMatch) {
            ddTable = { N: {}, S: {}, H: {}, D: {}, C: {} }; // N ici = SA (sans-atout), pas Nord
            const rows = ortMatch[1].trim().split('\n');
            for (const row of rows) {
                const rowMatch = row.trim().match(/^([NESW])\s+(NT|[SHDC])\s+(\d+)$/i);
                if (!rowMatch) continue;
                const declarer = rowMatch[1].toUpperCase();
                const strainKey = rowMatch[2].toUpperCase() === 'NT' ? 'N' : rowMatch[2].toUpperCase();
                ddTable[strainKey][declarer] = parseInt(rowMatch[3], 10);
            }
        }

        const parsedDeal = {
            board: boardMatch ? parseInt(boardMatch[1], 10) || boardCounter : boardCounter,
            dealer: dealerMatch ? dealerMatch[1].trim().toUpperCase() : 'N',
            vulnerable: vulnMatch ? normalizeVulnerable(vulnMatch[1], { strict: true }) : 'None',
            hands,
            par,
            ddTable
        };
        validateDealSemantics(parsedDeal, `Donne PBN ${parsedDeal.board}`);
        deals.push(parsedDeal);
    }

    if (deals.length === 0) {
        throw new Error('Aucune donne exploitable trouvée dans ce fichier PBN.');
    }
    return deals;
}

// --- LIN ---
//
// qx|o1|md|3SQ9HAKT2DAT3CJT53,SJTHQJ93DJ72CK764,SA8754H654DK85CA2|sv|-|pg||
//
// Après "md|", le premier caractère est le numéro du donneur (1=Sud, 2=Ouest, 3=Nord,
// 4=Est), suivi de 3 mains séparées par des virgules dans l'ordre Sud, Ouest, Nord
// (la main d'Est se déduit des 52 cartes restantes). Chaque main est écrite comme
// S<rangs>H<rangs>D<rangs>C<rangs>. Le code de vulnérabilité après "sv|" est
// "-"=personne, "n"=NS, "e"=EO, "b"=les deux.
const LIN_DEALER_NUM = { '1': 'S', '2': 'W', '3': 'N', '4': 'E' };
const LIN_VULN_CODE = { '-': 'None', n: 'NS', e: 'EW', b: 'Both' };

function parseLinHandString(str) {
    const hand = { S: '', H: '', D: '', C: '' };
    const source = String(str || '').trim().toUpperCase();
    const re = /([SHDC])([2-9TJQKA]*)/g;
    const seenSuits = new Set();
    let m;
    let cursor = 0;
    let found = false;
    while ((m = re.exec(source)) !== null) {
        // Le vieux parseur ignorait silencieusement les caractères qu'il ne connaissait
        // pas (par ex. Z). Exiger une couverture intégrale évite de fabriquer une main
        // différente du fichier fourni.
        if (m.index !== cursor || seenSuits.has(m[1])) {
            throw new Error(`Main LIN illisible : "${str}"`);
        }
        hand[m[1]] = normalizeAndValidateRanks(m[2], `Main LIN, couleur ${m[1]}`);
        seenSuits.add(m[1]);
        cursor = re.lastIndex;
        found = true;
    }
    if (!found || cursor !== source.length) throw new Error(`Main LIN illisible : "${str}"`);
    return hand;
}

function allCardsOfSuit() {
    return ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
}

function deduceFourthHand(hands, knownSeats) {
    // Déduit la main manquante (Est, normalement) à partir des 3 autres et des 52 cartes.
    const missingSeat = ['N', 'E', 'S', 'W'].find(s => !knownSeats.includes(s));
    const deduced = { S: '', H: '', D: '', C: '' };
    for (const suit of ['S', 'H', 'D', 'C']) {
        const used = new Set();
        knownSeats.forEach(seat => {
            for (const card of hands[seat][suit]) {
                if (used.has(card)) {
                    throw new Error(`Donne LIN invalide : carte dupliquée ${suit}${card}.`);
                }
                used.add(card);
            }
        });
        deduced[suit] = allCardsOfSuit().filter(c => !used.has(c)).join('');
    }
    hands[missingSeat] = deduced;
}

function parseLIN(text) {
    const deals = [];
    // Un fichier peut être sur une seule ligne géante ou une ligne par donne : on
    // découpe directement sur chaque occurrence de "qx|" plutôt que sur les retours ligne.
    const boardChunks = text.split(/(?=qx\|)/).map(c => c.trim()).filter(c => c.startsWith('qx|'));

    let boardCounter = 0;
    for (const chunk of boardChunks) {
        const mdMatch = chunk.match(/md\|([^|]+)\|/);
        if (!mdMatch) continue;

        boardCounter++;
        const boardNumMatch = chunk.match(/qx\|o(\d+)\|/);
        const svMatch = chunk.match(/sv\|([^|]*)\|/);

        const mdContent = mdMatch[1];
        const dealerChar = mdContent[0];
        const dealer = LIN_DEALER_NUM[dealerChar];
        if (!dealer) {
            throw new Error(`Numéro de donneur LIN illisible (donne ${boardCounter}) : "${dealerChar}"`);
        }

        const handStrings = mdContent.slice(1).split(',').map(s => s.trim()).filter(Boolean);
        if (handStrings.length < 3) {
            throw new Error(`Donne LIN incomplète (donne ${boardCounter}) : il faut au moins 3 mains (Sud, Ouest, Nord).`);
        }

        const hands = emptyHands();
        const seatForHandIndex = ['S', 'W', 'N']; // ordre standard du format LIN
        const knownSeats = [];
        handStrings.slice(0, 3).forEach((str, i) => {
            hands[seatForHandIndex[i]] = parseLinHandString(str);
            knownSeats.push(seatForHandIndex[i]);
        });
        deduceFourthHand(hands, knownSeats);

        const parsedDeal = {
            board: boardNumMatch ? parseInt(boardNumMatch[1], 10) : boardCounter,
            dealer,
            vulnerable: (() => {
                const raw = (svMatch ? svMatch[1] : '-').trim().toLowerCase();
                if (!Object.prototype.hasOwnProperty.call(LIN_VULN_CODE, raw)) {
                    throw new Error(`Vulnérabilité LIN invalide (donne ${boardCounter}) : "${svMatch ? svMatch[1] : ''}".`);
                }
                return LIN_VULN_CODE[raw];
            })(),
            hands,
            par: null, // le format LIN ne transporte pas d'information de par
            ddTable: null
        };
        validateDealSemantics(parsedDeal, `Donne LIN ${parsedDeal.board}`);
        deals.push(parsedDeal);
    }

    if (deals.length === 0) {
        throw new Error('Aucune donne exploitable trouvée dans ce fichier LIN.');
    }
    return deals;
}

// Détecte le format à partir du contenu et du nom de fichier, puis parse.
//
// Cas ambigu : si le texte contient à la fois un motif PBN ([Deal "...") et un motif LIN
// (qx|...) — par ex. un fichier renommé par erreur, ou un export malformé — on ne tranche
// pas silencieusement. On parse quand même en PBN (le format le plus structuré des deux,
// donc le choix le moins susceptible de produire des donnes fausses sans erreur), mais on
// attache un avertissement au tableau renvoyé (propriété non énumérable _formatWarning)
// pour que l'appelant puisse prévenir l'utilisateur. Un tableau normal n'ayant pas cette
// propriété, elle n'a aucun effet sur le code existant qui ignore ce cas.
function parseDealFile(text, filename) {
    const name = (filename || '').toLowerCase();
    const looksLikePBN = /\[Deal\s+"/.test(text) || name.endsWith('.pbn');
    const looksLikeLIN = /qx\|/.test(text) || name.endsWith('.lin');

    if (looksLikePBN && looksLikeLIN) {
        const deals = parsePBN(text);
        Object.defineProperty(deals, '_formatWarning', {
            value: 'Ce fichier contient à la fois des motifs PBN et LIN : il a été lu comme un fichier PBN. ' +
                   'Si le résultat ne semble pas correct, vérifiez le fichier ou renommez-le avec l\'extension attendue (.pbn ou .lin).',
            enumerable: false
        });
        return deals;
    }
    if (looksLikePBN) return parsePBN(text);
    if (looksLikeLIN) return parseLIN(text);
    throw new Error('Format de fichier non reconnu : ce n\'est ni un .pbn ni un .lin valide.');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { parsePBN, parseLIN, parseDealFile, normalizeVulnerable, validateDealSemantics };
}
