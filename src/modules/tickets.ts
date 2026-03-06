import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    EmbedBuilder,
    TextChannel,
    PermissionFlagsBits,
    CategoryChannel,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    AnySelectMenuInteraction,
    ButtonInteraction,
} from "discord.js";
import { config, defaultRoles } from "../config";
import { GuildConfig, Ticket } from "../database";
import { successEmbed, errorEmbed, primaryEmbed, infoEmbed } from "../utils/embeds";
import { isStaff } from "../utils/permissions";
import { generateTranscript } from "../utils/transcript";

// ── 1. SEND PANEL ──────────────────────────────────────────
export async function sendTicketPanel(channel: TextChannel) {
    const embed = primaryEmbed(
        "🎫 VoidTools Support",
        "Select a category below to open a private ticket.\n\n" +
        "**Do NOT share your password, token, or 2FA code with anyone.**"
    );

    const select = new StringSelectMenuBuilder()
        .setCustomId("ticket_select")
        .setPlaceholder("Select a ticket type...")
        .addOptions(
            new StringSelectMenuOptionBuilder().setLabel("Support").setValue("support").setEmoji("🛠️").setDescription("General help and support"),
            new StringSelectMenuOptionBuilder().setLabel("Report").setValue("report").setEmoji("🚨").setDescription("Report a user or tool"),
            new StringSelectMenuOptionBuilder().setLabel("Partnership").setValue("partnership").setEmoji("🤝").setDescription("Partnership inquiries"),
            new StringSelectMenuOptionBuilder().setLabel("Buying/Selling").setValue("buying").setEmoji("🛒").setDescription("Buying or selling tools")
        );

    const btn = new ButtonBuilder()
        .setCustomId("ticket_btn_open")
        .setLabel("Open Ticket (Backup)")
        .setStyle(ButtonStyle.Secondary);

    const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(btn);

    await channel.send({ embeds: [embed], components: [row1, row2] });
}

// ── 2. CREATE TICKET ─────────────────────────────────────
export async function handleTicketOpen(interaction: AnySelectMenuInteraction | ButtonInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild!;
    const member = interaction.member as any;
    let type = "support";

    if (interaction.isStringSelectMenu()) {
        type = interaction.values[0];
    }

    const existing = await Ticket.findOne({ openerId: member.id, status: "open", guildId: guild.id });
    if (existing) {
        return interaction.editReply({ embeds: [infoEmbed("Active Ticket", `You already have an open ticket: <#${existing.channelId}>`)] });
    }

    const gConf = await GuildConfig.findOne({ guildId: guild.id });
    if (!gConf) return interaction.editReply({ embeds: [errorEmbed("Setup Required", "Server config not found.")] });

    const category = guild.channels.cache.get(gConf.categoryIds?.supportId as string) as CategoryChannel;

    const overwrites: any[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.AttachFiles] },
        { id: guild.members.me!.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ];

    // Add staff
    if (gConf.roleIds?.adminRoleId) overwrites.push({ id: gConf.roleIds.adminRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    if (gConf.roleIds?.modRoleId) overwrites.push({ id: gConf.roleIds.modRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
    if (gConf.roleIds?.supportRoleId) overwrites.push({ id: gConf.roleIds.supportRoleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });

    const shortId = Math.random().toString(36).substring(2, 6);
    const channelName = `ticket-${type}-${member.user.username}-${shortId}`;

    try {
        const channel = await guild.channels.create({
            name: channelName,
            type: 0,
            parent: category?.id,
            permissionOverwrites: overwrites,
            topic: `Ticket for ${member.user.tag} (ID: ${member.id})`,
        });

        const ticketId = `TKT-${shortId.toUpperCase()}`;
        const newTicket = new Ticket({
            guildId: guild.id,
            ticketId,
            channelId: channel.id,
            openerId: member.id,
            type
        });
        await newTicket.save();

        await interaction.editReply({ embeds: [successEmbed("Ticket Created", `Head over to ${channel}`)] });

        const welcomeEmbed = primaryEmbed(
            `🎫 Ticket: ${type.toUpperCase()}`,
            `Welcome ${member}!\n\n` +
            `Please describe your issue below.\n` +
            `**Rules:** Do NOT share passwords, tokens, or 2FA codes.\n\n` +
            `**Include:**\n` +
            `• OS version\n` +
            `• Error messages (if any)\n` +
            `• App version`
        ).setFooter({ text: `Ticket ID: ${ticketId} | ${config.credits}` });

        const btnRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId("ticket_close").setLabel("🔒 Close").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("ticket_transcript").setLabel("🧾 Transcript").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId("ticket_add_user").setLabel("➕ Add User").setStyle(ButtonStyle.Secondary)
        );

        const msg = await channel.send({ content: `${member}`, embeds: [welcomeEmbed], components: [btnRow] });
        await msg.pin();
    } catch (e) {
        console.error(e);
        await interaction.editReply({ embeds: [errorEmbed("Error", "Could not create channel.")] });
    }
}

// ── 3. CLOSE MODAL ───────────────────────────────────────
export async function handleTicketCloseBtn(interaction: ButtonInteraction) {
    if (!await isStaff(interaction.member as any)) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId("ticket_close_modal")
        .setTitle("Close Ticket");

    const reasonInput = new TextInputBuilder()
        .setCustomId("closeReason")
        .setLabel("Reason for closing")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));
    await interaction.showModal(modal);
}

// ── 4. CLOSE EXECUTION ───────────────────────────────────
export async function handleTicketCloseSubmit(interaction: ModalSubmitInteraction) {
    await interaction.deferReply();
    const reason = interaction.fields.getTextInputValue("closeReason");
    const channel = interaction.channel as TextChannel;

    const ticket = await Ticket.findOne({ channelId: channel.id, status: "open" });
    if (!ticket) return interaction.editReply("Ticket not found in DB.");

    await interaction.editReply({ embeds: [successEmbed("Closing", "Generating transcript and closing...")] });

    const transcriptAttr = await generateTranscript(channel, 300);

    const gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    let transcriptUrl = "None";

    // Upload transcript to logs channel
    if (gConf && gConf.channelIds?.logsId && transcriptAttr) {
        const logsCh = interaction.guild?.channels.cache.get(gConf.channelIds.logsId) as TextChannel;
        if (logsCh) {
            const em = primaryEmbed(
                "🎫 Ticket Closed",
                `**Ticket ID:** ${ticket.ticketId}\n` +
                `**Opener:** <@${ticket.openerId}>\n` +
                `**Closed By:** ${interaction.user}\n` +
                `**Reason:** ${reason}`
            );
            const msg = await logsCh.send({ embeds: [em], files: [transcriptAttr] });
            transcriptUrl = msg.url;
        }
    }

    ticket.status = "closed";
    ticket.closedAt = new Date();
    ticket.closedBy = interaction.user.id;
    ticket.closeReason = reason;
    ticket.transcriptUrl = transcriptUrl;
    await ticket.save();

    setTimeout(() => channel.delete(`Closed by ${interaction.user.tag}: ${reason}`), 4000);
}

export async function handleTicketTranscriptBtn(interaction: ButtonInteraction) {
    if (!await isStaff(interaction.member as any)) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const transcriptAttr = await generateTranscript(interaction.channel as TextChannel, 300);
    if (transcriptAttr) {
        await interaction.editReply({ content: "Transcript generated:", files: [transcriptAttr] });
    } else {
        await interaction.editReply({ content: "Failed to generate transcript." });
    }
}
