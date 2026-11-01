# BUYER ENGAGEMENT — premier lot, simulation uniquement

État du premier lot, 1 novembre 2026. Le registre durable ajouté au deuxième lot est décrit dans [buyer-engagement-simulation-ledger.md](buyer-engagement-simulation-ledger.md) ; les mentions ci-dessous de calcul sans écriture décrivent le GET d’aperçu et le premier lot. Base : `61d82e620ad568480903a60b24d99616d42c7420` (PR #284). Ce lot reprend les corrections de formulaires, commandes et permissions agents livrées depuis l’audit du 8 octobre. Il ne constitue pas un déploiement ni une autorisation d’envoyer des campagnes.

## Livré dans ce lot

- Migrations additives et transactionnelles : provenance de création, approbation observée, activation, première et dernière connexion observées, dernière action métier, dernier email de relance d’inactivité. Aucun historique reconstruit depuis `last_seen_at`.
- Préférences email centralisées, choix explicite dans Mon profil, preuve horodatée et version du texte de choix. Export dans les deux routes RGPD et suppression en cascade avec le compte.
- BUYER ENGAGEMENT accessible uniquement à l’owner : quatre règles, seuils en heures, brouillons FR/EN versionnés, aperçu texte, liste paginée des acheteurs et motif d’inclusion/exclusion. Les mises à jour concurrentes sont rejetées (409).
- Modes autorisés par le serveur **et** la base : `disabled`, `simulation`. Toutes les règles sont désactivées à la création. Le module de simulation ne contient aucun appel fournisseur, ne crée ni candidat persistant, ni job, ni token, ni ligne `pending_reminders`.
- Création d’un acheteur en admin : mot de passe aléatoire inaccessible et activation par lien haché à usage unique (60 minutes), réutilisant le parcours d’approbation. L’interface distingue email accepté par le fournisseur et lien à transmettre en cas d’absence/échec du fournisseur. L’acceptation fournisseur ne prouve pas la réception.
- Les invitations publiques de marque renvoient vers la demande d’accès soumise à approbation. Le POST historique ne crée plus de compte/session.
- Liens d’accès : activation préalable, consommation atomique et respect du MFA. Dates de connexion après sauvegarde de session, y compris MFA, sélection agent et accès historique identifié.
- Une relance d’inactivité ne modifie plus la présence acheteur ; elle utilise un champ de contact distinct. Les relances marketing manuelles et l’ancienne file d’inactivité contrôlent l’accord centralisé. L’ancienne règle reste à 45 jours et conserve sa validation humaine ; elle n’est pas remplacée par le réglage de simulation à 30 jours.
- Purge des demandes `pending` **et** `rejected` de plus de 30 jours au démarrage puis dans la tâche existante toutes les 6 heures. Cela ne garantit pas une suppression à la seconde près ni pendant un arrêt prolongé du service.

Sources : `lib/buyer-engagement-migration.js`, `lib/buyer-engagement.js`, intégrations dans `server.js`, `public/buyer-engagement-admin.js` et `public/buyer-email-preferences.js`.

## Définitions et limites à préserver

| Donnée | Interprétation exacte |
|---|---|
| `login_history_known=false` | Historique depuis création non garanti. Une connexion observée aujourd’hui ne reconstitue pas le passé. Exclu des deux simulations. |
| `first_login_at` | Première connexion **observée par cette version** ; première connexion réelle seulement si historique complet. |
| `approved_at` | Approbation effectuée dans cette version ; les anciennes dates restent inconnues. |
| `activated_at` | Choix du mot de passe lors de l’activation ; distinct de la connexion. |
| `last_meaningful_activity_at` | Connexion complète, changement d’un panier non vide ou commande acheteur acceptée. Pas toutes les consultations. |
| `last_seen_at` | Présence historique conservée pour compatibilité. Une présence récente exclut un candidat inactif ; elle ne prouve jamais son inactivité. |
| `last_engagement_email_at` | Acceptation fournisseur de l’ancienne relance d’inactivité, pas une activité acheteur. |
| Préférence absente / `unknown` | Aucune autorisation marketing déduite. Aucun transfert automatique des anciennes demandes. |
| `access-request:version-unrecorded` | Le formulaire source ne stockait pas sa version : cette absence est conservée explicitement, aucune version historique inventée. |

Les deux simulations nécessitent un accord marketing enregistré. C’est un filtre conservateur pour des **rappels** : il ne conditionne pas l’email initial strictement nécessaire à l’approbation/activation du compte.

Les nouvelles approbations copient le choix de la demande seulement si une préférence n’existe pas déjà. Une réapprobation ne rétablit jamais un accord retiré. Les comptes historiques seront donc très largement exclus au démarrage. Cela est attendu ; ne pas interpréter ces exclusions comme un refus exprimé.

La confirmation d’une sélection créée par un agent peut toujours créer un compte via son parcours existant. Sa provenance est `agent_selection`, sans inventer une approbation owner. Cette exception commerciale reste à arbitrer avant de prétendre que toute création passe par la file des demandes d’accès. Les invitations entre collègues ne créent pas de compte portail et conservent leurs règles existantes.

Si l’enregistrement d’une observation de connexion échoue, l’accès au portail est préservé et une erreur est journalisée. Le moteur est donc limité à la simulation : une garantie plus forte de complétude sera nécessaire avant les envois automatiques. Aucun suivi nominatif des vues de marque/produit, pixel, score commercial ou événement de navigation détaillé n’est ajouté.

Le panier conserve son format actuel ; aucun état « converti » n’est inventé. Les synchronisations JSON identiques (y compris l’ordre des clés) ne modifient plus sa date. Une synchronisation vide ne compte pas comme action métier. Le checkout garde sa logique par marque, ses validations serveur, minimums, prix, stocks, signatures et CGV.

## Résultats vérifiés localement

- 67/67 tests réussis sur PostgreSQL 18.6 et Node 24.16.0 : suite existante, 14 nouveaux tests, concurrence, MFA, permissions et migrations.
- BUYER ENGAGEMENT et préférences : quatre scénarios Chromium réussis (360/1440 px × FR/EN), avec pagination réelle, sauvegarde des règles/modèles et retrait du choix marketing.
- Formulaires existants : quatre scénarios Chromium réussis, incluant conservation des adresses, pays, invitations de collègues et reprise d’un checkout multimarque partiellement refusé.
- Précontrôle READ ONLY exécuté sur une base synthétique uniquement.
- Service worker désactivé dans les scénarios du nouvel écran pour isoler l’interface des rechargements automatiques ; fonctionnement PWA non certifié.
- Configuration Railway lue le 1 novembre : production attachée à `main`, déploiement courant `9f7dfc33-3e04-43ee-8c29-46cad0990c30`, aucune modification en attente et aucun environnement de préproduction listé. Aucune mutation Railway effectuée.

## Ce qui reste à développer

- File durable des envois, réservation atomique, clés d’idempotence, recontrôle au dernier moment, reprise après panne, webhooks fournisseur, désabonnement depuis les emails, plafonds et arrêt global. Les anciens mécanismes de relance ne deviennent pas un moteur fiable grâce à cette interface.
- Rappels d’activation : renouvellement du lien au moment d’un envoi effectivement autorisé, distinction activation/non-connexion, cadence validée et brouillons éditoriaux approuvés.
- Inactivité 30 jours : définition complète de l’activité utile, couverture vérifiée, remplacement contrôlé de l’ancien 45 jours. Ne pas lancer les deux planificateurs ensemble.
- Panier 48 heures : version, conversion serveur et suivi par marque ; aucune détection fiable livrée ici.
- Intérêt marque : finalité et information acheteur validées, instrumentation, critères explicables, qualification humaine et mapping Airtable ; aucun nouvel enregistrement CRM.
- Statistiques d’envoi, délivrabilité, reprise et conversion avec dénominateurs et fenêtres d’attribution. Les chiffres de la page actuelle portent sur la pagination, pas sur une campagne ni un effet commercial.
- Durées et politique de conservation des preuves de préférences à valider avant publication. Les preuves actuelles restent associées au compte et sont effacées avec lui ; aucune conformité juridique générale n’est affirmée.

## Validation et exploitation

La suite d’intégration utilise PostgreSQL local, sans secrets fournisseur hérités. Le serveur enfant charge `test/no-outbound.js` et désactive les tâches de fond ; les connexions sortantes externes sont bloquées. Le helper refuse une base de test hors loopback et contrôle les noms des bases.

```sh
TEST_PG_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres npm test
```

La CI existante couvre PostgreSQL 16 et Node 22. La validation locale couvre PostgreSQL 18 et Node 24 ; les résultats CI doivent être contrôlés sur le commit proposé, pas déduits des résultats locaux. La matrice CI 16/18 a été préparée, mais n’est pas incluse : GitHub refuse une modification de workflow avec le jeton disponible (scope workflow absent). Aucun élargissement de droits n’a été demandé.

`scripts/buyer-engagement-smoke.cjs` vérifie la vraie application sur une base synthétique, les règles, pagination, modèles et préférences FR/EN à 360 et 1440 px. Les requêtes navigateur hors serveur de test sont bloquées. Les scripts existants de formulaires restent utilisables et incluent le nouveau fichier de préférences.

Le script `scripts/check-engagement-readonly.cjs` réalise un relevé SQL **agrégé**, dans une transaction READ ONLY, sans importer le serveur ou lancer de migration. Il requiert `ENGAGEMENT_AUDIT_DATABASE_URL`, idéalement un utilisateur SQL en lecture seule. Il n’affiche ni URL de connexion ni email acheteur. Sa présence ne signifie pas que la base de production a été auditée par SQL.

Avant toute publication :

1. Comparer le commit proposé à la version réellement déployée, vérifier les checks CI et les changements concurrents.
2. Contrôler le schéma/volumes réels en lecture seule ; mesurer la durée des verrous de migration sur une copie représentative. Le rollback DDL est testé sur une base synthétique, pas à charge réelle.
3. Vérifier une sauvegarde PostgreSQL exploitable et sa restauration dans un environnement isolé. Une exportation CSV n’est pas une preuve de restauration complète.
4. Préparer une préproduction sans identifiants email/CRM/paiement réels et avec `BACKGROUND_JOBS_ENABLED=false`. Cette variable désactive les anciens jobs, **pas** les envois transactionnels déclenchés par les routes : retirer les clés et bloquer la sortie réseau reste nécessaire.
5. Contrôler MFA, rôles, activation, compte historique, revalidation, commandes, préférences et liens expirés. Vérifier Safari/iOS et PWA/cache séparément ; les tests Chromium ne les couvrent pas.
6. Valider les textes et la conservation des préférences, les restrictions des relances historiques et le changement du parcours d’invitation publique. Les modèles du simulateur sont des brouillons de travail, jamais des emails prêts à envoyer.
7. Obtenir l’accord de publication. Aucun merge/déploiement ni envoi réel n’est inclus dans ce lot.

Retour arrière : les colonnes et tables nouvelles peuvent rester en place. Éviter de revenir aveuglément à l’ancien serveur : il ignorera les retraits de consentement et rétablira les anciens parcours d’accès. Préférer un correctif qui masque uniquement l’interface et conserve les protections, ou un retour préparé avec les relances bloquées et les clés email retirées. Ne pas supprimer les données de préférences pour annuler une version.
