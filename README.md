# Spy Work

A private field notebook for building a picture of the things you care about —
politics, economics, prices, processes and people — and for surfacing the
connections between them.

Phone-first, offline, installable. Everything is stored on your device; nothing
is uploaded anywhere.

## The idea behind it

Collected information doesn't produce leverage. Information that is timely,
non-obvious, and relevant to a decision does. Three design consequences:

1. **The output is the product.** The weekly brief is the point; the database is
   just what makes the brief possible. If the app never gives anything back, it
   gets abandoned by week three.
2. **Your edge is what only you saw.** Public news and published prices are
   available to everyone and confer nothing on their own. The value is in your
   own ground-level observations, and in the joins between domains that no
   single source covers.
3. **Capture must be instant.** One box, type, save. Everything else is optional
   and collapsed behind a disclosure.

## The method it enforces

- **Observation ≠ assessment.** The fact goes in one field, what you think it
  means in another. This is the single cheapest upgrade to your own thinking:
  six months later you will not mistake your guess for something you were told.
- **Grade the source and the claim separately.** The admiralty scale — source
  reliability A–F, claim credibility 1–6. A reliable source can still hand you
  an improbable claim, and collapsing the two into one "trust" score is how
  people end up certain about nothing.
- **Entities are the spine.** Tag anything with `@[Maria Santos]` or `@BSP`.
  Every mention links the observation to that entity.
- **A connection is an entity crossing domains.** When the same name shows up in
  observations you filed under unrelated domains, the brief flags it. That is
  the honest, useful version of "subtle connections" — no inference magic, just
  a join you would not have noticed by memory.
- **Standing questions beat aimless collecting.** Keep a list of what you want
  to know. You notice answers when you are already looking for them.

## Views

| View | What it's for |
|---|---|
| **Capture** | File an observation in seconds. Domain, entities, optional grading. |
| **Feed** | Everything filed, searchable, filterable by domain. Edit or delete. |
| **Entities** | Every person, org, place, thing and process, ranked by how often they come up. Open one for its profile: domains it spans, who it's seen alongside, every observation mentioning it. |
| **Questions** | Your open questions. Link observations that answer them. |
| **Brief** | The weekly payoff: what you filed, where you looked, who crossed domains, what's new, what's unanswered, what's unsourced. Copy it as text. |

## Running it

No build step, no dependencies, no server.

```sh
# locally
python3 -m http.server 8000
# then open http://localhost:8000
```

To put it on your phone: push this repo and enable **GitHub Pages** (Settings →
Pages → deploy from branch, root folder). Open the Pages URL in Chrome and use
"Add to Home screen". It then works offline and launches like a native app.

## Privacy and durability

These pull against each other: private means nobody can read it, durable means
copies exist in places you don't fully control. Encrypting on the device
resolves it — the ciphertext can then be scattered anywhere.

### Encryption

⚙ → Security → set a passphrase. What happens:

- A random 256-bit AES-GCM master key encrypts every record individually.
- That master key is stored twice over: wrapped by a key derived from your
  passphrase, and wrapped by a key derived from a one-time **recovery key**.
  Changing your passphrase rewraps one small blob rather than re-encrypting
  everything, and forgetting it is survivable.
- Key derivation is PBKDF2-SHA256 at 600,000 iterations. Argon2id resists GPU
  cracking better, but every implementation is a WASM blob fetched from a CDN,
  and this app's strongest property is that it makes **zero outbound requests**.
  Passphrase length closes that gap far more effectively than the KDF choice.
- The master key exists only in memory, only while unlocked. It is never written
  to storage in usable form.
- Locks on reload, on ⚙ → Security → Lock now, and automatically after five
  minutes in the background.

On disk, an encrypted record is `{ id, enc: { iv, ct } }` and nothing else. No
searchable text, no entity names, no dates.

There is no reset. Forget the passphrase *and* lose the recovery key and the
file is unreadable by anyone, permanently.

### Backups

⚙ → Backup gives you two formats:

- **Sealed (`.spyw`)** — ciphertext plus the wrapped keys needed to open it.
  Safe in Google Drive, in email, on a USB stick, committed to a public repo.
  Opens with the passphrase *or* recovery key that were in force when it was
  written, so an old backup still opens after you change your passphrase.
- **Plain JSON** — readable by anything, protected by nothing. For when you want
  to process the data elsewhere.

Restoring merges rather than overwrites, so pulling in an old backup never
destroys newer work. The app nags you on the Brief once a backup is a week old.

### What the threat model does and doesn't cover

Covered: a lost or stolen phone, a shared or repaired device, cloud storage
being breached, the hosting provider, anyone who opens the app's URL.

Not covered: malware with a keylogger on an unlocked phone, someone watching you
type, or coercion. Encryption at rest doesn't help against any of those.

## Files

```
index.html            app shell
styles.css            all styling
js/db.js              IndexedDB wrapper
js/crypto.js          the vault: key wrapping, AES-GCM records, recovery keys
js/model.js           data model, entity parsing, brief and link derivation
js/ui.js              views and event wiring
js/app.js             boot, service worker registration
sw.js                 offline cache (bump CACHE when deploying changes)
tools/make-icons.mjs  regenerates the PNG icons from the SVG motif
```

## Where this goes next

- Automated ingestion for the public half — RSS, official gazettes, price and FX
  feeds — so manual effort stays reserved for what only you can see.
- AI-assisted entity extraction and connection suggestions at capture time.
- Timeline view per entity, and alerting when a dormant entity resurfaces.

Deliberately not here yet: any of that matters only once there is a habit and a
body of observations to work on. Use it for two weeks first.
