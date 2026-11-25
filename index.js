require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");

const KEYS_FILE = path.join(__dirname, "keys.json");
const ONLINE_WINDOW_MS = 60 * 1000; // Consider a session online if heartbeat/verify seen within 60s

function loadDb() {
  if (!fs.existsSync(KEYS_FILE)) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify({ keys: {} }, null, 2));
  }
  const parsed = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
  parsed.keys = parsed.keys || {};
  return parsed;
}

let githubSyncQueue = Promise.resolve();

async function pushKeysToGitHub(data) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!token || !owner || !repo) {
    console.warn("[GITHUB] Missing GITHUB_TOKEN, GITHUB_OWNER, or GITHUB_REPO; skipping GitHub sync.");
    return;
  }

  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/keys.json`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "rmx-key-server"
  };

  const getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(branch)}`, { headers });
  let sha;
  if (getRes.ok) {
    const fileInfo = await getRes.json();
    sha = fileInfo.sha;
  } else if (getRes.status !== 404) {
    const errText = await getRes.text();
    throw new Error(`Failed to read keys.json from GitHub (${getRes.status}): ${errText}`);
  }

  const content = Buffer.from(JSON.stringify(data, null, 2) + "\n", "utf8").toString("base64");
  const body = {
    message: "[skip render] Auto-update keys.json",
    content,
    branch,
    ...(sha ? { sha } : {})
  };

  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(`Failed to update keys.json on GitHub (${putRes.status}): ${errText}`);
  }

  console.log("[GITHUB] Synced keys.json to repository.");
}

function saveDb(data) {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(data, null, 2));
  githubSyncQueue = githubSyncQueue
    .then(() => pushKeysToGitHub(data))
    .catch((err) => {
      console.error("[GITHUB] Sync error:", err.message);
    });
}

function generateRmxKey(length = 12, prefix = "RMX-") {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let suffix = "";
  for (let i = 0; i < length; i++) {
    suffix += chars[crypto.randomInt(0, chars.length)];
  }
  return `${prefix}${suffix}`;
}

function isKeyOwner(keyString, entry) {
  if (entry && entry.isOwner === true) return true;
  if (typeof keyString === "string" && keyString.toUpperCase().startsWith("RMX-OWN-")) return true;
  return false;
}

function isEntryOnline(entry) {
  if (!entry || !entry.lastSeenAt) return false;
  const seenMs = Date.parse(entry.lastSeenAt);
  if (Number.isNaN(seenMs)) return false;
  return Date.now() - seenMs <= ONLINE_WINDOW_MS;
}

const app = express();
app.use(express.json());

app.get("/", (_req, res) => {
  res.status(200).json({ status: "ok", service: "rmx-key-server" });
});

app.post("/api/verify", (req, res) => {
  const rawKey = (req.body?.key || "").trim().toUpperCase();
  const hwid = (req.body?.hwid || "").trim().toUpperCase();
  const machine = (req.body?.machine || "").trim();

  if (!rawKey || !hwid) {
    return res.json({ valid: false, isOwner: false, message: "Key and HWID are required." });
  }

  if (!rawKey.startsWith("RMX-")) {
    return res.json({ valid: false, isOwner: false, message: "Keys must start with RMX-." });
  }

  const db = loadDb();
  const entry = db.keys[rawKey];

  if (!entry) {
    return res.json({ valid: false, isOwner: false, message: "License key does not exist." });
  }

  if (entry.banned) {
    return res.json({ valid: false, isOwner: false, message: "This key has been banned." });
  }

  const ownerAccess = isKeyOwner(rawKey, entry);
  const nowIso = new Date().toISOString();

  if (!entry.hwid) {
    entry.hwid = hwid;
    entry.activatedAt = nowIso;
    entry.lastSeenAt = nowIso;
    if (machine) entry.machine = machine;
    saveDb(db);
    return res.json({
      valid: true,
      isOwner: ownerAccess,
      message: "Key activated and locked to your HWID."
    });
  }

  if (!ownerAccess && entry.hwid !== hwid) {
    return res.json({ valid: false, isOwner: false, message: "HWID mismatch. Key is locked to another PC." });
  }

  entry.lastSeenAt = nowIso;
  if (machine) entry.machine = machine;
  saveDb(db);

  return res.json({
    valid: true,
    isOwner: ownerAccess,
    message: "License verified."
  });
});

app.post("/api/check", (req, res) => {
  const rawKey = (req.body?.key || "").trim().toUpperCase();
  const hwid = (req.body?.hwid || "").trim().toUpperCase();

  if (!rawKey || !hwid) {
    return res.json({
      valid: false,
      active: false,
      isOwner: false,
      status: "missing",
      message: "Key and HWID are required. Please close the program."
    });
  }

  const db = loadDb();
  const entry = db.keys[rawKey];

  if (!entry) {
    return res.json({
      valid: false,
      active: false,
      isOwner: false,
      status: "deleted",
      message: "Your key has been deleted. Please close the program."
    });
  }

  if (entry.banned) {
    return res.json({
      valid: false,
      active: false,
      isOwner: false,
      status: "banned",
      message: "Your key has been banned. Please close the program."
    });
  }

  const ownerAccess = isKeyOwner(rawKey, entry);

  if (!ownerAccess && entry.hwid && entry.hwid !== hwid) {
    return res.json({
      valid: false,
      active: false,
      isOwner: false,
      status: "hwid_mismatch",
      message: "HWID mismatch. Key is locked to another PC. Please close the program."
    });
  }

  return res.json({
    valid: true,
    active: true,
    isOwner: ownerAccess,
    status: "active",
    message: "License active."
  });
});

app.post("/api/heartbeat", (req, res) => {
  const rawKey = (req.body?.key || "").trim().toUpperCase();
  const hwid = (req.body?.hwid || "").trim().toUpperCase();
  const machine = (req.body?.machine || "").trim();

  if (!rawKey) {
    return res.status(400).json({ ok: false, message: "Key is required." });
  }

  const db = loadDb();
  const entry = db.keys[rawKey];
  if (!entry || entry.banned) {
    return res.status(403).json({ ok: false, message: "Key invalid or banned." });
  }

  entry.lastSeenAt = new Date().toISOString();
  if (hwid && !entry.hwid) entry.hwid = hwid;
  if (machine) entry.machine = machine;

  fs.writeFileSync(KEYS_FILE, JSON.stringify(db, null, 2));
  return res.json({ ok: true, timestamp: entry.lastSeenAt });
});

app.get("/api/owner/keys", (req, res) => {
  const providedKey = String(req.headers["x-owner-key"] || req.query?.key || "")
    .trim()
    .toUpperCase();

  const db = loadDb();
  const callerEntry = db.keys[providedKey];

  if (!callerEntry || callerEntry.banned || !isKeyOwner(providedKey, callerEntry)) {
    return res.status(403).json({ error: "Owner key required." });
  }

  const keys = Object.entries(db.keys).map(([keyCode, info]) => ({
    key: keyCode,
    online: isEntryOnline(info),
    active: !info.banned,
    banned: Boolean(info.banned),
    isOwner: isKeyOwner(keyCode, info),
    subscription: info.subscription || "Lifetime",
    createdAt: info.createdAt || "",
    lastUsedAt: info.lastSeenAt || info.activatedAt || "",
    machine: info.machine || info.hwid || ""
  }));

  return res.json({ keys });
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
    .setName("ownerkey")
    .setDescription("Generate one or more Owner Panel license keys")
    .addIntegerOption((opt) =>
      opt.setName("count").setDescription("How many owner keys to generate (1-10)").setMinValue(1).setMaxValue(10)
    ),
  new SlashCommandBuilder()
    .setName("resethwid")
    .setDescription("Reset the bound HWID for an RMX key")
    .addStringOption((opt) => opt.setName("key").setDescription("Example: RMX-28D2HA823HALD").setRequired(true)),
  new SlashCommandBuilder()
    .setName("bankey")
    .setDescription("Ban or unban an RMX key")
    .addStringOption((opt) => opt.setName("key").setDescription("Example: RMX-28D2HA823HALD").setRequired(true))
    .addBooleanOption((opt) => opt.setName("banned").setDescription("true to ban, false to unban").setRequired(true)),
  new SlashCommandBuilder()
    .setName("deletekey")
    .setDescription("Delete an RMX key from files so it no longer works")
    .addStringOption((opt) => opt.setName("key").setDescription("Example: RMX-28D2HA823HALD").setRequired(true))
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
      let key = generateRmxKey(12, "RMX-");
      while (db.keys[key]) key = generateRmxKey(12, "RMX-");

      db.keys[key] = {
        hwid: null,
        banned: false,
        isOwner: false,
        subscription: "Lifetime",
        createdAt: new Date().toISOString()
      };
      created.push(key);
    }

    saveDb(db);
    await interaction.reply({ content: `Generated key(s):\n\`${created.join("\n")}\``, ephemeral: true });
  } else if (interaction.commandName === "ownerkey") {
    const count = interaction.options.getInteger("count") || 1;
    const created = [];

    for (let i = 0; i < count; i++) {
      let key = generateRmxKey(10, "RMX-OWN-");
      while (db.keys[key]) key = generateRmxKey(10, "RMX-OWN-");

      db.keys[key] = {
        hwid: null,
        banned: false,
        isOwner: true,
        subscription: "Lifetime",
        createdAt: new Date().toISOString()
      };
      created.push(key);
    }

    saveDb(db);
    await interaction.reply({
      content: `Generated Owner key(s):\n\`${created.join("\n")}\``,
      ephemeral: true
    });
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
  } else if (interaction.commandName === "deletekey") {
    const key = interaction.options.getString("key", true).trim().toUpperCase();
    if (!db.keys[key]) {
      await interaction.reply({ content: `Key \`${key}\` not found.`, ephemeral: true });
      return;
    }
    delete db.keys[key];
    saveDb(db);
    await interaction.reply({ content: `Deleted key \`${key}\` from files.`, ephemeral: true });
  }
});

if (process.env.DISCORD_TOKEN) {
  client.login(process.env.DISCORD_TOKEN).catch((err) => {
    console.error("[BOT] Discord login failed:", err.message);
  });
} else {
  console.warn("[BOT] DISCORD_TOKEN not set; API server is still running.");
}
