import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { MongoClient } from "mongodb";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3000;
const CORS_ORIGINS = [
  "https://zeng9898.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

// ── OpenAI 設定 ──────────────────────────────────────────────────────────────
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// 每題對應的 Prompt ID（前端只傳 questionIndex，後端從此 map 取 prompt）
const OPENAI_PROMPT_IDS = {
  0: process.env.OPENAI_PROMPT_ID_Q1,
  1: process.env.OPENAI_PROMPT_ID_Q2,
  2: process.env.OPENAI_PROMPT_ID_Q3,
};

// 反思引導 AI 的 Prompt ID
const OPENAI_PROMPT_ID_REFLECTION = process.env.OPENAI_PROMPT_ID_REFLECTION;

// ── MongoDB 設定 ─────────────────────────────────────────────────────────────
const MONGODB_COLLECTION = process.env.MONGODB_COLLECTION || "chat_sessions";

// ── JSON Schema（Responses API strict mode 用） ───────────────────────────────
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    phase: {
      type: "string",
      enum: ["diagnosis", "apprenticeship", "completed"],
    },
    step: {
      type: "integer",
      minimum: 1,
      maximum: 10,
    },
    stage: {
      type: "string",
      enum: ["claim", "evidence", "reasoning", "revise", "complete"],
    },
    assistantMessage: { type: "string" },
    feedback: {
      type: "string",
      minLength: 8,
      maxLength: 25,
    },
    hintLevel: {
      type: "integer",
      enum: [0, 1, 2, 3],
    },
    requiresRestatement: { type: "boolean" },
  },
  required: [
    "phase",
    "step",
    "stage",
    "assistantMessage",
    "feedback",
    "hintLevel",
    "requiresRestatement",
  ],
};

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({ origin: CORS_ORIGINS }));
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const mongoClient = new MongoClient(process.env.MONGODB_URI);

let db = null;

async function initMongo() {
  await mongoClient.connect();
  db = mongoClient.db(process.env.MONGODB_DB || "sa");
  console.log("[MongoDB] connected:", db.databaseName);
}

function getErrorMessage(err) {
  return err?.message ?? err?.error?.message ?? String(err);
}

// ── Helper：upsert chat_sessions ─────────────────────────────────────────────
async function upsertSession(conversationId, fields) {
  if (!db) return;
  try {
    await db.collection(MONGODB_COLLECTION).updateOne(
      { conversationId },
      { $set: { conversationId, ...fields } },
      { upsert: true }
    );
  } catch (e) {
    console.warn("[MongoDB] upsert failed:", e.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.setHeader("X-Server", "scientific_argumentation_back");
  res.json({ ok: true, time: new Date().toISOString(), pid: process.pid });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { userMessage, conversationId, questionIndex } = req.body ?? {};

    // ── 前置驗證 ──────────────────────────────────────────────────────────
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing OPENAI_API_KEY in .env" });
    }
    if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
      return res.status(400).json({ error: "userMessage is required (non-empty string)" });
    }

    // ── 驗證 questionIndex ────────────────────────────────────────────────
    if (questionIndex === undefined || questionIndex === null || ![0, 1, 2].includes(Number(questionIndex))) {
      return res.status(400).json({
        error: `questionIndex must be 0, 1, or 2 (received: ${questionIndex})`,
        code: "invalid_question_index",
      });
    }
    const qIdx = Number(questionIndex);
    const selectedPromptId = OPENAI_PROMPT_IDS[qIdx];
    if (!selectedPromptId) {
      return res.status(500).json({
        error: `missing prompt id for questionIndex=${qIdx}`,
        code: "missing_prompt_id",
      });
    }

    // ── 取得或建立 Conversation ───────────────────────────────────────────
    const validConvId =
      typeof conversationId === "string" && conversationId.startsWith("conv_")
        ? conversationId
        : null;

    let conversation;
    const now = new Date().toISOString();

    if (validConvId) {
      try {
        conversation = await openai.conversations.retrieve(validConvId);
      } catch (retrieveErr) {
        console.error("[api/chat] conversation retrieve failed:", retrieveErr.message);
        return res.status(400).json({
          error: "invalid_conversation_id",
          code: "invalid_conversation_id",
          detail: retrieveErr.message,
        });
      }
    } else {
      conversation = await openai.conversations.create({
        metadata: {
          app: "scientific_argumentation",
          surface: "argument_chat",
          questionIndex: String(qIdx),
        },
      });
      // 新 conversation — 建立 session 索引
      await upsertSession(conversation.id, {
        createdAt: now,
        updatedAt: now,
        questionIndex: qIdx,
        promptId: selectedPromptId,
      });
    }

    // ── 呼叫 Responses API ────────────────────────────────────────────────
    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      prompt: { id: selectedPromptId },
      conversation: conversation.id,
      input: [
        {
          role: "user",
          content: userMessage,
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "scientific_argumentation_tutor_turn",
          schema: RESPONSE_JSON_SCHEMA,
          strict: true,
        },
      },
      store: true,
    });

    // ── 解析 JSON ────────────────────────────────────────────────────────
    const rawText = response.output_text ?? "";
    if (!rawText) {
      console.error("[api/chat] empty output_text, response.id:", response.id);
      return res.status(500).json({ error: "no_assistant_text", response_id: response.id });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(
        "[api/chat] JSON parse failed:",
        parseErr.message,
        "| raw:",
        rawText.slice(0, 200)
      );
      return res.status(500).json({
        error: "invalid_assistant_json",
        raw_preview: rawText.slice(0, 200),
      });
    }

    // ── 更新 MongoDB session ──────────────────────────────────────────────
    await upsertSession(conversation.id, {
      updatedAt: new Date().toISOString(),
      questionIndex: qIdx,
      promptId: selectedPromptId,
      lastResponseId: response.id,
      lastPhase: data.phase,
      lastStep: data.step,
      lastStage: data.stage,
      lastHintLevel: data.hintLevel,
      requiresRestatement: data.requiresRestatement,
    });

    // ── 回傳 ─────────────────────────────────────────────────────────────
    res.json({
      ...data,
      questionIndex: qIdx,
      conversationId: conversation.id,
      responseId: response.id,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    console.error("[api/chat] error:", message);
    res.status(500).json({
      error: message || "server_error",
      ...(err?.code != null && { code: err.code }),
      ...(err?.status != null && { status: err.status }),
    });
  }
});

// ── 反思引導聊天 ──────────────────────────────────────────────────────────────

app.post("/api/reflection", async (req, res) => {
  try {
    const { userMessage, conversationId } = req.body ?? {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing OPENAI_API_KEY in .env" });
    }
    if (!OPENAI_PROMPT_ID_REFLECTION) {
      return res.status(500).json({ error: "missing OPENAI_PROMPT_ID_REFLECTION in .env" });
    }
    if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
      return res.status(400).json({ error: "userMessage is required (non-empty string)" });
    }

    const validConvId =
      typeof conversationId === "string" && conversationId.startsWith("conv_")
        ? conversationId
        : null;

    let conversation;
    const now = new Date().toISOString();

    if (validConvId) {
      try {
        conversation = await openai.conversations.retrieve(validConvId);
      } catch (retrieveErr) {
        return res.status(400).json({
          error: "invalid_conversation_id",
          code: "invalid_conversation_id",
          detail: retrieveErr.message,
        });
      }
    } else {
      conversation = await openai.conversations.create({
        metadata: { app: "scientific_argumentation", surface: "reflection" },
      });
      await upsertSession(conversation.id, {
        createdAt: now,
        updatedAt: now,
        surface: "reflection",
        promptId: OPENAI_PROMPT_ID_REFLECTION,
      });
    }

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      prompt: { id: OPENAI_PROMPT_ID_REFLECTION },
      conversation: conversation.id,
      input: [{ role: "user", content: userMessage }],
      store: true,
    });

    const assistantMessage = response.output_text ?? "";

    await upsertSession(conversation.id, {
      updatedAt: new Date().toISOString(),
      lastResponseId: response.id,
      surface: "reflection",
    });

    res.json({
      assistantMessage,
      conversationId: conversation.id,
      responseId: response.id,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    console.error("[api/reflection] error:", message);
    res.status(500).json({ error: message || "server_error" });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

function start() {
  console.log(`[API] http://localhost:${PORT} (pid=${process.pid})`);
}

initMongo()
  .then(() => {
    app.listen(PORT, start);
  })
  .catch((e) => {
    console.warn("[MongoDB] connect failed, starting without DB:", e.message);
    app.listen(PORT, start);
  });
