# Moonwell Withdraw Bot

Bot Node.js pour retirer des USDC du protocole Moonwell (Base) en plusieurs chunks. Conçu pour les grands retraits qui dépassent la liquidité disponible dans le pool en une seule transaction.

![Version](https://img.shields.io/github/package-json/v/rylorin/moonwell-withdraw-bot)
![Quality Check](https://github.com/rylorin/moonwell-withdraw-bot/workflows/Quality%20Check/badge.svg?branch=master)
![License](https://img.shields.io/badge/License-MIT-blue.svg)

> **Auteur original** : weez2 – merci infiniment pour avoir partagé le script initial.

## Fonctionnalités

- **Retrait chunké** : Divise automatiquement les grands retraits en plusieurs transactions basées sur la liquidité disponible
- **Polling intelligent** : Vérifie la liquidité à chaque nouveau bloc via `getCash()`
- **Gestion du gaz par paliers** : Ajuste automatiquement les frais de gaz selon la taille du chunk (Priorité EIP-1559)
- **Fallback RPC** : Utilise un RPC public gratuit pour les lectures et bascule vers Alchemy en cas d'erreur
- **Détection d'échecs** : Capture les `Failure` events des contrats Compound-fork même en cas de succès EVM
- **Garantie atomicité** : Ne soumet pas de nouvelle transaction tant qu'une précédente est en cours (`txInFlight`)
- **Re-synchronisation du solde** : Le bot re-lit le solde décomposable périodiquement (moniteur) et en mode solde complet la cible suit le solde courant — un dépôt externe est retiré automatiquement, un retrait manuel réduit la cible
- **Source de plafond configurable** : `CHUNK_CAP_SOURCE=monitor` (dernière valeur du moniteur, défaut) ou `fresh` (relecture du solde à chaque tour)

## Prérequis

- Node.js >= 18
- yarn install ethers
- Un wallet avec des USDC sur Base
- Une clé API Alchemy (WSS)

## Installation

```bash
yarn install
```

## Configuration

### Variables d'environnement (recommandé)

| Variable                   | Description                                | Défaut                  |
| -------------------------- | ------------------------------------------ | ----------------------- |
| `BASE_WSS_URL`             | URL WebSocket Alchemy pour Base            | -                       |
| `PRIVATE_KEY`              | Clé privée du wallet                       | -                       |
| `WITHDRAW_AMOUNT`          | Montant total à retirer (USDC)             | Solde complet           |
| `MIN_CHUNK`                | Montant minimum par chunk                  | 5 USDC                  |
| `BASE_READ_RPC_URL`        | RPC public pour les lectures               | `https://base.drpc.org` |
| `BALANCE_MONITOR_INTERVAL` | Relecture du solde décomposable (secondes) | `60` (`0` = désactivé)  |
| `CHUNK_CAP_SOURCE`         | Source du plafond de chunk                 | `monitor` (ou `fresh`)  |

### Exemple d'exécution

```bash
export BASE_WSS_URL="wss://base-mainnet.g.alchemy.com/v2/VOTRE_CLE"
export PRIVATE_KEY="votre_cle_privee"
export WITHDRAW_AMOUNT=70000
yarn start
```

> **Note** : le script charge automatiquement un fichier `.env` (via `dotenv`) s'il est présent. Copiez [.env.example](.env.example) en `.env` puis remplissez les valeurs.

### Configuration du gaz

Les paliers de gaz sont configurés dans le fichier :

| Palier | Priorité (gwei) | Max Fee (gwei) | Condition     |
| ------ | --------------- | -------------- | ------------- |
| 1      | 0.3             | 0.6            | Chunk >= $100 |
| 2      | 0.1             | 0.3            | Chunk >= $30  |
| 3      | 0.02            | 0.1            | Chunk < $30   |

## Fonctionnement

1. Le bot se connecte au réseau Base via WebSocket
2. Il lit le solde USDC décomposable du wallet
3. À chaque bloc, il vérifie la liquidité disponible dans le pool mUSDC
4. Il soumet une transaction `redeemUnderlying`, plafonnée à la plus petite valeur entre :
   - La liquidité totale disponible (`getCash()`)
   - Le montant restant à retirer
   - Le solde décomposable connu (dernière valeur du moniteur, ou relecture à chaque tour selon `CHUNK_CAP_SOURCE`)
5. Il répète à chaque bloc jusqu'à ce que la cible soit atteinte : sans `WITHDRAW_AMOUNT`, la cible suit le solde courant (les dépôts externes sont retirés automatiquement, un retrait manuel réduit la cible)

## Sécurité

- **Ne jamais coder en dur** la clé privée ou l'URL WSS
- Utilisez des variables d'environnement ou un gestionnaire de secrets
- Ne lancez ce script que sur un wallet que vous contrôlez
- Vérifiez toujours l'adresse du contrat sur BaseScan : `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22`

## Contract

- **mUSDC (Moonwell)** : `0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22` (Base)
- Interface ABI : `getCash()`, `balanceOfUnderlying()`, `redeemUnderlying()`

## Notes techniques

- Le bot utilise deux providers : un RPC public pour les lectures fréquentes et Alchemy WSS pour les souscriptions de blocs et soumissions de transactions
- En cas d'erreur de lecture sur le RPC public, le bot bascule automatiquement vers Alchemy
- Les échecs soft (event `Failure`) sont gérés séparément des reverts EVM
- Le solde restant est décrémenté uniquement après confirmation du succès on-chain
