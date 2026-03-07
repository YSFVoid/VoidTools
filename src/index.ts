import { Client, GatewayIntentBits, Partials, Routes } from "discord.js";
import { REST } from "@discordjs/rest";
import { config } from "./config";
import { connectDatabase } from "./database";

// Event Handlers
import { handleSecurityScan } from "./modules/security";
import { handlePrefixCommand } from "./modules/memberCommands";
import { setupCommand, executeSetup, handleSetupWizardBtn, handleSetupWizardSubmit } from "./modules/setup";
import { handleVerifyBtn, handleMemberJoin } from "./modules/verification";
import { handleTicketOpen, handleTicketCloseBtn, handleTicketCloseSubmit, handleTicketTranscriptBtn, handleTicketAddUserBtn, handleTicketAddUserSubmit } from "./modules/tickets";
import { toolsCommands, handleToolsAdmin } from "./modules/toolsHub";
import { startYouTubePoller } from "./modules/youtube";
import { releasesCommands, handleReleasesAdmin, startReleasesPoller } from "./modules/releases";
import { modCommands, handleBan, handleKick, handlePurge } from "./modules/moderation";
import { startDashboard } from "./server";

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

client.once("ready", async () => {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  Logged in as ${client.user?.tag}`);
    console.log(`  Guilds: ${client.guilds.cache.size}`);
    console.log(`  ${config.credits}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    client.user?.setActivity("over VoidTools 🔮");

    // Start polling
    startYouTubePoller(client);
    startReleasesPoller(client);

    // Sync slash commands
    const rest = new REST({ version: "10" }).setToken(config.token);
    try {
        const commands = [setupCommand.toJSON(), ...modCommands.map(c => c.toJSON()), ...toolsCommands.map(c => c.toJSON()), ...releasesCommands.map(c => c.toJSON())];
        await rest.put(Routes.applicationCommands(client.user!.id), { body: commands });
        console.log("Slash commands synced globally.");
    } catch (error) {
        console.error("Failed to sync slash commands:", error);
    }

    // Start Replit Keep-Alive Web Dashboard
    startDashboard(client);
});

// MESSAGE EVENTS
client.on("messageCreate", async (message) => {
    await handleSecurityScan(message);
    await handlePrefixCommand(message);
});

// GUILD MEMBER EVENTS
client.on("guildMemberAdd", async (member) => {
    await handleMemberJoin(member);
});

// INTERACTION EVENTS
client.on("interactionCreate", async (interaction) => {
    try {
        // 1. Slash Commands
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "setup") await executeSetup(interaction);
            if (interaction.commandName === "ban") await handleBan(interaction);
            if (interaction.commandName === "kick") await handleKick(interaction);
            if (interaction.commandName === "purge") await handlePurge(interaction);
            if (["addtool", "removetool", "edittool"].includes(interaction.commandName)) await handleToolsAdmin(interaction);
            if (interaction.commandName === "releases") await handleReleasesAdmin(interaction);
        }

        // 2. Buttons
        if (interaction.isButton()) {
            if (interaction.customId === "verify_btn") await handleVerifyBtn(interaction);
            if (interaction.customId === "setup_wizard_btn") await handleSetupWizardBtn(interaction);
            if (interaction.customId === "ticket_btn_open") await handleTicketOpen(interaction);
            if (interaction.customId === "ticket_close") await handleTicketCloseBtn(interaction);
            if (interaction.customId === "ticket_transcript") await handleTicketTranscriptBtn(interaction);
            if (interaction.customId === "ticket_add_user") await handleTicketAddUserBtn(interaction);
        }

        // 3. Select Menus
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "ticket_select") await handleTicketOpen(interaction);
        }

        // 4. Modals
        if (interaction.isModalSubmit()) {
            if (interaction.customId === "setup_wizard_modal") await handleSetupWizardSubmit(interaction);
            if (interaction.customId === "ticket_close_modal") await handleTicketCloseSubmit(interaction);
            if (interaction.customId === "ticket_add_user_modal") await handleTicketAddUserSubmit(interaction);
        }

    } catch (error) {
        console.error("Interaction Error:", error);
        if (interaction.isRepliable() && !interaction.replied) {
            await interaction.reply({ content: "An unexpected error occurred.", ephemeral: true }).catch(() => null);
        }
    }
});

async function main() {
    if (!config.token || config.token === "your_bot_token_here") {
        console.error("CRITICAL: No DISCORD_TOKEN set in .env.");
        process.exit(1);
    }
    await connectDatabase();
    await client.login(config.token);
}

main().catch(console.error);
