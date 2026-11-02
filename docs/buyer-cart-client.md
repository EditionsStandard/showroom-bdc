# Moteur client du panier — préparé, sans raccordement au portail

[public/buyer-cart-client.js](../public/buyer-cart-client.js) est un module autonome
utilisable dans le navigateur et dans les tests Node. Aucun script du portail ne
le charge encore. Les routes historiques et les parcours acheteur restent utilisés.

Le module prépare trois fonctions nécessaires au raccordement :

- Réconciliation entre base acquittée, modifications locales et snapshot serveur.
  Les modifications de lignes distinctes peuvent être combinées. Deux modifications
  contradictoires d’une même ligne, un cycle converti/remplacé ou un panier local
  sans base connue exigent une revue. Les trois versions restent récupérables.
- Contrôleur de sauvegarde : attente de l’initialisation, une écriture à la fois,
  conservation des éditions effectuées pendant une sauvegarde et synchronisation
  d’un effacement complet. Une écriture échouée exige relecture puis résolution
  explicite ; aucun ancien snapshot n’est réémis automatiquement après conflit.
- Journal local minimal d’une tentative : identité de l’acheteur, clé, panier,
  révision et marques attendues. Les coordonnées, lignes et signatures sont exclues
  par une liste de champs autorisés. Une tentative non résolue ne peut être remplacée.
  Sa clé n’est retirée qu’après validation d’un reçu complet pour toutes les marques,
  y compris en cas de réussite partielle. Une erreur de stockage bloque sa création.

L’API du contrôleur est `create({read,write,onChange})`, puis `initialize`, `edit`,
`flush`, `reconcile`, `resolve` et `inspect`. Les adaptateurs `read/write` devront
vérifier les statuts HTTP et le JSON et utiliser le
[protocole serveur versionné](buyer-cart-protocol.md). Les données entrantes sont
copiées ; aucune fonction n’envoie directement de requête ni ne crée de commande.

`reconcile()` fournit un résultat proposé ainsi que les conflits et les versions
de récupération. L’interface devra présenter ce choix à l’acheteur avant `resolve`.
Un ancien cycle converti exige un choix explicite de nouvel achat ; l’interface ne
doit pas sélectionner automatiquement l’ancien panier local.

## Vérification et suite

[test/buyer-cart-client.test.js](../test/buyer-cart-client.test.js) : **13 tests
unitaires passent**, sans accès réseau ou base. Ils couvrent les modifications
concurrentes, suppressions, changements de cycle, bootstrap retardé, écritures en
vol, réponse perdue, accusé invalide et journal de tentative sans données sensibles.
Le lot serveur précédent a passé ses 135 tests et sa CI au commit `b3d7699`.

Ce module seul ne prouve pas une synchronisation entre navigateurs réels. Restent
à réaliser : adaptateurs réseau et stockage du panier/base, interface FR/EN de
conflit et récupération, raccordement du checkout avec lecture des reçus, blocage
des éditions pendant sa transmission, puis tests navigateur des interruptions,
deux onglets, hors ligne et réussites partielles. La politique de conservation des
copies locales de récupération doit être fixée lors de ce raccordement.

Aucune relance panier n’est activée par ce lot. Aucun déploiement ni email n’a été
effectué pendant cette préparation.
