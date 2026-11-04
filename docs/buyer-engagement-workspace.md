# BUYER ENGAGEMENT : espace de travail

État du lot au 4 novembre 2026 : implémentation locale, sans déploiement, envoi d’email ou écriture Airtable.

## Organisation

- **À traiter** : quatre catégories indicatives, aperçu limité à huit lignes par catégorie, accès aux panneaux détaillés existants. Un acheteur peut figurer dans plusieurs catégories. Paniers et intérêts sont comptés par couple acheteur/marque.
- **Automatisations** : formulaires de règles et de brouillons existants ; seuls les modes désactivé et simulation sont disponibles. La pause utilise le contrôle versionné existant. La validation éditoriale reste distincte d’une autorisation d’envoi.
- **Résultats** : activité observée sur 7, 30 ou 90 jours glissants, sans attribution aux relances.
- **Diagnostic avancé** : calculs, journaux, préparation, transport verrouillé, retours fournisseur et conservation ; replié par défaut.

Les identifiants des contrôles existants et leurs gestionnaires sont conservés dans `public/admin.html`. `public/buyer-engagement-workspace.js` gère la navigation, les aperçus et les indicateurs. Il ne duplique aucun formulaire de mutation. Les changements d’onglet conservent les saisies. La traduction des trois vues et des formulaires principaux conserve aussi les brouillons et délais non enregistrés, sans requête réseau.

Les sous-panneaux historiques chargent leurs textes dans la langue du chargement. Après un changement de langue, certains textes de ces sous-panneaux nécessitent encore une actualisation ; cette limite préexistante n’est pas une traduction complète de tous les diagnostics.

## Lecture et comptage

`GET /api/admin/buyer-engagement/workspace?days=7|30|90`, réservé au propriétaire et `Cache-Control: no-store`, n’écrit ni candidat, ni événement commercial, ni file, ni lien. Les paramètres de période non scalaires ou hors liste sont rejetés.

`lib/buyer-engagement-workspace.js` applique les évaluations accueil/inactivité existantes, l’approbation documentée, les dates non futures, l’accord email, les blocages fournisseur et le délai de 24 heures depuis un contact. Les résumés panier/marque réutilisent les sources et décisions de leurs moteurs existants. Ces priorités restent indicatives et demandent une revue humaine ; elles ne constituent pas une liste prête à envoyer.

Les compteurs accueil/inactivité couvrent toute la cohorte lue, indépendamment de l’ancienne pagination de 100 acheteurs. Les limites sont : 10 000 acheteurs, 1 000 cycles panier courants, 5 000 couples d’intérêt marque. Un dépassement ou une erreur produit un état indisponible et un tiret, jamais un zéro supposé. Les trois lectures sont indépendantes : elles ne constituent pas un instantané atomique commun. Chaque moteur utilise sa propre transaction de lecture cohérente.

Les indicateurs comptent :

- les activations datées et terminées ;
- les premières connexions enregistrées, sans reconstitution d’un historique inconnu ;
- les commandes liées à un acheteur, créées pendant la période et actuellement dans un statut actif défini par `lib/commercial-metrics.js` ;
- les commandes issues d’un panier seulement si un reçu de validation réussi, une conversion durable et une commande active concordent sur l’acheteur et la commande. Les dates du reçu et de création doivent appartenir à la période.

Ces chiffres ne prouvent ni paiement, ni livraison, ni effet d’un email. `attribution_available` reste faux et `attributed_orders` reste nul.

## Validation locale du lot

- Suite serveur : **372 tests réussis, aucun échec ni test ignoré**, Node 24.16 et PostgreSQL 18.6. Journal externe au dépôt : `validation/engagement-workspace-tests-2026-11-04.log` dans le dossier d’implémentation parent.
- Douze tests supplémentaires couvrent l’accès propriétaire, les périodes, les compteurs globaux, les exclusions, la pause, les sources panier/marque, les données partielles, les indicateurs et l’absence de mutation.
- Scripts intégrés de l’admin analysés sans erreur ; syntaxe de 18 fichiers JavaScript contrôlée.
- Vérification manuelle dans le navigateur : quatre cas fictifs, navigation entre les trois vues, périodes 7/30/90, conservation des brouillons, traduction principale FR/EN, pause/reprise, diagnostic accessible, dépassement simulé de 1 000 cycles puis restauration du jeu de démonstration.
- À 360 pixels, largeur du document égale à 360 pixels dans chacune des trois vues. Chargement direct mobile vérifié ; le passage ordinateur/mobile nécessite un rechargement pour réinitialiser les menus globaux historiques.
- Aucune erreur ou alerte console capturée lors de la vérification finale.

Les neuf scripts de vérification navigateur existants ont été adaptés pour ouvrir les onglets et panneaux réels via `scripts/engagement-navigation.cjs`. Leur syntaxe a été contrôlée ; ces neuf parcours automatisés n’ont pas été exécutés pour ce lot. Les vérifications manuelles ne remplacent pas leur couverture complète. Aucune CI sur ce nouveau lot, ni validation en production, n’est revendiquée.

## Aperçu et suite

L’aperçu `http://127.0.0.1:3280/` utilise une base locale dédiée, des acheteurs fictifs et un serveur lié à la boucle locale. Le lanceur et l’injection de session de démonstration restent hors du dépôt applicatif ; ils ne doivent pas être déployés. Aucun expéditeur ni accès CRM réel n’est fourni à cet aperçu.

Ordre recommandé : revue utilisateur de cet écran ; validation complète des parcours navigateur et CI du lot ; préparation d’une publication avec sauvegarde/restauration déjà démontrée et configuration vérifiée ; déploiement uniquement après accord explicite. L’activation des envois et des transferts CRM reste un chantier distinct nécessitant ses propres contrôles et autorisations.
