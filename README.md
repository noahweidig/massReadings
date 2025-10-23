# Daily Mass Readings Emailer

This project is a self-contained Node.js service that collects the daily Catholic Mass readings, enriches them with an AI-generated reflection, and emails the content to subscribers every morning at 6 AM (server-local time by default).

## Features

- 🌐 Minimal landing page with an email subscription form (Express).
- 💾 SQLite subscriber database that is created automatically.
- 🔁 Daily cron job (6 AM) that fetches readings from the USCCB website, generates a brief reflection using OpenAI, and sends responsive HTML emails with Nodemailer.
- 🛡️ Duplicate subscriber protection and logging for send results.
- ⚙️ Fully configured through environment variables for SMTP, OpenAI, and timezone settings.

## Getting Started

### Prerequisites

- Node.js 18+
- An SMTP provider (for example: SendGrid, Mailgun, Gmail SMTP)
- An OpenAI API key (GPT-4 compatible)

### Installation

```bash
npm install
cp .env.example .env
```

Edit `.env` with your SMTP credentials, OpenAI API key, and preferred timezone.

### Environment Variables

| Variable | Description |
| --- | --- |
| `PORT` | Port used by the Express server (default: `3000`). |
| `TIMEZONE` | IANA timezone string for cron scheduling (default: server timezone). |
| `SMTP_HOST` | SMTP server host. |
| `SMTP_PORT` | SMTP server port. |
| `SMTP_SECURE` | Set to `true` to use TLS (port 465), otherwise `false`. |
| `SMTP_USER` | SMTP username. |
| `SMTP_PASS` | SMTP password or app password. |
| `FROM_EMAIL` | Friendly “from” email (defaults to `SMTP_USER`). |
| `OPENAI_API_KEY` | OpenAI API key with GPT-4 access. |

### Running Locally

```bash
npm start
```

Visit [http://localhost:3000](http://localhost:3000) to subscribe an email address. The cron task runs automatically, but you can trigger a send manually in a Node REPL if needed:

```js
// Inside `node`
require('./index').sendDailyReadingsEmail();
```

### Deployment Notes

- The scheduler uses [`node-cron`](https://www.npmjs.com/package/node-cron) and keeps running on platforms like Render, Fly.io, or Railway.
- The SQLite database file (`subscribers.db`) is created at the project root. Ensure the deployment environment persists this file, or swap in a managed database.
- If the OpenAI API key is missing, the service gracefully falls back to a generic reflection and question.
- If you host the landing page separately from the Node.js service (for example on GitHub Pages), set `window.MASS_READINGS_SUBSCRIBE_ENDPOINT` in a small inline script on that page so the form posts to your API origin instead of the static host. Example:

  ```html
  <script>
    window.MASS_READINGS_SUBSCRIBE_ENDPOINT = 'https://your-service-domain/subscribe';
  </script>
  ```

  The in-page script automatically prefers this value before falling back to the form action.

### Logging

The service logs:

- New subscribers
- Daily cron execution
- Number of successful/failed email sends
- Errors fetching readings or sending mail

## License

MIT
