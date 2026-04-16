import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import pg from "pg";

const { Pool } = pg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3000;
const CORS_ORIGINS = (
  process.env.CORS_ORIGINS ??
  [
    "https://zeng9898.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ].join(",")
)
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const AUTH_SESSION_DAYS = Number(process.env.AUTH_SESSION_DAYS || 7);

const PROMPT_IDS_BY_GROUP = {
  experiment: {
    0: process.env.OPENAI_PROMPT_ID_Q1_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q1,
    1: process.env.OPENAI_PROMPT_ID_Q2_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q2,
    2: process.env.OPENAI_PROMPT_ID_Q3_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q3,
    3: process.env.OPENAI_PROMPT_ID_Q4_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q1,
    4: process.env.OPENAI_PROMPT_ID_Q5_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q2,
    5: process.env.OPENAI_PROMPT_ID_Q6_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q3,
    6: process.env.OPENAI_PROMPT_ID_Q7_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q1,
    7: process.env.OPENAI_PROMPT_ID_Q8_EXPERIMENT || process.env.OPENAI_PROMPT_ID_Q2,
    reflection:
      process.env.OPENAI_PROMPT_ID_REFLECTION_EXPERIMENT ||
      process.env.OPENAI_PROMPT_ID_REFLECTION,
  },
  control: {
    0: process.env.OPENAI_PROMPT_ID_Q1_CONTROL || process.env.OPENAI_PROMPT_ID_Q1,
    1: process.env.OPENAI_PROMPT_ID_Q2_CONTROL || process.env.OPENAI_PROMPT_ID_Q2,
    2: process.env.OPENAI_PROMPT_ID_Q3_CONTROL || process.env.OPENAI_PROMPT_ID_Q3,
    3: process.env.OPENAI_PROMPT_ID_Q4_CONTROL || process.env.OPENAI_PROMPT_ID_Q1,
    4: process.env.OPENAI_PROMPT_ID_Q5_CONTROL || process.env.OPENAI_PROMPT_ID_Q2,
    5: process.env.OPENAI_PROMPT_ID_Q6_CONTROL || process.env.OPENAI_PROMPT_ID_Q3,
    6: process.env.OPENAI_PROMPT_ID_Q7_CONTROL || process.env.OPENAI_PROMPT_ID_Q1,
    7: process.env.OPENAI_PROMPT_ID_Q8_CONTROL || process.env.OPENAI_PROMPT_ID_Q2,
    reflection:
      process.env.OPENAI_PROMPT_ID_REFLECTION_CONTROL ||
      process.env.OPENAI_PROMPT_ID_REFLECTION,
  },
};

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
      maximum: 7,
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

const app = express();
const corsOptions = { origin: CORS_ORIGINS };
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "true"
      ? {
          rejectUnauthorized: false,
        }
      : undefined,
});

function getErrorMessage(err) {
  return err?.message ?? err?.error?.message ?? String(err);
}

function makePasswordHash(password, salt = randomBytes(16).toString("hex")) {
  const digest = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${digest}`;
}

function verifyPassword(password, passwordHash) {
  if (!passwordHash) return false;
  const [salt, storedDigest] = String(passwordHash).split(":");
  if (!salt || !storedDigest) return false;

  const computed = scryptSync(password, salt, 64);
  const stored = Buffer.from(storedDigest, "hex");
  if (stored.length !== computed.length) return false;
  return timingSafeEqual(stored, computed);
}

function hashSessionToken(token) {
  return scryptSync(token, "scientific_argumentation_session", 64).toString("hex");
}

async function initDb() {
  const schemaPath = path.join(__dirname, "db", "schema.sql");
  const schemaSql = await fs.readFile(schemaPath, "utf8");
  await pool.query(schemaSql);
  await pool.query("alter table ai_conversations add column if not exists level_id varchar(64)");
  await pool.query(
    "create index if not exists idx_ai_conversations_reflection_level on ai_conversations(student_id, surface, level_id)"
  );
  await pool.query("select 1");
  console.log("[PostgreSQL] connected");
}

function mapStudentPayload(row) {
  return {
    id: Number(row.id),
    studentNumber: row.student_number,
    name: row.name,
    groupType: row.group_type,
    stats: {
      completedArgumentCount: Number(row.completed_argument_count ?? 0),
      completedReflectionCount: Number(row.completed_reflection_count ?? 0),
      streakDays: Number(row.streak_days ?? 0),
    },
  };
}

async function getStudentWithStats(studentId) {
  const { rows } = await pool.query(
    `
      select
        s.id,
        s.student_number,
        s.name,
        s.group_type,
        coalesce((
          select count(*)
          from ai_conversations ac
          where ac.student_id = s.id
            and ac.surface = 'argument_chat'
            and ac.last_phase = 'completed'
        ), 0) as completed_argument_count,
        coalesce((
          select count(*)
          from ai_conversations ac
          where ac.student_id = s.id
            and ac.surface = 'reflection'
            and ac.last_response_id is not null
        ), 0) as completed_reflection_count,
        0 as streak_days
      from students s
      where s.id = $1
      limit 1
    `,
    [studentId]
  );

  return rows[0] ? mapStudentPayload(rows[0]) : null;
}

function getQuestionSetup(questionIndex, groupType) {
  if (
    questionIndex === undefined ||
    questionIndex === null ||
    ![0, 1, 2, 3, 4, 5, 6, 7].includes(Number(questionIndex))
  ) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `questionIndex must be 0, 1, 2, 3, 4, 5, 6, or 7 (received: ${questionIndex})`,
        code: "invalid_question_index",
      },
    };
  }

  const qIdx = Number(questionIndex);
  const selectedPromptId = PROMPT_IDS_BY_GROUP[groupType]?.[qIdx];
  if (!selectedPromptId) {
    return {
      ok: false,
      status: 500,
      body: {
        error: `missing prompt id for questionIndex=${qIdx}, groupType=${groupType}`,
        code: "missing_prompt_id",
      },
    };
  }

  return { ok: true, qIdx, selectedPromptId };
}

function getReflectionPromptId(groupType) {
  return PROMPT_IDS_BY_GROUP[groupType]?.reflection ?? null;
}

function normalizeLevelId(levelId) {
  if (typeof levelId !== "string") return null;
  const trimmed = levelId.trim();
  return /^level-\d+$/.test(trimmed) ? trimmed : null;
}

async function insertMessage(fields) {
  await pool.query(
    `
      insert into ai_messages (
        openai_conversation_id,
        student_id,
        surface,
        question_index,
        role,
        message_text,
        prompt_id,
        response_id,
        phase,
        step,
        stage,
        hint_level,
        requires_restatement
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `,
    [
      fields.openaiConversationId,
      fields.studentId,
      fields.surface,
      fields.questionIndex ?? null,
      fields.role,
      fields.messageText,
      fields.promptId ?? null,
      fields.responseId ?? null,
      fields.phase ?? null,
      fields.step ?? null,
      fields.stage ?? null,
      fields.hintLevel ?? null,
      fields.requiresRestatement ?? null,
    ]
  );
}

async function upsertConversation(openaiConversationId, fields) {
  await pool.query(
    `
      insert into ai_conversations (
        openai_conversation_id,
        student_id,
        surface,
        level_id,
        question_index,
        prompt_id,
        group_type_snapshot,
        opening_message,
        last_response_id,
        last_phase,
        last_step,
        last_stage,
        last_hint_level,
        requires_restatement,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        coalesce($15, now()), coalesce($16, now())
      )
      on conflict (openai_conversation_id)
      do update set
        student_id = excluded.student_id,
        surface = excluded.surface,
        level_id = coalesce(excluded.level_id, ai_conversations.level_id),
        question_index = excluded.question_index,
        prompt_id = excluded.prompt_id,
        group_type_snapshot = excluded.group_type_snapshot,
        opening_message = coalesce(excluded.opening_message, ai_conversations.opening_message),
        last_response_id = coalesce(excluded.last_response_id, ai_conversations.last_response_id),
        last_phase = coalesce(excluded.last_phase, ai_conversations.last_phase),
        last_step = coalesce(excluded.last_step, ai_conversations.last_step),
        last_stage = coalesce(excluded.last_stage, ai_conversations.last_stage),
        last_hint_level = coalesce(excluded.last_hint_level, ai_conversations.last_hint_level),
        requires_restatement = coalesce(excluded.requires_restatement, ai_conversations.requires_restatement),
        updated_at = coalesce(excluded.updated_at, now())
    `,
    [
      openaiConversationId,
      fields.studentId,
      fields.surface ?? null,
      fields.levelId ?? null,
      fields.questionIndex ?? null,
      fields.promptId ?? null,
      fields.groupTypeSnapshot ?? null,
      fields.openingMessage ?? null,
      fields.lastResponseId ?? null,
      fields.lastPhase ?? null,
      fields.lastStep ?? null,
      fields.lastStage ?? null,
      fields.lastHintLevel ?? null,
      fields.requiresRestatement ?? null,
      fields.createdAt ?? null,
      fields.updatedAt ?? null,
    ]
  );
}

async function getLatestArgumentConversation(studentId, questionIndex) {
  const { rows } = await pool.query(
    `
      select
        openai_conversation_id,
        prompt_id,
        opening_message,
        last_phase,
        last_step,
        last_stage,
        last_hint_level,
        requires_restatement
      from ai_conversations
      where student_id = $1
        and surface = 'argument_chat'
        and question_index = $2
      order by updated_at desc, id desc
      limit 1
    `,
    [studentId, questionIndex]
  );

  return rows[0] ?? null;
}

async function getLatestReflectionConversation(studentId, levelId) {
  if (!levelId) return null;

  const { rows } = await pool.query(
    `
      select
        openai_conversation_id,
        prompt_id,
        level_id,
        last_response_id
      from ai_conversations
      where student_id = $1
        and surface = 'reflection'
        and level_id = $2
      order by updated_at desc, id desc
      limit 1
    `,
    [studentId, levelId]
  );

  return rows[0] ?? null;
}

async function getConversationMessages(openaiConversationId) {
  const { rows } = await pool.query(
    `
      select id, role, message_text
      from ai_messages
      where openai_conversation_id = $1
      order by created_at asc, id asc
    `,
    [openaiConversationId]
  );

  return rows.map((row) => ({
    id: Number(row.id),
    role: row.role,
    text: row.message_text,
  }));
}

async function createAuthSession(studentId) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + AUTH_SESSION_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `
      insert into auth_sessions (student_id, token_hash, expires_at)
      values ($1, $2, $3)
    `,
    [studentId, hashSessionToken(token), expiresAt.toISOString()]
  );

  return token;
}

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;

    if (!token) {
      return res.status(401).json({ error: "missing_auth_token", code: "missing_auth_token" });
    }

    const { rows } = await pool.query(
      `
        select
          s.id,
          s.student_number,
          s.name,
          s.group_type,
          s.learning_status
        from auth_sessions session
        join students s on s.id = session.student_id
        where session.token_hash = $1
          and session.revoked_at is null
          and session.expires_at > now()
        limit 1
      `,
      [hashSessionToken(token)]
    );

    const student = rows[0];
    if (!student || student.learning_status !== "active") {
      return res.status(401).json({ error: "invalid_session", code: "invalid_session" });
    }

    req.student = {
      id: Number(student.id),
      studentNumber: student.student_number,
      name: student.name,
      groupType: student.group_type,
    };

    next();
  } catch (err) {
    const message = getErrorMessage(err);
    console.error("[requireAuth] error:", message);
    res.status(500).json({ error: message || "auth_error" });
  }
}

async function createArgumentConversation(student, qIdx, selectedPromptId, openingMessage) {
  const now = new Date().toISOString();
  const trimmedOpeningMessage =
    typeof openingMessage === "string" && openingMessage.trim() ? openingMessage.trim() : null;

  const conversation = await openai.conversations.create({
    metadata: {
      app: "scientific_argumentation",
      surface: "argument_chat",
      questionIndex: String(qIdx),
      studentId: String(student.id),
      studentNumber: student.studentNumber,
      groupType: student.groupType,
    },
    ...(trimmedOpeningMessage
      ? {
          items: [
            {
              role: "developer",
              content: [
                {
                  type: "input_text",
                  text:
                    "The student has already been shown this opening prompt in the UI. " +
                    "Treat it as prior tutor context, not as a student answer:\n" +
                    trimmedOpeningMessage,
                },
              ],
            },
          ],
        }
      : {}),
  });

  await upsertConversation(conversation.id, {
    studentId: student.id,
    surface: "argument_chat",
    questionIndex: qIdx,
    promptId: selectedPromptId,
    groupTypeSnapshot: student.groupType,
    openingMessage: trimmedOpeningMessage,
    createdAt: now,
    updatedAt: now,
  });

  if (trimmedOpeningMessage) {
    await insertMessage({
      openaiConversationId: conversation.id,
      studentId: student.id,
      surface: "argument_chat",
      questionIndex: qIdx,
      role: "assistant",
      messageText: trimmedOpeningMessage,
      promptId: selectedPromptId,
    });
  }

  return conversation;
}

app.get("/health", async (_req, res) => {
  const { rows } = await pool.query("select now() as database_time");
  res.setHeader("X-Server", "scientific_argumentation_back");
  res.json({ ok: true, time: new Date().toISOString(), databaseTime: rows[0]?.database_time });
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const studentNumber = String(req.body?.studentNumber ?? "").trim();
    const password = String(req.body?.password ?? "").trim();

    if (!studentNumber || !password) {
      return res.status(400).json({ error: "studentNumber and password are required" });
    }

    const { rows } = await pool.query(
      `
        select id, student_number, name, group_type, password_hash, learning_status
        from students
        where student_number = $1
        limit 1
      `,
      [studentNumber]
    );

    const student = rows[0];
    if (!student || student.learning_status !== "active") {
      return res.status(401).json({ error: "帳號不存在或已停用" });
    }

    const isUsingDefaultPassword = !student.password_hash;
    const isValidPassword = isUsingDefaultPassword
      ? password === student.student_number
      : verifyPassword(password, student.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: "帳號或密碼錯誤" });
    }

    if (isUsingDefaultPassword) {
      await pool.query(
        `
          update students
          set password_hash = $2, updated_at = now()
          where id = $1
        `,
        [student.id, makePasswordHash(password)]
      );
    }

    await pool.query(
      `
        update students
        set last_login_at = now(), updated_at = now()
        where id = $1
      `,
      [student.id]
    );

    const token = await createAuthSession(student.id);
    const studentPayload = await getStudentWithStats(student.id);

    res.json({
      token,
      student: studentPayload,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    console.error("[api/auth/login] error:", message);
    res.status(500).json({ error: message || "server_error" });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const studentPayload = await getStudentWithStats(req.student.id);
    res.json({ student: studentPayload });
  } catch (err) {
    const message = getErrorMessage(err);
    console.error("[api/auth/me] error:", message);
    res.status(500).json({ error: message || "server_error" });
  }
});

app.post("/api/chat/init", requireAuth, async (req, res) => {
  try {
    const { questionIndex, openingMessage } = req.body ?? {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing OPENAI_API_KEY in .env" });
    }

    const setup = getQuestionSetup(questionIndex, req.student.groupType);
    if (!setup.ok) {
      return res.status(setup.status).json(setup.body);
    }

    const existingConversation = await getLatestArgumentConversation(req.student.id, setup.qIdx);
    if (existingConversation) {
      const messages = await getConversationMessages(existingConversation.openai_conversation_id);
      return res.json({
        conversationId: existingConversation.openai_conversation_id,
        questionIndex: setup.qIdx,
        promptId: existingConversation.prompt_id ?? setup.selectedPromptId,
        groupType: req.student.groupType,
        restored: true,
        messages,
        phase: existingConversation.last_phase ?? null,
        step: existingConversation.last_step ?? null,
        stage: existingConversation.last_stage ?? null,
        hintLevel: existingConversation.last_hint_level ?? null,
        requiresRestatement: existingConversation.requires_restatement ?? null,
      });
    }

    const conversation = await createArgumentConversation(
      req.student,
      setup.qIdx,
      setup.selectedPromptId,
      openingMessage
    );

    res.json({
      conversationId: conversation.id,
      questionIndex: setup.qIdx,
      promptId: setup.selectedPromptId,
      groupType: req.student.groupType,
      restored: false,
      messages: await getConversationMessages(conversation.id),
      phase: null,
      step: null,
      stage: null,
      hintLevel: null,
      requiresRestatement: null,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    console.error("[api/chat/init] error:", message);
    res.status(500).json({
      error: message || "server_error",
      ...(err?.code != null && { code: err.code }),
      ...(err?.status != null && { status: err.status }),
    });
  }
});

app.post("/api/chat", requireAuth, async (req, res) => {
  try {
    const { userMessage, conversationId, questionIndex } = req.body ?? {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing OPENAI_API_KEY in .env" });
    }
    if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
      return res.status(400).json({ error: "userMessage is required (non-empty string)" });
    }

    const setup = getQuestionSetup(questionIndex, req.student.groupType);
    if (!setup.ok) {
      return res.status(setup.status).json(setup.body);
    }
    const { qIdx, selectedPromptId } = setup;

    const validConvId =
      typeof conversationId === "string" && conversationId.startsWith("conv_")
        ? conversationId
        : null;

    let conversation;

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
      conversation = await createArgumentConversation(req.student, qIdx, selectedPromptId, null);
    }

    await insertMessage({
      openaiConversationId: conversation.id,
      studentId: req.student.id,
      surface: "argument_chat",
      questionIndex: qIdx,
      role: "student",
      messageText: userMessage.trim(),
      promptId: selectedPromptId,
    });

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

    await upsertConversation(conversation.id, {
      studentId: req.student.id,
      surface: "argument_chat",
      questionIndex: qIdx,
      promptId: selectedPromptId,
      groupTypeSnapshot: req.student.groupType,
      lastResponseId: response.id,
      lastPhase: data.phase,
      lastStep: data.step,
      lastStage: data.stage,
      lastHintLevel: data.hintLevel,
      requiresRestatement: data.requiresRestatement,
      updatedAt: new Date().toISOString(),
    });

    await insertMessage({
      openaiConversationId: conversation.id,
      studentId: req.student.id,
      surface: "argument_chat",
      questionIndex: qIdx,
      role: "assistant",
      messageText: data.assistantMessage || "(無回覆內容)",
      promptId: selectedPromptId,
      responseId: response.id,
      phase: data.phase,
      step: data.step,
      stage: data.stage,
      hintLevel: data.hintLevel,
      requiresRestatement: data.requiresRestatement,
    });

    res.json({
      ...data,
      questionIndex: qIdx,
      conversationId: conversation.id,
      responseId: response.id,
      groupType: req.student.groupType,
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

app.post("/api/reflection", requireAuth, async (req, res) => {
  try {
    const { userMessage, conversationId } = req.body ?? {};
    const levelId = normalizeLevelId(req.body?.levelId);
    const reflectionPromptId = getReflectionPromptId(req.student.groupType);
    const normalizedUserMessage = typeof userMessage === "string" ? userMessage.trim() : "";
    const isSyntheticReflectionKickoff = normalizedUserMessage === "（反思開始）";

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "missing OPENAI_API_KEY in .env" });
    }
    if (!reflectionPromptId) {
      return res.status(500).json({
        error: `missing reflection prompt for groupType=${req.student.groupType}`,
      });
    }
    if (!userMessage || typeof userMessage !== "string" || !normalizedUserMessage) {
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
      const existingReflection = await getLatestReflectionConversation(req.student.id, levelId);
      if (existingReflection) {
        try {
          conversation = await openai.conversations.retrieve(existingReflection.openai_conversation_id);
        } catch (retrieveErr) {
          console.error("[api/reflection] latest conversation retrieve failed:", retrieveErr.message);
        }

        if (conversation && isSyntheticReflectionKickoff) {
          const messages = await getConversationMessages(conversation.id);
          if (messages.length === 0) {
            console.warn(
              `[api/reflection] latest reflection conversation has no messages; continuing kickoff: ${conversation.id}`
            );
          } else {
            return res.json({
              assistantMessage: "",
              conversationId: conversation.id,
              restored: true,
              messages,
              groupType: req.student.groupType,
              levelId,
            });
          }
        }
      }

      if (!conversation) {
        conversation = await openai.conversations.create({
          metadata: {
            app: "scientific_argumentation",
            surface: "reflection",
            levelId: levelId ?? "",
            studentId: String(req.student.id),
            studentNumber: req.student.studentNumber,
            groupType: req.student.groupType,
          },
        });
        await upsertConversation(conversation.id, {
          studentId: req.student.id,
          surface: "reflection",
          levelId,
          promptId: reflectionPromptId,
          groupTypeSnapshot: req.student.groupType,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (!isSyntheticReflectionKickoff) {
      await insertMessage({
        openaiConversationId: conversation.id,
        studentId: req.student.id,
        surface: "reflection",
        role: "student",
        messageText: normalizedUserMessage,
        promptId: reflectionPromptId,
      });
    }

    const response = await openai.responses.create({
      model: OPENAI_MODEL,
      prompt: { id: reflectionPromptId },
      conversation: conversation.id,
      input: [{ role: "user", content: normalizedUserMessage }],
      store: true,
    });

    const assistantMessage = response.output_text ?? "";

    await upsertConversation(conversation.id, {
      studentId: req.student.id,
      surface: "reflection",
      levelId,
      promptId: reflectionPromptId,
      groupTypeSnapshot: req.student.groupType,
      lastResponseId: response.id,
      updatedAt: new Date().toISOString(),
    });

    if (assistantMessage.trim()) {
      await insertMessage({
        openaiConversationId: conversation.id,
        studentId: req.student.id,
        surface: "reflection",
        role: "assistant",
        messageText: assistantMessage,
        promptId: reflectionPromptId,
        responseId: response.id,
      });
    }

    res.json({
      assistantMessage,
      conversationId: conversation.id,
      responseId: response.id,
      groupType: req.student.groupType,
      levelId,
    });
  } catch (err) {
    const message = getErrorMessage(err);
    console.error("[api/reflection] error:", message);
    res.status(500).json({ error: message || "server_error" });
  }
});

function start() {
  console.log(`[API] http://localhost:${PORT} (pid=${process.pid})`);
}

initDb()
  .then(() => {
    app.listen(PORT, start);
  })
  .catch((err) => {
    console.error("[PostgreSQL] startup failed:", getErrorMessage(err));
    process.exit(1);
  });
