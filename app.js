"use strict";
/* Лист персонажа Dark Heresy 1e — логика */

const $  = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const die = n => 1 + Math.floor(Math.random() * n);   // dN, включая N
const d10 = () => die(10);
const d5  = () => Math.ceil(d10() / 2);               // d10: 1-2→1 … 9-10→5
const num = v => parseInt(v, 10) || 0;

let uidSeq = 0;
let charEditMode = false;
let skillHintsVisible = true;

/* ---------- загружаемые справочники ---------- */
let WORLDS = [];
let CHARS = [];
let CAREERS = [];
let CAREER_ADVANCEMENTS = [];
let SKILL_LIST = [];
let SKILL_GROUPS = {};
let SKILL_TEXTS = {};
let SKILLS = [];
let BIOGRAPHIES = [];
let TALENTS = [];
let SANCTIONS = {};
let CARRY_TABLE = [];
let TALENT_EFFECTS = {};
let ARMORY_CATALOG = [];

/* ---------- серверное хранилище ---------- */
const API_PREFIX = "/api";
const LS_ID_KEY = "dh1e-current-id-v1";     // id текущего персонажа
const LS_SHEET_KEY = "dh1e-sheet-v1";       // старое локальное сохранение (миграция)
const LS_MIGRATED_KEY = "dh1e-sheet-migrated-v1";
let authUser = null;
const activeCharStorageKey = () => `${LS_ID_KEY}:${authUser.id}`;
let currentCharId = null;                   // id персонажа в SQLite
let isApplying = false;                     // guard: не сохранять во время apply()
let sheetDirty = false;                     // пользователь менял лист
let suppressAutosave = false;               // переход/удаление персонажа
let gearItems = [];
let arsenalCart = new Map();
let arsenalPage = 1;
const ARSENAL_PAGE_SIZE = 20;
let profileEditorSnapshot = null;
let stateEditorSnapshot = null;

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

/* Модификаторы, показываемые под результатом броска: мир, профессия и предыстория. */
function fixBreakdown(key) {
  const w = curWorld();
  if (!w) return "мир не выбран";
  const parts = [`мир ${fmtMod(w.mods[key] || 0)}`];
  for (const f of charFixes(key)) {
    const source = f.bio ? f.src.replace(/^Биография:\s*/i, "") : f.src;
    parts.push(`${fmtMod(f.v)} ${source}`);
  }
  return parts.join(" · ");
}

function buildChars() {
  const root = $("#chars-tbody");
  const legacy = $("#legacy-fields");
  root.innerHTML = "";
  for (const c of CHARS) {
    const card = document.createElement("div");
    card.className = "stat";
    card.dataset.stat = c.key;
    card.innerHTML =
      `<label>${c.name}</label><strong id="val_${c.key}">—</strong>` +
      `<input class="stat-edit-input" id="edit_${c.key}" data-stat-edit="${c.key}" type="number" inputmode="numeric" step="1" placeholder="—" aria-label="Базовое значение: ${c.name}" hidden>` +
      `<small><span id="roll_${c.key}">—</span><span id="stat-separator_${c.key}"> · </span><span id="fix_${c.key}"></span></small>`;
    root.appendChild(card);
    for (const prefix of ["base_", "adv_"]) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.dataset.key = prefix + c.key;
      if (prefix === "adv_") input.value = "0";
      legacy.appendChild(input);
    }
  }
}
const fmtMod = m => (m >= 0 ? "+" : "") + m;

function setCharEditMode(enabled) {
  charEditMode = enabled;
  const button = $("#btn-edit-chars");
  const label = enabled ? "Показать характеристики с модификаторами" : "Редактировать базовые значения характеристик";
  button.setAttribute("aria-pressed", String(enabled));
  button.setAttribute("aria-label", label);
  button.title = label;
  $("#stats-kicker").textContent = enabled ? "База · без модификаторов" : "Итог · бонус";
}

function getVal(key) {
  const base = document.querySelector(`input[data-key="base_${key}"]`);
  const adv  = document.querySelector(`input[data-key="adv_${key}"]`);
  return num(base && base.value) + num(adv && adv.value);
}

/* ---------- пересчёт ---------- */
function recalc() {
  const vals = {};
  const world = curWorld();
  for (const c of CHARS) {
    const baseValue = $("input[data-key='base_" + c.key + "']").value;
    const extra = charFixes(c.key).reduce((sum, f) => sum + f.v, 0);
    const v = getVal(c.key) + (world ? world.mods[c.key] : 0) + extra;
    vals[c.key] = v;
    $("#val_" + c.key).textContent = v || "—";
    $("#roll_" + c.key).textContent = baseValue || "—";
    $("#fix_" + c.key).textContent = fixBreakdown(c.key);
    const card = $(`[data-stat="${c.key}"]`);
    const editInput = $("#edit_" + c.key);
    if (editInput.value !== baseValue) editInput.value = baseValue;
    editInput.hidden = !charEditMode;
    $("#val_" + c.key).hidden = charEditMode;
    $("#roll_" + c.key).hidden = charEditMode;
    $("#stat-separator_" + c.key).hidden = charEditMode;
    card.classList.toggle("editing", charEditMode);
  }
  const bio = curBio();
  const bioCost = bio ? bio.cost : 0;
  const xpFree = Math.max(0, num($("input[data-key=xpTotal]").value) - num($("input[data-key=xpSpent]").value) - bioCost);
  $("#xp-available").textContent = xpFree;
  $("#xp-total-input").value = $("input[data-key=xpTotal]").value || "400";
  $("#xp-spent-input").value = $("input[data-key=xpSpent]").value || "0";

  for (const tr of $("#skills-tbody").rows) calcSkillRow(tr);
  renderSkillPreview();
  renderTalentPreview();
  renderProfile();
  renderState();
  renderGear();
  updateCareerAdvancementStatus();
  if (sheetDirty && !isApplying) flashSave();   // чистый только что загруженный лист не отправляем
}

/* ---------- умения ---------- */
function addSkillRow(name = "", lvl = "untrained", src = "manual", selectedChoiceKey = "", xpCost = 0) {
  const tb = $("#skills-tbody");
  const tr = document.createElement("tr");
  if (src !== "manual") tr.dataset.src = src;
  tr.dataset.xpCost = String(Math.max(0, num(xpCost)));

  const sel = document.createElement("select");
  sel.dataset.key = "sk" + (++uidSeq);
  sel.className = "sk-name";
  populateSkillSelect(sel, availableSkillGroups(), "", name, Boolean(name));

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
  delTd.querySelector("button").onclick = () => {
    const xpCost = Math.max(0, num(tr.dataset.xpCost));
    if (xpCost) {
      const xpSpent = num($("input[data-key=xpSpent]").value);
      $("input[data-key=xpSpent]").value = String(Math.max(0, xpSpent - xpCost));
    }
    tr.remove(); sheetDirty = true; flashSave(); recalc();
  };
  tr.append(nameTd, charTd, lvlTd, goalTd, delTd);
  tb.appendChild(tr);

  if (name) sel.value = name;
  if (selectedChoiceKey) {
    const selectedOption = Array.from(sel.options).find(option => option.dataset.choiceKey === selectedChoiceKey);
    if (selectedOption) selectedOption.selected = true;
  }
  lvlSel.value = lvl;
  updateSkillHint(sel);
  sel.onchange    = () => {
    const advancementLevel = sel.selectedOptions[0]?.dataset.level;
    if (advancementLevel) lvlSel.value = advancementLevel;
    updateSkillHint(sel); sheetDirty = true; calcSkillRow(tr); renderSkillPreview(); flashSave();
  };
  lvlSel.onchange = () => { sheetDirty = true; calcSkillRow(tr); renderSkillPreview(); flashSave(); };
  calcSkillRow(tr);
}

function updateSkillHint(select) {
  const hint = skillHintsVisible ? findSkillText(select.value) : "";
  if (hint) select.title = hint;
  else select.removeAttribute("title");
}

function calcSkillRow(tr) {
  const [selName, selLvl] = tr.querySelectorAll("select");
  const opt = selName.selectedOptions[0];
  const charTd = tr.children[1], goalTd = tr.children[3];
  if (!opt || !opt.dataset.char) { charTd.textContent = ""; goalTd.textContent = "—"; return; }
  charTd.textContent = CHARS.find(x => x.key === opt.dataset.char).abbr;
  const world = curWorld();
  const base = getVal(opt.dataset.char) + (world ? world.mods[opt.dataset.char] : 0) +
    charFixes(opt.dataset.char).reduce((sum, fix) => sum + fix.v, 0);
  let mod = 0;
  let target = base;
  if (selLvl.value === "basic") target = Math.floor(base / 2);
  else if (selLvl.value === "trained") mod = 10;
  else if (selLvl.value === "mastery") mod = 20;
  goalTd.textContent = base ? String(target + mod) : "—";
}

/* ---------- таланты ---------- */
function addTalentRow(name = "", note, src = "manual") {
  const tb = $("#talents-tbody");
  const tr = document.createElement("tr");
  if (src !== "manual") tr.dataset.src = src;

  const sel = document.createElement("select");
  sel.dataset.key = "tl" + (++uidSeq) + "_n";
  sel.className = "talent-name";
  populateTalentSelect(sel, availableTalentGroups(), "", name, Boolean(name));

  const noteEl = document.createElement("input");
  noteEl.type = "text";
  noteEl.dataset.key = sel.dataset.key.replace("_n", "_x");
  noteEl.className = "talent-note";
  noteEl.placeholder = "примечание / подтип";
  const nameCell = document.createElement("td"); nameCell.appendChild(sel);
  const noteCell = document.createElement("td"); noteCell.appendChild(noteEl);
  const deleteCell = document.createElement("td");
  const del = document.createElement("button"); del.type = "button"; del.className = "skill-delete"; del.textContent = "×";
  del.setAttribute("aria-label", "Удалить талант");
  del.onclick = () => { tr.remove(); sheetDirty = true; flashSave(); recalc(); };
  deleteCell.appendChild(del);
  tr.append(nameCell, noteCell, deleteCell);
  tb.appendChild(tr);

  if (name) sel.value = name;
  else sel.selectedIndex = 0;   // гарантируем «пусто» даже после истории опций
  const summary = findTalentText(name);
  noteEl.value = note === undefined ? summary : note;
  let generatedNote = noteEl.value === summary ? summary : "";
  sel.onchange = () => {
    if (!noteEl.value.trim() || (generatedNote && noteEl.value === generatedNote)) {
      noteEl.value = findTalentText(sel.value);
      generatedNote = noteEl.value;
    }
    sheetDirty = true; flashSave(); recalc();
  };
  noteEl.oninput = () => {
    if (noteEl.value !== generatedNote) generatedNote = "";
    sheetDirty = true; flashSave();
  };
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
  const rank = $(`[data-key="rank"]`);
  updateCharacterRankOptions({ preferredRank: overwriteRank ? "" : rank.value, defaultToLowest: overwriteRank || !rank.value });
  refreshAdvancementSelectors();
  renderProfile();
  recalc();
}

function updateCharacterRankOptions({ preferredRank = "", defaultToLowest = false } = {}) {
  const select = $("#profile-rank");
  if (!select) return;

  const career = CAREERS.find(item => item.id === $("#sel-career").value);
  const world = curWorld();
  const careerRanks = CAREER_ADVANCEMENTS.filter(item => item.career === career?.id);
  const eligibleRanks = careerRanks
    .filter(item => !world || item.worlds.includes(world.id))
    .sort((a, b) => a.minXp - b.minXp);
  const availableNames = new Set(eligibleRanks.map(item => item.rank));
  const careerRankNames = new Set(careerRanks.map(item => item.rank));
  select.replaceChildren(new Option("— выбери ранг —", ""));

  const addedNames = new Set();
  for (const item of eligibleRanks) {
    if (!addedNames.has(item.rank)) {
      select.appendChild(new Option(item.rank, item.rank));
      addedNames.add(item.rank);
    }
  }

  const requestedRank = String(preferredRank || "");
  let selectedRank = "";
  if (!defaultToLowest && requestedRank && availableNames.has(requestedRank)) {
    selectedRank = requestedRank;
  } else if (!defaultToLowest && requestedRank && !careerRankNames.has(requestedRank)) {
    // Сохраняем старые/импортированные значения, которых нет в новой таблице рангов.
    select.appendChild(new Option(requestedRank, requestedRank));
    selectedRank = requestedRank;
  } else if (eligibleRanks.length) {
    selectedRank = eligibleRanks[0].rank;
  } else if (!careerRanks.length && career?.rank) {
    select.appendChild(new Option(career.rank, career.rank));
    selectedRank = career.rank;
  }
  select.value = selectedRank;
}

/* ---------- броски ---------- */
const lookup = (table, roll) => {
  for (const [a, b, v] of table) if (roll >= a && roll <= b) return v;
  return 0;
};
const rollWounds = () => {
  const world = curWorld();
  const total = d5() + (world ? world.wounds : 0);
  $("#state-wounds-total").value = total;
  $("#state-wounds-current").value = total;
  recalc();
  saveSoon();
  flash("раны: d5" + fmtMod(world ? world.wounds : 0) + (world ? "" : " (мир не выбран)"));
};
const rollFate = () => {
  const world = curWorld();
  if (!world) return flash("сначала выбери родной мир");
  const n = d10(), pts = lookup(world.fate, n);
  $("#state-fate-total").value = pts;
  $("#state-fate-current").value = pts;
  sheetDirty = true;
  recalc();
  flashSave();
  flash(`судьба: d10=${n} → ${pts} очк.`);
};
const rollWealth = () => {
  const career = CAREERS.find(x => x.id === $("#sel-career").value);
  if (!career) return flash("сначала выбери профессию");
  const formula = career.wealth.match(/^(\d+)\+(\d+)d(\d+)$/);
  let value = formula ? +formula[1] : +career.wealth;
  if (formula) for (let i = 0; i < +formula[2]; i++) value += die(+formula[3]);
  const bio = curBio();
  if (bio && bio.wealthMul) value = Math.floor(value * bio.wealthMul);
  $("#wealth-input").value = value;
  sheetDirty = true; recalc(); flashSave();
  flash(`богатство: ${career.wealth}${bio?.wealthMul ? ` ×${bio.wealthMul}` : ""} = ${value} тронов`);
};
const rollSanction = () => {
  const d100 = (d10() - 1) * 10 + d10();
  for (const range of Object.keys(SANCTIONS)) {
    const [a, b] = range.split("-").map(Number);
    if (d100 >= a && d100 <= b) {
      flash(`санкционирование: ${d100}`);
      return;
    }
  }
};
const rollAllChars = () => {
  const world = curWorld();
  for (const c of CHARS) {
    const mod = world ? world.mods[c.key] : 0;
    document.querySelector(`input[data-key="base_${c.key}"]`).value = d10() + d10();
  }
  recalc();
  sheetDirty = true;
  flashSave();
  flash(world ? "напыление характеристик (2d10+мод. мира): " + world.name
              : "мир не выбран — модификаторы +0");
};

/* ---------- сериализация ---------- */
const RETIRED_FIELDS = new Set(["player", "history", "contacts", "notes"]);
function stripRetiredFields(data) {
  const clean = { ...data };
  for (const key of RETIRED_FIELDS) delete clean[key];
  return clean;
}

function collect() {
  const data = {};
  for (const el of $$("[data-key]")) {
    if (!RETIRED_FIELDS.has(el.dataset.key)) data[el.dataset.key] = el.value ?? "";
  }

  // Экранирование служебных символов упаковки: \ → \\ , ; → \S , | → \P
  const escField = x => String(x ?? "")
    .replace(/\\/g, "\\\\").replace(/;/g, "\\S").replace(/\|/g, "\\P");
  const packRows = (tbody, mapFn, keepSingleEmpty = false) => {
    const rows = [];
    for (const tr of (tbody.rows ? Array.from(tbody.rows) : Array.from(tbody.children))) {
      const t = mapFn(tr).map(escField);
      if (t.some(x => x.trim() !== "")) rows.push(t.join("|"));
    }
    const children = tbody.rows ? Array.from(tbody.rows) : Array.from(tbody.children);
    if (keepSingleEmpty && !rows.length && children.length === 1)
      rows.push(mapFn(children[0]).map(escField).join("|"));
    return rows.join(";");
  };
  data.__skills = packRows($("#skills-tbody"),
    tr => [tr.children[0].lastChild.value, tr.children[2].firstChild.value, tr.dataset.src || "manual", tr.dataset.xpCost || "0"]);
  data.__talents = packRows($("#talents-tbody"),
    tr => [tr.querySelector(".talent-name").value, tr.querySelector(".talent-note").value, tr.dataset.src || "manual"]);
  data.bioId = $("#sel-bio").value;
  data.__weapons = packRows($("#weapons-tbody"),
    tr => Array.from(tr.children).slice(0, 9).map(td => td.firstChild.value), true);
  data.__gearItems = JSON.stringify(gearItems);
  data.__gearMigrated = "1";
  data.__statsRaw = "1";
  return stripRetiredFields(data);
}

function apply(data) {
  data = stripRetiredFields(data || {});
  arsenalCart.clear();
  if (data.__statsRaw !== "1") {
    const storedWorld = WORLDS.find(world => world.id === data.world);
    for (const c of CHARS) {
      const key = `base_${c.key}`;
      if (storedWorld && data[key] != null && String(data[key]).trim() !== "")
        data[key] = String(num(data[key]) - storedWorld.mods[c.key]);
    }
    data.__statsRaw = "1";
  }
  const wasApplying = isApplying;
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
      const [name, lvl, src, xpCost] = parts;
      if (name) addSkillRow(name, lvl || "untrained", ["bio", "career"].includes(src) ? src : "manual", "", xpCost);
    }
    for (const parts of unpack(data.__talents)) {
      const [name, note, src] = parts;
      if (name || note) {
        const source = ["bio", "career"].includes(src) ? src : "manual";
        addTalentRow(name, source === "bio" && !note ? findTalentText(name) : (note || ""), source);
      }
    }
    for (const fields of unpack(data.__weapons)) if (fields.some(Boolean)) addWeaponRow({ name: fields[0], cls: fields[1], dmg: fields[2], dtyp: fields[3], pen: fields[4], rng: fields[5], clip: fields[6], rld: fields[7], spec: fields[8] });

    // значения статичных полей
    // пропускаем только динамические ключи строк таблиц (sk1, sk1_lvl, tl1_n, tl1_x,
    // w1 — оружие) и упакованные __skills/__talents/__weapons.
    // base_*/adv_* и world/wounds/wealth — обычные статичные поля, их restored-им.
    const dynamic = /^(sk\d|tl\d|w\d|__)/;
    for (const el of $$("[data-key]")) {
      if (dynamic.test(el.dataset.key)) continue;
      el.value = el.dataset.key.startsWith("adv_") ? "0" : (el.dataset.key === "xpTotal" ? "400" : "");
    }
    for (const [k, v] of Object.entries(data)) {
      if (dynamic.test(k)) continue;
      if (k.startsWith("__")) continue;
      const el = document.querySelector(`[data-key="${CSS.escape(k)}"]`);
      if (el) el.value = v;
    }
    $("input[data-key=xpTotal]").value = data.xpTotal ?? "400";
    if (data.woundsCurrent == null || data.woundsCurrent === "")
      $("#state-wounds-current").value = data.wounds || "0";
    if (data.fatigueCurrent == null || data.fatigueCurrent === "")
      $("#state-fatigue").value = "0";
    $("#sel-bio").dataset.prev = "";
    populateBioSelect();
    $("#sel-bio").value = "";
    try {
      const parsedGear = JSON.parse(data.__gearItems || "[]");
      gearItems = Array.isArray(parsedGear) ? parsedGear.filter(x => x && typeof x.name === "string") : [];
    } catch { gearItems = []; }
    if (data.__gearMigrated !== "1") {
      const names = new Set(gearItems.map(item => item.name.trim().toLocaleLowerCase("ru")));
      for (const item of readLegacyGearItems()) {
        const key = item.name.trim().toLocaleLowerCase("ru");
        if (!names.has(key)) { gearItems.push(item); names.add(key); }
      }
    }
    // после восстановления полей применяем сохранённую биографию, если она ещё доступна
    const savedBioId = data.bioId || "";
    if (savedBioId) {
      const career = $("#sel-career").value;
      const world = curWorld();
      const bio = BIOGRAPHIES.find(b => b.id === savedBioId && b.career === career &&
        (!world || !b.worlds?.length || b.worlds.includes(world.id)));
      if (bio) {
        $("#sel-bio").value = savedBioId;
        $("#sel-bio").dataset.prev = savedBioId;
        addBioRows(savedBioId, true);
      }
    }
    renderNotes();
    setCharEditMode(false);
    updateCharacterRankOptions({ preferredRank: data.rank, defaultToLowest: !data.rank });
    refreshAdvancementSelectors();
    recalc();
    updateBioStatus();
    renderCareerPreview();
  } finally {
    isApplying = wasApplying;
  }
}

/* ---------- сохранение / XML ---------- */
let saveTimer;
let saveInFlight = null;
function flash(msg) { $("#save-status").textContent = msg; }

function renderCharList(chars) {
  const sel = $("#sheet-switcher");
  sel.replaceChildren();
  if (!chars.length) sel.appendChild(new Option("Нет листов", ""));
  for (const c of chars) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name || `Безымянный #${c.id}`;
    sel.appendChild(opt);
  }
  if (currentCharId) sel.value = currentCharId;
  else if (chars.length) sel.selectedIndex = -1;
  syncDeleteButton();
}

function syncDeleteButton() {
  const button = $("#btn-delete-character");
  if (button) button.disabled = !currentCharId;
}

function updateCharListOption(id, name) {
  const sel = $("#sheet-switcher");
  let opt = sel.querySelector(`option[value="${CSS.escape(String(id))}"]`);
  if (!opt) {
    opt = document.createElement("option");
    opt.value = id;
    sel.appendChild(opt);
  }
  opt.textContent = name || `Безымянный #${id}`;
  sel.value = String(id);
}

async function loadCharList() {
  try {
    const r = await fetch(`${API_PREFIX}/characters`);
    if (!r.ok) throw new Error(r.status);
    const chars = await r.json();
    renderCharList(chars);
    return chars;
  } catch (e) {
    flash("не удалось загрузить список персонажей");
    return null;
  }
}

async function loadCharacter(id) {
  const wasSuppressingAutosave = suppressAutosave;
  suppressAutosave = true;
  clearTimeout(saveTimer);
  try {
    const r = await fetch(`${API_PREFIX}/characters/${id}`);
    if (!r.ok) throw new Error(r.status);
    const rec = await r.json();
    const cleanData = stripRetiredFields(rec.data || {});
    const needsDataMigration = Object.keys(rec.data || {}).some(key => RETIRED_FIELDS.has(key)) || rec.data?.__gearMigrated !== "1" || rec.data?.__statsRaw !== "1";
    sheetDirty = needsDataMigration;
    isApplying = true;
    apply(cleanData);
    isApplying = false;
    currentCharId = String(rec.id);
    try { localStorage.setItem(activeCharStorageKey(), currentCharId); } catch (e) {}
    $("#sheet-switcher").value = currentCharId;
    syncDeleteButton();
    if (needsDataMigration) flashSave();
    else { sheetDirty = false; flash("загружен персонаж"); }
    return true;
  } catch (e) {
    flash("не удалось загрузить персонажа");
    return false;
  } finally {
    suppressAutosave = wasSuppressingAutosave;
    if (!suppressAutosave && sheetDirty) flashSave();
  }
}

async function saveToServer(force = false) {
  if (isApplying || suppressAutosave) return false;
  if (saveInFlight && !await saveInFlight) return false;
  if (!currentCharId && !sheetDirty && !force) return true; // пустой новый лист не спамим
  clearTimeout(saveTimer);
  const data = collect();
  const previousId = currentCharId;
  flash("сохранение…");
  const request = (async () => {
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
      if (previousId && previousId !== currentCharId) {
        const staleOption = $("#sheet-switcher").querySelector(`option[value="${CSS.escape(previousId)}"]`);
        if (staleOption) staleOption.remove();
      }
      try { localStorage.setItem(activeCharStorageKey(), currentCharId); } catch (e) {}
      sheetDirty = false;
      updateCharListOption(currentCharId, data.name || "Безымянный");
      syncDeleteButton();
      flash("сохранено " + new Date().toLocaleTimeString("ru"));
      return true;
    } catch (e) {
      flash("Не сохранено (offline?)");
      return false;
    }
  })();
  saveInFlight = request;
  try {
    return await request;
  } finally {
    if (saveInFlight === request) saveInFlight = null;
  }
}

function flashSave(force = false) {
  clearTimeout(saveTimer);
  if (suppressAutosave) return;
  saveTimer = setTimeout(() => saveToServer(force), 300);
}
const saveSoon = () => flashSave(true);   // программные изменения — явное сохранение

function emptySheetData() {
  const data = {};
  for (const el of $$("[data-key]")) {
    const key = el.dataset.key;
    if (/^(sk\d|tl\d|w\d|__)/.test(key)) continue;
    data[key] = key.startsWith("adv_") ? "0" : "";
  }
  data.xpTotal = "400";
  data.bioId = "";
  data.__skills = "";
  data.__talents = "";
  data.__weapons = "";
  data.__gearItems = "[]";
  data.__gearMigrated = "1";
  data.__statsRaw = "1";
  data.woundsCurrent = "";
  data.fatigueCurrent = "0";
  data.status = "";
  return data;
}

async function deleteCharacter(id) {
  if (!id) return false;
  const deletingActive = String(id) === String(currentCharId);
  const prompt = deletingActive
    ? "Устранить персонажа вместе с несохранёнными изменениями?"
    : "Устранить выбранного персонажа?";
  if (!confirm(prompt)) return false;

  if (!deletingActive && sheetDirty && !await saveToServer()) return false;
  suppressAutosave = true;
  clearTimeout(saveTimer);
  try {
    if (saveInFlight && !await saveInFlight) {
      flash("не удалось завершить сохранение; персонаж не удалён");
      return false;
    }
    const r = await fetch(`${API_PREFIX}/characters/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error(r.status);
    if (deletingActive) {
      currentCharId = null;
      sheetDirty = false;
      apply(emptySheetData());
    }
    try {
      localStorage.removeItem(activeCharStorageKey());
      localStorage.removeItem(LS_ID_KEY);
      localStorage.removeItem(LS_SHEET_KEY);
      localStorage.setItem(LS_MIGRATED_KEY, "1");
    } catch (e) { /* хранилище недоступно */ }

    const chars = await loadCharList();
    if (!chars) throw new Error("character list unavailable");
    const lastCharacter = chars[chars.length - 1];
    if (lastCharacter) {
      sheetDirty = false;
      if (!await loadCharacter(lastCharacter.id)) throw new Error("last character unavailable");
      flash("персонаж удалён; открыт последний в списке");
    } else {
      const data = emptySheetData();
      const create = await fetch(`${API_PREFIX}/characters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!create.ok) throw new Error(create.status);
      const record = await create.json();
      currentCharId = String(record.id);
      try { localStorage.setItem(activeCharStorageKey(), currentCharId); } catch (e) {}
      sheetDirty = false;
      apply(data);
      await loadCharList();
      $("#sheet-switcher").value = currentCharId;
      syncDeleteButton();
      flash("последний персонаж удалён; создан пустой лист");
    }
    return true;
  } catch (e) {
    if (deletingActive && !currentCharId) apply(emptySheetData());
    flash("не удалось удалить персонажа");
    return false;
  } finally {
    suppressAutosave = false;
    if (sheetDirty) flashSave();
  }
}

async function resetSheet() {
  if (!confirm("Удалить текущего персонажа из базы и очистить лист? Несохранённые изменения будут потеряны.")) return;
  suppressAutosave = true;
  clearTimeout(saveTimer);
  try {
    if (saveInFlight) await saveInFlight;
    if (currentCharId) {
      const r = await fetch(`${API_PREFIX}/characters/${currentCharId}`, { method: "DELETE" });
      if (!r.ok) throw new Error(r.status);
    }
  } catch (e) {
    flash("не удалось удалить персонажа; лист не сброшен");
    suppressAutosave = false;
    if (sheetDirty) flashSave();
    return;
  }
  try {
    localStorage.removeItem(activeCharStorageKey());
  } catch (e) { /* хранилище недоступно */ }
  location.reload();
}

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
    apply(stripRetiredFields(data));
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
  const root = $("#dossier-summary");
  root.replaceChildren();
  const section = (title, className, values) => {
    const box = document.createElement("section"); box.className = `brief-section ${className}`;
    const heading = document.createElement("h3"); heading.textContent = title; box.appendChild(heading);
    if (typeof values === "string") {
      const p = document.createElement("p"); p.textContent = values || "Записей нет."; box.appendChild(p);
    } else if (values.length) {
      const list = document.createElement("ul");
      for (const value of values) { const li = document.createElement("li"); li.textContent = value; list.appendChild(li); }
      box.appendChild(list);
    } else {
      const p = document.createElement("p"); p.className = "brief-empty"; p.textContent = "Записей нет."; box.appendChild(p);
    }
    root.appendChild(box);
  };
  section("Идентификация", "brief-identity", `${$("#char-name").textContent} · ${$("#char-rank").textContent} · ${$("#char-career").textContent} · ${$("#char-world").textContent} · ${$("#char-age").textContent} · ${$("#char-status").textContent}`);
  section("Характеристики", "brief-stats", CHARS.map(c => `${c.name}: ${$("#val_" + c.key).textContent} · выпало ${$("#roll_" + c.key).textContent} · ${$("#fix_" + c.key).textContent}`));
  const skills = Array.from($("#skills-tbody").rows).map(tr => {
    const name = tr.children[0].querySelector("select").value;
    return name ? `${name} · ${tr.children[2].querySelector("select").selectedOptions[0]?.textContent || ""} · цель ${tr.children[3].textContent}` : "";
  }).filter(Boolean);
  section("Умения", "brief-skills", skills);
  section("Таланты и способности", "brief-talents", Array.from($("#talents-tbody").children).map(row => row.querySelector(".talent-name").value).filter(Boolean));
  section("Арсенал и имущество", "brief-gear", Array.from($("#gear-preview-list").children).filter(x => x.classList.contains("item")).map(x => x.textContent.trim()));
  flash("справка обновлена " + new Date().toLocaleTimeString("ru"));
}

/* ---------- биография ---------- */
function populateBioSelect() {
  const sel = $("#sel-bio");
  const careerId = $("#sel-career").value;
  const selectedId = sel.value;
  const world = curWorld();
  const list = careerId ? BIOGRAPHIES.filter(b => b.career === careerId &&
    (!world || !b.worlds?.length || b.worlds.includes(world.id))) : [];
  sel.innerHTML = `<option value="">— биография не куплена —</option>`;
  for (const b of list) sel.appendChild(new Option(`${b.name} (${b.cost} ОО)`, b.id));
  if (list.some(b => b.id === selectedId)) sel.value = selectedId;
}

function availableTalentGroups() {
  const groups = [];
  const addGroup = (label, options) => {
    const sorted = options.filter(item => item.name).sort((a, b) => a.name.localeCompare(b.name, "ru"));
    if (sorted.length) groups.push({ label, options: sorted });
  };
  const career = CAREERS.find(item => item.id === $("#sel-career").value);
  const world = curWorld();

  if (world) {
    const features = (world.hwFeatures || []).map(feature => `${feature.n || ""} ${feature.t || ""}`).join(" ").toLocaleLowerCase("ru");
    addGroup(`Мир · ${world.name}`,
      TALENTS.filter(name => features.includes(name.toLocaleLowerCase("ru"))).map(name => ({ name, cost: 0 })));
  }

  if (career) {
    addGroup(`Стартовый набор · ${career.name}`,
      careerPackage(career).talents.flat().map(name => ({ name, cost: 0 })));

    const bio = curBio();
    if (bio && (!world || !bio.worlds?.length || bio.worlds.includes(world.id)))
      addGroup(`Биография · ${bio.name} (${bio.cost} ОО)`, (bio.talents || []).map(name => ({ name, cost: 0 })));

    const ranks = CAREER_ADVANCEMENTS
      .filter(item => item.career === career.id && (!world || item.worlds.includes(world.id)))
      .sort((a, b) => a.minXp - b.minXp);
    const selectedRank = ranks.find(item => item.rank === $("#profile-rank").value);
    if (selectedRank) {
      for (const rank of ranks.filter(item => item.minXp <= selectedRank.minXp)) {
        addGroup(`Ранг · ${rank.rank}`,
          (rank.advancements || []).filter(item => item.type === "talent")
            .map(item => ({ name: item.name, cost: item.cost, requirements: item.requirements || "" })));
      }
    }
  }

  return groups;
}

function skillMeta(name) {
  const known = SKILLS.find(skill => skill.name === name);
  if (known) return known;
  const match = name.match(/^(.+?)\s*\((.+)\)$/);
  const base = match ? `${match[1].trim()}*` : name;
  const template = SKILL_LIST.find(item => item[0] === base || item[0] === base.replace("*", ""));
  return { name, type: template?.[1] || "a", char: template?.[2] || "int" };
}

function skillAdvancementOption(item) {
  const match = item.name.match(/^(.*?)\s*(\+10|\+20)$/);
  return {
    name: match ? match[1].trim() : item.name,
    displayName: item.name,
    cost: item.cost,
    requirements: item.requirements || "",
    level: match ? (match[2] === "+10" ? "trained" : "mastery") : "",
  };
}

function normalizeHomeworldSkill(value) {
  const name = String(value || "").trim();
  const suffix = name.match(/\s+\(([^()]*)\)$/);
  return suffix && CHARS.some(char => char.abbr === suffix[1]) ? name.slice(0, suffix.index).trim() : name;
}

function availableSkillGroups() {
  const groups = [];
  const addGroup = (label, skills) => {
    for (const type of ["b", "a"]) {
      const unique = new Map();
      for (const item of skills) {
        if (!item.name) continue;
        const meta = skillMeta(item.name);
        if (meta.type !== type) continue;
        unique.set(`${item.name}\u0000${item.displayName || item.name}\u0000${item.cost ?? 0}\u0000${item.level || ""}`,
          { ...meta, ...item, cost: item.cost ?? 0 });
      }
      const options = [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "ru"));
      if (options.length)
        groups.push({ label: `${label} · ${type === "b" ? "Базовые" : "Продвинутые"}`, options });
    }
  };

  const career = CAREERS.find(item => item.id === $("#sel-career").value);
  const world = curWorld();
  if (world) addGroup(`Мир · ${world.name}`,
    (world.hwSkills || []).map(value => ({ name: normalizeHomeworldSkill(value), cost: 0 })));

  if (career) {
    addGroup(`Стартовый набор · ${career.name}`,
      careerPackage(career).skills.flat().map(name => ({ name, cost: 0 })));

    const bio = curBio();
    if (bio && (!world || !bio.worlds?.length || bio.worlds.includes(world.id)))
      addGroup(`Биография · ${bio.name} (${bio.cost} ОО)`,
        [...(bio.skills || []), ...(bio.skillBasic || [])].map(name => ({ name, cost: 0 })));

    const ranks = CAREER_ADVANCEMENTS
      .filter(item => item.career === career.id && (!world || item.worlds.includes(world.id)))
      .sort((a, b) => a.minXp - b.minXp);
    const selectedRank = ranks.find(item => item.rank === $("#profile-rank").value);
    if (selectedRank) {
      for (const rank of ranks.filter(item => item.minXp <= selectedRank.minXp))
        addGroup(`Ранг · ${rank.rank}`,
          (rank.advancements || []).filter(item => item.type === "skill")
            .map(skillAdvancementOption));
    }
  }

  return groups;
}

function availableSkillNames(groups = availableSkillGroups()) {
  return [...new Set(groups.flatMap(group => group.options.map(item => item.name)))];
}

function populateSkillSelect(select, groups, placeholder, selected = "", preserveUnavailable = false, uniqueValues = false) {
  select.replaceChildren(new Option(placeholder, ""));
  const available = new Set();
  for (const [groupIndex, group] of groups.entries()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const [itemIndex, item] of group.options.entries()) {
      const abbr = CHARS.find(char => char.key === item.char)?.abbr || "?";
      const requirements = item.requirements ? ` · Требования: ${item.requirements}` : "";
      const option = new Option(`${item.displayName || item.name} [${abbr}] (${item.cost ?? 0} ОО)${requirements}`,
        uniqueValues ? `skill-${groupIndex}-${itemIndex}` : item.name);
      option.dataset.choiceKey = `${groupIndex}-${itemIndex}`;
      option.dataset.skillName = item.name;
      option.dataset.type = item.type;
      option.dataset.char = item.char;
      option.dataset.cost = String(item.cost ?? 0);
      if (item.level) option.dataset.level = item.level;
      optgroup.appendChild(option);
      available.add(item.name);
    }
    select.appendChild(optgroup);
  }
  if (selected && preserveUnavailable && !available.has(selected)) {
    const meta = skillMeta(selected);
    const abbr = CHARS.find(char => char.key === meta.char)?.abbr || "?";
    const option = new Option(`${selected} [${abbr}] (уже в листе)`, selected);
    option.dataset.type = meta.type;
    option.dataset.char = meta.char;
    select.appendChild(option);
  }
  select.value = selected && (available.has(selected) || preserveUnavailable) ? selected : "";
}

function refreshSkillSelectors() {
  const groups = availableSkillGroups();
  const available = new Set(availableSkillNames(groups));
  const addSelect = $("#skill-add-name");
  if (addSelect) {
    populateSkillSelect(addSelect, groups, "— выбери навык —", "", false, true);
  }
  for (const select of $$(".sk-name")) {
    const selected = select.value;
    populateSkillSelect(select, groups, "", selected, Boolean(selected) && !available.has(selected));
    updateSkillHint(select);
  }
}

function availableTalentNames(groups = availableTalentGroups()) {
  return [...new Set(groups.flatMap(group => group.options.map(item => item.name)))];
}

function populateTalentSelect(select, groups, placeholder, selected = "", preserveUnavailable = false, uniqueValues = false) {
  select.replaceChildren(new Option(placeholder, ""));
  const available = new Set();
  for (const [groupIndex, group] of groups.entries()) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const [itemIndex, item] of group.options.entries()) {
      const requirements = item.requirements ? ` · Требования: ${item.requirements}` : "";
      const option = new Option(`${item.name} (${item.cost ?? 0} ОО)${requirements}`,
        uniqueValues ? `talent-${groupIndex}-${itemIndex}` : item.name);
      option.dataset.talentName = item.name;
      option.dataset.cost = String(item.cost ?? 0);
      optgroup.appendChild(option);
      available.add(item.name);
    }
    select.appendChild(optgroup);
  }
  if (selected && preserveUnavailable && !available.has(selected))
    select.appendChild(new Option(`${selected} (уже в листе)`, selected));
  select.value = selected && (available.has(selected) || preserveUnavailable) ? selected : "";
}

function refreshAdvancementSelectors() {
  const groups = availableTalentGroups();
  const available = new Set(availableTalentNames(groups));
  const addSelect = $("#talent-add-name");
  if (addSelect) {
    populateTalentSelect(addSelect, groups, "— выбери талант —", "", false, true);
  }

  for (const select of $$(".talent-name")) {
    const selected = select.value;
    populateTalentSelect(select, groups, "", selected, Boolean(selected) && !available.has(selected));
  }
  refreshSkillSelectors();
}

function bioCost(id = $("#sel-bio").value) {
  const b = id ? BIOGRAPHIES.find(x => x.id === id) : null;
  return b ? b.cost : 0;
}

function chargeAdvancementXP(option, message) {
  const cost = Math.max(0, num(option?.dataset.cost));
  const xpTotal = num($("input[data-key=xpTotal]").value);
  const xpSpent = num($("input[data-key=xpSpent]").value);
  const available = Math.max(0, xpTotal - xpSpent - bioCost());
  if (cost > available) {
    message.textContent = `Недостаточно ОО: нужно ${cost}, доступно ${available}.`;
    return false;
  }
  if (cost) $("input[data-key=xpSpent]").value = String(xpSpent + cost);
  return true;
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
  const description = bio
    ? `${bio.cost} ОО · ${bioDescription(bio)}`
    : ($("#sel-career").value ? "не куплена" : "выбери профессию");
  $("#bio-status").textContent = description;
  $("#bio-status").title = description;
}

function splitCareerOptions(value) {
  return String(value || "").split(/\s+или\s+/i).map(item => item.trim()).filter(Boolean);
}

function splitCareerGearOptions(value) {
  return splitCareerOptions(value).flatMap(item => item.split(/\s*\/\s*/).map(option => option.trim()).filter(Boolean));
}

function careerPackage(career) {
  if (!career) return { skills: [], talents: [], gear: [] };
  return {
    skills: (career.skills || []).map(splitCareerOptions),
    talents: (career.talents || []).map(splitCareerOptions),
    // Снаряжение в справочнике дано коротким списком через точку с запятой;
    // не пытаемся превращать фрагменты с «или» в несколько выданных предметов.
    gear: String(career.gear || "").split(";").map(item => item.trim().replace(/[.]+$/, "")).filter(item => item && item !== "—").map(splitCareerGearOptions),
  };
}

function normalizeArmoryName(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ru")
    .replace(/ё/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function findArmoryItemByName(name) {
  const normalized = normalizeArmoryName(name);
  const matches = ARMORY_CATALOG.filter(item => normalizeArmoryName(item.name) === normalized);
  return matches.sort((a, b) => Number(b.market === "general") - Number(a.market === "general") ||
    String(a.id).localeCompare(String(b.id), "en"))[0] || null;
}

function resolveCareerGearOption(career, option) {
  const definitions = career.gearMap?.[option] || [{ name: option }];
  return definitions.map(definition => ({
    item: findArmoryItemByName(definition.name),
    qty: Math.max(1, num(definition.qty) || 1),
    note: definition.note || "",
  }));
}

function careerGearOptionLabel(career, option) {
  const resolved = resolveCareerGearOption(career, option);
  if (resolved.some(entry => !entry.item)) return `⚠ Нет в арсенале: ${option}`;
  return resolved.map(({ item, qty }) => `${item.name}${qty > 1 ? ` ×${qty}` : ""}`).join(" + ");
}

function currentCareerSelections(pack) {
  const names = kind => {
    if (kind === "skills") return new Set($$("#skills-tbody tr[data-src='career']").map(tr => tr.querySelector(".sk-name").value));
    if (kind === "talents") return new Set($$("#talents-tbody tr[data-src='career']").map(tr => tr.querySelector(".talent-name").value));
    return gearItems.filter(item => item.source === "career");
  };
  return Object.fromEntries(["skills", "talents", "gear"].map(kind => {
    const existing = names(kind);
    if (kind === "gear") return [kind, pack.gear.map((options, index) => {
      const selected = existing.find(item => item.careerGearIndex === index)?.careerGearOption;
      return Math.max(0, options.findIndex(option => option === selected));
    })];
    return [kind, pack[kind].map(options => Math.max(0, options.findIndex(option => existing.has(option))))];
  }));
}

function renderCareerPreview() {
  const root = $("#career-preview");
  const career = CAREERS.find(item => item.id === $("#sel-career").value);
  root.replaceChildren();
  root.hidden = !career;
  if (!career) return;

  const pack = careerPackage(career);
  const selections = currentCareerSelections(pack);
  const heading = document.createElement("div");
  heading.className = "career-preview-heading";
  const title = document.createElement("b"); title.textContent = `Стартовый набор · ${career.name}`;
  const missingGear = pack.gear.flatMap((options, index) => {
    const option = options[selections.gear[index] || 0];
    return option && resolveCareerGearOption(career, option).some(entry => !entry.item) ? [option] : [];
  });
  const hint = document.createElement("small");
  hint.textContent = missingGear.length
    ? `Не найдено в арсенале и не добавлено: ${missingGear.join("; ")}`
    : "Добавлен в лист. Варианты можно изменить здесь.";
  heading.append(title, hint); root.appendChild(heading);

  const labels = { gear: "Снаряжение", talents: "Таланты", skills: "Навыки" };
  for (const kind of ["gear", "talents", "skills"]) {
    const entries = pack[kind];
    const section = document.createElement("section"); section.className = "career-preview-section";
    const sectionTitle = document.createElement("h3"); sectionTitle.textContent = labels[kind]; section.appendChild(sectionTitle);
    if (!entries.length) {
      const empty = document.createElement("small"); empty.textContent = "Не указаны"; section.appendChild(empty);
    }
    entries.forEach((options, index) => {
      const row = document.createElement("div"); row.className = "career-preview-item";
      if (options.length > 1) {
        const select = document.createElement("select");
        select.className = "career-package-choice";
        select.dataset.kind = kind; select.dataset.index = String(index);
        options.forEach((option, optionIndex) => select.appendChild(new Option(
          kind === "gear" ? careerGearOptionLabel(career, option) : option,
          String(optionIndex),
        )));
        select.value = String(selections[kind][index] || 0);
        row.appendChild(select);
      } else {
        const option = options[0] || "—";
        const text = document.createElement("span");
        text.textContent = kind === "gear" ? careerGearOptionLabel(career, option) : option;
        if (kind === "gear" && resolveCareerGearOption(career, option).some(entry => !entry.item))
          text.classList.add("career-gear-unmatched");
        text.title = option;
        row.appendChild(text);
      }
      section.appendChild(row);
    });
    root.appendChild(section);
  }
  renderCareerAdvancements(root, career);
  root.querySelectorAll(".career-package-choice").forEach(select => {
    select.addEventListener("change", () => {
      const nextSelections = { skills: [], talents: [], gear: [] };
      root.querySelectorAll(".career-package-choice").forEach(choice => {
        nextSelections[choice.dataset.kind][Number(choice.dataset.index)] = Number(choice.value);
      });
      applyCareerPackage(career, nextSelections);
      renderCareerPreview();
      recalc();
      sheetDirty = true;
      flashSave();
    });
  });
}

function renderCareerAdvancements(root, career) {
  const world = curWorld();
  const ranks = CAREER_ADVANCEMENTS
    .filter(item => item.career === career.id && (!world || item.worlds.includes(world.id)));
  const details = document.createElement("details");
  details.className = "career-advancements";
  const summary = document.createElement("summary");
  summary.textContent = `Ранговые улучшения · ${ranks.length} рангов`;
  details.appendChild(summary);
  if (!ranks.length) {
    const empty = document.createElement("p");
    empty.textContent = "Для этого класса ранговые таблицы не найдены.";
    details.appendChild(empty);
    root.appendChild(details);
    return;
  }

  const eligibleRanks = ranks;
  const controls = document.createElement("div");
  controls.className = "career-advancement-controls";
  const label = document.createElement("label");
  label.textContent = "Таблица улучшений для ранга";
  const select = document.createElement("select");
  select.className = "career-advancement-rank";
  const currentRank = $("[data-key=rank]")?.value;
  for (const rank of eligibleRanks) {
    const option = new Option(`${rank.rank} · ${rank.minXp}–${rank.maxXp} ОО`, rank.rank);
    select.appendChild(option);
  }
  const spent = currentCareerSpentXP();
  const currentTier = eligibleRanks.filter(rank => rank.minXp <= spent && rank.maxXp >= spent);
  if (currentTier.some(rank => rank.rank === currentRank)) select.value = currentRank;
  else if (currentTier.length) select.value = currentTier[0].rank;
  else if (eligibleRanks.length) select.value = eligibleRanks[0].rank;
  label.appendChild(select);
  const status = document.createElement("small");
  status.className = "career-advancement-status";
  status.dataset.careerAdvancementStatus = "";
  controls.append(label, status);
  details.appendChild(controls);

  const tableWrap = document.createElement("div");
  tableWrap.className = "table-scroll";
  const table = document.createElement("table");
  table.className = "skill-table career-advancement-table";
  table.innerHTML = "<thead><tr><th>Улучшение</th><th>Тип</th><th>Цена</th><th>Требования</th></tr></thead>";
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  details.appendChild(tableWrap);

  const renderRows = () => {
    const rank = eligibleRanks.find(item => item.rank === select.value);
    tbody.replaceChildren();
    const spent = currentCareerSpentXP();
    status.textContent = rank
      ? (spent >= rank.minXp ? `Достигнут при ${spent} потраченных ОО (биография учтена). Предыдущие ранги доступны · таблица, стр. ${rank.sourcePage}.` : `Откроется при ${rank.minXp} потраченных ОО; сейчас ${spent} с учётом биографии · стр. ${rank.sourcePage}.`)
      : (world ? `Таблицы этого класса недоступны для мира «${world.name}».` : "Выбери мир, чтобы увидеть доступные таблицы.");
    for (const item of (rank?.advancements || [])) {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = item.name + (item.repeatLimit ? ` (до ${item.repeatLimit} раз)` : "");
      if (item.sourceNote) name.title = item.sourceNote;
      const type = document.createElement("td"); type.textContent = item.type === "skill" ? "Умение" : "Талант";
      const cost = document.createElement("td"); cost.textContent = `${item.cost} ОО`;
      const requirements = document.createElement("td"); requirements.textContent = item.requirements || "—";
      tr.append(name, type, cost, requirements);
      tbody.appendChild(tr);
    }
  };
  select.addEventListener("change", renderRows);
  details.addEventListener("toggle", () => { if (details.open) renderRows(); });
  renderRows();
  root.appendChild(details);
}

function updateCareerAdvancementStatus() {
  const status = $("[data-career-advancement-status]");
  const select = $(".career-advancement-rank");
  if (!status || !select) return;
  const career = CAREER_ADVANCEMENTS.find(item => item.career === $("#sel-career").value && item.rank === select.value);
  if (!career) return;
  const spent = currentCareerSpentXP();
  status.textContent = spent >= career.minXp
    ? `Достигнут при ${spent} потраченных ОО (биография учтена). Предыдущие ранги доступны · таблица, стр. ${career.sourcePage}.`
    : `Откроется при ${career.minXp} потраченных ОО; сейчас ${spent} с учётом биографии · стр. ${career.sourcePage}.`;
}

function currentCareerSpentXP() {
  return num($("input[data-key=xpSpent]")?.value) + bioCost();
}

function applyCareerPackage(career, selections = null) {
  // Переключение профессии заменяет только автоматически выданные строки.
  for (const tr of $$("#skills-tbody tr[data-src='career'], #talents-tbody tr[data-src='career']")) tr.remove();
  gearItems = gearItems.filter(item => item.source !== "career");
  if (!career) return;

  const pack = careerPackage(career);
  const choices = selections || { skills: [], talents: [], gear: [] };
  const existingSkills = new Set($$("#skills-tbody .sk-name").map(select => select.value).filter(Boolean));
  const existingTalents = new Set($$("#talents-tbody .talent-name").map(select => select.value).filter(Boolean));
  const existingGear = new Set(gearItems.flatMap(item => [item.catalogId, normalizeArmoryName(item.name)]).filter(Boolean));
  for (const [index, options] of pack.skills.entries()) {
    const name = options[choices.skills[index] || 0];
    if (name && !existingSkills.has(name)) { addSkillRow(name, "untrained", "career"); existingSkills.add(name); }
  }
  for (const [index, options] of pack.talents.entries()) {
    const name = options[choices.talents[index] || 0];
    if (name && !existingTalents.has(name)) { addTalentRow(name, findTalentText(name), "career"); existingTalents.add(name); }
  }
  for (const [index, options] of pack.gear.entries()) {
    const option = options[choices.gear[index] || 0];
    for (const { item, qty, note } of resolveCareerGearOption(career, option)) {
      if (!item) continue;
      const key = item.id || normalizeArmoryName(item.name);
      const nameKey = normalizeArmoryName(item.name);
      if (!existingGear.has(key) && !existingGear.has(nameKey)) {
        gearItems.push({
          catalogId: item.id, name: item.name, type: gearTypeWithWeaponFeatures(item),
          stats: [formatArmoryStats(gearStatsWithoutWeaponFeatures(item)), item.weight && `Вес ${item.weight}`,
            item.price == null ? item.priceLabel || "Цена не указана" : `Цена ${item.price} Тр.`,
            item.availability, item.unit, note].filter(Boolean).join(" · "),
          qty, price: item.price, availability: item.availability, sourcePage: item.sourcePage,
          source: "career", careerGearIndex: index, careerGearOption: option,
        });
        existingGear.add(key);
        existingGear.add(nameKey);
      }
    }
  }
}

/* удалить все строки, добавленные текущей биографией */
function clearBioRows() {
  for (const tr of $$("#skills-tbody tr[data-src='bio']")) tr.remove();
  for (const tr of $$("#talents-tbody [data-src='bio']")) tr.remove();
}

/* добавить строки по id биографии;
   skipExisting — не дублировать умения/таланты, уже восстановленные из сохранения */
function addBioRows(id, skipExisting = false) {
  const bio = BIOGRAPHIES.find(b => b.id === id);
  if (!bio) return;
  const existing = new Set();
  if (skipExisting) {
    for (const tr of $$("#skills-tbody tr[data-src='bio']")) existing.add(tr.children[0].lastChild.value);
    for (const tr of $$("#talents-tbody [data-src='bio']")) existing.add(tr.querySelector(".talent-name").value);
  }
  for (const s of (bio.skills || [])) if (!skipExisting || !existing.has(s)) addSkillRow(s, "untrained", "bio");
  for (const s of (bio.skillBasic || [])) if (!skipExisting || !existing.has(s)) addSkillRow(s, "basic", "bio");
  for (const t of (bio.talents || [])) if (!skipExisting || !existing.has(t)) addTalentRow(t, findTalentText(t), "bio");
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
  applyCareerPackage(CAREERS.find(item => item.id === careerId));
  renderCareerPreview();
  showCareerKit(true);
  sheetDirty = true;
  flashSave();
}

function onBioChange() {
  const newId = $("#sel-bio").value;
  const oldId = $("#sel-bio").dataset.prev || "";

  // убрать старые биографические строки
  clearBioRows();

  if (!newId) {
    $("#sel-bio").dataset.prev = "";
    refreshAdvancementSelectors();
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
    refreshAdvancementSelectors();
    updateBioStatus();
    recalc();
    return;
  }

  addBioRows(newId);
  $("#sel-bio").dataset.prev = newId;
  refreshAdvancementSelectors();
  updateBioStatus();
  recalc();
  sheetDirty = true;
  flashSave();
  flash(`куплена биография: ${bio.name} (−${bio.cost} ОО)`);
}

function setSkillMode(mode) {
  const managing = mode === "manage";
  $("#skill-overview").hidden = managing;
  $("#skill-management").hidden = !managing;
  $("#skill-section-row").classList.toggle("managing", managing);
  $("#dashboard-grid").classList.toggle("managing", managing);
  $("#dashboard-grid").classList.remove("talent-managing");
  if (managing) renderSkillPreview();
}

function setTalentMode(managing) {
  $("#talent-overview").hidden = managing;
  $("#talent-management").hidden = !managing;
  $("#skill-section-row").classList.toggle("talent-managing", managing);
  $("#dashboard-grid").classList.toggle("managing", managing);
  $("#dashboard-grid").classList.toggle("talent-managing", managing);
  renderTalentPreview();
}

function renderSkillPreview() {
  const basicRoot = $("#skill-preview-basic"), trainedRoot = $("#skill-preview-trained");
  basicRoot.replaceChildren();
  trainedRoot.replaceChildren();
  let count = 0;
  for (const tr of $("#skills-tbody").rows) {
    const nameSelect = tr.children[0].querySelector("select");
    const levelSelect = tr.children[2].querySelector("select");
    const name = nameSelect.value;
    if (!name) continue;
    count++;
    const level = levelSelect.value;
    const targetRoot = level === "basic" ? basicRoot : trainedRoot;
    const item = document.createElement("div"); item.className = "skill-preview";
    const meta = document.createElement("div"); meta.className = "skill-preview-meta";
    const title = document.createElement("span"); title.textContent = name;
    const description = skillHintsVisible ? findSkillText(name) : "";
    if (description) title.title = description;
    const levelLabel = document.createElement("small"); levelLabel.textContent = levelSelect.selectedOptions[0]?.textContent || "";
    meta.append(title, levelLabel);
    if (description) {
      const hint = document.createElement("small");
      hint.className = "skill-preview-hint";
      hint.textContent = description;
      hint.title = description;
      meta.appendChild(hint);
    }
    const attr = tr.children[1].textContent.trim();
    const characteristic = document.createElement("span"); characteristic.className = "skill-characteristic"; characteristic.textContent = attr || "—";
    const score = document.createElement("strong"); score.textContent = tr.children[3].textContent.trim() || "—";
    item.append(meta, characteristic, score);
    targetRoot.appendChild(item);
  }
  $("#skill-count").textContent = String(count);
  if (!basicRoot.children.length) basicRoot.innerHTML = '<p class="skill-empty">Нет базовых навыков.</p>';
  if (!trainedRoot.children.length) trainedRoot.innerHTML = '<p class="skill-empty">Нет обученных навыков.</p>';
}

function toggleSkillHints() {
  skillHintsVisible = !skillHintsVisible;
  const label = skillHintsVisible ? "Скрыть подсказки" : "Показать подсказки";
  for (const button of [$("#btn-skill-hints"), $("#btn-skill-hints-manage")]) {
    button.textContent = label;
    button.setAttribute("aria-label", label);
  }
  for (const select of $$("#skills-tbody .sk-name")) updateSkillHint(select);
  renderSkillPreview();
}

function renderTalentPreview() {
  const root = $("#talent-preview-list");
  root.replaceChildren();
  for (const tr of $("#talents-tbody").rows) {
    const name = tr.querySelector(".talent-name").value;
    if (!name) continue;
    const item = document.createElement("div"); item.className = "talent-row";
    const title = document.createElement("span"); title.textContent = name;
    const note = tr.querySelector(".talent-note").value.trim();
    item.appendChild(title);
    if (note) { const summary = document.createElement("small"); summary.textContent = note; item.appendChild(summary); }
    root.appendChild(item);
  }
  if (!root.children.length) root.innerHTML = '<p class="skill-empty">Таланты не добавлены.</p>';
}

function renderProfile() {
  const value = key => $("[data-key='" + key + "']")?.value || "";
  const career = CAREERS.find(x => x.id === value("career"));
  const world = WORLDS.find(x => x.id === value("world"));
  const bio = curBio();
  $("#char-name").textContent = value("name") || "Безымянный аколит";
  $("#char-rank").textContent = value("rank") || career?.rank || "—";
  $("#char-age").textContent = value("age") ? `${value("age")} стандартных лет` : "—";
  $("#char-status").textContent = value("status") || "—";
  $("#char-career").textContent = career?.name || "Профессия не выбрана";
  $("#char-world").textContent = world?.name || "Мир не выбран";
  $("#char-bio").textContent = bio?.name || "—";
  $("#creation-summary").textContent = [world?.name, career?.name, bio?.name].filter(Boolean).join(" · ") || "Выбери мир, профессию и биографию";
}

function renderState() {
  const woundsMax = Math.max(0, num($("#state-wounds-total").value));
  const wounds = Math.max(0, Math.min(woundsMax, num($("#state-wounds-current").value)));
  const fateMax = Math.max(0, num($("#state-fate-total").value));
  const fate = Math.max(0, Math.min(fateMax, num($("#state-fate-current").value)));
  const fatigue = Math.max(0, num($("#state-fatigue").value));
  $("#state-wounds-current").value = wounds;
  $("#state-fate-current").value = fate;
  $("#state-fatigue").value = fatigue;
  $("#wounds-current").textContent = wounds;
  $("#wounds-total").textContent = woundsMax;
  $("#fate-current").textContent = fate;
  $("#fate-total").textContent = fateMax;
  $("#insanity-value").textContent = num($("#state-insanity").value);
  $("#corruption-value").textContent = num($("#state-corruption").value);
  $("#fatigue-value").textContent = fatigue;
  $("#wealth-value").textContent = num($("#wealth-input").value);
  $("#wounds-meter").style.width = `${woundsMax ? Math.min(100, wounds / woundsMax * 100) : 0}%`;
  $("#fate-meter").style.width = `${fateMax ? Math.min(100, fate / fateMax * 100) : 0}%`;
}

const NOTE_BLOCKS = {
  dossier: { field: "dossier", text: "#dossier-text", editor: "#dossier-editor", input: "#dossier-input" },
  merit: { field: "meritNotes", text: "#merit-text", editor: "#merit-editor", input: "#merit-input" },
};

function renderNotes() {
  for (const [key, config] of Object.entries(NOTE_BLOCKS)) {
    const value = $(`[data-key="${config.field}"]`).value.trim();
    const text = $(config.text);
    text.textContent = value || "Записей нет.";
    text.classList.remove("expanded");
    const more = $(`[data-note-more="${key}"]`);
    more.hidden = value.length < 180;
    more.textContent = "Подробнее";
  }
}

function openNoteEditor(key) {
  const config = NOTE_BLOCKS[key];
  $(config.input).value = $(`[data-key="${config.field}"]`).value;
  $(config.editor).hidden = false;
  $(config.input).focus();
}

function cancelNoteEditor(key) {
  $(NOTE_BLOCKS[key].editor).hidden = true;
}

function saveNoteEditor(key) {
  const config = NOTE_BLOCKS[key];
  $(`[data-key="${config.field}"]`).value = $(config.input).value.trim();
  $(config.editor).hidden = true;
  renderNotes(); sheetDirty = true; flashSave();
}

function toggleNoteExpanded(key) {
  const config = NOTE_BLOCKS[key];
  const text = $(config.text), more = $(`[data-note-more="${key}"]`);
  const expanded = text.classList.toggle("expanded");
  more.textContent = expanded ? "Свернуть" : "Подробнее";
}

function readLegacyGearItems() {
  const items = [];
  for (const tr of $("#weapons-tbody").rows) {
    const f = Array.from(tr.children).slice(0, 9).map(td => td.firstChild.value.trim());
    if (!f[0]) continue;
    const stats = [f[2], f[3], f[4] && `Пен ${f[4]}`, f[5] && `дист. ${f[5]}`, f[6] && `обойма ${f[6]}`, f[7] && `перезарядка ${f[7]}`, f[8]].filter(Boolean).join(" · ");
    items.push({ name: f[0], type: f[1] ? `Оружие · ${f[1]}` : "Оружие", stats, source: "legacy-weapon" });
  }
  const armorLabels = [["arm-h", "Голова"], ["arm-b", "Тело"], ["arm-la", "Левая рука"], ["arm-ra", "Правая рука"], ["arm-ll", "Левая нога"], ["arm-rl", "Правая нога"]];
  for (const [key, label] of armorLabels) {
    const value = $(`[data-key="${key}"]`).value.trim();
    if (value) items.push({ name: label, type: "Броня", stats: `Защита ${value}`, source: `legacy-${key}` });
  }
  const legacyGear = $("textarea[data-key=gear]").value;
  for (const line of legacyGear.split(/[;\n]+/).map(x => x.trim()).filter(Boolean))
    items.push({ name: line, type: "Имущество", stats: "", source: "legacy-gear" });
  return items;
}

function getFilteredArmoryItems() {
  const query = $("#arsenal-search").value.trim().toLocaleLowerCase("ru");
  const category = $(".arsenal-category.active").dataset.arsenalCategory;
  const market = $("#arsenal-market").value;
  const kind = $("#arsenal-kind").value;
  const availability = $("#arsenal-availability").value;
  const fromInput = $("#arsenal-price-from").value;
  const toInput = $("#arsenal-price-to").value;
  const hasPriceRange = fromInput !== "" || toInput !== "";
  const from = fromInput === "" ? 0 : Number(fromInput);
  const to = toInput === "" ? Infinity : Number(toInput);
  const results = ARMORY_CATALOG.filter(item => {
    const text = `${item.name} ${item.type} ${item.stats} ${item.availability}`.toLocaleLowerCase("ru");
    const marketMatch = market === "all" || item.market === "general" || item.market === market;
    return (!query || text.includes(query)) &&
      (category === "all" || item.category === category) &&
      marketMatch &&
      (kind === "all" || (kind === "weapon-upgrade"
        ? String(item.type || "").trim().toLocaleLowerCase("ru") === "улучшение оружия"
        : item.kind === kind)) &&
      (availability === "all" || item.availability === availability) &&
      (!hasPriceRange || (item.price != null && Number(item.price) >= from && Number(item.price) <= to));
  });
  const sort = $("#arsenal-sort").value;
  if (sort === "price-asc") results.sort((a, b) => a.price == null ? 1 : b.price == null ? -1 : a.price - b.price);
  else if (sort === "price-desc") results.sort((a, b) => a.price == null ? 1 : b.price == null ? -1 : b.price - a.price);
  else if (sort === "name") results.sort((a, b) => a.name.localeCompare(b.name, "ru"));
  return results;
}

function renderArsenalSuggestions() {
  const root = $("#arsenal-suggestions"), query = $("#arsenal-search").value.trim().toLocaleLowerCase("ru");
  root.replaceChildren();
  if (!query || document.activeElement !== $("#arsenal-search")) { root.hidden = true; return; }
  const matches = ARMORY_CATALOG.filter(item => `${item.name} ${item.type}`.toLocaleLowerCase("ru").includes(query)).slice(0, 5);
  for (const item of matches) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = item.name;
    button.addEventListener("click", () => { $("#arsenal-search").value = item.name; arsenalPage = 1; root.hidden = true; renderArsenalCatalog(); });
    root.appendChild(button);
  }
  root.hidden = !matches.length;
}

function formatArmoryStats(stats) {
  return String(stats || "")
    .replace(/(^|[·\s])Дист:/g, "$1Дальность:")
    .replace(/(^|[·\s])РоФ:/g, "$1Скорострельность:")
    .replace(/(^|[·\s])Бро:/g, "$1Бронебойность:")
    .replace(/(^|[·\s])Бр:/g, "$1Броня:")
    .replace(/(^|[·\s])Об:/g, "$1Обойма:")
    .replace(/(^|[·\s])Пер:/g, "$1Перезарядка:");
}

function isGearWeapon(item) {
  const catalogItem = ARMORY_CATALOG.find(entry => entry.id === item.catalogId);
  if (item.category) return item.category === "weapon";
  if (catalogItem?.category) return catalogItem.category === "weapon";
  const type = String(item.type || "");
  if (/(?:улучшение|модификация|аксессуар)\s+(?:оруж|брон)/i.test(type)) return false;
  return /оруж/i.test(type) || /^(?:основное|пистолет(?:ы)?|ближний бой|рукопашное|метательное|тяж[её]лое|экзотическое)(?:[.,]|$)/i.test(type);
}

function isGearArmor(item) {
  const catalogItem = ARMORY_CATALOG.find(entry => entry.id === item.catalogId);
  if (item.category) return item.category === "armor";
  if (catalogItem?.category) return catalogItem.category === "armor";
  const type = String(item.type || "");
  if (/(?:улучшение|модификация|аксессуар)\s+(?:оруж|брон)/i.test(type)) return false;
  return /брон/i.test(type);
}

function gearWeaponKind(item) {
  const catalogItem = ARMORY_CATALOG.find(entry => entry.id === item.catalogId);
  return catalogItem?.kind || item.kind || (/ближн|рукопаш|melee/i.test(`${item.type || ""} ${item.stats || ""}`) ? "melee" : "ranged");
}

function gearQuality(item) {
  return ["low", "good", "best"].includes(item.quality) ? item.quality : "normal";
}

function gearStackKey(item) {
  if (!isGearWeapon(item) && !isGearArmor(item)) return "";
  const normalize = value => String(value || "").trim().toLocaleLowerCase("ru").replace(/\s+/g, " ");
  return JSON.stringify([
    isGearWeapon(item) ? "weapon" : "armor",
    item.catalogId || "",
    normalize(item.name), normalize(item.type), normalize(item.stats),
  ]);
}

function mergeGearStacks(item) {
  const stackKey = gearStackKey(item);
  if (!stackKey) return;
  const stacks = new Map();
  const originalItems = gearItems;
  const mergedItems = [];
  for (const candidate of originalItems) {
    if (gearStackKey(candidate) !== stackKey) {
      mergedItems.push(candidate);
      continue;
    }
    const quality = gearQuality(candidate);
    const stack = stacks.get(quality);
    if (stack) stack.qty += Math.max(1, num(candidate.qty) || 1);
    else {
      stacks.set(quality, { item: candidate, qty: Math.max(1, num(candidate.qty) || 1) });
      mergedItems.push(candidate);
    }
  }
  for (const [quality, stack] of stacks) {
    stack.item.quality = quality;
    stack.item.qty = stack.qty;
  }
  gearItems = mergedItems;
}

function updateGearQuality(index, quality) {
  const item = gearItems[index];
  if (!item || gearQuality(item) === quality) return;
  const quantity = Math.max(1, num(item.qty) || 1);
  if (quantity > 1) {
    item.qty = quantity - 1;
    gearItems.splice(index + 1, 0, { ...item, qty: 1, quality });
  } else {
    item.quality = quality;
  }
  mergeGearStacks(item);
  sheetDirty = true; flashSave(); renderGear();
}

function gearQualityEffect(item) {
  const quality = gearQuality(item);
  if (isGearArmor(item)) {
    if (quality === "normal") return "";
    if (quality === "low") return "−10 ко всем Тестам Ловкости";
    if (quality === "good") return "+1 Броня против первой атаки в Раунде";
    return "+1 Броня · вес уменьшен вдвое";
  }
  if (!isGearWeapon(item)) return "";
  if (gearWeaponKind(item) === "melee") {
    if (quality === "normal") return "";
    if (quality === "low") return "−10 к попаданию";
    if (quality === "good") return "+5 к попаданию";
    return "+10 к попаданию · +1 к Урону";
  }
  const traits = `${item.type || ""} ${item.stats || ""}`;
  const unreliable = /ненад[её]жн/i.test(traits);
  const reliable = /над[её]жн/i.test(traits.replace(/ненад[её]жн/ig, ""));
  if (quality === "normal") {
    if (unreliable && reliable) return "«Ненадёжное» и «Надёжное» взаимно нейтрализуются";
    if (unreliable) return "«Ненадёжное»: клин на 91+ (в т. ч. длинная очередь и беглый огонь)";
    if (reliable) return "«Надёжное»: клин только на 10 из 1d10, иначе промах";
    return "";
  }
  if (quality === "low") {
    if (unreliable) return "Уже «Ненадёжное»: клинит при каждом промахе";
    if (reliable) return "«Ненадёжное» + «Надёжное»: взаимно нейтрализуются";
    return "«Ненадёжное»: клин на 91+ (в т. ч. длинная очередь и беглый огонь)";
  }
  if (quality === "good") {
    if (unreliable) return "«Надёжное» + «Ненадёжное»: взаимно нейтрализуются";
    if (reliable) return "«Надёжное» уже есть (без доп. эффекта): клин только на 10 из 1d10";
    return "«Надёжное»: при клине 1d10; только 10 — клин, иначе промах";
  }
  return "Клин/перегрев: считается обычным промахом";
}

function gearQualityControl(item) {
  if (!isGearWeapon(item) && !isGearArmor(item)) return null;
  const wrap = document.createElement("div"); wrap.className = "gear-quality-control";
  const select = document.createElement("select"); select.setAttribute("aria-label", `Качество: ${item.name}`);
  const lowQualityLabel = isGearArmor(item) ? "Низкое" : "Плохое";
  for (const [value, text] of [["low", lowQualityLabel], ["normal", "Обычное"], ["good", "Хорошее"], ["best", "Высшее"]]) {
    const option = document.createElement("option"); option.value = value; option.textContent = text; select.appendChild(option);
  }
  select.value = gearQuality(item);
  const index = gearItems.indexOf(item);
  select.addEventListener("change", () => updateGearQuality(index, select.value));
  wrap.appendChild(select);
  const effect = gearQualityEffect(item);
  if (effect) {
    const note = document.createElement("span"); note.className = "gear-quality-effect"; note.textContent = effect;
    wrap.appendChild(note);
  }
  return wrap;
}

function gearTypeWithWeaponFeatures(item) {
  const catalogItem = ARMORY_CATALOG.find(entry => entry.id === item.catalogId);
  const type = String(item.type || catalogItem?.type || "").trim();
  if (!isGearWeapon(item)) return type;
  const featureEntry = String(item.stats || "").split("·").map(part => part.trim()).find(part => /^Особенности\s*:/i.test(part));
  const features = featureEntry?.replace(/^Особенности\s*:\s*/i, "").trim();
  if (!features || features === "---" || type.toLocaleLowerCase("ru").includes(features.toLocaleLowerCase("ru"))) return type;
  return `${type}. ${features}.`;
}

function gearStatsWithoutWeaponFeatures(item, stats = item.stats) {
  if (!isGearWeapon(item)) return String(stats || "");
  return String(stats || "").split("·").map(part => part.trim()).filter(part => !/^Особенности\s*:/i.test(part)).join(" · ");
}

function armoryItemIcon(item) {
  if (item.category === "armor") return "⛨";
  if (item.category === "weapon") {
    const type = `${item.type || ""} ${item.kind || ""}`.toLocaleLowerCase("ru");
    if (/пистолет/.test(type)) return "⌖";
    if (/метатель|лук|арбалет|throw/.test(type)) return "➶";
    if (/ranged|дистанц|основное/.test(type)) return "➤";
    return "⚔";
  }
  if (item.category === "service") return "⌂";
  if (item.category === "ammo") return "▣";
  return "✦";
}

function gearEntryIcon(item) {
  const catalogItem = ARMORY_CATALOG.find(entry => entry.id === item.catalogId);
  if (catalogItem) return armoryItemIcon(catalogItem);
  const type = String(item.type || "").toLocaleLowerCase("ru");
  if (/брон/.test(type)) return "⛨";
  if (/пистолет/.test(type)) return "⌖";
  if (/метатель|лук|арбалет/.test(type)) return "➶";
  if (/оруж|ближн|рукопаш/.test(type)) return "⚔";
  if (/боеприпас|патрон|заряд/.test(type)) return "▣";
  if (/услуг/.test(type)) return "⌂";
  return "✦";
}

function gearDisplayStats(item) {
  const isWeapon = isGearWeapon(item);
  const isArmor = isGearArmor(item);
  const quality = gearQuality(item);
  const rarities = new Set(["Изобильная", "Обильная", "Распространённая", "Средняя", "Скудная", "Редкая", "Раритет", "Особая", "Индивидуальная"]);
  const parts = String(item.stats || "").split("·").map(part => part.trim()).filter(part =>
    part && !/^(?:Вес|Цена)(?:\s|$)/i.test(part) && !/^за\s+обойму[.!]?$/i.test(part) &&
    !(isWeapon && /^(?:Класс|Особенности)\s*:/i.test(part)) && !rarities.has(part)
  );
  if (isWeapon && quality === "best" && gearWeaponKind(item) === "melee") {
    for (let i = 0; i < parts.length; i++) {
      parts[i] = parts[i].replace(/(Урон\s*:\s*\d+d\d+\s*)([+-]\s*\d+)?/i, (match, dice, modifier = "") => {
        const base = Number(modifier.replace(/\s/g, "")) || 0, adjusted = base + 1;
        return `${dice}${adjusted >= 0 ? "+" : ""}${adjusted}`;
      });
    }
  }
  if (isArmor && quality === "best") {
    for (let i = 0; i < parts.length; i++)
      parts[i] = parts[i].replace(/((?:Броня|Бр)\s*:?\s*)(\d+)/i, (_, label, value) => `${label}${Number(value) + 1}`);
    const weightPart = String(item.stats || "").split("·").map(part => part.trim()).find(part => /^Вес\s+/i.test(part));
    const weightMatch = weightPart?.match(/^Вес\s+([\d.,]+)\s*(.*)$/i);
    if (weightMatch) {
      const weight = Number(weightMatch[1].replace(",", ".")) / 2;
      parts.push(`Вес ${String(weight).replace(".", ",")}${weightMatch[2] ? ` ${weightMatch[2]}` : ""} (½)`);
    }
  }
  return parts.join(" · ");
}

function renderArsenalCatalog() {
  const root = $("#arsenal-results"), results = getFilteredArmoryItems();
  const pageCount = Math.ceil(results.length / ARSENAL_PAGE_SIZE);
  arsenalPage = Math.max(1, Math.min(arsenalPage, pageCount || 1));
  const first = results.length ? (arsenalPage - 1) * ARSENAL_PAGE_SIZE : 0;
  const visible = results.slice(first, first + ARSENAL_PAGE_SIZE);
  root.replaceChildren();
  $("#arsenal-result-count").textContent = `${results.length} ${results.length === 1 ? "предмет" : results.length > 1 && results.length < 5 ? "предмета" : "предметов"}`;
  $("#arsenal-page-range").textContent = results.length ? `${first + 1}–${Math.min(first + ARSENAL_PAGE_SIZE, results.length)} из ${results.length}` : "0 из 0";
  $("#arsenal-empty").hidden = results.length > 0;
  const marketNames = {general:"Общий рынок",feral:"Дикие / феодальные",hive:"Миры-ульи",forge:"Миры-кузницы",frontier:"Миры-фронтиры",void:"Пустота",warzone:"Зона боевых действий",ordos:"Святые Ордосы"};
  for (const item of visible) {
    const card = document.createElement("article"); card.className = "arsenal-item";
    const icon = document.createElement("div"); icon.className = "arsenal-item-icon"; icon.textContent = armoryItemIcon(item);
    const main = document.createElement("div"); main.className = "arsenal-item-main";
    const title = document.createElement("div"); title.className = "arsenal-item-title";
    const name = document.createElement("b"); name.textContent = item.name;
    const type = document.createElement("small"); type.textContent = item.type;
    title.append(name, type);
    const stats = document.createElement("div"); stats.className = "arsenal-item-stats"; stats.textContent = [formatArmoryStats(item.stats), item.weight && `Вес ${item.weight}`].filter(Boolean).join(" · ");
    const badges = document.createElement("div"); badges.className = "arsenal-item-badges";
    const marketBadge = document.createElement("span"); marketBadge.textContent = marketNames[item.market] || item.market; badges.appendChild(marketBadge);
    const rarityBadge = document.createElement("span"); rarityBadge.textContent = item.availability; badges.appendChild(rarityBadge);
    const sourceBadge = document.createElement("span"); sourceBadge.textContent = `стр. ${item.sourcePage}`; badges.appendChild(sourceBadge);
    main.append(title, stats, badges);
    const end = document.createElement("div"); end.className = "arsenal-item-end";
    const price = document.createElement("strong"); price.textContent = item.price == null ? (item.priceLabel || "Цена не указана") : `${Number(item.price).toLocaleString("ru-RU")} Тр.`;
    if (item.price != null && item.unit) price.textContent += ` · ${item.unit}`;
    const add = document.createElement("button"); add.type = "button"; add.className = "arsenal-add";
    const inCart = arsenalCart.get(item.id); add.textContent = inCart ? `✓ В корзине ×${inCart.qty}` : "＋ В корзину";
    if (inCart) add.classList.add("in-cart");
    add.addEventListener("click", () => addArsenalItem(item));
    end.append(price, add); card.append(icon, main, end); root.appendChild(card);
  }
  renderArsenalPagination(results.length, pageCount);
}

function renderArsenalPagination(total, pageCount = Math.ceil(total / ARSENAL_PAGE_SIZE)) {
  const root = $("#arsenal-pagination"); root.replaceChildren();
  root.hidden = pageCount <= 1;
  if (pageCount <= 1) return;
  const goTo = page => { arsenalPage = page; renderArsenalCatalog(); $("#arsenal-results").scrollIntoView({behavior:"smooth",block:"start"}); };
  const button = (label, page, active = false, disabled = false) => {
    const el = document.createElement("button"); el.type = "button"; el.className = "arsenal-page";
    el.textContent = label; el.disabled = disabled;
    if (page) el.dataset.page = String(page);
    if (active) { el.classList.add("active"); el.setAttribute("aria-current", "page"); }
    if (!disabled && page) el.addEventListener("click", () => goTo(page));
    root.appendChild(el);
  };
  button("‹", arsenalPage - 1, false, arsenalPage === 1);
  const numbers = pageCount <= 7 ? Array.from({length: pageCount}, (_, i) => i + 1) : [1, ...(arsenalPage > 3 ? ["…"] : []), ...Array.from({length: Math.min(pageCount - 1, arsenalPage + 1) - Math.max(2, arsenalPage - 1) + 1}, (_, i) => Math.max(2, arsenalPage - 1) + i), ...(arsenalPage < pageCount - 2 ? ["…"] : []), pageCount];
  for (const page of numbers) page === "…" ? (() => { const el = document.createElement("span"); el.className = "arsenal-page-ellipsis"; el.textContent = page; root.appendChild(el); })() : button(String(page), page, page === arsenalPage);
  button("›", arsenalPage + 1, false, arsenalPage === pageCount);
}

function addArsenalItem(item) {
  const current = arsenalCart.get(item.id);
  if (current) current.qty++;
  else arsenalCart.set(item.id, { item, qty: 1 });
  renderArsenalCart(); renderArsenalCatalog();
}

function renderArsenalCart() {
  const root = $("#arsenal-cart-items"); root.replaceChildren();
  let count = 0, total = 0, unpriced = 0;
  if (!arsenalCart.size) {
    const empty = document.createElement("p"); empty.className = "arsenal-cart-empty"; empty.textContent = "Добавь предмет кнопкой «В корзину»."; root.appendChild(empty);
  }
  for (const [id, entry] of arsenalCart) {
    const {item, qty} = entry; count += qty;
    if (item.price == null) unpriced += qty; else total += item.price * qty;
    const row = document.createElement("div"); row.className = "arsenal-cart-row";
    const info = document.createElement("div"), name = document.createElement("b"), meta = document.createElement("small");
    name.textContent = item.name; meta.textContent = `${item.price == null ? item.priceLabel || "Цена не указана" : `${item.price} Тр.`} · ${item.availability}`; info.append(name, meta);
    const controls = document.createElement("div"); controls.className = "arsenal-cart-qty";
    const changeQty = delta => { const next = arsenalCart.get(id); next.qty += delta; if (next.qty <= 0) arsenalCart.delete(id); renderArsenalCart(); renderArsenalCatalog(); };
    const minus = document.createElement("button"); minus.type = "button"; minus.textContent = "−"; minus.setAttribute("aria-label", `Уменьшить количество: ${item.name}`); minus.addEventListener("click", () => changeQty(-1));
    const amount = document.createElement("span"); amount.textContent = `×${qty}`;
    const plus = document.createElement("button"); plus.type = "button"; plus.textContent = "+"; plus.setAttribute("aria-label", `Увеличить количество: ${item.name}`); plus.addEventListener("click", () => changeQty(1));
    controls.append(minus, amount, plus); row.append(info, controls); root.appendChild(row);
  }
  $("#arsenal-cart-count").textContent = String(count);
  $("#arsenal-cart-total").textContent = total.toLocaleString("ru-RU");
  $("#arsenal-commit").disabled = count === 0;
  $("#arsenal-cart-status").textContent = unpriced ? "Позиции без фиксированной цены не входят в итог." : "";
}

function commitArsenalCart() {
  if (!arsenalCart.size) return;
  for (const {item, qty} of arsenalCart.values()) {
    const existing = gearItems.find(row => row.catalogId === item.id && gearQuality(row) === "normal");
    if (existing) existing.qty = Math.max(1, num(existing.qty) || 1) + qty;
    else gearItems.push({
      catalogId: item.id, name: item.name, type: gearTypeWithWeaponFeatures(item),
      stats: [formatArmoryStats(gearStatsWithoutWeaponFeatures(item)), item.weight && `Вес ${item.weight}`, item.price == null ? item.priceLabel || "Цена не указана" : `Цена ${item.price} Тр.`, item.availability, item.unit].filter(Boolean).join(" · "),
      qty, price: item.price, availability: item.availability, sourcePage: item.sourcePage,
    });
  }
  arsenalCart.clear(); renderGear(); renderArsenalCart(); renderArsenalCatalog();
  sheetDirty = true; flashSave(); $("#arsenal-cart-status").textContent = "Добавлено в лист персонажа.";
}

function renderGear() {
  const preview = $("#gear-preview-list"), rows = $("#gear-rows");
  preview.replaceChildren(); rows.replaceChildren();
  for (const [index, item] of gearItems.entries()) {
    const quantity = Math.max(1, num(item.qty) || 1);
    const card = document.createElement("article"); card.className = "gear-entry-row";
    card.dataset.gearIndex = String(index);
    const dragHandle = document.createElement("span"); dragHandle.className = "gear-entry-drag"; dragHandle.textContent = "⠿";
    dragHandle.draggable = true;
    dragHandle.setAttribute("role", "img"); dragHandle.setAttribute("aria-label", `Перетащить ${item.name}`); dragHandle.title = "Перетащить, чтобы изменить порядок";
    const icon = document.createElement("div"); icon.className = "gear-entry-icon"; icon.textContent = gearEntryIcon(item);
    const info = document.createElement("div"); info.className = "gear-entry-info";
    const name = document.createElement("b"), type = document.createElement("small"), stats = document.createElement("span");
    name.textContent = item.name; type.textContent = gearTypeWithWeaponFeatures(item) || "Предмет"; stats.textContent = gearDisplayStats(item);
    info.append(name, type);
    if (stats.textContent) info.appendChild(stats);
    const qualityControl = gearQualityControl(item);
    if (qualityControl) info.appendChild(qualityControl);
    const controls = document.createElement("div"); controls.className = "gear-entry-controls";
    const previewQtyInput = document.createElement("input");
    previewQtyInput.className = "gear-entry-quantity"; previewQtyInput.type = "number"; previewQtyInput.min = "1"; previewQtyInput.step = "1"; previewQtyInput.value = String(quantity);
    previewQtyInput.setAttribute("aria-label", `Количество: ${item.name}`);
    previewQtyInput.addEventListener("change", () => {
      gearItems[index].qty = Math.max(1, num(previewQtyInput.value) || 1);
      sheetDirty = true; flashSave(); renderGear();
    });
    const previewDelete = document.createElement("button"); previewDelete.type = "button"; previewDelete.className = "skill-delete"; previewDelete.textContent = "×";
    previewDelete.setAttribute("aria-label", `Удалить ${item.name}`); previewDelete.title = "Удалить снаряжение";
    previewDelete.addEventListener("click", () => { gearItems.splice(index, 1); sheetDirty = true; flashSave(); renderGear(); });
    controls.append(previewQtyInput, previewDelete);
    card.append(dragHandle, icon, info, controls);
    dragHandle.addEventListener("dragstart", event => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
      card.classList.add("dragging");
    });
    dragHandle.addEventListener("dragend", () => card.classList.remove("dragging"));
    card.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
    card.addEventListener("drop", event => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData("text/plain"));
      if (!Number.isInteger(from) || from < 0 || from >= gearItems.length || from === index) return;
      const [moved] = gearItems.splice(from, 1);
      gearItems.splice(index, 0, moved);
      sheetDirty = true; flashSave(); renderGear();
    });
    preview.appendChild(card);
    const tr = document.createElement("tr");
    for (const key of ["name", "type", "stats"]) {
      const td = document.createElement("td"), input = document.createElement("input");
      input.className = "gear-edit-input"; input.value = key === "type" ? gearTypeWithWeaponFeatures(item) : item[key] || ""; input.setAttribute("aria-label", key);
      input.addEventListener("change", () => { gearItems[index][key] = input.value.trim(); sheetDirty = true; flashSave(); renderGear(); });
      td.appendChild(input);
      if (key === "stats") {
        const inventoryQuality = gearQualityControl(item);
        if (inventoryQuality) td.appendChild(inventoryQuality);
      }
      tr.appendChild(td);
    }
    const qtyCell = document.createElement("td"), qtyInput = document.createElement("input");
    qtyInput.className = "gear-qty-input"; qtyInput.type = "number"; qtyInput.min = "1"; qtyInput.step = "1"; qtyInput.value = String(quantity); qtyInput.setAttribute("aria-label", `Количество: ${item.name}`);
    qtyInput.addEventListener("change", () => { gearItems[index].qty = Math.max(1, num(qtyInput.value) || 1); sheetDirty = true; flashSave(); renderGear(); });
    qtyCell.appendChild(qtyInput); tr.appendChild(qtyCell);
    const delCell = document.createElement("td"), del = document.createElement("button");
    del.type = "button"; del.className = "skill-delete"; del.textContent = "×"; del.setAttribute("aria-label", `Удалить ${item.name}`);
    del.onclick = () => { gearItems.splice(index, 1); sheetDirty = true; flashSave(); renderGear(); };
    delCell.appendChild(del); tr.appendChild(delCell); rows.appendChild(tr);
  }
  const count = gearItems.reduce((sum, item) => sum + Math.max(1, num(item.qty) || 1), 0);
  $("#gear-count").textContent = String(count);
  $("#gear-inventory-count").textContent = String(count);
  if (!gearItems.length) preview.innerHTML = '<p class="skill-empty">Снаряжение не записано.</p>';
}

function setGearMode(managing) {
  $("#gear-overview").hidden = managing;
  $("#gear-management").hidden = !managing;
  $("#secondary-grid").classList.toggle("managing", managing);
  if (managing) { renderGear(); renderArsenalCatalog(); renderArsenalCart(); }
}

function toggleStateEditor(force) {
  const editor = $("#state-editor"), open = typeof force === "boolean" ? force : editor.hidden;
  editor.hidden = !open;
  if (open) {
    stateEditorSnapshot = {
      wounds: $("#state-wounds-total").value, woundsCurrent: $("#state-wounds-current").value,
      fateTotal: $("#state-fate-total").value, fateLeft: $("#state-fate-current").value,
      insanity: $("#state-insanity").value, corruption: $("#state-corruption").value,
      fatigueCurrent: $("#state-fatigue").value,
    };
  } else if (stateEditorSnapshot) {
    const selectors = { wounds: "#state-wounds-total", woundsCurrent: "#state-wounds-current", fateTotal: "#state-fate-total", fateLeft: "#state-fate-current", insanity: "#state-insanity", corruption: "#state-corruption", fatigueCurrent: "#state-fatigue" };
    for (const [key, selector] of Object.entries(selectors)) $(selector).value = stateEditorSnapshot[key];
    stateEditorSnapshot = null; sheetDirty = true; recalc(); flashSave();
  }
}

function saveState() {
  const woundsMax = Math.max(0, num($("#state-wounds-total").value));
  $("#state-wounds-current").value = Math.min(woundsMax, Math.max(0, num($("#state-wounds-current").value)));
  const fateMax = Math.max(0, num($("#state-fate-total").value));
  $("#state-fate-current").value = Math.min(fateMax, Math.max(0, num($("#state-fate-current").value)));
  $("#state-fatigue").value = Math.max(0, num($("#state-fatigue").value));
  $("#state-editor").hidden = true;
  stateEditorSnapshot = null;
  sheetDirty = true; recalc(); flashSave();
}

function saveWealth() {
  const details = $("#wealth-input").closest("details");
  if (details) details.open = false;
  sheetDirty = true; recalc(); flashSave();
}

function adjustState(key, delta) {
  const map = { wounds: ["#state-wounds-current", "#state-wounds-total"], fate: ["#state-fate-current", "#state-fate-total"], fatigue: ["#state-fatigue", null] };
  const [valueSelector, maxSelector] = map[key];
  const input = $(valueSelector), max = maxSelector ? num($(maxSelector).value) : Infinity;
  input.value = Math.max(0, Math.min(max, num(input.value) + delta));
  sheetDirty = true; recalc(); flashSave();
}

function rollMaxState() {
  rollWounds();
  rollFate();
  $("#state-roll-note").textContent = "Максимум ран и очки судьбы определены по выбранному миру.";
}

function openProfileEdit() {
  profileEditorSnapshot = Object.fromEntries(["name", "rank", "age", "status"].map(key => [key, $(`[data-key="${key}"]`).value]));
  $("#profile-editor").hidden = false;
  $("#profile-name").focus();
}

function closeProfileEdit() { $("#profile-editor").hidden = true; }

function cancelProfileEdit() {
  if (profileEditorSnapshot) {
    for (const [key, value] of Object.entries(profileEditorSnapshot)) $(`[data-key="${key}"]`).value = value;
    profileEditorSnapshot = null; sheetDirty = true; recalc(); flashSave();
  }
  closeProfileEdit();
}

function saveProfile() {
  if (!$("#profile-name").value.trim()) { $("#profile-name").focus(); return; }
  profileEditorSnapshot = null; closeProfileEdit(); sheetDirty = true; recalc(); flashSave();
}

async function logout() {
  clearTimeout(saveTimer);
  if (saveInFlight && !await saveInFlight) {
    flash("не удалось сохранить изменения; выход отменён");
    return;
  }
  if (sheetDirty && !await saveToServer()) {
    flash("не удалось сохранить изменения; выход отменён");
    return;
  }
  try {
    const response = await fetch(`${API_PREFIX}/auth/logout`, { method: "POST" });
    if (!response.ok) throw new Error(response.status);
    location.reload();
  } catch (error) {
    flash("не удалось завершить сеанс");
  }
}

function initArsenalControls() {
  $$(".arsenal-category").forEach(button => button.addEventListener("click", () => {
    $$(".arsenal-category").forEach(category => category.classList.remove("active"));
    button.classList.add("active"); arsenalPage = 1; renderArsenalCatalog();
  }));
  $("#arsenal-search").addEventListener("input", () => { arsenalPage = 1; renderArsenalCatalog(); renderArsenalSuggestions(); });
  $("#arsenal-search").addEventListener("focus", renderArsenalSuggestions);
  for (const selector of ["#arsenal-market", "#arsenal-kind", "#arsenal-availability", "#arsenal-sort"]) {
    $(selector).addEventListener("input", () => { arsenalPage = 1; renderArsenalCatalog(); });
    $(selector).addEventListener("change", () => { arsenalPage = 1; renderArsenalCatalog(); });
  }
  // Обновлять список и при наборе цены, и при завершении редактирования поля.
  for (const selector of ["#arsenal-price-from", "#arsenal-price-to"]) {
    $(selector).addEventListener("input", () => { arsenalPage = 1; renderArsenalCatalog(); });
    $(selector).addEventListener("change", () => { arsenalPage = 1; renderArsenalCatalog(); });
  }
  $("#arsenal-reset").addEventListener("click", () => {
    arsenalPage = 1;
    $("#arsenal-search").value = "";
    $("#arsenal-market").value = "all";
    $("#arsenal-kind").value = "all";
    $("#arsenal-availability").value = "all";
    $("#arsenal-price-from").value = "";
    $("#arsenal-price-to").value = "";
    $("#arsenal-sort").value = "relevance";
    $(".arsenal-category.active").classList.remove("active");
    $(".arsenal-category[data-arsenal-category='all']").classList.add("active");
    renderArsenalCatalog();
  });
  document.addEventListener("click", event => { if (!event.target.closest(".arsenal-search-wrap")) $("#arsenal-suggestions").hidden = true; });
  $("#arsenal-commit").addEventListener("click", commitArsenalCart);
}

/* ---------- запуск ---------- */
async function loadReferenceData() {
  const response = await fetch(`${API_PREFIX}/reference-data`);
  if (!response.ok) throw new Error("Не удалось загрузить игровые справочники. Проверь сервер и повтори вход.");
  const data = await response.json();
  const required = [
    "worlds", "chars", "careers", "skill_list", "skill_groups", "skill_texts",
    "biographies", "career_advancements", "talents", "sanctions", "carry_table", "talent_effects", "armory_catalog",
  ];
  if (required.some(key => data[key] == null)) {
    throw new Error("Сервер вернул неполные игровые справочники. Обнови приложение.");
  }

  WORLDS = data.worlds;
  CHARS = data.chars;
  CAREERS = data.careers;
  CAREER_ADVANCEMENTS = data.career_advancements;
  SKILL_LIST = data.skill_list;
  SKILL_GROUPS = data.skill_groups;
  SKILL_TEXTS = data.skill_texts;
  BIOGRAPHIES = data.biographies;
  TALENTS = data.talents;
  SANCTIONS = data.sanctions;
  CARRY_TABLE = data.carry_table;
  TALENT_EFFECTS = data.talent_effects;
  ARMORY_CATALOG = data.armory_catalog;

  SKILLS = [];
  for (const [name, type, char] of SKILL_LIST) {
    if (SKILL_GROUPS[name]) {
      for (const sub of SKILL_GROUPS[name])
        SKILLS.push({ name: name.replace("*", "") + " (" + sub + ")", type, char });
    } else SKILLS.push({ name, type, char });
  }
  SKILLS.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

async function init() {
  buildChars();
  for (const world of WORLDS) $("#sel-world").appendChild(new Option(world.name, world.id));
  for (const career of CAREERS) $("#sel-career").appendChild(new Option(career.name, career.id));
  populateBioSelect();
  refreshAdvancementSelectors();

  $("#sel-world").addEventListener("change", () => {
    const bio = curBio();
    if (bio && bio.worlds?.length && !bio.worlds.includes($("#sel-world").value)) {
      clearBioRows();
      $("#sel-bio").value = "";
      $("#sel-bio").dataset.prev = "";
    }
    populateBioSelect();
    updateBioStatus();
    showCareerKit(false);
    renderCareerPreview();
    sheetDirty = true; flashSave();
  });
  $("#sel-career").addEventListener("change", onCareerChange);
  $("#sel-bio").addEventListener("change", onBioChange);
  $("#btn-roll-chars").addEventListener("click", rollAllChars);
  $("#btn-edit-chars").addEventListener("click", () => {
    setCharEditMode(!charEditMode);
    recalc();
  });
  $("#btn-print").addEventListener("click", () => window.print());
  $("#btn-hint").addEventListener("click", buildHint);
  $("#btn-delete-character").addEventListener("click", () => deleteCharacter(currentCharId));
  $("#btn-logout").addEventListener("click", logout);
  $("#btn-new-character").addEventListener("click", async () => {
    if (!await saveToServer()) return;
    const data = emptySheetData();
    try {
      const response = await fetch(`${API_PREFIX}/characters`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
      });
      if (!response.ok) throw new Error(response.status);
      const record = await response.json();
      currentCharId = String(record.id);
      try { localStorage.setItem(activeCharStorageKey(), currentCharId); } catch (e) {}
      sheetDirty = false; apply(data); await loadCharList();
      $("#sheet-switcher").value = currentCharId; syncDeleteButton();
      flash("новый лист создан");
    } catch (error) { flash("не удалось создать лист"); }
  });
  $("#sheet-switcher").addEventListener("change", async event => {
    const id = event.currentTarget.value;
    if (!id) return;
    const oldId = currentCharId;
    if (!await saveToServer()) { event.currentTarget.value = oldId || ""; return; }
    if (!await loadCharacter(id)) event.currentTarget.value = oldId || "";
  });
  $("#btn-skill-manage").addEventListener("click", () => setSkillMode("manage"));
  $("#btn-skill-overview").addEventListener("click", () => setSkillMode("overview"));
  $("#btn-skill-hints").addEventListener("click", toggleSkillHints);
  $("#btn-skill-hints-manage").addEventListener("click", toggleSkillHints);
  $("#btn-talent-manage").addEventListener("click", () => setTalentMode(true));
  $("#btn-talent-overview").addEventListener("click", () => setTalentMode(false));
  $("#skill-add-form").addEventListener("submit", event => {
    event.preventDefault();
    const selectedOption = $("#skill-add-name").selectedOptions[0];
    const name = selectedOption?.dataset.skillName || "";
    if (!name) { $("#skill-message").textContent = "Сначала выбери навык."; return; }
    if (!chargeAdvancementXP(selectedOption, $("#skill-message"))) return;
    addSkillRow(name, selectedOption.dataset.level || $("#skill-add-level").value,
      "manual", selectedOption.dataset.choiceKey, selectedOption.dataset.cost);
    event.currentTarget.reset(); $("#skill-message").textContent = "";
    sheetDirty = true; recalc(); flashSave();
  });
  $("#skill-add-name").addEventListener("change", event => {
    const advancementLevel = event.currentTarget.selectedOptions[0]?.dataset.level;
    if (advancementLevel) $("#skill-add-level").value = advancementLevel;
  });
  $("#talent-add-form").addEventListener("submit", event => {
    event.preventDefault();
    const selectedOption = $("#talent-add-name").selectedOptions[0];
    const name = selectedOption?.dataset.talentName || "";
    if (!name) { $("#talent-message").textContent = "Сначала выбери талант."; return; }
    if (!chargeAdvancementXP(selectedOption, $("#talent-message"))) return;
    addTalentRow(name, $("#talent-add-note").value.trim() || undefined);
    event.currentTarget.reset(); $("#talent-message").textContent = "";
    sheetDirty = true; recalc(); flashSave();
  });
  $("#btn-gear-manage").addEventListener("click", () => setGearMode(true));
  $("#btn-gear-overview").addEventListener("click", () => setGearMode(false));
  initArsenalControls();
  $("#gear-add-form").addEventListener("submit", event => {
    event.preventDefault();
    const name = $("#gear-new-name").value.trim();
    if (!name) return;
    gearItems.push({ name, type: $("#gear-new-type").value.trim(), stats: $("#gear-new-stats").value.trim(), qty: 1 });
    event.currentTarget.reset(); $("#gear-message").textContent = "";
    sheetDirty = true; renderGear(); flashSave();
  });
  $("#btn-xp-save").addEventListener("click", () => {
    const details = $("#xp-total-input").closest("details"); if (details) details.open = false;
    sheetDirty = true; recalc(); flashSave();
  });
  $("#btn-wealth-save").addEventListener("click", saveWealth);
  $("#btn-wealth-roll").addEventListener("click", rollWealth);
  $("#btn-state-edit").addEventListener("click", () => toggleStateEditor());
  $("#btn-state-cancel").addEventListener("click", () => toggleStateEditor(false));
  $("#btn-state-save").addEventListener("click", saveState);
  $("#btn-roll-state").addEventListener("click", rollMaxState);
  document.addEventListener("click", event => {
    const button = event.target.closest("[data-state][data-delta]");
    if (button) adjustState(button.dataset.state, Number(button.dataset.delta));
  });
  $("#btn-profile-edit").addEventListener("click", openProfileEdit);
  $("#btn-profile-cancel").addEventListener("click", cancelProfileEdit);
  $("#btn-profile-save").addEventListener("click", saveProfile);
  $("#profile-rank").addEventListener("change", () => { refreshAdvancementSelectors(); sheetDirty = true; recalc(); flashSave(); });
  for (const key of Object.keys(NOTE_BLOCKS)) {
    $(`[data-note-edit="${key}"]`).addEventListener("click", () => openNoteEditor(key));
    $(`[data-note-cancel="${key}"]`).addEventListener("click", () => cancelNoteEditor(key));
    $(`[data-note-save="${key}"]`).addEventListener("click", () => saveNoteEditor(key));
    $(`[data-note-more="${key}"]`).addEventListener("click", () => toggleNoteExpanded(key));
  }

  document.addEventListener("input", event => {
    const statKey = event.target.dataset.statEdit;
    if (statKey) {
      $(`input[data-key="base_${statKey}"]`).value = event.target.value;
      sheetDirty = true; recalc(); flashSave();
      return;
    }
    if (event.target.matches(".armor-zone input") && event.target.value !== "") {
      const armorValue = Number(event.target.value);
      if (!Number.isFinite(armorValue) || armorValue < 0) event.target.value = "0";
    }
    if (!event.target.matches("[data-key]")) return;
    sheetDirty = true; recalc(); flashSave();
  });

  const initialChars = await loadCharList();
  let restored = false;
  let savedId = localStorage.getItem(activeCharStorageKey());
  if (!savedId && !localStorage.getItem(LS_MIGRATED_KEY)) {
    const legacyId = localStorage.getItem(LS_ID_KEY);
    if (legacyId && $(`#sheet-switcher option[value="${CSS.escape(legacyId)}"]`)) {
      savedId = legacyId;
      try { localStorage.setItem(activeCharStorageKey(), savedId); localStorage.removeItem(LS_ID_KEY); } catch (e) {}
    }
  }
  if (savedId && $(`#sheet-switcher option[value="${CSS.escape(savedId)}"]`)) {
    restored = await loadCharacter(savedId);
  }
  if (!localStorage.getItem(LS_MIGRATED_KEY) && initialChars && initialChars.length === 0) {
    try {
      const saved = localStorage.getItem(LS_SHEET_KEY);
      if (saved) {
        const data = stripRetiredFields(JSON.parse(saved));
        const response = await fetch(`${API_PREFIX}/characters`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
        });
        if (response.ok) {
          const record = await response.json();
          currentCharId = String(record.id);
          try { localStorage.setItem(activeCharStorageKey(), currentCharId); } catch (e) {}
          apply(data); await loadCharList(); $("#sheet-switcher").value = currentCharId;
          sheetDirty = data.__gearMigrated !== "1" || data.__statsRaw !== "1";
          restored = true; localStorage.setItem(LS_MIGRATED_KEY, "1");
          flash("миграция из локального хранилища");
          if (sheetDirty) flashSave();
        }
      } else localStorage.setItem(LS_MIGRATED_KEY, "1");
    } catch (error) { /* миграция не удалась — лист останется пустым */ }
  } else if (initialChars && initialChars.length > 0) {
    try { localStorage.setItem(LS_MIGRATED_KEY, "1"); } catch (e) {}
  }
  if (!$('input[data-key="xpTotal"]').value) $('input[data-key="xpTotal"]').value = "400";
  const restoredBio = $("#sel-bio").value;
  populateBioSelect();
  if (restoredBio) $("#sel-bio").value = restoredBio;
  updateBioStatus();
  recalc();
}

function setAuthMode(mode) {
  const registering = mode === "register";
  $("#login-form").hidden = registering;
  $("#register-form").hidden = !registering;
  $("#show-login").classList.toggle("primary", !registering);
  $("#show-register").classList.toggle("primary", registering);
  $("#show-login").setAttribute("aria-selected", String(!registering));
  $("#show-register").setAttribute("aria-selected", String(registering));
  $("#auth-message").textContent = "";
}

async function openApplication(user) {
  authUser = user;
  try {
    await loadReferenceData();
  } catch (error) {
    $("#auth-screen").hidden = false;
    $("#app-shell").hidden = true;
    $("#auth-message").textContent = error.message;
    throw error;
  }
  $("#auth-screen").hidden = true;
  $("#app-shell").hidden = false;
  await init();
}

async function submitAuth(form, endpoint) {
  const button = form.querySelector('button[type="submit"]');
  const message = $("#auth-message");
  button.disabled = true;
  message.textContent = "Проверка данных…";
  try {
    const fields = Object.fromEntries(new FormData(form));
    const response = await fetch(`${API_PREFIX}/auth/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось выполнить вход");
    form.reset();
    message.textContent = "";
    await openApplication(result.user);
  } catch (error) {
    message.textContent = error.message === "Failed to fetch"
      ? "Нет соединения с сервером. Запусти приложение через python server.py."
      : error.message;
  } finally {
    button.disabled = false;
  }
}

async function startApplication() {
  $("#show-login").addEventListener("click", () => setAuthMode("login"));
  $("#show-register").addEventListener("click", () => setAuthMode("register"));
  $("#login-form").addEventListener("submit", event => {
    event.preventDefault();
    submitAuth(event.currentTarget, "login");
  });
  $("#register-form").addEventListener("submit", event => {
    event.preventDefault();
    submitAuth(event.currentTarget, "register");
  });
  try {
    const response = await fetch(`${API_PREFIX}/auth/session`);
    if (response.ok) {
      const result = await response.json();
      await openApplication(result.user);
      return;
    }
  } catch (error) {
    $("#auth-message").textContent = error.message === "Failed to fetch"
      ? "Нет соединения с сервером. Запусти приложение через python server.py."
      : error.message;
  }
  $("#auth-screen").hidden = false;
}

document.addEventListener("DOMContentLoaded", startApplication);
