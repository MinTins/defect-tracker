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
          { type: 'input', block_id: 'date', label: { type: 'plain_text', text: 'Дата звернення' }, element: { type: 'datepicker', action_id: 'date', initial_date: new Date().toISOString().split('T')[0] } },
          { type: 'input', block_id: 'order_num', label: { type: 'plain_text', text: '№ замовлення' }, element: { type: 'plain_text_input', action_id: 'order_num' } },
          { type: 'input', block_id: 'phone', label: { type: 'plain_text', text: 'Телефон клієнта' }, element: { type: 'plain_text_input', action_id: 'phone' } },
          { type: 'input', block_id: 'product', label: { type: 'plain_text', text: 'Назва товару (повна номенклатура)' }, element: { type: 'plain_text_input', action_id: 'product', multiline: false } },
          { type: 'input', block_id: 'lovespace_article', label: { type: 'plain_text', text: 'Артикул LOVESPACE' }, element: { type: 'plain_text_input', action_id: 'lovespace_article' }, optional: true },
          { type: 'input', block_id: 'supplier_article', label: { type: 'plain_text', text: 'Артикул постачальника' }, element: { type: 'plain_text_input', action_id: 'supplier_article' }, optional: true },
          { type: 'input', block_id: 'defect', label: { type: 'plain_text', text: 'Опис проблеми' }, element: { type: 'plain_text_input', action_id: 'defect', multiline: true } },
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
      manager:           meta.manager_name || payload.user.name,
      date:              formatDate(v.date.date.selected_date),
      phone:             v.phone.phone.value,
      order_num:         v.order_num.order_num.value,
      product:           v.product.product.value,
      lovespace_article: v.lovespace_article.lovespace_article.value || '',
      supplier_article:  v.supplier_article.supplier_article.value,
      defect:            v.defect.defect.value,
      timestamp:         new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    };

    let savedNumber;
    let messageText;
    appendToSheet(data).then(({ newNumber }) => {
      savedNumber = newNumber;
      // baseText — без статусу, статус додається окремо зверху
      messageText = `*Брак #${newNumber}* | ${data.date} | ${data.manager}\n*Замовл:* ${data.order_num} | *Тел:* ${data.phone}\n*Товар:* ${data.product}\n*Арт. LS:* ${data.lovespace_article || '—'} | *Арт. постач:* ${data.supplier_article || '—'}\n*Опис проблеми:* ${data.defect}`;
      return slackApi('chat.postMessage', {
        channel: channelId,
        text: `🔴 Брак #${newNumber}`,  // fallback
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: messageText }
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
      else {
        console.log('✅ Повідомлення відправлено, ts:', result.ts);
        // Зберігаємо ts для подальшого оновлення статусу
        messageMap.set(String(savedNumber), {
          channel: channelId,
          ts: result.ts,
          text: messageText
        });
        // Зберігаємо в Google Sheets для відновлення після перезапуску
        saveMessageToSheet(savedNumber, channelId, result.ts, messageText);
      }
    }).catch(err => console.error('❌ Помилка:', err.message));

  } else {
    res.status(200).send('');
  }
});

// ── 3. Запис у Google Sheets ─────────────────────────────────
async function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  return google.sheets({ version: 'v4', auth });
}

// ── Збереження/завантаження messageMap з Google Sheets ───────
const MSG_SHEET = '_bot_messages';

async function ensureMsgSheet(sheets) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.SPREADSHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === MSG_SHEET);
    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: process.env.SPREADSHEET_ID,
        resource: {
          requests: [{
            addSheet: { properties: { title: MSG_SHEET, hidden: true } }
          }]
        }
      });
      // Додаємо заголовки
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${MSG_SHEET}!A1:D1`,
        valueInputOption: 'RAW',
        resource: { values: [['number', 'channel', 'ts', 'text']] }
      });
      console.log('✅ Створено аркуш _bot_messages');
    }
  } catch (e) {
    console.error('❌ ensureMsgSheet error:', e.message);
  }
}

async function saveMessageToSheet(number, channel, ts, text) {
  try {
    const sheets = await getSheets();
    await ensureMsgSheet(sheets);
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${MSG_SHEET}!A:D`,
      valueInputOption: 'RAW',
      resource: { values: [[String(number), channel, ts, text]] }
    });
  } catch (e) {
    console.error('❌ saveMessageToSheet error:', e.message);
  }
}

async function loadMessageMap() {
  try {
    const sheets = await getSheets();
    await ensureMsgSheet(sheets);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SPREADSHEET_ID,
      range: `${MSG_SHEET}!A2:D`,
    });
    const rows = res.data.values || [];
    for (const [number, channel, ts, text] of rows) {
      if (number && channel && ts) {
        messageMap.set(number, { channel, ts, text: text || '' });
      }
    }
    console.log(`✅ Завантажено ${rows.length} повідомлень з Google Sheets`);
  } catch (e) {
    console.error('❌ loadMessageMap error:', e.message);
  }
}

async function appendToSheet(data) {
  const sheets = await getSheets();

  const getRows = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'БРАК!A:A',
  });

  const rows = getRows.data.values || [];

  // Знаходимо останній заповнений рядок
  let lastFilledRow = 1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i][0] && rows[i][0].toString().trim() !== '') {
      lastFilledRow = i + 1;
    }
  }

  const newRow = lastFilledRow + 1;
  const lastNumber = parseInt(rows[lastFilledRow - 1]?.[0]) || 0;
  const newNumber = lastNumber + 1;

  // Структура колонок:
  // A: № звернення  B: Менеджер  C: Дата  D: Телефон  E: № замовлення
  // F: Назва товару  G: Артикул LOVESPACE  H: (не чіпаємо — dropdown)
  // I: Артикул постач  J: Опис проблеми  K: Статус

  // Записуємо A-G окремо від I-K, щоб не чіпати H з dropdown
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `БРАК!A${newRow}:G${newRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [[
        newNumber,
        data.manager,
        data.date,
        data.phone,
        data.order_num,
        data.product,
        data.lovespace_article || '',
      ]]
    }
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `БРАК!I${newRow}:K${newRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [[
        data.supplier_article || '',
        data.defect,
        'Нова заявка',
      ]]
    }
  });

  // Копіюємо форматування з рядка 2
  const sheetId = 1385128494;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SPREADSHEET_ID,
    resource: {
      requests: [{
        copyPaste: {
          source: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 18 },
          destination: { sheetId, startRowIndex: newRow - 1, endRowIndex: newRow, startColumnIndex: 0, endColumnIndex: 18 },
          pasteType: 'PASTE_FORMAT'
        }
      }]
    }
  });

  console.log(`✅ Записано рядок ${newRow}, № звернення: ${newNumber}`);
  return { newNumber, newRow };
}

// ── 4. Webhook від Google Apps Script (зміна статусу) ────────
// ── Емодзі для статусів ──────────────────────────────────────
function statusEmoji(status) {
  const map = {
    'Нова заявка':                    '🔴',  // червоний
    'Очікуємо посилку від клієнта':   '🟣',  // фіолетовий
    'Отримали від клієнта':           '🔵',  // синій
    'Діагностика':                    '🟡',  // жовтий
    'Підтверджено':                   '🟢',  // зелений
    'Не підтверджено':                '🟠',  // помаранчевий
    'Відправили заміну':              '🟤',  // темно-зелений -> коричневий (найближче)
    'Кошти на баланс':                '💚',  // темно-зелений
  };
  return map[status] || '⚪';
}

// Зберігаємо map: номер звернення -> { channel, ts, baseText }
const messageMap = new Map();

app.post('/slack/status-update', async (req, res) => {
  res.status(200).send('ok');
  const { number, status } = req.body;
  console.log(`📊 Оновлення статусу: #${number} -> ${status}`);

  const msg = messageMap.get(String(number));
  if (!msg) {
    console.log(`ℹ️ Повідомлення для #${number} не знайдено в пам'яті`);
    return;
  }

  // Оновлюємо повідомлення в Slack — статус зверху з кольоровим емодзі
  const { channel, ts, text } = msg;
  const emoji = statusEmoji(status);
  await slackApi('chat.update', {
    channel,
    ts,
    text: `${emoji} Брак #${number}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `${emoji} ${text}` }
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
  }).then(r => {
    if (!r.ok) console.error('❌ chat.update error:', r.error);
    else console.log(`✅ Статус оновлено в Slack для #${number}`);
  });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`✅ Defect Tracker запущено на порту ${PORT}`);
  await loadMessageMap();
});
