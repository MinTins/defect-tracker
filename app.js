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
app.get('/', (req, res) => res.send('✅ Defect Tracker працює!'));

// ── Slack API helper ─────────────────────────────────────────
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

// ── Отримати Full Name користувача зі Slack ──────────────────
async function getSlackUserName(userId) {
  try {
    const result = await slackApi('users.info', { user: userId });
    if (result.ok) {
      return result.user.profile.real_name || result.user.real_name || result.user.name;
    }
  } catch (e) {
    console.error('❌ Помилка отримання імені:', e.message);
  }
  return null;
}

function sectionField(label, value) {
  return {
    type: 'section',
    text: { type: 'mrkdwn', text: `*${label}:*\n${value || '—'}` }
  };
}

// ── 1. Команда /create ───────────────────────────────────────
app.post('/slack/commands', (req, res) => {
  res.status(200).send('');
  console.log('📩 Команда отримана');

  const { trigger_id, channel_id, user_id } = req.body;

  // Отримуємо ім'я користувача і передаємо в metadata
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
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `👤 *Менеджер(-ка):* ${fullName || 'невідомо'}` }
          },
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
    else console.log('✅ Modal відкрито');
  }).catch(err => console.error('❌ Помилка:', err.message));
});

// ── 2. Відправка форми ───────────────────────────────────────
app.post('/slack/interactions', (req, res) => {
  const payload = JSON.parse(req.body.payload);

  if (payload.type === 'view_submission' && payload.view.callback_id === 'defect_form') {
    res.status(200).json({ response_action: 'clear' });

    const v = payload.view.state.values;
    const meta = JSON.parse(payload.view.private_metadata);
    const channelId = meta.channel_id;
    const managerName = meta.manager_name;

    const data = {
      manager:          managerName || payload.user.name,
      date:             v.date.date.selected_date,
      phone:            v.phone.phone.value,
      order_num:        v.order_num.order_num.value,
      product:          v.product.product.value,
      supplier_article: v.supplier_article.supplier_article.value,
      defect:           v.defect.defect.value,
      timestamp:        new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })
    };

    // Спочатку записуємо в Sheets, щоб отримати № звернення
    appendToSheet(data).then(newNumber => {
      return slackApi('chat.postMessage', {
        channel: channelId,
        text: '🔴 Новий брак зафіксовано',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '🔴 Новий брак зафіксовано' } },
          sectionField('🔢 № звернення', String(newNumber)),
          sectionField('👤 Менеджер(-ка)', data.manager),
          sectionField('📅 Дата звернення', data.date),
          sectionField('📞 Телефон клієнта', data.phone),
          sectionField('🧾 № замовлення', data.order_num),
          sectionField('📦 Назва товару', data.product),
          sectionField('🏷️ Артикул постачальника', data.supplier_article),
          sectionField('⚠️ Опис дефекту', data.defect),
          { type: 'divider' },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `Заповнив(ла): ${data.manager} · ${data.timestamp}` }] }
        ]
      });
    }).then(result => {
      if (!result.ok) console.error('❌ Slack message error:', result.error);
      else console.log('✅ Повідомлення відправлено в Slack');
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

  // Знаходимо перший порожній рядок у колонці A
  const getRows = await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: 'БРАК!A:A',
  });

  const rows = getRows.data.values || [];
  // Шукаємо перший рядок де A порожня (після заголовка)
  let firstEmptyRow = rows.length + 1;
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || rows[i][0].toString().trim() === '') {
      firstEmptyRow = i + 1; // +1 бо Google Sheets рядки з 1
      break;
    }
  }

  const newNumber = firstEmptyRow - 1; // № звернення = номер рядка - заголовок

  // Записуємо дані
  await sheets.spreadsheets.values.update({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `БРАК!A${firstEmptyRow}:J${firstEmptyRow}`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [[
        newNumber,            // A: № звернення
        data.manager,         // B: Менеджер(-ка)
        data.date,            // C: Дата звернення
        data.phone,           // D: Телефон клієнта
        data.order_num,       // E: № замовлення
        data.product,         // F: Назва товару
        '',                   // G: порожня
        data.supplier_article,// H: Артикул постачальника
        data.defect,          // I: Опис дефекту
        'Нова заявка',        // J: Статус
      ]]
    }
  });

  // Копіюємо форматування з попереднього рядка
  const sheetId = 1385128494; // gid аркуша БРАК
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: process.env.SPREADSHEET_ID,
    resource: {
      requests: [{
        copyPaste: {
          source: {
            sheetId,
            startRowIndex: firstEmptyRow - 2,
            endRowIndex: firstEmptyRow - 1,
            startColumnIndex: 0,
            endColumnIndex: 18
          },
          destination: {
            sheetId,
            startRowIndex: firstEmptyRow - 1,
            endRowIndex: firstEmptyRow,
            startColumnIndex: 0,
            endColumnIndex: 18
          },
          pasteType: 'PASTE_FORMAT'
        }
      }]
    }
  });

  console.log(`✅ Записано в рядок ${firstEmptyRow}, № звернення: ${newNumber}`);
  return newNumber;
}

// ── Запуск ───────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`✅ Defect Tracker запущено на порту ${PORT}`));
