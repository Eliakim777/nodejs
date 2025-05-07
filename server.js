const express = require('express');
const bodyParser = require('body-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { simpleParser } = require('mailparser');
const Imap = require('imap');
require('dotenv').config();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

let registeredEmails = new Set();
let processedUIDs = new Set();
let sentEmails = new Set();        // Emails that have already been sent the game
let pendingEmails = new Set();     // Emails currently being processed

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL,
    pass: process.env.APP_PASSWORD,
  },
});

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

// Serve registration form
app.get('/', (req, res) => {
  res.send(`
    <html>
      <body>
        <form action="/register" method="POST">
          <label for="email">Enter your email to register:</label><br>
          <input type="email" id="email" name="email" required><br>
          <input type="submit" value="Register">
        </form>
      </body>
    </html>
  `);
});

// Handle registration
app.post('/register', (req, res) => {
  const { email } = req.body;
  if (email) {
    registeredEmails.add(email.toLowerCase());
    console.log(`[${new Date().toISOString()}] ✅ Registered email: ${email}`);
    res.send(`Thank you for registering! You'll receive your game link after payment verification.`);
  } else {
    res.status(400).send('Missing email');
  }
});

// Game page
app.get('/game', (req, res) => {
  res.send('🎮 Welcome to the game!');
});

// IMAP setup
const imap = new Imap({
  user: process.env.EMAIL,
  password: process.env.APP_PASSWORD,
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
});

function openInbox(cb) {
  imap.openBox('INBOX', false, cb);
}

imap.once('ready', function () {
  openInbox((err, box) => {
    if (err) throw err;
    console.log('📂 Inbox opened.');

    imap.on('mail', () => {
      const since = new Date(Date.now() - 60 * 1000); // Check emails in last 60 seconds
      const searchCriteria = [['SINCE', since.toISOString()]];

      imap.search(searchCriteria, (err, results) => {
        if (err || !results || results.length === 0) return;

        const newUIDs = results.filter(uid => !processedUIDs.has(uid));
        if (newUIDs.length === 0) return;

        const f = imap.fetch(newUIDs, { bodies: '', markSeen: true });

        f.on('message', (msg, seqno) => {
          let uid = null;

          msg.on('attributes', attrs => {
            uid = attrs.uid;
          });

          msg.on('body', async (stream) => {
            try {
              const parsed = await simpleParser(stream);
              const fromEmail = parsed.from.value[0].address.toLowerCase();
              const subject = parsed.subject;

              if (!registeredEmails.has(fromEmail)) return;
              if (!subject.includes('sent you $1.98')) return;
              if (processedUIDs.has(uid)) return;

              processedUIDs.add(uid);

              // Lock to prevent duplicate sends
              if (pendingEmails.has(fromEmail) || sentEmails.has(fromEmail)) {
                console.log(`[${new Date().toISOString()}] ⚠️ Game link already sent or being processed for ${fromEmail}`);
                return;
              }

              pendingEmails.add(fromEmail);
              console.log(`[${new Date().toISOString()}] 💸 Verified payment from ${fromEmail}`);

              const token = generateToken();
              const gameUrl = `http://localhost:3000/game?token=${token}`;

              transporter.sendMail({
                from: process.env.EMAIL,
                to: fromEmail,
                subject: 'Your Game Link',
                text: `Here is your game: ${gameUrl}`,
              }, (err, info) => {
                pendingEmails.delete(fromEmail);

                if (err) {
                  console.error('❌ Email send error:', err);
                } else {
                  sentEmails.add(fromEmail);
                  console.log(`[${new Date().toISOString()}] 📧 Sent game link to ${fromEmail}`);
                }
              });

            } catch (err) {
              console.error('❌ Parsing failed:', err);
            }
          });
        });
      });
    });
  });
});

imap.once('error', function (err) {
  console.log('❌ IMAP error:', err);
});

imap.once('end', function () {
  console.log('📴 IMAP connection closed.');
});

imap.connect();

app.listen(3000, () => {
  console.log('🚀 Server running at http://localhost:3000');
});
