/**
 * TR10 Attendance Bot v3 (Stable)
 * discord.js v14 + sqlite + Express Web Server
 * Per-Guild System + Auto DB Migrate + Logs + Top + Reports + Session No
 *
 * Commands:
 *  - /setlog        (admin) set log channel per guild
 *  - /setmanagers   (admin) set managers role per guild
 *  - /panel         (manage guild) send attendance panel
 *  - /status        (anyone) show current session status
 *  - /report        (managers/admin) report day/week/month by time + entries
 *  - /top           (anyone) top day/week/month/all (time + entries)
 *  - /sync          (owner) push commands global OR to current guild quickly
 *  - /resetguild    (owner) clear guild commands for current guild
 */

require("dotenv").config();

/* ================== WEB SERVER (Render Keep Alive) ================== */
const express = require("express");
const web = express();

// مهم: هذي للـ UptimeRobot
web.get("/", (req, res) => res.status(200).send("Attendance Bot v3 is running ✅"));
web.get("/health", (req, res) => res.status(200).send("OK ✅"));

// عشان ما يطلع 404 بالغلط لو UptimeRobot حط مسار مختلف
web.all("*", (req, res) => res.status(200).send("OK ✅"));

const PORT = process.env.PORT || 3000;
web.listen(PORT, () => console.log(`🌐 Web server running on port ${PORT}`));
/* =================================================================== */

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

// لا تطبع التوكن نفسه.. بس نطبع هل هو موجود؟
console.log("🔧 ENV CHECK:", {
  TOKEN: !!TOKEN,
  CLIENT_ID: !!CLIENT_ID,
  OWNER_ID: !!OWNER_ID,
  TZ,
  NODE: process.version,
});

if (!TOKEN || !CLIENT_ID || !OWNER_ID) {
  console.error("❌ Missing env: TOKEN / CLIENT_ID / OWNER_ID");
  process.exit(1);
}

/* ====== حماية: عشان أي خطأ يطلع في اللوق وما يخليك تضيع ====== */
process.on("unhandledRejection", (err) => console.error("❌ UNHANDLED REJECTION:", err));
process.on("uncaughtException", (err) => console.error("❌ UNCAUGHT EXCEPTION:", err));

/* ================== TIME HELPERS ================== */
function fmtDateFrom(d) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}
function fmtTimeFrom(d) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return fmt.format(d);
}
function nowParts() {
  const d = new Date();
  return {
    ms: Date.now(),
    date: fmtDateFrom(d),
    time: fmtTimeFrom(d),
  };
}
function msToHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}
function dateMinusDays(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return fmtDateFrom(d);
}

/* ================== DB ================== */
let db;

async function initDb() {
  const database = await open({
    filename: "./attendance.db",
    driver: sqlite3.Database,
  });
  await database.exec(`PRAGMA journal_mode = WAL;`);
  return database;
}

/**
 * DB Migration strategy:
 * - Create v3 tables if not exist
 * - If old tables exist, keep them (no crash)
 * - Our code ONLY uses v3 tables, so no "no such column" ever
 */
async function migrateDb() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      guild_id TEXT PRIMARY KEY,
      log_channel_id TEXT,
      managers_role_id TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      session_no INTEGER NOT NULL,
      checkin_ms INTEGER NOT NULL,
      checkout_ms INTEGER,
      duration_ms INTEGER,
      checkin_date TEXT NOT NULL,
      checkout_date TEXT
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS stats_v3 (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      total_time_ms INTEGER NOT NULL DEFAULT 0,
      total_entries INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs_v3 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      at_ms INTEGER NOT NULL,
      at_date TEXT NOT NULL,
      at_time TEXT NOT NULL,
      session_no INTEGER NOT NULL,
      duration_ms INTEGER
    );
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessionsv3_open
      ON sessions_v3(guild_id, user_id) WHERE checkout_ms IS NULL;

    CREATE INDEX IF NOT EXISTS idx_sessionsv3_date
      ON sessions_v3(guild_id, checkout_date);

    CREATE INDEX IF NOT EXISTS idx_logsv3_date
      ON logs_v3(guild_id, at_date);
  `);

  console.log("✅ DB migrated/ready (v3 tables).");
}

/* ================== DISCORD CLIENT ================== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

/* ====== اطبع أخطاء الديسكورد بوضوح ====== */
client.on("error", (e) => console.error("❌ CLIENT ERROR:", e));
client.on("shardError", (e) => console.error("❌ SHARD ERROR:", e));

/* ================== SETTINGS HELPERS ================== */
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
  if (settingsRow?.managers_role_id && member.roles.cache.has(settingsRow.managers_role_id)) return true;
  return false;
}

async function sendLog(guild, settingsRow, embed) {
  try {
    if (!settingsRow?.log_channel_id) return;
    const ch = await guild.channels.fetch(settingsRow.log_channel_id).catch(() => null);
    if (!ch) return;
    if (!ch.isTextBased()) return;
    await ch.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error("LOG SEND ERROR:", e);
  }
}

/* ================== PANEL ================== */
function panelEmbed() {
  return new EmbedBuilder()
    .setTitle("نظام تسجيل الحضور")
    .setDescription("سجّل دخولك وخروجك من الأزرار بالأسفل — ويتم تسجيل كل شيء في روم اللوق.")
    .addFields(
      { name: "✅ تسجيل دخول", value: "اضغط زر تسجيل دخول", inline: true },
      { name: "💤 تسجيل خروج", value: "اضغط زر تسجيل خروج", inline: true }
    )
    .setColor(0x2b2d31);
}

function panelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("att_in").setLabel("تسجيل دخول").setEmoji("⏰").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("att_out").setLabel("تسجيل خروج").setEmoji("💤").setStyle(ButtonStyle.Danger)
  );
}

/* ================== COMMANDS ================== */
function buildCommandsJSON() {
  return [
    new SlashCommandBuilder()
      .setName("setlog")
      .setDescription("تحديد روم اللوق (لكل سيرفر)")
      .addChannelOption((o) =>
        o.setName("channel").setDescription("الروم").addChannelTypes(ChannelType.GuildText).setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("setmanagers")
      .setDescription("تحديد رتبة المسؤولين المسموح لهم بالتقارير (لكل سيرفر)")
      .addRoleOption((o) => o.setName("role").setDescription("الرتبة").setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName("panel")
      .setDescription("إرسال لوحة تسجيل الدخول/الخروج")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    new SlashCommandBuilder().setName("status").setDescription("يعرض حالتك: داخل/خارج ومدة الجلسة الحالية"),

    new SlashCommandBuilder()
      .setName("report")
      .setDescription("تقرير (اليوم/الأسبوع/الشهر) — للمسؤولين")
      .addStringOption((o) =>
        o
          .setName("range")
          .setDescription("المدى")
          .setRequired(true)
          .addChoices(
            { name: "اليوم", value: "day" },
            { name: "الأسبوع", value: "week" },
            { name: "الشهر", value: "month" }
          )
      ),

    new SlashCommandBuilder()
      .setName("top")
      .setDescription("توب حسب الوقت + عدد الدخول (🔁)")
      .addStringOption((o) =>
        o
          .setName("range")
          .setDescription("المدى")
          .setRequired(true)
          .addChoices(
            { name: "الكل (All-time)", value: "all" },
            { name: "اليوم", value: "day" },
            { name: "الأسبوع", value: "week" },
            { name: "الشهر", value: "month" }
          )
      ),

    new SlashCommandBuilder()
      .setName("sync")
      .setDescription("OWNER: مزامنة الأوامر (guild سريع / global عام)")
      .addStringOption((o) =>
        o
          .setName("scope")
          .setDescription("نوع المزامنة")
          .setRequired(true)
          .addChoices(
            { name: "guild (سريع للسيرفر الحالي)", value: "guild" },
            { name: "global (عام لكل السيرفرات)", value: "global" }
          )
      ),

    new SlashCommandBuilder().setName("resetguild").setDescription("OWNER: حذف أوامر السيرفر الحالي"),
  ].map((c) => c.toJSON());
}

async function registerGlobalCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: buildCommandsJSON() });
  console.log("✅ Global slash commands pushed.");
}
async function registerGuildCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: buildCommandsJSON() });
  console.log(`✅ Guild slash commands pushed for ${guildId}.`);
}
async function clearGuildCommands(guildId) {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: [] });
  console.log(`✅ Guild slash commands CLEARED for ${guildId}.`);
}

/* ================== CORE QUERIES (v3) ================== */
async function getOpenSession(gid, uid) {
  return db.get(
    "SELECT * FROM sessions_v3 WHERE guild_id=? AND user_id=? AND checkout_ms IS NULL ORDER BY id DESC LIMIT 1",
    [gid, uid]
  );
}
async function getNextSessionNo(gid, uid) {
  const row = await db.get("SELECT total_entries FROM stats_v3 WHERE guild_id=? AND user_id=?", [gid, uid]);
  return (row?.total_entries || 0) + 1;
}
async function upsertStatsOnCheckout(gid, uid, durationMs) {
  await db.run(
    `
    INSERT INTO stats_v3 (guild_id, user_id, total_time_ms, total_entries)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(guild_id, user_id)
    DO UPDATE SET
      total_time_ms = total_time_ms + excluded.total_time_ms,
      total_entries = total_entries + 1
  `,
    [gid, uid, durationMs]
  );
}

function makeDateList(range) {
  const dates = [];
  if (range === "day") dates.push(dateMinusDays(0));
  if (range === "week") for (let i = 0; i < 7; i++) dates.push(dateMinusDays(i));
  if (range === "month") for (let i = 0; i < 30; i++) dates.push(dateMinusDays(i));
  return dates;
}

async function aggregateByRange(gid, range) {
  const dates = makeDateList(range);
  const placeholders = dates.map(() => "?").join(",");
  const rows = await db.all(
    `
    SELECT user_id,
           SUM(COALESCE(duration_ms, 0)) AS total_time_ms,
           COUNT(*) AS entries
    FROM sessions_v3
    WHERE guild_id = ?
      AND checkout_ms IS NOT NULL
      AND checkout_date IN (${placeholders})
    GROUP BY user_id
    ORDER BY total_time_ms DESC, entries DESC
  `,
    [gid, ...dates]
  );
  return rows;
}

/* ================== READY ================== */
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await registerGlobalCommands().catch((e) => console.error("Global register error:", e));
});

/* ================== INTERACTIONS ================== */
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.inGuild()) {
      if (interaction.isRepliable()) {
        return interaction.reply({ content: "❌ هذا البوت يشتغل داخل السيرفرات فقط.", ephemeral: true });
      }
      return;
    }

    const gid = interaction.guildId;

    if (interaction.isChatInputCommand()) {
      const settingsRow = await getSettings(gid);

      if (interaction.commandName === "sync") {
        if (interaction.user.id !== OWNER_ID)
          return interaction.reply({ content: "❌ هذا الأمر للأونر فقط.", ephemeral: true });

        const scope = interaction.options.getString("scope", true);
        if (scope === "guild") {
          await registerGuildCommands(gid);
          return interaction.reply({ content: "✅ تمّت مزامنة الأوامر سريعًا لهذا السيرفر.", ephemeral: true });
        } else {
          await registerGlobalCommands();
          return interaction.reply({ content: "✅ تم رفع الأوامر عامّة.", ephemeral: true });
        }
      }

      if (interaction.commandName === "resetguild") {
        if (interaction.user.id !== OWNER_ID)
          return interaction.reply({ content: "❌ هذا الأمر للأونر فقط.", ephemeral: true });

        await clearGuildCommands(gid);
        return interaction.reply({ content: "✅ تم مسح أوامر هذا السيرفر.", ephemeral: true });
      }

      if (interaction.commandName === "setlog") {
        const ch = interaction.options.getChannel("channel", true);
        await db.run("UPDATE settings SET log_channel_id=? WHERE guild_id=?", [ch.id, gid]);
        return interaction.reply({ content: `✅ تم تعيين روم اللوق: <#${ch.id}>`, ephemeral: true });
      }

      if (interaction.commandName === "setmanagers") {
        const role = interaction.options.getRole("role", true);
        await db.run("UPDATE settings SET managers_role_id=? WHERE guild_id=?", [role.id, gid]);
        return interaction.reply({ content: `✅ تم تعيين رتبة المسؤولين: <@&${role.id}>`, ephemeral: true });
      }

      if (interaction.commandName === "panel") {
        return interaction.reply({ embeds: [panelEmbed()], components: [panelRow()] });
      }

      if (interaction.commandName === "status") {
        const openSession = await getOpenSession(gid, interaction.user.id);
        if (!openSession) {
          return interaction.reply({ content: "📌 حالتك: **خارج** (ما عندك جلسة مفتوحة).", ephemeral: true });
        }
        const elapsed = Date.now() - openSession.checkin_ms;
        const p = nowParts();
        return interaction.reply({
          content: `📌 حالتك: **داخل**\n🔁 رقم الدخول: (**${openSession.session_no}**)\n🗓️ بداية: ${openSession.checkin_date}\n🕒 الآن: ${p.time}\n⏳ المدة: ${msToHMS(elapsed)}`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "report") {
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        if (!isManager(member, settingsRow)) {
          return interaction.reply({ content: "❌ هذا الأمر للمسؤولين فقط.", ephemeral: true });
        }

        const range = interaction.options.getString("range", true);
        const rows = await aggregateByRange(gid, range);

        const top = rows.slice(0, 15);
        const lines = top.length
          ? top
              .map(
                (r, i) =>
                  `**${i + 1})** <@${r.user_id}> — ⏱️ **${msToHMS(r.total_time_ms || 0)}** 🔁 (${r.entries || 0})`
              )
              .join("\n")
          : "لا يوجد بيانات في هذا المدى.";

        const title = range === "day" ? "تقرير اليوم" : range === "week" ? "تقرير الأسبوع" : "تقرير الشهر";
        const emb = new EmbedBuilder().setTitle(`📊 ${title}`).setDescription(lines).setColor(0x2b2d31);
        return interaction.reply({ embeds: [emb], ephemeral: true });
      }

      if (interaction.commandName === "top") {
        const range = interaction.options.getString("range", true);

        if (range === "all") {
          const rows = await db.all(
            `SELECT user_id, total_time_ms, total_entries
             FROM stats_v3
             WHERE guild_id=?
             ORDER BY total_time_ms DESC, total_entries DESC`,
            [gid]
          );

          const top = rows.slice(0, 15);
          const lines = top.length
            ? top
                .map(
                  (r, i) =>
                    `**${i + 1})** <@${r.user_id}> — ⏱️ **${msToHMS(r.total_time_ms || 0)}** 🔁 (${r.total_entries || 0})`
                )
                .join("\n")
            : "لا يوجد بيانات حتى الآن.";

          const emb = new EmbedBuilder().setTitle("🏆 Top (All-time)").setDescription(lines).setColor(0x2b2d31);
          return interaction.reply({ embeds: [emb], ephemeral: true });
        } else {
          const rows = await aggregateByRange(gid, range);
          const top = rows.slice(0, 15);
          const lines = top.length
            ? top
                .map(
                  (r, i) =>
                    `**${i + 1})** <@${r.user_id}> — ⏱️ **${msToHMS(r.total_time_ms || 0)}** 🔁 (${r.entries || 0})`
                )
                .join("\n")
            : "لا يوجد بيانات في هذا المدى.";

          const title = range === "day" ? "Top اليوم" : range === "week" ? "Top الأسبوع" : "Top الشهر";
          const emb = new EmbedBuilder().setTitle(`🏆 ${title}`).setDescription(lines).setColor(0x2b2d31);
          return interaction.reply({ embeds: [emb], ephemeral: true });
        }
      }
    }

    if (interaction.isButton()) {
      const settingsRow = await getSettings(gid);
      const { date, time, ms } = nowParts();
      const uid = interaction.user.id;

      if (interaction.customId === "att_in") {
        const openSession = await getOpenSession(gid, uid);
        if (openSession) {
          return interaction.reply({ content: "⚠️ أنت مسجل **دخول** بالفعل. لازم تسجل خروج أول.", ephemeral: true });
        }

        const sessionNo = await getNextSessionNo(gid, uid);

        await db.run(
          `INSERT INTO sessions_v3 (guild_id, user_id, session_no, checkin_ms, checkout_ms, duration_ms, checkin_date, checkout_date)
           VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)`,
          [gid, uid, sessionNo, ms, date]
        );

        await db.run(
          `INSERT INTO logs_v3 (guild_id, user_id, action, at_ms, at_date, at_time, session_no, duration_ms)
           VALUES (?, ?, 'IN', ?, ?, ?, ?, NULL)`,
          [gid, uid, ms, date, time, sessionNo]
        );

        const emb = new EmbedBuilder()
          .setTitle("✅ تسجيل دخول")
          .setDescription(`👤 <@${uid}>\n🕒 ${time}\n🗓️ ${date}\n🔁 رقم الدخول: (**${sessionNo}**)`)
          .setColor(0x00cc66);

        await sendLog(interaction.guild, settingsRow, emb);
        return interaction.reply({ content: `✅ تم تسجيل دخولك 🔁 (${sessionNo})`, ephemeral: true });
      }

      if (interaction.customId === "att_out") {
        const openSession = await getOpenSession(gid, uid);
        if (!openSession) {
          return interaction.reply({ content: "⚠️ ما عندك جلسة مفتوحة. سجل دخول أول.", ephemeral: true });
        }

        const duration = ms - openSession.checkin_ms;

        await db.run(
          `UPDATE sessions_v3
           SET checkout_ms=?, duration_ms=?, checkout_date=?
           WHERE id=?`,
          [ms, duration, date, openSession.id]
        );

        await upsertStatsOnCheckout(gid, uid, duration);

        await db.run(
          `INSERT INTO logs_v3 (guild_id, user_id, action, at_ms, at_date, at_time, session_no, duration_ms)
           VALUES (?, ?, 'OUT', ?, ?, ?, ?, ?)`,
          [gid, uid, ms, date, time, openSession.session_no, duration]
        );

        const emb = new EmbedBuilder()
          .setTitle("💤 تسجيل خروج")
          .setDescription(
            `👤 <@${uid}>\n🕒 ${time}\n🗓️ ${date}\n⏱️ مدة الجلسة: **${msToHMS(duration)}**\n🔁 رقم الدخول: (**${openSession.session_no}**)`
          )
          .setColor(0xff3344);

        await sendLog(interaction.guild, settingsRow, emb);
        return interaction.reply({
          content: `💤 تم تسجيل خروجك — ⏱️ ${msToHMS(duration)} 🔁 (${openSession.session_no})`,
          ephemeral: true,
        });
      }
    }
  } catch (e) {
    console.error("INTERACTION ERROR:", e);
    try {
      const msg = "صار خطأ بسيط. تأكد من صلاحيات البوت + روم اللوق.";
      if (interaction?.replied || interaction?.deferred) {
        await interaction.followUp({ content: msg, ephemeral: true });
      } else if (interaction?.isRepliable()) {
        await interaction.reply({ content: msg, ephemeral: true });
      }
    } catch {}
  }
});

/* ================== START ================== */
(async () => {
  db = await initDb();
  await migrateDb();

  // أهم سطر: لو فشل التوكن هنا بيطلع لك السبب واضح
  try {
    console.log("🔌 Trying to login to Discord...");
    await client.login(TOKEN);
    console.log("🔌 Login promise resolved.");
  } catch (e) {
    console.error("❌ LOGIN FAILED (TOKEN/NETWORK/ENV):", e);
    process.exit(1);
  }
})();
