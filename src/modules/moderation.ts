import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    TextChannel,
    User,
} from "discord.js";
import { successEmbed, errorEmbed, modLogEmbed } from "../utils/embeds";
import { isStaff } from "../utils/permissions";
import { getGuildConfig } from "../database";

export const modCommands = [
    new SlashCommandBuilder()
        .setName("ban")
        .setDescription("Ban a user")
        .setDMPermission(false)
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

    new SlashCommandBuilder()
        .setName("kick")
        .setDescription("Kick a user")
        .setDMPermission(false)
        .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

    new SlashCommandBuilder()
        .setName("purge")
        .setDescription("Delete messages")
        .setDMPermission(false)
        .addIntegerOption(o => o.setName("count").setDescription("Count (1-100)").setRequired(true).setMinValue(1).setMaxValue(100)),
];

async function logAction(interaction: ChatInputCommandInteraction, action: string, target: User, reason: string) {
    const gConf = interaction.guildId ? await getGuildConfig(interaction.guildId) : null;
    if (gConf?.channelIds?.logsId) {
        const ch = interaction.guild?.channels.cache.get(gConf.channelIds.logsId) as TextChannel;
        if (ch) await ch.send({ embeds: [modLogEmbed(action, interaction.user, target, reason)] });
    }
}

export async function handleBan(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any))) return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    if (!guild) {
        return interaction.reply({ embeds: [errorEmbed("Guild Only", "This command can only be used inside a server.")], flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided";
    const member = await guild.members.fetch(target.id).catch(() => null);

    if (target.id === interaction.user.id) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "You cannot ban yourself.")], flags: MessageFlags.Ephemeral });
    }

    if (target.id === guild.ownerId) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "You cannot ban the server owner.")], flags: MessageFlags.Ephemeral });
    }

    if (target.id === interaction.client.user.id) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "You cannot ban the bot.")], flags: MessageFlags.Ephemeral });
    }

    if (member && !member.bannable) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "That member cannot be banned because of Discord role hierarchy or missing permissions.")], flags: MessageFlags.Ephemeral });
    }

    try {
        if (member) await member.ban({ reason });
        else await guild.members.ban(target, { reason });

        await interaction.reply({ embeds: [successEmbed("Banned", `${target} was banned.\nReason: ${reason}`)], flags: MessageFlags.Ephemeral });
        await logAction(interaction, "Ban", target, reason);
    } catch (e) {
        await interaction.reply({ embeds: [errorEmbed("Error", "Missing permissions or role hierarchy issue.")], flags: MessageFlags.Ephemeral });
    }
}

export async function handleKick(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any))) return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    if (!guild) {
        return interaction.reply({ embeds: [errorEmbed("Guild Only", "This command can only be used inside a server.")], flags: MessageFlags.Ephemeral });
    }

    const target = interaction.options.getUser("user", true);
    const reason = interaction.options.getString("reason") || "No reason provided";
    const member = await guild.members.fetch(target.id).catch(() => null);

    if (!member) return interaction.reply({ embeds: [errorEmbed("Not Found", "User not in server.")], flags: MessageFlags.Ephemeral });

    if (target.id === interaction.user.id) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "You cannot kick yourself.")], flags: MessageFlags.Ephemeral });
    }

    if (target.id === guild.ownerId) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "You cannot kick the server owner.")], flags: MessageFlags.Ephemeral });
    }

    if (target.id === interaction.client.user.id) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "You cannot kick the bot.")], flags: MessageFlags.Ephemeral });
    }

    if (!member.kickable) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "That member cannot be kicked because of Discord role hierarchy or missing permissions.")], flags: MessageFlags.Ephemeral });
    }

    try {
        await member.kick(reason);
        await interaction.reply({ embeds: [successEmbed("Kicked", `${target} was kicked.\nReason: ${reason}`)], flags: MessageFlags.Ephemeral });
        await logAction(interaction, "Kick", target, reason);
    } catch (e) {
        await interaction.reply({ embeds: [errorEmbed("Error", "Missing permissions or role hierarchy issue.")], flags: MessageFlags.Ephemeral });
    }
}

export async function handlePurge(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any))) return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });

    const count = interaction.options.getInteger("count", true);
    const channel = interaction.channel;
    if (!(channel instanceof TextChannel)) {
        return interaction.reply({ embeds: [errorEmbed("Invalid Channel", "Bulk delete only works in standard text channels.")], flags: MessageFlags.Ephemeral });
    }

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const deleted = await channel.bulkDelete(count, true);
        await interaction.editReply({ embeds: [successEmbed("Purged", `Deleted ${deleted.size} messages.`)] });
    } catch (e) {
        await interaction.editReply({ embeds: [errorEmbed("Error", "Failed to delete messages (too old?).")] });
    }
}
