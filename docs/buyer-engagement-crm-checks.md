# Contrôles CRM en lecture seule

Lot de préparation du 4 novembre 2026, sur `feat/buyer-engagement-foundations`.
Il ajoute un lecteur facultatif, une surveillance locale de ses opérations et
leur présentation dans la revue des signaux. Aucun transfert, déploiement ou
paramétrage de la connexion réelle n’est inclus.

## Ce que le contrôle établit

Depuis une revue sauvegardée, actuelle et encore éligible, le propriétaire peut
contrôler les quatre références proposées : STORES, BUYERS, BRANDS et SEASONS.
Les références sont prises dans la version sauvegardée, jamais depuis des champs
non enregistrés du navigateur. Elles doivent toutes être présentes.

Le lecteur relit d’abord les types des champs attendus et la cible du lien
BUYERS.Store. Il demande ensuite exactement les quatre identifiants, dans leurs
tables respectives, avec uniquement les champs nécessaires. Cela représente au
plus cinq requêtes GET : un schéma puis quatre sélections de fiches. Aucun POST,
PATCH, PUT, DELETE, création, fusion ou déclenchement d’email n’existe dans ce
transport. L’origine et la base sont fixes ; les redirections sont refusées.

Les résultats distinguent :

- Référence retrouvée ou non dans la lecture autorisée ; nom renseigné ou non.
- Présence de la boutique proposée dans les liens Store de l’acheteur.
- Égalité de l’email boutique/acheteur avec l’email du compte B2B et du nom de
  marque avec le nom local, après retrait des espaces de bord et passage en
  minuscules. Les accents, ponctuations et adresses avec suffixes ne sont pas
  assimilés. Aucune recherche de noms ressemblants n’est effectuée.

**Une égalité n’est pas une preuve d’identité.** Le contrôle ne prouve pas que la
boutique, l’acheteur ou la marque sont les bonnes entités commerciales, ni que la
saison est celle à attribuer au signal. Un lien Store multiple est permis : seule
la présence de la boutique proposée est constatée. Ces limites restent affichées,
même si tous les contrôles techniques réussissent.

`identity_verified`, `season_verified`, `ready_to_transfer` et
`crm_writes_enabled` restent faux. Le choix de destination, les doublons
commerciaux, les effets d’autres intégrations et le futur registre de transfert
restent à résoudre. Les aperçus CRM hypothétiques conservent leurs blocages.

## Connexion préparée, désactivée par défaut

Le lecteur utilise exclusivement `AIRTABLE_ENGAGEMENT_READ_TOKEN`, avec
`AIRTABLE_ENGAGEMENT_READS_ENABLED=true`. Aucun repli sur les clés historiques
n’existe. Il faut un jeton dédié, limité à la base prévue, avec les seuls droits
`data.records:read` et `schema.bases:read` nécessaires à ce parcours. Le secret ne
vient jamais du navigateur et n’est jamais renvoyé par l’API.

Ce code ne peut pas certifier les droits effectivement accordés à un jeton ; ils
restent à vérifier dans Airtable avant toute configuration. Le connecteur de cet
audit est indépendant de la future connexion du serveur. Aucune clé réelle n’a
été créée, copiée ou configurée dans ce lot.

Références officielles consultées :
[accès à l’API et lecture du schéma](https://support.airtable.com/articles/6292134965-getting-started-with-airtable-s-web-api),
[droits de lecture Airtable](https://support.airtable.com/articles/9897799762-using-the-airtable-mcp-server).
Les pages détaillées Web API ont refusé leur lecture par l’outil de consultation ;
le transport n’a pas été validé sur un jeton réel. Les paramètres de sélection
sont couverts par les essais locaux, sans prétendre remplacer ce futur essai réel.

## Fraîcheur, conflits et interruptions

Le contrôle est attaché à la version de revue, aux preuves de navigation, aux
quatre références et à une empreinte des données locales d’identité. Une lecture
réseau ne garde aucune transaction PostgreSQL ouverte. Une transaction brève
réserve d’abord la clé comme `running`, puis une autre enregistre le résultat.
Les données locales sont relues avant la conservation du résultat. Si elles ont
changé, le contrôle devient `failed` sans résultat copié. Un retrait du suivi ou
une suppression du signal empêche sa résurrection par une réponse retardée.

Seul le dernier contrôle est susceptible d’être présenté comme actuel. Un nouveau
contrôle échoué, clos ou interrompu empêche de présenter un ancien résultat comme
actuel. Un contrôle terminé reste actuel pendant au plus une heure, si les
versions et empreintes correspondent encore. Ce délai est un réglage technique
conservateur ; il ne prouve pas qu’une fiche distante n’a pas changé depuis la
lecture. Aucun cache n’autorise un transfert futur : une nouvelle vérification
immédiate serait nécessaire avant toute action distante.

Une seule opération récente peut être admise à la fois, pour limiter les rafales.
La lecture est bornée à 20 secondes au total et cinq secondes par requête. Un
refus de droit, une limite de débit, un schéma modifié ou une réponse incohérente
produit un échec explicite, sans nouvelle tentative automatique ni résultat positif.
Les réponses d’erreur distantes ne sont ni conservées ni affichées telles quelles.

Une clé identique ne répète pas les lectures : elle renvoie le reçu déjà connu.
Après une réponse perdue, « Vérifier le résultat du contrôle » relit ce reçu.
Une opération `running` peut correspondre à une lecture active ou à un serveur
interrompu. Elle ne reprend pas automatiquement. « Clore le contrôle non confirmé »
empêche de conserver un résultat tardif. Une clé inconnue peut aussi être close,
ce qui bloque l’arrivée tardive de sa demande. Une opération déjà terminée
conserve son résultat ; cette clôture ne l’annule pas.

La clôture ne peut pas annuler des GET déjà effectués. Des lectures déjà parties
peuvent se terminer après un retrait ; leurs résultats ne recréent pas les données
locales supprimées. Après deux minutes, une ancienne opération ne bloque plus
l’admission d’une nouvelle ; son résultat tardif ne peut plus être conservé.
Le navigateur garde uniquement le couple identifiant du signal / clé aléatoire
dans `buyer_brand_crm_check_pending_v1`, sans données de contact ni résultat.

## Données et conservation

`buyer_brand_crm_checks` conserve les références proposées, états et dates,
identifiant d’acteur, empreintes, codes d’erreur bornés et constats booléens. Le
jeton, les fiches, les emails et noms distants ne sont pas copiés. Les valeurs
locales nécessaires à la comparaison ne sont pas envoyées dans les requêtes :
seuls les identifiants CRM exacts et les identifiants de champs le sont.

Les identifiants et empreintes restent des données à protéger, pas des données
anonymes. Ils figurent dans l’export acheteur avec les reçus, via
`engagement.brand_reviews.crm_checks`. Ils sont supprimés par cascade lors du
retrait du suivi, de la suppression acheteur/marque ou de la purge du signal après
90 jours depuis sa création. Aucun résultat ne prolonge cette durée. Les
sauvegardes et les journaux d’accès Airtable suivent leurs politiques distinctes.

Le détail affiche les cinq derniers contrôles. Chaque signal est limité à
50 opérations, clôtures comprises. Les anciens contrôles restent historiques ;
une lecture indisponible efface les résultats affichés, sans prétendre qu’aucun
contrôle n’existe. Une saisie non enregistrée bloque le lancement d’un contrôle.
Les actions restent réservées au propriétaire administrateur.

## Vérifications et limites de livraison

`test/buyer-engagement-crm-checks.test.js` couvre le transport GET minimal, la
séparation des secrets, les permissions, les références manquantes, les conflits,
la reprise après perte d’accusé de réception, les clôtures, l’échec d’écriture, le
retrait pendant la lecture, la conservation et l’export. Le serveur Airtable de
ces tests est une imitation locale aux fiches fictives.

`scripts/crm-checks-smoke.cjs` exerce le vrai serveur et ce lecteur local dans
Chrome, en français/anglais à 360/1440 pixels. Les autres origines sont bloquées.
Il teste notamment une réponse perdue après lecture réussie et une demande perdue
avant arrivée au serveur, sans répétition des cinq GET après récupération.

Aucune identité réelle n’est vérifiée dans ce lot. Aucun essai de charge de
production, Safari/iOS, restauration, écriture CRM ou envoi n’est revendiqué.
