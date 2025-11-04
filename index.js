const fs = require('fs');
const path = require('path');
const { default: makeWASocket, useSingleFileAuthState, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

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
    console.error('Failed to load config, using defaults', e);
    return { mode: 'online', ownerName: 'Nama', whitelist: [], blacklist: [], adminNumbers: [], suppressWhenOwnerActive: false, suppressTimeoutSeconds: 120, autoReply: true, replyCooldownSeconds: 3600 };
  }
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('Failed to save config', e);
  }
}

let config = loadConfig();
// set default cooldown to 60s (1 minute) unless user explicitly configured otherwise
if (typeof config.replyCooldownSeconds !== 'number' || config.replyCooldownSeconds !== 60) {
  config.replyCooldownSeconds = 60;
  saveConfig(config);
}

function jidToNumber(jid) {
  if (!jid) return null;
  return jid.split('@')[0];
}

async function startBot() {
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
    console.log('Using auth directory:', authDir);
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
      console.error('Failed to load replied.json', e);
      repliedSet = new Set();
    }

    function saveReplied() {
      try {
        fs.writeFileSync(REPLIED_PATH, JSON.stringify(Array.from(repliedSet), null, 2));
      } catch (e) {
        console.error('Failed to save replied.json', e);
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
      console.error('Failed to load assist_state.json', e);
      assistState = { bySender: {} };
    }

    function saveAssistState() {
      try {
        fs.writeFileSync(ASSIST_PATH, JSON.stringify(assistState, null, 2));
      } catch (e) {
        console.error('Failed to save assist_state.json', e);
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
        console.log('QR code generated - scan with WhatsApp');
      }

      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp');
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
        console.log('Connection closed, status code:', reason);
        // if logged out, stop; otherwise try reconnecting
        if (reason !== DisconnectReason.loggedOut) {
          console.log('Reconnecting...');
          startBot();
        } else {
          console.log('Logged out. Delete auth_info.json and re-run to re-authenticate.');
        }
      }
    });

      // ownerJid and presence tracking for suppression / assist
      let ownerJid = undefined;
      try {
        ownerJid = state.creds?.me?.id || (state.creds?.me && `${state.creds.me?.user}@s.whatsapp.net`);
        if (ownerJid) console.log('Owner JID:', ownerJid);
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
              if (config.suppressWhenOwnerActive) console.log('Presence detected for owner, updated lastOwnerActive');
            }
          } catch (e) {
            // ignore
          }
        } catch (e) {
          // ignore
        }
      });

    // Handle incoming messages
    sock.ev.on('messages.upsert', async (m) => {
      try {
        const messages = m.messages;
        if (!messages || messages.length === 0) return;
        const msg = messages[0];
        // Ignore status messages or messages without content
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        // Only reply to private chats (not groups). Group JIDs end with @g.us
        if (!from || from.endsWith('@g.us')) return;

        // Don't reply to our own sent messages (prevent loops)
        if (msg.key.fromMe) return;

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
        const remoteNumber = jidToNumber(from);
        console.log('Incoming message from', remoteNumber, '-', text);

        // Create a unique key per incoming message to ensure we reply at-most-once per message
        const messageKey = `${remoteNumber}_${msg.key.id}`;
        if (repliedSet.has(messageKey)) {
          console.log('Already replied to message', messageKey, '- skipping');
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
          console.log('Sender in blacklist, ignoring:', remoteNumber);
          return;
        }

        // Whitelist handling: if whitelist non-empty, only respond to those in whitelist
        if (config.whitelist.length > 0 && !config.whitelist.includes(remoteNumber)) {
          console.log('Sender not in whitelist, ignoring:', remoteNumber);
          return;
        }

        // If suppressWhenOwnerActive is enabled and owner was recently active, skip auto-reply
        if (config.suppressWhenOwnerActive) {
          try {
            const now = Date.now();
            const since = now - (lastOwnerActive || 0);
            const timeoutMs = (config.suppressTimeoutSeconds || 120) * 1000;
            if (lastOwnerActive && since <= timeoutMs) {
              console.log(`Owner active recently (${Math.round(since/1000)}s ago) — suppressing auto-reply to ${remoteNumber}`);
              return;
            }
          } catch (e) {
            // ignore suppression errors
          }
        }
        // If autoReply disabled, do not send automatic replies to normal users
        if (!config.autoReply) {
          console.log('Auto-reply disabled, ignoring message from', remoteNumber);
          return;
        }

        // Assist logic: if owner is online but idle (not actively viewing), offer quick-help buttons
        try {
          const nowMs = Date.now();
          const adminOnline = !!ownerOnline;
          const adminIdle = ((nowMs - (lastOwnerActive || 0)) / 1000) > OWNER_IDLE_SECONDS;
          const assistCooldown = (config.assistCooldownSeconds || 3600);
          const st = assistState.bySender[remoteNumber] || { assistEnabled: true, lastDeniedAt: 0 };

          if (adminOnline && adminIdle) {
            // if sender explicitly disabled assist and still in cooldown, skip
            if (st.assistEnabled === false && st.lastDeniedAt && ((nowMs - st.lastDeniedAt) / 1000) < assistCooldown) {
              console.log('Assist disabled for', remoteNumber, 'and still in cooldown — skipping reply');
              return;
            }

            // If assist enabled (user previously said Iya), proceed to normal reply below
            if (st.assistEnabled !== false) {
              // we'll continue to send reply (and also include buttons the first time)
            } else {
              // assist disabled but cooldown expired — show buttons again (fallthrough)
            }
          }
        } catch (e) {
          // ignore assist errors
        }

        // rate limit (per-number cooldown)
        try {
          const now = Date.now();
          const last = lastReplyAt.get(remoteNumber) || 0;
          const cooldownMs = (config.replyCooldownSeconds || 60) * 1000;
          if (now - last < cooldownMs) {
            console.log(`Skipping reply due cooldown for ${remoteNumber} (wait ${Math.ceil((cooldownMs - (now-last))/1000)}s)`);
            return;
          }
          // mark last replied
          lastReplyAt.set(remoteNumber, now);
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

        // Send reply (consider assist state / buttons when owner is online but idle)
        try {
          const nowMs = Date.now();
          const adminOnline = !!ownerOnline;
          const adminIdle = ((nowMs - (lastOwnerActive || 0)) / 1000) > OWNER_IDLE_SECONDS;
          const assistCooldown = (config.assistCooldownSeconds || 3600);
          const st = assistState.bySender[remoteNumber] || { assistEnabled: true, lastDeniedAt: 0 };

          if (adminOnline && adminIdle) {
            // if sender disabled assist and still in cooldown, skip replying
            if (st.assistEnabled === false && st.lastDeniedAt && ((nowMs - st.lastDeniedAt) / 1000) < assistCooldown) {
              console.log('Assist disabled for', remoteNumber, 'and still in cooldown — skipping reply');
              return;
            }

            if (st.assistEnabled === true) {
              // user opted in: normal text reply
              await sock.sendMessage(from, { text: reply });
            } else {
              // ask user if they are helped (buttons) and do not repeatedly spam - include footer and two buttons
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
            }
          } else {
            // normal behavior when owner not online+idle
            await sock.sendMessage(from, { text: reply });
          }

          // mark this message as replied (persist so we don't reply again to same message)
          try {
            repliedSet.add(messageKey);
            saveReplied();
          } catch (e) {
            // ignore save errors
          }
          // persist assist state if updated
          try { assistState.bySender[remoteNumber] = st; saveAssistState(); } catch(e){}
          console.log('Replied to', remoteNumber, 'mode:', config.mode);
        } catch (e) {
          console.error('Failed to send reply:', e);
        }

      } catch (err) {
        console.error('Error handling message:', err);
      }
    });

  } catch (err) {
    console.error('Failed to start bot:', err);
  }
}

startBot();
