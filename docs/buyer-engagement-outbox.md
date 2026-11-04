# File de transport et reprise après panne

Lot du 4 novembre 2026, branche `feat/buyer-engagement-foundations`.
Il prépare une file durable et un protocole de soumission testable hors des
transactions SQL. **Le transport réel reste verrouillé.** Aucun SDK fournisseur,
clé Resend, adaptateur HTTP, route d’expédition ou ordonnanceur d’envoi n’est
raccordé à ce module. La base impose `delivery_enabled=false` et le seul mode
`isolated_transport`.

## Périmètre livré

Le propriétaire peut conserver une intention à partir d’une préparation à blanc
terminée pour **accueil ou inactivité**. Le texte de sa version sauvegardée doit
avoir une validation éditoriale actuelle. Les accords, dates, règles, version,
activation et épisode sont relus à la création. Les paniers et intérêts marque
ne sont pas introduits dans cette clé de périmètre acheteur.

La clé d’épisode unique est `(buyer_id, rule_id, scope_key, anchor_at)`. Une même
requête rejoue son reçu ; plusieurs requêtes pour le même épisode ne multiplient
pas les intentions. Cette déduplication est limitée à la conservation de 90 jours.
Une intention annulée ou dépassée n’est pas réarmée automatiquement. Un futur
transport réel devra définir la durée de déduplication commerciale et une remise
en préparation explicitement contrôlée, sans réutiliser un épisode ambigu.

L’administration montre les intentions, les états, le nombre de tentatives et les
besoins de vérification. « Réconcilier les réservations expirées » ne contacte
aucun fournisseur : cette action corrige uniquement les états techniques locaux.
Les sources proposées sont les cinquante dernières préparations terminées ; elles
sont recontrôlées lors du POST, et leur présence dans la liste ne garantit pas
qu’elles soient encore admissibles. La file affiche cinquante intentions par page.
Le stockage de reprise du navigateur contient uniquement type et identifiants
aléatoires d’opération/source, sans email, texte ou clé de chiffrement.

## États et frontière de soumission

| État | Signification dans ce lot |
|---|---|
| `staged` | Intention conservée, sans autorisation d’envoi réel. |
| `reserved` | Réservation technique de 60 secondes, protégée par un jeton unique. |
| `submitting` | Autorisation d’essai et tentative enregistrées avant l’appel au fournisseur fictif. Le résultat peut être inconnu. |
| `uncertain` | Une tentative a pu être acceptée ; aucune absence d’envoi n’est déduite du silence. |
| `accepted` | Identifiant d’acceptation du fournisseur fictif confirmé ; aucune livraison réelle revendiquée. |
| `rejected` | Refus définitif explicite du fournisseur fictif. |
| `cancelled` | Blocage avant toute autorisation de transport pour cette intention. |

La réservation est atomique avec `FOR UPDATE SKIP LOCKED`. Avant l’essai, une
transaction brève relit les conditions et lie le contenu à l’intention, conserve
la clé stable, incrémente la tentative, puis committe. La réservation est prolongée
pour laisser une marge au transport. **L’appel fournisseur intervient après le
commit et sans verrou acheteur conservé.**

Le pilote de validation n’accepte qu’un objet injecté `kind='local_fixture'`, une
clé de chiffrement de 32 octets fournie explicitement et des destinataires
`.test` ou `.invalid`. Il n’existe aucun accès HTTP à ce pilote. Les intentions
associées à d’autres domaines sont bloquées avant tout appel, même avec cet objet
fictif. Le message d’essai porte une mention explicite et des liens de domaine
fictif ; il ne génère ni activation ni désabonnement réels.

## Réponses perdues et reprise

Une réservation expirée sans tentative autorisée redevient `staged`. Une
réservation expirée après autorisation devient `uncertain`, même si le processus
s’est arrêté avant que la requête ne parte. Un refus ou une acceptation ne sont
jamais inventés après une panne. Un refus d’une nouvelle tentative n’efface pas
l’incertitude d’une précédente ; seule l’absence de toute tentative encore
incertaine permet de conclure au refus global.

Chaque intention conserve une clé d’idempotence et un contenu immuables. La
répétition d’un essai utilise strictement la même clé, les mêmes octets de contenu
après déchiffrement et la date de première tentative initiale. Le délai ne repart
pas de zéro lors d’une reprise.

La [documentation officielle Resend](https://resend.com/changelog/idempotency-keys)
annonce une conservation de 24 heures et refuse la réutilisation d’une clé avec
un autre contenu. Le protocole local retient une fenêtre plus courte de **23
heures**, au maximum trois tentatives et un délai d’attente croissant. Au-delà,
il conserve l’incertitude et exige une vérification ; il ne crée pas de nouvelle
clé pour essayer de nouveau. Ce contrat n’a pas été éprouvé sur le service réel.

Une attente de plus de dix secondes dans le pilote donne un résultat incertain.
Une acceptation tardive reste enregistrable et peut terminer l’intention, même
si son ancien jeton de réservation a expiré. Une réponse incertaine ou négative
ancienne ne dégrade pas une acceptation plus récente. Des identifiants fournisseur
contradictoires maintiennent un signal de vérification, sans nouvelle tentative.

Une réponse perdue après un commit SQL est récupérée depuis l’état durable. Si
l’écriture finale échoue, l’état `submitting` demeure récupérable après expiration
de réservation ; le worker ne suppose pas que le fournisseur n’a rien fait.

## Conditions avant chaque tentative

Le protocole recontrôle l’accord marketing, la pause, les dates documentées,
l’activité, la règle et sa version, l’épisode, le texte et sa validation, ainsi
que l’identité locale figée. Un changement d’email ne redirige jamais une intention
existante. Une nouvelle version ou un retrait éditorial invalide sa préparation.
Les contacts déjà inscrits dans `last_engagement_email_at` sont pris en compte.
Les intentions de cette file partagent un plafond conservateur d’un contact
potentiel par acheteur sur 24 heures, y compris lorsqu’une première tentative
reste incertaine. Ce périmètre ne prouve pas la connaissance des échanges externes.

Si une condition disparaît avant la première autorisation committée, l’intention est annulée.
Après une tentative ambiguë, le transport est bloqué et l’incertitude est
conservée. Une reprise POST avec la même clé pourrait sinon créer le premier envoi
après un retrait d’accord. Les anciennes fonctions d’email et leur planification
restent distinctes ; la pause de ce module n’est pas un arrêt global du portail.
Une pause ne peut pas annuler une soumission déjà autorisée par le commit.

## Données et conservation

Le contenu du message d’essai est chiffré avec AES-256-GCM ; l’authentification lie
le chiffré à l’intention et à son empreinte. La clé est extérieure à la base et ne
vient jamais de l’API. Aucun repli sur un secret existant n’existe. Une mauvaise
clé ou un contenu incohérent bloque la reprise ; aucun nouveau rendu n’est utilisé
à la place de l’ancien. La gestion d’une clé persistante de production reste à
concevoir avant un branchement réel.

Le contenu chiffré est retiré après acceptation/refus définitif, ou après 24 heures
lors d’un passage de conservation/récupération. La purge surveillée traite ce
périmètre, en lots bornés, sans prolonger la durée à chaque recalcul. L’arrêt du
service ou un échec de purge peut retarder l’effacement physique. Les métadonnées
et événements d’intention expirent à 90 jours ; leurs tentatives et reçus de
création suivent la suppression par cascade. Les reçus agrégés de récupération,
sans acheteur, expirent à 365 jours.

Les identifiants et empreintes restent des données liées à l’acheteur. Son export
inclut intentions, tentatives, opérations de création et événements ; il n’expose
ni chiffré, clé d’idempotence fournisseur ni jeton de réservation. La suppression
du compte supprime les lignes associées et une réponse tardive ne les recrée pas.
Aucun essai accepté ne modifie la date de contact réelle de l’acheteur.

## Vérifications et suite

Les tests utilisent PostgreSQL réel, un fournisseur fictif qui déduplique les
clés et des données synthétiques. Ils vérifient l’absence de verrou pendant I/O,
les fenêtres, les délais, les retraits, la concurrence, les réponses tardives,
les rollbacks, la restauration, l’export et les cascades. Le navigateur bloque
toutes les origines extérieures. Ces preuves ne certifient ni la délivrabilité
réelle ni l’absence de doublons chez Resend en production.

Avant toute expédition réelle : connecter un transport fournisseur approuvé,
générer correctement les liens d’activation et de désabonnement, vérifier les
webhooks et suppressions fournisseur, définir le pilote et les plafonds validés,
gérer la clé de chiffrement, étendre les paniers par marque, remplacer l’ancienne
relance sans double ordonnanceur, prouver la restauration de production et obtenir
l’accord d’activation. La validation éditoriale seule ne satisfait aucun de ces
verrous d’expédition.


## Répétition de restauration exécutée

L’exécution locale `fd431229b3c319f0` a restauré 78 tables, dont 39 non vides,
avec égalité des lignes, séquences, colonnes et contraintes. Elle inclut une
intention après autorisation d’essai mais avant réponse fournisseur : après
redémarrage, sa réservation expirée est reclassée `uncertain`, et l’expédition
reste verrouillée. Les douze contrôles sont réussis ; les bases et l’archive
temporaires ont été supprimées. Aucun fournisseur n’est appelé par cette
répétition. La sauvegarde de production reste non vérifiée.

Les quatre configurations du nouveau volet Chrome et les huit configurations
de régression Conservation / BUYER ENGAGEMENT passent en FR/EN à 360/1440 pixels.
Ces essais ne remplacent pas les contrôles sur comptes réels, Safari/iOS/PWA,
la charge représentative ni un pilote fournisseur approuvé.

La suite locale finale passe 298 tests, dont 31 nouveaux scénarios de file et de
reprise. Les pertes de confirmation SQL avant appel fournisseur et après
acceptation sont couvertes séparément. Les tests fonctionnent sans secrets
fournisseur et sans accès réseau externe. La CI doit encore être vérifiée sur le
commit exact proposé ; les résultats locaux seuls ne la remplacent pas.
