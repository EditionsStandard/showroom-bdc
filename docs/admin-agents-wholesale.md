# Administration, agents et commissions wholesale

## Périmètre

Les 14 liens existants sont conservés et regroupés en Pilotage, Ventes, Clients,
Catalogue et Administration. Commissions wholesale ajoute un quinzième écran.
Les identifiants, badges et historique du navigateur sont conservés. Sur mobile,
chaque rubrique ouvre ses liens au-dessus de la barre de navigation.

L’owner garde la vue globale et gère tous les comptes et affectations. Un sous-agent
est un compte agent avec un référent, sans pouvoir administratif supplémentaire.
L’owner seul valide les affectations. La hiérarchie est limitée à deux niveaux,
sans cycle, et les affectations du sous-agent doivent être incluses dans celles de
son référent. Une réduction incompatible est refusée, sans suppression automatique.

## Droits et reprise

Chaque droit est un couple marque + pays ISO alpha-2. `*` signifie explicitement
tous pays, y compris les pays manquants. Sans affectation, un agent n’a accès à
aucune donnée commerciale. Aucun droit historique n’est déduit ni recopié.
La création de sélection par un agent exige un client existant dont le pays ISO
a été qualifié par l’owner ; le pays saisi ne peut pas remplacer celui du compte.
Les codes inconnus ou pays en toutes lettres restent inchangés et exclus des droits
limités à un pays. Ils nécessitent une vérification humaine avant normalisation.

Les API agents passent par une frontière centrale : listes filtrées en SQL, puis
contrôles par identifiant pour les commandes/PDF/historiques et sélections.
Les routes non auditées pour le partage entre marques restent réservées à l’owner,
notamment exports globaux, modification des comptes clients, profils clients
transversaux, recherche globale, analytics transversaux et modifications catalogue.
L’agent a un tableau de bord limité à ses commandes et marques et lit ses propres
commissions validées. Il ne voit pas celles de son référent ni de ses sous-agents.
Les notifications push commerciales agents sont suspendues tant que leur filtrage
par territoire n’est pas audité ; les notifications owner/designer sont conservées.

Le rôle et l’état MFA des comptes staff sont relus avant autorisation. Les droits
ne reposent pas sur les seules valeurs mémorisées dans les sessions.

Cas métier fourni : Vous Décidez possède un agent Royaume-Uni et un agent
Scandinavie. Aucun compte, email ou droit réel n’a été créé. L’owner doit créer et
valider ces comptes. « Scandinavie » doit être traduit en pays explicitement
sélectionnés ; aucune liste de pays n’est supposée à partir de ce mot.

## Commissions

Trois flux séparés : créance agence, rémunération agent, rémunération sous-agent.
L’owner saisit marque, pays, devise, assiette nette HT, montant d’assiette, taux et
référence justificative. La commande liée est facultative ; si fournie, marque et
pays ISO doivent correspondre. Le bénéficiaire doit avoir l’affectation pertinente.
Aucun taux, facture ou encaissement n’est déduit des commandes. Aucun montant réel
n’est prérempli. Le calcul utilise NUMERIC PostgreSQL et un arrondi à deux décimales.
Pas d’addition de devises ou de compensation automatique entre les trois flux.

États : brouillon → validée → facturée → réglée ; annulation possible avant le
paiement. Une transition exige une référence et la version courante. Les montants
ne sont pas réécrits après création : annuler puis recréer un brouillon documenté
pour corriger. Les transitions sont verrouillées et historisées dans la même
transaction. « Réglée » est une déclaration manuelle justifiée, pas une vérification
bancaire. Facturation, paiement, avoirs et virements ne sont pas exécutés par l’outil.

## Migration et déploiement

La migration ajoute des tables et des colonnes avec une transaction et un verrou
consultatif ; elle ne modifie aucun montant, pays, commande ou droit historique.
Les relations commerciales empêchent la suppression physique d’un bénéficiaire,
d’une marque ou d’une commande référencée. Les erreurs de migration sont fatales au
démarrage. Les tests vérifient sa réexécution sans perte des données d’origine.

Avant fusion/déploiement :

1. CI verte pour le SHA exact, syntaxe et tests complets sur PostgreSQL isolé.
2. Vérifier une sauvegarde/restauration disponible ; relever le déploiement Railway
   courant. Ne pas exporter ni modifier de données réelles dans les tests.
3. Exécuter `node scripts/check-agent-rollout.js` dans l’environnement cible. Ce
   contrôle est en lecture seule. S’il signale des agents sans affectation, ne pas
   basculer leur accès sans validation owner d’un plan de reprise. Des nouveaux
   comptes peuvent rester sans accès pendant leur préparation par l’owner.
4. Préparer la migration additive et les affectations validées avant la bascule
   des agents existants. Le schéma et les affectations ne sont pas devinés par CI.
5. Railway a été observé le 30/10/2026 avec `main` et `checkSuites:false` : une fusion
   peut déclencher le déploiement immédiatement. Ne pas fusionner pour « tester »
   la production. Activer/valider la barrière CI Railway avant la mise en ligne.
6. Vérifier ensuite login/MFA, owner, agent, sous-agent, refus croisés, PDF,
   navigation ordinateur/mobile, absence de commissions fictives et état Railway.

Retour arrière : conserver le schéma et les écritures, revenir au build précédent
si nécessaire. Attention : revenir à l’ancienne politique agents rétablit ses droits
historiques plus larges ; éviter ce retour sans mesure compensatoire de révocation
des sessions/comptes concernés. Ne jamais supprimer les tables de commissions.
