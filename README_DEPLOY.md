# iPad Online Deploy - Gemini API Key 版

這包適用於 Google AI Studio / Gemini API key。

## Render 設定

- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `TEACHER_KEY=你想設定的老師密碼`
  - `GEMINI_API_KEY=你的 Gemini API key`
  - `GEMINI_MODEL=gemini-2.5-flash`
  - `NODE_VERSION=24.14.1`

## 使用方式

- 學生加入網址：`https://你的網域/join`
- 老師網址：`https://你的網域/teacher?key=你的老師密碼`

## AI 判定流程

學生按「寫好了」後，系統會把畫布 PNG 傳到伺服器，由伺服器使用 Gemini API key 呼叫 Gemini 判定。
AI 只在明確辨識出符合題目/部首且沒有重複的單一中文字時自動過關。
如果看不清楚、不符合題目或已經用過，會自動退回重寫，不會直接淘汰。

老師端保留原本三個按鈕，作為 AI 判定失敗或老師想覆核時的備用操作。

注意：不要把 `GEMINI_API_KEY` 寫進 GitHub 或 HTML，只能放在 Render Environment Variables。
