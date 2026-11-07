require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.PAGE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GROQ_KEY = process.env.GROQ_API_KEY;

// ==============================
// PERSONALIZE DITO LANG - THEMES
// 0 = Sunday, 1 = Monday, 2 = Tuesday, 3 = Wednesday, 4 = Thursday, 5 = Friday, 6 = Saturday
// ==============================
const THEMES = {
  0: "Panalangin para sa linggo - maikli, tahimik, nakakakalma",
  1: "Para sa pagod na - paalala na hindi mo kailangang maging okay agad",
  2: "Verse of the day - Taglish explanation, hindi preachy",
  3: "Paalala: wag madaliin ang sarili - healing takes time",
  4: "Maikling kwento / parable na may aral, 4-5 sentences lang",
  5: "Pasasalamat - 3 bagay na pwede ipagpasalamat ngayon",
  6: "Pahinga - rest is also part of God's plan, hindi ka tamad"
};

// ==============================
// RANDOM MOODS - araw-araw iba yung trip ni Groq
// Minsan malalim, minsan makulit, minsan tahimik lang
// ==============================
const MOODS = [
  "malalim, pang-hugot, yung mapapaisip ka",
  "makulit, parang tropa lang, may konting humor pero hindi bastos",
  "tahimik, malumanay, parang bulong lang",
  "seryoso pero may pag-asa, hindi mabigat",
  "nakakatawa ng konti sa simula, pero may malalim na dulo",
  "parang kwento lang sa kape, chill lang",
  "maikli at diretso, yung tatama agad"
];

// --- WEBHOOK VERIFICATION PARA KAY META ---
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('WEBHOOK VERIFIED');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- AUTO-REPLY SA INBOX ---
app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    for (const entry of body.entry) {
      if (entry.messaging) {
        for (const event of entry.messaging) {
          if (event.message && event.message.text && !event.message.is_echo) {
            const userMsg = event.message.text;
            console.log('User:', userMsg);
            const aiReply = await askGroqReply(userMsg);
            await sendMessage(event.sender.id, aiReply);
          }
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// --- GROQ PARA SA AUTO-REPLY ---
async function askGroqReply(userMsg) {
  try {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `Ikaw ang admin ng Page na "Pabaon - daily nourishment for the soul". Sumagot ka ng Taglish, malumanay, parang kaibigan. Kung malungkot yung nag-message, makinig ka muna, wag ka agad mag-sermon. Kung humingi ng prayer, mag-offer ka ng maikling prayer. Wag ka magpanggap na pastor o therapist. Kung mabigat na yung sinasabi (depression, self-harm), sabihin mo na hindi ka professional at i-encourage mo sila mag-usap sa taong pinagkakatiwalaan nila o sa professional. Maikli lang, 3-5 sentences.`
          },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.7,
        max_tokens: 250
      },
      { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } }
    );
    return res.data.choices[0].message.content;
  } catch (err) {
    console.error(err.response?.data || err.message);
    return 'Salamat sa pag-message sa Pabaon. Medyo busy lang, pero babasahin namin to. Pahinga ka muna ha.';
  }
}

async function sendMessage(senderId, text) {
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_TOKEN}`,
    { recipient: { id: senderId }, message: { text: text } }
  );
}

// --- GROQ PARA SA DAILY POST - RANDOM MOOD + THEME ---
async function generatePabaon() {
  const today = new Date().getDay();
  const theme = THEMES[today];
  const randomMood = MOODS[Math.floor(Math.random() * MOODS.length)];
  console.log('Today theme:', theme);
  console.log('Today mood:', randomMood);

  const res = await axios.post(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Ikaw ang writer ng Facebook Page na "Pabaon - daily nourishment for the soul".
          Ngayon, ang MOOD mo ay: ${randomMood}.
          Sundin mo yung mood na yan. Kung makulit, makulit ka. Kung malalim, malalim ka. Wag ka puro seryoso.
          Style: Taglish, parang tao, hindi AI. Hindi preachy.
          Bawal mag imbento ng Bible verse. Kung mag-quote ka, yung totoo lang at sikat na verse.
          Format:
          - Simula sa "Pabaon for today:"
          - 3-5 sentences lang
          - Tapos 1 tanong sa dulo para mag-comment sila
          - 2-3 hashtags lang: #Pabaon #DailyNourishment
          - 1 emoji lang max, kung kailangan.`
        },
        { role: 'user', content: `Gawa ka ng post for today. Theme: ${theme}. Mood: ${randomMood}. Dapat iba sa typical inspirational post, mas personal.` }
      ],
      temperature: 0.95,
      max_tokens: 350
    },
    { headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' } }
  );
  return res.data.choices[0].message.content;
}

async function autoPostDaily() {
  const postText = await generatePabaon();
  await axios.post(
    `https://graph.facebook.com/v21.0/${PAGE_ID}/feed`,
    { message: postText, access_token: PAGE_TOKEN }
  );
  console.log('Pabaon Posted:', postText);
  return postText;
}

// --- PARA I-TEST MANUALLY AT PARA SA CRON ---
app.get('/post-now', async (req, res) => {
  try {
    const posted = await autoPostDaily();
    res.send('Pabaon posted na! <br><br>' + posted);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('May error: ' + JSON.stringify(e.response?.data || e.message));
  }
});

app.get('/', (req, res) => {
  res.send('Pabaon Bot is running...');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Pabaon Bot running...');
});

