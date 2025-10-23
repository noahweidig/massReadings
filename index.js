const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cheerio = require('cheerio');
const { DateTime } = require('luxon');
const OpenAI = require('openai');
const fs = require('fs');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const DATABASE_PATH = path.join(__dirname, 'subscribers.db');

if (!process.env.SMTP_HOST) {
  console.warn('[Config] SMTP_HOST is not set. Emails will fail to send until configured.');
}

if (!process.env.OPENAI_API_KEY) {
  console.warn('[Config] OPENAI_API_KEY is not set. Using default reflection copy.');
}

const app = express();
app.use(express.urlencoded({ extended: true }));

let db;
function initializeDatabase() {
  const exists = fs.existsSync(DATABASE_PATH);
  db = new sqlite3.Database(DATABASE_PATH, (err) => {
    if (err) {
      console.error('Failed to connect to database', err);
      process.exit(1);
    }
    db.run(
      `CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        date_subscribed TEXT NOT NULL
      )`,
      (tableErr) => {
        if (tableErr) {
          console.error('Failed to create subscribers table', tableErr);
        } else if (!exists) {
          console.log('Database initialized at', DATABASE_PATH);
        }
      }
    );
  });
}

initializeDatabase();

const secureSetting = String(process.env.SMTP_SECURE).toLowerCase() === 'true';
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : secureSetting ? 465 : 587,
  secure: secureSetting,
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  } : undefined,
});

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Daily Mass Readings Subscription</title>
      <style>
        :root {
          color-scheme: light dark;
        }
        body {
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          margin: 0;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
          padding: 2rem;
        }
        .card {
          background: rgba(255, 255, 255, 0.9);
          backdrop-filter: blur(6px);
          border-radius: 16px;
          padding: 2.5rem 2rem;
          max-width: 420px;
          width: 100%;
          box-shadow: 0 20px 45px rgba(0, 0, 0, 0.15);
          text-align: center;
        }
        h1 {
          margin-top: 0;
          font-size: clamp(1.8rem, 2.5vw, 2.4rem);
        }
        p {
          color: #444;
          line-height: 1.6;
        }
        form {
          display: grid;
          gap: 1rem;
          margin-top: 1.5rem;
        }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0, 0, 0, 0);
          white-space: nowrap;
          border: 0;
        }
        input[type="email"] {
          padding: 0.85rem 1rem;
          border-radius: 999px;
          border: 1px solid rgba(0, 0, 0, 0.2);
          font-size: 1rem;
          transition: box-shadow 0.2s ease, border 0.2s ease;
        }
        input[type="email"]:focus {
          outline: none;
          border-color: #3f72af;
          box-shadow: 0 0 0 3px rgba(63, 114, 175, 0.25);
        }
        button {
          padding: 0.85rem 1rem;
          border: none;
          border-radius: 999px;
          background: #3f72af;
          color: #fff;
          font-weight: 600;
          font-size: 1rem;
          cursor: pointer;
          transition: transform 0.2s ease, box-shadow 0.2s ease;
        }
        button:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 18px rgba(63, 114, 175, 0.35);
        }
        footer {
          margin-top: 1.5rem;
          font-size: 0.875rem;
          color: #555;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Daily Mass Readings</h1>
        <p>Receive the daily Catholic Mass readings, a short reflection, and a question for prayer every morning at 6 AM.</p>
        <form method="POST" action="/subscribe">
          <label class="sr-only" for="email">Email address</label>
          <input id="email" name="email" type="email" placeholder="you@example.com" required />
          <button type="submit">Subscribe</button>
        </form>
        <footer>We respect your inbox. Unsubscribe anytime.</footer>
      </div>
    </body>
  </html>`);
});

app.post('/subscribe', (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).send('Please provide a valid email address.');
  }

  const now = new Date().toISOString();
  db.run(
    'INSERT OR IGNORE INTO subscribers (email, date_subscribed) VALUES (?, ?)',
    [email, now],
    function insertCallback(err) {
      if (err) {
        console.error('Failed to add subscriber', err);
        return res.status(500).send('Unable to add subscriber right now.');
      }

      if (this.changes === 0) {
        return res.status(200).send('You are already subscribed!');
      }

      console.log(`New subscriber: ${email}`);
      res.status(201).send('Subscription successful! Look for tomorrow\'s readings in your inbox.');
    }
  );
});

async function fetchReadingsForDate(date = DateTime.now().setZone(TIMEZONE)) {
  const formatted = date.toFormat('MMddyy');
  const url = `https://bible.usccb.org/bible/readings/${formatted}.cfm`;

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DailyMassReadingsBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    });

    const $ = cheerio.load(response.data);

    const pageTitle = $('h1.page-title, h1').first().text().trim();
    const displayDate = date.toFormat('MMMM d, yyyy');
    const infoBlocks = [];
    $('#page-content .readings-header p, #page-content .daily-readings__main p, main p').each((_, el) => {
      const text = $(el).text().trim();
      if (text) infoBlocks.push(text);
    });

    const feast = infoBlocks.find((text) => /memorial|feast|solemnity|weekday|saint|lord/i.test(text)) || pageTitle || 'Daily Mass';
    const colorMatch = infoBlocks.find((text) => /color/i.test(text));
    const liturgicalColor = colorMatch ? colorMatch.replace(/.*color:?\s*/i, '').trim() : 'Varies';

    function extractReading(label) {
      const heading = $('h3, h2').filter((_, el) => $(el).text().toLowerCase().includes(label));
      if (heading.length === 0) {
        return '';
      }
      const paragraphs = heading
        .first()
        .nextUntil('h3, h2')
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      return paragraphs.join('\n\n');
    }

    const firstReading = extractReading('reading i') || extractReading('first reading');
    const psalm = extractReading('responsorial psalm');
    const gospel = extractReading('gospel');

    if (!gospel) {
      throw new Error('Unable to locate Gospel text on the USCCB page.');
    }

    return {
      sourceUrl: url,
      dateText: displayDate,
      feast,
      liturgicalColor,
      readings: {
        firstReading: firstReading || 'First reading unavailable.',
        psalm: psalm || 'Responsorial Psalm unavailable.',
        gospel,
      },
    };
  } catch (error) {
    error.message = `Failed to fetch or parse readings: ${error.message}`;
    throw error;
  }
}

async function generateReflection(gospelText, dateText) {
  if (!openai) {
    return {
      reflection: 'May the Word of God dwell richly in your heart today.',
      question: 'How is the Gospel inviting me to love more generously today?',
    };
  }

  const prompt = `You are a Catholic spiritual writer. Write a concise reflection on the Gospel reading provided.\nDate: ${dateText}\nGospel:\n${gospelText}\n\nRespond with two sentences offering a pastoral insight, followed by a single question for reflection.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a Catholic spiritual writer who composes pastoral reflections grounded in Scripture.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 220,
    temperature: 0.7,
  });

  const output = completion.choices?.[0]?.message?.content || '';
  const [reflectionPart, questionPart] = output.split(/Question:?/i);

  const reflection = reflectionPart ? reflectionPart.trim().replace(/\s+/g, ' ') : output.trim();
  const question = questionPart
    ? `Question: ${questionPart.trim()}`
    : 'Question: How is Christ speaking to me in today\'s Gospel?';

  return { reflection, question };
}

function buildEmailTemplate(readingData, reflectionData) {
  const { dateText, feast, liturgicalColor, readings, sourceUrl } = readingData;
  const { reflection, question } = reflectionData;
  const parsedDate = DateTime.fromFormat(dateText || '', 'MMMM d, yyyy', { zone: TIMEZONE });
  const formattedDate = parsedDate.isValid
    ? parsedDate.toFormat('MMMM d, yyyy')
    : DateTime.now().setZone(TIMEZONE).toFormat('MMMM d, yyyy');
  const subject = `Daily Mass Readings – ${formattedDate}`;

  return {
    subject,
    html: `<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${subject}</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; background-color: #f7f7f7; color: #1f1f1f; margin: 0; padding: 0; }
        .wrapper { max-width: 620px; margin: 0 auto; padding: 24px 16px; }
        .card { background: #ffffff; border-radius: 12px; padding: 28px 24px; box-shadow: 0 6px 18px rgba(0,0,0,0.08); }
        h1 { font-size: 1.6rem; margin-bottom: 4px; }
        .meta { font-size: 0.95rem; color: #555; margin-bottom: 16px; }
        .reading { margin-bottom: 18px; }
        .reading h2 { font-size: 1.05rem; margin: 0 0 8px; color: #3f72af; }
        .reading p { line-height: 1.6; white-space: pre-line; }
        .reflection { border-left: 4px solid #3f72af; padding-left: 12px; margin: 24px 0; }
        .question { font-style: italic; margin-bottom: 24px; color: #444; }
        .footer { font-size: 0.85rem; color: #666; text-align: center; margin-top: 24px; }
        a.button { display: inline-block; padding: 12px 18px; background: #3f72af; color: #fff; border-radius: 999px; text-decoration: none; font-weight: 600; }
        @media (max-width: 600px) {
          .card { padding: 24px 18px; }
          h1 { font-size: 1.4rem; }
        }
      </style>
    </head>
    <body>
      <div class="wrapper">
        <div class="card">
          <h1>✝️ Daily Mass Readings – ${formattedDate}</h1>
          <div class="meta">
            <div><strong>Feast:</strong> ${feast}</div>
            <div><strong>Liturgical Color:</strong> ${liturgicalColor}</div>
          </div>
          <section class="reading">
            <h2>First Reading</h2>
            <p>${readings.firstReading.replace(/\n/g, '<br />')}</p>
          </section>
          <section class="reading">
            <h2>Responsorial Psalm</h2>
            <p>${readings.psalm.replace(/\n/g, '<br />')}</p>
          </section>
          <section class="reading">
            <h2>Gospel</h2>
            <p>${readings.gospel.replace(/\n/g, '<br />')}</p>
          </section>
          <section class="reflection">
            <p>${reflection}</p>
          </section>
          <p class="question"><em>${question}</em></p>
          <p><a class="button" href="${sourceUrl}" target="_blank" rel="noopener noreferrer">Full readings → USCCB website</a></p>
        </div>
        <div class="footer">You are receiving this email because you subscribed to Daily Mass Readings. To unsubscribe, reply to this email.</div>
      </div>
    </body>
    </html>`
  };
}

function getAllSubscribers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT email FROM subscribers', (err, rows) => {
      if (err) {
        return reject(err);
      }
      resolve(rows.map((row) => row.email));
    });
  });
}

async function sendDailyReadingsEmail() {
  try {
    const date = DateTime.now().setZone(TIMEZONE);
    console.log(`[Scheduler] Fetching readings for ${date.toISODate()}...`);
    const readings = await fetchReadingsForDate(date);
    const reflection = await generateReflection(readings.readings.gospel, readings.dateText);
    const emailContent = buildEmailTemplate(readings, reflection);

    const subscribers = await getAllSubscribers();
    if (!subscribers.length) {
      console.log('[Scheduler] No subscribers found; skipping email send.');
      return;
    }

    const sendResults = await Promise.allSettled(
      subscribers.map((recipient) =>
        transporter.sendMail({
          from: process.env.FROM_EMAIL || process.env.SMTP_USER,
          to: recipient,
          subject: emailContent.subject,
          html: emailContent.html,
        })
      )
    );

    const fulfilled = sendResults.filter((result) => result.status === 'fulfilled').length;
    const rejected = sendResults.length - fulfilled;
    console.log(`[Scheduler] Emails sent: ${fulfilled}; failures: ${rejected}`);
    if (rejected > 0) {
      sendResults
        .filter((result) => result.status === 'rejected')
        .forEach((failure) => console.error('Email send failure:', failure.reason));
    }
  } catch (error) {
    console.error('[Scheduler] Failed to send daily readings:', error);
  }
}

cron.schedule('0 6 * * *', () => {
  sendDailyReadingsEmail();
}, {
  timezone: TIMEZONE,
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timezone: TIMEZONE });
});

function startServer() {
  return app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}. Scheduler timezone: ${TIMEZONE}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  fetchReadingsForDate,
  generateReflection,
  buildEmailTemplate,
  sendDailyReadingsEmail,
};
