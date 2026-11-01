# BUYER ENGAGEMENT — registre durable de simulation

Ce deuxième lot prolonge le socle du commit `0aca716`. Il permet d’enregistrer et de recontrôler des calculs ; il ne livre pas de file d’envoi réelle, de worker d’email ou de connexion CRM. Les règles panier et intérêt marque restent bloquées.

## Comportement livré

- Le GET d’aperçu reste en lecture seule. Un clic explicite de l’owner sur « Enregistrer un calcul » crée un calcul durable et les candidats simulés éligibles.
- La clé UUID de la requête rend une reprise idempotente. Une réponse perdue peut être redemandée avec la même clé : le même résultat est renvoyé sans nouvel enregistrement. Une clé réutilisée pour un autre type de calcul est refusée.
- Deux clés distinctes créent deux entrées dans le journal, mais pas deux candidats pour le même épisode. La clé d’épisode contient la règle, l’acheteur et la date source exacte PostgreSQL : approbation pour l’activation, dernière action métier pour l’inactivité. Une version de modèle ou de règle ne crée pas un nouvel épisode.
- Chaque génération recontrôle aussi les candidats existants. Un recontrôle seul met à jour les candidats déjà enregistrés sans en créer de nouveaux. Les anciennes ancres d’activité sont exclues ; elles ne peuvent pas redevenir valides parce qu’une activité plus récente aurait elle-même vieilli.
- Les décisions prennent en compte la règle courante, l’accord marketing, les dates de connexion/action et la présence, l’activation et le modèle disponible. Le journal conserve les versions de règles/modèles utilisées, les résultats agrégés et les contrôles successifs de chaque candidat.
- Les statuts sont uniquement `eligible` et `excluded`, en mode `simulation`. « Éligible » signifie résultat du calcul à sa date ; cela n’autorise aucun envoi et ne garantit pas que l’acheteur est encore éligible après cette date.
- La pause bloque les nouvelles générations et masque immédiatement l’éligibilité affichée. Le recontrôle reste possible pendant la pause pour enregistrer les exclusions. Reprendre les simulations ne vaut pas recontrôler toutes les données.

La pause concerne uniquement les simulations. Elle ne désactive ni les anciennes relances à validation manuelle ni les emails transactionnels du portail. Il n’existe toujours pas d’arrêt global des envois futurs dans ce lot.

## Cohérence et limites d’exploitation

Le calcul entier est transactionnel : les candidats, contrôles et compteurs sont validés ensemble. Une erreur provoque un rollback complet ; le journal contient les calculs validés, pas les tentatives refusées/échouées. Les erreurs sont présentées à l’owner, sans enregistrer des messages d’exception susceptibles de contenir des données personnelles.

Un verrou consultatif transactionnel empêche deux moteurs de modifier le registre simultanément. Une seconde demande reçoit `409 simulation_busy`, à réessayer. Les modifications de pause utilisent le même ordre de verrouillage. Les changements de règles/modèles et de préférences sont coordonnés avec le calcul : règles et acheteurs sont verrouillés avant lecture des données utilisées. Les écritures de préférences verrouillent d’abord l’acheteur.

Les écritures de candidats/contrôles sont groupées en SQL. L’attente de verrou est limitée à trois secondes et chaque requête SQL à vingt secondes. Ces limites ne constituent pas une garantie de durée totale HTTP. Le calcul peut brièvement retarder une connexion ou une modification de panier ; mesurer ce coût en préproduction sur une copie représentative avant publication.

Au-delà de 10 000 acheteurs, le calcul est refusé explicitement (`422 simulation_cohort_limit`), sans résultat partiel ni compteurs trompeurs. Un traitement par lots avec reprise persistante reste à développer pour les cohortes plus grandes. Aucun calcul automatique ou nouveau cron de prospection n’est lancé.

## Minimisation, conservation et droits

Le registre ne copie ni nom, ni email, ni texte d’email rendu, ni URL, ni token. Les coordonnées affichées à l’owner sont jointes depuis le compte acheteur courant. Aucun suivi supplémentaire de navigation n’est ajouté.

Les candidats et leurs contrôles sont supprimés après 90 jours depuis la **création du candidat**. Les recalculs ne prolongent pas cette date. La déduplication porte donc sur la fenêtre de conservation : un épisode encore éligible pourra être recréé après purge, ce qui reste un résultat simulé. Les calculs agrégés, sans identifiant acheteur ni acteur copié, sont conservés 365 jours. Les UUID de requête n’acceptent pas de texte libre.

La purge s’exécute dans les nouveaux calculs et dans le nettoyage existant toutes les six heures. Elle n’est pas garantie pendant l’arrêt du service. Le choix de ces durées doit être validé avec la politique de conservation avant publication.

Les deux exports RGPD incluent les candidats et leurs contrôles du seul acheteur connecté. L’effacement du compte supprime ces traces par cascade. Les compteurs agrégés de calcul restent conservés ; ils ne constituent pas un historique nominatif.

## API owner

- `GET /api/admin/buyer-engagement/ledger?offset=0&run_offset=0` : registre paginé (50 candidats, 10 calculs) et réglage de pause, en lecture seule et sans cache.
- `POST /api/admin/buyer-engagement/simulation-runs` : `{request_key: UUID, kind: 'generate'|'recheck'}`.
- `PUT /api/admin/buyer-engagement/simulation-control` : `{paused: boolean, version: integer}`. Les versions concurrentes sont rejetées.

Les routes restent owner uniquement. Les agents, designers et acheteurs n’accèdent pas au registre transversal. Aucun rôle ou périmètre commercial supplémentaire n’est accordé.

## Avant tout envoi futur

Le registre de simulation n’est pas réutilisable tel quel comme une autorisation d’expédition. Il faudra un mécanisme de réservation et de reprise propre aux envois, un recontrôle au dernier moment, un lien de désabonnement, des plafonds, une gestion des échecs fournisseur et un arrêt global. L’ancienne règle d’inactivité à 45 jours devra être remplacée explicitement, sans double planificateur. Les limites de couverture d’activité, de validation des paniers et de données marques du premier lot restent applicables.


## Validation locale du deuxième lot

- 83 tests réussis sur PostgreSQL 18.6 / Node 24.16.0, dont 16 nouveaux tests du registre. La suite couvre déduplication, clé de reprise, concurrence, ancres à la microseconde, pause, retrait réel du consentement en concurrence, rollback, limite de cohorte, migrations, rétention, export/effacement et rôles.
- Quatre scénarios Chromium (360/1440 px × FR/EN) réussis : génération de 51 candidats, pagination, perte simulée d’une réponse pourtant validée côté serveur puis reprise avec la même clé, pause/recontrôle/reprise, journal de plus de dix calculs et préférences acheteur.
- Le précontrôle SQL READ ONLY relève sur cette base synthétique 12 calculs, 51 candidats et 612 contrôles ; aucune base de production n’a été interrogée par SQL.
- Les scénarios utilisent uniquement des comptes synthétiques, sans identifiants fournisseur, avec réseau externe bloqué. Safari/iOS/PWA, charge représentative et délivrabilité réelle restent hors de cette validation.
