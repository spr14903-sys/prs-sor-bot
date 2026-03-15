const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================
const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ============================================================
// LOAD SOR DATABASE
// ============================================================
const SOR_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'sor_data.json'), 'utf8'));
console.log(`✅ Loaded ${SOR_DATA.length} SOR codes`);

// Build search index
const SOR_MAP = {};
SOR_DATA.forEach(d => { SOR_MAP[d.c] = d; });

// ============================================================
// CLAUDE AI CLIENT
// ============================================================
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const SOR_NAMING_GUIDE = `
SOR CODE NAMING CONVENTIONS:
- Plasterwork: "WALL:HACK REPLASTER" = hack off + replaster. "WALL:SKIM" = apply skim only. "IN PATCH" = small area (IT price). Without "in patch" = per SM.
- "WALL:HACK OFF RENDER" (421001/421003) = remove render only, no replaster
- "WALL:TWO COATS DUB OUT" (411113/411115) = float and set without hacking off first
- Painting: "ROOM:REDECORATE" (450001) = full room (ceiling+walls emulsion + gloss on wood). "ROOM:REDECORATE CEILING" (450607) = ceiling only.
- "WALLS AND CEILINGS:APPLY MIST 2 COATS EMULSION" (442001) = per SM painting
- Carpentry: "FRAME:SPLICE" = repair section. "FRAME:RENEW" = replace whole frame
- Plumbing: "WC CISTERN/PAN:OVERHAUL" (630573) = investigate/repair/fix any WC issue
- "SEALANT:RENEW TO BATH" (631501) = silicone sealant around bath
- "BATH PANEL:RENEW" = replace bath panel
- Ceiling: "CEILING:FIX DOUBLE PLASTERBOARD" = new double layer. "CEILING:HACK RENEW" = remove old + replaster
- IT = Item (fixed price). SM = Square Metre. LM = Linear Metre. NO = Number.
- Custom items: "de-hum/dehumidifier" → custom price item. "locate/investigate leak" → suggest 630573.
`;

// ============================================================
// SOR MATCHING ENGINE
// ============================================================
async function matchSOR(description, isRomanian = false) {
  const prompt = `You are a UK social housing SOR (Schedule of Rates) pricing expert.

${SOR_NAMING_GUIDE}

The user describes repair/maintenance work${isRomanian ? ' (may be in Romanian - translate to English first)' : ''}.

Analyze this job description and break it into individual tasks. For each task, suggest the TOP 3 most relevant SOR codes from the database.

IMPORTANT: Return ONLY valid JSON, no markdown, no backticks:
{
  "tasks": [
    {
      "description": "English description of the task",
      "original": "original text if Romanian",
      "suggestions": [
        {"code": 123456, "reason": "why this code matches"},
        {"code": 123457, "reason": "why this code matches"},
        {"code": 123458, "reason": "why this code matches"}
      ]
    }
  ]
}

Here are ALL available SOR codes (code, description, element, unit, rate):
${SOR_DATA.map(d => `${d.c}|${d.s}|${d.e}|${d.u}|£${d.r}`).join('\n')}

USER'S JOB DESCRIPTION:
${description}`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text;
    // Clean any markdown formatting
    const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('AI matching error:', e.message);
    return { error: e.message };
  }
}

// Search SOR by keyword
function searchSOR(query) {
  const q = query.toUpperCase();
  return SOR_DATA.filter(d => 
    d.s.toUpperCase().includes(q) || 
    String(d.c).includes(q) ||
    d.e.toUpperCase().includes(q)
  ).slice(0, 10);
}

// ============================================================
// TELEGRAM BOT
// ============================================================
let bot;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log('✅ Telegram bot started');

  // User sessions for building quotes
  const sessions = {};

  function getSession(chatId) {
    if (!sessions[chatId]) {
      sessions[chatId] = { items: [], address: '', mode: 'chat' };
    }
    return sessions[chatId];
  }

  // /start command
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
      `🏗️ *PRS SOR Pricing Agent*\n\n` +
      `Salut! Sunt agentul tău de prețuri SOR.\n\n` +
      `*Ce pot face:*\n` +
      `📝 Trimite-mi descrierea lucrărilor și îți dau coduri SOR cu prețuri\n` +
      `🔍 /search KEYWORD - caută cod SOR\n` +
      `📋 /code 630573 - detalii despre un cod\n` +
      `💰 /quote - începe o cotație nouă\n` +
      `📊 /list - vezi cotația curentă\n` +
      `📥 /export - exportă Excel\n` +
      `🗑️ /clear - șterge cotația\n` +
      `❓ /help - ajutor\n\n` +
      `Sau pur și simplu scrie ce lucrări ai de făcut!`,
      { parse_mode: 'Markdown' }
    );
  });

  // /help command
  bot.onText(/\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
      `📖 *Cum să folosești agentul:*\n\n` +
      `*Mod rapid:* Scrie direct descrierea lucrărilor:\n` +
      `"Repara tavan baie, skim si vopsire"\n` +
      `"Hack off plaster wall 12sqm, replaster and paint"\n\n` +
      `*Mod cotație:*\n` +
      `1. /quote - începe cotație nouă\n` +
      `2. Scrie lucrările\n` +
      `3. Selectez coduri (reply cu numărul)\n` +
      `4. /export - descarcă Excel\n\n` +
      `*Căutare:*\n` +
      `/search bath panel\n` +
      `/search 630573\n` +
      `/code 450001\n\n` +
      `*Limbă:* Poți scrie în română sau engleză - detectez automat! 🇷🇴🇬🇧`,
      { parse_mode: 'Markdown' }
    );
  });

  // /search command
  bot.onText(/\/search (.+)/, (msg, match) => {
    const results = searchSOR(match[1]);
    if (results.length === 0) {
      bot.sendMessage(msg.chat.id, '❌ Nu am găsit nimic. Încearcă alt cuvânt cheie.');
      return;
    }
    const text = results.map(d => 
      `🔹 *${d.c}* - ${d.s}\n   ${d.u} | £${d.r.toFixed(2)}`
    ).join('\n\n');
    bot.sendMessage(msg.chat.id, `🔍 *Rezultate pentru "${match[1]}":*\n\n${text}`, 
      { parse_mode: 'Markdown' });
  });

  // /code command
  bot.onText(/\/code (\d+)/, (msg, match) => {
    const code = parseInt(match[1]);
    const d = SOR_MAP[code];
    if (!d) {
      bot.sendMessage(msg.chat.id, `❌ Codul ${code} nu există în baza de date.`);
      return;
    }
    bot.sendMessage(msg.chat.id,
      `📋 *Cod SOR: ${d.c}*\n\n` +
      `📝 ${d.s}\n` +
      `📂 ${d.e} → ${d.x}\n` +
      `📏 Unitate: *${d.u}*\n` +
      `💰 Preț (subby): *£${d.r.toFixed(2)}*`,
      { parse_mode: 'Markdown' }
    );
  });

  // /quote command
  bot.onText(/\/quote/, (msg) => {
    const session = getSession(msg.chat.id);
    session.items = [];
    session.address = '';
    session.mode = 'quote';
    bot.sendMessage(msg.chat.id,
      `📋 *Cotație nouă*\n\n` +
      `Scrie adresa proprietății (sau "skip" pentru a sări):`,
      { parse_mode: 'Markdown' }
    );
    session.waitingAddress = true;
  });

  // /list command
  bot.onText(/\/list/, (msg) => {
    const session = getSession(msg.chat.id);
    if (session.items.length === 0) {
      bot.sendMessage(msg.chat.id, '📋 Cotația e goală. Scrie descrierea lucrărilor sau /quote pentru a începe.');
      return;
    }
    let total = 0;
    const lines = session.items.map((item, i) => {
      const price = item.qty * item.rate;
      total += price;
      return `${i + 1}. *${item.code}* - ${item.desc}\n   ${item.qty} x £${item.rate.toFixed(2)} = *£${price.toFixed(2)}*`;
    });
    if (session.address) lines.unshift(`📍 *${session.address}*\n`);
    lines.push(`\n💰 *TOTAL: £${total.toFixed(2)}*`);
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // /clear command
  bot.onText(/\/clear/, (msg) => {
    const session = getSession(msg.chat.id);
    session.items = [];
    session.address = '';
    bot.sendMessage(msg.chat.id, '🗑️ Cotația a fost ștearsă.');
  });

  // /export command  
  bot.onText(/\/export/, async (msg) => {
    const session = getSession(msg.chat.id);
    if (session.items.length === 0) {
      bot.sendMessage(msg.chat.id, '📋 Cotația e goală. Adaugă lucrări mai întâi.');
      return;
    }
    bot.sendMessage(msg.chat.id, '⏳ Generez Excel...');
    
    // Generate CSV (simple, works everywhere)
    let csv = 'Code,Description,Qty,Unit,Unit Price,Total\n';
    let total = 0;
    session.items.forEach(item => {
      const price = item.qty * item.rate;
      total += price;
      csv += `${item.code},"${item.desc}",${item.qty},${item.uom},${item.rate.toFixed(2)},${price.toFixed(2)}\n`;
    });
    csv += `,,,,TOTAL:,${total.toFixed(2)}\n`;
    
    const filename = `PRS_Quotation_${new Date().toISOString().slice(0, 10)}.csv`;
    const buffer = Buffer.from(csv, 'utf8');
    
    bot.sendDocument(msg.chat.id, buffer, {
      caption: `📊 Cotație PRS - ${session.items.length} items - £${total.toFixed(2)}`
    }, {
      filename: filename,
      contentType: 'text/csv'
    });
  });

  // /add command - quick add by code
  bot.onText(/\/add (\d+)\s*(?:x\s*)?(\d+(?:\.\d+)?)?/, (msg, match) => {
    const code = parseInt(match[1]);
    const qty = parseFloat(match[2]) || 1;
    const d = SOR_MAP[code];
    if (!d) {
      bot.sendMessage(msg.chat.id, `❌ Codul ${code} nu există.`);
      return;
    }
    const session = getSession(msg.chat.id);
    session.items.push({
      code: d.c, desc: d.s, uom: d.u, rate: d.r, qty: qty
    });
    const price = qty * d.r;
    bot.sendMessage(msg.chat.id,
      `✅ Adăugat: *${d.c}* - ${d.s}\n${qty} x £${d.r.toFixed(2)} = *£${price.toFixed(2)}*\n\n📋 Total items: ${session.items.length} | /list pentru a vedea tot`,
      { parse_mode: 'Markdown' }
    );
  });

  // /remove command
  bot.onText(/\/remove (\d+)/, (msg, match) => {
    const session = getSession(msg.chat.id);
    const idx = parseInt(match[1]) - 1;
    if (idx < 0 || idx >= session.items.length) {
      bot.sendMessage(msg.chat.id, `❌ Index invalid. Ai ${session.items.length} items.`);
      return;
    }
    const removed = session.items.splice(idx, 1)[0];
    bot.sendMessage(msg.chat.id, `🗑️ Șters: ${removed.code} - ${removed.desc}`);
  });

  // Handle all other messages (AI matching)
  bot.on('message', async (msg) => {
    // Skip commands
    if (msg.text && msg.text.startsWith('/')) return;
    if (!msg.text && !msg.photo) return;

    const session = getSession(msg.chat.id);

    // Handle address input for quote mode
    if (session.waitingAddress) {
      session.waitingAddress = false;
      if (msg.text && msg.text.toLowerCase() !== 'skip') {
        session.address = msg.text;
        bot.sendMessage(msg.chat.id, `📍 Adresă: *${session.address}*\n\nAcum scrie descrierea lucrărilor:`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(msg.chat.id, 'OK, fără adresă. Scrie descrierea lucrărilor:');
      }
      return;
    }

    // Handle photo
    if (msg.photo) {
      bot.sendMessage(msg.chat.id, '📷 Funcția foto vine în curând! Deocamdată, descrie lucrările în text.');
      return;
    }

    // Check if it's a selection (number reply to suggestions)
    if (msg.reply_to_message && /^\d+$/.test(msg.text)) {
      // Handle selection of suggested codes
      return;
    }

    // Detect Romanian
    const isRomanian = /[ăîâșț]|si |pe |cu |din |pentru |este |sau |dar |dupa /i.test(msg.text);

    // AI Matching
    bot.sendMessage(msg.chat.id, '🔍 Analizez lucrările...');
    
    try {
      const result = await matchSOR(msg.text, isRomanian);
      
      if (result.error) {
        bot.sendMessage(msg.chat.id, `❌ Eroare AI: ${result.error}`);
        return;
      }

      if (!result.tasks || result.tasks.length === 0) {
        bot.sendMessage(msg.chat.id, '❌ Nu am putut identifica lucrări din descriere. Încearcă să fii mai specific.');
        return;
      }

      for (const task of result.tasks) {
        let text = `📌 *${task.description}*`;
        if (task.original) text += `\n_(${task.original})_`;
        text += '\n\n';

        task.suggestions.forEach((sug, i) => {
          const d = SOR_MAP[sug.code];
          if (d) {
            text += `${i + 1}️⃣ *${d.c}* — ${d.s}\n`;
            text += `   📏 ${d.u} | 💰 *£${d.r.toFixed(2)}*\n`;
            text += `   💡 ${sug.reason}\n`;
            text += `   ➕ /add ${d.c}\n\n`;
          }
        });

        bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
      }

      bot.sendMessage(msg.chat.id,
        `💡 *Adaugă coduri la cotație:*\n` +
        `Scrie /add CODE x QTY\n` +
        `Ex: /add 630573 x 2\n\n` +
        `/list - vezi cotația | /export - descarcă`,
        { parse_mode: 'Markdown' }
      );

    } catch (e) {
      console.error('Message handling error:', e);
      bot.sendMessage(msg.chat.id, `❌ Eroare: ${e.message}`);
    }
  });

} else {
  console.log('⚠️ No TELEGRAM_TOKEN set - bot disabled');
}

// ============================================================
// WEB APP (Express)
// ============================================================
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// API: Search SOR codes
app.get('/api/search', (req, res) => {
  const q = req.query.q || '';
  if (q.length < 2) return res.json([]);
  res.json(searchSOR(q));
});

// API: Get SOR code details
app.get('/api/code/:code', (req, res) => {
  const d = SOR_MAP[parseInt(req.params.code)];
  if (!d) return res.status(404).json({ error: 'Not found' });
  res.json(d);
});

// API: AI Match
app.post('/api/match', async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'No description' });
  const result = await matchSOR(description, true);
  res.json(result);
});

// API: Chat (conversational)
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'No message' });

  try {
    const messages = (history || []).concat([{ role: 'user', content: message }]);
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are a UK social housing SOR pricing expert for PRS Construction Group. 
You help find the right SOR codes and prices (subby rates at 75% of SOR).
You speak both English and Romanian fluently. Reply in the same language the user writes.
${SOR_NAMING_GUIDE}
When suggesting codes, always include: code number, description, unit, and subby price.
Available SOR codes summary: ${SOR_DATA.length} codes covering Groundworks, Brickwork, Roofing, Carpentry, Plasterwork, Painting, Plumbing, Electrical, etc.`,
      messages: messages
    });

    res.json({ 
      reply: response.content[0].text,
      role: 'assistant'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// API: Get all SOR data (for web app)
app.get('/api/sor', (req, res) => {
  res.json(SOR_DATA);
});

// Serve web app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Web server running on port ${PORT}`);
  console.log(`✅ Open http://localhost:${PORT} for web app`);
});
