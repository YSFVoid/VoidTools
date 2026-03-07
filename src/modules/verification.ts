import { ButtonInteraction, EmbedBuilder, GuildMember, TextChannel } from "discord.js";
import { config } from "../config";
import { GuildConfig } from "../database";
import { errorEmbed, infoEmbed, successEmbed } from "../utils/embeds";

export async function handleVerifyBtn(interaction: ButtonInteraction) {
    const gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!gConf?.roleIds?.verifiedRoleId) {
        return interaction.reply({ embeds: [errorEmbed("Config Error", "Run `/setup` first.")], ephemeral: true });
    }

    const member = interaction.member as GuildMember;
    const verifiedRoleId = gConf.roleIds.verifiedRoleId;
    if (member.roles.cache.has(verifiedRoleId)) {
        return interaction.reply({ embeds: [infoEmbed("Already Verified", "You are already verified.")], ephemeral: true });
    }

    try {
        await member.roles.add(verifiedRoleId, "Self-verification");
        await interaction.reply({
            embeds: [successEmbed("Verified", "You have been verified! Welcome to VoidTools.")],
            ephemeral: true,
        });

        if (gConf.channelIds?.logsId) {
            const logsChannel =
                (interaction.guild?.channels.cache.get(gConf.channelIds.logsId) as TextChannel | undefined) ||
                ((await interaction.guild?.channels.fetch(gConf.channelIds.logsId).catch(() => null)) as TextChannel | null);

            if (logsChannel) {
                await logsChannel.send({
                    embeds: [successEmbed("Member Verified", `${member} (${member.id}) has verified.`)],
                }).catch(() => null);
            }
        }
    } catch {
        return interaction.reply({ embeds: [errorEmbed("Permission Error", "I cannot assign roles.")], ephemeral: true });
    }
}

export async function handleMemberJoin(member: GuildMember) {
    try {
        const guildConfig = await GuildConfig.findOne({ guildId: member.guild.id });
        const verifyLine = guildConfig?.channelIds?.verifyId
            ? `To access the server, head to <#${guildConfig.channelIds.verifyId}> and click the Verify button.\n\n`
            : "To access the server, head to the verify channel and click the Verify button.\n\n";
        const supportLine = guildConfig?.channelIds?.supportId
            ? `If you have any issues, open a ticket in <#${guildConfig.channelIds.supportId}>.`
            : "If you have any issues, open a ticket in the support channel.";

        const embed = new EmbedBuilder()
            .setTitle("Welcome to VoidTools")
            .setDescription(`${verifyLine}${supportLine}`)
            .setColor(config.colors.primary)
            .setFooter({ text: config.credits });

        await member.send({ embeds: [embed] });
    } catch {
        // Ignore DM failures.
    }
}
