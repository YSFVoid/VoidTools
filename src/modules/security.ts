import { Message, EmbedBuilder, TextChannel } from "discord.js";
import { config } from "../config";
import { GuildConfig } from "../database";
import { warningEmbed, errorEmbed } from "../utils/embeds";

const SCAM_PATTERNS = [
    "free nitro", "verify here", "steam gift", "crypto giveaway",
    "claim your prize", "click here to verify", "discord-nitro",
    "steamcommunity.ru", "discordgift.site"
];

const SUSPICIOUS_DOMAINS = [
    "bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd",
    "buff.ly", "ow.ly", "rb.gy", "shorturl.at"
];

const URL_RE = /https?:\/\/([^\s/]+)/ig;

export async function handleSecurityScan(message: Message) {
    if (message.author.bot || !message.guild) return;

    const content = message.content.toLowerCase();

    const gConf = await GuildConfig.findOne({ guildId: message.guild.id });
    const whitelist = gConf?.security?.whitelistedDomains || [];

    let flaggedPattern: string | null = null;
    let flaggedDomain: string | null = null;

    for (const pattern of SCAM_PATTERNS) {
        if (content.includes(pattern)) {
            flaggedPattern = pattern;
            break;
        }
    }

    const urls = Array.from(content.matchAll(URL_RE)).map(m => m[1]);
    for (const domain of urls) {
        if (whitelist.includes(domain)) continue;
        for (const susp of SUSPICIOUS_DOMAINS) {
            if (domain.includes(susp)) {
                flaggedDomain = domain;
                break;
            }
        }
        if (flaggedDomain) break;
    }

    if (!flaggedPattern && !flaggedDomain) return;

    const reason = [
        flaggedPattern ? `Scam pattern: \`${flaggedPattern}\`` : null,
        flaggedDomain ? `Suspicious domain: \`${flaggedDomain}\`` : null
    ].filter(Boolean).join(" | ");

    try {
        await message.delete();
    } catch (e) {
        // Missing permissions
    }

    // Warn user
    const warnMsg = await (message.channel as TextChannel).send({
        embeds: [warningEmbed("Suspicious Message Removed", `${message.author}, your message was removed for safety.\n**Reason:** ${reason}`)]
    });
    setTimeout(() => warnMsg.delete().catch(() => null), 15000);

    // Log
    if (gConf?.channelIds?.logsId) {
        const logsCh = message.guild.channels.cache.get(gConf.channelIds.logsId) as TextChannel;
        if (logsCh) {
            const em = errorEmbed("🛡️ Security Alert", `**User:** ${message.author}\n**Channel:** ${message.channel}\n**Reason:** ${reason}\n\n**Content:**\n${message.content.substring(0, 500)}`);
            await logsCh.send({ embeds: [em] });
        }
    }
}
