# Éditions Standard — V6 responsive preview (non déployée)

## Périmètre

Cette branche `design/v6-responsive-simulation` prépare la refonte V6 sur les **pages réelles** du B2B. Elle ne remplace pas le moteur de commande et ne crée ni endpoint, ni table, ni migration.

- Acheteur : `/portal`, catalogue, fiche marque, produit, shortlist, favoris, panier et commandes.
- Agent : `/agent`.
- Administration, marques et rôles : `/admin`.
- Parcours annexes : `/commande/:brandId`, `/selection/:token`, `/buyer/:brandId`, `/rdv/:brandId`.
- Entrées : `/editions-showroom-b2b-portail`, `/demande-acces`, `/admin/login`, `/`.
- **Écran de connexion acheteur inchangé visuellement** (demande explicite). Un paramètre de preview sur sa page ne modifie pas le formulaire.

## Activer / désactiver

Après avoir démarré **une instance de développement locale et isolée**, ouvrir :

```
http://localhost:3000/editions-showroom-b2b-portail?es_v6=1
```

Le marqueur reste dans la **session de l'onglet**, et la couche graphique apparaît après connexion. On peut aussi démarrer sur `http://localhost:3000/agent?es_v6=1` ou sur une page autorisée. Les droits actuels restent nécessaires, aucun accès n'est contourné.

- `?es_v6=1` : active V6 pour l'onglet.
- `?es_v6=0` : désactive V6.
- Le mini-sélecteur en bas de page permet « Auto », « Jour », « Nuit », « Quitter ».
- En mode auto : thème **clair de 07:00 à 19:59**, **sombre de 20:00 à 06:59**, selon l'heure du navigateur, vérifiée toutes les 60 secondes.
- Palette : `#33251F` (brun) et `#B8D3E7` (bleu), IBM Plex Mono conservée.

## Isolation et sécurité

- **Aucun déploiement Railway**, aucune modification sur `main`.
- Aucun changement des routes authentifiées ni des API.
- Aucun appel réseau additionnel, hormis le chargement statique local de `/es-v6-preview.css` et `/es-v6-preview.js`.
- Le relooking est activé uniquement par `data-es-v6-preview=on` : **en mode normal, aucun sélecteur CSS V6 ne s'applique**.
- L'authentification MFA, les permissions agent/marque, les règles de minimum de commande, le stockage et les envois de commandes gardent leur logique d'origine.
- Les styles de preview ne doivent pas être pris pour une validation de compatibilité métier.
- Ne pas connecter l'instance locale à la base de données, aux emails, aux webhooks ou aux variables d'environnement **de production**. Utiliser une base de test et des services factices.

## Vérifications prévues (en local sur un environnement de test)

1. `npm install` et `npm test` dans la branche ; contrôler les tests V6.
2. Vérifier qu'un chargement sans `es_v6=1` affiche exactement le style normal.
3. Vérifier les pages de connexion et de demande d'accès inchangées.
4. Visualiser la même fiche marque sur 320, 390, 768, 1024, 1440 et 1600 px : pas de débordement horizontal.
5. Contrôler mode clair / sombre / auto, la navigation, les filtres produit, les variantes, les tailles, les minima, la shortlist, le panier et l'export PDF.
6. Contrôler les niveaux de droit séparément : acheteur, agent, marque, owner/admin.
7. Vérifier que le sous-total commande et les données envoyées au serveur sont identiques entre V6 désactivé et activé.
8. Vérifier préférences d'accessibilité : navigation clavier, contrastes et `prefers-reduced-motion`.

## Fichiers

- `public/es-v6-preview.js` : activation / thèmes et barre de contrôle.
- `public/es-v6-preview.css` : palette et composants responsive, styles cantonnés au mode preview.
- Liens script ajoutés aux pages publiques concernées, **sans changer leurs éléments métier**.
- `test/v6-preview.test.js` : garde-fous de structure.

## Limites actuelles et prochaines étapes

C'est une **première intégration esthétique activable** sur les templates réels, pas une reproduction complète, pixel-perfect, de chaque écran V6. En particulier, les vues à fort contenu (admin complexe et formulaires de commande) nécessitent une **revue navigateur authentifiée** et les réglages CSS spécifiques après inspection réelle. Aucune validation E2E en base de test n'est revendiquée.

Le CRM partagé Oscar / Michael reste une **fonctionnalité future distincte** ; le patch ne crée ni schéma, ni permissions, ni écran CRM fonctionnel.

Ne fusionner vers `main` qu'après QA et approbation explicite.
