// ── Google Apps Script для синхронізації статусу ─────────────
// 1. Вставити в Google Apps Script (Extensions -> Apps Script)
// 2. Запустити функцію createTrigger() ОДИН РАЗ щоб встановити тригер
// 3. Більше нічого не запускати вручну

const WEBHOOK_URL = 'https://zucchini-unity-production-0cd9.up.railway.app:8080/slack/status-update';
const SHEET_NAME = 'БРАК';
const NUMBER_COL = 1;  // A: № звернення
const STATUS_COL = 11; // K: Статус

// Запусти цю функцію ОДИН РАЗ для встановлення тригера
function createTrigger() {
  // Видаляємо старі тригери щоб не дублювались
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  
  // Створюємо installable тригер
  ScriptApp.newTrigger('onSheetEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();
  
  console.log('✅ Тригер встановлено');
}

// Ця функція викликається автоматично при редагуванні
function onSheetEdit(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAME) return;

    const row = e.range.getRow();
    const col = e.range.getColumn();

    // Реагуємо тільки на зміну колонки K (Статус)
    if (col !== STATUS_COL) return;
    if (row < 2) return;

    const number = sheet.getRange(row, NUMBER_COL).getValue();
    const status = e.value;

    if (!number || !status) return;

    console.log(`Статус змінено: #${number} -> ${status}`);

    const payload = JSON.stringify({ number: String(number), status });

    const response = UrlFetchApp.fetch(WEBHOOK_URL, {
      method: 'POST',
      contentType: 'application/json',
      payload,
      muteHttpExceptions: true
    });

    console.log('Webhook response:', response.getContentText());

  } catch (err) {
    console.error('Помилка:', err.message);
  }
}
