// ── Google Apps Script для синхронізації з Slack ─────────────
// 1. Вставити в Google Apps Script (Extensions -> Apps Script)
// 2. Запустити функцію createTrigger() ОДИН РАЗ

const WEBHOOK_URL = 'https://zucchini-unity-production-0cd9.up.railway.app/slack/row-update';
const SHEET_NAME = 'БРАК';

const COLS = {
  NUMBER:        1,
  MANAGER:       2,
  DATE:          3,
  PHONE:         4,
  ORDER:         5,
  PRODUCT:       6,
  ART_LS:        7,
  SUPPLIER:      8,
  ART_SUPPLIER:  9,
  DEFECT:       10,
  STATUS:       11,
  DATE_SENT_BY: 12,
  TTN_CLIENT:   13,
  DATE_RECEIVED:14,
  DATE_SENT_TO: 15,
  TTN_SUPPLIER: 16,
  DATE_RETURNED:17,
  TTN_RETURN:   18,
  COMMENT:      19,
};

function createTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onChange()
    .create();
  console.log('✅ Тригери встановлено');
}

function getRowNumbers() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME);
  if (!sheet) return [];
  const values = sheet.getRange('A2:A').getValues();
  return values
    .map(r => String(r[0]).trim())
    .filter(v => v !== '' && v !== '0');
}

function onSheetChange(e) {
  try {
    if (e.changeType !== 'REMOVE_ROW') return;
    const currentNumbers = new Set(getRowNumbers());
    const props = PropertiesService.getScriptProperties();
    const savedRaw = props.getProperty('row_numbers');
    if (!savedRaw) return;
    const savedNumbers = JSON.parse(savedRaw);
    const deleted = savedNumbers.filter(n => !currentNumbers.has(n));
    if (deleted.length === 0) return;
    deleted.forEach(number => {
      UrlFetchApp.fetch(WEBHOOK_URL.replace('row-update', 'row-delete'), {
        method: 'POST',
        contentType: 'application/json',
        payload: JSON.stringify({ number }),
        muteHttpExceptions: true
      });
    });
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
    const col = e.range.getColumn(); // ← визначаємо col тут
    if (row < 2) return;

    const number = sheet.getRange(row, COLS.NUMBER).getValue();
    if (!number) return;

    const rowData = sheet.getRange(row, 1, 1, 19).getValues()[0];

    const payload = {
      number:        String(number),
      statusChanged: col === COLS.STATUS, // тепер col визначено
      manager:       rowData[COLS.MANAGER - 1] || '',
      date:          formatDate(rowData[COLS.DATE - 1]),
      phone:         String(rowData[COLS.PHONE - 1] || ''),
      order:         String(rowData[COLS.ORDER - 1] || ''),
      product:       rowData[COLS.PRODUCT - 1] || '',
      art_ls:        rowData[COLS.ART_LS - 1] || '',
      supplier:      rowData[COLS.SUPPLIER - 1] || '',
      art_supplier:  rowData[COLS.ART_SUPPLIER - 1] || '',
      defect:        rowData[COLS.DEFECT - 1] || '',
      status:        rowData[COLS.STATUS - 1] || '',
      date_sent_by:  formatDate(rowData[COLS.DATE_SENT_BY - 1]),
      ttn_client:    String(rowData[COLS.TTN_CLIENT - 1] || ''),
      date_received: formatDate(rowData[COLS.DATE_RECEIVED - 1]),
      date_sent_to:  formatDate(rowData[COLS.DATE_SENT_TO - 1]),
      ttn_supplier:  String(rowData[COLS.TTN_SUPPLIER - 1] || ''),
      date_returned: formatDate(rowData[COLS.DATE_RETURNED - 1]),
      ttn_return:    String(rowData[COLS.TTN_RETURN - 1] || ''),
      comment:       rowData[COLS.COMMENT - 1] || '',
    };

    UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

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
