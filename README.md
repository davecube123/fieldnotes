# Fieldnotes

A private notebook for keeping track of what you learn — people, organisations,
prices, processes and how they fit together — and for surfacing connections you
would otherwise not notice.

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
- **Grade the source and the claim separately.** Source reliability A–F, claim
  credibility 1–6 — the scale used in analytic work precisely because the two
  come apart. A reliable source can still hand you
  an improbable claim, and collapsing the two into one "trust" score is how
  people end up certain about nothing.
- **Entities are the spine.** Tag anything with `@[Maria Santos]` or `@BSP`.
  Every mention links the observation to that entity. Typing `@` offers the
  entities you already have, so hurried typing doesn't split one person into
  three. Aliases catch the rest, and anything that still slips through can be
  merged.
- **Standing facts are not events.** A person's role, phone, plate or family sits
  on their entity card as attributes. What they did last Tuesday is an
  observation. Opening someone shows the first, then the second.
- **Their words are not your words.** Mark an observation verbatim and it renders
  as a quote, attributed to its source. A paraphrase you wrote three months ago
  is not evidence of what somebody said.
- **Relationships are recorded, not inferred.** Who owns what, who works for
  whom, who is married to whom — stored as typed, directed links between
  entities. One record reads correctly from both ends: what is "owns" on her
  card is "is owned by" on the shop's. Each carries a confidence, because who
  owns a place is usually rumour before it is fact, and a file that can't tell
  the two apart is a rumour mill. Two-hop traversal shows who you reach through
  someone you already have.
- **A connection is also an entity crossing domains.** When the same name shows up in
  observations you filed under unrelated domains, the brief flags it. That is
  the honest, useful version of "subtle connections" — no inference magic, just
  a join you would not have noticed by memory.
- **Someone you cannot name yet is still a file.** Start a subject under a
  working name — "the page admin", "the man in the grey pickup" — and observations,
  attributes and links attach to it like any other entity. Candidate identities
  are recorded with a confidence *and* with what would prove each one wrong;
  naming a subject requires writing down what convinced you, keeps the working
  name as an alias, and drops every rejected candidate rather than migrating
  them onto a real person.
- **Standing questions beat aimless collecting.** Keep a list of what you want
  to know. You notice answers when you are already looking for them. Each
  question also carries **leads** — hearsay, half-facts and things to check —
  kept separate from the answer until they are solid, and tapped through
  open → checked out → dead end as you work them.
- **Some answers are documents, not facts.** How a land lease works, how a fee
  gets processed, who really signs off — these are not one observation, they are
  a brief you accumulate. Each question holds its own answer text, tags the
  offices and people involved, and collects supporting observations as evidence.

## Views

| View | What it's for |
|---|---|
| **Capture** | File an observation in seconds. Domain, entities, optional grading. |
| **Feed** | Everything filed, searchable, filterable by domain. Edit or delete. |
| **Entities** | Every person, org, place, thing and process, ranked by how often they come up. Filter to the unidentified to see open subjects. Open one to get the file on them: standing details, the domains they span, their recorded connections and who those reach in two hops, who they're seen alongside, the questions they turn up in, and every observation mentioning them. |
| **Questions** | Standing questions, each holding the answer you build up over time, plus a list of leads — half-facts and things to check, before any of it is solid enough to write down as an answer. "How does a land lease work here" starts empty and grows into a written brief, with the observations that back it attached as evidence. |
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

## Scope

This is a tool for understanding how things and institutions actually work, and
who stands behind them: a business's real owner, a company's principals, an
account making public claims, who actually signs off on a permit.

It is not for identifying a private individual who is anonymous for their own
protection. The software cannot tell those two cases apart. The person using it
can.

Either way, the error that does harm is not failing to identify someone — it is
confidently identifying the wrong person. That is why every candidate records
what would disprove it, and why closing a subject requires a written reason.

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

- **Sealed (`.fnotes`)** — ciphertext plus the wrapped keys needed to open it.
  Safe in Google Drive, in email, on a USB stick, committed to a public repo.
  Opens with the passphrase *or* recovery key that were in force when it was
  written, so an old backup still opens after you change your passphrase.
- **Plain JSON** — readable by anything, protected by nothing. For when you want
  to process the data elsewhere.

Restoring merges rather than overwrites, so pulling in an old backup never
destroys newer work. The app nags you on the Brief once a backup is a week old.

### Automatic off-device backup

⚙ → Backup → *Set up automatic backup*. Each backup is committed to a private
GitHub repository as a sealed file, so the repository's history becomes your
versioned backup. A stale backup is sent in the background when the app opens.

**This is the only feature that makes a network request.** With it switched off
the app never talks to anything. With it on, the ciphertext goes to GitHub and
nothing else — the token is stored encrypted under your passphrase, is never
included in an export, and is deleted if you turn encryption off.

Use a fine-grained token limited to the one private repository, with
**Contents: read and write** and no other permission. Backing up to a *public*
repository is possible and the app will warn you: the file stays unreadable, but
anyone could take a copy and attack your passphrase at leisure.

### Keeping the device copy from being evicted

On first run the app calls `navigator.storage.persist()`, asking the browser not
to clear this origin when the device runs low on space. Chrome typically grants
it once the app is installed to the home screen; until then storage is
"best-effort" and can be reclaimed. ⚙ → Backup shows which state you're in.

This does not protect against you clearing site data by hand, or uninstalling.
Nothing on one device does. That is what backups are for.

### What the threat model does and doesn't cover

Covered: a lost or stolen phone, a shared or repaired device, cloud storage
being breached, the hosting provider, anyone who opens the app's URL.

Not covered: malware with a keylogger on an unlocked phone, someone watching you
type, or coercion. Encryption at rest doesn't help against any of those.

## Capturing from elsewhere

The app registers as an Android share target. Reading something in a browser, a
messaging app or a feed, **Share → Fieldnotes** opens a draft with the text in
the body and the link already in the source field.

Pulling feeds in directly is deliberately not implemented. A static page cannot
fetch arbitrary feeds — the browser's same-origin policy blocks it and almost no
publisher opts out — so it would need a server component, which would undo the
property that this app has no backend and phones home to nothing. Sharing in
takes two taps and costs nothing architecturally.

## Files

```
index.html            app shell
styles.css            all styling
js/db.js              IndexedDB wrapper
js/crypto.js          the vault: key wrapping, AES-GCM records, recovery keys
js/sync.js            optional sealed backup to a private GitHub repository
js/model.js           data model, entity parsing, brief and link derivation
js/ui.js              views and event wiring
js/app.js             boot, service worker registration
sw.js                 offline cache (bump CACHE when deploying changes)
tools/make-icons.mjs  regenerates the PNG icons from the SVG motif
tools/test/browser.mjs  end-to-end checks against a real browser
```

## Tests

The app itself has no dependencies. The tests need one:

```sh
python3 -m http.server 8099 &
npm i playwright-core
node tools/test/browser.mjs
```

They drive a real Chromium through capture, entity merging, question documents
and the whole encryption path — including dumping raw IndexedDB to prove no
plaintext survives encryption.

## Where this goes next

- AI-assisted entity extraction and connection suggestions at capture time.
- Timeline view per entity, and alerting when a dormant entity resurfaces.
- Feed ingestion, if it ever earns a small proxy service to make it possible.

None of it matters until there is a habit and a body of observations to work on.
