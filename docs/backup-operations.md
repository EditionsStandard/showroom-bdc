# Sauvegardes PostgreSQL — mise en place durable

## État vérifié le 5 novembre 2026

L’administration Railway du service Postgres indique `No backup schedule`. Elle permet de consulter et restaurer les anciens snapshots, mais demande l’offre Pro pour créer de nouvelles sauvegardes ou planifier leur exécution. Aucun abonnement n’a été modifié dans ce lot.

Une archive de production chiffrée du 4 novembre a été restaurée et contrôlée localement avant la publication de Buyer Engagement. Les copies temporaires ont ensuite été retirées. La sauvegarde et sa clé restent dans un dossier local privé hors du dépôt ; elles ne remplacent pas une copie extérieure à cet ordinateur.

## Plan conservant l’offre actuelle

Ce plan conserve l’abonnement Railway existant. Les sauvegardes natives planifiées n’étant pas disponibles dans cette offre, l’alternative est une archive logique chiffrée vers un stockage privé existant, choisi par le propriétaire. Aucune destination, autorisation permanente ou planification n’est encore créée.

1. Confirmer le stockage, le compte destinataire, le dossier et les personnes pouvant y accéder **avant tout transfert** : l’archive contient notamment des données acheteurs, commandes et éléments d’authentification. Google Drive ou iCloud synchronisés sur un poste et un stockage objet utilisé par un serveur n’offrent pas les mêmes possibilités d’exécution sans intervention.
2. Préparer un accès PostgreSQL dédié à la sauvegarde et limité à la lecture. Faire approuver la portée des droits, l’endroit où son secret sera conservé et sa durée avant toute création d’accès. Ne pas réutiliser durablement le compte administrateur dans une tâche automatique.
3. Utiliser un client PostgreSQL compatible, une connexion TLS avec autorité et identité vérifiées, et `pg_dump` en lecture seule. Chiffrer l’archive avant écriture sur le stockage distant. Préférer un format standard comme age ; le producteur peut utiliser une clé publique tandis que la clé privée de restauration est conservée séparément, avec une copie de secours approuvée par le propriétaire.
4. Refuser l’envoi d’une archive si l’export ou le chiffrement échoue. Une exécution d’export qui échoue peut néanmoins avoir produit des octets : la présence d’un fichier ou sa seule date ne prouve pas la réussite de la sauvegarde. Contrôler le code de sortie et l’intégrité de l’objet terminé.
5. Répéter la restauration dans une cible isolée, sans clés de messagerie/CRM et sans trafic vers ces fournisseurs. Vérifier intégrité, comptes, commandes et droits ; conserver uniquement un compte rendu sans données nominatives. Retirer la copie après le contrôle.
6. Activer ensuite une fréquence quotidienne, une durée de conservation et un contrôle de fraîcheur explicitement définis. Un job exécuté sur ce Mac dépend de son alimentation, de sa session et de son accès réseau ; il ne doit pas être présenté comme un service indépendant disponible en permanence. Une tâche exécutée côté serveur peut engendrer des frais d’exécution ou de stockage même sans changement d’offre : les chiffrer avant provisionnement.
7. Prévoir un essai de restauration mensuel. Les alertes d’exploitation sont distinctes des relances commerciales et nécessitent leurs propres destinataires et moyens de notification. Une copie manuelle validée reste un filet provisoire, pas une planification opérationnelle.

## Limites

Le choix d’un autre stockage n’autorise ni son achat, ni la création de nouveaux accès permanents, ni le téléversement de données réelles vers un dossier partagé. Ne jamais déposer une archive, une clé ou une URL de connexion dans GitHub ou un artifact de CI.

La restauration de production reste une opération distincte : préciser l’instant à restaurer, les données qui pourraient être perdues depuis cet instant, la procédure de retour et l’autorisation du propriétaire. Aucun test ne doit écraser la base de production.

## Sources

- [Tarifs Railway](https://railway.com/pricing)
- [Documentation des sauvegardes](https://docs.railway.com/volumes/backups)
- Contrôle authentifié du service Postgres, onglet Backups, le 5 novembre 2026.
