import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { Telegraf } from "telegraf";

const {
  TELEGRAM_BOT_TOKEN,
  ANTHROPIC_API_KEY,
  ANTHROPIC_BASE_URL,
  AI_MODEL = "deepseek-v4-flash",
  SYSTEM_PROMPT = "You are a helpful AI assistant. Answer clearly and concisely. Use Markdown when it helps readability, especially for code blocks.",
  MAX_FILE_BYTES = "10485760",
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
const maxFileBytes = Number.parseInt(MAX_FILE_BYTES, 10);

type TelegramFile = {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
    }
  | {
      type: "document";
      source: {
        type: "base64";
        media_type: string;
        data: string;
      };
      title?: string;
    };

const textMimeTypes = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "text/csv",
  "text/html",
  "text/javascript",
  "text/markdown",
  "text/plain",
  "text/xml",
  "text/yaml",
]);

bot.start((ctx) => {
  return ctx.reply(
    "Привет! Отправь текст, фото или файл, а я передам это в AI и верну аккуратный ответ с Markdown.",
  );
});

bot.on(["text", "photo", "document"], async (ctx) => {
  await ctx.sendChatAction("typing");

  try {
    const content = await buildUserContent(ctx);

    if (content.length === 0) {
      return ctx.reply("Пришли текст, фото или файл с подписью или вопросом.");
    }

    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content: content as any }],
      system: SYSTEM_PROMPT,
      temperature: 0.4,
    });

    const answer = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    await replyMarkdown(ctx, answer || "Модель не вернула текстовый ответ.");
  } catch (error) {
    console.error("AI request failed:", error);
    await ctx.reply(
      "Не получилось получить ответ от AI. Проверь ключи, endpoint и поддержку файлов выбранной моделью.",
    );
  }
});

bot.on("message", (ctx) => {
  return ctx.reply("Я умею обрабатывать текст, фото и документы.");
});

bot.catch((error, ctx) => {
  console.error(`Bot error for update ${ctx.update.update_id}:`, error);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

void bot.launch();
console.log("Telegram AI bot is running");

async function buildUserContent(ctx: any): Promise<AnthropicContentBlock[]> {
  const message = ctx.message;
  const content: AnthropicContentBlock[] = [];
  const text = getMessageText(message);

  if (text) {
    content.push({ type: "text", text });
  }

  if ("photo" in message && Array.isArray(message.photo)) {
    const photo = message.photo.at(-1);

    if (photo) {
      const downloaded = await downloadTelegramFile(ctx, {
        file_id: photo.file_id,
        file_name: "photo.jpg",
        mime_type: "image/jpeg",
        file_size: photo.file_size,
      });

      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: downloaded.mimeType,
          data: downloaded.data.toString("base64"),
        },
      });
    }
  }

  if ("document" in message && message.document) {
    const file = message.document as TelegramFile;
    const downloaded = await downloadTelegramFile(ctx, file);
    const name = file.file_name ?? "file";

    if (isTextFile(downloaded.mimeType, name)) {
      content.push({
        type: "text",
        text: [
          `Пользователь прикрепил файл: ${name}`,
          `MIME type: ${downloaded.mimeType}`,
          "",
          "Содержимое файла:",
          "```",
          downloaded.data.toString("utf8"),
          "```",
        ].join("\n"),
      });
    } else if (downloaded.mimeType.startsWith("image/")) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: downloaded.mimeType,
          data: downloaded.data.toString("base64"),
        },
      });
    } else {
      content.push({
        type: "document",
        title: name,
        source: {
          type: "base64",
          media_type: downloaded.mimeType,
          data: downloaded.data.toString("base64"),
        },
      });
    }
  }

  if (content.length > 0 && !content.some((part) => part.type === "text")) {
    content.unshift({
      type: "text",
      text: "Проанализируй вложение и ответь на запрос пользователя. Если явного вопроса нет, кратко опиши, что в файле.",
    });
  }

  return content;
}

function getMessageText(message: any): string {
  const rawText = "text" in message ? message.text : message.caption;
  return typeof rawText === "string" ? rawText.trim() : "";
}

async function downloadTelegramFile(ctx: any, file: TelegramFile) {
  if (file.file_size && file.file_size > maxFileBytes) {
    throw new Error(
      `File is too large: ${file.file_size} bytes. Limit is ${maxFileBytes} bytes.`,
    );
  }

  const fileLink = await ctx.telegram.getFileLink(file.file_id);
  const response = await fetch(fileLink.href);

  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status}`);
  }

  const data = Buffer.from(await response.arrayBuffer());

  if (data.byteLength > maxFileBytes) {
    throw new Error(`Downloaded file is too large: ${data.byteLength} bytes. Limit is ${maxFileBytes} bytes.`,);
  }

  return {
    data,
    mimeType: file.mime_type ?? response.headers.get("content-type") ?? "application/octet-stream",
  };
}

function isTextFile(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith("text/") || textMimeTypes.has(mimeType)) {
    return true;
  }

  return /\.(c|cpp|cs|css|env|go|html|java|js|json|jsx|log|md|py|rb|rs|sql|ts|tsx|txt|xml|yaml|yml)$/i.test(
    fileName,
  );
}

async function replyMarkdown(ctx: any, markdown: string): Promise<void> {
  const markdownChunks = splitTelegramMessage(markdown);

  for (const markdownChunk of markdownChunks) {
    const html = markdownToTelegramHtml(markdownChunk);

    try {
      await ctx.reply(html, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (error) {
      console.error("Formatted Telegram reply failed:", error);
      await ctx.reply(markdownChunk);
    }
  }
}

function markdownToTelegramHtml(markdown: string): string {
  const blocks = markdown.split(/(```[\s\S]*?```)/g);

  return blocks
    .map((block) => {
      if (block.startsWith("```") && block.endsWith("```")) {
        const code = block.slice(3, -3).replace(/^\w+\n/, "");
        return `<pre><code>${escapeHtml(code.trim())}</code></pre>`;
      }

      return escapeHtml(block)
        .replace(/`([^`\n]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
        .replace(/__([^_\n]+)__/g, "<b>$1</b>")
        .replace(/\*([^*\n]+)\*/g, "<i>$1</i>")
        .replace(/_([^_\n]+)_/g, "<i>$1</i>")
        .replace(/^\s*[-*]\s+(.+)$/gm, "• $1")
        .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
    })
    .join("")
    .trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function splitTelegramMessage(message: string): string[] {
  const maxLength = 3900;

  if (message.length <= maxLength) {
    return [message];
  }

  const chunks: string[] = [];
  let rest = message;

  while (rest.length > maxLength) {
    const splitAt = Math.max(rest.lastIndexOf("\n", maxLength), rest.lastIndexOf(" ", maxLength));
    const index = splitAt > 0 ? splitAt : maxLength;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks;
}
