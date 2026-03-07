import {
    SlashCommandBuilder,
    ChatInputCommandInteraction,
    EmbedBuilder,
    TextChannel,
    Client
} from "discord.js";
import { GuildConfig, ReleaseFeed } from "../database";
import { successEmbed, errorEmbed, primaryEmbed } from "../utils/embeds";
import { config } from "../config";
import Parser from "rss-parser";

const parser = new Parser();

export const releasesCommands = [
    new SlashCommandBuilder()
        .setName("releases")
        .setDescription("Manage GitHub / RSS release feeds")
        .addSubcommand(sub =>
            sub.setName("add")
                .setDescription("Add a new release feed (e.g. GitHub repo URL or RSS link)")
                .addStringOption(o => o.setName("url").setDescription("URL format: https://github.com/user/repo").setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName("remove")
                .setDescription("Remove a release feed")
                .addStringOption(o => o.setName("url").setDescription("URL to remove").setRequired(true))
        )
        .addSubcommand(sub =>
            sub.setName("list")
                .setDescription("List active release feeds")
        )
];

export async function handleReleasesAdmin(interaction: ChatInputCommandInteraction) {
    const gConf = await GuildConfig.findOne({ guildId: interaction.guildId });
    const memRoles = (interaction.member as any).roles.cache;
    const isStaff = memRoles.has(gConf?.roleIds?.adminRoleId) || memRoles.has(gConf?.roleIds?.modRoleId);
    if (!isStaff && interaction.user.id !== interaction.guild?.ownerId) {
        return interaction.reply({ embeds: [errorEmbed("Denied", "Staff only.")], ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
        let url = interaction.options.getString("url", true);

        // Auto convert github repo to .atom releases feed
        if (url.includes("github.com") && !url.endsWith(".atom") && !url.endsWith(".xml")) {
            // Strip trailing slashes
            url = url.replace(/\/$/, "");
            if (!url.endsWith("/releases")) url += "/releases";
            url += ".atom";
        }

        const exists = await ReleaseFeed.findOne({ guildId: interaction.guildId, url });
        if (exists) return interaction.reply({ embeds: [errorEmbed("Exists", "This feed is already being tracked.")], ephemeral: true });

        const feed = new ReleaseFeed({ guildId: interaction.guildId, url, addedBy: interaction.user.id });
        await feed.save();
        await interaction.reply({ embeds: [successEmbed("Feed Added", `Now tracking releases for: \n\`${url}\``)] });
    }

    if (sub === "remove") {
        let url = interaction.options.getString("url", true);
        if (url.includes("github.com") && !url.endsWith(".atom") && !url.endsWith(".xml")) {
            url = url.replace(/\/$/, "");
            if (!url.endsWith("/releases")) url += "/releases";
            url += ".atom";
        }

        const deleted = await ReleaseFeed.findOneAndDelete({ guildId: interaction.guildId, url });
        if (!deleted) return interaction.reply({ embeds: [errorEmbed("Not Found", "Feed not found in database.")] });

        await interaction.reply({ embeds: [successEmbed("Deleted", `Stopped tracking: \n\`${url}\``)] });
    }

    if (sub === "list") {
        const feeds = await ReleaseFeed.find({ guildId: interaction.guildId });
        if (feeds.length === 0) return interaction.reply({ embeds: [primaryEmbed("Release Feeds", "No feeds currently tracked.")] });

        const embed = primaryEmbed("📦 Release Feeds", feeds.map(f => `• ${f.url}`).join("\n"));
        await interaction.reply({ embeds: [embed] });
    }
}

// Background Task
export async function pollReleases(client: Client) {
    const feeds = await ReleaseFeed.find({});

    for (const feed of feeds) {
        try {
            const gConf = await GuildConfig.findOne({ guildId: feed.guildId });
            if (!gConf || !gConf.channelIds?.toolReleasesId) continue;

            const guild = client.guilds.cache.get(feed.guildId);
            if (!guild) continue;

            const targetChId = gConf.channelIds.toolReleasesId;
            const ch = guild.channels.cache.get(targetChId) as TextChannel;
            if (!ch) continue;

            const parsedFeeds = await parser.parseURL(feed.url);
            if (!parsedFeeds.items || parsedFeeds.items.length === 0) continue;

            const latest = parsedFeeds.items[0];
            const releaseId = latest.id || latest.link || latest.title;

            if (feed.lastReleaseId === releaseId) continue; // Already posted

            // New release!
            feed.lastReleaseId = releaseId;
            feed.lastReleasePublishedAt = latest.pubDate ? new Date(latest.pubDate) : new Date();
            await feed.save();

            const embed = new EmbedBuilder()
                .setTitle(`📦 New Release: ${latest.title}`)
                .setURL(latest.link || feed.url)
                .setDescription(`A new release was just published!\n\n${latest.link}`)
                .setColor(config.colors.primary)
                .setTimestamp()
                .setFooter({ text: config.credits });

            await ch.send({ embeds: [embed] });

        } catch (e) {
            console.error(`Release Poll Error for ${feed.url}:`, e);
        }
    }
}

export function startReleasesPoller(client: Client) {
    // every 5 minutes
    setInterval(() => pollReleases(client), 5 * 60 * 1000);
    console.log("Started Release/GitHub RSS Poller");
}
