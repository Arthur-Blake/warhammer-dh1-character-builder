# SESSION_CONTEXT — внедрение SQLite-базы персонажей

_Сессия: 2026-11-05. Фаза: build (переход из plan). Статус: код написан, проверки НЕ завершены._

## Цель задачи

Добавить SQLite-БД в лист персонажа Dark Heresy: хранение персонажей и их характеристик,
добавление новых персонажей и загрузка существующих из БД. Выбранный режим: **локальный
сервер** (Python stdlib), т.к. лист — статическая страница без сборки/зависимостей.

## Архитектура решения (согласована)

- Приложение запускается через `python3 server.py` (порт 8000 по умолчанию, `--port`/`PORT`).
- БД: `characters.sqlite3` рядом с server.py, таблица
  `characters(id INTEGER PK AUTOINCREMENT, name TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT, updated_at TEXT)`.
  `data` — полный JSON-снимок `collect()` (все поля `[data-key]` + `__skills`/`__talents`/`__weapons`/`bioId`).
- API `/api/characters`, `/api/characters/<id>`: GET список, POST, GET, PUT, DELETE.
- UI: в тулбаре `#char-list` (select персонажей) + кнопка «＋ Новый персонаж» (`#btn-new-character`).
- app.js: `collect()`/`apply()` остаются едиными шлюза сериализации (используются и для
  localStorage, и для XML, и теперь для БД). Автосохранение → PUT (или POST, если записи
  ещё нет); guard `isApplying` блокирует сохранение во время `apply()`;
  флаг `sheetDirty` (грязный лист) управляет автопостингом.
- Сброс (`#btn-reset`) НЕ удаляет запись в БД, только чистит localStorage-ключи и делает reload.
- Миграция: при первом старте, если БД пуста, а в localStorage есть `dh1e-sheet-v1` — POST-перенос.
- Старые ключи localStorage: `dh1e-sheet-v1` (снимок), `dh1e-current-id-v1` (текущий id).

## Факты о проекте (проверены ходоками-агентами)

- Статика: `index.html` + `app.js` (~1003 строки) + `data.js` + `style.css`. Node v18, Python 3.
- Точка входа: `index.html:167-168` (script-теги), `init()` — конец app.js.
- Модели персонажа нет — состояние в DOM (`data-key`), сериализация `collect()`/`apply()`.
- Характеристики: `data.js:91 CHARS`, рендер `buildChars()` (app.js ~47-73), `getVal()`, `recalc()` (~83-141).
- Тест `bio_check.py`: Selenium + headless Chrome, чистит localStorage, открывает
  `file:///home/grigoriev-m/Documents/DarkHeresyCharacterSheet/index.html`. Теперь лист
  предназначен для запуска через `http://127.0.0.1:8000/` — под `file://` API недоступен.
- В print-медиазапросе тулбар скрывается (`header .toolbar, button{display:none}`).

## Выполнено

- `server.py` создан (статика + CRUD API + создание БД + stderr-логирование).
- `index.html`: добавлен `#char-select` (id `char-list`) и `#btn-new-character`.
- `style.css`: стили `#char-list`, скрытие при печати.
- `app.js`: переменные `currentCharId` (line ~18), `isApplying` (~19), `sheetDirty` (~20);
  `loadCharList`, `loadCharacter`, `saveToServer(force)`, `renderCharList`,
  `updateCharListOption`; flashSave → saveToServer c debounce 300 мс; обработчики
  `#char-list` change (~919), `#btn-new-character` (~926), init: список + миграция;
  reset чистит LS_ID_KEY + LS_SHEET_KEY; `#save-status` статусы.
- Мои правки поверх (все применены):
  - `recalc()` (~140): `flashSave()` → `if (sheetDirty) flashSave();` — юзаюзёр loaded
    лист не шлёт PUT.
  - `sheetDirty = true` добавлен во все user-инициированные селект/инпут-изменения строк:
    умения (~194-195), таланты + заметки (~284-285), ввод в строке оружия (~313).

## НЕ завершено (продолжить отсюда)

1. Пометить `sheetDirty = true` в програмных изменениях листа:
   - `rollFate` ~line 387 (`flashSave()` после установки fateLeft/fateTotal);
   - `rollWealth` ~399 и ~405 (обе ветки внутри bio.wealthMul и обычная);
   - `rollSanction` (~после добавления строки в notes — ищи flashSave рядом);
   - `onBioChange` ~834 и ~857 (покупка/снятие биографии).
2. Прогнать проверки:
   ```
   node --check app.js && node --check data.js && python3 -m py_compile server.py
   python3 server.py --port 8123 &
   curl http://127.0.0.1:8123/api/characters
   curl -X POST http://127.0.0.1:8123/api/characters -H 'Content-Type: application/json' \
        -d '{"name":"Тест","ws":"30"}'
   curl http://127.0.0.1:8123/                 # должен отдать index.html
   ls characters.sqlite3                     # файл БД
   kill %1
   ```
   (sqlite3 CLI может отсутствовать — проверять через `python3 -c "import sqlite3; ..."`)
3. Ручная UI-проверка в браузере: создание, редактирование имени, переключение,
   новый персонаж, рестарт сервера (id восстанавливается, updated_at не прыгает на закрытом листе).
4. `bio_check.py` — прогнать под сервером при установленном Selenium; тест писался под
   localStorage-эпоху, может потребовать актуализации (не менять без необходимости).
5. Финальный `@reviewer` (макс. 2 круга) — только по итогу завершённых изменений.

## Риски / решения

- Решение: условие автосохранения \(не\) заменено на `if (!sheetDirty && !force) return;`
  — ПОЛНАЯ замена ломает сохранение после роллов/покупки биографии (они звали flashSave
  без dirty). Это применение выше через пункт 1 (пометить dirty в этих функциях).
- Лог выбора персонажа: `saveToServer()` перед `loadCharacter(id)` (app.js ~922).
- 404 при PUT → fallback на POST-создание (запись удалена снаружи).
- Статусные сообщения: «сохранение…», «сохранено …», «Не сохранено (offline?)».
- `__pycache__` появился от py_compile — можно удалить/занести в .gitignore (его нет).

---

# ПЛАН сессии 2026-11-05 (вторая задача) — UX листа: печать, персонажи, сброс

_Фаза: build. Статус: план согласован, реализация в этой же сессии._

## Постановка (запрос пользователя)

1. При печати характеристик «уезжает» шапка страницы — исправить печатную раскладку.
2. «Новый персонаж» должен создавать новый ПУСТОЙ лист (сейчас копируется текущий лист
   без имени — `app.js:932-954`).
3. Нужна кнопка удаления персонажа из БД (клиентского DELETE нет; серверный эндпоинт
   `DELETE /api/characters/{id}` готов — `server.py:164-174, 268-275`).
4. Пункт «— выбрать персонажа —» в селекте должен пропадать, когда персонажей > 0
   (допущение: скрывается placeholder-опция `<option value="">`, сам селект остаётся).
5. «Сброс» должен удалять ВСЕ данные персонажа, включая запись в БД (сейчас он не трогает
   БД — `app.js:908-915`, текст confirm это фиксирует).

## Установленные факты (ходоками-агентами)

- Шапка: `index.html:10-22` (`header` + `.toolbar`); print-стили только
  `style.css:129-140` — тулбар и все кнопки скрываются (`:132`), остальных
  позиционирований/разрывов страниц нет; лист наследует экранную раскладку.
- Кнопки тулбара: `#btn-export/#btn-import/#btn-print/#btn-reset/#btn-new-character`,
  селект `#char-list` (`index.html:13-20`), статус `#save-status`.
- Персонажи: `renderCharList()` app.js:519-529 (первая опция всегда placeholder),
  `updateCharListOption` (:531-540), `loadCharList` (:542-550), `loadCharacter` (:552-568),
  `saveToServer` (:570-608; PUT → при 404 POST), `flashSave` debounce 300мс (:610-614).
- Новый персонаж (:932-954): saveToServer → `collect()`, `data.name=""` → POST → id в
  `localStorage[LS_ID_KEY]` → `apply(data)` → loadCharList.
- Сброс (:908-915): confirm → удалить LS_ID_KEY + LS_SHEET_KEY → reload; БД не трогается.
- БД: `characters.sqlite3`, таблица `characters(id, name, data, created_at, updated_at)`.
- collect/apply — единые шлюзы сериализации (app.js:437-460 / 462-513).
- Чистый лист при первом старте: `addSkillRow(); addTalentRow(); addWeaponRow();`
  (app.js:993-997), xpTotal=400 (app.js:1000, index.html:88).

## Изменения (план)

- `app.js`:
  - новая функция пустого листа `emptySheetData()` — начальное состояние
    (xpTotal=400 + дефолт-строки умений/талантов/оружия), используется и «Новый персонаж»,
    и «Сброс», и init без сохранённого id;
  - «Новый персонаж» → POST с `emptySheetData()`, а не копией текущего;
  - `deleteCharacter(id)` → `fetch DELETE /api/characters/{id}`; кнопка «✖ Удалить»
    в тулбаре рядом с селектом; после удаления активного — чистый лист без сохранения;
  - «Сброс» → при наличии currentCharId DELETE записи + очистка LS_ID_KEY/LS_SHEET_KEY +
    reload; confirm-текст обновить;
  - `renderCharList()`: placeholder-опция добавляется только если персонажей 0.
- `index.html`: кнопка `#btn-delete-character`.
- `style.css`: печатные правила для шапки (без flex-сжатия/переноса, стабильные отступы),
  при необходимости page-break перед секциями; стиль кнопки удаления.
- server.py не меняется (DELETE уже готов).

## Проверки

- `node --check app.js && node --check data.js`
- curl-сценарий CRUD на порту 8123 (см. блок проверок выше), включая DELETE.
- Ручная: печать (шапка на месте), новый пустой лист, скрытие placeholder, удаление
  активного/неактивного, полный сброс (записи нет в БД).
- Финальный `@reviewer` (макс. 2 круга).
