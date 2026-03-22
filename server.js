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
// SOR MATCHING ENGINE (2-step: categorize then match)
// ============================================================

// Build category index
const SOR_BY_ELEMENT = {};
SOR_DATA.forEach(d => {
  if (!SOR_BY_ELEMENT[d.e]) SOR_BY_ELEMENT[d.e] = [];
  SOR_BY_ELEMENT[d.e].push(d);
});
const ALL_ELEMENTS = Object.keys(SOR_BY_ELEMENT);

async function matchSOR(description, isRomanian = false) {
  try {
    // STEP 1: Categorize - identify which SOR categories are relevant
    const step1 = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: `You categorize repair work into SOR database categories.
${isRomanian ? 'The description may be in Romanian - translate first.' : ''}

Available categories: ${ALL_ELEMENTS.join(', ')}

Job description: "${description}"

Break into tasks. For each task pick 1-3 relevant categories.
Return ONLY JSON, no markdown:
{"tasks":[{"description":"English description","original":"original if Romanian","categories":["Cat1","Cat2"]}]}` }]
    });

    const step1Text = step1.content[0].text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const step1Result = JSON.parse(step1Text);

    if (!step1Result.tasks || step1Result.tasks.length === 0) {
      return { error: 'Could not identify tasks' };
    }

    // STEP 2: For each task, match against filtered SOR codes
    const allTasks = [];
    for (const task of step1Result.tasks) {
      // Get relevant codes only
      let relevantCodes = [];
      for (const cat of task.categories) {
        if (SOR_BY_ELEMENT[cat]) {
          relevantCodes = relevantCodes.concat(SOR_BY_ELEMENT[cat]);
        }
      }
      // Fallback: fuzzy match category names
      if (relevantCodes.length === 0) {
        for (const cat of task.categories) {
          const catLower = cat.toLowerCase();
          for (const el of ALL_ELEMENTS) {
            if (el.toLowerCase().includes(catLower) || catLower.includes(el.toLowerCase())) {
              relevantCodes = relevantCodes.concat(SOR_BY_ELEMENT[el]);
            }
          }
        }
      }
      // Still empty? Use all painting + plaster + plumbing as default
      if (relevantCodes.length === 0) {
        ['Plasterwork and Other Finishes', 'Painting and Decorating', 'Plumbing', 'Carpentry and Joinery'].forEach(el => {
          if (SOR_BY_ELEMENT[el]) relevantCodes = relevantCodes.concat(SOR_BY_ELEMENT[el]);
        });
      }

      // Deduplicate
      const seen = {};
      relevantCodes = relevantCodes.filter(d => {
        if (seen[d.c]) return false;
        seen[d.c] = true;
        return true;
      });

      const step2 = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: `You are a UK social housing SOR pricing expert.

${SOR_NAMING_GUIDE}

Task: "${task.description}"

Pick the TOP 3 best matching SOR codes from this list:
${relevantCodes.map(d => `${d.c}|${d.s}|${d.u}|£${d.r}`).join('\n')}

Return ONLY JSON:
{"suggestions":[{"code":123456,"reason":"short reason"}]}` }]
      });

      const step2Text = step2.content[0].text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      const step2Result = JSON.parse(step2Text);

      allTasks.push({
        description: task.description,
        original: task.original || null,
        suggestions: step2Result.suggestions || []
      });
    }

    return { tasks: allTasks };
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
      `📍 /address ADRESA - setează adresa\n` +
      `🏷️ /label Bathroom - setează camera/zona\n` +
      `➕ /add CODE x QTY - adaugă la cotație\n` +
      `📊 /list - vezi cotația curentă\n` +
      `📥 /export - descarcă Excel\n` +
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
    bot.sendMessage(msg.chat.id, '⏳ Generez cotația...');
    
    let csv = 'Code,Description,Qty,Unit,Unit Price,Total\n';
    if (session.address) csv = `Address:,"${session.address}"\n\n` + csv;
    let total = 0;
    let currentLabel = '';
    session.items.forEach(item => {
      if (item.label && item.label !== currentLabel) {
        csv += `\n,"${item.label}"\n`;
        currentLabel = item.label;
      }
      const price = item.qty * item.rate;
      total += price;
      csv += `${item.code},"${item.desc}",${item.qty},${item.uom},${item.rate.toFixed(2)},${price.toFixed(2)}\n`;
    });
    csv += `\n,,,,TOTAL:,${total.toFixed(2)}\n`;
    
    const addr = session.address ? session.address.replace(/[^a-zA-Z0-9]/g,'_').substring(0,30) : 'Quote';
    const filename = `PRS_${addr}_${new Date().toISOString().slice(0,10)}.csv`;
    const buffer = Buffer.from(csv, 'utf8');
    
    bot.sendDocument(msg.chat.id, buffer, {
      caption: `📊 PRS - ${session.items.length} items - £${total.toFixed(2)}`
    }, {
      filename: filename,
      contentType: 'text/csv'
    });
  });

  // /add command - quick add by code (supports: /add 630573 3.5 or /add 630573 x 3.5 or /add 630573)
  bot.onText(/\/add (\d+)\s*(?:x\s*)?(\d+(?:\.\d+)?)?/, (msg, match) => {
    const code = parseInt(match[1]);
    const qty = parseFloat(match[2]) || 1;
    const d = SOR_MAP[code];
    if (!d) {
      bot.sendMessage(msg.chat.id, `❌ Codul ${code} nu există.`);
      return;
    }
    const session = getSession(msg.chat.id);
    const isNewLabel = session.currentLabel && session.currentLabel.toLowerCase() !== 'off' && !session.items.some(i => i.label === session.currentLabel);
    session.items.push({
      code: d.c, desc: d.s, uom: d.u, rate: d.r, qty: qty,
      label: isNewLabel ? session.currentLabel : null
    });
    const price = qty * d.r;
    const total = session.items.reduce((t,i) => t + i.qty * i.rate, 0);
    bot.sendMessage(msg.chat.id,
      `✅ *${d.c}* — ${d.s}\n` +
      `📏 ${qty} ${d.u} × £${d.r.toFixed(2)} = *£${price.toFixed(2)}*\n` +
      `📋 Items: ${session.items.length} | 💰 Total: *£${total.toFixed(2)}*\n\n` +
      `➖ /del ${session.items.length} — șterge acest item`,
      { parse_mode: 'Markdown' }
    );
  });

  // /del command - delete item by number
  bot.onText(/\/del (\d+)/, (msg, match) => {
    const session = getSession(msg.chat.id);
    const idx = parseInt(match[1]) - 1;
    if (idx < 0 || idx >= session.items.length) {
      bot.sendMessage(msg.chat.id, `❌ Index invalid. Ai ${session.items.length} items. Scrie /list ca să vezi.`);
      return;
    }
    const removed = session.items.splice(idx, 1)[0];
    const total = session.items.reduce((t,i) => t + i.qty * i.rate, 0);
    bot.sendMessage(msg.chat.id, 
      `🗑️ Șters: *${removed.code}* — ${removed.desc}\n📋 Items: ${session.items.length} | 💰 Total: *£${total.toFixed(2)}*`,
      { parse_mode: 'Markdown' }
    );
  });

  // /address command - set address for current quote
  bot.onText(/\/address (.+)/, (msg, match) => {
    const session = getSession(msg.chat.id);
    session.address = match[1];
    bot.sendMessage(msg.chat.id, `📍 Adresă setată: *${session.address}*`, { parse_mode: 'Markdown' });
  });

  // /label command - add room/area label
  bot.onText(/\/label (.+)/, (msg, match) => {
    const session = getSession(msg.chat.id);
    session.currentLabel = match[1];
    bot.sendMessage(msg.chat.id, `🏷️ Label setat: *${match[1]}*\nUrmătoarele coduri adăugate vor fi sub acest label.\n/label off — dezactivează label`, { parse_mode: 'Markdown' });
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
            text += `   ➕ /add ${d.c} QTY _(ex: /add ${d.c} 3.5)_\n\n`;
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

// ============================================================
// XLSX GENERATOR - PRS Template Format
// ============================================================
function generateXLSX(items, address) {
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const today = new Date();
  const dateStr = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;

  // Collect unique strings for shared strings table
  const ssSet = [];
  const ssMap = {};
  function addSS(s) {
    s = String(s);
    if (ssMap[s] === undefined) { ssMap[s] = ssSet.length; ssSet.push(s); }
    return ssMap[s];
  }

  // Pre-register known strings
  addSS('PRS CONSTRUCTION GROUP');
  addSS('Address: ' + (address || ''));
  addSS('Date: ' + dateStr);
  addSS('Code'); addSS('Description'); addSS('Qty'); addSS('Unit'); addSS('Unit Price'); addSS('Total');
  addSS('TOTAL:');

  // Register item strings + labels
  const labels = {};
  items.forEach(item => {
    if (item.label) { addSS(item.label); labels[item.label] = true; }
    addSS(item.desc);
    addSS(item.uom);
  });

  // Build sheet rows
  let sheetRows = '';
  let r = 1;

  // Row 1: Company + Address
  sheetRows += `<row r="1" ht="18"><c r="A1" s="6" t="s"><v>${addSS('PRS CONSTRUCTION GROUP')}</v></c><c r="B1" s="7" t="s"><v>${addSS('Address: '+(address||''))}</v></c></row>`;
  // Row 2: Date
  sheetRows += `<row r="2"><c r="A2" s="8" t="s"><v>${addSS('Date: '+dateStr)}</v></c></row>`;
  // Row 3: empty
  // Row 4: Headers
  sheetRows += `<row r="4"><c r="A4" s="1" t="s"><v>${addSS('Code')}</v></c><c r="B4" s="1" t="s"><v>${addSS('Description')}</v></c><c r="C4" s="1" t="s"><v>${addSS('Qty')}</v></c><c r="D4" s="1" t="s"><v>${addSS('Unit')}</v></c><c r="E4" s="1" t="s"><v>${addSS('Unit Price')}</v></c><c r="F4" s="1" t="s"><v>${addSS('Total')}</v></c></row>`;

  r = 5;
  const dataStartRow = r;
  let lastDataRow = r;

  items.forEach(item => {
    if (item.label) {
      // Label row - bold in column B
      sheetRows += `<row r="${r}" ht="15.75"><c r="B${r}" s="5" t="s"><v>${addSS(item.label)}</v></c></row>`;
      r++;
    }
    // Data row
    sheetRows += `<row r="${r}">`;
    sheetRows += `<c r="A${r}" s="2"><v>${item.code}</v></c>`;
    sheetRows += `<c r="B${r}" s="2" t="s"><v>${addSS(item.desc)}</v></c>`;
    sheetRows += `<c r="C${r}" s="2"><v>${item.qty}</v></c>`;
    sheetRows += `<c r="D${r}" s="2" t="s"><v>${addSS(item.uom)}</v></c>`;
    sheetRows += `<c r="E${r}" s="3"><v>${item.rate}</v></c>`;
    sheetRows += `<c r="F${r}" s="3"><f>C${r}*E${r}</f><v>${item.qty * item.rate}</v></c>`;
    sheetRows += `</row>`;
    lastDataRow = r;
    r++;
  });

  // Empty row then TOTAL
  r++;
  const totalRow = r;
  sheetRows += `<row r="${totalRow}"><c r="E${totalRow}" s="9" t="s"><v>${addSS('TOTAL:')}</v></c><c r="F${totalRow}" s="9"><f>SUM(F${dataStartRow}:F${lastDataRow})</f><v>${items.reduce((t,i)=>t+i.qty*i.rate,0)}</v></c></row>`;

  // Instructions rows
  r += 2;
  const instructions = [
    'Instructions: All prices are Subby Adjustment rates (SOR × 0.75)',
    'Codes from NHF v6.3 Schedule of Rates v8',
    'Generated by PRS SOR Pricing Agent'
  ];
  instructions.forEach(txt => {
    addSS(txt);
    sheetRows += `<row r="${r}"><c r="A${r}" s="4" t="s"><v>${addSS(txt)}</v></c></row>`;
    r++;
  });

  // Build shared strings XML
  let ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ssSet.length}" uniqueCount="${ssSet.length}">`;
  ssSet.forEach(s => { ssXml += `<si><t>${esc(s)}</t></si>`; });
  ssXml += '</sst>';

  // Sheet XML
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="36.3"/><col min="2" max="2" width="60.3"/><col min="3" max="3" width="15.4"/><col min="4" max="4" width="21.1"/><col min="5" max="5" width="23.6"/><col min="6" max="6" width="20.1"/></cols><sheetData>${sheetRows}</sheetData></worksheet>`;

  // Styles XML - matching PRS template exactly
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="\\£#,##0.00"/></numFmts><fonts count="6"><font><sz val="11"/><name val="Calibri"/></font><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><name val="Cambria"/></font><font><b/><sz val="11"/><color rgb="FFC8C8C8"/><name val="Cambria"/></font><font><sz val="9"/><color rgb="FF666666"/><name val="Cambria"/></font><font><b/><sz val="14"/><name val="Cambria"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF203864"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFD9E2F3"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFCCCCCC"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="5" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="164" fontId="2" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/></cellXfs></styleSheet>`;

  // Other required XML files
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Quotation" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;

  // Build ZIP (STORE method - no compression needed)
  const files = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rels,
    'xl/workbook.xml': workbook,
    'xl/_rels/workbook.xml.rels': wbRels,
    'xl/styles.xml': stylesXml,
    'xl/sharedStrings.xml': ssXml,
    'xl/worksheets/sheet1.xml': sheetXml
  };

  // Simple ZIP builder
  const localHeaders = [];
  const centralDir = [];
  let offset = 0;

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
      }
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataBytes = Buffer.from(content, 'utf8');
    const crc = crc32(dataBytes);

    // Local file header
    const lh = Buffer.alloc(30 + nameBytes.length + dataBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);  // sig
    lh.writeUInt16LE(20, 4);           // version
    lh.writeUInt16LE(0, 8);            // compression: store
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(dataBytes.length, 18);  // compressed
    lh.writeUInt32LE(dataBytes.length, 22);  // uncompressed
    lh.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(lh, 30);
    dataBytes.copy(lh, 30 + nameBytes.length);
    localHeaders.push(lh);

    // Central directory
    const cd = Buffer.alloc(46 + nameBytes.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(dataBytes.length, 20);
    cd.writeUInt32LE(dataBytes.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(32, 38);
    cd.writeUInt32LE(offset, 42);
    nameBytes.copy(cd, 46);
    centralDir.push(cd);

    offset += lh.length;
  }

  const cdOffset = offset;
  const cdSize = centralDir.reduce((a, b) => a + b.length, 0);

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([...localHeaders, ...centralDir, eocd]);
}

// Start server
app.listen(PORT, () => {
  console.log(`✅ Web server running on port ${PORT}`);
  console.log(`✅ Open http://localhost:${PORT} for web app`);
});
