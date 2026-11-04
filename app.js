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

/* ---------- характеристики ---------- */
const curWorld = () => WORLDS.find(w => w.id === $("#sel-world").value);

/* прямые стат-бонусы родного мира для характеристики key:
   statFixes — всегда, careerFix (Особенность «Годен») — по Профессии */
function charFixes(key) {
  const w = curWorld();
  const out = [];
  if (!w) return out;
  for (const f of (w.statFixes || [])) if (f.key === key) out.push(f);
  const cf = w.careerFix;
  if (cf && cf.map && cf.map[$("#sel-career").value] === key) out.push(cf);
  return out;
}

/* разбор источников цифры у сгенерированного значения:
   «+20 (Мир-кузница) +3 (Годен)» — мод. напыления уже внутри base */
function fixBreakdown(key) {
  const w = curWorld();
  if (!w) return "";
  const parts = [];
  if (w.mods[key]) parts.push(`${fmtMod(w.mods[key])} (${w.name})`);
  for (const f of charFixes(key)) parts.push(`${fmtMod(f.v)} (${f.src})`);
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

  $("#xpFree").textContent =
    Math.max(0, num($("input[data-key=xpTotal]").value) - num($("input[data-key=xpSpent]").value));

  for (const tr of $("#skills-tbody").rows) calcSkillRow(tr);
  flashSave();
}

/* ---------- умения ---------- */
function addSkillRow(name = "", lvl = "untrained") {
  const tb = $("#skills-tbody");
  const tr = document.createElement("tr");

  const sel = document.createElement("select");
  sel.dataset.key = "sk" + (++uidSeq);
  sel.className = "sk-name";
  const ogBase = document.createElement("optgroup"); ogBase.label = "Базовые";
  const ogAdv  = document.createElement("optgroup"); ogAdv.label  = "Продвинутые";
  for (const s of SKILLS) {
    const o = document.createElement("option");
    o.value = s.name; o.textContent = s.name;
    o.dataset.type = s.type; o.dataset.char = s.char;
    (s.type === "b" ? ogBase : ogAdv).appendChild(o);
  }
  sel.appendChild(new Option(""));
  sel.appendChild(ogBase); sel.appendChild(ogAdv);

  const lvlSel = document.createElement("select");
  lvlSel.dataset.key = sel.dataset.key + "_lvl";
  lvlSel.className = "sk-lvl";
  lvlSel.innerHTML =
    `<option value="untrained">Без обучения</option>` +
    `<option value="trained">Обучено (+10)</option>` +
    `<option value="mastery">Владение (+20)</option>`;

  const charTd = document.createElement("td"); charTd.className = "muted";
  const goalTd = document.createElement("td"); goalTd.className = "goal";
  const nameTd = document.createElement("td"); nameTd.appendChild(sel);
  const lvlTd  = document.createElement("td"); lvlTd.appendChild(lvlSel);
  const delTd  = document.createElement("td"); delTd.className = "del";
  delTd.innerHTML = `<button type="button">✕</button>`;
  delTd.querySelector("button").onclick = () => { tr.remove(); flashSave(); recalc(); };
  tr.append(nameTd, charTd, lvlTd, goalTd, delTd);
  tb.appendChild(tr);

  if (name) sel.value = name;
  lvlSel.value = lvl;
  sel.onchange    = () => { calcSkillRow(tr); flashSave(); };
  lvlSel.onchange = () => { calcSkillRow(tr); flashSave(); };
  calcSkillRow(tr);
}
function calcSkillRow(tr) {
  const [selName, selLvl] = tr.querySelectorAll("select");
  const opt = selName.selectedOptions[0];
  const charTd = tr.children[1], goalTd = tr.children[3];
  if (!opt || !opt.dataset.char) { charTd.textContent = ""; goalTd.textContent = "—"; return; }
  charTd.textContent = CHARS.find(x => x.key === opt.dataset.char).abbr;
  const base = getVal(opt.dataset.char);
  let mod = 0, tag = "";
  if (selLvl.value === "trained") { mod = 10; tag = "обучено +10"; }
  else if (selLvl.value === "mastery") { mod = 20; tag = "владение +20"; }
  else if (opt.dataset.type === "a") { mod = -20; tag = "без формы −20"; }
  goalTd.textContent = base ? `${base + mod} ${tag}` : "—";
}

/* ---------- таланты ---------- */
function addTalentRow(name = "", note = "") {
  const tb = $("#talents-tbody");
  const tr = document.createElement("tr");

  const sel = document.createElement("select");
  sel.dataset.key = "tl" + (++uidSeq) + "_n";
  // ВАЖНО: плейсхолдер добавляем ПЕРВЫМ — при добавлении опций в пустой select
  // первая опция автоматически становится выбранной (HTML spec), и вставка
  // плейсхолдера перед ней потом selectedIndex не сбрасывает
  sel.appendChild(new Option(""));
  for (const t of TALENTS) { const o = document.createElement("option"); o.textContent = t; sel.appendChild(o); }

  const noteEl = document.createElement("input");
  noteEl.type = "text";
  noteEl.dataset.key = sel.dataset.key.replace("_n", "_x");
  noteEl.placeholder = "примечание / подтип";

  const nameTd = document.createElement("td"); nameTd.appendChild(sel);
  const noteTd = document.createElement("td"); noteTd.appendChild(noteEl);
  const delTd  = document.createElement("td"); delTd.className = "del";
  delTd.innerHTML = `<button type="button">✕</button>`;
  delTd.querySelector("button").onclick = () => { tr.remove(); flashSave(); recalc(); };
  tr.append(nameTd, noteTd, delTd);
  tb.appendChild(tr);

  if (name) sel.value = name;
  else sel.selectedIndex = 0;   // гарантируем «пусто» даже после истории опций
  noteEl.value = note;
  sel.onchange   = () => { flashSave(); recalc(); };   // Пси-рейтинг влияет на производные
  noteEl.oninput = flashSave;
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
  delTd.querySelector("button").onclick = () => { tr.remove(); flashSave(); };
  tr.appendChild(delTd);
  tb.appendChild(tr);
  tr.addEventListener("input", flashSave);
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
  flashSave();
  flash(`судьба: d10=${n} → ${pts} очк.`);
};
const rollWealth = () => {
  const c = CAREERS.find(x => x.id === $("#sel-career").value);
  if (!c) return flash("сначала выбери профессию");
  const m = c.wealth.match(/^(\d+)\+(\d+)d(\d+)$/);
  let val = m ? +m[1] : +c.wealth;                   // сумма K отдельных бросков dN
  if (m) for (let i = 0; i < +m[2]; i++) val += die(+m[3]);
  $("#wealth").value = val;
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
    tr => [tr.children[0].firstChild.value, tr.children[2].firstChild.value]);
  data.__talents = packRows($("#talents-tbody"),
    tr => [tr.children[0].firstChild.value, tr.children[1].firstChild.value]);
  data.__weapons = packRows($("#weapons-tbody"),
    tr => Array.from(tr.children).slice(0, 9).map(td => td.firstChild.value));
  return data;
}

function apply(data) {
  $("#skills-tbody").innerHTML = "";
  $("#talents-tbody").innerHTML = "";
  $("#weapons-tbody").innerHTML = "";

  const unescField = u => u.replace(/\\[SP\\]/g, m =>
    m === "\\S" ? ";" : m === "\\P" ? "|" : "\\");
  const unpack = s => (s || "").split(";").filter(Boolean)
    .map(t => t.split("|").map(unescField));
  for (const [name, lvl] of unpack(data.__skills)) addSkillRow(name, lvl || "untrained");
  for (const [name, note] of unpack(data.__talents)) addTalentRow(name, note || "");
  for (const fields of unpack(data.__weapons)) addWeaponRow({ name: fields[0], cls: fields[1], dmg: fields[2], dtyp: fields[3], pen: fields[4], rng: fields[5], clip: fields[6], rld: fields[7], spec: fields[8] });

  // значения статичных полей
  const dynamic = /^(base_|adv_|sk\d|tl\d|w\d|__)/;
  for (const [k, v] of Object.entries(data)) {
    if (dynamic.test(k) || k.startsWith("sk") || k.startsWith("tl") || k.startsWith("w")) continue;
    const el = document.querySelector(`[data-key="${CSS.escape(k)}"]`);
    if (el) el.value = v;
  }
  $("input[data-key=xpTotal]").value = data.xpTotal ?? "400";
  showCareerKit(false);
  recalc();
}

/* ---------- сохранение / XML ---------- */
let saveTimer;
function flashSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem("dh1e-sheet-v1", JSON.stringify(collect()));
      $("#save-status").textContent = "сохранено " + new Date().toLocaleTimeString("ru");
    } catch (e) {
      $("#save-status").textContent = "хранилище недоступно — экспортируй XML";
    }
  }, 300);
}
function flash(msg) { $("#save-status").textContent = msg; }
const saveSoon = flashSave;   // программные изменения значения поля не создают событие input

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
function buildHint() {
  const parts = [];

  // умения
  let sk = [];
  for (const tr of $("#skills-tbody").rows) {
    const sel = tr.children[0].firstChild;
    const name = sel.value;
    if (!name) continue;
    const opt = sel.selectedOptions[0];
    const meta = opt && opt.dataset.char
      ? `${opt.dataset.type === "b" ? "Базовое" : "Продвинутое"} умение, тест по ${CHARS.find(x => x.key === opt.dataset.char).name}`
      : "характеристика не определена";
    const goal = tr.children[3].textContent;
    sk.push(`<li><b>${esc(name)}</b> — ${esc(meta)}. Цель Теста: ${esc(goal)}.`);
  }
  parts.push(`<div class="hgroup"><h3>Умения</h3>` +
    (sk.length ? `<ul>${sk.join("")}</ul>` : `<p class="muted">— ничего не добавлено</p>`) + `</div>`);

  // таланты
  let tl = [];
  for (const tr of $("#talents-tbody").rows) {
    const name = tr.children[0].firstChild.value;
    if (!name) continue;
    const note = tr.children[1].firstChild.value.trim();
    const text = findTalentText(name);
    const noteHtml = note ? `<i>· заметка: ${esc(note)}</i>` : "";
    tl.push(`<li><b>${esc(name)}</b>${noteHtml} — ${text ? esc(text) : "описания нет в справочнике (см. гл. IV книги; подтипы групповых талантов уточняй в скобках)."}`);
  }
  parts.push(`<div class="hgroup"><h3>Таланты и способности</h3>` +
    (tl.length ? `<ul>${tl.join("")}</ul>` : `<p class="muted">— ничего не добавлено</p>`) + `</div>`);

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

/* ---------- запуск ---------- */
function init() {
  buildChars();

  for (const w of WORLDS) $("#sel-world").appendChild(new Option(w.name, w.id));
  for (const c of CAREERS) $("#sel-career").appendChild(new Option(c.name, c.id));

  $("#sel-world").addEventListener("change", () => showCareerKit(false));
  $("#sel-career").addEventListener("change", () => showCareerKit(true));

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
  $("#btn-add-skill").onclick  = () => { addSkillRow(); flashSave(); };
  $("#btn-add-talent").onclick = () => { addTalentRow(); flashSave(); };
  $("#btn-add-weapon").onclick = () => { addWeaponRow(); flashSave(); };
  $("#btn-hint").onclick = buildHint;

  $("#btn-export").onclick = exportXML;
  $("#btn-print").onclick  = () => window.print();
  $("#btn-import").onclick = () => $("#file-import").click();
  $("#file-import").addEventListener("change", e => { if (e.target.files[0]) importXML(e.target.files[0]); e.target.value = ""; });
  $("#btn-reset").onclick = () => {
    if (!confirm("Очистить лист? Несохранённый XML будет потерян.")) return;
    try { localStorage.removeItem("dh1e-sheet-v1"); } catch (e) { /* хранилище недоступно */ }
    location.reload();
  };

  document.addEventListener("input", e => {
    if (e.target.dataset && e.target.dataset.key) flashSave(), recalc();
  });

  let restored = false;
  try {
    const saved = localStorage.getItem("dh1e-sheet-v1");
    if (saved) { apply(JSON.parse(saved)); restored = true; }
  } catch (e) { /* первый запуск */ }
  if (!restored) {
    addSkillRow();
    addTalentRow();
    addWeaponRow();
  }
  // xpTotal — поле со значением по умолчанию тоже попадает в data-key
  if (!$("input[data-key=xpTotal]").value) $("input[data-key=xpTotal]").value = "400";
  recalc();
}
document.addEventListener("DOMContentLoaded", init);
