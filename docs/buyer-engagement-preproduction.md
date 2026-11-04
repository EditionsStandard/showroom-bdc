# Préparation de préproduction et validation éditoriale

Lot en cours du 4 novembre 2026. Il prépare une répétition locale de
sauvegarde/restauration et une validation du texte des modèles. Il n’ajoute aucun
expéditeur, planificateur d’envoi, jeton d’activation ou lien de désabonnement.
Les autorisations de publication et d’envoi restent distinctes.

## Validation éditoriale

BUYER ENGAGEMENT propose un volet réservé au propriétaire : **Validation
éditoriale des modèles**. Il montre les dernières versions sauvegardées, avec
leur objet et texte exacts, pour accueil, inactivité et panier, en FR/EN.
Les brouillons « intérêt marque » restent hors de ce circuit email.

Pour valider, le propriétaire doit relire la version, cocher la confirmation et
renseigner un motif. La décision conserve l’identifiant de version et une empreinte
du contenu. Elle concerne seulement le texte ; `scope='editorial_only'` et
`sending_enabled=false` ne constituent aucune autorisation d’expédition.
Les variables prises en charge restent `buyer_name` et `portal_url`. Les autres
variables, accolades incomplètes, objets multilignes et formats invalides bloquent
la validation. Les liens de sécurité futurs devront avoir leur propre lot validé.

Une nouvelle version de brouillon n’hérite jamais de la validation précédente.
L’ancien texte n’est plus admissible au contrôle éditorial courant, même si son
historique conserve une ancienne décision favorable. Une modification inattendue
du contenu invalide aussi l’empreinte. Le futur moteur devra relire la validation
dans sa transaction de contrôle, puis effectuer tous les autres contrôles d’envoi.
Ce lot ne raccorde pas la file à blanc à un fournisseur.

Les modifications concurrentes sont refusées sans écraser le motif saisi. Le
retrait prime sur une version de formulaire ancienne ; une approbation retardée
ne peut pas le remplacer avec son ancienne révision. Le retrait d’une validation
encore favorable reste possible lorsque les limites normales d’historique sont
atteintes. Ensuite, une nouvelle approbation reste bloquée à cette limite.

Une opération normale est plafonnée à 100 révisions et 200 reçus par version de
modèle. Un retrait final peut dépasser ces limites d’une opération pour ne pas
laisser un texte bloqué dans l’état validé. Les reçus connus sont rejouables sans
nouvelle décision. Le détail affiche les cinq dernières décisions de la version.

Avant une décision, le navigateur mémorise seulement une clé aléatoire et la
sélection règle/langue/version, sans motif ni texte. Après une réponse perdue,
il relit un reçu. Une tentative inconnue peut être close pour bloquer son arrivée
tardive ; clore une opération déjà enregistrée ne retire pas sa validation.
Un stockage de reprise invalide ou indisponible bloque les nouvelles décisions.
Une lecture erronée ne conserve pas un ancien état favorable à l’écran.

Les tables `buyer_engagement_template_signoffs` et
`buyer_engagement_template_signoff_operations` contiennent l’acteur, le motif,
les empreintes et les décisions. L’acteur historique sans compte personnel est
nommé `legacy_owner`, sans prétendre identifier une personne. Ne pas y consigner
d’informations acheteur ou sensibles. Ces données sont rattachées à la version
du modèle, pas au compte acheteur ; elles ne figurent pas dans son export.
La suppression d’une version autorisée par ses autres relations les supprime par
cascade. La durée de conservation de cet historique administratif reste à fixer
avant publication ; aucun effacement périodique n’est revendiqué pour ces tables.

## Répétition locale de sauvegarde/restauration

`scripts/engagement-preproduction-rehearsal.cjs` n’accepte aucune base source
existante. Il exige une connexion d’administration locale sur la base `postgres`,
crée deux bases aux noms aléatoires réservés à cet essai et les supprime à la fin.
Il n’utilise jamais une base de production comme source ni comme cible.

Le parcours exécuté est :

1. Démarrer l’application isolée, sans secrets fournisseur et avec les sorties
   réseau non locales bloquées. Tous les jobs de fond sont désactivés.
2. Créer des comptes, catalogue, commande brouillon, panier versionné, préférence
   facultative, signal, revue et validation éditoriale **fictifs**.
3. Arrêter le serveur source et calculer les empreintes de toutes ses tables,
   colonnes, contraintes et séquences.
4. Exporter avec `pg_dump` au format personnalisé, puis restaurer avec
   `pg_restore --exit-on-error --no-owner --no-acl` dans la nouvelle base vide.
5. Comparer toutes les lignes, séquences, colonnes et contraintes ; démarrer
   ensuite l’application restaurée et vérifier les accès, revues, validation et
   refus d’expédition. Tester une cascade de suppression dans une transaction
   annulée.
6. Supprimer uniquement les bases créées par cette exécution et l’archive fictive.
   Produire un rapport agrégé, sans identifiants de connexion ni données de contact.
   Un nouvel essai remplace immédiatement le statut du rapport courant par
   `running` ; un échec est enregistré comme tel au lieu de laisser apparaître
   un ancien succès. Chaque exécution conserve aussi son rapport distinct.

L’archive temporaire est dans un dossier privé ; elle est supprimée après l’essai.
Son empreinte dans le rapport prouve quel fichier a servi à l’essai, pas qu’une
sauvegarde durable reste disponible. Le script ne sauvegarde ni rôles globaux,
permissions ACL, fichiers téléversés, secrets ou services externes.

Exemple de configuration locale, sans identifiants réels :

```sh
TEST_PG_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:55439/postgres \
ENGAGEMENT_PG_TOOLS_DIR=/chemin/vers/outils-postgresql/bin \
ENGAGEMENT_REHEARSAL_REPORT_DIR=/chemin/vers/rapport-local \
node scripts/engagement-preproduction-rehearsal.cjs
```

Les outils `pg_dump`/`pg_restore` doivent être compatibles avec le serveur testé.
Leur présence est contrôlée avant de créer les bases. La préparation locale a
compilé ces outils PostgreSQL 18.6 à partir des sources officielles dont l’empreinte
SHA256 a été vérifiée. Les dépendances et binaires de production restent inchangés.
Voir les documentations officielles [sources](https://www.postgresql.org/docs/18/install-getsource.html),
[compilation](https://www.postgresql.org/docs/18/install-make.html) et
[pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html).

## Ce qui reste nécessaire avant publication

Une réussite sur données fictives ne valide pas une sauvegarde de production.
Il faut toujours obtenir une sauvegarde récente, vérifier sa restauration dans
un environnement autorisé isolé, comparer les volumes réels, mesurer les migrations
et préparer un retour arrière conservant les préférences et protections d’accès.
Aucun environnement Railway ni déploiement n’est créé par ce script.

Il reste également à valider les textes réels, la politique de conservation et les
parcours Safari/iOS/PWA, puis à développer le moteur d’envoi avec limites de
contact, désabonnement, réservation, idempotence fournisseur, reprise après
résultat incertain, webhooks authentifiés et arrêt global. Un premier pilote devra
avoir des destinataires et contenus explicitement approuvés.

La dernière validation complète antérieure à ce lot est celle du commit `91e1636` :
248 tests réussis. Les résultats du présent lot doivent être rapportés séparément,
sans les déduire des vérifications antérieures.


## Résultat de la répétition locale

La répétition `ac176bced34e521b` a réussi sur PostgreSQL 18.6 avec des données
entièrement fictives : 73 tables comparées, dont 28 non vides ; égalité des lignes,
séquences, colonnes et contraintes. Les dix contrôles sont réussis, dont les accès
administrateur restaurés, le refus anonyme, la revue conservée et le maintien de
`delivery_enabled=false`. Les deux bases et l’archive temporaires ont été
supprimées à la fin. Le rapport indique explicitement
`production_backup_verified=false`. Les durées de cet essai ne prédisent pas
celles d’une migration ou restauration de production.

Les quatre configurations Chrome du nouveau volet (FR/EN, 360/1440 pixels) et
les quatre configurations de régression BUYER ENGAGEMENT ont réussi. Aucun email
ni accès fournisseur réel n’a été effectué par ces essais.

La suite locale finale passe 267 tests avec quatre processus simultanés. Le premier
lancement fortement parallèle, en même temps que les navigateurs, avait dépassé
le délai de démarrage de plusieurs serveurs de validation ; il n’est pas présenté
comme réussi. La reprise bornée couvre la suite entière sans échec. Cette preuve
ne remplace ni la CI du commit exact ni un essai de charge représentatif.
