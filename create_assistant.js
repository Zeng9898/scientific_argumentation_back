// ============================================================
// DEPRECATED — 不再被系統依賴
// 本專案已從 Assistants API 遷移至 Responses API + Conversations。
// server.js 不再使用 ASSISTANT_ID，此檔案僅作歷史參考，請勿執行。
// ============================================================
import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Assistants API (beta) object model per official API reference/deep dive :contentReference[oaicite:4]{index=4}
const assistant = await client.beta.assistants.create({
    name: "Scientific Argumentation Helper",
    // 你之後會把長流程 prompt 放這裡（先短版跑通）
    instructions: [
        "你是科學論證小幫手，請用繁體中文一步一步引導學生。",
        "每次回覆都要輸出 JSON（不要加其他文字）。",
        'JSON schema: {"stage":"claim|evidence|reasoning|revise","assistantMessage":string}.',
    ].join("\n"),
    model: "gpt-4.1-mini",
});

console.log("ASSISTANT_ID =", assistant.id);