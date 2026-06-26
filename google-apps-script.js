// ── Google Apps Script для синхронізації статусу ─────────────
// Вставити в Google Apps Script (script.google.com)
// Прив'язати до таблиці через тригер onEdit

const WEBHOOK_URL = 'https://zucchini-unity-production-0cd9.up.railway.app:8080/slack/status-update';
const SHEET_NAME = 'БРАК';
const NUMBER_COL = 1;  // A: № звернення
const STATUS_COL = 11; // K: Статус

function onEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== SHEET_NAME) return;

  const row = e.range.getRow();
  const col = e.range.getColumn();

  // Реагуємо тільки на зміну колонки K (Статус)
  if (col !== STATUS_COL) return;
  if (row < 2) return; // пропускаємо заголовок

  const number = sheet.getRange(row, NUMBER_COL).getValue();
  const status = e.value;

  if (!number || !status) return;

  console.log(`Статус змінено: #${number} -> ${status}`);

  // Відправляємо webhook на наш сервер
  const payload = JSON.stringify({ number: String(number), status });

  UrlFetchApp.fetch(WEBHOOK_URL, {
    method: 'POST',
    contentType: 'application/json',
    payload,
    muteHttpExceptions: true
  });
}
