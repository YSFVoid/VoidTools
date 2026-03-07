import { REST } from "@discordjs/rest";
import { Client, Events, GatewayIntentBits, MessageFlags, Partials, Routes } from "discord.js";
import { config } from "./config";
import { connectDatabase, isDatabaseReady } from "./database";
import {
    handlePrefixCommand,
} from "./modules/memberCommands";
import { handleBan, handleKick, handlePurge, modCommands } from "./modules/moderation";
import {
    githubWatchCommands,
    handleGitHubWatchAdmin,
    pollGitHub,
    startGitHubPoller,
} from "./modules/releases";
import { handleSecurityScan } from "./modules/security";
import {
    executeSetup,
    handleSetupWizardBtn,
    handleSetupWizardSubmit,
    setupCommand,
} from "./modules/setup";
import {
    handleTicketAddUserBtn,
    handleTicketAddUserSubmit,
    handleTicketCloseBtn,
    handleTicketCloseSubmit,
    handleTicketOpen,
    handleTicketTranscriptBtn,
} from "./modules/tickets";
import { handleToolsAdmin, toolsCommands } from "./modules/toolsHub";
import { setBotStatus, setCommandsStatus } from "./runtime";
import { startDashboard } from "./server";
import { errorEmbed } from "./utils/embeds";
import { handleMemberJoin, handleVerifyBtn } from "./modules/verification";
import { handleYouTubeConfig, pollYouTube, startYouTubePoller, youtubeConfigCommands } from "./modules/youtube";

export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildPresences,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember],
});
let backgroundJobsStarted = false;

function getSlashCommandPayload() {
    const commands = [
        setupCommand.toJSON(),
        ...modCommands.map((command) => command.toJSON()),
        ...toolsCommands.map((command) => command.toJSON()),
        ...githubWatchCommands.map((command) => command.toJSON()),
        ...youtubeConfigCommands.map((command) => command.toJSON()),
    ];

    const uniqueCommands = new Map<string, (typeof commands)[number]>();
    for (const command of commands) {
        uniqueCommands.set(command.name, command);
    }

    return [...uniqueCommands.values()];
}

async function syncApplicationCommands() {
    if (!client.user) {
        throw new Error("Discord client is not ready yet.");
    }

    const rest = new REST({ version: "10" }).setToken(config.token);
    const commands = getSlashCommandPayload();

    try {
        if (config.guildId) {
            await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
            await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
            setCommandsStatus("online", {
                lastSyncedAt: new Date().toISOString(),
                lastError: null,
                scope: "guild",
                targetGuildId: config.guildId,
            });
            return `Slash commands synced to guild ${config.guildId}.`;
        }

        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        setCommandsStatus("online", {
            lastSyncedAt: new Date().toISOString(),
            lastError: null,
            scope: "global",
            targetGuildId: null,
        });
        return "Slash commands synced globally.";
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setCommandsStatus("degraded", { lastError: message });
        throw error;
    }
}

async function ensureClientReady() {
    if (!client.isReady()) {
        throw new Error("Discord client is not ready yet.");
    }
}

async function ensureDatabaseReadyForTask() {
    if (!isDatabaseReady()) {
        throw new Error("Database is offline. Retry MongoDB first, then rerun this action.");
    }
}

function maybeStartBackgroundJobs() {
    if (backgroundJobsStarted || !client.isReady() || !isDatabaseReady()) {
        return false;
    }

    backgroundJobsStarted = true;
    startYouTubePoller(client);
    startGitHubPoller(client);
    return true;
}

async function replyDatabaseOffline(interaction: any) {
    if (!interaction.isRepliable()) return;

    const payload = {
        embeds: [
            errorEmbed(
                "Database Offline",
                "MongoDB is unavailable. Fix `MONGODB_URI` or Atlas network access, then retry."
            ),
        ],
        flags: MessageFlags.Ephemeral,
    };

    if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => null);
        return;
    }

    await interaction.reply(payload).catch(() => null);
}

client.once(Events.ClientReady, async (readyClient) => {
    setBotStatus("online", null);

    console.log("");
    console.log("========================================");
    console.log(`Logged in as ${readyClient.user.tag}`);
    console.log(`Guilds: ${readyClient.guilds.cache.size}`);
    console.log(config.credits);
    console.log("========================================");
    console.log("");

    readyClient.user.setActivity("over VoidTools");
    maybeStartBackgroundJobs();

    try {
        console.log(await syncApplicationCommands());
    } catch (error) {
        console.error("Failed to sync slash commands:", error);
    }
});

client.on("error", (error) => {
    console.error("Discord client error:", error);
    setBotStatus("degraded", error.message);
});

client.on("shardDisconnect", (_event, shardId) => {
    setBotStatus("offline", `Shard ${shardId} disconnected.`);
});

client.on("shardResume", (shardId) => {
    console.log(`Shard ${shardId} resumed.`);
    setBotStatus("online", null);
});

client.on("messageCreate", async (message) => {
    try {
        await handleSecurityScan(message);
    } catch (error) {
        console.error("Security scan error:", error);
    }

    try {
        await handlePrefixCommand(message);
    } catch (error) {
        console.error("Prefix command error:", error);
    }
});

client.on("guildMemberAdd", async (member) => {
    try {
        await handleMemberJoin(member);
    } catch (error) {
        console.error("Member join handler error:", error);
    }
});

client.on("interactionCreate", async (interaction) => {
    try {
        if (!isDatabaseReady()) {
            await replyDatabaseOffline(interaction);
            return;
        }

        if (interaction.isChatInputCommand()) {
            if (!interaction.inGuild()) {
                await interaction.reply({ content: "This command can only be used inside a server.", flags: MessageFlags.Ephemeral });
                return;
            }

            if (interaction.commandName === "setup") await executeSetup(interaction);
            if (interaction.commandName === "ban") await handleBan(interaction);
            if (interaction.commandName === "kick") await handleKick(interaction);
            if (interaction.commandName === "purge") await handlePurge(interaction);
            if (["addtool", "removetool", "edittool", "posttool"].includes(interaction.commandName)) await handleToolsAdmin(interaction);
            if (interaction.commandName === "githubwatch") await handleGitHubWatchAdmin(interaction);
            if (interaction.commandName === "youtubeconfig") await handleYouTubeConfig(interaction);
        }

        if (interaction.isButton()) {
            if (interaction.customId === "verify_btn") await handleVerifyBtn(interaction);
            if (interaction.customId === "setup_wizard_btn") await handleSetupWizardBtn(interaction);
            if (interaction.customId === "ticket_btn_open") await handleTicketOpen(interaction);
            if (interaction.customId === "ticket_close") await handleTicketCloseBtn(interaction);
            if (interaction.customId === "ticket_transcript") await handleTicketTranscriptBtn(interaction);
            if (interaction.customId === "ticket_add_user") await handleTicketAddUserBtn(interaction);
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "ticket_select") await handleTicketOpen(interaction);
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === "setup_wizard_modal") await handleSetupWizardSubmit(interaction);
            if (interaction.customId === "ticket_close_modal") await handleTicketCloseSubmit(interaction);
            if (interaction.customId === "ticket_add_user_modal") await handleTicketAddUserSubmit(interaction);
        }
    } catch (error) {
        console.error("Interaction error:", error);
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "An unexpected error occurred.", flags: MessageFlags.Ephemeral }).catch(() => null);
        }
    }
});

startDashboard(client, {
    "retry-db": async () => {
        const connected = await connectDatabase();
        if (!connected) {
            throw new Error("Database connection failed. Check Atlas network access and `MONGODB_URI`.");
        }

        maybeStartBackgroundJobs();
        return "Database connection restored.";
    },
    "sync-commands": async () => {
        await ensureClientReady();
        return syncApplicationCommands();
    },
    "poll-youtube": async () => {
        await ensureClientReady();
        await ensureDatabaseReadyForTask();
        await pollYouTube(client);
        return "YouTube poll completed.";
    },
    "poll-releases": async () => {
        await ensureClientReady();
        await ensureDatabaseReadyForTask();
        await pollGitHub(client);
        return "GitHub poll completed.";
    },
});

async function main() {
    if (!config.token || config.token === "your_bot_token_here") {
        const message = "CRITICAL: No DISCORD_TOKEN set in environment.";
        console.error(message);
        setBotStatus("offline", message);
        return;
    }

    if (config.youtubeApiKey) {
        console.log("YouTube Data API key configured.");
    } else {
        console.warn("YOUTUBE_API_KEY is not set. @handle YouTube inputs will not resolve until it is configured.");
    }

    const databasePromise = connectDatabase().catch((error) => {
        console.error("Initial database connection task failed:", error);
        return false;
    });

    try {
        setBotStatus("starting", null);
        await client.login(config.token);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error("Discord login failed:", error);
        setBotStatus("offline", message);
    }

    const databaseConnected = await databasePromise;
    if (databaseConnected) {
        maybeStartBackgroundJobs();
    }
}

void main();
