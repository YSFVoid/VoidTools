import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    PermissionFlagsBits,
    TextChannel,
    User,
} from "discord.js";
import { successEmbed, errorEmbed, modLogEmbed } from "../utils/embeds";
import { isStaff } from "../utils/permissions";
import { Warning, GuildConfig } from "../database";

export const modCommands = [
    new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a user")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a user")
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

    new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete messages")
        .addIntegerOption(o => o.setName("count").setDescription("Count (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)),
];

async function logAction(interaction: ChatInputCommandInteraction, action: string, target: User, reason: string) {
    const gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (gConf?.channelIds?.logsId) {
        const ch = interaction.guild?.channels.cache.get(gConf.channelIds.logsId) as TextChannel;
        if (ch) await ch.send({ embeds: [modLogEmbed(action, interaction.user, target, reason)] });
    }
}

export async function handleBan(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any))) return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });

    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided";
    const member = interaction.guild?.members.cache.get(target.id);

    try {
        if (member) await member.ban({ reason });
        else await interaction.guild?.members.ban(target, { reason });

        await interaction.reply({ embeds: [successEmbed("Banned", `${target} was banned.\nReason: ${reason}`)], ephemeral: true });
        await logAction(interaction, "Ban", target, reason);
    } catch (e) {
        await interaction.reply({ embeds: [errorEmbed("Error", "Missing permissions or role hierarchy issue.")], ephemeral: true });
    }
}

export async function handleKick(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any))) return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });

    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided";
    const member = interaction.guild?.members.cache.get(target.id);

    if (!member) return interaction.reply({ embeds: [errorEmbed("Not Found", "User not in server.")], ephemeral: true });

    try {
        await member.kick(reason);
        await interaction.reply({ embeds: [successEmbed("Kicked", `${target} was kicked.\nReason: ${reason}`)], ephemeral: true });
        await logAction(interaction, "Kick", target, reason);
    } catch (e) {
        await interaction.reply({ embeds: [errorEmbed("Error", "Missing permissions or role hierarchy issue.")], ephemeral: true });
    }
}

export async function handlePurge(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any))) return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });

    const count = interaction.options.getInteger("count", true);
    const c = interaction.channel as TextChannel;

    try {
        await interaction.deferReply({ ephemeral: true });
        const deleted = await c.bulkDelete(count, true);
        await interaction.editReply({ embeds: [successEmbed("Purged", `Deleted ${deleted.size} messages.`)] });
    } catch (e) {
        await interaction.editReply({ embeds: [errorEmbed("Error", "Failed to delete messages (too old?).")] });
    }
}
