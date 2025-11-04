const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useSingleFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const http = require('http');

// Logging utility with configurable levels
const LOG_LEVEL = process.env.LOG_LEVEL || 'info'; // debug|info|error
const LOG_LEVELS = { debug: 0, info: 1, error: 2 };

function log(level, ...args) {
  if (LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL]) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}]`, ...args);
  }
}

// Singleton pattern: prevent multiple bot instances
let botRunning = false;

// Use multi-file auth state (v7+ of baileys)
// We'll initialize this inside startBot() because useMultiFileAuthState is async
// and returns { state, saveCreds }.

const CONFIG_PATH = path.join(__dirname, 'bot_config.json');

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      const defaultConfig = {
        mode: 'online', // 'online' | 'offline' | 'busy' (treat 'busy' same as 'online')
        ownerName: 'Nama',
        whitelist: [],
        blacklist: [],
        adminNumbers: [],
          suppressWhenOwnerActive: false,
          suppressTimeoutSeconds: 120,
      autoReply: true,
      replyCooldownSeconds: 3600
      };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
      return defaultConfig;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return JSON.parse(raw);
    } catch (e) {
      log('error', 'Failed to load config, using defaults', e);
      return { mode: 'online', ownerName: 'Nama', whitelist: [], blacklist: [], adminNumbers: [], suppressWhenOwnerActive: false, suppressTimeoutSeconds: 120, autoReply: true, replyCooldownSeconds: 3600 };
    }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log('error', 'Failed to save config', e);
  }
}

let config = loadConfig();
// set default cooldown to 60s (1 minute) only if not configured
if (typeof config.replyCooldownSeconds !== 'number') {
  config.replyCooldownSeconds = 60;
  saveConfig(config);
}

function jidToNumber(jid) {
  if (!jid) return null;
  return jid.split('@')[0];
}

async function startBot() {
  if (botRunning) {
    log('info', 'Bot already running, skipping duplicate start');
    return;
  }
  botRunning = true;
  
  try {
    // Fetch latest WA Web protocol version
    const { version } = await fetchLatestBaileysVersion();

    // initialize multi-file auth state. Allow overriding path with AUTH_DIR env var
    const { useMultiFileAuthState } = require('@whiskeysockets/baileys');
    const authDir = process.env.AUTH_DIR ? path.resolve(process.env.AUTH_DIR) : path.join(__dirname, 'auth_info');
    try {
      // ensure directory exists (useful when mounting an empty volume)
      fs.mkdirSync(authDir, { recursive: true });
    } catch (e) {
      // ignore mkdir errors - useMultiFileAuthState will report if needed
    }
    log('info', 'Using auth directory:', authDir);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // load persisted "replied" set to ensure we reply at-most-once per incoming message
    const REPLIED_PATH = path.join(__dirname, 'replied.json');
    let repliedSet = new Set();
    try {
      if (fs.existsSync(REPLIED_PATH)) {
        const raw = fs.readFileSync(REPLIED_PATH, 'utf8');
        const arr = JSON.parse(raw || '[]');
        if (Array.isArray(arr)) repliedSet = new Set(arr);
      }
    } catch (e) {
      log('error', 'Failed to load replied.json', e);
      repliedSet = new Set();
    }

    function saveReplied() {
      try {
        const tmpPath = REPLIED_PATH + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(Array.from(repliedSet), null, 2));
        fs.renameSync(tmpPath, REPLIED_PATH); // atomic on POSIX
      } catch (e) {
        log('error', 'Failed to save replied.json', e);
      }
    }

    // assist state: per-sender preference for assistance buttons
    const ASSIST_PATH = path.join(__dirname, 'assist_state.json');
    let assistState = { bySender: {} };
    try {
      if (fs.existsSync(ASSIST_PATH)) {
        const raw = fs.readFileSync(ASSIST_PATH, 'utf8');
        const obj = JSON.parse(raw || '{}');
        if (obj && typeof obj === 'object') assistState = obj;
      }
    } catch (e) {
      log('error', 'Failed to load assist_state.json', e);
      assistState = { bySender: {} };
    }

    function saveAssistState() {
      try {
        const tmpPath = ASSIST_PATH + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(assistState, null, 2));
        fs.renameSync(tmpPath, ASSIST_PATH); // atomic on POSIX
      } catch (e) {
        log('error', 'Failed to save assist_state.json', e);
      }
    }

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: true,
      auth: state,
      version
    });

    // save auth creds when updated
    sock.ev.on('creds.update', saveCreds);

    // connection updates (qr, open, close)
    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        // show QR in terminal for initial login
        qrcode.generate(qr, { small: true });
        log('info', 'QR code generated - scan with WhatsApp');
      }

      if (connection === 'open') {
        log('info', '✅ Connected to WhatsApp');
        // update ownerName from session if available
        try {
          const me = state.creds?.me;
          if (me && me.name && (!config.ownerName || config.ownerName === 'Nama')) {
            config.ownerName = me.name;
            saveConfig(config);
          }
        } catch (e) {
          // ignore
        }
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        log('info', 'Connection closed, status code:', reason);
        // if logged out, stop; otherwise reconnect after delay
        if (reason !== DisconnectReason.loggedOut) {
          log('info', 'Reconnecting in 5 seconds...');
          setTimeout(() => startBot(), 5000);
        } else {
          log('info', 'Logged out. Delete auth_info and re-run to re-authenticate.');
          process.exit(0);
        }
      }
    });

      // ownerJid and presence tracking for suppression / assist
      let ownerJid = undefined;
      try {
        ownerJid = state.creds?.me?.id || (state.creds?.me && `${state.creds.me?.user}@s.whatsapp.net`);
        if (ownerJid) log('info', 'Owner JID:', ownerJid);
      } catch (e) {
        // ignore
      }

      let lastOwnerActive = 0; // timestamp ms of last owner activity
      let ownerOnline = false; // presence flag
      // how long of idle before we consider owner "not actively viewing" (seconds)
      const OWNER_IDLE_SECONDS = (config.ownerIdleSeconds || 30);

    // simple per-number cooldown map (avoid spam replies)
    const lastReplyAt = new Map();

      // listen for presence updates; shape varies across versions
      sock.ev.on('presence.update', (update) => {
        try {
          const now = Date.now();
          if (!update) return;
          // detect owner presence/online and activity
          const isOwnerUpdate = (update.id && ownerJid && update.id === ownerJid) || (typeof update === 'object' && Object.keys(update).some(k => k === ownerJid || k === (ownerJid?.split('@')[0])));
          // helper to inspect presence objects for "available" or composing states
          const checkPresenceAvailable = (u) => {
            try {
              if (!u) return false;
              if (u.presence && u.presence === 'available') return true;
              if (u.lastKnownPresence && u.lastKnownPresence === 'available') return true;
              if (u.presences) {
                for (const v of Object.values(u.presences)) {
                  if (!v) continue;
                  if (v.presence === 'available' || v.lastKnownPresence === 'available') return true;
                  if (v.chatState === 'composing') return true;
                }
              }
              return false;
            } catch (e) { return false; }
          };

          try {
            const online = checkPresenceAvailable(update) || checkPresenceAvailable(update.presences || update[ownerJid]);
            ownerOnline = !!online;
            if (isOwnerUpdate) {
              // update lastOwnerActive timestamp when owner presence update occurs
              lastOwnerActive = now;
              lastOwnerActiveGlobal = now; // for health endpoint
              if (config.suppressWhenOwnerActive) log('debug', 'Presence detected for owner, updated lastOwnerActive');
            }
          } catch (e) {
            // ignore
          }
        } catch (e) {
          // ignore
        }
      });

    // Track when admin reads messages
    sock.ev.on('messages.update', async (updates) => {
      try {
        for (const update of updates) {
          // if message status changed to 'read' or has readTimestamp
          if (update.update?.status === 4 || update.update?.status === 'read' || update.key?.fromMe) {
            lastOwnerActive = Date.now();
            lastOwnerActiveGlobal = lastOwnerActive;
            log('debug', 'Admin read message - updated lastOwnerActive');
          }
        }
      } catch (e) {
        // ignore
      }
    });

    // Handle incoming messages - UNIFIED handler (track admin activity + auto-reply)
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = m.messages;
        if (!messages || messages.length === 0) return;
        
        // First pass: track admin outgoing messages
        for (const message of messages) {
          if (message.key && message.key.fromMe) {
            lastOwnerActive = Date.now();
            lastOwnerActiveGlobal = lastOwnerActive;
            log('debug', 'Admin sent message - updated lastOwnerActive');
          }
        }
        
        // Second pass: handle incoming for auto-reply (only first message)
        const msg = messages[0];
        // Ignore status messages or messages without content
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        // Only reply to private chats (not groups). Group JIDs end with @g.us
        if (!from || from.endsWith('@g.us')) return;

        // Don't reply to our own sent messages (prevent loops)
        if (msg.key.fromMe) return;

        // Extract remote number early for self-chat check
        const remoteNumber = jidToNumber(from);
        
        // CRITICAL: Skip self-chat - if user is messaging themselves
        const ownerJid = config.adminNumbers && config.adminNumbers[0] ? `${config.adminNumbers[0]}@s.whatsapp.net` : null;
        const ownerNumber = config.adminNumbers && config.adminNumbers[0] ? config.adminNumbers[0] : null;
        
        if (ownerJid && from === ownerJid) {
          log('debug', 'Skipping self-chat message from owner JID:', from);
          return;
        }
        if (ownerNumber && remoteNumber === ownerNumber) {
          log('debug', 'Skipping self-chat message from owner number:', remoteNumber);
          return;
        }

        // Extract text content (support different message shapes)
        const getText = () => {
          const message = msg.message;
          if (message.conversation) return message.conversation;
          if (message.extendedTextMessage && message.extendedTextMessage.text) return message.extendedTextMessage.text;
          if (message.imageMessage && message.imageMessage.caption) return message.imageMessage.caption;
          if (message.videoMessage && message.videoMessage.caption) return message.videoMessage.caption;
          return '';
        };

        const text = (getText() || '').trim();
        log('info', 'Incoming message from', remoteNumber, '-', text);

        // Create a unique key per incoming message to ensure we reply at-most-once per message
        const messageKey = `${remoteNumber}_${msg.key.id}`;
        if (repliedSet.has(messageKey)) {
          log('debug', 'Already replied to message', messageKey, '- skipping');
          return;
        }

        // Handle button/list responses first (user interaction with "Apakah Terbantu?" buttons)
        try {
          const btn = msg.message?.buttonsResponseMessage || msg.message?.templateButtonReplyMessage || null;
          const list = msg.message?.listResponse || null;
          const selected = btn?.selectedButtonId || btn?.selectedId || list?.singleSelectReply?.selectedRowId || null;
          const normalized = (selected || text || '').toString().trim().toLowerCase();
          if (normalized) {
            if (normalized === 'assist_yes' || normalized === 'iya' || normalized === 'yes') {
              assistState.bySender[remoteNumber] = assistState.bySender[remoteNumber] || {};
              assistState.bySender[remoteNumber].assistEnabled = true;
              assistState.bySender[remoteNumber].lastDeniedAt = 0;
              saveAssistState();
              await sock.sendMessage(from, { text: 'Terima kasih — saya akan terus membalas saat admin belum melihat chat.' });
              return;
            }
            if (normalized === 'assist_no' || normalized === 'tidak' || normalized === 'no') {
              assistState.bySender[remoteNumber] = assistState.bySender[remoteNumber] || {};
              assistState.bySender[remoteNumber].assistEnabled = false;
              assistState.bySender[remoteNumber].lastDeniedAt = Date.now();
              saveAssistState();
              const cooldownMin = Math.round(((config.assistCooldownSeconds || 3600) / 60));
              await sock.sendMessage(from, { text: `Baik. Saya tidak akan membalas selama ${cooldownMin} menit.` });
              return;
            }
          }
        } catch (e) {
          // ignore button handling errors
        }

        // Admin commands: only from configured adminNumbers
        const isAdmin = config.adminNumbers.includes(remoteNumber);
        if (isAdmin && text.startsWith('!')) {
          const parts = text.slice(1).trim().split(/\s+/);
          const cmd = parts[0]?.toLowerCase();
          const args = parts.slice(1);

          if (cmd === 'status') {
            const val = (args[0] || '').toLowerCase();
            if (['online', 'offline', 'busy'].includes(val)) {
              config.mode = val;
              saveConfig(config);
              await sock.sendMessage(from, { text: `✅ Mode berhasil diubah menjadi: ${val}` });
            } else {
              await sock.sendMessage(from, { text: 'Gunakan: !status online|offline|busy' });
            }
            return;
          }

          if (cmd === 'whitelist') {
            const sub = args[0];
            const num = args[1];
            if (sub === 'add' && num) {
              if (!config.whitelist.includes(num)) config.whitelist.push(num);
              saveConfig(config);
              await sock.sendMessage(from, { text: `➕ Nomor ${num} berhasil ditambahkan ke whitelist.` });
            } else if (sub === 'remove' && num) {
              config.whitelist = config.whitelist.filter(n => n !== num);
              saveConfig(config);
              await sock.sendMessage(from, { text: `➖ Nomor ${num} dihapus dari whitelist.` });
            } else {
              await sock.sendMessage(from, { text: 'Gunakan: !whitelist add|remove <nomor>' });
            }
            return;
          }

          if (cmd === 'blacklist') {
            const sub = args[0];
            const num = args[1];
            if (sub === 'add' && num) {
              if (!config.blacklist.includes(num)) config.blacklist.push(num);
              saveConfig(config);
              await sock.sendMessage(from, { text: `⛔ Nomor ${num} berhasil ditambahkan ke blacklist.` });
            } else if (sub === 'remove' && num) {
              config.blacklist = config.blacklist.filter(n => n !== num);
              saveConfig(config);
              await sock.sendMessage(from, { text: `✔️ Nomor ${num} telah dihapus dari blacklist.` });
            } else {
              await sock.sendMessage(from, { text: 'Gunakan: !blacklist add|remove <nomor>' });
            }
            return;
          }

          if (cmd === 'show') {
            await sock.sendMessage(from, { text: `📋 Config saat ini:\n• mode: ${config.mode}\n• ownerName: ${config.ownerName}\n• whitelist: ${config.whitelist.join(', ') || '-'}\n• blacklist: ${config.blacklist.join(', ') || '-'}\n• adminNumbers: ${config.adminNumbers.join(', ') || '-'}\n• suppressWhenOwnerActive: ${config.suppressWhenOwnerActive}\n• suppressTimeoutSeconds: ${config.suppressTimeoutSeconds}` });
            return;
          }

          if (cmd === 'admin') {
            const sub = args[0];
            const num = args[1];
            if (sub === 'add' && num) {
              if (!config.adminNumbers.includes(num)) config.adminNumbers.push(num);
              saveConfig(config);
              await sock.sendMessage(from, { text: `🔐 Nomor ${num} berhasil ditambahkan sebagai admin.` });
            } else if (sub === 'remove' && num) {
              config.adminNumbers = config.adminNumbers.filter(n => n !== num);
              saveConfig(config);
              await sock.sendMessage(from, { text: `🔓 Nomor ${num} telah dihapus dari admin.` });
            } else {
              await sock.sendMessage(from, { text: 'Gunakan: !admin add|remove <nomor>' });
            }
            return;
          }

          if (cmd === 'suppress') {
            const sub = args[0];
            if (!sub) {
              await sock.sendMessage(from, { text: 'Gunakan: !suppress on|off OR !suppress timeout <seconds>' });
              return;
            }
            if (sub === 'on' || sub === 'off') {
              config.suppressWhenOwnerActive = (sub === 'on');
              saveConfig(config);
              await sock.sendMessage(from, { text: `🔕 suppressWhenOwnerActive sudah ${config.suppressWhenOwnerActive ? 'ON' : 'OFF'}` });
              return;
            }
            if (sub === 'timeout') {
              const sec = parseInt(args[1] || '', 10);
              if (!isNaN(sec) && sec >= 0) {
                config.suppressTimeoutSeconds = sec;
                saveConfig(config);
                await sock.sendMessage(from, { text: `⏱️ suppressTimeoutSeconds diset ke ${sec} detik` });
              } else {
                await sock.sendMessage(from, { text: 'Gunakan: !suppress timeout <seconds> (contoh: !suppress timeout 120)' });
              }
              return;
            }
            await sock.sendMessage(from, { text: 'Perintah suppress tidak dikenali. Gunakan on|off atau timeout.' });
            return;
          }

          if (cmd === 'autoreply') {
            const val = (args[0] || '').toLowerCase();
            if (val === 'on' || val === 'off') {
              config.autoReply = (val === 'on');
              saveConfig(config);
              await sock.sendMessage(from, { text: `🔁 Auto-reply sekarang: ${config.autoReply ? 'ON' : 'OFF'}` });
            } else {
              await sock.sendMessage(from, { text: 'Gunakan: !autoreply on|off' });
            }
            return;
          }

          if (cmd === 'cooldown') {
            const sec = parseInt(args[0] || '', 10);
            if (!isNaN(sec) && sec >= 0) {
              config.replyCooldownSeconds = sec;
              saveConfig(config);
              await sock.sendMessage(from, { text: `⏱️ cooldown reply diset ke ${sec} detik` });
            } else {
              await sock.sendMessage(from, { text: 'Gunakan: !cooldown <seconds> (contoh: !cooldown 60)' });
            }
            return;
          }

          await sock.sendMessage(from, { text: 'Perintah admin tidak dikenali. Ketik !show untuk melihat konfigurasi saat ini.' });
          return;
        }

        // Blacklist handling
        if (config.blacklist.includes(remoteNumber)) {
          log('debug', 'Sender in blacklist, ignoring:', remoteNumber);
          return;
        }

        // Whitelist handling: if whitelist non-empty, only respond to those in whitelist
        if (config.whitelist.length > 0 && !config.whitelist.includes(remoteNumber)) {
          log('debug', 'Sender not in whitelist, ignoring:', remoteNumber);
          return;
        }

        // If suppressWhenOwnerActive is enabled and owner was recently active, skip auto-reply
        if (config.suppressWhenOwnerActive) {
          try {
            const now = Date.now();
            const since = now - (lastOwnerActive || 0);
            const timeoutMs = (config.suppressTimeoutSeconds || 120) * 1000;
            if (lastOwnerActive && since <= timeoutMs) {
              log('debug', `Owner active recently (${Math.round(since/1000)}s ago) — suppressing auto-reply to ${remoteNumber}`);
              return;
            }
          } catch (e) {
            // ignore suppression errors
          }
        }
        // If autoReply disabled, do not send automatic replies to normal users
        if (!config.autoReply) {
          log('debug', 'Auto-reply disabled, ignoring message from', remoteNumber);
          return;
        }

        // Assist logic: if owner is online but idle (not actively viewing), decide whether to reply
        let shouldReply = true;
        let useButtons = false;
        
        try {
          const nowMs = Date.now();
          const adminOnline = !!ownerOnline;
          const adminIdle = ((nowMs - (lastOwnerActive || 0)) / 1000) > OWNER_IDLE_SECONDS;
          const assistCooldown = (config.assistCooldownSeconds || 3600);
          const st = assistState.bySender[remoteNumber] || { assistEnabled: true, lastDeniedAt: 0, lastRepliedMsgId: null };

          log('debug', `Assist check: adminOnline=${adminOnline}, adminIdle=${adminIdle}, idleSeconds=${Math.round((nowMs - lastOwnerActive)/1000)}, threshold=${OWNER_IDLE_SECONDS}`);

          if (adminOnline && adminIdle) {
            // Check if we already replied to this exact message
            if (st.lastRepliedMsgId === msg.key.id) {
              log('debug', 'Already replied to this message ID for', remoteNumber, '- skipping');
              return;
            }

            // if sender explicitly disabled assist and still in cooldown, skip
            if (st.assistEnabled === false && st.lastDeniedAt && ((nowMs - st.lastDeniedAt) / 1000) < assistCooldown) {
              log('debug', 'Assist disabled for', remoteNumber, 'and still in cooldown — skipping reply');
              return;
            }

            // If assist enabled (user previously said Iya), proceed with normal reply
            if (st.assistEnabled === true) {
              shouldReply = true;
              useButtons = false;
            } else {
              // First time or cooldown expired - show buttons
              shouldReply = true;
              useButtons = true;
            }
          } else {
            // Admin is not online+idle - use normal auto-reply behavior
            shouldReply = true;
            useButtons = false;
          }

          // Store state
          assistState.bySender[remoteNumber] = st;
        } catch (e) {
          log('error', 'Assist logic error:', e);
          // ignore assist errors, fallback to normal reply
        }

        if (!shouldReply) {
          return;
        }

        // rate limit (per-number cooldown) - CHECK BEFORE replying
        try {
          const now = Date.now();
          const last = lastReplyAt.get(remoteNumber) || 0;
          const cooldownMs = (config.replyCooldownSeconds || 60) * 1000;
          if (now - last < cooldownMs) {
            log('debug', `Skipping reply due cooldown for ${remoteNumber} (wait ${Math.ceil((cooldownMs - (now-last))/1000)}s)`);
            return;
          }
        } catch (e) {
          // ignore cooldown errors
        }

        // Generate reply depending on mode (more friendly phrasing) and time of day
        const owner = config.ownerName || 'Pemilik';

        function getTimeGreeting() {
          // Use server/local timezone. Returns Indonesian greeting based on hour.
          const hr = new Date().getHours();
          if (hr >= 4 && hr < 10) return 'Selamat pagi';
          if (hr >= 10 && hr < 15) return 'Selamat siang';
          if (hr >= 15 && hr < 18) return 'Selamat sore';
          return 'Selamat malam';
        }

        const timeGreet = getTimeGreeting();
        let reply = `${timeGreet} 👋\nTerima kasih sudah menghubungi ${owner}. Saya adalah asisten virtual ${owner}.`;
        const lower = text.toLowerCase();
        if (lower.includes('halo') || lower.includes('hi') || lower.includes('hello') || lower.includes('selamat')) {
          reply = `${timeGreet} 👋! Terima kasih sudah menyapa. Pesan Anda sudah diterima oleh ${owner}.`;
        } else if (lower.includes('terima kasih') || lower.includes('thanks')) {
          reply = `Sama-sama 😊 Senang bisa membantu.`;
        }

        if (config.mode === 'online' || config.mode === 'busy') {
          // When owner is online but busy — use friendlier, multi-line template
          reply = `Hai, ${timeGreet} 👋\nSaya adalah asisten virtual milik ${owner}.\nSaat ini ${owner} sedang sibuk, mohon ditunggu beberapa saat hingga beliau dapat membalas pesan Anda.\nTerima kasih atas perhatian dan pengertiannya 🙏`;
        } else if (config.mode === 'offline') {
          // When owner is offline (friendly multiline template)
          reply = `${timeGreet} 👋\nMohon maaf, *${owner}* saat ini sedang tidak aktif.\nSilakan tinggalkan pesan, dan *${owner}* akan membalasnya setelah kembali online.\nTerima kasih atas pengertian dan kesabarannya 🙏`;
        }

        // Send reply
        try {
          const st = assistState.bySender[remoteNumber] || { assistEnabled: true, lastDeniedAt: 0, lastRepliedMsgId: null };

          if (useButtons) {
            // ask user if they are helped (buttons)
            const buttons = [
              { buttonId: 'assist_yes', buttonText: { displayText: 'Iya' }, type: 1 },
              { buttonId: 'assist_no', buttonText: { displayText: 'Tidak' }, type: 1 }
            ];
            const buttonMessage = {
              text: reply,
              footerText: 'Apakah Terbantu?',
              buttons,
              headerType: 1
            };
            await sock.sendMessage(from, buttonMessage);
          } else {
            // normal text reply
            await sock.sendMessage(from, { text: reply });
          }

          // NOW mark cooldown AFTER successful send
          lastReplyAt.set(remoteNumber, Date.now());

          // mark this message as replied (persist so we don't reply again to same message)
          try {
            repliedSet.add(messageKey);
            saveReplied();
            // Also store in assist state
            st.lastRepliedMsgId = msg.key.id;
            assistState.bySender[remoteNumber] = st;
            saveAssistState();
            repliedCountGlobal = repliedSet.size; // update health metric
          } catch (e) {
            // ignore save errors
          }
          log('info', 'Replied to', remoteNumber, 'mode:', config.mode, 'buttons:', useButtons);
        } catch (e) {
          log('error', 'Failed to send reply:', e);
        }

      } catch (err) {
        log('error', 'Error handling message:', err);
      }
    });

  } catch (err) {
    log('error', 'Failed to start bot:', err);
    botRunning = false;
  }
}

// Health check endpoint for monitoring
let lastOwnerActiveGlobal = 0;
let repliedCountGlobal = 0;

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: process.uptime(),
      botRunning,
      lastOwnerActive: lastOwnerActiveGlobal ? new Date(lastOwnerActiveGlobal).toISOString() : null,
      repliedCount: repliedCountGlobal,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const HEALTH_PORT = process.env.HEALTH_PORT || 3000;
healthServer.listen(HEALTH_PORT, () => {
  log('info', `Health check endpoint running on http://localhost:${HEALTH_PORT}/health`);
});

startBot();
