const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// ── Парсинг тіла запиту ──────────────────────────────────────
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    if (req.headers['content-type']?.includes('application/json')) {
      try { req.body = JSON.parse(data); } catch(e) { req.body = {}; }
    } else if (req.headers['content-type']?.includes('urlencoded')) {
      req.body = Object.fromEntries(new URLSearchParams(data));
    }
    next();
  });
});

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('✅ Defect Tracker працює!');
});

// ── Допоміжні функції ────────────────────────────────────────
async function slackApi(method, body) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify(body)
  });
  return response.json();
}

function sectionField(label, value) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${label}:*\n${value || '—'}` }
  };
}

// ── 1. Команда /create ───────────────────────────────────────
app.post('/slack/commands', (req, res) => {
  // Відповідаємо Slack ОДРАЗУ — до будь-яких await
  res.status(200).send('');
  console.log('📩 Команда отримана, відповідь відправлена');

  // Все інше робимо асинхронно після відповіді
  const { trigger_id, channel_id } = req.body;

  slackApi('views.open', {
    trigger_id,
    view: {
      type: 'modal',
      callback_id: 'defect_form',
      private_metadata: channel_id,
      title: { type: 'plain_text', text: 'Новий брак' },
      submit: { type: 'plain_text', text: 'Відправити' },
      close: { type: 'plain_text', text: 'Скасувати' },
      blocks: [
        { type: 'input', block_id: 'manager', label: { type: 'plain_text', text: 'Менеджер(-ка)' }, element: { type: 'plain_text_input', action_id: 'manager' } },
        { type: 'input', block_id: 'date', label: { type: 'plain_text', text: 'Дата звернення' }, element: { type: 'datepicker', action_id: 'date' } },
        { type: 'input', block_id: 'phone', label: { type: 'plain_text', text: 'Телефон клієнта' }, element: { type: 'plain_text_input', action_id: 'phone' } },
        { type: 'input', block_id: 'order_num', label: { type: 'plain_text', text: '№ замовлення' }, element: { type: 'plain_text_input', action_id: 'order_num' } },
        { type: 'input', block_id: 'product', label: { type: 'plain_text', text: 'Назва товару (повна номенклатура + наш артикул)' }, element: { type: 'plain_text_input', action_id: 'product', multiline: true } },
        { type: 'input', block_id: 'supplier_article', label: { type: 'plain_text', text: 'Артикул постачальника' }, element: { type: 'plain_text_input', action_id: 'supplier_article' } },
        { type: 'input', block_id: 'defect', label: { type: 'plain_text', text: 'Опис дефекту' }, element: { type: 'plain_text_input', action_id: 'defect', multiline: true } },
      ]
    }
  }).then(result => {
    console.log('Modal result:', JSON.stringify(result));
  }).catch(err => {
    console.error('❌ Помилка відкриття modal:', err.message);
  });
});

// ── 2. Обробка відправки форми ───────────────────────────────
app.post('/slack/interactions', (req, res) => {
  const payload = JSON.parse(req.body.payload);
  console.log('📋 Interaction type:', payload.type);

  if (payload.type === 'view_submission' && payload.view.callback_id === 'defect_form') {
    // Відповідаємо ОДРАЗУ
    res.status(200).json({ response_action: 'clear' });

    // Обробляємо асинхронно
    const v = payload.view.state.values;
    const channelId = payload.view.private_metadata;

    const data = {
      manager:          v.manager.manager.value,
      date:             v.date.date.selected_date,
      phone:            v.phone.phone.value,
      order_num:        v.order_num.order_num.value,
      product:          v.product.product.value,
      supplier_article: v.supplier_article.supplier_article.value,
      defect:           v.defect.defect.value,
      submitted_by:     payload.user.name,
      timestamp:        new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    };

    // Надсилаємо повідомлення в Slack
    slackApi('chat.postMessage', {
      channel: channelId,
      text: '🔴 Новий брак зафіксовано',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: '🔴 Новий брак зафіксовано' } },
        sectionField('👤 Менеджер(-ка)', data.manager),
        sectionField('📅 Дата звернення', data.date),
        sectionField('📞 Телефон клієнта', data.phone),
        sectionField('🧾 № замовлення', data.order_num),
        sectionField('📦 Назва товару', data.product),
        sectionField('🏷️ Артикул постачальника', data.supplier_article),
        sectionField('⚠️ Опис дефекту', data.defect),
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: `Заповнив(ла): @${data.submitted_by} · ${data.timestamp}` }] }
      ]
    }).then(() => {
      console.log('✅ Повідомлення відправлено в Slack');
      return appendToSheet(data);
    }).then(() => {
      console.log('✅ Записано в Google Sheets');
    }).catch(err => {
      console.error('❌ Помилка:', err.message);
    });

  } else {
    res.status(200).send('');
  }
});

// ── 3. Запис у Google Sheets ─────────────────────────────────
async function appendToSheet(data) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const getRows = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'БРАК!A:A',
  });

  const existingRows = getRows.data.values ? getRows.data.values.length : 1;

  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'БРАК!A:I',
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        existingRows,
        data.manager,
        data.date,
        data.phone,
        data.order_num,
        data.product,
        '',
        data.supplier_article,
        data.defect,
      ]]
    }
  });
}

// ── Запуск ───────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`✅ Defect Tracker запущено на порту ${PORT}`);
});
