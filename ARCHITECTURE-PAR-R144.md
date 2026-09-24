# PLAY R144 — Architecture consolidée du PAR statistique

## Principe

Le navigateur est le moteur de référence du calcul statistique. Le serveur fournit un cache/préchauffage RAW ; PONS et les raffinements adaptatifs appartiennent au runtime local.

```text
Donne + statisticalSeedId
        |
        +--> DD exact
        |
        +--> Population statistique unique par camp
                |
                +--> RAW
                |
                +--> PONS conditionné (tout ou rien)
                        |
                        +--> primaire prioritaire (24)
                        +--> cellules directes (24 -> 48 -> 72)
                        +--> full-table seulement si cellule directe impossible
```

## Responsabilités

### Serveur / pool
- fournit idéalement une donne déjà prête ;
- peut fournir le DD exact ;
- peut fournir une baseline RAW ;
- pour une donne locale, PLAY ne poll plus la progression une fois DD + 24 RAW NS + 24 RAW EW obtenus ;
- le serveur peut continuer ensuite à enrichir son propre pool sans rester dans le chemin critique de la partie.

### DDS local WASM
- moteur de référence de la partie en cours ;
- calcule les cellules nécessaires ;
- assure les raffinements 48/72 ;
- calcule toute population PONS conditionnée ;
- possède watchdog, remplacement de Worker et retry borné.

### PONS
- ne reçoit que les informations publiques d'enchères ;
- produit une identité sémantique canonique des contraintes ;
- un Passe qui ne change pas les contraintes ne change plus le plan ;
- si 72 candidats conditionnés ne peuvent pas être produits dans la fenêtre bornée, le plan entier repasse RAW : jamais de mélange.

### P2P
- les invités peuvent fournir de la puissance DDS WASM au host ;
- ce calcul est collaboratif et local aux navigateurs, pas un retour au DDS Vercel historique.

## Chemins de calcul

### Primary
Le contrat de PAR principal reçoit la priorité absolue pour faire apparaître rapidement le premier pourcentage.

### Direct cells
Après le primaire, le chemin normal est une cellule `(camp, dénomination, déclarant)`. Le même nombre de levées sert plusieurs niveaux du même contrat.

### Full-table fallback
Conservé uniquement pour les rares ensembles de cibles trop complexes/non représentables dans la limite des cellules directes. Les sacrifices ne sont plus une raison de l'utiliser : ils ne font plus partie du pipeline de probabilités de réalisation.

## Source unique de population

`contractChancePopulationPlan()` fournit désormais :
- le camp ;
- `planKey` RAW/PONS ;
- le mode ;
- le nombre demandé ;
- la liste des candidats.

Les chemins primaire, direct et full-table ne reconstruisent donc plus chacun leur propre interprétation de la population.

## Ce qui n'a pas changé

- UI ;
- probabilités et seuils 24/48/72 ;
- logique Wilson ;
- ordre des cibles affichées ;
- règles PONS ;
- génération déterministe des redistributions ;
- calcul du PAR exact.

## R145 — couche de résilience au-dessus de l'architecture consolidée

R145 ne change pas le moteur statistique ni la population RAW/PONS définis par R144.
Il ajoute une couche de supervision strictement orthogonale :

- le watchdog DDS protège une tâche Worker isolée (20 s) ;
- le superviseur observe la progression de la donne visible (2,5 s) ;
- après 8 s sans progression alors qu'un travail est encore attendu, il réveille et
  remonte en priorité le scheduler de cette donne ;
- après 15 s, il peut recycler les Workers réellement anciens (>12 s) et réarmer les
  retries fast/direct ;
- les reprises sont bornées et le compteur est remis à zéro dès qu'un échantillon
  supplémentaire est obtenu ;
- un changement de plan RAW/PONS remet aussi la surveillance à zéro.

Aucun élément de cette couche ne touche au DOM. Le diagnostic détaillé est disponible
uniquement via `window.getStatParDiagnostic()` dans la console développeur.
