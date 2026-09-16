// Data model, entity parsing and the derived views (links, streak, brief).

import * as db from './db.js';

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

export const state = { observations: [], entities: [], questions: [] };

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const normKey = name => name.trim().toLowerCase().replace(/\s+/g, ' ');

export async function load() {
  const [observations, entities, questions] = await Promise.all([
    db.getAll('observations'), db.getAll('entities'), db.getAll('questions'),
  ]);
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
    // Bare mentions allow inner dots and dashes (U.S., e-Gov) but must not swallow
    // the punctuation that ends the sentence they sit in.
    const name = (m[1] || m[2] || '').trim().replace(/[.\-_]+$/, '');
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
      await db.put('entities', entity);
      state.entities.push(entity);
    }
    if (!ids.includes(entity.id)) ids.push(entity.id);
  }
  return ids;
}

export async function saveEntity(entity) {
  entity.key = normKey(entity.name);
  await db.put('entities', entity);
  const i = state.entities.findIndex(e => e.id === entity.id);
  if (i >= 0) state.entities[i] = entity; else state.entities.push(entity);
  return entity;
}

export async function deleteEntity(id) {
  await db.del('entities', id);
  state.entities = state.entities.filter(e => e.id !== id);
  for (const o of state.observations) {
    if (o.entityIds.includes(id)) {
      o.entityIds = o.entityIds.filter(x => x !== id);
      await db.put('observations', o);
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
    questionId: draft.questionId || null,
    entityIds,
  };

  await db.put('observations', obs);
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

export async function saveQuestion(q) {
  const question = {
    id: q.id || uid(),
    text: q.text.trim(),
    createdAt: q.createdAt || new Date().toISOString(),
    answeredAt: q.answeredAt || null,
  };
  await db.put('questions', question);
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
    unsourced: recent.filter(o => !o.source).length,
  };
}

/* ---------------- import / export ---------------- */

export function exportPayload() {
  return {
    format: 'spy-work',
    version: 1,
    exportedAt: new Date().toISOString(),
    observations: state.observations,
    entities: state.entities,
    questions: state.questions,
  };
}

export async function importPayload(payload, { replace = false } = {}) {
  if (!payload || payload.format !== 'spy-work') throw new Error('Not a Spy Work export file.');

  if (replace) {
    await Promise.all([db.clear('observations'), db.clear('entities'), db.clear('questions')]);
    state.observations = []; state.entities = []; state.questions = [];
  }

  const existing = new Set(state.observations.map(o => o.id));
  const entityKeys = new Set(state.entities.map(e => e.key));
  const questionIds = new Set(state.questions.map(q => q.id));

  const entities = (payload.entities || []).filter(e => replace || !entityKeys.has(e.key));
  const observations = (payload.observations || []).filter(o => replace || !existing.has(o.id));
  const questions = (payload.questions || []).filter(q => replace || !questionIds.has(q.id));

  await Promise.all([
    db.putMany('entities', entities),
    db.putMany('observations', observations),
    db.putMany('questions', questions),
  ]);
  await load();
  return { observations: observations.length, entities: entities.length, questions: questions.length };
}

export async function wipe() {
  await Promise.all([db.clear('observations'), db.clear('entities'), db.clear('questions')]);
  await load();
}
