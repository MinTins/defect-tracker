const express = require('express');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();

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

app.get('/', (req, res) => res.send('✅ Defect Tracker працює!'));

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

async function slackApiGet(method, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const response = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` }
  });
  return response.json();
}

async function getSlackUserName(userId) {
  try {
    const result = await slackApiGet('users.info', { user: userId });
    if (result.ok) {
      return result.user.profile.real_name || result.user.real_name || result.user.name;
    }
  } catch (e) {
    console.error('❌ Помилка отримання імені:', e.message);
  }
  return null;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

// ── 1. Команда /create ───────────────────────────────────────
app.post('/slack/commands', (req, res) => {
  res.status(200).send('');

  const { trigger_id, channel_id, user_id } = req.body;

  getSlackUserName(user_id).then(fullName => {
    return slackApi('views.open', {
      trigger_id,
      view: {
        type: 'modal',
        callback_id: 'defect_form',
        private_metadata: JSON.stringify({ channel_id, manager_name: fullName }),
        title: { type: 'plain_text', text: 'Новий брак' },
        submit: { type: 'plain_text', text: 'Відправити' },
        close: { type: 'plain_text', text: 'Скасувати' },
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `👤 *Менеджер(-ка):* ${fullName || 'невідомо'}` } },
          { type: 'input', block_id: 'date', label: { type: 'plain_text', text: 'Дата звернення' }, element: { type: 'datepicker', action_id: 'date' } },
          { type: 'input', block_id: 'phone', label: { type: 'plain_text', text: 'Телефон клієнта' }, element: { type: 'plain_text_input', action_id: 'phone' } },
          { type: 'input', block_id: 'order_num', label: { type: 'plain_text', text: '№ замовлення' }, element: { type: 'plain_text_input', action_id: 'order_num' } },
          { type: 'input', block_id: 'product', label: { type: 'plain_text', text: 'Назва товару (повна номенклатура + наш артикул)' }, element: { type: 'plain_text_input', action_id: 'product', multiline: true } },
          { type: 'input', block_id: 'supplier_article', label: { type: 'plain_text', text: 'Артикул постачальника' }, element: { type: 'plain_text_input', action_id: 'supplier_article' } },
          { type: 'input', block_id: 'defect', label: { type: 'plain_text', text: 'Опис дефекту' }, element: { type: 'plain_text_input', action_id: 'defect', multiline: true } },
        ]
      }
    });
  }).then(result => {
    if (!result.ok) console.error('❌ Modal error:', result.error);
  }).catch(err => console.error('❌ Помилка:', err.message));
});

// ── 2. Обробка форми та кнопок ───────────────────────────────
app.post('/slack/interactions', (req, res) => {
  const payload = JSON.parse(req.body.payload);

  // Кнопка "Видалити"
  if (payload.type === 'block_actions') {
    const action = payload.actions[0];
    if (action.action_id === 'delete_message') {
      res.status(200).send('');
      slackApi('chat.delete', {
        channel: payload.channel.id,
        ts: payload.message.ts
      }).then(result => {
        if (!result.ok) console.error('❌ delete error:', result.error);
        else console.log('✅ Повідомлення видалено');
      });
    } else {
      res.status(200).send('');
    }
    return;
  }

  // Відправка форми
  if (payload.type === 'view_submission' && payload.view.callback_id === 'defect_form') {
    res.status(200).json({ response_action: 'clear' });

    const v = payload.view.state.values;
    const meta = JSON.parse(payload.view.private_metadata);
    const channelId = meta.channel_id;

    const data = {
      manager:          meta.manager_name || payload.user.name,
      date:             formatDate(v.date.date.selected_date),
      phone:            v.phone.phone.value,
      order_num:        v.order_num.order_num.value,
      product:          v.product.product.value,
      supplier_article: v.supplier_article.supplier_article.value,
      defect:           v.defect.defect.value,
      timestamp:        new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    };

    appendToSheet(data).then(newNumber => {
      return slackApi('chat.postMessage', {
        channel: channelId,
        text: `🔴 Брак #${newNumber}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `🔴 *Брак #${newNumber}* | ${data.date} | ${data.manager}\n*Тел:* ${data.phone} | *Замовл:* ${data.order_num}\n*Товар:* ${data.product}\n*Артикул постач:* ${data.supplier_article}\n*Дефект:* ${data.defect}`
            }
          },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: '🗑 Видалити' },
              style: 'danger',
              action_id: 'delete_message',
              confirm: {
                title: { type: 'plain_text', text: 'Видалити повідомлення?' },
                text: { type: 'plain_text', text: 'Запис в таблиці залишиться.' },
                confirm: { type: 'plain_text', text: 'Видалити' },
                deny: { type: 'plain_text', text: 'Скасувати' }
              }
            }]
          }
        ]
      });
    }).then(result => {
      if (!result.ok) console.error('❌ postMessage error:', result.error);
      else console.log('✅ Повідомлення відправлено, ts:', result.ts);
    }).catch(err => console.error('❌ Помилка:', err.message));

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

  const rows = getRows.data.values || [];
  let firstEmptyRow = rows.length + 1;
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || rows[i][0].toString().trim() === '') {
      firstEmptyRow = i + 1;
      break;
    }
  }

  const newNumber = firstEmptyRow - 1;

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `БРАК!A${firstEmptyRow}:J${firstEmptyRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [[
        newNumber, data.manager, data.date, data.phone,
        data.order_num, data.product, '', data.supplier_article,
        data.defect, 'Нова заявка',
      ]]
    }
  });

  const sheetId = 1385128494;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SPREADSHEET_ID,
    resource: {
      requests: [{
        copyPaste: {
          source: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 18 },
          destination: { sheetId, startRowIndex: firstEmptyRow - 1, endRowIndex: firstEmptyRow, startColumnIndex: 0, endColumnIndex: 18 },
          pasteType: 'PASTE_FORMAT'
        }
      }]
    }
  });

  console.log(`✅ Записано рядок ${firstEmptyRow}, № ${newNumber}`);
  return newNumber;
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Defect Tracker запущено на порту ${PORT}`));
