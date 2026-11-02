# Raccordement du panier versionné au portail

Le lot raccorde le portail de la branche de revue aux API `cart-state` et
`checkout-v2`. Aucun déploiement ni envoi d’email réel n’a été effectué.
Les anciennes API restent disponibles pour les clients déjà ouverts et les
parcours de commande existants. Les relances panier BUYER ENGAGEMENT restent
bloquées ; ce lot ne crée aucune tâche de relance.

## Parcours acheteur

[public/buyer-cart-portal.js](../public/buyer-cart-portal.js) raccorde le moteur
[buyer-cart-client.js](../public/buyer-cart-client.js) dans
[portal.html](../public/portal.html). Le catalogue est chargé avant l’initialisation
attendue du panier. Les nouveaux scripts portent une version dans leur URL.

Les sauvegardes utilisent la révision acquittée. Sur conflit ou erreur, le portail
conserve les modifications locales et propose une relecture. L’interface FR/EN
présente le contenu local et serveur, avec trois choix explicites : conserver le
serveur, appliquer les changements compatibles, ou remplacer par la version locale.
Ce dernier choix exige de cocher une confirmation de nouvel achat pour les marques
qui auraient déjà été commandées. Aucune ancienne version n’est imposée après un
simple changement de numéro de révision. Un état nécessitant une revue le reste
après rechargement.

Avant commande, la sauvegarde est attendue et l’interface est bloquée pendant
transmission. Une clé minimale est persistée avant le POST, sans signature ni
coordonnées dans ce journal. Une réponse HTTP, JSON ou un reçu incomplet ne peut
pas afficher un succès vide. Après une issue incertaine, une fenêtre modale empêche
les modifications du panier jusqu’à vérification ou clôture ; la déconnexion reste
possible. Aucun POST de commande n’est réémis automatiquement.

La récupération utilise le GET du reçu, y compris après rechargement. Les succès
partiels conservent les marques refusées et les conditions de validation saisies.
Les anciennes réponses de chargement sont ignorées après adoption d’un reçu plus
récent. Les appels réseau du nouvel adaptateur expirent après trente secondes ;
une expiration de transmission conserve sa clé et son caractère incertain.

## Clôture d’une tentative incertaine

`POST /api/portal/checkout-v2/:request_key/cancel` ajoute des refus terminaux aux
marques sans résultat. Les commandes déjà créées restent intactes : ce n’est pas
une annulation de commande. L’acheteur peut ensuite engager une nouvelle tentative
sur le panier restant.

La clôture utilise le même verrou panier que la conversion. Si la tentative n’était
pas encore réservée, un reçu de clôture empêche un POST retardé d’utiliser sa clé.
Si une conversion a déjà committé, son succès est conservé. Le code se trouve dans
[lib/buyer-cart.js](../lib/buyer-cart.js), les routes dans [server.js](../server.js).
Les contrôles d’accès acheteur et la limitation de fréquence sont conservés.

## Stockage et limites

Le panier/base sont enregistrés ensemble dans une clé locale propre au compte.
Un panier historique sans base connue exige une revue ; une copie brute initiale
est conservée pour récupération, puis retirée au prochain accès après quatre-vingt-
dix jours. Une base locale plus ancienne est remise en revue. La suppression des
copies dépend donc d’une nouvelle visite, pas d’un traitement quand le navigateur
est fermé. Le panier peut contenir des notes saisies par l’acheteur.

La clé de tentative reste conservée jusqu’à résolution ou déconnexion. La
suppression du compte et la déconnexion purgent les nouvelles clés locales, comme
les autres données du portail. Un stockage indisponible ou invalide bloque la
transmission ; aucune identité de tentative n’est inventée pour contourner l’erreur.
La durée des historiques côté serveur reste celle décrite dans
[buyer-cart-protocol.md](buyer-cart-protocol.md), à valider avant production.

## Validation

- `npm test` sur PostgreSQL 18 local isolé : **151 tests passent**, aucun échec ni
  test ignoré. Les trois tests supplémentaires vérifient le maintien de la revue
  après rechargement et la clôture d’une tentative réservée ou encore inconnue.
- [cart-portal-smoke.cjs](../scripts/cart-portal-smoke.cjs) : quatre configurations
  Chromium FR/EN, 360/1440 px, contre le vrai serveur et une base synthétique.
  Conflit réel de révision, choix explicite, effacement hors ligne, accusé invalide,
  rechargement, clôture avant POST retardé et perte de réponse après commit. Le test
  retarde aussi un ancien snapshot pour vérifier l’absence de résurrection après
  récupération. Les scénarios confirment zéro ou une commande selon le résultat,
  sans second POST navigateur. Aucun débordement horizontal ni erreur JavaScript.
- Régressions : quatre configurations des formulaires, quatre de la messagerie et
  du tableau de bord, et le scénario catalogue mobile (tailles, couleurs, minima).
  Les fixtures partagées utilisent [cart-protocol-fixture.cjs](../scripts/cart-protocol-fixture.cjs).

Ces tests n’établissent pas un fonctionnement réel dans Safari/iOS, un test de
charge, une restauration de production ou une livraison d’email. Les services
externes sont bloqués par les utilitaires de test. Une mise en production exige une
validation distincte, sauvegarde/restauration vérifiée et arrêt des anciens serveurs
avant utilisation du nouveau protocole. Les sessions de pages anciennes restent
un motif d’invalidation conservatrice, jamais de relance automatique.
