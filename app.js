const { App } = require('@slack/bolt');
const { google } = require('googleapis');
require('dotenv').config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  port: process.env.PORT || 3000
});

// ── Допоміжна функція для створення поля форми ──────────────
function inputBlock(blockId, label, type = 'plain_text_input', multiline = false) {
  let element;
  if (type === 'datepicker') {
    element = { type: 'datepicker', action_id: blockId };
  } else {
    element = { type: 'plain_text_input', action_id: blockId, multiline };
  }
  return {
    type: 'input',
    block_id: blockId,
    label: { type: 'plain_text', text: label },
    element
  };
}

// ── Секція для повідомлення в Slack ─────────────────────────
function sectionField(label, value) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${label}:*\n${value || '—'}` }
  };
}

// ── 1. Обробка команди /create ───────────────────────────────
app.command('/create', async ({ ack, body, client, logger }) => {
  await ack();
  try {
    await client.views.open({
      trigger_id: body.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'defect_form',
        private_metadata: body.channel_id,
        title: { type: 'plain_text', text: 'Новий брак' },
        submit: { type: 'plain_text', text: 'Відправити' },
        close: { type: 'plain_text', text: 'Скасувати' },
        blocks: [
          inputBlock('manager', 'Менеджер(-ка)'),
          inputBlock('date', 'Дата звернення', 'datepicker'),
          inputBlock('phone', 'Телефон клієнта'),
          inputBlock('order_num', '№ замовлення'),
          inputBlock('product', 'Назва товару (повна номенклатура + наш артикул)', 'plain_text_input', true),
          inputBlock('supplier_article', 'Артикул постачальника'),
          inputBlock('defect', 'Опис дефекту', 'plain_text_input', true),
        ]
      }
    });
  } catch (error) {
    logger.error(error);
  }
});

// ── 2. Обробка відправки форми ───────────────────────────────
app.view('defect_form', async ({ ack, body, view, client, logger }) => {
  await ack();
  try {
    const v = view.state.values;
    const channelId = view.private_metadata;

    const data = {
      manager:          v.manager.manager.value,
      date:             v.date.date.selected_date,
      phone:            v.phone.phone.value,
      order_num:        v.order_num.order_num.value,
      product:          v.product.product.value,
      supplier_article: v.supplier_article.supplier_article.value,
      defect:           v.defect.defect.value,
      submitted_by:     body.user.name,
      timestamp:        new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    };

    // Відправка повідомлення в Slack
    await client.chat.postMessage({
      channel: channelId,
      text: '🔴 Новий брак зафіксовано',
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: '🔴 Новий брак зафіксовано' }
        },
        sectionField('👤 Менеджер(-ка)', data.manager),
        sectionField('📅 Дата звернення', data.date),
        sectionField('📞 Телефон клієнта', data.phone),
        sectionField('🧾 № замовлення', data.order_num),
        sectionField('📦 Назва товару', data.product),
        sectionField('🏷️ Артикул постачальника', data.supplier_article),
        sectionField('⚠️ Опис дефекту', data.defect),
        { type: 'divider' },
        {
          type: 'context',
          elements: [{
            type: 'mrkdwn',
            text: `Заповнив(ла): @${data.submitted_by} · ${data.timestamp}`
          }]
        }
      ]
    });

    // Запис у Google Sheets
    await appendToSheet(data);
    logger.info('✅ Дані успішно записані в Google Sheets');

  } catch (error) {
    logger.error('❌ Помилка:', error);
  }
});

// ── 3. Запис у Google Sheets ─────────────────────────────────
// Структура аркуша БРАК:
// A: № звернення  B: Менеджер(-ка)  C: Дата звернення  D: Телефон клієнта
// E: № замовлення  F: Назва товару  G: (порожня)  H: Артикул постачальника
// I: Опис дефекту  J: Статус  ...

async function appendToSheet(data) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // Отримуємо кількість рядків щоб визначити № звернення
  const getRows = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'БРАК!A:A',
  });

  const existingRows = getRows.data.values ? getRows.data.values.length : 1;
  const newNumber = existingRows; // рядок 1 — заголовок, тому № = кількість рядків

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'БРАК!A:I',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        newNumber,        // A: № звернення
        data.manager,     // B: Менеджер(-ка)
        data.date,        // C: Дата звернення
        data.phone,       // D: Телефон клієнта
        data.order_num,   // E: № замовлення
        data.product,     // F: Назва товару
        '',               // G: порожня колонка
        data.supplier_article, // H: Артикул постачальника
        data.defect,      // I: Опис дефекту
      ]]
    }
  });
}

// ── Запуск ───────────────────────────────────────────────────
(async () => {
  await app.start();
  console.log('✅ Defect Tracker запущено на порту', process.env.PORT || 3000);
})();
