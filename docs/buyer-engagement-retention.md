# Conservation des observations et simulations — purge surveillée

Lot du 3 novembre 2026, branche de revue `feat/buyer-engagement-foundations`.
La purge est développée et vérifiée localement ; elle n'est pas déployée.
Aucune donnée de production ou Airtable n'a été purgée.

## Périmètre fixe

| Catégorie | Critère d'expiration | Maximum de lignes parentes par passage |
|---|---|---|
| Observations marque | `observed_at` de plus de 30 jours | 1 000 |
| Candidats d'intérêt marque | `created_at` de plus de 90 jours | 1 000 |
| Calculs d'intérêt marque | `created_at` de plus de 365 jours | 1 000 |
| Candidats panier | `created_at` de plus de 90 jours | 1 000 |
| Calculs panier | `created_at` de plus de 365 jours | 1 000 |

Les contrôles associés sont supprimés par cascade. Le nombre de lignes physiques
supprimées par cascade peut donc dépasser le plafond de lignes parentes. Les
compteurs du journal portent sur ces cinq catégories parentes. Les comptes,
commandes, cycles de conversion panier, préférences et preuves de choix ne sont
pas supprimés par ce traitement. Les preuves restent liées au compte selon les
règles existantes. Le journal de purge ne contient aucun identifiant acheteur,
nom, email, contenu de panier ou message ; il est purgé après 30 jours.

La comparaison est strictement « plus ancien que » : la borne exacte est conservée.
Les durées sont des constantes du code, pas des paramètres fournis au POST admin.
Leur validation avant publication reste requise ; ce lot ne certifie pas une
conformité juridique générale.

## Déclenchement et cadence

Le démarrage effectue un passage surveillé après les migrations. Il remplace les
anciennes purges initiales non journalisées des seules simulations panier/marque.
Les nettoyages historiques du reste de l'application restent inchangés.

Le réglage supplémentaire `LEGACY_BACKGROUND_JOBS_ENABLED=false` permet de
désactiver le bloc des anciens jobs tout en laissant `BACKGROUND_JOBS_ENABLED`
actif pour la nouvelle purge. Par défaut, ce nouveau réglage ne change pas les
anciens jobs. Il est utile en validation isolée ; il désactive aussi le backup
hebdomadaire historique et le nettoyage des jetons de ce bloc, pas seulement les
rappels. Ce n'est donc pas une configuration générale de production sans stratégie
de sauvegarde et de maintenance distincte. Les emails transactionnels déclenchés
par des routes ne dépendent pas de ce réglage : retirer leurs secrets et bloquer
les sorties réseau reste nécessaire dans les environnements de test.

Lorsque `BACKGROUND_JOBS_ENABLED` n'est pas `false`, un ordonnanceur vérifie toutes
les cinq minutes si un passage est dû. L'objectif est une réussite complète toutes
les six heures. Un lot incomplet, échec ou report est réessayé au contrôle suivant.
Les exécutions d'un même processus ne se chevauchent pas. Le verrou PostgreSQL
partagé des moteurs de simulation évite les exécutions concurrentes entre instances.

Avec `BACKGROUND_JOBS_ENABLED=false`, aucun timer de purge n'est créé. Le passage
initial et l'action manuelle restent disponibles. L'administration indique alors
explicitement la planification désactivée. Le texte du choix acheteur distingue
aussi ce cas d'une purge automatique. Une conservation physique plus longue est
possible en cas d'interruption, de désactivation, d'échec ou de file de données
expirées trop importante ; l'interface ne promet pas une durée maximale absolue.

Les calculs de simulation conservent leurs nettoyages existants. Ces suppressions
ne sont pas comptabilisées comme une réussite du nouveau traitement surveillé.

## Résultats vérifiables

Le volet propriétaire « Conservation des données — surveillance » affiche :

- planification active ou désactivée sur le serveur répondant ;
- dernière réussite complète connue et retard après huit heures sans réussite ;
- dernier contrôle du timer dans les métadonnées de réponse ;
- dix derniers passages, leur état et les nombres de lignes parentes supprimées ;
- durées, cadence et limites du traitement.

Les états sont distincts : `running`, `succeeded`, `partial`, `skipped_busy`,
`failed` et `interrupted`. Un lot partiel ou une ligne verrouillée encore expirée
ne devient pas une réussite complète. Un report laisse les données intactes et ne
rafraîchit pas la dernière réussite. Un traitement `running` depuis plus de dix
minutes est signalé comme bloqué. La lecture n'effectue aucune purge.

Cette surveillance est consultable dans l'administration ; elle ne constitue pas
une alerte externe proactive. Les échecs du timer sont journalisés sans données
personnelles. Avant production, prévoir la consultation ou supervision externe
des retards et tester une interruption réelle d'instance. Aucun email de
surveillance n'est ajouté dans ce lot.

## Transaction, panne et reprise

Le moteur prend un verrou consultatif de session commun avec les verrous
transactionnels des simulations. L'essai `running` est enregistré durablement
avant la transaction de suppression. Les suppressions des cinq catégories et la
mise à jour finale du journal sont committées ensemble. Une erreur annule toutes
les suppressions du passage ; seule une erreur technique normalisée est conservée.

Après une interruption, les suppressions non committées sont annulées par
PostgreSQL. Une entrée `running` sans verrou actif est marquée `interrupted` au
prochain passage, sans inventer un résultat. Une réussite déjà committée ne peut
pas être remplacée par un échec à cause d'un accusé de commit perdu. La connexion
est détruite si le verrou de session ne peut pas être libéré.

L'action manuelle possède une clé UUID conservée avant le POST, puis réutilisée
après une réponse perdue ou un rechargement. Une répétition récupère l'état du même
lot ; elle ne lance pas un deuxième lot. Un état terminal permet ensuite un
nouveau passage avec une nouvelle clé. Un stockage local indisponible ou invalide
bloque l'action manuelle. Les états d'échec et de report ne sont pas affichés comme
des suppressions réussies.

Les lignes parentes verrouillées sont ignorées avec `SKIP LOCKED`, puis détectées
comme restant à traiter. Les requêtes ont une limite de temps et les attentes de
verrou sont bornées. Les index ajoutés ciblent les dates des tables de simulation
et du journal. La durée des migrations, les cascades volumineuses, le débit de
rattrapage et l'attente réelle des utilisateurs nécessitent un essai sur une copie
représentative avant publication.

## Routes et fichiers

- GET propriétaire `/api/admin/buyer-engagement/retention` : état en lecture seule,
  réponses `no-store`, aucun résultat positif déduit d'une requête en échec.
- POST propriétaire `/api/admin/buyer-engagement/retention/runs` : uniquement une
  référence d'opération ; table, délai ou déclencheur fourni par le client n'élargit
  pas le périmètre fixe.
- [buyer-engagement-retention.js](../lib/buyer-engagement-retention.js) : moteur,
  ordonnanceur et routes ; [migration](../lib/buyer-engagement-retention-migration.js)
  additive ; [interface](../public/buyer-engagement-retention.js) FR/EN.

## Validation locale

`npm test` : **211 tests passent**, dont 16 nouveaux tests de conservation, sur
PostgreSQL 18 local et Node 24. Les nouveaux tests couvrent les cinq catégories, données valides,
boucles de rattrapage, borne exacte, verrous concurrents, rollback, réponse perdue,
interruption, cadence, timer virtuel exécutant la vraie purge, absence de timer
en mode désactivé, lecture seule, rôles et libération du verrou de session.
Un serveur de test distinct confirme aussi que la nouvelle purge peut être
planifiée avec les anciens jobs désactivés. Une réponse perdue lors de l'acquisition
du verrou de session ne peut pas laisser ce verrou dans une connexion réutilisée.

Le scénario [retention-smoke.cjs](../scripts/retention-smoke.cjs) vérifie le vrai
serveur local en FR/EN à 360/1440 px : lot de 1 001 observations expirées, reprise
sans double suppression après réponse perdue et rechargement, fin du rattrapage,
report, panne, réponse invalide et stockage indisponible. Les données sont fictives
et les services externes sont bloqués. Quatre configurations FR/EN 360/1440 px
passent pour ce scénario, ainsi que quatre pour les intérêts marque et quatre
pour les fonctions BUYER ENGAGEMENT existantes. Le rendu a été inspecté ; les
compteurs nuls restent explicitement affichés à zéro. Ces tests ne certifient pas
Safari/iOS, la PWA, la charge ou le fonctionnement réel de production. La CI doit
être vérifiée sur le commit proposé.

Avant activation : sauvegarde et restauration isolée prouvée, durée des migrations
mesurée, ordonnanceur effectivement activé, supervision du retard organisée et
autorisation explicite de déploiement. Le [raccordement Airtable](buyer-engagement-airtable-mapping.md)
reste une proposition séparée, sans écriture ni envoi.
