require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");

const KEYS_FILE = path.join(__dirname, "keys.json");

function loadDb() {
  if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: {} }, null, 2));
  }
  return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
}

function saveDb(data) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
}

function generateRmxKey(length = 12) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < length; i++) {
    suffix += chars[crypto.randomInt(0, chars.length)];
  }
  return `RMX-${suffix}`;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "rmx-key-server" });
});

app.post("/api/verify", (req, res) => {
  const rawKey = (req.body?.key || "").trim().toUpperCase();
  const hwid = (req.body?.hwid || "").trim().toUpperCase();

  if (!rawKey || !hwid) {
    return res.json({ valid: false, message: "Key and HWID are required." });
  }

  if (!rawKey.startsWith("RMX-")) {
    return res.json({ valid: false, message: "Keys must start with RMX-." });
  }

  const db = loadDb();
  const entry = db.keys[rawKey];

  if (!entry) {
    return res.json({ valid: false, message: "License key does not exist." });
  }

  if (entry.banned) {
    return res.json({ valid: false, message: "This key has been banned." });
  }

  if (!entry.hwid) {
    entry.hwid = hwid;
    entry.activatedAt = new Date().toISOString();
    saveDb(db);
    return res.json({ valid: true, message: "Key activated and locked to your HWID." });
  }

  if (entry.hwid !== hwid) {
    return res.json({ valid: false, message: "HWID mismatch. Key is locked to another PC." });
  }

  return res.json({ valid: true, message: "License verified." });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[API] Listening on port ${port}`);
});

const commands = [
  new SlashCommandBuilder()
    .setName("genkey")
    .setDescription("Generate a new RMX-... license key")
    .addIntegerOption((opt) =>
      opt.setName("count").setDescription("How many keys to generate (1-10)").setMinValue(1).setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName("resethwid")
    .setDescription("Reset the bound HWID for an RMX key")
    .addStringOption((opt) => opt.setName("key").setDescription("Example: RMX-28D2HA823HALD").setRequired(true)),
  new SlashCommandBuilder()
    .setName("bankey")
    .setDescription("Ban or unban an RMX key")
    .addStringOption((opt) => opt.setName("key").setDescription("Example: RMX-28D2HA823HALD").setRequired(true))
    .addBooleanOption((opt) => opt.setName("banned").setDescription("true to ban, false to unban").setRequired(true))
].map((cmd) => cmd.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function onClientReady() {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  const token = process.env.DISCORD_TOKEN;
  const guildId = process.env.GUILD_ID;

  if (!token || !guildId) {
    console.warn("[BOT] Missing DISCORD_TOKEN or GUILD_ID; skipping slash command registration.");
    return;
  }

  try {
    const rest = new REST({ version: "10" }).setToken(token);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
    console.log("[BOT] Slash commands registered.");
  } catch (err) {
    console.error("[BOT] Failed to register slash commands:", err.message);
  }
}

client.once("clientReady", onClientReady);
client.once("ready", onClientReady);

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.user.id !== process.env.ADMIN_USER_ID) {
    await interaction.reply({ content: "Only the bot owner can run key management commands.", ephemeral: true });
    return;
  }

  const db = loadDb();

  if (interaction.commandName === "genkey") {
    const count = interaction.options.getInteger("count") || 1;
    const created = [];

    for (let i = 0; i < count; i++) {
      let key = generateRmxKey(12);
      while (db.keys[key]) key = generateRmxKey(12);

      db.keys[key] = { hwid: null, banned: false, createdAt: new Date().toISOString() };
      created.push(key);
    }

    saveDb(db);
    await interaction.reply({ content: `Generated key(s):\n\`${created.join("\n")}\``, ephemeral: true });
  } else if (interaction.commandName === "resethwid") {
    const key = interaction.options.getString("key", true).trim().toUpperCase();
    if (!db.keys[key]) {
      await interaction.reply({ content: `Key \`${key}\` not found.`, ephemeral: true });
      return;
    }
    db.keys[key].hwid = null;
    saveDb(db);
    await interaction.reply({ content: `HWID reset for \`${key}\`.`, ephemeral: true });
  } else if (interaction.commandName === "bankey") {
    const key = interaction.options.getString("key", true).trim().toUpperCase();
    const banned = interaction.options.getBoolean("banned", true);
    if (!db.keys[key]) {
      await interaction.reply({ content: `Key \`${key}\` not found.`, ephemeral: true });
      return;
    }
    db.keys[key].banned = banned;
    saveDb(db);
    await interaction.reply({ content: `Key \`${key}\` updated: banned = \`${banned}\`.`, ephemeral: true });
  }
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("[BOT] Discord login failed:", err.message);
  });
} else {
  console.warn("[BOT] DISCORD_TOKEN not set; API server is still running.");
}
