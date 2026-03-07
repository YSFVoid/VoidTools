import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    CategoryChannel,
    ChannelType,
    ChatInputCommandInteraction,
    ModalBuilder,
    ModalSubmitInteraction,
    OverwriteResolvable,
    PermissionFlagsBits,
    Role,
    SlashCommandBuilder,
    TextChannel,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { defaultCategories, defaultChannels, defaultRoles } from "../config";
import { GuildConfig } from "../database";
import { errorEmbed, infoEmbed, primaryEmbed, successEmbed } from "../utils/embeds";
import { ensurePanelMessage } from "../utils/panels";
import { isAdmin } from "../utils/permissions";
import { sendTicketPanel } from "./tickets";
import { ensureYouTubeNotificationRole, normalizeYouTubeChannelInput } from "./youtube";

function getPanelRef(ref: any) {
    if (!ref?.channelId || !ref?.messageId) {
        return null;
    }

    return {
        channelId: ref.channelId,
        messageId: ref.messageId,
    };
}

export const setupCommand = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Idempotent server scaffold. Creates roles, channels, and locks down the server until verified.")
    .setDMPermission(false)
    .addStringOption((opt) =>
        opt
            .setName("mode")
            .setDescription("Setup mode")
            .addChoices(
                { name: "Normal (creates missing items)", value: "normal" },
                { name: "Lockdown (removes Verified role from non-staff)", value: "lockdown" }
            )
            .setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function ensureRole(guild: any, name: string, color?: number, hoist = false): Promise<Role> {
    const existing = guild.roles.cache.find((role: any) => role.name === name);
    if (existing) {
        return existing;
    }

    return guild.roles.create({ name, color, hoist, reason: "Setup" });
}

async function ensureCategory(guild: any, name: string, permissionOverwrites: OverwriteResolvable[] = []): Promise<CategoryChannel> {
    const existing = guild.channels.cache.find((channel: any) => channel.name === name && channel.type === ChannelType.GuildCategory);
    if (existing) {
        await existing.permissionOverwrites.set(permissionOverwrites);
        return existing as CategoryChannel;
    }

    return guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        permissionOverwrites,
        reason: "Setup",
    }) as Promise<CategoryChannel>;
}

async function ensureChannel(
    guild: any,
    fancyName: string,
    slugFallback: string,
    parentId: string,
    permissionOverwrites: OverwriteResolvable[] = []
): Promise<TextChannel> {
    const existing = guild.channels.cache.find(
        (channel: any) => channel.type === ChannelType.GuildText && (channel.name === fancyName || channel.name === slugFallback)
    );
    if (existing) {
        if (existing.parentId !== parentId) {
            await existing.setParent(parentId);
        }
        await existing.permissionOverwrites.set(permissionOverwrites);
        return existing as TextChannel;
    }

    try {
        return (await guild.channels.create({
            name: fancyName,
            type: ChannelType.GuildText,
            parent: parentId,
            permissionOverwrites,
        })) as TextChannel;
    } catch {
        return (await guild.channels.create({
            name: slugFallback,
            type: ChannelType.GuildText,
            parent: parentId,
            permissionOverwrites,
        })) as TextChannel;
    }
}

export async function executeSetup(interaction: ChatInputCommandInteraction) {
    if (!(await isAdmin(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Admin only.")], ephemeral: true });
    }

    await interaction.reply({ embeds: [infoEmbed("Setup Working", "Creating/repairing server structure... Please wait.")], ephemeral: true });

    const guild = interaction.guild!;
    const mode = interaction.options.getString("mode") || "normal";

    const rAdmin = await ensureRole(guild, defaultRoles.admin, 0xa337f7, true);
    const rMod = await ensureRole(guild, defaultRoles.mod, 0x7239ea, true);
    const rSupport = await ensureRole(guild, defaultRoles.support, 0x5865f2, true);
    const rVip = await ensureRole(guild, defaultRoles.vip, 0xf1c40f);
    const rVerified = await ensureRole(guild, defaultRoles.verified, 0x2ecc71);
    const rQuarantine = await ensureRole(guild, defaultRoles.quarantine, 0x992d22);

    const staffOverwrites: OverwriteResolvable[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rMod.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rSupport.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const publicExceptVerifyOverwrites: OverwriteResolvable[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: rVerified.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rMod.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rSupport.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const verifyChannelOverwrites: OverwriteResolvable[] = [
        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: rVerified.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
        { id: rMod.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
        { id: rSupport.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const sellingToolsOverwrites: OverwriteResolvable[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: rVerified.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rMod.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rSupport.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const catSelling = await ensureCategory(guild, defaultCategories.selling, publicExceptVerifyOverwrites);
    const chSellingRules = await ensureChannel(guild, defaultChannels.sellingRules, defaultChannels.sellingRules, catSelling.id, sellingToolsOverwrites);
    const chSellingTools = await ensureChannel(guild, defaultChannels.sellingTools, defaultChannels.sellingTools, catSelling.id, sellingToolsOverwrites);
    const chBuyReqs = await ensureChannel(guild, defaultChannels.buyRequests, defaultChannels.buyRequests, catSelling.id, publicExceptVerifyOverwrites);

    const catInfo = await ensureCategory(guild, defaultCategories.info);
    const chAnnounce = await ensureChannel(guild, defaultChannels.announcements, "announcements", catInfo.id, sellingToolsOverwrites);
    const chVerify = await ensureChannel(guild, defaultChannels.verify, "verify", catInfo.id, verifyChannelOverwrites);

    const catTools = await ensureCategory(guild, defaultCategories.tools, publicExceptVerifyOverwrites);
    const chTools = await ensureChannel(guild, defaultChannels.tools, "tools", catTools.id, publicExceptVerifyOverwrites);
    const chToolRels = await ensureChannel(guild, defaultChannels.toolReleases, "tool-releases", catTools.id, sellingToolsOverwrites);

    const catSupport = await ensureCategory(guild, defaultCategories.support, publicExceptVerifyOverwrites);
    const chSupport = await ensureChannel(guild, defaultChannels.support, "support", catSupport.id, publicExceptVerifyOverwrites);
    const chRequests = await ensureChannel(guild, defaultChannels.requests, "requests", catSupport.id, publicExceptVerifyOverwrites);

    const catSecurity = await ensureCategory(guild, defaultCategories.security, staffOverwrites);
    const chQuarantine = await ensureChannel(guild, defaultChannels.quarantine, "quarantine", catSecurity.id, staffOverwrites);

    const catStaff = await ensureCategory(guild, defaultCategories.staff, staffOverwrites);
    const chReports = await ensureChannel(guild, defaultChannels.reports, "reports", catStaff.id, staffOverwrites);

    const catLogs = await ensureCategory(guild, defaultCategories.logs, staffOverwrites);
    const chLogs = await ensureChannel(guild, defaultChannels.logs, "logs", catLogs.id, staffOverwrites);

    let gConf = await GuildConfig.findOne({ guildId: guild.id });
    if (!gConf) {
        gConf = new GuildConfig({ guildId: guild.id });
    }

    const youtubeRole = await ensureYouTubeNotificationRole(guild, gConf).catch(() => null);

    gConf.roleIds = {
        adminRoleId: rAdmin.id,
        modRoleId: rMod.id,
        supportRoleId: rSupport.id,
        vipRoleId: rVip.id,
        verifiedRoleId: rVerified.id,
        youtubeNotifsRoleId: youtubeRole?.id || gConf.roleIds?.youtubeNotifsRoleId || "",
        quarantineRoleId: rQuarantine.id,
    };
    gConf.channelIds = {
        announcementsId: chAnnounce.id,
        verifyId: chVerify.id,
        toolsId: chTools.id,
        toolReleasesId: chToolRels.id,
        supportId: chSupport.id,
        requestsId: chRequests.id,
        reportsId: chReports.id,
        logsId: chLogs.id,
        sellingRulesId: chSellingRules.id,
        sellingToolsId: chSellingTools.id,
        buyRequestsId: chBuyReqs.id,
    };
    gConf.categoryIds = {
        infoId: catInfo.id,
        toolsId: catTools.id,
        supportId: catSupport.id,
        securityId: catSecurity.id,
        sellingId: catSelling.id,
        staffId: catStaff.id,
        logsId: catLogs.id,
    };

    if (mode === "lockdown") {
        const members = await guild.members.fetch();
        for (const [, member] of members) {
            if (member.id === guild.ownerId || member.user.bot) continue;
            if (member.roles.cache.has(rAdmin.id) || member.roles.cache.has(rMod.id) || member.roles.cache.has(rSupport.id)) continue;
            if (member.roles.cache.has(rVerified.id)) {
                await member.roles.remove(rVerified).catch(() => null);
            }
        }
    }

    const setupChannel = interaction.channel?.type === ChannelType.GuildText ? (interaction.channel as TextChannel) : null;
    if (setupChannel) {
        const setupPanel = await ensurePanelMessage(
            setupChannel,
            ["setup_wizard_btn"],
            {
                embeds: [primaryEmbed("VoidTools Setup Wizard", "Server scaffold complete.\nClick below to configure GitHub, YouTube, and Selling settings.")],
                components: [
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId("setup_wizard_btn").setLabel("Configure Setup").setStyle(ButtonStyle.Primary)
                    ),
                ],
            },
            getPanelRef(gConf.panelRefs?.setupWizard)
        );

        gConf.panelRefs = {
            ...(gConf.panelRefs || {}),
            setupWizard: {
                channelId: setupPanel.channelId,
                messageId: setupPanel.messageId,
            },
        };
    }

    const verifyPanel = await ensurePanelMessage(
        chVerify,
        ["verify_btn"],
        {
            embeds: [infoEmbed("Verification Required", "Click `Verify` to gain access to the server. You will not see this channel once verified.\n\nDo NOT share passwords or tokens.")],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId("verify_btn").setLabel("Verify").setStyle(ButtonStyle.Success)
                ),
            ],
        },
        getPanelRef(gConf.panelRefs?.verify)
    );

    gConf.panelRefs = {
        ...(gConf.panelRefs || {}),
        verify: {
            channelId: verifyPanel.channelId,
            messageId: verifyPanel.messageId,
        },
    };

    const ticketPanel = await sendTicketPanel(chSupport, getPanelRef(gConf.panelRefs?.ticket));
    gConf.panelRefs = {
        ...(gConf.panelRefs || {}),
        ticket: {
            channelId: ticketPanel.channelId,
            messageId: ticketPanel.messageId,
        },
    };

    await gConf.save();

    void chQuarantine;
    await interaction.editReply({ embeds: [successEmbed("Setup Complete", `Server structure secured. Mode: \`${mode}\``)] });
}

export async function handleSetupWizardBtn(interaction: any) {
    if (!(await isAdmin(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Admin only.")], ephemeral: true });
    }

    const modal = new ModalBuilder()
        .setCustomId("setup_wizard_modal")
        .setTitle("VoidTools Config");

    const ghInput = new TextInputBuilder()
        .setCustomId("github")
        .setLabel("GitHub Repos/Feeds (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const ytInput = new TextInputBuilder()
        .setCustomId("youtube")
        .setLabel("YouTube Channel ID or URL (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    const sellDescInput = new TextInputBuilder()
        .setCustomId("sellingDesc")
        .setLabel("Selling Tools Description")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

    const sellContactInput = new TextInputBuilder()
        .setCustomId("sellingContact")
        .setLabel("Selling Contact Info")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

    modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(ghInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(ytInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(sellDescInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(sellContactInput)
    );

    await interaction.showModal(modal);
}

export async function handleSetupWizardSubmit(interaction: ModalSubmitInteraction) {
    if (!(await isAdmin(interaction.member as any))) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Admin only.")], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const github = interaction.fields.getTextInputValue("github").trim();
    const youtube = interaction.fields.getTextInputValue("youtube").trim();
    const desc = interaction.fields.getTextInputValue("sellingDesc").trim();
    const contact = interaction.fields.getTextInputValue("sellingContact").trim();
    const normalizedYouTube = normalizeYouTubeChannelInput(youtube);

    if (normalizedYouTube.error) {
        return interaction.editReply({ embeds: [errorEmbed("Invalid YouTube Input", normalizedYouTube.error)] });
    }

    const gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!gConf) {
        return interaction.editReply({ embeds: [errorEmbed("Config Not Found", "Run /setup first.")] });
    }

    gConf.setupWizard = {
        githubValue: github,
        youtubeChannelId: normalizedYouTube.value || "",
        sellingDescription: desc,
        sellingContact: contact,
        notifyChannelId: gConf.channelIds?.toolReleasesId,
    };

    if (normalizedYouTube.value) {
        gConf.youtube = {
            ...(gConf.youtube || {}),
            channelInput: normalizedYouTube.value,
            notifyChannelId: gConf.channelIds?.toolReleasesId || "",
            lastVideoId: gConf.youtube?.lastVideoId,
            lastVideoPublishedAt: gConf.youtube?.lastVideoPublishedAt,
        };
    }

    await gConf.save();

    if (normalizedYouTube.value && interaction.guild) {
        await ensureYouTubeNotificationRole(interaction.guild, gConf).catch(() => null);
    }

    await interaction.editReply({
        embeds: [
            successEmbed(
                "Wizard Completed",
                `Config updated.\n**GitHub**: ${github || "N/A"}\n**YouTube**: ${youtube || "N/A"}`
            ),
        ],
    });
}
