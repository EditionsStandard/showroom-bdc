# Intérêt répété pour une marque — simulation et mesure facultative

Lot du 3 novembre 2026 sur `feat/buyer-engagement-foundations`. Aucun déploiement,
envoi, tâche de préparation ou enregistrement Airtable. Ce lot complète la
[simulation panier](buyer-cart-simulation.md) avec des signaux par acheteur et
marque, à qualifier humainement.

## Définition du signal

Le réglage initial proposé est **trois jours UTC distincts dans les sept derniers
jours glissants**, soit une fenêtre de 168 heures. C'est un paramètre de travail,
pas un seuil commercial validé par des résultats de vente. L'administration
permet de régler le nombre minimum de jours (2 à 30) et la fenêtre (3 à 30 jours,
en multiples de 24 heures). Le seuil ne peut pas dépasser le nombre de jours de
la fenêtre. La règle reste désactivée par défaut.

Un chargement réussi et visible du catalogue d'une marque déclenche, si les
conditions sont réunies, une observation authentifiée. Seule la première
observation autorisée de chaque jour UTC est conservée. Les rechargements du même
jour et les onglets concurrents ne multiplient donc pas le nombre de jours.
Le navigateur n'envoie ni date ni identité acheteur : le serveur les détermine.
Une requête ancienne ne peut pas réutiliser une version de consentement retirée.

Le serveur atteste la réception d'une requête authentifiée pour une marque
autorisée ; cela ne prouve pas une lecture attentive ou humaine. Trois jours UTC
ne signifient pas trois sessions, trois visiteurs ou 72 heures d'attention.
Les fenêtres glissantes ne retiennent que les observations effectivement connues,
sans reconstituer les visites manquantes ou une visite ultérieure du même jour.

Les compteurs `product_stats.views` et la liste locale historique des marques
récentes ne sont pas utilisés et restent inchangés. Ils ne permettent pas de
reconstruire cet historique par acheteur. Les nouvelles observations ne modifient
pas `last_meaningful_activity_at` : les définitions existantes des autres règles
restent distinctes.

## Collecte et accords

Le profil acheteur propose un choix explicite séparé des préférences email, non
coché pour un compte sans accord. Refuser n'affecte ni l'accès B2B ni les commandes.
La mesure requiert simultanément :

- un compte avec approbation et connexion achevée documentées, sans date future ;
- la règle `brand_interest` en mode `simulation` et les simulations non suspendues ;
- un accord de mesure `granted` avec la version actuelle du texte d'information ;
- une requête portant la version actuelle de ce choix ;
- une marque existante, active et accessible pour cet acheteur, accès anticipé compris.

L'interface n'émet aucun POST d'observation sans lecture valide d'un accord de
mesure actif. Une erreur de préférence, une navigation remplacée, une page cachée
ou un catalogue verrouillé bloque cette nouvelle observation. Aucune file locale,
date client, identité de terminal ou reprise automatique d'observations n'est ajoutée.
L'API conserve un contrôle autonome et limite les POST à 60 par minute et compte,
par processus serveur. Une pause ou désactivation attend la fin des observations
déjà engagées avant de confirmer sa sauvegarde.

Le retrait de l'accord de mesure supprime dans une même transaction les
observations, candidats et contrôles associés à l'acheteur. La preuve du choix
reste liée au compte. Une nouvelle autorisation commence avec une nouvelle
version et sans ancien historique. Une version de notice obsolète exige aussi un
choix renouvelé et ne permet aucune collecte. Un formulaire ancien ne peut pas
réautoriser après un retrait ; un retrait explicite peut l'emporter malgré une
version de formulaire ancienne.

L'accord email est indépendant. Il est exigé en plus pour qualifier un signal
commercial dans cette simulation. Son retrait exclut immédiatement le signal
actuel ; il ne modifie pas l'accord de mesure séparé. Ce choix conservateur ne
constitue pas une conclusion juridique générale sur la prospection B2B.

## Simulation dans BUYER ENGAGEMENT

Le propriétaire dispose d'un volet FR/EN « Intérêt marque — signaux à qualifier ».
Il montre les noms actuels, les jours effectivement observés, première et dernière
observation, état actuel et dernier contrôle enregistré. La pagination est de
cinquante couples ; les lignes sont adaptées au mobile sans défilement horizontal.

Le GET recalcule en lecture seule. Une commande hors brouillon/annulation
enregistrée depuis la première observation de la fenêtre exclut le signal, de
même qu'un contact d'engagement enregistré depuis moins de 24 heures. Ce champ
ne couvre pas les échanges commerciaux externes ou historiques non renseignés.
Un délai hors limites, un compte incomplet, un accord manquant, une marque inactive
ou une collection réservée produisent également une exclusion explicite.

« Enregistrer les signaux » crée uniquement les couples éligibles encore absents.
Il existe au maximum un candidat conservé par acheteur et marque ; les visites
ultérieures ne créent pas un nouveau faux prospect chaque jour. « Recontrôler »
actualise les candidats conservés, y compris pendant la pause pour documenter leur
exclusion. Le dernier contrôle enregistré est historique, tandis que l'état actuel
est recalculé. Le retrait de l'accord de mesure efface cet historique individuel.

Chaque calcul utilise une clé UUID persistée avant le POST ; après une réponse
perdue ou un rechargement, la même référence récupère le résultat existant.
Un stockage invalide ou indisponible bloque la création de calculs. Une réponse
de lecture invalide efface les résultats affichés. Les calculs et les contrôles
sont atomiques ; une erreur ne laisse pas une partie du lot enregistrée.

Les moteurs partagent un verrou de simulation. Les calculs verrouillent les
comptes concernés dans un ordre stable pour sérialiser les retraits, puis utilisent
des écritures groupées. Le périmètre est plafonné à 5 000 couples acheteur/marque
et les requêtes SQL sont bornées dans le temps. Un dépassement échoue explicitement,
sans enregistrement partiel. Le temps d'attente réel des comptes et les volumes
supérieurs nécessitent des essais représentatifs avant production.

## Données et conservation

La migration additive crée les tables de préférences `buyer_interest_preferences`
et `buyer_interest_preference_events`, les observations `buyer_brand_interest_days`,
ainsi que `buyer_brand_interest_runs`, `buyer_brand_interest_candidates` et
`buyer_brand_interest_checks`.

Une observation contient uniquement les identifiants acheteur/marque, jour UTC,
premier horodatage observé et version du choix. Aucun nom, email, IP, URL, appareil,
produit ou contenu de message n'est recopié. Les candidats/contrôles contiennent
les identifiants, dates de preuve, compteurs, motif et versions de réglage. Ces
identifiants restent des données personnelles liées au compte, pas des statistiques
anonymes. Les noms du volet sont résolus depuis les données actuelles, sous rôle
propriétaire, avec des réponses `no-store`.

L'export acheteur inclut préférences, preuves, observations et contrôles. La
suppression du compte ou d'une marque efface les observations et candidats
associés par cascade. Les calculs agrégés peuvent subsister sans identifiant
acheteur. Les preuves du choix sont supprimées avec le compte.

La purge retire les observations de plus de 30 jours, candidats créés depuis plus
de 90 jours et calculs de plus de 365 jours. Les contrôles suivent leurs candidats
et calculs par cascade. Elle s'exécute au démarrage et lors d'un nouveau calcul ;
un verrou occupé au démarrage peut la reporter. La lecture ne purge pas. **Aucune
purge quotidienne planifiée n'est ajoutée dans ce lot** : sans démarrage ou calcul,
la conservation physique peut dépasser ces durées. Le texte du choix le précise.
Les observations hors fenêtre sont exclues du calcul indépendamment de la purge.

Avant activation réelle, valider finalité, texte, durées, gestion des droits et
mettre en place une purge régulière dont l'exécution est surveillée. Le lot ne
certifie pas la conformité globale des autres suivis déjà présents sur le site.

## Validation et mise en service

- **195 tests locaux passent**, dont 25 nouveaux tests : choix séparé, déduplication
  concurrente, jour serveur, privilèges, retrait/réautorisation, notice obsolète,
  seuil glissant exact, idempotence, commandes, retraits marketing, paramétrage,
  export/suppression, conservation, rollback, verrou partagé, retrait concurrent
  pendant le calcul, pause concurrente attendant les observations engagées et
  dépassement de cohorte.
- [brand-interest-smoke.cjs](../scripts/brand-interest-smoke.cjs) : quatre
  configurations Chromium FR/EN à 360/1440 px contre le vrai serveur local et
  52 couples fictifs. Accord séparé, première observation via le vrai catalogue,
  déduplication, navigation remplacée, erreur de préférence bloquant la collecte,
  pagination, réponse perdue et reprise après rechargement, réglage du seuil,
  pause/recontrôle, retrait marketing, réponse invalide, retrait de mesure et purge.
- Régressions : quatre configurations de [buyer-engagement-smoke.cjs](../scripts/buyer-engagement-smoke.cjs)
  et quatre de [cart-portal-smoke.cjs](../scripts/cart-portal-smoke.cjs). Règles,
  modèles, file de préparation verrouillée et préférences email restent vérifiés,
  ainsi que conflits panier, commande incertaine, clôture et récupération de reçu.
  Aucun débordement horizontal ni erreur JavaScript observé dans ces scénarios.

Les tests utilisent des bases PostgreSQL locales fictives, sans identifiants
fournisseur et avec les sorties externes bloquées. Safari/iOS, PWA/cache, charge,
restauration et comptes réels restent des validations distinctes.

Ordre recommandé : revue du lot et des choix de mesure ; purge supervisée et
sauvegarde/restauration prouvée ; préproduction isolée avec parcours FR/EN et
autorisations réelles de revue ; autorisation explicite de publication ; règles
désactivées au premier déploiement ; pilote volontaire de simulation ; évaluation
des faux positifs avant toute qualification CRM. Aucun email, notification
commerciale ou CRM ne doit consommer ces signaux sans un lot séparé approuvé.

L'intégration Airtable reste à définir : correspondances vérifiées des comptes
et marques, responsable du suivi, qualification humaine, états de traitement et
déduplication des opportunités. Ce lot n'invente ni montant, ni probabilité, ni
contact commercial, et ne crée aucun enregistrement externe.
