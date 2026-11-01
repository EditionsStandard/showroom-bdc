# Précondition du rappel panier 48 h — revue en lecture seule

Le rappel panier doit rester bloqué. L’âge du snapshot ne prouve pas qu’il reste à commander : le retrait des marques commandées dépend encore du navigateur.

## Preuves dans le code au commit 142daef

- [database.js:126](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/database.js#L126) : `buyer_carts` ne stocke que l’acheteur, le JSON et sa date, sans révision ni conversion.
- [public/portal.html:2291](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/public/portal.html#L2291) et [server.js:6079](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/server.js#L6079) : sauvegarde locale, envoi différé de 1,2 seconde d’un snapshot complet, sans contrôle de révision serveur.
- [public/portal.html:2320](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/public/portal.html#L2320) et `2410` : fusion donnant priorité aux lignes locales ; l’initialisation n’attend pas cette fusion avant de normaliser et sauvegarder. Une révision serveur seule ne corrigerait pas cette réconciliation.
- [server.js:5754](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/server.js#L5754) : checkout sur des lignes indépendantes du panier sauvegardé, création par marque, sans identité/révision de panier.
- [server.js:4517](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/server.js#L4517) et [public/portal.html:3682](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/public/portal.html#L3682) : commande, stock et activité sont transactionnels, mais le panier est retiré après la réponse puis synchronisé avec délai. Une réponse perdue peut donc laisser un panier déjà commandé sauvegardé — conséquence déduite du code, pas incident de production constaté.
- [server.js:4496](https://github.com/EditionsStandard/showroom-bdc/blob/142daefd3d17e5896afe4480a01156748b17af80/server.js#L4496) : déduplication de vingt secondes fondée sur les lignes, après validation catalogue. Elle ne fournit pas une identité durable de conversion ; une reprise tardive peut échouer si le catalogue ou le stock a changé.

## Chemin recommandé avant instrumentation

1. Créer une identité/révision de panier et un cycle par marque (`open`, `empty`, `converted`, `unknown`). Les paniers historiques restent inconnus ; ne pas reconstituer une conversion.
2. Ajouter une API versionnée compatible avec les routes existantes. Une révision obsolète doit renvoyer un conflit et conduire à une réconciliation explicite. Un ancien client sans version conserve ses fonctions mais rend le cycle incertain, donc exclu des rappels.
3. Donner au checkout une clé durable liée au contenu. Relire un résultat déjà validé avant de refaire les contrôles catalogue d’une reprise.
4. Dans la transaction existante de création de commande, enregistrer la conversion de la révision de marque et la commande ensemble. Préserver les parcours public/sélection agent et les validations serveur actuelles.
5. Conserver les réussites partielles : A convertie, B refusée et ouverte. Des identités/tombstones empêchent un ancien snapshot de ressusciter A.
6. Détecter seulement un cycle connu, ouvert, non vide et inchangé depuis quarante-huit heures, avec recontrôle au traitement. Une future tâche doit inclure la marque dans sa clé d’épisode.

## Validation nécessaire

Seuil exact quarante-huit heures ; synchronisation identique sans remise à zéro ; deux appareils et écriture obsolète ; réponse perdue après commit puis reprise plusieurs minutes après sans double commande/stock ; réussite A/échec B et reprise de B seule ; rollback commun commande/conversion ; modification concurrente sans perte de lignes ; exclusion des anciens clients ; aucun rappel après conversion, effacement ou retrait du choix marketing.

Les tests actuels couvrent prix serveur, minimums, couleurs/tailles, CGV, signature, PO, PDF, sélections et découpage multimarque. Le smoke navigateur couvre la réussite partielle avec réponse simulée. Ils ne prouvent pas une conversion durable après panne. Aucun changement de checkout n’est inclus dans ce troisième lot.
