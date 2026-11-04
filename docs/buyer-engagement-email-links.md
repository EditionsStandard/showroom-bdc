# Liens acheteur et adaptateur fournisseur préparé

Lot du 4 novembre 2026, branche `feat/buyer-engagement-foundations`.
Le lot ajoute les liens d’activation et de désabonnement au protocole d’essai
isolé et prépare un adaptateur Resend séparé. **Aucun envoi réel ni déploiement
n’est effectué.** Le verrou SQL `delivery_enabled=false`, le mode isolé et
l’absence de route d’expédition ou d’ordonnanceur d’envoi sont conservés.

## Activation et approbation

Le premier message figé d’accueil peut créer un jeton aléatoire de 256 bits pour
un compte déjà approuvé, encore en attente d’activation et sans connexion connue.
Seule son empreinte SHA-256 est enregistrée dans `buyer_password_resets`, avec
une durée d’une heure. Une table associée conserve l’identité email et l’origine
de ce lien, avec une échéance absolue indépendante du fuseau horaire de l’ancien
stockage. La création n’efface pas les liens de réinitialisation existants.

La page bilingue permet de choisir le mot de passe via le parcours existant.
Dans la transaction de consommation, le compte est verrouillé et son approbation,
son identité et son état sont recontrôlés. Un lien consommé, expiré ou devenu
incompatible ne peut plus activer le compte. Le parcours ne crée aucun compte,
n’approuve aucune demande et n’ouvre aucune session automatiquement. Les liens
de réinitialisation existants conservent leur parcours.

## Désabonnement

Chaque première enveloppe reçoit un jeton distinct, aléatoire et non devinable.
Il retire l’accord marketing du compte correspondant sans modifier son accès,
ses commandes, ses dates de connexion ou son activité. Une répétition du POST
confirme le retrait sans multiplier les événements de préférence.

L’ouverture par GET ou HEAD affiche une page sans mutation. Le lien du corps
utilise un fragment ; le navigateur le retire immédiatement de l’URL et le garde
uniquement en mémoire, sans stockage navigateur ni ressource tierce. Une action
explicite envoie le POST. Le point d’entrée destiné aux messageries accepte le
POST `List-Unsubscribe=One-Click`, encodé en formulaire ou multipart, sans session.
Les corps JSON/formulaire sont bornés à 2 Ko ; multipart est limité à un champ
de 100 octets et aucun fichier. Les erreurs ne renvoient pas l’identité du compte.

Ce choix suit le mécanisme de la [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.html),
qui distingue les ouvertures automatiques des liens et la demande de retrait par
POST. La conformité du message effectivement reçu reste à vérifier : les deux
en-têtes doivent notamment être couverts par une signature DKIM valide. Aucun
message ni signature DKIM réels n’a été testé dans ce lot.

Avant la première tentative, un retrait annule les intentions en attente. Après
autorisation d’une tentative, il conserve l’incertitude et interdit la reprise.
Une acceptation tardive reste enregistrable : un désabonnement ne peut rappeler
une requête déjà partie. Un lien valable peut retirer un accord donné à nouveau
ultérieurement ; il ne peut jamais donner un accord.

## Immutabilité, confidentialité et conservation

Les jetons sont créés dans la même transaction que le contenu chiffré et la
tentative. Une erreur annule le tout. Le message et ses liens restent identiques
lors d’une reprise, avec la même clé fournisseur. Un lien d’activation expiré,
utilisé ou supprimé bloque la reprise ; aucun nouveau lien n’est substitué dans
le message d’une tentative incertaine.

Le lien de désabonnement reste valable 365 jours, même après suppression de
l’intention à 90 jours. Cette durée est une proposition technique à valider avant
la mise en service. La purge surveillée retire les liens de désabonnement expirés
et les réinitialisations gérées expirées depuis sept jours, par lots de 1 000.
Le nettoyage existant des réinitialisations peut aussi intervenir. Les preuves
de préférence restent liées au compte selon la politique existante. La suppression
du compte supprime les liens ; l’export acheteur expose leurs dates et état
d’utilisation, sans empreinte de jeton ni secret permettant d’agir.

Les pages et réponses sont privées et sans cache, avec une politique de contenu
restrictive et sans référent. Un filtre Sentry retire les jetons d’action et mots
de passe des événements, transactions et traces de navigation transmis par ses
callbacks. Ce filtre ne couvre pas les journaux du proxy ou de Railway. Avant
publication, leur traitement des URL contenant le jeton du point d’entrée
messagerie doit être vérifié ; il faut aussi vérifier la désactivation du suivi
des clics sur les liens sensibles chez le fournisseur.

## Adaptateur Resend

`lib/buyer-engagement-resend-adapter.js` est importé uniquement par ses tests.
Il est désactivé par défaut. Aucun secret d’environnement ni transport réseau
global n’est utilisé implicitement. Son essai nécessite explicitement une clé,
un expéditeur identique à celui de l’enveloppe, une fonction HTTP et un signal
d’arrêt. Le pilote isolé refuse son type `resend_prepared`.

L’adaptateur prépare une seule requête HTTPS à l’adresse fixe du fournisseur,
conserve le corps et la clé d’idempotence, transmet les en-têtes de désabonnement
et refuse les redirections. Il ne réessaie pas lui-même. Une réponse d’acceptation
sans identifiant valide, une erreur HTTP ou réseau reste incertaine ; elle ne
devient jamais une preuve de livraison ou de non-envoi. Le contrat de requête
reprend la [documentation officielle Resend](https://resend.com/docs/api-reference/emails/send-email).
Les tests utilisent uniquement des fonctions et réponses fictives, sans appel à
Resend et sans lecture de clé réelle.

## Validation et ordre restant

La suite locale complète passe 327 tests. Les quatre configurations Chrome
FR/EN à 360/1440 pixels couvrent l’effacement de l’URL, l’activation, l’absence de
connexion automatique, le désabonnement et une confirmation HTTP perdue. Les
requêtes vers les origines extérieures sont bloquées. Les captures ont été
inspectées. Ces contrôles ne prouvent pas Safari/iOS/PWA ni un parcours réel.

La restauration synthétique `8891048560916077` restitue 80 tables, dont 42 non
vides : lignes, séquences, colonnes et contraintes identiques. Ses 14 contrôles
passent, y compris les métadonnées et la validité des liens restaurés ; les
bases et l’archive temporaires sont supprimées. Ce résultat ne valide aucune
sauvegarde de production. La CI doit être relue sur le commit exact du lot.

L’ordre de mise en service restant est : valider les durées et règles métier ;
prouver une sauvegarde de production restaurable ; vérifier domaines, expéditeur,
DKIM, journaux et suivi des liens ; traiter les webhooks authentifiés et les
suppressions fournisseur ; raccorder un worker borné avec une clé de chiffrement
persistante ; tester en préproduction ; obtenir l’accord sur un pilote limité.
Les relances panier par marque, l’articulation avec l’ancien ordonnanceur et
l’écriture d’opportunités CRM demandent encore leur propre raccordement contrôlé.

Le lot suivant prépare la réception signée, les faits de livraison et les
blocages : [retours fournisseur](buyer-engagement-provider-events.md). La
configuration distante, la couverture réelle et le pilote restent à valider.
