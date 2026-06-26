const express = require('express');
const crypto = require('crypto');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

// ── Парсинг тіла запиту ──────────────────────────────────────
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('✅ Defect Tracker працює!');
});

// ── Верифікація підпису Slack ────────────────────────────────
function verifySlackRequest(req) {
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];
  const body = req.rawBody || '';

  const sigBaseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac('sha256', process.env.SLACK_SIGNING_SECRET);
  hmac.update(sigBaseString);
  const computedSig = `v0=${hmac.digest('hex')}`;

  return crypto.timingSafeEqual(
    Buffer.from(computedSig),
    Buffer.from(signature || '')
  );
}

// ── Middleware для збереження raw body ───────────────────────
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    next();
  });
});

// ── Допоміжні функції ────────────────────────────────────────
async function slackApi(method, body, token) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Authorization': `Bearer ${token}`
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

// ── Модальна форма ───────────────────────────────────────────
const modalView = {
  type: 'modal',
  callback_id: 'defect_form',
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
};

// ── 1. Обробка команди /create ───────────────────────────────
app.post('/slack/commands', async (req, res) => {
  console.log('📩 Отримано команду /create');
  res.status(200).send('');

  try {
    const { trigger_id, channel_id } = req.body;
    const view = { ...modalView, private_metadata: channel_id };

    const result = await slackApi('views.open', {
      trigger_id,
      view
    }, process.env.SLACK_BOT_TOKEN);

    console.log('Modal result:', JSON.stringify(result));
  } catch (error) {
    console.error('❌ Помилка /create:', error.message);
  }
});

// ── 2. Обробка інтерактивних подій (форма) ───────────────────
app.post('/slack/interactions', async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  console.log('📋 Отримано interaction:', payload.type);

  if (payload.type === 'view_submission' && payload.view.callback_id === 'defect_form') {
    res.status(200).json({ response_action: 'clear' });

    try {
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

      // Повідомлення в Slack
      await slackApi('chat.postMessage', {
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
      }, process.env.SLACK_BOT_TOKEN);

      // Запис у Google Sheets
      await appendToSheet(data);
      console.log('✅ Все записано успішно');

    } catch (error) {
      console.error('❌ Помилка обробки форми:', error.message);
    }
  } else {
    res.status(200).send('');
  }
});

// ── 3. Запис у Google Sheets ─────────────────────────────────
async function appendToSheet(data) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
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
