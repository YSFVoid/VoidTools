import Parser from "rss-parser";
import { EmbedBuilder, TextChannel, Client, Guild } from "discord.js";
import { GuildConfig } from "../database";
import { config } from "../config";
import { queueDM } from "../utils/dmQueue";

const parser = new Parser();

export async function pollYouTube(client: Client) {
    const gConfs = await GuildConfig.find({});

    for (const gConf of gConfs) {
        if (!gConf.setupWizard?.youtubeChannelId) continue;
        if (!gConf.channelIds?.toolReleasesId && !gConf.setupWizard.notifyChannelId) continue;

        // Attempt parse feed
        try {
            const channelId = gConf.setupWizard.youtubeChannelId;
            // Note: we assume channelId is actual ID, not URL for simplicity, but we can try to parse from feed
            const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
            const feed = await parser.parseURL(feedUrl);

            if (!feed.items || feed.items.length === 0) continue;

            const latest = feed.items[0];
            const videoId = latest.id || latest.link?.split("v=")[1] || latest.title;

            if (gConf.youtube?.lastVideoId === videoId) continue; // Already posted

            // New video!
            if (!gConf.youtube) gConf.youtube = {};
            gConf.youtube.lastVideoId = videoId;
            gConf.youtube.lastVideoPublishedAt = latest.pubDate ? new Date(latest.pubDate) : new Date();
            await gConf.save();

            const embed = new EmbedBuilder()
                .setTitle(`🎥 New Video: ${latest.title}`)
                .setURL(latest.link || "")
                .setDescription(`**${feed.title}** just uploaded a new video!\n\n${latest.link}`)
                .setColor(config.colors.primary)
                .setTimestamp()
                .setFooter({ text: config.credits });

            if (videoId && latest.link?.includes("v=")) {
                embed.setImage(`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`);
            }

            const guild = client.guilds.cache.get(gConf.guildId);
            if (!guild) continue;

            // 1. Post to channel
            const targetChId = gConf.setupWizard.notifyChannelId || gConf.channelIds?.toolReleasesId;
            if (targetChId) {
                const ch = guild.channels.cache.get(targetChId) as TextChannel;
                if (ch) await ch.send({ embeds: [embed] });
            }

            // 2. Queue DMs to opt-in role
            if (gConf.roleIds?.youtubeNotifsRoleId) {
                const role = guild.roles.cache.get(gConf.roleIds.youtubeNotifsRoleId);
                if (role) {
                    // ensure members are fetched
                    await guild.members.fetch();
                    for (const [_, member] of role.members) {
                        queueDM(member, embed);
                    }
                }
            }

        } catch (e) {
            console.error(`YouTube Poll Error for ${gConf.guildId}:`, e);
        }
    }
}

// Background Task
export function startYouTubePoller(client: Client) {
    // every 5 minutes
    setInterval(() => pollYouTube(client), 5 * 60 * 1000);
    console.log("Started YouTube RSS Poller");
}
