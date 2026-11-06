# SESSION_CONTEXT — переход листа на макет «Досье Инквизиции»

_Сессия: 2026-11-06. Фаза: build. Статус: перенос начат заново с чистого `HEAD`; после обратной связи выравниваются отклонения от макета._

## Цель задачи

Заменить UI экрана листа персонажа на новый макет `design-preview.html` («Концепт —
Досье Инквизиции», коммит 6d475f5, в корне проекта). Внешний вид листа должен
полностью совпадать с макетом; элементов, которых в макете нет, быть не должно.
Экран входа/регистраци `#auth-screen` и серверную часть (`server.py`, SQLite,
`/api/auth/*`, CRUD `/api/characters`) оставить как есть. `data.js` не менять.

## Решения пользователя (обязательны)

1. **Авторизация**: экран входа/регистрации оставить; всё, чего нет в макете
   (XML-экспорт/импорт, сброс, тулбар и т.п.), убрать с экрана листа вместе с UI.
   Эти функции можно доделать позже (JS-код export/import можно оставить неиспользуемым,
   но обработчики на удалённые элементы снять).
2. **Листы**: переключение/создание/удаление привязать к существующему серверному CRUD
   и автосохранению (flashSave/saveToServer), демо-данные макета не использовать.
3. **Новые блоки**:
   - таланты — редактируемые на базе существующего `addTalentRow`, вид как `.talent-row` макета;
   - экипировка — урезанный вид текущих брони/оружия/имущества (#equipment: #gear-overview/
     #gear-management, setGearMode/renderGear, #gear-add-form), ПОЛНАЯ модель сохраняется в JSON
     даже без UI;
   - состояние (раны/судьба/усталость/безумие/порча/опыт) — существующие формулы источником;
   - пси-силы, мутации, заметки («Личное дело»/«Журнал заслуг») — СТАТИКА без
     добавления/сохранения (кнопки редактирования скрыть или disabled);
   - неизвестные мелочи — редактируемыми по образцу макета.
4. **Правила и данные текущего приложения — источник истины**: не переносить демо-массивы
   макета (skillCatalog/demoSkills/demoGear/demoPsyPowers/демо-листы) и захардкоженный
   2d10+20; селекты #creation наполнять из data.js (WORLDS/CAREERS/BIOGRAPHIES) и вешать
   существующие onCareerChange/onBioChange.

## Критичные технические ловушки

- **Потеря данных при удалении полей**: `collect()` (app.js:445) читает только DOM
  `[data-key]`. Поля, убранные со страницы (sex/quirks, arm-h..arm-rl, arm-ag,
  history/contacts/notes и пр.), должны либо остаться в скрытом контейнере, либо
  collect() должен мерджить их с последним загруженным снапшотом. То же для
  `emptySheetData()` (app.js:670) — новые ключи не терять.
- collect()/apply() — единый шлюз сериализации (localStorage `dh1e-current-id-v1`,
  `dh1e-sheet-v1`, миграция; серверные PUT/POST при 404). Не ломать контракт:
  `__skills`/`__talents`/`__weapons`/`bioId` + `[data-key]` поля.
- `apply()` вызывает `showCareerKit(false)` (app.js:518) — блок #career-kit уйдёт из
  разметки; ради перезаписи ранга оставить суть, но без панели.
- Таблицы #skills-tbody/#talents-tbody/#weapons-tbody используются collect()/apply()/
  buildHint/bioRows — структура строк документа выше (children[n]) должна сохраниться
  или аккуратно перебиндить индексы.
- `renderCharList`/`loadCharList`, `#char-list` → заменяется `#sheet-switcher`
  (change: saveToServer → loadCharacter, откат выбора при неудаче — app.js:1049-1062).
- `renderSheetBrief()` (макет) читает `.hero .meta`, `.badge`, стат-плитки, демо-массивы —
  перебиндить на реальные данные листа.

## Карта блоков макета (что рендерить чем)

- header `.top`: `.saved` (= #save-status), `#sheet-switcher`, печать (⎙ window.print),
  `addSheet()` (= POST emptySheetData), `deleteSheet()` (= deleteCharacter, confirm).
- `.layout > aside.side`: якоря #overview/#stats/#skills/#equipment/#notes + цитата.
- hero `#overview`: `#char-name`, `.meta` (badge «Аколит» + профессия · мир),
  `#char-rank`, возраст, `#char-status`, редактор `#profile-editor`
  (openProfileEdit/saveProfile — name/rank/age/status ← существующие data-keys name/rank/age).
- `#creation` (details.setup): 3 селекта мир/профессия/биография из data.js.
- `#stats`: 9 стат-плиток (значение+бонус+модификатор мира), только общая кнопка броска
  характеристик → rollAllChars (2d10+мод. мира из WORLDS), без отдельных бросков на плитках.
- `#skills`: обзор (skill-preview-basic/trained, `#skill-count`) / управление
  (`#skill-rows`, #skill-add-form c `#skill-add-name`/`#skill-add-level`/`#skill-message`)
  поверх существующих addSkillRow/calcSkillRow; уровни: basic/untrained/trained/mastery.
- `#talents`: `.talent-row` (имя + примечание).
- `#equipment`: грид-карточки `#gear-preview-list`, `#gear-count`, богатство/Троны как в макете,
  управление `#gear-rows` (name/type/stats), #gear-add-form.
- `#state-row`: степперы adjustState(wounds/fate/fatigue), метры #wounds-meter/#fate-meter,
  `#insanity-value`, `#corruption-value`, `#fatigue-value`, `#xp-available` + popover;
  панель `#state-editor` (saveState/rollMaxState → rollWounds/rollFate формулы мира).
- `#notes`/`#personal-note` и `#psy-card` (togglePsyForm/#psy-add-form), «Полевые заметки»,
  мутации — статика.
- `#generated-hint`: кнопка «↻ Обновить» → существующий buildHint → вывод в стиле
  #dossier-summary (5 секций: идентификация/характеристики/умения/таланты/арсенал).
- print-стили уже есть в макете (@media print, блок 139 mock.css) — взять его.

## Убрать со страницы листа (нет в макете)

Тулбар (export/import/reset/print-кнопка старая), #career-kit, поля sex/quirks,
#movement/#carry/#psy (derived-боксы), #btn-sanction, старые таблицы брони/оружия 9 колонок,
textarea history/contacts/notes (старый вид), #btn-hint — всё заменить разметкой макета,
данные сохранить (см. ловушки). Обработчики init() (app.js:998-1154) на removed ID снять.

## Стили

- Новый style.css = инлайн-CSS макета (26 блоков, 44.7KB — не редактировать вручную
  целиком, копи-паст из файла) + старые правила для `.auth-card`/auth-form (style.css:121-138)
  + `#save-status`-стиль под `.saved` + @page/print-адаптация (макетный @media print уже есть).
- Старые классы (toolbar/grid-4/tbl-chars/kit/hcards...) не нужны на листе, но auth
  экран их использует (btn/accent/muted) — базовые button/muted оставить.

## Порядок реализации

1. index.html: разметка = auth-screen (как есть) + скелет макета (body design-preview,
   без onclick-инлайнов — обработчики через app.js; dynamic контейнеры пустые).
2. style.css: CSS макета + auth + save-status + print правки.
3. app.js: перебиндить (см. карту); добавить glue: openProfileEdit/saveProfile,
   setSkillMode/renderSkills (2 режима), setGearMode/renderGear (name/type/stats ↔ модель),
    adjustState/метры/saveState/rollMaxState, XP popover, renderSheetSwitcher?,
   updateStatusMeters, брифер вместо buildHint-вывода (evaluate — можно оставить
   hcards-логику, вывод в brief-секции).
4. Проверки: node --check app.js && node --check data.js; py_compile server.py;
   python3 server.py --port 8123 → GET / (200, новая index) + CRUD curl; grep на
   удалённые ID; ручная проверка: вход, CRUD, автосохранение, migrate, биография-строки,
   печать, сверка с макетом таблица/боксы (через bio_check.py Selenium — устарел, аккуратно).

## Статус (что сделано в сессии)

- Неудачные незакоммиченные изменения `app.js`, `index.html`, `style.css` отброшены по запросу;
  ветка `main` и подтянутые коммиты оставлены. Новая реализация начата с чистого `HEAD` `b370379`.
- `index.html` и `style.css` переведены на структуру и стили `design-preview.html`, без демо-листов
  и вымышленных записей. Экран авторизации сохранён; старые XML/reset controls удалены из UI.
- `app.js`: существующие правила `data.js`, авторизация, CRUD, автосохранение и сериализация
  сохранены; добавлены переключение/создание/удаление листов, редактируемые навыки/таланты,
  краткая экипировка, блок состояния и сводка по листу.
- По последней обратной связи убраны отдельные кнопки броска и редактирования с плиток
  характеристик, оставлен только общий бросок; выбор мира/класса раскрыт сразу. Богатство
  возвращено в экипировку, опыт остаётся в состоянии листа. Таланты получили отдельный режим
  управления через «Таланты →», как у навыков; старое снаряжение теперь редактируется в арсенале.
- Добавлены `status`, `woundsCurrent`, `fatigueCurrent`, `__gearItems`, `__gearMigrated`,
  `__statsRaw`, `dossier`, `meritNotes`, `fieldNotes`. Для старых листов текущие раны берутся
  из `wounds`, усталость — 0; старые значения характеристик переводятся в raw-roll, чтобы
  модификатор мира применялся отдельно. `player`/`history`/`contacts`/`notes` удаляются
  из загрузки/импорта/следующего сохранения.
- Заметки «Личное дело», «Журнал заслуг» и «Полевые заметки» редактируются отдельными
  карандашами, сохраняются в JSON/БД и отображаются с макетным line-clamp и «Подробнее».
- Для широких шапок зафиксировано вертикальное выравнивание ссылок; раздел происхождения
  остаётся в трёх колонках, длинное описание биографии ограничено тремя строками, а `apply()`
  сбрасывает биографию перед загрузкой каждого листа. Удаление очищает ключи кэша, выбирает
  последний лист или создаёт пустой, если удалён последний.
- Проверено: `node --check app.js`, `node --check data.js`, `py -m py_compile server.py`,
  `git diff --check`, GET `/` → 200. Браузерный smoke test прошёл на имитации API CRUD, включая
  raw-roll миграцию, добавление редактируемых талантов/арсенала и сохранение заметок;
  консоль показала только ожидаемый 401 для неавторизованного `/api/auth/session`.
- Ещё не выполнена ручная проверка с реальным аккаунтом/SQLite и полная визуальная
  сверка на целевых размерах экрана. Текущие изменения незакоммичены.
