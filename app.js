"use strict";
/* Лист персонажа Dark Heresy 1e — логика */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const die = n => 1 + Math.floor(Math.random() * n);   // dN, включая N
const d10 = () => die(10);
const d5  = () => Math.ceil(d10() / 2);               // d10: 1-2→1 … 9-10→5
const num = v => parseInt(v, 10) || 0;

let uidSeq = 0;
let careerKitExpanded = true;   // состояние свёрнутости блока #career-kit

/* ---------- серверное хранилище ---------- */
const API_PREFIX = "/api";
const LS_ID_KEY = "dh1e-current-id-v1";     // id текущего персонажа
const LS_SHEET_KEY = "dh1e-sheet-v1";       // старое локальное сохранение (миграция)
let currentCharId = null;                   // id персонажа в SQLite
let isApplying = false;                     // guard: не сохранять во время apply()
let sheetDirty = false;                     // пользователь менял лист

/* ---------- характеристики ---------- */
const curWorld = () => WORLDS.find(w => w.id === $("#sel-world").value);
const curBio   = () => {
  const id = $("#sel-bio").value;
  return id ? BIOGRAPHIES.find(b => b.id === id) || null : null;
};

/* прямые стат-бонусы родного мира для характеристики key:
   statFixes — всегда, careerFix (Особенность «Годен») — по Профессии,
   купленная биография — третий источник */
function charFixes(key) {
  const w = curWorld();
  const out = [];
  if (!w) return out;
  for (const f of (w.statFixes || [])) if (f.key === key) out.push(f);
  const cf = w.careerFix;
  if (cf && cf.map && cf.map[$("#sel-career").value] === key) out.push(cf);
  const bio = curBio();
  if (bio && bio.stats && bio.stats[key]) out.push({ v:bio.stats[key], src:`Биография: ${bio.name}`, bio:true });
  return out;
}

/* разбор источников цифры у сгенерированного значения:
   «+20 (Мир-кузница) +3 (Годен) +5 (Биография)» — мод. напыления уже внутри base */
function fixBreakdown(key) {
  const w = curWorld();
  if (!w) return "";
  const parts = [];
  if (w.mods[key]) parts.push(`${fmtMod(w.mods[key])} (${w.name})`);
  for (const f of charFixes(key)) parts.push(`${fmtMod(f.v)} (${f.bio ? "🛠️ " : ""}${f.src})`);
  return parts.length ? `[${parts.join(" ")}]` : "";
}

function buildChars() {
  const tb = $("#chars-tbody");
  tb.innerHTML = "";
  for (const c of CHARS) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td>${c.name} <span class="muted">(${c.abbr})</span></td>` +
      `<td><div class="inline">
          <button class="roll" type="button" data-rollchar="${c.key}" title="2d10+мод. мира">🎲</button>
          <input data-key="base_${c.key}" type="number" min="1" max="100" class="char-base">
        </div></td>` +
      `<td><input data-key="adv_${c.key}" type="number" min="0" max="100" value="0"></td>` +
      `<td><span class="val" id="val_${c.key}">—</span> <span class="fixsrc" id="fix_${c.key}"></span></td>` +
      `<td><span class="bon" id="bon_${c.key}">—</span></td>`;
    tb.appendChild(tr);
  }
  tb.addEventListener("click", e => {
    const b = e.target.closest("button[data-rollchar]");
    if (!b) return;
    const key = b.dataset.rollchar;
    const world = curWorld();
    const mod = world ? world.mods[key] : 0;
    document.querySelector(`input[data-key="base_${key}"]`).value = d10() + d10() + mod;
    recalc();
    flash("бросок: 2d10" + fmtMod(mod));
  });
}
const fmtMod = m => (m >= 0 ? "+" : "") + m;

function getVal(key) {
  const base = document.querySelector(`input[data-key="base_${key}"]`);
  const adv  = document.querySelector(`input[data-key="adv_${key}"]`);
  return num(base && base.value) + num(adv && adv.value);
}

/* ---------- пересчёт ---------- */
function recalc() {
  const vals = {};
  for (const c of CHARS) {
    const extra = charFixes(c.key).reduce((sum, f) => sum + f.v, 0);
    const v = getVal(c.key) + extra;
    vals[c.key] = v;
    $("#val_" + c.key).textContent = v || "—";
    $("#fix_" + c.key).textContent = v ? fixBreakdown(c.key) : "";
    $("#bon_" + c.key).textContent = v ? Math.floor(v / 10) : "—";
  }

  const ab = Math.floor(vals.ag / 10);
  $("#movement").textContent = ab ? `${ab} · ${ab*2} · ${ab*3} · ${ab*6} м` : "—";
  $("#fatigue").textContent = vals.t ? Math.floor(vals.t / 10) : "—";

  const carrySum = Math.floor(vals.s / 10) + Math.floor(vals.t / 10);
  const c = CARRY_TABLE[carrySum];
  // отличаем пустые характеристики от реально введённых малых значений:
  // сумма бонусов 0 при заполненных полях — легитимный случай (табл. строка 0)
  const hasChars = vals.s > 0 || vals.t > 0;
  $("#carry").textContent =
    hasChars && c !== undefined
      ? `перенос ${c} · подъём ${c*2} · толчок ${c*4} кг`
      : (hasChars ? `${carrySum} — см. таблицу на стр. 208` : "—");

  const career = CAREERS.find(x => x.id === $("#sel-career").value);
  const wpb = Math.floor(vals.wp / 10);
  // Пси-рейтинг: от профессии-псайкера (стартовый 1) или от купленного таланта «Пси-рейтинг …»
  const psyRating = Math.max(
    0,
    ...$$("#talents-tbody select").map(s => {
      const m = (s.value || "").match(/^Пси-рейтинг (\d+)/);
      return m ? +m[1] : 0;
    })
  );
  const isPsy = (career && career.psy) || psyRating > 0;
  $("#psy").textContent = isPsy && wpb
    ? `≈ ${Math.ceil(wpb / 2)} малых психосил` + (psyRating > 1 ? ` · Пси-рейтинг ${Math.max(psyRating, 1)}` : "")
    : "—";
  // Санкционирование проходили только Имперские Псайкеры
  $("#btn-sanction").classList.toggle("hidden",
    !(((career && career.id === "psy") || psyRating > 0) && $("#sel-world").value));

  const bio = curBio();
  const bioCost = bio ? bio.cost : 0;
  $("#xpFree").textContent =
    Math.max(0, num($("input[data-key=xpTotal]").value) - num($("input[data-key=xpSpent]").value) - bioCost);

  for (const tr of $("#skills-tbody").rows) calcSkillRow(tr);
  if (sheetDirty) flashSave();   // чистый только что загруженный лист не отправляем
}

/* ---------- умения ---------- */
function addSkillRow(name = "", lvl = "untrained", src = "manual") {
  const tb = $("#skills-tbody");
  const tr = document.createElement("tr");
  if (src === "bio") tr.dataset.src = "bio";

  const sel = document.createElement("select");
  sel.dataset.key = "sk" + (++uidSeq);
  sel.className = "sk-name";
  const ogBase = document.createElement("optgroup"); ogBase.label = "Базовые";
  const ogAdv  = document.createElement("optgroup"); ogAdv.label  = "Продвинутые";
  for (const s of SKILLS) {
    const o = document.createElement("option");
    const char = CHARS.find(x => x.key === s.char);
    o.value = s.name; o.textContent = `${s.name} [${char ? char.abbr : "?"}]`;
    o.dataset.type = s.type; o.dataset.char = s.char;
    (s.type === "b" ? ogBase : ogAdv).appendChild(o);
  }
  sel.appendChild(new Option(""));
  sel.appendChild(ogBase); sel.appendChild(ogAdv);

  // динамическая опция, если имя не из списка
  ensureSkillOption(sel, name);

  const lvlSel = document.createElement("select");
  lvlSel.dataset.key = sel.dataset.key + "_lvl";
  lvlSel.className = "sk-lvl";
  lvlSel.innerHTML =
    `<option value="basic">Базовое</option>` +
    `<option value="untrained">Без обучения</option>` +
    `<option value="trained">Обучено +10</option>` +
    `<option value="mastery">Владение +20</option>`;

  const charTd = document.createElement("td"); charTd.className = "muted";
  const goalTd = document.createElement("td"); goalTd.className = "goal";
  const nameTd = document.createElement("td");
  const mark = document.createElement("span");
  mark.className = "bio-mark";
  mark.textContent = "🛠️";
  mark.hidden = src !== "bio";
  nameTd.appendChild(mark);
  nameTd.appendChild(sel);
  const lvlTd  = document.createElement("td"); lvlTd.appendChild(lvlSel);
  const delTd  = document.createElement("td"); delTd.className = "del";
  delTd.innerHTML = `<button type="button">✕</button>`;
  delTd.querySelector("button").onclick = () => { tr.remove(); sheetDirty = true; flashSave(); recalc(); };
  tr.append(nameTd, charTd, lvlTd, goalTd, delTd);
  tb.appendChild(tr);

  if (name) sel.value = name;
  lvlSel.value = lvl;
  sel.onchange    = () => { sheetDirty = true; calcSkillRow(tr); flashSave(); };
  lvlSel.onchange = () => { sheetDirty = true; calcSkillRow(tr); flashSave(); };
  calcSkillRow(tr);
}

/* если имени нет в стандартном списке — добавить опцию в соответствующий optgroup */
function ensureSkillOption(sel, name) {
  if (!name) return;
  const exists = Array.from(sel.options).some(o => o.value === name);
  if (exists) return;
  // пытаемся угадать группу по префиксу
  let base = name, sub = "";
  const m = name.match(/^(.+?)\s*\((.+)\)$/);
  if (m) { base = m[1].trim() + "*"; sub = m[2].trim(); }
  const proto = SKILLS.find(s => s.name === name);
  if (proto) return; // уже должно быть — на всякий случай
  const group = SKILL_GROUPS[base];
  // ищем базовый шаблон в SKILL_LIST
  const tpl = SKILL_LIST.find(x => x[0] === base || x[0] === base.replace("*",""));
  const type = tpl ? tpl[1] : "a";
  const char = tpl ? tpl[2] : "int";
  const option = document.createElement("option");
  option.value = name;
  const abbr = CHARS.find(x => x.key === char)?.abbr || "?";
  option.textContent = `${name} [${abbr}]`;
  option.dataset.type = type;
  option.dataset.char = char;
  const label = type === "b" ? "Базовые" : "Продвинутые";
  const og = Array.from(sel.querySelectorAll("optgroup")).find(g => g.label === label);
  if (og) og.appendChild(option);
  else sel.appendChild(option);
}
function calcSkillRow(tr) {
  const [selName, selLvl] = tr.querySelectorAll("select");
  const opt = selName.selectedOptions[0];
  const charTd = tr.children[1], goalTd = tr.children[3];
  if (!opt || !opt.dataset.char) { charTd.textContent = ""; goalTd.textContent = "—"; return; }
  charTd.textContent = CHARS.find(x => x.key === opt.dataset.char).abbr;
  const base = getVal(opt.dataset.char) +
    charFixes(opt.dataset.char).reduce((sum, fix) => sum + fix.v, 0);
  let mod = 0, tag = "";
  let target = base;
  if (selLvl.value === "basic") { target = Math.floor(base / 2); tag = "базовое"; }
  else if (selLvl.value === "untrained") { tag = "без обучения (0)"; }
  else if (selLvl.value === "trained") { mod = 10; tag = "обучено +10"; }
  else if (selLvl.value === "mastery") { mod = 20; tag = "владение +20"; }
  goalTd.textContent = base ? `${target + mod} ${tag}` : "—";
}

/* ---------- таланты ---------- */
function addTalentRow(name = "", note = "", src = "manual") {
  const tb = $("#talents-tbody");
  const tr = document.createElement("tr");
  if (src === "bio") tr.dataset.src = "bio";

  const sel = document.createElement("select");
  sel.dataset.key = "tl" + (++uidSeq) + "_n";
  // ВАЖНО: плейсхолдер добавляем ПЕРВЫМ — при добавлении опций в пустой select
  // первая опция автоматически становится выбранной (HTML spec), и вставка
  // плейсхолдера перед ней потом selectedIndex не сбрасывает
  sel.appendChild(new Option(""));
  for (const t of TALENTS) { const o = document.createElement("option"); o.textContent = t; sel.appendChild(o); }

  // динамическая опция, если имя не из списка
  if (name && !TALENTS.includes(name)) {
    const o = document.createElement("option"); o.textContent = name; sel.appendChild(o);
  }

  const noteEl = document.createElement("input");
  noteEl.type = "text";
  noteEl.dataset.key = sel.dataset.key.replace("_n", "_x");
  noteEl.placeholder = "примечание / подтип";

  const nameTd = document.createElement("td");
  const mark = document.createElement("span");
  mark.className = "bio-mark";
  mark.textContent = "🛠️";
  mark.hidden = src !== "bio";
  nameTd.appendChild(mark);
  nameTd.appendChild(sel);
  const noteTd = document.createElement("td"); noteTd.appendChild(noteEl);
  const delTd  = document.createElement("td"); delTd.className = "del";
  delTd.innerHTML = `<button type="button">✕</button>`;
  delTd.querySelector("button").onclick = () => { tr.remove(); sheetDirty = true; flashSave(); recalc(); };
  tr.append(nameTd, noteTd, delTd);
  tb.appendChild(tr);

  if (name) sel.value = name;
  else sel.selectedIndex = 0;   // гарантируем «пусто» даже после истории опций
  noteEl.value = note;
  sel.onchange   = () => { sheetDirty = true; flashSave(); recalc(); };   // Пси-рейтинг влияет на производные
  noteEl.oninput = () => { sheetDirty = true; flashSave(); };
}

/* ---------- оружие ---------- */
const W_FIELDS = [
  ["name","Название"],["cls","Класс"],["dmg","Урон"],["dtyp","Тип"],["pen","Пен"],
  ["rng","Дальность"],["clip","Обойма"],["rld","Перез."],["spec","Особое"]
];
function addWeaponRow(values = null) {
  const tb = $("#weapons-tbody");
  const tr = document.createElement("tr");
  const baseKey = "w" + (++uidSeq);
  tr._baseKey = baseKey;
  for (const [f, ph] of W_FIELDS) {
    const td = document.createElement("td");
    const i = document.createElement("input");
    i.type = "text"; i.placeholder = ph;
    i.dataset.key = baseKey + "_" + f;
    if (f === "name") i.style.minWidth = "110px";
    if (values && values[f] != null) i.value = values[f];
    td.appendChild(i); tr.appendChild(td);
  }
  const delTd = document.createElement("td");
  delTd.className = "del";
  delTd.innerHTML = `<button type="button">✕</button>`;
  delTd.querySelector("button").onclick = () => { tr.remove(); sheetDirty = true; flashSave(); };
  tr.appendChild(delTd);
  tb.appendChild(tr);
  tr.addEventListener("input", () => { sheetDirty = true; flashSave(); });
}

/* ---------- профессия / мир ---------- */
// overwriteRank=true только при явной смене профессии пользователем;
// при восстановлении/импорте (false) сохранённый ранг не затирается
function showCareerKit(overwriteRank = true) {
  const c = CAREERS.find(x => x.id === $("#sel-career").value);
  const w = curWorld();
  const box = $("#career-kit");
  const rank = $("input[data-key=rank]");
  if (!c && !w) {
    box.hidden = true;
    if (overwriteRank) rank.value = "";
  } else {
    box.hidden = false;

    const careerCol =
      `<div class="kit-col"><div class="kit-title">Профессия${c ? `: ${c.name}` : ""}</div>` +
      (c
        ? `Ранг: ${c.rank}\nБогатство: ${c.wealth}\n` +
          `\nСтартовые умения:\n  • ${c.skills.join("\n  • ")}` +
          `\n\nСтартовые таланты:\n  • ${c.talents.join("\n  • ")}` +
          (c.gear && c.gear !== "—" ? `\n\nСтартовое имущество:\n  ${c.gear}` : "")
        : "— профессия не выбрана") +
      `</div>`;

    let worldCol = `<div class="kit-col"><div class="kit-title">Родной мир${w ? `: ${w.name}` : ""}</div>`;
    if (!w) {
      worldCol += "— мир не выбран";
    } else {
      worldCol += `\nСтартовые Умения Уроженца Мира:\n` +
        ((w.hwSkills && w.hwSkills.length)
          ? `  • ${w.hwSkills.join("\n  • ")}`
          : `  — отдельных умений нет (см. Особенности)`);
      worldCol += `\n\nОсобенности Уроженцев Мира:\n` +
        w.hwFeatures.map(f => `  ● ${f.n} — ${f.t}`).join("\n") +
        (w.careerFix ? "\n\n  (+3 из Особенности «Годен» учтён в «Итоге» таблицы характеристик)" : "");
    }
    worldCol += `</div>`;

    const headerText = c ? `Профессия: ${c.name} (ранг ${c.rank})` : "Профессия не выбрана";
    const arrow = careerKitExpanded ? "▾" : "▸";
    box.innerHTML =
      `<button class="kit-toggle" type="button" aria-expanded="${careerKitExpanded}" aria-controls="career-kit-body">` +
        `<span>${headerText}</span><span class="kit-toggle-arrow" aria-hidden="true">${arrow}</span>` +
      `</button>` +
      `<div id="career-kit-body" class="kit-body${careerKitExpanded ? "" : " collapsed"}"${careerKitExpanded ? "" : " hidden"}>` +
        `<div class="kit-2col">${careerCol}${worldCol}</div>` +
      `</div>`;

    if (c && (overwriteRank || !rank.value)) rank.value = c.rank;
  }
  recalc();
}

/* ---------- броски ---------- */
const lookup = (table, roll) => {
  for (const [a, b, v] of table) if (roll >= a && roll <= b) return v;
  return 0;
};
const rollWounds = () => {
  const world = curWorld();
  $("#wounds").value = d5() + (world ? world.wounds : 0);
  recalc();
  saveSoon();
  flash("раны: d5" + fmtMod(world ? world.wounds : 0) + (world ? "" : " (мир не выбран)"));
};
const rollFate = () => {
  const world = curWorld();
  if (!world) return flash("сначала выбери родной мир");
  const n = d10(), pts = lookup(world.fate, n);
  $("#fateTotal").value = pts;
  $("#fateLeft").value  = pts;
  sheetDirty = true;
  flashSave();
  flash(`судьба: d10=${n} → ${pts} очк.`);
};
const rollWealth = () => {
  const c = CAREERS.find(x => x.id === $("#sel-career").value);
  if (!c) return flash("сначала выбери профессию");
  const m = c.wealth.match(/^(\d+)\+(\d+)d(\d+)$/);
  let val = m ? +m[1] : +c.wealth;                   // сумма K отдельных бросков dN
  if (m) for (let i = 0; i < +m[2]; i++) val += die(+m[3]);
  const bio = curBio();
  if (bio && bio.wealthMul) {
    val = Math.floor(val * bio.wealthMul);
    sheetDirty = true;
    flashSave();
    flash(`богатство: ${c.wealth} ×${bio.wealthMul} = ${val} тронов`);
    $("#wealth").value = val;
    return;
  }
  $("#wealth").value = val;
  sheetDirty = true;
  flashSave();
  flash(`богатство: ${c.wealth} = ${val} тронов`);
};
const rollSanction = () => {
  const d100 = (d10() - 1) * 10 + d10();
  for (const range of Object.keys(SANCTIONS)) {
    const [a, b] = range.split("-").map(Number);
    if (d100 >= a && d100 <= b) {
      const ta = $("textarea[data-key=notes]");
      ta.value = (ta.value ? ta.value + "\n" : "") + `[санкционирование d100=${d100}] ${SANCTIONS[range]}`;
      sheetDirty = true;
      saveSoon();
      flash(`санкционирование: ${d100}`);
      return;
    }
  }
};
const rollAllChars = () => {
  const world = curWorld();
  for (const c of CHARS) {
    const mod = world ? world.mods[c.key] : 0;
    document.querySelector(`input[data-key="base_${c.key}"]`).value = d10() + d10() + mod;
  }
  recalc();
  flash(world ? "напыление характеристик (2d10+мод. мира): " + world.name
              : "мир не выбран — модификаторы +0");
};

/* ---------- сериализация ---------- */
function collect() {
  const data = {};
  for (const el of $$("[data-key]")) data[el.dataset.key] = el.value ?? "";

  // Экранирование служебных символов упаковки: \ → \\ , ; → \S , | → \P
  const escField = x => String(x ?? "")
    .replace(/\\/g, "\\\\").replace(/;/g, "\\S").replace(/\|/g, "\\P");
  const packRows = (tbody, mapFn) => {
    const rows = [];
    for (const tr of tbody.rows) {
      const t = mapFn(tr).map(escField);
      if (t.some(x => x.trim() !== "")) rows.push(t.join("|"));
    }
    return rows.join(";");
  };
  data.__skills = packRows($("#skills-tbody"),
    tr => [tr.children[0].lastChild.value, tr.children[2].firstChild.value, tr.dataset.src || "manual"]);
  data.__talents = packRows($("#talents-tbody"),
    tr => [tr.children[0].lastChild.value, tr.children[1].firstChild.value, tr.dataset.src || "manual"]);
  data.bioId = $("#sel-bio").value;
  data.__weapons = packRows($("#weapons-tbody"),
    tr => Array.from(tr.children).slice(0, 9).map(td => td.firstChild.value));
  return data;
}

function apply(data) {
  isApplying = true;
  try {
    $("#skills-tbody").innerHTML = "";
    $("#talents-tbody").innerHTML = "";
    $("#weapons-tbody").innerHTML = "";

    const unescField = u => u.replace(/\\[SP\\]/g, m =>
      m === "\\S" ? ";" : m === "\\P" ? "|" : "\\");
    const unpack = s => (s || "").split(";").filter(Boolean)
      .map(t => t.split("|").map(unescField));
    for (const parts of unpack(data.__skills)) {
      const [name, lvl, src] = parts;
      addSkillRow(name, lvl || "untrained", src === "bio" ? "bio" : "manual");
    }
    for (const parts of unpack(data.__talents)) {
      const [name, note, src] = parts;
      addTalentRow(name, note || "", src === "bio" ? "bio" : "manual");
    }
    for (const fields of unpack(data.__weapons)) addWeaponRow({ name: fields[0], cls: fields[1], dmg: fields[2], dtyp: fields[3], pen: fields[4], rng: fields[5], clip: fields[6], rld: fields[7], spec: fields[8] });

    // значения статичных полей
    // пропускаем только динамические ключи строк таблиц (sk1, sk1_lvl, tl1_n, tl1_x,
    // w1 — оружие) и упакованные __skills/__talents/__weapons.
    // base_*/adv_* и world/wounds/wealth — обычные статичные поля, их restored-им.
    const dynamic = /^(sk\d|tl\d|w\d|__)/;
    for (const [k, v] of Object.entries(data)) {
      if (dynamic.test(k)) continue;
      const el = document.querySelector(`[data-key="${CSS.escape(k)}"]`);
      if (el) el.value = v;
    }
    $("input[data-key=xpTotal]").value = data.xpTotal ?? "400";
    // после восстановления полей применяем сохранённую биографию, если она ещё доступна
    const savedBioId = data.bioId || "";
    if (savedBioId) {
      const career = $("#sel-career").value;
      const bio = BIOGRAPHIES.find(b => b.id === savedBioId && b.career === career);
      if (bio) {
        // опции #sel-bio зависят от профессии — перезаполнить до установки значения
        populateBioSelect();
        $("#sel-bio").value = savedBioId;
        $("#sel-bio").dataset.prev = savedBioId;
        addBioRows(savedBioId, true);
      }
    }
    showCareerKit(false);
    recalc();
    updateBioStatus();
  } finally {
    isApplying = false;
  }
}

/* ---------- сохранение / XML ---------- */
let saveTimer;
function flash(msg) { $("#save-status").textContent = msg; }

function renderCharList(chars) {
  const sel = $("#char-list");
  sel.innerHTML = '<option value="">— выбрать персонажа —</option>';
  for (const c of chars) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = `#${c.id} ${c.name}`;
    sel.appendChild(opt);
  }
  if (currentCharId) sel.value = currentCharId;
}

function updateCharListOption(id, name) {
  const sel = $("#char-list");
  let opt = sel.querySelector(`option[value="${CSS.escape(String(id))}"]`);
  if (!opt) {
    opt = document.createElement("option");
    opt.value = id;
    sel.appendChild(opt);
  }
  opt.textContent = `#${id} ${name || "Безымянный"}`;
}

async function loadCharList() {
  try {
    const r = await fetch(`${API_PREFIX}/characters`);
    if (!r.ok) throw new Error(r.status);
    renderCharList(await r.json());
  } catch (e) {
    flash("не удалось загрузить список персонажей");
  }
}

async function loadCharacter(id) {
  try {
    const r = await fetch(`${API_PREFIX}/characters/${id}`);
    if (!r.ok) throw new Error(r.status);
    const rec = await r.json();
    isApplying = true;
    apply(rec.data);
    isApplying = false;
    currentCharId = String(rec.id);
    try { localStorage.setItem(LS_ID_KEY, currentCharId); } catch (e) {}
    $("#char-list").value = currentCharId;
    sheetDirty = false;
    flash("загружен персонаж");
  } catch (e) {
    flash("не удалось загрузить персонажа");
  }
}

async function saveToServer(force = false) {
  if (isApplying) return;
  if (!currentCharId && !sheetDirty && !force) return; // пустой новый лист не спамим
  const data = collect();
  flash("сохранение…");
  try {
    let r;
    if (currentCharId) {
      r = await fetch(`${API_PREFIX}/characters/${currentCharId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (r.status === 404) {
        // запись исчезла — создаём новую
        r = await fetch(`${API_PREFIX}/characters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
      }
    } else {
      r = await fetch(`${API_PREFIX}/characters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    }
    if (!r.ok) throw new Error(r.status);
    const rec = await r.json();
    currentCharId = String(rec.id);
    try { localStorage.setItem(LS_ID_KEY, currentCharId); } catch (e) {}
    sheetDirty = false;
    updateCharListOption(currentCharId, data.name || "Безымянный");
    flash("сохранено " + new Date().toLocaleTimeString("ru"));
  } catch (e) {
    flash("Не сохранено (offline?)");
  }
}

function flashSave(force = false) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToServer(force), 300);
}
const saveSoon = () => flashSave(true);   // программные изменения — явное сохранение

const esc = s => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function exportXML() {
  const data = collect();
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<darkheresy edition="1" sheet="0.1">\n`;
  for (const [k, v] of Object.entries(data)) xml += `  <f k="${esc(k)}" v="${esc(v)}"/>\n`;
  xml += `</darkheresy>\n`;
  const name = (data.name || "аколит").replace(/[\\/:*?"<>|]/g, "").trim().replace(/\s+/g, "_") || "аколит";
  const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}_dh1e.xml`;
  a.click();
  URL.revokeObjectURL(a.href);
  flash("XML выгружен ✓");
}
function importXML(file) {
  file.text().then(text => {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) return flash("битый XML");
    const root = doc.documentElement;
    // принимаем только XML листа: корень <darkheresy>, динамические данные в <f>
    if (!root || root.tagName !== "darkheresy" || !doc.querySelector("f"))
      return flash("это не XML листа Dark Heresy — импорт отменён");
    const data = {};
    for (const f of doc.querySelectorAll("f")) data[f.getAttribute("k")] = f.getAttribute("v") ?? "";
    apply(data);
    sheetDirty = true;
    flashSave();
    flash("XML импортирован ✓");
  }).catch(e => flash("ошибка импорта: " + e.message));
}

/* ---------- краткая справка по листу (кнопка «Обновить подсказку») ---------- */
function findTalentText(name) {
  if (!name) return "";
  if (TALENT_EFFECTS[name]) return TALENT_EFFECTS[name];
  const base = name.replace(/\s*\(.*?\)\s*$/, "").trim();
  if (TALENT_EFFECTS[base]) return TALENT_EFFECTS[base] + ` (вариант: ${name})`;
  // длиннейший ключ, на который начинается имя («Пси-рейтинг 2» → «Пси-рейтинг»)
  const pref = Object.keys(TALENT_EFFECTS)
    .filter(k => name.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  if (pref) return TALENT_EFFECTS[pref] + ` (вариант: ${name})`;
  return "";
}
function findSkillText(name) {
  if (!name) return "";
  if (SKILL_TEXTS[name]) return SKILL_TEXTS[name];
  const base = name.replace(/\s*\(.*?\)\s*$/, "").trim();
  if (SKILL_TEXTS[base]) return SKILL_TEXTS[base];
  // групповые умения промаркированы звёздочкой («Шифры*», «Предание*» и т.п.)
  if (SKILL_TEXTS[base + "*"]) return SKILL_TEXTS[base + "*"];
  return "";
}
function hcardHtml(name, meta, desc) {
  return `<div class="hcard"><h4>${esc(name)}</h4>` +
    (meta ? `<div class="hmeta">${esc(meta)}</div>` : "") +
    `<div class="hdesc ${desc ? "" : "muted"}">${desc ? esc(desc) : "описания нет в справочнике."}</div></div>`;
}
function buildHint() {
  const parts = [];

  // умения: строки могут дублироваться (вручную + биография) — оставляем первую,
  // цели теста объединяем
  const skMap = new Map();
  for (const tr of $("#skills-tbody").rows) {
    const sel = tr.children[0].querySelector("select");
    const name = sel.value;
    if (!name) continue;
    const opt = sel.selectedOptions[0];
    const meta = opt && opt.dataset.char
      ? `${opt.dataset.type === "b" ? "Базовое" : "Продвинутое"} умение, тест по ${CHARS.find(x => x.key === opt.dataset.char).name}`
      : "характеристика не определена";
    const goal = tr.children[3].textContent.trim();
    let e = skMap.get(name);
    if (!e) skMap.set(name, { name, meta, goals: goal ? [goal] : [] });
    else if (goal && !e.goals.includes(goal)) e.goals.push(goal);
  }
  const sk = [...skMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map(e => hcardHtml(e.name, e.meta + (e.goals.length ? ` · цель Теста: ${e.goals.join(" / ")}` : ""), findSkillText(e.name)));
  parts.push(`<div class="hgroup"><h3>Умения</h3>` +
    (sk.length ? `<div class="hcards">${sk.join("")}</div>` : `<p class="muted">— ничего не добавлено</p>`) + `</div>`);

  // таланты: дубликаты (вручную + биография) объединяем, заметки сливаем
  const tlMap = new Map();
  for (const tr of $("#talents-tbody").rows) {
    const name = tr.children[0].querySelector("select").value;
    if (!name) continue;
    const note = tr.children[1].firstChild.value.trim();
    let e = tlMap.get(name);
    if (!e) tlMap.set(name, { name, notes: note ? [note] : [] });
    else if (note && !e.notes.includes(note)) e.notes.push(note);
  }
  const tl = [...tlMap.values()]
    .sort((a, b) => a.name.localeCompare(b.name, "ru"))
    .map(e => {
      const text = findTalentText(e.name);
      return hcardHtml(e.name,
        e.notes.length ? `заметка: ${e.notes.join(" · ")}` : "",
        text || "см. гл. IV книги; подтипы групповых талантов уточняй в скобках.");
    });
  parts.push(`<div class="hgroup"><h3>Таланты и способности</h3>` +
    (tl.length ? `<div class="hcards">${tl.join("")}</div>` : `<p class="muted">— ничего не добавлено</p>`) + `</div>`);

  // оружие (из введённых характеристик)
  let wp = [];
  for (const tr of $("#weapons-tbody").rows) {
    const f = {};
    for (let i = 0; i < 9; i++) f[W_FIELDS[i][0]] = tr.children[i].firstChild.value.trim();
    if (!f.name) continue;
    const stats = [
      f.cls && `класс: ${f.cls}`,
      f.dmg && `урон: ${f.dmg}`,
      f.dtyp && `тип: ${f.dtyp}`,
      f.pen && `пробитие: ${f.pen}`,
      f.rng && `дальность: ${f.rng}`,
      f.clip && `обойма: ${f.clip}`,
      f.rld && `перезарядка: ${f.rld}`,
      f.spec && `особое: ${f.spec}`
    ].filter(Boolean).join(", ");
    wp.push(`<li><b>${esc(f.name)}</b> — ${stats ? esc(stats) : "характеристики не заполнены (см. Арсенал, гл. V)"}.`);
  }
  parts.push(`<div class="hgroup"><h3>Оружие</h3>` +
    (wp.length ? `<ul>${wp.join("")}</ul>` : `<p class="muted">— ничего не добавлено</p>`) + `</div>`);

  // снаряжение (текст из поля «Имущество»)
  const gearLines = ($("textarea[data-key=gear]").value || "")
    .split(/[;\n]/).map(s => s.trim()).filter(Boolean);
  parts.push(`<div class="hgroup"><h3>Снаряжение</h3>` +
    (gearLines.length
      ? `<ul>${gearLines.map(g => `<li>${esc(g)} <span class="muted">— см. Главу V: Арсенал</span></li>`).join("")}</ul>`
      : `<p class="muted">— поле имущества пусто</p>`) + `</div>`);

  $("#hint-box").innerHTML = parts.join("");
  flash("справка обновлена " + new Date().toLocaleTimeString("ru"));
}

/* ---------- биография ---------- */
function populateBioSelect() {
  const sel = $("#sel-bio");
  const careerId = $("#sel-career").value;
  const list = careerId ? BIOGRAPHIES.filter(b => b.career === careerId) : [];
  sel.innerHTML = `<option value="">— биография не куплена —</option>`;
  for (const b of list) sel.appendChild(new Option(`${b.name} (${b.cost} ОО)`, b.id));
}

function bioCost(id = $("#sel-bio").value) {
  const b = id ? BIOGRAPHIES.find(x => x.id === id) : null;
  return b ? b.cost : 0;
}

function bioDescription(bio) {
  const parts = [];
  if (bio.statsChoice) parts.push(`статы: ${bio.statsChoice}`);
  if (bio.skills && bio.skills.length) parts.push(`умения: ${bio.skills.join(", ")}`);
  if (bio.skillBasic && bio.skillBasic.length) parts.push(`базовые: ${bio.skillBasic.join(", ")}`);
  if (bio.talents && bio.talents.length) parts.push(`таланты: ${bio.talents.join(", ")}`);
  if (bio.wealthMul) parts.push(`богатство ×${bio.wealthMul}`);
  if (bio.notes && bio.notes.length) parts.push(bio.notes.join("; "));
  return parts.length ? parts.join(" · ") : "—";
}

function updateBioStatus() {
  const bio = curBio();
  $("#bio-status").textContent = bio
    ? `${bio.cost} ОО · ${bioDescription(bio)}`
    : ($("#sel-career").value ? "не куплена" : "выбери профессию");
}

/* удалить все строки, добавленные текущей биографией */
function clearBioRows() {
  for (const tr of $$("#skills-tbody tr[data-src='bio']")) tr.remove();
  for (const tr of $$("#talents-tbody tr[data-src='bio']")) tr.remove();
}

/* добавить строки по id биографии;
   skipExisting — не дублировать умения/таланты, уже восстановленные из сохранения */
function addBioRows(id, skipExisting = false) {
  const bio = BIOGRAPHIES.find(b => b.id === id);
  if (!bio) return;
  const existing = new Set();
  if (skipExisting) {
    for (const tr of $$("#skills-tbody tr[data-src='bio']")) existing.add(tr.children[0].lastChild.value);
    for (const tr of $$("#talents-tbody tr[data-src='bio']")) existing.add(tr.children[0].lastChild.value);
  }
  for (const s of (bio.skills || [])) if (!skipExisting || !existing.has(s)) addSkillRow(s, "untrained", "bio");
  for (const s of (bio.skillBasic || [])) if (!skipExisting || !existing.has(s)) addSkillRow(s, "basic", "bio");
  for (const t of (bio.talents || [])) if (!skipExisting || !existing.has(t)) addTalentRow(t, "", "bio");
}

function onCareerChange() {
  const careerId = $("#sel-career").value;
  const oldBioId = $("#sel-bio").value;
  const oldBio = oldBioId ? BIOGRAPHIES.find(b => b.id === oldBioId) : null;

  // если старая биография не подходит к новой профессии — снять и вернуть ОО
  if (oldBio && oldBio.career !== careerId) {
    clearBioRows();
    $("#sel-bio").value = "";
  }

  populateBioSelect();
  // если старая биография всё ещё в списке — оставляем выбранной
  if (oldBio && oldBio.career === careerId) $("#sel-bio").value = oldBioId;
  updateBioStatus();
  showCareerKit(true);
}

function onBioChange() {
  const newId = $("#sel-bio").value;
  const oldId = $("#sel-bio").dataset.prev || "";

  // убрать старые биографические строки
  clearBioRows();

  if (!newId) {
    $("#sel-bio").dataset.prev = "";
    updateBioStatus();
    recalc();
    sheetDirty = true;
    flashSave();
    return;
  }

  const bio = BIOGRAPHIES.find(b => b.id === newId);
  if (!bio) return;

  // проверка доступных ОО (bioCost уже вычитается в recalc из xpFree)
  const xpTotal = num($("input[data-key=xpTotal]").value);
  const xpSpent = num($("input[data-key=xpSpent]").value);
  if (xpTotal - xpSpent < bio.cost) {
    flash(`недостаточно ОО: нужно ${bio.cost}, доступно ${xpTotal - xpSpent}`);
    $("#sel-bio").value = oldId;
    if (oldId) addBioRows(oldId);
    updateBioStatus();
    recalc();
    return;
  }

  addBioRows(newId);
  $("#sel-bio").dataset.prev = newId;
  updateBioStatus();
  recalc();
  sheetDirty = true;
  flashSave();
  flash(`куплена биография: ${bio.name} (−${bio.cost} ОО)`);
}

/* ---------- запуск ---------- */
async function init() {
  buildChars();

  for (const w of WORLDS) $("#sel-world").appendChild(new Option(w.name, w.id));
  for (const c of CAREERS) $("#sel-career").appendChild(new Option(c.name, c.id));

  $("#sel-world").addEventListener("change", () => showCareerKit(false));
  $("#sel-career").addEventListener("change", onCareerChange);

  populateBioSelect();
  $("#sel-bio").addEventListener("change", onBioChange);

  $("#career-kit").addEventListener("click", e => {
    const btn = e.target.closest(".kit-toggle");
    if (!btn) return;
    careerKitExpanded = !careerKitExpanded;
    const body = $("#career-kit-body");
    const arrow = btn.querySelector(".kit-toggle-arrow");
    if (body) {
      body.classList.toggle("collapsed", !careerKitExpanded);
      body.hidden = !careerKitExpanded;
    }
    if (arrow) arrow.textContent = careerKitExpanded ? "▾" : "▸";
    btn.setAttribute("aria-expanded", String(careerKitExpanded));
  });

  $("#btn-wounds").onclick     = rollWounds;
  $("#btn-fate").onclick       = rollFate;
  $("#btn-wealth").onclick     = rollWealth;
  $("#btn-sanction").onclick   = rollSanction;
  $("#btn-roll-chars").onclick = rollAllChars;
  $("#btn-add-skill").onclick  = () => { addSkillRow(); sheetDirty = true; flashSave(); };
  $("#btn-add-talent").onclick = () => { addTalentRow(); sheetDirty = true; flashSave(); };
  $("#btn-add-weapon").onclick = () => { addWeaponRow(); sheetDirty = true; flashSave(); };
  $("#btn-hint").onclick = buildHint;

  $("#btn-export").onclick = exportXML;
  $("#btn-print").onclick  = () => window.print();
  $("#btn-import").onclick = () => $("#file-import").click();
  $("#file-import").addEventListener("change", e => { if (e.target.files[0]) importXML(e.target.files[0]); e.target.value = ""; });
  $("#btn-reset").onclick = () => {
    if (!confirm("Очистить лист? Текущая запись останется в базе; будет создан чистый лист.")) return;
    try {
      localStorage.removeItem(LS_ID_KEY);
      localStorage.removeItem(LS_SHEET_KEY);
    } catch (e) { /* хранилище недоступно */ }
    location.reload();
  };

  document.addEventListener("input", e => {
    if (e.target.dataset && e.target.dataset.key) {
      sheetDirty = true;
      flashSave();
      recalc();
    }
  });

  $("#char-list").addEventListener("change", async () => {
    const id = $("#char-list").value;
    if (!id) return;
    await saveToServer();
    await loadCharacter(id);
  });

  $("#btn-new-character").onclick = async () => {
    await saveToServer();
    const data = collect();
    data.name = "";                       // новый лист — копия текущего, но без имени
    try {
      const r = await fetch(`${API_PREFIX}/characters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error(r.status);
      const rec = await r.json();
      currentCharId = String(rec.id);
      try { localStorage.setItem(LS_ID_KEY, currentCharId); } catch (e) {}
      apply(data);
      await loadCharList();
      $("#char-list").value = currentCharId;
      sheetDirty = false;
      flash("новый персонаж создан");
    } catch (e) {
      flash("не удалось создать персонажа");
    }
  };

  // Загружаем список персонажей
  await loadCharList();

  let restored = false;

  // 1) Если в localStorage есть id и запись существует — загружаем её
  const savedId = localStorage.getItem(LS_ID_KEY);
  if (savedId && $(`#char-list option[value="${CSS.escape(savedId)}"]`)) {
    await loadCharacter(savedId);
    restored = true;
  }

  // 2) Миграция: база пуста, но есть старое локальное сохранение
  if (!restored && $("#char-list").options.length <= 1) {
    try {
      const saved = localStorage.getItem(LS_SHEET_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        const r = await fetch(`${API_PREFIX}/characters`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (r.ok) {
          const rec = await r.json();
          currentCharId = String(rec.id);
          try { localStorage.setItem(LS_ID_KEY, currentCharId); } catch (e) {}
          apply(data);
          await loadCharList();
          $("#char-list").value = currentCharId;
          restored = true;
          flash("миграция из локального хранилища");
        }
      }
    } catch (e) { /* миграция не удалась — оставляем пустой лист */ }
  }

  if (!restored) {
    addSkillRow();
    addTalentRow();
    addWeaponRow();
  }

  // xpTotal — поле со значением по умолчанию тоже попадает в data-key
  if (!$("input[data-key=xpTotal]").value) $("input[data-key=xpTotal]").value = "400";
  // если применили сохранённый лист — перезаполнение селекта не должно
  // затирать восстановленный выбор биографии
  const restoredBio = $("#sel-bio").value;
  populateBioSelect();
  if (restoredBio) $("#sel-bio").value = restoredBio;
  updateBioStatus();
  recalc();
}
document.addEventListener("DOMContentLoaded", init);
