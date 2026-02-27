/**
 * TR10 Attendance Bot v3.1 (Stable Reply Fixed)
 * discord.js v14 + sqlite + Express Web Server
 */

require("dotenv").config();

/* ================== WEB SERVER ================== */
const express = require("express");
const web = express();

web.get("/", (req, res) => res.status(200).send("Attendance Bot Running ✅"));
web.get("/health", (req, res) => res.status(200).send("OK"));
web.all("*", (req, res) => res.status(200).send("OK"));

const PORT = process.env.PORT || 3000;
web.listen(PORT, () => console.log(`🌐 Web server on ${PORT}`));
/* ================================================= */

const {
  Client,
  GatewayIntentBits,
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
  console.log("❌ Missing ENV");
  process.exit(1);
}

/* ================== DATABASE ================== */

let db;

async function initDb() {
  const database = await open({
    filename: "./attendance.db",
    driver: sqlite3.Database,
  });

  await database.exec(`PRAGMA journal_mode=WAL;`);

  await database.exec(`
  CREATE TABLE IF NOT EXISTS settings(
    guild_id TEXT PRIMARY KEY,
    log_channel_id TEXT,
    managers_role_id TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT,
    user_id TEXT,
    session_no INTEGER,
    checkin_ms INTEGER,
    checkout_ms INTEGER,
    duration_ms INTEGER,
    checkin_date TEXT,
    checkout_date TEXT
  );

  CREATE TABLE IF NOT EXISTS stats(
    guild_id TEXT,
    user_id TEXT,
    total_time_ms INTEGER DEFAULT 0,
    total_entries INTEGER DEFAULT 0,
    PRIMARY KEY(guild_id,user_id)
  );

  CREATE TABLE IF NOT EXISTS blocked_guilds(
    guild_id TEXT PRIMARY KEY
  );
  `);

  return database;
}

/* ================== CLIENT ================== */

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* ================== HELPERS ================== */

function now() {
  return Date.now();
}

function msToHMS(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

async function getOpen(gid, uid) {
  return db.get(
    `SELECT * FROM sessions WHERE guild_id=? AND user_id=? AND checkout_ms IS NULL`,
    [gid, uid]
  );
}

async function ensureSettings(gid) {
  let row = await db.get(`SELECT * FROM settings WHERE guild_id=?`, [gid]);
  if (!row) {
    await db.run(
      `INSERT INTO settings(guild_id) VALUES(?)`,
      [gid]
    );
    row = await db.get(`SELECT * FROM settings WHERE guild_id=?`, [gid]);
  }
  return row;
}

/* ================== COMMAND REGISTER ================== */

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إرسال لوحة تسجيل الحضور"),

    new SlashCommandBuilder()
      .setName("status")
      .setDescription("عرض حالتك الحالية"),

    new SlashCommandBuilder()
      .setName("sync")
      .setDescription("OWNER: مزامنة الأوامر")
      .addStringOption(o =>
        o.setName("scope")
          .setDescription("guild or global")
          .setRequired(true)
          .addChoices(
            { name: "guild", value: "guild" },
            { name: "global", value: "global" }
          )
      ),

    new SlashCommandBuilder()
      .setName("resetguild")
      .setDescription("OWNER: حذف أوامر السيرفر"),

    new SlashCommandBuilder()
      .setName("blockguild")
      .setDescription("OWNER: حظر سيرفر"),

    new SlashCommandBuilder()
      .setName("unblockguild")
      .setDescription("OWNER: فك حظر سيرفر"),
  ].map(c => c.toJSON());
}

async function registerGlobal() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(
    Routes.applicationCommands(CLIENT_ID),
    { body: buildCommands() }
  );
  console.log("✅ Global Commands Registered");
}

/* ================== READY ================== */

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerGlobal();
});

/* ================== INTERACTIONS (FIXED) ================== */

client.on("interactionCreate", async (interaction) => {
  try {

    if (!interaction.inGuild()) return;

    const gid = interaction.guildId;
    const uid = interaction.user.id;

    if (interaction.isChatInputCommand()) {

      const cmd = interaction.commandName;

      if (!interaction.deferred && !interaction.replied)
        await interaction.deferReply({ ephemeral: true });

      if (cmd === "panel") {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle("نظام تسجيل الحضور")
              .setDescription("استخدم الأزرار للتسجيل")
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId("in")
                .setLabel("تسجيل دخول")
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId("out")
                .setLabel("تسجيل خروج")
                .setStyle(ButtonStyle.Danger)
            )
          ]
        });
      }

      if (cmd === "status") {
        const open = await getOpen(gid, uid);
        if (!open)
          return interaction.editReply("📌 أنت خارج");

        const duration = now() - open.checkin_ms;
        return interaction.editReply(`⏱️ داخل منذ ${msToHMS(duration)}`);
      }

      if (cmd === "sync" && uid === OWNER_ID) {
        const scope = interaction.options.getString("scope");
        if (scope === "global") await registerGlobal();
        return interaction.editReply("✅ تم المزامنة");
      }

      if (cmd === "resetguild" && uid === OWNER_ID) {
        const rest = new REST({ version: "10" }).setToken(TOKEN);
        await rest.put(
          Routes.applicationGuildCommands(CLIENT_ID, gid),
          { body: [] }
        );
        return interaction.editReply("✅ تم حذف أوامر السيرفر");
      }

      if (cmd === "blockguild" && uid === OWNER_ID) {
        await db.run(`INSERT OR IGNORE INTO blocked_guilds VALUES(?)`, [gid]);
        return interaction.editReply("⛔ تم الحظر");
      }

      if (cmd === "unblockguild" && uid === OWNER_ID) {
        await db.run(`DELETE FROM blocked_guilds WHERE guild_id=?`, [gid]);
        return interaction.editReply("✅ تم فك الحظر");
      }

    }

    if (interaction.isButton()) {

      if (!interaction.deferred && !interaction.replied)
        await interaction.deferReply({ ephemeral: true });

      if (interaction.customId === "in") {

        const open = await getOpen(gid, uid);
        if (open)
          return interaction.editReply("⚠️ مسجل بالفعل");

        const row = await db.get(
          `SELECT total_entries FROM stats WHERE guild_id=? AND user_id=?`,
          [gid, uid]
        );

        const sessionNo = (row?.total_entries || 0) + 1;

        await db.run(
          `INSERT INTO sessions(guild_id,user_id,session_no,checkin_ms,checkin_date)
           VALUES(?,?,?,?,?)`,
          [gid, uid, sessionNo, now(), new Date().toISOString()]
        );

        return interaction.editReply(`✅ تم تسجيل دخولك (${sessionNo})`);
      }

      if (interaction.customId === "out") {

        const open = await getOpen(gid, uid);
        if (!open)
          return interaction.editReply("⚠️ لا يوجد جلسة");

        const duration = now() - open.checkin_ms;

        await db.run(
          `UPDATE sessions SET checkout_ms=?,duration_ms=? WHERE id=?`,
          [now(), duration, open.id]
        );

        await db.run(
          `INSERT INTO stats(guild_id,user_id,total_time_ms,total_entries)
           VALUES(?,?,?,1)
           ON CONFLICT(guild_id,user_id)
           DO UPDATE SET
             total_time_ms=total_time_ms+?,
             total_entries=total_entries+1`,
          [gid, uid, duration, duration]
        );

        return interaction.editReply(`💤 تم تسجيل خروجك — ${msToHMS(duration)}`);
      }

    }

  } catch (err) {
    console.log("❌ Interaction Error:", err);
    if (interaction.isRepliable())
      interaction.reply({ content: "حدث خطأ بسيط", ephemeral: true }).catch(()=>{});
  }
});

/* ================== START ================== */

(async () => {
  db = await initDb();
  await client.login(TOKEN);
})();
