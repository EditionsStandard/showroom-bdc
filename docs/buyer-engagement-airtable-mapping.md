# Préparation du raccordement BUYER ENGAGEMENT à Airtable

Relevé du 3 novembre 2026, en lecture seule via le connecteur Airtable. Base
[Editions Standard CRM](https://airtable.com/appquOEohNkpH6sbB), identifiant
`appquOEohNkpH6sbB`. Le schéma observé comprend 27 tables et 525 champs. Les
identifiants utiles, types, cibles des liens et choix de statuts sont consignés dans
[buyer-engagement-airtable-contract.json](buyer-engagement-airtable-contract.json).
Ce contrat est une proposition : `target: null`, `writes_enabled: false`.
Aucun enregistrement, champ, table ou automatisation Airtable n'a été modifié.

## Deux destinations existantes à arbitrer

| Destination | Éléments vérifiés | Conséquence pour le raccordement |
|---|---|---|
| [OPPORTUNITIES](https://airtable.com/appquOEohNkpH6sbB/tblYjgiiFnoJUJEXs) | Liens boutique, acheteur, marque et saison ; `Status` commence à `Prospect` ; champ `Notes` | Table sans saison dans son nom, adaptée à une architecture multisaison. Pas de statut `To qualify` ni champ `Source` dédié dans le schéma observé. |
| [SS27 Pipeline - All Brands](https://airtable.com/appquOEohNkpH6sbB/tblqshM9RQ08paOhb) | Liens boutique, acheteur, marque et saison ; `Pipeline Status` propose `To qualify` ; `Source` propose `Online showroom` ; notes internes et prochaine action | Le vocabulaire convient à un signal à qualifier, mais la portée SS27 doit être confirmée. Le nom ne prouve pas la saison à affecter à un signal actuel. |

Proposition technique : retenir **une seule destination**. Pour un fonctionnement
multisaison pérenne, privilégier la table générique si elle est bien le référentiel
commercial voulu. Pour un pilote strictement SS27, le pipeline possède déjà les
libellés utiles. Ce choix reste à valider ; aucune synchronisation parallèle vers
les deux tables n'est proposée. Le relevé ne prouve pas que des doublons existent
déjà entre elles.

## Correspondances observées et limites

Les deux tables pointent vers les mêmes entités :

| Entité | Table vérifiée | Champs utiles |
|---|---|---|
| Boutique | `STORES` / `tblQCsZU8DeokGygm` | `Store Name` / `fldiiGOlzIQNvdGTh`, `Email` / `fldbGIrhVTpvBBnZk` |
| Acheteur | `BUYERS` / `tblTlluS8iIOPpGKG` | `Buyer Name` / `fldnwoMdkIjxowdSc`, `Email` / `fldSyLLXo4LcrLTNI`, lien `Store` / `fldrjxIVyP0nmUAMF` |
| Marque | `BRANDS` / `tblOD4jzbfiBtfZNG` | `Brand Name` / `fldbh3fo1OQqgsrrE` |
| Saison | `SEASONS` / `tblbThkyyXvCoafxS` | `Season Name` / `fldqe9PHp7GZcpCFV` |

Les liens acheteur/boutique acceptent plusieurs enregistrements. Un email identique
ou un nom ressemblant ne suffit donc pas à confirmer l'identité professionnelle
ou la bonne boutique. Aucun échantillon de contacts n'a été téléchargé dans ce
lot : **aucune correspondance individuelle B2B/CRM n'est déclarée vérifiée**.

L'application possède déjà des appels Airtable dans [server.js](../server.js) :
création de prospects lors des demandes d'accès, commandes et mise à jour de
`Last Contact` lors de certaines actions. Les recherches existantes prennent le
premier `STORES` trouvé par email (`maxRecords=1`) ; elles ne démontrent pas
l'unicité du rapprochement. La synchronisation des commandes contient aussi un
identifiant de saison fixe. Ces comportements restent inchangés dans ce lot et
ne servent pas de preuve pour les nouveaux signaux.

Le futur raccordement devra conserver des liens explicites et revus entre les
identifiants locaux et les identifiants Airtable : acheteur, boutique retenue,
marque et saison. Les champs absents, plusieurs correspondances, liens boutique
incohérents et saisons non vérifiées doivent bloquer le transfert. Aucune création
automatique de boutique, contact, marque ou fusion n'est incluse.

## Déduplication avant toute écriture

Aucun champ dédié de type « B2B Signal ID » ou clé d'intégration n'a été observé
dans les deux schémas d'opportunités. Une clé dans le seul titre ou les notes ne
constitue pas une contrainte d'unicité fiable.

Un lot ultérieur devra prévoir :

1. Une clé durable pour l'épisode source et la saison effectivement validée,
   ainsi qu'un registre local unique des transferts. Un candidat actuel est
   propre à un acheteur et une marque, mais n'attribue pas une saison commerciale.
2. Une recherche paginée de correspondances et d'opportunités existantes dans les
   deux tables avant le premier transfert, pour repérer une opportunité déjà
   ouverte sur le même périmètre. Une opportunité clôturée exige un arbitrage
   humain ; elle ne doit pas être rouverte ou remplacée implicitement.
3. Un champ d'intégration dédié dans la seule cible retenue, après validation de
   cette modification de schéma. Un champ texte Airtable ne garantit pas à lui
   seul l'unicité : réservation locale et recontrôle distant restent nécessaires.
4. Une reprise explicite après résultat réseau incertain : chercher la clé et
   distinguer zéro, une ou plusieurs correspondances. Ne pas réémettre aveuglément
   un POST dont le résultat reste inconnu.
5. Un recontrôle des accords, de l'éligibilité actuelle et de la version de preuve
   immédiatement avant la préparation d'un transfert approuvé. Les retraits et
   données expirées ne doivent pas rester transférables depuis un ancien calcul.

## Contenu minimal d'une proposition humaine

Après vérification des liens et choix de la destination, un aperçu pourra proposer
le nom, les liens et une note factuelle : nombre de jours observés, fenêtre du
calcul, identifiant source et mention « signal de navigation à qualifier ».
Dans le pipeline SS27 validé, `To qualify` et `Online showroom` sont des choix
existants ; ils ne sont pas appliqués dans ce lot. Dans la table générique, le
statut initial et la manière de distinguer un signal non qualifié restent à fixer.

Les champs suivants doivent rester non renseignés sans preuve distincte : valeur
estimée, probabilités humaines ou ML, commission, retour qualitatif acheteur,
dernière prise de contact, prochaine relance, sélection/commande effectuée,
résultat final et valeur réelle de commande. Une consultation n'établit aucun de
ces faits. Une valeur inconnue ne doit pas être remplacée par zéro.

## Automatismes et effets à vérifier

Le connecteur a listé six automatisations : trois marquées `deployed` et trois
`undeployed`. Les configurations retournées comportent des actions email sur les
demandes de rendez-vous et de contact web, ainsi qu'un brouillon lié aux créations
de boutiques. Aucune des six entrées listées ne déclare un déclencheur direct sur
`OPPORTUNITIES` ou `SS27 Pipeline - All Brands`.

Ce relevé de métadonnées n'est pas une preuve d'absence d'effets externes. Les
consommateurs hors de cette liste, intégrations tierces, liens réciproques et
changements futurs devront être contrôlés avant une écriture. Aucun webhook n'a
été testé et aucune automatisation n'a été activée ou exécutée ici.

## Ordre recommandé

1. Fixer la table cible et la saison commerciale ; conserver le contrat bloqué
   jusqu'à cette décision.
2. Vérifier un petit échantillon de liens individuels avec l'équipe commerciale,
   sans rapprochement automatique ni modification des fiches existantes.
3. Valider les informations transmises, leur conservation dans Airtable, le
   traitement des retraits et la distinction entre signal non qualifié et véritable
   opportunité commerciale. La suppression locale ne supprimera pas par elle-même
   une future copie externe.
4. Préparer le registre local, le champ d'intégration proposé et un aperçu des
   changements exacts. Tester les doublons, reprises et retraits sur des données
   fictives sans secrets fournisseur.
5. Obtenir l'autorisation du pilote concret avant sa première écriture externe,
   puis relire chaque enregistrement créé et vérifier l'absence d'effets induits.

La [purge surveillée](buyer-engagement-retention.md) est développée séparément et
n'autorise aucun transfert CRM ni envoi commercial.
