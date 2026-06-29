// ── Google Apps Script для синхронізації з Slack ─────────────
// 1. Вставити в Google Apps Script (Extensions -> Apps Script)
// 2. Запустити функцію createTrigger() ОДИН РАЗ

const WEBHOOK_URL = 'https://zucchini-unity-production-0cd9.up.railway.app/slack/row-update';
const SHEET_NAME = 'БРАК';

// Індекси колонок (з 1)
const COLS = {
  NUMBER:           1,  // A: № звернення
  MANAGER:          2,  // B: Менеджер(-ка)
  DATE:             3,  // C: Дата звернення
  PHONE:            4,  // D: Телефон клієнта
  ORDER:            5,  // E: № замовлення
  PRODUCT:          6,  // F: Назва товару
  ART_LS:           7,  // G: Артикул LOVESPACE
  SUPPLIER:         8,  // H: Постачальник
  ART_SUPPLIER:     9,  // I: Артикул постачальника
  DEFECT:          10,  // J: Опис дефекту
  STATUS:          11,  // K: Статус
  DATE_SENT_BY:    12,  // L: Дата відправки клієнтом
  TTN_CLIENT:      13,  // M: ТТН клієнта
  DATE_RECEIVED:   14,  // N: Дата отримання нами
  DATE_SENT_TO:    15,  // O: Дата відправки постачальнику
  TTN_SUPPLIER:    16,  // P: ТТН відправки постачальнику
  DATE_RETURNED:   17,  // Q: Дата відправки клієнту/повернення коштів
  TTN_RETURN:      18,  // R: ТТН відправки клієнту
  COMMENT:         19,  // S: Коментар
};

function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  // Тригер для змін значень (onEdit)
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  // Тригер для структурних змін (видалення рядків)
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();

  console.log('✅ Тригери встановлено');
}

// Зберігаємо стан рядків перед змінами
function getRowNumbers() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return [];
  const values = sheet.getRange('A2:A').getValues();
  return values
    .map(r => String(r[0]).trim())
    .filter(v => v !== '' && v !== '0');
}

// Викликається при структурних змінах (видалення/додавання рядків)
function onSheetChange(e) {
  try {
    if (e.changeType !== 'REMOVE_ROW') return;

    // Отримуємо поточні номери в таблиці
    const currentNumbers = new Set(getRowNumbers());

    // Отримуємо збережені номери з PropertiesService
    const props = PropertiesService.getScriptProperties();
    const savedRaw = props.getProperty('row_numbers');
    if (!savedRaw) return;

    const savedNumbers = JSON.parse(savedRaw);

    // Знаходимо видалені номери
    const deleted = savedNumbers.filter(n => !currentNumbers.has(n));

    if (deleted.length === 0) return;

    console.log('Видалені рядки:', deleted);

    // Відправляємо webhook для кожного видаленого рядка
    deleted.forEach(number => {
      UrlFetchApp.fetch(WEBHOOK_URL.replace('row-update', 'row-delete'), {
        method: 'POST',
        contentType: 'application/json',
        payload: JSON.stringify({ number }),
        muteHttpExceptions: true
      });
    });

    // Оновлюємо збережений стан
    props.setProperty('row_numbers', JSON.stringify([...currentNumbers]));

  } catch (err) {
    console.error('onSheetChange помилка:', err.message);
  }
}

function onSheetEdit(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAME) return;

    const row = e.range.getRow();
    if (row < 2) return; // пропускаємо заголовок

    const number = sheet.getRange(row, COLS.NUMBER).getValue();
    if (!number) return;

    // Читаємо весь рядок
    const rowData = sheet.getRange(row, 1, 1, 19).getValues()[0];

    const payload = {
      number: String(number),
      statusChanged: col === COLS.STATUS, // чи змінився саме статус
      manager:      rowData[COLS.MANAGER - 1] || '',
      date:         formatDate(rowData[COLS.DATE - 1]),
      phone:        String(rowData[COLS.PHONE - 1] || ''),
      order:        String(rowData[COLS.ORDER - 1] || ''),
      product:      rowData[COLS.PRODUCT - 1] || '',
      art_ls:       rowData[COLS.ART_LS - 1] || '',
      supplier:     rowData[COLS.SUPPLIER - 1] || '',
      art_supplier: rowData[COLS.ART_SUPPLIER - 1] || '',
      defect:       rowData[COLS.DEFECT - 1] || '',
      status:       rowData[COLS.STATUS - 1] || '',
      date_sent_by: formatDate(rowData[COLS.DATE_SENT_BY - 1]),
      ttn_client:   String(rowData[COLS.TTN_CLIENT - 1] || ''),
      date_received:formatDate(rowData[COLS.DATE_RECEIVED - 1]),
      date_sent_to: formatDate(rowData[COLS.DATE_SENT_TO - 1]),
      ttn_supplier: String(rowData[COLS.TTN_SUPPLIER - 1] || ''),
      date_returned:formatDate(rowData[COLS.DATE_RETURNED - 1]),
      ttn_return:   String(rowData[COLS.TTN_RETURN - 1] || ''),
      comment:      rowData[COLS.COMMENT - 1] || '',
    };

    UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    // Зберігаємо поточні номери рядків для відстеження видалень
    const props = PropertiesService.getScriptProperties();
    props.setProperty('row_numbers', JSON.stringify(getRowNumbers()));

  } catch (err) {
    console.error('Помилка:', err.message);
  }
}

function formatDate(val) {
  if (!val) return '';
  if (val instanceof Date) {
    const d = val.getDate().toString().padStart(2, '0');
    const m = (val.getMonth() + 1).toString().padStart(2, '0');
    const y = val.getFullYear();
    return `${d}.${m}.${y}`;
  }
  return String(val);
}
