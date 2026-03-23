require("dotenv").config();
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
const PERSONALITY_FILE = path.join(__dirname, "personality.txt");

const QUESTIONS = [
  "how do you usually open a convo? what's your go-to first text to someone",
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

async function main() {
  console.log("\n🔥 personality training — answer naturally, no filter\n");

  const answers = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    const a = await ask(`[${i + 1}/${QUESTIONS.length}] ${QUESTIONS[i]}\n> `);
    answers.push({ q: QUESTIONS[i], a });
    console.log();
  }

  rl.close();
  console.log("synthesizing… 🧠");

  const qa = answers.map((x, i) => `Q${i + 1}: ${x.q}\nA: ${x.a}`).join("\n\n");

  const res = await anthropic.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `Based on these Q&A answers from the real person, write a concise bullet-point list of personality notes, speech patterns, and quirks that a WhatsApp bot should use to better replicate them. Be specific and extract the most unique/authentic details. Format as bullet points only, no headers.\n\n${qa}`,
    }],
  });

  const notes = res.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
  fs.writeFileSync(PERSONALITY_FILE, notes, "utf8");

  console.log("\n✅ done! saved to personality.txt\n");
  console.log(notes);
  console.log("\nrestart the bot to apply.\n");
}

main().catch(console.error);
