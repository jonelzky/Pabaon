require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const PAGE_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const PAGE_ID = process.env.PAGE_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY,
].filter(Boolean);

const MODEL_MAIN = process.env.GROQ_MODEL_MAIN || 'openai/gpt-oss-120b';
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || 'openai/gpt-oss-20b';

let currentKeyIndex = 0;
function getNextKey() {
  const key = GROQ_KEYS[currentKeyIndex % GROQ_KEYS.length];
  currentKeyIndex++;
  return key;
}

async function callGroq(messages, temperature = 0.9, max_tokens = 350) {
  for (let keyTry = 0; keyTry < GROQ_KEYS.length; keyTry++) {
    const apiKey = getNextKey();
    for (const model of [MODEL_MAIN, MODEL_FALLBACK]) {
      try {
        console.log(`Trying Groq: key #${(currentKeyIndex - 1) % GROQ_KEYS.length + 1} | model: ${model}`);
        const res = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          { model, messages, temperature, max_tokens },
          { headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        return res.data.choices[0].message.content;
      } catch (err) {
        console.log(`Failed: ${model} - ${err.response?.data?.error?.message || err.message} -> try next`);
        continue;
      }
    }
  }
  throw new Error('Lahat ng Groq keys at models nag-fail');
}

const THEMES = {
  0: "Panalangin para sa linggo - maikli, tahimik, nakakakalma",
  1: "Para sa pagod na - paalala na hindi mo kailangang maging okay agad",
  2: "Verse of the day - Taglish explanation, hindi preachy",
  3: "Paalala: wag madaliin ang sarili - healing takes time",
  4: "Maikling kwento / parable na may aral, 4-5 sentences lang",
  5: "Pasasalamat - 3 bagay na pwede ipagpasalamat ngayon",
  6: "Pahinga - rest is also part of God's plan, hindi ka tamad"
};

const MOODS = [
  "malalim, pang-hugot, yung mapapaisip ka",
  "makulit, parang tropa lang, may konting humor pero hindi bastos",
  "tahimik, malumanay, parang bulong lang",
  "seryoso pero may pag-asa, hindi mabigat",
  "nakakatawa ng konti sa simula, pero may malalim na dulo",
  "parang kwento lang sa kape, chill lang",
  "maikli at diretso, yung tatama agad"
];

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

async function askGroqReply(userMsg) {
  try {
    const reply = await callGroq([
      {
        role: 'system',
        content: `Ikaw ang admin ng Page na "Pabaon - daily nourishment for the soul". Sumagot ka ng Taglish, malumanay, parang kaibigan. Kung malungkot yung nag-message, makinig ka muna, wag ka agad mag-sermon. Kung humingi ng prayer, mag-offer ka ng maikling prayer. Wag ka magpanggap na pastor o therapist. Kung mabigat na yung sinasabi (depression, self-harm), sabihin mo na hindi ka professional at i-encourage mo sila mag-usap sa taong pinagkakatiwalaan nila o sa professional. Maikli lang, 3-5 sentences.`
      },
      { role: 'user', content: userMsg }
    ], 0.7, 250);
    return reply;
  } catch (err) {
    console.error(err.message);
    return 'Salamat sa pag-message sa Pabaon. Medyo busy lang, pero babasahin namin to. Pahinga ka muna ha.';
  }
}

async function sendMessage(senderId, text) {
  await axios.post(
    `https://graph.facebook.com/v21.0/me/messages?access_token=${PAGE_TOKEN}`,
    { recipient: { id: senderId }, message: { text: text } }
  );
}

async function generatePabaon() {
  const today = new Date().getDay();
  const theme = THEMES[today];
  const randomMood = MOODS[Math.floor(Math.random() * MOODS.length)];
  console.log('Today theme:', theme);
  console.log('Today mood:', randomMood);

  const post = await callGroq([
    {
      role: 'system',
      content: `Ikaw ang writer ng 【entity-Facebook¦canonical_name=Facebook】 Page na "Pabaon - daily nourishment for the soul".
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
    { role: 'user', content: `Gawa ka ng post for today. Theme:
