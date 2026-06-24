import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { Telegraf } from "telegraf";


const {
  TELEGRAM_BOT_TOKEN,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  AI_MODEL = "deepseek-v4-flash",
  SYSTEM_PROMPT = "You are a helpful AI assistant. Answer clearly and concisely.",
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in env");
}

if (!ANTHROPIC_API_KEY) {
  throw new Error("Missing ANTHROPIC_API_KEY in env");
}

const client = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
  baseURL: ANTHROPIC_BASE_URL,
});

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

bot.start((ctx) => {
  return ctx.reply("Привет! Напиши вопрос, а я отправлю его в AI и верну ответ.");
});

bot.on("text", async (ctx) => {
  const userMessage = ctx.message.text.trim();

  if (!userMessage) {
    return ctx.reply("Пришли текстовый запрос.");
  }

  await ctx.sendChatAction("typing");

  try {
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: userMessage }],
      system: SYSTEM_PROMPT,
      temperature: 0.4,
    });

    const answer = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    return ctx.reply(answer || "Модель не вернула текстовый ответ.");
  } catch (error) {
    console.error("AI request failed:", error);
    return ctx.reply("Не получилось получить ответ от AI. Проверь ключи и endpoint.");
  }
});

bot.catch((error, ctx) => {
  console.error(`Bot error for update ${ctx.update.update_id}:`, error);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

bot.launch();
console.log("Telegram AI bot is running");
