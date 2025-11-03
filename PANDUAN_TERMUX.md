# Panduan Menjalankan Bot WhatsApp di Termux (Android)

Panduan lengkap untuk menjalankan StaticBot (bot WhatsApp auto-reply) di smartphone Android menggunakan aplikasi Termux.

---

## 📋 Persyaratan

- **Smartphone Android** (minimal Android 7.0)
- **Aplikasi Termux** (download dari [F-Droid](https://f-droid.org/packages/com.termux/) - **WAJIB dari F-Droid, bukan Play Store**)
- **Koneksi internet stabil** (Wi-Fi atau paket data)
- **Perangkat kedua** (HP lain atau PC) untuk scan QR code WhatsApp saat login pertama kali
- **(Opsional)** Termux:Boot untuk auto-start saat HP restart

> ⚠️ **PENTING**: Install Termux dari F-Droid, bukan dari Play Store. Versi Play Store sudah deprecated dan tidak mendapat update.

---

## 🚀 Langkah-Langkah Instalasi

### 1. Install Termux dan Update Paket

Setelah install Termux dari F-Droid, buka aplikasi dan jalankan:

```bash
pkg update -y && pkg upgrade -y
```

Tunggu sampai proses update selesai (mungkin butuh waktu beberapa menit tergantung koneksi internet).

### 2. Install Paket yang Diperlukan

Install Git dan Node.js:

```bash
pkg install git nodejs -y
```

Verifikasi instalasi:

```bash
node --version
npm --version
git --version
```

### 3. Clone Repository Bot

Pindah ke folder home dan clone repo:

```bash
cd $HOME
git clone https://github.com/Ascalon984/StaticBot.git
cd StaticBot
```

### 4. Install Dependencies

Install semua package Node.js yang dibutuhkan:

```bash
npm install
```

Proses ini akan download library Baileys dan dependencies lainnya. Tunggu sampai selesai.

### 5. Konfigurasi Bot (Opsional)

Edit file `bot_config.json` untuk mengatur:
- Nomor admin
- Nama owner
- Mode auto-reply
- Whitelist/blacklist
- Cooldown waktu reply

```bash
nano bot_config.json
```

*Tips: Tekan `Ctrl+X`, lalu `Y`, lalu `Enter` untuk save dan keluar dari nano.*

---

## ▶️ Menjalankan Bot

### Cara 1: Jalankan Manual

```bash
node index.js
```

**Saat pertama kali**, bot akan menampilkan **QR code** di terminal. 

> ⚠️ **Cara Scan QR:**
> 1. Buka WhatsApp di **HP kedua** (atau PC dengan WhatsApp Web)
> 2. Buka menu **Perangkat Tertaut** (Linked Devices)
> 3. Tap **Tautkan Perangkat**
> 4. Scan QR code yang muncul di Termux

Setelah scan berhasil, bot akan terhubung dan mulai berjalan. Terminal akan menampilkan:
```
✅ Connected to WhatsApp
Using auth directory: /data/data/com.termux/files/home/StaticBot/auth_info
```

### Cara 2: Jalankan dengan Helper Script (Recommended)

Bot ini sudah dilengkapi dengan script `start-termux.sh` yang:
- Mengaktifkan wake-lock (mencegah Android membunuh proses)
- Auto-restart jika bot crash
- Berjalan dalam loop resilient

Jalankan:

```bash
chmod +x start-termux.sh
./start-termux.sh
```

**Untuk stop bot**, tekan `Ctrl+C` atau tutup sesi Termux.

---

## 🔄 Menjaga Bot Tetap Berjalan 24/7

### Opsi A: Menggunakan Screen/Tmux (Detach Session)

Install screen:

```bash
pkg install screen -y
```

Jalankan bot di screen session:

```bash
screen -S botwa
./start-termux.sh
```

**Detach session** (bot tetap jalan di background):
- Tekan `Ctrl+A`, lalu tekan `D`

**Kembali ke session**:
```bash
screen -r botwa
```

**Lihat semua session**:
```bash
screen -ls
```

### Opsi B: Auto-Start dengan Termux:Boot

1. **Install Termux:Boot** dari F-Droid atau Play Store
2. Buka app Termux:Boot sekali (untuk activate)
3. Buat folder boot script:

```bash
mkdir -p ~/.termux/boot
```

4. Copy script boot yang sudah disediakan:

```bash
cp .termux/boot/startbot.sh ~/.termux/boot/
chmod +x ~/.termux/boot/startbot.sh
```

5. **Edit path jika perlu**:

```bash
nano ~/.termux/boot/startbot.sh
```

Pastikan path mengarah ke folder bot:
```bash
cd "$HOME/StaticBot"
```

6. **Restart HP** - bot akan otomatis jalan setelah boot!

### Opsi C: Menggunakan PM2 (Process Manager)

Install PM2 globally:

```bash
npm install -g pm2
```

Jalankan bot dengan PM2:

```bash
pm2 start index.js --name staticbot
pm2 save
```

PM2 akan auto-restart bot jika crash.

**Perintah PM2 berguna:**
- `pm2 list` - lihat status bot
- `pm2 logs staticbot` - lihat log real-time
- `pm2 restart staticbot` - restart bot
- `pm2 stop staticbot` - stop bot
- `pm2 delete staticbot` - hapus dari PM2

---

## ⚙️ Optimasi untuk Android

### 1. Nonaktifkan Battery Optimization untuk Termux

Agar Android tidak membunuh Termux di background:

1. Buka **Settings** → **Apps** → **Termux**
2. Pilih **Battery** atau **Battery Optimization**
3. Pilih **Don't optimize** atau **Unrestricted**

### 2. Aktifkan Wake Lock di Termux

Jalankan sebelum start bot:

```bash
termux-wake-lock
```

Untuk release wake lock:

```bash
termux-wake-unlock
```

> 💡 Script `start-termux.sh` sudah otomatis mengaktifkan wake-lock!

### 3. Gunakan Wi-Fi Stabil

Bot membutuhkan koneksi internet stabil. Jika menggunakan data seluler:
- Pastikan kuota cukup
- Signal stabil (4G/LTE)
- Disable battery saver yang membatasi data di background

---

## 🔧 Troubleshooting

### ❌ QR Code Tidak Muncul / Terlalu Kecil

Perbesar font Termux atau zoom in terminal. Jika masih tidak bisa scan, coba:

```bash
# Install qrencode untuk generate QR sebagai gambar
pkg install qrencode -y
```

Lalu edit `index.js` untuk save QR ke file (atau screenshot terminal dan scan dari device lain).

### ❌ Bot Sering Disconnect

Solusi:
- Pastikan wake-lock aktif
- Nonaktifkan battery optimization
- Gunakan koneksi internet stabil
- Jalankan dengan screen/tmux atau PM2

### ❌ Error "Cannot find module"

Jalankan lagi:

```bash
npm install
```

Jika masih error, hapus `node_modules` dan reinstall:

```bash
rm -rf node_modules package-lock.json
npm install
```

### ❌ Bot Tidak Auto-Reply

Periksa:
1. Mode di `bot_config.json` → pastikan `autoReply: true`
2. Nomor sender tidak masuk blacklist
3. Cooldown belum habis (default 1 jam per sender)
4. Bot sudah scan QR dan terkoneksi

Check log di terminal untuk melihat pesan masuk.

### ❌ Session Hilang Setelah Restart

Session WhatsApp disimpan di folder `auth_info/`. Pastikan:
- Folder `auth_info/` ada dan tidak terhapus
- Jangan jalankan `git pull` yang overwrite session
- Backup folder `auth_info/` secara berkala:

```bash
cp -r auth_info auth_info_backup
```

---

## 📝 Perintah Admin Bot

Kirim pesan ke nomor bot (harus dari nomor admin yang terdaftar):

- `!status online|offline|busy` - ubah mode bot
- `!whitelist add 628xxx` - tambah nomor ke whitelist
- `!blacklist add 628xxx` - tambah nomor ke blacklist
- `!show` - lihat konfigurasi saat ini
- `!autoreply on|off` - aktifkan/nonaktifkan auto-reply
- `!cooldown 3600` - set cooldown reply (detik)
- `!suppress on|off` - aktifkan suppress saat owner online

Contoh:
```
!status offline
!whitelist add 6281234567890
!cooldown 1800
```

---

## 🔒 Keamanan & Privasi

### ⚠️ JANGAN Commit File Sensitif

File yang **TIDAK BOLEH** di-upload ke GitHub:
- `auth_info/` - berisi session WhatsApp
- `replied.json` - log replied numbers
- `.env` atau file credential lainnya

File `.gitignore` sudah dikonfigurasi untuk mengabaikan file-file ini.

### 🔐 Backup Session

Backup session secara berkala:

```bash
cd $HOME/StaticBot
tar -czf backup_auth_$(date +%Y%m%d).tar.gz auth_info/
```

Simpan file backup di tempat aman (Google Drive, dll).

---

## 🔄 Update Bot

Jika ada update di GitHub:

```bash
cd $HOME/StaticBot

# Backup session dulu
cp -r auth_info auth_info_backup

# Pull update
git pull origin main

# Install dependencies baru (jika ada)
npm install

# Restart bot
pm2 restart staticbot
# atau jika pakai screen/manual:
# Ctrl+C lalu jalankan lagi
./start-termux.sh
```

---

## 📞 Dukungan

Jika ada masalah:
1. Periksa log error di terminal
2. Lihat section Troubleshooting di atas
3. Pastikan Termux dan Node.js versi terbaru
4. Check koneksi internet

---

## 📄 Lisensi

Proyek ini gratis dan open-source. Silakan modifikasi sesuai kebutuhan.

---

**Selamat mencoba! 🚀**

Jika bot sudah berjalan, kamu bisa minimize Termux dan bot akan terus berjalan di background (asalkan battery optimization disabled dan wake-lock aktif).
