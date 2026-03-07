import {
    ActionRowBuilder,
    AnySelectMenuInteraction,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    CategoryChannel,
    ChannelType,
    MessageFlags,
    ModalBuilder,
    ModalSubmitInteraction,
    PermissionFlagsBits,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextChannel,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { config } from "../config";
import { Ticket, getGuildConfig } from "../database";
import { errorEmbed, infoEmbed, primaryEmbed, successEmbed } from "../utils/embeds";
import { PanelRef, ensurePanelMessage } from "../utils/panels";
import { isStaff } from "../utils/permissions";
import { generateTranscript } from "../utils/transcript";

const openingTicketUsers = new Set<string>();

export async function sendTicketPanel(channel: TextChannel, panelRef?: PanelRef | null) {
    return ensurePanelMessage(
        channel,
        ["ticket_select", "ticket_btn_open"],
        {
            embeds: [
                primaryEmbed(
                    "VoidTools Support",
                    "Select a category below to open a private ticket.\n\n**Do NOT share your password, token, or 2FA code with anyone.**"
                ),
            ],
            components: [
                new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                    new StringSelectMenuBuilder()
                        .setCustomId("ticket_select")
                        .setPlaceholder("Select a ticket type...")
                        .addOptions(
                            new StringSelectMenuOptionBuilder().setLabel("Support").setValue("support").setDescription("General help and support"),
                            new StringSelectMenuOptionBuilder().setLabel("Report").setValue("report").setDescription("Report a user or tool"),
                            new StringSelectMenuOptionBuilder().setLabel("Partnership").setValue("partnership").setDescription("Partnership inquiries"),
                            new StringSelectMenuOptionBuilder().setLabel("Buying/Selling").setValue("buying").setDescription("Buying or selling tools")
                        )
                ),
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId("ticket_btn_open").setLabel("Open Ticket (Backup)").setStyle(ButtonStyle.Secondary)
                ),
            ],
        },
        panelRef
    );
}

function buildTicketChannelName(type: string, username: string, shortId: string) {
    const slug = `${type}-${username}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 72);

    return `ticket-${slug || "support"}-${shortId}`.slice(0, 100);
}

function getTextTicketChannel(channel: unknown) {
    if (!channel || !(channel instanceof TextChannel) || channel.type !== ChannelType.GuildText) {
        return null;
    }

    return channel;
}

export async function handleTicketOpen(interaction: AnySelectMenuInteraction | ButtonInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const member = interaction.member as any;
    const botMember = guild?.members.me;
    if (!guild || !member || !botMember) {
        return interaction.editReply({ embeds: [errorEmbed("Unavailable", "This action can only be used inside the server.")] });
    }

    const openerLockKey = `${guild.id}:${member.id}`;
    if (openingTicketUsers.has(openerLockKey)) {
        return interaction.editReply({ embeds: [infoEmbed("Please Wait", "Your previous ticket request is still being processed.")] });
    }

    const type = interaction.isStringSelectMenu() ? interaction.values[0] || "support" : "support";
    openingTicketUsers.add(openerLockKey);

    try {
        const existing = await Ticket.findOne({ openerId: member.id, status: "open", guildId: guild.id });
        if (existing) {
            const existingChannel =
                guild.channels.cache.get(existing.channelId) ||
                (await guild.channels.fetch(existing.channelId).catch(() => null));

            if (existingChannel) {
                return interaction.editReply({ embeds: [infoEmbed("Active Ticket", `You already have an open ticket: <#${existing.channelId}>`)] });
            }

            existing.status = "closed";
            existing.closedAt = new Date();
            existing.closedBy = interaction.client.user?.id || "system";
            existing.closeReason = "Ticket channel missing. Auto-closed stale record.";
            await existing.save();
        }

        const gConf = await getGuildConfig(guild.id);
        if (!gConf) {
            return interaction.editReply({ embeds: [errorEmbed("Setup Required", "Server config not found.")] });
        }

        const category = guild.channels.cache.get(gConf.categoryIds?.supportId as string) as CategoryChannel | undefined;
        const overwrites: any[] = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
                id: member.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.ReadMessageHistory,
                ],
            },
            {
                id: botMember.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.AttachFiles,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.ManageMessages,
                ],
            },
        ];

        for (const roleId of [gConf.roleIds?.adminRoleId, gConf.roleIds?.modRoleId, gConf.roleIds?.supportRoleId]) {
            if (roleId) {
                overwrites.push({
                    id: roleId,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
                });
            }
        }

        const shortId = Math.random().toString(36).slice(2, 6);
        const channel = await guild.channels.create({
            name: buildTicketChannelName(type, member.user.username, shortId),
            type: ChannelType.GuildText,
            parent: category?.id,
            permissionOverwrites: overwrites,
            topic: `Ticket for ${member.user.tag} (ID: ${member.id})`,
        });

        const ticketId = `TKT-${shortId.toUpperCase()}`;
        await new Ticket({
            guildId: guild.id,
            ticketId,
            channelId: channel.id,
            openerId: member.id,
            type,
        }).save();

        await interaction.editReply({ embeds: [successEmbed("Ticket Created", `Head over to ${channel}`)] });

        const welcomeEmbed = primaryEmbed(
            `Ticket: ${type.toUpperCase()}`,
            `Welcome ${member}!\n\nPlease describe your issue below.\n**Rules:** Do NOT share passwords, tokens, or 2FA codes.\n\n**Include:**\n• OS version\n• Error messages (if any)\n• App version`
        ).setFooter({ text: `Ticket ID: ${ticketId} | ${config.credits}` });

        const welcomeMessage = await channel.send({
            content: `${member}`,
            embeds: [welcomeEmbed],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId("ticket_close").setLabel("Close").setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId("ticket_transcript").setLabel("Transcript").setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId("ticket_add_user").setLabel("Add User").setStyle(ButtonStyle.Secondary)
                ),
            ],
        });
        await welcomeMessage.pin().catch(() => null);
    } catch (error) {
        console.error(error);
        await interaction.editReply({ embeds: [errorEmbed("Error", "Could not create channel.")] });
    } finally {
        openingTicketUsers.delete(openerLockKey);
    }
}

export async function handleTicketCloseBtn(interaction: ButtonInteraction) {
    if (!(await isStaff(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
        .setCustomId("ticket_close_modal")
        .setTitle("Close Ticket");

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
                .setCustomId("closeReason")
                .setLabel("Reason for closing")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
        )
    );

    await interaction.showModal(modal);
}

export async function handleTicketCloseSubmit(interaction: ModalSubmitInteraction) {
    if (!(await isStaff(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();
    const channel = getTextTicketChannel(interaction.channel);
    if (!channel) {
        return interaction.editReply({ embeds: [errorEmbed("Invalid Channel", "This ticket action must be used inside a text ticket channel.")] });
    }

    const ticket = await Ticket.findOne({ channelId: channel.id, status: "open" });
    if (!ticket) {
        return interaction.editReply({ embeds: [errorEmbed("Not Found", "Ticket not found in the database.")] });
    }

    const reason = interaction.fields.getTextInputValue("closeReason").trim();
    await interaction.editReply({ embeds: [successEmbed("Closing", "Generating transcript and closing...")] });

    const transcriptAttr = await generateTranscript(channel, 300);
    let transcriptUrl = "None";
    const gConf = interaction.guildId ? await getGuildConfig(interaction.guildId) : null;
    if (gConf?.channelIds?.logsId && transcriptAttr) {
        try {
            const logsChannel =
                (interaction.guild?.channels.cache.get(gConf.channelIds.logsId) as TextChannel | undefined) ||
                ((await interaction.guild?.channels.fetch(gConf.channelIds.logsId).catch(() => null)) as TextChannel | null);

            if (logsChannel) {
                const logMessage = await logsChannel.send({
                    embeds: [
                        primaryEmbed(
                            "Ticket Closed",
                            `**Ticket ID:** ${ticket.ticketId}\n**Opener:** <@${ticket.openerId}>\n**Closed By:** ${interaction.user}\n**Reason:** ${reason}`
                        ),
                    ],
                    files: [transcriptAttr],
                });
                transcriptUrl = logMessage.url;
            }
        } catch (error) {
            console.error("Failed to upload ticket transcript to logs channel:", error);
        }
    }

    ticket.status = "closed";
    ticket.closedAt = new Date();
    ticket.closedBy = interaction.user.id;
    ticket.closeReason = reason;
    ticket.transcriptUrl = transcriptUrl;
    await ticket.save();

    setTimeout(() => {
        void channel.delete(`Closed by ${interaction.user.tag}: ${reason}`).catch((error) => {
            console.error("Failed to delete closed ticket channel:", error);
        });
    }, 4000);
}

export async function handleTicketTranscriptBtn(interaction: ButtonInteraction) {
    if (!(await isStaff(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = getTextTicketChannel(interaction.channel);
    if (!channel) {
        return interaction.editReply({ embeds: [errorEmbed("Invalid Channel", "This ticket action must be used inside a text ticket channel.")] });
    }

    const transcriptAttr = await generateTranscript(channel, 300);
    if (!transcriptAttr) {
        return interaction.editReply({ content: "Failed to generate transcript." });
    }

    await interaction.editReply({ content: "Transcript generated:", files: [transcriptAttr] });
}

export async function handleTicketAddUserBtn(interaction: ButtonInteraction) {
    if (!(await isStaff(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });
    }

    const modal = new ModalBuilder()
        .setCustomId("ticket_add_user_modal")
        .setTitle("Add User to Ticket");

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId("userId").setLabel("User ID").setStyle(TextInputStyle.Short).setRequired(true)
        )
    );

    await interaction.showModal(modal);
}

export async function handleTicketAddUserSubmit(interaction: ModalSubmitInteraction) {
    if (!(await isStaff(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = getTextTicketChannel(interaction.channel);
    if (!channel) {
        return interaction.editReply({ embeds: [errorEmbed("Invalid Channel", "This ticket action must be used inside a text ticket channel.")] });
    }

    try {
        const ticket = await Ticket.findOne({ channelId: channel.id, status: "open" });
        if (!ticket) {
            return interaction.editReply({ embeds: [errorEmbed("Not Found", "Open ticket record not found for this channel.")] });
        }

        const userId = interaction.fields.getTextInputValue("userId").trim();
        const member = await interaction.guild?.members.fetch(userId);
        if (!member) {
            return interaction.editReply({ embeds: [errorEmbed("Not Found", "User not found in server.")] });
        }

        await channel.permissionOverwrites.edit(userId, {
            ViewChannel: true,
            SendMessages: true,
            AttachFiles: true,
            ReadMessageHistory: true,
        });

        await interaction.editReply({ embeds: [successEmbed("Added", `Added <@${userId}> to the ticket.`)] });
        await channel.send(`<@${userId}> was added to the ticket by ${interaction.user}.`).catch(() => null);
    } catch {
        await interaction.editReply({ embeds: [errorEmbed("Error", "Invalid User ID or missing permissions.")] });
    }
}
