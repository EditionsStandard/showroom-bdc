# Qualification locale des signaux d’intérêt

État du lot : 4 novembre 2026. Préparation sur la branche de revue
`feat/buyer-engagement-foundations`. Aucun déploiement, transfert Airtable ou
email n’est inclus dans ce lot.

## Parcours disponible

Dans BUYER ENGAGEMENT, le volet **Qualification locale des signaux** montre les
signaux déjà enregistrés par la simulation Intérêt marque, par pages de 50. Il ne
crée ni signal ni opportunité à l’ouverture. Seul le propriétaire administrateur
peut accéder à ces données et enregistrer une revue.

L’administrateur examine les jours UTC observés, la fenêtre et l’éligibilité
actuelle. Il peut laisser « À examiner », qualifier localement ou écarter le
signal. Qualifier ou écarter exige un motif ; qualifier exige également une
confirmation explicite de lecture. Une qualification locale signifie une revue
humaine de ces observations, sans preuve d’intention d’achat.

Les références STORES, BUYERS, BRANDS et SEASONS sont facultatives à ce stade.
Leur format `rec…` est contrôlé, mais leur existence, leur identité, leurs liens
et leur saison restent **non vérifiés**. Aucun rapprochement automatique ni création distante n’est effectué. Un
[contrôle technique distinct en lecture seule](buyer-engagement-crm-checks.md)
peut comparer quatre références sauvegardées, via une connexion dédiée désactivée
par défaut. Ce contrôle ne certifie pas les identités. Ne pas y consigner de données sensibles ou étrangères à la revue.

Deux aperçus hypothétiques montrent les données de la **dernière revue
sauvegardée**, pour OPPORTUNITIES et SS27 Pipeline. La note humaine reste locale
et n’est pas copiée dans les aperçus. Ceux-ci utilisent une note factuelle de
navigation et les références proposées. Ils ne constituent pas des demandes
prêtes à transférer : `ready_to_transfer` reste toujours faux. Les montants,
probabilités, dates de contact, prochaines relances, commandes et résultats
commerciaux sont absents. Le statut générique reste absent, faute d’arbitrage.
Dans le seul aperçu SS27, une qualification actuelle peut afficher les valeurs
hypothétiques `To qualify` et `Online showroom` ; aucune n’est écrite dans Airtable.

Le contrat de schéma demeure daté du 3 novembre 2026. Une relecture ciblée du
4 novembre confirme les liens acheteur/boutique et les choix Status, Pipeline
Status et Source utilisés ici. Ce contrôle ne certifie pas les enregistrements,
le reste du schéma ni l’absence d’effets externes.

## Modifications et interruptions

Chaque revue conserve une version et l’empreinte des observations examinées :
comptage et bornes des jours, paramètres/version de règle, version de l’accord
facultatif, état/date de la préférence email et résultat d’éligibilité. Un nouveau
jour, une modification de règle ou un changement d’éligibilité impose une nouvelle
revue. Un recontrôle identique de simulation ne l’invalide pas. L’éligibilité reste
une photographie au moment de la lecture, et non une garantie permanente.

Les modifications concurrentes sont refusées avec conflit ; la saisie reste dans
le formulaire et doit être explicitement abandonnée pour relire la version
courante. Une actualisation conserve une saisie non enregistrée et vérifie si ses
preuves ont changé. Une lecture indisponible ou invalide efface les anciens
aperçus et bloque l’enregistrement jusqu’à une relecture explicite.

Avant une sauvegarde, le navigateur mémorise uniquement l’identifiant du signal et
une clé d’opération aléatoire. **Ni note ni références CRM ne sont placées dans
localStorage.** Si la réponse se perd, le reçu peut être relu après rechargement.
Aucun nouvel enregistrement n’est tenté automatiquement. Si aucun reçu n’est
trouvé, « Clore la tentative non confirmée » réserve la clé comme annulée et
bloque une ancienne requête retardée. Si la sauvegarde avait déjà réussi, cette
commande retourne son reçu et ne l’annule pas. Un stockage de reprise inaccessible
ou invalide bloque toute nouvelle modification, sans empêcher la lecture.

Côté serveur, revue courante, événement d’historique et reçu sont enregistrés dans
la même transaction. Une clé identique et un contenu identique renvoient le reçu
existant ; un contenu différent ou un autre signal sont refusés. Une clé de
clôture et une sauvegarde concurrentes sont sérialisées. Les opérations déjà
sauvegardées ne réécrivent pas une version ultérieure lors d’une reprise.

## Données personnelles et conservation

Les tables de revue sont `buyer_brand_reviews`,
`buyer_brand_review_events` et `buyer_brand_review_operations`. Les notes libres
peuvent contenir des données personnelles : elles figurent dans l’export acheteur
avec l’historique et les reçus. Les listes n’exposent pas les notes. L’acteur est
l’identifiant interne de l’administrateur ; pour une session propriétaire
historique sans compte personnel, le journal indique `legacy_owner` et ne prétend
pas identifier une personne.

Le retrait du suivi facultatif supprime le signal et, par cascade, sa revue, ses
versions et ses reçus. La suppression de l’acheteur ou de la marque produit aussi
cette cascade. La purge du signal après 90 jours depuis sa **création** supprime
les mêmes données ; éditer une note ne prolonge pas ce délai. L’exécution effective
de la purge reste à surveiller dans le volet Conservation des données. Les
sauvegardes de base et leur politique de conservation restent un sujet séparé.

Chaque signal est limité à 100 versions sauvegardées et 500 opérations, clôtures
comprises ; au-delà, de nouvelles modifications sont bloquées. Le détail affiche
les dix dernières versions, tandis que l’export conserve tout l’historique encore
retenu. La population reste plafonnée à 5 000 couples acheteur/marque ; un
dépassement bloque la lecture plutôt que de produire une liste présentée comme
complète.

## Ce qui manque avant un transfert

1. Choisir une seule destination et confirmer sa portée saisonnière et son statut
   initial. Le contrat conserve `target: null` et `writes_enabled: false`.
2. Vérifier chaque enregistrement CRM proposé et les relations entre entités,
   avec traitement humain des ambiguïtés et sans création/fusion implicite.
3. Rechercher les opportunités existantes et définir une clé d’intégration et un
   registre durable de transferts, avec reprise après résultat distant incertain.
4. Auditer les effets des automatisations, intégrations et notifications Airtable.
5. Concevoir le transfert comme un lot distinct, avec recontrôle immédiat des
   preuves/accords, tests isolés et validation avant toute activation.

Le parcours ne contient ni client d’écriture Airtable, ni service d’envoi, ni
bouton de transfert. Le lecteur facultatif et ses reçus sont décrits dans le
[lot de contrôles CRM](buyer-engagement-crm-checks.md). Les anciennes fonctions de l’application restent indépendantes de ce
volet ; ce lot ne prouve pas que leurs effets existants sont désactivés.

## Vérification reproductible

Les tests serveur sont dans `test/buyer-engagement-reviews.test.js` ; les essais
Chrome dans `scripts/engagement-reviews-smoke.cjs`. Ils utilisent de vraies
transactions PostgreSQL, le serveur local et des données fictives. Le serveur de
test ne reçoit pas les secrets fournisseurs et son préchargement interdit les
connexions non locales. Le navigateur bloque également les origines externes.

Ces essais ne valident pas de vrais comptes acheteurs, une identité CRM réelle,
Safari/iOS, la charge de production, une restauration de sauvegarde ni un effet
distant. Les résultats exacts du lot sont consignés dans le compte rendu de
livraison après exécution de la suite et de la CI.
