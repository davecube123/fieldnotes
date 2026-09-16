// End-to-end checks against a real browser. The app has no build step and no
// runtime dependencies; these tests are the one place playwright-core is needed.
//
//   python3 -m http.server 8099 &
//   npm i playwright-core && node tools/test/browser.mjs
//
// CHROME can point at any Chromium build.

import { chromium } from 'playwright-core';

const URL = process.env.URL || 'http://localhost:8099/index.html';
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PASSPHRASE = 'correct horse battery staple';

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function session(title, fn) {
  console.log(`\n${title}`);
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(URL);
  await page.waitForSelector('#capture');
  try {
    await fn(page);
  } finally {
    check('no console or page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }
}

const file = async (page, body, opts = {}) => {
  await page.click('.tab[data-view=capture]');
  await page.fill('textarea[name=body]', body);
  if (opts.domain) await page.click(`[data-domain=${opts.domain}]`);
  if (opts.source || opts.verbatim) {
    await page.click('details.more > summary');
    if (opts.source) await page.fill('input[name=source]', opts.source);
    if (opts.verbatim) await page.check('input[name=verbatim]');
  }
  await page.click('button.primary[type=submit]');
  await page.waitForTimeout(250);
};

/* ---------------------------------------------------------------- */

await session('Capture, entities and cross-domain detection', async page => {
  await file(page, 'Port fees up 12% Monday, per @[Maria Santos] at @PPA.', { domain: 'price' });
  await file(page, '@[Maria Santos] appointed to the transport board.', { domain: 'political' });

  await page.click('.tab[data-view=feed]');
  check('both observations listed', await page.locator('article.obs').count() === 2);

  await page.click('.tab[data-view=entities]');
  check('entities created from mentions', await page.locator('.rowitem').count() === 2);
  check('cross-domain entity flagged', await page.locator('.rowitem .chip.cross').count() === 1);

  await page.click('.tab[data-view=brief]');
  const brief = await page.locator('#view').textContent();
  check('brief surfaces the crossing', brief.includes('Crossing domains'));
  check('brief nags about backups', brief.includes('Never backed up'));
  check('brief nags about encryption', brief.includes('Not encrypted'));

  await page.reload();
  await page.waitForTimeout(600);
  check('data survives reload', await page.evaluate(() => window.spy.model.state.observations.length) === 2);
});

await session('Mentions, quotes, attributes and merging', async page => {
  await file(page, 'Buys cement from @[Rosa Dimaano] on the corner.');

  await page.type('textarea[name=body]', 'Saw @ros');
  await page.waitForTimeout(250);
  check('autocomplete offers a known entity',
    (await page.locator('.suggest [data-pick]').first().textContent()) === 'Rosa Dimaano');
  await page.locator('.suggest [data-pick]').first().click();
  check('picking inserts the stored spelling',
    (await page.inputValue('textarea[name=body]')).includes('@[Rosa Dimaano] '));

  await file(page, '@[Rosa Dimaano]: "the permit stops at the clerk, never reaches the mayor".',
    { source: 'Rosa, over coffee', verbatim: true });
  await page.click('.tab[data-view=feed]');
  check('verbatim renders as a quote', await page.locator('blockquote.quote').count() === 1);
  check('quote is attributed', (await page.locator('blockquote.quote footer').textContent()).includes('Rosa'));
  check('tag syntax is not shown raw', !(await page.locator('blockquote.quote').textContent()).includes('@['));

  await page.click('.tab[data-view=entities]');
  await page.locator('.rowitem').first().click();
  await page.locator('#sheet-content summary', { hasText: 'Edit details' }).click();
  await page.fill('#ent-form input[name=aliases]', 'Rosa D.');
  const k = page.locator('#attr-rows input[name="attr-k"]');
  const v = page.locator('#attr-rows input[name="attr-v"]');
  await k.nth(0).fill('role'); await v.nth(0).fill('hardware supplier');
  await k.nth(1).fill('phone'); await v.nth(1).fill('0917-555-0142');
  await page.click('#ent-form button.primary');
  await page.waitForTimeout(300);

  await page.locator('.rowitem').first().click();
  await page.waitForTimeout(200);
  const card = await page.locator('#sheet-content').textContent();
  check('standing details read back on her card',
    card.includes('hardware supplier') && card.includes('0917-555-0142'));
  await page.click('#sheet-close');

  await file(page, 'Quoted a price to @[Rosa D.] today.');
  check('an alias resolves instead of creating a twin',
    await page.evaluate(() => window.spy.model.state.entities.filter(e => e.name.includes('Rosa')).length) === 1);

  await file(page, 'Note about @[Rosa Dimano] — misspelt.');
  const merged = await page.evaluate(async () => {
    const M = window.spy.model;
    const dupe = M.state.entities.find(e => e.name === 'Rosa Dimano');
    const real = M.state.entities.find(e => e.name === 'Rosa Dimaano');
    await M.mergeEntities(dupe.id, real.id);
    const p = M.entityProfile(real.id);
    return { count: M.state.entities.length, obs: p.observations.length, aliases: p.entity.aliases, attrs: p.entity.attributes.length };
  });
  check('merge folds the duplicate away', merged.count === 1);
  check('merge keeps every observation', merged.obs === 4, `got ${merged.obs}`);
  check('merge keeps the old spelling as an alias', merged.aliases.includes('Rosa Dimano'));
  check('merge keeps the standing details', merged.attrs === 2);
});

await session('Relationships between entities', async page => {
  await file(page, 'Blue Hardware on Rizal St has no owner name on the signage. @[Blue Hardware]');
  await file(page, 'Cement delivered by @[Rosa Dimaano] to the same shop.');

  // record the ownership the way you actually learn it: as rumour first
  await page.click('.tab[data-view=entities]');
  await page.locator('.rowitem', { hasText: 'Blue Hardware' }).first().click();
  await page.waitForTimeout(250);
  await page.locator('#sheet-content summary', { hasText: 'Add a connection' }).click();
  await page.selectOption('#rel-form select[name=type]', 'owns|in');
  await page.fill('#rel-form input[name=other]', 'Rosa Dimaano');
  await page.selectOption('#rel-form select[name=confidence]', 'rumoured');
  await page.fill('#rel-form input[name=note]', 'the clerk implied it');
  await page.click('#rel-form button.primary');
  await page.waitForTimeout(400);

  const shop = await page.locator('#sheet-content').textContent();
  check('link reads correctly from this end', shop.includes('is owned by') && shop.includes('Rosa Dimaano'));
  check('uncertainty is recorded, not hidden', shop.includes('Rumoured'));

  // the same record must read correctly from the other side
  await page.click('#sheet-content [data-entity] >> nth=0');
  await page.waitForTimeout(300);
  check('link reverses on the other entity',
    (await page.locator('#sheet-content').textContent()).includes('owns'));

  // a second hop: Rosa's family should surface from the shop's card
  await page.locator('#sheet-content summary', { hasText: 'Add a connection' }).click();
  await page.selectOption('#rel-form select[name=type]', 'family|out');
  await page.fill('#rel-form input[name=other]', 'Ernesto Dimaano');
  await page.selectOption('#rel-form select[name=confidence]', 'confirmed');
  await page.click('#rel-form button.primary');
  await page.waitForTimeout(400);
  check('a new party is created by name',
    await page.evaluate(() => window.spy.model.state.entities.some(e => e.name === 'Ernesto Dimaano')));

  const hops = await page.evaluate(() => {
    const M = window.spy.model;
    const shop = M.state.entities.find(e => e.name === 'Blue Hardware');
    return M.secondDegree(shop.id).map(x => `${x.other.name} via ${x.via.name}`);
  });
  check('two steps away finds the owner\'s family', hops.some(h => h.startsWith('Ernesto Dimaano via Rosa')), hops.join('; '));

  await page.click('#sheet-close');
  await page.click('.tab[data-view=brief]');
  await page.waitForTimeout(250);
  check('brief reports new connections',
    (await page.locator('#view').textContent()).includes('New connections'));

  // merging must not orphan or self-link relations
  const merged = await page.evaluate(async () => {
    const M = window.spy.model;
    await M.saveObservation({ body: 'note about @[Rosa Dimano]', domain: 'other' });
    const dupe = M.state.entities.find(e => e.name === 'Rosa Dimano');
    const real = M.state.entities.find(e => e.name === 'Rosa Dimaano');
    await M.mergeEntities(dupe.id, real.id);
    return { relations: M.state.relations.length, selfLinks: M.state.relations.filter(r => r.fromId === r.toId).length,
             dangling: M.state.relations.filter(r => !M.entityById(r.fromId) || !M.entityById(r.toId)).length };
  });
  check('relations survive a merge intact', merged.relations === 2, JSON.stringify(merged));
  check('merge creates no self-links or dangling ends', merged.selfLinks === 0 && merged.dangling === 0);

  // deleting an entity takes its links with it
  const afterDelete = await page.evaluate(async () => {
    const M = window.spy.model;
    await M.deleteEntity(M.state.entities.find(e => e.name === 'Ernesto Dimaano').id);
    return M.state.relations.filter(r => !M.entityById(r.fromId) || !M.entityById(r.toId)).length;
  });
  check('deleting an entity leaves no dangling links', afterDelete === 0);
});

await session('Tracking an unidentified subject to a name', async page => {
  await page.click('.tab[data-view=entities]');
  await page.click('#new-subject');
  await page.fill('#subject-form input[name=codename]', 'the page admin');
  await page.click('#subject-form button.primary');
  await page.waitForTimeout(400);
  check('subject card opens on creation',
    (await page.locator('#sheet-content').textContent()).includes('Who is this?'));
  await page.click('#sheet-close');

  await file(page, 'The @[the page admin] posts council agendas hours before they are published.');
  await file(page, '@[the page admin] used the phrase "per our last executive session".', { verbatim: true, source: 'the page itself' });

  await page.click('.tab[data-view=entities]');
  await page.click('[data-entfilter=subjects]');
  check('unidentified filter isolates subjects', await page.locator('.rowitem').count() === 1);
  await page.locator('.rowitem').first().click();
  await page.waitForTimeout(300);

  // two candidates, each with what would kill the theory
  for (const [name, conf, why, counter] of [
    ['Ernesto Dimaano', 'probable', 'sits in executive session', 'he was on leave in March'],
    ['Rosa Dimaano', 'rumoured', 'knows the agenda early', 'she has no council access'],
  ]) {
    await page.locator('#sheet-content summary', { hasText: 'Add a candidate' }).click();
    await page.fill('#cand-form input[name=other]', name);
    await page.selectOption('#cand-form select[name=confidence]', conf);
    await page.fill('#cand-form input[name=note]', why);
    await page.fill('#cand-form input[name=counter]', counter);
    await page.click('#cand-form button.primary');
    await page.waitForTimeout(400);
  }
  check('candidates are listed with their disproof',
    (await page.locator('#sheet-content').textContent()).includes('Would disprove: he was on leave in March'));

  await page.locator('#sheet-content [data-ruleout]').last().click();
  await page.waitForTimeout(300);
  check('ruling out keeps the candidate on file, marked',
    (await page.locator('#sheet-content').textContent()).includes('Ruled out'));

  // a bare confirmation should not be enough to name someone
  await page.locator('#sheet-content [data-resolve]').first().click();
  await page.waitForTimeout(300);
  check('resolution restates what would have disproved it',
    (await page.locator('#sheet-content').textContent()).includes('he was on leave in March'));
  await page.click('#resolve-form button.primary');
  await page.waitForTimeout(300);
  check('naming without written reasoning is refused',
    await page.locator('#resolve-form').count() === 1);

  await page.fill('#resolve-form textarea[name=reason]', 'Posted the agenda 40 minutes before the session he chaired.');
  await page.click('#resolve-form button.primary');
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => {
    const M = window.spy.model;
    const person = M.state.entities.find(e => e.name === 'Ernesto Dimaano');
    return {
      subjectsLeft: M.subjects().length,
      codenameKept: (person.aliases || []).includes('the page admin'),
      observations: M.observationsFor(person.id).length,
      provisional: !!person.provisional,
      reasoned: person.notes.includes('40 minutes'),
      stamped: person.notes.includes('Identified as'),
      candidateLinksLeft: M.state.relations.filter(r => r.type === 'may_be').length,
      dangling: M.state.relations.filter(r => !M.entityById(r.fromId) || !M.entityById(r.toId)).length,
    };
  });
  check('the working name folds away', after.subjectsLeft === 0 && !after.provisional);
  check('the working name survives as an alias', after.codenameKept);
  check('everything filed under it moves across', after.observations === 2, `got ${after.observations}`);
  check('the reasoning is written into the file', after.reasoned && after.stamped);
  check('rejected candidates are dropped, not inherited', after.candidateLinksLeft === 0);
  check('no dangling links after resolution', after.dangling === 0);

  await page.click('#sheet-close');
  await page.click('.tab[data-view=entities]');
  check('a tag on the old working name still resolves',
    await page.evaluate(() => !!window.spy.model.findEntityByName('the page admin')));
});

await session('Questions as answer documents', async page => {
  await page.click('.tab[data-view=questions]');
  await page.fill('#q-form input[name=text]', 'How does a land lease actually work here?');
  await page.click('#q-form button.primary');
  await page.waitForSelector('#q-edit');
  check('asking opens the answer document', true);

  await page.fill('#q-edit textarea[name=answer]',
    'Runs 25 years. @[Registry of Deeds] stamps it; @[Maria Santos] controls the queue. Fee is 2% of declared value.');
  await page.click('#q-edit button.primary');
  await page.waitForTimeout(300);

  check('answer preview shows on the list',
    (await page.locator('#view').textContent()).includes('Runs 25 years'));
  check('entities are pulled out of the answer',
    await page.evaluate(() => window.spy.model.state.entities.length) === 2);

  await page.click('.tab[data-view=entities]');
  await page.locator('.rowitem').first().click();
  await page.waitForTimeout(200);
  check('an entity lists the questions it turns up in',
    (await page.locator('#sheet-content').textContent()).includes('Turns up in 1 question'));
  await page.click('#sheet-close');

  await page.click('.tab[data-view=capture]');
  await page.fill('textarea[name=body]', 'Clerk confirmed 2% is on declared value, not market.');
  await page.click('details.more > summary');
  await page.selectOption('select[name=questionId]', { index: 1 });
  await page.click('button.primary[type=submit]');
  await page.waitForTimeout(250);

  await page.click('.tab[data-view=questions]');
  await page.locator('[data-question]').first().click();
  await page.waitForTimeout(250);
  check('linked observation attaches as evidence',
    (await page.locator('#sheet-content').textContent()).includes('Evidence · 1'));

  // leads: half-facts you want recorded before they are solid
  await page.fill('#lead-text', 'heard the fee is 2% — @[Maria Santos] would know');
  await page.click('#lead-add');
  await page.waitForTimeout(400);
  check('a lead is recorded against the question',
    (await page.locator('#sheet-content').textContent()).includes('heard the fee is 2%'));
  check('a new lead starts open',
    (await page.locator('#sheet-content [data-leadcycle]').first().textContent()).trim() === 'open');
  check('a lead pulls its mentions into entities',
    await page.evaluate(() => window.spy.model.state.entities.some(e => e.name === 'Maria Santos')));

  await page.locator('#sheet-content [data-leadcycle]').first().click();
  await page.waitForTimeout(400);
  check('tapping moves the lead along',
    (await page.locator('#sheet-content [data-leadcycle]').first().textContent()).trim() === 'checked out');

  await page.fill('#lead-text', 'ask the treasurer who signs the release');
  await page.click('#lead-add');
  await page.waitForTimeout(400);
  await page.click('#sheet-close');
  await page.click('.tab[data-view=brief]');
  await page.waitForTimeout(250);
  const brief = await page.locator('#view').textContent();
  check('brief lists only leads still open',
    brief.includes('Leads to chase · 1') && brief.includes('ask the treasurer'));

  await page.click('.tab[data-view=questions]');
  check('the question row shows outstanding leads',
    (await page.locator('#view').textContent()).includes('1 open leads'));
  await page.locator('[data-question]').first().click();
  await page.waitForTimeout(250);
  await page.locator('#sheet-content [data-leaddel]').first().click();
  await page.waitForTimeout(400);
  check('a lead can be dropped',
    await page.evaluate(() => window.spy.model.state.questions[0].leads.length) === 1);

  await page.click('[data-answer]');
  await page.waitForTimeout(250);
  check('settling moves it out of open', (await page.locator('#view').textContent()).includes('Settled · 1'));
});

await session('Encryption, locking and sealed backups', async page => {
  await file(page, 'Sensitive memo from @[Maria Santos] — CANARYTOKEN99.');
  await file(page, 'The shop on the corner. @[Blue Hardware]');
  await page.evaluate(async () => {
    const M = window.spy.model;
    await M.saveRelation({
      fromId: M.state.entities.find(e => e.name === 'Maria Santos').id,
      toId: M.state.entities.find(e => e.name === 'Blue Hardware').id,
      type: 'owns', confidence: 'rumoured', note: 'CANARYRELATION',
    });
  });

  await page.click('#btn-data');
  await page.click('#open-security');
  await page.waitForSelector('#setup-pass');
  await page.fill('#setup-pass input[name=passphrase]', PASSPHRASE);
  await page.fill('#setup-pass input[name=confirm]', PASSPHRASE);
  await page.click('#setup-pass button.primary');
  await page.waitForSelector('#recovery-done', { timeout: 30000 });
  const recoveryKey = (await page.locator('#sheet-content .card').first().textContent()).trim();
  check('recovery key is shown in readable groups', /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4})+$/.test(recoveryKey));
  await page.click('#recovery-done');
  await page.waitForTimeout(400);

  const raw = await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('fieldnotes');
    req.onsuccess = () => {
      const tx = req.result.transaction(['observations', 'entities'], 'readonly');
      const rows = [];
      tx.objectStore('observations').getAll().onsuccess = e => rows.push(...e.target.result);
      tx.objectStore('entities').getAll().onsuccess = e => rows.push(...e.target.result);
      tx.oncomplete = () => resolve(JSON.stringify(rows));
    };
  }));
  check('no plaintext left on disk', !raw.includes('CANARYTOKEN99') && !raw.includes('Maria Santos'));
  check('relations are encrypted too', await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('fieldnotes');
    req.onsuccess = () => {
      req.result.transaction('relations', 'readonly').objectStore('relations').getAll()
        .onsuccess = e => resolve(e.target.result.length === 1 && !JSON.stringify(e.target.result).includes('CANARYRELATION'));
    };
  })));

  await page.reload();
  await page.waitForSelector('#unlock', { timeout: 15000 });
  check('locked after reload', true);
  check('navigation hidden while locked', await page.locator('.tabbar').isHidden());

  await page.fill('#unlock input[name=secret]', 'not the passphrase');
  await page.click('#unlock button.primary');
  await page.waitForTimeout(4000);
  check('wrong passphrase rejected', (await page.locator('#view').textContent()).includes('Wrong passphrase'));

  await page.fill('#unlock input[name=secret]', PASSPHRASE);
  await page.click('#unlock button.primary');
  await page.waitForSelector('.tab.active[data-view=brief]', { timeout: 30000 });
  check('right passphrase opens the file',
    await page.evaluate(() => window.spy.model.state.observations.some(o => o.body.includes('CANARYTOKEN99'))));

  const sealed = await page.evaluate(() => window.spy.model.exportEncrypted());
  check('sealed backup carries no plaintext', !JSON.stringify(sealed).includes('CANARYTOKEN99'));
  check('sealed backup opens with the recovery key',
    await page.evaluate(async ([payload, key]) =>
      (await window.spy.model.decryptExport(payload, key, { recovery: true })).observations.some(o => o.body.includes('CANARYTOKEN99')),
    [sealed, recoveryKey]));
  check('sealed backup rejects a wrong secret',
    await page.evaluate(async payload => {
      try { await window.spy.model.decryptExport(payload, 'wrong'); return false; } catch { return true; }
    }, sealed));

  await page.evaluate(async ([payload, secret]) => {
    await window.spy.model.wipe();
    await window.spy.model.importPayload(await window.spy.model.decryptExport(payload, secret));
  }, [sealed, PASSPHRASE]);
  check('restore brings it back', await page.evaluate(() => window.spy.model.state.observations.length) === 2);
  check('relations survive the round trip',
    await page.evaluate(() => window.spy.model.state.relations[0]?.note === 'CANARYRELATION'));
  check('restored records are re-encrypted', await page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('fieldnotes');
    req.onsuccess = () => {
      req.result.transaction('observations', 'readonly').objectStore('observations').getAll()
        .onsuccess = e => resolve(!JSON.stringify(e.target.result).includes('CANARYTOKEN99'));
    };
  })));

  await page.evaluate(() => window.spy.model.changePassphrase('correct horse battery staple', 'an entirely different phrase'));
  await page.reload();
  await page.waitForSelector('#unlock');
  await page.fill('#unlock input[name=secret]', 'an entirely different phrase');
  await page.click('#unlock button.primary');
  await page.waitForSelector('.tab.active', { timeout: 30000 });
  check('changed passphrase works', await page.evaluate(() => window.spy.model.state.observations.length) === 2);
});

await browser.close();
console.log(failures ? `\n${failures} failing check(s)` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
