/**
 * Attendance Panel Bot (GLOBAL)
 * discord.js v14 + sqlite + Express Web Server
 * Global Slash Commands + Owner fast guild sync/reset
 */

require("dotenv").config();

/* ================== WEB SERVER (Render Keep Alive) ================== */
const express = require("express");
const web = express();

web.get("/", (req, res) => {
  res.send("Attendance Bot is running 🚀");
});

const PORT = process.env.PORT || 3000;
web.listen(PORT, () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});
/* ==================================================================== */

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require("discord.js");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const OWNER_ID = process.env.OWNER_ID;
const TZ = process.env.TZ || "Asia/Riyadh";

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error("❌ Missing env: TOKEN / CLIENT_ID / OWNER_ID");
  process.exit(1);
}

function nowParts() {
  const d = new Date();
  const fmtDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const fmtTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return { iso: d.toISOString(), date: fmtDate.format(d), time: fmtTime.format(d) };
}

function msToHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}

async function initDb() {
  const db = await open({ filename: "./attendance.db", driver: sqlite3.Database });

  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      log_channel_id TEXT,
      managers_role_id TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      checkin_iso TEXT NOT NULL,
      checkout_iso TEXT,
      checkin_date TEXT NOT NULL,
      checkout_date TEXT
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at_iso TEXT NOT NULL,
      at_date TEXT NOT NULL,
      at_time TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_open
    ON sessions(guild_id, user_id)
    WHERE checkout_iso IS NULL;

    CREATE INDEX IF NOT EXISTS idx_logs_date
    ON logs(guild_id, at_date);
  `);

  return db;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

let db;

/* ================== SETTINGS ================== */

async function getSettings(guildId) {
  let row = await db.get("SELECT * FROM settings WHERE guild_id = ?", [guildId]);
  if (!row) {
    await db.run(
      "INSERT INTO settings (guild_id, log_channel_id, managers_role_id) VALUES (?, NULL, NULL)",
      [guildId]
    );
    row = await db.get("SELECT * FROM settings WHERE guild_id = ?", [guildId]);
  }
  return row;
}

function isManager(member, settingsRow) {
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (
    settingsRow?.managers_role_id &&
    member.roles.cache.has(settingsRow.managers_role_id)
  )
    return true;
  return false;
}

async function sendLog(guild, settingsRow, embed) {
  if (!settingsRow?.log_channel_id) return;
  const ch = await guild.channels.fetch(settingsRow.log_channel_id).catch(() => null);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  await ch.send({ embeds: [embed] }).catch(() => {});
}

/* ================== PANEL ================== */

function panelEmbed() {
  return new EmbedBuilder()
    .setTitle("نظام تسجيل الحضور")
    .setDescription("سجّل دخولك وخروجك من الأزرار بالأسفل — يتم تسجيل كل العمليات في روم اللوق.")
    .addFields(
      { name: "✅ تسجيل دخول", value: "اضغط زر تسجيل دخول", inline: true },
      { name: "💤 تسجيل خروج", value: "اضغط زر تسجيل خروج", inline: true }
    )
    .setColor(0x2b2d31);
}

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("att_in")
      .setLabel("تسجيل دخول")
      .setEmoji("⏰")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("att_out")
      .setLabel("تسجيل خروج")
      .setEmoji("💤")
      .setStyle(ButtonStyle.Danger)
  );
}

/* ================== COMMANDS ================== */

function buildCommandsJSON() {
  return [
    new SlashCommandBuilder()
      .setName("setlog")
      .setDescription("تحديد روم اللوق")
      .addChannelOption(o =>
        o.setName("channel")
          .setDescription("الروم")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setmanagers")
      .setDescription("تحديد رتبة المسؤولين")
      .addRoleOption(o =>
        o.setName("role")
          .setDescription("الرتبة")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إرسال لوحة تسجيل الحضور")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("يعرض حالتك الحالية"),

    new SlashCommandBuilder()
      .setName("report")
      .setDescription("تقرير حضور")
      .addStringOption(o =>
        o.setName("range")
          .setDescription("اليوم / الأسبوع / الشهر")
          .setRequired(true)
          .addChoices(
            { name: "اليوم", value: "day" },
            { name: "الأسبوع", value: "week" },
            { name: "الشهر", value: "month" }
          )
      ),

    new SlashCommandBuilder()
      .setName("sync")
      .setDescription("OWNER: مزامنة الأوامر")
      .addStringOption(o =>
        o.setName("scope")
          .setDescription("guild أو global")
          .setRequired(true)
          .addChoices(
            { name: "guild", value: "guild" },
            { name: "global", value: "global" }
          )
      ),

    new SlashCommandBuilder()
      .setName("resetguild")
      .setDescription("OWNER: حذف أوامر السيرفر"),
  ].map(c => c.toJSON());
}

/* ================== START ================== */

(async () => {
  db = await initDb();
  client.login(TOKEN);
})();