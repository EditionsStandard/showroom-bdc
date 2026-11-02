# Retours d’erreur acheteur et indicateurs commerciaux

Lot préparé sur `feat/buyer-engagement-foundations`, sans migration de schéma,
correction de données réelles, fusion, déploiement ou envoi d’email.

## Portail acheteur

Le tableau de bord distingue chargement, résultat vide et échec pour les sélections
en attente et les commandes récentes. Le nouvel essai recharge seulement la section
concernée. Une réponse ancienne ne peut plus remplacer un résultat plus récent.
La prochaine action reste indéterminée lorsque les sélections n’ont pas pu être
vérifiées ; elle ne prétend plus que tout est à jour dans ce cas.

La messagerie conserve texte, sujet et pièce jointe après un échec. Un refus HTTP
explicite permet un nouvel essai manuel. Une interruption réseau, un HTTP 408/5xx ou
un accusé invalide laisse l’enregistrement incertain : le message a pu être créé
avant la perte de réponse. Le portail exige alors une relecture réussie du fil avant
de permettre un renvoi manuel. Il ne réémet pas automatiquement le POST. Le blocage
des soumissions concurrentes évite le double clic ; il ne remplace pas une future
clé d’idempotence serveur. Le brouillon reste en mémoire dans la page, sans garantie
de conservation après fermeture ou rechargement.

Une réponse `{ok:true}` signifie « enregistré dans la conversation ». Elle ne prouve
ni envoi ni réception d’un email. Ces comportements sont définis dans
[public/portal.html](../public/portal.html) et vérifiés par
[scripts/buyer-feedback-smoke.cjs](../scripts/buyer-feedback-smoke.cjs).

## Définitions des indicateurs corrigés

La définition commune figure dans
[lib/commercial-metrics.js](../lib/commercial-metrics.js). Les routes owner et agent
l’utilisent dans [server.js](../server.js) et [lib/agent-api.js](../lib/agent-api.js).

| Indicateur | Définition |
| --- | --- |
| Commandes actives | Statut `confirmed`, `validated`, `in_production` ou `shipped`. Les brouillons, annulations, archives, statuts inconnus et NULL sont exclus. |
| Montant des commandes actives HT | Somme des quantités × prix unitaires enregistrés dans les lignes. Une commande sans ligne compte comme une commande et contribue zéro au montant. Ce n’est pas du facturé ni de l’encaissé. |
| Classements acheteurs et marques | Même cohorte active ; le nombre de commandes utilise `COUNT(DISTINCT o.id)` pour éviter de compter chaque ligne comme une commande. |
| Activité sur trente jours | Commandes actives entre maintenant moins trente jours et maintenant ; les dates futures sont exclues. |
| Courbe mensuelle et meilleurs produits | Six mois calendaires : début du mois courant moins cinq mois jusqu’à maintenant. Les mois vides apparaissent à zéro dans la courbe. Les limites calendaires sont calculées par PostgreSQL. |
| Acceptation des sélections proposées | Sélections au statut enregistré `sent`, hors modèles ; numérateur : `used=true`. Les brouillons et états inconnus sont exclus. Sans proposition, le taux est indéfini et l’interface affiche un tiret. |

Le statut historique `sent` n’est pas une preuve d’acceptation par le prestataire
email, de livraison ou de lecture. `used=true` n’est pas une preuve de vente finale.
Les nouvelles clés `selections_proposed`, `selections_accepted` et
`selection_acceptance_rate` rendent le sens explicite. Les anciennes clés
`selections_total`, `selections_confirmed` et `conversion_rate` restent présentes,
avec la même cohorte corrigée, pour les clients existants.

Les autorisations agent restent les couples exacts marque/pays accordés. Les
classements globaux acheteurs restent interdits aux agents par le garde existant.
Le classement produits écarte une ligne dont le produit appartient à une autre
marque que la commande, afin de ne pas afficher ses métadonnées dans ce périmètre.

Dans [public/admin.html](../public/admin.html), une panne de courbe ne produit plus
une estimation tirée des dix dernières commandes. Courbe, produits et statistiques
possèdent un état indisponible et un nouvel essai ciblé. Une réponse invalide ne doit
pas être présentée comme une cohorte vide.

## Validation et limites

- `npm test` sur PostgreSQL 18 local isolé : 115 tests passent, aucun échec ni test
  ignoré, dont dix tests d’intégration supplémentaires dans
  [test/commercial-kpi.test.js](../test/commercial-kpi.test.js).
- Les tests supplémentaires couvrent les commandes multilignes, statuts mixtes,
  commandes sans lignes, bornes de dates, proportions et dénominateur nul,
  permissions/révocations et couples marque/pays, six mois calendaires et types
  numériques des réponses.
- Les contrôles Chromium utilisent uniquement des données synthétiques : FR/EN,
  360/1440 px ; les douze scénarios (trois scripts × quatre configurations) passent.
  Le contrôle admin couvre également les erreurs HTTP/réseau/JSON, les vrais zéros,
  les nouveaux essais indépendants et la protection contre une réponse obsolète.
  Le contrôle des formulaires existants couvre notamment pays,
  facturation, notes, invitation par lien et reprise après réussite partielle.
  Les scripts sont [buyer-feedback-smoke.cjs](../scripts/buyer-feedback-smoke.cjs),
  [commercial-kpi-smoke.cjs](../scripts/commercial-kpi-smoke.cjs) et
  [buyer-forms-smoke.cjs](../scripts/buyer-forms-smoke.cjs).

Ce lot ne normalise pas tous les rapports historiques : cartes, exports, rapport
de marque construit sur les dix commandes récentes et indicateurs d’inactivité
fondés sur `last_seen_at` restent à examiner séparément. `buyers_count` conserve
des sens différents : tous les comptes pour le propriétaire, acheteurs ayant des
commandes actives autorisées pour l’agent ; ne pas comparer ces deux populations.
Le compteur de présence et la liste des dernières commandes conservent leur
gestion historique des pannes et ne sont pas couverts par le nouveau chargeur
des statistiques.

Les contrôles locaux ne valident pas Safari/iOS, une session acheteur réelle,
la réception d’email, un paiement ou une restauration de production.

## Suite recommandée

La relance panier à quarante-huit heures reste bloquée : la conversion panier vers
commande n’est pas encore liée durablement à une révision de panier côté serveur.
Le prochain lot doit traiter identité/révision, reprise idempotente et conversion
transactionnelle, y compris réponses perdues, deux appareils et réussites partielles.
Voir [buyer-engagement-cart-readiness.md](buyer-engagement-cart-readiness.md).
Les simulations et préparations BUYER ENGAGEMENT restent sans envoi.
