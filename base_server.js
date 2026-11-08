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
// IMAGES - ROTATION
// ==============================
const IMAGE_SETS = {
  0: { prefix: 'panalangin', count: 10 },   // Sunday
  1: { prefix: 'pagod', count: 10 },        // Monday
  2: { prefix: 'verse', count: 10 },         // Tuesday
  3: { prefix: 'paalala', count: 13 },       // Wednesday
  4: { prefix: 'kwento', count: 10 },        // Thursday
  5: { prefix: 'pasasalamat', count: 12 },   // Friday
  6: { prefix: 'pahinga', count: 10 },       // Saturday
};
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/jonelzky/Pabaon/main/images/';

function getRotationImageForToday() {
  const now = new Date();
  const day = now.getDay();
  const set = IMAGE_SETS[day];
  const start = new Date(now.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((now - start) / 86400000);
  const weekNumber = Math.floor(dayOfYear / 7);
  const index = (weekNumber % set.count) + 1;
  const fileName = `${set.prefix}${index}.jpg`;
  const url = GITHUB_RAW_BASE + fileName;
  console.log('Today image (rotation):', fileName, '| Week:', weekNumber);
  return { fileName, url };
}

// ==============================
// FIRESTORE INTEGRATION
// ==============================
let _firestoreDb = null;
let _knowledgeCache = null;
let _knowledgeCacheAt = 0;

function getFirestoreDb() {
  if (_firestoreDb) return _firestoreDb;
  try {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!sa) return null;
    const admin = require('firebase-admin');
    const cred = JSON.parse(sa);
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(cred), projectId: cred.project_id || 'chinhel' });
    _firestoreDb = admin.firestore();
    return _firestoreDb;
  } catch (e) { console.log('Firestore init failed:', e.message); return null; }
}

function flattenDoc(data) {
  if (!data) return '';
  const parts = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string' && v.trim()) parts.push(`${k}: ${v}`);
    else if (typeof v === 'object' && v !== null) parts.push(`${k}: ${JSON.stringify(v)}`);
    else if (v !== undefined && v !== null) parts.push(`${k}: ${String(v)}`);
  }
  return parts.join('\n');
}

async function getChinhelKnowledge() {
  if (_knowledgeCache && Date.now() - _knowledgeCacheAt < 10*60*1000) return _knowledgeCache;
  try {
    const db = getFirestoreDb();
    if (!db) return '';
    const snap = await db.collection('chinhel_knowledge').get();
    if (snap.empty) return '';
    const chunks = [];
snap.forEach(doc => {
  const d = doc.data();
  const t = flattenDoc(d);
  if (t) chunks.push(`[${doc.id}]\n${t}`);
});

    const combined = chunks.join('\n\n');
    if (!combined.trim()) return '';
    _knowledgeCache = combined;
    _knowledgeCacheAt = Date.now();
    console.log('Knowledge from Firestore chinhel_knowledge, docs:', snap.size);
    return combined;
  } catch (e) { console.log('Firestore fetch failed:', e.message); return ''; }
}

// ==============================
// LIVE WEB SEARCH (DuckDuckGo + Wikipedia)
// ==============================
async function searchWeb(query) {
  const parts = [];
  try {
    const r = await axios.get('https://api.duckduckgo.com/', { params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 }, timeout: 8000 });
    if (r.data.AbstractText) parts.push(`[DuckDuckGo] ${r.data.AbstractText}`);
    for (const t of (r.data.RelatedTopics || []).slice(0,3)) { if (t.Text) parts.push(`[DuckDuckGo] ${t.Text}`); }
  } catch (e) { console.log('DDG failed:', e.message); }

  for (const wiki of ['en', 'tl']) {
    try {
      const r = await axios.get(`https://${wiki}.wikipedia.org/w/api.php`, {
        params: { action: 'query', list: 'search', srsearch: query, srlimit: 2, format: 'json', origin: '*' },
        timeout: 8000,
        headers: { 'User-Agent': 'PabaonBot/1.0 (Jonel)' }
      });
      const results = r.data?.query?.search || [];
      for (const it of results) {
        const clean = (it.snippet || '').replace(/<[^>]+>/g, '').trim();
        if (clean) parts.push(`[Wikipedia ${wiki}] ${it.title}: ${clean} (https://${wiki}.wikipedia.org/wiki/${encodeURIComponent(it.title.replace(/ /g, '_'))})`);
      }
      if (results.length) break;
    } catch (e) { console.log(`Wikipedia ${wiki} failed:`, e.message); }
  }

  try {
    const r = await axios.get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(query), { timeout: 8000, headers: { 'User-Agent': 'PabaonBot/1.0' } });
    if (r.data?.extract) parts.push(`[Wikipedia Summary] ${r.data.extract.slice(0, 800)}`);
  } catch (e) {}

  return parts.join('\n- ');
}

function needsWebSearch(text) {
  const t = (text||'').toLowerCase();
  const keywords = ['ngayon','today','latest','bago','balita','news','presyo','price','magkano','sino nanalo','score','panahon','weather','bagyo','lindol','election','halalan','bukas','anong petsa','trending','viral','kailan'];
  return keywords.some(k => t.includes(k));
}

function looksLikeNewFact(text) {
  const t = (text||'').toLowerCase();
  const triggers = ['tandaan mo','dapat mong malaman','natapos na','tapos na ang','bagong','ngayon ay','ako si','kami ay','meron na ako','meron na kami','nagawa ko','umuwi na','graduate na','binili ko','nag-umpisa','nag-apply','nag-resign'];
  return triggers.some(k => t.includes(k));
}

async function autoLearn(userMsg, aiReply, source='messenger') {
  try {
    if (!looksLikeNewFact(userMsg)) return;
    if (!userMsg || userMsg.trim().length < 15) return;
    const db = getFirestoreDb();
    if (!db) { console.log('Auto-learn skipped: walang Firestore'); return; }
    await db.collection('chinhel_knowledge').add({
      type: 'auto_learned',
      source,
      text: userMsg.trim(),
      ai_reply: (aiReply||'').slice(0,500),
      createdAt: new Date(),
      approved: true, // <-- Auto-approve na agad
    });

    _knowledgeCache = null;
    console.log('Auto-learn saved to chinhel_knowledge:', userMsg.slice(0,80));
  } catch (e) { console.log('Auto-learn failed:', e.message); }
}

// ==============================
// MESSENGER WEBHOOKS
// ==============================
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
    const liveKnowledge = await getChinhelKnowledge();
    let webContext = '';
    if (needsWebSearch(userMsg)) {
      const w = await searchWeb(userMsg);
      if (w) webContext = `\n\nLIVE WEB SEARCH (gamitin mo ito, huwag mag-imbento ng bagong balita/presyo):\n${w}`;
    }
    const knowledgeBlock = liveKnowledge ? `\n\nIto ang totoong kwento ng may-ari na si Jonel mula sa chinhel_knowledge. Gamitin lang pag bagay, huwag ikwento lahat, huwag mag-imbento:\n${liveKnowledge}` : '';
    const reply = await callGroq([
      { role: 'system', content: `Ikaw ang admin ng Page na "Pabaon - daily nourishment for the soul". Sumagot ka ng Taglish, malumanay, parang kaibigan. Kung malungkot yung nag-message, makinig ka muna, wag ka agad mag-sermon. Kung humingi ng prayer, mag-offer ka ng maikling prayer. Wag ka magpanggap na pastor o therapist. Kung mabigat na yung sinasabi (depression, self-harm), sabihin mo na hindi ka professional at i-encourage mo sila mag-usap sa taong pinagkakatiwalaan nila o sa professional. Maikli lang, 3-5 sentences.${knowledgeBlock}${webContext}` },
      { role: 'user', content: userMsg }
    ], 0.7, 250);
    autoLearn(userMsg, reply, 'messenger').catch(()=>{});
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
  const liveKnowledge = await getChinhelKnowledge();
  const knowledgeBlock = liveKnowledge ? `\n\nIto ang totoong kwento ng may-ari na si Jonel mula sa chinhel_knowledge. Pwede kumuha ng isang maliit na hugot lang pag bagay, huwag ikwento lahat, huwag mag-imbento:\n${liveKnowledge}` : '';
  const post = await callGroq([
    {
      role: 'system',
      content: `Ikaw ang writer ng Facebook Page na "Pabaon - daily nourishment for the soul". Ngayon, ang MOOD mo ay: ${randomMood}. Sundin mo yung mood na yan. Style: Taglish, parang tao, hindi AI. Hindi preachy. Bawal mag imbento ng Bible verse. Format: Simula sa "Pabaon for today:" - 3-5 sentences lang - Tapos 1 tanong sa dulo - 2-3 hashtags lang: #Pabaon #DailyNourishment - 1 emoji lang max.${knowledgeBlock}`
    },
    { role: 'user', content: `Gawa ka ng post for today. Theme: ${theme}. Mood: ${randomMood}.` }
  ], 0.95, 350);
  return post;
}

async function autoPostDaily() {
  if (!PAGE_ID || !PAGE_TOKEN) { console.log('Auto-post skipped: walang PAGE_ID/PAGE_TOKEN'); return 'skipped'; }
  const postText = await generatePabaon();
  const { fileName, url } = getRotationImageForToday();
  try {
    const res = await axios.post(`https://graph.facebook.com/v21.0/${PAGE_ID}/photos`, {
      url: url,
      caption: postText,
      access_token: PAGE_TOKEN
    });
    console.log('Pabaon Posted with photo:', fileName, 'FB id:', res.data.id);
    return postText + '\n\n[Photo: ' + fileName + ']';
  } catch (photoErr) {
    console.log('Photo post failed, fallback to text:', photoErr.response?.data?.error?.message || photoErr.message);
    await axios.post(`https://graph.facebook.com/v21.0/${PAGE_ID}/feed`, { message: postText, access_token: PAGE_TOKEN });
    console.log('Pabaon Posted (text fallback):', postText);
    return postText;
  }
}

// ==============================
// AUTO-POST SCHEDULER (8:00 AM Manila Daily)
// ==============================
function getNext8amManilaMs() {
  const now = new Date();
  const manilaNow = new Date(now.getTime() + (8*60 + now.getTimezoneOffset())*60000);
  const next = new Date(manilaNow);
  next.setHours(8, 0, 0, 0);
  if (next <= manilaNow) next.setDate(next.getDate() + 1);
  return next.getTime() - manilaNow.getTime();
}

function scheduleDailyPost() {
  const delay = getNext8amManilaMs();
  console.log('Next Pabaon auto-post in', Math.round(delay/60000), 'minutes (8AM Manila)');
  setTimeout(async () => {
    try { await autoPostDaily(); } catch (e) { console.log('Auto-post failed:', e.message); }
    setInterval(async () => {
      try { await autoPostDaily(); } catch (e) { console.log('Auto-post interval failed:', e.message); }
    }, 24*60*60*1000);
  }, delay);
}

// ==============================
// SERVER ENDPOINTS
// ==============================
app.get('/post-now', async (req, res) => {
  try {
    const posted = await autoPostDaily();
    res.send('Pabaon posted na! <br><br>' + posted);
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).send('May error: ' + JSON.stringify(e.response?.data || e.message));
  }
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    groqKeys: GROQ_KEYS.length,
    mainModel: MODEL_MAIN,
    fallbackModel: MODEL_FALLBACK,
    hasFirestore: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    hasPage: !!PAGE_ID,
    webSearch: 'DuckDuckGo + Wikipedia',
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => { res.send('Pabaon Bot is running...'); });

// IDAGDAG ANG ENDPOINT PARA SA META DATA DELETION
app.get('/data-deletion', (req, res) => {
  res.send('Data deletion instructions: To delete your data, please message our page directly.');
});

scheduleDailyPost();
app.listen(process.env.PORT || 3000, () => {
  console.log('Pabaon Bot running...');
  console.log('Keys found:', GROQ_KEYS.length);
  console.log('Main model:', MODEL_MAIN, '| Fallback:', MODEL_FALLBACK);
});

