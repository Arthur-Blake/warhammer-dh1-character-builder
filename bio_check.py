#!/usr/bin/env python3
# Browser-проверки покупки биографий (Dark Heresy character sheet)
import json, time, sys
from selenium import webdriver
from selenium.webdriver.chrome.options import Options

URL = "file:///home/grigoriev-m/Documents/DarkHeresyCharacterSheet/index.html"
opts = Options()
opts.add_argument("--headless=new")
opts.add_argument("--no-sandbox")
opts.add_argument("--disable-dev-shm-usage")
d = webdriver.Chrome(options=opts)

results = []
def check(name, ok, detail=""):
    results.append((name, ok))
    print(("✓ " if ok else "✗ ") + name + (" | " + detail if detail else ""))

def js(script):
    return d.execute_script(script)

js("try{localStorage.clear()}catch(e){}")
d.get(URL)
time.sleep(0.3)

# ---- 1. без профессии селект биографии пуст ----
n0 = js("return document.querySelectorAll('#sel-bio option').length")
check("1. без профессии: 1 опция (плейсхолдер)", n0 == 1, f"options={n0}")

# ---- 2. выбор профессии → список биографий; покупка вычитает ОО ----
js("""
  const w=document.querySelector('#sel-world'); w.value='hive';
  w.dispatchEvent(new Event('change'));
  const c=document.querySelector('#sel-career'); c.value='clrk';
  c.dispatchEvent(new Event('change'));
""")
n_opts = js("return document.querySelectorAll('#sel-bio option').length")
check("2a. клирик: 4 опции (3 биографии + плейсхолдер)", n_opts == 4, f"options={n_opts}")

js("""
  const b=document.querySelector('#sel-bio'); b.value='bio_clrk_1'; b.dataset.prev='bio_clrk_1';
  b.dispatchEvent(new Event('change'));
""")
xp = js("return document.querySelector('#xpFree').textContent")
check("2b. покупка «Великие Приделы Тарсуса» (200): xpFree=200", xp == "200", f"xpFree={xp}")

rows = js("return Array.from(document.querySelectorAll('#skills-tbody tr[data-src=bio]')).map(t=>t.children[0].lastChild.value)")
check("2c. добавлено 4 умения биографии", len(rows) == 4, ", ".join(rows))
tal = js("return Array.from(document.querySelectorAll('#talents-tbody tr[data-src=bio]')).map(t=>t.children[0].lastChild.value)")
check("2d. добавлен 1 талант биографии", tal == ["Равный (Экклезиархия)"], ", ".join(tal))

# ---- 3. пометки 🛠️ ----
marks = js("return Array.from(document.querySelectorAll('#skills-tbody tr[data-src=bio] .bio-mark')).filter(m=>!m.hidden).length")
check("3a. 🛠️ виден у 4 умений", marks == 4, f"visible={marks}")
tmark = js("return Array.from(document.querySelectorAll('#talents-tbody tr[data-src=bio] .bio-mark')).filter(m=>!m.hidden).length")
check("3b. 🛠️ виден у таланта", tmark == 1, f"visible={tmark}")
fix = js("return document.querySelector('#fix_int').textContent")
check("3c. Итог Инт: пометка «Биография» и +5", "+5 (🛠️ Биография: Великие Приделы Тарсуса)" in fix, fix)
fixb = js("return document.querySelector('#fix_bb').textContent")
check("3d. Итог Лов: −5 от биографии присутствует", "-5 (🛠️ Биография" in fixb, fixb)
val_int = js("return document.querySelector('#val_int').textContent")
check("3e. Итог Инт учитывает +5", val_int != "—", f"val_int={val_int}")

# ---- 4. смена биографии: старые строки сняты, статус обновлён ----
js("""
  const b=document.querySelector('#sel-bio'); b.value='bio_clrk_2';
  b.dispatchEvent(new Event('change'));
""")
skl2 = js("return Array.from(document.querySelectorAll('#skills-tbody tr[data-src=bio]')).map(t=>t.children[0].lastChild.value)")
check("4a. смена биографии: старые строки удалены, новые добавлены",
      skl2 == ["Обыденное Знание (Империум)", "Навигация (Наземная)", "Учёное Знание (Легенды)", "Выживание"],
      "; таланты биографии: " + ", ".join(js("return Array.from(document.querySelectorAll('#talents-tbody tr[data-src=bio]')).map(t=>t.children[0].lastChild.value)")))
fix2 = js("return document.querySelector('#fix_int').textContent")
check("4b. стат-бонусы старой биографии сняты", "Тарсуса" not in fix2, fix2)

# ---- 5. wealth ×0.5 ----
flash = js("""
  const btn=document.querySelector('#btn-wealth');
  btn.click();
  return document.querySelector('#save-status').textContent;
""")
w_val = js("return document.querySelector('#wealth').value")
check("5a. flash богатство ×0.5", "×0.5" in flash and "богатство" in flash, flash)
w_int = js("""
  const v=+document.querySelector('#wealth').value;
  return Number.isInteger(v) && v>0 && v<=330;
""")
check("5b. значение целое, положительное", w_int, f"wealth={w_val}")

# ---- 6. недостаточно ОО → откат ----
js("""
  const xp=document.querySelector('input[data-key=xpTotal]'); xp.value='50';
  xp.dispatchEvent(new Event('input',{bubbles:true}));
  const b=document.querySelector('#sel-bio'); b.value='bio_clrk_1';
  b.dispatchEvent(new Event('change'));
""")
flash2 = js("return document.querySelector('#save-status').textContent")
sel_now = js("return document.querySelector('#sel-bio').value")
tal3 = js("return Array.from(document.querySelectorAll('#skills-tbody tr[data-src=bio]')).map(t=>t.children[0].lastChild.value)")
check("6a. при нехватке ОО откат на «Проповедник»", sel_now == "bio_clrk_2", f"sel={sel_now}, flash={flash2}")
check("6b. строки биографии после отката сохранены",
      tal3 == ["Обыденное Знание (Империум)", "Навигация (Наземная)", "Учёное Знание (Легенды)", "Выживание"], ", ".join(tal3))
js("const xp=document.querySelector('input[data-key=xpTotal]'); xp.value='400'; xp.dispatchEvent(new Event('input',{bubbles:true}));")

# ---- 7. смена профессии: биография снимается, ОО возвращаются ----
js("""
  const c=document.querySelector('#sel-career'); c.value='gd';
  c.dispatchEvent(new Event('change'));
""")
xp_after = js("return document.querySelector('#xpFree').textContent")
sel_after = js("return document.querySelector('#sel-bio').value")
bio_rows = js("return document.querySelectorAll('#talents-tbody tr[data-src=bio]').length")
check("7a. смена профессии: xpFree восстановлен (400)", xp_after == "400", f"xpFree={xp_after}")
check("7b. селект биографии сброшен", sel_after == "", f"sel={sel_after}")
check("7c. биографические строки сняты", bio_rows == 0, f"rows={bio_rows}")

# ---- 8. сохранение в localStorage и восстановление bioId ----
js("""
  const c=document.querySelector('#sel-career'); c.value='clrk';
  c.dispatchEvent(new Event('change'));
  const b=document.querySelector('#sel-bio'); b.value='bio_clrk_1'; b.dataset.prev='bio_clrk_1';
  b.dispatchEvent(new Event('change'));
""")
# ЛОВУШКА: flashSave дебаунсится 300ms — без паузы прочитается старое состояние
time.sleep(0.5)
saved = json.loads(js("return localStorage.getItem('dh1e-sheet-v1')"))
check("8a. localStorage: bioId записан", saved.get("bioId") == "bio_clrk_1", f"bioId={saved.get('bioId')}")
check("8b. localStorage: __skills с пометкой bio", "|bio" in saved.get("__skills", ""), saved.get("__skills", "")[:80])
check("8c. localStorage: __talents с пометкой bio", "|bio" in saved.get("__talents", ""), saved.get("__talents", "")[:80])

# перезагрузка — проверка восстановления bioId (фикс populateBioSelect в apply/init)
d.refresh()
time.sleep(0.5)
sel_rest = js("return document.querySelector('#sel-bio').value")
tal_rest = js("return Array.from(document.querySelectorAll('#talents-tbody tr[data-src=bio]')).map(t=>t.children[0].lastChild.value)")
xp_rest = js("return document.querySelector('#xpFree').textContent")
status_rest = js("return document.querySelector('#bio-status').textContent")
check("8d. после перезагрузки: селект биографии восстановлен", sel_rest == "bio_clrk_1", f"sel={sel_rest!r}")
check("8e. после перезагрузки: строки биографии восстановлены", tal_rest == ["Равный (Экклезиархия)"], ", ".join(tal_rest))
check("8f. после перезагрузки: xpFree=200 (стоимость вычтена)", xp_rest == "200", f"xpFree={xp_rest}")
check("8g. после перезагрузки: статус биографии показывает цену", "200 ОО" in status_rest, status_rest)

# ---- 9. XML: collect содержит bioId ----
has_bio = js("""
  const data=collect();
  return data.bioId==='bio_clrk_1' && data.__skills.includes('|bio');
""")
check("9. collect(): bioId и bio-пометки в XML-данных", has_bio)

# ---- 10. сохранение характеристик/мира/ран/богатства, без задвоений ----
# меняем мир и статы, добавляем ручное умение; после reload всё должно восстановиться
js("""
  const w=document.querySelector('#sel-world'); w.value='feral';
  w.dispatchEvent(new Event('change'));
  const bb=document.querySelector('input[data-key=base_bb]'); bb.value='41';
  bb.dispatchEvent(new Event('input',{bubbles:true}));
  const bs=document.querySelector('input[data-key=adv_bs]'); bs.value='5';
  bs.dispatchEvent(new Event('input',{bubbles:true}));
  const wd=document.querySelector('input[data-key=wounds]'); wd.value='13';
  wd.dispatchEvent(new Event('input',{bubbles:true}));
  const wh=document.querySelector('input[data-key=wealth]'); wh.value='27';
  wh.dispatchEvent(new Event('input',{bubbles:true}));
  addSkillRow('Запугивание', 'trained', 'manual');
  addTalentRow('Бешенство', '', 'manual');
""")
# запоминаем количество строк до перезагрузки
sk_before = js("return document.querySelectorAll('#skills-tbody tr').length")
tl_before = js("return document.querySelectorAll('#talents-tbody tr').length")

time.sleep(0.5)  # дебаунс flashSave
saved2 = json.loads(js("return localStorage.getItem('dh1e-sheet-v1')"))
check("10a. localStorage: world записан", saved2.get("world") == "feral", f"world={saved2.get('world')}")
check("10b. localStorage: base_bb/adv_bs записаны",
      saved2.get("base_bb") == "41" and saved2.get("adv_bs") == "5",
      f"base_bb={saved2.get('base_bb')}, adv_bs={saved2.get('adv_bs')}")
check("10c. localStorage: wounds/wealth записаны",
      saved2.get("wounds") == "13" and saved2.get("wealth") == "27",
      f"wounds={saved2.get('wounds')}, wealth={saved2.get('wealth')}")

d.refresh()
time.sleep(0.5)
world_rest = js("return document.querySelector('#sel-world').value")
bb_rest = js("return document.querySelector('input[data-key=base_bb]').value")
bs_rest = js("return document.querySelector('input[data-key=adv_bs]').value")
wd_rest = js("return document.querySelector('input[data-key=wounds]').value")
wh_rest = js("return document.querySelector('input[data-key=wealth]').value")
check("10d. после перезагрузки: мир восстановлен", world_rest == "feral", f"world={world_rest}")
check("10e. после перезагрузки: характеристики восстановлены",
      bb_rest == "41" and bs_rest == "5", f"base_bb={bb_rest}, adv_bs={bs_rest}")
check("10f. после перезагрузки: раны и богатство восстановлены",
      wd_rest == "13" and wh_rest == "27", f"wounds={wd_rest}, wealth={wh_rest}")

# задвоения нет: столько же строк, сколько до перезагрузки, имена не повторяются
sk_after = js("return document.querySelectorAll('#skills-tbody tr').length")
tl_after = js("return document.querySelectorAll('#talents-tbody tr').length")
sk_names = js("return Array.from(document.querySelectorAll('#skills-tbody tr')).map(t=>t.children[0].querySelector('select').value)")
check("10g. после перезагрузки: строки умений не задвоены",
      sk_after == sk_before, f"было={sk_before}, стало={sk_after}")
check("10h. после перезагрузки: строки талантов не задвоены",
      tl_after == tl_before, f"было={tl_before}, стало={tl_after}")
js("apply(collect()); apply(collect());")
sk_reapply = js("return document.querySelectorAll('#skills-tbody tr').length")
tl_reapply = js("return document.querySelectorAll('#talents-tbody tr').length")
check("10i. повторный apply(): дубликатов не появляется",
      sk_reapply == sk_before and tl_reapply == tl_before,
      f"sk={sk_reapply}, tl={tl_reapply}")
check("10j. имена умений уникальны после восстановления",
      len(sk_names) == len(set(sk_names)), ", ".join(sk_names))

# ---- 11. подсказка: сводка умений и талантов отображается ----
js("document.querySelector('#btn-hint').click()")
hint = js("return document.querySelector('#hint-box').textContent")
check("11a. подсказка: умение биографии в сводке",
      "Обольщение" in hint, hint[:120])
check("11b. подсказка: талант биографии в сводке",
      "Равный (Экклезиархия)" in hint, hint[:120])
check("11c. подсказка: ручное умение в сводке", "Запугивание" in hint, hint[:120])
check("11d. подсказка: заглушка «ничего не добавлено» заменена сводкой",
      "— ничего не добавлено" != hint.strip() and hint.strip() != "", hint[:120])

fails = [n for n, ok in results if not ok]
print()
print("ИТОГО:", "ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" if not fails else f"ПРОВАЛЕНО: {fails}")
sys.exit(1 if fails else 0)
