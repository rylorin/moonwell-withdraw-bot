# PLAN — Correctifs & améliorations du bot Moonwell

Statut : **P1, P2, P3, P4 & P6 traités** (sept. 2026 — correctifs appliqués + tests unitaires `tests/bot.test.js`, 73 tests). P5 toujours ouvert.
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

## ✅ 🟡 P3 — Aucune reconnexion / surveillance du WSS Alchemy (TRAITÉ)

**Localisation** : [createWssWatchdog (watchdog) ligne 664](../moonwell-withdraw-bot-chunked.js#L664), [watchdog instancié dans main() ligne 1047](../moonwell-withdraw-bot-chunked.js#L1047)

**Problème** : aucun handler `error` / `close` sur `WebSocketProvider`. Si Alchemy ferme la connexion (idle, rate-limit, rebalance), les events `block` s'arrêtent **silencieusement** : le bot continue d'afficher des logs mais ne réagit plus.

**Correctif proposé** :

1. Ajouter `provider.websocket.on("close", ...)` et `provider.on("error", ...)` pour logger l'incident
2. Tenter de recréer le provider + relancer la souscription (ou au minimum sortir avec un message d'erreur explicite plutôt que de se taire)
3. **Optionnel** : garde-fou anti-stall — si aucune tx ni aucun bloc traité depuis X minutes, alerte

**Correctif appliqué (11/09/2026)** : nouveau factory `createWssWatchdog` exporté — heartbeat (`WS_CHECK_MS`) + seuil de silence (`WS_STALL_MS`) ; sa propre souscription `block` alimente l'horloge, et les events `error` / `close` du provider/websocket sont loggés (URL masquée, jamais de clé). En cas de stall : si une tx est en vol, la reconnexion est différée (budget non consommé) ; sinon l'ancien provider est détruit, un nouveau est créé (`buildWss`), la souscription `block` est relancée et `runner.setConnection` rebranche la soumission sur le nouveau provider. Comportement piloté par `WS_ON_STALL` : `reconnect` (défaut, jusqu'à `WS_MAX_RECONNECTS` tentatives avant arrêt) ou `exit` (alerte + arrêt immédiat, également sur `close` du socket).

**Amélioration backoff (12/09/2026)** : une reconnexion échouée ne fait plus **quitter** le processus — elle est relancée en *backoff* exponentiel (`WS_BACKOFF_BASE_MS` = 5 s, ×2 par échec, plafonné à `WS_BACKOFF_MAX_MS` = 60 s). Le budget par défaut monte à **10** (`WS_MAX_RECONNECTS`) ; avec l'espacement du backoff, ~8 min de réseau absent peuvent être absorbées — de quoi survivre à un réveil de veille Mac dont la DNS est transitoirement morte (crash `getaddrinfo ENOTFOUND` sur le socket ws, à l'origine du correctif). Avant d'adopter un socket frais, une sonde de santé (`getBlockNumber` via `withTimeout`, 5 s) vérifie qu'il répond réellement.

**Correctif complémentaire (12/09/2026)** : le getter `WebSocketProvider.websocket` d'ethers v6 **lève** `Error("websocket closed")` une fois le socket détruit (il ne renvoie pas `null`) — l'optional chaining `?.` ne protège pas d'un getter qui throw. Au réveil de veille, `fatal()` → `stop()` → `unbind()` accédait à `boundProvider.websocket` (déjà mort) et faisait crasher le processus par un rejet non géré *au lieu* du `process.exit(1)` prévu — d'où l'impression que le backoff « ne fonctionnait pas » alors qu'il espaçait bien les 10 tentatives. `unbind()`/`bind()`/`buildWss()` accèdent désormais au socket uniquement via un helper `safeWs()` (`try { return p?.websocket || null } catch { return null }`). Tests de régression : `watchdog: un getter websocket qui THROW après close ne crashe pas fatal() (régression)` et `watchdog: getter websocket qui THROW dès le bind → stop()/fatal() propres`. ✅ 73 tests verts.

**Critère de validation** : couper la connexion réseau en cours d'exécution → log explicite et soit reconnexion, soit arrêt propre. ✅ couvert par les tests `watchdog:*` (stall → reconnexion budgetée, `WS_ON_STALL=exit`, fermeture du socket, reconnexion différée, rebind `setProvider`, budget épuisé → `process.exit(1)`) et `runner: setConnection …`.

---

## ✅ 🟣 P4 — Boucle infinie sur les poussières (< MIN_CHUNK) (TRAITÉ)

**Localisation** : [ligne 161-165](../moonwell-withdraw-bot-chunked.js#L161)

**Problème** : si le reliquat passe sous `MIN_CHUNK` (ex. cible 100.5 → 3 chunks de 33, il reste 1.5 < 5), le bot imprime « Below MIN_CHUNK » à **chaque bloc, indéfiniment**, sans jamais s'arrêter — alors qu'il ne peut plus rien retirer par conception.

**Correctif proposé** :

1. Détecter `remainingRaw < minChunkRaw` **avant** d'entrer dans la boucle d'attente
2. Afficher un message final (« Solde résiduel de X USDC en dessous du minimum — retrait terminé ») et arrêt propre (`stopped = true` → destroy provider → `process.exit(0)`)
3. À valider : faut-il laisser la poussière ou la retirer en ignorant le minimum sur le dernier chunk ?

**Correctif appliqué (12/09/2026)** : dans `attemptChunk`, dès que `remainingRaw` reste > 0 mais < `minChunkRaw` (poussière), le bot log un message explicite puis s'arrête proprement via `done()` (`stopped = true` → destroy provider → `process.exit(0)`) — plus de boucle « Below MIN_CHUNK » à chaque bloc.

**Critère de validation** : configurer un reliquat < MIN → le bot s'arrête seul avec un message explicite. ✅ couvert par les tests `P4: remaining dust below MIN_CHUNK stops cleanly`.

---

## 🟣 P5 — Double conversion des montants en `parseFloat`

**Localisation** : [WITHDRAW_AMOUNT ligne 37](../moonwell-withdraw-bot-chunked.js#L37), [MIN_CHUNK ligne 42](../moonwell-withdraw-bot-chunked.js#L42)

**Problème** : `parseFloat(process.env.X)` puis `parseUnits(value.toString(), 6)` → double arrondi. Un montant à plus de 6 décimales (ex. `70000.1234567`) est arrondi silencieusement, et le garde « exceeds redeemable balance » (ligne 112) compare sur la valeur arrondie.

**Correctif proposé** :

1. Parset les valeurs en `BigInt` via `ethers.parseUnits(String(raw), USDC_DECIMALS)` quand un montant est fourni
2. Valider l'entrée (nombre > 0, ≤ 6 décimales après conversion — sinon erreur explicite)

**Critère de validation** : `WITHDRAW_AMOUNT=70000.1234567` → soit erreur explicite, soit valeur exacte sans arrondi.

---

## ✅ 🟣 P6 — Nettoyage des providers en fin de vie (TRAITÉ)

**Localisation** : [readProvider ligne 97](../moonwell-withdraw-bot-chunked.js#L97)

**Problème** : `readProvider` n'est jamais détruit et aucun handler `error` n'y est attaché. Sans impact aujourd'hui (le `process.exit(0)` [ligne 226](../moonwell-withdraw-bot-chunked.js#L226) s'en charge), mais voué à fuiter si le processus est refactorisé (ex. boucle externe).

**Correctif proposé** : sur le chemin d'arrêt, détruire `readProvider` en plus du WSS provider.

**Correctif appliqué (12/09/2026)** : nouveau `createShutdownHandler()` exporté — stop des jobs de fond (moniteur de balance, watchdog) puis destruction des deux providers (WSS + RPC de lecture) sur SIGINT/SIGTERM, idempotent (un second signal est ignoré), `process.exit(0)` sur succès / `process.exit(1)` sur erreur. Un handler `error` est aussi attaché au `readProvider`.

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
3. **P4** (arrêt propre) + **P6** (nettoyage) — ✅ traités le 12/09/2026
4. **P5** (parsing montants) — à faire avec un mini test manuel
5. **P3** (reconnexion WSS) — ✅ traité le 11/09/2026, backoff exponentiel ajouté le 12/09/2026
6. Les améliorations optionnelles si le bot doit tourner en production durable

## Checklist de validation après traitement

- [ ] `node --check moonwell-withdraw-bot-chunked.js` → aucune erreur de syntaxe
- [ ] Lancement à blanc sans vraie clé → erreurs placeholder toujours actives (pas de fuite de secrets)
- [ ] Simuler une tx non minée → reprise de boucle sous 60 s (P1)
- [ ] Simuler 2 events simultanés → une seule soumission (P2)
- [x] Couper le réseau → log explicite / reconnexion (P3) — couvert par les tests watchdog 53–66
- [x] Reliquat < MIN → arrêt propre (P4)
- [ ] `WITHDRAW_AMOUNT` avec >6 décimales → erreur explicite (P5)
