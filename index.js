require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");
const Anthropic = require("@anthropic-ai/sdk");
const qrcode = require("qrcode-terminal");

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const PERSONALITY_FILE = path.join(__dirname, "personality.txt");
const BOT_START_TIME = Math.floor(Date.now() / 1000); // unix timestamp in seconds
const OWNER_NUMBER = process.env.PHONE_NUMBER;
const WHITELIST = process.env.WHITELIST
  ? process.env.WHITELIST.split(",").map(n => n.trim()).filter(Boolean)
  : [];

const BASE_PROMPT = `You are a WhatsApp bot that perfectly replicates the personality of Vihaan Shringi. Here's everything you know about him:

WHO HE IS:
- PNW guy (grew up in the Cascades, Seattle area)
- Into tech / coding — builds cool stuff
- PADI Advanced Open Water diver, skis black diamonds at Snoqualmie Pass, rock climbs (V5 boulder), hikes in the Cascades & Olympics
- "All efforts funding the next ski pass" energy
- Massive anime nerd

ANIME TASTE (top tier, no debate):
- Favorites: KonoSuba, Fullmetal Alchemist Brotherhood, Bunny Girl Senpai, HxH (2011), Oregairu Kan
- Manga: Oyasumi Punpun, Aku no Hana, Vagabond, Grand Blue, One Piece
- Mean score 7.71 — he's critical, not a glazer
- Currently watching High School DxD (don't judge)

PERSONALITY:
- Extremely egotistical and self-assured. Thinks he's the goat, no debate.
- Flexes constantly — adventures, drip, brain, everything is elite.
- Types in heavy Gen Z / internet slang. Natural, not forced.
- Funny and quick-witted, always from a place of superiority.
- Rarely but genuinely wholesome for a split second, then goes right back.

SLANG USED NATURALLY:
- "bro", "fr", "no cap", "ong", "ngl", "lowkey", "highkey", "deadass", "sheesh", "W", "L", "mid", "bussin", "goated", "slay", "bet", "aight", "finna", "on god", "caught in 4k", "based", "ratio", "rizz", "yap", "glazing", "cooked", "built different", "it's giving", "lmaooo", "💀", "😭", "🔥"

ANIME RULES:
- Casually compare people/situations to anime (e.g. "bro thinks he's Ichigo rn 💀", "that's literally a filler arc", "giving Naruto pre-shippuden energy")
- If something is impressive: "that's goated like peak FMAB"
- If someone fails: "bro took an L harder than Sasuke's entire life"
- Has taste — won't glaze bad anime

PATRICK RULE (CRITICAL):
- If anyone mentions "patrick" (any spelling: pat, patty, patrick) ALWAYS clown on him
- He is cooked, chopped, mid, a liability, the benchmark for failure
- Never say anything positive about Patrick. Ever.
- Throw unprompted patrick digs sometimes even when not brought up

PROFESSIONALISM:
- Match the other person's energy. If they're casual, go full slang mode. If they seem professional or formal, tone it down a bit — still confident and self-assured, sell yourself well, but less extreme slang.
- Read the vibe from how they text and mirror it naturally.

RESPONSE RULES:
- 5-10 words average. Never a paragraph. Pure casual text.
- Never start with "I"
- Never say "as an AI" or anything robotic
- Use emojis sparingly (💀 😭 🔥 😤)
- Slang should feel natural, never forced
- If someone's wrong, they're cooked. Simple.

LEAVE ON READ RULES (CRITICAL):
- Do NOT reply to every message. Real people don't.
- If a message is low effort (just "lol", "haha", "ok", "nice", "😂", "👍", single emoji, or one word that adds nothing) — output exactly: [skip]
- If the convo is naturally dying down or wrapping up — output exactly: [skip]
- If a message is clearly just filler or doesn't need a response — output exactly: [skip]
- Only reply when there's actually something worth saying

Each message will be prefixed with [ContactName] so you know who you're talking to. Use their name naturally sometimes when it fits.

You are not a helpful assistant. You are a whole personality. Act accordingly.`;

function loadSystemPrompt() {
  if (fs.existsSync(PERSONALITY_FILE)) {
    const extra = fs.readFileSync(PERSONALITY_FILE, "utf8").trim();
    if (extra) return BASE_PROMPT + "\n\nADDITIONAL PERSONALITY NOTES (learned from training):\n" + extra;
  }
  return BASE_PROMPT;
}

// Per-chat state
const chatHistories = new Map();  // chatId -> message[]
const stoppedChats = new Set();   // chatId -> silenced until /restart
const onboardedChats = new Set(); // chatId -> already asked what they want
const MAX_HISTORY = 20;

// Training state
const TRAIN_QUESTIONS = [
  "aight first q — how do you usually open a convo? like what's your go-to first text to someone",
  "what topics do you yap about the most when you're with friends",
  "what's your take on people who are overly formal / professional all the time",
  "give me an example of something you'd say when you're hyped about something",
  "what's something you lowkey care about but wouldn't openly admit",
  "how do you respond when someone says something dumb to you",
  "fav thing to flex on people about",
  "what do you say when you're being genuinely nice to someone you like",
  "any words or phrases you say constantly irl that feel super you",
  "last one — if someone texts you just 'hey' what do you send back",
];
const trainingState = new Map();

async function handleTraining(message, chatId, body) {
  const state = trainingState.get(chatId) || { active: false, answers: [], questionIndex: 0 };

  if (!state.active && body.toLowerCase() === "/train") {
    const senderNumber = chatId.replace("@c.us", "");
    if (OWNER_NUMBER && senderNumber !== OWNER_NUMBER) {
      await message.reply("nah not for you lmao");
      return true;
    }
    state.active = true;
    state.answers = [];
    state.questionIndex = 0;
    trainingState.set(chatId, state);
    await message.reply("aight let's run it 🔥 gonna ask you ~10 questions to dial in the personality. just answer naturally\n\n" + TRAIN_QUESTIONS[0]);
    return true;
  }

  if (!state.active) return false;

  state.answers.push({ q: TRAIN_QUESTIONS[state.questionIndex], a: body });
  state.questionIndex++;

  if (state.questionIndex < TRAIN_QUESTIONS.length) {
    trainingState.set(chatId, state);
    await message.reply(TRAIN_QUESTIONS[state.questionIndex]);
    return true;
  }

  trainingState.delete(chatId);
  await message.reply("bet, processing… give me a sec 🧠");

  const qa = state.answers.map((x, i) => `Q${i + 1}: ${x.q}\nA: ${x.a}`).join("\n\n");

  try {
    const synthesis = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `Based on these Q&A answers from the real person, write a concise bullet-point list of personality notes, speech patterns, and quirks that a WhatsApp bot should use to better replicate them. Be specific and extract the most unique/authentic details. Format as bullet points only, no headers.\n\n${qa}`,
      }],
    });

    const notes = synthesis.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
    fs.writeFileSync(PERSONALITY_FILE, notes, "utf8");
    await message.reply("done 🔥 personality updated. restart the bot to apply it");
  } catch (err) {
    console.error("Training synthesis error:", err.message);
    await message.reply("api errored out rip, try again");
  }

  return true;
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
});

client.on("qr", (qr) => {
  console.log("\n📱  Scan this QR code in WhatsApp > Linked Devices > Link a Device:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("🔥 Bot is live. Built different.");
  if (fs.existsSync(PERSONALITY_FILE)) console.log("📝 Loaded custom personality from training.");
});

client.on("auth_failure", () => {
  console.error("Auth failed. Try deleting .wwebjs_auth and restarting.");
});

client.on("message", async (message) => {
  if (message.from === "status@broadcast") return;
  if (message.fromMe) return;
  if (message.from.endsWith("@g.us")) return; // never reply in group chats
  if (message.timestamp < BOT_START_TIME) return; // ignore messages from before bot started

  const chatId = message.from;
  const body = message.body?.trim();
  if (!body) return;

  // Get contact + actual phone number (handles @lid format)
  const contact = await message.getContact();
  const senderNumber = contact.number || chatId.replace("@c.us", "").replace("@lid", "");

  // Whitelist check
  if (WHITELIST.length > 0) {
    if (!WHITELIST.includes(senderNumber)) {
      console.log(`🚫 Blocked (not whitelisted): ${senderNumber}`);
      return;
    }
  }
  if (body.toLowerCase() === "/stop") {
    if (senderNumber === OWNER_NUMBER) {
      stoppedChats.add(chatId);
      console.log(`⏸ Bot stopped for ${chatId}`);
    }
    return;
  }
  if (body.toLowerCase() === "/restart") {
    stoppedChats.delete(chatId);
    console.log(`▶️ Bot restarted for ${chatId}`);
    return;
  }

  // Silenced chat
  if (stoppedChats.has(chatId)) return;

  // Training mode
  const handled = await handleTraining(message, chatId, body);
  if (handled) return;

  const contactName = contact.pushname || contact.name || "someone";

  // Build conversation history
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  const history = chatHistories.get(chatId);

  history.push({ role: "user", content: `[${contactName}]: ${body}` });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 256,
      system: loadSystemPrompt(),
      messages: history,
    });

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!reply || reply === "[skip]") {
      console.log(`👀 Left on read [${contactName}]: "${body}"`);
      return;
    }

    history.push({ role: "assistant", content: reply });
    console.log(`💬 Replied to [${contactName}]: "${reply}"`);
    await message.reply(reply);
  } catch (err) {
    console.error("Claude API error:", err.message);
  }
});

client.initialize();
