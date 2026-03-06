import { EmbedBuilder, GuildMember, User } from "discord.js";
import { config } from "../config";

function baseEmbed(title: string, description: string, color: number, footer?: string) {
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(description || null)
        .setColor(color)
        .setTimestamp()
        .setFooter({ text: footer || config.credits });
}

export function successEmbed(title: string, description = "") {
    return baseEmbed(`✅ ${title}`, description, config.colors.success);
}

export function errorEmbed(title: string, description = "") {
    return baseEmbed(`❌ ${title}`, description, config.colors.error);
}

export function infoEmbed(title: string, description = "") {
    return baseEmbed(`ℹ️ ${title}`, description, config.colors.info);
}

export function warningEmbed(title: string, description = "") {
    return baseEmbed(`⚠️ ${title}`, description, config.colors.warning);
}

export function primaryEmbed(title: string, description = "", footer?: string) {
    return baseEmbed(title, description, config.colors.primary, footer);
}

export function modLogEmbed(action: string, moderator: User, target: User, reason = "No reason provided") {
    return new EmbedBuilder()
        .setTitle(`🔨 Mod Action: ${action}`)
        .setColor(config.colors.warning)
        .addFields([
            { name: "Moderator", value: `${moderator} (${moderator.id})`, inline: true },
            { name: "Target", value: `${target} (${target.id})`, inline: true },
            { name: "Reason", value: reason, inline: false },
        ])
        .setTimestamp()
        .setFooter({ text: config.credits });
}
