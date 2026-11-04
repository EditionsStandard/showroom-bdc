# Retours fournisseur et blocages des relances

Lot du 4 novembre 2026, branche `feat/buyer-engagement-foundations`.
Le lot prépare la réception des événements Resend et ajoute une surveillance
dans BUYER ENGAGEMENT. Les envois restent verrouillés en base. Aucun fournisseur,
compte, secret ou déploiement de production n’est configuré par ce lot.

## Réception authentifiée et désactivée par défaut

Le point d’entrée `POST /api/webhooks/buyer-engagement/resend` est placé avant
les parseurs JSON généraux et les sessions. Sans activation explicite et secret
valide, il répond 503. L’activation de la réception n’active aucun envoi.

Le SDK Resend déjà installé vérifie les en-têtes `svix-id`, `svix-timestamp` et
`svix-signature` sur les octets originaux. La tolérance temporelle du vérificateur
installé est de cinq minutes. Deux secrets peuvent être fournis pour une rotation
explicite. Les clés d’API d’envoi existantes ne servent pas à cette vérification.
Le corps JSON est limité à 32 Ko, sans compression ; la limite locale est de
600 requêtes par minute et par IP. Aucune signature ni corps n’est journalisé
par ce module. Ce contrat suit la
[documentation officielle de vérification](https://resend.com/docs/webhooks/verify-webhooks-requests).

| Variable dédiée | Comportement |
|---|---|
| `ENGAGEMENT_RESEND_WEBHOOKS_ENABLED` | Active la réception uniquement si la valeur est `true`. Absente : désactivée. |
| `ENGAGEMENT_RESEND_WEBHOOK_SECRET` | Secret de signature de ce point d’entrée. |
| `ENGAGEMENT_RESEND_WEBHOOK_PREVIOUS_SECRET` | Ancien secret facultatif pendant une rotation. |

Ces variables ne sont ajoutées à aucun environnement distant. Les tests utilisent
des secrets aléatoires locaux et aucun accès au service Resend.

## Rattachement et ordre des événements

Une association durable lie un identifiant fournisseur à l’intention, au compte
et à l’empreinte de son destinataire figé. La source `local_fixture` reste distincte
de `resend`. L’acceptation du protocole isolé crée exclusivement une association
`local_fixture` ; aucun point d’entrée public ne peut la promouvoir vers Resend.
Le futur expéditeur réel devra établir ses propres associations vérifiées.

Un événement de message nécessite un identifiant connu, une seule adresse
correspondant à l’enveloppe et une date compatible avec la première tentative.
L’adresse seule ne rattache jamais un identifiant de message inconnu. Une
notification globale de suppression d’adresse ne concerne que les destinataires
déjà associés à des messages de ce périmètre et de cette source.

Un événement reçu avant la confirmation HTTP peut donc rester **sans rattachement**.
Il est acquitté sans modifier de compte. Une fois l’association établie, un
nouveau rejeu authentifié du même événement peut le traiter. Le code n’appelle
pas automatiquement Resend pour le rejouer ou retrouver un identifiant perdu.
Un acquittement HTTP perdu, sans association connue, reste un cas à réconcilier
avant le pilote. Les
[reprises et rejeux officiels](https://resend.com/docs/webhooks/retries-and-replays)
permettent notamment un rejeu depuis le tableau de bord fournisseur.

Le reçu durable est unique par source et identifiant de livraison. Huit livraisons
concurrentes identiques sont couvertes par les tests. Un même identifiant avec
un autre corps produit un conflit, sans nouvel effet. Une panne SQL ne reçoit
pas d’acquittement de réussite ; un résultat déjà committé est retrouvé au rejeu.
La boîte est bornée à 10 000 reçus. À capacité, les nouveaux événements reçoivent
503, tandis qu’un doublon déjà traité reste acquittable. Cette limite doit être
dimensionnée et surveillée avant un abonnement à un flux fournisseur réel.

## Interprétation des retours

| Événement | Traitement local |
|---|---|
| `email.sent` | Fait d’acceptation fournisseur conservé. |
| `email.delivered` | Remise au serveur destinataire conservée. Aucune lecture ni activité acheteur déduite. |
| `email.delivery_delayed` | Retard conservé ; aucun nouvel essai d’envoi déclenché. |
| `email.bounced` | Rebond conservé. Type `Permanent` : blocage d’adresse ; `Temporary` : vérification sans blocage d’adresse ; type absent ou inconnu : blocage conservateur à qualifier. |
| `email.complained` | Plainte conservée et adresse bloquée pour les relances du nouveau périmètre. |
| `email.failed` | Échec conservé et intention signalée à vérifier, sans déclarer l’adresse incorrecte. |
| `email.suppressed` | Refus fournisseur conservé et blocage des relances de cette adresse. |
| `suppression.added` | Blocage des adresses connues dans la nouvelle file. |
| `suppression.removed` | Pour un blocage existant, retrait signalé et blocage maintenu pour vérification humaine. |

Ces types et leur portée proviennent des
[événements officiels Resend](https://resend.com/docs/webhooks/event-types),
des [détails de rebond](https://resend.com/docs/webhooks/emails/bounced)
et des [suppressions d’adresse](https://resend.com/docs/webhooks/suppressions/added).
Les ouvertures, clics, contacts et autres événements sont acquittés puis ignorés,
sans collecte d’activité ni stockage de leurs données.

Les faits s’additionnent : une remise et une plainte peuvent concerner le même
message. L’interface précise que les catégories se recoupent. Les dates de faits
conservent leur première occurrence, indépendamment de l’ordre d’arrivée. Une
livraison tardive et une acceptation HTTP tardive n’effacent pas un problème de
livraison ou un blocage. Le statut d’acceptation de la file reste distinct des
faits de remise, de rebond et de plainte.

## Effet des blocages

Les blocages sont relus lors de la création et de l’autorisation d’une intention.
Les intentions sans tentative sont annulées ; après autorisation d’une tentative,
l’incertitude reste conservée. Une requête déjà autorisée peut avoir quitté le
serveur avant le blocage. Aucun nouvel essai n’est déclenché par le traitement
des événements.

L’accord marketing n’est pas réécrit. Le redonner ne contourne pas un blocage
fournisseur. Un blocage d’ancienne adresse ne bloque pas une nouvelle adresse,
et redevient pertinent si l’ancienne adresse est réutilisée. La page de
désabonnement reste disponible, de même que les fonctions d’accès acheteur.

Le périmètre de blocage est la nouvelle file BUYER ENGAGEMENT. Les fonctions
d’email historiques gardent leur fonctionnement et devront être examinées avant
le pilote pour éviter une relance parallèle. L’état global des suppressions
Resend n’est pas synchronisé par une lecture API ; la couverture dépend des
associations connues et des événements reçus.

## Administration et confidentialité

Le volet FR/EN, réservé au propriétaire, montre la réception activée/désactivée,
les messages, leurs faits, les compteurs par source et les blocages conservés.
Les messages sont paginés par 50 ; les 50 derniers blocages et leur total sont
affichés. Aucun bouton d’envoi, rejeu distant ou déblocage n’est ajouté. Une
réponse invalide efface l’affichage précédent et signale l’indisponibilité.

Le corps original, l’adresse reçue, l’objet et les diagnostics SMTP ne sont pas
stockés. Les reçus conservent des identifiants, dates, type, résultat et empreinte
du corps. Un reçu sans association n’a ni adresse, ni empreinte d’adresse, ni
compte associé. Ces métadonnées et empreintes peuvent néanmoins rester des
données personnelles indirectes ; leur accès est restreint.

La conservation proposée est de sept jours pour un reçu sans compte associé,
90 jours pour un reçu rattaché, depuis sa première réception. Un doublon ne
renouvelle pas cette durée. Un rattachement ultérieur porte l’échéance à 90 jours
depuis cette même première réception. La purge surveillée traite les expirations
par lots de 1 000. Les messages suivent la suppression de l’intention à 90 jours.
Les blocages restent liés au compte pour éviter une reprise automatique après
purge de l’historique ; la suppression du compte les supprime par cascade.
Ces durées et la procédure de levée doivent être validées avant mise en service.

L’export acheteur inclut ses faits, reçus rattachés et blocages, sans jetons,
empreintes ni signatures. Le filtre Sentry retire corps, en-têtes, cookies et
paramètres des objets de requête du point d’entrée fournisseur. Les journaux
d’infrastructure et la configuration réelle de télémétrie restent à vérifier.

## Preuves et prochaine étape

Les tests utilisent le vrai serveur local et PostgreSQL, avec signatures HMAC
calculées indépendamment et vérifiées par le SDK installé. Les associations
`resend` des tests sont des données synthétiques préparées explicitement, sans
envoi. Les tests couvrent signatures, rotation, corps modifiés, doublons,
concurrence, ordre des retours, blocages, changements d’adresse, pannes SQL,
conservation, export et droits d’accès. Le contrôle des scripts intégrés à
l’administration protège aussi les gabarits d’impression contre une inclusion
qui couperait le script principal.

La validation locale complète et la CI du commit exact sont consignées dans le
rapport de vérification. La restauration synthétique `6a628f8ff2a1dbcc` passe
17 contrôles sur 83 tables, dont 45 non vides, avec égalité des lignes, séquences,
colonnes et contraintes. Les faits et blocages restaurés restent consultables,
la réception externe reste désactivée, et la suppression du compte entraîne les
cascades attendues. Archive et bases temporaires sont supprimées. Aucune
sauvegarde de production n’est validée par cette répétition.

Avant activation réelle : sauvegarde de production restaurable, expéditeur/DKIM
et suivi des liens contrôlés, secrets dédiés et rotation préparés, couverture des
suppressions fournisseur confirmée, procédure de réconciliation des événements
sans rattachement, gestion persistante du chiffrement, worker borné, préproduction
et pilote limité approuvé. Le remplacement de l’ancien ordonnanceur, les relances
panier par marque et l’écriture d’opportunités CRM restent des lots distincts.
