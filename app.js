'use strict';

/* ---------- constants ---------- */

const DAY_ORDER = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
const DAY_NAMES = {
  'א': 'ראשון', 'ב': 'שני', 'ג': 'שלישי', 'ד': 'רביעי',
  'ה': 'חמישי', 'ו': 'שישי', 'ש': 'שבת',
};
const ROW_H = 38;      // px per stacked sub-row inside a person's lane
const CHIP_H = 34;     // px, must match .chip height in styles.css

const el = {
  days: document.getElementById('days'),
  people: document.getElementById('people'),
  summary: document.getElementById('conflict-summary'),
  focus: document.getElementById('focus-conflicts'),
  reset: document.getElementById('reset-off'),
  error: document.getElementById('error'),
  unlock: document.getElementById('unlock'),
  unlockForm: document.getElementById('unlock-form'),
  keyInput: document.getElementById('key-input'),
  unlockError: document.getElementById('unlock-error'),
  tip: document.getElementById('tip'),
};

/* ---------- helpers ---------- */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

/** "1730" | "17:30" | "8" -> minutes since midnight, or null. */
function toMinutes(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  if (raw.includes(':')) {
    const [h, m] = raw.split(':');
    return Number(h) * 60 + (Number(m) || 0);
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length <= 2) return Number(digits) * 60;
  return Number(digits.slice(0, -2)) * 60 + Number(digits.slice(-2));
}

const hhmm = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const range = (a, b) => `<span dir="ltr">${hhmm(a)}–${hhmm(b)}</span>`;

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

const OFF_KEY = 'family-schedule:off';

/** Reads the "not attending" set; a blocked or corrupt store just means "none". */
function loadOff() {
  try {
    const raw = JSON.parse(localStorage.getItem(OFF_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveOff(off) {
  try {
    localStorage.setItem(OFF_KEY, JSON.stringify([...off]));
  } catch {
    /* private mode / storage disabled: the toggle still works for this visit */
  }
}

/** Stable, well-spread hue per activity name. */
function hueOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return (h * 47) % 360;
}

/* ---------- decryption ---------- */

const KEY_STORE = 'family-schedule:key';
const IV_LEN = 12;
const CODED_FILE = 'schedule.coded';

const b64ToBytes = (b64) =>
  Uint8Array.from(atob(b64.replace(/\s+/g, '')), (ch) => ch.charCodeAt(0));

/** Rejects a malformed key before it reaches WebCrypto. */
async function importKey(raw) {
  let bytes;
  try {
    bytes = b64ToBytes(raw.trim());
  } catch {
    throw new Error('המפתח אינו בפורמט תקין (base64)');
  }
  if (bytes.length !== 32) {
    throw new Error('המפתח אינו באורך הנכון — נדרש מפתח של 256 ביט (44 תווים)');
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['decrypt']);
}

/** schedule.coded is base64 of iv(12) + AES-256-GCM ciphertext + tag. */
async function decodeSchedule(coded, rawKey) {
  const key = await importKey(rawKey);
  const bytes = b64ToBytes(coded);
  let plain;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, IV_LEN) }, key, bytes.slice(IV_LEN),
    );
  } catch {
    throw new Error('המפתח אינו מתאים לקובץ הזה');
  }
  try {
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('הקובץ נפתח אך תוכנו אינו JSON תקין');
  }
}

/* ---------- model ---------- */

/**
 * One JSON entry with several days becomes one item per day. The item id is the
 * entry's own id plus the day, so a cancellation survives edits to any other
 * field (a fixed typo, a changed hour or place) while each day of a repeating
 * entry stays separately cancellable.
 */
function toItems(entries) {
  const items = [];
  const skipped = [];
  const fatal = [];
  const seenIds = new Map();

  entries.forEach((entry, i) => {
    const start = toMinutes(entry.startHour);
    const end = toMinutes(entry.endHour);
    const days = (Array.isArray(entry.days) ? entry.days : [entry.days])
      .map((d) => String(d == null ? '' : d).trim())
      .filter(Boolean);
    const id = String(entry.id == null ? '' : entry.id).trim();

    if (!id) {
      fatal.push(`רשומה ${i + 1}: אין id`);
      return;
    }
    if (seenIds.has(id)) {
      fatal.push(`רשומה ${i + 1}: id "${id}" כבר בשימוש ברשומה ${seenIds.get(id)}`);
      return;
    }
    if (!entry.who || start == null || end == null || end <= start || !days.length) {
      skipped.push(`${i + 1} (id ${id}: שדות חסרים או שעות לא תקינות)`);
      return;
    }
    seenIds.set(id, i + 1);

    for (const day of days) {
      items.push({
        id: `${id}:${day}`,
        who: String(entry.who).trim(),
        what: String(entry.what || '').trim(),
        where: String(entry.where || '').trim(),
        day,
        start,
        end,
        clashes: [],
      });
    }
  });

  return { items, skipped, fatal };
}

/**
 * Recomputes overlaps. Events switched off are excluded, so turning one off is
 * how a double booking gets resolved.
 */
function linkClashes(items, off) {
  for (const item of items) item.clashes = [];
  const live = items.filter((it) => !off.has(it.id));
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.day !== b.day || a.who !== b.who || !overlaps(a, b)) continue;
      a.clashes.push(b);
      b.clashes.push(a);
    }
  }
}

/** Greedy packing: items that overlap get separate sub-rows within a lane. */
function packRows(items) {
  const rows = [];
  for (const item of [...items].sort((a, b) => a.start - b.start || a.end - b.end)) {
    let r = rows.findIndex((row) => row.every((other) => !overlaps(item, other)));
    if (r === -1) r = rows.push([]) - 1;
    rows[r].push(item);
    item.row = r;
  }
  return rows.length;
}

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

/* ---------- render ---------- */

const state = {
  items: [], people: [], hidden: new Set(), off: new Set(), span: null, registry: [],
  coded: '', scrollLeft: null, whoWidth: '4ch',
};

function renderPeopleFilter() {
  el.people.innerHTML = state.people.map((p) => `
    <button type="button" data-who="${esc(p)}" aria-pressed="${!state.hidden.has(p)}">${esc(p)}</button>
  `).join('');
}

function renderDays() {
  const { from, to } = state.span;
  const total = to - from;
  const pct = (min) => ((min - from) / total) * 100;
  const todayLetter = DAY_ORDER[new Date().getDay()];

  state.registry = [];
  const visible = state.items.filter((it) => !state.hidden.has(it.who));
  const byDay = groupBy(visible, (it) => it.day);
  const days = [...byDay.keys()].sort((a, b) => {
    const ia = DAY_ORDER.indexOf(a), ib = DAY_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const ticks = [];
  for (let m = from; m <= to; m += 60) {
    const shift = m === from ? '0' : m === to ? '100%' : '50%';
    ticks.push(`<span style="inset-inline-start:${pct(m)}%;transform:translateX(${shift})">${
      String(Math.floor(m / 60)).padStart(2, '0')}</span>`);
  }

  el.days.innerHTML = days.map((day) => {
    const dayItems = byDay.get(day);
    const isToday = day === todayLetter;
    const clashing = dayItems.filter((it) => it.clashes.length).length;
    const offCount = dayItems.filter((it) => state.off.has(it.id)).length;

    const lanes = state.people
      .filter((who) => !state.hidden.has(who))
      .map((who) => {
        const mine = dayItems.filter((it) => it.who === who);
        const rows = packRows(mine);
        const chips = mine.map((it) => {
          const i = state.registry.push(it) - 1;
          const isOff = state.off.has(it.id);
          const bad = it.clashes.length > 0;
          return `<button type="button" class="chip${bad ? ' conflict' : ''}${isOff ? ' off' : ''}"
                          data-i="${i}" data-id="${esc(it.id)}" aria-pressed="${!isOff}"
                       style="--h:${hueOf(it.what)};inset-inline-start:${pct(it.start)}%;width:${
                         pct(it.end) - pct(it.start)}%;top:${3 + it.row * ROW_H}px">
                    <span class="what">${esc(it.what)}</span>
                    ${it.where ? `<span class="meta">${esc(it.where)}</span>` : ''}
                    ${bad ? '<span class="flag" aria-label="חפיפה">⚠</span>' : ''}
                  </button>`;
        }).join('');

        const nowLine = isToday ? '<div class="now" hidden></div>' : '';

        return `<div class="row">
                  <div class="who">${esc(who)}</div>
                  <div class="lane" style="height:${Math.max(rows, 1) * ROW_H + CHIP_H - ROW_H + 6}px">
                    ${chips}${nowLine}
                  </div>
                </div>`;
      }).join('');

    return `<section class="day${isToday ? ' today' : ''}">
      <div class="day-head">
        <h2>יום ${esc(DAY_NAMES[day] || day)}</h2>
        ${isToday ? '<span class="pill">היום</span>' : ''}
        <span class="spacer"></span>
        ${clashing ? `<span class="pill warn">⚠ ${clashing} בחפיפה</span>` : ''}
        <span class="count">${dayItems.length - offCount} פעילויות${
          offCount ? ` · ${offCount} מבוטלות` : ''}</span>
      </div>
      <div class="scroller">
        <div class="track" style="--hour-w:calc(100% / ${total / 60});--who-w:${state.whoWidth}">
          <div class="row">
            <div class="who-pad"></div>
            <div class="ruler">${ticks.join('')}</div>
          </div>
          ${lanes}
        </div>
      </div>
    </section>`;
  }).join('');

  syncScrollers();
}

/**
 * Day blocks are wider than a phone, so they scroll — as one, and starting at
 * the activity-dense end of the day rather than at the morning. Assigning a
 * large negative scrollLeft lands on the leftmost edge under either RTL
 * convention (0-at-start or 0-at-left).
 */
function syncScrollers() {
  const scrollers = [...el.days.querySelectorAll('.scroller')];
  if (!scrollers.length) return;

  if (state.scrollLeft === null) {
    scrollers[0].scrollLeft = -1e6;
    state.scrollLeft = scrollers[0].scrollLeft;
  }

  for (const scroller of scrollers) {
    scroller.scrollLeft = state.scrollLeft;
    scroller.addEventListener('scroll', () => {
      if (scroller.scrollLeft === state.scrollLeft) return;
      state.scrollLeft = scroller.scrollLeft;
      for (const other of scrollers) {
        if (other !== scroller) other.scrollLeft = state.scrollLeft;
      }
    }, { passive: true });
  }
}

/** Moves the "now" marker without re-rendering (keeps focus and tooltips alive). */
function updateNow() {
  const { from, to } = state.span;
  const now = new Date();
  const min = now.getHours() * 60 + now.getMinutes();
  const inRange = DAY_ORDER[now.getDay()] && min > from && min < to;
  for (const line of el.days.querySelectorAll('.now')) {
    line.hidden = !inRange;
    if (inRange) line.style.insetInlineStart = `${((min - from) / (to - from)) * 100}%`;
  }
}

function renderSummary() {
  const n = state.items.filter((it) => it.clashes.length).length;
  el.summary.textContent = n ? `⚠ ${n} פעילויות בחפיפה` : 'אין חפיפות בלוח';
  el.summary.classList.toggle('clean', n === 0);

  // ids kept from a deleted entry stay in storage but must not be counted here
  const cancelled = state.items.filter((it) => state.off.has(it.id)).length;
  el.reset.hidden = cancelled === 0;
  el.reset.textContent = `${cancelled} מבוטלות · החזר הכל`;
}

/** Flips one event between attending and not, then redraws. */
function toggleOff(id) {
  if (state.off.has(id)) state.off.delete(id);
  else state.off.add(id);
  saveOff(state.off);
  linkClashes(state.items, state.off);
  renderDays();
  renderSummary();
  updateNow();

  const chip = el.days.querySelector(`.chip[data-id="${CSS.escape(id)}"]`);
  if (chip) {
    chip.focus({ preventScroll: true });
    showTip(chip);
  }
}

/* ---------- tooltip ---------- */

function showTip(chip) {
  const item = state.registry[Number(chip.dataset.i)];
  if (!item) return;

  const clashes = [...item.clashes].sort((a, b) => a.start - b.start);
  el.tip.innerHTML = `
    <b>${esc(item.what)}</b>
    <div class="row">${esc(item.who)}${item.where ? ' · ' + esc(item.where) : ''}</div>
    <div class="row">${range(item.start, item.end)}</div>
    ${clashes.length ? `<div class="clash">⚠ חפיפה עם:
      <ul>${clashes.map((c) => `<li>${esc(c.what)} ${range(c.start, c.end)}${
        c.where ? ' · ' + esc(c.where) : ''}</li>`).join('')}</ul></div>` : ''}
  `;
  el.tip.hidden = false;

  const box = chip.getBoundingClientRect();
  const tip = el.tip.getBoundingClientRect();
  const pad = 8;
  let left = box.left + box.width / 2 - tip.width / 2;
  left = Math.min(Math.max(pad, left), window.innerWidth - tip.width - pad);
  const above = box.top - tip.height - 6;
  el.tip.style.left = `${left}px`;
  el.tip.style.top = `${above > pad ? above : box.bottom + 6}px`;
}

const hideTip = () => { el.tip.hidden = true; };

document.addEventListener('pointerover', (e) => {
  const chip = e.target.closest?.('.chip');
  if (chip) showTip(chip); else hideTip();
});
document.addEventListener('focusin', (e) => {
  const chip = e.target.closest?.('.chip');
  if (chip) showTip(chip);
});
document.addEventListener('focusout', hideTip);
window.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); });

/* ---------- wiring ---------- */

el.people.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-who]');
  if (!button) return;
  const who = button.dataset.who;
  if (state.hidden.has(who)) state.hidden.delete(who);
  else if (state.hidden.size < state.people.length - 1) state.hidden.add(who);
  renderPeopleFilter();
  renderDays();
  updateNow();
});

el.days.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) toggleOff(chip.dataset.id);
});

el.reset.addEventListener('click', () => {
  state.off.clear();
  saveOff(state.off);
  linkClashes(state.items, state.off);
  renderDays();
  renderSummary();
  updateNow();
});

el.focus.addEventListener('change', () => {
  document.body.classList.toggle('focus-conflicts', el.focus.checked);
});

function start(entries) {
  const { items, skipped, fatal } = toItems(entries);

  // A broken id means cancellations can attach to the wrong activity, so refuse
  // to draw a board that would look complete while an activity is missing.
  if (fatal.length) {
    el.days.innerHTML = '';
    el.error.hidden = false;
    el.error.innerHTML = `<b>הלוח לא הוצג — בעיית מזהים ב-schedule.json</b>
      <ul>${fatal.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
      <div>תקנו את הקובץ והריצו <code>npm run encode</code>.</div>`;
    return;
  }

  if (!items.length) throw new Error('לא נמצאו רשומות תקינות בלוח');

  const off = loadOff();
  linkClashes(items, off);
  const seen = new Set();
  for (const it of items) if (!seen.has(it.who)) seen.add(it.who);

  const from = Math.floor(Math.min(...items.map((i) => i.start)) / 60) * 60;
  const to = Math.ceil(Math.max(...items.map((i) => i.end)) / 60) * 60;

  state.items = items;
  state.people = [...seen];
  state.whoWidth = `calc(${Math.max(...[...seen].map((p) => p.length), 3)}ch + 18px)`;
  state.hidden = new Set();
  state.off = off;
  state.span = { from, to: Math.max(to, from + 60) };

  el.error.hidden = true;
  renderPeopleFilter();
  renderDays();
  renderSummary();
  updateNow();

  if (skipped.length) {
    el.error.hidden = false;
    el.error.innerHTML = `דולגו רשומות ב-schedule.json: ${esc(skipped.join('; '))}`;
  }
  setInterval(updateNow, 60_000); // keeps the "now" marker honest
}

/** The coded file sits next to the page; there is nothing to show without it. */
async function loadCoded() {
  const res = await fetch(CODED_FILE, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function showUnlock(message) {
  document.body.classList.add('locked');
  el.unlock.hidden = false;
  el.unlockError.hidden = !message;
  el.unlockError.textContent = message || '';
  el.keyInput.focus();
}

/** Renders the schedule once a key decrypts it, and remembers that key. */
async function unlock(rawKey, remember) {
  const entries = await decodeSchedule(state.coded, rawKey);
  start(entries);
  document.body.classList.remove('locked');
  el.unlock.hidden = true;
  el.unlockError.hidden = true;
  el.unlockError.textContent = '';
  if (remember) {
    try {
      localStorage.setItem(KEY_STORE, rawKey.trim());
    } catch {
      /* storage disabled: the key just has to be pasted again next time */
    }
  }
}

el.unlockForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await unlock(el.keyInput.value, true);
    el.keyInput.value = '';
  } catch (err) {
    showUnlock(err.message);
  }
});

async function boot() {
  document.body.classList.add('locked');

  if (!window.crypto?.subtle) {
    el.error.hidden = false;
    el.error.innerHTML = `<b>אין הצפנה זמינה בדפדפן</b>
      <div>הדף חייב להיפתח דרך <code>https</code> או <code>localhost</code>.</div>`;
    return;
  }

  try {
    state.coded = await loadCoded();
  } catch (err) {
    el.error.hidden = false;
    el.error.innerHTML = `<b>לא ניתן לטעון את ${CODED_FILE}</b>
      <div>${esc(err.message)}</div>`;
    return;
  }

  let saved = null;
  try {
    saved = localStorage.getItem(KEY_STORE);
  } catch {
    /* no storage: fall through to the unlock box */
  }

  if (saved) {
    try {
      await unlock(saved, false);
      return;
    } catch {
      try { localStorage.removeItem(KEY_STORE); } catch { /* ignore */ }
      showUnlock('המפתח השמור אינו פותח את הלוח — כנראה הוחלף. הדביקו את המפתח החדש.');
      return;
    }
  }

  showUnlock();
}

boot();
