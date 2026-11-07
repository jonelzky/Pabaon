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

// ==============================
// IMAGES - ROTATION, HINDI RANDOM
// 75 images sa GitHub: images/panalangin1.jpg etc.
// Walang gitling sa pangalan - tulad ng ni-rename mo.
// Rotation base sa linggo: 10 weeks bago umulit, walang doble sa 1 buwan.
// ==============================
const IMAGE_SETS = {
  0: { prefix: 'panalangin', count: 10 },   // Sunday
  1: { prefix: 'pagod', count: 10 },        // Monday
  2: { prefix: 'verse', count: 10 },         // Tuesday
  3: { prefix: 'paalala', count: 13 },       // Wednesday - 10 + 3 bago
  4: { prefix: 'kwento', count: 10 },        // Thursday
  5: { prefix: 'pasasalamat', count: 12 },   // Friday - 10 + 2 bago
  6: { prefix: 'pahinga', count: 10 },       // Saturday
};
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/jonelzky/Pabaon/main/images/';

function getRotationImageForToday() {
  const now = new Date();
  const day = now.getDay();
  const set = IMAGE_SETS[day];
  // Day of year -> week number -> rotation index
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  const weekNumber = Math.floor(dayOfYear / 7);
  const index = (weekNumber % set.count) + 1; // 1..count, walang doble hanggat hindi naikot lahat
  const fileName = `${set.prefix}${index}.jpg`;
  const url = GITHUB_RAW_BASE + fileName;
  console.log('Today image (rotation):', fileName, '| Week:', weekNumber);
  return { fileName, url };
}

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
      { role: 'system', content: `Ikaw ang admin ng Page na "Pabaon - daily nourishment for the soul". Sumagot ka ng Taglish, malumanay, parang kaibigan. Kung malungkot yung nag-message, makinig ka muna, wag ka agad mag-sermon. Kung humingi ng prayer, mag-offer ka ng maikling prayer. Wag ka magpanggap na pastor o therapist. Kung mabigat na yung sinasabi (depression, self-harm), sabihin mo na hindi ka professional at i-encourage mo sila mag-usap sa taong pinagkakatiwalaan nila o sa professional. Maikli lang, 3-5 sentences.` },
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
  const post = await callGroq([
    {
      role: 'system',
      content: `Ikaw ang writer ng Facebook Page na "Pabaon - daily nourishment for the soul". Ngayon, ang MOOD mo ay: ${randomMood}. Sundin mo yung mood na yan. Style: Taglish, parang tao, hindi AI. Hindi preachy. Bawal mag imbento ng Bible verse. Format: Simula sa "Pabaon for today:" - 3-5 sentences lang - Tapos 1 tanong sa dulo - 2-3 hashtags lang: #Pabaon #DailyNourishment - 1 emoji lang max.`
    },
    { role: 'user', content: `Gawa ka ng post for today. Theme: ${theme}. Mood: ${randomMood}.` }
  ], 0.95, 350);
  return post;
}

async function autoPostDaily() {
  const postText = await generatePabaon();
  const { fileName, url } = getRotationImageForToday();
  try {
    // Post as photo - Facebook kukuha ng image galing sa GitHub raw URL
    const res = await axios.post(`https://graph.facebook.com/v21.0/${PAGE_ID}/photos`, {
      url: url,
      caption: postText,
      access_token: PAGE_TOKEN
    });
    console.log('Pabaon Posted with photo:', fileName, 'FB id:', res.data.id);
    return postText + '\n\n[Photo: ' + fileName + ']';
  } catch (photoErr) {
    // Fallback: kung ayaw ni FB ng photo, text lang muna para hindi mawala yung post
    console.log('Photo post failed, fallback to text:', photoErr.response?.data?.error?.message || photoErr.message);
    await axios.post(`https://graph.facebook.com/v21.0/${PAGE_ID}/feed`, { message: postText, access_token: PAGE_TOKEN });
    console.log('Pabaon Posted (text fallback):', postText);
    return postText;
  }
}

app.get('/post-now', async (req, res) => {
  try {
    const posted = await autoPostDaily();
    res.send('Pabaon posted na! <br><br>' + posted);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('May error: ' + JSON.stringify(e.response?.data || e.message));
  }
});

app.get('/', (req, res) => { res.send('Pabaon Bot is running...'); });

app.listen(process.env.PORT || 3000, () => {
  console.log('Pabaon Bot running...');
  console.log('Keys found:', GROQ_KEYS.length);
  console.log('Main model:', MODEL_MAIN, '| Fallback:', MODEL_FALLBACK);
});
