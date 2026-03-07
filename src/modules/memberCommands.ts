import { Message, EmbedBuilder } from "discord.js";
import { config } from "../config";
import { primaryEmbed, infoEmbed, successEmbed, errorEmbed } from "../utils/embeds";
import { GuildConfig, Tool, isDatabaseReady } from "../database";
import { escapeRegExp } from "../utils/regex";
import { ensureYouTubeNotificationRole } from "./youtube";

export async function handlePrefixCommand(message: Message) {
    if (!message.content.startsWith(config.prefix) || message.author.bot) return;

    const args = message.content.slice(config.prefix.length).trim().split(/ +/);
    const command = args.shift()?.toLowerCase();

    if (!command) return;

    if (!isDatabaseReady() && !["help", "ping"].includes(command)) {
        await message.reply({
            embeds: [errorEmbed("Database Offline", "MongoDB is unavailable right now. Fix the database connection, then retry.")],
        });
        return;
    }

    switch (command) {
        case "help": {
            const em = primaryEmbed("🔮 VoidTools Bot — Help", "Available prefix commands:");
            em.addFields([
                { name: "!help", value: "Show this help." },
                { name: "!ping", value: "Check latency." },
                { name: "!tools", value: "Browse tool categories." },
                { name: "!tool <name>", value: "View tool details." },
                { name: "!yt [on|off]", value: "Toggle YouTube DM notifications." }
            ]);
            await message.reply({ embeds: [em] });
            break;
        }
        case "ping": {
            await message.reply({ embeds: [infoEmbed("Pong! 🏓", `Latency is **${Math.round(message.client.ws.ping)}ms**.`)] });
            break;
        }
        case "tools": {
            const tools = await Tool.find();
            if (!tools.length) return message.reply({ embeds: [infoEmbed("Tools", "No tools published yet.")] });

            const catMap: Record<string, string[]> = {};
            tools.forEach(t => {
                const cat = t.category || "Uncategorized";
                if (!catMap[cat]) catMap[cat] = [];
                catMap[cat].push(`• \`${t.name}\``);
            });

            const em = primaryEmbed("🛠️ Tools Hub", "Use `!tool <name>` for details.");
            for (const [cat, items] of Object.entries(catMap)) {
                em.addFields({ name: `📁 ${cat}`, value: items.join("\n") });
            }
            await message.reply({ embeds: [em] });
            break;
        }
        case "tool": {
            if (!args[0]) return message.reply({ embeds: [errorEmbed("Missing Argument", "Usage: `!tool <name>`")] });
            const toolName = args.join(" ").toLowerCase();

            const tool = await Tool.findOne({ name: { $regex: new RegExp(`^${escapeRegExp(toolName)}$`, "i") } });
            if (!tool) return message.reply({ embeds: [errorEmbed("Not Found", `Tool **${toolName}** not found.`)] });

            const em = infoEmbed(`🛠️ ${tool.name}`, tool.description || "No description.");
            if (tool.version) em.addFields({ name: "Version", value: tool.version, inline: true });
            if (tool.category) em.addFields({ name: "Category", value: tool.category, inline: true });
            if (tool.sourceUrl) em.addFields({ name: "Source Code", value: tool.sourceUrl, inline: false });
            if (tool.downloadUrl) em.addFields({ name: "Download", value: tool.downloadUrl, inline: false });
            else if (tool.url) em.addFields({ name: "Download", value: tool.url, inline: false });
            if (tool.publishedChannelId) em.addFields({ name: "Published In", value: `<#${tool.publishedChannelId}>`, inline: true });

            let attachStr = "";
            if (tool.filename) attachStr += `📎 \`${tool.filename}\`\n`;
            if (tool.sha256) attachStr += `SHA256: \`${tool.sha256}\`\n`;
            if (tool.size) attachStr += `Size: ${tool.size}`;
            if (attachStr) em.addFields({ name: "Attachment", value: attachStr, inline: false });

            em.addFields({ name: "⚠️ Safety", value: "Verify source and scan locally.", inline: false });
            await message.reply({ embeds: [em] });
            break;
        }
        case "yt": {
            if (!message.guild || !message.member) {
                return message.reply({ embeds: [errorEmbed("Guild Only", "Use this command inside the server.")] });
            }

            const mode = args[0]?.toLowerCase();
            const gConf = await GuildConfig.findOne({ guildId: message.guild.id });
            const role = await ensureYouTubeNotificationRole(message.guild, gConf || undefined).catch(() => null);
            if (!role) {
                return message.reply({ embeds: [errorEmbed("Config Error", "I could not create or repair the YouTube opt-in role.")] });
            }

            const roleId = role.id;

            try {
                if (mode === "on") {
                    if (message.member.roles.cache.has(roleId)) return message.reply({ embeds: [infoEmbed("Info", "Already opted-in.")] });
                    await message.member.roles.add(role);
                    await message.reply({ embeds: [successEmbed("YouTube Notifications", "You will now receive DMs for new videos.")] });
                } else if (mode === "off") {
                    if (!message.member.roles.cache.has(roleId)) return message.reply({ embeds: [infoEmbed("Info", "Already opted-out.")] });
                    await message.member.roles.remove(role);
                    await message.reply({ embeds: [successEmbed("YouTube Notifications", "Opted-out. You will no longer receive DMs.")] });
                } else {
                    await message.reply({ embeds: [infoEmbed("YouTube Auto-DMs", "Usage: `!yt on` to subscribe, `!yt off` to unsubscribe.")] });
                }
            } catch {
                await message.reply({ embeds: [errorEmbed("Permission Error", "I could not update your YouTube notification role.")] });
            }
            break;
        }
    }
}
