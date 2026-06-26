# Defect Tracker — Slack Bot

Slack-бот для фіксації браку з записом у Google Sheets.

## Встановлення

```bash
npm install
```

## Запуск локально

```bash
npm start
```

## Змінні середовища

| Змінна | Опис |
|--------|------|
| `SLACK_BOT_TOKEN` | Bot token (xoxb-...) з OAuth & Permissions |
| `SLACK_SIGNING_SECRET` | Signing Secret з Basic Information |
| `SPREADSHEET_ID` | ID Google таблиці |
| `GOOGLE_CREDENTIALS` | Вміст service-account.json у форматі рядка |
