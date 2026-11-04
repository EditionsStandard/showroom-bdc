# BUYER ENGAGEMENT — file durable de préparation, expédition verrouillée

Ce troisième lot prolonge le registre de simulation du commit `142daef`. Il ajoute une vraie persistance des tâches de préparation, des réservations et des résultats. Le traitement est une répétition locale de contrôle de brouillon : **aucun email n’est expédié**, aucun fournisseur n’est appelé et aucun lien d’activation ou de désabonnement n’est généré.

## Protections et périmètre

- Le mode SQL est limité à `dry_run` ; `delivery_enabled=true` est interdit par contrainte. Aucun statut `sent`, aucun adaptateur SMTP/Resend/HTTP, aucun paramètre d’environnement n’active l’expédition.
- Le traitement commence en pause. Reprendre les tests permet uniquement leur exécution manuelle par lots de dix maximum. Aucun cron de traitement supplémentaire n’est lancé ; seul le nettoyage utilise la tâche existante.
- Seules les règles accueil et inactivité sont acceptées, avec périmètre `buyer`. Les paniers et intérêts marque restent exclus jusque dans la contrainte SQL. Une future tâche panier devra inclure son périmètre **marque** dans son identité ; il ne faudra pas la glisser dans la clé actuelle.
- La pause de cette file ne contrôle pas les emails transactionnels ni les anciennes relances à validation humaine du portail. La pause des simulations empêche aussi le traitement de leurs préparations ; les réservations sont alors libérées sans consommer un essai.

## Préparation des tâches

L’owner choisit « Préparer les candidats ». Le serveur ne copie pas aveuglément la liste enregistrée : il relit les règles, modèles, dates, accord marketing et ancre exacte de chaque candidat. Une version périmée est écartée ; il faut recontrôler les candidats dans le registre avant de préparer à nouveau.

La préparation ne traite qu’une cohorte complète de 1 000 candidats maximum. Au-delà, elle est refusée sans écriture partielle. Règles, acheteurs, préférences et tâches sont coordonnés par transactions et verrous. L’attente de verrou est bornée à trois secondes et chaque requête SQL à vingt secondes ; cela ne certifie pas une durée HTTP ou une charge de production.

Une clé UUID de requête permet de récupérer le même résultat après réponse perdue. Deux clés distinctes ne dupliquent pas une tâche portant sur le même acheteur, la même règle et la même ancre exacte PostgreSQL. Les versions de règle/modèle et l’état d’activation sont mémorisés sans texte d’email rendu ni copie des coordonnées.

Une tâche déjà terminée, annulée ou en échec n’est pas recréée automatiquement pour le même épisode. Il n’existe pas de bouton pour forcer sa réouverture dans ce lot. Une annulation après changement de modèle doit être examinée ; elle ne doit pas déclencher un nouvel essai automatique masqué.

## Réservations, reprise et recontrôle

Le serveur réserve les tâches disponibles avec `FOR UPDATE SKIP LOCKED`. Deux traitements concurrents peuvent réserver des tâches différentes ; ils ne possèdent pas simultanément la même réservation. Chaque réservation dure soixante secondes et porte une identité interne renouvelée à la reprise. Une ancienne réservation ne peut plus valider le résultat à la place d’une nouvelle.

Le traitement relit l’identité de l’acheteur et de la règle depuis la tâche persistée, puis vérifie de nouveau :

- accord marketing, historique exploitable et état d’activation ;
- première/dernière connexion, activité et présence ;
- règle active en simulation, délai et version ;
- modèle et langue courants, ancre d’épisode inchangée.

Une donnée incompatible annule la préparation. Sinon, le contrôle local valide uniquement les variables du brouillon (`buyer_name`, `portal_url`) ; il ne prouve ni la qualité commerciale du message, ni sa réception, ni la validité de futurs liens.

Les états sont `pending`, `reserved`, `simulated`, `cancelled`, `failed`. Le résultat `simulated` signifie « contrôle local terminé », jamais « email envoyé ».

Une interruption après réservation laisse la tâche réservée jusqu’à expiration, puis reprenable. Trois réservations au maximum sont accordées. Une erreur transitoire contrôlée reporte la disponibilité de soixante puis cent vingt secondes ; il faut toujours lancer un nouveau lot manuellement. Après le troisième essai ou trois réservations expirées, l’échec devient terminal. Les expirations terminalisées sont incluses dans le bilan d’échec du lot, même lorsqu’aucune nouvelle tâche n’a été réservée.

Le POST de traitement d’un lot n’est pas idempotent à l’échelle HTTP : après réponse perdue, un autre appel peut traiter le lot suivant. L’interface n’effectue donc aucun nouvel essai automatique ; elle recharge la file et demande d’examiner les états. Les tâches déjà simulées ne sont pas sélectionnées à nouveau.

## Traçabilité et données

Chaque tâche conserve les événements normalisés de préparation, réservation, reprise, libération, résultat et échec. Aucun message d’exception libre, nom, adresse email ou corps rendu n’est copié dans ces tables. Les coordonnées affichées sont jointes depuis le compte courant. L’identité interne de réservation n’est exposée ni dans le GET admin ni dans les exports acheteur.

Les tâches et événements sont supprimés après quatre-vingt-dix jours depuis la création, sans prolongation par les recalculs. Une réservation encore valide est conservée jusqu’à expiration ; aucune tâche trop ancienne n’est réclamée à nouveau. Les opérations de préparation agrégées sont conservées 365 jours. La purge intervient à la préparation et dans le nettoyage existant toutes les six heures, avec les limites d’un service arrêté. Ces durées restent à valider avec la politique de conservation avant publication.

Les deux exports RGPD incluent les tâches/événements du seul acheteur connecté ; leur effacement suit la suppression du compte par cascade. Les relations vers les candidats du registre deviennent nulles si ces candidats sont purgés. Les compteurs agrégés des opérations ne contiennent pas d’identité acheteur.

## Conditions d’un futur transport réel

Ce module ne doit pas être transformé en expéditeur en remplaçant simplement son contrôle local : ce contrôle s’exécute sous verrous de données. Un appel fournisseur externe exigerait une autre frontière transactionnelle, un mécanisme d’idempotence fournisseur, des réponses ambiguës traitées sans renvoi aveugle, des webhooks authentifiés, le désabonnement, les plafonds, les textes approuvés et un arrêt global réel. Aucun de ces éléments n’est revendiqué comme livré ici.

Les anciens envois et la règle d’inactivité à 45 jours restent des mécanismes distincts. La préparation du nouvel inactif à trente jours n’autorise pas leur fonctionnement en parallèle comme deux expéditeurs.


## Validation du troisième lot

105 tests locaux réussis sur PostgreSQL 18.6 et Node 24.16.0, dont 22 nouveaux tests de préparation : contraintes dry-run, absence de copies de coordonnées, idempotence, pauses, réservations concurrentes, reprise après expiration, rejet d’un ancien propriétaire, délais et plafond d’essais, recontrôle des sources, annulation des modèles périmés, bilan d’échec, rollback, migration, export/effacement, rétention et rôles.

Quatre scénarios Chromium réussis (360/1440 px × FR/EN) : file de 51 tâches paginée 50+1, préparation dont la réponse est perdue après commit puis reprise avec la même clé, traitement manuel de dix tâches, deuxième lot dont la réponse est perdue sans nouvel essai automatique, état rechargé affichant vingt tests réussis, pause finale. Le registre de simulation et les préférences acheteur restent couverts par ces scénarios.

Le relevé READ ONLY sur la base synthétique finale montre 31 tâches en attente, 20 simulées, traitement en pause et `delivery_enabled=false`. Aucun fournisseur ou compte réel n’est utilisé. La version de production, les sauvegardes, Safari/iOS/PWA et la charge réelle ne sont pas validés par ces tests locaux.


## Protocole de transport distinct

Le [lot de file verrouillée](buyer-engagement-outbox.md) peut prendre une
préparation à blanc terminée et un texte validé pour conserver une intention.
Il ne remplace pas ce contrôle local par un appel réseau sous verrou : sa
frontière de soumission, ses réservations, contenus immuables et réponses
incertaines sont distincts. Ses essais utilisent uniquement un fournisseur fictif
et des destinataires réservés à la validation. Aucun envoi réel n’est raccordé.
