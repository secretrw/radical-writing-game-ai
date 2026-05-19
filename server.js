const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 8 * 1024 * 1024
});

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Serve the HTML pages and local audio assets used by the teacher dashboard.
app.use(express.static(__dirname));

// 5. 老師端密碼保護
const TEACHER_KEY = process.env.TEACHER_KEY || "1234";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-2.0-flash";
const AI_RETRY_DELAY_MS = 1800;
const GEMINI_RETRY_DELAYS_MS = [1200, 2500];

// 2. 難度分級：部首題目庫
const RADICAL_BANK = {
  easy: ["水", "木", "手", "心", "口", "人", "火", "土", "金", "女"],
  medium: ["阜", "邑", "艸", "辵", "疒", "示", "衣", "肉", "竹", "言"],
  hard: ["龠", "黍", "黹", "鬯", "黽", "鼎", "鼓", "鼠", "鼻", "齊"]
};

// --- 路由設定 ---
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/join', (req, res) => {
  res.redirect('/');
});

app.get('/teacher', (req, res) => {
  if (req.query.key !== TEACHER_KEY) {
    return res.status(403).send("<h1>🚫 存取拒絕</h1>請在網址後方輸入正確的 key (例如: /teacher?key=1234) 才能進入主控台。");
  }
  res.sendFile(__dirname + '/teacher.html');
});

app.get('/health', (req, res) => {
  res.status(200).send('ok');
});

// 4. 斷線重連保護機制
let playersMap = {};     // 格式: { "王大明": "socket_id_xyz", "李小華": null }
let playerOrder = [];    // 格式: ["王大明", "李小華"]
let currentPlayerIndex = 0;

let turnTimer = null;
let countdownTimer = null;
let defaultTime = 15;      
let timeLeft = defaultTime;       
let turnPhase = 'waiting'; // waiting | countdown | running | paused | timeUp
let currentRadical = "水"; 
let usedWords = [];
let gameStarted = false;  // [新增] 遊戲是否已由老師正式開始
let eliminatedPlayers = []; // [新增] 已被淘汰的玩家名單
let geminiClientPromise = null;

function broadcastGameState() {
  removeOfflinePlayersFromActiveGame();
  const currentName = playerOrder.length > 0 ? playerOrder[currentPlayerIndex] : null;
  io.emit('gameState', {
    playerOrder: playerOrder,
    playersMap: playersMap,
    currentName: currentName,
    currentRadical: currentRadical,
    usedWords: usedWords,
    defaultTime: defaultTime,
    timeLeft: timeLeft,
    turnPhase: turnPhase,
    timerRunning: turnPhase === 'running',
    gameStarted: gameStarted  // [新增] 廣播遊戲狀態
  });
}

function removeOfflinePlayersFromActiveGame() {
  if (!gameStarted) return;

  const currentName = playerOrder[currentPlayerIndex];
  playerOrder = playerOrder.filter(name => !!playersMap[name]);

  Object.keys(playersMap).forEach(name => {
    if (!playerOrder.includes(name)) delete playersMap[name];
  });

  if (playerOrder.length === 0) {
    currentPlayerIndex = 0;
    turnPhase = 'waiting';
    return;
  }

  const currentNameIndex = playerOrder.indexOf(currentName);
  if (currentNameIndex >= 0) {
    currentPlayerIndex = currentNameIndex;
  } else if (currentPlayerIndex >= playerOrder.length) {
    currentPlayerIndex = 0;
  }
}

function stopTurnTimer(nextPhase = 'waiting') {
  if (turnTimer) clearInterval(turnTimer);
  if (countdownTimer) clearTimeout(countdownTimer);
  turnTimer = null;
  countdownTimer = null;
  turnPhase = nextPhase;
}

function disconnectStudentSockets() {
  for (const [, connectedSocket] of io.sockets.sockets) {
    if (connectedSocket.handshake.query.role !== 'teacher') {
      connectedSocket.disconnect(true);
    }
  }
}

function startTimer() {
  // [新增] 只有在遊戲已開始後才啟動計時器
  if (!gameStarted) return;
  removeOfflinePlayersFromActiveGame();
  if (playerOrder.length === 0) {
    stopTurnTimer('waiting');
    broadcastGameState();
    return;
  }
  if (turnTimer) clearInterval(turnTimer);
  turnPhase = 'running';
  timeLeft = defaultTime;
  broadcastGameState();
  io.emit('timeUpdate', timeLeft); 

  turnTimer = setInterval(() => {
    timeLeft--;
    io.emit('timeUpdate', timeLeft);

    if (timeLeft <= 0) {
      stopTurnTimer('timeUp');
      io.emit('timeUp');        
      broadcastGameState();
    }
  }, 1000);
}

function resumeCurrentTurnTimer() {
  if (!gameStarted) return;
  removeOfflinePlayersFromActiveGame();
  if (playerOrder.length === 0) return;
  if (turnTimer) clearInterval(turnTimer);
  turnPhase = 'running';
  io.emit('timerResumed');
  broadcastGameState();
  turnTimer = setInterval(() => {
    timeLeft--;
    io.emit('timeUpdate', timeLeft);
    if (timeLeft <= 0) {
      stopTurnTimer('timeUp');
      io.emit('timeUp');
      broadcastGameState();
    }
  }, 1000);
}

function finishTurnWithJudgement(wordWritten) {
  stopTurnTimer('paused');
  removeOfflinePlayersFromActiveGame();
  let isPass = false;
  const currentName = playerOrder[currentPlayerIndex];
  if (!currentName) {
    broadcastGameState();
    return;
  }
  broadcastGameState();

  if (typeof wordWritten === 'string' && wordWritten.trim() !== "" && !usedWords.includes(wordWritten.trim())) {
    usedWords.push(wordWritten.trim());
    isPass = true;
  }

  if (isPass) {
    io.emit('playAnimation', 'pass');
  } else {
    if (currentName && !eliminatedPlayers.includes(currentName)) {
      eliminatedPlayers.push(currentName);
    }
    io.emit('playAnimation', 'fail');
  }

  setTimeout(() => {
    if (!isPass && currentName) {
      playerOrder = playerOrder.filter(p => p !== currentName);
      delete playersMap[currentName];
    }
    removeOfflinePlayersFromActiveGame();

    const isSinglePlayerWin = playerOrder.length === 1 && isPass;
    const isSurvivorship = playerOrder.length === 1 && eliminatedPlayers.length > 0 && !isPass;
    if (isSinglePlayerWin || isSurvivorship) {
      io.emit('gameWinner', playerOrder[0]);
      broadcastGameState();
      return;
    }
    if (playerOrder.length === 0) {
      io.emit('gameWinner', null);
      broadcastGameState();
      return;
    }

    if (!isPass) {
      if (currentPlayerIndex >= playerOrder.length) currentPlayerIndex = 0;
    } else {
      currentPlayerIndex = (currentPlayerIndex + 1) % playerOrder.length;
    }

    io.emit('clearCanvas');
    broadcastGameState();
    startTimer();
  }, 2800);
}

function parseCanvasDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== 'string') throw new Error('缺少學生畫布圖片。');
  const match = imageDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('學生畫布圖片格式不正確。');
  const byteLength = Buffer.byteLength(match[2], 'base64');
  if (byteLength > 6 * 1024 * 1024) throw new Error('學生畫布圖片太大。');
  return { mimeType: match[1], data: match[2] };
}

async function getGeminiClient() {
  if (!geminiClientPromise) {
    geminiClientPromise = import('@google/genai').then(({ GoogleGenAI }) => {
      if (!process.env.GEMINI_API_KEY) {
        throw new Error('Render 尚未設定 GEMINI_API_KEY。');
      }
      return new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY
      });
    });
  }
  return geminiClientPromise;
}

function normalizeGeminiDecision(raw, currentRadicalForJudge) {
  const decision = raw && raw.decision === 'pass' ? 'pass' : 'retry';
  const word = typeof raw?.word === 'string' ? raw.word.trim().slice(0, 4) : '';
  const confidence = typeof raw?.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0;
  const reason = typeof raw?.reason === 'string' && raw.reason.trim()
    ? raw.reason.trim().slice(0, 120)
    : `AI 無法確認這個字符合「${currentRadicalForJudge}」題目。`;
  return { decision, word, confidence, reason };
}

function parseGeminiJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Gemini 回傳空內容。');
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch (firstErr) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(unfenced.slice(start, end + 1));
    }
    throw firstErr;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableGeminiError(err) {
  const status = err?.status || err?.code || err?.error?.code;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function generateGeminiContentWithRetry(ai, request) {
  const models = [GEMINI_MODEL, GEMINI_MODEL, GEMINI_FALLBACK_MODEL].filter(Boolean);
  let lastErr = null;
  for (let attempt = 0; attempt < models.length; attempt++) {
    const model = models[attempt];
    try {
      if (attempt > 0) {
        await sleep(GEMINI_RETRY_DELAYS_MS[Math.min(attempt - 1, GEMINI_RETRY_DELAYS_MS.length - 1)]);
      }
      return {
        response: await ai.models.generateContent({ ...request, model }),
        model
      };
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiError(err) || attempt === models.length - 1) {
        throw err;
      }
      console.warn(`Gemini 模型暫時不可用，準備重試：${model}`, err?.message || err);
    }
  }
  throw lastErr;
}

async function judgeAnswerWithGemini({ imageDataUrl, studentName }) {
  const image = parseCanvasDataUrl(imageDataUrl);
  const ai = await getGeminiClient();
  const usedWordList = usedWords.length ? usedWords.join('、') : '尚無';
  const prompt = [
    '你是繁體中文國小課堂遊戲的助教裁判。請根據學生手寫畫布判斷作答。',
    `目前題目或部首是：「${currentRadical}」。`,
    `目前已經用過的字：${usedWordList}。`,
    `目前作答學生：${studentName || '未知學生'}。`,
    '通過條件：你能辨識出一個單一繁體中文漢字，且它符合目前題目/部首，且沒有出現在已用過的字。',
    '如果畫得太亂、不是單一中文字、看不清楚、不符合題目/部首、或已經用過，請判定 retry。',
    '不要因為筆跡不漂亮就退回；只要能清楚辨識且符合題目即可 pass。',
    'word 欄位只填辨識出的單一中文字；若看不出來請填空字串。reason 用繁體中文，簡短說明。',
    '只輸出 JSON 物件本身，不要使用 ```json 或 Markdown code block。'
  ].join('\n');

  const { response, model: usedModel } = await generateGeminiContentWithRetry(ai, {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: image }
      ]
    }],
    config: {
      temperature: 0.1,
      responseFormat: {
        text: {
          mimeType: 'application/json',
          schema: {
            type: 'object',
            properties: {
              decision: { type: 'string', enum: ['pass', 'retry'] },
              word: { type: 'string' },
              confidence: { type: 'number' },
              reason: { type: 'string' }
            },
            required: ['decision', 'word', 'confidence', 'reason']
          }
        }
      }
    }
  });

  const parsed = parseGeminiJson(response.text);
  const normalized = normalizeGeminiDecision(parsed, currentRadical);
  normalized.model = usedModel;
  if (normalized.decision === 'pass' && (!normalized.word || usedWords.includes(normalized.word))) {
    return {
      ...normalized,
      decision: 'retry',
      reason: normalized.word ? `「${normalized.word}」已經用過，請換一個字。` : normalized.reason
    };
  }
  return normalized;
}

io.on('connection', (socket) => {
  const role = socket.handshake.query.role;
  const studentName = typeof socket.handshake.query.name === 'string' ? socket.handshake.query.name.trim() : '';

  function isCurrentWritingSocket() {
    removeOfflinePlayersFromActiveGame();
    const currentName = playerOrder[currentPlayerIndex];
    return role !== 'teacher'
      && turnPhase === 'running'
      && studentName
      && currentName === studentName
      && playersMap[studentName] === socket.id;
  }
  
  if (role !== 'teacher') {
    // 處理學生連線與斷線重連
    if (studentName) {
      if (gameStarted && !playerOrder.includes(studentName)) {
        socket.emit('gameReset');
        socket.disconnect(true);
        return;
      }
      if (!playerOrder.includes(studentName)) {
        playerOrder.push(studentName);
      }
      playersMap[studentName] = socket.id; // 更新最新的 socket id
    }
    broadcastGameState();
    
    // [修改] 移除「第一位學生加入就自動開始」的邏輯，改由老師手動開始
  } else {
    // 老師連線時同步狀態
    broadcastGameState();
    socket.emit('timeUpdate', timeLeft);
  }

  socket.on('drawing', (data) => {
    if (!isCurrentWritingSocket()) return;
    socket.broadcast.emit('drawing', data);
  });

  socket.on('syncCanvas', (dataURL) => {
    if (!isCurrentWritingSocket()) return;
    socket.broadcast.emit('syncCanvas', dataURL);
  });

  socket.on('clearCanvas', () => {
    if (!isCurrentWritingSocket()) return;
    io.emit('clearCanvas');
  });

  socket.on('studentDone', async (payload = {}) => {
    if (!isCurrentWritingSocket()) return;
    const currentName = playerOrder[currentPlayerIndex];
    stopTurnTimer('paused');
    io.emit('timerPaused');
    broadcastGameState();
    io.emit('aiJudgeStart', { studentName: currentName });

    try {
      const result = await judgeAnswerWithGemini({
        imageDataUrl: payload.imageDataUrl,
        studentName: currentName
      });
      io.emit('aiJudgeResult', {
        ...result,
        studentName: currentName,
        radical: currentRadical,
        model: result.model || GEMINI_MODEL
      });

      if (result.decision === 'pass') {
        finishTurnWithJudgement(result.word);
      } else {
        setTimeout(() => {
          if (gameStarted && turnPhase === 'paused') resumeCurrentTurnTimer();
        }, AI_RETRY_DELAY_MS);
      }
    } catch (err) {
      console.error('Gemini 判定失敗：', err);
      io.emit('aiJudgeError', {
        studentName: currentName,
        message: err.message || 'Gemini 判定失敗，請老師手動判定。'
      });
    }
  });

  socket.on('teacherRejectRetry', () => {
    resumeCurrentTurnTimer();
  });

  socket.on('teacherNextTurn', (wordWritten) => {
    finishTurnWithJudgement(wordWritten);
  });
  
  // 原有手動更換題目
  socket.on('changeRadical', (newRadical) => {
    stopTurnTimer('waiting');
    currentRadical = newRadical;
    usedWords = [];
    broadcastGameState();
    // [修改] 不自動開始計時，等老師手動按「開始計時」
  });

  // 新增：老師端隨機題庫抽題
  socket.on('drawRadical', (level) => {
    stopTurnTimer('waiting');
    const bank = RADICAL_BANK[level] || RADICAL_BANK.easy;
    currentRadical = bank[Math.floor(Math.random() * bank.length)];
    usedWords = [];
    broadcastGameState();
    // [修改] 不自動開始計時，等老師手動按「開始計時」
  });

  socket.on('updateTimeSetting', (newTime) => {
    const parsedTime = parseInt(newTime);
    if (!isNaN(parsedTime) && parsedTime > 0) {
      defaultTime = parsedTime;
      console.log(`老師將時間更改為：${defaultTime} 秒`);
    }
  });

  // [新增] 老師按下「開始遊戲」→ 僅進入主控台，不自動開始計時
  socket.on('startGame', () => {
    if (gameStarted) return; // 防止重複觸發
    if (playerOrder.length === 0) return; // 無學生則不開始
    stopTurnTimer('waiting');
    gameStarted = true;
    currentPlayerIndex = 0;
    broadcastGameState();
    // ★ 不呼叫 startTimer()，等老師手動按「開始計時」
    console.log('🎮 遊戲進入主控台，等待老師開始計時。');
  });

  // [新增] 老師手動按下「開始計時」
  socket.on('startTimerNow', () => {
    if (!gameStarted) return;
    if (turnPhase !== 'waiting') return;
    removeOfflinePlayersFromActiveGame();
    if (playerOrder.length === 0) return;
    stopTurnTimer('countdown');
    broadcastGameState();
    io.emit('countdownStart', { steps: ['3', '2', '1', 'GO'], interval: 900 });
    countdownTimer = setTimeout(() => {
      countdownTimer = null;
      if (!gameStarted || turnPhase !== 'countdown') return;
      startTimer();
      console.log('⏱️ 倒數結束，正式開始計時！');
    }, 3600);
    console.log('⏳ 老師手動開始倒數。');
  });

  // [修改] 老師重置遊戲：清除玩家名單，讓學生重新加入大廳
  socket.on('resetGame', () => {
    stopTurnTimer('waiting');
    gameStarted = false;
    currentPlayerIndex = 0;
    timeLeft = defaultTime;
    usedWords = [];
    eliminatedPlayers = []; // [新增] 清除淘汰名單
    playerOrder = [];
    playersMap = {};
    io.emit('gameReset');
    disconnectStudentSockets();
    broadcastGameState();
    console.log('🔄 遊戲已重置，玩家名單已清除，回到等待大廳。');
  });

  // [新增] 老師宣布重新開始整場遊戲（學生需重新輸入姓名）
  socket.on('fullReset', () => {
    stopTurnTimer('waiting');
    gameStarted = false;
    currentPlayerIndex = 0;
    timeLeft = defaultTime;
    usedWords = [];
    eliminatedPlayers = [];
    playerOrder = [];
    playersMap = {};
    io.emit('fullReset'); // 通知所有學生清除姓名並重新加入
    setTimeout(disconnectStudentSockets, 250);
    broadcastGameState();
    console.log('🔄 完整重置，學生需重新輸入姓名。');
  });

  // 舊版學生頁面可能還會在 resetGame 後送出 studentRejoin；一律斷開，避免幽靈學生回到名單。
  socket.on('studentRejoin', (name) => {
    socket.emit('gameReset');
    socket.disconnect(true);
  });

  // [新增] 老師在大廳手動清除離線玩家
  socket.on('removeOfflinePlayers', () => {
    playerOrder = playerOrder.filter(name => !!playersMap[name]);
    broadcastGameState();
    console.log('🧹 已清除所有離線玩家。');
  });

  socket.on('disconnect', () => {
    if (role !== 'teacher' && studentName) {
      // [修正] 只有當這個 socket 還是該玩家的現役連線時才標記為離線
      // 避免重新連線後舊 socket 斷線把新連線覆蓋成 null（幽靈玩家根源）
      if (playersMap[studentName] === socket.id) {
        playersMap[studentName] = null;
        if (gameStarted) removeOfflinePlayersFromActiveGame();
        broadcastGameState();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`伺服器啟動！`);
  console.log(`👨‍🎓 學生請前往: http://localhost:${PORT}`);
  console.log(`👨‍🏫 老師請前往: http://localhost:${PORT}/teacher?key=${TEACHER_KEY}`);
});
