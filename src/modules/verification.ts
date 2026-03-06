import {
    ButtonInteraction,
    GuildMember,
    EmbedBuilder,
    TextChannel
} from "discord.js";
import { config } from "../config";
import { GuildConfig } from "../database";
import { successEmbed, errorEmbed, infoEmbed } from "../utils/embeds";

export async function handleVerifyBtn(interaction: ButtonInteraction) {
    const gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!gConf || !gConf.roleIds?.verifiedRoleId) {
        return interaction.reply({ embeds: [errorEmbed("Config Error", "Run `/setup` first.")], ephemeral: true });
    }

    const member = interaction.member as GuildMember;
    const verifiedRoleId = gConf.roleIds.verifiedRoleId;

    if (member.roles.cache.has(verifiedRoleId)) {
        return interaction.reply({ embeds: [infoEmbed("Already Verified", "You are already verified!")], ephemeral: true });
    }

    try {
        await member.roles.add(verifiedRoleId, "Self-verification");
        await interaction.reply({
            embeds: [successEmbed("Verified", "You have been verified! Welcome to VoidTools. 🎉")],
            ephemeral: true
        });

        // Logging
        if (gConf.channelIds?.logsId) {
            const logsCh = interaction.guild?.channels.cache.get(gConf.channelIds.logsId) as TextChannel;
            if (logsCh) {
                logsCh.send({ embeds: [successEmbed("✅ Member Verified", `${member} (${member.id}) has verified.`)] });
            }
        }
    } catch (error) {
        return interaction.reply({ embeds: [errorEmbed("Permission Error", "I cannot assign roles.")], ephemeral: true });
    }
}

export async function handleMemberJoin(member: GuildMember) {
    try {
        const embed = new EmbedBuilder()
            .setTitle("Welcome to VoidTools! 🔮")
            .setDescription(
                "To access the server, please head to the **verify** channel and click the **✅ Verify** button.\n\n" +
                "If you have any issues, open a ticket in the support channel."
            )
            .setColor(config.colors.primary)
            .setFooter({ text: config.credits });

        await member.send({ embeds: [embed] });
    } catch (err) {
        // DMs closed
    }
}
