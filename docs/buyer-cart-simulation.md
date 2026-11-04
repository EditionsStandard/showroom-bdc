# Paniers inactifs : simulation par marque

État du lot au 3 novembre 2026 : développement sur la branche de revue
`feat/buyer-engagement-foundations`, sans déploiement ni envoi réel. Le protocole
panier et son raccordement sont décrits dans [buyer-cart-protocol.md](buyer-cart-protocol.md)
et [buyer-cart-portal.md](buyer-cart-portal.md). Cette simulation dépend de ces lots.

## Fonctionnement livré dans la branche

BUYER ENGAGEMENT comporte un volet propriétaire « Paniers inactifs ». Il affiche
les cycles courants par acheteur et marque, les motifs d'exclusion, les candidats
de simulation enregistrés et les dix derniers calculs. L'interface existe en FR/EN,
avec pages de cinquante lignes. Les comptes acheteurs et agents ne peuvent pas
accéder aux nouvelles routes.

Le GET est en lecture seule. « Enregistrer un calcul panier » crée uniquement un
candidat pour chaque cycle éligible inédit. « Recontrôler » recalcule les candidats
existants, y compris pendant une pause globale pour enregistrer leur exclusion.
Les règles sont désactivées par défaut ; seule la configuration `simulation`
permet de qualifier un panier. Un délai inférieur à 48 heures reste exclu par le
moteur, même s'il provient d'un ancien paramétrage.

L'identité du candidat est `(cycle_id, revision, content_hash)`, donc propre à
une marque et à un contenu. Un changement de contenu exclut l'ancienne version
et exige un nouveau délai avant qualification. Une commande réussie exclut le
cycle converti. La déduplication est limitée à la conservation des candidats.

Les décisions utilisent un snapshot transactionnel cohérent, sans verrouiller les
écritures panier. Une modification committée après ce snapshot peut rendre une
décision enregistrée dépassée. Le volet recalcule donc l'état actuel à chaque
lecture et le distingue du dernier contrôle enregistré. Cela ne constitue jamais
une autorisation d'envoyer : aucun expéditeur ne consomme ces candidats.

## Critères conservateurs

Un panier peut être indiqué « à examiner en simulation » uniquement si :

- son cycle est courant, ouvert, issu du protocole versionné et son empreinte
  correspond exactement au contenu ; les données historiques inconnues sont exclues ;
- sa dernière modification date d'au moins le délai configuré, avec un minimum
  de 48 heures, comparaison PostgreSQL inclusive à l'instant exact ;
- l'approbation et une connexion achevée sont documentées, sans date d'accès future ;
- l'accord marketing explicite est présent ;
- la dernière action significative est connue et suffisamment ancienne, la
  présence connue n'est pas récente et aucun contact d'engagement enregistré
  dans `last_engagement_email_at` ne date de moins de 24 heures ;
- aucune transmission de commande correspondante ne reste sans résultat terminal ;
- la marque est disponible et l'accès anticipé est autorisé, le cas échéant ;
- chaque article existe dans la bonne marque, satisfait les règles partagées de
  taille/couleur/stock, possède un prix valide et respecte les minima de commande ;
- un brouillon de modèle existe dans la langue FR/EN applicable.

Le champ de dernier contact ne couvre que les contacts enregistrés dans ce champ.
Il ne prouve pas l'absence d'emails historiques ou d'échanges effectués hors de
l'application. Une décision positive ne prouve ni un abandon volontaire, ni une
intention d'achat, ni une future vente. Elle ne réserve aucun stock.

## Stockage et sécurité

Les trois nouvelles tables sont `buyer_cart_simulation_runs`,
`buyer_cart_simulation_candidates` et `buyer_cart_simulation_checks`. Le journal
conserve versions de règle/modèle, motif, horodatage et compteurs ; les candidats
référencent l'acheteur et son cycle. Aucun nom, email, corps de message, signature
ou contenu de panier n'est recopié dans ces tables. L'interface résout les noms
depuis les données actuelles, sous contrôle propriétaire, avec `Cache-Control: no-store`.
Les identifiants et empreintes restent des données liées à une personne et doivent
être traités comme telles.

Le candidat et ses contrôles sont supprimés en cascade avec l'acheteur ou le cycle.
L'export acheteur inclut les candidats et contrôles. Les calculs agrégés restent
sans identifiant acheteur après cette suppression.

La purge retire les candidats créés depuis plus de 90 jours et les calculs de
plus de 365 jours. Le [lot de conservation surveillée](buyer-engagement-retention.md)
ajoute le passage initial journalisé et l'ordonnanceur régulier, en plus des
nettoyages des calculs. Les lots incomplets ou reports ne deviennent pas des
réussites complètes. La planification respecte `BACKGROUND_JOBS_ENABLED=false` ;
une désactivation ou un retard peut prolonger le stockage physique. La lecture ne
purge pas. Ces durées sont des choix techniques à valider avant production.

Chaque calcul est atomique et utilise une clé UUID unique. Après une réponse
perdue, le navigateur conserve uniquement le type et la référence du calcul dans
`localStorage`, puis réutilise cette même référence, y compris après rechargement.
Un stockage indisponible ou invalide bloque les nouveaux calculs. La réponse d'un
GET invalide efface les résultats affichés et bloque les nouvelles générations
jusqu'à une lecture valide.

Les calculs sont bornés : 1 000 cycles courants, 5 000 candidats conservés et
10 000 produits distincts à contrôler. Un dépassement renvoie une erreur explicite
sans résultat partiel enregistré. Le verrou de simulation partagé empêche deux
moteurs de calcul concurrents ; des limites de temps encadrent les requêtes SQL.
Un volume supérieur exigera un traitement par lots et des essais de charge.

## Limites et ordre de mise en service

Ce lot n'ajoute aucun email, tâche de préparation, appel fournisseur, écriture
Airtable ou opportunité commerciale. Les contraintes SQL interdisent les états
d'envoi dans ces nouvelles tables. Le moteur générique par acheteur et la file
de préparation existante restent limités à leurs règles précédentes : la règle
panier utilise ce volet dédié par marque.

Avant toute mise en production : revue des migrations et durées, sauvegarde
récente et restauration isolée prouvée, validation du protocole panier sur de
vrais parcours de revue, puis validation et autorisation explicite du déploiement.
Les pages anciennes et écritures historiques continueront d'être exclues.

La première mise en service devrait conserver les règles désactivées, puis ouvrir
une simulation manuelle sur un périmètre vérifié. Tout futur envoi devra refaire
les contrôles immédiatement avant expédition, gérer désabonnements, plafonds entre
campagnes, arrêt d'urgence, résultats fournisseur et traitement des échecs. La
qualification d'intérêts répétés par marque nécessite encore une collecte
d'événements distincte et une définition commerciale validée.

## Preuves de validation locale

- `npm test` : **170 tests passent** sur PostgreSQL 18 local, dont 19 nouveaux
  tests de simulation panier. Seuil exact et microseconde précédente, deux marques,
  reprise idempotente, conversion réelle, changement de version, retrait d'accord,
  catalogue/minima, droits, export/suppression, purge, rollback et limite de cohorte.
- [cart-engagement-smoke.cjs](../scripts/cart-engagement-smoke.cjs) : quatre
  configurations Chromium, FR/EN à 360 et 1440 px, contre le vrai serveur local
  avec 52 paniers fictifs. Pagination, réponse perdue après commit puis rechargement
  et reprise avec la même clé, accord retiré, pause/recontrôle, réponse invalide,
  stockage bloqué ou invalide. Vérification d'absence de débordement et d'erreur JS.
- [buyer-engagement-smoke.cjs](../scripts/buyer-engagement-smoke.cjs) : quatre
  configurations FR/EN à 360/1440 px confirment les fonctions existantes : règles,
  modèles, journal, file de préparation verrouillée, pause et accord acheteur.

Les utilitaires de test neutralisent les services externes et utilisent des bases
locales dédiées. Ces vérifications ne valident pas Safari/iOS, la production, la
charge, une restauration ou la livraison d'emails.
