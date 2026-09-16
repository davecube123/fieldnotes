// All rendering and event wiring. Views are re-rendered wholesale; the data set
// a single person can type is far too small for that to matter.

import * as M from './model.js';

const view = document.getElementById('view');
const sheet = document.getElementById('sheet');
const sheetTitle = document.getElementById('sheet-title');
const sheetContent = document.getElementById('sheet-content');
const toastEl = document.getElementById('toast');

const today = () => new Date().toISOString().slice(0, 10);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Renders @[Maria Santos] and @BSP as the plain name, highlighted. The tagging
// syntax is for typing, not for reading it back.
const MENTION_RE = /@\[([^\]\n]+)\]|@([\p{L}\p{N}_.\-]+)/gu;
const withMentions = text => esc(text).replace(MENTION_RE, (_, bracketed, bare) => {
  if (bracketed !== undefined) return `<span class="mention">${bracketed}</span>`;
  const trail = bare.match(/[.\-_]+$/)?.[0] || '';
  return `<span class="mention">${bare.slice(0, bare.length - trail.length)}</span>${trail}`;
});

let currentView = 'capture';
// The domain you filed last is nearly always the one you file next.
let lastDomain = 'political';
let draft = blankDraft();
let feedQuery = '';
let feedDomains = new Set();
let entityQuery = '';
let entityFilter = 'all';
let toastTimer = null;

const AUTO_LOCK_MS = 5 * 60 * 1000;

function blankDraft() {
  return { id: null, createdAt: null, body: '', assessment: '', domain: lastDomain,
           source: '', reliability: 'F', credibility: '6', eventDate: today(), followUp: false, questionId: '' };
}

function relTime(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / 1440);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2200);
}

function openSheet(title, html) {
  sheetTitle.textContent = title;
  sheetContent.innerHTML = html;
  sheet.classList.remove('hidden');
}
export function closeSheet() { sheet.classList.add('hidden'); }

export function go(name) {
  currentView = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  render();
  window.scrollTo(0, 0);
}

export function render() {
  if (M.isLocked()) return renderLock();
  document.body.classList.remove('locked');
  document.getElementById('streak').textContent = `${M.streak()}d streak`;
  ({ capture: renderCapture, feed: renderFeed, entities: renderEntities,
     questions: renderQuestions, brief: renderBrief }[currentView])();
}

/* ======================= lock screen ======================= */

function renderLock({ recovery = false, error = '' } = {}) {
  document.body.classList.add('locked');
  document.getElementById('streak').textContent = 'locked';

  view.innerHTML = `
    <div class="card" style="margin-top:14vh">
      <h3>Locked</h3>
      <p class="small muted">This file is encrypted on this device. Nothing can be read without the passphrase.</p>
      <div class="spacer"></div>
      <form id="unlock">
        ${recovery
          ? `<label class="field"><span class="lab">Recovery key</span>
               <textarea name="secret" style="min-height:70px" placeholder="XXXX-XXXX-XXXX-XXXX-…" autocapitalize="characters"></textarea></label>`
          : `<label class="field"><span class="lab">Passphrase</span>
               <input type="password" name="secret" autocomplete="current-password"></label>`}
        <button class="primary" type="submit">Unlock</button>
      </form>
      ${error ? `<p class="small" style="color:var(--bad);margin-top:12px">${esc(error)}</p>` : ''}
      <div class="spacer"></div>
      <button class="ghost" id="toggle-recovery" style="width:100%">
        ${recovery ? 'Use passphrase instead' : 'Use recovery key instead'}
      </button>
    </div>`;

  document.getElementById('toggle-recovery')
    .addEventListener('click', () => renderLock({ recovery: !recovery }));

  document.getElementById('unlock').addEventListener('submit', async e => {
    e.preventDefault();
    const secret = e.target.elements.secret.value.trim();
    if (!secret) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      // Deliberately slow: 600k PBKDF2 rounds cost a moment here and a fortune
      // to anyone grinding guesses.
      recovery ? await M.unlockWithRecoveryKey(secret) : await M.unlock(secret);
      document.body.classList.remove('locked');
      go('brief');
    } catch {
      renderLock({ recovery, error: recovery ? 'That recovery key does not open this file.' : 'Wrong passphrase.' });
    }
  });
}

/* ======================= capture ======================= */

function renderCapture() {
  const openQs = M.state.questions.filter(q => !q.answeredAt);

  view.innerHTML = `
    <form id="capture">
      <label class="field">
        <span class="lab">${draft.id ? 'Editing observation' : 'What did you observe?'}</span>
        <textarea name="body" placeholder="A vendor's name, what someone actually said, a detail about a person.&#10;Type @ to tag whoever it concerns.">${esc(draft.body)}</textarea>
      </label>
      <div class="suggest" data-suggest-for="body"></div>

      <div class="chips scroll" id="domain-chips">
        ${M.DOMAINS.map(d => `<button type="button" class="chip ${draft.domain === d.id ? 'on' : ''}" data-domain="${d.id}">${d.label}</button>`).join('')}
      </div>
      <div class="spacer"></div>

      <div class="chips" id="mention-chips"></div>

      <details class="more" ${draft.assessment || draft.source || draft.followUp || draft.verbatim || draft.id ? 'open' : ''}>
        <summary>Assessment, source, grading</summary>

        <label class="field">
          <span class="lab">Your assessment — kept separate from the fact above</span>
          <textarea name="assessment" placeholder="What you think it means. Label guesses as guesses.">${esc(draft.assessment)}</textarea>
        </label>
        <div class="suggest" data-suggest-for="assessment"></div>

        <label class="field">
          <span class="lab">Source — who or what told you</span>
          <input type="text" name="source" value="${esc(draft.source)}" placeholder="Person, publication, firsthand">
        </label>

        <label class="field" style="display:flex;gap:10px;align-items:center">
          <input type="checkbox" name="verbatim" ${draft.verbatim ? 'checked' : ''} style="width:auto">
          <span class="small">Their exact words, not my summary</span>
        </label>

        <div class="row">
          <label class="field">
            <span class="lab">Source reliability</span>
            <select name="reliability">
              ${Object.entries(M.RELIABILITY).map(([k, v]) => `<option value="${k}" ${draft.reliability === k ? 'selected' : ''}>${k} — ${v}</option>`).join('')}
            </select>
          </label>
          <label class="field">
            <span class="lab">Claim credibility</span>
            <select name="credibility">
              ${Object.entries(M.CREDIBILITY).map(([k, v]) => `<option value="${k}" ${draft.credibility === k ? 'selected' : ''}>${k} — ${v}</option>`).join('')}
            </select>
          </label>
        </div>

        <label class="field">
          <span class="lab">When it happened</span>
          <input type="date" name="eventDate" value="${esc(draft.eventDate)}">
        </label>

        ${openQs.length ? `
        <label class="field">
          <span class="lab">Answers an open question?</span>
          <select name="questionId">
            <option value="">—</option>
            ${openQs.map(q => `<option value="${q.id}" ${draft.questionId === q.id ? 'selected' : ''}>${esc(q.text.slice(0, 70))}</option>`).join('')}
          </select>
        </label>` : ''}

        <label class="field" style="display:flex;gap:10px;align-items:center">
          <input type="checkbox" name="followUp" ${draft.followUp ? 'checked' : ''} style="width:auto">
          <span class="small">Flag for follow-up</span>
        </label>
      </details>

      <button class="primary" type="submit">${draft.id ? 'Save changes' : 'File observation'}</button>
      ${draft.id ? '<div class="spacer"></div><button type="button" class="ghost" id="cancel-edit" style="width:100%">Cancel edit</button>' : ''}
    </form>
    <p class="tiny muted" style="margin-top:16px">
      Facts above, interpretation below. Grade the source and the claim separately —
      an A source can still pass you a 5.
    </p>`;

  const form = document.getElementById('capture');

  form.addEventListener('input', e => {
    const t = e.target;
    draft[t.name] = t.type === 'checkbox' ? t.checked : t.value;
    if (t.name === 'body' || t.name === 'assessment') updateMentionChips();
  });

  for (const name of ['body', 'assessment']) {
    attachMentionAutocomplete(
      form.elements[name],
      form.querySelector(`[data-suggest-for="${name}"]`),
      () => { draft[name] = form.elements[name].value; updateMentionChips(); },
    );
  }
  updateMentionChips();

  document.getElementById('domain-chips').addEventListener('click', e => {
    const btn = e.target.closest('[data-domain]');
    if (!btn) return;
    draft.domain = btn.dataset.domain;
    document.querySelectorAll('#domain-chips .chip').forEach(c => c.classList.toggle('on', c.dataset.domain === draft.domain));
  });

  const cancel = document.getElementById('cancel-edit');
  if (cancel) cancel.addEventListener('click', () => { draft = blankDraft(); render(); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (!draft.body.trim()) return toast('Nothing to file yet.');
    await M.saveObservation(draft);
    const wasEdit = !!draft.id;
    lastDomain = draft.domain;
    draft = blankDraft();
    render();
    toast(wasEdit ? 'Updated.' : 'Filed.');
  });
}

// Live list of who this observation will be filed against.
function updateMentionChips() {
  const el = document.getElementById('mention-chips');
  if (!el) return;
  const names = M.parseMentions(`${draft.body} ${draft.assessment}`);
  el.innerHTML = names.map(n => {
    const known = M.findEntityByName(n);
    return `<span class="chip entity" ${known ? `data-entity="${known.id}"` : 'style="opacity:0.7"'}>${esc(n)}${known ? '' : ' · new'}</span>`;
  }).join('');
}

// Typing @ offers the entities you already have. Picking one inserts the exact
// stored name, which is what stops "Maria S." and "Maria Santos" becoming two
// separate people over a few months of hurried typing.
function attachMentionAutocomplete(textarea, suggestEl, onChange) {
  if (!textarea || !suggestEl) return;

  const openToken = () => {
    const upto = textarea.value.slice(0, textarea.selectionStart);
    const m = upto.match(/@\[([^\]\n]*)$/) || upto.match(/@([\p{L}\p{N}_.\-]*)$/u);
    return m ? { query: m[1], start: upto.length - m[0].length } : null;
  };

  const close = () => { suggestEl.innerHTML = ''; };

  const refresh = () => {
    const token = openToken();
    if (!token) return close();
    const matches = M.suggestEntities(token.query);
    if (!matches.length) {
      suggestEl.innerHTML = token.query
        ? `<span class="tiny muted">No match — finish typing to create “${esc(token.query)}”.</span>`
        : '';
      return;
    }
    suggestEl.innerHTML = matches
      .map(e => `<button type="button" class="chip entity" data-pick="${e.id}">${esc(e.name)}</button>`).join('');
  };

  suggestEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-pick]');
    if (!btn) return;
    const token = openToken();
    if (!token) return;
    const entity = M.entityById(btn.dataset.pick);
    const insert = `@[${entity.name}] `;
    textarea.value = textarea.value.slice(0, token.start) + insert + textarea.value.slice(textarea.selectionStart);
    const caret = token.start + insert.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    close();
    onChange();
  });

  textarea.addEventListener('input', refresh);
  textarea.addEventListener('click', refresh);
  textarea.addEventListener('blur', () => setTimeout(close, 200));
}

/* ======================= feed ======================= */

function matches(o, q) {
  if (!q) return true;
  const names = o.entityIds.map(id => M.entityById(id)?.name || '').join(' ');
  return `${o.body} ${o.assessment} ${o.source} ${names}`.toLowerCase().includes(q.toLowerCase());
}

function renderFeed() {
  const list = M.state.observations
    .filter(o => (!feedDomains.size || feedDomains.has(o.domain)) && matches(o, feedQuery));

  view.innerHTML = `
    <input type="search" id="feed-q" placeholder="Search observations, sources, entities" value="${esc(feedQuery)}">
    <div class="spacer"></div>
    <div class="chips scroll" id="feed-filters">
      ${M.DOMAINS.map(d => `<button type="button" class="chip ${feedDomains.has(d.id) ? 'on' : ''}" data-domain="${d.id}">${d.label}</button>`).join('')}
    </div>
    <div class="spacer"></div>
    <p class="tiny muted">${list.length} of ${M.state.observations.length} observations</p>
    <div id="feed-list">
      ${list.length ? list.map(obsCard).join('') : '<p class="empty">Nothing here yet. File something in Capture.</p>'}
    </div>`;

  const q = document.getElementById('feed-q');
  q.addEventListener('input', () => {
    feedQuery = q.value;
    document.getElementById('feed-list').innerHTML =
      M.state.observations.filter(o => (!feedDomains.size || feedDomains.has(o.domain)) && matches(o, feedQuery))
        .map(obsCard).join('') || '<p class="empty">No match.</p>';
  });

  document.getElementById('feed-filters').addEventListener('click', e => {
    const btn = e.target.closest('[data-domain]');
    if (!btn) return;
    const d = btn.dataset.domain;
    feedDomains.has(d) ? feedDomains.delete(d) : feedDomains.add(d);
    render();
  });
}

function gradeClass(o) {
  const score = 'ABCDEF'.indexOf(o.reliability) + (Number(o.credibility) - 1);
  return score <= 2 ? 'hi' : score <= 6 ? 'mid' : 'lo';
}

function obsCard(o) {
  const chips = o.entityIds.map(id => M.entityById(id)).filter(Boolean)
    .map(e => `<button class="chip entity" data-entity="${e.id}">${esc(e.name)}</button>`).join('');
  const q = o.questionId ? M.state.questions.find(x => x.id === o.questionId) : null;

  return `
    <article class="card obs" data-obs="${o.id}">
      <div class="obs-head">
        <span class="dom-${o.domain}">${M.DOMAINS.find(d => d.id === o.domain)?.label || o.domain}</span>
        <span>${esc(relTime(o.createdAt))}</span>
      </div>
      ${o.verbatim
        ? `<blockquote class="body quote">${withMentions(o.body)}${o.source ? `<footer>— ${esc(o.source)}</footer>` : ''}</blockquote>`
        : `<div class="body">${withMentions(o.body)}</div>`}
      ${o.assessment ? `<div class="assess"><span class="tag">ASSESSMENT</span>${withMentions(o.assessment)}</div>` : ''}
      <div class="obs-foot">
        ${chips}
        <span class="chip grade ${gradeClass(o)}">${esc(o.reliability)}${esc(o.credibility)}</span>
        ${o.source ? `<span class="chip">src: ${esc(o.source)}</span>` : '<span class="chip" style="color:var(--bad)">no source</span>'}
        ${o.verbatim ? '<span class="chip" style="color:var(--good)">verbatim</span>' : ''}
        ${o.followUp ? '<span class="chip cross">follow up</span>' : ''}
        ${q ? `<span class="chip">Q: ${esc(q.text.slice(0, 32))}</span>` : ''}
      </div>
      <div class="actions">
        <button class="ghost" data-edit="${o.id}">Edit</button>
        <button class="ghost" data-del="${o.id}">Delete</button>
      </div>
    </article>`;
}

/* ======================= entities ======================= */

function renderEntities() {
  const all = M.entityIndex();
  const index = all
    .filter(r => entityFilter !== 'subjects' || r.entity.provisional)
    .filter(r => !entityQuery || r.entity.name.toLowerCase().includes(entityQuery.toLowerCase()));
  const subjectCount = all.filter(r => r.entity.provisional).length;

  view.innerHTML = `
    <input type="search" id="ent-q" placeholder="Search entities" value="${esc(entityQuery)}">
    <div class="spacer"></div>
    <div class="chips" style="margin-bottom:12px">
      <button class="chip ${entityFilter === 'all' ? 'on' : ''}" data-entfilter="all">Everyone</button>
      <button class="chip ${entityFilter === 'subjects' ? 'on' : ''}" data-entfilter="subjects">Unidentified · ${subjectCount}</button>
      <button class="chip entity" id="new-subject">+ Track someone unnamed</button>
    </div>
    <p class="tiny muted">${index.length} shown · ${all.filter(r => r.crossDomain).length} appear in more than one domain</p>
    ${index.length ? index.map(r => `
      <button class="rowitem" data-entity="${r.entity.id}">
        <span>
          <strong>${esc(r.entity.name)}</strong>
          ${r.entity.provisional ? '<span class="chip" style="margin-left:6px;color:var(--warn)">unidentified</span>' : ''}
          ${r.crossDomain ? '<span class="chip cross" style="margin-left:6px">cross-domain</span>' : ''}
          <div class="meta">${r.entity.type !== 'unknown' ? esc(r.entity.type) + ' · ' : ''}${r.domains.map(d => esc(d)).join(', ') || 'no observations'}${(r.entity.attributes || []).length ? ` · ${r.entity.attributes.length} details` : ''}${M.relationsFor(r.entity.id).length ? ` · ${M.relationsFor(r.entity.id).length} links` : ''}</div>
        </span>
        <span class="meta">${r.count}</span>
      </button>`).join('')
      : `<p class="empty">${entityFilter === 'subjects' ? 'No unidentified subjects.' : 'Entities appear here once you tag something with @.'}</p>`}`;

  const q = document.getElementById('ent-q');
  q.addEventListener('input', () => { entityQuery = q.value; renderEntities(); q.focus(); });

  view.querySelectorAll('[data-entfilter]').forEach(btn =>
    btn.addEventListener('click', () => { entityFilter = btn.dataset.entfilter; renderEntities(); }));

  document.getElementById('new-subject').addEventListener('click', openNewSubject);
}

function openNewSubject() {
  openSheet('Track someone unnamed', `
    <p class="small muted">Give them a working name you will recognise. Everything you learn attaches to it, and when you are sure who they are, the whole file folds into that person.</p>
    <div class="spacer"></div>
    <form id="subject-form">
      <label class="field"><span class="lab">Working name</span>
        <input type="text" name="codename" placeholder="the page admin · the man in the grey pickup" autocomplete="off"></label>
      <label class="field"><span class="lab">What kind of subject</span>
        <select name="type">
          <option value="person">person</option>
          <option value="org">organisation</option>
          <option value="thing">thing</option>
        </select></label>
      <button class="primary" type="submit">Start the file</button>
    </form>
    <p class="tiny muted" style="margin-top:14px">Naming the wrong person is the real risk here, not staying unsure. Every candidate you add will ask what would prove it wrong.</p>`);

  document.getElementById('subject-form').addEventListener('submit', async e => {
    e.preventDefault();
    const codename = new FormData(e.target).get('codename').trim();
    if (!codename) return toast('Give them a working name.');
    if (M.findEntityByName(codename)) return toast('That name is already in the file.');
    const entity = await M.createSubject(codename, new FormData(e.target).get('type'));
    render();
    openEntity(entity.id);
  });
}

const confChip = id => {
  const c = M.CONFIDENCE.find(x => x.id === id) || M.CONFIDENCE[2];
  return `<span class="chip" style="color:var(--${c.tone})">${c.label}</span>`;
};

const candidateCard = ({ relation, other }) => {
  const out = relation.confidence === 'ruled_out';
  return `
    <div class="card" style="${out ? 'opacity:0.55' : ''}">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">
        <strong data-entity="${other.id}" style="flex:1">${esc(other.name)}</strong>
        ${confChip(relation.confidence)}
      </div>
      ${relation.note ? `<div class="small" style="margin-top:8px">${esc(relation.note)}</div>` : ''}
      ${relation.counter
        ? `<div class="small" style="margin-top:8px;color:var(--warn)">Would disprove: ${esc(relation.counter)}</div>`
        : '<div class="tiny" style="margin-top:8px;color:var(--bad)">Nothing recorded that would disprove this.</div>'}
      <div class="actions">
        ${out
          ? `<button class="ghost" data-reopen="${relation.id}">Put back in play</button>`
          : `<button class="ghost" data-resolve="${relation.id}">This is them</button>
             <button class="ghost" data-ruleout="${relation.id}">Rule out</button>`}
        <button class="ghost" data-reldel="${relation.id}">Remove</button>
      </div>
    </div>`;
};

const relationRow = ({ relation, other, label }) => `
  <div class="rowitem">
    <span data-entity="${other.id}" style="flex:1;min-width:0">
      <span class="muted small">${esc(label)}</span>
      <strong style="display:block">${esc(other.name)}</strong>
      ${relation.note ? `<div class="meta">${esc(relation.note)}</div>` : ''}
    </span>
    ${confChip(relation.confidence)}
    <button class="icon-btn" data-reldel="${relation.id}" aria-label="Remove connection">✕</button>
  </div>`;

const attrRows = attrs => (attrs.length ? attrs : [{ k: '', v: '' }, { k: '', v: '' }])
  .map(a => `<div class="row" style="margin-bottom:8px">
    <input type="text" name="attr-k" value="${esc(a.k)}" placeholder="phone / role / plate" style="flex:2">
    <input type="text" name="attr-v" value="${esc(a.v)}" placeholder="detail" style="flex:3">
  </div>`).join('');

let openEntityId = null;

export function openEntity(id) {
  const p = M.entityProfile(id);
  if (!p.entity) return;
  openEntityId = id;

  const attrs = (p.entity.attributes || []).filter(a => a.k || a.v);
  const candidates = p.entity.provisional ? M.candidatesFor(p.entity.id) : [];
  const connections = p.relations.filter(x => !(p.entity.provisional && x.relation.type === 'may_be'));

  openSheet(p.entity.name, `
    ${attrs.length ? `<dl class="attrs">${attrs.map(a => `<div><dt>${esc(a.k)}</dt><dd>${esc(a.v)}</dd></div>`).join('')}</dl><div class="spacer"></div>` : ''}
    ${p.entity.notes ? `<p class="small">${withMentions(p.entity.notes)}</p><div class="spacer"></div>` : ''}

    <details class="more">
      <summary>Edit details</summary>
    <form id="ent-form">
      <label class="field"><span class="lab">Name</span>
        <input type="text" name="name" value="${esc(p.entity.name)}"></label>
      <div class="row">
        <label class="field"><span class="lab">Type</span>
          <select name="type">${M.ENTITY_TYPES.map(t => `<option ${p.entity.type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label class="field"><span class="lab">Also known as (comma separated)</span>
          <input type="text" name="aliases" value="${esc((p.entity.aliases || []).join(', '))}"></label>
      </div>
      <label class="field"><span class="lab">Standing notes</span>
        <textarea name="notes" style="min-height:70px">${esc(p.entity.notes || '')}</textarea></label>

      <h2>What you have on ${esc(p.entity.name)}</h2>
      <p class="tiny muted" style="margin-bottom:8px">${p.entity.provisional
        ? 'Anything that narrows the field — vehicle, hours, dialect, where they turn up, who they arrive with. Details that would fit few people are worth more than details that fit many.'
        : 'Standing facts — role, employer, phone, plate, who they are related to. Things that stay true, as opposed to things that happened.'}</p>
      <div id="attr-rows">${attrRows(p.entity.attributes || [])}</div>
      <button class="ghost" type="button" id="attr-add" style="width:100%">Add a detail</button>

      <div class="spacer"></div>
      <div class="row">
        <button class="primary" type="submit">Save</button>
        <button class="ghost" type="button" id="ent-del">Delete</button>
      </div>
    </form>

    ${M.state.entities.length > 1 ? `
    <div class="spacer"></div>
    <form id="ent-merge" class="card">
      <h3>Same as another entry?</h3>
      <p class="tiny muted">Everything moves across and this name is kept as an alias, so old tags keep resolving.</p>
      <label class="field"><span class="lab">Fold ${esc(p.entity.name)} into</span>
        <select name="target">
          <option value="">—</option>
          ${M.state.entities.filter(e => e.id !== p.entity.id).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
        </select></label>
      <button class="ghost" type="submit" style="width:100%">Merge</button>
    </form>` : ''}
    </details>

    ${p.entity.provisional ? `
    <div class="spacer"></div>
    <h2>Who is this?</h2>
    <p class="tiny muted" style="margin-bottom:10px">Candidates, how sure you are, and what would prove each one wrong. Deciding on the wrong person is the failure that matters.</p>
    ${candidates.length ? candidates.map(candidateCard).join('') : '<p class="muted small">No candidates yet. The details above are what will eventually narrow it.</p>'}

    <details class="more">
      <summary>Add a candidate</summary>
      <form id="cand-form">
        <label class="field"><span class="lab">Who might it be — a new name is created</span>
          <input type="text" name="other" list="all-entity-names" autocomplete="off" placeholder="Name"></label>
        <label class="field"><span class="lab">How sure are you?</span>
          <select name="confidence">
            ${M.CONFIDENCE.filter(c => c.id !== 'ruled_out').map(c => `<option value="${c.id}" ${c.id === 'rumoured' ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select></label>
        <label class="field"><span class="lab">What points to them</span>
          <input type="text" name="note" placeholder="same pickup, same hours"></label>
        <label class="field"><span class="lab">What would prove this wrong</span>
          <input type="text" name="counter" placeholder="she was out of province that week"></label>
        <button class="primary" type="submit">Add candidate</button>
      </form>
    </details>` : ''}

    <div class="spacer"></div>
    <h2>Appears in</h2>
    <!-- domains -->
    <div class="chips">${p.domains.length ? p.domains.map(d => `<span class="chip dom-${d}">${esc(d)}</span>`).join('') : '<span class="muted small">nothing yet</span>'}</div>
    ${p.crossDomain ? '<p class="tiny" style="color:var(--warn);margin-top:8px">Crosses domains — the joins are where the non-obvious sits.</p>' : ''}

    <div class="spacer"></div>
    <h2>Connections</h2>
    ${connections.length ? connections.map(relationRow).join('') : '<p class="muted small">No connections recorded.</p>'}

    <details class="more">
      <summary>Add a connection</summary>
      <form id="rel-form">
        <label class="field"><span class="lab">How are they connected?</span>
          <select name="type">
            ${M.REL_TYPES.flatMap(t => t.forward === t.inverse
              ? [`<option value="${t.id}|out">${esc(p.entity.name)} ${t.forward} …</option>`]
              : [`<option value="${t.id}|out">${esc(p.entity.name)} ${t.forward} …</option>`,
                 `<option value="${t.id}|in">… ${t.forward} ${esc(p.entity.name)}</option>`]).join('')}
          </select></label>

        <label class="field"><span class="lab">The other party — a new name is created</span>
          <input type="text" name="other" list="all-entity-names" autocomplete="off" placeholder="Blue Hardware">
          <datalist id="all-entity-names">
            ${M.state.entities.filter(e => e.id !== p.entity.id).map(e => `<option value="${esc(e.name)}"></option>`).join('')}
          </datalist></label>

        <div class="row">
          <label class="field"><span class="lab">How sure are you?</span>
            <select name="confidence">
              ${M.CONFIDENCE.map(c => `<option value="${c.id}" ${c.id === 'rumoured' ? 'selected' : ''}>${c.label}</option>`).join('')}
            </select></label>
          <label class="field"><span class="lab">Note</span>
            <input type="text" name="note" placeholder="how you know"></label>
        </div>

        <button class="primary" type="submit">Add connection</button>
      </form>
    </details>

    ${p.secondDegree.length ? `
    <div class="spacer"></div>
    <h2>Two steps away</h2>
    <p class="tiny muted" style="margin-bottom:8px">Reached through someone ${esc(p.entity.name)} is already linked to.</p>
    ${p.secondDegree.slice(0, 12).map(x => `
      <div class="rowitem">
        <span data-entity="${x.other.id}" style="flex:1;min-width:0">
          <strong>${esc(x.other.name)}</strong>
          <div class="meta">via ${esc(x.via.name)} · ${esc(x.label)}</div>
        </span>
        ${confChip(x.confidence)}
      </div>`).join('')}` : ''}

    <div class="spacer"></div>
    <h2>Seen alongside</h2>
    ${p.links.length ? `<div class="chips">${p.links.map(l => `<button class="chip entity" data-entity="${l.entity.id}">${esc(l.entity.name)} ·${l.count}</button>`).join('')}</div>`
                     : '<p class="muted small">Nobody yet. Co-mentions build this.</p>'}

    ${p.questions.length ? `
    <div class="spacer"></div>
    <h2>Turns up in ${p.questions.length} question${p.questions.length > 1 ? 's' : ''}</h2>
    ${p.questions.map(q => `<button class="rowitem" data-question="${q.id}" style="display:block"><strong>${esc(q.text)}</strong></button>`).join('')}` : ''}

    <div class="spacer"></div>
    <h2>${p.observations.length} observations</h2>
    ${p.observations.map(obsCard).join('') || '<p class="muted small">None.</p>'}`);

  document.getElementById('attr-add').addEventListener('click', () => {
    document.getElementById('attr-rows').insertAdjacentHTML('beforeend', attrRows([{ k: '', v: '' }]));
  });

  document.getElementById('ent-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const keys = f.getAll('attr-k');
    const values = f.getAll('attr-v');
    await M.saveEntity({
      ...p.entity,
      name: f.get('name').trim() || p.entity.name,
      type: f.get('type'),
      aliases: f.get('aliases').split(',').map(s => s.trim()).filter(Boolean),
      notes: f.get('notes'),
      attributes: keys.map((k, i) => ({ k, v: values[i] || '' })),
    });
    closeSheet();
    render();
    toast('Saved.');
  });

  const candForm = document.getElementById('cand-form');
  if (candForm) candForm.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = f.get('other').trim();
    if (!name) return toast('Name the candidate.');
    const otherId = await M.ensureEntity(name);
    if (otherId === p.entity.id) return toast('That is the subject themselves.');
    await M.saveRelation({
      fromId: p.entity.id, toId: otherId, type: 'may_be',
      confidence: f.get('confidence'), note: f.get('note'), counter: f.get('counter'),
    });
    openEntity(p.entity.id);
    render();
    toast('Candidate added.');
  });

  document.getElementById('rel-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = f.get('other').trim();
    if (!name) return toast('Name the other party.');

    const [type, direction] = f.get('type').split('|');
    const otherId = await M.ensureEntity(name);
    if (otherId === p.entity.id) return toast('That is the same entity.');

    try {
      await M.saveRelation({
        fromId: direction === 'out' ? p.entity.id : otherId,
        toId: direction === 'out' ? otherId : p.entity.id,
        type,
        confidence: f.get('confidence'),
        note: f.get('note'),
      });
    } catch (err) {
      return toast(err.message);
    }
    openEntity(p.entity.id);
    render();
    toast('Connection added.');
  });

  const mergeForm = document.getElementById('ent-merge');
  if (mergeForm) mergeForm.addEventListener('submit', async e => {
    e.preventDefault();
    const targetId = new FormData(e.target).get('target');
    if (!targetId) return;
    const target = M.entityById(targetId);
    if (!confirm(`Fold "${p.entity.name}" into "${target.name}"? This cannot be undone.`)) return;
    await M.mergeEntities(p.entity.id, targetId);
    closeSheet();
    render();
    openEntity(targetId);
    toast('Merged.');
  });

  document.getElementById('ent-del').addEventListener('click', async () => {
    if (!confirm(`Delete "${p.entity.name}"? Its observations stay, untagged.`)) return;
    await M.deleteEntity(p.entity.id);
    closeSheet();
    render();
    toast('Entity deleted.');
  });
}

function openResolve(relationId) {
  const relation = M.state.relations.find(r => r.id === relationId);
  if (!relation) return;
  const subject = M.entityById(relation.fromId);
  const identity = M.entityById(relation.toId);
  if (!subject || !identity) return;

  openSheet('Name this subject', `
    <p class="small">You are saying <strong>${esc(subject.name)}</strong> is <strong>${esc(identity.name)}</strong>.</p>
    <div class="spacer"></div>
    <p class="small muted">Everything filed under the working name moves onto them permanently, and the other candidates are dropped. This cannot be undone from inside the app — only by restoring a backup.</p>
    ${relation.counter ? `<div class="card" style="border-color:var(--accent-dim)"><strong class="small">You said this would disprove it:</strong><div class="small" style="margin-top:6px">${esc(relation.counter)}</div><div class="tiny muted" style="margin-top:8px">Has that been checked?</div></div>` : ''}
    <form id="resolve-form">
      <label class="field"><span class="lab">What convinced you</span>
        <textarea name="reason" style="min-height:90px" placeholder="The evidence, not the hunch."></textarea></label>
      <button class="primary" type="submit">Confirm the identification</button>
      <div class="spacer"></div>
      <button class="ghost" type="button" id="resolve-cancel" style="width:100%">Not yet</button>
    </form>`);

  document.getElementById('resolve-cancel').addEventListener('click', () => openEntity(subject.id));

  document.getElementById('resolve-form').addEventListener('submit', async e => {
    e.preventDefault();
    const reason = new FormData(e.target).get('reason').trim();
    if (!reason) return toast('Write down what convinced you.');
    await M.resolveSubject(subject.id, identity.id, reason);
    render();
    openEntity(identity.id);
    toast('Identified.');
  });
}

/* ======================= questions ======================= */

function renderQuestions() {
  const open = M.state.questions.filter(q => !q.answeredAt);
  const answered = M.state.questions.filter(q => q.answeredAt);

  const row = q => {
    const linked = M.state.observations.filter(o => o.questionId === q.id).length;
    const preview = q.answer ? q.answer.replace(/\s+/g, ' ').slice(0, 110) : '';
    return `
      <button class="rowitem" data-question="${q.id}" style="display:block">
        <strong>${esc(q.text)}</strong>
        ${preview ? `<div class="meta" style="margin-top:6px;white-space:normal">${withMentions(preview)}${q.answer.length > 110 ? '…' : ''}</div>` : ''}
        <div class="obs-foot">
          ${q.answer ? `<span class="chip" style="color:var(--good)">answered ${q.answer.split(/\s+/).length} words</span>` : '<span class="chip">no answer yet</span>'}
          ${linked ? `<span class="chip">${linked} observation${linked > 1 ? 's' : ''}</span>` : ''}
          ${(q.leads || []).filter(l => l.status === 'open').length ? `<span class="chip" style="color:var(--warn)">${(q.leads || []).filter(l => l.status === 'open').length} open leads</span>` : ''}
          <span class="chip">${esc(relTime(q.updatedAt || q.createdAt))}</span>
        </div>
      </button>`;
  };

  view.innerHTML = `
    <form id="q-form" class="row" style="margin-bottom:14px">
      <input type="text" name="text" placeholder="How does … actually work?" style="flex:3">
      <button class="primary" type="submit" style="flex:1;width:auto">Add</button>
    </form>
    <p class="tiny muted">Each question holds its own answer, written up as you learn it. Standing questions also turn aimless collecting into a search — you notice answers when you are already looking for them.</p>
    <div class="spacer"></div>
    <h2>Open · ${open.length}</h2>
    ${open.map(row).join('') || '<p class="empty">No open questions.</p>'}
    ${answered.length ? `<div class="spacer"></div><h2>Settled · ${answered.length}</h2>${answered.map(row).join('')}` : ''}`;

  document.getElementById('q-form').addEventListener('submit', async e => {
    e.preventDefault();
    const input = e.target.elements.text;
    if (!input.value.trim()) return;
    const q = await M.saveQuestion({ text: input.value });
    render();
    openQuestion(q.id);
  });
}

export function openQuestion(id) {
  const q = M.state.questions.find(x => x.id === id);
  if (!q) return;
  const linked = M.state.observations.filter(o => o.questionId === q.id);
  const entities = (q.entityIds || []).map(M.entityById).filter(Boolean);

  openSheet(q.answeredAt ? 'Settled' : 'Open question', `
    <form id="q-edit">
      <label class="field"><span class="lab">The question</span>
        <input type="text" name="text" value="${esc(q.text)}"></label>

      <label class="field"><span class="lab">What you have worked out so far</span>
        <textarea name="answer" style="min-height:190px" placeholder="Write it up as you learn it — the steps, who decides what, what it costs, where it stalls.&#10;&#10;Type @ to tag the people and offices involved.">${esc(q.answer || '')}</textarea></label>
      <div class="suggest" data-suggest-for="answer"></div>

      ${entities.length ? `<div class="chips" style="margin-bottom:12px">${entities.map(e => `<button type="button" class="chip entity" data-entity="${e.id}">${esc(e.name)}</button>`).join('')}</div>` : ''}

      <button class="primary" type="submit">Save</button>
      <div class="spacer"></div>
      <div class="row">
        <button class="ghost" type="button" data-answer="${q.id}">${q.answeredAt ? 'Reopen' : 'Mark settled'}</button>
        <button class="ghost" type="button" data-qdel="${q.id}">Delete</button>
      </div>
    </form>

    <div class="spacer"></div>
    <h2>Leads and loose ends</h2>
    <p class="tiny muted" style="margin-bottom:10px">Half-facts, hearsay and things to check. Tap the tag to move a lead along.</p>
    <div class="row" style="margin-bottom:12px">
      <input type="text" id="lead-text" placeholder="heard the fee is 2% — unconfirmed" style="flex:3" autocomplete="off">
      <button class="ghost" id="lead-add" style="flex:1;width:auto">Add</button>
    </div>
    ${(q.leads || []).length ? (q.leads || []).map(l => `
      <div class="rowitem" style="${l.status === 'dead end' ? 'opacity:0.5' : ''}">
        <span style="flex:1;min-width:0">${withMentions(l.text)}</span>
        <button class="chip" data-leadcycle="${l.id}" style="color:var(--${l.status === 'checked out' ? 'good' : l.status === 'dead end' ? 'muted' : 'warn'})">${esc(l.status)}</button>
        <button class="icon-btn" data-leaddel="${l.id}" aria-label="Remove lead">✕</button>
      </div>`).join('') : '<p class="muted small">Nothing outstanding.</p>'}

    <div class="spacer"></div>
    <h2>Evidence · ${linked.length}</h2>
    <p class="tiny muted">Observations you filed against this question. Link one by choosing it in Capture.</p>
    <div class="spacer"></div>
    ${linked.map(obsCard).join('') || '<p class="muted small">Nothing linked yet.</p>'}`);

  const addLead = async () => {
    const input = document.getElementById('lead-text');
    const text = input.value.trim();
    if (!text) return;
    const form = new FormData(document.getElementById('q-edit'));
    await M.saveQuestion({
      ...q, text: form.get('text'), answer: form.get('answer'),
      leads: [...(q.leads || []), { text }],
    });
    render();
    openQuestion(q.id);
  };
  document.getElementById('lead-add').addEventListener('click', addLead);
  document.getElementById('lead-text').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addLead(); }
  });

  sheetContent.querySelectorAll('[data-leadcycle], [data-leaddel]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const id = btn.dataset.leadcycle || btn.dataset.leaddel;
      const leads = btn.dataset.leaddel
        ? (q.leads || []).filter(l => l.id !== id)
        : (q.leads || []).map(l => l.id === id
            ? { ...l, status: M.LEAD_STATES[(M.LEAD_STATES.indexOf(l.status) + 1) % M.LEAD_STATES.length] }
            : l);
      await M.saveQuestion({ ...q, leads });
      render();
      openQuestion(q.id);
    }));

  const qForm = document.getElementById('q-edit');
  attachMentionAutocomplete(qForm.elements.answer, qForm.querySelector('[data-suggest-for="answer"]'), () => {});

  qForm.addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    await M.saveQuestion({ ...q, text: f.get('text'), answer: f.get('answer') });
    closeSheet();
    render();
    toast('Saved.');
  });
}

/* ======================= brief ======================= */

function renderBrief() {
  const b = M.brief(7);
  const max = Math.max(1, ...b.byDomain.map(d => d.count));

  view.innerHTML = `
    <div class="stats">
      ${stat(b.streak, 'day streak')}
      ${stat(b.recent.length, 'this week')}
      ${stat(b.total, 'total')}
      ${stat(M.state.entities.length, 'entities')}
      ${stat(b.crossDomain.length, 'cross-domain')}
      ${stat(b.openQuestions.length, 'open Qs')}
    </div>

    ${nagCards()}

    ${b.recent.length ? '' : '<div class="card"><strong>Quiet week.</strong><div class="small muted" style="margin-top:6px">One observation a day beats a burst every month. The system only pays out if it is fed.</div></div>'}

    ${b.byDomain.length ? `<div class="card">
      <h3>Where you looked</h3>
      ${b.byDomain.map(d => `
        <div style="margin-top:8px">
          <div class="tiny"><span class="dom-${d.id}">${d.label}</span> · ${d.count}</div>
          <div class="bar"><i style="width:${Math.round(d.count / max * 100)}%"></i></div>
        </div>`).join('')}
      ${b.byDomain.length === 1 ? '<p class="tiny muted" style="margin-top:10px">Single domain this week. Connections need at least two.</p>' : ''}
    </div>` : ''}

    ${b.crossDomain.length ? `<div class="card">
      <h3>Crossing domains</h3>
      <p class="tiny muted">These showed up in unrelated domains. Ask why.</p>
      <div class="chips" style="margin-top:8px">
        ${b.crossDomain.slice(0, 12).map(p => `<button class="chip cross" data-entity="${p.entity.id}">${esc(p.entity.name)} · ${p.domains.join('/')}</button>`).join('')}
      </div>
    </div>` : ''}

    ${b.hot.length ? `<div class="card">
      <h3>Most active this week</h3>
      <div class="chips" style="margin-top:8px">
        ${b.hot.map(h => `<button class="chip entity" data-entity="${h.profile.entity.id}">${esc(h.profile.entity.name)} ·${h.recentCount}</button>`).join('')}
      </div>
    </div>` : ''}

    ${b.subjects.length ? `<div class="card">
      <h3>Unidentified · ${b.subjects.length}</h3>
      ${b.subjects.map(sub => `
        <div class="small" style="margin-top:8px">
          <button class="chip entity" data-entity="${sub.entity.id}">${esc(sub.entity.name)}</button>
          <span class="muted tiny">${sub.observations} observation${sub.observations === 1 ? '' : 's'} · ${sub.candidates} candidate${sub.candidates === 1 ? '' : 's'} in play</span>
        </div>`).join('')}
      ${b.subjects.some(sub => !sub.candidates && sub.observations >= 3) ? '<p class="tiny muted" style="margin-top:10px">A subject with material but no candidate usually means you have not yet asked who it could be.</p>' : ''}
    </div>` : ''}

    ${b.newRelations.length ? `<div class="card">
      <h3>New connections</h3>
      ${b.newRelations.slice(0, 8).map(r => {
        const from = M.entityById(r.fromId), to = M.entityById(r.toId);
        return from && to
          ? `<div class="small" style="margin-top:8px"><button class="chip entity" data-entity="${from.id}">${esc(from.name)}</button>
             <span class="muted">${esc(M.relType(r.type).forward)}</span>
             <button class="chip entity" data-entity="${to.id}">${esc(to.name)}</button> ${confChip(r.confidence)}</div>`
          : '';
      }).join('')}
    </div>` : ''}

    ${b.unconfirmedRelations.length >= 3 ? `<div class="card">
      <h3>${b.unconfirmedRelations.length} connections still rumoured</h3>
      <p class="small muted">Unchased rumour is what turns a file into gossip. Confirm them or mark them dead.</p>
    </div>` : ''}

    ${b.newEntities.length ? `<div class="card">
      <h3>New to the file</h3>
      <div class="chips" style="margin-top:8px">${b.newEntities.map(e => `<button class="chip entity" data-entity="${e.id}">${esc(e.name)}</button>`).join('')}</div>
    </div>` : ''}

    ${b.followUps.length ? `<div class="card">
      <h3>Flagged for follow-up · ${b.followUps.length}</h3>
      ${b.followUps.slice(0, 5).map(o => `<div class="small" style="margin-top:8px">${esc(o.body.slice(0, 140))}${o.body.length > 140 ? '…' : ''}</div>`).join('')}
    </div>` : ''}

    ${b.openLeads.length ? `<div class="card">
      <h3>Leads to chase · ${b.openLeads.length}</h3>
      ${b.openLeads.slice(0, 8).map(({ question, lead }) => `
        <div class="small" style="margin-top:8px">
          ${withMentions(lead.text)}
          <div class="tiny muted">${esc(question.text)}</div>
        </div>`).join('')}
    </div>` : ''}

    ${b.openQuestions.length ? `<div class="card">
      <h3>Still unanswered</h3>
      ${b.openQuestions.slice(0, 8).map(q => `<div class="small" style="margin-top:8px"><button class="chip entity" data-question="${q.id}" style="white-space:normal;text-align:left">${esc(q.text)}</button></div>`).join('')}
    </div>` : ''}

    ${b.answeredRecently.length ? `<div class="card">
      <h3>Settled this week</h3>
      ${b.answeredRecently.map(q => `<div class="small" style="margin-top:6px">· ${esc(q.text)}</div>`).join('')}
    </div>` : ''}

    ${b.unsourced ? `<div class="card"><h3>Hygiene</h3><p class="small muted">${b.unsourced} of this week's observations have no source recorded. In six months you will not remember where they came from.</p></div>` : ''}

    <button class="ghost" id="copy-brief" style="width:100%">Copy brief as text</button>`;

  document.getElementById('copy-brief').addEventListener('click', async () => {
    const text = briefText(b);
    try {
      await navigator.clipboard.writeText(text);
      toast('Brief copied.');
    } catch {
      openSheet('Brief', `<textarea style="min-height:50vh">${esc(text)}</textarea>`);
    }
  });
}

function nagCards() {
  const cards = [];
  if (!M.isEncrypted()) {
    cards.push(`<div class="card" style="border-color:var(--accent-dim)">
      <h3>Not encrypted</h3>
      <p class="small muted">Anyone who picks up this unlocked phone can read everything here.</p>
      <div class="spacer"></div>
      <button class="ghost" data-open="security" style="width:100%">Set a passphrase</button>
    </div>`);
  }
  const age = M.daysSinceBackup();
  if (age === null || age >= 7) {
    cards.push(`<div class="card">
      <h3>${age === null ? 'Never backed up' : `Last backup ${age} days ago`}</h3>
      <p class="small muted">One device is not storage. Clear this site's data and the file is gone.</p>
      <div class="spacer"></div>
      <button class="ghost" data-open="data" style="width:100%">Back up now</button>
    </div>`);
  }
  return cards.join('');
}

const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;

function briefText(b) {
  const lines = [
    `BRIEF — ${new Date().toLocaleDateString()} (last ${b.days} days)`,
    ``,
    `${b.recent.length} new observations · ${b.total} total · ${M.state.entities.length} entities · ${b.streak}-day streak`,
  ];
  if (b.byDomain.length) lines.push(``, `Coverage: ${b.byDomain.map(d => `${d.label} ${d.count}`).join(', ')}`);
  if (b.crossDomain.length) lines.push(``, `Crossing domains:`, ...b.crossDomain.slice(0, 10).map(p => `  - ${p.entity.name} (${p.domains.join(', ')})`));
  if (b.newEntities.length) lines.push(``, `New entities: ${b.newEntities.map(e => e.name).join(', ')}`);
  if (b.recent.length) {
    lines.push(``, `Observations:`);
    for (const o of b.recent) {
      lines.push(`  [${o.domain}] ${o.body}`);
      if (o.assessment) lines.push(`      assessment: ${o.assessment}`);
      lines.push(`      ${o.source || 'no source'} (${o.reliability}${o.credibility})`);
    }
  }
  if (b.openQuestions.length) lines.push(``, `Open questions:`, ...b.openQuestions.map(q => `  - ${q.text}`));
  return lines.join('\n');
}

/* ======================= data sheet ======================= */

let pendingImport = null;

export function openData() {
  const age = M.daysSinceBackup();
  openSheet('Backup', `
    <p class="small muted">
      ${M.isEncrypted()
        ? 'A sealed file is encrypted with your passphrase. It is safe to put in cloud storage, email it to yourself, or commit it to a repo — none of those can read it.'
        : 'Encryption is off, so an export is plain readable text. Turn on a passphrase first if this file is sensitive.'}
    </p>
    <div class="spacer"></div>
    ${M.isEncrypted()
      ? '<button class="primary" id="do-export-sealed" style="width:100%">Export sealed backup (.spyw)</button><div class="spacer"></div>'
      : ''}
    <button class="ghost" id="do-export" style="width:100%">Export plain JSON${M.isEncrypted() ? ' (unprotected)' : ''}</button>
    <p class="tiny muted" style="margin-top:8px">
      ${age === null ? 'No backup taken yet.' : `Last backup ${age === 0 ? 'today' : age + ' days ago'}.`}
    </p>

    <div class="spacer"></div>
    <label class="field">
      <span class="lab">Restore from a backup (merges; nothing is overwritten)</span>
      <input type="file" id="do-import" accept=".json,.fnotes,.spyw,application/json">
    </label>
    <div id="import-unlock"></div>

    <div class="spacer"></div>
    <div id="storage-status" class="tiny muted"></div>

    <div class="spacer"></div>
    <button class="ghost" id="open-security" style="width:100%">Security…</button>
    <div class="spacer"></div>
    <button class="ghost" id="do-wipe" style="width:100%;color:var(--bad)">Erase all data on this device</button>
    <div class="spacer"></div>
    <p class="tiny muted">${M.state.observations.length} observations · ${M.state.entities.length} entities · ${M.state.questions.length} questions${M.isEncrypted() ? ' · encrypted' : ''}</p>`);

  const download = (data, name) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const sealed = document.getElementById('do-export-sealed');
  if (sealed) sealed.addEventListener('click', async () => {
    download(await M.exportEncrypted(), `fieldnotes-${today()}.fnotes`);
    toast('Sealed backup saved.');
  });

  document.getElementById('do-export').addEventListener('click', () => {
    if (M.isEncrypted() && !confirm('This file will be readable by anyone who opens it. Continue?')) return;
    download(M.exportPlain(), `fieldnotes-${today()}.json`);
    toast('Exported.');
  });

  document.getElementById('do-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (String(payload.format).endsWith('-encrypted')) {
        pendingImport = payload;
        return renderImportUnlock();
      }
      await applyImport(payload);
    } catch (err) {
      toast(err.message || 'Could not read that file.');
    }
  });

  showStorageStatus();
  document.getElementById('open-security').addEventListener('click', openSecurity);

  document.getElementById('do-wipe').addEventListener('click', async () => {
    if (!confirm('Erase every observation, entity and question on this device? Backups elsewhere are untouched.')) return;
    await M.wipe();
    closeSheet();
    render();
    toast('Erased.');
  });
}

// Whether the browser has promised not to evict this origin. "Best-effort" means
// it can be cleared to reclaim disk; installing to the home screen usually flips it.
async function showStorageStatus() {
  const el = document.getElementById('storage-status');
  if (!el || !navigator.storage?.persisted) return;
  try {
    const durable = await navigator.storage.persisted();
    const { usage } = (await navigator.storage.estimate?.()) || {};
    el.innerHTML = `Storage: <strong style="color:var(--${durable ? 'good' : 'warn'})">${durable ? 'persistent' : 'best-effort'}</strong>` +
      `${usage ? ` · ${(usage / 1024).toFixed(0)} KB used` : ''}` +
      `${durable ? '' : ' — install to the home screen to make it persistent.'}`;
  } catch {}
}

function renderImportUnlock(error = '', recovery = false) {
  document.getElementById('import-unlock').innerHTML = `
    <div class="card">
      <h3>Sealed backup</h3>
      <p class="small muted">Opens with whatever passphrase was in force when it was written.</p>
      <label class="field"><span class="lab">${recovery ? 'Recovery key' : 'Passphrase'}</span>
        <input type="${recovery ? 'text' : 'password'}" id="import-secret"></label>
      <div class="row">
        <button class="primary" id="import-go">Restore</button>
        <button class="ghost" id="import-toggle">${recovery ? 'Passphrase' : 'Recovery key'}</button>
      </div>
      ${error ? `<p class="small" style="color:var(--bad);margin-top:10px">${esc(error)}</p>` : ''}
    </div>`;

  document.getElementById('import-toggle').addEventListener('click', () => renderImportUnlock('', !recovery));
  document.getElementById('import-go').addEventListener('click', async () => {
    const secret = document.getElementById('import-secret').value.trim();
    if (!secret) return;
    try {
      await applyImport(await M.decryptExport(pendingImport, secret, { recovery }));
    } catch {
      renderImportUnlock(recovery ? 'That recovery key does not open this backup.' : 'Wrong passphrase for this backup.', recovery);
    }
  });
}

async function applyImport(payload) {
  const result = await M.importPayload(payload);
  pendingImport = null;
  closeSheet();
  render();
  toast(`Restored ${result.observations} observations.`);
}

/* ======================= security ======================= */

export function openSecurity() {
  if (!M.isEncrypted()) return renderSetupPassphrase();

  openSheet('Security', `
    <p class="small muted">This file is encrypted with AES-256. The key is derived from your passphrase on this device and is never stored anywhere.</p>

    <div class="spacer"></div>
    <button class="ghost" id="lock-now" style="width:100%">Lock now</button>

    <div class="spacer"></div>
    <form id="change-pass" class="card">
      <h3>Change passphrase</h3>
      <label class="field"><span class="lab">Current</span><input type="password" name="current"></label>
      <label class="field"><span class="lab">New</span><input type="password" name="next"></label>
      <button class="primary" type="submit">Change</button>
      <p class="tiny muted" style="margin-top:10px">Your existing recovery key keeps working — it unwraps the same underlying key.</p>
    </form>

    <form id="disable-enc" class="card">
      <h3>Turn encryption off</h3>
      <p class="small muted">Everything is rewritten as plain text on this device.</p>
      <label class="field"><span class="lab">Confirm passphrase</span><input type="password" name="passphrase"></label>
      <button class="ghost" type="submit" style="width:100%;color:var(--bad)">Turn off</button>
    </form>`);

  document.getElementById('lock-now').addEventListener('click', () => {
    M.lock();
    closeSheet();
    render();
  });

  document.getElementById('change-pass').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get('next').length < 8) return toast('Use at least 8 characters.');
    try {
      await M.changePassphrase(f.get('current'), f.get('next'));
      closeSheet();
      toast('Passphrase changed.');
    } catch {
      toast('Current passphrase is wrong.');
    }
  });

  document.getElementById('disable-enc').addEventListener('submit', async e => {
    e.preventDefault();
    if (!confirm('Turn off encryption? Anyone with this phone will be able to read the file.')) return;
    try {
      await M.disableEncryption(new FormData(e.target).get('passphrase'));
      closeSheet();
      render();
      toast('Encryption off.');
    } catch {
      toast('Wrong passphrase.');
    }
  });
}

function renderSetupPassphrase(error = '') {
  openSheet('Set a passphrase', `
    <p class="small muted">Everything already filed gets re-written encrypted. A long phrase you will not forget beats a short clever one — length is what makes guessing hopeless.</p>
    <div class="spacer"></div>
    <form id="setup-pass">
      <label class="field"><span class="lab">Passphrase (8 characters minimum)</span>
        <input type="password" name="passphrase" autocomplete="new-password"></label>
      <label class="field"><span class="lab">Again</span>
        <input type="password" name="confirm" autocomplete="new-password"></label>
      <button class="primary" type="submit">Encrypt this file</button>
    </form>
    ${error ? `<p class="small" style="color:var(--bad);margin-top:12px">${esc(error)}</p>` : ''}
    <p class="tiny muted" style="margin-top:14px">There is no reset. Forget the passphrase and lose the recovery key, and the file is unreadable — by you, by me, by anyone.</p>`);

  document.getElementById('setup-pass').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const passphrase = f.get('passphrase');
    if (passphrase.length < 8) return renderSetupPassphrase('Too short — at least 8 characters.');
    if (passphrase !== f.get('confirm')) return renderSetupPassphrase('The two entries do not match.');

    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Encrypting…';
    const recoveryKey = await M.enableEncryption(passphrase);
    showRecoveryKey(recoveryKey);
  });
}

function showRecoveryKey(key) {
  openSheet('Write this down', `
    <p class="small">This is the only way back in if you forget your passphrase. It is shown once and is not stored anywhere in readable form.</p>
    <div class="spacer"></div>
    <div class="card" style="font-family:ui-monospace,monospace;font-size:17px;letter-spacing:0.06em;word-break:break-all;text-align:center;color:var(--accent)">${esc(key)}</div>
    <button class="ghost" id="copy-recovery" style="width:100%">Copy</button>
    <div class="spacer"></div>
    <p class="small muted">Put it somewhere that is not this phone: paper, a password manager, a safe. Not a note in the same phone that holds the file.</p>
    <div class="spacer"></div>
    <button class="primary" id="recovery-done" style="width:100%">I have written it down</button>`);

  document.getElementById('copy-recovery').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(key); toast('Copied.'); } catch { toast('Copy failed — write it by hand.'); }
  });
  document.getElementById('recovery-done').addEventListener('click', () => {
    closeSheet();
    render();
    toast('Encrypted.');
  });
}

/* ======================= delegated events ======================= */

export function wireGlobalEvents() {
  document.body.addEventListener('click', async e => {
    const entity = e.target.closest('[data-entity]');
    if (entity) return openEntity(entity.dataset.entity);

    const question = e.target.closest('[data-question]');
    if (question) return openQuestion(question.dataset.question);

    const open = e.target.closest('[data-open]');
    if (open) return open.dataset.open === 'security' ? openSecurity() : openData();

    const edit = e.target.closest('[data-edit]');
    if (edit) {
      const o = M.state.observations.find(x => x.id === edit.dataset.edit);
      if (o) {
        draft = { ...o, credibility: String(o.credibility), questionId: o.questionId || '' };
        closeSheet();
        go('capture');
      }
      return;
    }

    const del = e.target.closest('[data-del]');
    if (del) {
      if (!confirm('Delete this observation?')) return;
      await M.deleteObservation(del.dataset.del);
      closeSheet();
      render();
      return toast('Deleted.');
    }

    const answer = e.target.closest('[data-answer]');
    if (answer) {
      const q = M.state.questions.find(x => x.id === answer.dataset.answer);
      if (q) await M.saveQuestion({ ...q, answeredAt: q.answeredAt ? null : new Date().toISOString() });
      closeSheet();
      return render();
    }

    const resolve = e.target.closest('[data-resolve]');
    if (resolve) return openResolve(resolve.dataset.resolve);

    const setConfidence = e.target.closest('[data-ruleout], [data-reopen]');
    if (setConfidence) {
      const id = setConfidence.dataset.ruleout || setConfidence.dataset.reopen;
      const relation = M.state.relations.find(r => r.id === id);
      if (!relation) return;
      await M.saveRelation({ ...relation, confidence: setConfidence.dataset.ruleout ? 'ruled_out' : 'rumoured' });
      render();
      if (openEntityId) openEntity(openEntityId);
      return;
    }

    const reldel = e.target.closest('[data-reldel]');
    if (reldel) {
      if (!confirm('Remove this connection?')) return;
      await M.deleteRelation(reldel.dataset.reldel);
      render();
      if (openEntityId && !sheet.classList.contains('hidden')) openEntity(openEntityId);
      return;
    }

    const qdel = e.target.closest('[data-qdel]');
    if (qdel) {
      if (!confirm('Delete this question and the answer written into it?')) return;
      await M.deleteQuestion(qdel.dataset.qdel);
      closeSheet();
      return render();
    }
  });

  // Auto-lock: walking away from the phone should not leave the file open.
  let hiddenSince = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenSince = Date.now();
    } else if (hiddenSince && M.isEncrypted() && !M.isLocked() && Date.now() - hiddenSince > AUTO_LOCK_MS) {
      M.lock();
      closeSheet();
      render();
    }
  });

  sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });
  document.getElementById('sheet-close').addEventListener('click', closeSheet);
  document.getElementById('btn-data').addEventListener('click', openData);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => go(t.dataset.view)));
}
