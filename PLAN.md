# PLAN — Correctifs & améliorations du bot Moonwell

Statut : **P1 & P2 traités le 09/09/2026** (correctifs appliqués + tests unitaires `tests/bot.test.js`, 31 tests). P3–P6 toujours ouverts.
Cible : `moonwell-withdraw-bot-chunked.js`.

## Barème de priorité

| Priorité | Signification                                                             |
| -------- | ------------------------------------------------------------------------- |
| 🔴 P1    | Risque de blocage du bot / perte de fonctionnalité — à traiter en premier |
| 🟠 P2    | Bug de concurrence réel, déclencheur aléatoire                            |
| 🟡 P3    | Robustesse face aux pannes réseau                                         |
| 🟣 P4-P6 | Améliorations de confort / fiabilité cosmétique                           |

---

## ✅ 🔴 P1 — Stall permanent si une transaction n'est jamais minée (TRAITÉ)

**Localisation** : [moonwell-withdraw-bot-chunked.js:188](../moonwell-withdraw-bot-chunked.js#L188)

**Problème** : `await tx.wait()` sans timeout, aucune gestion de nonce ni d'augmentation de frais. Avec les plafonds `maxFee` de 0.1–0.6 gwei ([GAS_TIERS ligne 49](../moonwell-withdraw-bot-chunked.js#L49)), un pic de base fee sur Base (mint populaire, etc.) fait passer base fee > `maxFeePerGas`. La tx reste pending indéfiniment → `txInFlight` reste `true` → **tous les blocs suivants sont ignorés** → bot bloqué jusqu'au Ctrl-C manuel. Même scénario si la tx est remplacée/orpheline (cf. P2).

**Correctif proposé** :

1. Encadrer `await tx.wait()` d'un timeout via `Promise.race` (ex. 60 s)
2. Au timeout : interroger `provider.getTransaction(tx.hash)` pour le statut réel (pending / mined / dropped)
3. Logguer clairement et remettre `txInFlight = false`, sans décrémenter `remainingRaw`
4. **Optionnel / décision de conception** : au lieu d'attendre, soumettre une tx de remplacement avec frais plus élevés (bump), ou simplement signaler à l'utilisateur et réessayer au prochain bloc

**Correctif appliqué (09/09/2026)** : `tx.wait()` est encadré par `withTimeout()` (configurable via `TX_TIMEOUT_MS`, défaut 60 s). Au timeout, `getTxStatus()` interroge le provider → `pending`/`dropped` : log clair, `txInFlight = false`, **aucun** décrément de `remainingRaw`, reprise au bloc suivant ; `mined` : le receipt est récupéré et traité normalement. Voir tests `withTimeout`, `getTxStatus` et `P1: tx pending forever…`.

**Critère de validation** : simuler un hash jamais miné (mock) → le bot doit logger un warning et reprendre sa boucle au bloc suivant, sans blocage. ✅ couvert par `tests/bot.test.js` (mock tx non minée → warning + `txInFlight = false` + pas de décrément).

---

## ✅ 🟠 P2 — Course : le garde `txInFlight` est posé trop tard (TRAITÉ)

**Localisation** : garde à la [ligne 130](../moonwell-withdraw-bot-chunked.js#L130), `txInFlight = true` à la [ligne 169](../moonwell-withdraw-bot-chunked.js#L169)

**Problème** : le handler `attemptChunk` est async ; entre le garde et l'assignation de `txInFlight`, il y a des `await` (`getCash` lignes 138–143). Deux events `block` (Base en produit toutes les ~2 s) peuvent franchir le garde pendant la lecture. Résultat : deux soumissions concurrentes → ethers v6 lit deux fois le même nonce → **deux txs au même nonce**, l'une devient orpheline → rejoint le P1.

**Correctif proposé** :

1. Déplacer `txInFlight = true` immédiatement après le garde `if (stopped || txInFlight) return;`, **avant tout `await`**
2. Le `finally` existant (ligne 231) remet déjà le flag à `false` — conserver cette logique
3. Vérifier qu'aucune branche intermédiaire ne « sort » du try (les `return` des lignes 149 / 165 passent bien par le `finally`)

**Correctif appliqué (09/09/2026)** : `txInFlight = true` est posé immédiatement après le garde, avant tout `await`. Le `finally` existant ressort toujours le flag.

**Critère de validation** : déclencher deux `attemptChunk()` simultanément (simulation bloc + appel initial) → une seule tx soumise, l'autre retourne immédiatement. ✅ couvert par `tests/bot.test.js` (`P2: two concurrent attemptChunk calls submit exactly one tx`, getCash bloqué sur une gate).

---

## 🟠 P3 — Aucune reconnexion / surveillance du WSS Alchemy

**Localisation** : [provider création ligne 90](../moonwell-withdraw-bot-chunked.js#L90), [souscription ligne 237](../moonwell-withdraw-bot-chunked.js#L237)

**Problème** : aucun handler `error` / `close` sur `WebSocketProvider`. Si Alchemy ferme la connexion (idle, rate-limit, rebalance), les events `block` s'arrêtent **silencieusement** : le bot continue d'afficher des logs mais ne réagit plus.

**Correctif proposé** :

1. Ajouter `provider.websocket.on("close", ...)` et `provider.on("error", ...)` pour logger l'incident
2. Tenter de recréer le provider + relancer la souscription (ou au minimum sortir avec un message d'erreur explicite plutôt que de se taire)
3. **Optionnel** : garde-fou anti-stall — si aucune tx ni aucun bloc traité depuis X minutes, alerte

**Critère de validation** : couper la connexion réseau en cours d'exécution → log explicite et soit reconnexion, soit arrêt propre.

---

## 🟣 P4 — Boucle infinie sur les poussières (< MIN_CHUNK)

**Localisation** : [ligne 161-165](../moonwell-withdraw-bot-chunked.js#L161)

**Problème** : si le reliquat passe sous `MIN_CHUNK` (ex. cible 100.5 → 3 chunks de 33, il reste 1.5 < 5), le bot imprime « Below MIN_CHUNK » à **chaque bloc, indéfiniment**, sans jamais s'arrêter — alors qu'il ne peut plus rien retirer par conception.

**Correctif proposé** :

1. Détecter `remainingRaw < minChunkRaw` **avant** d'entrer dans la boucle d'attente
2. Afficher un message final (« Solde résiduel de X USDC en dessous du minimum — retrait terminé ») et arrêt propre (`stopped = true` → destroy provider → `process.exit(0)`)
3. À valider : faut-il laisser la poussière ou la retirer en ignorant le minimum sur le dernier chunk ?

**Critère de validation** : configurer un reliquat < MIN → le bot s'arrête seul avec un message explicite.

---

## 🟣 P5 — Double conversion des montants en `parseFloat`

**Localisation** : [WITHDRAW_AMOUNT ligne 37](../moonwell-withdraw-bot-chunked.js#L37), [MIN_CHUNK ligne 42](../moonwell-withdraw-bot-chunked.js#L42)

**Problème** : `parseFloat(process.env.X)` puis `parseUnits(value.toString(), 6)` → double arrondi. Un montant à plus de 6 décimales (ex. `70000.1234567`) est arrondi silencieusement, et le garde « exceeds redeemable balance » (ligne 112) compare sur la valeur arrondie.

**Correctif proposé** :

1. Parset les valeurs en `BigInt` via `ethers.parseUnits(String(raw), USDC_DECIMALS)` quand un montant est fourni
2. Valider l'entrée (nombre > 0, ≤ 6 décimales après conversion — sinon erreur explicite)

**Critère de validation** : `WITHDRAW_AMOUNT=70000.1234567` → soit erreur explicite, soit valeur exacte sans arrondi.

---

## 🟣 P6 — Nettoyage des providers en fin de vie

**Localisation** : [readProvider ligne 97](../moonwell-withdraw-bot-chunked.js#L97)

**Problème** : `readProvider` n'est jamais détruit et aucun handler `error` n'y est attaché. Sans impact aujourd'hui (le `process.exit(0)` [ligne 226](../moonwell-withdraw-bot-chunked.js#L226) s'en charge), mais voué à fuiter si le processus est refactorisé (ex. boucle externe).

**Correctif proposé** : sur le chemin d'arrêt, détruire `readProvider` en plus du WSS provider.

---

## Améliorations optionnelles (à évaluer, non validées)

- **Notification** : alerte (télégramme / webhook) à la fin du retrait ou en cas d'échec répété — le bot tournant en fond, l'utilisateur ne surveille pas les logs.
- **Nonce explicite** : gérer le nonce manuellement (ou `nonce` dans les options de tx) pour éliminer toute ambiguïté en cas de multi-exécution.
- **Estimation `gasLimit`** explicite (actuellement ethers l'estime par défaut) pour éviter un revert d'estimation à l'envoi.
- **Variable `READ_RPC_URL`** : documenter la nécessité d'un endpoint fiable (drpc.org public peut être lent/rate-limité) et envisager plusieurs endpoints avec rotation.

---

## Ordre de traitement suggéré

1. **P2** (minimal, 2 lignes) → réduit aussi la probabilité du P1
2. **P1** (timeout + reprise de boucle) — la correction la plus importante pour la fiabilité
3. **P4** (arrêt propre) + **P6** (nettoyage) — rapides, confort d'utilisation
4. **P5** (parsing montants) — à faire avec un mini test manuel
5. **P3** (reconnexion WSS) — plus lourd, à planifier séparément
6. Les améliorations optionnelles si le bot doit tourner en production durable

## Checklist de validation après traitement

- [ ] `node --check moonwell-withdraw-bot-chunked.js` → aucune erreur de syntaxe
- [ ] Lancement à blanc sans vraie clé → erreurs placeholder toujours actives (pas de fuite de secrets)
- [ ] Simuler une tx non minée → reprise de boucle sous 60 s (P1)
- [ ] Simuler 2 events simultanés → une seule soumission (P2)
- [ ] Couper le réseau → log explicite / reconnexion (P3)
- [ ] Reliquat < MIN → arrêt propre (P4)
- [ ] `WITHDRAW_AMOUNT` avec >6 décimales → erreur explicite (P5)
