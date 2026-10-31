# Coordonnées et validation du portail acheteur

## Comportement

- Liste de pays traduite via Intl.DisplayNames, codes ISO alpha-2 partagés entre
  formulaires et serveur. Aucun pays n’est déduit d’une ancienne valeur.
- Le profil conserve sa valeur historique tant que l’acheteur ne la modifie pas.
  Une ancienne valeur reste visible avec « À vérifier ». Une nouvelle commande
  exige un pays ISO, vérifié par l’API avant toute création de commande.
- Facturation et nouveaux magasins : adresse, complément, code postal facultatif,
  ville et pays. Les écritures sont validées côté serveur et restent réservées au
  propriétaire de la société. Les JSON existants ne sont pas migrés ; les champs
  supplémentaires de facturation sont conservés lors de l’édition.
- Formulaires intégrés pour adresses, invitation, création de liste et notes.
  Erreurs conservées dans le formulaire, saisies préservées pour réessayer,
  soumission désactivée pendant l’écriture, annulation clavier et restitution du
  focus par le dialogue natif. Les notes existantes sont préremplies.
- Une invitation génère un lien privé à transmettre manuellement, pas un email.
  Le texte rappelle l’activation préalable du compte. Les permissions et la
  consommation unique de l’invitation sont inchangées.
- Avant transmission : signature et CGV enregistrées avec une commande par marque,
  aucun paiement déclenché. Après : « Commande enregistrée », référence et PDF,
  conditions réelles ou mention « À confirmer avec le showroom ». Le texte ne
  garantit ni email livré ni délai de validation.
- Après une réussite partielle, les marques en échec restent au panier, avec pays,
  signature et acceptations conservés. La réussite complète ramène en haut de page
  et place le focus sur le titre de confirmation.

## Données et mise en production

Aucune migration de schéma ni correction de données de production. Les anciennes
adresses et les pays historiques ne sont pas réécrits au déploiement. Une ancienne
page déjà ouverte peut recevoir une erreur de pays et devra sélectionner un code
ISO ou être rechargée pour afficher la liste. Ne pas rétablir le champ libre pour
contourner ce contrôle.

Les adresses enregistrées sont celles de la société ; ce changement ne les ajoute
pas rétroactivement aux commandes et ne choisit pas automatiquement un magasin
comme destination de livraison.

## Validation

- `TEST_PG_ADMIN_URL=<PostgreSQL isolé> npm test` : 53 tests passent, dont les refus
  d’adresses/pays invalides, la conservation des données historiques, le refus
  d’écriture par un collègue, les permissions agents et les règles de commande.
- `node scripts/buyer-forms-smoke.cjs` avec Playwright disponible : fixtures
  synthétiques uniquement, FR/EN à 360/1440 px, erreur serveur puis nouvel essai,
  conservation de facturation, notes préremplies, invitation sans email, refus du
  pays non qualifié et réussite de commande. Aucune fenêtre prompt/confirm, aucune
  erreur JavaScript et aucun débordement horizontal.
- `node scripts/buyer-mobile-smoke.cjs` : régression catalogue, tailles en pouces,
  couleurs, minima par référence et modification directe du panier.
- Pour un Chrome installé localement, définir `CHROME_EXECUTABLE`. Le module
  Playwright peut être fourni via `PLAYWRIGHT_MODULE`. `SCREENSHOT_DIR` active les
  captures des nouveaux parcours.

Ces tests ne prouvent pas la réception d’emails, un paiement, un parcours dans
Safari/iOS, ni une session acheteur réelle en production. Fusionner uniquement
après CI verte pour le commit exact ; Railway suit main et une fusion peut lancer
immédiatement le déploiement.
