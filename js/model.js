// Data model, entity parsing, the derived views (links, streak, brief), and the
// encryption boundary. Records leave this module as plain objects and hit the
// database as ciphertext whenever a vault exists.

import * as db from './db.js';
import * as C from './crypto.js';

export const DOMAINS = [
  { id: 'political', label: 'Political' },
  { id: 'economic',  label: 'Economic'  },
  { id: 'price',     label: 'Price'     },
  { id: 'process',   label: 'Process'   },
  { id: 'people',    label: 'People'    },
  { id: 'other',     label: 'Other'     },
];

export const ENTITY_TYPES = ['unknown', 'person', 'org', 'place', 'thing', 'process'];

// Source reliability (A best .. F unknown) and information credibility (1 best .. 6 unknown).
// The admiralty scale: grading the source and the claim separately stops a confident
// source from laundering a weak claim.
export const RELIABILITY = {
  A: 'Reliable',
  B: 'Usually reliable',
  C: 'Fairly reliable',
  D: 'Not usually reliable',
  E: 'Unreliable',
  F: 'Cannot be judged',
};

export const CREDIBILITY = {
  1: 'Confirmed elsewhere',
  2: 'Probably true',
  3: 'Possibly true',
  4: 'Doubtful',
  5: 'Improbable',
  6: 'Cannot be judged',
};

const STORES = ['observations', 'entities', 'questions'];

export const state = { observations: [], entities: [], questions: [] };

// The master key exists only here, only in memory, only while unlocked.
let masterKey = null;
let vault = null;

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const normKey = name => name.trim().toLowerCase().replace(/\s+/g, ' ');

/* ---------------- encryption boundary ---------------- */

export const isEncrypted = () => !!vault;
export const isLocked = () => !!vault && !masterKey;

async function persist(store, obj) {
  if (masterKey) return db.put(store, { id: obj.id, enc: await C.encryptJson(masterKey, obj) });
  return db.put(store, obj);
}

async function readAll(store) {
  const rows = await db.getAll(store);
  const out = [];
  for (const row of rows) {
    if (!row.enc) { out.push(row); continue; }
    if (!masterKey) throw new Error('locked');
    out.push(await C.decryptJson(masterKey, row.enc));
  }
  return out;
}

// Rewrites every record under the current key setting. Used when turning
// encryption on or off; both directions are a full pass over the data.
async function rewriteAll() {
  const snapshot = { observations: state.observations, entities: state.entities, questions: state.questions };
  for (const store of STORES) {
    await db.clear(store);
    for (const row of snapshot[store]) await persist(store, row);
  }
}

export async function init() {
  vault = (await db.get('vault', 'vault')) || null;
  if (!vault) await load();
}

export async function unlock(passphrase) {
  masterKey = await C.unlockWithPassphrase(vault, passphrase);
  await load();
}

export async function unlockWithRecoveryKey(recoveryKey) {
  masterKey = await C.unlockWithRecoveryKey(vault, recoveryKey);
  await load();
}

export function lock() {
  masterKey = null;
  state.observations = [];
  state.entities = [];
  state.questions = [];
}

export async function enableEncryption(passphrase) {
  if (vault) throw new Error('Already encrypted.');
  const created = await C.createVault(passphrase);
  masterKey = created.key;
  vault = created.vault;
  await rewriteAll();
  await db.put('vault', vault);
  return created.recoveryKey;
}

export async function changePassphrase(current, next) {
  await C.unlockWithPassphrase(vault, current); // throws if wrong
  vault = await C.rewrapPassphrase(vault, masterKey, next);
  await db.put('vault', vault);
}

export async function disableEncryption(passphrase) {
  await C.unlockWithPassphrase(vault, passphrase); // throws if wrong
  masterKey = null;
  vault = null;
  await rewriteAll();
  await db.del('vault', 'vault');
}

/* ---------------- loading ---------------- */

export async function load() {
  const [observations, entities, questions] = await Promise.all(STORES.map(readAll));
  state.observations = observations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  state.entities = entities;
  state.questions = questions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ---------------- entities ---------------- */

// @[Two Word Name] for anything with spaces, @bareword for the rest.
const MENTION = /@\[([^\]\n]+)\]|@([\p{L}\p{N}_.\-]+)/gu;

export function parseMentions(text) {
  const names = [];
  for (const m of (text || '').matchAll(MENTION)) {
    // Brackets are explicit delimiters, so @[Rosa D.] is taken literally. A bare
    // mention has to guess where it ends, so it allows inner dots and dashes
    // (U.S., e-Gov) but must not swallow the punctuation closing its sentence.
    const name = m[1] !== undefined ? m[1].trim() : (m[2] || '').trim().replace(/[.\-_]+$/, '');
    if (name && !names.some(n => normKey(n) === normKey(name))) names.push(name);
  }
  return names;
}

export function entityById(id) {
  return state.entities.find(e => e.id === id) || null;
}

export function findEntityByName(name) {
  const key = normKey(name);
  return state.entities.find(e => e.key === key || (e.aliases || []).some(a => normKey(a) === key)) || null;
}

async function ensureEntities(names) {
  const ids = [];
  for (const name of names) {
    let entity = findEntityByName(name);
    if (!entity) {
      entity = { id: uid(), name: name.trim(), key: normKey(name), type: 'unknown', aliases: [], notes: '', createdAt: new Date().toISOString() };
      await persist('entities', entity);
      state.entities.push(entity);
    }
    if (!ids.includes(entity.id)) ids.push(entity.id);
  }
  return ids;
}

export async function saveEntity(entity) {
  entity.key = normKey(entity.name);
  entity.attributes = (entity.attributes || [])
    .map(a => ({ k: (a.k || '').trim(), v: (a.v || '').trim() }))
    .filter(a => a.k || a.v);
  await persist('entities', entity);
  const i = state.entities.findIndex(e => e.id === entity.id);
  if (i >= 0) state.entities[i] = entity; else state.entities.push(entity);
  return entity;
}

// Folds one entity into another: every link moves, the old name survives as an
// alias so future mentions resolve, and attributes are kept unless they clash.
export async function mergeEntities(sourceId, targetId) {
  const source = entityById(sourceId);
  const target = entityById(targetId);
  if (!source || !target || sourceId === targetId) throw new Error('Pick two different entities.');

  const targetKeys = new Set((target.attributes || []).map(a => a.k.toLowerCase()));
  target.attributes = (target.attributes || [])
    .concat((source.attributes || []).filter(a => !targetKeys.has(a.k.toLowerCase())));

  target.aliases = [...new Set([...(target.aliases || []), ...(source.aliases || []), source.name]
    .filter(a => normKey(a) !== normKey(target.name)))];

  target.notes = [target.notes, source.notes].filter(Boolean).join('\n\n');
  target.type = target.type !== 'unknown' ? target.type : source.type;
  await saveEntity(target);

  for (const o of state.observations) {
    if (!o.entityIds.includes(sourceId)) continue;
    o.entityIds = [...new Set(o.entityIds.map(id => (id === sourceId ? targetId : id)))];
    await persist('observations', o);
  }
  for (const q of state.questions) {
    if (!(q.entityIds || []).includes(sourceId)) continue;
    q.entityIds = [...new Set(q.entityIds.map(id => (id === sourceId ? targetId : id)))];
    await persist('questions', q);
  }

  await db.del('entities', sourceId);
  state.entities = state.entities.filter(e => e.id !== sourceId);
  return target;
}

export async function deleteEntity(id) {
  await db.del('entities', id);
  state.entities = state.entities.filter(e => e.id !== id);
  for (const o of state.observations) {
    if (o.entityIds.includes(id)) {
      o.entityIds = o.entityIds.filter(x => x !== id);
      await persist('observations', o);
    }
  }
}

/* ---------------- observations ---------------- */

export async function saveObservation(draft) {
  const names = parseMentions(draft.body + ' ' + (draft.assessment || ''));
  const entityIds = await ensureEntities(names.concat(draft.extraEntities || []));
  const now = new Date().toISOString();

  const obs = {
    id: draft.id || uid(),
    createdAt: draft.createdAt || now,
    updatedAt: now,
    eventDate: draft.eventDate || now.slice(0, 10),
    body: draft.body.trim(),
    assessment: (draft.assessment || '').trim(),
    domain: draft.domain || 'other',
    source: (draft.source || '').trim(),
    reliability: draft.reliability || 'F',
    credibility: draft.credibility || '6',
    followUp: !!draft.followUp,
    verbatim: !!draft.verbatim,
    questionId: draft.questionId || null,
    entityIds,
  };

  await persist('observations', obs);
  const i = state.observations.findIndex(o => o.id === obs.id);
  if (i >= 0) state.observations[i] = obs; else state.observations.unshift(obs);
  state.observations.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return obs;
}

export async function deleteObservation(id) {
  await db.del('observations', id);
  state.observations = state.observations.filter(o => o.id !== id);
}

export function observationsFor(entityId) {
  return state.observations.filter(o => o.entityIds.includes(entityId));
}

/* ---------------- questions ---------------- */

// A question is a living document: the thing you want to know, plus the answer
// you build up over time, plus the observations that back it. "How does a land
// lease work here" is not one fact, it is a standing brief that keeps growing.
export async function saveQuestion(q) {
  const existing = state.questions.find(x => x.id === q.id);
  const text = (q.text ?? existing?.text ?? '').trim();
  const answer = (q.answer ?? existing?.answer ?? '').trim();
  const now = new Date().toISOString();

  const question = {
    id: q.id || uid(),
    text,
    answer,
    entityIds: await ensureEntities(parseMentions(`${text} ${answer}`)),
    createdAt: q.createdAt || existing?.createdAt || now,
    updatedAt: now,
    answeredAt: q.answeredAt !== undefined ? q.answeredAt : (existing?.answeredAt || null),
  };
  await persist('questions', question);
  const i = state.questions.findIndex(x => x.id === question.id);
  if (i >= 0) state.questions[i] = question; else state.questions.unshift(question);
  return question;
}

export async function deleteQuestion(id) {
  await db.del('questions', id);
  state.questions = state.questions.filter(q => q.id !== id);
}

/* ---------------- derived ---------------- */

export function entityProfile(entityId) {
  const obs = observationsFor(entityId);
  const domains = [...new Set(obs.map(o => o.domain))];

  const together = new Map();
  for (const o of obs) {
    for (const other of o.entityIds) {
      if (other !== entityId) together.set(other, (together.get(other) || 0) + 1);
    }
  }
  const links = [...together.entries()]
    .map(([id, count]) => ({ entity: entityById(id), count }))
    .filter(l => l.entity)
    .sort((a, b) => b.count - a.count);

  return {
    entity: entityById(entityId),
    observations: obs,
    questions: state.questions.filter(q => (q.entityIds || []).includes(entityId)),
    domains,
    crossDomain: domains.length >= 2,
    links,
    lastSeen: obs[0] ? obs[0].createdAt : null,
  };
}

export function entityIndex() {
  return state.entities
    .map(e => {
      const obs = observationsFor(e.id);
      const domains = [...new Set(obs.map(o => o.domain))];
      return { entity: e, count: obs.length, domains, crossDomain: domains.length >= 2, lastSeen: obs[0] ? obs[0].createdAt : e.createdAt };
    })
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen));
}

export function suggestEntities(query, limit = 6) {
  const q = query.trim().toLowerCase();
  return entityIndex()
    .filter(r => !q || r.entity.name.toLowerCase().includes(q)
              || (r.entity.aliases || []).some(a => a.toLowerCase().includes(q)))
    .slice(0, limit)
    .map(r => r.entity);
}

const localDay = iso => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function streak() {
  const days = new Set(state.observations.map(o => localDay(o.createdAt)));
  if (!days.size) return 0;
  const cursor = new Date();
  if (!days.has(localDay(cursor.toISOString()))) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (days.has(localDay(cursor.toISOString()))) {
    n++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return n;
}

export function brief(days = 7) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const recent = state.observations.filter(o => o.createdAt >= since);
  const recentIds = new Set(recent.flatMap(o => o.entityIds));

  const byDomain = DOMAINS
    .map(d => ({ ...d, count: recent.filter(o => o.domain === d.id).length }))
    .filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count);

  const touched = [...recentIds].map(id => entityProfile(id)).filter(p => p.entity);

  return {
    days,
    total: state.observations.length,
    recent,
    byDomain,
    streak: streak(),
    newEntities: state.entities.filter(e => e.createdAt >= since),
    crossDomain: touched.filter(p => p.crossDomain).sort((a, b) => b.observations.length - a.observations.length),
    hot: touched
      .map(p => ({ profile: p, recentCount: recent.filter(o => o.entityIds.includes(p.entity.id)).length }))
      .sort((a, b) => b.recentCount - a.recentCount)
      .slice(0, 8),
    followUps: state.observations.filter(o => o.followUp),
    openQuestions: state.questions.filter(q => !q.answeredAt),
    answeredRecently: state.questions.filter(q => q.answeredAt && q.answeredAt >= since),
    unsourced: recent.filter(o => !o.source).length,
  };
}

/* ---------------- backup bookkeeping ---------------- */

const BACKUP_KEY = 'spy-work:last-backup';

export function lastBackupAt() {
  try { return localStorage.getItem(BACKUP_KEY); } catch { return null; }
}

export function daysSinceBackup() {
  const at = lastBackupAt();
  if (!at) return null;
  return Math.floor((Date.now() - new Date(at)) / 86400000);
}

function markBackedUp() {
  try { localStorage.setItem(BACKUP_KEY, new Date().toISOString()); } catch {}
}

/* ---------------- import / export ---------------- */

// Plaintext. Readable by anything, protected by nothing.
export function exportPlain() {
  markBackedUp();
  return {
    format: 'spy-work',
    version: 1,
    exportedAt: new Date().toISOString(),
    observations: state.observations,
    entities: state.entities,
    questions: state.questions,
  };
}

// Ciphertext plus the wrapped keys needed to open it. Safe to put anywhere:
// cloud storage, email, a public repo. Opens with the passphrase or the
// recovery key that were in force when it was written.
export async function exportEncrypted() {
  if (!masterKey) throw new Error('Encryption is off — nothing to export as a sealed file.');
  const records = {};
  for (const store of STORES) {
    records[store] = [];
    for (const row of state[store]) {
      records[store].push({ id: row.id, enc: await C.encryptJson(masterKey, row) });
    }
  }
  markBackedUp();
  return { format: 'spy-work-encrypted', version: 1, exportedAt: new Date().toISOString(), vault, records };
}

// Turns an encrypted export back into plain records, without touching this
// device's own vault. The file carries its own wrapped key, so an old backup
// opens with the passphrase it was written under.
export async function decryptExport(payload, secret, { recovery = false } = {}) {
  if (payload.format !== 'spy-work-encrypted') throw new Error('Not a sealed Spy Work file.');
  const key = recovery
    ? await C.unlockWithRecoveryKey(payload.vault, secret)
    : await C.unlockWithPassphrase(payload.vault, secret);

  const out = { format: 'spy-work', version: 1 };
  for (const store of STORES) {
    out[store] = [];
    for (const row of payload.records[store] || []) out[store].push(await C.decryptJson(key, row.enc));
  }
  return out;
}

export async function importPayload(payload, { replace = false } = {}) {
  if (!payload || payload.format !== 'spy-work') throw new Error('Not a Spy Work export file.');

  if (replace) {
    await Promise.all(STORES.map(s => db.clear(s)));
    state.observations = []; state.entities = []; state.questions = [];
  }

  const seenObs = new Set(state.observations.map(o => o.id));
  const seenEntityKeys = new Set(state.entities.map(e => e.key));
  const seenQuestions = new Set(state.questions.map(q => q.id));

  const incoming = {
    entities: (payload.entities || []).filter(e => !seenEntityKeys.has(e.key)),
    observations: (payload.observations || []).filter(o => !seenObs.has(o.id)),
    questions: (payload.questions || []).filter(q => !seenQuestions.has(q.id)),
  };

  for (const store of STORES) {
    for (const row of incoming[store]) await persist(store, row);
  }

  await load();
  return { observations: incoming.observations.length, entities: incoming.entities.length, questions: incoming.questions.length };
}

export async function wipe() {
  await Promise.all(STORES.map(s => db.clear(s)));
  await load();
}
