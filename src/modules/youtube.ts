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
import { GuildConfig, getOrCreateGuildConfig, isDatabaseReady } from "../database";
import { markJobFinished, markJobOffline, markJobStarted } from "../runtime";
import { queueDM } from "../utils/dmQueue";
import { errorEmbed, primaryEmbed, successEmbed } from "../utils/embeds";
import { isStaff } from "../utils/permissions";

const parser = new Parser();
let youtubePollerStarted = false;
let activeYouTubePoll: Promise<void> | null = null;

const CHANNEL_ID_PATTERN = /^UC[\w-]{20,}$/i;
const HANDLE_PATTERN = /^@([A-Za-z0-9._-]{3,})$/;
const SUPPORTED_YOUTUBE_HOSTS = new Set(["youtube.com", "m.youtube.com"]);
const SUPPORTED_INPUT_MESSAGE =
    "Use a YouTube channel ID (UC...), a /channel/UC... URL, the direct RSS feed URL, @handle, or https://www.youtube.com/@handle.";
const INVALID_HANDLE_MESSAGE =
    "The YouTube handle is malformed. Use @handle or https://www.youtube.com/@handle.";
const UNSUPPORTED_CUSTOM_URL_MESSAGE =
    "Custom YouTube URLs other than @handles are not supported here. Use a UC... channel ID, a /channel/UC... URL, the direct RSS feed URL, @handle, or https://www.youtube.com/@handle.";

type YouTubeInputKind = "channel_id" | "channel_url" | "feed_url" | "handle" | "handle_url";
type YouTubeErrorCode =
    | "missing_api_key"
    | "invalid_handle"
    | "channel_not_found"
    | "failed_api_request"
    | "quota_exceeded"
    | "malformed_input"
    | "feed_empty"
    | "feed_unavailable"
    | "network_error";

interface NormalizedYouTubeInput {
    kind: YouTubeInputKind | null;
    originalInput: string;
    normalizedInput: string | null;
    channelId: string | null;
    handle: string | null;
    feedUrl: string | null;
    error: string | null;
}

interface ResolvedYouTubeInput {
    kind: YouTubeInputKind;
    originalInput: string;
    normalizedInput: string;
    channelId: string;
    handle: string | null;
    feedUrl: string;
}

class YouTubeConfigError extends Error {
    code: YouTubeErrorCode;
    status: number | null;
    cause?: unknown;

    constructor(code: YouTubeErrorCode, message: string, status: number | null = null, cause?: unknown) {
        super(message);
        this.name = "YouTubeConfigError";
        this.code = code;
        this.status = status;
        this.cause = cause;
    }
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
                        .setDescription("YouTube channel ID, RSS URL, or @handle")
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

function logYouTubeDebug(message: string, details?: Record<string, unknown>) {
    if (details) {
        console.log(`[YouTube] ${message}`, details);
        return;
    }

    console.log(`[YouTube] ${message}`);
}

function logYouTubeError(message: string, details?: Record<string, unknown>) {
    if (details) {
        console.error(`[YouTube] ${message}`, details);
        return;
    }

    console.error(`[YouTube] ${message}`);
}

function buildYouTubeFeedUrl(channelId: string) {
    return `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
}

function normalizeYouTubeHost(hostname: string) {
    const lowerHost = hostname.toLowerCase();
    return lowerHost.startsWith("www.") ? lowerHost.slice(4) : lowerHost;
}

function parseYouTubeHandle(value: string) {
    const match = value.trim().match(HANDLE_PATTERN);
    if (!match) {
        return null;
    }

    return {
        handle: match[1],
        normalizedInput: `@${match[1]}`,
    };
}

export function normalizeYouTubeChannelInput(channelValue: string): NormalizedYouTubeInput {
    const trimmed = channelValue.trim();
    if (!trimmed) {
        return {
            kind: null,
            originalInput: "",
            normalizedInput: null,
            channelId: null,
            handle: null,
            feedUrl: null,
            error: null,
        };
    }

    if (CHANNEL_ID_PATTERN.test(trimmed)) {
        return {
            kind: "channel_id",
            originalInput: trimmed,
            normalizedInput: trimmed,
            channelId: trimmed,
            handle: null,
            feedUrl: buildYouTubeFeedUrl(trimmed),
            error: null,
        };
    }

    const directHandle = parseYouTubeHandle(trimmed);
    if (directHandle) {
        return {
            kind: "handle",
            originalInput: trimmed,
            normalizedInput: directHandle.normalizedInput,
            channelId: null,
            handle: directHandle.handle,
            feedUrl: null,
            error: null,
        };
    }

    if (trimmed.startsWith("@")) {
        return {
            kind: null,
            originalInput: trimmed,
            normalizedInput: null,
            channelId: null,
            handle: null,
            feedUrl: null,
            error: INVALID_HANDLE_MESSAGE,
        };
    }

    try {
        const parsed = new URL(trimmed);
        const normalizedHost = normalizeYouTubeHost(parsed.hostname);

        if (!SUPPORTED_YOUTUBE_HOSTS.has(normalizedHost)) {
            return {
                kind: null,
                originalInput: trimmed,
                normalizedInput: null,
                channelId: null,
                handle: null,
                feedUrl: null,
                error: SUPPORTED_INPUT_MESSAGE,
            };
        }

        if (parsed.pathname === "/feeds/videos.xml") {
            const channelId = parsed.searchParams.get("channel_id");
            if (channelId && CHANNEL_ID_PATTERN.test(channelId)) {
                return {
                    kind: "feed_url",
                    originalInput: trimmed,
                    normalizedInput: buildYouTubeFeedUrl(channelId),
                    channelId,
                    handle: null,
                    feedUrl: buildYouTubeFeedUrl(channelId),
                    error: null,
                };
            }

            return {
                kind: null,
                originalInput: trimmed,
                normalizedInput: null,
                channelId: null,
                handle: null,
                feedUrl: null,
                error: "The YouTube RSS URL must include a valid channel_id query parameter.",
            };
        }

        const channelMatch = parsed.pathname.match(/^\/channel\/(UC[\w-]{20,})\/?$/i);
        if (channelMatch) {
            const channelId = channelMatch[1];
            return {
                kind: "channel_url",
                originalInput: trimmed,
                normalizedInput: `https://www.youtube.com/channel/${channelId}`,
                channelId,
                handle: null,
                feedUrl: buildYouTubeFeedUrl(channelId),
                error: null,
            };
        }

        const pathSegments = parsed.pathname.split("/").filter(Boolean);
        const firstSegment = pathSegments[0] || "";
        if (firstSegment.startsWith("@")) {
            const handleInput = parseYouTubeHandle(firstSegment);
            if (!handleInput) {
                return {
                    kind: null,
                    originalInput: trimmed,
                    normalizedInput: null,
                    channelId: null,
                    handle: null,
                    feedUrl: null,
                    error: INVALID_HANDLE_MESSAGE,
                };
            }

            return {
                kind: "handle_url",
                originalInput: trimmed,
                normalizedInput: `https://www.youtube.com/${handleInput.normalizedInput}`,
                channelId: null,
                handle: handleInput.handle,
                feedUrl: null,
                error: null,
            };
        }

        const queryChannelId = parsed.searchParams.get("channel_id");
        if (queryChannelId && CHANNEL_ID_PATTERN.test(queryChannelId)) {
            return {
                kind: "feed_url",
                originalInput: trimmed,
                normalizedInput: buildYouTubeFeedUrl(queryChannelId),
                channelId: queryChannelId,
                handle: null,
                feedUrl: buildYouTubeFeedUrl(queryChannelId),
                error: null,
            };
        }
    } catch {
        return {
            kind: null,
            originalInput: trimmed,
            normalizedInput: null,
            channelId: null,
            handle: null,
            feedUrl: null,
            error: SUPPORTED_INPUT_MESSAGE,
        };
    }

    return {
        kind: null,
        originalInput: trimmed,
        normalizedInput: null,
        channelId: null,
        handle: null,
        feedUrl: null,
        error: UNSUPPORTED_CUSTOM_URL_MESSAGE,
    };
}

interface StoredYouTubeConfig {
    kind: YouTubeInputKind | null;
    originalInput: string;
    normalizedInput: string;
    channelId: string;
    handle: string | null;
    feedUrl: string;
    notifyChannelId: string;
    lastVideoId: string;
    lastVideoPublishedAt: Date | null;
}

interface YouTubeChannelsListResponse {
    items?: Array<{
        id?: string;
    }>;
    error?: {
        code?: number;
        message?: string;
        errors?: Array<{
            reason?: string;
            message?: string;
        }>;
    };
}

async function resolveHandleToChannelId(handle: string, context: string) {
    if (!config.youtubeApiKey) {
        throw new YouTubeConfigError(
            "missing_api_key",
            "YOUTUBE_API_KEY is not configured. Handle-based YouTube inputs require the YouTube Data API."
        );
    }

    const apiUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
    apiUrl.searchParams.set("part", "id");
    apiUrl.searchParams.set("forHandle", handle);
    apiUrl.searchParams.set("key", config.youtubeApiKey);

    let response: Response;
    try {
        response = await fetch(apiUrl, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
        throw new YouTubeConfigError(
            "network_error",
            "A network error occurred while contacting the YouTube Data API.",
            null,
            error
        );
    }

    logYouTubeDebug("YouTube Data API response received", {
        context,
        handle,
        status: response.status,
        statusText: response.statusText,
    });

    let responseBody: YouTubeChannelsListResponse = {};
    try {
        responseBody = (await response.json()) as YouTubeChannelsListResponse;
    } catch (error) {
        if (!response.ok) {
            throw new YouTubeConfigError(
                "failed_api_request",
                `The YouTube Data API request failed with status ${response.status}.`,
                response.status,
                error
            );
        }
    }

    const apiReasons = responseBody.error?.errors?.map((entry) => entry.reason || "").filter(Boolean) || [];
    const apiMessage = responseBody.error?.message || apiReasons[0] || "Unknown YouTube API error.";
    if (apiReasons.some((reason) => ["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded"].includes(reason))) {
        throw new YouTubeConfigError(
            "quota_exceeded",
            "The YouTube Data API quota is exceeded right now. Try again later or increase the API quota.",
            response.status || responseBody.error?.code || null
        );
    }

    if (!response.ok) {
        throw new YouTubeConfigError(
            "failed_api_request",
            `The YouTube Data API request failed: ${apiMessage}`,
            response.status
        );
    }

    const channelId = responseBody.items?.find((item) => item.id && CHANNEL_ID_PATTERN.test(item.id))?.id || null;
    if (!channelId) {
        throw new YouTubeConfigError("channel_not_found", "Invalid handle or channel not found.");
    }

    return channelId;
}

export async function resolveYouTubeChannelInput(channelValue: string, context = "general"): Promise<ResolvedYouTubeInput | null> {
    logYouTubeDebug("Received YouTube input", { context, rawInput: channelValue });

    const normalized = normalizeYouTubeChannelInput(channelValue);
    logYouTubeDebug("Normalized YouTube input", {
        context,
        originalInput: normalized.originalInput,
        normalizedInput: normalized.normalizedInput,
        kind: normalized.kind,
        channelId: normalized.channelId,
        handle: normalized.handle,
        error: normalized.error,
    });

    if (!normalized.originalInput) {
        return null;
    }

    if (normalized.error || !normalized.kind || !normalized.normalizedInput) {
        throw new YouTubeConfigError("malformed_input", normalized.error || SUPPORTED_INPUT_MESSAGE);
    }

    if (normalized.channelId && normalized.feedUrl) {
        logYouTubeDebug("Resolved YouTube channel", {
            context,
            channelId: normalized.channelId,
            feedUrl: normalized.feedUrl,
            resolution: "direct",
        });
        return {
            kind: normalized.kind,
            originalInput: normalized.originalInput,
            normalizedInput: normalized.normalizedInput,
            channelId: normalized.channelId,
            handle: normalized.handle,
            feedUrl: normalized.feedUrl,
        };
    }

    if (!normalized.handle) {
        throw new YouTubeConfigError("malformed_input", SUPPORTED_INPUT_MESSAGE);
    }

    const resolvedChannelId = await resolveHandleToChannelId(normalized.handle, context);
    const feedUrl = buildYouTubeFeedUrl(resolvedChannelId);
    logYouTubeDebug("Resolved YouTube channel", {
        context,
        channelId: resolvedChannelId,
        feedUrl,
        resolution: "handle",
    });
    return {
        kind: normalized.kind,
        originalInput: normalized.originalInput,
        normalizedInput: normalized.normalizedInput,
        channelId: resolvedChannelId,
        handle: normalized.handle,
        feedUrl,
    };
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
        const normalizedHost = normalizeYouTubeHost(parsed.hostname);

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

function getStoredYouTubeState(guildConfig: any) {
    const originalInput = (
        guildConfig.youtube?.originalInput ||
        guildConfig.youtube?.channelInput ||
        guildConfig.setupWizard?.youtubeChannelId ||
        ""
    ).trim();
    const channelId = (guildConfig.youtube?.channelId || "").trim();
    const feedUrl = (guildConfig.youtube?.feedUrl || "").trim();
    const notifyChannelId =
        guildConfig.youtube?.notifyChannelId ||
        guildConfig.setupWizard?.notifyChannelId ||
        guildConfig.channelIds?.toolReleasesId ||
        "";
    const rawLastPublishedAt = guildConfig.youtube?.lastVideoPublishedAt;
    const lastVideoPublishedAt = rawLastPublishedAt ? new Date(rawLastPublishedAt) : null;

    return {
        originalInput,
        channelId,
        feedUrl,
        notifyChannelId,
        lastVideoId: guildConfig.youtube?.lastVideoId || "",
        lastVideoPublishedAt:
            lastVideoPublishedAt && !Number.isNaN(lastVideoPublishedAt.getTime()) ? lastVideoPublishedAt : null,
    };
}

async function resolveStoredYouTubeConfig(
    guildConfig: any,
    context: string,
    saveIfUpdated = false
): Promise<StoredYouTubeConfig> {
    const stored = getStoredYouTubeState(guildConfig);
    if (!stored.originalInput && !stored.channelId && !stored.feedUrl) {
        return {
            kind: null,
            originalInput: "",
            normalizedInput: "",
            channelId: "",
            handle: null,
            feedUrl: "",
            notifyChannelId: stored.notifyChannelId,
            lastVideoId: stored.lastVideoId,
            lastVideoPublishedAt: stored.lastVideoPublishedAt,
        };
    }

    const normalizedOriginalInput = stored.originalInput ? normalizeYouTubeChannelInput(stored.originalInput) : null;
    let resolved: ResolvedYouTubeInput | null = null;

    if (stored.channelId && CHANNEL_ID_PATTERN.test(stored.channelId)) {
        resolved = {
            kind: normalizedOriginalInput?.kind || "channel_id",
            originalInput: stored.originalInput || stored.channelId,
            normalizedInput: normalizedOriginalInput?.normalizedInput || stored.channelId,
            channelId: stored.channelId,
            handle: normalizedOriginalInput?.handle || null,
            feedUrl: buildYouTubeFeedUrl(stored.channelId),
        };
    }

    if (!resolved && stored.feedUrl) {
        const normalizedFeedInput = normalizeYouTubeChannelInput(stored.feedUrl);
        if (normalizedFeedInput.channelId && normalizedFeedInput.feedUrl && normalizedFeedInput.kind) {
            resolved = {
                kind: normalizedOriginalInput?.kind || normalizedFeedInput.kind,
                originalInput: stored.originalInput || stored.feedUrl,
                normalizedInput:
                    normalizedOriginalInput?.normalizedInput || normalizedFeedInput.normalizedInput || stored.feedUrl,
                channelId: normalizedFeedInput.channelId,
                handle: normalizedOriginalInput?.handle || normalizedFeedInput.handle,
                feedUrl: normalizedFeedInput.feedUrl,
            };
        }
    }

    if (!resolved) {
        const sourceInput = stored.originalInput || stored.channelId || stored.feedUrl;
        resolved = await resolveYouTubeChannelInput(sourceInput, context);
    }

    if (!resolved) {
        throw new YouTubeConfigError("malformed_input", "No YouTube channel has been configured.");
    }

    const currentYouTubeState = guildConfig.youtube || {};
    const nextYouTubeState: any = {
        ...currentYouTubeState,
        originalInput: resolved.originalInput,
        channelId: resolved.channelId,
        feedUrl: resolved.feedUrl,
        notifyChannelId: stored.notifyChannelId,
        lastVideoId: stored.lastVideoId,
        lastVideoPublishedAt: stored.lastVideoPublishedAt,
    };
    delete nextYouTubeState.channelInput;

    const needsUpdate =
        (currentYouTubeState.originalInput || "") !== resolved.originalInput ||
        (currentYouTubeState.channelId || "") !== resolved.channelId ||
        (currentYouTubeState.feedUrl || "") !== resolved.feedUrl ||
        (currentYouTubeState.notifyChannelId || "") !== stored.notifyChannelId ||
        Boolean(currentYouTubeState.channelInput);

    guildConfig.youtube = nextYouTubeState;

    if (saveIfUpdated && needsUpdate) {
        logYouTubeDebug("Persisting normalized YouTube configuration", {
            context,
            originalInput: resolved.originalInput,
            channelId: resolved.channelId,
            feedUrl: resolved.feedUrl,
            notifyChannelId: stored.notifyChannelId,
        });
        await guildConfig.save();
    }

    return {
        kind: resolved.kind,
        originalInput: resolved.originalInput,
        normalizedInput: resolved.normalizedInput,
        channelId: resolved.channelId,
        handle: resolved.handle,
        feedUrl: resolved.feedUrl,
        notifyChannelId: stored.notifyChannelId,
        lastVideoId: stored.lastVideoId,
        lastVideoPublishedAt: stored.lastVideoPublishedAt,
    };
}

export async function ensureYouTubeNotificationRole(guild: Guild, guildConfig?: any) {
    const configDocument = guildConfig || (await getOrCreateGuildConfig(guild.id));
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

async function fetchLatestYouTubeVideo(feedUrl: string, context: string): Promise<LatestYouTubeVideo> {
    logYouTubeDebug("Fetching YouTube RSS feed", {
        context,
        feedUrl,
    });

    let feed: Awaited<ReturnType<typeof parser.parseURL>>;
    try {
        feed = await parser.parseURL(feedUrl);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/enotfound|econnreset|etimedout|fetch failed|network/i.test(message)) {
            throw new YouTubeConfigError(
                "network_error",
                "A network error occurred while fetching the YouTube RSS feed.",
                null,
                error
            );
        }

        throw new YouTubeConfigError(
            "feed_unavailable",
            `The YouTube RSS feed is unavailable: ${message}`,
            null,
            error
        );
    }

    if (!feed.items?.length) {
        logYouTubeError("YouTube RSS feed returned no entries", {
            context,
            feedUrl,
        });
        throw new YouTubeConfigError("feed_empty", "The configured YouTube feed has no video entries.");
    }

    const latestVideo = feed.items[0];
    const videoId = extractYouTubeVideoId(latestVideo);
    const link = latestVideo.link || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
    const publishedAt = latestVideo.pubDate ? new Date(latestVideo.pubDate) : new Date();

    return {
        channelTitle: feed.title || "YouTube",
        title: latestVideo.title || "New Video",
        link,
        videoId,
        publishedAt: Number.isNaN(publishedAt.getTime()) ? new Date() : publishedAt,
    };
}

function buildYouTubeEmbed(video: LatestYouTubeVideo) {
    const description = video.link
        ? `**${video.channelTitle}** published a new video.\n\n${video.link}`
        : `**${video.channelTitle}** published a new video.`;
    const embed = new EmbedBuilder()
        .setTitle(video.title)
        .setDescription(description)
        .addFields({ name: "Published", value: `<t:${Math.floor(video.publishedAt.getTime() / 1000)}:F>`, inline: false })
        .setColor(config.colors.primary)
        .setTimestamp(video.publishedAt)
        .setFooter({ text: config.credits });

    if (video.link) {
        embed.setURL(video.link);
    }

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

function formatStoredValue(value: string) {
    return value ? `\`${value}\`` : "Not configured";
}

function formatOptionalTimestamp(value: Date | null) {
    if (!value || Number.isNaN(value.getTime())) {
        return "None";
    }

    return `<t:${Math.floor(value.getTime() / 1000)}:F>`;
}

export function getYouTubeErrorMessage(error: unknown, fallback = "An unexpected YouTube error occurred.") {
    if (error instanceof YouTubeConfigError) {
        return error.message;
    }

    if (error instanceof Error && error.message) {
        return error.message;
    }

    return fallback;
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

    const guildConfig = await getOrCreateGuildConfig(guild.id);

    if (subcommand === "set") {
        const rawInput = interaction.options.getString("channel_input", true);
        const targetChannel = interaction.options.getChannel("target_channel", true);
        if (!isSupportedNotificationChannel(targetChannel)) {
            return interaction.reply({ embeds: [errorEmbed("Invalid Channel", "Choose a server text or announcement channel.")], ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            const resolvedInput = await resolveYouTubeChannelInput(rawInput, `command:set:${guild.id}`);
            if (!resolvedInput) {
                await interaction.editReply({ embeds: [errorEmbed("Invalid YouTube Input", SUPPORTED_INPUT_MESSAGE)] });
                return;
            }

            const notificationRole = await ensureYouTubeNotificationRole(guild, guildConfig);
            const nextYouTubeState: any = {
                ...(guildConfig.youtube || {}),
                originalInput: resolvedInput.originalInput,
                channelId: resolvedInput.channelId,
                feedUrl: resolvedInput.feedUrl,
                notifyChannelId: targetChannel.id,
                lastVideoId: guildConfig.youtube?.lastVideoId,
                lastVideoPublishedAt: guildConfig.youtube?.lastVideoPublishedAt,
            };
            delete nextYouTubeState.channelInput;
            guildConfig.youtube = nextYouTubeState;
            await guildConfig.save();

            await interaction.editReply({
                embeds: [
                    successEmbed(
                        "YouTube Config Updated",
                        `Original Input: ${formatStoredValue(resolvedInput.originalInput)}\nResolved Channel ID: ${formatStoredValue(
                            resolvedInput.channelId
                        )}\nFeed URL: ${formatStoredValue(resolvedInput.feedUrl)}\nNotification Channel: <#${
                            targetChannel.id
                        }>\nOpt-in Role: <@&${notificationRole.id}>`
                    ),
                ],
            });
        } catch (error) {
            const message = getYouTubeErrorMessage(error, SUPPORTED_INPUT_MESSAGE);
            logYouTubeError("Failed to update YouTube configuration", {
                guildId: guild.id,
                error: message,
            });
            await interaction.editReply({ embeds: [errorEmbed("Invalid YouTube Input", message)] });
        }
        return;
    }

    if (subcommand === "view") {
        await interaction.deferReply({ ephemeral: true });

        const stored = getStoredYouTubeState(guildConfig);
        let settings: StoredYouTubeConfig | null = null;
        let configIssue: string | null = null;

        try {
            settings = await resolveStoredYouTubeConfig(guildConfig, `command:view:${guild.id}`, true);
        } catch (error) {
            configIssue = getYouTubeErrorMessage(error);
            logYouTubeError("Failed to resolve YouTube configuration for view", {
                guildId: guild.id,
                error: configIssue,
            });
        }

        const viewSettings = settings || {
            kind: null,
            originalInput: stored.originalInput,
            normalizedInput: stored.originalInput,
            channelId: stored.channelId,
            handle: null,
            feedUrl: stored.feedUrl,
            notifyChannelId: stored.notifyChannelId,
            lastVideoId: stored.lastVideoId,
            lastVideoPublishedAt: stored.lastVideoPublishedAt,
        };
        const roleId = guildConfig.roleIds?.youtubeNotifsRoleId || "";

        const embed = primaryEmbed("YouTube Configuration");
        embed.addFields(
            { name: "Original Input", value: formatStoredValue(viewSettings.originalInput), inline: false },
            { name: "Resolved Channel ID", value: formatStoredValue(viewSettings.channelId), inline: false },
            { name: "Feed URL", value: formatStoredValue(viewSettings.feedUrl), inline: false },
            {
                name: "Notification Channel",
                value: viewSettings.notifyChannelId ? `<#${viewSettings.notifyChannelId}>` : "Not configured",
                inline: true,
            },
            {
                name: "YouTube API Key",
                value: config.youtubeApiKey ? "Configured" : "Missing",
                inline: true,
            },
            {
                name: "Opt-In Role",
                value: roleId ? `<@&${roleId}>` : "Not configured",
                inline: true,
            },
            {
                name: "Last Seen Video ID",
                value: formatStoredValue(viewSettings.lastVideoId),
                inline: false,
            },
            {
                name: "Last Seen Publish Time",
                value: formatOptionalTimestamp(viewSettings.lastVideoPublishedAt),
                inline: false,
            }
        );

        if (configIssue) {
            embed.addFields({ name: "Config Issue", value: configIssue, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    let settings: StoredYouTubeConfig;
    try {
        settings = await resolveStoredYouTubeConfig(guildConfig, `command:test:${guild.id}`, true);
    } catch (error) {
        const message = getYouTubeErrorMessage(error, "Run `/youtubeconfig set` before sending a test notification.");
        logYouTubeError("Failed to resolve YouTube configuration for test", {
            guildId: guild.id,
            error: message,
        });
        await interaction.editReply({ embeds: [errorEmbed("Test Failed", message)] });
        return;
    }

    if (!settings.channelId || !settings.feedUrl || !settings.notifyChannelId) {
        await interaction.editReply({
            embeds: [errorEmbed("Not Configured", "Run `/youtubeconfig set` before sending a test notification.")],
        });
        return;
    }

    try {
        const latestVideo = await fetchLatestYouTubeVideo(settings.feedUrl, `command:test:${guild.id}`);
        const embed = buildYouTubeEmbed(latestVideo);
        await sendVideoToConfiguredChannel(guild, settings.notifyChannelId, embed);
        const member = interaction.member as GuildMember;
        queueDM(member, embed);

        await interaction.editReply({
            embeds: [
                successEmbed(
                    "Test Sent",
                    `Posted the latest YouTube video from ${formatStoredValue(settings.channelId)} to <#${settings.notifyChannelId}> and queued a DM to you.`
                ),
            ],
        });
    } catch (error) {
        const message = getYouTubeErrorMessage(error, "Failed to fetch the configured YouTube feed.");
        logYouTubeError("YouTube test failed", {
            guildId: guild.id,
            channelId: settings.channelId,
            feedUrl: settings.feedUrl,
            error: message,
        });
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

        const configs = await GuildConfig.find({}).sort({ _id: -1 });
        const processedGuildIds = new Set<string>();
        let hadErrors = false;
        let lastError: string | null = null;

        for (const guildConfig of configs) {
            if (processedGuildIds.has(guildConfig.guildId)) {
                logYouTubeError("Skipping duplicate guild config during YouTube poll", {
                    guildId: guildConfig.guildId,
                    configId: String(guildConfig._id),
                });
                continue;
            }

            processedGuildIds.add(guildConfig.guildId);

            try {
                const settings = await resolveStoredYouTubeConfig(guildConfig, `poll:${guildConfig.guildId}`, true);
                if (!settings.channelId || !settings.feedUrl || !settings.notifyChannelId) continue;

                const latestVideo = await fetchLatestYouTubeVideo(settings.feedUrl, `poll:${guildConfig.guildId}`);

                const videoKey = getVideoStateKey(latestVideo);
                if (!videoKey) continue;

                const previousVideoId = guildConfig.youtube?.lastVideoId || null;
                if (previousVideoId === videoKey) continue;

                const nextYouTubeState: any = {
                    ...(guildConfig.youtube || {}),
                    originalInput: settings.originalInput,
                    channelId: settings.channelId,
                    feedUrl: settings.feedUrl,
                    notifyChannelId: settings.notifyChannelId,
                    lastVideoId: guildConfig.youtube?.lastVideoId,
                    lastVideoPublishedAt: guildConfig.youtube?.lastVideoPublishedAt,
                };
                delete nextYouTubeState.channelInput;
                guildConfig.youtube = nextYouTubeState;

                // Seed the last-seen item without sending a backfilled notification.
                if (!previousVideoId) {
                    guildConfig.youtube = {
                        ...(guildConfig.youtube || {}),
                        lastVideoId: videoKey,
                        lastVideoPublishedAt: latestVideo.publishedAt,
                    };
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

                guildConfig.youtube = {
                    ...(guildConfig.youtube || {}),
                    lastVideoId: videoKey,
                    lastVideoPublishedAt: latestVideo.publishedAt,
                };
                await guildConfig.save();
            } catch (error) {
                hadErrors = true;
                lastError = getYouTubeErrorMessage(error);
                logYouTubeError("YouTube poll error", {
                    guildId: guildConfig.guildId,
                    error: lastError,
                });
            }
        }

        markJobFinished("youtube", hadErrors, lastError);
    } catch (error) {
        const message = getYouTubeErrorMessage(error);
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
