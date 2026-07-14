// deal-parser.js — Lecture des fichiers .pbn et .lin exportés par le générateur de donnes.
// Produit un tableau de donnes au format commun :
//   { board, dealer, vulnerable, hands: { N:{S,H,D,C}, E:{...}, S:{...}, W:{...} } }
// où chaque hands[pos][suit] est une chaîne de rangs triée haut->bas (ex: "AKQ432").

const SUIT_ORDER = ['S', 'H', 'D', 'C'];

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
function normalizeVulnerable(v) {
    const s = (v || '').trim();
    if (/^all$/i.test(s) || /^both$/i.test(s)) return 'Both';
    if (/^none$/i.test(s) || s === '-' || s === '0') return 'None';
    if (/^ns$/i.test(s)) return 'NS';
    if (/^ew$/i.test(s)) return 'EW';
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
                S: suitGroups[0] || '',
                H: suitGroups[1] || '',
                D: suitGroups[2] || '',
                C: suitGroups[3] || ''
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

        deals.push({
            board: boardMatch ? parseInt(boardMatch[1], 10) || boardCounter : boardCounter,
            dealer: dealerMatch ? dealerMatch[1].trim().toUpperCase() : 'N',
            vulnerable: normalizeVulnerable(vulnMatch ? vulnMatch[1] : 'None'),
            hands,
            par,
            ddTable
        });
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
    const re = /([SHDC])([2-9TJQKA]*)/g;
    let m;
    let found = false;
    while ((m = re.exec(str)) !== null) {
        hand[m[1]] = m[2];
        found = true;
    }
    if (!found) throw new Error(`Main LIN illisible : "${str}"`);
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
            for (const card of hands[seat][suit]) used.add(card);
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

        deals.push({
            board: boardNumMatch ? parseInt(boardNumMatch[1], 10) : boardCounter,
            dealer,
            vulnerable: LIN_VULN_CODE[(svMatch ? svMatch[1] : '-').trim()] || 'None',
            hands,
            par: null, // le format LIN ne transporte pas d'information de par
            ddTable: null
        });
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
    module.exports = { parsePBN, parseLIN, parseDealFile, normalizeVulnerable };
}
