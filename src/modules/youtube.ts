import {
    ChannelType,
    ChatInputCommandInteraction,
    Client,
    EmbedBuilder,
    Guild,
    GuildMember,
    SlashCommandBuilder,
} from "discord.js";
import Parser from "rss-parser";
import { config, defaultRoles } from "../config";
import { GuildConfig, isDatabaseReady } from "../database";
import { markJobFinished, markJobOffline, markJobStarted } from "../runtime";
import { queueDM } from "../utils/dmQueue";
import { errorEmbed, primaryEmbed, successEmbed } from "../utils/embeds";
import { isStaff } from "../utils/permissions";

const parser = new Parser();
let youtubePollerStarted = false;
let activeYouTubePoll: Promise<void> | null = null;

const CHANNEL_ID_PATTERN = /^UC[\w-]{20,}$/i;

interface NormalizedYouTubeInput {
    value: string | null;
    error: string | null;
}

export const youtubeConfigCommands = [
    new SlashCommandBuilder()
        .setName("youtubeconfig")
        .setDescription("Configure YouTube notifications for this server")
        .setDMPermission(false)
        .addSubcommand((subcommand) =>
            subcommand
                .setName("set")
                .setDescription("Set the YouTube channel and notification channel")
                .addStringOption((option) =>
                    option
                        .setName("channel_input")
                        .setDescription("YouTube channel ID or URL")
                        .setRequired(true)
                )
                .addChannelOption((option) =>
                    option
                        .setName("target_channel")
                        .setDescription("Channel that should receive video notifications")
                        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                        .setRequired(true)
                )
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("view")
                .setDescription("View the current YouTube notification settings")
        )
        .addSubcommand((subcommand) =>
            subcommand
                .setName("test")
                .setDescription("Send a test YouTube notification using the current configuration")
        ),
];

export function normalizeYouTubeChannelInput(channelValue: string): NormalizedYouTubeInput {
    const trimmed = channelValue.trim();
    if (!trimmed) {
        return { value: null, error: null };
    }

    if (CHANNEL_ID_PATTERN.test(trimmed)) {
        return { value: trimmed, error: null };
    }

    try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.toLowerCase();
        const normalizedHost = host.startsWith("www.") ? host.slice(4) : host;

        if (!["youtube.com", "m.youtube.com"].includes(normalizedHost)) {
            return {
                value: null,
                error: "Use a YouTube channel ID, a /channel/UC... URL, or the direct RSS feed URL.",
            };
        }

        if (parsed.pathname === "/feeds/videos.xml") {
            const channelId = parsed.searchParams.get("channel_id");
            if (channelId && CHANNEL_ID_PATTERN.test(channelId)) {
                return { value: channelId, error: null };
            }

            return {
                value: null,
                error: "The YouTube RSS URL must include a valid channel_id query parameter.",
            };
        }

        const channelMatch = parsed.pathname.match(/^\/channel\/(UC[\w-]{20,})$/i);
        if (channelMatch) {
            return { value: channelMatch[1], error: null };
        }

        const channelId = parsed.searchParams.get("channel_id");
        if (channelId && CHANNEL_ID_PATTERN.test(channelId)) {
            return { value: channelId, error: null };
        }
    } catch {
        return {
            value: null,
            error: "Use a YouTube channel ID, a /channel/UC... URL, or the direct RSS feed URL.",
        };
    }

    return {
        value: null,
        error: "Handles and custom URLs are not supported here. Use a channel ID (UC...) or RSS feed URL.",
    };
}

function getFeedUrl(channelValue: string) {
    const normalized = normalizeYouTubeChannelInput(channelValue);
    if (!normalized.value) {
        throw new Error(normalized.error || "Invalid YouTube channel configuration.");
    }

    try {
        const parsed = new URL(normalized.value);
        const host = parsed.hostname.toLowerCase();
        const normalizedHost = host.startsWith("www.") ? host.slice(4) : host;
        if (["youtube.com", "m.youtube.com"].includes(normalizedHost) && parsed.pathname === "/feeds/videos.xml") {
            const channelId = parsed.searchParams.get("channel_id");
            if (channelId && CHANNEL_ID_PATTERN.test(channelId)) {
                return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
            }
        }
    } catch {
        // Normalized IDs are expected to land here.
    }

    return `https://www.youtube.com/feeds/videos.xml?channel_id=${normalized.value}`;
}

function extractYouTubeVideoId(item: { id?: string; link?: string }) {
    const idMatch = item.id?.match(/(?:yt:video:)?([A-Za-z0-9_-]{11})$/);
    if (idMatch) {
        return idMatch[1];
    }

    if (!item.link) {
        return null;
    }

    try {
        const parsed = new URL(item.link);
        const host = parsed.hostname.toLowerCase();
        const normalizedHost = host.startsWith("www.") ? host.slice(4) : host;

        if (normalizedHost === "youtu.be") {
            return parsed.pathname.split("/").filter(Boolean)[0] || null;
        }

        const searchId = parsed.searchParams.get("v");
        if (searchId) {
            return searchId;
        }

        const pathMatch = parsed.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})/);
        if (pathMatch) {
            return pathMatch[1];
        }
    } catch {
        return null;
    }

    return null;
}

function getYouTubeConfig(guildConfig: any) {
    return {
        channelInput: guildConfig.youtube?.channelInput || guildConfig.setupWizard?.youtubeChannelId || "",
        notifyChannelId:
            guildConfig.youtube?.notifyChannelId ||
            guildConfig.setupWizard?.notifyChannelId ||
            guildConfig.channelIds?.toolReleasesId ||
            "",
    };
}

async function getGuildConfigWithFallback(guildId: string) {
    let guildConfig = await GuildConfig.findOne({ guildId });
    if (!guildConfig) {
        guildConfig = new GuildConfig({ guildId });
    }

    return guildConfig;
}

export async function ensureYouTubeNotificationRole(guild: Guild, guildConfig?: any) {
    const configDocument = guildConfig || (await getGuildConfigWithFallback(guild.id));
    const configuredRoleId = configDocument.roleIds?.youtubeNotifsRoleId;
    const configuredRole = configuredRoleId ? guild.roles.cache.get(configuredRoleId) : null;
    let role =
        configuredRole ||
        guild.roles.cache.find((candidate) => candidate.name === "YouTube Notifs") ||
        guild.roles.cache.find((candidate) => candidate.name === defaultRoles.youtube) ||
        guild.roles.cache.find((candidate) => /youtube/i.test(candidate.name));

    if (!role) {
        role = await guild.roles.create({
            name: "YouTube Notifs",
            color: 0xe74c3c,
            reason: "YouTube notification opt-in role",
        });
    } else if (role.name !== "YouTube Notifs") {
        role = await role.edit({
            name: "YouTube Notifs",
            color: 0xe74c3c,
            reason: "Normalize YouTube notification role",
        }).catch(() => role);
    }

    if (!role) {
        throw new Error("Failed to create or resolve the YouTube notification role.");
    }

    configDocument.roleIds = {
        ...(configDocument.roleIds || {}),
        youtubeNotifsRoleId: role.id,
    };
    await configDocument.save();

    return role;
}

interface LatestYouTubeVideo {
    channelTitle: string;
    title: string;
    link: string;
    videoId: string | null;
    publishedAt: Date;
}

function isSupportedNotificationChannel(channel: unknown): channel is { id: string; send: (...args: any[]) => Promise<any> } {
    if (!channel || typeof channel !== "object") {
        return false;
    }

    const candidate = channel as { type?: ChannelType; send?: (...args: any[]) => Promise<any> };
    return (
        typeof candidate.send === "function" &&
        (candidate.type === ChannelType.GuildText || candidate.type === ChannelType.GuildAnnouncement)
    );
}

async function fetchLatestYouTubeVideo(channelInput: string): Promise<LatestYouTubeVideo | null> {
    const feed = await parser.parseURL(getFeedUrl(channelInput));
    if (!feed.items?.length) {
        return null;
    }

    const latestVideo = feed.items[0];
    const videoId = extractYouTubeVideoId(latestVideo);
    const publishedAt = latestVideo.pubDate ? new Date(latestVideo.pubDate) : new Date();

    return {
        channelTitle: feed.title || "YouTube",
        title: latestVideo.title || "New Video",
        link: latestVideo.link || "",
        videoId,
        publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
    };
}

function buildYouTubeEmbed(video: LatestYouTubeVideo) {
    const embed = new EmbedBuilder()
        .setTitle(video.title)
        .setURL(video.link)
        .setDescription(`**${video.channelTitle}** published a new video.\n\n${video.link}`)
        .addFields({ name: "Published", value: `<t:${Math.floor(video.publishedAt.getTime() / 1000)}:F>`, inline: false })
        .setColor(config.colors.primary)
        .setTimestamp(video.publishedAt)
        .setFooter({ text: config.credits });

    if (video.videoId) {
        embed.setImage(`https://img.youtube.com/vi/${video.videoId}/maxresdefault.jpg`);
    }

    return embed;
}

function getVideoStateKey(video: LatestYouTubeVideo) {
    return video.videoId || video.link || video.title;
}

async function sendVideoToConfiguredChannel(guild: Guild, channelId: string, embed: EmbedBuilder) {
    const targetChannel = guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));
    if (!isSupportedNotificationChannel(targetChannel)) {
        throw new Error(`YouTube notification channel ${channelId} is missing or not postable.`);
    }

    return targetChannel.send({ embeds: [embed] });
}

export async function handleYouTubeConfig(interaction: ChatInputCommandInteraction) {
    if (!(await isStaff(interaction.member as any)) && interaction.user.id !== interaction.guild?.ownerId) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });
    }

    const subcommand = interaction.options.getSubcommand();
    const guild = interaction.guild;
    if (!guild) {
        return interaction.reply({ embeds: [errorEmbed("Guild Only", "This command only works in a server.")], ephemeral: true });
    }

    const guildConfig = await getGuildConfigWithFallback(guild.id);

    if (subcommand === "set") {
        const normalized = normalizeYouTubeChannelInput(interaction.options.getString("channel_input", true));
        if (normalized.error || !normalized.value) {
            return interaction.reply({ embeds: [errorEmbed("Invalid YouTube Input", normalized.error || "Invalid YouTube input.")], ephemeral: true });
        }

        const targetChannel = interaction.options.getChannel("target_channel", true);
        if (!isSupportedNotificationChannel(targetChannel)) {
            return interaction.reply({ embeds: [errorEmbed("Invalid Channel", "Choose a server text or announcement channel.")], ephemeral: true });
        }

        const notificationRole = await ensureYouTubeNotificationRole(guild, guildConfig);
        guildConfig.youtube = {
            ...(guildConfig.youtube || {}),
            channelInput: normalized.value,
            notifyChannelId: targetChannel.id,
            lastVideoId: guildConfig.youtube?.lastVideoId,
            lastVideoPublishedAt: guildConfig.youtube?.lastVideoPublishedAt,
        };
        await guildConfig.save();

        await interaction.reply({
            embeds: [
                successEmbed(
                    "YouTube Config Updated",
                    `Notifications will post in <#${targetChannel.id}>.\nOpt-in role: <@&${notificationRole.id}>`
                ),
            ],
            ephemeral: true,
        });
        return;
    }

    if (subcommand === "view") {
        const settings = getYouTubeConfig(guildConfig);
        const roleId = guildConfig.roleIds?.youtubeNotifsRoleId || "Not configured";
        const embed = primaryEmbed(
            "YouTube Configuration",
            `Channel Input: ${settings.channelInput || "Not configured"}\nNotification Channel: ${
                settings.notifyChannelId ? `<#${settings.notifyChannelId}>` : "Not configured"
            }\nOpt-In Role: ${typeof roleId === "string" && roleId !== "Not configured" ? `<@&${roleId}>` : roleId}`
        );
        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
    }

    const settings = getYouTubeConfig(guildConfig);
    if (!settings.channelInput || !settings.notifyChannelId) {
        return interaction.reply({
            embeds: [errorEmbed("Not Configured", "Run `/youtubeconfig set` before sending a test notification.")],
            ephemeral: true,
        });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const latestVideo = await fetchLatestYouTubeVideo(settings.channelInput);
        if (!latestVideo) {
            await interaction.editReply({ embeds: [errorEmbed("No Videos Found", "No video was returned from the configured YouTube feed.")] });
            return;
        }

        const embed = buildYouTubeEmbed(latestVideo);
        await sendVideoToConfiguredChannel(guild, settings.notifyChannelId, embed);
        const member = interaction.member as GuildMember;
        queueDM(member, embed);

        await interaction.editReply({
            embeds: [successEmbed("Test Sent", `Posted a YouTube test notification to <#${settings.notifyChannelId}> and queued a DM to you.`)],
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await interaction.editReply({ embeds: [errorEmbed("Test Failed", message)] });
    }
}

async function runYouTubePoll(client: Client) {
    markJobStarted("youtube");

    try {
        if (!isDatabaseReady()) {
            markJobOffline("youtube", "Database is offline.");
            return;
        }

        const configs = await GuildConfig.find({});
        let hadErrors = false;
        let lastError: string | null = null;

        for (const guildConfig of configs) {
            const settings = getYouTubeConfig(guildConfig);
            if (!settings.channelInput || !settings.notifyChannelId) continue;

            try {
                const latestVideo = await fetchLatestYouTubeVideo(settings.channelInput);
                if (!latestVideo) continue;

                const videoKey = getVideoStateKey(latestVideo);
                if (!videoKey) continue;

                const previousVideoId = guildConfig.youtube?.lastVideoId || null;
                if (previousVideoId === videoKey) continue;

                if (!guildConfig.youtube) {
                    guildConfig.youtube = {};
                }
                guildConfig.youtube.channelInput = settings.channelInput;
                guildConfig.youtube.notifyChannelId = settings.notifyChannelId;

                // Seed the last-seen item without sending a backfilled notification.
                if (!previousVideoId) {
                    guildConfig.youtube.lastVideoId = videoKey;
                    guildConfig.youtube.lastVideoPublishedAt = latestVideo.publishedAt;
                    await guildConfig.save();
                    continue;
                }

                const embed = buildYouTubeEmbed(latestVideo);

                const guild = client.guilds.cache.get(guildConfig.guildId);
                if (!guild) continue;

                await sendVideoToConfiguredChannel(guild, settings.notifyChannelId, embed);

                const notificationRole = await ensureYouTubeNotificationRole(guild, guildConfig);
                await guild.members.fetch();
                for (const member of notificationRole.members.values()) {
                    queueDM(member, embed);
                }

                guildConfig.youtube.lastVideoId = videoKey;
                guildConfig.youtube.lastVideoPublishedAt = latestVideo.publishedAt;
                await guildConfig.save();
            } catch (error) {
                hadErrors = true;
                lastError = error instanceof Error ? error.message : String(error);
                console.error(`YouTube poll error for ${guildConfig.guildId}:`, error);
            }
        }

        markJobFinished("youtube", hadErrors, lastError);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        markJobOffline("youtube", message);
        throw error;
    }
}

export function pollYouTube(client: Client) {
    if (activeYouTubePoll) {
        return activeYouTubePoll;
    }

    activeYouTubePoll = runYouTubePoll(client).finally(() => {
        activeYouTubePoll = null;
    });

    return activeYouTubePoll;
}

export function startYouTubePoller(client: Client) {
    if (youtubePollerStarted) return;
    youtubePollerStarted = true;

    void pollYouTube(client).catch((error) => {
        console.error("Initial YouTube poll failed:", error);
    });

    setInterval(() => {
        void pollYouTube(client).catch((error) => {
            console.error("YouTube poller execution failed:", error);
        });
    }, 5 * 60 * 1000);

    console.log("Started YouTube RSS poller");
}
