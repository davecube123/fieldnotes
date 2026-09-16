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
  if (bracketed) return `<span class="mention">${bracketed}</span>`;
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
  const mentions = M.parseMentions(draft.body + ' ' + draft.assessment);
  const openQs = M.state.questions.filter(q => !q.answeredAt);

  view.innerHTML = `
    <form id="capture">
      <label class="field">
        <span class="lab">${draft.id ? 'Editing observation' : 'What did you observe?'}</span>
        <textarea name="body" placeholder="Fact only — what was said, seen, posted, priced.&#10;Tag with @[Maria Santos] or @BSP.">${esc(draft.body)}</textarea>
      </label>

      <div class="chips scroll" id="domain-chips">
        ${M.DOMAINS.map(d => `<button type="button" class="chip ${draft.domain === d.id ? 'on' : ''}" data-domain="${d.id}">${d.label}</button>`).join('')}
      </div>
      <div class="spacer"></div>

      ${mentions.length ? `<div class="chips">${mentions.map(n => `<span class="chip entity">@${esc(n)}</span>`).join('')}</div><div class="spacer"></div>` : ''}

      <details class="more" ${draft.assessment || draft.source || draft.followUp || draft.id ? 'open' : ''}>
        <summary>Assessment, source, grading</summary>

        <label class="field">
          <span class="lab">Your assessment — kept separate from the fact above</span>
          <textarea name="assessment" placeholder="What you think it means. Label guesses as guesses.">${esc(draft.assessment)}</textarea>
        </label>

        <label class="field">
          <span class="lab">Source — who or what told you</span>
          <input type="text" name="source" value="${esc(draft.source)}" placeholder="Person, publication, firsthand">
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
    if (t.name === 'body' || t.name === 'assessment') refreshMentionChips(mentions);
  });

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

// Cheap live feedback on which entities the text will create, without a full re-render
// (which would steal focus from the textarea mid-sentence).
function refreshMentionChips(previous) {
  const now = M.parseMentions(draft.body + ' ' + draft.assessment);
  if (now.length !== previous.length || now.some((n, i) => n !== previous[i])) {
    const active = document.activeElement;
    const pos = active && active.selectionStart;
    renderCapture();
    const again = document.querySelector(`#capture [name="${active?.name}"]`);
    if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch {} }
  }
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
      <div class="body">${withMentions(o.body)}</div>
      ${o.assessment ? `<div class="assess"><span class="tag">ASSESSMENT</span>${withMentions(o.assessment)}</div>` : ''}
      <div class="obs-foot">
        ${chips}
        <span class="chip grade ${gradeClass(o)}">${esc(o.reliability)}${esc(o.credibility)}</span>
        ${o.source ? `<span class="chip">src: ${esc(o.source)}</span>` : '<span class="chip" style="color:var(--bad)">no source</span>'}
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
  const index = M.entityIndex().filter(r => !entityQuery || r.entity.name.toLowerCase().includes(entityQuery.toLowerCase()));

  view.innerHTML = `
    <input type="search" id="ent-q" placeholder="Search entities" value="${esc(entityQuery)}">
    <div class="spacer"></div>
    <p class="tiny muted">${index.length} entities · ${index.filter(r => r.crossDomain).length} appear in more than one domain</p>
    ${index.length ? index.map(r => `
      <button class="rowitem" data-entity="${r.entity.id}">
        <span>
          <strong>${esc(r.entity.name)}</strong>
          ${r.crossDomain ? '<span class="chip cross" style="margin-left:6px">cross-domain</span>' : ''}
          <div class="meta">${r.entity.type !== 'unknown' ? esc(r.entity.type) + ' · ' : ''}${r.domains.map(d => esc(d)).join(', ') || 'no observations'}</div>
        </span>
        <span class="meta">${r.count}</span>
      </button>`).join('') : '<p class="empty">Entities appear here once you tag something with @.</p>'}`;

  const q = document.getElementById('ent-q');
  q.addEventListener('input', () => { entityQuery = q.value; renderEntities(); q.focus(); });
}

export function openEntity(id) {
  const p = M.entityProfile(id);
  if (!p.entity) return;

  openSheet(p.entity.name, `
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
      <div class="row">
        <button class="primary" type="submit">Save</button>
        <button class="ghost" type="button" id="ent-del">Delete</button>
      </div>
    </form>

    <div class="spacer"></div>
    <h2>Appears in</h2>
    <div class="chips">${p.domains.length ? p.domains.map(d => `<span class="chip dom-${d}">${esc(d)}</span>`).join('') : '<span class="muted small">nothing yet</span>'}</div>
    ${p.crossDomain ? '<p class="tiny" style="color:var(--warn);margin-top:8px">Crosses domains — the joins are where the non-obvious sits.</p>' : ''}

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

  document.getElementById('ent-form').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    await M.saveEntity({
      ...p.entity,
      name: f.get('name').trim() || p.entity.name,
      type: f.get('type'),
      aliases: f.get('aliases').split(',').map(s => s.trim()).filter(Boolean),
      notes: f.get('notes'),
    });
    closeSheet();
    render();
    toast('Entity saved.');
  });

  document.getElementById('ent-del').addEventListener('click', async () => {
    if (!confirm(`Delete "${p.entity.name}"? Its observations stay, untagged.`)) return;
    await M.deleteEntity(p.entity.id);
    closeSheet();
    render();
    toast('Entity deleted.');
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
        <textarea name="answer" style="min-height:190px" placeholder="Write it up as you learn it — the steps, who decides what, what it costs, where it stalls.&#10;&#10;Tag the people and offices involved with @[Registry of Deeds].">${esc(q.answer || '')}</textarea></label>

      ${entities.length ? `<div class="chips" style="margin-bottom:12px">${entities.map(e => `<button type="button" class="chip entity" data-entity="${e.id}">${esc(e.name)}</button>`).join('')}</div>` : ''}

      <button class="primary" type="submit">Save</button>
      <div class="spacer"></div>
      <div class="row">
        <button class="ghost" type="button" data-answer="${q.id}">${q.answeredAt ? 'Reopen' : 'Mark settled'}</button>
        <button class="ghost" type="button" data-qdel="${q.id}">Delete</button>
      </div>
    </form>

    <div class="spacer"></div>
    <h2>Evidence · ${linked.length}</h2>
    <p class="tiny muted">Observations you filed against this question. Link one by choosing it in Capture.</p>
    <div class="spacer"></div>
    ${linked.map(obsCard).join('') || '<p class="muted small">Nothing linked yet.</p>'}`);

  document.getElementById('q-edit').addEventListener('submit', async e => {
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

    ${b.newEntities.length ? `<div class="card">
      <h3>New to the file</h3>
      <div class="chips" style="margin-top:8px">${b.newEntities.map(e => `<button class="chip entity" data-entity="${e.id}">${esc(e.name)}</button>`).join('')}</div>
    </div>` : ''}

    ${b.followUps.length ? `<div class="card">
      <h3>Flagged for follow-up · ${b.followUps.length}</h3>
      ${b.followUps.slice(0, 5).map(o => `<div class="small" style="margin-top:8px">${esc(o.body.slice(0, 140))}${o.body.length > 140 ? '…' : ''}</div>`).join('')}
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
      <input type="file" id="do-import" accept=".json,.spyw,application/json">
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
    download(await M.exportEncrypted(), `spy-work-${today()}.spyw`);
    toast('Sealed backup saved.');
  });

  document.getElementById('do-export').addEventListener('click', () => {
    if (M.isEncrypted() && !confirm('This file will be readable by anyone who opens it. Continue?')) return;
    download(M.exportPlain(), `spy-work-${today()}.json`);
    toast('Exported.');
  });

  document.getElementById('do-import').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (payload.format === 'spy-work-encrypted') {
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
