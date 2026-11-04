# Panier durable — protocole serveur

État historique de la préparation du moteur/serveur. Le [raccordement au portail](buyer-cart-portal.md) est désormais préparé et testé en branche, sans déploiement.


Lot préparé sur `feat/buyer-engagement-foundations`, sans fusion, déploiement ni
connexion à une base réelle. Le portail utilise encore les routes historiques.
Son raccordement au nouveau protocole constitue le prochain lot. Les relances
panier BUYER ENGAGEMENT restent bloquées dans
[lib/buyer-engagement.js](../lib/buyer-engagement.js).

## Contrat et preuves dans le code

[lib/buyer-cart-migration.js](../lib/buyer-cart-migration.js) ajoute quatre tables.
[lib/buyer-cart.js](../lib/buyer-cart.js) définit leurs transactions. Les routes et
le noyau de création de commande sont raccordés dans [server.js](../server.js).

| Identité | Rôle |
| --- | --- |
| Panier : `cart_id`, `revision` | Une écriture doit fournir la version lue. Une version périmée reçoit `409` sans écrasement. Le conflit exige une réconciliation explicite par le futur client. |
| Cycle par marque : `cycle_id`, révision, empreinte | États `open`, `empty`, `converted`, `unknown`. Un nouvel achat après conversion utilise un nouveau cycle. Les anciens cycles restent conservés. |
| Tentative : `request_key` | Liée à l’empreinte du contenu et du contexte effectif. Chaque marque possède un résultat terminal, succès ou refus. |

Les lignes de commande doivent correspondre aux lignes sauvegardées de chaque
marque soumise : produit, quantité, taille, coloris et note. Les prix restent
résolus dans le catalogue côté serveur. Une synchronisation identique conserve
révisions, dates du cycle et activité. Une modification des seules métadonnées
d’affichage ne transforme pas un panier historique en épisode connu.

Les paniers historiques sont importés comme `unknown / legacy_unknown`. Un
changement de contenu effectivement reçu par l’API versionnée ouvre un cycle
`open / versioned`. Les écritures et commandes historiques invalident cette
certitude ; elles conservent leur contrat de réponse et leur comportement de
commande existants. La preuve durable de conversion concerne `checkout-v2`.

## Routes réservées à l’acheteur connecté

| Route | Réponse et comportement |
| --- | --- |
| `GET /api/portal/cart-state` | Snapshot `{cart_id, revision, cart, cycles}`. Import historique conservateur à la première lecture. |
| `PUT /api/portal/cart-state` | Corps `{cart_id, revision, cart}` ; retourne le nouveau snapshot. `cart` doit être un objet explicite, même pour l’effacement `{}`. |
| `POST /api/portal/checkout-v2` | Corps : `request_key` UUID, `cart_id`, `revision`, lignes et données de validation de commande. Retourne état, résultats par marque et snapshot courant. |
| `GET /api/portal/checkout-v2/:request_key` | Lecture du résultat par son identifiant, sans signature à renvoyer ni nouvelle création. Une clé inconnue de cet acheteur reçoit `404`. |

Les réponses du nouveau protocole ont `Cache-Control: no-store, private`.
Les mutations du panier et les tentatives de commande sont limitées en fréquence.
Un résultat peut être `pending` si une interruption a laissé des marques sans
résultat terminal. Sa lecture ne relance aucune commande. Une reprise du POST
avec la même clé et le même contenu peut traiter ces marques encore pendantes,
avec recontrôle de leurs cycles. Le futur client doit conserver la clé et vérifier
ce résultat avant toute nouvelle tentative.

Un contenu différent sous une même clé reçoit `409 checkout_key_conflict`.
L’email et les coordonnées issus de la session sont également liés par une
empreinte : s’ils changent pendant une tentative incomplète, sa reprise reçoit
`409 checkout_context_changed`. Les résultats complets restent récupérables.

## Atomicité et réussites partielles

La création des lignes, le décrément du stock, l’activité acheteur, le retrait de
la marque du panier, l’état converti et son reçu utilisent le même `dbClient` et
le même `COMMIT`. Une contrainte unique interdit deux conversions réussies d’un
cycle. Le verrou du panier et les recontrôles du cycle protègent les requêtes
concurrentes et les modifications intervenues après réservation.

Les reçus sont lus avant les contrôles catalogue, MOQ, accès anticipé ou stock.
Après une création validée, un replay retourne la confirmation enregistrée,
même si ces données ont changé. Il ne repasse pas dans les effets externes de
création. La déduplication historique de vingt secondes reste limitée aux anciens
parcours : deux nouveaux cycles explicites peuvent commander les mêmes lignes.

Si A est créée et B refusée, A est retirée du panier et B y reste. L’ancienne clé
retrouve toujours le succès A et le refus B. Une nouvelle tentative pour B seule
peut réussir ensuite. Le reçu décrit le résultat historique de création ; le
statut ultérieur de la commande se consulte dans son historique habituel.

Les notifications actuelles restent exécutées après le commit d’une nouvelle
commande. Ce lot n’ajoute pas d’outbox et ne garantit pas leur livraison. Les
tests locaux bloquent les connexions sortantes et utilisent des données fictives.

## Données et exploitation

- Les nouvelles réservations stockent des empreintes et identités de cycles.
  Aucune copie supplémentaire des coordonnées, de la signature ou du corps de
  commande complet n’est stockée dans ces réservations.
- Les résultats conservent les références et données de confirmation. L’export
  acheteur existant inclut `cart_protocol` et retire `pdf_token` de cette partie.
  La suppression de l’acheteur efface les quatre tables par cascade.
- Le nettoyage au démarrage efface les payloads panier de plus de quatre-vingt-dix
  jours, avance la révision et conserve identités et reçus. Les cycles non convertis
  deviennent vides avec provenance `expired`. Une suppression de commande conserve
  le reçu et l’état converti, avec sa référence SQL devenue nullable.
- Les identités, historiques de cycles et reçus sont actuellement conservés jusqu’à
  suppression de l’acheteur. Leur durée de conservation et leur volume doivent être
  validés avant une mise en production.

La migration ajoute des tables et index, sans réécrire les anciennes commandes.
Le nettoyage des anciens paniers préexistait ; les nouvelles métadonnées permettent
d’en conserver les protections de version après effacement du contenu.

Avant un raccordement du navigateur, terminer le déploiement du serveur compatible
et arrêter les anciens processus : un ancien serveur peut encore écrire directement
dans `buyer_carts` sans invalider les nouvelles métadonnées. La cohérence pendant un
déploiement progressif de serveurs anciens/nouveaux n’est pas garantie par ce lot.
Une mise en production exige aussi sauvegarde récente et restauration isolée
vérifiée ; aucun de ces contrôles de production n’a été exécuté ici.

## Validation

[test/buyer-cart.test.js](../test/buyer-cart.test.js) contient vingt tests dédiés :
historique inconnu, synchronisation identique, conflit de version, égalité des
lignes, payloads invalides, isolation, lecture d’un reçu après abandon de l’accusé,
replay après modification du catalogue/stock, contexte modifié, deux tentatives
concurrentes, nouveaux cycles identiques, réussites partielles, compatibilité
historique, expiration, migration répétée, export/cascade et rollback commun.

`TEST_PG_ADMIN_URL=<PostgreSQL local isolé> npm test` : **135 tests passent**, aucun
échec ni test ignoré, sur Node 24 / PostgreSQL 18. Le test de réponse perdue ignore
l’accusé du POST puis retrouve son résultat par GET ; il ne simule pas une coupure
réseau physique. Le test de rollback injecte une erreur SQL d’écriture du reçu.

Le navigateur étant inchangé, ce lot ne valide pas encore sa réconciliation entre
appareils, ses paniers hors ligne, sa gestion d’une issue incertaine ou Safari/iOS.
Ces contrôles appartiennent au prochain lot client, avant toute activation des
relances à quarante-huit heures.
