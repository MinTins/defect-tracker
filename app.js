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

function statusEmoji(status) {
  const map = {
    'Нова заявка':                    '⚪',
    'Очікуємо посилку від клієнта':   '🟣',
    'Отримали від клієнта':           '🔵',
    'Діагностика':                    '🟡',
    'Підтверджено':                   '🟢',
    'Не підтверджено':                '🟠',
    'Відправили заміну':              '🟤',
    'Кошти на баланс':                '🔵',
  };
  return map[status] || '⚪';
}

function formatStatus(status) {
  return status; // used only in fallback text
}


function buildStatusBlock(emoji, status) {
  return {
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: emoji + ' ' },
        { type: 'text', text: '[' + status + ']', style: { code: true, underline: true } }
      ]
    }]
  };
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  if (!year || !month || !day) return dateStr;
  return `${day}.${month}.${year}`;
}



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
      defect:            v.defect.defect.value,
      timestamp:         new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    };

    let savedNumber;
    let messageText;
    appendToSheet(data).then(({ newNumber }) => {
      savedNumber = newNumber;
      // baseText — без статусу і емодзі, вони додаються при оновленні
      messageText = `*Брак #${newNumber}* | ${data.date} | *${data.manager}* | Замовл: *${data.order_num}* | Тел: ${data.phone}\n*Товар:* _${data.product}_ (${data.lovespace_article || '—'})\n*Проблема:* _${data.defect}_`;
      const initialStatus = 'Нова заявка';
      const initialEmoji = statusEmoji(initialStatus);
      // Повний текст: статус зверху, потім опис
      const fullText = `${initialEmoji} ${formatStatus(initialStatus)}\n${messageText}`;
      return slackApi('chat.postMessage', {
        channel: channelId,
        text: `${initialEmoji} [${initialStatus}] Брак #${newNumber}`,
        blocks: [
          buildStatusBlock(initialEmoji, initialStatus),
          { type: 'section', text: { type: 'mrkdwn', text: messageText } },
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
  // H: Постачальник (не чіпаємо)  I: Артикул постачальника (не чіпаємо)
  // J: Опис дефекту  K: Статус

  // Записуємо A-G, потім J-K (H і I не чіпаємо)
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
    range: `БРАК!J${newRow}:K${newRow}`,
    valueInputOption: 'RAW',
    resource: {
      values: [[
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

// ── 4. Webhook від Google Apps Script (оновлення рядка) ─────
// Зберігаємо map: номер -> { channel, ts }
const messageMap = new Map();

// Скорочені назви полів для Slack
const FIELD_LABELS = {
  manager:      'Менеджер',
  date:         'Дата',
  phone:        'Тел',
  order:        'Замовл',
  product:      'Товар',
  art_ls:       'Арт LS',
  supplier:     'Постач',
  art_supplier: 'Арт постач',
  defect:       'Проблема',
  status:       'Статус',
  date_sent_by: 'Відпр клієнтом',
  ttn_client:   'ТТН клієнта',
  date_received:'Отримали',
  date_sent_to: 'Відпр постач',
  ttn_supplier: 'ТТН постач',
  date_returned:'Відпр клієнту',
  ttn_return:   'ТТН клієнту',
  comment:      'Коментар',
};

// Зберігаємо map: номер -> { channel, ts }

app.post('/slack/row-update', async (req, res) => {
  res.status(200).send('ok');
  const d = req.body;
  const number = d.number;
  console.log(`📊 Оновлення рядка #${number}`);

  const msg = messageMap.get(String(number));
  if (!msg) {
    console.log(`ℹ️ Повідомлення для #${number} не знайдено`);
    return;
  }

  const status = d.status || 'Нова заявка';
  const emoji = statusEmoji(status);

  // Перший рядок — статус і основна інфо
  let text = `*Брак #${number}*`;
  if (d.date)    text += ` | ${d.date}`;
  if (d.manager) text += ` | *${d.manager}*`;
  if (d.order)   text += ` | Замовл: *${d.order}*`;
  if (d.phone)   text += ` | Тел: ${d.phone}`;

  // Товар з артикулами
  if (d.product) {
    text += `\n*Товар:* _${d.product}_`;
    const arts = [d.art_ls, d.art_supplier].filter(Boolean);
    if (arts.length) text += ` (${arts.join(' | ')})`;
  }

  // Проблема
  if (d.defect) text += `\n*Проблема:* _${d.defect}_`;

  // Додаткові поля — тільки заповнені
  const extra = [
    ['supplier',     d.supplier],
    ['date_sent_by', d.date_sent_by],
    ['ttn_client',   d.ttn_client],
    ['date_received',d.date_received],
    ['date_sent_to', d.date_sent_to],
    ['ttn_supplier', d.ttn_supplier],
    ['date_returned',d.date_returned],
    ['ttn_return',   d.ttn_return],
    ['comment',      d.comment],
  ].filter(([, v]) => v && String(v).trim() !== '');

  if (extra.length) {
    text += '\n' + extra.map(([k, v]) => `*${FIELD_LABELS[k]}:* ${v}`).join(' | ');
  }

  await slackApi('chat.update', {
    channel: msg.channel,
    ts: msg.ts,
    text: `${emoji} [${status}] Брак #${number}`,
    blocks: [
      buildStatusBlock(emoji, status),
      { type: 'section', text: { type: 'mrkdwn', text } },
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
    else console.log(`✅ Повідомлення оновлено для #${number}`);
  });
});


// ── 5. Webhook для видалення повідомлення при видаленні рядка ─
app.post('/slack/row-delete', async (req, res) => {
  res.status(200).send('ok');
  const { number } = req.body;
  console.log(`🗑 Видалення повідомлення для #${number}`);

  const msg = messageMap.get(String(number));
  if (!msg) {
    console.log(`ℹ️ Повідомлення для #${number} не знайдено`);
    return;
  }

  await slackApi('chat.delete', {
    channel: msg.channel,
    ts: msg.ts
  }).then(r => {
    if (!r.ok) console.error('❌ chat.delete error:', r.error);
    else {
      console.log(`✅ Повідомлення #${number} видалено з Slack`);
      messageMap.delete(String(number));
    }
  });
});


const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
  console.log(`✅ Defect Tracker запущено на порту ${PORT}`);
  await loadMessageMap();
});
