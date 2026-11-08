#!/usr/bin/env python3
"""
PABAON INJECTOR - Malinis na injector
Gamit: python3 inject_pabaon.py base_server.js server.js
- Base mo yung binigay mo: GROQ_KEYS, gpt-oss-120b, image rotation
- Idadagdag lang: Firestore 100% + Auto-Learn + DuckDuckGo/Wikipedia + Auto-Post Scheduler + /health
- Idempotent: pag tinakbo mo ulit, hindi siya dodoble
- Walang hardcoded knowledge, walang Tavily, walang llama-3.3
"""
import sys, subprocess

BASE_PATH = sys.argv[1] if len(sys.argv) > 1 else "base_server.js"
OUT_PATH = sys.argv[2] if len(sys.argv) > 2 else "server.js"

FIRESTORE_BLOCK = """
// ==============================
// FIRESTORE - 100% Firestore, WALANG hardcoded knowledge
// Project: chinhel, Collection: chinhel_knowledge
// Kailangan ng FIREBASE_SERVICE_ACCOUNT_JSON sa env (Render)
// Kung wala, babalik ng '' - hindi mag-iimbento si Pabaon
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
    if (typeof v === 'string' && v.trim()) parts.push(k + ': ' + v);
    else if (typeof v === 'object' && v !== null) parts.push(k + ': ' + JSON.stringify(v));
    else if (v !== undefined && v !== null) parts.push(k + ': ' + String(v));
  }
  return parts.join(String.fromCharCode(10));
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
      if (d && d.type === 'auto_learned' && d.approved !== true) return;
      const t = flattenDoc(d);
      if (t) chunks.push('[' + doc.id + ']' + String.fromCharCode(10) + t);
    });
    const combined = chunks.join(String.fromCharCode(10) + String.fromCharCode(10));
    if (!combined.trim()) return '';
    _knowledgeCache = combined;
    _knowledgeCacheAt = Date.now();
    console.log('Knowledge from Firestore chinhel_knowledge, docs:', snap.size);
    return combined;
  } catch (e) { console.log('Firestore fetch failed:', e.message); return ''; }
}
"""

SEARCH_BLOCK = """
// ==============================
// AUTO-LEARN + LIVE WEB SEARCH (DuckDuckGo + Wikipedia lang, walang Tavily)
// ==============================
async function searchWeb(query) {
  const parts = [];
  try {
    const r = await axios.get('https://api.duckduckgo.com/', { params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 }, timeout: 8000 });
    if (r.data.AbstractText) parts.push('[DuckDuckGo] ' + r.data.AbstractText);
    for (const t of (r.data.RelatedTopics || []).slice(0, 3)) { if (t.Text) parts.push('[DuckDuckGo] ' + t.Text); }
  } catch (e) { console.log('DDG failed:', e.message); }
  for (const wiki of ['en', 'tl']) {
    try {
      const r = await axios.get('https://' + wiki + '.wikipedia.org/w/api.php', {
        params: { action: 'query', list: 'search', srsearch: query, srlimit: 2, format: 'json', origin: '*' },
        timeout: 8000, headers: { 'User-Agent': 'PabaonBot/1.0 (Jonel)' }
      });
      const results = (r.data && r.data.query && r.data.query.search) || [];
      for (const it of results) {
        const clean = (it.snippet || '').replace(/<[^>]+>/g, '').trim();
        if (clean) parts.push('[Wikipedia ' + wiki + '] ' + it.title + ': ' + clean + ' (https://' + wiki + '.wikipedia.org/wiki/' + encodeURIComponent(it.title.replace(/ /g, '_')) + ')');
      }
      if (results.length) break;
    } catch (e) { console.log('Wikipedia ' + wiki + ' failed:', e.message); }
  }
  try {
    const r = await axios.get('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(query), { timeout: 8000, headers: { 'User-Agent': 'PabaonBot/1.0' } });
    if (r.data && r.data.extract) parts.push('[Wikipedia Summary] ' + r.data.extract.slice(0, 800));
  } catch (e) {}
  return parts.join(String.fromCharCode(10) + '- ');
}
function needsWebSearch(text) {
  const t = (text || '').toLowerCase();
  const keywords = ['ngayon','today','latest','bago','balita','news','presyo','price','magkano','sino nanalo','score','panahon','weather','bagyo','lindol','election','halalan','bukas','anong petsa','trending','viral','kailan'];
  return keywords.some(k => t.includes(k));
}
function looksLikeNewFact(text) {
  const t = (text || '').toLowerCase();
  const triggers = ['tandaan mo','dapat mong malaman','natapos na','tapos na ang','bagong','ngayon ay','ako si','kami ay','meron na ako','meron na kami','nagawa ko','umuwi na','graduate na','binili ko','nag-umpisa','nag-apply','nag-resign'];
  return triggers.some(k => t.includes(k));
}
async function autoLearn(userMsg, aiReply, source) {
  try {
    if (!looksLikeNewFact(userMsg)) return;
    if (!userMsg || userMsg.trim().length < 15) return;
    const db = getFirestoreDb();
    if (!db) { console.log('Auto-learn skipped: walang Firestore'); return; }
    await db.collection('chinhel_knowledge').add({
      type: 'auto_learned', source: source || 'messenger',
      text: userMsg.trim(), ai_reply: (aiReply || '').slice(0, 500),
      createdAt: new Date(), approved: false,
    });
    _knowledgeCache = null;
    console.log('Auto-learn saved to chinhel_knowledge:', userMsg.slice(0, 80));
  } catch (e) { console.log('Auto-learn failed:', e.message); }
}
"""

SCHEDULER_BLOCK = """
// ==============================
// AUTO-POST SCHEDULER - 8:00 AM Manila araw-araw
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
"""

def main():
    txt = open(BASE_PATH).read()
    # 1. Kung may lumang inject na, tanggalin muna para hindi dumoble - hanapin yung markers
    # Simpleng paraan: kung may getChinhelKnowledge na, sabihin na naka-inject na at i-overwrite ng malinis na base
    # Kaya ang injector na ito, dapat ang base ay yung ORIGINAL base mo, hindi yung naka-inject na.
    if "getChinhelKnowledge" in txt or "searchWeb" in txt:
        print("BABALA: Yung base mo may inject na. Gumamit ka ng ORIGINAL base (yung binigay mo kanina) para malinis.")
        print("Hindi ko ito papatungan para hindi dumoble. I-save mo muna yung original base as base_server.js")
        return
    # 2. Inject Firestore + Search bago yung app.get('/webhook'
    assert "app.get('/webhook'" in txt, "Hindi mahanap yung app.get('/webhook' - iba yung base mo"
    txt = txt.replace("app.get('/webhook'", FIRESTORE_BLOCK + SEARCH_BLOCK + "\napp.get('/webhook'", 1)
    # 3. Inject Scheduler bago yung app.get('/post-now'
    assert "app.get('/post-now'" in txt, "Hindi mahanap yung app.get('/post-now'"
    txt = txt.replace("app.get('/post-now'", SCHEDULER_BLOCK + "\napp.get('/post-now'", 1)
    # 4. Patch askGroqReply: kunin knowledge + web search, auto-learn pagkatapos
    old_reply = """async function askGroqReply(userMsg) {
  try {
    const reply = await callGroq(["""
    new_reply = """async function askGroqReply(userMsg) {
  try {
    const liveKnowledge = (await getChinhelKnowledge()).slice(0, 1500);
    let webContext = '';
    if (needsWebSearch(userMsg)) {
      const w = await searchWeb(userMsg);
      if (w) webContext = String.fromCharCode(10) + String.fromCharCode(10) + 'LIVE WEB SEARCH (DuckDuckGo + Wikipedia, huwag mag-imbento):' + String.fromCharCode(10) + w;
    }
    const knowledgeBlock = liveKnowledge ? String.fromCharCode(10) + String.fromCharCode(10) + 'Totoong kwento ni Jonel mula sa chinhel_knowledge. Gamitin lang pag bagay, huwag ikwento lahat, huwag mag-imbento:' + String.fromCharCode(10) + liveKnowledge : '';
    const reply = await callGroq(["""
    assert old_reply in txt, "Hindi mahanap yung askGroqReply - iba yung base"
    txt = txt.replace(old_reply, new_reply, 1)
    # Lagyan ng knowledgeBlock + webContext sa system prompt ng askGroqReply
    old_sys = "Maikli lang, 3-5 sentences.` },"
    new_sys = "Maikli lang, 3-5 sentences.${knowledgeBlock}${webContext}` },"
    # Yung base mo may backtick system prompt, hanapin yung exact
    if old_sys in txt:
        txt = txt.replace(old_sys, new_sys, 1)
    else:
        print("BABALA: Hindi mahanap yung system prompt ng askGroqReply, manual check kailangan")
    # Auto-learn pagkatapos ng reply
    old_ret = "    return reply;\n  } catch (err) {"
    if old_ret in txt:
        txt = txt.replace(old_ret, "    autoLearn(userMsg, reply, 'messenger').catch(()=>{});\n    return reply;\n  } catch (err) {", 1)
    # 5. Patch generatePabaon: kunin knowledge
    old_gen = "async function generatePabaon() {"
    new_gen = """async function generatePabaon() {
  const liveKnowledge2 = (await getChinhelKnowledge()).slice(0, 1500);
  const knowledgeBlock2 = liveKnowledge2 ? String.fromCharCode(10) + String.fromCharCode(10) + 'Totoong kwento ni Jonel mula sa chinhel_knowledge. Pwede kumuha ng isang maliit na hugot lang pag bagay, huwag ikwento lahat:' + String.fromCharCode(10) + liveKnowledge2 : '';"""
    txt = txt.replace(old_gen, new_gen, 1)
    # Sa system prompt ng generatePabaon, idagdag knowledgeBlock2
    old_gen_sys = "- 1 emoji lang max.`"
    if old_gen_sys in txt:
        txt = txt.replace(old_gen_sys, "- 1 emoji lang max.${knowledgeBlock2}`", 1)
    # 5a. FIX CHAT - PURE SENDING LANG: sagutin agad si Facebook, saka mag-isip sa background
    # Dati: hinihintay ni Facebook si Groq (20-30s) bago mag-EVENT_RECEIVED -> timeout -> puro sending lang
    # Ngayon: EVENT_RECEIVED agad (1s), saka sa background mag-askGroqReply + sendMessage
    old_webhook_full = """app.post('/webhook', async (req, res) => {
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
});"""
    new_webhook_full = """app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object === 'page') {
    res.status(200).send('EVENT_RECEIVED agad'); // Sagot agad kay Facebook, huwag hintayin si Groq
    // Sa background na mag-isip at mag-reply
    (async () => {
      for (const entry of body.entry) {
        if (entry.messaging) {
          for (const event of entry.messaging) {
            if (event.message && event.message.text && !event.message.is_echo) {
              const userMsg = event.message.text;
              console.log('User:', userMsg, '| sender:', event.sender.id);
              try {
                const aiReply = await askGroqReply(userMsg);
                console.log('AI reply:', aiReply);
                await sendMessage(event.sender.id, aiReply);
                console.log('Sent to:', event.sender.id);
              } catch (e) { console.log('sendMessage failed:', e.response?.data?.error?.message || e.message); }
            }
          }
        }
      }
    })().catch(e => console.log('Webhook background failed:', e.message));
  } else {
    res.sendStatus(404);
  }
});"""
    if old_webhook_full in txt:
        txt = txt.replace(old_webhook_full, new_webhook_full, 1)
        print("patched webhook to immediate response")
    else:
        print("webhook full pattern NOT found")
    # 5a. FIX CHAT: huwag mag-crash yung webhook pag nag-error yung sendMessage
    old_webhook = "            const aiReply = await askGroqReply(userMsg);\n            await sendMessage(event.sender.id, aiReply);"
    new_webhook = "            try { const aiReply = await askGroqReply(userMsg); console.log('AI reply:', aiReply); await sendMessage(event.sender.id, aiReply); } catch (e) { console.log('sendMessage failed:', e.response?.data?.error?.message || e.message); }"
    if old_webhook in txt:
        txt = txt.replace(old_webhook, new_webhook, 1)
        print("patched webhook sendMessage try/catch")
    else:
        print("webhook pattern NOT found - check base")
    # 5b. FIX PUTOL: taasan max_tokens kasi yung gpt-oss nag-reasoning muna, nauubos 350 tokens
    # Base mo 350 lang, gagawin natin 900 para hindi maputol yung post
    txt = txt.replace("], 0.95, 350)", "], 0.95, 900)", 1)
    txt = txt.replace("], 0.7, 250)", "], 0.7, 600)", 1)
    # 5c. FIX PUTOL: kung naputol pa rin yung post (walang . ? ! sa dulo o may bukas na quote), ayusin bago i-post
    # Ilalagay natin sa autoPostDaily: kung hindi nagtatapos sa . ? !, tanggalin yung huling putol na sentence
    old_post = "async function autoPostDaily() {"
    new_post = """async function cleanPostText(t) {
  let s = (t || '').trim();
  // Tanggalin yung bukas na quote na walang sarado
  const openQuotes = (s.match(/\u201c/g) || []).length - (s.match(/\u201d/g) || []).length;
  if (openQuotes > 0) s = s.replace(/\u201c[^\u201d]*$/, '').trim();
  // Kung hindi nagtatapos sa . ? !, putulin sa huling buong sentence
  if (!/[.!?]$/.test(s)) {
    const lastEnd = Math.max(s.lastIndexOf('.'), s.lastIndexOf('!'), s.lastIndexOf('?'));
    if (lastEnd > 30) s = s.slice(0, lastEnd + 1).trim();
  }
  // Siguraduhin may tanong at hashtags sa dulo kung nawala dahil sa pagputol
  if (!s.includes('#Pabaon')) s += ' #Pabaon #DailyNourishment';
  return s;
}
async function autoPostDaily() {"""
    if old_post in txt and "cleanPostText" not in txt:
        txt = txt.replace(old_post, new_post, 1)
        print("added cleanPostText")
    # Gamitin yung cleanPostText sa autoPostDaily: postText = cleanPostText(await generatePabaon())
    txt = txt.replace("  const postText = await generatePabaon();", "  const postText = cleanPostText(await generatePabaon());", 1)
    print("patched autoPostDaily to use cleanPostText")
    # 5d. FIX CHAT: balutin yung sendMessage para hindi mag-crash yung webhook pag nag-error si FB
    # At lagyan ng /test-chat para ma-test mo yung chat nang hindi nagme-message sa Page
    if "/test-chat" not in txt:
        txt = txt.replace("app.get('/post-now'", "app.get('/test-chat', async (req, res) => { try { const q = req.query.q || 'Hello, kamusta ka?'; const r = await askGroqReply(q); res.json({ ok: true, question: q, reply: r }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });\n\napp.get('/post-now'", 1)
        print("added /test-chat")
    # 6. Guard sa autoPostDaily
    txt = txt.replace("async function autoPostDaily() {\n  const postText", "async function autoPostDaily() {\n  if (!PAGE_ID || !PAGE_TOKEN) { console.log('Auto-post skipped: walang PAGE_ID/PAGE_TOKEN'); return 'skipped'; }\n  const postText", 1)
    # 7. Health + Scheduler start
    if "/health" not in txt:
        txt = txt.replace("app.get('/', (req, res)", "app.get('/health', (req, res) => { res.json({ ok: true, groqKeys: GROQ_KEYS.length, mainModel: MODEL_MAIN, fallbackModel: MODEL_FALLBACK, hasFirestore: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON, hasPage: !!PAGE_ID, webSearch: 'DuckDuckGo + Wikipedia', time: new Date().toISOString() }); });\n\napp.get('/', (req, res)", 1)
    if "scheduleDailyPost();" not in txt:
        txt = txt.replace("app.listen(process.env.PORT", "scheduleDailyPost();\napp.listen(process.env.PORT", 1)
    open(OUT_PATH, "w").write(txt)
    print(f"OK: {BASE_PATH} -> {OUT_PATH} ({len(txt)} chars)")
    r = subprocess.run(["node", "--check", OUT_PATH], capture_output=True, text=True)
    print(r.stderr or "node --check OK")
    for k in ["GROQ_KEYS","gpt-oss-120b","getRotationImageForToday","getChinhelKnowledge","autoLearn","searchWeb","scheduleDailyPost","/health","chinhel_knowledge"]:
        print(f"  {k}: {'YES' if k in txt else 'MISSING'}")
    print("  hardcoded tigdas:", "tigdas na tigre" in txt)
    print("  Tavily:", "TAVILY" in txt)
    print("  llama-3.3:", "llama-3.3" in txt)

if __name__ == "__main__":
    main()
