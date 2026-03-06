import {
    ChatInputCommandInteraction,
    SlashCommandBuilder,
    TextChannel,
    CategoryChannel,
    Role,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ModalSubmitInteraction,
    OverwriteResolvable,
} from "discord.js";
import { GuildConfig } from "../database";
import { config, defaultCategories, defaultChannels, defaultRoles } from "../config";
import { toBold, toSlug } from "../utils/boldFont";
import { successEmbed, errorEmbed, infoEmbed, primaryEmbed } from "../utils/embeds";
import { isAdmin } from "../utils/permissions";

// Command definition
export const setupCommand = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Idempotent server scaffold. Creates roles, channels, and locks down the server until verified.")
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

async function ensureRole(guild: any, name: string, color?: any, hoist = false): Promise<Role> {
    const existing = guild.roles.cache.find((r: any) => r.name === name);
    if (existing) return existing;
    return await guild.roles.create({ name, color, hoist, reason: "Setup" });
}

async function ensureCategory(guild: any, name: string, permissionOverwrites: OverwriteResolvable[] = []): Promise<CategoryChannel> {
    const existing = guild.channels.cache.find((c: any) => c.name === name && c.type === 4);
    if (existing) {
        await existing.permissionOverwrites.set(permissionOverwrites);
        return existing as CategoryChannel;
    }
    return await guild.channels.create({
        name,
        type: 4, // Category
        permissionOverwrites,
        reason: "Setup",
    }) as CategoryChannel;
}

async function ensureChannel(
    guild: any,
    fancyName: string,
    slugFallback: string,
    parentId: string,
    permissionOverwrites: OverwriteResolvable[] = []
): Promise<TextChannel> {
    const existing = guild.channels.cache.find((c: any) => c.name === fancyName || c.name === slugFallback);
    if (existing) {
        if (existing.parentId !== parentId) await existing.setParent(parentId);
        await existing.permissionOverwrites.set(permissionOverwrites);
        return existing as TextChannel;
    }

    try {
        return (await guild.channels.create({
            name: fancyName,
            type: 0, // Text
            parent: parentId,
            permissionOverwrites,
        })) as TextChannel;
    } catch {
        return (await guild.channels.create({
            name: slugFallback,
            type: 0,
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

    // 1. ROLES
    const rAdmin = await ensureRole(guild, defaultRoles.admin, 0xa337f7, true);
    const rMod = await ensureRole(guild, defaultRoles.mod, 0x7239ea, true);
    const rSupport = await ensureRole(guild, defaultRoles.support, 0x5865f2, true);
    const rVip = await ensureRole(guild, defaultRoles.vip, 0xf1c40f);
    const rVerified = await ensureRole(guild, defaultRoles.verified, 0x2ecc71);
    const rQuarantine = await ensureRole(guild, defaultRoles.quarantine, 0x992d22);
    const rYoutube = await ensureRole(guild, defaultRoles.youtube, 0xe74c3c);

    // 2. PERMISSION SETS (Strict Lockdown)
    const staffOverwrites: OverwriteResolvable[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rMod.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
        { id: rSupport.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const publicExceptVerifyOverwrites: OverwriteResolvable[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] }, // @everyone denies view
        { id: rVerified.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }, // Verified can see
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
        { id: rMod.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const verifyChannelOverwrites: OverwriteResolvable[] = [
        { id: guild.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] }, // everyone sees #verify
        { id: rVerified.id, deny: [PermissionFlagsBits.ViewChannel] }, // Verified CANNOT see #verify (disappears)
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    ];

    const sellingToolsOverwrites: OverwriteResolvable[] = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: rVerified.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory], deny: [PermissionFlagsBits.SendMessages] },
        { id: rAdmin.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    ];

    // 3. SELLING CATEGORY & CHANNELS
    const catSelling = await ensureCategory(guild, defaultCategories.selling, publicExceptVerifyOverwrites);
    const chSellingRules = await ensureChannel(guild, defaultChannels.sellingRules, defaultChannels.sellingRules, catSelling.id, sellingToolsOverwrites);
    const chSellingTools = await ensureChannel(guild, defaultChannels.sellingTools, defaultChannels.sellingTools, catSelling.id, sellingToolsOverwrites);
    const chBuyReqs = await ensureChannel(guild, defaultChannels.buyRequests, defaultChannels.buyRequests, catSelling.id, publicExceptVerifyOverwrites);

    // 4. OTHER CATEGORIES
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

    // DB Store
    let gConf = await GuildConfig.findOne({ guildId: guild.id });
    if (!gConf) gConf = new GuildConfig({ guildId: guild.id });

    gConf.roleIds = {
        adminRoleId: rAdmin.id, modRoleId: rMod.id, supportRoleId: rSupport.id,
        vipRoleId: rVip.id, verifiedRoleId: rVerified.id, youtubeNotifsRoleId: rYoutube.id,
        quarantineRoleId: rQuarantine.id
    };
    gConf.channelIds = {
        announcementsId: chAnnounce.id, verifyId: chVerify.id, toolsId: chTools.id,
        toolReleasesId: chToolRels.id, supportId: chSupport.id, requestsId: chRequests.id,
        reportsId: chReports.id, logsId: chLogs.id, sellingRulesId: chSellingRules.id,
        sellingToolsId: chSellingTools.id, buyRequestsId: chBuyReqs.id
    };
    gConf.categoryIds = {
        infoId: catInfo.id, toolsId: catTools.id, supportId: catSupport.id,
        securityId: catSecurity.id, sellingId: catSelling.id, staffId: catStaff.id, logsId: catLogs.id
    };
    await gConf.save();

    // Mode Action
    if (mode === "lockdown") {
        // Strip verified from everyone but owner/staff
        const members = await guild.members.fetch();
        for (const [_, mem] of members) {
            if (mem.id === guild.ownerId || mem.user.bot) continue;
            if (mem.roles.cache.has(rAdmin.id) || mem.roles.cache.has(rMod.id)) continue;

            if (mem.roles.cache.has(rVerified.id)) {
                await mem.roles.remove(rVerified).catch(() => null);
            }
        }
    }

    // Setup Wizard Panel
    const setupEmbed = primaryEmbed(
        "VoidTools Setup Wizard",
        "Server scaffold complete.\nClick below to configure GitHub, YouTube, and Selling settings."
    );

    const btn = new ButtonBuilder()
        .setCustomId("setup_wizard_btn")
        .setLabel("Configure Setup")
        .setStyle(ButtonStyle.Primary);
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(btn);

    await (interaction.channel as TextChannel)?.send({ embeds: [setupEmbed], components: [row] });
    await interaction.editReply({ embeds: [successEmbed("Setup Complete", `Server structure secured. Mode: \`${mode}\``)] });

    // Add Verification / Ticket Panels if empty
    const verifyMsgs = await chVerify.messages.fetch({ limit: 1 });
    if (verifyMsgs.size === 0) {
        const vBtn = new ButtonBuilder().setCustomId("verify_btn").setLabel("✅ Verify").setStyle(ButtonStyle.Success);
        const vRow = new ActionRowBuilder<ButtonBuilder>().addComponents(vBtn);
        await chVerify.send({
            embeds: [infoEmbed("🔒 Verification Required", "Click ✅ Verify to gain access to the server. You will not see this channel once verified.\n\n**Do NOT share passwords or tokens.**")],
            components: [vRow]
        });
    }

    // Tickets panel (to be implemented in tickets module, handled later)
}

// Handle Wizard Button Click
export async function handleSetupWizardBtn(interaction: any) {
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

// Handle Wizard Modal Submit
export async function handleSetupWizardSubmit(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ ephemeral: true });

    const github = interaction.fields.getTextInputValue("github");
    const youtube = interaction.fields.getTextInputValue("youtube");
    const desc = interaction.fields.getTextInputValue("sellingDesc");
    const contact = interaction.fields.getTextInputValue("sellingContact");

    let gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    if (!gConf) return interaction.editReply({ embeds: [errorEmbed("Config Not Found", "Run /setup first.")] });

    gConf.setupWizard = {
        githubValue: github,
        youtubeChannelId: youtube,
        sellingDescription: desc,
        sellingContact: contact,
        notifyChannelId: gConf.channelIds?.toolReleasesId, // fallback
    };
    await gConf.save();

    const embed = successEmbed(
        "Wizard Completed",
        `Config updated.\n**GitHub**: ${github || "N/A"}\n**YouTube**: ${youtube || "N/A"}`
    );
    await interaction.editReply({ embeds: [embed] });
}
